import { isViewerHostV1 } from "../state/hostRoleV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";

/**
 * In a VIEWER window (hostRoleV1.ts) the workflow's action buttons, tree
 * rows and keyboard shortcuts must do what their label says — on the
 * runner. Without this, pressing "Run Review" in a viewer hit the route
 * gate and surfaced VS Code's raw "Error running command …" toast
 * (confirmed live, 2026-09-17).
 *
 * Each forwardable command is registered through `forwardInViewerV1`: in a
 * standalone or runner host the wrapper is transparent; in a viewer it hands
 * the command id and the task it was invoked for to the forwarder
 * extension.ts configures (the file relay, hostRelayV1.ts). The runner
 * re-invokes the command with a `{ taskFolderPath }` argument — the shape
 * every one of these commands already accepts from the keyboard-shortcut
 * router.
 *
 * `RELAYABLE_COMMAND_IDS_V1` is also the runner's allow-list: a relay request
 * naming any other command is refused, so nothing that can write the relay
 * directory gets arbitrary command execution in the runner.
 */
export const RELAYABLE_COMMAND_IDS_V1: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.draftTaskWithAI",
  "vs-code-ai-helper.generatePlanWithAI",
  "vs-code-ai-helper.generateImplementationWithAI",
  "vs-code-ai-helper.runImplementationWithAI",
  "vs-code-ai-helper.runReviewWithAI",
  "vs-code-ai-helper.applyReviewWithAI",
  "vs-code-ai-helper.applyReviewEditWithAI",
  "vs-code-ai-helper.fastForwardReviewWithAI",
  "vs-code-ai-helper.applyHighLevelReviewChanges",
  "vs-code-ai-helper.applyLowLevelReviewChanges",
  "vs-code-ai-helper.applyCurrentStageAction",
  "vs-code-ai-helper.reviewCurrentTask",
  "vs-code-ai-helper.fastForwardCurrentTaskReview",
  "vs-code-ai-helper.nextStage",
  "vs-code-ai-helper.runPublishChecks",
  "vs-code-ai-helper.runLintingFixes",
  "vs-code-ai-helper.renameTaskWithAI",
  // A chat send (its stage and message travel as the command argument);
  // chatWithStage forwards only a send, opening the panel stays local.
  "vs-code-ai-helper.chatWithStage",
]);

/**
 * A relayed command's argument, decoded field by field.
 *
 * The runner used to spread the request's first argument into the command's
 * own argument. Anything that can write the relay directory — including the
 * provider CLIs the workflow runs in this very workspace — could therefore
 * set internal fields the commands trust as provenance: `automationDispatch:
 * true` alone makes an Implementation request advance the stage and dispatch
 * Apply Review instead (review, 2026-09-17). Only the fields a relayed
 * command is DEFINED to carry are accepted, and only for the command that
 * defines them; the task always comes from the request's own validated path.
 */
export function decodeRelayedCommandArgV1(commandId: string, arg: unknown): Record<string, unknown> {
  if (commandId !== "vs-code-ai-helper.chatWithStage") {
    return {};
  }
  const record = typeof arg === "object" && arg !== null ? (arg as Record<string, unknown>) : {};
  const decoded: Record<string, unknown> = {};
  if (typeof record.message === "string" && record.message.length > 0) {
    decoded.message = record.message;
  }
  if (typeof record.stage === "string" && Object.prototype.hasOwnProperty.call(STAGE_DISPLAY_NAMES, record.stage)) {
    decoded.stage = record.stage;
  }
  if (typeof record.taskName === "string") {
    decoded.taskName = record.taskName;
  }
  return decoded;
}

/**
 * Decision effects that must run where the USER is, not on the runner.
 *
 * Answering a decision relays it to the runner, which resolves the record and
 * then runs the chosen option's effect. That is right for effects that are
 * workflow work (resume, apply, advance) — they belong to the window that
 * runs the workflow. It is wrong for effects that only open a view or ask for
 * a confirmation: those would open on a desktop nobody is watching, so the
 * card would vanish and nothing would appear to happen (review, 2026-09-17).
 * The runner hands these back and the viewer runs them itself.
 */
export const VIEWER_DECISION_EFFECT_COMMANDS_V1: ReadonlySet<string> = new Set([
  "vs-code-ai-helper.openAiModels",
  "vs-code-ai-helper.openSettings",
  "vs-code-ai-helper.openPlanFinal",
  "vs-code-ai-helper.openPlanNonGoals",
  "vs-code-ai-helper.viewStageChanges",
  "vs-code-ai-helper.setStageBackupModel",
  // Commit & Push confirms with a modal and is deliberately not relayable at
  // all — the user answers it in their own window.
  "vs-code-ai-helper.commitAndPushTask",
]);

export type ViewerCommandForwarderV1 = (
  commandId: string,
  taskFolderPath: string | undefined,
  /** Extra fields for the runner's command argument, beside the task. */
  commandArg?: Readonly<Record<string, unknown>>
) => Promise<boolean>;

let forwarder: ViewerCommandForwarderV1 | undefined;

/** extension.ts installs the relay-backed forwarder during activation. */
export function configureViewerCommandForwarderV1(next: ViewerCommandForwarderV1 | undefined): void {
  forwarder = next;
}

/**
 * Forward one invocation to the runner directly (for a command that forwards
 * only some of its invocations). Resolves false when the action did not run,
 * having already reported why — it never rejects, because a rejection from a
 * webview handler or command handler surfaces as VS Code's raw "Error running
 * command" toast, which is what this module exists to avoid.
 */
export async function forwardToRunnerV1(
  commandId: string,
  taskFolderPath: string | undefined,
  commandArg?: Readonly<Record<string, unknown>>
): Promise<boolean> {
  if (!RELAYABLE_COMMAND_IDS_V1.has(commandId)) {
    throw new Error(`${commandId} is not in RELAYABLE_COMMAND_IDS_V1 — the runner would refuse to run it`);
  }
  if (forwarder === undefined) {
    NotificationRouter.showWarning("This viewer window has no connection to the runner yet.");
    return false;
  }
  return forwarder(commandId, taskFolderPath, commandArg);
}

/**
 * The task a command was invoked for, from any of the argument shapes the
 * workflow's commands receive: a tree row (`{ task: { folderUri } }`), the
 * keyboard-shortcut router (`{ taskFolderPath }`), or `{ canonicalId }` (a
 * canonical id IS the normalized folder path). Undefined when the command
 * was invoked bare (command palette): the forwarder then uses the viewer's
 * current task.
 */
export function taskFolderPathFromCommandArgV1(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) {
    return undefined;
  }
  const record = arg as Record<string, unknown>;
  const task = record.task;
  if (typeof task === "object" && task !== null) {
    const folderUri = (task as Record<string, unknown>).folderUri;
    if (typeof folderUri === "object" && folderUri !== null) {
      const fsPath = (folderUri as Record<string, unknown>).fsPath;
      if (typeof fsPath === "string" && fsPath.length > 0) {
        return fsPath;
      }
    }
  }
  for (const key of ["taskFolderPath", "canonicalId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Wrap a command handler so that, in a viewer host, invoking it forwards the
 * action to the runner instead of running (and being refused) here.
 */
export function forwardInViewerV1<A extends unknown[], R>(
  commandId: string,
  handler: (...args: A) => R
): (...args: A) => R | Promise<void> {
  if (!RELAYABLE_COMMAND_IDS_V1.has(commandId)) {
    throw new Error(`${commandId} is not in RELAYABLE_COMMAND_IDS_V1 — the runner would refuse to run it`);
  }
  return (...args: A): R | Promise<void> => {
    if (!isViewerHostV1()) {
      return handler(...args);
    }
    if (forwarder === undefined) {
      NotificationRouter.showWarning("This viewer window has no connection to the runner yet.");
      return Promise.resolve();
    }
    return forwarder(commandId, taskFolderPathFromCommandArgV1(args[0])).then(() => undefined);
  };
}
