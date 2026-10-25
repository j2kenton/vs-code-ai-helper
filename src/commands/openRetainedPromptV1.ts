/**
 * "Ensemble: Open Retained Prompt" — item 18's "retain the assembled prompt"
 * requirement (Part 2 step 7): lets the user open the exact prompt text a
 * past implementation round was dispatched with, so "did the model see X?"
 * (item 18's core finding — plan non-goals, checklist content, prompt size)
 * is answerable from disk instead of unknowable.
 *
 * Reads every `.prompt.txt` sibling `writePromptManifestV1` writes beside a
 * task's run logs (one per captured coordinator attempt as of the review fix,
 * 2026-08-27 — a round whose primary candidate failed and fell back to a
 * secondary now retains both attempts' prompts, not just the last), labelled
 * by the sibling manifest's `attemptId` when present, else its `roundId` (see
 * that module's doc comment for why this is a plain retained file, keyed by
 * these observability ids, rather than a `chatInteractionTransactionV1`
 * lookup — that store's `inputSnapshot` is the validated action input for
 * Resume reconstruction, not dispatched prompt text, and would not answer
 * this command's question even where a transaction happens to exist).
 */
import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "../utils/taskRoot";
import { RUNS_DIRNAME } from "../types/taskProgress";
import { findAllTasksStrictV1 } from "../services/taskProgressDiscoveryV1";
import { IncompleteTask } from "../types/incompleteTask";
import { safeOpenTextDocument, statIfExists } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { askChatChoiceV1 } from "../utils/chatChoiceV1";
import { resolveGlobalChatTargetV1 } from "../utils/globalChatTargetV1";

interface OpenRetainedPromptArg {
  task?: IncompleteTask;
}

interface RetainedPromptEntry {
  readonly label: string;
  readonly promptUri: vscode.Uri;
  readonly mtime: number;
  /** The sibling manifest's `roundId`, when readable — see promptManifestV1.ts. */
  readonly roundId?: string;
  /**
   * The sibling manifest's `attemptId` — the coordinator's own per-attempt
   * identity (review fix, 2026-08-27: attempt-based lookup). Undefined for a
   * CLI-resolved round (no coordinator attempt exists) or a manifest
   * predating this field. A round with a fallback/retry now writes one
   * `.prompt.txt` per attempt, so this is what distinguishes them in the
   * picker beyond filename/mtime alone.
   */
  readonly attemptId?: string;
}

async function readManifestIdentityV1(
  promptUri: vscode.Uri
): Promise<{ roundId?: string; attemptId?: string }> {
  const manifestUri = vscode.Uri.file(promptUri.fsPath.replace(/\.prompt\.txt$/, ".prompt-manifest.json"));
  try {
    const raw = await vscode.workspace.fs.readFile(manifestUri);
    const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as {
      roundId?: string;
      attemptId?: string;
    };
    return {
      roundId: typeof manifest.roundId === "string" ? manifest.roundId : undefined,
      attemptId: typeof manifest.attemptId === "string" ? manifest.attemptId : undefined,
    };
  } catch {
    return {};
  }
}

async function listRetainedPromptsV1(folderUri: vscode.Uri): Promise<RetainedPromptEntry[]> {
  const runsUri = vscode.Uri.joinPath(folderUri, RUNS_DIRNAME);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(runsUri);
  } catch {
    return [];
  }
  const prompts: RetainedPromptEntry[] = [];
  for (const [name, fileType] of entries) {
    if (fileType !== vscode.FileType.File || !name.endsWith(".prompt.txt")) {
      continue;
    }
    const promptUri = vscode.Uri.joinPath(runsUri, name);
    let mtime = 0;
    try {
      const stat = await vscode.workspace.fs.stat(promptUri);
      mtime = stat.mtime;
    } catch {
      // Keep default mtime — the entry still opens fine.
    }
    const { roundId, attemptId } = await readManifestIdentityV1(promptUri);
    prompts.push({ label: name.replace(/\.prompt\.txt$/, ""), promptUri, mtime, roundId, attemptId });
  }
  prompts.sort((a, b) => b.mtime - a.mtime);
  return prompts;
}

async function pickTaskV1(): Promise<IncompleteTask | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showError("No workspace folder open. Please open a folder first.");
    return undefined;
  }
  const metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, getConfiguredTaskRoot());
  const tasks = (await findAllTasksStrictV1(metaFolderUri)).tasks;
  if (tasks.length === 0) {
    NotificationRouter.showInformation("No tasks found.");
    return undefined;
  }
  const target = await resolveGlobalChatTargetV1();
  if (!target) {
    NotificationRouter.showError("No workspace folder open. Please open a folder first.");
    return undefined;
  }
  const chosen = await askChatChoiceV1({
    decisionKey: "openRetainedPromptTask",
    target,
    whatHappened: "Choose the task whose retained implementation prompt you want to inspect.",
    whyUserNeeded: "Retained prompts are per task, so the task must be chosen first.",
    options: tasks.map((task, index) => ({
      optionId: `task-${index}`,
      label: task.progress.displayName ?? task.folderName,
      description: task.folderName,
    })),
    detail: "Answering asks which of that task's rounds to open.",
  });
  const index = chosen === undefined ? -1 : tasks.findIndex((_task, i) => `task-${i}` === chosen);
  return index >= 0 ? tasks[index] : undefined;
}

export async function openRetainedPromptV1(arg?: OpenRetainedPromptArg): Promise<void> {
  const task = arg?.task ?? (await pickTaskV1());
  if (!task) {
    return;
  }

  const prompts = await listRetainedPromptsV1(task.folderUri);
  if (prompts.length === 0) {
    NotificationRouter.showInformation(
      `${formatNotificationTaskLabelV1(task.progress.displayName, task.folderName)}: no retained prompts found yet — they are written starting with this task's next implementation round.`
    );
    return;
  }

  let selected = prompts.length === 1 ? prompts[0] : undefined;
  if (!selected) {
    const chosen = await askChatChoiceV1({
      decisionKey: "openRetainedPromptRound",
      target: {
        canonicalId: task.canonicalId ?? task.folderUri.fsPath,
        taskFolderPath: task.folderUri.fsPath,
        stage: task.progress.currentStage,
        taskName: task.progress.displayName ?? task.folderName,
      },
      whatHappened: "Choose which retained implementation prompt to open.",
      whyUserNeeded: "More than one prompt was retained for this task.",
      options: prompts.map((entry, index) => ({
        optionId: `prompt-${index}`,
        label: entry.label,
        description: entry.attemptId
          ? `Attempt ID: ${entry.attemptId}${entry.roundId ? ` (round ${entry.roundId})` : ""}`
          : entry.roundId
            ? `Round ID: ${entry.roundId}`
            : undefined,
      })),
      detail: "Answering opens the chosen prompt file.",
    });
    const index = chosen === undefined ? -1 : prompts.findIndex((_entry, i) => `prompt-${i}` === chosen);
    selected = index >= 0 ? prompts[index] : undefined;
  }
  if (!selected) {
    return;
  }

  const taskLabel = formatNotificationTaskLabelV1(task.progress.displayName, task.folderName);
  if (!(await statIfExists(selected.promptUri))) {
    NotificationRouter.showWarning(`${taskLabel}: the retained prompt file no longer exists on disk.`);
    return;
  }
  await warnIfPromptCaptureIncompleteV1(selected.promptUri, taskLabel);
  await safeOpenTextDocument(selected.promptUri, `${selected.label}.prompt.txt`, task.folderUri);
}

/**
 * See `PromptManifestV1.promptCaptureComplete`: a Copilot-resolved round's
 * retained text is the pre-coordinator template only, missing the sealed
 * pipeline's preflight preamble and result-contract suffix. Surfacing that
 * here, at the point the user is about to read the file as "what the model
 * saw", is what keeps the manifest's honesty useful rather than merely
 * recorded.
 */
async function warnIfPromptCaptureIncompleteV1(promptUri: vscode.Uri, taskLabel: string): Promise<void> {
  const manifestUri = vscode.Uri.file(promptUri.fsPath.replace(/\.prompt\.txt$/, ".prompt-manifest.json"));
  try {
    const raw = await vscode.workspace.fs.readFile(manifestUri);
    const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as { promptCaptureComplete?: boolean };
    if (manifest.promptCaptureComplete === false) {
      NotificationRouter.showWarning(
        `${taskLabel}: this round ran through the Copilot sealed pipeline: the retained text is the pre-dispatch template only. ` +
          "The provider also received a preflight tool-session preamble and a result-contract suffix that are not captured here."
      );
    }
  } catch {
    // No manifest, or it predates this field — nothing to warn about.
  }
}

export function registerOpenRetainedPromptCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.openRetainedPrompt",
    (arg?: OpenRetainedPromptArg) => openRetainedPromptV1(arg)
  );
  context.subscriptions.push(disposable);
}
