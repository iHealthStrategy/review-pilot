import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { GitHubProvider } from "../src/providers/github-provider.js";
import type { GitProvider } from "../src/providers/git-provider.js";
import { TriggerService } from "../src/trigger/trigger-service.js";
import { startWebhookServer } from "../src/trigger/webhook-server.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";

const SECRET = "s3cret";
const ghPull = {
  number: 7,
  title: "Add feature",
  state: "open",
  html_url: "https://github.com/acme/demo/pull/7",
  user: { login: "alice" },
  head: { ref: "feat", sha: "abc123" },
  base: { ref: "main" },
};
const routes: Route[] = [{ method: "GET", urlIncludes: "pulls/7", body: ghPull }];

function providerFor(_platform: Platform): GitProvider {
  return new GitHubProvider(new FakeHttpClient(routes), {
    apiBase: "https://api.github.com",
    token: "",
    webhookSecret: SECRET,
  });
}

test("webhook server: POST /webhook/github creates a job over real HTTP", async () => {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const project = await repo.createProject({
    name: "demo",
    platform: "github",
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  await repo.createRepo({
    projectId: project.id,
    platform: "github",
    fullName: "acme/demo",
    remoteUrl: "https://github.com/acme/demo",
    cloneUrl: "https://github.com/acme/demo.git",
    defaultBranch: "main",
  });
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const server = startWebhookServer(service, 0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const rawBody = JSON.stringify({
      action: "opened",
      pull_request: { number: 7, head: { sha: "abc123" } },
      repository: { full_name: "acme/demo" },
    });
    const digest = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${digest}`,
      },
      body: rawBody,
    });
    assert.equal(res.status, 202);
    const outcome = (await res.json()) as { status: string };
    assert.equal(outcome.status, "created");
    assert.equal((await repo.listReviewJobs()).length, 1);
  } finally {
    server.close();
  }
});

test("webhook server: unknown route returns 404", async () => {
  const repo = new MemoryRepository();
  await repo.init();
  const service = new TriggerService({ repo, providerFor, defaultEngine: "mock" });
  const server = startWebhookServer(service, 0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
