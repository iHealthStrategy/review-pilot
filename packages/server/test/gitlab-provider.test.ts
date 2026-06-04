import assert from "node:assert/strict";
import { test } from "node:test";
import { GitLabProvider } from "../src/providers/gitlab-provider.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { runGitProviderContract } from "./git-provider-contract.js";

const SECRET = "gl-token";

const glMr = {
  iid: 7,
  title: "Add feature",
  state: "opened",
  web_url: "https://gitlab.com/acme/demo/-/merge_requests/7",
  source_branch: "feat",
  target_branch: "main",
  sha: "abc123",
  author: { username: "alice" },
};

const routes: Route[] = [
  {
    method: "GET",
    urlIncludes: "merge_requests/7/changes",
    body: {
      changes: [
        { old_path: "src/new.ts", new_path: "src/new.ts", new_file: true, diff: "@@" },
        { old_path: "src/mod.ts", new_path: "src/mod.ts", diff: "@@" },
        { old_path: "src/old.ts", new_path: "src/renamed.ts", renamed_file: true },
      ],
    },
  },
  { method: "GET", urlIncludes: "merge_requests?state=opened", body: [glMr] },
  { method: "GET", urlIncludes: "merge_requests/7", body: glMr },
  { method: "POST", urlIncludes: "merge_requests/7/notes", body: { id: 456 } },
];

function makeProvider() {
  const http = new FakeHttpClient(routes);
  const provider = new GitLabProvider(http, {
    apiBase: "https://gitlab.com/api/v4",
    token: "",
    webhookSecret: SECRET,
  });
  return { http, provider };
}

runGitProviderContract("GitLabProvider", () => ({
  provider: makeProvider().provider,
  repo: { fullName: "acme/demo" },
}));

test("GitLabProvider: getPullRequestDiff handles added/modified/renamed", async () => {
  const { provider } = makeProvider();
  const diff = await provider.getPullRequestDiff({ fullName: "acme/demo" }, 7);
  assert.equal(diff.length, 3);
});

test("GitLabProvider: verifyWebhook accepts matching token", () => {
  const { provider } = makeProvider();
  const result = provider.verifyWebhook({
    headers: { "x-gitlab-token": SECRET },
    rawBody: "{}",
  });
  assert.equal(result.valid, true);
});

test("GitLabProvider: verifyWebhook rejects mismatched token", () => {
  const { provider } = makeProvider();
  const result = provider.verifyWebhook({
    headers: { "x-gitlab-token": "wrong" },
    rawBody: "{}",
  });
  assert.equal(result.valid, false);
});

test("GitLabProvider: parseWebhook extracts a reviewable MR event", () => {
  const { provider } = makeProvider();
  const event = provider.parseWebhook({
    headers: { "x-gitlab-event": "Merge Request Hook" },
    rawBody: JSON.stringify({
      object_kind: "merge_request",
      project: { path_with_namespace: "acme/demo" },
      object_attributes: { iid: 7, action: "open", last_commit: { id: "abc123" } },
    }),
  });
  assert.equal(event?.platform, "gitlab");
  assert.equal(event?.number, 7);
  assert.equal(event?.repoFullName, "acme/demo");
  assert.equal(event?.headSha, "abc123");
  assert.equal(event?.reviewable, true);
});

test("GitLabProvider: cloneUrl injects oauth2 token when present", async () => {
  const http = new FakeHttpClient(routes);
  const provider = new GitLabProvider(http, {
    apiBase: "https://gitlab.com/api/v4",
    token: "gltoken",
    webhookSecret: SECRET,
  });
  assert.equal(
    await provider.cloneUrl({ fullName: "acme/demo" }),
    "https://oauth2:gltoken@gitlab.com/acme/demo.git",
  );
});
