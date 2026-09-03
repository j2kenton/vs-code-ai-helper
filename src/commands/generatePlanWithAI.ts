import * as vscode from "vscode";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { updateTaskProgressStage } from "../utils/taskProgressTransforms";
import { formatPlanRevisionProposalVariableV1, listCheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readNonEmptyText } from "../utils/fileUtils";
import { IncompleteTask } from "../types/incompleteTask";
import {
  generateContextPack,
  writeContextPackContent,
} from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import {
  describeTaskActionFailureV1,
  describeTaskActionOutcomeForLogV1,
} from "../utils/taskActionOutcomeTextV1";
import { pickTaskFolder } from "../utils/pickTaskFolder";
import { checkRunnerAvailabilityForModel } from "../runners/runnerRegistry";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { TASK_FILENAME, TaskStage } from "../types/taskProgress";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { TaskInventory } from "../state/taskInventory";
import { NotificationRouter } from "../utils/notificationRouter";
import { attributionHeader, safeOpenTextDocument } from "../utils/fileUtils";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

import {
  AutoTriggerMode,
  getAutoReviewAfterPlanMode,
  getCompleteAndMoveOnTriggersAIMode,
  strongestAutoTriggerMode,
} from "../config/settings";
import { scheduleAutomationChain } from "../utils/automationChain";
import {
  linkCancellationTokens,
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
  reportStageStartingV1,
  reportStageRunningV1,
  resolveWorkflowRootTaskName,
} from "../utils/taskOperations";
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
} from "../actions/productionTaskActionRuntimeV1";
import { TaskActionCoordinatorV1 } from "../actions/taskActionCoordinatorV1";
import {
  ActionConversationOrchestratorV1,
  InteractionRefV1,
} from "../actions/actionConversationOrchestratorV1";
import {
  GENERATE_PLAN_ACTION_KEY_V1,
  GENERATE_PLAN_TARGET_RELATIVE_PATH_V1,
  GeneratePlanActionInputV1,
} from "../actions/rows/generatePlanRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import {
  ChatInteractionRefV1,
  ChatInteractionResumeResultV1,
  ChatViewProvider,
} from "../views/chatView";

/**
 * Stages a task may be in for plan generation to be safe: either at the
 * task-description stage (first generation) or the plan stage (regeneration).
 */
const ELIGIBLE_STAGES: readonly TaskStage[] = ["desc", "plan"];

/**
 * Accepted argument shapes for generatePlanWithAI.
 *
 * Commands may be invoked from:
 *   - Tree stage-row buttons: the tree node itself, which has `.task: IncompleteTask`
 *     and `.stage: TaskStage` (StageNode shape)
 *   - Tree task-row buttons / IncompleteTask wrappers: `{ task: IncompleteTask }`
 *   - Keyboard shortcut router: `{ canonicalId?: string }`
 *   - Legacy direct URI (kept for backward compat): vscode.Uri
 *   - Command palette (no arg): undefined
 */
type GeneratePlanArg =
  | vscode.Uri
  | { canonicalId?: string }
  | { task?: IncompleteTask }
  | {
      taskFolderPath?: string;
      /**
       * Carried only by automation-chain dispatches from "Complete & Move On
       * triggers AI: auto-fast-forward". A successful plan generation then
       * advances to Plan High-Level Review and runs the Fast Forward loop,
       * even when the standalone auto-review-after-plan setting is off or
       * plain "auto". Never set by UI surfaces.
       */
      followUpReviewMode?: "auto-fast-forward";
    };

/**
 * Normalize a GeneratePlanArg into a resolved value for the caller to act on.
 *
 * Returns:
 *   - A `vscode.Uri` when the target folder is unambiguously resolved
 *     (direct Uri, `{ task }` shape, or `{ taskFolderPath }` shape).
 *   - `{ canonicalId: string }` sentinel when the arg carries only a canonical
 *     ID that was not found in the inventory — the caller must fail clearly
 *     rather than silently opening a folder picker.
 *   - `undefined` to fall through to the user folder picker (no arg, empty
 *     object, or `{ task: undefined }`).
 *
 * @internal exported for testing
 */
export function normalizeGeneratePlanArg(
  arg: GeneratePlanArg | undefined,
  inventory: TaskInventory
): vscode.Uri | { canonicalId: string } | undefined {
  if (!arg) {
    return undefined;
  }

  // Direct URI (legacy shape, e.g. right-click in explorer)
  if (arg instanceof vscode.Uri) {
    return arg;
  }

  // Tree stage-row shape: StageNode has `.task: IncompleteTask`. Guarded on
  // folderUri: the keyboard-shortcut router (applyCurrentStageAction)
  // dispatches { canonicalId, taskFolderPath, task: { progress } } — a
  // partial task with no folderUri — which must resolve via the explicit
  // fields below rather than returning undefined here (which would silently
  // open the folder picker and could retarget a different task).
  if ("task" in arg && arg.task && arg.task.folderUri?.fsPath) {
    return arg.task.folderUri;
  }

  // Explicit folder path (e.g. from applyHighLevelReviewChanges delegation)
  if ("taskFolderPath" in arg && arg.taskFolderPath) {
    return vscode.Uri.file(arg.taskFolderPath);
  }

  // Canonical ID — resolve via inventory
  if ("canonicalId" in arg && arg.canonicalId) {
    const task = inventory.getTaskById(arg.canonicalId);
    if (task) {
      return vscode.Uri.file(task.taskFolderPath);
    }
    // Return a sentinel so the caller can report the failure rather than
    // silently falling through to the folder picker.
    return { canonicalId: arg.canonicalId };
  }

  return undefined;
}

/**
 * Generate plan.md for a task folder using the user's Copilot access.
 * No overwrite confirmation is shown since the user has already triggered
 * this action deliberately.
 *
 * When `targetFolderUri` is given (e.g. right after creating or resuming a
 * specific task), that task is used directly instead of prompting the user
 * to pick one.
 *
 * Requires first-use consent (ensureAiConsent) before any provider is
 * launched or any file is written.
 */
export async function generatePlanWithAI(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  arg?: GeneratePlanArg
): Promise<boolean | undefined> {
  assertLegacyAiRouteAllowedV0("generatePlan.v1");
  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  // Resolve the target task folder URI from the argument.
  let taskFolderUri: vscode.Uri | undefined;

  const normalized = normalizeGeneratePlanArg(arg, inventory);

  if (normalized === undefined) {
    // No arg or unresolvable arg — prompt user to pick
    taskFolderUri = await pickTaskFolder("Generate Plan with AI", ELIGIBLE_STAGES);
  } else if (normalized instanceof vscode.Uri) {
    taskFolderUri = normalized;
  } else {
    // Sentinel: canonicalId was provided but not found in the inventory.
    // After a refresh attempt the inventory still doesn't know this task —
    // fail clearly rather than silently acting on a different task.
    await inventory.refresh();
    const retried = inventory.getTaskById(normalized.canonicalId);
    if (retried) {
      taskFolderUri = vscode.Uri.file(retried.taskFolderPath);
    } else {
      NotificationRouter.showError(
        `Task with ID "${normalized.canonicalId}" not found. It may have been deleted or moved.`
      );
      return;
    }
  }

  if (!taskFolderUri) {
    return;
  }

  // The stage's own auto-review setting combined with a chained fast-forward
  // request from "Complete & Move On triggers AI: auto-fast-forward" —
  // whichever is stronger wins, so the chained request fires even when the
  // standalone setting is off, and a standalone "auto-fast-forward" is never
  // downgraded by a plain chained dispatch.
  //
  // The chained marker is re-validated against the setting that minted it:
  // it was only ever attached while "Complete & Move On triggers AI" was
  // "auto-fast-forward", so a queued/stale arg must not resurrect the loop
  // after the user turned that setting off or downgraded it.
  const currentChainedReviewMode = (): "auto-fast-forward" | undefined =>
    arg && !(arg instanceof vscode.Uri) && "followUpReviewMode" in arg &&
    arg.followUpReviewMode === "auto-fast-forward" &&
    getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
      ? arg.followUpReviewMode
      : undefined;
  const chainedReviewMode = currentChainedReviewMode();
  const effectiveReviewMode = strongestAutoTriggerMode(
    getAutoReviewAfterPlanMode(),
    chainedReviewMode
  );

  const lockKey = taskFolderUri.fsPath;
  // This is a workflow root (carries a `stage`) — the Notifications row must
  // show the task's real name, never a raw basename(taskPath) computed here
  // in the caller (that would silently reproduce the exact "wf10" vs
  // "2026-07-17_task_1" regression this task exists to prevent). An
  // un-renamed task's displayName IS the raw folder name, which
  // taskOperations.begin's workflow-root guard now rejects unconditionally
  // (explicit or not) — resolveWorkflowRootTaskName reformats it so the
  // guard never refuses a legitimate, un-renamed task. If the inventory
  // hasn't indexed this task yet (e.g. a race right after creation),
  // refresh once and fail safely rather than falling through to a
  // synthesized name.
  let resolvedForDisplay = inventory.getTaskByPath(lockKey);
  if (!resolvedForDisplay) {
    await inventory.refresh();
    resolvedForDisplay = inventory.getTaskByPath(lockKey);
  }
  if (!resolvedForDisplay) {
    NotificationRouter.showError(
      `Task at "${lockKey}" could not be resolved. It may have been deleted or moved.`
    );
    return;
  }
  const taskName = resolveWorkflowRootTaskName(
    resolvedForDisplay.progress.displayName ?? resolvedForDisplay.folderName,
    lockKey
  );
  const result = await runTrackedOperation(
    lockKey,
    { label: "Generate Plan", stage: "plan", taskName, kind: "generate-plan", cancellable: true },
    (op) =>
      generatePlanWithAIForResolvedTask(
        context, inventory, chatViewProvider, taskFolderUri, op, effectiveReviewMode
      )
  );
  if (!result) {
    // Refused (another operation holds this task's lock) — the busy warning
    // was already shown by runTrackedOperation.
    return;
  }

  // Dispatched through the automation-chain scheduler. This run's own lock
  // was already released above (runTrackedOperation returned), so no root
  // operation is passed and the follow-up runs immediately — but the chain
  // still goes through the single lock-safe dispatch point.
  if (result.triggerAutoReview && result.taskFolderPath) {
    // "auto-fast-forward" runs the review + fixes loop instead of a single
    // review pass.
    const command = effectiveReviewMode === "auto-fast-forward"
      ? "vs-code-ai-helper.fastForwardReviewWithAI"
      : "vs-code-ai-helper.runReviewWithAI";
    await scheduleAutomationChain({
      command,
      arg: { taskFolderPath: result.taskFolderPath },
      taskKey: result.taskFolderPath,
      chainId: "auto-review",
      // Dropped at fire time if every route to this review (the stage's own
      // auto-review setting and the chained request) is off by then.
      stillEnabled: () =>
        strongestAutoTriggerMode(
          getAutoReviewAfterPlanMode(),
          currentChainedReviewMode()
        ) !== "off",
      intent: {
        trigger: "auto-review after plan generation completes",
        settingKey: "ensemble.autoReviewAfterPlan",
        expectedTiming: "immediately, once plan generation finishes",
        willRetry: false,
        retryNote: "Not retried automatically if dropped — run the review manually.",
      },
    });
  }

  return result.succeeded || undefined;
}

interface GeneratePlanResult {
  succeeded: boolean;
  triggerAutoReview: boolean;
  taskFolderPath?: string;
}

/** A resolved provider/coordinator pair for one generatePlan.v1 invocation. */
interface ResolvedGeneratePlanCoordinatorV1 {
  readonly coordinator: TaskActionCoordinatorV1;
  readonly providerLabel: string;
  /** (2m) Native model id for the run-log attribution header; undefined for providers without one. */
  readonly modelLabel: string | undefined;
  /**
   * The provider-qualified stored model id (e.g. "claude-cli:sonnet@high"),
   * as passed to `reportStageStartingV1`/`TaskOperationHandle.setModel` —
   * distinct from `modelLabel` (the native id used for the run-log
   * attribution header only).
   */
  readonly modelId: string;
}

type ResolveGeneratePlanCoordinatorFailureV1 =
  | { readonly kind: "noModel" }
  | { readonly kind: "unavailable"; readonly providerLabel: string; readonly reason: string };

/**
 * Resolve the stage's configured model, confirm the provider is available,
 * and build a task action coordinator bound to this invocation's workspace
 * cwd and resolved stage model (plan §3.8's registry/runner boundary —
 * `RunnerSelectionOpenerV1` requires a synchronous stage-model resolver, so
 * the async resolution happens once here and the returned closure just
 * echoes the already-resolved value). Shared by the direct command
 * invocation and by an explicit Chat Resume of a `generatePlan.v1`
 * structured-question interaction (plan §6.1).
 */
async function resolveGeneratePlanCoordinatorV1(
  taskFolderUri: vscode.Uri,
  workspaceFolderUri: vscode.Uri
): Promise<
  | { readonly ok: true; readonly value: ResolvedGeneratePlanCoordinatorV1 }
  | { readonly ok: false; readonly failure: ResolveGeneratePlanCoordinatorFailureV1 }
> {
  const model = await resolveFreshModelForStage(taskFolderUri, "plan");
  if (!model.modelId) {
    return { ok: false, failure: { kind: "noModel" } };
  }
  const { availability, providerLabel, nativeModelId } = await checkRunnerAvailabilityForModel(
    model.modelId,
    "plan"
  );
  if (!availability.available) {
    return {
      ok: false,
      failure: { kind: "unavailable", providerLabel, reason: availability.reason ?? "unknown reason" },
    };
  }
  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: "plan" as TaskStage }),
  });
  return { ok: true, value: { coordinator, providerLabel, modelLabel: nativeModelId, modelId } };
}

/** Minimal task identity `handleGeneratePlanOutcomeV1` needs — never a raw filesystem path beyond the task's own folder. */
interface GeneratePlanOutcomeTaskRefV1 {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly taskName?: string;
}

interface GeneratePlanOutcomeContextV1 {
  readonly taskRef: GeneratePlanOutcomeTaskRefV1;
  readonly chatViewProvider: ChatViewProvider;
  readonly orchestrator: ActionConversationOrchestratorV1;
  /**
   * The action-specific prompt this drive rendered, recorded in the run log
   * only. This is the prompt BEFORE the coordinator appends its own AI-result
   * envelope contract block (frame/schema instructions) — see the run-log
   * write below for why that appended block isn't reproduced verbatim here.
   */
  readonly prompt: string;
  /** (2m) Resolved provider/model for the run log's attribution header. */
  readonly providerLabel: string;
  readonly modelLabel: string | undefined;
  readonly effectiveReviewMode: AutoTriggerMode;
}

interface GeneratePlanOutcomeResultV1 {
  readonly succeeded: boolean;
  readonly triggerAutoReview: boolean;
  readonly runLogUri?: vscode.Uri;
}


/**
 * Handle one `generatePlan.v1` coordinator outcome: promote a completed
 * result's already-written plan.md into the task's lifecycle (stage
 * transition, opening the document, notifying the user), raise a `questions`
 * outcome in Chat With AI (never in plan.md — plan §6's universal question
 * flow), or notify the user of cancellation/failure. Shared by the direct
 * command invocation and by an explicit Chat Resume, so both paths behave
 * identically once the coordinator has produced an outcome.
 */
async function handleGeneratePlanOutcomeV1(
  outcome: TaskActionOutcomeV1,
  ctx: GeneratePlanOutcomeContextV1
): Promise<GeneratePlanOutcomeResultV1> {
  const taskFolderUri = vscode.Uri.file(ctx.taskRef.taskFolderPath);
  const planFileUri = vscode.Uri.joinPath(taskFolderUri, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1);

  let succeeded = false;
  let triggerAutoReview = false;

  if (outcome.kind === "completed") {
    // Preserve unrelated fields (implReviewFiles, scheduled metadata, lint
    // results, ...) while updating the stage. The destination stage must be
    // persisted before its automatic follow-up operation begins, so the
    // tree/progress indicator and review eligibility stay aligned with what
    // actually runs next.
    const destinationStage: TaskStage = ctx.effectiveReviewMode !== "off" ? "plan-high-review" : "plan";
    await patchTaskProgressStrictV1(taskFolderUri, (existing) => {
      if (!ELIGIBLE_STAGES.includes(existing.currentStage)) {
        return existing;
      }
      return updateTaskProgressStage(existing, destinationStage);
    });
    succeeded = true;
    triggerAutoReview = ctx.effectiveReviewMode !== "off";
    await safeOpenTextDocument(planFileUri, GENERATE_PLAN_TARGET_RELATIVE_PATH_V1);
    NotificationRouter.showInformation(`${GENERATE_PLAN_TARGET_RELATIVE_PATH_V1} generated.`);
  } else if (outcome.kind === "questions") {
    // Plan §6.1: questions surface in Chat With AI, never in plan.md. The
    // durable Chat interaction transaction is already persisted (the
    // coordinator wrote it through before this outcome surfaced); fetch the
    // full record to mirror it into the task-local Chat display.
    const record = await ctx.orchestrator.getRecord({
      operationId: outcome.correlation.operationId,
      interactionId: outcome.interactionId,
      taskBindingId: outcome.correlation.taskBindingId,
      chatDocumentId: outcome.correlation.chatDocumentId,
      sourceAttemptId: outcome.correlation.attemptId,
    });
    if (record) {
      await ctx.chatViewProvider.askInteraction({
        canonicalId: ctx.taskRef.canonicalId,
        taskFolderPath: ctx.taskRef.taskFolderPath,
        stage: record.stage,
        taskName: ctx.taskRef.taskName,
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
    NotificationRouter.showInformation("Plan generation cancelled.");
  } else {
    NotificationRouter.showError(
      `Plan generation failed: ${describeTaskActionFailureV1(outcome)}. Use the manual planning workflow instead.`
    );
  }

  // (2m) The prompt actually dispatched is ctx.prompt PLUS the AI-result
  // envelope contract block taskActionCoordinatorV1.ts appends internally
  // (buildAiResultContractPromptV1) — a §2.2-permitted, correlation-scoped
  // block this command has no access to reconstruct verbatim (and no need
  // to: it is boilerplate frame/schema instructions, identical in shape
  // across every drive, not diagnostic content). Rather than logging a
  // prompt that silently omits it — the exact gap that made an
  // `invalidFrame` failure look like "the contract was never wired up" when
  // debugging by run log alone — the log says so explicitly. The model
  // header (mirroring CLI run logs' `<!-- Generated by ... -->`) records
  // which provider/model this drive resolved to, so a malformed-result
  // failure is attributable without cross-referencing settings by hand.
  const runLogUri = await writeRunLog(
    taskFolderUri,
    "generatePlan-v1",
    "plan",
    `${attributionHeader(ctx.providerLabel, ctx.modelLabel)}\n\n` +
      `# Prompt\n\n${ctx.prompt}\n\n` +
      "*(The coordinator appends its own AI-result envelope contract block " +
      "to this prompt before dispatch; that block is not reproduced here.)*\n\n" +
      `# Result\n\n${describeTaskActionOutcomeForLogV1(outcome, "plan.md")}`
  );

  return { succeeded, triggerAutoReview, runLogUri };
}

async function generatePlanWithAIForResolvedTask(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  taskFolderUri: vscode.Uri,
  op: TaskOperationHandle,
  /**
   * Effective follow-up review mode: the auto-review-after-plan setting
   * combined (strongest-wins) with any chained fast-forward request from
   * "Complete & Move On triggers AI". Anything other than "off" advances a
   * successful generation to Plan High-Level Review and asks the caller to
   * dispatch that review.
   */
  effectiveReviewMode: AutoTriggerMode
): Promise<GeneratePlanResult> {
  // A direct URI is not an ownership proof. Require the live inventory to
  // resolve it so this command cannot write into an unrelated workspace.
  const ownedTask = inventory.getTaskByPath(taskFolderUri.fsPath);
  if (!ownedTask) {
    NotificationRouter.showError("The selected task is not owned by this workspace.");
    return { succeeded: false, triggerAutoReview: false };
  }
  taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    NotificationRouter.showError("The selected task has no owning workspace.");
    return { succeeded: false, triggerAutoReview: false };
  }

  const resolved = await resolveGeneratePlanCoordinatorV1(taskFolderUri, workspaceFolderUri);
  if (!resolved.ok) {
    if (resolved.failure.kind === "noModel") {
      NotificationRouter.showWarning(
        "No model is configured for the Plan stage. Open Ensemble Settings and choose a primary model before continuing.",
        undefined,
        undefined,
        undefined,
        { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
      );
    } else {
      NotificationRouter.showWarning(
        `${resolved.failure.providerLabel} is unavailable: ${resolved.failure.reason}. Use the manual planning workflow instead.`
      );
    }
    return { succeeded: false, triggerAutoReview: false };
  }
  const { coordinator, providerLabel, modelLabel, modelId } = resolved.value;

  // Notifications in-flight visibility (Part II audit gap): Generate Plan
  // resolves its own "plan"-stage model and dispatches through
  // coordinator.executeAction below, but previously never reported either —
  // the row stayed silent for the whole run. Report the stage transition as
  // soon as the model is known; `stageToken` guards the later "running"
  // report (issued right before the dispatch await) against a stage
  // transition on this same root that supersedes it in the meantime.
  const stageToken = reportStageStartingV1(op, modelId);

  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  let taskContent: string;
  try {
    // Prefer open document buffer for unsaved changes
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === taskFileUri.toString()
    );
    if (openDoc) {
      taskContent = openDoc.getText().trim();
    } else {
      const content = await vscode.workspace.fs.readFile(taskFileUri);
      taskContent = new TextDecoder().decode(content).trim();
    }
  } catch {
    taskContent = "";
  }
  if (taskContent.length === 0) {
    NotificationRouter.showWarning(
      `${TASK_FILENAME} is empty. Describe the task before generating a plan.`
    );
    return { succeeded: false, triggerAutoReview: false };
  }

  // Build the context pack IN MEMORY — do NOT write context-pack.md yet.
  // The size gate below may abort or the user may decline; in either case
  // no on-disk artifact should be written for this run.
  const contextPackContent = await generateContextPack(
    taskFolderUri,
    workspaceFolderUri
  );

  // Part 6 / item 6: tell the model when this generation is a plan revision
  // (`TaskProgress.planRevision`, set by `applyPlanRevisionPolicyV1`) —
  // including the discovered items it must incorporate and the currently
  // checked items it must never renumber or drop. `plan-final.md` is still
  // the PRE-revision artifact at this point (untouched since the round back
  // at `plan` stage started — see planRevisionV1.ts's doc comment), so its
  // checked items are exactly the ones this revision must preserve.
  const revisionProgress = await readTaskProgressStrictV1(taskFolderUri);
  const planRevision = revisionProgress.ok ? revisionProgress.decoded.progress.planRevision : undefined;
  const priorPlanFinalContent = planRevision
    ? await readNonEmptyText(getCanonicalImplementationUri(taskFolderUri))
    : undefined;
  const planRevisionProposal = formatPlanRevisionProposalVariableV1(
    planRevision,
    priorPlanFinalContent ? listCheckedChecklistItemTextsV1(priorPlanFinalContent) : []
  );

  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "create-plan.md",
    {
      contextPack: contextPackContent,
      planRevisionProposal,
    }
  );

  // ── Prompt-size gate (BEFORE any artifact is written) ────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return { succeeded: false, triggerAutoReview: false };
  }

  // Size gate passed — persist the EXACT same context-pack content that was
  // assembled above (no second generation pass). This ensures context-pack.md
  // on disk is byte-for-byte identical to what was sent in the prompt, even
  // if open buffers change between the two calls.
  await writeContextPackContent(taskFolderUri, contextPackContent);

  // Register (or reconfirm) this task folder as a trusted workflow mutation
  // root and derive its ownership-backed binding (plan §3.9) — the identity
  // every coordinator invocation correlates against.
  let taskBindingId: string;
  try {
    const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
    const verified = getVerifiedTaskBindingIdV1(rootId);
    if (!verified) {
      NotificationRouter.showError(
        "Plan generation failed: this task's ownership binding could not be verified."
      );
      return { succeeded: false, triggerAutoReview: false };
    }
    taskBindingId = verified;
  } catch (error) {
    NotificationRouter.showError(
      `Plan generation failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { succeeded: false, triggerAutoReview: false };
  }
  const chatIdentity = await readChatDocumentIdentityV1(
    taskFolderUri.fsPath,
    ownedTask.canonicalId ?? taskFolderUri.fsPath
  );
  const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

  // Capture plan.md's current revision (if it exists) so the row's
  // promotion is a revision-checked replacement (plan §6.2): a concurrent
  // edit made while the provider is thinking is detected and refused rather
  // than clobbered.
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
  const targetLocator = { rootId, relativePath: GENERATE_PLAN_TARGET_RELATIVE_PATH_V1 };
  const fileStore = getWorkflowFileStoreV1();
  const statResult = await fileStore.stat(targetLocator);
  if (statResult.kind === "unavailable" || statResult.kind === "failed") {
    NotificationRouter.showError(
      `Plan generation failed: could not check ${GENERATE_PLAN_TARGET_RELATIVE_PATH_V1} (${statResult.code}).`
    );
    return { succeeded: false, triggerAutoReview: false };
  }
  const baselineRevision =
    statResult.value.kind === "file" ? statResult.value.revision : undefined;

  const validatedInput: GeneratePlanActionInputV1 = {
    prompt,
    targetLocator,
    ...(baselineRevision !== undefined ? { baselineRevision } : {}),
  };

  let succeeded = false;
  let triggerAutoReview = false;

  // No overwrite confirmation — user has deliberately triggered regeneration
  await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Generating plan with ${providerLabel} (uses your ${providerLabel} quota)...`,
        cancellable: true,
      },
      async (progress, token) => {
        NotificationRouter.emitProgressSummary(
          `Generating plan with ${providerLabel}...`,
          taskOperations.rootOperationIdFor(taskFolderUri.fsPath)
        );

        progress.report({ message: `Waiting for ${providerLabel} response...` });

        reportStageRunningV1(op, stageToken);

        // Cancellable from either surface: the native progress toast and the
        // Notifications-row cancel button both abort the same provider run.
        const linked = linkCancellationTokens(token, op.token);
        let outcome: TaskActionOutcomeV1;
        try {
          outcome = await coordinator.executeAction({
            actionKey: GENERATE_PLAN_ACTION_KEY_V1,
            taskBinding: { taskBindingId, chatDocumentId },
            taskStatus: ownedTask.progress.status ?? "active",
            taskStage: ownedTask.progress.currentStage,
            rawInput: validatedInput,
            cancellationToken: linked.token,
          });
        } finally {
          linked.dispose();
        }

        const handled = await handleGeneratePlanOutcomeV1(outcome, {
          taskRef: {
            taskFolderPath: taskFolderUri.fsPath,
            canonicalId: ownedTask.canonicalId ?? taskFolderUri.fsPath,
            taskName: ownedTask.progress.displayName,
          },
          chatViewProvider,
          orchestrator: getProductionActionConversationOrchestratorV1(),
          prompt,
          providerLabel,
          modelLabel,
          effectiveReviewMode,
        });
        succeeded = handled.succeeded;
        triggerAutoReview = handled.triggerAutoReview;
        if (handled.runLogUri) {
          op.setResultTargetUri(handled.runLogUri);
        }
      }
    );
  return { succeeded, triggerAutoReview, taskFolderPath: taskFolderUri.fsPath };
}

/**
 * Drive an explicit Chat Resume of a `generatePlan.v1` structured-question
 * interaction (plan §5.5 / §6.1 / AC-QUESTION-03): re-resolve the stage
 * model/provider, run the coordinator's `resumeAction`, and handle the
 * resulting outcome exactly like a fresh invocation (promote a completed
 * result, raise a fresh `questions` interaction, or notify cancellation/
 * failure). Called from extension.ts's `ChatInteractionServicesV1.resume`
 * wiring once the interaction's recorded actionKey resolves to
 * `generatePlan.v1`.
 */
export async function resumeGeneratePlanInteractionV1(
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

  const resolved = await resolveGeneratePlanCoordinatorV1(taskFolderUri, workspaceFolderUri);
  if (!resolved.ok) {
    return {
      ok: false,
      reason:
        resolved.failure.kind === "noModel"
          ? "no model is configured for the Plan stage"
          : `${resolved.failure.providerLabel} is unavailable: ${resolved.failure.reason}`,
    };
  }
  const { coordinator, providerLabel, modelLabel } = resolved.value;
  const orchestrator = getProductionActionConversationOrchestratorV1();

  const interactionRef: InteractionRefV1 = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };

  // The persisted transaction's validated-input snapshot carries this
  // drive's original prompt (recorded for the run log only — the coordinator
  // itself reconstructs and revalidates the action from the snapshot).
  const before = await orchestrator.loadInteraction(interactionRef);
  let prompt = "(prompt unavailable)";
  if (before.kind === "ok") {
    try {
      const snapshot = JSON.parse(before.record.inputSnapshot.canonicalJson) as { prompt?: unknown };
      if (typeof snapshot.prompt === "string") {
        prompt = snapshot.prompt;
      }
    } catch {
      // Best-effort for the run log only.
    }
  }

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: ownedTask.progress.currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  const handled = await handleGeneratePlanOutcomeV1(outcome, {
    taskRef: {
      taskFolderPath: ownedTask.taskFolderPath,
      canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
      taskName: ownedTask.progress.displayName,
    },
    chatViewProvider,
    orchestrator,
    prompt,
    providerLabel,
    modelLabel,
    // Resume has no chained "Complete & Move On" request of its own to
    // combine with — only the standalone stage setting applies.
    effectiveReviewMode: getAutoReviewAfterPlanMode(),
  });

  if (handled.triggerAutoReview) {
    const command = getAutoReviewAfterPlanMode() === "auto-fast-forward"
      ? "vs-code-ai-helper.fastForwardReviewWithAI"
      : "vs-code-ai-helper.runReviewWithAI";
    await scheduleAutomationChain({
      command,
      arg: { taskFolderPath: ownedTask.taskFolderPath },
      taskKey: ownedTask.taskFolderPath,
      chainId: "auto-review",
      stillEnabled: () => getAutoReviewAfterPlanMode() !== "off",
      intent: {
        trigger: "auto-review after plan generation completes",
        settingKey: "ensemble.autoReviewAfterPlan",
        expectedTiming: "immediately, once plan generation finishes",
        willRetry: false,
        retryNote: "Not retried automatically if dropped — run the review manually.",
      },
    });
  }

  // Report the ORIGINAL interaction's actual settlement (re-read after
  // resumeAction, rather than inferred from this drive's outcome kind): a
  // resumed run that itself asks again, fails, or is cancelled still means
  // the interaction being resumed settled exactly once (plan §5.5) — only a
  // rejection BEFORE settlement (binding mismatch, unanswered, already
  // settled under a different id, ...) leaves it unsettled and resumable.
  const after = await orchestrator.loadInteraction(interactionRef);
  const settlement =
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" || after.record.settlement === "supersededByReplacementOperation")
      ? after.record.settlement
      : undefined;

  if (settlement === undefined) {
    return { ok: false, reason: describeTaskActionFailureV1(outcome) };
  }
  return { ok: true, settlement };
}

/**
 * Register the generatePlanWithAI command
 */
export function registerGeneratePlanWithAICommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.generatePlanWithAI",
    (arg?: GeneratePlanArg) =>
      generatePlanWithAI(context, inventory, chatViewProvider, arg)
  );
  context.subscriptions.push(disposable);
}
