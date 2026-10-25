import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { awaitWorkflowDecisionAnswerV1 } from "../utils/workflowDecisionDispatchV1";

type ChoosePublishScopeArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; publishScopeRelPath?: string; resumeChecks?: boolean };

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
  const readResult = await readTaskProgressStrictV1(taskFolderUri);
  const progress = readResult.ok ? readResult.decoded.progress : undefined;
  const projectRoot = progress?.ownership?.projectRoot?.trim();
  if (projectRoot) {
    // The task schema records an absolute binding.  A relative value would
    // otherwise be interpreted relative to the extension host's cwd and
    // could offer an unrelated project in the scope picker.
    if (!path.isAbsolute(projectRoot) || !isExistingDirectory(projectRoot)) {
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
 * Ask in task chat for a Publish verification scope and persist the
 * choice on the task record. Options are the project root (workspace folder
 * or ownership binding — see resolvePickerRoot) plus detected nested
 * package.json directories. Returns the absolute path of the chosen
 * folder, or undefined when the chat card was dismissed (or no project root
 * could be resolved for the task). Shared by the choosePublishScope
 * command and by runCompletionLint's stale-scope re-prompt
 * (completionLint.ts), so both persist through the same write and continue
 * their own operation with the returned folder.
 */
export async function promptAndPersistPublishScope(
  taskFolderUri: vscode.Uri,
  options?: { title?: string; currentRelPath?: string; resumeChecksOnSelection?: boolean }
): Promise<string | undefined> {
  const folderName = path.basename(taskFolderUri.fsPath);
  const base = await resolvePickerRoot(taskFolderUri);
  if (base.kind === "stale-binding") {
    NotificationRouter.showWarning(
      `${folderName}: the task's recorded project root ("${base.projectRoot}") no longer exists, so there ` +
        "is no valid folder to offer as a Publish verification scope. Re-bind the task to " +
        "its project and try again."
    );
    return undefined;
  }
  if (base.kind === "unbound") {
    NotificationRouter.showWarning(
      `${folderName}: the task is not inside an open workspace folder and has no project binding to verify against.`
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
  const taskProgress = await readTaskProgressStrictV1(taskFolderUri);
  if (!taskProgress.ok) {
    return undefined;
  }
  const stage = taskProgress.decoded.progress.currentStage;
  const target = {
    canonicalId: taskFolderUri.fsPath,
    taskFolderPath: taskFolderUri.fsPath,
    stage,
    taskName: taskProgress.decoded.progress.displayName ?? folderName,
  };
  // Awaited in-process, like the Commit & Push confirmations: the caller
  // (runCompletionLint's stale-scope re-prompt, or the choosePublishScope
  // command) continues its own operation with the chosen folder instead of
  // starting a separate Publish Checks run. Nothing is persisted when the
  // card is dismissed or times out, so the caller keeps its refusal path.
  const chosenOptionId = await awaitWorkflowDecisionAnswerV1({
    decisionKey: "choosePublishVerificationScope",
    taskCanonicalId: taskFolderUri.fsPath,
    stage,
    whatHappened: options?.title ?? `${folderName}: choose the folder for Publish verification.`,
    whyUserNeeded: "The Publish checks must run against the project root or one of its package folders.",
    options: items.map((item, index) => ({
      optionId: `scope-${index}`,
      label: item.relPath || `${item.label} (project root)`,
      resumeKind: "continue" as const,
      consequence: `Saves this Publish scope${
        options?.resumeChecksOnSelection ? " and continues the checks that asked for it" : ""
      }.`,
      effect: { kind: "doNothing" as const },
    })),
    recommendation: current !== undefined && items.some(item => item.relPath === current)
      ? { kind: "option", optionId: `scope-${items.findIndex(item => item.relPath === current)}`, reasoning: "This is the currently saved scope." }
      : { kind: "option", optionId: "scope-0", reasoning: "The project root is the default scope." },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: options?.resumeChecksOnSelection
        ? "Choosing a scope saves it and continues the current Publish checks."
        : "Choosing a scope saves it for this task.",
    },
  }, target);
  const chosenIndex = chosenOptionId === undefined
    ? -1
    : items.findIndex((_item, index) => `scope-${index}` === chosenOptionId);
  if (chosenIndex < 0) {
    return undefined;
  }
  const chosenItem = items[chosenIndex];
  if (!chosenItem) {
    return undefined;
  }
  const chosenRelPath = chosenItem.relPath;
  await patchTaskProgressStrictV1(taskFolderUri, (progress) => ({
    ...progress,
    publishScopePath: chosenRelPath || undefined,
    updatedAt: new Date().toISOString(),
  }));
  return chosenRelPath ? path.resolve(workspaceRoot, chosenRelPath) : workspaceRoot;
}

/**
 * Ask in task chat for the Publish verification scope for a task: workspace-folder
 * roots plus detected nested package.json directories. Deliberately a
 * separate persisted value from the release target — neither ever silently
 * reuses the other's value.
 */
export async function choosePublishScope(
  inventory: TaskInventory,
  explicitArg?: ChoosePublishScopeArg
): Promise<void> {
  // Block on the startup gate's classification pass before this command's
  // first task-state read — same barrier contract as startNewTask/resumeTask
  // (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const resolved = await resolveTaskContext(inventory, normalizeArg(explicitArg), {
    allowPaused: true,
  });
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolved.taskFolderPath);
  const normalized = explicitArg as { publishScopeRelPath?: string; resumeChecks?: boolean } | undefined;
  if (normalized?.publishScopeRelPath !== undefined) {
    const relPath = normalized.publishScopeRelPath;
    const pickerRoot = await resolvePickerRoot(taskFolderUri);
    const resolvedScope = relPath && pickerRoot.kind === "resolved"
      ? path.resolve(pickerRoot.root, relPath)
      : undefined;
    const validRelativeChoice = !relPath || (
      pickerRoot.kind === "resolved" &&
      !path.isAbsolute(relPath) &&
      !relPath.split(/[\\/]+/).includes("..") &&
      resolvedScope !== undefined &&
      isExistingDirectory(resolvedScope) &&
      fs.existsSync(path.join(resolvedScope, "package.json"))
    );
    if (pickerRoot.kind !== "resolved" || !validRelativeChoice) {
      NotificationRouter.showError(`${resolved.folderName}: the selected Publish scope is no longer available. Choose a valid scope from chat.`);
      return;
    }
    await patchTaskProgressStrictV1(taskFolderUri, (progress) => ({
      ...progress,
      publishScopePath: relPath || undefined,
      updatedAt: new Date().toISOString(),
    }));
    if (normalized.resumeChecks) {
      await vscode.commands.executeCommand("vs-code-ai-helper.runPublishChecks", { taskFolderPath: resolved.taskFolderPath });
    }
    return;
  }
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
  const stored = await readTaskProgressStrictV1(taskFolderUri);
  NotificationRouter.showInformation(
    `${resolved.folderName}: Publish verification scope set to ${
      (stored.ok ? stored.decoded.progress.publishScopePath : undefined) ?? "the project root"
    }.`
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
