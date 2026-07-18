import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask, patchTaskProgress, readTaskProgress } from "../utils/taskProgressUtils";
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

/** True when the path exists on disk and is a directory. */
function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Compare absolute paths, case-insensitively on Windows (like VS Code). */
function isSamePath(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  return process.platform === "win32"
    ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
    : resolvedA === resolvedB;
}

type PickerRootResolution =
  | { kind: "resolved"; root: string; label: string; findBase: vscode.WorkspaceFolder | vscode.Uri }
  | { kind: "stale-binding"; projectRoot: string }
  | { kind: "unbound" };

/**
 * Resolve the root the Publish-scope picker offers, and that a persisted
 * relative scope resolves against. Persisted ownership takes precedence
 * over task-folder containment (mirroring resolveReleaseWorkspace in
 * reviewActions.ts): a task can live in an external metadata root that
 * happens to sit inside an unrelated open workspace, and that parent
 * workspace must never be offered as if it were the project — a recorded
 * `ownership.projectRoot` that has vanished is reported stale instead.
 * Only a legacy task with no recorded binding falls back to its containing
 * workspace folder. Must stay consistent with resolvePublishScopeFolder's
 * default (completionLint.ts) so a picked relative path round-trips to the
 * same absolute folder.
 */
async function resolvePickerRoot(taskFolderUri: vscode.Uri): Promise<PickerRootResolution> {
  const progress = await readTaskProgress(taskFolderUri);
  const projectRoot = progress?.ownership?.projectRoot?.trim();
  if (projectRoot) {
    if (!isExistingDirectory(projectRoot)) {
      return { kind: "stale-binding", projectRoot };
    }
    const matchingFolder = (vscode.workspace.workspaceFolders ?? []).find((folder) =>
      isSamePath(folder.uri.fsPath, projectRoot)
    );
    if (matchingFolder) {
      return {
        kind: "resolved",
        root: matchingFolder.uri.fsPath,
        label: matchingFolder.name,
        findBase: matchingFolder,
      };
    }
    // findFiles only searches open workspace folders; a Uri base inside one
    // still matches, and a projectRoot outside the open workspace degrades
    // to a root-only pick rather than refusing outright.
    return {
      kind: "resolved",
      root: projectRoot,
      label: path.basename(projectRoot),
      findBase: vscode.Uri.file(projectRoot),
    };
  }
  const containing = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  if (containing) {
    return { kind: "resolved", root: containing.uri.fsPath, label: containing.name, findBase: containing };
  }
  return { kind: "unbound" };
}

/**
 * QuickPick a Publish verification scope for the task and persist the
 * choice on the task record. Items are the project root (workspace folder
 * or ownership binding — see resolvePickerRoot) plus detected nested
 * package.json directories. Returns the absolute path of the chosen
 * folder, or undefined when the picker was dismissed (or no project root
 * could be resolved for the task). Shared by the choosePublishScope
 * command and by runCompletionLint's stale-scope re-prompt
 * (completionLint.ts), so both persist through the same write.
 */
export async function promptAndPersistPublishScope(
  taskFolderUri: vscode.Uri,
  options?: { title?: string; currentRelPath?: string }
): Promise<string | undefined> {
  const base = await resolvePickerRoot(taskFolderUri);
  if (base.kind === "stale-binding") {
    void vscode.window.showWarningMessage(
      `The task's recorded project root ("${base.projectRoot}") no longer exists, so there ` +
        "is no valid folder to offer as a Publish verification scope. Re-bind the task to " +
        "its project and try again."
    );
    return undefined;
  }
  if (base.kind === "unbound") {
    void vscode.window.showWarningMessage(
      "The task is not inside an open workspace folder and has no project binding to verify against."
    );
    return undefined;
  }
  const workspaceRoot = base.root;

  const items: Array<vscode.QuickPickItem & { relPath: string }> = [
    {
      label: base.label,
      description: "project root (default)",
      relPath: "",
    },
  ];
  const packageJsons = await vscode.workspace.findFiles(
    new vscode.RelativePattern(base.findBase, "**/package.json"),
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

  await inventory.refresh();
  // The persisted value is already relative to the picker root (workspace
  // folder or ownership projectRoot), so it is the right display form for
  // external-metadata-root tasks too.
  const stored = await readTaskProgress(taskFolderUri);
  NotificationRouter.showInformation(
    `Publish verification scope set to ${stored?.publishScopePath ?? "the project root"}.`
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
