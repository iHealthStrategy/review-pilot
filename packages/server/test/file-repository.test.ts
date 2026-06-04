import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileRepository } from "../src/persistence/file-repository.js";
import {
  fixedClock,
  runRepositoryContract,
  seqIdGen,
} from "./repository-contract.js";

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reviewpilot-"));
  return join(dir, "db.json");
}

runRepositoryContract("FileRepository", async () => {
  const repo = new FileRepository(await tempDbPath(), {
    clock: fixedClock(),
    idGen: seqIdGen(),
  });
  await repo.init();
  return repo;
});

test("FileRepository: state survives a reload from disk", async () => {
  const path = await tempDbPath();
  const first = new FileRepository(path, {
    clock: fixedClock(),
    idGen: seqIdGen(),
  });
  await first.init();
  const project = await first.createProject({
    name: "persisted",
    platform: "gitlab",
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  await first.close();

  const second = new FileRepository(path);
  await second.init();
  const reloaded = await second.getProject(project.id);
  assert.deepEqual(reloaded, project);
  await second.close();

  await rm(path, { force: true });
});
