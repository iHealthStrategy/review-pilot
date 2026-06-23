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
---

# ReviewPilot — local code review (orchestrator)

You are the review engine. Review the user's LOCAL changes the way the ReviewPilot
service would, but running here. Prefer fewer high-quality findings over noise.
Write the findings in the user's language unless told otherwise.

ReviewPilot base URL: ${base ? base : "(not baked — set the REVIEWPILOT_URL env var)"}

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
value for steps 2 and 8.

## 2. Detect whether a reviewer was named
If the user names someone to review for them — e.g. "我想让 **alice** 帮我 review 我的改动",
"用 **bob** 的规则 review", "let **alice** review my changes" — extract that
person's **handle** (the token after 让/用/let and before 帮/review; lowercase it,
keep letters/digits/hyphens). Call it \`HANDLE\`.

If no one is named, skip to step 5 as a generic review (plus any local ruleset the
user already installed). Auto-grow (step 8) still applies to your own project.

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

## 7. Review & present
Look for ${REVIEW_DIMENSIONS}, and apply the selected ruleset rules + freeform
instructions from step 4. Report only issues introduced or affected by the
reviewed changes. For each issue, form a finding with these fields:

\`\`\`
${FINDING_SCHEMA_FIELDS}
\`\`\`

Severity ranks: info < minor < major < critical. Group findings by file, most
severe first; for each show severity, location (\`path:line\`), title, a short
explanation, and a concrete fix. Then offer to apply the fixes. If there are no
issues, say so plainly. If you applied a named user's rules, note whose.

## 8. Auto-grow this project's rules (key points → candidate rules)
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
    -d "{\\"project\\":\\"$REMOTE\\",\\"projectLabel\\":\\"$PROJECT\\",\\"rules\\":$RULES_JSON}" \\
    && echo "✓ 已提交候选规则,去平台「评审规则集」确认采纳" \\
    || echo "(提交候选规则失败,已跳过)"
fi
\`\`\`
Send the raw remote URL as \`project\`; the server normalizes it to the same project
key. Tell the user which key points you submitted (or that there were none).
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
  branch diff, or a checked-out pull request.
---

# ReviewPilot — local code review

Review the user's LOCAL code changes the way the ReviewPilot service would, but
running here — you are the review engine. Prefer fewer high-quality findings over
noise. Write the findings in the user's language unless told otherwise.

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

## 4. Review
Look for ${REVIEW_DIMENSIONS}${ruleset ? ", and apply the ruleset's rules above" : ""}.
Report only issues introduced or affected by the reviewed changes. For each
issue, form a finding with these fields:

\`\`\`
${FINDING_SCHEMA_FIELDS}
\`\`\`

Severity ranks: info < minor < major < critical.

## 5. Present
Group findings by file, most severe first. For each show: severity, location
(\`path:line\`), title, a short explanation, and a concrete fix. Then offer to
apply the fixes. If there are no issues, say so plainly.
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
