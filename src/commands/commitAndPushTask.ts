import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import { TASK_FILENAME, STAGE_DISPLAY_NAMES, TaskProgress } from "../types/taskProgress";
import {
  getImplementationSummaryUri,
  isUnusableImplementationSummaryV1,
  resolveImplementationArtifact,
} from "../utils/implementationArtifactResolver";
import { splitSummaryAtEchoV1 } from "../utils/implementationChecklist";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { selectNextTask } from "./markTaskDone";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  CompletionLintResult,
  upsertCompletionChecksReportV1,
} from "../utils/completionLint";
import { runPublishScopeCheck } from "../utils/publishScopeCheck";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { runGitCommand, resolveGitRepo, checkGitPublishReadiness, GitPublishReadiness } from "../utils/gitRepoInfo";
import { refreshStaleReviewBannersForTaskV1 } from "../utils/reviewFreshness";
import { runLintingFixes } from "./runLintingFixes";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
} from "../utils/taskOperations";
import { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME } from "../utils/chatHistoryConstants";
import { isWorkflowPrivatePathV1 } from "../services/workflowPrivacyClassifierV1";
import { isLegacyAiRouteDisabledV0 } from "../services/legacyAiActionSafetyGateV0";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  ensureTaskRunsDirectoryV1,
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { ActionCorrelationV1, allocateHex128IdV1, InteractionIdV1, OperationIdV1 } from "../types/actionCorrelationV1";
import {
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
  invokeLifecycleRowV1,
} from "../actions/productionTaskActionRuntimeV1";
import {
  COMMIT_PUSH_METADATA_ACTION_KEY_V1,
  CommitPushMetadataActionInputV1,
} from "../actions/rows/commitPushMetadataRowV1";
import { NEXT_STAGE_ACTION_KEY_V1 } from "../actions/rows/nextStageRowV1";
import { MARK_TASK_DONE_ACTION_KEY_V1 } from "../actions/rows/markTaskDoneRowV1";
import { COMMIT_PUSH_ACTION_KEY_V1, CommitPushServicesV1 } from "../actions/rows/commitPushRowV1";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";
import { ChatInteractionRefV1, ChatInteractionResumeResultV1, ChatViewProvider } from "../views/chatView";

/**
 * A pending `commitPushMetadata.v1` Chat interaction being explicitly
 * resumed (plan §10.2 point 5). Threaded privately through
 * `reviewCommitPushMessageV1` into `reviewCommitMessage`/`resumeCommitMessage`
 * so the metadata attempt (`coordinator.resumeAction`) runs as part of THIS
 * fresh operation's own token acquisition, index/privacy checks, and lint —
 * never generated ahead of that validation. `onSettled` reports the
 * interaction's terminal settlement (or a failure reason) back to
 * `resumeCommitPushMetadataInteractionV1`'s caller exactly once. Never set by
 * UI surfaces; only that function constructs one.
 */
interface CommitPushMetadataResumeRequestV1 {
  ref: ChatInteractionRefV1;
  resumeIdempotencyId: string;
  onSettled: (result: ChatInteractionResumeResultV1) => void;
}

/**
 * Accepted argument shapes for commitAndPushTask.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
export type CommitAndPushTaskArg =
  | { task?: IncompleteTask; resumeInteraction?: CommitPushMetadataResumeRequestV1 }
  | { canonicalId?: string; taskFolderPath?: string; resumeInteraction?: CommitPushMetadataResumeRequestV1 };

function extractResumeInteraction(
  node: CommitAndPushTaskArg | undefined
): CommitPushMetadataResumeRequestV1 | undefined {
  return node && typeof node === "object" && "resumeInteraction" in node
    ? node.resumeInteraction
    : undefined;
}

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: CommitAndPushTaskArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazily-created singleton output channel used for the full file-list debug
 * surface in the commit-and-push flow. Cleared before each use.
 *
 * Name is pinned: "Ensemble: Commit Preview"
 */
let commitPreviewChannel: vscode.OutputChannel | undefined;
function getCommitPreviewChannel(): vscode.OutputChannel {
  if (!commitPreviewChannel) {
    commitPreviewChannel = vscode.window.createOutputChannel(
      "Ensemble: Commit Preview"
    );
  }
  return commitPreviewChannel;
}

/**
 * Render a repo-relative path for display in modal dialogs and the output
 * channel. Uses JSON string-escaping so quotes, backslashes, tabs, and
 * newlines render losslessly and reversibly.
 *
 * e.g.  src/foo.ts  →  src/foo.ts
 *       a "b".ts    →  "a \"b\".ts"
 */
function renderPath(repoRelativePath: string): string {
  // JSON.stringify adds surrounding quotes and escapes special chars.
  // We only want the escaping, not the outer quotes, unless there are
  // characters that need escaping.
  const json = JSON.stringify(repoRelativePath);
  // If the path contains any character that JSON needed to escape,
  // keep the quoted form; otherwise return the bare path.
  if (json === `"${repoRelativePath}"`) {
    return repoRelativePath;
  }
  return json;
}

/**
 * Check if a file path is inside a folder.
 * Uses proper path boundary checking to avoid false positives.
 * Case normalization is applied on Windows only for drive-letter compatibility.
 */
function isFileInFolder(filePath: string, folderPath: string): boolean {
  // Normalize separators first
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedFolderPath = folderPath.replace(/\\/g, "/");

  // Apply case normalization on Windows only
  const isCaseSensitive = process.platform !== "win32";
  const compareFilePath = isCaseSensitive
    ? normalizedFilePath
    : normalizedFilePath.toLowerCase();
  const compareFolderPath = isCaseSensitive
    ? normalizedFolderPath
    : normalizedFolderPath.toLowerCase();

  // Ensure folder path ends with separator for boundary-safe comparison
  const folderPathWithSeparator = compareFolderPath.endsWith("/")
    ? compareFolderPath
    : compareFolderPath + "/";

  return compareFilePath.startsWith(folderPathWithSeparator) ||
         compareFilePath === compareFolderPath;
}

/**
 * Review the AI-suggested commit message via a modal confirmation dialog —
 * no editor document, no file to save, and no re-triggering the whole
 * command to see it again. "Regenerate" asks for a different message without
 * restarting staging, PR-description generation, or the earlier file-scope
 * confirmation. Nothing is staged, committed, or pushed until the user picks
 * "Commit & Push" here — cancelling (or dismissing the dialog) leaves the
 * working tree and index exactly as they were.
 *
 * Returns a discriminated result rather than a bare `string | undefined` so
 * the caller can settle `reviewCommitPushMessageV1`'s result correctly: metadata
 * generation returning structured questions is not the same event as the
 * user explicitly dismissing the confirmation modal, even though both used
 * to collapse into the same `undefined` — the former needs a `questions`
 * outcome carrying the real question's correlation/interactionId (routed to
 * Chat With AI, resumable), the latter a plain `cancelled` outcome (nothing
 * to resume, the user just said no).
 */
type CommitMessageReviewResultV1 =
  | { kind: "confirmed"; message: string }
  | { kind: "questionsPosted"; interactionId: InteractionIdV1; correlation: ActionCorrelationV1 }
  | { kind: "declined" };

async function reviewCommitMessage(
  repoRoot: string,
  taskFolderUri: vscode.Uri,
  taskName: string,
  scopedFiles: string[],
  runArtifactPaths: string[],
  pushDestination: string,
  workspaceUri: vscode.Uri,
  cancellationToken: vscode.CancellationToken,
  taskStatus: string | undefined,
  chatViewProvider?: ChatViewProvider,
  resumeInteraction?: CommitPushMetadataResumeRequestV1,
  /** See `reviewCommitPushMessageV1`'s `coordinatorOperationId` param — passed straight through. */
  coordinatorOperationId?: OperationIdV1
): Promise<CommitMessageReviewResultV1> {
  const MAX_PREVIEW_FILES = 15;
  const previewFiles = scopedFiles.slice(0, MAX_PREVIEW_FILES);
  const remaining = scopedFiles.length - previewFiles.length;
  const fileList = previewFiles
    .map((f) => {
      const marker = runArtifactPaths.includes(f) ? " ⚠ (run artifact)" : "";
      return `  • ${renderPath(f)}${marker}`;
    })
    .join("\n");
  const moreNote = remaining > 0 ? `\n  … and ${remaining} more file(s)` : "";

  // Plan §10.2 point 4: when metadata generation returns questions, this
  // Commit and Push attempt must end here rather than falling back to a
  // placeholder message the user could unknowingly accept — no modal is
  // shown, the token this attempt holds is released by the caller's
  // outermost finally, and the question itself already reached the user
  // via Chat With AI inside buildCommitMessage.
  //
  // Plan §10.2 point 5: when this attempt was started by an explicit Resume
  // (resumeInteraction set), the FIRST generation call resumes that pending
  // interaction — via coordinator.resumeAction, after this operation's own
  // token acquisition, index/privacy checks, and lint have already run —
  // instead of starting a brand-new attempt from scratch. A resume
  // idempotency ID is single-use, so a later "Regenerate" click (if the
  // resume itself completed) falls back to ordinary fresh generation.
  let resumeAttempted = false;
  const generate = async (): Promise<CommitMessageResultV1> => {
    let result: CommitMessageResultV1;
    if (resumeInteraction && !resumeAttempted) {
      resumeAttempted = true;
      result = await resumeCommitMessage(
        taskFolderUri,
        workspaceUri,
        taskName,
        cancellationToken,
        taskStatus,
        chatViewProvider,
        resumeInteraction,
        coordinatorOperationId
      );
    } else {
      result = await buildCommitMessage(
        repoRoot,
        taskFolderUri,
        workspaceUri,
        taskName,
        scopedFiles,
        cancellationToken,
        chatViewProvider,
        coordinatorOperationId
      );
    }
    if (result.kind === "questionsPosted") {
      NotificationRouter.showWarning(
        "Commit and Push needs more information before it can generate a commit message. " +
          "Answer the question in Chat With AI, then start Commit and Push again."
      );
    }
    return result;
  };

  const generated = await generate();
  if (generated.kind === "questionsPosted") {
    return { kind: "questionsPosted", interactionId: generated.interactionId, correlation: generated.correlation };
  }
  let message = generated.text;
  for (;;) {
    const confirmText =
      `Commit message:\n\n${message}\n\n` +
      `Files (${scopedFiles.length} total):\n${fileList}${moreNote}\n\n` +
      `Destination: ${pushDestination}`;
    const choice = await vscode.window.showInformationMessage(
      confirmText,
      { modal: true },
      "Commit & Push",
      "Regenerate"
    );
    if (choice === "Regenerate") {
      const regenerated = await generate();
      if (regenerated.kind === "questionsPosted") {
        return { kind: "questionsPosted", interactionId: regenerated.interactionId, correlation: regenerated.correlation };
      }
      message = regenerated.text;
      continue;
    }
    if (choice === "Commit & Push") {
      return { kind: "confirmed", message };
    }
    return { kind: "declined" };
  }
}

/**
 * Generate a suggested structured commit message, using whichever model is
 * actually configured for the Publish stage. Copilot models get a direct
 * chat-completion call; CLI providers (Claude Code, Codex, …) have no simple
 * text-completion surface, so they run through the same text-only agentic
 * runner stage chat uses (runner.run to a run-log file, no edit permissions),
 * with the run recorded as a normal Publish-stage run log. Falls back to a
 * deterministic subject only when no model is configured, the resolved
 * runner is unavailable, or the run fails/returns nothing usable. The caller
 * always shows this suggestion to the user for review/edit/accept before it
 * is ever committed.
 */
type CommitMessageResultV1 =
  | { kind: "message"; text: string }
  | { kind: "questionsPosted"; interactionId: InteractionIdV1; correlation: ActionCorrelationV1 };

async function buildCommitMessage(
  repoRoot: string,
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  taskName: string,
  files: string[],
  cancellationToken: vscode.CancellationToken,
  chatViewProvider?: ChatViewProvider,
  /** See `reviewCommitPushMessageV1`'s `coordinatorOperationId` param — passed straight through. */
  coordinatorOperationId?: OperationIdV1
): Promise<CommitMessageResultV1> {
  const fallback = `chore: complete ${taskName} changes for publish`.slice(0, 72);

  if (isLegacyAiRouteDisabledV0("commitPushMetadata.v1")) {
    return { kind: "message", text: fallback };
  }

  let diffText = "";
  try {
    const diff = await runGitCommand(repoRoot, "diff", ["HEAD", "--no-color", "--", ...files]);
    diffText = diff.stdout;
  } catch {
    // diffText stays empty; message generation falls back to the deterministic subject below.
  }

  const commitMessageInstructions =
    "Write a git commit message for the diff below, in standard subject-plus-body form, using the Conventional Commits format:\n" +
    "- Line 1 (subject): must follow `type(scope): summary` (scope is optional — omit the parentheses entirely when there is no clear scope); `type` must be exactly one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert; the summary is imperative mood, describing the feature-level intent or behavior of the change (what it does and why), not abstract planning language; no quotes, no trailing period; the entire subject line (including the type/scope prefix) must be at most 72 characters.\n" +
    "- For a non-trivial change, follow with a blank line and a short body (2-6 plain-text lines, wrapped at ~72 characters) explaining the intent behind the change — what problem it solves or what capability it adds — in terms of behavior, not implementation mechanics.\n" +
    "- Never render the subject or body as a list or enumeration of changed files or filenames — the diff already shows exactly what changed; describe what the change accomplishes instead.\n" +
    "- For a trivial change, return the subject line alone.\n" +
    "Return only the commit message — no markdown fences, no commentary.\n\n";

  const { modelId } = await resolveFreshModelForStage(taskFolderUri, "publish");
  if (!modelId) return { kind: "message", text: fallback };

  try {
    const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
    const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!verifiedBindingId) return { kind: "message", text: fallback };
    // commitPushMetadata.v1 promotes into runs/ through createFileExclusive,
    // which never creates missing parents (see ensureTaskRunsDirectoryV1).
    // A task reaching Publish has effectively always run a stage that
    // created runs/ already, so this has never actually bitten here — but
    // the write has no business depending on that, and the same omission
    // did break Rename Task with AI outright.
    if (!(await ensureTaskRunsDirectoryV1(rootId))) return { kind: "message", text: fallback };

    const chatIdentity = await readChatDocumentIdentityV1(taskFolderUri.fsPath, taskFolderUri.fsPath);
    const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

    const coordinator = createProductionTaskActionCoordinatorV1({
      workspaceCwd: workspaceUri.fsPath,
      resolveStagePrimaryModel: () => ({ modelId, stage: "publish" }),
    });

    const targetLocator = { rootId, relativePath: `runs/commit-metadata-${Date.now()}.json` };
    const validatedInput: CommitPushMetadataActionInputV1 = {
      prompt: commitMessageInstructions + diffText.slice(0, 12000),
      targetLocator,
    };

    const outcome = await coordinator.executeAction({
      actionKey: COMMIT_PUSH_METADATA_ACTION_KEY_V1,
      taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
      taskStatus: "active",
      taskStage: "publish",
      rawInput: validatedInput,
      cancellationToken,
      // Opens a CHILD lease on this same task binding instead of
      // self-deadlocking against commitPush.v1's own held lease (see
      // commitPushRowV1.ts and TaskActionRequestV1.parentOperationId).
      parentOperationId: coordinatorOperationId,
    });

    if (outcome.kind === "completed") {
      const fileStore = getWorkflowFileStoreV1();
      const readResult = await fileStore.readFileBounded(targetLocator, 64 * 1024);
      if (readResult.kind === "ok") {
        const jsonText = readResult.value.bytes.toString("utf8");
        const parsed = JSON.parse(jsonText) as { subject?: string; body?: string };
        if (parsed.subject) {
          const subject = parsed.subject.trim();
          const body = parsed.body ? parsed.body.trim() : "";
          return { kind: "message", text: body ? `${subject}\n\n${body}` : subject };
        }
      }
    } else if (outcome.kind === "questions" && chatViewProvider) {
      // Plan §6.1/§10.2 point 4: structured questions route to Chat With
      // AI, never silently dropped, and this attempt ends here instead of
      // falling back to a placeholder message the caller could commit
      // without realizing clarification was needed. Answering/Resuming in
      // Chat completes a linked replacement operation (resumeSemantics:
      // "replacementOperation") and notifies the user to start a fresh
      // Commit and Push, seeded with the resumed message, once it's ready.
      const orchestrator = getProductionActionConversationOrchestratorV1();
      const record = await orchestrator.getRecord({
        operationId: outcome.correlation.operationId,
        interactionId: outcome.interactionId,
        taskBindingId: outcome.correlation.taskBindingId,
        chatDocumentId: outcome.correlation.chatDocumentId,
        sourceAttemptId: outcome.correlation.attemptId,
      });
      if (record) {
        await chatViewProvider.askInteraction({
          canonicalId: taskFolderUri.fsPath,
          taskFolderPath: taskFolderUri.fsPath,
          stage: record.stage,
          taskName,
          interactionId: record.interactionId,
          operationId: record.correlation.operationId,
          actionKey: record.correlation.actionKey,
          sourceAttemptId: record.correlation.attemptId,
          // safe: this call site only loads a record already known (via a
          // "questions" outcome or an existing unresolved interaction) to
          // carry posted questions — never invocationPending.
          questions: record.questions!,
          binding: {
            taskBindingId: record.correlation.taskBindingId,
            chatDocumentId: record.correlation.chatDocumentId,
          },
        });
      }
      return { kind: "questionsPosted", interactionId: outcome.interactionId, correlation: outcome.correlation };
    }
  } catch {
    // Any failure resolving/parsing the coordinator result falls back to the deterministic subject below.
  }
  return { kind: "message", text: fallback };
}

/**
 * Resume a pending `commitPushMetadata.v1` Chat interaction as part of THIS
 * (already token-acquired, already index/lint-validated) Commit and Push
 * attempt, instead of generating fresh content. Calls `resumeInteraction`'s
 * `onSettled` exactly once, on every path, so the caller that kicked off
 * this whole attempt (`resumeCommitPushMetadataInteractionV1`) always learns
 * the outcome even when this attempt goes on to fail, get cancelled, or have
 * its result declined in the modal preview.
 */
async function resumeCommitMessage(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  taskName: string,
  cancellationToken: vscode.CancellationToken,
  taskStatus: string | undefined,
  chatViewProvider: ChatViewProvider | undefined,
  resumeInteraction: CommitPushMetadataResumeRequestV1,
  /** See `reviewCommitPushMessageV1`'s `coordinatorOperationId` param — passed straight through. */
  coordinatorOperationId?: OperationIdV1
): Promise<CommitMessageResultV1> {
  const fallback = `chore: complete ${taskName} changes for publish`.slice(0, 72);
  const { ref, resumeIdempotencyId, onSettled } = resumeInteraction;

  const model = await resolveFreshModelForStage(taskFolderUri, "publish");
  if (!model.modelId) {
    onSettled({ ok: false, reason: "no model is configured for publish stage" });
    return { kind: "message", text: fallback };
  }
  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: "publish" }),
  });
  const orchestrator = getProductionActionConversationOrchestratorV1();

  const interactionRef = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: taskStatus ?? "active",
    taskStage: "publish",
    resumeIdempotencyId,
    cancellationToken,
    // Same nested-lease reasoning as buildCommitMessage's executeAction call:
    // this fresh commitPush.v1 invocation's own operationId, so this nested
    // commitPushMetadata.v1 Resume opens a CHILD lease instead of
    // self-deadlocking against the lease this row's own execute holds.
    parentOperationId: coordinatorOperationId,
  });

  if (outcome.kind === "questions" && chatViewProvider) {
    const record = await orchestrator.getRecord(interactionRef);
    if (record) {
      await chatViewProvider.askInteraction({
        canonicalId: taskFolderUri.fsPath,
        taskFolderPath: taskFolderUri.fsPath,
        stage: record.stage,
        taskName,
        interactionId: record.interactionId,
        operationId: record.correlation.operationId,
        actionKey: record.correlation.actionKey,
        sourceAttemptId: record.correlation.attemptId,
        // safe: see the other askInteraction call site's comment above.
        questions: record.questions!,
        binding: {
          taskBindingId: record.correlation.taskBindingId,
          chatDocumentId: record.correlation.chatDocumentId,
        },
      });
    }
  }

  const after = await orchestrator.loadInteraction(interactionRef);
  const settlement =
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" || after.record.settlement === "supersededByReplacementOperation")
      ? after.record.settlement
      : undefined;

  if (settlement === undefined) {
    onSettled({ ok: false, reason: "Resume failed to settle the interaction" });
    return outcome.kind === "questions"
      ? { kind: "questionsPosted", interactionId: outcome.interactionId, correlation: outcome.correlation }
      : { kind: "message", text: fallback };
  }
  onSettled({ ok: true, settlement });

  if (outcome.kind === "questions") {
    return { kind: "questionsPosted", interactionId: outcome.interactionId, correlation: outcome.correlation };
  }

  if (outcome.kind === "completed" && after.kind === "ok") {
    try {
      const snapshot = JSON.parse(after.record.inputSnapshot.canonicalJson) as {
        targetLocator?: { rootId: string; relativePath: string };
      };
      if (snapshot.targetLocator) {
        const fileStore = getWorkflowFileStoreV1();
        const readResult = await fileStore.readFileBounded(snapshot.targetLocator, 64 * 1024);
        if (readResult.kind === "ok") {
          const parsed = JSON.parse(readResult.value.bytes.toString("utf8")) as {
            subject?: string;
            body?: string;
          };
          if (parsed.subject) {
            const subject = parsed.subject.trim();
            const body = parsed.body ? parsed.body.trim() : "";
            return { kind: "message", text: body ? `${subject}\n\n${body}` : subject };
          }
        }
      }
    } catch {
      // Falls through to the deterministic fallback below.
    }
  }
  return { kind: "message", text: fallback };
}

/**
 * Explicit Resume for a `commitPushMetadata.v1` question (plan §10.2 point
 * 5). This action's row declares `resumeSemantics: "replacementOperation"`
 * (its process-global token was released when the question was first
 * posted, and there is no live modal to feed a message into), so Resume
 * must start a genuinely fresh, linked PUBLIC Commit and Push operation —
 * its own token acquisition, index/privacy checks, and lint — and only run
 * the metadata attempt itself once that validation has passed, inside that
 * fresh operation's own `reviewCommitMessage` step. This function is a thin
 * wrapper around the public `commitAndPushTask` entry point: it never
 * generates metadata ahead of time and never hands off to a separate,
 * later-clicked button.
 */
export async function resumeCommitPushMetadataInteractionV1(
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  currentTaskStore?: CurrentTaskStore,
  extensionContext?: vscode.ExtensionContext
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }

  let settled: ChatInteractionResumeResultV1 | undefined;
  const resumeInteraction: CommitPushMetadataResumeRequestV1 = {
    ref,
    resumeIdempotencyId,
    onSettled: (result) => {
      settled = result;
    },
  };

  const entryOutcome = await commitAndPushTask(
    inventory,
    { taskFolderPath: ownedTask.taskFolderPath, resumeInteraction },
    currentTaskStore,
    undefined,
    extensionContext,
    chatViewProvider
  );

  if (settled) {
    return settled;
  }
  if (entryOutcome && entryOutcome.kind === "duplicateRejected") {
    return {
      ok: false,
      reason: "Commit and Push is already in progress. Please wait for it to finish, then resume again.",
    };
  }
  return {
    ok: false,
    reason: "Commit and Push ended before the metadata attempt could resume. Please try again.",
  };
}

/**
 * Check if there are any changes to commit (optionally scoped to a folder).
 */
async function hasChangesToCommit(
  repoRoot: string,
  scopePath?: string
): Promise<boolean> {
  try {
    const args = ["--porcelain"];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const { stdout } = await runGitCommand(repoRoot, "status", args);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** A single change record from `git status --porcelain=v2 -z`. */
interface PorcelainV2Entry {
  status: string;
  /** Current (destination) path. For renames/copies this is the new path. */
  path: string;
  /** Original path, present only for rename/copy entries. */
  origPath?: string;
}

/**
 * Parse git status --porcelain=v2 -z --untracked-files=all output.
 *
 * Porcelain v2 reports rename/copy changes as a single atomic record
 * (`2 ...`) carrying both the destination path and, as the following
 * NUL-delimited field, the original path — unlike v1, which reports the two
 * endpoints as independent tokens with no structural link between them. That
 * distinction matters here: callers decide inclusion (task-folder scoping,
 * run-artifact exclusion) per record, and a rename must be kept as one unit
 * so both endpoints are staged together rather than a rename being silently
 * split into an orphaned delete on one side of a scope boundary.
 *
 * Record shapes (fields are space-separated; the -z format still uses NUL
 * only to separate whole records, and — for renames only — to separate the
 * trailing origPath from its record):
 *   1 XY sub mH mI mW hH hI path                  (ordinary changed entry)
 *   2 XY sub mH mI mW hH hI X score path\0origPath (rename or copy)
 *   u XY sub m1 m2 m3 mW h1 h2 h3 path             (unmerged)
 *   ? path                                        (untracked)
 *   ! path                                         (ignored)
 */
export function parsePorcelainV2Z(output: string): PorcelainV2Entry[] {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const results: PorcelainV2Entry[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    i++;

    if (token.startsWith("1 ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(8).join(" ");
      if (filePath) results.push({ status, path: filePath });
    } else if (token.startsWith("2 ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(9).join(" ");
      const origPath = i < tokens.length ? tokens[i] : undefined;
      if (origPath !== undefined) i++;
      if (filePath) results.push({ status, path: filePath, origPath });
    } else if (token.startsWith("u ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(10).join(" ");
      if (filePath) results.push({ status, path: filePath });
    } else if (token.startsWith("? ")) {
      results.push({ status: "??", path: token.slice(2) });
    } else if (token.startsWith("! ")) {
      results.push({ status: "!!", path: token.slice(2) });
    }
  }

  return results;
}

/**
 * Chat-transcript basenames (chatHistoryStore.ts). Under the transcript
 * staging policy (Option A — never-stage, non-overridable), these must never
 * be staged by Commit and Push through any path: they are plaintext
 * prompt/response content, unlike run artifacts which can be opted back in.
 */
const SENSITIVE_TASK_FILE_BASENAMES = new Set([
  CHAT_HISTORY_FILENAME,
  CHAT_HISTORY_CORRUPT_FILENAME,
]);

/**
 * Repo-relative path of the task ROOT (the parent directory holding every
 * task folder, e.g. "plans"), not just the current task's own folder. Chat
 * transcripts must be excluded for every task under this root — not only
 * the current one — since default-mode staging would otherwise sweep a
 * sibling task's transcript in as an ordinary "source change" outside this
 * task's own folder. Returns undefined when the task root can't be
 * expressed as a repo-relative path (e.g. configured outside the repo), in
 * which case no entry can match it and sensitivity filtering is a no-op.
 */
function taskRootRelativeFor(repoRoot: string, taskFolderPath: string): string | undefined {
  const taskRoot = path.resolve(taskFolderPath, "..");
  const relative = path.relative(repoRoot, taskRoot).replace(/\\/g, "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function isUnderTaskRoot(entryPath: string, taskRootRelative: string): boolean {
  return (
    taskRootRelative === "" ||
    entryPath === taskRootRelative ||
    entryPath.startsWith(taskRootRelative + "/")
  );
}

/**
 * True when `entryPath` is a chat-transcript file (or its quarantine copy)
 * for some task under `taskRootRelative`. Scoped to the task root so a file
 * that happens to share a transcript's basename elsewhere in the repo is
 * never matched.
 */
function isSensitiveTaskFile(entryPath: string, taskRootRelative: string | undefined): boolean {
  if (taskRootRelative === undefined) return false;
  if (!isUnderTaskRoot(entryPath, taskRootRelative)) return false;
  return SENSITIVE_TASK_FILE_BASENAMES.has(path.basename(entryPath));
}

/**
 * Final gate: strips chat-transcript files — this task's or any sibling
 * task's — from a staging list immediately before it is shown to the user
 * or staged with `git add`. Re-applied here regardless of which path above
 * built `scopedFiles`, catching any entry whose OWN path matches a
 * transcript basename.
 *
 * This is necessarily a basename check over a flat path list, so it cannot
 * by itself catch a transcript renamed to an innocuous destination path
 * (the rename's origin information isn't in this list — it was already
 * discarded when `scopedFiles` was flattened). That case is caught earlier,
 * in `getChangedFiles`, which still has each rename/copy record's origin
 * path available and treats the whole record as sensitive if either
 * endpoint is: see the "destSensitive || origSensitive" check there. Both
 * layers are needed; this one alone is not sufficient for renames.
 */
export function stripSensitiveTaskFiles(
  scopedFiles: string[],
  repoRoot: string,
  taskFolderPath: string
): string[] {
  const taskRootRelative = taskRootRelativeFor(repoRoot, taskFolderPath);
  return scopedFiles.filter((f) => {
    // §2.4 rule 5: private/workflow-control paths (the §2.2 classifier's
    // shape contract — locks, creation-intents, sentinels, atomic temps,
    // chat transcripts by basename, workflow-runtime families) are never
    // staged by this command through any list-building path.
    if (isWorkflowPrivatePathV1(f)) {
      return false;
    }
    return !isSensitiveTaskFile(f, taskRootRelative);
  });
}

/**
 * Read the CURRENT git index (§10.2 step 1 / §2.4 rule 4): every porcelain-v2
 * record whose staged (X) column reports index content — ordinary staged
 * changes, staged renames/copies (both endpoints), staged deletions, and
 * unmerged entries (whose index slots hold conflict content). Untracked and
 * ignored records carry no index content and are excluded.
 */
export async function collectStagedIndexRecordsV1(repoRoot: string): Promise<PorcelainV2Entry[]> {
  // `--untracked-files=no`: untracked entries carry no INDEX content, and
  // enumerating them is unbounded work on large repos (resolveGitRepo can
  // legitimately resolve to a huge ancestor repository) — the index gate
  // needs exactly the staged records.
  const { stdout } = await runGitCommand(repoRoot, "status", [
    "--porcelain=v2",
    "-z",
    "--untracked-files=no",
  ]);
  return parsePorcelainV2Z(stdout).filter((entry) => {
    const stagedColumn = entry.status.charAt(0);
    return stagedColumn !== "" && stagedColumn !== "." && stagedColumn !== "?" && stagedColumn !== "!";
  });
}

/**
 * §2.4's index-content rule over already-staged records: a record is
 * forbidden when EITHER endpoint (destination, or a rename/copy origin) is a
 * private/workflow-control path per the §2.2 classifier, or a chat
 * transcript under the task root. Rename tainting must use both endpoints —
 * a transcript `git mv`'d to an innocuous destination still carries its
 * content into the index. Callers BLOCK on any hit (§2.4 rule 4: content
 * someone already put in the index is refused, never silently dropped) —
 * contrast with `getChangedFiles`, whose exclusions merely OMIT paths from
 * the staging proposals this command builds itself.
 */
export function findForbiddenStagedRecordsV1(
  entries: readonly PorcelainV2Entry[],
  repoRoot: string,
  taskFolderPath: string
): PorcelainV2Entry[] {
  const taskRootRelative = taskRootRelativeFor(repoRoot, taskFolderPath);
  return entries.filter(
    (entry) =>
      isWorkflowPrivatePathV1(entry.path) ||
      (entry.origPath !== undefined && isWorkflowPrivatePathV1(entry.origPath)) ||
      isSensitiveTaskFile(entry.path, taskRootRelative) ||
      (entry.origPath !== undefined && isSensitiveTaskFile(entry.origPath, taskRootRelative))
  );
}

/**
 * Get the list of changed files scoped to the implemented source changes
 * (default mode: everything OUTSIDE the task folder) or the entire repo,
 * task folder included (include-task-folder mode).
 *
 * Returns:
 *  - scopedFiles: files to be staged and shown in the preview
 *  - repoFiles:   all changed files in the repo (for display of what's excluded)
 *  - runArtifactPaths: run-artifact files under the task folder, excluded by
 *    default but eligible for the "Include Run Artifacts" override
 *  - sensitiveFilePaths: chat-transcript files, excluded in EVERY mode
 *    (including includeTaskFolder) — never eligible for that override. A
 *    rename/copy record is classified here using BOTH its endpoints (see the
 *    "destSensitive || origSensitive" check below), since this is the one
 *    place where a rename's origin path is still available; the later
 *    `stripSensitiveTaskFiles` gate only sees a flattened path list.
 */
export async function getChangedFiles(
  repoRoot: string,
  taskFolderPath: string,
  includeTaskFolder: boolean
): Promise<{
  scopedFiles: string[];
  repoFiles: string[];
  runArtifactPaths: string[];
  sensitiveFilePaths: string[];
  /**
   * Private/workflow-control paths per the §2.2 classifier
   * (`isWorkflowPrivatePathV1`) — locks, creation-intents records, sentinels,
   * atomic-temp debris, workflow-runtime families. Excluded (omitted) from
   * every staging proposal in every mode (§2.4 rule 5), like
   * `sensitiveFilePaths` but for control records rather than transcripts;
   * surfaced to the user so an unexpectedly shrinking commit is explainable.
   */
  excludedControlPaths: string[];
}> {
  try {
    const { stdout } = await runGitCommand(repoRoot, "status", [
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);

    const allEntries = parsePorcelainV2Z(stdout);

    // Compute the task folder relative to the repo root
    const taskRelative = path
      .relative(repoRoot, taskFolderPath)
      .replace(/\\/g, "/");
    const taskRootRelative = taskRootRelativeFor(repoRoot, taskFolderPath);

    // Identify run-artifact paths (runs/ and context-pack.md under the task folder)
    const runArtifactPaths: string[] = [];
    const sensitiveFilePaths: string[] = [];
    const excludedControlPaths: string[] = [];
    const scopedFiles: string[] = [];
    const repoFiles: string[] = [];

    for (const entry of allEntries) {
      // A rename/copy is one logical change with two path endpoints. Scope
      // and count it as a single unit anchored on the destination path so it
      // can never be split across the task-folder boundary — e.g. only the
      // deletion half staged while the addition half is excluded (or vice
      // versa), which would corrupt the rename into an orphaned add/delete.
      repoFiles.push(entry.path);

      // Chat transcripts are excluded in every mode, for every task under
      // the task root — never included by includeTaskFolder, and never
      // eligible for the run-artifact override below. Checked against BOTH
      // endpoints of a rename/copy: content survives a `git mv` to an
      // innocuous-looking destination path (e.g. moving chat-v1.json out of
      // the task root, or to a non-transcript basename inside it), so
      // checking only entry.path would let transcript content reach staging
      // under a new name. Either endpoint being sensitive taints the whole
      // record — neither endpoint may enter scopedFiles/runArtifactPaths.
      if (
        isSensitiveTaskFile(entry.path, taskRootRelative) ||
        (entry.origPath !== undefined && isSensitiveTaskFile(entry.origPath, taskRootRelative))
      ) {
        sensitiveFilePaths.push(entry.path);
        if (entry.origPath !== undefined && entry.origPath !== entry.path) {
          sensitiveFilePaths.push(entry.origPath);
        }
        continue;
      }

      // §2.4 rule 5: private/workflow-control paths (the §2.2 classifier)
      // are omitted from every proposal in every mode. Same either-endpoint
      // tainting as transcripts above — a control record renamed to an
      // innocuous destination still carries its content. Omit (not block):
      // these proposals are built by this command itself, and stray control
      // debris (a crashed .ensemble-*.lock, an atomic-temp leftover) must
      // not dead-end publishing — blocking is reserved for content already
      // in the INDEX (findForbiddenStagedRecordsV1) and post-add divergence.
      if (
        isWorkflowPrivatePathV1(entry.path) ||
        (entry.origPath !== undefined && isWorkflowPrivatePathV1(entry.origPath))
      ) {
        excludedControlPaths.push(entry.path);
        if (entry.origPath !== undefined && entry.origPath !== entry.path) {
          excludedControlPaths.push(entry.origPath);
        }
        continue;
      }

      // Determine if this file is inside the task folder
      const isInTaskFolder =
        entry.path === taskRelative ||
        entry.path.startsWith(taskRelative + "/");

      // Default mode stages the implemented source — everything OUTSIDE the
      // task folder. The task folder holds planning metadata, not the code
      // changes, so it is excluded unless the caller opts in.
      if (!includeTaskFolder && isInTaskFolder) {
        continue;
      }

      // Check for run artifacts (runs/ directory and context-pack.md)
      const isRunArtifact =
        entry.path.startsWith(taskRelative + "/runs/") ||
        entry.path === taskRelative + "/context-pack.md" ||
        entry.path === taskRelative + "/pr-description.md";

      if (isRunArtifact) {
        runArtifactPaths.push(entry.path);
        // Run artifacts are always excluded from the staged set here. The
        // "Include Run Artifacts" flow opts in separately by re-fetching and
        // filtering, rather than via this function.
        continue;
      }

      scopedFiles.push(entry.path);
      // Stage both rename endpoints together: `git add` on the destination
      // alone would record only an addition, leaving the vacated origPath
      // untracked-removed rather than committed as part of the same rename.
      if (entry.origPath) {
        scopedFiles.push(entry.origPath);
      }
    }

    return {
      scopedFiles: scopedFiles.filter((f) => f.length > 0),
      repoFiles: repoFiles.filter((f) => f.length > 0),
      runArtifactPaths,
      sensitiveFilePaths,
      excludedControlPaths,
    };
  } catch {
    return {
      scopedFiles: [],
      repoFiles: [],
      runArtifactPaths: [],
      sensitiveFilePaths: [],
      excludedControlPaths: [],
    };
  }
}

/**
 * Extract first H1 from markdown content
 */
function extractFirstH1(content: string): string | undefined {
  const match = /^# (.+)$/m.exec(content);
  return match?.[1]?.trim();
}

// The stage-AI drafting placeholder shown in a blank task.md before the user
// (or AI) fills in real content. If a task somehow reaches Publish with this
// still as its H1, it must never surface as if it were a real task title.
const TASK_DESCRIPTION_PLACEHOLDER =
  /^describe the work you want to do here/i;

/**
 * Resolve a human-readable task title for user-facing text (e.g. the
 * deterministic commit-message fallback), preferring task.md's H1 over the
 * raw folder slug so that title reads as the feature-level intent of the
 * task rather than an internal identifier. Falls back to `folderName` when
 * task.md is missing, has no H1, or its H1 is still the unfilled drafting
 * placeholder.
 *
 * Normal AI drafting (`draftTaskWithAI.ts`) never emits an H1 into task.md —
 * it stores its generated summary as `progress.displayName` instead (with
 * `nameIsDefault` flipped to `false` once that summary replaces the
 * generated folder-name label). So the H1 check alone misses that case and
 * falls through to the raw folder slug (e.g. "task_1"). Prefer the H1 when
 * present, otherwise fall back to `progress.displayName` when it has been
 * established as a real (non-default) label, and only then to `folderName`.
 */
async function resolveTaskTitle(
  taskFolderUri: vscode.Uri,
  folderName: string,
  progress?: Pick<TaskProgress, "displayName" | "nameIsDefault">
): Promise<string> {
  try {
    const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
    const taskBytes = await vscode.workspace.fs.readFile(taskFileUri);
    const taskContent = new TextDecoder().decode(taskBytes);
    const h1 = extractFirstH1(taskContent);
    if (h1 && !TASK_DESCRIPTION_PLACEHOLDER.test(h1)) {
      return h1;
    }
  } catch {
    // No task.md or unreadable — fall through to the displayName/folder name.
  }
  const displayName = progress?.displayName?.trim();
  if (
    displayName &&
    progress?.nameIsDefault !== true &&
    !TASK_DESCRIPTION_PLACEHOLDER.test(displayName)
  ) {
    return displayName;
  }
  return folderName;
}

/**
 * Extract first non-empty paragraph from a section
 */
function extractFirstParagraph(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let paragraph = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      paragraph += (paragraph ? " " : "") + trimmed;
    } else if (paragraph.length > 0) {
      break;
    }
  }
  return paragraph.length > 0 ? paragraph : undefined;
}

/**
 * Extract section body from markdown content
 */
function extractSectionBody(
  content: string,
  sectionHeader: string
): string | undefined {
  const headerIndex = content.indexOf(sectionHeader);
  if (headerIndex === -1) {
    return undefined;
  }

  const afterHeader = content.slice(headerIndex + sectionHeader.length);
  const nextHeaderMatch = /^## /m.exec(afterHeader);
  const sectionEnd = nextHeaderMatch
    ? headerIndex + sectionHeader.length + nextHeaderMatch.index
    : content.length;

  return content
    .slice(headerIndex + sectionHeader.length, sectionEnd)
    .trim();
}

/**
 * Label prepended to the PR "Testing" section when its text came from the
 * low-level plan's own `## Testing` section rather than from anything the run
 * reported about itself. Kept as a named constant so the label's exact
 * wording is pinnable in a test and greppable at the decision site.
 *
 * @internal exported for testing
 */
export const PR_TESTING_PLANNED_FALLBACK_LABEL_V1 =
  "Planned testing (from the plan — not verified by this run):";

/**
 * Generate PR description from task artifacts
 *
 * @internal exported for testing
 */
export async function generatePRDescription(
  taskFolderPath: string,
  folderName: string,
  changedFiles: string[]
): Promise<string> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  // A PR describes what the run DID, and that now lives in impl-summary.md —
  // plan-final.md keeps the checklist of what was planned. Reading only the
  // plan of record here wrote PR text from planned prose instead of delivered
  // work. A summary stamped unusable is skipped, so the fallback still
  // describes something real.
  const readImplementationNotes = async (): Promise<string | undefined> => {
    for (const uri of [
      getImplementationSummaryUri(taskFolderUri),
      implementationArtifact.uri,
    ]) {
      try {
        const text = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(uri)
        );
        if (text.trim().length > 0 && !isUnusableImplementationSummaryV1(text)) {
          return text;
        }
      } catch {
        // Missing or unreadable — try the next source.
      }
    }
    return undefined;
  };
  const implementationNotes = await readImplementationNotes();
  // A checklist-backed summary opens with an echo of plan-final.md, and
  // create-implementation.md guarantees that echoed document has its OWN
  // "## Verification" section. extractSectionBody takes the FIRST match, so
  // section lookups must run against the run-owned region or the PR reports
  // the plan's intended verification steps instead of what the round verified.
  // No fallback to the whole document when the split finds no run-owned
  // region. `own` is empty precisely when the artifact has no summary of its
  // own — an echo-only response, or plan-final.md standing in because the task
  // predates impl-summary.md — and falling back put the echoed plan's sections
  // straight back in view, so the PR reported PLANNED verification as
  // delivered work. That is the identical failure that retired the overview
  // extraction (see the note at the top of this function): a plain
  // "not available" beats a confident lie about what was tested.
  const runOwnedNotes = implementationNotes
    ? splitSummaryAtEchoV1(implementationNotes).own
    : undefined;
  // NO overview extraction. Three attempts at recovering the run's one-or-two
  // sentence lead-in from the response all failed the same way: filtering
  // checkbox lines left the `<!-- Generated by ... -->` signature as the first
  // paragraph; a reverse prose-block scan returned the echoed plan's goal
  // statement; tracking headings as boundaries still let the echoed
  // `## Verification` section's prose through. Each fix moved the failure
  // without removing it, because the job has no reliable signal — a response
  // that omits the overview is indistinguishable from one whose overview is
  // ordinary prose sitting among the plan's own.
  //
  // Every version got this wrong in the same direction: describing PLANNED
  // verification as delivered work. `## Files Changed` is written by the run,
  // about the run, and always real — so the PR is built from that instead.

  // Read task.md
  let taskTitle = folderName;
  let summary = "No summary provided.";
  try {
    const taskBytes = await vscode.workspace.fs.readFile(taskFileUri);
    const taskContent = new TextDecoder().decode(taskBytes);
    taskTitle = extractFirstH1(taskContent) ?? folderName;

    const taskDescBody =
      extractSectionBody(taskContent, "## Task Description");
    if (taskDescBody) {
      summary = extractFirstParagraph(taskDescBody) ?? summary;
    } else {
      const draftBody = extractSectionBody(taskContent, "## Draft with AI");
      if (draftBody) {
        summary = extractFirstParagraph(draftBody) ?? summary;
      }
    }
  } catch {
    // ignore
  }

  // Implementation summary
  let implementationSummary = "Implementation summary not available.";
  if (implementationNotes) {
    // "## Files Changed" is what a run summary actually emits; "##
    // Implementation" is the older shape a plan-of-record document used.
    // Both are sections the run wrote about itself, so neither can report the
    // plan's intentions as delivered work.
    // Run-owned region only — `?? implementationNotes` here was the same
    // whole-document fallback by another name, and it reached the plan's
    // sections whenever the split found no summary of its own.
    const implSection =
      extractSectionBody(runOwnedNotes ?? "", "## Implementation") ??
      extractSectionBody(runOwnedNotes ?? "", "## Files Changed");
    if (implSection) {
      implementationSummary = extractFirstParagraph(implSection) ?? implSection;
    }
  }

  // Testing summary
  let testingSummary = "Testing summary not available.";
  // Run-owned region: the echoed checklist carries the PLAN's Verification
  // section, and a first-match lookup would report planned steps as if the
  // round had run them.
  const testingSection = runOwnedNotes
    ? extractSectionBody(runOwnedNotes, "## Testing") ??
      extractSectionBody(runOwnedNotes, "## Verification")
    : undefined;
  if (testingSection) {
    testingSummary = extractFirstParagraph(testingSection) ?? testingSection;
  } else {
    try {
      const lowLevelBytes = await vscode.workspace.fs.readFile(lowLevelPlanUri);
      const lowLevelContent = new TextDecoder().decode(lowLevelBytes);
      const testingSection = extractSectionBody(
        lowLevelContent,
        "## Testing"
      );
      if (testingSection) {
        // This fallback reads the low-level PLAN's own `## Testing` section —
        // planned testing, written before any run existed. Emitting it
        // unlabeled presented the plan's intentions under the PR's "Testing"
        // heading as if the run had executed them, the same misrepresentation
        // that retired the overview extraction above. The fallback itself is
        // kept (a PR with no run-owned testing section is still better
        // pointing at the plan than saying nothing), but the label travels
        // with the text so the reader can tell planned from delivered.
        testingSummary =
          `${PR_TESTING_PLANNED_FALLBACK_LABEL_V1}\n` +
          (extractFirstParagraph(testingSection) ?? testingSection);
      }
    } catch {
      // ignore
    }
  }

  const parts: string[] = [];
  parts.push(`# ${taskTitle}`);
  parts.push("");
  parts.push("## Summary");
  parts.push("");
  parts.push(summary);
  parts.push("");
  parts.push("## Implementation");
  parts.push("");
  parts.push(implementationSummary);
  parts.push("");
  parts.push("## Testing");
  parts.push("");
  parts.push(testingSummary);
  parts.push("");
  parts.push("## Changed Files");
  parts.push("");
  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      parts.push(`- ${file}`);
    }
  } else {
    parts.push("- (no changes)");
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Save relevant dirty documents before git operations.
 * In default (source-only) mode, only saves documents outside the task
 * folder plus the always-relevant task/plan artifacts. In
 * include-task-folder mode, saves any dirty document in the repo.
 */
async function saveDirtyDocuments(
  taskFolderPath: string,
  repoRoot: string,
  includeTaskFolder: boolean
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  const relevantPaths = new Set([
    taskFileUri.fsPath,
    implementationArtifact.uri.fsPath,
    // The run summary is a task artifact like the others: a round opens it in
    // an editor, so unsaved edits to it must be flushed before the commit that
    // is supposed to include them.
    getImplementationSummaryUri(taskFolderUri).fsPath,
    lowLevelPlanUri.fsPath,
  ]);

  const dirtyDocs = vscode.workspace.textDocuments.filter((doc) => {
    if (!doc.isDirty) {
      return false;
    }
    if (relevantPaths.has(doc.uri.fsPath)) {
      return true;
    }
    // In default (source-only) mode: only save files outside the task folder
    if (!includeTaskFolder) {
      return (
        isFileInFolder(doc.uri.fsPath, repoRoot) &&
        !isFileInFolder(doc.uri.fsPath, taskFolderPath)
      );
    }
    // In include-task-folder mode: save any dirty file in the repo
    return isFileInFolder(doc.uri.fsPath, repoRoot);
  });

  for (const doc of dirtyDocs) {
    const saved = await doc.save();
    if (!saved || doc.isDirty) {
      return {
        ok: false,
        detail: `Could not save ${path.basename(doc.uri.fsPath)}. Please save all files before committing.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Stable outcome returned when the process-global Commit/Push guard (below)
 * rejects a duplicate invocation. Modeled after the coordinator outcome
 * union's `duplicateRejected` shape (plan §3.7 / §10.1) without pulling in
 * the rest of that union, which nothing else in the codebase produces yet.
 */
export interface CommitPushDuplicateRejectedV1 {
  readonly kind: "duplicateRejected";
  readonly code: "operationAlreadyRunning";
}

/**
 * Process-global (NOT per-task) nonblocking token guarding the two public
 * Commit/Push entry points end to end. Acquired as the very first statement
 * in each public callback — before argument normalization, task resolution,
 * or any other read — so a duplicate click is rejected before touching the
 * task, workspace, lint, prompts, or git index, regardless of which task it
 * targets. Deliberately global rather than keyed per task: both commands
 * stage/commit/push against one repository working tree and index at a
 * time, so an overlapping run against a *different* task is exactly as
 * unsafe as a second click on the same one.
 *
 * This is separate from — and sits in front of — the per-task exclusive
 * tracked-operation lock `commitPushRowV1.ts`'s `executeCommitPushV1` opens
 * directly (via `taskOperations.begin`/`taskOperations.end`), which continues
 * to guard against a *different* operation (e.g. a stage AI action) running
 * concurrently on the same task, and supplies the Notifications-row/cancel/
 * nesting plumbing the flow relies on.
 */
let commitPushTokenHeld = false;

function acquireCommitPushToken(): boolean {
  if (commitPushTokenHeld) {
    return false;
  }
  commitPushTokenHeld = true;
  return true;
}

function releaseCommitPushToken(): void {
  commitPushTokenHeld = false;
}

function rejectDuplicateCommitPush(): CommitPushDuplicateRejectedV1 {
  NotificationRouter.showInformation(
    "Commit and Push is already in progress. Please wait for it to finish."
  );
  return { kind: "duplicateRejected", code: "operationAlreadyRunning" };
}

/**
 * Commit and push the current task — the coordinator-owned sequence of
 * steps below (plan §3.8/§10.1/§10.2), containing all of the actual
 * behavior. None of these steps acquire or release the process-global token
 * themselves: only the two exported entry points below do that, so a caller
 * that already holds the token (the composite flow in
 * `completeCommitAndPushTask`) can invoke `invokeCommitPushRowV1` directly,
 * borrowing the held token, without a self-rejection.
 *
 * ⚠️ RISK NOTICE (IMPORTANT — READ BEFORE MODIFYING):
 *
 * Default mode: stages the implemented source changes — every changed file
 * OUTSIDE the task folder. The task folder holds planning metadata
 * (task.md, plan.md, run logs), not the code changes being shipped, so it
 * is excluded from the default staged set.
 * Include-task-folder mode: also stages changes inside the task folder
 * (requires explicit opt-in), still excluding run artifacts unless the
 * user separately opts into those too.
 *
 * Run artifacts (runs/, context-pack.md) contain full AI prompts and
 * file contents. They are excluded from the default staged set.
 *
 * This command does NOT roll back local commits if push fails.
 * If push fails, the local commit is kept and the user is shown how to undo.
 *
 * See DISCLAIMER.md §4 for the full risk disclosure.
 */
/**
 * The specific stopping point behind a `{ kind: "notCompleted" }` result
 * (plan §3.8's "the coordinator owns ... detailed outcomes"). Every
 * non-success exit from the coordinator-native steps below (staging-scope
 * resolution, confirmation, save, PR description, commit-message review,
 * staging/commit, and push) sets one of these — instead of leaving
 * `commitPush.v1` (`commitPushRowV1.ts`) unable to distinguish
 * "the user declined a prompt" from "git rejected the push" beyond a single
 * generic `commitPush.notCompleted` code. The user-facing explanation for
 * each reason is shown exactly once, from `commitPushRowV1.ts`'s
 * `presentCommitPushCoreResultV1` (plan §3.8: "the coordinator owns ...
 * presentation") — none of the coordinator-native step functions below show
 * their own notification for a reason they set.
 */
export type CommitAndPushNotCompletedReasonV1 =
  | "ineligibleStage"
  | "noGitRepository"
  | "gitIndexReadFailed"
  | "privateContentStaged"
  | "gitNotReady"
  | "checksDeclined"
  | "fixWithAiUnavailable"
  | "taskFolderChangesDeclined"
  | "runArtifactsDeclined"
  | "viewedFullFileList"
  | "userCancelled"
  | "saveFailed"
  | "commitMessageCancelled"
  | "gitCommitFailed"
  | "pushFailed"
  | "unexpectedError";

/**
 * `commitPush.v1`'s completion signal — set to `{ kind: "completed" }` or
 * `{ kind: "noChanges" }` ONLY at the two genuinely-terminal-success points
 * below ("nothing to commit" and "push succeeded"); every other exit from
 * this function sets `{ kind: "notCompleted", reason }` with the specific
 * `CommitAndPushNotCompletedReasonV1` for that exit, rather than a single
 * undifferentiated failure signal.
 *
 * `detail` (present on `completed` and `notCompleted`) is the exact
 * user-facing text for that stopping point — a caught error's message, a
 * git-readiness reason, the resolved push destination, .... None of the
 * coordinator-native steps that build this result show their own
 * notification (plan §3.8: "the coordinator owns ... presentation");
 * `executeCommitPushV1` (`commitPushRowV1.ts`) presents it exactly once, via
 * `presentCommitPushCoreResultV1`, once the terminal result is known.
 */
export type CommitAndPushCoreResultV1 =
  | { readonly kind: "completed"; readonly detail?: string }
  | { readonly kind: "noChanges" }
  | { readonly kind: "notCompleted"; readonly reason: CommitAndPushNotCompletedReasonV1; readonly detail?: string }
  | {
      /**
       * The commit-message step returned structured questions instead of a
       * message to review (fresh generation or Resume) — distinct from
       * `notCompleted`'s `"commitMessageCancelled"` reason, which is the
       * user explicitly dismissing the confirmation modal. Carries the real
       * metadata attempt's correlation/interactionId (not this Commit/Push
       * attempt's own) so `commitPushRowV1.ts` can map it straight to the
       * standard `{ kind: "questions" }` coordinator outcome — the question
       * already reached Chat With AI before this result was set.
       */
      readonly kind: "questionsPosted";
      readonly interactionId: InteractionIdV1;
      readonly correlation: ActionCorrelationV1;
    };

/**
 * Shared task resolution for the Commit/Push flow (resolution order matches
 * `resolveTaskContext`'s own contract: explicit task arg, then the
 * persisted current-task canonical ID). Factored out so `commitPush.v1`
 * (`commitPushRowV1.ts`) can resolve the SAME task the SAME way — with
 * identical not-found messaging — before invoking the coordinator, without
 * that pre-check and the row's own sealed task binding ever drifting
 * apart. Shows the appropriate not-found message itself and returns
 * `undefined` on failure; malformed explicit args are hard failures (no
 * redirect to an unrelated task).
 */
async function resolveCommitPushTargetTaskV1(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore
): Promise<ResolvedTaskContext | undefined> {
  const resolverArg = normalizeArg(explicitArg);
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  }, currentTaskStore);
  if (!resolvedTask) {
    // If an explicit arg was supplied but resolution failed, the task is gone;
    // a clear error was already shown by resolveTaskContext. If no arg and no
    // persisted task, guide the user.
    if (resolverArg) {
      NotificationRouter.showError(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      NotificationRouter.showInformation(
        "Select a completed task in the Tasks panel to commit and push, " +
          "or invoke this command from that task's completed row."
      );
    }
    return undefined;
  }
  return resolvedTask;
}

/**
 * §10.2 step 1 / §2.4 rule 4, factored out as its own coordinator-native
 * step (plan §3.8: "The coordinator owns ... sequencing"). Index/privacy
 * checks run FIRST — before git readiness, lint, staging, and every prompt.
 * Content someone already put in the INDEX is refused outright (block, no
 * index mutation): unlike the staging proposals this command builds itself
 * (where control paths are merely omitted — see getChangedFiles), staged
 * private content would be published verbatim by the eventual commit, and
 * no later filter of OUR proposal list can un-stage it.
 *
 * `commitPushRowV1.ts`'s `executeCommitPushV1` calls this SAME function
 * itself, before ever opening the tracked "Commit and Push" operation — a
 * genuine, distinct, coordinator-owned first step with its own outcome,
 * rather than the whole flow being one opaque delegated call.
 * `resolveCommitPushStagingScopeV1` below also calls this exact function
 * again, under the per-task lock the coordinator already opened by that
 * point, immediately before it actually needs the result — the
 * coordinator's copy is a fast, lock-free pre-check for real sequencing and
 * fast rejection (skipping the tracked-operation UI row entirely for a
 * privacy-blocked attempt), not a replacement for the lock-protected,
 * authoritative recheck that actually gates the git work (§7.7's
 * "revalidate immediately before mutation" philosophy, applied here).
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export async function checkCommitPushIndexPrivacyV1(
  resolvedTask: ResolvedTaskContext
): Promise<
  | { readonly ok: true; readonly repoRoot: string }
  | {
      readonly ok: false;
      readonly reason: "noGitRepository" | "gitIndexReadFailed" | "privateContentStaged";
      // The exact user-facing text for this stopping point (plan §3.8: "the
      // coordinator owns ... presentation") — `executeCommitPushV1` shows
      // this itself, exactly once, via `presentCommitPushCoreResultV1`;
      // this function performs no notification/UI side effect of its own.
      readonly detail: string;
    }
> {
  const repoRoot = await resolveGitRepo(resolvedTask.taskFolderPath);
  if (!repoRoot) {
    return {
      ok: false,
      reason: "noGitRepository",
      detail:
        "Commit and push failed: Could not find git repository. Make sure the task is inside a git repository.",
    };
  }
  let stagedIndexRecords: PorcelainV2Entry[];
  try {
    stagedIndexRecords = await collectStagedIndexRecordsV1(repoRoot);
  } catch (error) {
    // Fail CLOSED: publishing without having verified the index would
    // defeat the §2.4 gate entirely.
    return {
      ok: false,
      reason: "gitIndexReadFailed",
      detail: `Commit and push failed: could not read the git index (${getErrorMessage(error)}).`,
    };
  }
  const forbiddenStaged = findForbiddenStagedRecordsV1(
    stagedIndexRecords,
    repoRoot,
    resolvedTask.taskFolderPath
  );
  if (forbiddenStaged.length > 0) {
    const channel = getCommitPreviewChannel();
    channel.clear();
    channel.appendLine("=== Ensemble: Commit and Push blocked — private/workflow-control content in the git index ===");
    channel.appendLine("");
    channel.appendLine("These staged entries are Ensemble-private or workflow-control paths and must never be committed:");
    for (const record of forbiddenStaged) {
      const rename = record.origPath !== undefined ? `  (from ${renderPath(record.origPath)})` : "";
      channel.appendLine(`  ${renderPath(record.path)}${rename}`);
    }
    channel.appendLine("");
    channel.appendLine("Unstage them (git restore --staged <path>) and run Commit and Push again.");
    channel.show(true);
    return {
      ok: false,
      reason: "privateContentStaged",
      detail:
        `Commit and push blocked: ${forbiddenStaged.length} private/workflow-control file(s) are already staged in the git index. ` +
        "See 'Ensemble: Commit Preview' for the list — unstage them and retry.",
    };
  }
  return { ok: true, repoRoot };
}

export type CommitPushCompletionChecksResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "checksDeclined" | "fixWithAiUnavailable">;
    };

/**
 * §10.2's failing-checks decision (Publish Anyway / Fix with AI / Cancel,
 * plan C3) as its own coordinator-native step: `commitPushRowV1.ts`'s
 * `executeCommitPushV1` opens the "Commit and Push" tracked operation
 * itself and calls this function DIRECTLY, before it ever calls into any of
 * the remaining save/PR-description/commit-message/staging/commit/push
 * steps below — genuine sequencing ownership of this step, not just
 * admission/leasing wrapped around one opaque delegated call. Runs under
 * `op`, the SAME handle the coordinator opened and will end, so the
 * Notifications row and its nested "Completion checks"/"Fix with AI"
 * children present exactly as they did when this loop used to run inside a
 * single delegated core call.
 *
 * Unlike the index/privacy and git-readiness checks (cheap, side-effect-free
 * reads that are safely re-run as an "authoritative revalidation immediately
 * before mutation", §7.7, by `resolveCommitPushStagingScopeV1`/
 * `confirmCommitPushScopeV1` below), this step cannot also be re-run later
 * in the sequence — it can execute a real test/build suite and drives its
 * own interactive modal, so running it twice would double-run expensive
 * work or double-prompt the user. It therefore runs exactly ONCE, here, and
 * every step below starts from its result.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export async function runCommitPushCompletionChecksV1(
  inventory: TaskInventory,
  resolvedTask: ResolvedTaskContext,
  extensionContext: vscode.ExtensionContext | undefined,
  op: TaskOperationHandle,
  lockKey: string
): Promise<CommitPushCompletionChecksResultV1> {
  // Always run fresh checks immediately before a commit. Persisted payloads
  // are informational and may be stale after files were edited. Registered
  // as a child (C1 publish model) so the Publish stage row spins while the
  // pre-commit checks run. Every run — passing, failing, or a post-fix
  // rerun — is also recorded in publish-review.md's managed Completion
  // Checks section by runCompletionLint itself (completionLint.ts), so the
  // artifact always reflects the latest result whatever the user decides
  // below; the Publish Anyway branch only layers the override annotation on
  // top of that record.
  // checkPublishPreflight now checks read-only git readiness (repo,
  // branch, remote — via checkGitPublishReadiness) before it ever runs
  // the lint. A git-readiness failure can't be fixed by "Fix with AI" or
  // meaningfully overridden by "Publish Anyway" (there is nowhere to
  // push), so it's surfaced directly by executeCommitPushV1's own pre-check
  // instead of going through the failing-checks modal below, which is
  // reserved for lint/test failures.
  const runChecks = async (): Promise<CompletionLintResult> => {
    const preflight = (await runTrackedOperation(
      lockKey,
      { parent: op, label: "Completion checks", stage: "publish", kind: "completion-checks" },
      () => checkPublishPreflight(vscode.Uri.file(resolvedTask.taskFolderPath), resolvedTask.progress.implReviewFiles, { persist: true })
    ))!;
    if (preflight.lintPayload) {
      // Both halves of publish-checks.md must come from the same run. The
      // preflight refreshes Completion Checks (through runCompletionLint) but
      // nothing here recomputed the Scope Check, so a pre-commit report paired
      // fresh check results with a scope answer from whenever Run Publish
      // Checks last ran — before the files being committed were edited. That is
      // the two-runs-one-document failure the publish split exists to remove,
      // reappearing inside the new artifact.
      //
      // Deliberately inside this branch: an absent lintPayload means the checks
      // did not run (git-readiness race, or runCompletionLint threw), so
      // Completion Checks was not refreshed either. Refreshing only the scope
      // half there would create the same mismatch in the other direction.
      await runPublishScopeCheck(
        vscode.Uri.file(resolvedTask.taskFolderPath),
        resolvedTask.progress
      );
      return preflight.lintPayload;
    }
    // checkPublishPreflight omits lintPayload when either the read-only
    // git readiness check failed (already handled by executeCommitPushV1's
    // own pre-check — this is a narrow same-task race, e.g. the branch
    // changed between the two checks) or runCompletionLint itself threw
    // (e.g. a tooling failure). Surface that through the same failing-checks
    // modal instead of letting the exception abort the whole commit flow.
    return {
      runAt: new Date().toISOString(),
      passed: false,
      summary: preflight.ok === false ? preflight.reason : "Completion checks failed.",
      issueCount: 1,
      failedChecks: [],
      missingScripts: [],
    };
  };
  let lintPayload = await runChecks();
  // Failing checks surface a three-way decision (C3): Publish Anyway,
  // Fix with AI, or Cancel (the modal's dismiss affordance). Fix with AI
  // runs the linting-fixes flow — editor autofixes plus the configured
  // Publish-stage agent fed the failing lint/test output — nested under
  // this operation, then checks re-run before publishing can continue, so
  // a fix pass that didn't resolve everything re-surfaces this decision.
  while (!lintPayload.passed) {
    const summary = lintPayload.summary ? ` (${lintPayload.summary})` : "";
    const choice = await vscode.window.showWarningMessage(
      `Completion checks failed for "${resolvedTask.folderName}"${summary}.\n\n` +
        "Publish Anyway records the failing checks in the Publish review. " +
        "Fix with AI applies automatic and AI fixes using the failing check output, then re-runs the checks.",
      { modal: true },
      "Publish Anyway",
      "Fix with AI"
    );
    if (choice === "Publish Anyway") {
      // The override lives here, in the publish flow (C3): task completion
      // is ungated and never records overrides — publishing over failing
      // checks is the decision worth an audit trail in publish-review.md.
      await upsertCompletionChecksReportV1(
        vscode.Uri.file(resolvedTask.taskFolderPath),
        lintPayload,
        { reason: "user chose Publish Anyway despite failing checks" }
      );
      break;
    }
    if (choice !== "Fix with AI") {
      return { ok: false, reason: "checksDeclined" };
    }
    if (!extensionContext) {
      // Programmatic invocation without an ExtensionContext: the fix flow
      // needs prompt templates and the AI-consent state, so point at the
      // standalone command instead of failing partway through. Text shown by
      // `executeCommitPushV1` via `presentCommitPushCoreResultV1`, not here
      // (plan §3.8: "the coordinator owns ... presentation").
      return { ok: false, reason: "fixWithAiUnavailable" };
    }
    await runLintingFixes(
      inventory,
      extensionContext.extensionUri,
      { taskFolderPath: resolvedTask.taskFolderPath },
      extensionContext,
      op
    );
    lintPayload = await runChecks();
  }
  return { ok: true };
}

/**
 * The read-only file lists `resolveCommitPushStagingScopeV1` resolves before
 * anything is staged, committed, or pushed — threaded through
 * `confirmCommitPushScopeV1` and the remaining save/PR-description/
 * commit-message/staging/commit steps below so each coordinator-native step
 * operates on the SAME resolved scope rather than silently re-deriving its
 * own (which could drift if git state changes between steps, or
 * double-prompt the user for "Include Task Folder" / "Include Run
 * Artifacts" a second time).
 */
export interface CommitPushResolvedScopeV1 {
  readonly scopedFiles: string[];
  readonly repoFiles: string[];
  readonly runArtifactPaths: string[];
  readonly sensitiveFilePaths: string[];
  readonly excludedControlPaths: string[];
  readonly includeTaskFolder: boolean;
}

/**
 * `resolveCommitPushStagingScopeV1`'s result (plan §3.8/§10.2's "staging-
 * scope decisions" step, now a distinct coordinator-native step
 * `commitPushRowV1.ts`'s `executeCommitPushV1` calls directly instead of it
 * living opaquely inside a single delegated call). `repoRoot` travels
 * alongside the resolved scope so downstream steps never re-resolve it from
 * a fresh `checkCommitPushIndexPrivacyV1` call — that repo identity was
 * already established here, as this step's own revalidation (§7.7).
 */
export type CommitPushScopeResultV1 =
  | { readonly kind: "noChanges" }
  | {
      readonly kind: "notCompleted";
      readonly reason: CommitAndPushNotCompletedReasonV1;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail?: string;
    }
  | { readonly kind: "scoped"; readonly repoRoot: string; readonly scope: CommitPushResolvedScopeV1 };

/**
 * `confirmCommitPushScopeV1`'s result. `gitReadiness` is the successful
 * branch/push-destination read this step performs as its own revalidation
 * (§7.7) immediately before building the confirmation preview — threaded
 * into `pushCommitPushV1` below so the push step never needs to re-derive it
 * a third time. `scope` carries `scopedFiles` after the
 * final pre-preview `stripSensitiveTaskFiles` gate (§2.4's invariant "gate A"
 * — reapplied here regardless of which path built the scope).
 */
export type CommitPushConfirmResultV1 =
  | {
      readonly kind: "confirmed";
      readonly gitReadiness: Extract<GitPublishReadiness, { ok: true }>;
      readonly scope: CommitPushResolvedScopeV1;
    }
  | {
      readonly kind: "notCompleted";
      readonly reason: CommitAndPushNotCompletedReasonV1;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail?: string;
    };

/**
 * §10.2's staging-scope resolution as its own coordinator-native step (plan
 * §3.8: "the coordinator owns ... sequencing ... and presentation") —
 * `commitPushRowV1.ts`'s `executeCommitPushV1` calls this directly, before
 * `confirmCommitPushScopeV1` and the remaining save/PR-description/
 * commit-message/staging/commit/push steps below, instead of this work
 * living inside one opaque delegated call. Handles the
 * pre-existing-staged-changes prompt, the default (outside-task-folder)
 * scope, and the "Include Task Folder Changes" / "Include Run Artifacts"
 * fallback prompts when the default scope is empty. Never stages, commits,
 * or pushes anything — every git call here is read-only.
 *
 * Runs its own revalidation of the index/privacy and git-readiness checks
 * (§7.7 "revalidate immediately before mutation") exactly once — not a NEW
 * extra revalidation on top of the coordinator's early pre-checks in
 * `executeCommitPushV1`, just the authoritative recheck at the point where
 * the real (lock-protected, `op`-scoped) work begins.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export async function resolveCommitPushStagingScopeV1(
  resolvedTask: ResolvedTaskContext
): Promise<CommitPushScopeResultV1> {
  const indexCheck = await checkCommitPushIndexPrivacyV1(resolvedTask);
  if (!indexCheck.ok) {
    return { kind: "notCompleted", reason: indexCheck.reason };
  }
  const repoRoot = indexCheck.repoRoot;

  const gitReadinessCheck = await checkGitPublishReadiness(resolvedTask.taskFolderPath);
  if (!gitReadinessCheck.ok) {
    return {
      kind: "notCompleted",
      reason: "gitNotReady",
      detail: `Commit and push failed: ${gitReadinessCheck.reason}`,
    };
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushScopeResultV1> => {
      NotificationRouter.emitProgressSummary(
        `Committing and pushing ${resolvedTask.folderName}...`,
        taskOperations.rootOperationIdFor(resolvedTask.taskFolderPath)
      );
      try {
        // Handle pre-existing staged changes. When EVERYTHING that changed
        // is already staged, commit/push proceeds without raising an error
        // (the staged files are part of the porcelain status and flow into
        // the preview and commit). When only SOME changes are staged, the
        // user chooses: commit everything together, or cancel and handle
        // the existing staged changes manually.
        const { stdout: stagedOutput } = await runGitCommand(
          repoRoot,
          "diff",
          ["--cached", "--name-only"]
        );
        const preStagedFiles = stagedOutput.trim().split(/\r?\n/).filter(Boolean);
        if (preStagedFiles.length > 0) {
          const { stdout: unstagedOutput } = await runGitCommand(
            repoRoot,
            "diff",
            ["--name-only"]
          );
          const { stdout: untrackedOutput } = await runGitCommand(
            repoRoot,
            "ls-files",
            ["--others", "--exclude-standard"]
          );
          const hasUnstagedChanges =
            unstagedOutput.trim().length > 0 || untrackedOutput.trim().length > 0;
          if (hasUnstagedChanges) {
            const choice = await vscode.window.showWarningMessage(
              `This repository already has ${preStagedFiles.length} staged change(s) alongside unstaged changes.\n\n` +
                "Commit everything together (staged and unstaged changes in one commit), " +
                "or cancel to handle the existing staged changes manually first.",
              { modal: true },
              "Commit Everything Together"
            );
            if (choice !== "Commit Everything Together") {
              return {
                kind: "notCompleted",
                reason: "userCancelled",
                detail: "Commit and push cancelled — handle the existing staged changes manually, then retry.",
              };
            }
          }
        }

        // Determine staging scope: default to the implemented source changes
        // (everything OUTSIDE the task folder), since that's what "commit
        // and push" is meant to ship. The task folder holds planning
        // metadata (task.md, plan.md, run logs), not the code changes.
        progress.report({ message: "Collecting changed files..." });
        let includeTaskFolder = false;
        let { scopedFiles, repoFiles, runArtifactPaths, sensitiveFilePaths, excludedControlPaths } =
          await getChangedFiles(repoRoot, resolvedTask.taskFolderPath, includeTaskFolder);

        if (scopedFiles.length === 0) {
          // No source changes — everything that changed lives inside the
          // task folder. Offer to include it, or bail out if nothing changed.
          const hasRepoChanges = await hasChangesToCommit(repoRoot);
          if (!hasRepoChanges) {
            return { kind: "noChanges" };
          }

          const choice = await vscode.window.showInformationMessage(
            "No source code changes found outside the task folder.\n\n" +
              "Only the task's planning files (in the task folder) have changed. " +
              "Include the task folder in this commit instead?",
            { modal: true },
            "Include Task Folder Changes",
          );
          if (choice !== "Include Task Folder Changes") {
            return { kind: "notCompleted", reason: "taskFolderChangesDeclined" };
          }
          includeTaskFolder = true;
          ({ scopedFiles, repoFiles, runArtifactPaths, sensitiveFilePaths, excludedControlPaths } =
            await getChangedFiles(repoRoot, resolvedTask.taskFolderPath, includeTaskFolder));

          if (scopedFiles.length === 0) {
            // All task-folder changes were run artifacts
            const artifactChoice = await vscode.window.showWarningMessage(
              "The only changes in the task folder are run artifacts " +
                "(runs/, context-pack.md). " +
                "These are excluded from the default staged set because they " +
                "contain AI prompts and file contents.\n\n" +
                "Include run artifacts in this commit?",
              { modal: true },
              "Include Run Artifacts",
            );
            if (artifactChoice === "Include Run Artifacts") {
              const taskRelative = path
                .relative(repoRoot, resolvedTask.taskFolderPath)
                .replace(/\\/g, "/");
              // Chat transcripts are never eligible for this override — even
              // though they live under the task folder like run artifacts,
              // the transcript staging policy (Option A) never stages them.
              // Filtered against `sensitiveFilePaths` (this same
              // getChangedFiles call's classification), not a basename
              // re-check: a transcript renamed to an innocuous basename still
              // inside the task folder carries a destination path that
              // getChangedFiles has already tagged as sensitive because its
              // rename origin was a transcript, but whose own basename would
              // pass a plain SENSITIVE_TASK_FILE_BASENAMES check.
              // Workflow-control paths are equally ineligible for the
              // run-artifact override (§2.4 rule 5 applies in every mode).
              const sensitivePathSet = new Set([...sensitiveFilePaths, ...excludedControlPaths]);
              scopedFiles.push(...repoFiles.filter((f) => {
                if (!(f === taskRelative || f.startsWith(taskRelative + "/"))) return false;
                return !sensitivePathSet.has(f);
              }));
            } else {
              return { kind: "notCompleted", reason: "runArtifactsDeclined" };
            }
          }
        }

        return {
          kind: "scoped",
          repoRoot,
          scope: { scopedFiles, repoFiles, runArtifactPaths, sensitiveFilePaths, excludedControlPaths, includeTaskFolder },
        };
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        return {
          kind: "notCompleted",
          reason: "unexpectedError",
          detail: `Commit and push failed: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * §10.2's final preview-and-confirmation step as its own coordinator-native
 * step, run directly by `commitPushRowV1.ts`'s `executeCommitPushV1` after
 * `resolveCommitPushStagingScopeV1` and before the remaining save/
 * PR-description/commit-message/staging/commit/push steps below. This is
 * the flow's critical safety gate — staging and pushing are NOT reversible
 * once changes reach a shared remote — so nothing here mutates the working
 * tree or index; it only re-derives the
 * branch/push-destination for display and asks the user to confirm.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export async function confirmCommitPushScopeV1(
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  scope: CommitPushResolvedScopeV1
): Promise<CommitPushConfirmResultV1> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (): Promise<CommitPushConfirmResultV1> => {
      try {
        // Get current branch and push destination for the confirm dialog,
        // through the same read-only checkGitPublishReadiness the automatic
        // Publish-entry preflight (publishPreflight.ts) already ran before
        // scheduling this command — so manual and automatic publishing can
        // never drift on what "repo/branch/remote ready" means, mirroring
        // the completion-lint preflight sharing above.
        const gitReadiness = await checkGitPublishReadiness(resolvedTask.taskFolderPath);
        if (!gitReadiness.ok) {
          throw new Error(gitReadiness.reason);
        }
        const currentBranch = gitReadiness.currentBranch;
        const pushDestination = gitReadiness.pushDestination;
        const hasUpstream = gitReadiness.hasUpstream;
        const singleRemote = gitReadiness.singleRemote;
        if (!hasUpstream && !singleRemote) {
          // Unreachable in practice — checkGitPublishReadiness already
          // returns ok:false for this case above — but kept as a defensive
          // guard so a future readiness-contract change fails loud instead
          // of silently attempting an ambiguous push below.
          throw new Error(
            `Push target is ambiguous: ${pushDestination}. ` +
              `Set an upstream manually with: git push -u <remote> ${currentBranch}`
          );
        }

        // Final gate (the invariant): re-applied here regardless of which
        // path built `scope.scopedFiles` — default fetch, include-task-folder
        // re-fetch, or the run-artifact override re-add — so no chat
        // transcript can reach the preview the user is about to confirm.
        const scopedFiles = stripSensitiveTaskFiles(scope.scopedFiles, repoRoot, resolvedTask.taskFolderPath);
        const nextScope: CommitPushResolvedScopeV1 = { ...scope, scopedFiles };

        // ----------------------------------------------------------------
        // ⚠️  CONFIRMATION DIALOG with file preview and push destination
        //
        // This is the critical safety gate. Staging and pushing are NOT
        // reversible once changes reach a shared remote.
        // ----------------------------------------------------------------
        const MAX_PREVIEW_FILES = 15;
        const previewFiles = scopedFiles.slice(0, MAX_PREVIEW_FILES);
        const remaining = scopedFiles.length - previewFiles.length;

        const scopeLabel = scope.includeTaskFolder
          ? "all repository changes, including the task folder"
          : "source changes only (task folder excluded by default)";

        const fileList = previewFiles
          .map((f) => {
            const isRunArtifact = scope.runArtifactPaths.includes(f);
            const marker = isRunArtifact ? " ⚠ (run artifact — contains AI prompts)" : "";
            return `  • ${renderPath(f)}${marker}`;
          })
          .join("\n");
        const moreNote =
          remaining > 0 ? `\n  … and ${remaining} more file(s)` : "";

        const notStagedCount = scope.repoFiles.length - scopedFiles.length;
        const repoExtra =
          !scope.includeTaskFolder && notStagedCount > 0
            ? `\n\n(${notStagedCount} file(s) changed in the task folder — not staged by default)`
            : "";
        const sensitiveExtra =
          scope.sensitiveFilePaths.length > 0
            ? `\n\n(${scope.sensitiveFilePaths.length} chat transcript file(s) excluded — plaintext prompt/response content, never staged by this command)`
            : "";
        const controlExtra =
          scope.excludedControlPaths.length > 0
            ? `\n\n(${scope.excludedControlPaths.length} workflow-control/private file(s) excluded — Ensemble runtime records, never staged by this command)`
            : "";

        const confirmMessage =
          `⚠️ Commit and push — please review carefully\n\n` +
          `Scope: ${scopeLabel}\n` +
          `Branch: ${currentBranch}\n` +
          `Destination: ${pushDestination}\n\n` +
          `Files to be staged (${scopedFiles.length} total):\n` +
          fileList +
          moreNote +
          repoExtra +
          sensitiveExtra +
          controlExtra +
          `\n\nPushing is outward-facing and largely irreversible.\n` +
          `Run artifacts (runs/, context-pack.md) contain AI prompts and file contents.\n` +
          `See DISCLAIMER.md §4-5 for full risk details.\n\n` +
          `Proceed?`;

        const confirmed = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true },
          "Commit & Push",
          "View Full List"
        );

        if (confirmed === "View Full List") {
          // Show the full file list in the output channel and return —
          // the user can re-invoke the command after reviewing.
          const channel = getCommitPreviewChannel();
          channel.clear();
          channel.appendLine("=== Ensemble: Commit Preview — Full File List ===");
          channel.appendLine("");
          channel.appendLine(`Scope: ${scopeLabel}`);
          channel.appendLine(`Branch: ${currentBranch}`);
          channel.appendLine(`Destination: ${pushDestination}`);
          channel.appendLine("");
          channel.appendLine(`Files to be staged (${scopedFiles.length} total):`);
          for (const f of scopedFiles) {
            const isRunArtifact = scope.runArtifactPaths.includes(f);
            const marker = isRunArtifact
              ? "  [run artifact — contains AI prompts and file contents]"
              : "";
            channel.appendLine(`  ${renderPath(f)}${marker}`);
          }
          if (!scope.includeTaskFolder && notStagedCount > 0) {
            channel.appendLine("");
            channel.appendLine("Not staged (inside task folder, excluded by default):");
            const taskRelative = path
              .relative(repoRoot, resolvedTask.taskFolderPath)
              .replace(/\\/g, "/");
            for (const f of scope.repoFiles) {
              const inTaskFolder = f === taskRelative || f.startsWith(taskRelative + "/");
              if (inTaskFolder) {
                channel.appendLine(`  ${renderPath(f)}`);
              }
            }
          }
          if (scope.sensitiveFilePaths.length > 0) {
            channel.appendLine("");
            channel.appendLine("Excluded — chat transcripts (plaintext prompt/response content, never staged by this command):");
            for (const f of scope.sensitiveFilePaths) {
              channel.appendLine(`  ${renderPath(f)}`);
            }
          }
          if (scope.excludedControlPaths.length > 0) {
            channel.appendLine("");
            channel.appendLine("Excluded — workflow-control/private files (Ensemble runtime records, never staged by this command):");
            for (const f of scope.excludedControlPaths) {
              channel.appendLine(`  ${renderPath(f)}`);
            }
          }
          channel.appendLine("");
          channel.appendLine("Run the command again to proceed after reviewing.");
          channel.show(true);
          return { kind: "notCompleted", reason: "viewedFullFileList" };
        }

        if (confirmed !== "Commit & Push") {
          return { kind: "notCompleted", reason: "userCancelled" };
        }

        return { kind: "confirmed", gitReadiness, scope: nextScope };
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        return {
          kind: "notCompleted",
          reason: "unexpectedError",
          detail: `Commit and push failed: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * §10.2's "save" step (plan §3.8) as its own coordinator-native function —
 * `commitPushRowV1.ts`'s `executeCommitPushV1` calls this directly,
 * immediately after `confirmCommitPushScopeV1` accepts, instead of this work
 * living opaquely inside one delegated "core" call. Saves dirty documents
 * relevant to the resolved staging scope; never stages, commits, or pushes.
 *
 * Emits the flow's progress-summary line once, here, at the start of the
 * remaining (post-confirmation) sequence — the same point the former single
 * delegated call used to emit it from, before this step existed on its own.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export type CommitPushSaveResultV1 =
  | { readonly kind: "saved" }
  | {
      readonly kind: "notCompleted";
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "saveFailed" | "unexpectedError">;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail?: string;
    };

export async function saveCommitPushDocumentsV1(
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  includeTaskFolder: boolean
): Promise<CommitPushSaveResultV1> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushSaveResultV1> => {
      NotificationRouter.emitProgressSummary(
        `Committing and pushing ${resolvedTask.folderName}...`,
        taskOperations.rootOperationIdFor(resolvedTask.taskFolderPath)
      );
      try {
        progress.report({ message: "Saving open files..." });
        const saved = await saveDirtyDocuments(
          resolvedTask.taskFolderPath,
          repoRoot,
          includeTaskFolder
        );
        if (!saved.ok) {
          return { kind: "notCompleted", reason: "saveFailed", detail: saved.detail };
        }
        return { kind: "saved" };
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        return {
          kind: "notCompleted",
          reason: "unexpectedError",
          detail: `Commit and push failed: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * §10.2's "PR description" step as its own coordinator-native function,
 * called directly by `executeCommitPushV1` right after
 * `saveCommitPushDocumentsV1` succeeds. Generates `pr-description.md` from
 * task artifacts and writes it atomically (temp file + rename), then
 * reapplies the §2.4 sensitive/control-path gate to `scopedFiles` — the
 * true invariant point immediately before the commit-message review's modal
 * preview (whose acceptance is what actually stages these files). Nothing
 * rebuilds `scopedFiles` between here and the eventual `git add`, but this
 * call is what makes that a property of the code rather than an assumption.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export type CommitPushPrDescriptionResultV1 =
  | { readonly kind: "generated"; readonly scopedFiles: string[] }
  | {
      readonly kind: "notCompleted";
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "unexpectedError">;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail?: string;
    };

export async function generateCommitPushPrDescriptionV1(
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  scopedFiles: string[]
): Promise<CommitPushPrDescriptionResultV1> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushPrDescriptionResultV1> => {
      try {
        progress.report({ message: "Generating PR description..." });
        const prDescription = await generatePRDescription(
          resolvedTask.taskFolderPath,
          resolvedTask.folderName,
          scopedFiles
        );
        const prDescPath = path.join(
          resolvedTask.taskFolderPath,
          "pr-description.md"
        );
        const prDescUri = vscode.Uri.file(prDescPath);

        // Write PR description atomically
        const tempPath = prDescPath + ".tmp";
        const tempUri = vscode.Uri.file(tempPath);
        await vscode.workspace.fs.writeFile(
          tempUri,
          new TextEncoder().encode(prDescription)
        );
        await vscode.workspace.fs.rename(tempUri, prDescUri, {
          overwrite: true,
        });

        // Final gate, reapplied immediately before the commit-message
        // review's modal confirmation preview (whose acceptance performs
        // the actual `git add`, in stageAndCommitCommitPushV1).
        const gatedScopedFiles = stripSensitiveTaskFiles(scopedFiles, repoRoot, resolvedTask.taskFolderPath);
        return { kind: "generated", scopedFiles: gatedScopedFiles };
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        return {
          kind: "notCompleted",
          reason: "unexpectedError",
          detail: `Commit and push failed: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * §10.2's "commit message review" step as its own coordinator-native
 * function, called directly by `executeCommitPushV1` right after
 * `generateCommitPushPrDescriptionV1` succeeds. Generated from the
 * configured Publish-stage model when possible, always shown to the user in
 * a modal preview to review, regenerate, or accept before anything is
 * staged or committed — staging, commit, and push all happen AFTER the user
 * confirms the message here (stage-after-confirm); cancelling or dismissing
 * the dialog leaves the index untouched. May instead return structured
 * questions (routed to Chat With AI by `buildCommitMessage`/
 * `resumeCommitMessage` themselves) that this attempt must end on rather
 * than falling back to a placeholder message the caller could commit
 * without realizing clarification was needed.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export type CommitPushMessageReviewResultV1 =
  | { readonly kind: "confirmed"; readonly message: string }
  | { readonly kind: "questionsPosted"; readonly interactionId: InteractionIdV1; readonly correlation: ActionCorrelationV1 }
  | {
      readonly kind: "notCompleted";
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "commitMessageCancelled" | "unexpectedError">;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail?: string;
    };

export async function reviewCommitPushMessageV1(
  op: TaskOperationHandle,
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  scopedFiles: string[],
  runArtifactPaths: string[],
  pushDestination: string,
  explicitArg: CommitAndPushTaskArg | undefined,
  chatViewProvider: ChatViewProvider | undefined,
  // The commitPush.v1 ROW's own coordinator operationId (commitPushRowV1.ts).
  // Threaded down to reviewCommitMessage's nested commitPushMetadata.v1
  // invocation so it opens a CHILD lease on this same task binding instead
  // of self-deadlocking against this row's own held lease. Undefined only
  // for a hypothetical caller outside the commitPush.v1 row (none exists in
  // production today), in which case the nested call falls back to a plain
  // top-level acquire — unchanged prior behavior.
  coordinatorOperationId: OperationIdV1 | undefined
): Promise<CommitPushMessageReviewResultV1> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushMessageReviewResultV1> => {
      try {
        progress.report({ message: "Generating commit message..." });
        const commitTaskTitle = await resolveTaskTitle(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          resolvedTask.folderName,
          resolvedTask.progress
        );
        const reviewResult = await reviewCommitMessage(
          repoRoot,
          vscode.Uri.file(resolvedTask.taskFolderPath),
          commitTaskTitle,
          scopedFiles,
          runArtifactPaths,
          pushDestination,
          resolvedTask.workspaceFolder ?? vscode.Uri.file(resolvedTask.taskFolderPath),
          op.token!,
          resolvedTask.progress.status,
          chatViewProvider,
          extractResumeInteraction(explicitArg),
          coordinatorOperationId
        );
        if (reviewResult.kind === "questionsPosted") {
          // No "cancelled" notification here — buildCommitMessage/
          // resumeCommitMessage already warned the user and routed the
          // question to Chat With AI. This is a genuine `questions` outcome,
          // not a decline: carry the metadata attempt's own
          // correlation/interactionId so commitPushRowV1.ts can map it to
          // the standard coordinator `questions` outcome.
          return {
            kind: "questionsPosted",
            interactionId: reviewResult.interactionId,
            correlation: reviewResult.correlation,
          };
        }
        if (reviewResult.kind === "declined") {
          return { kind: "notCompleted", reason: "commitMessageCancelled" };
        }
        return { kind: "confirmed", message: reviewResult.message };
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          // A genuine mid-flight cancellation (e.g. the operation's token
          // fired while awaiting a provider call). Rethrown to the caller
          // (executeCommitPushV1), which ends the operation as cancelled.
          throw error;
        }
        return {
          kind: "notCompleted",
          reason: "unexpectedError",
          detail: `Commit and push failed: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * §10.2's "staging and commit" step as its own coordinator-native function,
 * called directly by `executeCommitPushV1` right after
 * `reviewCommitPushMessageV1` returns a confirmed message. Stages exactly
 * `scopedFiles`, re-verifies the index for private/workflow-control content
 * that may have slipped in since the confirmation preview (§2.4 rule 7,
 * rolling staging back via `git reset` on a hit), then commits. Never
 * pushes — `pushCommitPushV1` is a separate step so a commit failure can
 * never reach the push step at all.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export type CommitPushStageAndCommitResultV1 =
  | { readonly kind: "committed" }
  | {
      readonly kind: "notCompleted";
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "gitCommitFailed">;
      // See `checkCommitPushIndexPrivacyV1`'s `detail` field — same contract.
      readonly detail: string;
    };

export async function stageAndCommitCommitPushV1(
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  scopedFiles: string[],
  confirmedMessage: string
): Promise<CommitPushStageAndCommitResultV1> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushStageAndCommitResultV1> => {
      progress.report({ message: "Staging changes..." });
      try {
        if (scopedFiles.length > 0) {
          await runGitCommand(repoRoot, "add", ["--", ...scopedFiles]);
        }
        // §2.4 rule 7: re-read the INDEX after staging and verify no
        // private/workflow-control content slipped in — e.g. a path that
        // changed shape between the proposal build and the add, or
        // pre-staged records swept in by the "Commit Everything Together"
        // path. A hit rolls the staging back (the catch below runs
        // `git reset`) and aborts before any commit exists.
        const postAddForbidden = findForbiddenStagedRecordsV1(
          await collectStagedIndexRecordsV1(repoRoot),
          repoRoot,
          resolvedTask.taskFolderPath
        );
        if (postAddForbidden.length > 0) {
          throw new Error(
            `staging was rolled back — ${postAddForbidden.length} private/workflow-control file(s) reached the git index ` +
              `(first: ${postAddForbidden[0]!.path}). Unstage or remove them and retry.`
          );
        }
        progress.report({ message: "Creating commit..." });
        await runGitCommand(repoRoot, "commit", ["-m", confirmedMessage]);
      } catch (error) {
        // Undo any staging performed above so a retry starts clean.
        try {
          await runGitCommand(repoRoot, "reset", []);
        } catch {
          // Best effort.
        }
        return {
          kind: "notCompleted",
          reason: "gitCommitFailed",
          detail: `Commit failed: ${getErrorMessage(error)}`,
        };
      }
      // The commit just advanced HEAD: any review artifact whose recorded
      // reviewed-commit predates it is now stale, and must say so at the top
      // rather than only in a trailing HTML comment (review freshness
      // follow-up — see utils/reviewFreshness.ts). Best-effort: the commit
      // already landed, so a courtesy marker must never fail it.
      await refreshStaleReviewBannersForTaskV1(resolvedTask.taskFolderPath);
      return { kind: "committed" };
    }
  );
}

/**
 * §10.2's "push" step as its own coordinator-native function, called
 * directly by `executeCommitPushV1` right after
 * `stageAndCommitCommitPushV1` succeeds. Push failure keeps the local
 * commit — it is never rolled back automatically, since that would mutate
 * the user's git history without explicit instruction; the user is told how
 * to undo manually.
 *
 * @internal exported for the commitPush.v1 row and for testing
 */
export type CommitPushPushResultV1 =
  | {
      readonly kind: "completed";
      // The exact success text (plan §3.8: "the coordinator owns ...
      // presentation") — `executeCommitPushV1` shows this itself, exactly
      // once, via `presentCommitPushCoreResultV1`; this function performs no
      // notification/UI side effect of its own.
      readonly detail: string;
    }
  | {
      readonly kind: "notCompleted";
      readonly reason: Extract<CommitAndPushNotCompletedReasonV1, "pushFailed">;
      readonly detail: string;
    };

export async function pushCommitPushV1(
  resolvedTask: ResolvedTaskContext,
  repoRoot: string,
  gitReadiness: Extract<GitPublishReadiness, { ok: true }>
): Promise<CommitPushPushResultV1> {
  const { pushDestination, hasUpstream, singleRemote, currentBranch } = gitReadiness;
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress): Promise<CommitPushPushResultV1> => {
      progress.report({ message: "Pushing to remote..." });
      try {
        if (hasUpstream) {
          await runGitCommand(repoRoot, "push", []);
        } else if (singleRemote) {
          await runGitCommand(repoRoot, "push", [
            "-u",
            singleRemote,
            currentBranch,
          ]);
        }
        return {
          kind: "completed",
          detail: `Successfully committed and pushed ${resolvedTask.folderName} to ${pushDestination}`,
        };
      } catch (error) {
        // Push failed after commit was created — keep the local commit.
        // Do NOT automatically roll back: this mutates the user's git
        // history without their explicit instruction. Tell them how to
        // undo manually.
        return {
          kind: "notCompleted",
          reason: "pushFailed",
          detail:
            `Push failed. Your local commit was kept — it has NOT been rolled back automatically.\n\n` +
            `To undo the commit manually: git reset --mixed HEAD~1\n\n` +
            `Error: ${getErrorMessage(error)}`,
        };
      }
    }
  );
}

/**
 * Invoke the `commitPush.v1` registry row (plan §3.8/§10.1/§10.2) for an
 * ALREADY-RESOLVED task — used by every call site below, so eligibility and
 * settlement logging run through the coordinator exactly once per
 * invocation, regardless of which public entry point (or internal composite
 * step) is driving it. The row's `execute` passes THIS exact `resolvedTask`
 * straight through its coordinator-native steps (never re-resolving one),
 * so the task the coordinator bound its correlation/eligibility check to is
 * guaranteed to be the task actually acted on. Every outcome except a
 * pre-`execute` rejection (ineligible stage/status, or duplicate lease) has
 * already had its specific reason shown to the user exactly once, by
 * `presentCommitPushCoreResultV1` from inside `executeCommitPushV1`
 * (`commitPushRowV1.ts`) — the coordinator's own presentation step, not any
 * of the coordinator-native step functions above, none of which show a
 * notification of their own for a reason they set. This helper only surfaces
 * a message for the pre-`execute` cases nothing has said anything about yet.
 */
/** @internal exported for testing */
export async function invokeCommitPushRowV1(
  resolvedTask: ResolvedTaskContext,
  services: Omit<CommitPushServicesV1, "resolvedTask">
): Promise<void> {
  const derivedBinding = deriveTaskBindingV1(resolvedTask.progress);
  if (!derivedBinding.ok) {
    NotificationRouter.showError(
      `Commit and push failed: this task's ownership binding could not be verified. ` +
        `The task's progress file needs recovery.`
    );
    return;
  }
  const outcome = await invokeLifecycleRowV1({
    actionKey: COMMIT_PUSH_ACTION_KEY_V1,
    taskFolderPath: resolvedTask.taskFolderPath,
    taskBindingId: derivedBinding.binding.bindingId,
    chatDocumentIdentitySeed: resolvedTask.canonicalId,
    workspaceCwd: resolvedTask.workspaceFolder?.fsPath ?? path.dirname(resolvedTask.taskFolderPath),
    taskStatus: resolvedTask.progress.status ?? "active",
    taskStage: resolvedTask.progress.currentStage,
    rawInput: { taskFolderPath: resolvedTask.taskFolderPath },
    // The row's `execute` (commitPushRowV1.ts) must act on this EXACT
    // resolved/bound task, never re-resolve one from mutable current-task
    // state — see the coordinator-native step functions' header comments
    // above (saveCommitPushDocumentsV1 onward).
    services: { ...services, resolvedTask },
  });
  if (outcome.kind === "completed") {
    return;
  }
  if (outcome.kind === "questions") {
    // Not a failure: commit-message generation returned structured
    // questions. The question already reached Chat With AI and the
    // "answer in Chat With AI, then start Commit and Push again" warning
    // was already shown from inside reviewCommitMessage/buildCommitMessage
    // (commitAndPushTask.ts's `generate` helper) at the exact point this
    // outcome was produced — nothing more to show here, and definitely not
    // the generic "could not start" error below.
    return;
  }
  if (outcome.kind === "cancelled" && outcome.code === "userCancelled") {
    // The coordinator-native step that produced this outcome already showed
    // "Commit and push cancelled." via NotificationRouter at the exact
    // point that produced this outcome (commitPushRowV1.ts's `userCancelled`
    // mapping) — nothing more to show.
    return;
  }
  if (outcome.kind === "failed" && outcome.code.startsWith("commitPush.") && outcome.code !== "commitPush.servicesUnavailable") {
    // The coordinator-native step that produced this outcome already showed
    // the specific reason for every `commitPush.<CommitAndPushNotCompletedReasonV1>`
    // code (see that type's header) — this just recognizes the whole family
    // instead of one now-retired exact string, so a caller doesn't ALSO get
    // the generic "could not start" message below on top of the real one.
    return;
  }
  if (outcome.kind === "failed" && outcome.code === "actionNotEligibleForStage") {
    // The row's real, coordinator-owned stage eligibility (commitPushRowV1.ts)
    // rejected this before any of the coordinator-native steps ever ran —
    // same user-facing message those steps used to show internally after
    // their own now-redundant (but still present, defense-in-depth) stage
    // check.
    NotificationRouter.showWarning(
      `Task is at stage "${STAGE_DISPLAY_NAMES[resolvedTask.progress.currentStage]}" — must be completed before committing and pushing.`
    );
    return;
  }
  // A pre-execute rejection (ineligible task status, or another coordinator
  // action already holding this task's lease) — nothing has told the user
  // anything yet.
  const detail = outcome.kind === "failed" ? outcome.code : outcome.kind;
  NotificationRouter.showError(`Commit and push could not start: ${detail}.`);
}

/**
 * Commit and push the current task (public command entry point).
 *
 * Acquires the process-global Commit/Push token before anything else — a
 * duplicate invocation is rejected immediately, before argument
 * normalization, task resolution, lint, prompts, staging, commit, or push
 * setup. See the coordinator-native step functions above (checked via
 * `commitPushRowV1.ts`'s `executeCommitPushV1`) for the actual behavior;
 * both public entries reach them through the `commitPush.v1` registry row.
 */
export async function commitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore,
  parentOperation?: TaskOperationHandle,
  extensionContext?: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): Promise<CommitPushDuplicateRejectedV1 | void> {
  if (!acquireCommitPushToken()) {
    return rejectDuplicateCommitPush();
  }
  try {
    // Duplicate rejection stays first (the token check above reads no task
    // state); after that, block on the startup gate's classification pass
    // before the core's first task-state read (plan §1.4).
    await TaskCreationStartupReconcilerV1.waitUntilReady();
    const resolvedTask = await resolveCommitPushTargetTaskV1(inventory, explicitArg, currentTaskStore);
    if (!resolvedTask) {
      return;
    }
    await invokeCommitPushRowV1(resolvedTask, {
      inventory,
      explicitArg,
      parentOperation,
      extensionContext,
      chatViewProvider,
    });
  } finally {
    releaseCommitPushToken();
  }
}

/**
 * Combined complete + commit + push command.
 * Marks the task completed, selects the next task, and commits/pushes the completed task.
 *
 * Acquires the same process-global Commit/Push token as `commitAndPushTask`
 * before anything else, then — holding that token — calls
 * `invokeCommitPushRowV1` directly rather than the public `commitAndPushTask`
 * command, so it never tries (and fails) to acquire a token it already
 * holds.
 */
export async function completeCommitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore,
  extensionContext?: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): Promise<CommitPushDuplicateRejectedV1 | void> {
  if (!acquireCommitPushToken()) {
    return rejectDuplicateCommitPush();
  }
  try {
    // Duplicate rejection stays first (the token check above reads no task
    // state); after that, block on the startup gate's classification pass
    // before this callback's first task-state read (plan §1.4).
    await TaskCreationStartupReconcilerV1.waitUntilReady();
    const resolverArg = normalizeArg(explicitArg);
    const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
      allowPaused: false,
    }, currentTaskStore);

    if (!resolvedTask) {
      if (resolverArg) {
        NotificationRouter.showError(
          "The task could not be found. It may have been deleted or moved. " +
            "Please refresh the Tasks panel and try again."
        );
      } else {
        NotificationRouter.showInformation(
          "No active task found to complete, commit, and push."
        );
      }
      return;
    }

    // Check stage eligibility: must be at final review stage (impl-low-review) or completed
    if (resolvedTask.progress.currentStage !== "impl-low-review") {
      if (resolvedTask.progress.currentStage === "publish") {
        // Already completed: borrow the token this callback already holds
        // and route through the commitPush.v1 row directly.
        await invokeCommitPushRowV1(resolvedTask, {
          inventory,
          explicitArg,
          extensionContext,
          chatViewProvider,
        });
        return;
      }
      NotificationRouter.showWarning(
        `"Complete, Commit and Push" is only available when the task is at the final review stage (Implementation: Low-Level Review) or completed.`
      );
      return;
    }

    // One root operation guards the ENTIRE composite — lint, advance, complete,
    // next-task selection, and the commit/push itself (registered below as a
    // child of this root, so it never contends for the lock this root holds).
    const lockKey = resolvedTask.taskFolderPath;
    await runTrackedOperation(
      lockKey,
      { label: "Complete, Commit and Push", taskName: resolvedTask.progress.displayName ?? resolvedTask.folderName, kind: "complete-commit-push" },
      async (op) => {
      // 1. Transition stage to "publish", then persist completion — both
      // through the coordinator's lifecycle rows (§10.2's transfer: the
      // strict progress stack and the exhaustive field policy own these
      // writes, never the permissive patch). Completion itself is ungated
      // (C3): no checks run here — the commitPush.v1 row invoked below (via
      // invokeCommitPushRowV1) runs fresh checks and owns the failing-checks
      // prompt/override flow, so the completion step can never be blocked
      // by lint/test state.
      const workspaceCwd =
        resolvedTask.workspaceFolder?.fsPath ?? path.dirname(resolvedTask.taskFolderPath);
      // Plan §3.9: the task-binding identity is the digest derived from this
      // task's persisted ownership + taskFolder, never the raw canonical
      // folder path — the same derivation every provider row uses for the
      // same task, so leases and audit records key on one identity per task
      // regardless of which action touches it. Derived once and reused for
      // both lifecycle calls below (ownership does not change across a stage
      // transition).
      const derivedBinding = deriveTaskBindingV1(resolvedTask.progress);
      if (!derivedBinding.ok) {
        NotificationRouter.showError(
          `Could not complete ${resolvedTask.folderName}: its ownership binding could not be verified. ` +
            `The task's progress file needs recovery.`
        );
        return;
      }
      const taskBindingId = derivedBinding.binding.bindingId;
      const stageOutcome = await invokeLifecycleRowV1({
        actionKey: NEXT_STAGE_ACTION_KEY_V1,
        taskFolderPath: resolvedTask.taskFolderPath,
        taskBindingId,
        chatDocumentIdentitySeed: resolvedTask.canonicalId,
        workspaceCwd,
        taskStatus: resolvedTask.progress.status ?? "active",
        taskStage: resolvedTask.progress.currentStage,
        rawInput: {
          taskFolderPath: resolvedTask.taskFolderPath,
          // The eligibility check above pinned the stage to impl-low-review;
          // the row re-validates it as a CAS against the freshly re-read
          // progress (mirroring the retired advanceStage compare-and-set).
          expectedSourceStage: "impl-low-review",
          targetStage: "publish",
        },
      });
      if (stageOutcome.kind !== "completed") {
        const detail = stageOutcome.kind === "failed" ? stageOutcome.code : stageOutcome.kind;
        NotificationRouter.showWarning(
          `Could not persist completion for ${resolvedTask.folderName}: ${detail}.`
        );
        return;
      }

      // Completing this command is a lifecycle transition, not merely reaching
      // Publish. Persist completion (status + completedAt + the completedStages
      // tick the markTaskDone policy column owns) before selecting another
      // task so the one active-task invariant remains true across refreshes
      // and reloads.
      const doneOutcome = await invokeLifecycleRowV1({
        actionKey: MARK_TASK_DONE_ACTION_KEY_V1,
        taskFolderPath: resolvedTask.taskFolderPath,
        taskBindingId,
        chatDocumentIdentitySeed: resolvedTask.canonicalId,
        workspaceCwd,
        // The nextStage row above just landed the task at active/publish —
        // exactly markTaskDone's eligibility gate.
        taskStatus: "active",
        taskStage: "publish",
        rawInput: { taskFolderPath: resolvedTask.taskFolderPath },
      });
      if (doneOutcome.kind !== "completed") {
        const detail = doneOutcome.kind === "failed" ? doneOutcome.code : doneOutcome.kind;
        NotificationRouter.showError(
          `Could not persist completion for ${resolvedTask.folderName}: ${detail}. Please try again.`
        );
        return;
      }

      // 2. Refresh inventory
      await inventory.refresh();

      // 3. Select next active task deterministically
      if (currentTaskStore) {
        const nextCanonicalId = selectNextTask(inventory, resolvedTask.canonicalId);
        if (nextCanonicalId) {
          await currentTaskStore.set(nextCanonicalId);
        } else {
          await currentTaskStore.clear();
        }
      }

      // 4. Run commit & push (the core, not the public command — this
      // callback already holds the process-global token) as a child of this
      // composite's root operation — still under the same exclusive lock, so
      // no second invocation can start between completion and the
      // commit/push handoff.
      const completedTask: IncompleteTask = {
        folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
        folderName: resolvedTask.folderName,
        progress: {
          ...resolvedTask.progress,
          currentStage: "publish", // Since it was just advanced
        },
        canonicalId: resolvedTask.canonicalId,
      };
      await invokeCommitPushRowV1(
        { ...resolvedTask, progress: completedTask.progress },
        {
          inventory,
          explicitArg: { task: completedTask },
          parentOperation: op,
          extensionContext,
          chatViewProvider,
        }
      );
      }
    );
  } finally {
    releaseCommitPushToken();
  }
}

/**
 * Register the commitAndPushTask command.
 */
export function registerCommitAndPushTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore?: CurrentTaskStore,
  chatViewProvider?: ChatViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.commitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      commitAndPushTask(inventory, arg, currentTaskStore, undefined, context, chatViewProvider)
  );
  const completeDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.completeCommitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      completeCommitAndPushTask(inventory, arg, currentTaskStore, context, chatViewProvider)
  );
  context.subscriptions.push(disposable, completeDisposable);
}
