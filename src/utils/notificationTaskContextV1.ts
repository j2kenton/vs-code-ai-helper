import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";

/**
 * Which task a notification belongs to (v1 fixes 2, item 6 — release half).
 *
 * A tracked operation establishes a context for its own asynchronous call
 * path; a notification raised inside that path is named for that task. This is
 * deliberately NOT a module-level "current task" variable: two operations on
 * different tasks overlap freely, and each must attribute only its own
 * notifications. The context also carries an `ended` flag, so a notification
 * emitted by a detached continuation (a timer or promise the operation left
 * behind) after the operation returned is left unattributed rather than named
 * for a task the emitter may no longer be working on. The task is never
 * inferred from the current selection.
 */
/*
 * Coverage of `NotificationRouter.show*` producers that fire OUTSIDE a tracked
 * operation (classification, v1 fixes 2 step 25c):
 *  - Scheduler `fire()` (scheduleTaskResume.ts): task-specific. Runs under an
 *    explicit context built from the armed task's display name.
 *  - Recovery sweep, watchdog escalation and stale-owner takeover
 *    (scheduleTaskResume.ts): task-specific; each message already quotes the
 *    task's display name in its own text, so no context is needed.
 *  - Busy refusal (`showTaskBusyWarning`, taskOperations.ts): task-specific and
 *    fires before any operation of its own exists, so it runs under a context
 *    built from the holder's snapshot (or the folder, reformatted).
 *  - Schedule-armed confirmations (scheduleTaskResume.ts): name the task in
 *    their own text.
 *  - Scheduling prompts and validation ("Enter a future date/time"), viewer-host
 *    refusals, and workspace activation notices (taskActivationCoordinator.ts):
 *    intentionally global — they are not about one task. Silence is the
 *    classification, not a hole.
 * A task is never inferred from the current selection.
 */
export interface NotificationTaskContextV1 {
  readonly taskName: string;
  /** The stage the operation works on, when it has one. */
  readonly stage?: TaskStage;
  ended: boolean;
}

const storage = new AsyncLocalStorage<NotificationTaskContextV1>();

/** The raw `YYYY-MM-DD_task_N` folder default — never an acceptable label as it stands. */
const FOLDER_DEFAULT_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})_task_(\d+)$/;

/**
 * The name a notification may show for a task: a real display name passes
 * through, the raw folder default is reformatted (`Task 3 (2026-08-14)`) so it
 * is never shown as if it were a name the user chose.
 */
export function notificationTaskDisplayNameV1(taskName: string | undefined, taskPath: string): string {
  const name = taskName ?? path.basename(taskPath);
  const match = FOLDER_DEFAULT_NAME_PATTERN.exec(name);
  return match ? `Task ${match[2]} (${match[1]})` : name;
}

/**
 * Runs `fn` with the task as the notification context for everything it
 * awaits, then marks the context ended. A nested call (a child operation) keeps
 * the enclosing root's context.
 */
export async function runWithNotificationTaskContextV1<T>(
  taskName: string | undefined,
  taskPath: string,
  fn: () => Promise<T>,
  stage?: TaskStage
): Promise<T> {
  const name = notificationTaskDisplayNameV1(taskName, taskPath);
  if (!name || storage.getStore()?.ended === false) {
    return fn();
  }
  const context: NotificationTaskContextV1 = { taskName: name, ...(stage !== undefined ? { stage } : {}), ended: false };
  try {
    return await storage.run(context, fn);
  } finally {
    context.ended = true;
  }
}

/**
 * Warning/error notices raised while a command runs, so a caller that only
 * gets `false` back can name the command's own stated cause. Keyed to the
 * async call path like the task context, so overlapping calls never mix.
 */
const noticeCaptureStorage = new AsyncLocalStorage<string[]>();

/** Runs `fn`, returning its result plus the warning/error notices it raised (in order). */
export async function captureRaisedNoticesV1<T>(fn: () => Promise<T>): Promise<{ result: T; notices: string[] }> {
  const notices: string[] = [];
  const result = await noticeCaptureStorage.run(notices, fn);
  return { result, notices };
}

/** Called by the router for every warning/error; a no-op outside a capture. */
export function recordRaisedNoticeV1(message: string): void {
  noticeCaptureStorage.getStore()?.push(message);
}

/** The live context for the current async call path, if any. */
export function currentNotificationTaskContextV1(): NotificationTaskContextV1 | undefined {
  const context = storage.getStore();
  return context && !context.ended ? context : undefined;
}

/**
 * Prefixes `message` with the task's name (and stage, where the operation has
 * one) when a live context exists and the message does not already name them
 * (the tracked-operation bridge already does, and must not be doubled).
 */
export function attributeNotificationMessageV1(message: string): string {
  const context = currentNotificationTaskContextV1();
  if (!context || message.includes(context.taskName)) {
    return message;
  }
  const stageName = context.stage !== undefined ? STAGE_DISPLAY_NAMES[context.stage] : undefined;
  const stageText = stageName !== undefined && !message.includes(stageName) ? ` (${stageName})` : "";
  return `"${context.taskName}"${stageText} — ${message}`;
}
