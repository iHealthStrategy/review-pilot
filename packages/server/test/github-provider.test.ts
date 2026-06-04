import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { GitHubProvider } from "../src/providers/github-provider.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { runGitProviderContract } from "./git-provider-contract.js";

const SECRET = "s3cret";

const ghPull = {
  number: 7,
  title: "Add feature",
  state: "open",
  merged: false,
  html_url: "https://github.com/acme/demo/pull/7",
  user: { login: "alice" },
  head: { ref: "feat", sha: "abc123" },
  base: { ref: "main" },
};

const routes: Route[] = [
  {
    method: "GET",
    urlIncludes: "pulls/7/files",
    body: [
      { filename: "src/new.ts", status: "added", additions: 10, deletions: 0, patch: "@@ -0,0" },
      { filename: "src/mod.ts", status: "modified", additions: 3, deletions: 1 },
      { filename: "src/renamed.ts", previous_filename: "src/old.ts", status: "renamed" },
    ],
  },
  { method: "GET", urlIncludes: "pulls?state=open", body: [ghPull] },
  { method: "GET", urlIncludes: "pulls/7", body: ghPull },
  { method: "POST", urlIncludes: "issues/7/comments", body: { id: 123, html_url: "https://github.com/acme/demo/pull/7#c123" } },
  { method: "POST", urlIncludes: "check-runs", body: { id: 555, html_url: "https://github.com/acme/demo/runs/555" } },
  { method: "PATCH", urlIncludes: "check-runs", body: { id: 555 } },
];

function makeProvider() {
  const http = new FakeHttpClient(routes);
  const provider = new GitHubProvider(http, {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: SECRET,
  });
  return { http, provider };
}

runGitProviderContract("GitHubProvider", () => ({
  provider: makeProvider().provider,
  repo: { fullName: "acme/demo" },
}));

test("GitHubProvider: verifyWebhook accepts a valid HMAC signature", () => {
  const { provider } = makeProvider();
  const rawBody = JSON.stringify({ hello: "world" });
  const digest = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  const result = provider.verifyWebhook({
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    rawBody,
  });
  assert.equal(result.valid, true);
});

test("GitHubProvider: verifyWebhook rejects a tampered body", () => {
  const { provider } = makeProvider();
  const digest = createHmac("sha256", SECRET).update("original").digest("hex");
  const result = provider.verifyWebhook({
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    rawBody: "tampered",
  });
  assert.equal(result.valid, false);
});

test("GitHubProvider: parseWebhook extracts a reviewable PR event", () => {
  const { provider } = makeProvider();
  const event = provider.parseWebhook({
    headers: { "x-github-event": "pull_request" },
    rawBody: JSON.stringify({
      action: "opened",
      pull_request: { number: 7, head: { sha: "abc123" } },
      repository: { full_name: "acme/demo" },
    }),
  });
  assert.equal(event?.number, 7);
  assert.equal(event?.repoFullName, "acme/demo");
  assert.equal(event?.headSha, "abc123");
  assert.equal(event?.reviewable, true);
});

test("GitHubProvider: parseWebhook ignores non-PR events", () => {
  const { provider } = makeProvider();
  const event = provider.parseWebhook({
    headers: { "x-github-event": "push" },
    rawBody: "{}",
  });
  assert.equal(event, null);
});

test("GitHubProvider: createCheckRun posts a completed check with a conclusion", async () => {
  const { http, provider } = makeProvider();
  const check = await provider.createCheckRun!(
    { fullName: "acme/demo" },
    { name: "ReviewPilot", headSha: "abc123", conclusion: "failure", title: "2 findings", summary: "..." },
  );
  assert.equal(check.id, "555");
  const post = http.requests.find((r) => r.method === "POST" && r.url.includes("check-runs"))!;
  const sent = JSON.parse(post.body ?? "{}");
  assert.equal(sent.head_sha, "abc123");
  assert.equal(sent.status, "completed");
  assert.equal(sent.conclusion, "failure");
  assert.equal(sent.output.title, "2 findings");
});

test("GitHubProvider: createCheckRun sends inline annotations (batched in 50s)", async () => {
  const { http, provider } = makeProvider();
  // 51 annotations → one create (50) + one PATCH (1).
  const annotations = Array.from({ length: 51 }, (_v, i) => ({
    path: "src/a.ts",
    startLine: i + 1,
    endLine: i + 1,
    level: "warning" as const,
    title: "Nit",
    message: "m",
  }));
  await provider.createCheckRun!(
    { fullName: "acme/demo" },
    { name: "ReviewPilot", headSha: "abc123", conclusion: "neutral", title: "t", summary: "s", annotations },
  );
  const post = http.requests.find((r) => r.method === "POST" && r.url.includes("check-runs"))!;
  const created = JSON.parse(post.body ?? "{}");
  assert.equal(created.output.annotations.length, 50);
  assert.equal(created.output.annotations[0].path, "src/a.ts");
  assert.equal(created.output.annotations[0].start_line, 1);
  assert.equal(created.output.annotations[0].annotation_level, "warning");
  // Remaining annotation appended via PATCH to the created check.
  const patch = http.requests.find((r) => r.method === "PATCH" && r.url.includes("check-runs/555"))!;
  assert.ok(patch, "second batch sent via PATCH");
  assert.equal(JSON.parse(patch.body ?? "{}").output.annotations.length, 1);
});

test("GitHubProvider: cloneUrl injects the token when present", async () => {
  const http = new FakeHttpClient(routes);
  const provider = new GitHubProvider(http, {
    apiBase: "https://api.github.com",
    token: "ghtoken",
    webhookSecret: SECRET,
  });
  assert.equal(
    await provider.cloneUrl({ fullName: "acme/demo" }),
    "https://x-access-token:ghtoken@github.com/acme/demo.git",
  );
});
