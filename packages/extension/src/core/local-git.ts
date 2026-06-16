import type { CommandRunner } from "../../../server/src/review/command-runner.js";
import type {
  DiffFile,
  DiffFileStatus,
} from "../../../server/src/providers/git-provider.js";

/** Scope of a local review. Decides how the diff (if any) is built. */
export type LocalReviewMode = "working" | "branch" | "full";

/** Map a `git diff --name-status` letter to our normalised status. */
function mapStatus(code: string): DiffFileStatus {
  const c = code[0];
  if (c === "A") return "added";
  if (c === "D") return "removed";
  if (c === "R") return "renamed";
  return "modified";
}

/** Run a git command in `dir`; throw with stderr on non-zero exit. */
async function git(
  runner: CommandRunner,
  dir: string,
  args: string[],
): Promise<string> {
  const res = await runner.run("git", ["-C", dir, ...args]);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

/**
 * Build `DiffFile[]` for a diff range expressed as extra `git diff` args
 * (e.g. `["HEAD"]` or `["<base>..HEAD"]`). Mirrors the server scan-service's
 * `collectDiff`: a name-status pass to enumerate files, then a per-file patch.
 */
async function diffForRange(
  runner: CommandRunner,
  dir: string,
  rangeArgs: string[],
): Promise<DiffFile[]> {
  const nameStatus = await git(runner, dir, ["diff", "--name-status", ...rangeArgs]);
  const files: DiffFile[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = mapStatus(parts[0] ?? "");
    const path = (status === "renamed" ? parts[2] : parts[1]) ?? "";
    if (!path) continue;
    const previousPath = status === "renamed" ? parts[1] : undefined;
    const patch = await git(runner, dir, ["diff", ...rangeArgs, "--", path]);
    files.push({
      path,
      status,
      ...(previousPath ? { previousPath } : {}),
      ...(patch ? { patch } : {}),
    });
  }
  return files;
}

/**
 * Include not-yet-tracked files in the working-tree review WITHOUT mutating the
 * index (no `git add -N`): list untracked files honouring .gitignore, then ask
 * git for a no-index diff of each against an empty source. `git diff --no-index`
 * exits 1 when there IS a diff, so we read stdout directly instead of `git()`.
 */
async function untrackedDiff(
  runner: CommandRunner,
  dir: string,
  onLog?: (message: string) => void,
): Promise<DiffFile[]> {
  const listing = (
    await git(runner, dir, ["ls-files", "--others", "--exclude-standard"])
  ).trim();
  if (!listing) return [];
  const files: DiffFile[] = [];
  for (const path of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const res = await runner.run("git", [
      "-C", dir, "diff", "--no-index", "--", "/dev/null", path,
    ]);
    // `git diff --no-index` exits 0 (no diff) or 1 (diff present); anything
    // higher is a genuine failure (unreadable file, broken symlink, …). Don't
    // silently treat that as "no patch" — warn and skip just that file.
    if (res.code > 1) {
      onLog?.(`Skipped untracked ${path}: git diff failed: ${res.stderr.trim()}`);
      continue;
    }
    files.push({ path, status: "added", ...(res.stdout ? { patch: res.stdout } : {}) });
  }
  return files;
}

/**
 * Produce the diff a local review should consider:
 *  - `working`: tracked changes vs HEAD + untracked (new) files.
 *  - `branch`:  current branch vs its merge-base with `baseBranch`.
 *  - `full`:    none — the engine reviews the whole checkout from its structure.
 */
export async function buildLocalDiff(
  runner: CommandRunner,
  dir: string,
  mode: LocalReviewMode,
  baseBranch?: string,
  onLog?: (message: string) => void,
): Promise<DiffFile[]> {
  if (mode === "full") return [];
  if (mode === "working") {
    const tracked = await diffForRange(runner, dir, ["HEAD"]);
    const untracked = await untrackedDiff(runner, dir, onLog);
    return [...tracked, ...untracked];
  }
  const base = (baseBranch || "main").trim();
  const mergeBase = (await git(runner, dir, ["merge-base", base, "HEAD"])).trim();
  return diffForRange(runner, dir, [`${mergeBase}..HEAD`]);
}

/** List local branch names (for the branch-scope base-branch picker). */
export async function listBranches(
  runner: CommandRunner,
  dir: string,
): Promise<string[]> {
  const out = await git(runner, dir, [
    "for-each-ref", "--format=%(refname:short)", "refs/heads",
  ]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Current branch name, or empty string when detached / not a repo. */
export async function currentBranch(
  runner: CommandRunner,
  dir: string,
): Promise<string> {
  try {
    return (await git(runner, dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return "";
  }
}
