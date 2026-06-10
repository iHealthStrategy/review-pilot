import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverFeishu, formatScanCard } from "../src/schedule/feishu.js";
import type { ScanResult } from "../src/schedule/scan-service.js";

const withFindings: ScanResult = {
  repoFullName: "acme/demo",
  date: "2026-06-10",
  branches: [
    {
      branch: "main",
      commitCount: 3,
      findings: [
        { filePath: "src/a.ts", line: 12, severity: "major", title: "Null deref", detail: "" },
      ],
    },
  ],
  totalFindings: 1,
};

const clean: ScanResult = {
  repoFullName: "acme/demo",
  date: "2026-06-10",
  branches: [],
  totalFindings: 0,
};

test("formatScanCard: red header + finding lines when issues exist", () => {
  const card = formatScanCard(withFindings) as {
    card: { header: { template: string }; elements: { text: { content: string } }[] };
  };
  assert.equal(card.card.header.template, "red");
  const content = card.card.elements[0]!.text.content;
  assert.match(content, /acme\/demo/);
  assert.match(content, /main/);
  assert.match(content, /src\/a\.ts:12/);
});

test("formatScanCard: green header + 'no changes' when clean", () => {
  const card = formatScanCard(clean) as { card: { header: { template: string } } };
  assert.equal(card.card.header.template, "green");
});

test("deliverFeishu: posts the card; never throws on a failing endpoint", async () => {
  const sent: string[] = [];
  const ok = await deliverFeishu("https://hook", withFindings, async (_u, b) => {
    sent.push(b);
  });
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /interactive/);

  const bad = await deliverFeishu("https://hook", withFindings, async () => {
    throw new Error("refused");
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /refused/);
});
