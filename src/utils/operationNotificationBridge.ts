import * as vscode from "vscode";
import { formatTaskNameForDisplay, taskOperations, TaskOperationSnapshot } from "./taskOperations";
import { NotificationRouter } from "./notificationRouter";
import { policyForKind } from "./operationTaxonomy";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { notificationTaskDisplayNameV1 } from "./notificationTaskContextV1";
import { describeModelWithProviderV1 } from "../runners/providers";
import { offerActionInChatV1 } from "./chatActionOfferV1";

/**
 * The centralized operation → Notifications-section terminal-entry policy
 * (contract C1 / taxonomy in operationTaxonomy.ts).
 *
 * Every root operation leaves exactly one persistent terminal entry when it
 * ends: the live in-progress row disappears from the Notifications view and
 * this entry takes its place, so a completed operation never vanishes from
 * the history. The policy is enforced here, from the registry's own
 * lifecycle event, rather than by each command remembering to post a message.
 *
 * Rules, per the taxonomy:
 * - Child operations never render their own Notifications row, so they never
 *   record terminal entries either (the root's entry covers the composite).
 * - Chat-response kinds record only failures/cancellations — no per-turn
 *   success noise.
 * - Everything else records its terminal state:
 *   succeeded → info, cancelled → warning, failed → error.
 */
export interface TerminalNotificationEntry {
  readonly message: string;
  readonly level: "info" | "warning" | "error";
  /**
   * Stringified vscode.Uri of the operation's result artifact/run log, when
   * known (see TaskOperationHandle.setResultTargetUri). Consumers must
   * vscode.Uri.parse() this — never a bare fsPath.
   */
  readonly resultTargetUri?: string;
  /** The root operation this terminal entry is about. By the time this fires
   * the operation has already ended, so the Notifications surface correctly
   * shows no cancel affordance for it — the id is carried through so any
   * other still-live operation that later reuses is never confused for it. */
  readonly sourceOperationId: string;
}

export function terminalEntryFor(
  snap: TaskOperationSnapshot
): TerminalNotificationEntry | undefined {
  if (snap.parentId !== undefined) {
    return undefined;
  }
  if (
    snap.kind !== undefined &&
    policyForKind(snap.kind).notification === "terminal-on-failure-only" &&
    snap.state === "succeeded"
  ) {
    return undefined;
  }

  // A refusal is not a completion: say the action did not start, in the
  // words the user needs (the specific reason was already shown at the refusal).
  const stateText =
    snap.state === "succeeded" ? "completed" : snap.state === "refused" ? "refused — nothing was started" : snap.state;
  const level =
    snap.state === "failed" ? "error" : snap.state === "succeeded" ? "info" : "warning";
  // The live detail is meaningful on a settled row ("iteration 3/5", a new
  // task's folder name) except for the transient "cancelling…" placeholder,
  // which the cancelled state already expresses. A FORCED end is the one
  // cancellation whose detail must survive: "cancelled" on its own would say
  // the work stopped, and a row removed after Stop was ignored has not
  // necessarily stopped (verification review, 2026-09-18).
  // A cancelled row whose owner stated what was cancelled and by whom (Fast
  // Forward's "Publish Checks were cancelled from the Notifications row…",
  // bugs2 finding 5) keeps that statement.
  const detail =
    snap.state === "cancelled" && snap.forcedEndV1 !== true
      ? snap.cancelReasonV1
      : snap.detail;
  const suffix = detail ? ` (${detail})` : "";
  const modelSuffix = snap.modelId ? ` — model: ${describeModelWithProviderV1(snap.modelId)}` : "";
  // Name the stage where the snapshot has one, unless the label already says it.
  const stageName = snap.stage !== undefined ? STAGE_DISPLAY_NAMES[snap.stage] : undefined;
  const stageText =
    stageName !== undefined && !snap.label.toLowerCase().includes(stageName.toLowerCase()) ? ` (${stageName})` : "";
  return {
    // The quoted name is a render-time decision: the snapshot's semantic
    // `taskName` (including persisted snapshots) stays unquoted.
    message: `${snap.label} — ${formatTaskNameForDisplay(notificationTaskDisplayNameV1(snap.taskName, snap.key))}${stageText}: ${stateText}${modelSuffix}${suffix}`,
    level,
    sourceOperationId: snap.id,
    // Only present when set — keeps `terminalEntryFor` output free of
    // stray `resultTargetUri: undefined` keys for the (still-common) case
    // where no result target was recorded.
    ...(snap.resultTargetUri !== undefined ? { resultTargetUri: snap.resultTargetUri } : {}),
  };
}

/**
 * Re-open a user-reachable recovery choice when activation restores an
 * interrupted operation. Its result is unknown, so the safest supported
 * action is the normal stage-action path, which re-reads task state and
 * admission before dispatch. The stable chat-action key updates this card in place
 * if activation recovery reports the same interruption more than once.
 */
export async function offerInterruptedOperationRecoveryV1(
  snapshot: TaskOperationSnapshot
): Promise<void> {
  if (snapshot.state !== "interrupted" || !snapshot.key) {
    return;
  }
  const reason = `${snapshot.label} was interrupted when the runner stopped reporting; its outcome is unknown.`;
  const isPublishChecks = snapshot.label === "Run Publish Checks";
  await offerActionInChatV1({
    taskFolderPath: snapshot.key,
    taskLabel: snapshot.taskName,
    actionLabel: isPublishChecks ? "Run Publish Checks" : "Run Current Stage Action",
    command: isPublishChecks
      ? "vs-code-ai-helper.runPublishChecks"
      : "vs-code-ai-helper.applyCurrentStageAction",
    args: [{ taskFolderPath: snapshot.key }],
    ...(snapshot.resultTargetUri
      ? {
          alternatives: [{
            label: "View Run Log",
            command: "vscode.open",
            args: [vscode.Uri.parse(snapshot.resultTargetUri)],
            consequence: "Opens the run evidence before deciding whether to rerun the stage action.",
            resumeKind: "unpause",
          }],
        }
      : {}),
    noticeText: `${reason} The recommended action rechecks the task's current state and runs its current stage action.`,
    optional: true,
  });
}

/**
 * Subscribe the Notifications surface to the operation registry's terminal
 * events. Installed once during activation, after initNotificationRouter;
 * dispose the returned subscription on deactivation.
 */
export function installOperationNotificationBridge(): vscode.Disposable {
  return taskOperations.onDidEnd((snap) => {
    const entry = terminalEntryFor(snap);
    if (!entry) {
      return;
    }
    if (entry.level === "error") {
      NotificationRouter.showError(entry.message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    } else if (entry.level === "warning") {
      NotificationRouter.showWarning(entry.message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    } else {
      NotificationRouter.showInformation(entry.message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    }
  });
}
