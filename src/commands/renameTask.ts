import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { resolveTaskContext, ResolvedTaskContext, ResolveTaskOptions } from "../utils/resolveTaskContext";
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
import {
  acquireEarlyWorkAdmissionForCandidatePathV1,
  acquireWorkAdmissionV1,
  beginTargetResolutionV1,
  describeWorkAdmissionRefusalV1,
  endTargetResolutionV1,
  WorkAdmissionHandleV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
} from "../state/workAdmissionV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import { resolveTaskRootCandidates } from "../utils/taskRoot";

type TaskArg = TaskNode | { canonicalId?: string; taskFolderPath?: string };

/**
 * Work admission (v1 fixes item 1, Part 1a) needs a task folder path BEFORE
 * any awaited setup — mirrors `runLintingFixes.ts`'s
 * `extractSynchronousLintingFolderPathV1`. Only returns a path when one is
 * known synchronously from the argument (a tree-row invocation or a
 * resolver-aware caller); a bare canonicalId or no-arg invocation has
 * nothing to protect until `resolve()` picks a target, so admission is
 * acquired right after resolution instead, in `renameTaskWithAI` itself.
 */
function extractSynchronousRenameFolderPathV1(arg?: TaskArg): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (arg instanceof TaskNode) {
    return arg.task.folderUri.fsPath;
  }
  return arg.taskFolderPath;
}

async function resolve(
  inventory: TaskInventory,
  arg?: TaskArg,
  /**
   * 2026-09-10 review architectural blocker fix (`d620c877...-1`): threaded
   * through so `renameTaskWithAI` can acquire late admission and reconcile a
   * watchdog-provenance pause from INSIDE `resolveTaskContext`'s own
   * `onResolvedCandidate` hook — fired after ownership/containment/
   * workspace-binding validation has already passed, mirroring
   * `draftTaskWithAI.ts`'s identical fix. Previously `renameTaskWithAI` ended
   * root-level target-resolution protection in a `finally` wrapped around
   * this call's own await, then acquired late per-task admission afterward —
   * a real gap between "resolution protection ends" and "per-task admission
   * begins" that no amount of narrowing the early-admission check (the
   * validation-before-bookkeeping fix) could close, because it was a
   * sequencing defect, not a validation one. `renameTask` (the plain,
   * non-AI rename) has no provider dispatch and passes nothing here.
   */
  onResolvedCandidate?: ResolveTaskOptions["onResolvedCandidate"]
) {
  if (arg instanceof TaskNode) {
    return resolveTaskContext(
      inventory,
      {
        canonicalId: arg.task.canonicalId,
        taskFolderPath: arg.task.folderUri.fsPath,
      },
      { allowPaused: true, onResolvedCandidate }
    );
  }
  return resolveTaskContext(inventory, arg, { allowPaused: true, onResolvedCandidate });
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
  // ── Early work admission (v1 fixes item 1, Part 1a) ───────────────────────
  // Acquire durable admission BEFORE the startup gate, task resolution, and
  // consent gate whenever the target folder is known synchronously from
  // `arg` — mirrors runLintingFixes.ts/draftTaskWithAI.ts. Without this, the
  // real provider dispatch below (`requestAiNameV1`'s `coordinator.executeAction`)
  // ran with no durable evidence this task was doing anything, so a watchdog
  // sweep could pause it mid-run.
  //
  // 2026-09-10 review blockers (new), mirroring runPublishChecks/
  // commitAndPushTask's already-fixed shape:
  //  - a canonicalId-only or true no-arg invocation left NO protection at
  //    all across `resolve()` below. `beginTargetResolutionV1` now stands
  //    the whole sweep pass down across that resolution regardless of
  //    whether an early guess exists.
  //  - `earlyFolderPath` is an UNVALIDATED raw path; if it targets a
  //    different folder than `resolve()` authoritatively resolves to, the
  //    early admission is released and reacquired for the REAL target.
  const taskRootCandidatePathsV1 = resolveTaskRootCandidates().map((candidate) => candidate.absolutePath);
  const targetResolutionHandle = await beginTargetResolutionV1(taskRootCandidatePathsV1);
  // 2026-09-10 review architectural blocker fix (`d620c877...-1`):
  // `earlyFolderPath` is a raw, unvalidated caller-supplied path —
  // `resolve()`'s `resolveTaskContext` call below performs the real
  // ownership/workspace-binding validation, but this early guess runs BEFORE
  // any of that. This route used to gate on a bare
  // `fs.existsSync(earlyFolderPath)`, duplicating (and falling short of) the
  // validation-before-bookkeeping check every other early-admission route
  // already gets from the shared helper — a directory that merely exists but
  // is not a task folder (no `task.md`) would still have had admission
  // bookkeeping created beneath it. Routed through
  // `acquireEarlyWorkAdmissionForCandidatePathV1` like every other route so
  // the same rule (and any future fix to it) applies here too. A synchronous
  // containment check against `resolveTaskRootCandidates()` was tried here
  // and reverted the same round — see `chatWithStage.ts`'s identical call
  // site for why: it depends on `vscode.workspace.workspaceFolders` being
  // configured exactly in step with the caller's raw path, which is not
  // guaranteed, and it silently skipped early admission for legitimate
  // candidates instead of narrowing the gap. This still does not replace the
  // real ownership/workspace-binding validation `resolve()` performs below.
  //
  // 2026-09-11 round (review architectural blocker `d620c877...-1`,
  // narrowed further): passing `taskRootCandidatePathsV1` as
  // `taskRootCandidatePaths` below makes an out-of-root candidate OBSERVABLE
  // (a logged diagnostic, see `isPathOutsideAllTaskRootsV1`) without
  // repeating the reverted gate — admission is still always acquired for a
  // path that looks like a task folder, never left unprotected.
  const earlyFolderPath = extractSynchronousRenameFolderPathV1(arg);
  const early = await acquireEarlyWorkAdmissionForCandidatePathV1({
    candidatePath: earlyFolderPath,
    purpose: "admission",
    commandId: "renameTaskWithAI",
    taskRootCandidatePaths: taskRootCandidatePathsV1,
  });
  if (early && early.outcome !== "acquired") {
    await endTargetResolutionV1(targetResolutionHandle);
    NotificationRouter.showWarning(describeWorkAdmissionRefusalV1(early));
    return;
  }

  let handle: WorkAdmissionHandleV1 | undefined = early?.outcome === "acquired" ? early.handle : undefined;
  let heartbeat = handle ? setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1) : undefined;
  const releaseCurrentAdmissionV1 = async (): Promise<void> => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (handle) {
      const toRelease = handle;
      handle = undefined;
      await toRelease.release();
    }
  };

  // 2026-09-10 review architectural blocker fix (`d620c877...-1`): target-
  // resolution protection must stay live across the ENTIRE resolve() call,
  // not just until it returns — late admission and pause reconciliation now
  // run from `resolveTaskContext`'s `onResolvedCandidate` hook, which fires
  // DURING resolution (after ownership/containment/workspace-binding checks,
  // before the `allowPaused` gate), so there is no longer any window where
  // resolution protection has ended but per-task admission has not yet begun.
  let targetResolutionEnded = false;
  const endTargetResolutionOnceV1 = async (): Promise<void> => {
    if (targetResolutionEnded) {
      return;
    }
    targetResolutionEnded = true;
    await endTargetResolutionV1(targetResolutionHandle);
  };
  let reconcileOutcomeCapturedV1: Awaited<ReturnType<typeof reconcileWatchdogPauseAgainstAdmissionV1>> | undefined;
  let lateAdmissionRefusalV1: Parameters<typeof describeWorkAdmissionRefusalV1>[0] | undefined;

  try {
    // Same activation-barrier contract as renameTask above (plan §1.4).
    await TaskCreationStartupReconcilerV1.waitUntilReady();

    let task: Awaited<ReturnType<typeof resolve>>;
    try {
      task = await resolve(inventory, arg, async (candidate) => {
        // The early guess above can target the wrong task — release it and
        // fall through to the ordinary late-acquisition path below, which
        // acquires for the AUTHORITATIVE, now-validated folder.
        if (handle && handle.taskFolderPath !== candidate.taskFolderPath) {
          await releaseCurrentAdmissionV1();
        }
        if (!handle) {
          const late = await acquireWorkAdmissionV1({
            taskFolderPath: candidate.taskFolderPath,
            purpose: "admission",
            commandId: "renameTaskWithAI",
          });
          if (late.outcome === "acquired") {
            handle = late.handle;
            heartbeat = setInterval(() => void handle!.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
          } else {
            lateAdmissionRefusalV1 = late;
          }
        }
        // Admission is now guaranteed live for this exact target — reverse a
        // watchdog-provenance pause (never a user pause) before any further
        // setup, exactly like runReviewWithAI/runLintingFixes. Only reconcile
        // once admission is confirmed live for this exact target — otherwise
        // a reversed pause would leave the task with nothing actually
        // protecting it.
        if (handle) {
          reconcileOutcomeCapturedV1 = await reconcileWatchdogPauseAgainstAdmissionV1(
            vscode.Uri.file(candidate.taskFolderPath)
          );
        }
      });
    } finally {
      await endTargetResolutionOnceV1();
    }
    if (!task) return;
    if (!handle) {
      NotificationRouter.showWarning(
        lateAdmissionRefusalV1
          ? describeWorkAdmissionRefusalV1(lateAdmissionRefusalV1)
          : "Could not acquire work admission for this task."
      );
      return;
    }
    if (refuseRenameWhileDescStageRuns(task.taskFolderPath)) return;

    // 2026-09-10 review completion blocker (new): the reconciliation result
    // was previously discarded — a genuine `userPaused`/`unreadable` outcome
    // must stop this command, exactly as runPublishChecks/
    // completeCommitAndPushTask already do.
    if (reconcileOutcomeCapturedV1?.outcome === "userPaused" || reconcileOutcomeCapturedV1?.outcome === "unreadable") {
      NotificationRouter.showWarning(
        "Rename Task with AI is only available for tasks that are not paused. Resume the task first."
      );
      return;
    }

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
  } finally {
    await releaseCurrentAdmissionV1();
  }
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
