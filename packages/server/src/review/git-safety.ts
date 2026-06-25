/**
 * Guards for values that flow into `git` argv. `execFile` already prevents shell
 * injection, but NOT git *option* injection: a positional value beginning with
 * `-` is parsed as a flag (e.g. `--upload-pack=cmd`), and a clone URL with an
 * `ext::`/`file://`/scp scheme can execute commands or read local paths. These
 * helpers reject such values at the boundary so untrusted repo/branch/URL data
 * can't reach git as options.
 */

/** Reject a ref/branch git would misparse as an option (leading `-`). */
export function assertSafeGitArg(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`unsafe ${label}: must be a non-empty string`);
  }
  if (value.startsWith("-")) {
    throw new Error(`unsafe ${label}: must not start with '-' (got ${JSON.stringify(value.slice(0, 40))})`);
  }
  return value;
}

/** Validate a clone URL: http(s) only (blocks ext::/file:///ssh/scp), no leading `-`. */
export function assertSafeCloneUrl(url: string): string {
  if (typeof url !== "string" || url.startsWith("-") || !/^https?:\/\//i.test(url)) {
    throw new Error("unsafe clone URL: only http(s) URLs are allowed");
  }
  return url;
}

/** Redact inline `user:token@` credentials before a URL/command is logged. */
export function redactCreds(s: string): string {
  return String(s).replace(/\/\/[^/@\s]+@/g, "//***@");
}
