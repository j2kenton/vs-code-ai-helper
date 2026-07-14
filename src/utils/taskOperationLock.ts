import { NotificationRouter } from "./notificationRouter";

/**
 * Guards against overlapping AI/git actions for the same task folder, so a
 * rapid double-click (or two different entry points — tree button, keyboard
 * shortcut, palette — invoking the same command) gets an immediate "already
 * in progress" message instead of racing two runs against the same artifact.
 *
 * This is a lightweight, per-extension-host dedup keyed on task folder path.
 * It is intentionally simple: one lock per task, not per action kind, so any
 * two mutating actions on the same task are treated as mutually exclusive.
 */
const activeTaskOperations = new Map<string, string>();

export function tryAcquireTaskOperationLock(folderFsPath: string, label: string): boolean {
  if (activeTaskOperations.has(folderFsPath)) {
    return false;
  }
  activeTaskOperations.set(folderFsPath, label);
  return true;
}

export function releaseTaskOperationLock(folderFsPath: string): void {
  activeTaskOperations.delete(folderFsPath);
}

export function showTaskBusyWarning(folderFsPath: string): void {
  const label = activeTaskOperations.get(folderFsPath) ?? "An operation";
  NotificationRouter.showInformation(
    `${label} is already in progress for this task. Please wait for it to finish.`
  );
}
