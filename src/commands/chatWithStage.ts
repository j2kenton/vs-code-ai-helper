import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import {
  IMPLEMENTATION_SUMMARY_FILENAME,
  PLAN_FILENAME,
  PUBLISH_CHECKS_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkRunnerAvailabilityForModel,
} from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { ChatViewProvider } from "../views/chatView";
import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation } from "../utils/taskOperations";
import {
  readTextIfExists,
} from "../utils/fileUtils";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import {
  computeReviewFreshness,
  parseReviewedCommitSha,
  REVIEWED_COMMIT_STAGES,
} from "../utils/reviewReadiness";
import { executeProposedAction } from "../utils/globalAssistantActions";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
} from "../services/workflowRuntimeServicesV1";
import { readChatDocumentIdentityV1, ChatMessage } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  admitAndContinueWithMalformedResultRetryV1,
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
} from "../actions/productionTaskActionRuntimeV1";
import { CHAT_SEND_ACTION_KEY_V1, ChatSendActionInputV1, validateChatSendInputV1 } from "../actions/rows/chatSendRowV1";
import { ChatInteractionRefV1, ChatInteractionResumeResultV1 } from "../views/chatView";

type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage; message?: string }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };

function normalizeArg(node: ChatWithStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined; message: string | undefined;
} {
  if (!node) return { resolverArg: undefined, stage: undefined, message: undefined };
  if ("task" in node && node.task) {
    return { resolverArg: { taskFolderPath: node.task.folderUri.fsPath }, stage: node.stage, message: node.message };
  }
  const value = node as { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };
  return {
    resolverArg: value.canonicalId || value.taskFolderPath
      ? { canonicalId: value.canonicalId, taskFolderPath: value.taskFolderPath }
      : undefined,
    stage: value.stage,
    message: value.message,
  };
}

export type ChatSendValidationResultV1 =
  | { ok: true; task: ResolvedTaskContext; targetStage: TaskStage }
  | { ok: false; reason: string };

/**
 * Validates a Chat Send BEFORE the user's message is persisted to
 * `chat-v1.json` (plan §5.4/§6.1, AC-CHAT-TX-02): resolves and confirms the
 * target task actually exists. chatView.ts's webview handler calls this
 * (via ChatInteractionServicesV1.validateSend) immediately before appending
 * the user's display message, so a validation failure — most commonly a
 * stale/deleted task reference — leaves the transcript untouched instead of
 * recording a message for a send that chatWithStage will only reject moments
 * later anyway. chatWithStage itself also calls this (rather than
 * duplicating the resolution logic) so both paths apply identical rules.
 */
export async function validateChatSendV1(
  inventory: TaskInventory,
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined,
  stage: TaskStage | undefined
): Promise<ChatSendValidationResultV1> {
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) {
    return { ok: false, reason: "No task found. Please select a task first." };
  }
  return { ok: true, task, targetStage: stage ?? task.progress.currentStage };
}

/** Chat never invokes tools or edits code — the runner is the same text-only
 * planning/review runner used to answer questions (CLI providers run in
 * `mode: "text"`, native edit permissions withheld). Two extension-mediated
 * exceptions exist:
 *  - markdown: a response may propose the full replacement content of a
 *    single `.md` file that lives inside this task's own folder (its
 *    description, plan, or a review artifact), which this command applies
 *    directly. Anything outside that folder, or any non-markdown file, is
 *    never written. See docs/design/c4-chat-edit-spike-decision.md for why
 *    this envelope was chosen over enabling a provider's native edit mode.
 *  - stage actions: a response may propose exactly one of the four pinned
 *    stage actions for THIS task (see STAGE_CHAT_ACTIONS) via the shared
 *    typed `[[ACTION:<id>]]` envelope (legacy `[[STAGE_ACTION:<id>]]` is
 *    still accepted). The proposal is executed through the same typed action
 *    executor the global assistant uses (executeProposedAction), so the
 *    confirmation gate, state-accurate outcome verification, and audit
 *    logging are identical — the model never executes anything itself, and
 *    unlisted ids are rejected. */

/** One of the four pinned stage actions the stage chat may propose (the
 * approved catalog: complete stage, set this task's stage, trigger this
 * task's AI action, complete task). Each id IS a global-assistant operation
 * id: execution flows through the shared typed executor with the chat's own
 * task pinned as the payload target, so the chat path reuses exactly the
 * same confirmation, guards, and outcome verification as the global
 * assistant (which in turn delegates to the UI buttons' commands).
 * Task-lifecycle actions beyond the stage itself (pause, archive, pin,
 * reviews across tasks, …) belong to the global assistant, not stage chat. */
export interface StageChatActionDefinition {
  /** Global-assistant operation id this action executes as. */
  readonly id: string;
  /** Human label used in the outcome note. */
  readonly label: string;
  /** Shown to the model in the prompt so it knows what it may propose. */
  readonly description: string;
  /**
   * Payload keys the chat may pass through from the proposal envelope to the
   * operation (e.g. setTaskStage's target "stage"). Everything else in the
   * proposal payload is dropped, and the target task is ALWAYS the chat's
   * own task — the model can never retarget another task from stage chat.
   */
  readonly allowedPayloadKeys?: readonly string[];
}

const STAGE_ID_LIST = Object.keys(STAGE_DISPLAY_NAMES).join(", ");

export const STAGE_CHAT_ACTIONS: readonly StageChatActionDefinition[] = [
  {
    id: "completeStage",
    label: "Complete Stage & Move On",
    description: "complete the current stage and advance the task to its next stage",
  },
  {
    id: "setTaskStage",
    label: "Set Task Stage",
    description:
      `move this task to a specific stage — the envelope must carry the target stage, e.g. [[ACTION:setTaskStage {"stage": "<stage id>"}]] with a stage id from: ${STAGE_ID_LIST}`,
    allowedPayloadKeys: ["stage"],
  },
  {
    id: "triggerStageAI",
    label: "Apply Current Stage Action",
    description:
      "run the primary AI action for this task's current stage (uses provider quota)",
  },
  {
    id: "completeTask",
    label: "Complete Task",
    description: "mark this Publish-stage task as completed",
  },
];

export function getStageChatAction(
  id: string
): StageChatActionDefinition | undefined {
  return STAGE_CHAT_ACTIONS.find((action) => action.id === id);
}

/** A stage-chat action proposal extracted from a response envelope. The
 * payload (when present and valid JSON) is filtered later against the
 * action's `allowedPayloadKeys`; the target task is always pinned to the
 * chat's own task regardless of what the payload claims. */
export interface StageChatActionProposal {
  id: string;
  payload?: unknown;
}

/** Extracts every action envelope and returns the remaining text with all
 * envelopes removed — no envelope may survive into the displayed response,
 * whether or not it is executed. The stage chat shares the global
 * assistant's typed action protocol (`[[ACTION:<id> <optional json>]]`) and
 * still accepts the legacy `[[STAGE_ACTION:<id>]]` form. A JSON payload is
 * captured so actions that need one (setTaskStage's target stage) can use
 * it; unparseable payloads yield undefined and the operation's own
 * validation rejects them with a useful message. Pure and VS-Code-free so
 * the allowlist boundary is unit-testable without a host. */
export function splitStageActionEnvelopes(
  text: string
): { text: string; actions: StageChatActionProposal[] } {
  const actions: StageChatActionProposal[] = [];
  const remaining = text
    .replace(
      /\[\[(?:STAGE_)?ACTION:([A-Za-z0-9_-]+)(?:\s+([\s\S]*?))?\]\]/gi,
      (_whole, id: string, rawPayload: string | undefined) => {
        let payload: unknown;
        if (rawPayload && rawPayload.trim().length > 0) {
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = undefined;
          }
        }
        actions.push({ id, payload });
        return "";
      }
    )
    .trim();
  return { text: remaining, actions };
}

/**
 * Build the payload the shared typed executor receives for a stage-chat
 * action: the chat's own task is ALWAYS the target (pinned last so a
 * proposal can never override it), and only the action's allowlisted keys
 * are copied through from the proposal payload. Pure for unit testing.
 */
export function buildStageActionPayload(
  action: StageChatActionDefinition,
  taskFolderPath: string,
  proposalPayload: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (
    proposalPayload &&
    typeof proposalPayload === "object" &&
    action.allowedPayloadKeys
  ) {
    for (const key of action.allowedPayloadKeys) {
      const value = (proposalPayload as Record<string, unknown>)[key];
      if (value !== undefined) {
        payload[key] = value;
      }
    }
  }
  payload.taskFolder = taskFolderPath;
  return payload;
}

function describeStageActionsForPrompt(): string {
  return STAGE_CHAT_ACTIONS.map(
    (action) => `${action.id} — ${action.description}`
  ).join("; ");
}

/**
 * The markdown-update paragraph explicitly disclaims "any read-only or
 * plan-mode restriction" — worded that way specifically for opencode's
 * `plan` agent (see providers.ts's buildArgs comment), which stage chat
 * always selects via `mode: "text"`. That agent's plan-mode refusal is baked
 * into its own system prompt, not just its tool permissions, so a model can
 * decline the `[[UPDATE_FILE:...]]` envelope in read-only/plan-mode terms
 * even though the envelope invokes no tool at all. Live-verified against
 * opencode 1.18.4: this wording took a free model
 * (opencode/north-mini-code-free) that refused 100% of the time under the
 * prior wording ("you may do so directly") to roughly 2 of 3 attempts
 * emitting a valid envelope — a real improvement, NOT a guaranteed fix (the
 * same model still refused outright on one of three identical retries).
 * Models that already complied under the old wording (opencode/mimo-v2.5-free,
 * opencode/ling-3.0-flash-free) kept complying. See
 * isLikelyOpencodePlanModeRefusal below for the fallback when a refusal gets
 * through anyway.
 */
export function buildStageResponsePrompt(
  stageName: string, taskName: string, taskArtifacts: string, contextPack: string, message: string, conversation = ""
): string {
  const artifactsSection = taskArtifacts.trim().length > 0
    ? `\n\nTask's plan and current stage artifact (always included, regardless of open editor tabs):\n${taskArtifacts}`
    : "";
  return `You are answering a user question about the ${stageName} stage for task ${taskName}.\n\nDo not invoke tools or propose that code changes were applied. If the user asks you to make a code change, tell them to use the stage action that applies it explicitly instead. However, the user may ask you to update this task's own markdown files (its task description, plan, or a review file) — this is not a file-edit action and uses no edit or write tool, so it is unaffected by any read-only or plan-mode restriction on your tool use: you are only composing text in your reply, and a separate already-trusted process outside this conversation reads that text and applies it on your behalf, the same as if you were dictating a paragraph for someone else to type. To draft an update, put the file's full new content, and nothing else, wrapped in \`[[UPDATE_FILE:relative-filename.md]]\`...\`[[/UPDATE_FILE]]\`, using a path relative to this task's own folder. Only one file may be drafted per response, only \`.md\` files inside this task's folder may be targeted this way, and you must never target a source code file. You may also run this task's own stage actions when the user asks for one: end your response with a single \`[[ACTION:<actionId>]]\` envelope (the same typed action protocol the global assistant uses; the legacy \`[[STAGE_ACTION:<actionId>]]\` form is also accepted) and the extension will confirm with the user and run it. Available action ids: ${describeStageActionsForPrompt()}. Propose at most one action per response, only when the user clearly asked for it — never speculatively. For other task-lifecycle requests (pausing, archiving, pinning, renaming, running or fast-forwarding reviews, …), point the user at the Global Assistant chat, which can run those. Give a concise, useful answer alongside any update or action. If you need clarification before the task can proceed, end with a single \`[[QUESTION]]your question[[/QUESTION]]\` envelope. Do not put task output in that envelope.\n\nConversation so far:\n${conversation.slice(-12000)}${artifactsSection}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}`;
}

/**
 * Reads the task's approved plan plus the current stage's own artifact
 * (e.g. the review file for a review stage) directly from the task folder,
 * so Chat With AI can always answer questions that reference them — instead
 * of depending on generateContextPack's ambient open-editor-tab inclusion,
 * which silently omits them whenever the user hasn't happened to have that
 * file open. Skips a file that doesn't exist yet (e.g. plan.md before the
 * Plan stage), and never reads the same file twice (targetStage === "plan"
 * means the stage artifact IS plan.md).
 *
 * @internal exported for testing — chatArtifactCoverage.test.ts asserts that
 * every task artifact carrying answerable content actually reaches chat, so a
 * future artifact split cannot silently drop one the way the plan-final.md and
 * publish-review.md splits both did.
 */
export async function readStageArtifactsForChat(
  taskFolderUri: vscode.Uri,
  targetStage: TaskStage
): Promise<string> {
  const sections: string[] = [];

  const planContent = await readTextIfExists(
    vscode.Uri.joinPath(taskFolderUri, PLAN_FILENAME)
  );
  if (planContent?.trim()) {
    sections.push(`### ${PLAN_FILENAME} (approved plan)\n\n${planContent}`);
  }

  const stageFilename = STAGE_ARTIFACT_FILENAMES[targetStage];
  if (stageFilename && stageFilename !== PLAN_FILENAME) {
    const stageContent = await readTextIfExists(
      vscode.Uri.joinPath(taskFolderUri, stageFilename)
    );
    if (stageContent?.trim()) {
      let section = `### ${stageFilename} (current stage artifact)\n\n${stageContent}`;
      // Review freshness, display-side only (chat never mutates the
      // artifact): a stage review whose recorded commit is behind HEAD gets a
      // note appended to its packed section, so the model answering the user
      // does not present a superseded verdict as the current state.
      if (
        REVIEWED_COMMIT_STAGES.has(targetStage) &&
        parseReviewedCommitSha(stageContent) !== undefined
      ) {
        const headSha = await resolveHeadCommitSha(taskFolderUri.fsPath);
        const freshness = computeReviewFreshness(stageContent, headSha);
        if (freshness.behindHead) {
          section +=
            `\n\n> ⚠ This review examined commit ${freshness.reviewedSha}, which is no longer HEAD — ` +
            "its verdicts describe that commit, not the current workspace.";
        }
      }
      sections.push(section);
    }
  }

  // The latest run's notes live in impl-summary.md since the artifact split;
  // before it they arrived here inside plan-final.md, which is now only the
  // plan of record. Without this, Chat With Stage silently lost the ability to
  // answer anything about what the last implementation round actually did.
  const summaryContent = await readTextIfExists(
    vscode.Uri.joinPath(taskFolderUri, IMPLEMENTATION_SUMMARY_FILENAME)
  );
  if (summaryContent?.trim()) {
    sections.push(
      `### ${IMPLEMENTATION_SUMMARY_FILENAME} (latest implementation run summary)\n\n${summaryContent}`
    );
  }

  // The Publish checks report, and it regressed exactly the way the paragraph
  // above describes: before the publish split these sections arrived here
  // inside publish-review.md, so "why did the checks fail?" was answerable at
  // the Publish stage. Afterwards chat could only see the review's verdict —
  // which may be several commits old — and would answer a question about the
  // current run from a stale one.
  //
  // Read unconditionally rather than gated on `targetStage === "publish"`:
  // readTextIfExists already yields undefined when the file is absent, and a
  // stage conditional is one more place for the next artifact to be forgotten.
  const publishChecksContent = await readTextIfExists(
    vscode.Uri.joinPath(taskFolderUri, PUBLISH_CHECKS_FILENAME)
  );
  if (publishChecksContent?.trim()) {
    sections.push(
      `### ${PUBLISH_CHECKS_FILENAME} (latest Publish checks report)\n\n${publishChecksContent}`
    );
  }

  return sections.join("\n\n");
}

// Envelope extraction, the all-or-nothing update plan, and the path-
// containment check now live in utils/chatFileUpdateEnvelope.ts (so
// actions/rows/chatSendRowV1.ts — the production write path — can depend on
// them without a commands -> actions -> commands import cycle). Re-exported
// here unchanged so existing imports of this module keep working.
export {
  FileUpdateEnvelope,
  splitFileUpdateEnvelopes,
  ChatFileUpdatePlan,
  planFileUpdate,
  resolveMarkdownUpdateTarget,
} from "../utils/chatFileUpdateEnvelope";

/**
 * Recognizes opencode's own `plan`-agent refusal language (READ-ONLY phase /
 * plan mode / its `.opencode/plans/*.md` permission grant) surviving into a
 * chat response with no `[[UPDATE_FILE:...]]` envelope. buildStageResponsePrompt's
 * reframing (see its own doc comment) reduces how often this happens but does
 * not eliminate it, since the refusal is baked into that agent's own system
 * prompt rather than gated by our envelope's wording. Matching it lets the
 * chat append a clarifying note instead of leaving opencode's confusing,
 * extension-unaware "I can only edit .opencode/plans/*.md" framing as the
 * user's entire answer. Deliberately narrow (three opencode-specific phrases)
 * so it never fires on an ordinary answer that happens to mention read-only
 * concepts for unrelated reasons.
 */
export function isLikelyOpencodePlanModeRefusal(responseText: string): boolean {
  return /\.opencode[\\/]plans|\bplan mode\b|read-only phase/i.test(responseText);
}

export const OPENCODE_PLAN_MODE_REFUSAL_NOTE =
  "_That refusal is opencode's own read-only \"plan\" mode declining to draft the update in its own terms — " +
  "not a real limitation here. This chat never uses opencode's native edit tool for `.md` updates; it only " +
  "reads the drafted text back and applies it itself. Try asking again, or switch this stage to a different " +
  "model in AI Models if opencode keeps declining._";



export async function chatWithStage(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  explicitArg?: ChatWithStageArg,
  currentTaskStore?: CurrentTaskStore
): Promise<void> {
  assertLegacyAiRouteAllowedV0("chatSend.v1");
  const { resolverArg, stage, message } = normalizeArg(explicitArg);
  const validated = await validateChatSendV1(inventory, resolverArg, stage);
  if (!validated.ok) {
    NotificationRouter.showWarning(validated.reason);
    return;
  }
  const { task, targetStage } = validated;
  if (!message?.trim()) {
    await chatViewProvider.open({
      canonicalId: task.canonicalId,
      taskFolderPath: task.taskFolderPath,
      stage: targetStage,
      taskName: task.progress.displayName,
    });
    return;
  }
  if (!(await ensureAiConsent(context))) return;

  const lockKey = task.taskFolderPath;
  let proposedAction: StageChatActionProposal | undefined;
  // Tracks whether the user's message has actually been written to
  // chat-v1.json yet. Persisted only after every deterministic
  // precondition below has passed (plan §5.4/AC-CHAT-TX-02) — a failure
  // before that point must never mutate the transcript, so the catch
  // block below reports it as a notification instead of an assistant
  // reply to a message that was never shown.
  let userMessagePersisted = false;
  try {
    await runTrackedOperation(lockKey, {
      label: "Chat",
      stage: targetStage,
      taskName: task.progress.displayName ?? task.folderName,
      exclusive: false,
      kind: "chat-send",
      cancellable: true,
    }, async (op) => {
    const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
    if (!workspaceFolder) throw new Error("The task is not inside an open workspace.");
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, targetStage);
    if (!modelId) {
      NotificationRouter.showWarning(
        "No model is configured for this stage. Open Ensemble Settings and choose a primary model before continuing.",
        undefined,
        undefined,
        undefined,
        { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
      );
      return;
    }
    const { availability: available, providerLabel } = await checkRunnerAvailabilityForModel(modelId, targetStage);
    if (!available.available) throw new Error(available.reason ?? `${providerLabel} is unavailable.`);

    const rootId = ensureWorkflowTaskFolderRootV1(task.taskFolderPath);
    const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!verifiedBindingId) {
      throw new Error("Task ownership binding could not be verified.");
    }
    const chatIdentity = await readChatDocumentIdentityV1(task.taskFolderPath, task.canonicalId);
    const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

    // Build the prompt from the transcript as it stands BEFORE this send is
    // persisted, with the pending message spliced in only for prompt
    // construction — mirroring what the transcript will look like once the
    // message lands, without writing it yet (plan §5.4/AC-CHAT-TX-02). Every
    // precondition that can still independently reject this send — prompt
    // size confirmation, coordinator input validation, and (via
    // `coordinator.admitAction` below) eligibility, cancellation,
    // duplicate-lease rejection, and provider selection — is checked against
    // that in-memory view first; only once none of them reject does the
    // user's message actually get written to chat-v1.json, so a rejection
    // never leaves an unanswerable orphan message in the transcript.
    const existingTranscript = await chatViewProvider.transcript(task.taskFolderPath, task.canonicalId, targetStage);
    const pendingEntry: ChatMessage = { role: "user", text: message, stage: targetStage, at: new Date().toISOString() };
    const conversation = [...existingTranscript, pendingEntry]
      .slice(-20)
      .map(entry => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n");
    const taskArtifacts = await readStageArtifactsForChat(taskFolderUri, targetStage);
    const prompt = buildStageResponsePrompt(STAGE_DISPLAY_NAMES[targetStage], task.folderName, taskArtifacts,
      await generateContextPack(taskFolderUri, workspaceFolder.uri), message, conversation);
    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") return;

    const validatedInput: ChatSendActionInputV1 = {
      prompt,
      taskFolderPath: task.taskFolderPath,
      canonicalId: task.canonicalId,
    };
    const inputValidation = validateChatSendInputV1(validatedInput);
    if (!inputValidation.ok) {
      NotificationRouter.showError(`Unable to send: ${inputValidation.reason}`);
      return;
    }

    const coordinator = createProductionTaskActionCoordinatorV1({
      workspaceCwd: workspaceFolder.uri.fsPath,
      resolveStagePrimaryModel: () => ({ modelId, stage: targetStage }),
    });

    // Admission (plan §5.4/AC-CHAT-TX-02): eligibility, input validation,
    // cancellation, duplicate-lease rejection, and provider selection all
    // run here, still without touching chat-v1.json. Only once the action
    // has survived every one of those and is genuinely about to run a
    // provider does the user's message get persisted — a rejection at any
    // of these stages leaves the transcript untouched, same as a rejection
    // from the prompt-size confirmation or input validation just above.
    // Retried via admitAndContinueWithMalformedResultRetryV1 on a malformed
    // provider response (bad result frame / cross-operation correlation) —
    // safe here because preInvocationHook's own userMessagePersisted guard
    // makes a second admission's hook a deliberate no-op, so a retry can
    // never persist the user's message twice.
    const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, {
      actionKey: CHAT_SEND_ACTION_KEY_V1,
      taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
      taskStatus: task.progress.status ?? "active",
      taskStage: targetStage,
      rawInput: validatedInput,
      cancellationToken: op.token!,
      preInvocationHook: async () => {
        if (!userMessagePersisted) {
          await chatViewProvider.append("user", message, targetStage, {
            canonicalId: task.canonicalId,
            taskFolderPath: task.taskFolderPath,
          });
          userMessagePersisted = true;
        }
      },
    });

    if (outcome.kind === "completed") {
      // Completed message has already been written to chat-v1.json by promoteChatSendContentV1.
      // Now trigger transcript refresh in chat view.
      await chatViewProvider.open({
        canonicalId: task.canonicalId,
        taskFolderPath: task.taskFolderPath,
        stage: targetStage,
        taskName: task.progress.displayName,
      });
    } else if (outcome.kind === "questions") {
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
          canonicalId: task.canonicalId,
          taskFolderPath: task.taskFolderPath,
          stage: record.stage,
          taskName: task.progress.displayName,
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
    } else if (outcome.kind === "cancelled") {
      await chatViewProvider.append("assistant", "Stage chat was cancelled.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    } else {
      const code = "code" in outcome ? outcome.code : outcome.kind;
      await chatViewProvider.append("assistant", `Unable to respond: ${code}`, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    }
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (userMessagePersisted) {
      await chatViewProvider.append("assistant", `Unable to respond: ${text}`, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    } else {
      // Nothing was ever written to chat-v1.json for this send, so report
      // the failure as a notification rather than an assistant reply with
      // no visible user message to answer.
      NotificationRouter.showError(`Unable to send: ${text}`);
    }
    return;
  }

  if (proposedAction) {
    const action = getStageChatAction(proposedAction.id);
    if (!action) return;
    const chatTarget = { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath };
    if (!currentTaskStore) {
      await chatViewProvider.append(
        "assistant",
        `_The proposed "${action.label}" action could not be executed in this context._`,
        targetStage,
        chatTarget
      );
      return;
    }
    const outcome = await executeProposedAction(
      {
        inventory,
        currentTaskStore,
        assistantFolderUri: vscode.Uri.file(task.taskFolderPath),
        pendingOperations: new PendingOperationsStore(context.workspaceState),
      },
      {
        operationId: action.id,
        payload: buildStageActionPayload(action, task.taskFolderPath, proposedAction.payload),
      }
    );
    await chatViewProvider.append("assistant", outcome, targetStage, chatTarget);
  }
}

/**
 * Drive an explicit Chat Resume of a `chatSend.v1` structured-question interaction.
 */
export async function resumeChatSendInteractionV1(
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }
  const taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    return { ok: false, reason: "the task has no owning workspace" };
  }

  const model = await resolveFreshModelForStage(taskFolderUri, ownedTask.progress.currentStage);
  if (!model.modelId) {
    return { ok: false, reason: "no model is configured for this stage" };
  }
  const { availability, providerLabel } = await checkRunnerAvailabilityForModel(
    model.modelId,
    ownedTask.progress.currentStage
  );
  if (!availability.available) {
    return {
      ok: false,
      reason: `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}`,
    };
  }
  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: ownedTask.progress.currentStage }),
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
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: ownedTask.progress.currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  if (outcome.kind === "completed") {
    await chatViewProvider.open({
      canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
      taskFolderPath: ownedTask.taskFolderPath,
      stage: ownedTask.progress.currentStage,
      taskName: ownedTask.progress.displayName,
    });
  } else if (outcome.kind === "questions") {
    const record = await orchestrator.getRecord(interactionRef);
    if (record) {
      await chatViewProvider.askInteraction({
        canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
        taskFolderPath: ownedTask.taskFolderPath,
        stage: record.stage,
        taskName: ownedTask.progress.displayName,
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
    return { ok: false, reason: "Resume failed to settle the interaction" };
  }
  return { ok: true, settlement };
}



export function registerChatWithStageCommand(context: vscode.ExtensionContext, inventory: TaskInventory, chatViewProvider: ChatViewProvider, currentTaskStore?: CurrentTaskStore): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage", (arg?: ChatWithStageArg) => chatWithStage(context, inventory, chatViewProvider, arg, currentTaskStore)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.postStageQuestion",
    // This command IS the notification's own "Open Chat" action — the user
    // already saw the "waiting for feedback" notification that led them
    // here, so re-invoking ask() must not raise another one.
    (question: import("../views/chatView").StageChatQuestion) => chatViewProvider.ask(question, false, false)
  ));
}
