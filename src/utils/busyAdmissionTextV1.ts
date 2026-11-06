/**
 * bugs3 Step 12: the "this task already has a stage action in progress" refusal in
 * plain words.
 *
 * The raw refusal named the claim's command id, pid, host id and lock-file path,
 * which tells the owner nothing they can act on ("held by resumeThenDispatchV1 (pid
 * 23188 on 62a10e54-…)"). This names the action the owner knows ("Publish Checks is
 * running: tests, 3 min so far"), offers the two things they can do (Cancel it from
 * Notifications, or wait), and keeps the technical identifiers in a separate
 * `details` string for a log or a details toggle — never in the message.
 *
 * A claim that has stopped renewing is a different situation (nothing is running); that
 * wording stays with `describeWorkAdmissionRefusalV1`, which this defers to.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1, describeWorkAdmissionRefusalV1 } from "../state/workAdmissionV1";
import type { WorkAdmissionBusyV1, WorkAdmissionWriteFailedV1 } from "../state/workAdmissionV1";
import { getLiveTaskOperationV1 } from "./liveTaskOperationLookupV1";

/** The action a claim's command id stands for, in the owner's words. */
const ACTION_BY_COMMAND_V1: Readonly<Record<string, string>> = {
  runPublishChecks: "Publish Checks",
  runLintingFixes: "Fix Linting & Code Errors",
  commitAndPushTask: "Commit & Push",
  completeCommitAndPushTask: "Commit & Push",
  fastForwardReviewWithAI: "Fast Forward Review",
  runReviewWithAI: "A review",
  applyReviewWithAI: "Apply Review",
  runImplementationWithAI: "Implementation",
  generatePlanWithAI: "Plan generation",
  resumeThenDispatchV1: "A resumed stage action",
};

/**
 * chat1 Step 18: the same names for the action keys the lease store records
 * (`DuplicateRejectedOutcomeV1.holder.actionKey`), for when no live operation names the holder.
 */
export const ACTION_NAME_BY_KEY_V1: Readonly<Record<string, string>> = {
  "commitPush.v1": "Commit & Push",
  "commitPushMetadata.v1": "Commit & Push",
  "markTaskDone.v1": "Complete Task",
  "review.v1": "A review",
  "applyReview.v1": "Apply Review",
  "applyReviewEdit.v1": "Apply Review",
  "implementation.v1": "Implementation",
  "editExecution.v1": "Implementation",
  "generateImplementation.v1": "Implementation plan generation",
  "generatePlan.v1": "Plan generation",
  "fastForward.v1": "Fast Forward",
  "lint.v1": "Fix Linting & Code Errors",
  "resumeTask.v1": "A resumed stage action",
  "nextStage.v1": "Moving to the next stage",
  "renameTask.v1": "Renaming the task",
  "draft.v1": "Drafting",
};

export interface PlainBusyRefusalV1 {
  /** For the owner: what is running, how long, and what they can do. */
  readonly message: string;
  /** Command id, pid, host and marker path, for a log or a details toggle. */
  readonly details: string;
  /** The live operation holding the task, when the registry has one: what a Cancel choice targets. */
  readonly runningOperation?: { readonly operationId: string; readonly label: string };
  /**
   * Set when a fresh claim holds the task but the registry has no operation for it yet (the
   * action is still starting): the action in the owner's words. A Cancel offered for it must
   * find its target when it is chosen, not now.
   */
  readonly claimOnlyAction?: string;
}

function elapsedWordsV1(startedAtMs: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - startedAtMs) / 60_000));
  return minutes < 1 ? "under a minute so far" : `${minutes} min so far`;
}

/**
 * review1 Step 41: the task's own display name, read best effort from its progress file next to the claim marker.
 * Flows that refuse before they have resolved the task (lint, rename, chat-with-stage, Publish Checks, Commit & Push)
 * pass no name; this lets every refusal name the task the owner sees in the Tasks pane instead of "This task".
 */
function readTaskDisplayNameForRefusalV1(markerPath: string): string | undefined {
  try {
    const taskFolder = path.dirname(path.dirname(markerPath));
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(taskFolder, "task-progress.json"), "utf8"));
    const name = (parsed as { displayName?: unknown } | null)?.displayName;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function describePlainBusyRefusalV1(
  outcome: WorkAdmissionBusyV1,
  taskDisplayName?: string,
  now: number = Date.now()
): PlainBusyRefusalV1 {
  const resolvedName = taskDisplayName ?? readTaskDisplayNameForRefusalV1(outcome.markerPath);
  const subject = resolvedName ? `"${resolvedName}"` : "This task";
  const owner = outcome.owner;
  const details = owner
    ? `held by ${owner.commandId} (pid ${owner.pid} on ${owner.hostId}), claim marker ${outcome.markerPath}`
    : `held by an unreadable claim record at ${outcome.markerPath}`;

  // The claim stopped renewing: nothing is running, so "Cancel / Wait" would mislead.
  if (Number.isFinite(outcome.ageMs) && outcome.ageMs > 5 * WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1) {
    return { message: describeWorkAdmissionRefusalV1(outcome, resolvedName), details };
  }

  // Prefer the live operations state (what the owner sees in Notifications) over the claim.
  const taskFolder = path.dirname(path.dirname(outcome.markerPath));
  const live = getLiveTaskOperationV1(taskFolder);
  const startedAtMs = owner ? Date.parse(owner.startedAt) : Number.NaN;
  let what: string;
  let claimOnlyAction: string | undefined;
  if (live) {
    const phase = live.activity ? `: ${live.activity}` : "";
    const elapsed = live.startedAt !== undefined ? `, ${elapsedWordsV1(live.startedAt, now)}` : "";
    what = `${live.label} ${live.label === "Publish Checks" ? "are" : "is"} running${phase}${elapsed}`;
  } else {
    const action = (owner && ACTION_BY_COMMAND_V1[owner.commandId]) ?? "Another stage action";
    const elapsed = Number.isFinite(startedAtMs) ? `, ${elapsedWordsV1(startedAtMs, now)}` : "";
    what = `${action} ${action === "Publish Checks" ? "are" : "is"} running${elapsed}`;
    if (owner) {
      claimOnlyAction = action;
    }
  }
  const finishing = outcome.outstandingReason ? ` It is finishing up because: ${outcome.outstandingReason}` : "";
  return {
    message:
      `${subject} already has a stage action in progress — ${what}.${finishing} ` +
      "Cancel: stop it from its row in Notifications. Wait: it finishes on its own, and you can then run this again.",
    details,
    ...(live?.operationId !== undefined ? { runningOperation: { operationId: live.operationId, label: live.label } } : {}),
    ...(claimOnlyAction !== undefined ? { claimOnlyAction } : {}),
  };
}

/** One string for a notification: the plain message, with the technical details logged, not shown. */
export function describeWorkAdmissionRefusalForUserV1(
  outcome: WorkAdmissionBusyV1 | WorkAdmissionWriteFailedV1,
  taskDisplayName?: string
): string {
  if (outcome.outcome === "writeFailed") {
    return describeWorkAdmissionRefusalV1(outcome, taskDisplayName);
  }
  const plain = describePlainBusyRefusalV1(outcome, taskDisplayName);
  console.info(`[admission] refused: ${plain.details}`);
  return plain.message;
}
