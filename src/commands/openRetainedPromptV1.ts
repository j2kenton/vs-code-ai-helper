/**
 * "Ensemble: Open Retained Prompt" — item 18's "retain the assembled prompt"
 * requirement (Part 2 step 7): lets the user open the exact prompt text a
 * past implementation round was dispatched with, so "did the model see X?"
 * (item 18's core finding — plan non-goals, checklist content, prompt size)
 * is answerable from disk instead of unknowable.
 *
 * Reads the `.prompt.txt` sibling `writePromptManifestV1` writes beside a
 * round's run log, keyed to the manifest's `roundId` (see that module's doc
 * comment for why this is a plain retained file, keyed by a freshly
 * allocated observability id, rather than a `chatInteractionTransactionV1`
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

interface OpenRetainedPromptArg {
  task?: IncompleteTask;
}

interface RetainedPromptEntry {
  readonly label: string;
  readonly promptUri: vscode.Uri;
  readonly mtime: number;
  /** The sibling manifest's `roundId`, when readable — see promptManifestV1.ts. */
  readonly roundId?: string;
}

async function readManifestRoundIdV1(promptUri: vscode.Uri): Promise<string | undefined> {
  const manifestUri = vscode.Uri.file(promptUri.fsPath.replace(/\.prompt\.txt$/, ".prompt-manifest.json"));
  try {
    const raw = await vscode.workspace.fs.readFile(manifestUri);
    const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as { roundId?: string };
    return typeof manifest.roundId === "string" ? manifest.roundId : undefined;
  } catch {
    return undefined;
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
    const roundId = await readManifestRoundIdV1(promptUri);
    prompts.push({ label: name.replace(/\.prompt\.txt$/, ""), promptUri, mtime, roundId });
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
  const picked = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: task.progress.displayName ?? task.folderName,
      description: task.folderName,
      task,
    })),
    { title: "Open Retained Prompt", placeHolder: "Select a task" }
  );
  return picked?.task;
}

export async function openRetainedPromptV1(arg?: OpenRetainedPromptArg): Promise<void> {
  const task = arg?.task ?? (await pickTaskV1());
  if (!task) {
    return;
  }

  const prompts = await listRetainedPromptsV1(task.folderUri);
  if (prompts.length === 0) {
    NotificationRouter.showInformation(
      `No retained prompts found for ${task.progress.displayName ?? task.folderName} yet — they are written starting with this task's next implementation round.`
    );
    return;
  }

  const selected =
    prompts.length === 1
      ? prompts[0]
      : (
          await vscode.window.showQuickPick(
            prompts.map((entry) => ({
              label: entry.label,
              description: entry.roundId ? `Round ID: ${entry.roundId}` : undefined,
              entry,
            })),
            { title: "Open Retained Prompt", placeHolder: "Select a round" }
          )
        )?.entry;
  if (!selected) {
    return;
  }

  if (!(await statIfExists(selected.promptUri))) {
    NotificationRouter.showWarning("The retained prompt file no longer exists on disk.");
    return;
  }
  await warnIfPromptCaptureIncompleteV1(selected.promptUri);
  await safeOpenTextDocument(selected.promptUri, `${selected.label}.prompt.txt`);
}

/**
 * See `PromptManifestV1.promptCaptureComplete`: a Copilot-resolved round's
 * retained text is the pre-coordinator template only, missing the sealed
 * pipeline's preflight preamble and result-contract suffix. Surfacing that
 * here, at the point the user is about to read the file as "what the model
 * saw", is what keeps the manifest's honesty useful rather than merely
 * recorded.
 */
async function warnIfPromptCaptureIncompleteV1(promptUri: vscode.Uri): Promise<void> {
  const manifestUri = vscode.Uri.file(promptUri.fsPath.replace(/\.prompt\.txt$/, ".prompt-manifest.json"));
  try {
    const raw = await vscode.workspace.fs.readFile(manifestUri);
    const manifest = JSON.parse(Buffer.from(raw).toString("utf8")) as { promptCaptureComplete?: boolean };
    if (manifest.promptCaptureComplete === false) {
      NotificationRouter.showWarning(
        "This round ran through the Copilot sealed pipeline: the retained text is the pre-dispatch template only. " +
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
