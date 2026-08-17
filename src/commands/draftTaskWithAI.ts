import * as vscode from "vscode";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME, TaskStage } from "../types/taskProgress";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { checkRunnerAvailabilityForModel } from "../runners/runnerRegistry";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext, ResolvedTaskContext } from "../utils/resolveTaskContext";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { NotificationRouter } from "../utils/notificationRouter";
import { attributionHeader, safeOpenTextDocument } from "../utils/fileUtils";
import { ChatViewProvider, ChatInteractionRefV1, ChatInteractionResumeResultV1 } from "../views/chatView";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

import { IncompleteTask } from "../types/incompleteTask";
import {
  linkCancellationTokens,
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
  TASK_NAME_WRITE_CONFLICT_KEY,
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
import { ActionConversationOrchestratorV1, InteractionRefV1 } from "../actions/actionConversationOrchestratorV1";
import {
  DRAFT_ACTION_KEY_V1,
  DRAFT_TARGET_RELATIVE_PATH_V1,
  DraftActionInputV1,
} from "../actions/rows/draftRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { describeTaskActionFailureV1, describeTaskActionOutcomeForLogV1 } from "../utils/taskActionOutcomeTextV1";

import {
  buildTaskDocument,
  detectEOL,
  DRAFT_REQUIRED_SUBSECTIONS,
  DRAFT_UNSTRUCTURED_HEADING,
  INTRO_TEXT,
  ParsedTaskDocument,
  parseTaskDocument,
  SHORTCUT_NOTE,
  validateDraftStructure,
  wrapUnstructuredDraft,
} from "../utils/taskDescriptionDocument";

export {
  buildTaskDocument,
  detectEOL,
  DRAFT_REQUIRED_SUBSECTIONS,
  DRAFT_UNSTRUCTURED_HEADING,
  INTRO_TEXT,
  ParsedTaskDocument,
  parseTaskDocument,
  SHORTCUT_NOTE,
  validateDraftStructure,
  wrapUnstructuredDraft,
};

/**
 * Accepted argument shapes for draftTaskWithAI. Mirrors generatePlanWithAI's
 * GeneratePlanArg so the command works both from the tree stage-row inline
 * button (which passes the StageNode itself, i.e. `.task: IncompleteTask`)
 * and from the keyboard shortcut router (`{ canonicalId }`).
 */
type DraftTaskArg =
  | { canonicalId?: string; taskFolderPath?: string }
  | { task?: IncompleteTask };

/**
 * Normalize a DraftTaskArg into the `{ canonicalId?, taskFolderPath? }` shape
 * resolveTaskContext accepts.
 *
 * @internal exported for testing
 */
export function normalizeDraftTaskArg(
  arg?: DraftTaskArg
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Prefer the explicit resolver shape: the keyboard-shortcut router
  // (applyCurrentStageAction) dispatches { canonicalId, taskFolderPath,
  // task: { progress } } — a partial `task` with no folderUri — so the
  // explicit fields must win before the tree-node branch touches folderUri.
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return { canonicalId: explicit.canonicalId, taskFolderPath: explicit.taskFolderPath };
  }
  if ("task" in arg && arg.task && arg.task.folderUri?.fsPath) {
    return {
      canonicalId: arg.task.canonicalId,
      taskFolderPath: arg.task.folderUri.fsPath,
    };
  }
  return undefined;
}

/** A resolved provider/coordinator pair for one draft.v1 invocation. */
interface ResolvedDraftCoordinatorV1 {
  readonly coordinator: TaskActionCoordinatorV1;
  readonly providerLabel: string;
  /** (2m) Native model id for the run-log attribution header; undefined for providers without one. */
  readonly modelLabel: string | undefined;
}

type ResolveDraftCoordinatorFailureV1 =
  | { readonly kind: "noModel" }
  | { readonly kind: "unavailable"; readonly providerLabel: string; readonly reason: string };

/**
 * Resolve the Description stage's configured model, confirm the provider is
 * available, and build a task action coordinator bound to this invocation's
 * workspace cwd and resolved stage model — mirrors
 * generatePlanWithAI.ts's resolveGeneratePlanCoordinatorV1. Shared by the
 * direct command invocation and by an explicit Chat Resume of a `draft.v1`
 * structured-question interaction (plan §6.1).
 */
async function resolveDraftCoordinatorV1(
  taskFolderUri: vscode.Uri,
  workspaceFolderUri: vscode.Uri
): Promise<
  | { readonly ok: true; readonly value: ResolvedDraftCoordinatorV1 }
  | { readonly ok: false; readonly failure: ResolveDraftCoordinatorFailureV1 }
> {
  const model = await resolveFreshModelForStage(taskFolderUri, "desc");
  if (!model.modelId) {
    return { ok: false, failure: { kind: "noModel" } };
  }
  const { availability, providerLabel, nativeModelId } = await checkRunnerAvailabilityForModel(
    model.modelId,
    "desc"
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
    resolveStagePrimaryModel: () => ({ modelId, stage: "desc" as TaskStage }),
  });
  return { ok: true, value: { coordinator, providerLabel, modelLabel: nativeModelId } };
}

/** Minimal task identity `handleDraftOutcomeV1` needs — never a raw filesystem path beyond the task's own folder. */
interface DraftOutcomeTaskRefV1 {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly taskName?: string;
}

interface DraftOutcomeContextV1 {
  readonly taskRef: DraftOutcomeTaskRefV1;
  readonly chatViewProvider: ChatViewProvider;
  readonly orchestrator: ActionConversationOrchestratorV1;
  /**
   * The action-specific prompt this drive rendered, recorded in the run log
   * only. This is the prompt BEFORE the coordinator appends its own AI-result
   * envelope contract block — see the run-log write below.
   */
  readonly prompt: string;
  /** (2m) Resolved provider/model for the run log's attribution header. */
  readonly providerLabel: string;
  readonly modelLabel: string | undefined;
}

interface DraftOutcomeResultV1 {
  readonly succeeded: boolean;
  readonly runLogUri?: vscode.Uri;
}

/**
 * Handle one `draft.v1` coordinator outcome: promote a completed result's
 * already-written task.md into the task's lifecycle (derive the task name,
 * open the document, notify the user), raise a `questions` outcome in Chat
 * With AI (never in task.md — plan §6's universal question flow), or notify
 * the user of cancellation/failure. Shared by the direct command invocation
 * and by an explicit Chat Resume, so both paths behave identically once the
 * coordinator has produced an outcome.
 */
async function handleDraftOutcomeV1(
  outcome: TaskActionOutcomeV1,
  ctx: DraftOutcomeContextV1
): Promise<DraftOutcomeResultV1> {
  const taskFolderUri = vscode.Uri.file(ctx.taskRef.taskFolderPath);
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);

  let succeeded = false;

  if (outcome.kind === "completed") {
    // The coordinator outcome carries no content — re-read the just-written
    // draft section to (a) detect the unstructured-fallback wrap and (b)
    // derive the task name, exactly as the pre-V1 flow did from its own
    // in-memory aiOutput.
    let draftWithAI = "";
    try {
      const bytes = await vscode.workspace.fs.readFile(taskFileUri);
      draftWithAI = parseTaskDocument(new TextDecoder().decode(bytes)).draftWithAI;
    } catch {
      // Best-effort: the write itself already succeeded (the coordinator
      // reported "completed"); a re-read failure only loses the naming/
      // warning UX below, not the draft itself.
    }
    if (draftWithAI.includes(DRAFT_UNSTRUCTURED_HEADING)) {
      NotificationRouter.showWarning(
        "The draft is missing required subsections (Behavior change / Affected areas / Actionable changes); it was saved under a 'Draft (unstructured)' heading for manual review."
      );
    }
    succeeded = true;

    // Drafting never renames the task: naming is owned exclusively by the
    // explicit Rename Task with AI action (renameTask.ts).

    await safeOpenTextDocument(taskFileUri, "task.md");
    NotificationRouter.showInformation("task.md updated with Draft with AI.");
  } else if (outcome.kind === "questions") {
    // Plan §6.1: questions surface in Chat With AI, never in task.md. The
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
    NotificationRouter.showInformation("Draft with AI cancelled.");
  } else {
    NotificationRouter.showError(
      `Draft with AI failed: ${describeTaskActionFailureV1(outcome)}. task.md was not changed.`
    );
  }

  // (2m) See generatePlanWithAI.ts's identical run-log comment: ctx.prompt is
  // the pre-contract prompt, and the coordinator-appended AI-result envelope
  // block (not reconstructable here — §2.2-permitted, correlation-scoped
  // boilerplate) is called out explicitly rather than silently omitted.
  const runLogUri = await writeRunLog(
    taskFolderUri,
    "draft-v1",
    "desc",
    `${attributionHeader(ctx.providerLabel, ctx.modelLabel)}\n\n` +
      `# Prompt\n\n${ctx.prompt}\n\n` +
      "*(The coordinator appends its own AI-result envelope contract block " +
      "to this prompt before dispatch; that block is not reproduced here.)*\n\n" +
      `# Result\n\n${describeTaskActionOutcomeForLogV1(outcome, "task.md")}`
  );

  return { succeeded, runLogUri };
}

interface DraftResultV1 {
  readonly succeeded: boolean;
}

async function draftTaskWithAIForResolvedTask(
  context: vscode.ExtensionContext,
  chatViewProvider: ChatViewProvider,
  resolvedTask: ResolvedTaskContext,
  op: TaskOperationHandle
): Promise<DraftResultV1> {
  // resolveTaskContext already computed the owning workspace folder (with a
  // fallback for tasks that predate the `ownership` field), so reuse it
  // instead of re-deriving it from ownership.workspaceRoot directly — that
  // duplicate check had no fallback and always failed for ownership-less
  // tasks even when the correct (and only) workspace folder was open.
  const workspaceFolder = resolvedTask.workspaceFolder
    ? vscode.workspace.getWorkspaceFolder(resolvedTask.workspaceFolder)
    : undefined;
  if (!workspaceFolder) {
    NotificationRouter.showError("Could not determine the owning workspace for this task.");
    return { succeeded: false };
  }

  if (resolvedTask.progress.currentStage !== "desc") {
    NotificationRouter.showInformation(
      "Task is not at the Task Description stage."
    );
    return { succeeded: false };
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const descriptionFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_DESCRIPTION_FILENAME);

  // Prefer live document buffer over stale disk content. task.md's V1
  // promotion mutates through the workflow file store (disk only — it
  // cannot see editor buffer state), so a dirty buffer is saved now rather
  // than silently losing its unsaved edits to a disk-only read-merge-write
  // later in this same drive.
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === taskFileUri.toString()
  );
  let rawContent: string;
  if (openDoc) {
    rawContent = openDoc.getText();
    if (openDoc.isDirty) {
      const saved = await openDoc.save();
      if (!saved) {
        NotificationRouter.showError(
          "Could not save unsaved changes to task.md before drafting. Save the file and try again."
        );
        return { succeeded: false };
      }
    }
  } else {
    try {
      const bytes = await vscode.workspace.fs.readFile(taskFileUri);
      rawContent = new TextDecoder().decode(bytes);
    } catch {
      rawContent = "";
    }
  }

  const parsed = parseTaskDocument(rawContent);

  // New tasks keep narration in task-description.md. Fall back to legacy
  // embedded descriptions so existing tasks remain fully compatible.
  let sourceDescription = parsed.taskDescription;
  try {
    const description = new TextDecoder().decode(await vscode.workspace.fs.readFile(descriptionFileUri)).trim();
    if (description) sourceDescription = description;
  } catch {
    // Optional file.
  }

  if (!sourceDescription.trim()) {
    NotificationRouter.showWarning(
      "Please enter a task description before using Draft with AI."
    );
    return { succeeded: false };
  }

  const resolved = await resolveDraftCoordinatorV1(taskFolderUri, workspaceFolder.uri);
  if (!resolved.ok) {
    if (resolved.failure.kind === "noModel") {
      NotificationRouter.showWarning(
        "No model is configured for the Description stage. Open Ensemble Settings and choose a primary model before continuing.",
        undefined,
        undefined,
        undefined,
        { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
      );
    } else {
      NotificationRouter.showWarning(
        `${resolved.failure.providerLabel} is unavailable: ${resolved.failure.reason}.`
      );
    }
    return { succeeded: false };
  }
  const { coordinator, providerLabel, modelLabel } = resolved.value;

  // Build the prompt and check its size BEFORE launching or writing artifacts.
  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "draft-task-with-ai.md",
    {
      taskDescription: `${sourceDescription}\n\nNote: this may be voice-transcribed input; resolve obvious transcription errors from context rather than treating them as requirements.`,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return { succeeded: false };
  }

  // Register (or reconfirm) this task folder as a trusted workflow mutation
  // root and derive its ownership-backed binding (plan §3.9) — the identity
  // every coordinator invocation correlates against.
  let taskBindingId: string;
  try {
    const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
    const verified = getVerifiedTaskBindingIdV1(rootId);
    if (!verified) {
      NotificationRouter.showError(
        "Draft with AI failed: this task's ownership binding could not be verified."
      );
      return { succeeded: false };
    }
    taskBindingId = verified;
  } catch (error) {
    NotificationRouter.showError(
      `Draft with AI failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { succeeded: false };
  }
  const chatIdentity = await readChatDocumentIdentityV1(
    taskFolderUri.fsPath,
    resolvedTask.canonicalId ?? taskFolderUri.fsPath
  );
  const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

  // Capture task.md's current revision so the row's promotion is a
  // revision-checked read-merge-write (plan §6.2/§6.3): a concurrent edit
  // made while the provider is thinking is detected and refused rather than
  // clobbered. Unlike plan.md, task.md always exists by the desc stage.
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderUri.fsPath);
  const targetLocator = { rootId, relativePath: DRAFT_TARGET_RELATIVE_PATH_V1 };
  const fileStore = getWorkflowFileStoreV1();
  const statResult = await fileStore.stat(targetLocator);
  if (
    statResult.kind !== "ok" ||
    statResult.value.kind !== "file" ||
    statResult.value.revision === undefined
  ) {
    NotificationRouter.showError(
      `Draft with AI failed: could not read ${DRAFT_TARGET_RELATIVE_PATH_V1} (${
        statResult.kind === "ok" ? statResult.value.kind : statResult.code
      }).`
    );
    return { succeeded: false };
  }
  const baselineRevision = statResult.value.revision;

  const validatedInput: DraftActionInputV1 = { prompt, targetLocator, baselineRevision };

  let succeeded = false;

  // No overwrite confirmation — user has deliberately triggered this run.
  await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Drafting task with ${providerLabel} (uses your ${providerLabel} quota)...`,
        cancellable: true,
      },
      async (progress, token) => {
        NotificationRouter.emitProgressSummary(
          `Drafting task with ${providerLabel}...`,
          taskOperations.rootOperationIdFor(taskFolderUri.fsPath)
        );

        progress.report({ message: `Waiting for ${providerLabel} response...` });

        // Cancellable from either surface: the native progress toast and the
        // Notifications-row cancel button both abort the same provider run.
        const linked = linkCancellationTokens(token, op.token);
        let outcome: TaskActionOutcomeV1;
        try {
          outcome = await coordinator.executeAction({
            actionKey: DRAFT_ACTION_KEY_V1,
            taskBinding: { taskBindingId, chatDocumentId },
            taskStatus: resolvedTask.progress.status ?? "active",
            taskStage: resolvedTask.progress.currentStage,
            rawInput: validatedInput,
            cancellationToken: linked.token,
          });
        } finally {
          linked.dispose();
        }

        const handled = await handleDraftOutcomeV1(outcome, {
          taskRef: {
            taskFolderPath: taskFolderUri.fsPath,
            canonicalId: resolvedTask.canonicalId ?? taskFolderUri.fsPath,
            taskName: resolvedTask.progress.displayName,
          },
          chatViewProvider,
          orchestrator: getProductionActionConversationOrchestratorV1(),
          prompt,
          providerLabel,
          modelLabel,
        });
        succeeded = handled.succeeded;
        if (handled.runLogUri) {
          op.setResultTargetUri(handled.runLogUri);
        }
      }
    );
  return { succeeded };
}

/**
 * Draft the task description with AI. Reads from the live open document
 * buffer if task.md is open (to capture unsaved edits), writes back only
 * to `## Draft with AI`. Structured clarifying questions route to Chat With
 * AI (plan §6's universal question flow) instead of an `## Open Questions`
 * section — see draftRowV1.ts and handleDraftOutcomeV1 above.
 *
 * Requires first-use consent (ensureAiConsent) before any provider is
 * launched or any file is written.
 */
export async function draftTaskWithAI(
  inventory: TaskInventory,
  context: vscode.ExtensionContext,
  chatViewProvider: ChatViewProvider,
  explicitArg?: DraftTaskArg
): Promise<boolean | undefined> {
  assertLegacyAiRouteAllowedV0("draft.v1");
  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const resolvedTask = await resolveTaskContext(inventory, normalizeDraftTaskArg(explicitArg), {
    allowPaused: false,
  });

  if (!resolvedTask) {
    NotificationRouter.showInformation(
      "No active task found at the Task Description stage."
    );
    return;
  }

  const lockKey = resolvedTask.taskFolderPath;
  const result = await runTrackedOperation(
    lockKey,
    // TASK_NAME_WRITE_CONFLICT_KEY: description generation never writes the
    // task's name (handleDraftOutcomeV1 leaves naming to the rename actions),
    // but it runs under the name captured here, so it must never overlap a
    // (non-exclusive) rename — the shared key makes begin() refuse whichever
    // side arrives second, atomically.
    { label: "Draft Task with AI", stage: "desc", taskName: resolvedTask.progress.displayName ?? resolvedTask.folderName, kind: "draft-task", cancellable: true, conflictKeys: [TASK_NAME_WRITE_CONFLICT_KEY] },
    (op) => draftTaskWithAIForResolvedTask(context, chatViewProvider, resolvedTask, op)
  );
  return result?.succeeded || undefined;
}

/**
 * Drive an explicit Chat Resume of a `draft.v1` structured-question
 * interaction (plan §5.5 / §6.1 / AC-QUESTION-03): re-resolve the stage
 * model/provider, run the coordinator's `resumeAction`, and handle the
 * resulting outcome exactly like a fresh invocation. Called from
 * extension.ts's `ChatInteractionServicesV1.resume` wiring once the
 * interaction's recorded actionKey resolves to `draft.v1`.
 */
export async function resumeDraftInteractionV1(
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

  const resolved = await resolveDraftCoordinatorV1(taskFolderUri, workspaceFolderUri);
  if (!resolved.ok) {
    return {
      ok: false,
      reason:
        resolved.failure.kind === "noModel"
          ? "no model is configured for the Description stage"
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

  await handleDraftOutcomeV1(outcome, {
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
  });

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
 * Register the draftTaskWithAI command.
 */
export function registerDraftTaskWithAICommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.draftTaskWithAI",
    (explicitArg?: Parameters<typeof draftTaskWithAI>[3]) =>
      draftTaskWithAI(inventory, context, chatViewProvider, explicitArg)
  );
  context.subscriptions.push(disposable);
}
