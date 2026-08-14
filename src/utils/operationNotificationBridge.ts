import * as vscode from "vscode";
import { formatTaskNameForDisplay, taskOperations, TaskOperationSnapshot } from "./taskOperations";
import { NotificationRouter } from "./notificationRouter";
import { policyForKind } from "./operationTaxonomy";

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

  const stateText = snap.state === "succeeded" ? "completed" : snap.state;
  const level =
    snap.state === "failed" ? "error" : snap.state === "succeeded" ? "info" : "warning";
  // The live detail is meaningful on a settled row ("iteration 3/5", a new
  // task's folder name) except for the transient "cancelling…" placeholder,
  // which the cancelled state already expresses.
  const detail = snap.state === "cancelled" ? undefined : snap.detail;
  const suffix = detail ? ` (${detail})` : "";
  return {
    // The quoted name is a render-time decision: the snapshot's semantic
    // `taskName` (including persisted snapshots) stays unquoted.
    message: `${snap.label} — ${formatTaskNameForDisplay(snap.taskName)}: ${stateText}${suffix}`,
    level,
    sourceOperationId: snap.id,
    // Only present when set — keeps `terminalEntryFor` output free of
    // stray `resultTargetUri: undefined` keys for the (still-common) case
    // where no result target was recorded.
    ...(snap.resultTargetUri !== undefined ? { resultTargetUri: snap.resultTargetUri } : {}),
  };
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
