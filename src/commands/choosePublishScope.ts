import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask, patchTaskProgress } from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";

type ChoosePublishScopeArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

function normalizeArg(
  arg: ChoosePublishScopeArg | undefined
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  if ("task" in arg && arg.task) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  return a.canonicalId || a.taskFolderPath
    ? { canonicalId: a.canonicalId, taskFolderPath: a.taskFolderPath }
    : undefined;
}

/**
 * QuickPick a Publish verification scope for the task and persist the
 * choice on the task record. Items are the workspace-folder root plus
 * detected nested package.json directories. Returns the absolute path of
 * the chosen folder, or undefined when the picker was dismissed (or the
 * task is not inside an open workspace folder). Shared by the
 * choosePublishScope command and by runCompletionLint's stale-scope
 * re-prompt (completionLint.ts), so both persist through the same write.
 */
export async function promptAndPersistPublishScope(
  taskFolderUri: vscode.Uri,
  options?: { title?: string; currentRelPath?: string }
): Promise<string | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage(
      "The task is not inside an open workspace folder."
    );
    return undefined;
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const items: Array<vscode.QuickPickItem & { relPath: string }> = [
    {
      label: workspaceFolder.name,
      description: "workspace folder root (default)",
      relPath: "",
    },
  ];
  const packageJsons = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, "**/package.json"),
    "**/node_modules/**",
    50
  );
  for (const uri of packageJsons) {
    const rel = path.relative(workspaceRoot, path.dirname(uri.fsPath));
    if (rel) {
      items.push({ label: rel, description: "nested package.json", relPath: rel });
    }
  }

  const current = options?.currentRelPath;
  const picked = await vscode.window.showQuickPick(items, {
    title: options?.title ?? "Publish verification scope",
    placeHolder: current
      ? `Current scope: ${current || "(workspace root)"} — lint/tests/plan verification run here`
      : "Folder that Publish-stage lint/tests/plan verification run against",
  });
  if (!picked) {
    return undefined;
  }

  await patchTaskProgress(taskFolderUri, (progress) => ({
    ...progress,
    publishScopePath: picked.relPath || undefined,
    updatedAt: new Date().toISOString(),
  }));
  return picked.relPath ? path.join(workspaceRoot, picked.relPath) : workspaceRoot;
}

/**
 * QuickPick the Publish verification scope for a task: workspace-folder
 * roots plus detected nested package.json directories. Deliberately a
 * separate persisted value from the release target — neither ever silently
 * reuses the other's value.
 */
export async function choosePublishScope(
  inventory: TaskInventory,
  explicitArg?: ChoosePublishScopeArg
): Promise<void> {
  const resolved = await resolveTaskContext(inventory, normalizeArg(explicitArg), {
    allowPaused: true,
  });
  if (!resolved) {
    void vscode.window.showErrorMessage(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolved.taskFolderPath);
  const chosen = await promptAndPersistPublishScope(taskFolderUri, {
    title: `Publish verification scope for "${resolved.folderName}"`,
    currentRelPath: resolved.progress.publishScopePath,
  });
  if (chosen === undefined) {
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  const relPath = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, chosen)
    : chosen;
  await inventory.refresh();
  NotificationRouter.showInformation(
    `Publish verification scope set to ${relPath || "the workspace folder root"}.`
  );
}

export function registerChoosePublishScopeCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.choosePublishScope",
      (arg?: ChoosePublishScopeArg) => choosePublishScope(inventory, arg)
    )
  );
}
