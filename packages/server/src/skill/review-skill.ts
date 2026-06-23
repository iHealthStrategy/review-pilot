import type { ReviewRuleset } from "../domain/entities.js";
import { FINDING_SCHEMA_FIELDS, REVIEW_DIMENSIONS } from "../review/prompt.js";

/**
 * The local Claude Code "skill" — a SKILL.md that drives the user's own Claude
 * Code as the review engine, using the SAME review kernel as the service (review
 * dimensions + finding schema, imported from the prompt module so they never
 * drift) but running entirely on the user's machine. Without a ruleset it is the
 * generic reviewer; with a community ruleset it weaves in that ruleset's
 * preferences + custom rules. Distributed via a one-line installer.
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

/** Collapse whitespace so user text is safe inside YAML frontmatter. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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
        "## Custom rules",
        "Apply these rules in addition to the standard review:",
        "",
        ruleset.instructions.trim(),
      );
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
Look for ${REVIEW_DIMENSIONS}${ruleset ? ", and apply the ruleset's custom rules above" : ""}.
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
`;
}
