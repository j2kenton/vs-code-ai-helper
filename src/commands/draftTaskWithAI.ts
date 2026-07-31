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
import { safeOpenTextDocument } from "../utils/fileUtils";
import { ChatViewProvider, ChatInteractionRefV1, ChatInteractionResumeResultV1 } from "../views/chatView";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";

import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import {
  linkCancellationTokens,
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
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
  if ("task" in arg && arg.task) {
    return {
      canonicalId: arg.task.canonicalId,
      taskFolderPath: arg.task.folderUri.fsPath,
    };
  }
  if ("canonicalId" in arg && (arg.canonicalId || arg.taskFolderPath)) {
    return { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath };
  }
  return undefined;
}

/** A resolved provider/coordinator pair for one draft.v1 invocation. */
interface ResolvedDraftCoordinatorV1 {
  readonly coordinator: TaskActionCoordinatorV1;
  readonly providerLabel: string;
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
  const { availability, providerLabel } = await checkRunnerAvailabilityForModel(
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
  return { ok: true, value: { coordinator, providerLabel } };
}

/** Minimal task identity `handleDraftOutcomeV1` needs — never a raw filesystem path beyond the task's own folder. */
interface DraftOutcomeTaskRefV1 {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly taskName?: string;
  readonly nameIsDefault?: boolean;
}

interface DraftOutcomeContextV1 {
  readonly taskRef: DraftOutcomeTaskRefV1;
  readonly chatViewProvider: ChatViewProvider;
  readonly orchestrator: ActionConversationOrchestratorV1;
  /** The action-specific prompt sent this drive, recorded in the run log only. */
  readonly prompt: string;
}

interface DraftOutcomeResultV1 {
  readonly succeeded: boolean;
  readonly runLogUri?: vscode.Uri;
}

/** One short, sanitized status line for the run log — never provider text. */
function describeDraftOutcomeForLogV1(outcome: TaskActionOutcomeV1): string {
  switch (outcome.kind) {
    case "completed":
      return `Status: completed (${outcome.code})`;
    case "questions":
      return `Status: questions (interactionId=${outcome.interactionId}) — the AI asked a clarifying question in Chat With AI instead of writing task.md.`;
    case "cancelled":
      return `Status: cancelled (${outcome.code})`;
    case "failed":
      return `Status: failed (code=${outcome.code}, retryable=${outcome.retryable})`;
    case "malformedResult":
      return `Status: malformed result (${outcome.code})`;
    case "unavailable":
      return `Status: unavailable (${outcome.code})`;
    case "recoveryRequired":
      return `Status: recovery required (${outcome.code})`;
    case "duplicateRejected":
      return "Status: duplicate rejected (another operation is already running for this task)";
    case "stalePreflight":
      return `Status: stale preflight (${outcome.planId})`;
    case "partialEditBlocked":
      return `Status: partial edit blocked (${outcome.executionId})`;
    default:
      return `Status: ${(outcome as TaskActionOutcomeV1).kind}`;
  }
}

/** User-facing failure text for a non-completed, non-cancelled, non-questions outcome. */
function describeDraftFailureV1(outcome: TaskActionOutcomeV1): string {
  switch (outcome.kind) {
    case "failed":
      return `${outcome.code}${outcome.retryable ? " (retryable)" : ""}`;
    case "malformedResult":
      return `the model's response was malformed (${outcome.code})`;
    case "unavailable":
      return outcome.code;
    case "recoveryRequired":
      return outcome.code;
    case "duplicateRejected":
      return "another operation is already running for this task";
    case "stalePreflight":
      return "a stale preflight plan was rejected";
    case "partialEditBlocked":
      return "a partial edit was blocked";
    default:
      return outcome.kind;
  }
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

    // Keep folder IDs stable, but replace the generated label when it has
    // not been manually renamed. The draft's opening goal line is the best
    // concise summary already produced without an extra model request, so
    // it (not a nonexistent H1) is the task name. Skip `#`/`>` lines too: an
    // unstructured-fallback draft opens with the "### Draft (unstructured)"
    // heading followed by a "> The AI response was missing..." blockquote —
    // neither is real draft content.
    if (ctx.taskRef.nameIsDefault !== false) {
      const title = draftWithAI
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(">"));
      if (title) {
        await patchTaskProgressStrictV1(taskFolderUri, (current) => ({
          ...current,
          displayName: title.slice(0, 120),
          // An AI-derived summary replaces the generated folder-name label.
          // Treat it as established so later drafts cannot silently
          // overwrite a title the user has accepted.
          nameIsDefault: false,
        }));
      }
    }

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
      `Draft with AI failed: ${describeDraftFailureV1(outcome)}. task.md was not changed.`
    );
  }

  const runLogUri = await writeRunLog(
    taskFolderUri,
    "draft-v1",
    "desc",
    `# Prompt\n\n${ctx.prompt}\n\n# Result\n\n${describeDraftOutcomeForLogV1(outcome)}`
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
  const { coordinator, providerLabel } = resolved.value;

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
            nameIsDefault: resolvedTask.progress.nameIsDefault,
          },
          chatViewProvider,
          orchestrator: getProductionActionConversationOrchestratorV1(),
          prompt,
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
    { label: "Draft Task with AI", stage: "desc", taskName: resolvedTask.folderName, kind: "draft-task", cancellable: true },
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
  const { coordinator } = resolved.value;
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
      nameIsDefault: ownedTask.progress.nameIsDefault,
    },
    chatViewProvider,
    orchestrator,
    prompt,
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
    return { ok: false, reason: describeDraftFailureV1(outcome) };
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
