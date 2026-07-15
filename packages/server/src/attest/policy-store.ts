import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Severity } from "../domain/entities.js";
import type { AttestEnforce } from "../auth/attestation.js";

/**
 * The GLOBAL review-attestation enforcement policy — the "是否强制修复" control,
 * managed at runtime from the Web UI rather than pinned to an env var. There is
 * exactly one (platform-wide); the env values (`ATTEST_ENFORCE`,
 * `ATTEST_BLOCK_SEVERITY`) only SEED the first run, after which the stored value
 * is authoritative.
 */
export interface AttestPolicy {
  /** off = advisory; warn = never block; block = fail at/above blockSeverity. */
  enforce: AttestEnforce;
  /** Severity at/above which findings fail the verdict under `block`. */
  blockSeverity: Severity;
  /** ISO timestamp of the last change (empty = still the seeded default). */
  updatedAt: string;
  /** Who last changed it (handle/email), or "default" while unset. */
  updatedBy: string;
}

export interface AttestPolicyPatch {
  enforce?: AttestEnforce;
  blockSeverity?: Severity;
}

/** Persistence port for the single global policy. */
export interface AttestPolicyStore {
  init(): Promise<void>;
  get(): Promise<AttestPolicy>;
  set(patch: AttestPolicyPatch, updatedBy: string): Promise<AttestPolicy>;
  close(): Promise<void>;
}

export interface AttestPolicyDefaults {
  enforce: AttestEnforce;
  blockSeverity: Severity;
}

/**
 * File-backed (or pure in-memory when no path) store for the single global
 * policy. Mirrors {@link ../schedule/file-schedule-store.ts}: load once, rewrite
 * the whole (tiny) file on each change. In-memory is fine for tests and for the
 * `mongo` driver path (which uses {@link MongoAttestPolicyStore} instead).
 */
export class FileAttestPolicyStore implements AttestPolicyStore {
  private current: AttestPolicy;
  private readonly filePath?: string;
  private readonly clock: () => string;

  constructor(opts: { defaults: AttestPolicyDefaults; filePath?: string; clock?: () => string }) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    if (opts.filePath) this.filePath = opts.filePath;
    // Seed from the env defaults; init() overrides from disk when present.
    this.current = {
      enforce: opts.defaults.enforce,
      blockSeverity: opts.defaults.blockSeverity,
      updatedAt: "",
      updatedBy: "default",
    };
  }

  async init(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AttestPolicy>;
      this.current = {
        enforce: parsed.enforce ?? this.current.enforce,
        blockSeverity: parsed.blockSeverity ?? this.current.blockSeverity,
        updatedAt: parsed.updatedAt ?? "",
        updatedBy: parsed.updatedBy ?? "default",
      };
    } catch (err) {
      // Missing file → keep the seeded default. A corrupt file should surface.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async get(): Promise<AttestPolicy> {
    return { ...this.current };
  }

  async set(patch: AttestPolicyPatch, updatedBy: string): Promise<AttestPolicy> {
    this.current = {
      enforce: patch.enforce ?? this.current.enforce,
      blockSeverity: patch.blockSeverity ?? this.current.blockSeverity,
      updatedAt: this.clock(),
      updatedBy: updatedBy || "unknown",
    };
    await this.persist();
    return { ...this.current };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.current, null, 2), "utf8");
  }
}
