import * as vscode from "vscode";
import { formatTaskNameForDisplay, taskOperations, TaskOperationSnapshot } from "./taskOperations";
import { NotificationRouter } from "./notificationRouter";
import { policyForKind } from "./operationTaxonomy";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { notificationTaskDisplayNameV1 } from "./notificationTaskContextV1";
import { describeModelWithProviderV1 } from "../runners/providers";
import { offerActionInChatV1 } from "./chatActionOfferV1";
import { appendChatMessageV1 } from "./chatHistoryStore";
import { planInterruptedRecoveryV1 } from "./interruptedRecoveryPlanV1";
import { readInterruptedRecoveryStateV1 } from "./interruptedRecoveryStateV1";
import { takeRoundOutcomeDetailsForTaskV1 } from "./roundOutcomeDetailV1";
import { describeRefusalReasonV1 } from "./refusalGuidanceV1";

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
  // chat1 Step 19: the command already reported this refusal or failure in its own entry.
  if (snap.reportedByCommandV1 === true && (snap.state === "refused" || snap.state === "failed")) {
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
  // chat1 Step 5: a failed or refused operation says why it did, so no end entry reads just
  // "failed". The reason is what the owner of the operation recorded when it settled.
  const settleReason =
    snap.state === "refused"
      ? (describeRefusalReasonV1(snap.endReasonV1, snap.kind) ?? "")
      : snap.state === "failed" && snap.endReasonV1 !== undefined
        ? snap.endReasonV1.trim().replace(/[.\s]+$/, "")
        : "";
  const reasonSuffix = settleReason && !(detail && detail.includes(settleReason)) ? `: ${settleReason}` : "";
  const modelSuffix = snap.modelId ? ` — model: ${describeModelWithProviderV1(snap.modelId)}` : "";
  // Name the stage where the snapshot has one, unless the label already says it.
  const stageName = snap.stage !== undefined ? STAGE_DISPLAY_NAMES[snap.stage] : undefined;
  const stageText =
    stageName !== undefined && !snap.label.toLowerCase().includes(stageName.toLowerCase()) ? ` (${stageName})` : "";
  return {
    // The quoted name is a render-time decision: the snapshot's semantic
    // `taskName` (including persisted snapshots) stays unquoted.
    message: `${snap.label} — ${formatTaskNameForDisplay(notificationTaskDisplayNameV1(snap.taskName, snap.key))}${stageText}: ${stateText}${reasonSuffix}${modelSuffix}${suffix}`,
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
  // bugs5 Step 12: restart what was interrupted, by name; at Publish list the stage's real actions and
  // recommend one from what the checks have proved about the tree as it is now.
  const state = await readInterruptedRecoveryStateV1(snapshot.key).catch(() => undefined);
  const plan = planInterruptedRecoveryV1({
    label: snapshot.label,
    ...(snapshot.kind !== undefined ? { kind: snapshot.kind } : {}),
    atPublish: (snapshot.stage ?? state?.stage) === "publish",
    ...(state !== undefined ? { checksState: state.checksState } : {}),
    ...(state?.lastRunCommands !== undefined ? { lastRunCommands: state.lastRunCommands } : {}),
    ...(state?.lastRunMinutes !== undefined ? { lastRunMinutes: state.lastRunMinutes } : {}),
  });
  const args = [{ taskFolderPath: snapshot.key }];
  if (plan.primary === undefined) {
    // The interrupted operation cannot be named, so no action is guessed: say what happened in the chat.
    await appendChatMessageV1(
      snapshot.key,
      { role: "assistant", text: `${reason} ${plan.reasoning}`, stage: snapshot.stage ?? state?.stage ?? "desc", at: new Date().toISOString() },
      snapshot.key
    ).catch((error) => console.warn("[operationNotificationBridge] Could not post the interruption notice", error));
    return;
  }
  await offerActionInChatV1({
    taskFolderPath: snapshot.key,
    taskLabel: snapshot.taskName,
    actionLabel: plan.primary.label,
    command: plan.primary.command,
    args,
    actionConsequence: plan.primary.consequence,
    alternatives: [
      ...plan.alternatives.map((action) => ({
        label: action.label,
        command: action.command,
        args,
        consequence: action.consequence,
      })),
      ...(snapshot.resultTargetUri
        ? [{
            label: "View Run Log",
            command: "vscode.open",
            args: [vscode.Uri.parse(snapshot.resultTargetUri)],
            consequence: "Opens the run evidence before deciding what to run next.",
            resumeKind: "unpause" as const,
          }]
        : []),
    ],
    noticeText: reason,
    recommend: { target: "action", reasoning: plan.reasoning },
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
    // chat1 Step 5: a round that ended under this root operation left its detail (score, files
    // changed, run log) here rather than as a chat line; it is part of this one end entry. Child
    // operations never get an end entry, so their rounds' details wait for the root.
    const roundDetails = snap.parentId === undefined ? takeRoundOutcomeDetailsForTaskV1(snap.key) : [];
    if (!entry) {
      if (roundDetails.length > 0) {
        // No end entry for this operation (a quiet success): the round's detail gets its own.
        NotificationRouter.showInformation(
          `${snap.label} — ${formatTaskNameForDisplay(notificationTaskDisplayNameV1(snap.taskName, snap.key))}: ${roundDetails.join(" — ")}`,
          undefined,
          undefined,
          snap.id
        );
      }
      return;
    }
    const message = roundDetails.length > 0 ? `${entry.message} — ${roundDetails.join(" — ")}` : entry.message;
    if (entry.level === "error") {
      NotificationRouter.showError(message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    } else if (entry.level === "warning") {
      NotificationRouter.showWarning(message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    } else {
      NotificationRouter.showInformation(message, undefined, entry.resultTargetUri, entry.sourceOperationId);
    }
  });
}
