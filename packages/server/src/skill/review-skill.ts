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
  "Bash(echo *) Bash(cd *) Bash(find *) Bash(grep *) Bash(ls *) Bash(rg *) " +
  "Bash(git remote get-url *) Bash(git diff *) Bash(git log *) Bash(git show *) " +
  "Bash(git ls-files *) Bash(git merge-base *) Bash(git rev-parse *) Bash(git status *) " +
  // Write path for the one-shot "ship it" pipeline (branch → commit → fix →
  // attest → push → PR). `git commit` covers --amend (writes the signed
  // attestation trailer; only the message changes, the bound tree stays intact).
  "Bash(git switch *) Bash(git checkout *) Bash(git add *) Bash(git commit *) " +
  "Bash(git push *) Bash(gh pr create *) Bash(gh pr view *) Bash(gh auth status*) " +
  "Bash(printf *) Bash(sed *) Bash(tr *) Bash(mkdir *) Bash(cat *) " +
  "Bash(curl *) Bash(code-review-graph*) Read Edit Write";

/**
 * A confirmation banner the skill must emit as its first output line, so the
 * user can tell at a glance that THIS skill actually ran (vs a generic review).
 * Shared by both skills.
 */
const BANNER_INSTRUCTION = `## Confirmation banner (ALWAYS print this first)
The VERY FIRST line of your review report MUST be this banner — it is how the
user confirms this skill actually ran:

\`🤖 ReviewPilot ▸ scope=<working|branch|whole> ▸ threshold=<must-fix|critical-only|+minor|all> ▸ project=<key>\`

TYPE it directly as the first line of your TEXT reply — do NOT run \`echo\`,
\`printf\`, or any shell command to produce it (that would just cause a needless
permission prompt). Fill the placeholders with the resolved values (project key,
chosen scope, applied threshold). Always emit it — even when there are no
findings, or you fall back to a generic review.`;

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
export function buildOrchestratorSkill(baseUrl = "", token = ""): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Resolve to a shell expression: prefer the baked origin, else an env var.
  const urlExpr = base ? `"${base}"` : '"${REVIEWPILOT_URL:-}"';
  // When a token is baked in at install time, the skill is fully configured and
  // needs no manual setup; otherwise it reads REVIEWPILOT_TOKEN from the env.
  const tokenExpr = token ? `"${token}"` : '"${REVIEWPILOT_TOKEN:-}"';
  const tokenNote = token
    ? "Your personal access token is already baked in below — no setup needed."
    : "This needs your personal access token in `REVIEWPILOT_TOKEN` (create one on the API Key page).";

  return `---
name: ${SKILL_NAME}
description: >-
  Review the user's LOCAL code changes, and optionally run the whole submit flow.
  USE THIS whenever the user wants to review or submit their OWN changes, in ANY
  phrasing — e.g. "review 一下 / 审一下 / 帮我 review / 评审 / 审查 / 看下我的改动 /
  review my changes / check my diff", or wants to submit after reviewing — e.g.
  "提交 / 提个 PR / 提交代码 / review 完提交 / 一键提 PR / ship it", or names a
  reviewer ("让 X 帮我 review"). Prefer this over any generic review for local
  changes: it is the same review kernel as the ReviewPilot service but runs on this
  machine, applies per-project rules (by git remote), can fetch another user's
  PUBLIC rules, auto-grows your project rules, and produces the server-signed review
  attestation that repos may require before merge (review → auto-fix → attest →
  push → open PR). Covers the working-tree diff, a branch diff, or a checked-out PR.
  Reports only must-fix (major/critical) by default; adjust in natural language
  ("也看次要的" / "显示全部").
allowed-tools: ${SKILL_ALLOWED_TOOLS}
---

# ReviewPilot — local code review (orchestrator)

You are the review engine. Review the user's LOCAL changes the way the ReviewPilot
service would, but running here. Prefer fewer high-quality findings over noise.
Write the ENTIRE review report in **中文 (Chinese)** by default — finding titles,
explanations, and suggested fixes. Only switch language if the user explicitly
asks (or a ruleset specifies a different output language). The banner line stays
as-is.

ReviewPilot base URL: ${base ? base : "(not baked — set the REVIEWPILOT_URL env var)"}

${BANNER_INSTRUCTION}

## 1. Identify the project (rules are managed per project)
Run ONE simple command (no pipes, no \`cd\`, no command substitution — keep it
auto-approvable):

\`\`\`sh
git remote get-url origin
\`\`\`

Then normalize its output YOURSELF (in your head — do NOT build a shell pipeline)
into a stable \`PROJECT\` key \`host/owner/repo\`: strip the scheme and any
\`user:pass@\` credentials, turn a scp-style \`git@host:owner/repo\` into
\`host/owner/repo\`, drop a trailing \`.git\` and trailing slashes, lowercase. E.g.
\`git@github.com:acme/App.git\` and \`https://github.com/acme/app\` both → \`github.com/acme/app\`.
If there is no remote, use the repo directory name. Keep \`PROJECT\` for steps 3 and 9.

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
  Run commands as SIMPLE single invocations from the current directory — no
  \`cd\`, no \`&&\` chains, no \`$(…)\` substitution — so they stay auto-approvable.
- **branch** — current branch vs a base (default \`main\`):
  do it in TWO simple steps (avoid \`$(…)\`): first \`git merge-base <base> HEAD\`,
  then \`git diff <that-sha>..HEAD\`.
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
${tokenNote} Skip silently if there are no key points or no token.

\`\`\`sh
BASE=${urlExpr}
TOKEN=${tokenExpr}
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

## 10. Report this review's usage (counts only — no code, no tokens)
After presenting, silently report this run so the platform can show per-user usage
(admins see everyone; each user sees their own). Send ONLY numbers: the scope you
used and how many findings you identified at each severity — count **all** of them
internally, regardless of the display threshold. No code, snippets, file names, or
token counts ever leave the machine. Best-effort: never block, delay, or mention
this step in your report; ignore any failure.

\`\`\`sh
BASE=${urlExpr}
TOKEN=${tokenExpr}
if [ -n "$BASE" ] && [ -n "$TOKEN" ]; then
  # Fill these with this run's values: SCOPE = working|branch|whole; CRIT/MAJ/MIN/INFO
  # = the number of findings you identified at each severity (0 if none).
  curl -fsS -X POST "$BASE/api/usage/skill" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d "{\\"project\\":\\"$PROJECT\\",\\"scope\\":\\"$SCOPE\\",\\"critical\\":$CRIT,\\"major\\":$MAJ,\\"minor\\":$MIN,\\"info\\":$INFO}" \\
    >/dev/null 2>&1 || true
fi
\`\`\`

## 11. Commit attestation (提交前门禁凭证 — use when the team enforces the gate)
Do this ONLY when the user is preparing to push and the team enforces the
"reviewed-before-merge" gate, or the user asks for it explicitly (生成提交凭证 /
提交前 review / attest / 准备推送). It produces a server-SIGNED token that GitHub
verifies before allowing a merge. Three rules govern it:
- **It binds the HEAD commit's _tree_ (code snapshot)** — so the change MUST
  already be committed. Review the **committed** state (scope \`branch\`, or the
  HEAD commit), NOT uncommitted working-tree edits: anything not committed is
  not covered by the token.
- **The SERVER decides pass/fail** under the team's policy; you only send finding
  COUNTS (count ALL severities, regardless of the display threshold). You cannot
  and must not try to influence the verdict.
- **Only amend on \`pass\`.** If the server returns \`verdict":"fail"\`, do NOT
  amend — the policy blocks these findings; tell the user what to fix and re-run.

### Steps
1. Confirm the change is committed, then read the tree + base (two SIMPLE
   commands — keep them auto-approvable):

\`\`\`sh
git rev-parse HEAD^{tree}
git merge-base main HEAD
\`\`\`
Keep \`TREE\` = the first output; \`BASE_SHA\` = the second (leave empty if it fails).

2. Request the attestation (send ONLY counts — never code):

\`\`\`sh
BASE=${urlExpr}
TOKEN=${tokenExpr}
if [ -n "$BASE" ] && [ -n "$TOKEN" ]; then
  # CRIT/MAJ/MIN/INFO = counts you identified at each severity (0 if none).
  curl -fsS -X POST "$BASE/api/attest" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d "{\\"project\\":\\"$PROJECT\\",\\"treeSha\\":\\"$TREE\\",\\"baseSha\\":\\"$BASE_SHA\\",\\"scope\\":\\"branch\\",\\"critical\\":$CRIT,\\"major\\":$MAJ,\\"minor\\":$MIN,\\"info\\":$INFO}"
fi
\`\`\`
The response is \`{ token, verdict, policy, blockSeverity, expiresAt }\`.

3. Gate on \`verdict\`:
- \`"fail"\` → the policy blocks these findings. List the remaining must-fix issues
  and STOP (no amend). After the user fixes them and you re-review, start again
  from step 1 (the tree has changed, so a new attestation is required).
- \`"pass"\` → write the token into the HEAD commit as a trailer, then finish:

\`\`\`sh
git commit --amend --no-edit --trailer "Reviewed-Token: $ATT_TOKEN"
\`\`\`
Set \`ATT_TOKEN\` to the response's \`token\` field. The amend rewrites the HEAD
commit sha but leaves the tree unchanged, so the token stays valid. Then tell the
user to \`git push\` (use \`--force-with-lease\` if the commit was already pushed).

Remind the user: **any later edit to the code changes the tree and invalidates
the attestation** — they must re-run this step before pushing again.

## 12. One-shot "ship it" — review → fix → attest → push → PR
Run this ONLY when the user explicitly asks to submit/ship a pull request
(提交 PR / 一键提 PR / 帮我提个 PR / review 完直接提 PR / ship it). You then drive the
WHOLE pipeline end-to-end. Because pushing and opening a PR are outward-facing and
hard to undo, **aggregate everything and confirm ONCE before the push**, then run
the rest automatically. If the user said "全自动 / 别问 / no confirm", skip the
confirmation.

### Order matters (why this sequence)
Fixes change the code → they change the **tree**. The attestation binds the tree.
So you must apply ALL fixes FIRST, let the code settle, and attest LAST — the
\`Reviewed-Token\` trailer only changes the commit message, not the tree, so the
token keeps covering exactly what ships. Never attest before fixing.

### Pipeline
1. **Branch — never commit to the default branch.** Get the current branch:
   \`\`\`sh
   git rev-parse --abbrev-ref HEAD
   \`\`\`
   If it is \`main\` or \`master\`, create a feature branch:
   \`\`\`sh
   git switch -c <branch>
   \`\`\`
   Name it FLAT and parse-safe: ASCII letters, digits, \`-\`/\`_\` only — no
   slashes, spaces, or \`feat/\`-style prefixes (e.g. \`fix-auth-null-check\`).
   Derive the name from the change.
2. **Commit the change** so there is a committed state to review:
   \`\`\`sh
   git add -A
   git commit -m "<concise message>"
   \`\`\`
3. **Review** the committed change — do steps 1–7 above with scope \`branch\`.
4. **Fix loop.** If there are must-fix findings, run the one-shot fix (step 8) for
   the mechanical ones, then fold them into the commit:
   \`\`\`sh
   git add -A
   git commit --amend --no-edit
   \`\`\`
   Then **re-review the amended code**. Repeat until either no must-fix findings
   remain, OR the only ones left need human judgement — in that case list them and
   STOP (do not open a PR that the gate will just block).
5. **Attest the FINAL code** — do step 11 now that the tree is stable. On
   \`verdict: "pass"\`, it amends the \`Reviewed-Token\` trailer in. On
   \`verdict: "fail"\`, STOP and report; the merge gate would block it.
6. **Show the plan & confirm once** (skip if pre-authorized): branch name, final
   commit message, files changed, a review summary (counts + what was auto-fixed),
   and the PR title/body you will use. Ask a single yes/no.
7. **Push** the branch:
   \`\`\`sh
   git push -u origin <branch>
   \`\`\`
   Add \`--force-with-lease\` if the branch was pushed before and you amended.
8. **Open the PR** (requires \`gh\` installed + authenticated — check
   \`gh auth status\`; if not available, stop after the push and tell the user to
   open the PR manually):
   \`\`\`sh
   gh pr create --base main --title "<title>" --body "<body>"
   \`\`\`
   Put the review summary in the body plus a line like
   \`🤖 reviewed locally via ReviewPilot (attested)\`. Show the returned PR URL.

Keep the whole run in this session; report each stage briefly (branch → commit →
review → fixes → attest verdict → push → PR URL) so the user can follow along.
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
  Review the user's LOCAL code changes — the same review kernel as the ReviewPilot
  service, run on this machine.${descSuffix} USE THIS whenever the user wants to
  review their OWN changes, in ANY phrasing — e.g. "review 一下 / 审一下 / 帮我
  review / 评审 / 审查 / 看下我的改动 / review my changes / check my diff", or names
  a reviewer ("让 X 帮我 review"). Prefer this over any generic review for local
  changes; it covers the working-tree diff, a branch diff, or a checked-out PR.
  Reports only must-fix (major/critical) by default; adjust in natural language
  ("也看次要的" / "显示全部").
allowed-tools: ${SKILL_ALLOWED_TOOLS}
---

# ReviewPilot — local code review

Review the user's LOCAL code changes the way the ReviewPilot service would, but
running here — you are the review engine. Prefer fewer high-quality findings over
noise. Write the ENTIRE review report in **中文 (Chinese)** by default — finding titles,
explanations, and suggested fixes. Only switch language if the user explicitly
asks (or a ruleset specifies a different output language). The banner line stays
as-is.

${BANNER_INSTRUCTION}

${rulesetSections.join("\n")}## 1. Choose the scope
Default to **working** unless the user says otherwise:
- **working** — uncommitted changes: \`git diff HEAD\` plus untracked files
  (\`git ls-files --others --exclude-standard\`).
  Run commands as SIMPLE single invocations from the current directory — no
  \`cd\`, no \`&&\` chains, no \`$(…)\` substitution — so they stay auto-approvable.
- **branch** — current branch vs a base (default \`main\`):
  do it in TWO simple steps (avoid \`$(…)\`): first \`git merge-base <base> HEAD\`,
  then \`git diff <that-sha>..HEAD\`.
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

# Optional structural-context engine: code-review-graph via a USER-scoped MCP, so
# the skill's risk-hotspot / impacted-caller / test-gap step works in every
# project. The skill works fine WITHOUT it. uvx fetches the package lazily on
# first launch. If uv is missing we interactively offer to install it (reading
# the answer from /dev/tty so it works even under \`curl … | sh\`); skipping is
# safe, and a non-interactive run (CI) skips automatically. Never fatal.
GRAPH_CMD="claude mcp add -s user code-review-graph -- uvx code-review-graph serve"
register_graph_mcp() {
  if claude mcp list 2>/dev/null | grep -q "code-review-graph"; then
    echo "✓ code-review-graph MCP already registered (structural context on)"
  elif claude mcp add -s user code-review-graph -- uvx code-review-graph serve >/dev/null 2>&1; then
    echo "✓ Registered code-review-graph MCP (user scope) — structural context enabled"
  else
    echo "• Could not register the MCP automatically. Run later:  \$GRAPH_CMD"
  fi
}
if [ -n "\${REVIEWPILOT_NO_GRAPH:-}" ]; then
  echo "• Skipped structural-context setup (REVIEWPILOT_NO_GRAPH set)."
elif ! command -v claude >/dev/null 2>&1; then
  echo "• Structural context optional; Claude Code CLI not found — skipping."
elif command -v uvx >/dev/null 2>&1; then
  register_graph_mcp
else
  echo ""
  echo "可选增强:结构化上下文(风险热点 / 调用方 / 测试缺口)需要 uv (uvx)。"
  echo "不装也行 —— skill 照常评审,只是少这层上下文。"
  ans=n
  if [ -r /dev/tty ]; then
    printf "现在安装 uv 吗? [y/N] " > /dev/tty
    read ans < /dev/tty || ans=n
  fi
  case "\$ans" in
    y|Y|yes|YES)
      echo "→ 通过官方脚本安装 uv (https://astral.sh/uv) …"
      if curl -LsSf https://astral.sh/uv/install.sh | sh; then
        # uv installs to ~/.local/bin by default; surface it to this session.
        export PATH="\$HOME/.local/bin:\$PATH"
        if command -v uvx >/dev/null 2>&1; then
          echo "✓ uv 已安装。"
          register_graph_mcp
          echo "  注意:新开终端(或 source shell 配置)让 uvx 永久在 PATH。"
        else
          echo "✓ uv 已安装,但当前会话 PATH 未生效。新开终端后运行:  \$GRAPH_CMD"
        fi
      else
        echo "✗ uv 安装失败(网络?)。手动装好 uv 后运行:  \$GRAPH_CMD"
      fi
      ;;
    *)
      echo "• 已跳过。以后启用:先装 uv,再运行:  \$GRAPH_CMD"
      ;;
  esac
fi

echo "  In Claude Code, just ask: 评审一下我的改动  (or: review my changes)"
echo "  Or:  让 <用户名> 帮我 review 我的改动  (pulls that user's public rules)"
echo "  Tip: export REVIEWPILOT_TOKEN=rpat_…  to auto-grow your project's rules (account page)"
`;
}
