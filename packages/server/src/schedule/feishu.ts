import type { Severity } from "../domain/entities.js";
import type { ScanResult } from "./scan-service.js";

/** Minimal HTTP POST seam returning the response (injectable; defaults to fetch). */
export type FeishuSender = (
  url: string,
  body: string,
) => Promise<{ status: number; text: string }>;

const fetchSender: FeishuSender = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: res.status, text: await res.text() };
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🟥",
  major: "🟧",
  minor: "🟨",
  info: "⬜",
};

/**
 * Neutralize lark_md control characters in untrusted strings (branch names,
 * finding titles, engine stderr) so a crafted value can't inject markup, fake
 * links, code spans, or @mentions into a card a human trusts. Emphasis/code/link
 * markers become spaces; `@` is broken with a zero-width space.
 */
function lk(s: string): string {
  return String(s)
    .replace(/[`*_~[\]()<>#|]/g, " ")
    .replace(/@/g, "@​");
}

/**
 * Render a daily-scan result as a Feishu (Lark) interactive card payload.
 * Header turns red when there are findings, green when the day was clean.
 */
export function formatScanCard(result: ScanResult): unknown {
  const lines: string[] = [`**仓库**: ${lk(result.repoFullName)}　**日期**: ${lk(result.date)}`];
  if (result.branches.length === 0) {
    lines.push("\n今日无改动。");
  } else {
    for (const b of result.branches) {
      if (b.error) {
        lines.push(`\n**${lk(b.branch)}** （${b.commitCount} 次提交）：⚠️ 评审失败（${lk(b.error)}）`);
        continue;
      }
      lines.push(`\n**${lk(b.branch)}** （${b.commitCount} 次提交）：${b.findings.length} 个问题`);
      for (const f of b.findings.slice(0, 10)) {
        const loc = `${lk(f.filePath)}${f.line ? ":" + f.line : ""}`;
        lines.push(`${SEVERITY_EMOJI[f.severity]} \`${loc}\` ${lk(f.title)}`);
      }
      if (b.findings.length > 10) lines.push(`…以及另外 ${b.findings.length - 10} 个`);
    }
  }
  return {
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: `🤖 ReviewPilot 每日扫描 · ${result.totalFindings} 个问题`,
        },
        template: result.totalFindings > 0 ? "red" : "green",
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
    },
  };
}

/**
 * Deliver a scan result to a Feishu custom-bot incoming webhook. Best-effort:
 * never throws (a misconfigured webhook must not crash the scheduled run); the
 * outcome is returned for logging.
 */
export async function deliverFeishu(
  webhookUrl: string,
  result: ScanResult,
  send: FeishuSender = fetchSender,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await send(webhookUrl, JSON.stringify(formatScanCard(result)));
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}: ${res.text.slice(0, 200)}` };
    }
    // Feishu returns 200 even on rejection — the body's `code` is the real
    // status (0 = ok; e.g. 19007 "Bot Not Enabled", 19021 "sign match fail").
    try {
      const body = JSON.parse(res.text) as { code?: number; msg?: string };
      if (typeof body.code === "number" && body.code !== 0) {
        return { ok: false, error: `feishu code ${body.code}: ${body.msg ?? ""}` };
      }
    } catch {
      // Non-JSON 2xx body — treat as delivered.
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
