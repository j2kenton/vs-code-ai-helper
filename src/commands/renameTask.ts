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
  ensureTaskRunsDirectoryV1,
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
        updatedAt: new Date().toISOString(),
      }));
      await inventory.refresh();
      op.report(`renamed to "${name.trim()}"`);
    }
  );
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

/** Collapse markdown markup and whitespace so a candidate name can be
 * compared against raw task-description text on words alone. */
function normalizeForComparison(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when `candidate` is (up to markdown/whitespace normalization) the
 * literal leading N words of `description`, where N is the candidate's own
 * word count — i.e. the model (or a bug) just copied the task's opening
 * words instead of summarizing. Exported for testing.
 */
export function isLeadingSubstringOfDescription(candidate: string, description: string): boolean {
  const candidateWords = wordsOf(normalizeForComparison(candidate));
  if (candidateWords.length === 0) {
    return false;
  }
  const descriptionWords = wordsOf(normalizeForComparison(description));
  if (descriptionWords.length < candidateWords.length) {
    return false;
  }
  return descriptionWords.slice(0, candidateWords.length).join(" ") === candidateWords.join(" ");
}

const RENAME_MIN_WORDS = 6;
const RENAME_MAX_WORDS = 8;

export type NameValidationFailureReason = "too-short" | "too-long" | "leading-substring";

export type NameValidationResult =
  | { ok: true; name: string }
  | { ok: false; reason: NameValidationFailureReason };

/**
 * Enforce the full 6–8 word contract for an AI-produced task name, and
 * reject a reply that is just the task description's opening words restated
 * (the regression this guards against — see the module doc on
 * `renameTaskWithAI`). Exported for testing.
 */
export function validateAiNameReply(name: string, taskDescription: string): NameValidationResult {
  const wordCount = wordsOf(name).length;
  if (wordCount < RENAME_MIN_WORDS) {
    return { ok: false, reason: "too-short" };
  }
  if (wordCount > RENAME_MAX_WORDS) {
    return { ok: false, reason: "too-long" };
  }
  if (isLeadingSubstringOfDescription(name, taskDescription)) {
    return { ok: false, reason: "leading-substring" };
  }
  return { ok: true, name };
}

function strictnessNoteFor(reason: NameValidationFailureReason | undefined): string {
  switch (reason) {
    case "too-long":
      return "IMPORTANT: your previous answer was too long. Respond with 6 to 8 words — nothing more.";
    case "too-short":
      return "IMPORTANT: your previous answer was too short. Respond with 6 to 8 words — no fewer.";
    case "leading-substring":
      return "IMPORTANT: your previous answer just repeated the task description's opening words. Write an actual summary of what the task accomplishes, in your own words.";
    default:
      return "";
  }
}

type AiNameRequestResult =
  | { kind: "no-model" }
  /**
   * The attempt never reached name validation at all — the coordinator
   * settled non-completed, or the suggestion artifact could not be written
   * or read back. `detail` names the concrete cause so the user-facing
   * warning can say what actually happened instead of blaming the model for
   * a reply it may well have produced correctly.
   */
  | { kind: "failed"; detail: string }
  | { kind: "ok"; name: string };

/**
 * Ask the configured Description-stage model for a 6–8 word name via the
 * `renameTask.v1` coordinator row.
 */
async function requestAiNameV1(
  context: vscode.ExtensionContext,
  task: ResolvedTaskContext,
  taskDescription: string,
  strictnessNote: string,
  token: vscode.CancellationToken
): Promise<AiNameRequestResult> {
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  const workspaceFolder = task.workspaceFolder
    ? vscode.workspace.getWorkspaceFolder(task.workspaceFolder)
    : undefined;
  if (!workspaceFolder) {
    return { kind: "no-model" };
  }

  const { modelId } = await resolveFreshModelForStage(taskFolderUri, "desc");
  if (!modelId) {
    return { kind: "no-model" };
  }

  try {
    const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
    const taskBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!taskBindingId) {
      return { kind: "failed", detail: "the task folder is not a verified task binding" };
    }
    // The row promotes into runs/ through createFileExclusive, which never
    // creates missing parents — see ensureTaskRunsDirectoryV1. Do it before
    // the provider call so a task that has never run a stage does not spend
    // a model call on a promotion that cannot land.
    if (!(await ensureTaskRunsDirectoryV1(rootId))) {
      return { kind: "failed", detail: "the task's runs/ directory could not be created" };
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
      return {
        kind: "failed",
        detail: `the action settled ${outcome.kind}${"code" in outcome ? ` (${outcome.code})` : ""}`,
      };
    }
    const readResult = await getWorkflowFileStoreV1().readFileBounded(targetLocator, 16 * 1024);
    if (readResult.kind !== "ok") {
      return {
        kind: "failed",
        detail: `the suggestion artifact could not be read back (${readResult.kind}${
          "code" in readResult ? `: ${readResult.code}` : ""
        })`,
      };
    }
    const name = normalizeAiNameReply(readResult.value.bytes.toString("utf8"));
    return name.length > 0
      ? { kind: "ok", name }
      : { kind: "failed", detail: "the reply was empty" };
  } catch (error) {
    console.error("renameTaskWithAI: provider/coordinator call threw", error);
    return {
      kind: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rename Task with AI: read the task description and produce a genuine 6–8
 * word high-level summary from the configured model, applied directly (the
 * explicit click is the confirmation, so it renames even after a prior
 * manual rename). There is no deterministic fallback — a reply that fails
 * validation (wrong length, or just the description's opening words restated)
 * gets one bounded re-prompt, and if that still fails the task keeps its
 * current name and the user is notified.
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
        const first = await requestAiNameV1(context, task, sourceText, "", token);
        if (first.kind === "no-model") {
          NotificationRouter.showWarning(
            "No Description-stage model is configured, so Rename Task with AI could not run. Configure a model in AI Models, or rename manually."
          );
          return;
        }

        const rejectedReplies: string[] = [];
        let lastFailureDetail: string | undefined;
        let validated: NameValidationResult | undefined;
        if (first.kind === "ok") {
          validated = validateAiNameReply(first.name, sourceText);
          if (!validated.ok) {
            rejectedReplies.push(first.name);
          }
        } else {
          lastFailureDetail = first.detail;
        }

        // At most one bounded re-prompt covers every failure combination
        // (too-long, too-short, leading-substring, or an outright failure).
        if (!validated || !validated.ok) {
          const retry = await requestAiNameV1(
            context,
            task,
            sourceText,
            strictnessNoteFor(validated?.reason),
            token
          );
          if (retry.kind === "ok") {
            validated = validateAiNameReply(retry.name, sourceText);
            if (!validated.ok) {
              rejectedReplies.push(retry.name);
            }
          } else if (retry.kind === "failed") {
            lastFailureDetail = retry.detail;
          }
        }

        if (!validated || !validated.ok) {
          console.error(
            `renameTaskWithAI: no valid 6-8 word summary produced for "${task.taskFolderPath}"`,
            { rejectedReplies, lastFailureDetail }
          );
          // Only blame the model when it actually replied and the reply was
          // rejected. When no reply ever reached validation the cause is the
          // run itself — a non-completed settlement, or a storage failure
          // writing/reading the suggestion artifact — and saying "the AI did
          // not produce a valid summary" sends diagnosis in the wrong
          // direction entirely (observed 2026-08-20, where the model had
          // answered correctly twice and promotion failed on a missing
          // runs/ directory).
          NotificationRouter.showWarning(
            rejectedReplies.length > 0
              ? "The AI did not produce a valid task summary, so the name was not changed. Configure a Description-stage model in AI Models, or rename manually."
              : `Rename Task with AI could not complete, so the name was not changed — ${
                  lastFailureDetail ?? "the provider call failed"
                }. Try again, or rename manually.`
          );
          return;
        }

        const finalName = validated.name;
        await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
          ...current,
          displayName: finalName,
          // The explicit Rename Task with AI click confirms the name.
          nameIsDefault: false,
          updatedAt: new Date().toISOString(),
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
