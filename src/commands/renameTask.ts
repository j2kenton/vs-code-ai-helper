import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import {
  runTrackedOperation,
  taskOperations,
  TASK_NAME_WRITE_CONFLICT_KEY,
} from "../utils/taskOperations";
import { parseTaskDocument } from "../utils/taskDescriptionDocument";
import { TaskNode } from "../views/taskTreeProvider";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { ensureAiConsent } from "../utils/aiConsent";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { createProductionTaskActionCoordinatorV1 } from "../actions/productionTaskActionRuntimeV1";
import {
  RENAME_TASK_ACTION_KEY_V1,
  RenameTaskActionInputV1,
} from "../actions/rows/renameTaskRowV1";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
} from "../services/workflowRuntimeServicesV1";

type TaskArg = TaskNode | { canonicalId?: string; taskFolderPath?: string };

async function resolve(inventory: TaskInventory, arg?: TaskArg) {
  if (arg instanceof TaskNode) {
    return resolveTaskContext(
      inventory,
      {
        canonicalId: arg.task.canonicalId,
        taskFolderPath: arg.task.folderUri.fsPath,
      },
      { allowPaused: true }
    );
  }
  return resolveTaskContext(inventory, arg, { allowPaused: true });
}

/**
 * Rename never contends for the task's exclusive operation lock (both rename
 * operations register with `exclusive: false`): the displayName patch goes
 * through patchTaskProgressStrictV1, which merges onto freshly-read state
 * under its own journaled lock, so it is safe beside a running
 * implementation, review, or publish operation. The one stage it must NOT
 * run beside is Task Description generation — the requested product
 * boundary. That run never writes the name (naming is owned exclusively by
 * the rename actions, per handleDraftOutcomeV1 in draftTaskWithAI.ts), but
 * it works from the name captured when it was admitted — its Notifications
 * row, chat interaction labels, and run log — so a mid-run rename would
 * desync those surfaces.
 *
 * This guard exists for the quality of the message only — the exclusion
 * itself is enforced atomically by the operation registry: both rename
 * operations and the Task Description operation register with
 * TASK_NAME_WRITE_CONFLICT_KEY, so `begin` refuses either while the other is
 * active, with no window between check and registration.
 *
 * @returns true (after showing the explanatory warning) when rename must
 * wait; false when it may proceed.
 *
 * @internal exported for testing
 */
export function refuseRenameWhileDescStageRuns(taskFolderPath: string): boolean {
  const descRunning = taskOperations
    .getTaskOperations(taskFolderPath)
    .some((op) => op.state === "running" && op.stage === "desc");
  if (!descRunning) {
    return false;
  }
  NotificationRouter.showWarning(
    "Renaming is unavailable while the Task Description is being generated, because that run works from the task's current name. Wait for it to finish, then rename."
  );
  return true;
}

export async function renameTask(
  inventory: TaskInventory,
  arg?: TaskArg,
  suggestedName?: string
): Promise<void> {
  // Block on the startup gate's classification pass before this command's
  // first task-state read (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const task = await resolve(inventory, arg);
  if (!task) return;
  if (refuseRenameWhileDescStageRuns(task.taskFolderPath)) return;

  const name = await vscode.window.showInputBox({
    prompt: "Task name",
    value: suggestedName ?? task.progress.displayName ?? task.folderName,
    validateInput: (value) =>
      value.trim() ? undefined : "Task name cannot be blank.",
  });
  if (name === undefined) return;

  // The input box can sit open for as long as the user likes, so a Task
  // Description run may have started meanwhile — re-check for the
  // explanatory message. Even if one starts between this check and begin(),
  // the shared conflict key makes begin() refuse the rename atomically.
  if (refuseRenameWhileDescStageRuns(task.taskFolderPath)) return;

  // Tracked instant mutation (taxonomy: rename-task / terminal-always). The
  // input box stays outside the operation; the terminal Notifications entry
  // (including the new name, via report()) is recorded centrally by the
  // operation-notification bridge. Non-exclusive: see
  // refuseRenameWhileDescStageRuns — rename is safe beside every running
  // stage except Task Description generation, which the conflict key blocks.
  await runTrackedOperation(
    task.taskFolderPath,
    { label: "Rename Task", taskName: task.progress.displayName ?? task.folderName, kind: "rename-task", exclusive: false, conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY] },
    async (op) => {
      await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
        ...current,
        displayName: name.trim(),
        nameIsDefault: false,
      }));
      await inventory.refresh();
      op.report(`renamed to "${name.trim()}"`);
    }
  );
}

/**
 * Lines of abstract process/planning language ("independently shippable
 * slices", "decision gate", …) describe how the work is organized, not what
 * it does — they make meaningless task names, so name derivation skips them
 * in favor of the first line that states concrete work.
 */
const ABSTRACT_PLANNING_LINE =
  /\b(shippable|workstream|decision gate|vertical slice|slices?\b.*\bcarved|carved out of|integration checkpoint|implementation checklist|checklist below|scope and requirements|open questions)\b/i;

/**
 * Derive a concise task name from the task description text: the first
 * meaningful (non-heading, non-boilerplate, non-abstract) line, stripped of
 * markdown markup and truncated at a sentence boundary. Exported for testing.
 */
export function deriveNameFromDescription(text: string): string | undefined {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  let firstFallback: string | undefined;
  for (const rawLine of withoutCode.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^<!--/.test(line)) {
      continue;
    }
    // Strip list markers, emphasis, and inline code markup.
    line = line
      .replace(/^[-*>\d.)\s]+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    // Meta labels like "Goal:" / "Scope:" prefix real content — drop the label.
    line = line.replace(/^(Goal|Scope|Objective|Summary|Task|Description)\s*:\s*/i, "").trim();
    if (line.length < 8) {
      continue;
    }
    // Cut at the first sentence end when the line is long.
    const sentenceEnd = line.search(/[.!?](\s|$)/);
    if (sentenceEnd > 12) {
      line = line.slice(0, sentenceEnd);
    }
    const candidate = line.slice(0, 100).trim();
    if (ABSTRACT_PLANNING_LINE.test(candidate)) {
      // Remember it in case nothing concrete follows, but keep looking for a
      // line that says what the work actually changes.
      firstFallback = firstFallback ?? candidate;
      continue;
    }
    return candidate;
  }
  return firstFallback;
}

/** Split into whitespace-delimited words (markdown-stripped input assumed). */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Normalize a model reply into a single-line candidate name: first non-empty
 * line, stripped of surrounding quotes, markdown emphasis, and a trailing
 * period.
 */
export function normalizeAiNameReply(reply: string): string {
  const firstLine =
    reply
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine
    .replace(/^["'`*_\s]+/, "")
    .replace(/["'`*_\s]+$/, "")
    .replace(/\.$/, "")
    .trim();
}

/** Clamp a too-long name at a word boundary — never mid-word. */
export function clampNameAtWordBoundary(name: string, maxWords: number): string {
  return wordsOf(name).slice(0, maxWords).join(" ");
}

const RENAME_MAX_WORDS = 7;

/**
 * Ask the configured Description-stage model for a 5–7 word name via the
 * `renameTask.v1` coordinator row. Returns the normalized reply, or
 * undefined when no provider path is available or the run fails/cancels.
 */
async function requestAiNameV1(
  context: vscode.ExtensionContext,
  task: ResolvedTaskContext,
  taskDescription: string,
  strictnessNote: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  const workspaceFolder = task.workspaceFolder
    ? vscode.workspace.getWorkspaceFolder(task.workspaceFolder)
    : undefined;
  if (!workspaceFolder) {
    return undefined;
  }

  const { modelId } = await resolveFreshModelForStage(taskFolderUri, "desc");
  if (!modelId) {
    return undefined;
  }

  try {
    const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
    const taskBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!taskBindingId) {
      return undefined;
    }
    const chatIdentity = await readChatDocumentIdentityV1(
      taskFolderUri.fsPath,
      task.canonicalId ?? taskFolderUri.fsPath
    );
    const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

    const prompt = await renderPromptTemplate(context.extensionUri, "rename-task.md", {
      taskDescription,
      strictnessNote,
    });

    const coordinator = createProductionTaskActionCoordinatorV1({
      workspaceCwd: workspaceFolder.uri.fsPath,
      resolveStagePrimaryModel: () => ({ modelId, stage: "desc" }),
    });

    const targetLocator = { rootId, relativePath: `runs/rename-suggestion-${Date.now()}.txt` };
    const validatedInput: RenameTaskActionInputV1 = { prompt, targetLocator };

    const outcome = await coordinator.executeAction({
      actionKey: RENAME_TASK_ACTION_KEY_V1,
      taskBinding: { taskBindingId, chatDocumentId },
      taskStatus: task.progress.status ?? "active",
      taskStage: task.progress.currentStage,
      rawInput: validatedInput,
      cancellationToken: token,
    });

    if (outcome.kind !== "completed") {
      return undefined;
    }
    const readResult = await getWorkflowFileStoreV1().readFileBounded(targetLocator, 16 * 1024);
    if (readResult.kind !== "ok") {
      return undefined;
    }
    const name = normalizeAiNameReply(readResult.value.bytes.toString("utf8"));
    return name.length > 0 ? name : undefined;
  } catch {
    // Any provider/coordinator failure falls back to the offline derivation.
    return undefined;
  }
}

/**
 * Rename Task with AI: read the task description and produce a short 5–7
 * word high-level summary, applied directly (the explicit click is the
 * confirmation, so it renames even after a prior manual rename). Falls back
 * to `deriveNameFromDescription` when no provider is available.
 */
export async function renameTaskWithAI(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  arg?: TaskArg
): Promise<void> {
  // Same activation-barrier contract as renameTask above (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const task = await resolve(inventory, arg);
  if (!task) return;
  if (refuseRenameWhileDescStageRuns(task.taskFolderPath)) return;

  const readText = async (fileName: string): Promise<string> => {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(task.taskFolderPath), fileName);
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return "";
    }
  };

  let sourceText = (await readText(TASK_DESCRIPTION_FILENAME)).trim();
  if (!sourceText) {
    const parsed = parseTaskDocument(await readText(TASK_FILENAME));
    sourceText = parsed.taskDescription || parsed.draftWithAI;
  }
  if (!sourceText.trim()) {
    NotificationRouter.showWarning(
      "This task has no description yet. Write a task description before renaming with AI."
    );
    return;
  }

  const consented = await ensureAiConsent(context);
  if (!consented) return;

  // The consent prompt can pause the flow indefinitely — re-check for the
  // explanatory message; begin()'s conflict key enforces the exclusion
  // atomically regardless (see refuseRenameWhileDescStageRuns).
  if (refuseRenameWhileDescStageRuns(task.taskFolderPath)) return;

  await runTrackedOperation(
    task.taskFolderPath,
    { label: "Rename Task with AI", taskName: task.progress.displayName ?? task.folderName, kind: "rename-task", exclusive: false, conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY] },
    async (op) => {
      const fallbackCts = new vscode.CancellationTokenSource();
      const token = op.token ?? fallbackCts.token;
      try {
        let name = await requestAiNameV1(context, task, sourceText, "", token);
        if (name !== undefined && wordsOf(name).length > RENAME_MAX_WORDS) {
          // Too long: one stricter retry, then clamp at a word boundary.
          const retried = await requestAiNameV1(
            context,
            task,
            sourceText,
            "IMPORTANT: your previous answer was too long. Respond with 5 to 7 words — nothing more.",
            token
          );
          name = retried ?? name;
          if (wordsOf(name).length > RENAME_MAX_WORDS) {
            name = clampNameAtWordBoundary(name, RENAME_MAX_WORDS);
          }
        }

        if (name === undefined) {
          // Offline fallback: derive a concise name without a provider.
          name = deriveNameFromDescription(sourceText);
        }
        if (!name) {
          NotificationRouter.showWarning(
            "Could not produce a task name. Configure a Description-stage model in AI Models, or rename manually."
          );
          return;
        }

        const finalName = name;
        await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
          ...current,
          displayName: finalName,
          // The explicit Rename Task with AI click confirms the name.
          nameIsDefault: false,
        }));
        await inventory.refresh();
        op.report(`renamed to "${finalName}"`);
      } finally {
        fallbackCts.dispose();
      }
    }
  );
}

export function registerRenameTaskCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.renameTask", (arg?: TaskArg) =>
      renameTask(inventory, arg)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.renameTaskWithAI",
      (arg?: TaskArg) => renameTaskWithAI(context, inventory, arg)
    )
  );
}
