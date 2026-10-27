/**
 * Step 12 / Finding 3: Check missing-artifact blockers against disk before escalation.
 *
 * Before showing a task-file blocker as outside automation's control, resolves and reads
 * the canonical file for the bound task. If it exists, corrects the supplied location/context
 * and obtains a corrected review without presenting the owner with a false missing-file request.
 * Bounded to one attempt; if disagreement persists, reports the actual path, read result and disagreement.
 * Distinguishes absent, empty, unreadable and wrong-task files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveAuthoritativeTaskArtifactPathsV1 } from "./implementationArtifactResolver";
import { TaskStage } from "../types/taskProgress";

export type MissingArtifactDiagnosisKind =
  | "absent"
  | "empty"
  | "unreadable"
  | "wrong-task"
  | "exists-readable"
  | "not-missing-artifact";

export interface MissingArtifactDiagnosisV1 {
  readonly kind: MissingArtifactDiagnosisKind;
  readonly canonicalPath: string;
  readonly citedPath?: string;
  readonly artifactName?: string;
  readonly reason: string;
  readonly isOutsideAutomationControl: boolean;
  readonly contentSnippet?: string;
}

export interface MissingArtifactResolutionV1 {
  readonly action: "correct-and-retry" | "report-disagreement" | "escalate" | "none";
  readonly diagnosis: MissingArtifactDiagnosisV1;
  readonly canonicalPath: string;
  readonly disagreementMessage?: string;
  readonly correctedContext?: string;
}

export interface MissingArtifactCorrectionRetryResultV1 {
  readonly attempted: boolean;
  readonly dispatched: boolean;
  readonly canonicalPath?: string;
}

/** Read the one-shot correction marker from a durable interaction snapshot. */
export function missingArtifactCorrectionAttemptedFromInputSnapshotV1(canonicalJson: string): boolean {
  try {
    const parsed = JSON.parse(canonicalJson) as { prompt?: unknown };
    return typeof parsed.prompt === "string" && /## Canonical Task Artifact Correction\b/.test(parsed.prompt);
  } catch {
    return false;
  }
}

const TASK_ARTIFACT_PATTERNS = [
  /(?:on-disk\s+)?plan(?:\s+checklist)?\s+(?:is\s+)?unavailable/i,
  /(?:plan-final\.md|plan\.md|round-progress\.md|task-progress\.json|impl-summary\.md|task\.md)\s+(?:is\s+)?(?:missing|unavailable|not\s+found|could\s+not\s+be\s+found)/i,
  /(?:could\s+not\s+(?:find|read|see)|cannot\s+(?:find|read|see)|missing|unavailable)\s+(?:[^\n]*?)?(?:plan-final\.md|plan\.md|round-progress\.md|task-progress\.json|impl-summary\.md|task\.md)/i,
];

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/**
 * Checks whether a blocker description alleges that an on-disk task artifact is missing or unavailable.
 */
export function isMissingTaskArtifactBlockerV1(description: string): {
  readonly isMissing: boolean;
  readonly artifactName?: string;
  readonly citedPath?: string;
} {
  const matches = TASK_ARTIFACT_PATTERNS.some((pattern) => pattern.test(description));
  if (!matches) {
    return { isMissing: false };
  }

  // Extract artifact name if mentioned
  let artifactName: string | undefined;
  if (/plan-final\.md/i.test(description) || /on-disk\s+plan\s+checklist/i.test(description)) {
    artifactName = "plan-final.md";
  } else if (/plan\.md/i.test(description)) {
    artifactName = "plan.md";
  } else if (/round-progress\.md/i.test(description)) {
    artifactName = "round-progress.md";
  } else if (/task-progress\.json/i.test(description)) {
    artifactName = "task-progress.json";
  } else if (/task\.md/i.test(description)) {
    artifactName = "task.md";
  } else if (/impl-summary\.md/i.test(description)) {
    artifactName = "impl-summary.md";
  }

  // Extract cited path if present in quotes or code spans
  let citedPath: string | undefined;
  const pathMatch =
    description.match(/(?:`|"|')([^\s"`']+\/(?:plan-final\.md|plan\.md|round-progress\.md|task-progress\.json|impl-summary\.md|task\.md))(?:`|"|')/i) ??
    description.match(/(\.ensemble\/[^\s/]+\/(?:plan-final\.md|plan\.md|round-progress\.md|task-progress\.json|impl-summary\.md|task\.md))/i);
  if (pathMatch) {
    citedPath = pathMatch[1];
  }

  return { isMissing: true, artifactName, citedPath };
}

/**
 * Checks the on-disk reality of the bound task's canonical artifact before escalating.
 * Distinguishes absent, empty, unreadable, wrong-task and exists-readable.
 */
export async function diagnoseMissingArtifactBlockerV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blocker: { description: string; resolver?: string; category?: string }
): Promise<MissingArtifactDiagnosisV1> {
  const detection = isMissingTaskArtifactBlockerV1(blocker.description);
  const paths = resolveAuthoritativeTaskArtifactPathsV1(folderUri, stage);

  const artifactName = detection.artifactName ?? "plan-final.md";
  const canonicalPath =
    artifactName === "plan.md"
      ? paths.planPath
      : artifactName === "round-progress.md"
        ? paths.roundProgressPath
        : artifactName === "impl-summary.md"
          ? paths.implSummaryPath
          : artifactName === "task-progress.json"
            ? path.join(paths.taskFolderPath, "task-progress.json")
            : artifactName === "task.md"
              ? path.join(paths.taskFolderPath, "task.md")
              : paths.planFinalPath;

  if (!detection.isMissing) {
    return {
      kind: "not-missing-artifact",
      canonicalPath,
      reason: "Blocker description does not claim an on-disk task artifact is missing.",
      isOutsideAutomationControl: false,
    };
  }

  const normCanonical = normalizePath(canonicalPath);
  const normBoundFolder = normalizePath(folderUri.fsPath);

  // Check cited path vs bound task folder
  const citedPath = detection.citedPath;
  let citesWrongTask = false;
  if (citedPath) {
    const isWorkspaceRelative = /^(?:\.ensemble|\.helper\/plans|plans)\//.test(citedPath.replace(/\\/g, "/"));
    const workspaceRoot = path.resolve(folderUri.fsPath, "..", "..");
    const normCited = normalizePath(path.isAbsolute(citedPath)
      ? citedPath
      : isWorkspaceRelative
        ? path.resolve(workspaceRoot, citedPath)
        : path.resolve(folderUri.fsPath, citedPath));
    const citedFolder = path.dirname(normCited);
    if (citedFolder !== normBoundFolder) {
      citesWrongTask = true;
    }
  }

  // Probe canonical disk file
  let stat: fs.Stats | undefined;
  try {
    stat = await fs.promises.stat(normCanonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const errStr = error instanceof Error ? error.message : String(error);
      return {
        kind: "unreadable",
        canonicalPath: normCanonical,
        citedPath,
        artifactName,
        reason: `Canonical file '${normCanonical}' could not be inspected: ${errStr}.`,
        isOutsideAutomationControl: true,
      };
    }
    stat = undefined;
  }

  if (!stat || !stat.isFile()) {
    return {
      kind: "absent",
      canonicalPath: normCanonical,
      citedPath,
      artifactName,
      reason: `Canonical file '${normCanonical}' does not exist on disk for the bound task.`,
      isOutsideAutomationControl: true,
    };
  }

  if (stat.size === 0) {
    return {
      kind: "empty",
      canonicalPath: normCanonical,
      citedPath,
      artifactName,
      reason: `Canonical file '${normCanonical}' exists on disk but is 0 bytes (empty).`,
      isOutsideAutomationControl: true,
    };
  }

  let content: string;
  try {
    content = await fs.promises.readFile(normCanonical, "utf8");
  } catch (error) {
    const errStr = error instanceof Error ? error.message : String(error);
    return {
      kind: "unreadable",
      canonicalPath: normCanonical,
      citedPath,
      artifactName,
      reason: `Canonical file '${normCanonical}' exists on disk but cannot be read: ${errStr}.`,
      isOutsideAutomationControl: true,
    };
  }

  if (!content.trim()) {
    return {
      kind: "empty",
      canonicalPath: normCanonical,
      citedPath,
      artifactName,
      reason: `Canonical file '${normCanonical}' exists on disk but contains only whitespace.`,
      isOutsideAutomationControl: true,
    };
  }

  if (citesWrongTask) {
    return {
      kind: "wrong-task",
      canonicalPath: normCanonical,
      citedPath,
      artifactName,
      reason: `The blocker cited a foreign task path '${citedPath}', but the canonical file for the bound task exists and is readable at '${normCanonical}' (${stat.size} bytes).`,
      isOutsideAutomationControl: false,
      contentSnippet: content.slice(0, 200),
    };
  }

  return {
    kind: "exists-readable",
    canonicalPath: normCanonical,
    citedPath,
    artifactName,
    reason: `Canonical file exists and is readable on disk at '${normCanonical}' (${stat.size} bytes).`,
    isOutsideAutomationControl: false,
    contentSnippet: content.slice(0, 200),
  };
}

/**
 * Handles a missing-artifact blocker before showing it as outside automation's control.
 * If canonical file exists, provides a corrected context retry (bounded to 1 attempt)
 * or reports the disagreement instead of presenting a false missing-file request.
 */
export async function handleMissingArtifactBlockerBeforeEscalationV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blocker: { description: string; resolver?: string; category?: string },
  previousCorrectionAttempts = 0
): Promise<MissingArtifactResolutionV1> {
  const diagnosis = await diagnoseMissingArtifactBlockerV1(folderUri, stage, blocker);

  if (diagnosis.kind === "not-missing-artifact") {
    return {
      action: "none",
      diagnosis,
      canonicalPath: diagnosis.canonicalPath,
    };
  }

  // Truly absent, empty or unreadable: genuine missing artifact, legitimately outside automation's control
  if (diagnosis.isOutsideAutomationControl) {
    return {
      action: "escalate",
      diagnosis,
      canonicalPath: diagnosis.canonicalPath,
    };
  }

  // Canonical file exists and is readable: NOT outside automation's control
  if (previousCorrectionAttempts < 1) {
    const correctedContext = [
      `Authoritative correction: the required task artifact '${diagnosis.artifactName}' is located at the following absolute on-disk path:`,
      `${diagnosis.canonicalPath}`,
      `Do not look for this artifact in another task folder or assume it is missing.`,
    ].join("\n");

    return {
      action: "correct-and-retry",
      diagnosis,
      canonicalPath: diagnosis.canonicalPath,
      correctedContext,
    };
  }

  // Disagreement persists after 1 correction attempt
  const disagreementMessage =
    `Review blocker claimed task file was unavailable (${blocker.description}), but canonical file verified readable on disk at '${diagnosis.canonicalPath}'. ` +
    `Disagreement between reviewer assertion and verified disk state.`;

  return {
    action: "report-disagreement",
    diagnosis,
    canonicalPath: diagnosis.canonicalPath,
    disagreementMessage,
  };
}

/** Run at most one corrected review for the first readable missing-artifact
 * claim. The caller omits this callback on the correction attempt, so the
 * bound also holds across nested review dispatches. */
export async function retryMissingArtifactReviewOnceV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blockers: readonly { description: string; resolver?: string; category?: string }[],
  dispatchCorrectedReview: (correctedContext: string) => Promise<boolean>
): Promise<MissingArtifactCorrectionRetryResultV1> {
  for (const blocker of blockers) {
    if (!isMissingTaskArtifactBlockerV1(blocker.description).isMissing) continue;
    const resolution = await handleMissingArtifactBlockerBeforeEscalationV1(folderUri, stage, blocker);
    if (resolution.action !== "correct-and-retry" || !resolution.correctedContext) continue;
    const dispatched = await dispatchCorrectedReview(resolution.correctedContext);
    return { attempted: true, dispatched, canonicalPath: resolution.canonicalPath };
  }
  return { attempted: false, dispatched: false };
}
