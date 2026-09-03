import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import {
  IMPLEMENTATION_SUMMARY_FILENAME,
  PLAN_FILENAME,
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
import { runTrackedOperation, resolveWorkflowRootTaskName } from "../utils/taskOperations";
import {
  readTextIfExists,
  statIfExists,
} from "../utils/fileUtils";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import {
  computeReviewFreshness,
  parseReviewBlockers,
  parseReviewedCommitSha,
  REVIEWED_COMMIT_STAGES,
} from "../utils/reviewReadiness";
import { filterSupersededBlockersV1 } from "../utils/reviewEvidenceNormalizerV1";
import { BlockerSupersessionRecordV1, PLAN_REVIEW_STAGES } from "../types/taskProgress";
import { executeProposedAction } from "../utils/globalAssistantActions";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
} from "../services/workflowRuntimeServicesV1";
import { readChatDocumentIdentityV1, readChatHistory, ChatMessage } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  admitAndContinueWithMalformedResultRetryV1,
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
} from "../actions/productionTaskActionRuntimeV1";
import {
  CHAT_SEND_ACTION_KEY_V1,
  ChatSendActionInputV1,
  validateChatSendInputV1,
  writeMarkdownUpdateV1,
} from "../actions/rows/chatSendRowV1";
import { resolveMarkdownUpdateTarget as resolveMarkdownUpdateTargetV1 } from "../utils/chatFileUpdateEnvelope";
import { ChatInteractionRefV1, ChatInteractionResumeResultV1 } from "../views/chatView";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { appendBlockerSupersession } from "../utils/taskProgressTransforms";

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

// Stage-action envelope definitions, the pinned catalog, extraction, and
// payload pinning now live in utils/chatStageActionEnvelope.ts (so
// actions/rows/chatSendRowV1.ts — the production write path — can depend on
// them without a commands -> actions -> commands import cycle). Re-exported
// here unchanged so existing imports of this module keep working.
export {
  StageChatActionDefinition,
  STAGE_CHAT_ACTIONS,
  getStageChatAction,
  StageChatActionProposal,
  splitStageActionEnvelopes,
  buildStageActionPayload,
} from "../utils/chatStageActionEnvelope";
import {
  STAGE_CHAT_ACTIONS,
  getStageChatAction,
  buildStageActionPayload,
  StageChatActionProposal,
} from "../utils/chatStageActionEnvelope";

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
 *
 * Deliberately advertises no bracket-style clarification envelope (no
 * `[[QUESTION]]...[[/QUESTION]]`): a prior revision did, but nothing ever
 * parsed it — it silently leaked raw markup into the transcript whenever a
 * model used it, discovered while wiring `splitStageActionEnvelopes`
 * (task: "Actionable Hand-offs", PART 3) as a second, unrelated instance of
 * the same "advertised but unconsumed envelope" defect. The real mechanism
 * is `buildAiResultContractPromptV1`'s JSON `"kind": "questions"` envelope
 * (`taskActionCoordinatorV1.ts` appends it after this prompt for every row,
 * including `chatSend.v1`), which IS wired end to end via
 * `outcome.kind === "questions"` below. Do not reintroduce a second,
 * competing clarification format here without wiring a parser for it too.
 */
export function buildStageResponsePrompt(
  stageName: string, taskName: string, taskArtifacts: string, contextPack: string, message: string, conversation = ""
): string {
  const artifactsSection = taskArtifacts.trim().length > 0
    ? `\n\nTask's plan and current stage artifact (always included, regardless of open editor tabs):\n${taskArtifacts}`
    : "";
  return `You are answering a user question about the ${stageName} stage for task ${taskName}.\n\nDo not invoke tools or propose that code changes were applied. If the user asks you to make a code change, tell them to use the stage action that applies it explicitly instead. However, the user may ask you to update this task's own markdown files (its task description, plan, or a review file) — this is not a file-edit action and uses no edit or write tool, so it is unaffected by any read-only or plan-mode restriction on your tool use: you are only composing text in your reply, and a separate already-trusted process outside this conversation reads that text and applies it on your behalf, the same as if you were dictating a paragraph for someone else to type. To draft an update, put the file's full new content, and nothing else, wrapped in \`[[UPDATE_FILE:relative-filename.md]]\`...\`[[/UPDATE_FILE]]\`, using a path relative to this task's own folder. Only one file may be drafted per response, only \`.md\` files inside this task's folder may be targeted this way, and you must never target a source code file. If you conclude in this conversation that a blocker recorded in this task's current review or plan is resolved by something the user just told you, draft that decision into the relevant file with \`[[UPDATE_FILE:...]]\` as part of saying so, rather than only stating it in your reply, and also end your response with \`[[RESOLVES_BLOCKER]]\` on its own line — this is how the extension knows YOU concluded this specific draft resolves the recorded blocker, rather than guessing from the wording of your edit; include it only when that is genuinely your conclusion, and never for an edit that merely discusses, restates, or promises to resolve the blocker later. Drafting the update is NOT the same as it taking effect: the user must still confirm it in a dialog after this response, outside this conversation turn, so you cannot know here whether it will be accepted, declined, or fail to apply. Until you have actually drafted that update, say "this resolves it once recorded — shall I write it to plan.md?" and do not advise completing this stage or advancing to the next one, since the artifacts on record still show the blocker outstanding — and that restriction still applies in the very same response where you draft the update, since nothing has been written yet at that point either. Only treat the blocker as resolved, and it becomes safe to advise advancing, on a LATER turn once this conversation's own history shows a message beginning "_Updated \`<file>\`._" for that exact update — the sole confirmation the write actually landed. A declined confirmation instead reports "_...was not confirmed; nothing was written._" in this same conversation; if you see that, the blocker is still outstanding, so say so plainly, do not advise advancing, and offer to draft the update again if the user still wants it applied. You may also run this task's own stage actions when the user asks for one: end your response with a single \`[[ACTION:<actionId>]]\` envelope (the same typed action protocol the global assistant uses; the legacy \`[[STAGE_ACTION:<actionId>]]\` form is also accepted) and the extension will confirm with the user and run it. Available action ids: ${describeStageActionsForPrompt()}. Propose at most one action per response, only when the user clearly asked for it — never speculatively. For other task-lifecycle requests (pausing, archiving, pinning, renaming, running or fast-forwarding reviews, …), point the user at the Global Assistant chat, which can run those. Give a concise, useful answer alongside any update or action.\n\nConversation so far:\n${conversation.slice(-12000)}${artifactsSection}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}`;
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
  targetStage: TaskStage,
  /**
   * wf10 item 19 (review-flagged 2026-08-25, new completion blocker): the
   * ONLY production consumer of `TaskProgress.blockerSupersessions` for a
   * plan-review stage — the two consumers that field's own doc comment
   * claimed (`buildSoleBlockerReconcileGuidanceV1`,
   * `postReviewPlateauDecisionV1`) never actually match a plan-review-scoped
   * record: the former only ever iterates `IMPL_REVIEW_STAGES`, and the
   * latter is deliberately never called with a supersession filter (fresh
   * round evidence must never be masked — see `filterSupersededBlockersV1`'s
   * doc comment). Without a real consumer, a human reopening this stage's
   * chat after confirming a resolving edit would still be shown the review
   * artifact's raw, unannotated blocker text as if nothing had happened.
   * Optional so every other caller (and the coverage test) keeps working
   * unchanged; omit to get the artifact with no annotation.
   */
  blockerSupersessions?: readonly BlockerSupersessionRecordV1[]
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
      // wf10 item 19: this artifact's own blocker text is never rewritten
      // when a human resolves it via chat (item 19 explicitly does not
      // require a fresh review round) — so, for a plan-review stage with
      // recorded supersessions, note beneath the raw text which listed
      // blocker(s) a confirmed `plan.md` edit already resolved. Bound to
      // THIS artifact's own mtime (`filterSupersededBlockersV1`'s
      // `reviewAsOfMs`), so a supersession recorded against an OLDER version
      // of this same file never suppresses a blocker a later, still-current
      // review round re-asserted.
      if (PLAN_REVIEW_STAGES.includes(targetStage) && blockerSupersessions?.length) {
        const stat = await statIfExists(vscode.Uri.joinPath(taskFolderUri, stageFilename));
        const allBlockers = parseReviewBlockers(stageContent);
        const stillOutstanding = new Set(
          filterSupersededBlockersV1(targetStage, allBlockers, blockerSupersessions, stat?.mtime).map(
            (blocker) => blocker.description.trim()
          )
        );
        const supersededBlockers = allBlockers.filter(
          (blocker) => !stillOutstanding.has(blocker.description.trim())
        );
        for (const blocker of supersededBlockers) {
          const record = blockerSupersessions.find(
            (entry) =>
              entry.stage === targetStage &&
              entry.blockerDescription.trim() === blocker.description.trim()
          );
          section +=
            `\n\n> ✅ Superseded: the blocker "${blocker.description}" was marked resolved on ` +
            `${record?.supersededAt ?? "an earlier date"} by a confirmed edit to \`${record?.planRelPath ?? PLAN_FILENAME}\`` +
            (record?.confirmingMessageAt ? ` (confirmed in the chat exchange at ${record.confirmingMessageAt})` : "") +
            " — treat it as no longer outstanding unless this file has since been re-reviewed and re-asserts it.";
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

  // The Publish checks sections used to live in a separate publish-checks.md,
  // read here as its own block — but that file is now frozen legacy (plan
  // item 17, step 20): the checks are spliced directly into publish-review.md
  // under "## Verification (ground truth)", so the `stageFilename` block
  // above already carries them, current as of this task's latest run, for
  // `targetStage === "publish"`. Re-reading the legacy file here would only
  // ever surface content frozen at the moment of the artifact-unification
  // upgrade, presented as if it were the latest report — the exact stale-
  // evidence failure this unification exists to eliminate.

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
  let proposedBlockerSupersessionEdit: ChatMessage["proposedBlockerSupersessionEdit"];
  // The proposing assistant message's own timestamp — the durable pointer to
  // the confirming chat exchange a supersession record carries (see
  // `BlockerSupersessionRecordV1.confirmingMessageAt`'s doc comment).
  let proposedBlockerSupersessionEditAt: string | undefined;
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
      taskName: resolveWorkflowRootTaskName(task.progress.displayName ?? task.folderName, task.taskFolderPath),
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
    const taskArtifacts = await readStageArtifactsForChat(
      taskFolderUri,
      targetStage,
      task.progress.blockerSupersessions
    );
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
      // Completed message has already been written to chat-v1.json by
      // promoteChatSendContentV1, which also attached any recognized stage-
      // action proposal to that message (`proposedStageAction`) rather than
      // executing it itself — execution needs vscode.window (a confirmation
      // dialog), unavailable inside that pure promotion path.
      const history = await readChatHistory(task.taskFolderPath, task.canonicalId);
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      proposedAction = lastAssistant?.proposedStageAction;
      proposedBlockerSupersessionEdit = lastAssistant?.proposedBlockerSupersessionEdit;
      proposedBlockerSupersessionEditAt = lastAssistant?.at;
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
    await dispatchProposedStageActionV1(
      context,
      inventory,
      currentTaskStore,
      chatViewProvider,
      task.taskFolderPath,
      task.canonicalId,
      targetStage,
      proposedAction
    );
  }
  if (proposedBlockerSupersessionEdit) {
    await dispatchProposedBlockerSupersessionEditV1(
      chatViewProvider,
      task.taskFolderPath,
      task.canonicalId,
      targetStage,
      proposedBlockerSupersessionEdit,
      proposedBlockerSupersessionEditAt
    );
  }
}

/**
 * Executes a stage-chat action proposal recognized during promotion
 * (`promoteChatSendContentV1` persisted it as `proposedStageAction` on the
 * assistant message it just wrote) and appends a visible outcome — applied,
 * or refused with the reason — as a follow-up assistant message. The
 * envelope itself never survives into the displayed text (stripped at
 * promotion time); this is the second half of that contract: a stripped
 * envelope must still produce a visible acknowledgement, never a silent
 * drop. Shared by the initial send and the Resume path, since both can
 * produce a `proposedStageAction` via the same promotion function.
 *
 * @internal exported for testing — stageChatActions.test.ts exercises the
 * applied, declined-confirmation, and rejected-validation branches end to
 * end through this function (not just the pure planner), since a review
 * found the prior test suite never reached the actual dispatcher.
 */
export async function dispatchProposedStageActionV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore | undefined,
  chatViewProvider: ChatViewProvider,
  taskFolderPath: string,
  canonicalId: string,
  targetStage: TaskStage,
  proposedAction: StageChatActionProposal
): Promise<void> {
  const chatTarget = { canonicalId, taskFolderPath };
  const action = getStageChatAction(proposedAction.id);
  if (!action) {
    // Defense in depth: promoteChatSendContentV1 already filters to
    // recognized ids before persisting a proposal, so this branch should be
    // unreachable — but a silent return here would recreate exactly the
    // silently-dropped-action defect this wiring exists to fix.
    await chatViewProvider.append(
      "assistant",
      `_The proposed action ("${proposedAction.id}") is not one of this task's recognized stage actions; it was rejected and nothing was executed._`,
      targetStage,
      chatTarget
    );
    return;
  }
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
      assistantFolderUri: vscode.Uri.file(taskFolderPath),
      pendingOperations: new PendingOperationsStore(context.workspaceState),
    },
    {
      operationId: action.id,
      payload: buildStageActionPayload(action, taskFolderPath, proposedAction.payload),
    }
  );
  await chatViewProvider.append("assistant", outcome, targetStage, chatTarget);
}

/**
 * wf10 item 19: confirms and applies a chat-drafted plan edit recognized
 * (`detectBlockerSupersessionCandidateV1`, `actions/rows/chatSendRowV1.ts`)
 * as resolving this stage's sole recorded review blocker. Mirrors
 * `dispatchProposedStageActionV1`'s shape — the write is proposed rather
 * than auto-applied specifically because it needs a `vscode.window`
 * confirmation dialog naming the exact blocker text it would resolve, which
 * the pure promotion path that recognized it cannot show.
 *
 * @internal exported for testing
 */
export async function dispatchProposedBlockerSupersessionEditV1(
  chatViewProvider: ChatViewProvider,
  taskFolderPath: string,
  canonicalId: string,
  targetStage: TaskStage,
  proposedEdit: NonNullable<ChatMessage["proposedBlockerSupersessionEdit"]>,
  /** The proposing assistant message's own `at` timestamp — recorded on the
   * supersession entry as the durable pointer to the confirming chat
   * exchange (`BlockerSupersessionRecordV1.confirmingMessageAt`). Absent only
   * when the caller could not find the proposing message (defense in depth;
   * should not happen in practice since the proposal is always read back
   * from the message that just carried it). */
  confirmingMessageAt?: string
): Promise<void> {
  const chatTarget = { canonicalId, taskFolderPath };
  const targetPath = resolveMarkdownUpdateTargetV1(taskFolderPath, proposedEdit.relPath);
  if (!targetPath) {
    await chatViewProvider.append(
      "assistant",
      `_Could not apply the drafted update to \`${proposedEdit.relPath}\`: the target is no longer a valid file inside this task's folder._`,
      targetStage,
      chatTarget
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Apply the drafted update to "${proposedEdit.relPath}"?\n\nThis would resolve the blocker:\n"${proposedEdit.blockerDescription}"\n\n` +
      "A fresh review is the stronger confirmation, but is not required for this write to land.",
    { modal: true },
    "Apply Update"
  );
  if (choice !== "Apply Update") {
    await chatViewProvider.append(
      "assistant",
      `_The drafted update to \`${proposedEdit.relPath}\` was not confirmed; nothing was written._`,
      targetStage,
      chatTarget
    );
    return;
  }
  const outcome = await writeMarkdownUpdateV1(taskFolderPath, proposedEdit.relPath, targetPath, proposedEdit.content);
  if (/^_Updated /.test(outcome)) {
    // wf10 item 19: record the durable supersession the moment the write
    // actually lands, not just the confirmation — a declined or failed write
    // (checked above) must never suppress a stage gate from reading the
    // blocker as outstanding, since nothing was actually resolved on disk.
    // See `TaskProgress.blockerSupersessions`'s doc comment for how this
    // record is read back. Two production consumers as of 2026-08-25:
    // `readStageArtifactsForChat` (this same module, feeds the chat model's
    // prompt context) and `computePlanReviewBlockerSupersessionEvidenceV1`
    // (`reconcilePlanChecklist.ts`, surfaces it as durable evidence in the
    // reconcile decision panel — a real on-screen surface, not just chat
    // context). `postReviewPlateauDecisionV1` (`reviewEscalation.ts`)
    // deliberately never filters, since the evidence it reads is always THIS
    // round's own just-published, still-fresh finding — see
    // `filterSupersededBlockersV1`'s doc comment.
    await patchTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), (current) =>
      appendBlockerSupersession(current, {
        stage: proposedEdit.reviewStage,
        blockerDescription: proposedEdit.blockerDescription,
        supersededAt: new Date().toISOString(),
        planRelPath: proposedEdit.relPath,
        ...(confirmingMessageAt ? { confirmingMessageAt } : {}),
      })
    );
  }
  await chatViewProvider.append("assistant", outcome, targetStage, chatTarget);
}

/**
 * Drive an explicit Chat Resume of a `chatSend.v1` structured-question interaction.
 */
export async function resumeChatSendInteractionV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore | undefined,
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

  let proposedAction: StageChatActionProposal | undefined;
  let proposedBlockerSupersessionEdit: ChatMessage["proposedBlockerSupersessionEdit"];
  // The proposing assistant message's own timestamp — the durable pointer to
  // the confirming chat exchange a supersession record carries (see
  // `BlockerSupersessionRecordV1.confirmingMessageAt`'s doc comment).
  let proposedBlockerSupersessionEditAt: string | undefined;
  if (outcome.kind === "completed") {
    const history = await readChatHistory(ownedTask.taskFolderPath, ownedTask.canonicalId ?? ownedTask.taskFolderPath);
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    proposedAction = lastAssistant?.proposedStageAction;
    proposedBlockerSupersessionEdit = lastAssistant?.proposedBlockerSupersessionEdit;
    proposedBlockerSupersessionEditAt = lastAssistant?.at;
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
  if (proposedAction) {
    await dispatchProposedStageActionV1(
      context,
      inventory,
      currentTaskStore,
      chatViewProvider,
      ownedTask.taskFolderPath,
      ownedTask.canonicalId ?? ownedTask.taskFolderPath,
      ownedTask.progress.currentStage,
      proposedAction
    );
  }
  if (proposedBlockerSupersessionEdit) {
    await dispatchProposedBlockerSupersessionEditV1(
      chatViewProvider,
      ownedTask.taskFolderPath,
      ownedTask.canonicalId ?? ownedTask.taskFolderPath,
      ownedTask.progress.currentStage,
      proposedBlockerSupersessionEdit,
      proposedBlockerSupersessionEditAt
    );
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
