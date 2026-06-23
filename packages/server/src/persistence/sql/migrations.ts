import type { SqlClient, SqlDialect } from "./sql-client.js";

/**
 * A single forward migration. `up` receives the dialect so a migration can
 * diverge per backend; the current schema is dialect-portable (TEXT/INTEGER
 * only), so the SQL is identical for both today.
 */
export interface Migration {
  readonly id: string;
  up(dialect: SqlDialect): string;
}

/**
 * Ordered migration registry. Append new migrations; never edit applied ones.
 * The schema mirrors the domain entities one table per entity.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_init",
    up: () => `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        default_engine TEXT NOT NULL,
        enabled_engines TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        platform TEXT NOT NULL,
        full_name TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repos_lookup ON repos(platform, full_name);
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (repo_id, number)
      );
      CREATE TABLE IF NOT EXISTS review_jobs (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL REFERENCES pull_requests(id),
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        error TEXT,
        logs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        review_job_id TEXT NOT NULL REFERENCES review_jobs(id),
        file_path TEXT NOT NULL,
        line INTEGER,
        end_line INTEGER,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        suggestion TEXT,
        category TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_review_jobs_status ON review_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_findings_job ON findings(review_job_id);
    `,
  },
  {
    id: "0002_repo_insights",
    up: () => `
      CREATE TABLE IF NOT EXISTS repo_insights (
        repo_id TEXT PRIMARY KEY REFERENCES repos(id),
        summary TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "0003_users_tokens",
    up: () => `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    id: "0004_token_usage",
    up: () => `
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_label TEXT NOT NULL,
        engine TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        estimated INTEGER NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_at ON token_usage(at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, source_id);
    `,
  },
  {
    id: "0005_rulesets",
    up: () => `
      CREATE TABLE IF NOT EXISTS rulesets (
        id TEXT PRIMARY KEY,
        -- No FK to users: the env-configured admin owns rulesets without a DB row.
        owner_id TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL,
        visibility TEXT NOT NULL,
        language TEXT NOT NULL,
        focus TEXT NOT NULL,
        instructions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rulesets_owner ON rulesets(owner_id);
      CREATE INDEX IF NOT EXISTS idx_rulesets_visibility ON rulesets(visibility);
    `,
  },
  {
    id: "0006_handles_and_rules",
    up: () => `
      ALTER TABLE users ADD COLUMN handle TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
      ALTER TABLE rulesets ADD COLUMN owner_handle TEXT NOT NULL DEFAULT '';
      ALTER TABLE rulesets ADD COLUMN rules TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX IF NOT EXISTS idx_rulesets_owner_handle ON rulesets(owner_handle);
    `,
  },
  {
    id: "0007_ruleset_project",
    up: () => `
      ALTER TABLE rulesets ADD COLUMN project TEXT NOT NULL DEFAULT '';
      ALTER TABLE rulesets ADD COLUMN project_label TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_rulesets_owner_project ON rulesets(owner_id, project);
    `,
  },
];

/**
 * Apply all not-yet-applied migrations in order, recording each in a
 * `_migrations` ledger table. Idempotent: re-running applies nothing.
 */
export async function runMigrations(client: SqlClient): Promise<string[]> {
  await client.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );
  const applied = new Set(
    (
      await client.all<{ id: string }>("SELECT id FROM _migrations")
    ).map((r) => r.id),
  );
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await client.exec(migration.up(client.dialect));
    await client.run(
      `INSERT INTO _migrations (id, applied_at) VALUES (${
        client.dialect === "postgres" ? "$1, $2" : "?, ?"
      })`,
      [migration.id, new Date().toISOString()],
    );
    ran.push(migration.id);
  }
  return ran;
}
