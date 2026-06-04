import type { Finding, Severity } from "../domain/entities.js";
import type {
  GitProvider,
  ProviderComment,
  RepoRef,
} from "../providers/git-provider.js";

/**
 * Hidden marker placed at the top of every ReviewPilot summary comment so the
 * worker can find and UPDATE its prior comment on a re-review instead of
 * posting a new one each push (avoids comment spam).
 */
export const SUMMARY_MARKER = "<!-- reviewpilot:summary -->";

/** The finding fields a summary comment renders (Finding and FindingDraft both satisfy this). */
export type CommentFinding = Pick<Finding, "filePath" | "severity" | "title" | "detail"> & {
  line?: number;
  suggestion?: string;
};

/**
 * Deliver the summary comment to a PR/MR, UPDATING our prior comment in place
 * when the provider supports listing/editing (avoids a fresh comment on every
 * push); otherwise posts a new one. Shared by the long-running worker and the
 * one-shot GitHub Action.
 */
export async function deliverSummaryComment(
  provider: GitProvider,
  repo: RepoRef,
  number: number,
  body: string,
): Promise<ProviderComment> {
  if (provider.listComments && provider.updateComment) {
    const existing = (await provider.listComments(repo, number)).find((c) =>
      (c.body ?? "").includes(SUMMARY_MARKER),
    );
    if (existing) {
      return provider.updateComment(repo, number, existing.id, body);
    }
  }
  return provider.postComment(repo, number, body);
}

const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "info"];
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🛑 Critical",
  major: "⚠️ Major",
  minor: "🔸 Minor",
  info: "ℹ️ Info",
};

/**
 * Render findings into a single Markdown summary comment for write-back to the
 * PR/MR. Groups by severity (highest first) and lists file:line + suggestion.
 */
export function formatFindingsComment(
  findings: CommentFinding[],
  meta: { engine: string; prNumber: number },
): string {
  const header = `${SUMMARY_MARKER}\n## 🤖 ReviewPilot review\n\nEngine: \`${meta.engine}\` · PR #${meta.prNumber}\n`;
  if (findings.length === 0) {
    return `${header}\nNo issues found. ✅`;
  }

  const counts = SEVERITY_ORDER.map((s) => {
    const n = findings.filter((f) => f.severity === s).length;
    return n > 0 ? `${SEVERITY_LABEL[s]}: ${n}` : null;
  }).filter(Boolean);
  const summary = `\n**${findings.length} finding(s)** — ${counts.join(" · ")}\n`;

  const sections: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    sections.push(`\n### ${SEVERITY_LABEL[severity]}`);
    for (const f of group) {
      const loc = f.line ? `\`${f.filePath}:${f.line}\`` : `\`${f.filePath}\``;
      const lines = [`- ${loc} — **${f.title}**`, `  - ${f.detail}`];
      if (f.suggestion) lines.push(`  - 💡 ${f.suggestion}`);
      sections.push(lines.join("\n"));
    }
  }
  return header + summary + sections.join("\n");
}
