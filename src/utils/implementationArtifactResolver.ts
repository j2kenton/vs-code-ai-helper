/**
 * Centralizes all read/write/open paths for the merged Implementation stage.
 * The canonical artifact for new writes is plan-final.md.
 * Legacy implementation.md is only used as a read/materialization fallback.
 */
import * as vscode from "vscode";
import {
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";
import { readNonEmptyText, resolveCurrentPlanUri, statIfExists } from "./fileUtils";
import { backupArtifactBeforeWrite } from "./artifactBackups";

export interface ResolvedImplementationArtifact {
  /** The URI to use for reading/opening */
  uri: vscode.Uri;
  /** True when plan-final.md was found */
  isCanonical: boolean;
  /** True when falling back to legacy implementation.md */
  isFallback: boolean;
}

/**
 * True when content matches the shape the implementation-run prompts
 * (run-implementation.md / apply-impl-review-code.md) dictate for the
 * implementation summary: a "## Files Changed" section and a
 * "## Verification" section. Used to tell a misdirected summary write —
 * an agent that wrote its final answer to a `plan-final.md`/`implementation.md`
 * file instead of returning it as text — apart from a same-named file that
 * happens to hold real, unrelated project content. Filename and location
 * alone can't make that distinction: a project may legitimately have its own
 * root-level `implementation.md`, so only a content match is treated as the
 * extension's own artifact.
 */
export function looksLikeGeneratedImplementationSummary(content: string): boolean {
  return content.includes("## Files Changed") && content.includes("## Verification");
}

/**
 * Returns the canonical URI (plan-final.md) for new writes.
 * All AI generation must write to this path.
 */
export function getCanonicalImplementationUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, IMPLEMENTATION_FILENAME);
}

/**
 * Returns the legacy URI (implementation.md) for fallback reading.
 */
export function getLegacyImplementationUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, LEGACY_IMPLEMENTATION_FILENAME);
}

/**
 * Resolve the best URI to open/read for the Implementation stage:
 * - plan-final.md when present (canonical)
 * - implementation.md when plan-final.md absent (legacy fallback)
 * - canonical plan-final.md URI when neither file exists (create path)
 */
export async function resolveImplementationArtifact(
  taskFolderUri: vscode.Uri
): Promise<ResolvedImplementationArtifact> {
  const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
  const legacyUri = vscode.Uri.joinPath(
    taskFolderUri,
    LEGACY_IMPLEMENTATION_FILENAME
  );

  const canonicalStat = await statIfExists(canonicalUri);
  if (canonicalStat) {
    return { uri: canonicalUri, isCanonical: true, isFallback: false };
  }

  const legacyStat = await statIfExists(legacyUri);
  if (legacyStat) {
    return { uri: legacyUri, isCanonical: false, isFallback: true };
  }

  // Neither exists; return canonical for create path
  return { uri: canonicalUri, isCanonical: false, isFallback: false };
}

/**
 * When a run-implementation or redo-implementation command is invoked and
 * plan-final.md is missing but implementation.md exists, materialize
 * plan-final.md by copying implementation.md. Returns the canonical URI.
 * Throws a user-visible error if neither file exists.
 */
export async function materializeCanonicalIfNeeded(
  taskFolderUri: vscode.Uri
): Promise<vscode.Uri> {
  const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
  const legacyUri = vscode.Uri.joinPath(
    taskFolderUri,
    LEGACY_IMPLEMENTATION_FILENAME
  );

  const canonicalStat = await statIfExists(canonicalUri);
  if (canonicalStat) {
    return canonicalUri;
  }

  const legacyStat = await statIfExists(legacyUri);
  if (legacyStat) {
    // Copy legacy -> canonical
    const content = await vscode.workspace.fs.readFile(legacyUri);
    await backupArtifactBeforeWrite(canonicalUri);
    await vscode.workspace.fs.writeFile(canonicalUri, content);
    return canonicalUri;
  }

  throw new Error(
    `No ${IMPLEMENTATION_FILENAME} or ${LEGACY_IMPLEMENTATION_FILENAME} found. ` +
      "Generate an implementation plan before running implementation."
  );
}

/** Result of {@link preparePlanPromotion}. */
export type PlanPromotion =
  | { ready: true; publish?: () => Promise<void> }
  | { ready: false };

/**
 * Prepare (but do not perform) seeding plan-final.md from the current
 * plan.md the first time a task enters the Implementation stage.
 *
 * This is the single source of truth for that promotion: every path that can
 * transition a task's stage to "impl" (manual Next Stage, and score-based
 * review auto-advance) must use it, or the task lands on "impl" with no
 * implementation artifact and Generate Checklist/Implement immediately
 * hard-fail via `materializeCanonicalIfNeeded`.
 *
 * Returns `{ ready: false }` when there is no plan content to promote —
 * callers should abort the transition. Returns `{ ready: true }` with no
 * `publish` when a canonical artifact already exists (nothing to do).
 * Otherwise returns `{ ready: true, publish }`, where `publish` performs the
 * actual backup+write.
 *
 * The write is intentionally split out from this read/check step so callers
 * that gate the transition behind a compare-and-swap (e.g. `advanceStage`'s
 * `publishArtifact` hook) can defer `publish` until that CAS has actually
 * succeeded. Writing eagerly, before the CAS runs, would let a review
 * attempt that loses the race still materialize plan-final.md for a stage
 * transition that never happens.
 */
export async function preparePlanPromotion(
  taskFolderUri: vscode.Uri
): Promise<PlanPromotion> {
  const resolved = await resolveImplementationArtifact(taskFolderUri);
  if (resolved.isCanonical) {
    return { ready: true };
  }

  const currentPlanUri = await resolveCurrentPlanUri(taskFolderUri);
  const planContent = await readNonEmptyText(currentPlanUri);
  if (!planContent) {
    return { ready: false };
  }

  return {
    ready: true,
    publish: async () => {
      const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
      await backupArtifactBeforeWrite(canonicalUri);
      await vscode.workspace.fs.writeFile(
        canonicalUri,
        new TextEncoder().encode(planContent)
      );
    },
  };
}
