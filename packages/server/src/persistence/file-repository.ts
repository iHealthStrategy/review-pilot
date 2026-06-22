import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemoryRepository,
  type MemoryRepositoryOptions,
  type MemorySnapshot,
} from "./memory-repository.js";

/**
 * Durable, dependency-free repository: the in-memory store written through to
 * a JSON file after every mutation and loaded on `init()`. This is the second
 * *real* backend that proves the persistence port is switchable, and it works
 * on any Node version with no native modules.
 *
 * (The SQL backend — see {@link ./sql/sql-repository.ts} — implements the same
 * port against an injectable driver for when SQLite/Postgres is wired in.)
 */
export class FileRepository extends MemoryRepository {
  constructor(
    private readonly filePath: string,
    options: MemoryRepositoryOptions = {},
  ) {
    super(options);
  }

  protected override async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemorySnapshot>;
      this.data = {
        projects: parsed.projects ?? {},
        repos: parsed.repos ?? {},
        pullRequests: parsed.pullRequests ?? {},
        reviewJobs: parsed.reviewJobs ?? {},
        findings: parsed.findings ?? {},
        repoInsights: parsed.repoInsights ?? {},
        users: parsed.users ?? {},
        apiTokens: parsed.apiTokens ?? {},
        tokenUsage: parsed.tokenUsage ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First run: no file yet — start empty and create it on first persist.
        await this.persist();
        return;
      }
      throw err;
    }
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.data, null, 2)}\n`,
      "utf8",
    );
  }
}
