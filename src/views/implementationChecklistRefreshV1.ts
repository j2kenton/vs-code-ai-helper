import * as path from "path";
import * as vscode from "vscode";
import type { TaskStage } from "../types/taskProgress";

/**
 * What the `plan-final.md` watcher needs from the rest of the extension,
 * injected so the decision logic below is unit-testable without one.
 */
export interface ImplementationChecklistRefreshDepsV1 {
  /** The task whose folder is `folderFsPath`, or `undefined` when it is not a known task. */
  findTaskStage(folderFsPath: string): TaskStage | undefined;
  refreshTaskTree(): void;
  /** Read-only: is the status bar currently showing the task in `folderUri`? */
  isStatusBarShowingTaskFolder(folderUri: vscode.Uri): boolean;
  refreshStatusBar(): void;
  refreshChatImplementationProgress(folderUri: vscode.Uri): Promise<boolean>;
}

/**
 * Refresh the implementation percentage on every surface that shows it after
 * one or more `plan-final.md` files changed on disk (a run ticking boxes).
 *
 * Deliberately narrow: only known tasks currently AT the implementation
 * stage count, and the only work done is re-rendering. It never refreshes the
 * task inventory and never arms schedules — a checklist tick changes no
 * progress record, and re-arming from a file watcher would let a viewer claim
 * leases the runner owns. No document is written or saved here either; the
 * surfaces re-read through the display-only reader
 * (`readPlanOfRecordForDisplayV1`).
 */
export async function handleImplementationChecklistChangeV1(
  changedFiles: readonly vscode.Uri[],
  deps: ImplementationChecklistRefreshDepsV1
): Promise<void> {
  const folders = new Map<string, vscode.Uri>();
  for (const file of changedFiles) {
    const folder = path.dirname(file.fsPath);
    if (!folders.has(folder) && deps.findTaskStage(folder) === "impl") {
      folders.set(folder, vscode.Uri.file(folder));
    }
  }
  if (folders.size === 0) {
    return;
  }

  deps.refreshTaskTree();
  if ([...folders.values()].some((folder) => deps.isStatusBarShowingTaskFolder(folder))) {
    deps.refreshStatusBar();
  }
  for (const folder of folders.values()) {
    await deps.refreshChatImplementationProgress(folder).catch(() => false);
  }
}
