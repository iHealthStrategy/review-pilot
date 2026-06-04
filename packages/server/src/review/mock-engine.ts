import type { ReviewEngineKind, Severity } from "../domain/entities.js";
import type {
  FindingDraft,
  ReviewContext,
  ReviewEngine,
} from "./review-engine.js";

/**
 * Deterministic, dependency-free review engine. It produces one finding per
 * changed file and grounds each in the WHOLE codebase (it references the total
 * structure size and whether the changed file is new to the repo), which is
 * exactly the "review against overall structure, not just the diff" behaviour
 * the platform promises — while needing no external tool or network.
 *
 * Determinism makes it ideal for end-to-end and e2e tests.
 */
export class MockReviewEngine implements ReviewEngine {
  readonly kind: ReviewEngineKind = "mock";

  async review(ctx: ReviewContext): Promise<FindingDraft[]> {
    const total = ctx.structure.length;
    const known = new Set(ctx.structure);
    return ctx.diff.map((file): FindingDraft => {
      const severity = severityForStatus(file.status);
      const isNewToRepo = !known.has(file.path);
      return {
        filePath: file.path,
        line: 1,
        severity,
        title: `[mock] reviewed ${file.path} (${file.status})`,
        detail:
          `Mock review of '${file.path}' considered the full repository ` +
          `(${total} files). Change status: ${file.status}` +
          (isNewToRepo ? "; file not present in synced tree." : "."),
        suggestion:
          file.status === "removed"
            ? "Confirm no remaining references to the removed file."
            : "Verify the change is consistent with surrounding modules.",
        category: "mock",
      };
    });
  }
}

function severityForStatus(status: string): Severity {
  switch (status) {
    case "removed":
      return "info";
    case "added":
      return "minor";
    case "renamed":
      return "minor";
    default:
      return "minor";
  }
}
