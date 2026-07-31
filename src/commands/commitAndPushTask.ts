import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { TASK_FILENAME, STAGE_DISPLAY_NAMES, TaskProgress } from "../types/taskProgress";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { selectNextTask } from "./markTaskDone";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  CompletionLintResult,
  upsertCompletionChecksInPublishReview,
} from "../utils/completionLint";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { runGitCommand, resolveGitRepo, checkGitPublishReadiness } from "../utils/gitRepoInfo";
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
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
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
import { ChatInteractionRefV1, ChatInteractionResumeResultV1, ChatViewProvider } from "../views/chatView";

/**
 * A pending `commitPushMetadata.v1` Chat interaction being explicitly
 * resumed (plan §10.2 point 5). Threaded privately through
 * `commitAndPushTaskCore` into `reviewCommitMessage`/`resumeCommitMessage` so
 * the metadata attempt (`coordinator.resumeAction`) runs as part of THIS
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
type CommitAndPushTaskArg =
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
 */
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
  resumeInteraction?: CommitPushMetadataResumeRequestV1
): Promise<string | undefined> {
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
  const generate = async (): Promise<string | undefined> => {
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
        resumeInteraction
      );
    } else {
      result = await buildCommitMessage(repoRoot, taskFolderUri, workspaceUri, taskName, scopedFiles, cancellationToken, chatViewProvider);
    }
    if (result.kind === "questionsPosted") {
      NotificationRouter.showWarning(
        "Commit and Push needs more information before it can generate a commit message. " +
          "Answer the question in Chat With AI, then start Commit and Push again."
      );
      return undefined;
    }
    return result.text;
  };

  let message = await generate();
  if (message === undefined) {
    return undefined;
  }
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
      if (regenerated === undefined) {
        return undefined;
      }
      message = regenerated;
      continue;
    }
    if (choice === "Commit & Push") {
      return message;
    }
    return undefined;
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
  | { kind: "questionsPosted" };

async function buildCommitMessage(
  repoRoot: string,
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  taskName: string,
  files: string[],
  cancellationToken: vscode.CancellationToken,
  chatViewProvider?: ChatViewProvider
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
      return { kind: "questionsPosted" };
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
  resumeInteraction: CommitPushMetadataResumeRequestV1
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
    return outcome.kind === "questions" ? { kind: "questionsPosted" } : { kind: "message", text: fallback };
  }
  onSettled({ ok: true, settlement });

  if (outcome.kind === "questions") {
    return { kind: "questionsPosted" };
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
 * Generate PR description from task artifacts
 */
async function generatePRDescription(
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
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const implSection = extractSectionBody(
      implContent,
      "## Implementation"
    );
    if (implSection) {
      implementationSummary = extractFirstParagraph(implSection) ?? implSection;
    } else {
      implementationSummary =
        extractFirstParagraph(implContent) ?? implementationSummary;
    }
  } catch {
    // ignore
  }

  // Testing summary
  let testingSummary = "Testing summary not available.";
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const testingSection = extractSectionBody(implContent, "## Testing");
    if (testingSection) {
      testingSummary = extractFirstParagraph(testingSection) ?? testingSection;
    }
  } catch {
    try {
      const lowLevelBytes = await vscode.workspace.fs.readFile(lowLevelPlanUri);
      const lowLevelContent = new TextDecoder().decode(lowLevelBytes);
      const testingSection = extractSectionBody(
        lowLevelContent,
        "## Testing"
      );
      if (testingSection) {
        testingSummary =
          extractFirstParagraph(testingSection) ?? testingSection;
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
): Promise<boolean> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  const relevantPaths = new Set([
    taskFileUri.fsPath,
    implementationArtifact.uri.fsPath,
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
      NotificationRouter.showError(
        `Could not save ${path.basename(doc.uri.fsPath)}. Please save all files before committing.`
      );
      return false;
    }
  }

  return true;
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
 * `runTrackedOperation` lock still used inside `commitAndPushTaskCore` below,
 * which continues to guard against a *different* operation (e.g. a stage AI
 * action) running concurrently on the same task, and supplies the
 * Notifications-row/cancel/nesting plumbing the flow relies on.
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
 * Commit and push the current task — the named private core (plan §10.1),
 * containing all of the actual behavior. Never acquires or releases the
 * process-global token itself: only the two exported entry points below do
 * that, so a caller that already holds the token (the composite flow in
 * `completeCommitAndPushTask`) can invoke this directly, borrowing the held
 * token, without a self-rejection.
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
async function commitAndPushTaskCore(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore,
  parentOperation?: TaskOperationHandle,
  extensionContext?: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);
  const resumeInteraction = extractResumeInteraction(explicitArg);

  // Resolution order (matches resolveTaskContext contract):
  //   1. explicit task arg (tree node, canonical ID, folder path) — highest precedence
  //   2. persisted current-task canonical ID from CurrentTaskStore
  // Malformed explicit args are hard failures (no redirect to unrelated tasks).
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
    return;
  }

  // Per-task exclusive lock (contract C1). The process-global duplicate-
  // invocation guard for Commit and Push itself already ran in the public
  // entry point (commitAndPushTask / completeCommitAndPushTask) before this
  // function — or any read, lint, prompt, staging, commit, or push logic —
  // ever started. This lock's remaining job is guarding against a DIFFERENT
  // operation (e.g. a stage AI action) already running for this same task,
  // and providing the Notifications-row/cancel/nesting plumbing used
  // throughout this flow. When invoked as part of the Complete/Commit/Push
  // composite, this registers as a child of that root (C1 nesting) instead
  // of contending for the lock the root holds.
  const lockKey = resolvedTask.taskFolderPath;
  try {
  await runTrackedOperation(
    lockKey,
    {
      label: "Commit and Push",
      taskName: resolvedTask.folderName,
      kind: "commit-push",
      parent: parentOperation,
      // The V1 action coordinator requires a real CancellationToken for
      // every provider action (TaskActionRequestV1.cancellationToken is not
      // optional) — commit-message generation below passes op.token into it.
      // Without `cancellable: true` here, taskOperations never creates a
      // token source, op.token stays undefined, and the coordinator's
      // admission phase throws on `cancellationToken.isCancellationRequested`
      // before ever reaching a provider — silently caught by
      // buildCommitMessage's catch-all, so every real invocation fell back
      // to the deterministic subject instead of the configured AI message.
      cancellable: true,
    },
    async (op) => {
    // Allow committing from completed stage only
    if (resolvedTask.progress.currentStage !== "publish") {
      NotificationRouter.showWarning(
        `Task is at stage "${STAGE_DISPLAY_NAMES[resolvedTask.progress.currentStage]}" — must be completed before committing and pushing.`
      );
      return;
    }

    // §10.2 step 1 / §2.4 rule 4: index/privacy checks run FIRST — before
    // git readiness, lint, and every prompt. Content someone already put in
    // the INDEX is refused outright (block, no index mutation): unlike the
    // staging proposals this command builds itself (where control paths are
    // merely omitted — see getChangedFiles), staged private content would be
    // published verbatim by the eventual commit, and no later filter of OUR
    // proposal list can un-stage it.
    const repoRoot = await resolveGitRepo(resolvedTask.taskFolderPath);
    if (!repoRoot) {
      NotificationRouter.showError(
        "Commit and push failed: Could not find git repository. Make sure the task is inside a git repository."
      );
      return;
    }
    let stagedIndexRecords: PorcelainV2Entry[];
    try {
      stagedIndexRecords = await collectStagedIndexRecordsV1(repoRoot);
    } catch (error) {
      // Fail CLOSED: publishing without having verified the index would
      // defeat the §2.4 gate entirely.
      NotificationRouter.showError(
        `Commit and push failed: could not read the git index (${getErrorMessage(error)}).`
      );
      return;
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
      NotificationRouter.showError(
        `Commit and push blocked: ${forbiddenStaged.length} private/workflow-control file(s) are already staged in the git index. ` +
          "See 'Ensemble: Commit Preview' for the list — unstage them and retry."
      );
      return;
    }
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
    // push), so it's surfaced directly here instead of going through the
    // failing-checks modal below, which is reserved for lint/test failures.
    const gitReadinessCheck = await checkGitPublishReadiness(resolvedTask.taskFolderPath);
    if (!gitReadinessCheck.ok) {
      NotificationRouter.showError(
        `Commit and push failed: ${gitReadinessCheck.reason}`
      );
      return;
    }
    // Routed through the same checkPublishPreflight helper the automatic
    // entry paths (setTaskStage.ts, reviewActions.ts) use before scheduling
    // auto-publish, so manual and automatic publishing can never drift on
    // what "checks passed" means. Those scheduling-decision call sites use
    // the default side-effect-free mode (no persistence); this is the one
    // call site that is an actual publish attempt, so it opts into
    // `{ persist: true }` to record the result in task-progress.json and
    // publish-review.md's managed Completion Checks section.
    const runChecks = async (): Promise<CompletionLintResult> => {
      const preflight = (await runTrackedOperation(
        lockKey,
        { parent: op, label: "Completion checks", stage: "publish", kind: "completion-checks" },
        () => checkPublishPreflight(vscode.Uri.file(resolvedTask.taskFolderPath), resolvedTask.progress.implReviewFiles, { persist: true })
      ))!;
      if (preflight.lintPayload) {
        return preflight.lintPayload;
      }
      // checkPublishPreflight omits lintPayload when either the read-only
      // git readiness check failed (already handled above — this is a
      // narrow same-task race, e.g. the branch changed between the two
      // checks) or runCompletionLint itself threw (e.g. a tooling
      // failure). Surface that through the same failing-checks modal
      // instead of letting the exception abort the whole commit flow.
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
        await upsertCompletionChecksInPublishReview(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          lintPayload,
          { reason: "user chose Publish Anyway despite failing checks" }
        );
        break;
      }
      if (choice !== "Fix with AI") {
        NotificationRouter.showInformation("Commit and push cancelled.");
        return;
      }
      if (!extensionContext) {
        // Programmatic invocation without an ExtensionContext: the fix flow
        // needs prompt templates and the AI-consent state, so point at the
        // standalone command instead of failing partway through.
        NotificationRouter.showWarning(
          'Fix with AI is unavailable here — run "Linting Fixes" from the task\'s Publish actions, then retry Commit and Push.'
        );
        return;
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

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress) => {
      NotificationRouter.emitProgressSummary(
        `Committing and pushing ${resolvedTask.folderName}...`,
        taskOperations.rootOperationIdFor(lockKey)
      );
      try {
        // Repository already resolved by the §10.2 index/privacy gate above,
        // before lint and every prompt — reused here unchanged.

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
              NotificationRouter.showInformation(
                "Commit and push cancelled — handle the existing staged changes manually, then retry."
              );
              throw new vscode.CancellationError();
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
            NotificationRouter.showInformation(
              "No changes to commit — the repository is clean."
            );
            return;
          }

          const choice = await vscode.window.showInformationMessage(
            "No source code changes found outside the task folder.\n\n" +
              "Only the task's planning files (in the task folder) have changed. " +
              "Include the task folder in this commit instead?",
            { modal: true },
            "Include Task Folder Changes",
          );
          if (choice !== "Include Task Folder Changes") {
            NotificationRouter.showInformation("Commit and push cancelled.");
            return;
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
              NotificationRouter.showInformation("Commit and push cancelled.");
              return;
            }
          }
        }

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
        // path above built `scopedFiles` — default fetch, include-task-folder
        // re-fetch, or the run-artifact override re-add — so no chat
        // transcript can reach the preview the user is about to confirm.
        scopedFiles = stripSensitiveTaskFiles(scopedFiles, repoRoot, resolvedTask.taskFolderPath);

        // ----------------------------------------------------------------
        // ⚠️  CONFIRMATION DIALOG with file preview and push destination
        //
        // This is the critical safety gate. Staging and pushing are NOT
        // reversible once changes reach a shared remote.
        // ----------------------------------------------------------------
        const MAX_PREVIEW_FILES = 15;
        const previewFiles = scopedFiles.slice(0, MAX_PREVIEW_FILES);
        const remaining = scopedFiles.length - previewFiles.length;

        const scopeLabel = includeTaskFolder
          ? "all repository changes, including the task folder"
          : "source changes only (task folder excluded by default)";

        const fileList = previewFiles
          .map((f) => {
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact ? " ⚠ (run artifact — contains AI prompts)" : "";
            return `  • ${renderPath(f)}${marker}`;
          })
          .join("\n");
        const moreNote =
          remaining > 0 ? `\n  … and ${remaining} more file(s)` : "";

        const notStagedCount = repoFiles.length - scopedFiles.length;
        const repoExtra =
          !includeTaskFolder && notStagedCount > 0
            ? `\n\n(${notStagedCount} file(s) changed in the task folder — not staged by default)`
            : "";
        const sensitiveExtra =
          sensitiveFilePaths.length > 0
            ? `\n\n(${sensitiveFilePaths.length} chat transcript file(s) excluded — plaintext prompt/response content, never staged by this command)`
            : "";
        const controlExtra =
          excludedControlPaths.length > 0
            ? `\n\n(${excludedControlPaths.length} workflow-control/private file(s) excluded — Ensemble runtime records, never staged by this command)`
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
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact
              ? "  [run artifact — contains AI prompts and file contents]"
              : "";
            channel.appendLine(`  ${renderPath(f)}${marker}`);
          }
          if (!includeTaskFolder && notStagedCount > 0) {
            channel.appendLine("");
            channel.appendLine("Not staged (inside task folder, excluded by default):");
            const taskRelative = path
              .relative(repoRoot, resolvedTask.taskFolderPath)
              .replace(/\\/g, "/");
            for (const f of repoFiles) {
              const inTaskFolder = f === taskRelative || f.startsWith(taskRelative + "/");
              if (inTaskFolder) {
                channel.appendLine(`  ${renderPath(f)}`);
              }
            }
          }
          if (sensitiveFilePaths.length > 0) {
            channel.appendLine("");
            channel.appendLine("Excluded — chat transcripts (plaintext prompt/response content, never staged by this command):");
            for (const f of sensitiveFilePaths) {
              channel.appendLine(`  ${renderPath(f)}`);
            }
          }
          if (excludedControlPaths.length > 0) {
            channel.appendLine("");
            channel.appendLine("Excluded — workflow-control/private files (Ensemble runtime records, never staged by this command):");
            for (const f of excludedControlPaths) {
              channel.appendLine(`  ${renderPath(f)}`);
            }
          }
          channel.appendLine("");
          channel.appendLine("Run the command again to proceed after reviewing.");
          channel.show(true);
          NotificationRouter.showInformation(
            "Full file list shown in 'Ensemble: Commit Preview'. Re-run the command to proceed."
          );
          // End the tracked operation as cancelled, not succeeded — nothing
          // was committed or pushed, so a "completed" terminal entry here
          // would falsely report success. Swallowed at the outer call.
          throw new vscode.CancellationError();
        }

        if (confirmed !== "Commit & Push") {
          NotificationRouter.showInformation(
            "Commit and push cancelled."
          );
          return;
        }

        // Save dirty documents (scoped to source files, or entire repo)
        progress.report({ message: "Saving open files..." });
        const saved = await saveDirtyDocuments(
          resolvedTask.taskFolderPath,
          repoRoot,
          includeTaskFolder
        );
        if (!saved) {
          return;
        }

        // Generate PR description
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

        // Final gate, reapplied immediately before the modal confirmation
        // preview (whose acceptance performs the actual `git add`) — the
        // true invariant point. Nothing rebuilds scopedFiles between the
        // confirmation preview and here today, but this call is what makes
        // that a property of the code rather than an assumption.
        scopedFiles = stripSensitiveTaskFiles(scopedFiles, repoRoot, resolvedTask.taskFolderPath);

        // Commit message — generated from the configured Publish-stage
        // model when possible, always shown to the user in a modal preview
        // to review, regenerate, or accept before anything is committed.
        // Staging, commit, and push all happen AFTER the user confirms the
        // message (stage-after-confirm) — cancelling or dismissing the
        // dialog leaves the index untouched.
        progress.report({ message: "Generating commit message..." });
        const commitTaskTitle = await resolveTaskTitle(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          resolvedTask.folderName,
          resolvedTask.progress
        );
        const confirmedMessage = await reviewCommitMessage(
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
          resumeInteraction
        );
        if (!confirmedMessage) {
          NotificationRouter.showInformation("Commit and push cancelled.");
          return;
        }

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
          NotificationRouter.showError(
            `Commit failed: ${getErrorMessage(error)}`
          );
          return;
        }

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
          NotificationRouter.showInformation(
            `Successfully committed and pushed ${resolvedTask.folderName} to ${pushDestination}`
          );
        } catch (error) {
          // Push failed after commit was created — keep the local commit.
          // Do NOT automatically roll back: this mutates the user's git
          // history without their explicit instruction. Tell them how to
          // undo manually.
          NotificationRouter.showError(
            `Push failed. Your local commit was kept — it has NOT been rolled back automatically.\n\n` +
              `To undo the commit manually: git reset --mixed HEAD~1\n\n` +
              `Error: ${getErrorMessage(error)}`
          );
        }
      } catch (error: unknown) {
        if (error instanceof vscode.CancellationError) {
          // "View Full List" (and genuine cancellations) end the tracked
          // operation as cancelled instead of falsely reporting success.
          throw error;
        }
        NotificationRouter.showError(
          `Commit and push failed: ${getErrorMessage(error)}`
        );
      }
    }
  );
    }
  );
  } catch (error) {
    if (!(error instanceof vscode.CancellationError)) {
      throw error;
    }
  }
}

/**
 * Commit and push the current task (public command entry point).
 *
 * Acquires the process-global Commit/Push token before anything else — a
 * duplicate invocation is rejected immediately, before argument
 * normalization, task resolution, lint, prompts, staging, commit, or push
 * setup. See `commitAndPushTaskCore` above for the actual behavior.
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
    await commitAndPushTaskCore(
      inventory,
      explicitArg,
      currentTaskStore,
      parentOperation,
      extensionContext,
      chatViewProvider
    );
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
 * `commitAndPushTaskCore` directly rather than the public `commitAndPushTask`
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
        // and run the core directly.
        await commitAndPushTaskCore(inventory, explicitArg, currentTaskStore, undefined, extensionContext, chatViewProvider);
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
      { label: "Complete, Commit and Push", taskName: resolvedTask.folderName, kind: "complete-commit-push" },
      async (op) => {
      // 1. Transition stage to "publish", then persist completion — both
      // through the coordinator's lifecycle rows (§10.2's transfer: the
      // strict progress stack and the exhaustive field policy own these
      // writes, never the permissive patch). Completion itself is ungated
      // (C3): no checks run here — commitAndPushTaskCore below runs fresh
      // checks and owns the failing-checks prompt/override flow, so the
      // completion step can never be blocked by lint/test state.
      const workspaceCwd =
        resolvedTask.workspaceFolder?.fsPath ?? path.dirname(resolvedTask.taskFolderPath);
      const stageOutcome = await invokeLifecycleRowV1({
        actionKey: NEXT_STAGE_ACTION_KEY_V1,
        taskFolderPath: resolvedTask.taskFolderPath,
        taskBindingId: resolvedTask.canonicalId,
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
        taskBindingId: resolvedTask.canonicalId,
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
      await commitAndPushTaskCore(inventory, { task: completedTask }, currentTaskStore, op, extensionContext, chatViewProvider);
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
