import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import { FINDING_SCHEMA_FIELDS } from "../src/review/prompt.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import {
  SKILL_NAME,
  buildInstallScript,
  buildReviewSkill,
} from "../src/skill/review-skill.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

test("buildReviewSkill: valid frontmatter + shared finding schema (no drift)", () => {
  const md = buildReviewSkill();
  assert.match(md, /^---\nname: reviewpilot-review\n/);
  assert.match(md, /description:/);
  // The finding schema is the SAME one the service prompt uses.
  assert.ok(md.includes(FINDING_SCHEMA_FIELDS), "embeds the shared finding schema");
  assert.match(md, /working/);
  assert.match(md, /code-review-graph/); // structural context step
});

test("buildInstallScript: writes the skill into ~/.claude/skills via a heredoc", () => {
  const sh = buildInstallScript(buildReviewSkill());
  assert.match(sh, /\$HOME\/\.claude\/skills\/reviewpilot-review/);
  assert.match(sh, /<<'REVIEWPILOT_SKILL_EOF'/);
  assert.match(sh, /^REVIEWPILOT_SKILL_EOF$/m); // closing delimiter on its own line
  assert.ok(sh.includes("name: " + SKILL_NAME));
});

async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  // Auth ON — the skill artifacts must still be reachable without a credential.
  const server = startAppServer({ repo, taskService, sessionSecret: "secret" }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

test("GET /skill/install.sh is public (no auth) and returns a shell installer", () =>
  withApp(async (base) => {
    const res = await fetch(`${base}/skill/install.sh`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /shellscript/);
    const body = await res.text();
    assert.match(body, /mkdir -p/);
    assert.match(body, /reviewpilot-review/);
  }));

test("GET /skill/<name>/SKILL.md serves the raw skill", () =>
  withApp(async (base) => {
    const res = await fetch(`${base}/skill/${SKILL_NAME}/SKILL.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /markdown/);
    assert.match(await res.text(), /name: reviewpilot-review/);
  }));
