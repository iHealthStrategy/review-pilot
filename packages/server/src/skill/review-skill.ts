import type { ReviewRuleset } from "../domain/entities.js";
import { FINDING_SCHEMA_FIELDS, REVIEW_DIMENSIONS } from "../review/prompt.js";

/**
 * The local Claude Code "skill" — a SKILL.md that drives the user's own Claude
 * Code as the review engine, using the SAME review kernel as the service (review
 * dimensions + finding schema, imported from the prompt module so they never
 * drift) but running entirely on the user's machine.
 *
 * Two flavours are generated here:
 *   - {@link buildOrchestratorSkill} — the DEFAULT install. One skill that, when
 *     the user says "让 X 帮我 review 我的改动", fetches user X's PUBLIC rulesets
 *     from the platform, selects ONLY the rules relevant to the changed files
 *     (selectors matched locally — code never leaves the machine), then reviews.
 *   - {@link buildReviewSkill} — a single pinned ruleset baked into the skill,
 *     for installing one specific community ruleset directly.
 */
export const SKILL_NAME = "reviewpilot-review";

/** Filesystem/skill-safe slug from a ruleset name. */
export function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "ruleset";
}

/** Skill (and install dir) name for a ruleset. */
export function rulesetSkillName(slug: string): string {
  return `reviewpilot-${slug}`;
}

/**
 * Normalize a git remote URL into a stable, cross-machine project key like
 * `github.com/acme/app` (host + path, no scheme/credentials/.git/trailing
 * slash). Handles both `https://` and `scp`-style `git@host:owner/repo` URLs.
 * Returns "" for empty input. The skill computes the same key in shell so the
 * server and skill agree on which project a ruleset governs.
 */
export function normalizeProjectKey(remoteUrl: string): string {
  let s = (remoteUrl || "").trim();
  if (!s) return "";
  // scp-style: git@github.com:owner/repo.git → github.com/owner/repo
  const scp = /^[^@/]+@([^:]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // strip scheme
    s = s.replace(/^[^@/]+@/, ""); // strip userinfo
  }
  // Trailing slash before .git so `…/repo.git/` reduces to `…/repo`.
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  s = s.toLowerCase();
  return s;
}

/** Collapse whitespace so user text is safe inside YAML frontmatter. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Tools the skill pre-authorizes via its `allowed-tools` frontmatter, so Claude
 * Code does NOT prompt for each command WHILE THIS SKILL IS ACTIVE. Scoped to
 * exactly what the skill runs: read-only git, the project-key shell pipeline,
 * curl to the configured server, the code-review-graph probe, plus Read/Edit/
 * Write for the opt-in one-shot fix (which still asks once before batch-applying).
 */
const SKILL_ALLOWED_TOOLS =
  "Bash(git remote get-url *) Bash(git diff *) Bash(git log *) Bash(git ls-files *) " +
  "Bash(git merge-base *) Bash(git rev-parse *) Bash(git status *) Bash(printf *) " +
  "Bash(sed *) Bash(tr *) Bash(mkdir *) Bash(cat *) Bash(curl *) Bash(code-review-graph*) " +
  "Read Edit Write";

/**
 * A confirmation banner the skill must emit as its first output line, so the
 * user can tell at a glance that THIS skill actually ran (vs a generic review).
 * Shared by both skills.
 */
const BANNER_INSTRUCTION = `## Confirmation banner (ALWAYS print this first)
The VERY FIRST line of your review report MUST be this banner — it is how the
user confirms this skill actually ran:

\`🤖 ReviewPilot ▸ scope=<working|branch|whole> ▸ threshold=<must-fix|critical-only|+minor|all> ▸ project=<key>\`

Fill the placeholders with the resolved values (project key, chosen scope,
applied threshold). Always emit it — even when there are no findings, or you fall
back to a generic review.`;

/**
 * Severity calibration rubric, shared by both skills so findings are rated by
 * REAL-WORLD impact × reachability in THIS codebase — not the theoretical worst
 * case. Keeps the list honest (no severity inflation, low-confidence → info).
 */
const SEVERITY_RUBRIC = `Assign severity by real-world impact × how reachable the issue actually is in
THIS codebase's context (who controls the inputs, what access/preconditions are
needed) — NOT the theoretical worst case:
- **critical** — exploitable with realistic preconditions: RCE, auth bypass,
  secret/credential theft, cross-user or stored XSS, data loss/corruption. Must
  fix before shipping.
- **major** — a real defect with material impact that needs elevated access, a
  specific backend/config, or concurrency to trigger; or hardening against a
  genuine vulnerability class. Should fix.
- **minor** — real but low impact, narrow trigger, or correctness-cosmetic. Fix
  opportunistically.
- **info** — theoretical / near-zero impact, style, OR anything you could not
  actually confirm by reading the code (low confidence).
Calibration rules: downgrade a finding one level when its precondition is
unlikely in this project; rate anything you have not confirmed in the code as
\`info\` (low confidence); never inflate severity to look thorough — prefer fewer,
higher-quality findings. If something is a deliberate design trade-off rather
than a defect, label it "design decision" and do NOT give it a fix-severity.`;

/**
 * Reporting-threshold policy, shared by both skills. Default = only must-fix
 * (major + critical). The user can widen/narrow it in natural language.
 */
const REPORTING_THRESHOLD = `By DEFAULT report only **must-fix** issues — severity **major and critical**.
Suppress minor/info findings unless asked, so the list stays focused on what
truly needs changing. Parse the user's intent to adjust the threshold:
- "只报致命的 / only critical / 最严重" → critical only
- (default, or "必须修的 / must-fix") → major + critical
- "也看次要的 / 全面一点 / include minor" → minor + major + critical
- "全部 / 所有问题 / 包括吹毛求疵 / everything / nitpicks" → all, including info
Always still COUNT everything internally, then state which threshold you applied
and how many were suppressed below it, e.g. "（已按 must-fix 过滤，另有 3 个 minor、
2 个 info 未列出，说『显示全部』可查看）", so the filtering is transparent and reversible.`;

/**
 * The orchestrator skill: install once, then drive every review locally. It
 *  - derives a stable PROJECT key from the local git remote (rules are managed
 *    per project, independently),
 *  - given a request that names a user ("让 alice 帮我 review"), pulls that user's
 *    public rulesets for THIS project from `baseUrl` and applies only the rules
 *    whose selectors match the changed files (matched locally — code never
 *    leaves the machine),
 *  - after reviewing, extracts recurring "key points" and auto-submits them as
 *    PENDING candidate rules into the caller's OWN per-project ruleset, using the
 *    caller's PAT (`REVIEWPILOT_TOKEN`), so each project's rules self-grow.
 * `baseUrl` is baked in at install time (the server origin); when empty the skill
 * falls back to the `REVIEWPILOT_URL` env var.
 */
export function buildOrchestratorSkill(baseUrl = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Resolve to a shell expression: prefer the baked origin, else an env var.
  const urlExpr = base ? `"${base}"` : '"${REVIEWPILOT_URL:-}"';

  return `---
name: ${SKILL_NAME}
description: >-
  Review LOCAL code changes for ${REVIEW_DIMENSIONS} — the same review kernel as
  the ReviewPilot service, run entirely on this machine. Manages review rules per
  project (by git remote), can fetch another user's PUBLIC rules on demand, and
  auto-grows your own project rules from each review. Use when the user asks to
  review / 评审 / 审查 their local changes, a working-tree diff, a branch diff, or a
  checked-out pull request — or asks someone (by handle) to review ("让 X 帮我 review").
  Reports only must-fix (major/critical) issues by default; threshold adjustable in
  natural language ("也看次要的" / "显示全部").
allowed-tools: ${SKILL_ALLOWED_TOOLS}
---

# ReviewPilot — local code review (orchestrator)

You are the review engine. Review the user's LOCAL changes the way the ReviewPilot
service would, but running here. Prefer fewer high-quality findings over noise.
Write the findings in the user's language unless told otherwise.

ReviewPilot base URL: ${base ? base : "(not baked — set the REVIEWPILOT_URL env var)"}

${BANNER_INSTRUCTION}

## 1. Identify the project (rules are managed per project)
Derive a stable project key from the git remote so rules stay independent across
the user's many projects:

\`\`\`sh
REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
# Normalize to host/owner/repo: strip scheme/credentials/.git, lowercase.
# git@github.com:acme/App.git  -> github.com/acme/app
# https://github.com/acme/app  -> github.com/acme/app
PROJECT=$(printf '%s' "$REMOTE" \\
  | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#^[^@/]+@#@#; s#^@##; s#:#/#; s#\\.git$##; s#/+$##' \\
  | tr 'A-Z' 'a-z')
echo "project=$PROJECT"
\`\`\`
If there is no remote, fall back to the repo directory name. Keep this \`PROJECT\`
value for steps 2 and 9.

## 2. Detect whether a reviewer was named
If the user names someone to review for them — e.g. "我想让 **alice** 帮我 review 我的改动",
"用 **bob** 的规则 review", "let **alice** review my changes" — extract that
person's **handle** (the token after 让/用/let and before 帮/review; lowercase it,
keep letters/digits/hyphens). Call it \`HANDLE\`.

If no one is named, skip to step 5 as a generic review (plus any local ruleset the
user already installed). Auto-grow (step 9) still applies to your own project.

## 3. Fetch that user's public rulesets for THIS project (on demand)
\`\`\`sh
BASE=${urlExpr}
HANDLE=<the handle from step 2>
CACHE="$HOME/.claude/skills/${SKILL_NAME}/cache"
mkdir -p "$CACHE"
if [ -n "$BASE" ]; then
  curl -fsS "$BASE/api/u/$HANDLE/rulesets?project=$PROJECT" -o "$CACHE/$HANDLE.json" \\
    || echo "(offline — using cached $CACHE/$HANDLE.json if present)"
fi
cat "$CACHE/$HANDLE.json"
\`\`\`

The response is \`{ handle, project, owner, rulesets: [...] }\`. Each ruleset has
\`name\`, \`focus\`, \`instructions\` (freeform, ALWAYS applies), \`language\`, and a
\`rules\` array of \`{ title, instruction, globs[], languages[], topics[] }\`. The
server already filtered to this project and excluded the owner's unconfirmed
candidates. If the fetch fails and there is no cache, tell the user the handle
wasn't found and offer a generic review instead.

## 4. Select ONLY the relevant rules (locally — code never leaves this machine)
First get the changed file paths for the chosen scope (see step 5). Then, for each
ruleset, decide which rules apply. A rule applies when **every** non-empty selector
matches; empty selectors mean "always". Matching is done here, locally:
- \`globs\` — apply if any changed file path matches any glob (e.g. \`src/db/**\`,
  a \`*.sql\` suffix). Empty \`globs\` ⇒ matches any path.
- \`languages\` — apply if any changed file's extension family is listed (e.g.
  \`ts\`/\`tsx\`→typescript, \`py\`→python, \`sql\`→sql). Empty ⇒ any language.
- \`topics\` — semantic hints (e.g. \`security\`, \`performance\`). Treat as relevant
  unless clearly unrelated to the change; empty ⇒ always.

A ruleset's \`instructions\` (freeform) and \`focus\` ALWAYS apply when used. Collect
the applicable rules into one set. Briefly tell the user which rules you loaded and
which you skipped (and why), so the on-demand selection is transparent.

## 5. Choose the scope & gather the diff
Default to **working** unless the user says otherwise:
- **working** — uncommitted changes: \`git diff HEAD\` plus untracked files
  (\`git ls-files --others --exclude-standard\`).
- **branch** — current branch vs a base (default \`main\`):
  \`git diff "$(git merge-base <base> HEAD)..HEAD"\`.
- **whole project** — audit the full checkout (slower).

Collect the changed files and their patches. Open and read surrounding code in the
repo as needed for context.

## 6. Structural context (optional — only if available)
If \`code-review-graph\` is installed (check \`code-review-graph --version\`, or use
its MCP tools), get risk-scored hotspots, impacted callers, and test-coverage
gaps for the changed files and prioritise the review accordingly. Skip if absent.

## 7. Review, rate severity & present
Look for ${REVIEW_DIMENSIONS}, and apply the selected ruleset rules + freeform
instructions from step 4. Report only issues introduced or affected by the
reviewed changes. For each issue, form a finding with these fields:

\`\`\`
${FINDING_SCHEMA_FIELDS}
\`\`\`

### Severity (rate honestly, by impact × reachability)
${SEVERITY_RUBRIC}

### Reporting threshold
${REPORTING_THRESHOLD}

Group the REPORTED findings by file, most severe first; for each show severity,
location (\`path:line\`), title, a short explanation, and a concrete fix. If there
are no must-fix issues, say so plainly (and note any suppressed lower-severity
ones). If you applied a named user's rules, note whose. (The report stays in this
session — do not write it to a file unless the user asks.)

## 8. One-shot fix (aggregate → confirm once → batch-apply)
After presenting, offer a single auto-fix pass:
1. **Aggregate** every REPORTED finding (those above the current threshold) that
   has a concrete, mechanical fix into a fix list. Exclude findings that need a
   design decision or human judgement — list those separately as "needs manual
   attention" and never auto-edit them.
2. **Show the plan**: group the proposed edits by file; for each give the
   location (\`path:line\`) and a one-line description of the change. Show this as
   one consolidated list so the user sees everything before deciding.
3. **Ask once** for approval to apply the whole batch (a single yes/no). Do not
   prompt per finding.
4. **Batch when large**: if the fix list is big (roughly >15 edits, or it spans
   many files), split it into ordered batches (by file/area, ~10–15 edits each).
   Apply one batch, give a one-line summary, then continue to the next batch
   automatically — pausing only if the user interrupts or a batch fails. State up
   front how many batches there will be. This keeps each change set reviewable.
5. **After applying**: summarise what changed (files + count), and suggest the
   user inspect \`git diff\` and run the tests/build. Do NOT commit or push —
   leave the working tree for the user to review.
If the user declines, leave everything unchanged.

## 9. Auto-grow this project's rules (key points → candidate rules)
From THIS review, extract 0–3 **key points** worth enforcing on future changes in
this project — recurring or systemic issues, not one-offs (e.g. "DB migrations must
be reversible", "public API changes need a changelog entry"). It is fine to find
none. Turn each into a candidate rule object:
\`{ title, instruction, globs[], languages[], topics[] }\` — set selectors so the
rule only loads for the relevant files (e.g. migrations → \`globs:["**/migrations/**"]\`).

Submit them to YOUR OWN project ruleset (they land as **pending** candidates for you
to confirm later in the web UI; they do not affect others until you promote them).
This needs your personal access token in \`REVIEWPILOT_TOKEN\` (create one in the
account page). Skip silently if there are no key points or no token.

\`\`\`sh
BASE=${urlExpr}
TOKEN="\${REVIEWPILOT_TOKEN:-}"
if [ -n "$BASE" ] && [ -n "$TOKEN" ]; then
  # RULES_JSON = a JSON array of the candidate rule objects you extracted.
  curl -fsS -X POST "$BASE/api/rulesets/candidates" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d "{\\"project\\":\\"$PROJECT\\",\\"projectLabel\\":\\"$PROJECT\\",\\"rules\\":$RULES_JSON}" \\
    && echo "✓ 已提交候选规则,去平台「评审规则集」确认采纳" \\
    || echo "(提交候选规则失败,已跳过)"
fi
\`\`\`
Send the SAME \`$PROJECT\` key used to fetch rules in step 3 (it has the no-remote
directory-name fallback) so the auto-grown rules match on the next review; the
server normalizes it idempotently. Tell the user which key points you submitted
(or that there were none).
`;
}

export function buildReviewSkill(ruleset?: ReviewRuleset): string {
  const name = ruleset ? rulesetSkillName(ruleset.slug) : SKILL_NAME;
  const descSuffix = ruleset
    ? ` Applies the community ruleset "${oneLine(ruleset.name)}"${ruleset.description ? ` — ${oneLine(ruleset.description)}` : ""}.`
    : "";

  const rulesetSections: string[] = [];
  if (ruleset) {
    rulesetSections.push(`## Ruleset: ${ruleset.name}`);
    if (ruleset.description) rulesetSections.push(ruleset.description);
    if (ruleset.focus.trim()) {
      rulesetSections.push(
        "",
        "## Review focus (prioritise)",
        ruleset.focus.trim(),
      );
    }
    if (ruleset.instructions.trim()) {
      rulesetSections.push(
        "",
        "## Custom rules (always apply)",
        "Apply these rules in addition to the standard review:",
        "",
        ruleset.instructions.trim(),
      );
    }
    if (ruleset.rules.length) {
      rulesetSections.push(
        "",
        "## Conditional rules (apply only when the selector matches the changed files)",
        "Match each rule's selectors against the changed file paths/languages locally;",
        "apply a rule only when its non-empty selectors all match (empty = always):",
        "",
      );
      for (const r of ruleset.rules) {
        const sel: string[] = [];
        if (r.globs.length) sel.push(`paths ${r.globs.join(", ")}`);
        if (r.languages.length) sel.push(`langs ${r.languages.join(", ")}`);
        if (r.topics.length) sel.push(`topics ${r.topics.join(", ")}`);
        const when = sel.length ? ` _(when: ${sel.join("; ")})_` : " _(always)_";
        rulesetSections.push(`- **${oneLine(r.title)}**${when}: ${oneLine(r.instruction)}`);
      }
    }
    if (ruleset.language.trim()) {
      rulesetSections.push("", `Write the findings in ${ruleset.language.trim()}.`);
    }
    rulesetSections.push("");
  }

  return `---
name: ${name}
description: >-
  Review LOCAL code changes for ${REVIEW_DIMENSIONS} — the same review kernel as
  the ReviewPilot service, run entirely on this machine.${descSuffix} Use when the
  user asks to review / 评审 / 审查 their local changes, a working-tree diff, a
  branch diff, or a checked-out pull request. Reports only must-fix (major/critical)
  issues by default; threshold adjustable in natural language ("也看次要的" / "显示全部").
allowed-tools: ${SKILL_ALLOWED_TOOLS}
---

# ReviewPilot — local code review

Review the user's LOCAL code changes the way the ReviewPilot service would, but
running here — you are the review engine. Prefer fewer high-quality findings over
noise. Write the findings in the user's language unless told otherwise.

${BANNER_INSTRUCTION}

${rulesetSections.join("\n")}## 1. Choose the scope
Default to **working** unless the user says otherwise:
- **working** — uncommitted changes: \`git diff HEAD\` plus untracked files
  (\`git ls-files --others --exclude-standard\`).
- **branch** — current branch vs a base (default \`main\`):
  \`git diff "$(git merge-base <base> HEAD)..HEAD"\`.
- **whole project** — audit the full checkout (slower).

## 2. Gather the diff
Run the git commands for the chosen scope to collect the changed files and their
patches. Open and read surrounding code in the repo as needed for context.

## 3. Structural context (optional — only if available)
If \`code-review-graph\` is installed (check \`code-review-graph --version\`, or use
its MCP tools), get risk-scored hotspots, impacted callers, and test-coverage
gaps for the changed files and prioritise the review accordingly. Skip if absent.

## 4. Review & rate severity
Look for ${REVIEW_DIMENSIONS}${ruleset ? ", and apply the ruleset's rules above" : ""}.
Report only issues introduced or affected by the reviewed changes. For each
issue, form a finding with these fields:

\`\`\`
${FINDING_SCHEMA_FIELDS}
\`\`\`

Rate each finding's severity honestly, by impact × reachability:
${SEVERITY_RUBRIC}

## 5. Present (default: only must-fix)
${REPORTING_THRESHOLD}

Group the REPORTED findings by file, most severe first. For each show: severity,
location (\`path:line\`), title, a short explanation, and a concrete fix. If there
are no must-fix issues, say so plainly (and note any suppressed lower-severity
ones). (The report stays in this session — do not write it to a file unless the
user asks.)

## 6. One-shot fix (aggregate → confirm once → batch-apply)
After presenting, offer a single auto-fix pass:
1. **Aggregate** every REPORTED finding (above the current threshold) with a
   concrete, mechanical fix into a fix list. Exclude findings needing a design
   decision or human judgement — list those separately as "needs manual
   attention" and never auto-edit them.
2. **Show the plan**: group the proposed edits by file with location
   (\`path:line\`) and a one-line description, as one consolidated list.
3. **Ask once** for approval to apply the whole batch (single yes/no) — not per
   finding.
4. **Batch when large**: if the fix list is big (roughly >15 edits, or it spans
   many files), split into ordered batches (~10–15 edits each), state how many
   batches there are, apply one, give a one-line summary, then continue — pausing
   only if the user interrupts or a batch fails.
5. **After applying**: summarise what changed and suggest inspecting \`git diff\`
   and running tests/build. Do NOT commit or push. If the user declines, leave
   everything unchanged.
`;
}

/** A self-contained installer that writes the skill into ~/.claude/skills/. */
export function buildInstallScript(skillMd: string, dirName: string = SKILL_NAME): string {
  return `#!/bin/sh
set -e
DIR="$HOME/.claude/skills/${dirName}"
mkdir -p "$DIR"
cat > "$DIR/SKILL.md" <<'REVIEWPILOT_SKILL_EOF'
${skillMd}REVIEWPILOT_SKILL_EOF
echo "✓ Installed the ReviewPilot review skill → $DIR/SKILL.md"
echo "  In Claude Code, just ask: 评审一下我的改动  (or: review my changes)"
echo "  Or:  让 <用户名> 帮我 review 我的改动  (pulls that user's public rules)"
echo "  Tip: export REVIEWPILOT_TOKEN=rpat_…  to auto-grow your project's rules (account page)"
`;
}
