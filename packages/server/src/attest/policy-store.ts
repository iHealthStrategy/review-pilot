import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Severity } from "../domain/entities.js";
import type { AttestEnforce } from "../auth/attestation.js";

/**
 * Review-attestation enforcement policy — the "是否强制修复" control, managed at
 * runtime from the Web UI rather than pinned to an env var.
 *
 * TWO LAYERS:
 *  - a single GLOBAL default (project ""), seeded from env on first run;
 *  - any number of PER-PROJECT overrides keyed by the normalized project key
 *    (e.g. `github.com/acme/app`).
 * The EFFECTIVE policy for a project is its override when one exists, else the
 * global default. This lets different projects enforce different strictness
 * (e.g. one blocks at `major`, another only warns) without touching CI: the
 * server signs each attestation under the effective policy for that project.
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

/** A per-project override carrying its project key (for listing). */
export interface ProjectAttestPolicy extends AttestPolicy {
  /** Normalized project key this override governs. */
  project: string;
}

/** The resolved policy for a project, plus where it came from. */
export interface EffectiveAttestPolicy extends AttestPolicy {
  /** Normalized project key it was resolved for ("" = the global default). */
  project: string;
  /** `project` when a per-project override applied, else `global`. */
  source: "project" | "global";
}

/**
 * Persistence port for the layered policy. Callers pass an ALREADY-normalized
 * project key; an empty key means the global default.
 */
export interface AttestPolicyStore {
  init(): Promise<void>;
  /** The platform-wide default policy. */
  getGlobal(): Promise<AttestPolicy>;
  /** Effective policy for a project (its override if set, else the global). */
  getEffective(project: string): Promise<EffectiveAttestPolicy>;
  /** Set the global default (empty/omitted project) or a per-project override. */
  set(patch: AttestPolicyPatch, updatedBy: string, project?: string): Promise<AttestPolicy>;
  /** All per-project overrides (the global default is not included). */
  listOverrides(): Promise<ProjectAttestPolicy[]>;
  /** Remove a project override → that project falls back to the global default. */
  deleteOverride(project: string): Promise<void>;
  close(): Promise<void>;
}

export interface AttestPolicyDefaults {
  enforce: AttestEnforce;
  blockSeverity: Severity;
}

/** Shape persisted to disk (and the parse target for the legacy migration). */
interface PolicyFile {
  global: AttestPolicy;
  projects: Record<string, AttestPolicy>;
}

/**
 * File-backed (or pure in-memory when no path) store for the layered policy.
 * Mirrors {@link ../schedule/file-schedule-store.ts}: load once, rewrite the
 * whole (tiny) file on each change. In-memory is fine for tests and for the
 * `mongo` driver path (which uses {@link MongoAttestPolicyStore} instead).
 */
export class FileAttestPolicyStore implements AttestPolicyStore {
  private globalPolicy: AttestPolicy;
  private readonly projects = new Map<string, AttestPolicy>();
  private readonly defaults: AttestPolicyDefaults;
  private readonly filePath?: string;
  private readonly clock: () => string;

  constructor(opts: { defaults: AttestPolicyDefaults; filePath?: string; clock?: () => string }) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.defaults = opts.defaults;
    if (opts.filePath) this.filePath = opts.filePath;
    // Seed the global default from env; init() overrides from disk when present.
    this.globalPolicy = {
      enforce: opts.defaults.enforce,
      blockSeverity: opts.defaults.blockSeverity,
      updatedAt: "",
      updatedBy: "default",
    };
  }

  /** Fill a partial policy from the seeded default (tolerates missing fields). */
  private hydrate(p: Partial<AttestPolicy> | undefined): AttestPolicy {
    return {
      enforce: p?.enforce ?? this.defaults.enforce,
      blockSeverity: p?.blockSeverity ?? this.defaults.blockSeverity,
      updatedAt: p?.updatedAt ?? "",
      updatedBy: p?.updatedBy ?? "default",
    };
  }

  async init(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as
        | Partial<PolicyFile>
        | Partial<AttestPolicy>;
      if (parsed && typeof parsed === "object" && "global" in parsed) {
        // Current two-layer format.
        const f = parsed as Partial<PolicyFile>;
        this.globalPolicy = this.hydrate(f.global);
        this.projects.clear();
        for (const [key, value] of Object.entries(f.projects ?? {})) {
          if (key) this.projects.set(key, this.hydrate(value));
        }
      } else if (parsed && typeof parsed === "object") {
        // LEGACY flat format (a single global policy) → load it as the global.
        this.globalPolicy = this.hydrate(parsed as Partial<AttestPolicy>);
      }
    } catch (err) {
      // Missing file → keep the seeded default. A corrupt file should surface.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async getGlobal(): Promise<AttestPolicy> {
    return { ...this.globalPolicy };
  }

  async getEffective(project: string): Promise<EffectiveAttestPolicy> {
    const key = project || "";
    const override = key ? this.projects.get(key) : undefined;
    if (override) return { ...override, project: key, source: "project" };
    return { ...this.globalPolicy, project: key, source: "global" };
  }

  async set(patch: AttestPolicyPatch, updatedBy: string, project = ""): Promise<AttestPolicy> {
    const key = project || "";
    // A new override inherits the current global as its starting point.
    const base = key ? (this.projects.get(key) ?? this.globalPolicy) : this.globalPolicy;
    const next: AttestPolicy = {
      enforce: patch.enforce ?? base.enforce,
      blockSeverity: patch.blockSeverity ?? base.blockSeverity,
      updatedAt: this.clock(),
      updatedBy: updatedBy || "unknown",
    };
    if (key) this.projects.set(key, next);
    else this.globalPolicy = next;
    await this.persist();
    return { ...next };
  }

  async listOverrides(): Promise<ProjectAttestPolicy[]> {
    return [...this.projects.entries()].map(([project, p]) => ({ ...p, project }));
  }

  async deleteOverride(project: string): Promise<void> {
    const key = project || "";
    if (key && this.projects.delete(key)) await this.persist();
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const file: PolicyFile = {
      global: this.globalPolicy,
      projects: Object.fromEntries(this.projects),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }
}
