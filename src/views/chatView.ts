import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { notifyDesktop } from "../utils/desktopNotifier";
import { formatTaskNameForDisplay, taskOperations } from "../utils/taskOperations";
import { NotificationRouter, getNotificationRouterStatus } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  appendChatInteraction,
  appendChatMessageV1,
  CHAT_HISTORY_FILENAME,
  ChatDocumentInteractionV1,
  ChatHistoryRecoveryErrorV1,
  ChatMessage,
  loadTranscriptWithMigration,
  onDidChangeChatHistoryV1,
  readChatDocumentIdentityV1,
  readChatInteractions,
  recordChatInteractionAnswers,
  resetChatHistoryV1,
  settleChatInteraction,
} from "../utils/chatHistoryStore";
import { stripAttributionHeaders } from "../utils/fileUtils";
import { formatTimestampForDisplay } from "../utils/timeFormat";
import {
  decodeStructuredAnswersArrayV1,
  DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../types/structuredQuestionV1";
import { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { deriveApplicableVerifiedTicksV1 } from "../commands/applyReviewerVerifiedTicks";
import { renderHandoffFieldLineV1, renderRequiredHandoffFieldsV1 } from "../types/handoffGuidanceV1";
import {
  deriveOwedContinuationRecordV1,
  deriveSchedulingPostureV1,
  describeSchedulingPostureV1,
  SchedulingIntentStoreV1,
} from "../state/schedulingIntentV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

export type { ChatMessage };

/**
 * Interaction ref plus the source correlation a webview Answer/Resume/Cancel
 * control acts against (plan §5.4/§6.1). `interactionId` is validated by the
 * services below against the durable transaction it names. `taskBindingId`
 * and `chatDocumentId` are the CURRENT task-local Chat document's own
 * authoritative binding (chatHistoryStore.ts's `readChatDocumentIdentityV1`)
 * — derived server-side by `resolveInteractionRef` below, never trusted from
 * the webview message itself — so a stale or foreign operation/interaction
 * pair (e.g. one left over from a document that was Reset, or one that never
 * belonged to this task) is rejected against the durable transaction's own
 * recorded binding, not only its interaction id. `sourceAttemptId` is the
 * mirrored interaction's own recorded question-time attempt (read from its
 * `ChatDocumentInteractionV1` record, also by `resolveInteractionRef`) — the
 * full task/document/source-attempt tuple `InteractionRefV1` requires
 * (plan §3.1 / AC-ID-03).
 */
export interface ChatInteractionRefV1 {
  readonly operationId: string;
  readonly interactionId: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly sourceAttemptId: string;
}

/** The bare client-supplied selector a webview interaction message carries — see `resolveInteractionRef`. */
interface ChatInteractionClientRefV1 {
  readonly operationId: string;
  readonly interactionId: string;
}

export type ChatInteractionServiceResultV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ChatInteractionResumeResultV1 =
  | { readonly ok: true; readonly settlement: "resumed" | "supersededByReplacementOperation" }
  | { readonly ok: false; readonly reason: string };

/**
 * The production Chat interaction transaction/coordinator surface Chat With
 * AI's structured Answer/Resume/Cancel controls act through (plan §5.4/§6.1).
 * Optional and set only once wired from extension.ts — `resume` in
 * particular requires the action coordinator, which nothing in production
 * constructs yet (pending the Generate Plan cohort landing); until then
 * Resume surfaces a clear "not available yet" message instead of silently
 * doing nothing. Answer and Cancel need only the durable transaction store
 * (already production-ready) and work as soon as `setInteractionServices` is
 * called.
 */
export interface ChatInteractionServicesV1 {
  submitAnswers(
    ref: ChatInteractionRefV1,
    rawAnswers: unknown,
    answerIdempotencyId: string
  ): Promise<ChatInteractionServiceResultV1>;
  cancel(ref: ChatInteractionRefV1): Promise<ChatInteractionServiceResultV1>;
  resume?(
    ref: ChatInteractionRefV1,
    resumeIdempotencyId: string
  ): Promise<ChatInteractionResumeResultV1>;
  /**
   * Validates a Chat Send BEFORE the user's message is appended to the
   * transcript (plan §5.4/AC-CHAT-TX-02) — resolves the target task so a
   * stale/deleted reference is rejected without ever persisting a message
   * for a send `chatWithStage` would only reject moments later anyway.
   * Optional: when unset, Send proceeds straight to append (matches
   * pre-wiring behavior, and the "global" assistant target, which has no
   * task to validate).
   */
  validateSend?(target: ChatTarget, text: string): Promise<ChatInteractionServiceResultV1>;
  /**
   * Resolve a task's current lifecycle status from the shared inventory.
   * Used by render() to hide (never delete) the stored conversation of a
   * completed/archived task; resume/reopen flips the status back to active
   * and the history reappears automatically. Optional: when unset (tests,
   * pre-wiring), every conversation renders as before. Returning undefined
   * (unknown task) also renders normally rather than hiding history on a
   * lookup miss.
   */
  getTaskStatus?(canonicalId: string): string | undefined;
}

export interface ChatTarget {
  canonicalId: string;
  taskFolderPath: string;
  stage: TaskStage;
  /** User-facing task name; falls back to the folder's date/task-ID code. */
  taskName?: string;
  /**
   * "global" marks the task-section global assistant, which has its own
   * fully separate history (stored in a dedicated folder, not any task's)
   * and is labeled as a global assistant rather than a task/stage chat.
   */
  kind?: "stage" | "global";
}

/** The identity fields an append/transcript operation is anchored to. */
type ChatIdentity = Pick<ChatTarget, "canonicalId" | "taskFolderPath">;

interface SendMessage {
  type: "send";
  text: string;
}

function isSendMessage(value: unknown): value is SendMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "send" && typeof candidate.text === "string";
}

function isReadyMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).type === "ready";
}

interface InteractionActionMessage {
  /**
   * `confirmInteraction` is the single commit path behind the Confirm button:
   * submit the answers, then resume the action, in ONE handler invocation.
   *
   * It replaces a webview that posted `submitInteractionAnswers` and
   * `resumeInteraction` as two separate messages from one click, while a
   * second button (`Save Answers`) posted the submit on its own. Two buttons
   * that both submit meant the natural reading of the labels — save, then
   * resume — submitted the same answers twice and failed the second with
   * `interactionAlreadySettled` (observed 2026-08-19, jester
   * `2026-08-19_task_1` runs 002/003). One message, one commit path, no way
   * to submit twice from the UI.
   */
  type:
    | "submitInteractionAnswers"
    | "cancelInteraction"
    | "resumeInteraction"
    | "confirmInteraction";
  operationId: string;
  interactionId: string;
  /** Present only for "submitInteractionAnswers" and "confirmInteraction". */
  answers?: unknown;
}

function isInteractionActionMessage(value: unknown): value is InteractionActionMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "submitInteractionAnswers" ||
      v.type === "cancelInteraction" ||
      v.type === "resumeInteraction" ||
      v.type === "confirmInteraction") &&
    typeof v.operationId === "string" &&
    v.operationId.length > 0 &&
    typeof v.interactionId === "string" &&
    v.interactionId.length > 0
  );
}

/**
 * The webview's single commit path for a `WorkflowDecisionV1` card: choosing
 * an option and pressing Confirm posts exactly this one message (task:
 * "Replace hidden notification decision buttons with explained, selectable
 * decisions" — PART 2 applies the SAME single-commit-path and acknowledgement
 * rules PART 0 established for structured questions, so the two decision
 * surfaces do not diverge).
 */
interface ResolveWorkflowDecisionMessage {
  type: "resolveWorkflowDecision";
  decisionId: string;
  optionId: string;
}

function isResolveWorkflowDecisionMessage(value: unknown): value is ResolveWorkflowDecisionMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "resolveWorkflowDecision" &&
    typeof v.decisionId === "string" &&
    v.decisionId.length > 0 &&
    typeof v.optionId === "string" &&
    v.optionId.length > 0
  );
}

export interface StageChatQuestion extends ChatTarget {
  question: string;
}

/**
 * A structured-question interaction to raise in Chat With AI (plan §6.1),
 * as opposed to StageChatQuestion's free-text legacy `role: "question"`
 * record. Nothing in production posts one of these yet — no registry row
 * has migrated to the structured-question flow — but the surface is
 * production-ready for whichever action migrates first.
 */
export interface StructuredChatQuestion extends ChatTarget {
  interactionId: string;
  operationId: string;
  actionKey: string;
  /** The question-time source attempt that produced these questions (plan §5.1) — required on every new interaction. */
  sourceAttemptId: string;
  questions: readonly StructuredQuestionV1[];
  /**
   * The operation's authoritative, coordinator-derived binding (plan §3.1),
   * passed straight through to `appendChatInteraction`'s required `binding`
   * param. REQUIRED (plan §3.1 / AC-ID-03): posting a structured-question
   * interaction must always carry the complete task/document binding so the
   * durable transaction and the task-local mirror can never disagree about
   * which task/document they belong to (see chatHistoryStore.ts's module
   * header and `appendChatInteraction`'s own binding checks).
   */
  binding: {
    readonly taskBindingId: string;
    readonly chatDocumentId: string;
  };
}

function sameIdentity(a: ChatIdentity | undefined, b: ChatIdentity | undefined): boolean {
  if (!a || !b) return a === b;
  return a.canonicalId === b.canonicalId && a.taskFolderPath === b.taskFolderPath;
}

/**
 * The set of transcript indices holding a `question` entry that is still
 * genuinely awaiting an answer (Part 4 of "Actionable Hand-offs"). A
 * question's persisted `pending` flag is never rewritten once set (module
 * comment on `ChatMessage.pending`), and settlement is defined as "the user
 * sends a follow-up message" — NOT "any later entry exists". Checking only
 * the transcript's last entry (as an earlier version of this function did)
 * falsely settles a question the moment ANY later entry is appended, even an
 * unrelated assistant/system message the user never answered — recreating
 * the exact stale-pending defect this function exists to fix, just inverted
 * (false-settled instead of stuck-pending). Scanning forward and treating
 * only a `role: "user"` entry as a settling event is what the module comment
 * actually specifies.
 *
 * Correlation (review-flagged, 2026-08-22): when more than one question is
 * still unanswered when a `user` entry arrives — `ask()` has no lock
 * preventing a second question from stacking before the first is answered —
 * a single reply settles only the MOST RECENT of them, never all of them at
 * once. Settling every earlier stacked question off one reply had no
 * correlation to which question the reply actually addressed, and silently
 * dropped the older one(s) as answered forever with no record of what (if
 * anything) actually answered them.
 */
function computeAwaitingQuestionIndices(entries: readonly ChatMessage[]): ReadonlySet<number> {
  const awaiting = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.role === "question" && entry.pending === true) {
      awaiting.add(i);
      continue;
    }
    if (entry.role === "user" && awaiting.size > 0) {
      // Settle only the nearest still-unanswered question — the one this
      // reply most plausibly addresses — leaving any older stacked question
      // genuinely awaiting until its own later reply arrives.
      let nearest = -1;
      for (const index of awaiting) {
        if (index > nearest) nearest = index;
      }
      awaiting.delete(nearest);
    }
  }
  return awaiting;
}

/**
 * Notification demotion for a posted `WorkflowDecisionV1` (task: "Replace
 * hidden notification decision buttons with explained, selectable
 * decisions"). The notification only ANNOUNCES that a decision is waiting
 * and where to find it — it carries a single "Review decision in Chat"
 * action that opens Chat With AI on the decision's task/stage, where the
 * full explained choice (what happened, why, options with consequences, a
 * recommendation) renders. It is never itself the decision surface.
 *
 * Callers already have the `ChatTarget` in scope from computing the decision
 * itself (the decision record only carries `taskCanonicalId`/`stage`, not
 * `taskFolderPath` or a display name), so it is passed in rather than
 * re-derived here.
 */
export function notifyPendingWorkflowDecision(decision: WorkflowDecisionV1, target: ChatTarget): void {
  if (!getNotificationRouterStatus()) return;
  const label = target.taskName ?? target.taskFolderPath;
  const stageName = STAGE_DISPLAY_NAMES[target.stage];
  // A record predating the `gating` field (or one from a call site that
  // regresses and omits it) is treated as blocking — absence is never
  // positive evidence, so an unknown gating state must not downgrade a
  // notification that might genuinely be holding the task paused.
  const isBlocking =
    decision.gating === undefined ||
    decision.gating.holdsTaskPaused === true ||
    decision.gating.unblocksProgress === true;
  const actionCommand = {
    command: "vs-code-ai-helper.openWorkflowDecision",
    title: "Review decision in Chat",
    args: [target],
  };
  // The fact reported is always `whatHappened` — `gating.detail` says
  // whether answering moves anything forward, which is a claim ABOUT the
  // decision, not a substitute for the decision's own content. Swapping the
  // body for `gating.detail` on the non-blocking path would silently drop
  // the actual fact (e.g. which continuation was scheduled) behind a generic
  // "this doesn't block anything" line — the same "absence is never positive
  // evidence" failure this contract exists to prevent, just relocated to the
  // headline instead of the gating field itself. So the non-blocking path
  // states BOTH: `whatHappened` for the fact, then `gating.detail` for why
  // it does not need urgent attention — the plan's explicit contract for
  // this surface.
  if (isBlocking) {
    NotificationRouter.showWarning(
      `Decision needed — ${label} (${stageName}): ${decision.whatHappened}`,
      undefined,
      undefined,
      undefined,
      actionCommand
    );
  } else {
    const detail = decision.gating?.detail;
    const body = detail ? `${decision.whatHappened} ${detail}` : decision.whatHappened;
    NotificationRouter.showInformation(
      `Optional — ${label} (${stageName}): ${body}`,
      undefined,
      undefined,
      undefined,
      actionCommand
    );
  }
}

/** Memento key the last-open chat target is persisted under, so the panel
 * reopens on the same conversation instead of always resetting to the
 * Global Assistant across window reloads. */
const LAST_CHAT_TARGET_KEY = "vs-code-ai-helper.chatView.lastTarget";

/** A workspace-scoped, persistent conversation surface for the active task.
 * Transcripts are persisted to `chat-v1.json` inside each task folder (see
 * chatHistoryStore.ts) so they travel with the task, with a lazy one-time
 * migration from the legacy per-workspace Memento transcript. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "vs-code-ai-helper.chatView";
  private view?: vscode.WebviewView;
  private target?: ChatTarget;
  /**
   * Resolves the default chat target when none has been chosen yet: the
   * global assistant. Installed from extension.ts (the resolver lives with
   * the openGeneralAssistant command) so the panel is usable immediately
   * instead of showing a "select a task first" blocked state.
   */
  private defaultTargetFactory?: () => Promise<ChatTarget | undefined>;
  /**
   * One write/read queue per task folder, so a slow or failing operation on
   * one task can never stall or lose a message for another. Reads
   * (transcript/render) are chained through the same queue as writes so a
   * lazy migration can never race a concurrent append for the same task.
   */
  private queues = new Map<string, Promise<void>>();
  /** Tracks which tasks already showed the "could not save" warning, so a
   * run of write failures surfaces one notice, not one per message. Cleared
   * the next time a write for that task succeeds. */
  private warnedTasks = new Set<string>();
  private readonly operationsSub: vscode.Disposable;
  private readonly decisionsSub: vscode.Disposable;
  private readonly chatHistorySub: vscode.Disposable;
  /** Set only once wired from extension.ts (see ChatInteractionServicesV1's doc comment). */
  private interactionServices?: ChatInteractionServicesV1;
  /**
   * The reusable decision contract's store (task: "Replace hidden
   * notification decision buttons with explained, selectable decisions").
   * Backed by the same Memento as this provider — any other module can
   * independently construct `new WorkflowDecisionStoreV1(context.workspaceState)`
   * and post/resolve against the same underlying records, mirroring how
   * `PendingOperationsStore` is re-constructed per call site rather than
   * threaded through as a single shared instance.
   */
  readonly workflowDecisionStore: WorkflowDecisionStoreV1;
  /**
   * The scheduling-intent ledger's store (task "Actionable Hand-offs", PART
   * 6), backed by the same Memento as `workflowDecisionStore`. Drives the
   * chat panel's "what happens next" header line — the second of the two
   * required always-present surfaces (the task-tree tooltip is the first,
   * `taskTreeProvider.ts`).
   */
  private readonly schedulingIntentStore: SchedulingIntentStoreV1;
  private readonly schedulingIntentSub: vscode.Disposable;

  constructor(private readonly state: vscode.Memento) {
    this.workflowDecisionStore = new WorkflowDecisionStoreV1(state);
    this.schedulingIntentStore = new SchedulingIntentStoreV1(state);
    // Same rationale as `decisionsSub` below: a ledger write from anywhere
    // else sharing this Memento (the tree provider's chokepoint writes, a
    // recovery sweep) must not leave an already-open panel showing a stale
    // "what happens next" line.
    this.schedulingIntentSub = this.schedulingIntentStore.onDidChange(() => {
      if (!this.target || !this.view) return;
      void this.render().catch(() => undefined);
    });
    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose. Only re-render when there is a
    // target to render — operations on other tasks must not rebuild this view.
    this.operationsSub = taskOperations.onDidChange(() => {
      if (!this.target || !this.view) return;
      void this.render().catch(() => undefined);
    });
    // A decision resolved (or posted) from anywhere else — another window,
    // an automated dispatch, a different provider instance sharing this same
    // Memento — must not leave THIS panel showing a stale card for a record
    // that has already settled elsewhere (Part 4: rendered state must be
    // derived from persisted state, re-derived whenever the store changes).
    this.decisionsSub = this.workflowDecisionStore.onDidChange(() => {
      if (!this.target || !this.view) return;
      void this.render().catch(() => undefined);
    });
    // The persisted chat store's own change signal (Part 4.1's other half):
    // `actions/rows/chatSendRowV1.ts` and `globalAssistantSendRowV1.ts` write
    // chat-v1.json directly through `writeChatHistory`, bypassing this
    // provider's own append()/ask() methods (which already call render()
    // themselves after writing). Without this subscription, a write from one
    // of those row actions — or from a second provider instance sharing the
    // same task — left an already-open panel on the SAME target stale until
    // some unrelated trigger (a task-operation or decision change) happened
    // to re-render it. Scoped to `this.target` exactly like the other two.
    this.chatHistorySub = onDidChangeChatHistoryV1((change) => {
      if (!this.target || !this.view) return;
      if (!sameIdentity(this.target, change)) return;
      void this.render().catch(() => undefined);
    });
  }

  dispose(): void {
    this.operationsSub.dispose();
    this.decisionsSub.dispose();
    this.chatHistorySub.dispose();
    this.schedulingIntentSub.dispose();
  }

  setDefaultTargetFactory(factory: () => Promise<ChatTarget | undefined>): void {
    this.defaultTargetFactory = factory;
  }

  /** Wire the production Chat interaction services (plan §5.4/§6.1); see ChatInteractionServicesV1. */
  setInteractionServices(services: ChatInteractionServicesV1): void {
    this.interactionServices = services;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isReadyMessage(message)) {
        // The webview's own script just finished installing its message
        // listener — it may have missed the render() this method already
        // triggered below (e.g. after being torn down and recreated), which
        // is exactly what left the panel stuck on "Loading chat…". Send the
        // current state now that we know someone is listening.
        void this.render();
        return;
      }
      if (isResolveWorkflowDecisionMessage(message)) {
        await this.resolveWorkflowDecision(message.decisionId, message.optionId);
        return;
      }
      if (isInteractionActionMessage(message)) {
        const clientRef: ChatInteractionClientRefV1 = {
          operationId: message.operationId,
          interactionId: message.interactionId,
        };
        if (message.type === "submitInteractionAnswers") {
          await this.submitInteractionAnswers(clientRef, message.answers);
        } else if (message.type === "cancelInteraction") {
          await this.cancelInteraction(clientRef);
        } else if (message.type === "confirmInteraction") {
          // Resume ONLY on a confirmed submit: resuming an action whose
          // answer never landed would run it against a question it has no
          // answer for. `submitInteractionAnswers` has already reported the
          // reason to the user (and the transcript) on every false path.
          // The submission is acknowledged IMMEDIATELY (inside
          // submitInteractionAnswers, before Resume — a potentially
          // long-running provider-backed round — is even invoked below), so
          // the user is never left staring at silence while a slow round
          // runs. `resumeInteraction`'s own message then reports only the
          // resume outcome, not a second "answer submitted" claim.
          if (
            await this.submitInteractionAnswers(
              clientRef,
              message.answers,
              "Recorded: your answer was submitted. Resuming…"
            )
          ) {
            await this.resumeInteraction(clientRef, "Resumed — the action is continuing.");
          }
        } else {
          await this.resumeInteraction(clientRef);
        }
        return;
      }
      if (!isSendMessage(message) || !this.target) return;
      // Captured before any await, so a target switch mid-send still writes
      // to (and, if still current, renders) the task the message was sent to.
      const target = this.target;
      const text = message.text.trim();
      if (!text) return;
      if (target.kind !== "global") {
        // Concrete webview route of the Chat Send action family (plan §1.3):
        // consult the gate BEFORE appending the user message, so a disabled
        // route rejects without mutating the transcript (the downstream
        // chatWithStage handler would only throw after this write).
        try {
          assertLegacyAiRouteAllowedV0("chatSend.v1");
        } catch (error) {
          NotificationRouter.showError(
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
        // Plan §5.4/AC-CHAT-TX-02: validate the send BEFORE the user message
        // is persisted, so a stale/deleted task reference is rejected without
        // ever mutating chat-v1.json for a send chatWithStage would only
        // reject moments later anyway.
        if (this.interactionServices?.validateSend) {
          const validated = await this.interactionServices.validateSend(target, text);
          if (!validated.ok) {
            NotificationRouter.showWarning(validated.reason);
            return;
          }
        }
        // chatWithStage itself persists the user message (plan
        // §5.4/AC-CHAT-TX-02) once every precondition it independently
        // checks — consent, workspace/model/runner availability, task
        // ownership binding — has passed, so a failure there never leaves
        // an unanswerable message in chat-v1.json. Do not also append here.
        await vscode.commands.executeCommand("vs-code-ai-helper.chatWithStage", {
          ...target,
          message: text,
        });
      } else {
        // The global assistant has its own send path — it is not a task or
        // stage chat, chatWithStage cannot resolve its synthetic folder, and
        // globalAssistantSend does not persist the user message itself. Same
        // reasoning as the stage branch above: consult the gate BEFORE
        // appending, so a disabled route rejects without mutating the
        // transcript instead of leaving an unanswerable message behind an
        // unhandled rejection from the command dispatch below.
        try {
          assertLegacyAiRouteAllowedV0("globalAssistantSend.v1");
        } catch (error) {
          NotificationRouter.showError(
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
        await this.append("user", text, target.stage, target);
        await vscode.commands.executeCommand("vs-code-ai-helper.globalAssistantSend", {
          message: text,
        });
      }
    });
    // retainContextWhenHidden keeps the webview's DOM/script state alive
    // across a hide/show cycle (e.g. switching to Source Control and back),
    // but the underlying transcript on disk can still have changed while
    // hidden — re-render on regaining visibility so the panel doesn't keep
    // showing a stale snapshot (or, worse, appear stuck "loading" forever
    // if the very first render raced the webview's readiness).
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.render();
      }
    });
    void this.render();
  }

  async open(target: ChatTarget): Promise<void> {
    this.target = target;
    // Best-effort: a Memento write failing must never block opening the chat.
    try {
      await this.state.update(LAST_CHAT_TARGET_KEY, target);
    } catch {
      // Ignore — the panel just won't restore this target next time.
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    void this.render();
  }

  /**
   * `vs-code-ai-helper.openChatData` (plan §5.1's recovery UX): reveal the
   * current target's `chat-v1.json` in the editor so a `chatRecoveryRequired`
   * state (or any other question about what's persisted) can be inspected
   * directly. Never mutates the file.
   */
  async openChatDataForCurrentTarget(): Promise<void> {
    if (!this.target) {
      NotificationRouter.showWarning("Open a chat conversation first.");
      return;
    }
    const uri = vscode.Uri.file(path.join(this.target.taskFolderPath, CHAT_HISTORY_FILENAME));
    try {
      await vscode.window.showTextDocument(uri);
    } catch (error) {
      NotificationRouter.showWarning(
        `Could not open ${CHAT_HISTORY_FILENAME}. (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  /**
   * `vs-code-ai-helper.resetChatHistory` (plan §5.1's recovery UX): after
   * explicit confirmation, clears every unresolved interaction for the
   * current target (settling each as `resetByChatRecovery`) once a verified
   * pre-reset snapshot has been written to private storage. Preserves the
   * document id and display transcript. Never invokes a provider.
   */
  async resetHistoryForCurrentTarget(): Promise<void> {
    if (!this.target) {
      NotificationRouter.showWarning("Open a chat conversation first.");
      return;
    }
    const identity = this.target;
    const confirmed = await vscode.window.showWarningMessage(
      "Reset Chat History clears this conversation's unresolved questions, after saving a private recovery " +
        "snapshot. This cannot be undone from Chat With AI. Continue?",
      { modal: true },
      "Reset Chat History"
    );
    if (confirmed !== "Reset Chat History") {
      return;
    }
    await this.runQueued(identity.taskFolderPath, async () => {
      try {
        const result = await resetChatHistoryV1(identity.taskFolderPath, identity.canonicalId);
        if (!result.ok) {
          NotificationRouter.showWarning(`Could not reset chat history: ${result.reason}`);
        }
      } catch (error) {
        NotificationRouter.showWarning(
          `Could not reset chat history. (${error instanceof Error ? error.message : String(error)})`
        );
      }
    });
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  /** The persisted last-open target, or undefined if none was saved or it no
   * longer resolves to a real task (the global assistant is always valid —
   * it isn't tied to any task folder). Used by `render()` to restore the
   * previous conversation instead of always defaulting to the global
   * assistant when the view is (re)created. */
  private async loadPersistedTarget(): Promise<ChatTarget | undefined> {
    const persisted = this.state.get<ChatTarget>(LAST_CHAT_TARGET_KEY);
    if (!persisted) return undefined;
    if (persisted.kind === "global") return persisted;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(persisted.taskFolderPath));
      return persisted;
    } catch {
      return undefined;
    }
  }

  /**
   * A question is always appended to `question`'s own transcript, regardless
   * of what's currently open — see `append`. The view itself is only
   * switched/focused onto `question`'s task when doing so wouldn't yank the
   * user away from a different task they've since switched to: either
   * nothing is open yet, or the currently open task already is this one. If
   * some other task is current, this must not steal focus back to `question`
   * — that would silently render the answer/question against the wrong task
   * from the user's point of view (see chatWithStage.ts, whose stage runs
   * capture the target task before any await, so a response can complete
   * well after the user has moved on to a different task's chat).
   *
   * `forceOpen` overrides that guard for callers where retargeting is the
   * explicit point of the call — e.g. a newly drafted task's blocking open
   * questions must actually surface in Chat With AI, not just persist unseen
   * in a transcript the user isn't looking at.
   *
   * Every NEW question raised through this method also raises an internal
   * Notifications entry — centralized here (rather than left to each caller
   * to remember) so no question producer can silently skip it. By default
   * that's a warning ("Waiting for user feedback": work can continue
   * without an answer). Pass `notify: { blocking: true }` for questions
   * that genuinely halt progress until answered — those raise an error
   * ("Can't proceed without user feedback") instead. `blockedReason` lets a
   * caller fold in why it's blocked (e.g. a round-limit or escalation
   * reason) without duplicating the notification call itself.
   *
   * Pass `notify: false` for `vs-code-ai-helper.postStageQuestion` (the
   * notification's own "Open Chat" action) re-invoking ask() on an
   * already-raised question — re-notifying every time the user clicks
   * through to the question they were already told about would spam a
   * fresh Notifications entry on every click.
   */
  async ask(
    question: StageChatQuestion,
    forceOpen = false,
    notify: { blocking?: boolean; blockedReason?: string } | false = {}
  ): Promise<void> {
    if (forceOpen || !this.target || sameIdentity(this.target, question)) {
      await this.open(question);
    }
    await this.append("question", question.question, question.stage, question, true);
    notifyDesktop("Ensemble — question", question.question);
    if (notify !== false) {
      this.notifyWaitingForFeedback(question, notify, {
        command: "vs-code-ai-helper.postStageQuestion",
        title: "Open Chat",
        args: [question],
      });
    }
  }

  /**
   * Post a structured-question interaction (plan §6.1) — the universal AI
   * question flow's Chat-side entry point, alongside the legacy free-text
   * `ask()` above. Never invokes a provider; the coordinator settles the
   * interaction only on the user's explicit Resume (via resumeInteraction).
   */
  async askInteraction(
    question: StructuredChatQuestion,
    forceOpen = false,
    notify: { blocking?: boolean; blockedReason?: string } | false = {}
  ): Promise<void> {
    if (forceOpen || !this.target || sameIdentity(this.target, question)) {
      await this.open(question);
    }
    await this.runQueued(question.taskFolderPath, () =>
      appendChatInteraction(question.taskFolderPath, question.canonicalId, {
        interactionId: question.interactionId,
        operationId: question.operationId,
        actionKey: question.actionKey,
        sourceAttemptId: question.sourceAttemptId,
        stage: question.stage,
        questions: question.questions,
        postedAt: new Date().toISOString(),
        binding: question.binding,
      })
    );
    if (sameIdentity(this.target, question)) {
      await this.render();
    }
    notifyDesktop(
      "Ensemble — question",
      question.questions.length === 1 ? question.questions[0]!.prompt : `${question.questions.length} questions to answer`
    );
    if (notify !== false) {
      this.notifyWaitingForFeedback(question, notify);
    }
  }

  private notifyWaitingForFeedback(
    question: ChatTarget,
    { blocking, blockedReason }: { blocking?: boolean; blockedReason?: string },
    /** Absent for a structured interaction: it has no free-text-question reopen command to point at. */
    actionCommand?: { command: string; title: string; args: unknown[] }
  ): void {
    // Guarded rather than assumed-initialized: production always has
    // NotificationRouter up by the time a chat question can be raised, but
    // this keeps ask() safe to call from any context (e.g. tests) that
    // hasn't wired one up.
    if (!getNotificationRouterStatus()) return;
    const label = question.taskName ?? question.taskFolderPath;
    const stageName = STAGE_DISPLAY_NAMES[question.stage];
    if (blocking) {
      NotificationRouter.showError(
        `Can't proceed without user feedback — ${label}: ${blockedReason ?? `${stageName} needs your input.`}`,
        undefined,
        undefined,
        undefined,
        actionCommand
      );
    } else {
      NotificationRouter.showWarning(
        `Waiting for user feedback — ${label}: the ${stageName} stage asked a question.`,
        undefined,
        undefined,
        undefined,
        actionCommand
      );
    }
  }

  /**
   * Append a message to `identity`'s transcript (defaulting to the current
   * target). `identity` must be captured by the caller before any await —
   * see chatWithStage.ts, which captures the task at the start of a run so a
   * response completing after the user switched chats still lands in the
   * originating task's file rather than whatever is currently open.
   */
  async append(
    role: ChatMessage["role"],
    text: string,
    stage: TaskStage,
    identity: ChatIdentity | undefined = this.target,
    pending = false
  ): Promise<void> {
    if (!identity) return;
    const message: ChatMessage = { role, text, stage, at: new Date().toISOString(), pending };
    await this.runQueued(identity.taskFolderPath, () => this.persistAppend(identity, message));

    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  /** Recent conversation is supplied to the runner so a response can safely
   * answer an AI's earlier clarification question rather than becoming an
   * unrelated one-shot prompt. When `stage` is given, only that stage's
   * messages are returned — every stage has a fully separate conversation. */
  async transcript(taskFolderPath: string, canonicalId: string, stage?: TaskStage): Promise<ChatMessage[]> {
    const all = await this.runQueued(taskFolderPath, () =>
      loadTranscriptWithMigration(taskFolderPath, canonicalId, this.state)
    );
    return stage === undefined ? all : all.filter((entry) => entry.stage === stage);
  }

  /**
   * Build the FULL, authoritative interaction ref an interaction service call
   * requires: the client-supplied operation/interaction selector plus the
   * CURRENT task-local Chat document's own binding, read fresh from disk
   * (never trusted from the webview message), plus the referenced
   * interaction's own recorded `sourceAttemptId` — the complete
   * task/document/source-attempt tuple `InteractionRefV1` requires (plan
   * §3.1 / AC-ID-03). Returns `undefined` when no Chat document exists at all
   * for this identity, when no mirrored interaction matches the client's
   * selector, or when that interaction predates `sourceAttemptId` (a legacy
   * mirror record) — the caller should treat any of these as "nothing to act
   * on" rather than send a partial, unvalidatable ref.
   */
  private async resolveInteractionRef(
    identity: ChatIdentity,
    clientRef: ChatInteractionClientRefV1
  ): Promise<ChatInteractionRefV1 | undefined> {
    const docIdentity = await readChatDocumentIdentityV1(identity.taskFolderPath, identity.canonicalId);
    if (!docIdentity) {
      return undefined;
    }
    const interactions = await readChatInteractions(identity.taskFolderPath, identity.canonicalId);
    const interaction = interactions.find(
      (i) => i.interactionId === clientRef.interactionId && i.operationId === clientRef.operationId
    );
    if (!interaction || interaction.sourceAttemptId === undefined) {
      return undefined;
    }
    return {
      operationId: clientRef.operationId,
      interactionId: clientRef.interactionId,
      taskBindingId: docIdentity.taskBindingId,
      chatDocumentId: docIdentity.documentId,
      sourceAttemptId: interaction.sourceAttemptId,
    };
  }

  /**
   * Submit typed answers for the current target's unresolved interaction
   * (plan §6.1's Answer control). When interaction services are wired, the
   * answers are validated and written through the durable transaction store
   * FIRST (plan §5.5: "writes through the transaction before the Chat
   * display state changes") — a rejection there leaves the task-local Chat
   * mirror untouched. Only once that succeeds (or when no durable store is
   * wired yet — matching Resume's "not available yet" degradation) does the
   * mirror get updated. A caller must not invoke a provider from answering
   * alone (plan product decisions); that only happens on explicit Resume.
   *
   * Every outcome is acknowledged in the transcript (contract field 7): a
   * decline (invalid answers, no matching question, a rejected/erroring
   * service call, a failed mirror write) leaves a visible "declined, because
   * X" trace rather than only a `NotificationRouter` entry, which can stack
   * or be dismissed unseen. `successMessage` is overridden by the
   * confirmInteraction path below so the acknowledgement that the ANSWER
   * landed posts immediately here — before Resume (a potentially long-running
   * provider-backed round) even starts — rather than being folded into
   * resumeInteraction's own message and deferred until that round finishes
   * (review-flagged, 2026-08-22: the immediate half of the acknowledgement
   * must not wait on the slow half).
   */
  /** Returns whether the answers were accepted, so a combined Confirm can
   * decide whether resuming is safe — resuming an action whose answer never
   * landed would run it against a question it has no answer for. */
  private async submitInteractionAnswers(
    clientRef: ChatInteractionClientRefV1,
    rawAnswers: unknown,
    successMessage = "Recorded: your answer was submitted."
  ): Promise<boolean> {
    if (!this.target) return false;
    const identity = this.target;
    const decoded = decodeStructuredAnswersArrayV1(rawAnswers);
    if (!decoded.ok) {
      const message = `Could not submit your answers: ${decoded.reason}`;
      NotificationRouter.showWarning(message);
      await this.append("assistant", message, identity.stage, identity);
      return false;
    }
    const result = await this.runQueued(identity.taskFolderPath, () =>
      this.doSubmitInteractionAnswers(identity, clientRef, decoded.answers)
    );
    if (!result.ok) {
      await this.append("assistant", result.message, identity.stage, identity);
    } else {
      await this.append("assistant", successMessage, identity.stage, identity);
    }
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
    return result.ok;
  }

  private async doSubmitInteractionAnswers(
    identity: ChatIdentity,
    clientRef: ChatInteractionClientRefV1,
    answers: readonly StructuredAnswerV1[]
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    if (this.interactionServices) {
      const ref = await this.resolveInteractionRef(identity, clientRef);
      if (!ref) {
        const message = "Could not submit answers: no matching question exists in this task's chat.";
        NotificationRouter.showWarning(message);
        return { ok: false, message };
      }
      let result: ChatInteractionServiceResultV1;
      try {
        result = await this.interactionServices.submitAnswers(
          ref,
          answers,
          crypto.randomBytes(16).toString("hex")
        );
      } catch (error) {
        const message = `Could not submit answers. (${error instanceof Error ? error.message : String(error)})`;
        NotificationRouter.showWarning(message);
        return { ok: false, message };
      }
      if (!result.ok) {
        const message = `Could not submit answers: ${result.reason}`;
        NotificationRouter.showWarning(message);
        return { ok: false, message };
      }
    }
    try {
      await recordChatInteractionAnswers(
        identity.taskFolderPath,
        identity.canonicalId,
        clientRef.interactionId,
        answers
      );
    } catch (error) {
      NotificationRouter.showWarning(
        `Could not save your answers. (${error instanceof Error ? error.message : String(error)})`
      );
      // The transcript record failed, but the answer WAS accepted by the
      // interaction service above — so this is not a submission failure and
      // must not stop a combined Confirm from resuming. Reporting false here
      // would strand an action whose answer is already settled.
    }
    return { ok: true };
  }

  /**
   * Cancel the current target's unresolved interaction (plan §6.1's Cancel
   * control). Never invokes a provider. Every outcome — success or a decline
   * (no matching question, the service refusing, or an unexpected error) —
   * is acknowledged in the transcript (contract field 7): the question card
   * simply vanishes from the panel otherwise, and a decline that only
   * reaches `NotificationRouter` reads identically to the click never
   * registering, which is exactly the ambiguity this task exists to close.
   */
  private async cancelInteraction(clientRef: ChatInteractionClientRefV1): Promise<void> {
    if (!this.target) return;
    const identity = this.target;
    let cancelled = false;
    let declineMessage: string | undefined;
    await this.runQueued(identity.taskFolderPath, async () => {
      try {
        if (this.interactionServices) {
          const ref = await this.resolveInteractionRef(identity, clientRef);
          if (!ref) {
            declineMessage = "Could not cancel: no matching question exists in this task's chat.";
            NotificationRouter.showWarning(declineMessage);
            return;
          }
          const result = await this.interactionServices.cancel(ref);
          if (!result.ok) {
            declineMessage = `Could not cancel: ${result.reason}`;
            NotificationRouter.showWarning(declineMessage);
            return;
          }
        }
        await settleChatInteraction(
          identity.taskFolderPath,
          identity.canonicalId,
          clientRef.interactionId,
          "cancelled"
        );
        cancelled = true;
      } catch (error) {
        declineMessage = `Could not cancel this question. (${error instanceof Error ? error.message : String(error)})`;
        NotificationRouter.showWarning(declineMessage);
      }
    });
    if (cancelled) {
      await this.append(
        "assistant",
        "Recorded: question cancelled — the action that asked it will not continue.",
        identity.stage,
        identity
      );
    } else if (declineMessage) {
      await this.append("assistant", declineMessage, identity.stage, identity);
    }
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  /**
   * Resume the current target's unresolved interaction (plan §6.1's Resume
   * control). Requires the production action coordinator; until it is wired
   * (see ChatInteractionServicesV1's doc comment) this surfaces a clear
   * "not available yet" message rather than silently doing nothing — and,
   * like Cancel above, that refusal is also recorded in the transcript so it
   * is legible as "declined, because X" rather than a click that appeared to
   * do nothing.
   *
   * `successMessage` defaults to the standalone-Resume wording; the combined
   * Confirm path overrides it, since submitInteractionAnswers has already
   * posted its own "your answer was submitted" acknowledgement immediately —
   * repeating that claim here would be redundant.
   */
  private async resumeInteraction(
    clientRef: ChatInteractionClientRefV1,
    successMessage = "Recorded: your answer was submitted and the action is resuming."
  ): Promise<void> {
    if (!this.target) return;
    const unavailableIdentity = this.target;
    if (!this.interactionServices?.resume) {
      NotificationRouter.showWarning(
        "Resume isn't available yet for this question — the action that asked it hasn't been migrated to the new Resume flow."
      );
      await this.append(
        "assistant",
        "Not resumed: Resume isn't available yet for this question — the action that asked it hasn't been migrated to the new Resume flow.",
        unavailableIdentity.stage,
        unavailableIdentity
      );
      return;
    }
    const identity = this.target;
    const services = this.interactionServices;
    const resume = (r: ChatInteractionRefV1, id: string): Promise<ChatInteractionResumeResultV1> =>
      services.resume!(r, id);
    let resumed = false;
    let declineMessage: string | undefined;
    await this.runQueued(identity.taskFolderPath, async () => {
      try {
        const ref = await this.resolveInteractionRef(identity, clientRef);
        if (!ref) {
          declineMessage = "Could not resume: no matching question exists in this task's chat.";
          NotificationRouter.showWarning(declineMessage);
          return;
        }
        const result = await resume(ref, crypto.randomBytes(16).toString("hex"));
        if (!result.ok) {
          declineMessage = `Could not resume: ${result.reason}`;
          NotificationRouter.showWarning(declineMessage);
          return;
        }
        await settleChatInteraction(
          identity.taskFolderPath,
          identity.canonicalId,
          clientRef.interactionId,
          result.settlement
        );
        resumed = true;
      } catch (error) {
        declineMessage = `Could not resume this question. (${error instanceof Error ? error.message : String(error)})`;
        NotificationRouter.showWarning(declineMessage);
      }
    });
    if (resumed) {
      await this.append("assistant", successMessage, identity.stage, identity);
    } else if (declineMessage) {
      await this.append("assistant", declineMessage, identity.stage, identity);
    }
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  /**
   * The decision's own record carries only `taskCanonicalId` + `stage`, not
   * the `taskFolderPath` a transcript append needs — so the identity used to
   * acknowledge a resolution is `this.target` when it is still the exact
   * task/stage the decision belonged to (the only case a webview click could
   * actually have come from). A decision resolved after the user switched
   * chats in the interim (a narrow race) still resolves correctly in the
   * store; it just has nowhere to append a visible acknowledgement, which is
   * no worse than today's silence.
   */
  private identityForDecision(decision: WorkflowDecisionV1): ChatIdentity | undefined {
    return this.target &&
      this.target.kind !== "global" &&
      this.target.canonicalId === decision.taskCanonicalId &&
      this.target.stage === decision.stage
      ? this.target
      : undefined;
  }

  /**
   * Item 6d (wf10 step 7): the "Apply N Reviewer-Verified Ticks" card's claim
   * is a snapshot taken when it was posted — if every item it names gets
   * ticked some other way before the user answers (a later round's own echo,
   * a hand edit, a differently-sourced reconcile), the card is a silent no-op
   * that still reads as pending and actionable. `listPending` above already
   * re-reads the STORE fresh on every render (so a decision resolved
   * elsewhere disappears), but that only re-checks the record's `state`, not
   * whether its underlying claim is still true — a `"pending"` record stays
   * `"pending"` even after its target items are ticked out from under it.
   *
   * Re-derives applicability fresh against the CURRENT plan-final.md on every
   * render, via the exact same `deriveApplicableVerifiedTicksV1` the "Apply"
   * command itself re-runs at accept-time (module doc comment there) — so
   * this can never disagree with what actually happens if the user clicks
   * Apply. Any decision whose derivation is no longer `"ok"` (every item
   * already ticked, the review file is gone, the stage changed) is withdrawn
   * (`dismiss`ed) rather than left presenting as an open question.
   *
   * Scoped to this one `decisionKey` for now, per the task's worked example;
   * other decision kinds have no equivalent cheap, side-effect-free
   * "is this still true?" re-derivation to call here. A derivation failure
   * (I/O error) fails closed — the card stays pending rather than being
   * withdrawn on inconclusive evidence.
   */
  private async withdrawStaleApplyReviewerVerifiedTicksDecisionsV1(
    target: ChatTarget,
    decisions: readonly WorkflowDecisionV1[]
  ): Promise<readonly WorkflowDecisionV1[]> {
    const fresh: WorkflowDecisionV1[] = [];
    const stale: WorkflowDecisionV1[] = [];
    for (const decision of decisions) {
      if (decision.decisionKey !== "applyReviewerVerifiedTicks") {
        fresh.push(decision);
        continue;
      }
      const derived = await deriveApplicableVerifiedTicksV1(
        vscode.Uri.file(target.taskFolderPath),
        decision.stage
      ).catch(() => undefined);
      if (derived === undefined || derived.kind === "ok") {
        fresh.push(decision);
      } else {
        stale.push(decision);
      }
    }
    for (const decision of stale) {
      await this.workflowDecisionStore.dismiss(decision.decisionId).catch(() => undefined);
    }
    return fresh;
  }

  /**
   * The webview's single commit path for a `WorkflowDecisionV1` card:
   * resolve the record in the store FIRST (single-flight — a second press of
   * an already-resolved control reports `alreadySettled` instead of
   * dispatching the option's effect twice), and only once that succeeds does
   * the option's command run. A `doNothing` option simply resolves.
   *
   * `alreadySettled` is presented as an informational notice, never a
   * warning/error — task: "an already-answered decision is not an error".
   *
   * Every resolution is also acknowledged directly in the transcript
   * (task: "a no-op option must acknowledge the click ... the user cannot
   * distinguish 'recorded, and it does nothing' from 'the click was lost'"),
   * because the decision card itself simply disappears from the panel the
   * moment it resolves — with no acknowledgement anywhere else, that read
   * exactly like the click being lost.
   *
   * The race outcomes (`missing`, `rejected`, `alreadySettled`) are no
   * exception (review-flagged, 2026-08-22): they used to be reported only
   * through `NotificationRouter`, which stacks and can be dismissed unseen —
   * the same acknowledgement gap this task exists to close for every other
   * decline path. `clickIdentity` is captured before the resolve() await so a
   * target switch mid-race still acknowledges the task the click actually
   * came from, not whatever is open when the store call returns.
   */
  private async resolveWorkflowDecision(decisionId: string, optionId: string): Promise<void> {
    const clickIdentity =
      this.target && this.target.kind !== "global" ? this.target : undefined;
    const result = await this.workflowDecisionStore.resolve(decisionId, optionId);
    if (result.kind === "missing") {
      const message = "This decision is no longer pending — it may have already been resolved elsewhere.";
      NotificationRouter.showWarning(message);
      if (clickIdentity) await this.append("assistant", message, clickIdentity.stage, clickIdentity);
    } else if (result.kind === "rejected") {
      const message = `Could not record your choice: ${result.reason}`;
      NotificationRouter.showWarning(message);
      if (clickIdentity) await this.append("assistant", message, clickIdentity.stage, clickIdentity);
    } else if (result.kind === "alreadySettled") {
      const message = "This decision was already submitted.";
      NotificationRouter.showInformation(message);
      const identity = this.identityForDecision(result.decision) ?? clickIdentity;
      if (identity) await this.append("assistant", message, result.decision.stage, identity);
    } else if (result.kind === "orphaned") {
      // The operation this decision was gating already ended (its cleanup
      // write failed, but the continuation is gone regardless) — review
      // blocker round 3. Refuse before dispatching anything, and say so
      // rather than leaving the click looking lost.
      const message =
        "This decision's operation has already ended, so this answer can no longer be applied. It will clear on its own.";
      NotificationRouter.showInformation(message);
      if (clickIdentity) await this.append("assistant", message, clickIdentity.stage, clickIdentity);
    } else {
      const { decision, option } = result;
      const identity = this.identityForDecision(decision);
      if (identity) {
        const ackText =
          option.effect.kind === "doNothing"
            ? `Recorded: "${option.label}" — this does nothing further. ${option.consequence}`
            : `Recorded: "${option.label}" — applying now. ${option.consequence}`;
        await this.append("assistant", ackText, decision.stage, identity);
      }
      if (option.effect.kind === "command") {
        try {
          // Some dispatched commands (e.g. goToReviewAndApplyV1) report a
          // failed multi-step sequence by resolving `false` rather than
          // throwing — `setTaskStage` reports its own failures by
          // notification and then returns normally (see
          // goToReviewAndApplyV1.ts), so the only trustworthy signal here is
          // the resolved value. Treating only a thrown error as failure left
          // the "applying now" acknowledgement above standing uncorrected
          // even when the command it described did not actually happen.
          const result = await vscode.commands.executeCommand(
            option.effect.command,
            ...(option.effect.args ?? [])
          );
          if (result === false && identity) {
            await this.append(
              "assistant",
              `"${option.label}" did not complete — see the notification for why. The task may still be in ` +
                "its previous state.",
              decision.stage,
              identity
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          NotificationRouter.showWarning(`"${option.label}" could not be completed. (${message})`);
          if (identity) {
            await this.append(
              "assistant",
              `"${option.label}" could not be completed. (${message})`,
              decision.stage,
              identity
            );
          }
        }
      }
    }
    await this.render();
  }

  private async persistAppend(identity: ChatIdentity, message: ChatMessage): Promise<void> {
    try {
      // Review-flagged (2026-08-23): this used to read a full transcript
      // snapshot via `loadTranscriptWithMigration` and then call
      // `writeChatHistory` with that snapshot plus `message` appended —
      // `writeChatHistory` writes its caller-supplied list verbatim, so any
      // message a DIFFERENT writer appended between the read and the write
      // (e.g. the scheduling-intent auto-start announcement) was silently
      // discarded. `appendChatMessageV1` instead re-reads the CURRENT
      // document inside the shared per-document queue and appends onto its
      // actual current messages, so no racing writer's message can be lost.
      // A first-time migration still runs (its own read has no queue to
      // race against a same-process appender before this document exists),
      // so touch it once to trigger migration, then append atomically.
      await loadTranscriptWithMigration(identity.taskFolderPath, identity.canonicalId, this.state);
      await appendChatMessageV1(identity.taskFolderPath, message, identity.canonicalId);
      this.warnedTasks.delete(identity.taskFolderPath);
    } catch (error) {
      // A persistence failure must not surface as a chat-send failure, and
      // must not stop later messages for this (or any other) task from
      // being attempted — the queue this runs under already keeps advancing.
      if (!this.warnedTasks.has(identity.taskFolderPath)) {
        this.warnedTasks.add(identity.taskFolderPath);
        NotificationRouter.showWarning(
          `Could not save chat history to disk for this task. (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
  }

  /** Chain `op` onto this task's queue so operations on one task's transcript
   * (writes and reads alike) never interleave with one another, while a
   * different task's queue is unaffected. A failed prior operation cannot
   * poison the queue for subsequent ones. */
  private runQueued<T>(taskFolderPath: string, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskFolderPath) ?? Promise.resolve();
    let result!: T;
    const next = previous.catch(() => undefined).then(async () => {
      result = await op();
    });
    this.queues.set(taskFolderPath, next);
    return next.then(() => result);
  }

  private async render(): Promise<void> {
    // No target chosen yet: restore whatever conversation was last open
    // (e.g. after a window reload) before falling back to the global
    // assistant, so the panel is usable immediately either way. The
    // factory/restore can both legitimately come up empty; the panel then
    // keeps its empty state.
    if (!this.target) {
      try {
        const restored = await this.loadPersistedTarget();
        // Re-check: an open() may have landed while this resolved.
        if (restored && !this.target) {
          this.target = restored;
        }
      } catch {
        // Fall through to the default-target factory below.
      }
    }
    if (!this.target && this.defaultTargetFactory) {
      try {
        const fallback = await this.defaultTargetFactory();
        // Re-check: an open() may have landed while the factory resolved.
        if (fallback && !this.target) {
          this.target = fallback;
        }
      } catch {
        // Keep the empty state.
      }
    }
    // Captured before the (now async, file-backed) transcript read so a
    // target switch mid-read can be detected and the stale render dropped
    // instead of painting one task's history into another's view.
    const target = this.target;
    let entries: ChatMessage[] = [];
    let interaction: ChatDocumentInteractionV1 | undefined;
    let errorMessage: string | undefined;
    let emptyNotice: string | undefined;
    // A completed/archived task's conversation is hidden, not deleted: skip
    // the transcript read entirely and show an explanatory empty state. The
    // history file stays on disk, and resume/reopen (which flips the status
    // back to active) surfaces it again with no further work here.
    const taskStatus =
      target && target.kind !== "global"
        ? this.interactionServices?.getTaskStatus?.(target.canonicalId)
        : undefined;
    const historyHidden = taskStatus === "completed" || taskStatus === "archived";
    if (historyHidden) {
      emptyNotice = `This task is ${taskStatus}, so its chat is hidden. Resume or reopen the task to see the conversation again.`;
    } else if (target) {
      try {
        // Stage chats are fully isolated: a stage's view never shows another
        // stage's conversation. The global assistant's history lives in its
        // own dedicated folder, so it is separate by construction.
        entries = await this.transcript(
          target.taskFolderPath,
          target.canonicalId,
          target.kind === "global" ? undefined : target.stage
        );
        // The most recent unresolved structured-question interaction, if
        // any, for this same stage-isolated scope (plan §6.1). A read
        // failure here must not break the rest of Chat — nothing in
        // production posts these yet, so it degrades to "none" silently
        // rather than surfacing a second error channel alongside the
        // transcript's own.
        const interactions = await readChatInteractions(
          target.taskFolderPath,
          target.canonicalId,
          target.kind === "global" ? undefined : target.stage
        ).catch(() => [] as ChatDocumentInteractionV1[]);
        interaction = interactions
          .slice()
          .reverse()
          .find((i) => i.state === "unresolved");
      } catch (error) {
        // A transcript that fails to read (e.g. corrupt and unquarantinable —
        // see chatHistoryStore's readChatHistory) must not crash render(), or
        // by extension append()/ask() callers that await it. Show it as
        // empty and warn once, mirroring persistAppend's own containment.
        const isRecovery = error instanceof ChatHistoryRecoveryErrorV1;
        if (!this.warnedTasks.has(target.taskFolderPath)) {
          this.warnedTasks.add(target.taskFolderPath);
          if (isRecovery) {
            // plan §5.1: offer both Open Chat Data and Reset Chat History.
            // NotificationRouter carries one action button per entry, so
            // Reset (the actionable recovery path) gets the button; Open
            // Chat Data is named in the message text as the inspect-first
            // alternative, and is always reachable from the Command Palette.
            NotificationRouter.showWarning(
              `Chat history needs recovery for this task. (${error.message}) Use "Ensemble: Open Chat Data" to ` +
                "inspect the preserved file, or reset it below.",
              undefined,
              undefined,
              undefined,
              { command: "vs-code-ai-helper.resetChatHistory", title: "Reset Chat History" }
            );
          } else {
            NotificationRouter.showWarning(
              `Could not load chat history for this task. (${error instanceof Error ? error.message : String(error)})`
            );
          }
        }
        errorMessage = isRecovery
          ? "Chat history needs recovery. Use \"Ensemble: Open Chat Data\" or \"Ensemble: Reset Chat History\" from the Command Palette."
          : "Chat history could not be loaded. Check the Notifications view for details.";
      }
    }
    if (!sameIdentity(target, this.target)) return;
    // Pending `WorkflowDecisionV1` records for this exact task/stage (the
    // global assistant never carries decisions — they are always stage-
    // scoped). Read fresh on every render so a decision resolved from
    // elsewhere (or superseded by a repost) disappears without a stale
    // control lingering in the panel.
    const pendingDecisions: readonly WorkflowDecisionV1[] =
      target && target.kind !== "global"
        ? await this.withdrawStaleApplyReviewerVerifiedTicksDecisionsV1(
            target,
            this.workflowDecisionStore.listPending(target.canonicalId).filter((d) => d.stage === target.stage)
          )
        : [];
    // Distinguish genuinely-running work from an operation that is merely
    // parked waiting on the user's answer (round-limit pause, a pending
    // question, etc.) — the latter must never show the busy spinner, which
    // reads as "the computer is working, leave it alone" and is exactly
    // backwards when it's actually this chat that's waiting on the user.
    const targetOps = target ? taskOperations.getTaskOperations(target.canonicalId) : [];
    // A trailing pending question (no reply after it yet) drives only the
    // per-message "— awaiting your answer" label further down; it plays no
    // part in busy/waitingForUser/badge, which are derived exclusively from
    // live `taskOperations` entries below (a persisted-only question is real
    // and still renders with that label, but does not by itself justify an
    // ACTIVE posture claim — see the block below).
    const awaitingQuestionIndices = computeAwaitingQuestionIndices(entries);
    // `busy` and `waitingForUser` are the panel's two ACTIVE POSTURE banners
    // (the `b` element in the webview: "Waiting for the AI…" with a spinner,
    // or "Waiting for your answer" without one). Both are held to the exact
    // same rule, per AC3's own text verbatim: "The chat panel cannot show a
    // pending posture without a live in-flight transaction." Neither may ever
    // be sourced from a persisted, potentially-stale record — only a live
    // `taskOperations` entry can set either one, and both fall the instant
    // that entry ends, since nothing else survives to justify an ACTIVE claim
    // once the round that created it has finished.
    //
    // Review-flagged (2026-08-22, rounds 2-3): an earlier version of this
    // code also set `waitingForUser` from a persisted-but-not-live
    // `openInteraction`/`openQuestion`/`openDecision` record, reasoning that
    // Part 4.2's "settled renders settled... with or without controls"
    // implied the converse (unsettled renders as an ACTIVE waiting posture).
    // The review (rounds 2-4) rejected that reading: Part 4.2 requires the
    // record's CONTENT and answer controls to keep rendering — which
    // `renderInteraction`, `renderDecisions`, and each message's
    // `awaitingAnswer` label (below) do UNCONDITIONALLY, regardless of
    // `waitingForUser` — not that the panel additionally assert an active
    // "waiting" banner with zero live evidence that anything is in flight.
    // Doing so left `waitingForUser === true` even when NO `taskOperations`
    // entry existed anywhere for the task, which is exactly the "pending
    // posture without a live in-flight transaction" AC3 prohibits. A record
    // that is merely unresolved is not itself a transaction — the content it
    // carries is real and stays visible either way, but the posture claim is
    // not.
    //
    // `waitingForUserSource` is therefore now `"liveOperation" | undefined`
    // only — kept as a named/verifiable source (not a bare boolean) so a
    // future addition can't quietly reintroduce an unbacked claim without
    // updating this type. The invariant tests in
    // chatViewWorkflowDecision.test.ts ("waitingForUser is only ever
    // asserted from a live operation" and "neither active posture is shown
    // for a persisted-only record, even with all three waiting sources open
    // at once") verify both directions: `true` only ever traces to a live
    // `taskOperations` entry, and all three persisted-only sources — alone or
    // combined, with zero live operations — leave both `busy` and
    // `waitingForUser` false while their content still renders in full.
    const waitingForUserSource: "liveOperation" | undefined = targetOps.some((op) => op.waitingForUser)
      ? "liveOperation"
      : undefined;
    const waitingForUser = waitingForUserSource !== undefined;
    const busy = !waitingForUser && targetOps.some((op) => !op.waitingForUser);
    // Part 4.3: "Where a transport genuinely reports nothing until it
    // finishes, render that statement explicitly (contract rule: explicit
    // unknown, not implied wait)." Most busy operations never call
    // `TaskOperationHandle.report(detail)`, so a bare "Waiting for the AI…"
    // reads as an implied wait with no way to tell whether progress is being
    // narrated or not. `busyDetail` surfaces the most recently started
    // non-waiting op's `detail` when one exists (e.g. a review loop's
    // "iteration 2/3"); when none of the live ops have reported anything,
    // it is left `undefined` and the webview renders the explicit
    // no-status-available statement instead of a bare spinner.
    const busyDetail = busy
      ? [...targetOps]
          .filter((op) => !op.waitingForUser && op.detail !== undefined)
          .sort((a, b) => b.startedAt - a.startedAt)[0]?.detail
      : undefined;
    // Always show the associated task: the task name when available,
    // otherwise the folder's date/task-ID code — with no bracketed raw
    // stage id. The global assistant is labeled as a global assistant.
    let label: string | undefined;
    if (target?.kind === "global") {
      label = "Global Assistant — cross-task actions (Uses the model currently set for Task Description)";
    } else if (target) {
      const taskLabel = target.taskName ?? target.taskFolderPath.replace(/\\/g, "/").split("/").pop() ?? "task";
      label = `${formatTaskNameForDisplay(taskLabel)} — ${STAGE_DISPLAY_NAMES[target.stage]} stage chat`;
    }
    // Attribution comments belong in generated artifact files, not in a
    // conversation — strip them from every displayed message (including
    // messages persisted before this stripping existed). The webview script
    // cannot import host-side code, so the HH:mm label and its full-date
    // tooltip are pre-formatted here from `entry.at` (an ISO string) using
    // the same helper the Notifications view uses.
    //
    // `awaitingAnswer` (not the raw persisted `pending` flag) drives the
    // "— awaiting your answer" label: `pending` stays true on a `question`
    // message forever once a follow-up reply supersedes it (module comment
    // on `ChatMessage.pending` — a question is pending "until the user sends
    // a follow-up message", and nothing ever rewrites the earlier message),
    // so rendering straight off `pending` kept showing already-answered
    // escalation questions as still awaiting an answer even after the user
    // had replied (the "7 persisted, 6 visible" defect: the extra entry was
    // this stale label, not a missing render). `computeAwaitingQuestionIndices`
    // (the same source `awaitingQuestionIndices` above uses, so the two can
    // never disagree) settles a question only on a later `role: "user"` entry — an unrelated
    // assistant/system message appended after it must NOT falsely settle it.
    const displayEntries = entries.map((entry, index) => {
      const date = new Date(entry.at);
      return {
        ...entry,
        text: stripAttributionHeaders(entry.text),
        atLabel: formatTimestampForDisplay(date),
        atTitle: date.toLocaleString(),
        awaitingAnswer: awaitingQuestionIndices.has(index),
      };
    });
    // The webview script cannot import host-side code (see the comment on
    // `displayEntries` above), so the hand-off contract's "gating" line is
    // pre-rendered here. A decision that supplies `gating` (task PART 5)
    // renders its real content; one that does not (any record persisted
    // before PART 5 — every production creation site, including
    // `reviewActions.ts`'s `providerChainExhausted`, now supplies it, tracked
    // in `workflowDecisionGatingInventoryV1.test.ts`) falls back to an
    // explicit "not recorded" line. The absence reason passed is deliberately
    // `"unknown"`, not `"legacyRecord"`: this renderer cannot tell a record
    // that predates the field apart from one created today by a call site
    // that regresses and omits it, so claiming "older record" for both would
    // assert something not provably true — the exact "absence is never
    // positive evidence" defect this contract exists to fix.
    //
    // The card's highlight (`isGating`) is derived from `holdsTaskPaused`,
    // NOT `unblocksProgress`: whether THIS decision is the reason the task is
    // currently paused (ownership) is a different fact from whether choosing
    // an option here is expected to move the task forward (see
    // `HandoffGatingV1`'s doc comment) — a decision can hold the task paused
    // without every option being guaranteed to unblock it (e.g. a "wait"
    // choice), and conflating the two either falsely denies pause ownership
    // or falsely promises an unblock.
    const displayDecisions = pendingDecisions.map((decision) => ({
      ...decision,
      gatingLine: renderHandoffFieldLineV1(
        "decisionRecord",
        "gating",
        decision.gating !== undefined ? { gating: decision.gating } : undefined,
        "unknown"
      ).text,
      isGating: decision.gating?.holdsTaskPaused === true,
      // Headline/severity predicate — distinct from `isGating` above (which
      // deliberately tracks `holdsTaskPaused` alone for the border
      // highlight). This is "is the user's answer actually awaited by
      // something", so it also considers `unblocksProgress`: a decision that
      // does not hold the task paused but whose resolution does move it
      // forward still deserves the blocking "Decision needed" headline.
      // Unknown gating (undefined, predates the field) defaults to blocking —
      // absence is never positive evidence.
      isBlockingDecision:
        decision.gating === undefined ||
        decision.gating.holdsTaskPaused === true ||
        decision.gating.unblocksProgress === true,
    }));
    // "What happens next" — the chat panel's half of the always-present
    // scheduling posture (task "Actionable Hand-offs", PART 6; the task-tree
    // tooltip built in `taskTreeProvider.ts`'s `computeSchedulingPosture` is
    // the other, structurally identical half). A failure deriving/rendering
    // the posture must still render the contract's explicit-unknown line
    // (review-flagged 2026-08-23: this used to leave the line unset on any
    // exception, which the webview then hides entirely — silence, not the
    // required "unknown" statement, exactly the "absence is never positive
    // evidence" defect this contract exists to prevent).
    let schedulingPostureLine: string | undefined;
    if (target && target.kind !== "global") {
      try {
        const progressResult = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
        // A failed/unreadable progress read is NOT evidence that no
        // continuation is owed (review-flagged 2026-08-23) — it means this
        // render cannot establish that fact at all, so it must not feed
        // `owedContinuation: undefined` into the posture (which would read as
        // a positive "nothing owed" and could fall through to the false
        // `waitingForYou` posture). `owedContinuationUnknown` forces the
        // explicit `unknown` fallback instead whenever the read did not
        // succeed.
        const progress = progressResult.ok ? progressResult.decoded.progress : undefined;
        const owedSource = progress?.implRecovery
          ? {
              reason: progress.implRecovery.reason,
              at: progress.implRecovery.at,
              leaseUntil: progress.implRecovery.leaseUntil,
              quarantinedFiles: progress.pendingImplReviewFiles ?? [],
              dispatch: progress.implRecovery.dispatch,
            }
          : undefined;
        // PART 6.5 (review-flagged 2026-08-23, resolved this round): every
        // `implRecovery` mutation site now pushes through
        // `syncOwedContinuationLedgerBestEffortV1` right after its own CAS
        // resolves (see `schedulingIntentV1.ts`'s `OwedContinuationRecordV1`
        // doc comment for the full nine-site inventory) — the ledger is no
        // longer a "some sites missing" degraded fallback. This render still
        // performs its own fresh `TaskProgress` read (the one piece no other
        // site can substitute for: a DIFFERENT window's direct file mutation,
        // or a process that died between committing the CAS and running its
        // ledger push) and writes it through here, but posture is now
        // DERIVED FROM THE LEDGER's own read-back — never from `owedSource`
        // directly — so this satisfies AC5's "rendered only from the ledger"
        // contract while staying exactly as fresh as a live read (the
        // ledger's value IS this read, one line earlier).
        if (progressResult.ok) {
          await this.schedulingIntentStore.recordOwedContinuation(target.canonicalId, owedSource);
        }
        const ledgerOwedSource = this.schedulingIntentStore.getOwedContinuation(target.canonicalId);
        // A failed/unreadable progress read cannot establish the fact live —
        // the ledger's last-recorded value (from this window's own most
        // recent successful push, at this render or at any mutation site) is
        // still positive evidence and is preferred over forcing `unknown`;
        // only a ledger that has NEVER recorded anything for this task
        // degrades to `unknown` via `owedContinuationUnknown` below.
        const posture = deriveSchedulingPostureV1({
          entries: this.schedulingIntentStore.listForTask(target.canonicalId),
          owedContinuation: deriveOwedContinuationRecordV1(target.canonicalId, ledgerOwedSource),
          hasCoverage: this.schedulingIntentStore.hasCoverage(target.canonicalId),
          inFlight: taskOperations.rootOperationIdFor(target.canonicalId) !== undefined,
          owedContinuationUnknown: !progressResult.ok && ledgerOwedSource === undefined,
        });
        schedulingPostureLine = renderRequiredHandoffFieldsV1("scheduledWork", describeSchedulingPostureV1(posture))
          .map((line) => line.text)
          .join(" ");
      } catch {
        // A failure deriving the posture is exactly the "cannot establish
        // the fact" case the `unknown` posture exists for — never silence,
        // never a guess at `waitingForYou`/`running`.
        schedulingPostureLine = renderRequiredHandoffFieldsV1("scheduledWork", describeSchedulingPostureV1({ kind: "unknown" }))
          .map((line) => line.text)
          .join(" ");
      }
      // The progress read above is async: a target switch mid-read must drop
      // this stale render rather than painting one task's scheduling posture
      // into another's (or the global assistant's) header — same rule the
      // transcript read above is already held to.
      if (!sameIdentity(target, this.target)) return;
    }
    // A small badge on the view itself draws the eye even when this panel is
    // present but not the currently focused element, mirroring how other
    // views badge unread/actionable counts. It asserts the exact same claim
    // as the `waitingForUser` banner ("something needs you right now"), just
    // on a different widget, so it is held to the identical AC3 rule: only a
    // live `taskOperations` entry may justify it. A pending question, open
    // interaction, or pending decision with no live operation behind it
    // (e.g. after a window reload) is real and still renders in the panel
    // body either way — it just no longer lights this badge, since nothing
    // live is actually happening right now.
    if (this.view) {
      this.view.badge = waitingForUser ? { value: 1, tooltip: "Waiting for your answer" } : undefined;
    }
    await this.view?.webview.postMessage({
      type: "state",
      target: this.target,
      label,
      schedulingPostureLine,
      entries: displayEntries,
      interaction,
      decisions: displayDecisions,
      busy,
      busyDetail,
      waitingForUser,
      waitingForUserSource,
      errorMessage,
      emptyNotice,
    });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <style>
        :root {
          --ensemble-space-1: 4px;
          --ensemble-space-2: 8px;
          --ensemble-space-3: 12px;
          --ensemble-space-4: 16px;
          --ensemble-border-width: 1px;
          --ensemble-focus-width: 2px;
          --ensemble-radius: 3px;
        }
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: var(--ensemble-space-2) var(--ensemble-space-3);
          margin: 0;
        }
        #context {
          color: var(--vscode-foreground);
          font-weight: bold;
          font-size: 1.1em;
          margin: 0 0 var(--ensemble-space-3);
          padding-bottom: var(--ensemble-space-2);
          border-bottom: var(--ensemble-border-width) solid var(--vscode-panel-border);
        }
        #scheduling-posture {
          color: var(--vscode-descriptionForeground);
          font-size: 0.9em;
          margin: 0 0 var(--ensemble-space-3);
          display: none;
        }
        #scheduling-posture.visible {
          display: block;
        }
        #messages {
          margin: 0 0 var(--ensemble-space-2);
        }
        .msg-row {
          margin: 0 0 var(--ensemble-space-2);
        }
        .msg-meta {
          display: flex;
          align-items: center;
          gap: var(--ensemble-space-1);
          font-size: 0.85em;
          color: var(--vscode-descriptionForeground);
          margin-top: 2px;
        }
        .msg-copy {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--vscode-descriptionForeground);
          padding: 0 var(--ensemble-space-1);
          font-size: 1em;
          line-height: 1;
        }
        .msg-copy:hover {
          color: var(--vscode-foreground);
        }
        #messages p {
          margin: 0;
          line-height: 1.4;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          padding: var(--ensemble-space-2);
          border-radius: var(--ensemble-radius);
        }
        /* The user's own messages: same foreground-on-background pairing as
           the rest of the extension's text, with a foreground-colored border
           standing in for a distinct background (so it reads correctly in
           high-contrast themes, where a "highlight" background token can end
           up lighter than the foreground text meant to sit on it). */
        #messages p.msg-user {
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          border: var(--ensemble-border-width) solid var(--vscode-foreground);
        }
        /* Agent/assistant messages: a distinct surface instead of a border,
           so the two roles are never confused at a glance. */
        #messages p.msg-agent {
          color: var(--vscode-editor-foreground);
          background-color: var(--vscode-sideBar-background);
          border: none;
        }
        .spinner {
          display: inline-block;
          width: 1em;
          height: 1em;
          border: var(--ensemble-focus-width) solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          vertical-align: text-bottom;
          margin-right: 0.5em;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .spinner {
            animation: none;
          }
        }
        #busy-indicator {
          display: none;
          margin: var(--ensemble-space-2) 0;
          font-style: italic;
          color: var(--vscode-descriptionForeground);
        }
        #empty-notice {
          display: none;
          margin: var(--ensemble-space-2) 0;
          font-style: italic;
          color: var(--vscode-descriptionForeground);
        }
        #error {
          display: none;
          margin: var(--ensemble-space-2) 0;
          padding: var(--ensemble-space-2);
          color: var(--vscode-inputValidation-errorForeground);
          background-color: var(--vscode-inputValidation-errorBackground);
          border: var(--ensemble-border-width) solid var(--vscode-inputValidation-errorBorder);
        }
        #form {
          display: flex;
          flex-direction: column;
          gap: var(--ensemble-space-2);
          margin-top: var(--ensemble-space-3);
        }
        #form textarea {
          resize: vertical;
          font-family: inherit;
          font-size: inherit;
          background-color: var(--vscode-input-background, var(--vscode-editor-background));
          color: var(--vscode-input-foreground, var(--vscode-foreground));
          border: var(--ensemble-border-width) solid var(--vscode-input-border, var(--vscode-widget-border));
          padding: var(--ensemble-space-2);
          border-radius: var(--ensemble-radius);
          box-sizing: border-box;
        }
        #form textarea:focus {
          outline: var(--ensemble-focus-width) solid var(--vscode-focusBorder);
          outline-offset: var(--ensemble-border-width);
        }
        #form button {
          align-self: flex-end;
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: var(--ensemble-space-1) var(--ensemble-space-3);
          cursor: pointer;
          border-radius: var(--ensemble-radius);
        }
        #form button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        #form button:focus-visible { outline: var(--ensemble-focus-width) solid var(--vscode-focusBorder); outline-offset: var(--ensemble-border-width); }
        #interaction {
          display: none;
          margin: 0 0 var(--ensemble-space-3);
          padding: var(--ensemble-space-3);
          border: var(--ensemble-border-width) solid var(--vscode-panel-border);
          border-radius: var(--ensemble-radius);
          background-color: var(--vscode-sideBar-background);
        }
        .interaction-title { font-weight: bold; margin-bottom: var(--ensemble-space-2); }
        .interaction-question { margin-bottom: var(--ensemble-space-3); }
        .interaction-prompt { margin-bottom: var(--ensemble-space-1); }
        .interaction-help { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: var(--ensemble-space-1); }
        .interaction-option { display: block; margin: var(--ensemble-space-1) 0; }
        .interaction-question textarea {
          width: 100%; box-sizing: border-box; font-family: inherit; font-size: inherit;
          background-color: var(--vscode-input-background, var(--vscode-editor-background));
          color: var(--vscode-input-foreground, var(--vscode-foreground));
          border: var(--ensemble-border-width) solid var(--vscode-input-border, var(--vscode-widget-border));
          padding: var(--ensemble-space-2); border-radius: var(--ensemble-radius);
        }
        .interaction-error {
          display: none; color: var(--vscode-inputValidation-errorForeground);
          background-color: var(--vscode-inputValidation-errorBackground);
          border: var(--ensemble-border-width) solid var(--vscode-inputValidation-errorBorder);
          padding: var(--ensemble-space-2); border-radius: var(--ensemble-radius); margin-bottom: var(--ensemble-space-2);
        }
        .interaction-actions { display: flex; gap: var(--ensemble-space-2); }
        .interaction-actions button {
          background-color: var(--vscode-button-background); color: var(--vscode-button-foreground);
          border: none; padding: var(--ensemble-space-1) var(--ensemble-space-3); cursor: pointer; border-radius: var(--ensemble-radius);
        }
        .interaction-actions button:hover { background-color: var(--vscode-button-hoverBackground); }
        .interaction-actions button.secondary {
          background-color: transparent; color: var(--vscode-foreground);
          border: var(--ensemble-border-width) solid var(--vscode-widget-border);
        }
        #decisions { display: none; }
        .decision-card { margin: 0 0 var(--ensemble-space-3); }
        .decision-why { margin-bottom: var(--ensemble-space-2); }
        .decision-evidence {
          margin: 0 0 var(--ensemble-space-2); padding: var(--ensemble-space-2);
          background-color: var(--vscode-editor-background);
          border: var(--ensemble-border-width) solid var(--vscode-panel-border);
          border-radius: var(--ensemble-radius); font-size: 0.9em;
        }
        .decision-evidence-title { font-weight: bold; margin-bottom: var(--ensemble-space-1); }
        .decision-option { display: block; margin: var(--ensemble-space-2) 0; }
        .decision-option-consequence { margin: 0 0 0 1.5em; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
        .decision-option-destructive { color: var(--vscode-inputValidation-errorForeground); font-weight: bold; }
        .decision-recommendation { margin: var(--ensemble-space-2) 0; font-style: italic; color: var(--vscode-descriptionForeground); }
        .decision-gating { margin: 0 0 var(--ensemble-space-2); font-size: 0.9em; color: var(--vscode-descriptionForeground); }
        .decision-card.decision-card-gating { border-left: 3px solid var(--vscode-inputValidation-warningBorder); padding-left: var(--ensemble-space-2); }
        .decision-gating.decision-gating-active { color: var(--vscode-inputValidation-warningForeground); font-weight: bold; }
        .decision-paused-note { margin: 0 0 var(--ensemble-space-3); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
      </style>
      </head><body>
      <div id="context" role="status">Loading chat…</div><div id="scheduling-posture" role="status"></div><div id="messages" role="log" aria-live="polite" aria-label="Conversation"></div>
      <div id="interaction" role="form" aria-label="Question from the AI"></div>
      <div id="decisions" role="list" aria-label="Pending workflow decisions"></div>
      <div id="empty-notice" role="status"></div>
      <div id="error" role="alert"></div>
      <div id="busy-indicator" role="status" aria-live="polite"><span id="busy-spinner" class="spinner"></span><span id="busy-text">Waiting for the AI…</span></div>
      <form id="form"><textarea id="message" rows="3" aria-label="Message the AI" placeholder="Message the AI… (Enter to send, Shift+Enter for a new line)"></textarea><button type="submit" title="Send message (Enter)">Send</button></form>
      <script nonce="${nonce}">const v=acquireVsCodeApi(), c=document.getElementById('context'), sp=document.getElementById('scheduling-posture'), m=document.getElementById('messages'), ic=document.getElementById('interaction'), dc=document.getElementById('decisions'), en=document.getElementById('empty-notice'), e=document.getElementById('error'), b=document.getElementById('busy-indicator'), bs=document.getElementById('busy-spinner'), bt=document.getElementById('busy-text'), f=document.getElementById('form'), i=document.getElementById('message');
      const savedState = v.getState() || {};
      const scrollPositions = savedState.scrollPositions || {};
      let currentKey;
      function targetKey(t){ if(!t) return ''; return t.kind==='global' ? 'global' : (t.canonicalId+':'+t.stage); }
      function isNearBottom(){ return (document.documentElement.scrollHeight-window.scrollY-window.innerHeight)<60; }
      function persistScroll(){ if(currentKey===undefined) return; scrollPositions[currentKey]=window.scrollY; v.setState({scrollPositions:scrollPositions}); }
      window.addEventListener('scroll', persistScroll);
      // Renders one structured-question interaction (plan §6.1's universal
      // question flow) with typed Answer/Resume/Cancel controls. Answer
      // collection returns null for an invalid/unanswered required question
      // so the caller can show an inline error instead of posting an invalid
      // submission — enforcing the SAME rules the durable store's strict
      // decoder enforces server-side (structuredQuestionV1.ts's
      // validateStructuredAnswersV1): a "skipped" answer is only legal for an
      // optional question (a required, blank-allowed text question that is
      // left blank is submitted as answered with an empty value, not
      // skipped), and a multiple-choice selection must fall within the
      // question's declared [minSelections, maxSelections] bounds. Prior
      // answers already recorded on the interaction (e.g. a crash-recovered
      // submission — see chatHistoryStore.ts's RECONCILIATION section) are
      // hydrated into the controls instead of always starting blank.
      function renderInteraction(interaction){
        ic.replaceChildren();
        if(!interaction){ ic.style.display='none'; return; }
        ic.style.display='block';
        const err=document.createElement('div'); err.className='interaction-error';
        ic.appendChild(err);
        const title=document.createElement('div'); title.className='interaction-title';
        title.textContent='This action needs your input:';
        ic.appendChild(title);
        const priorAnswers={};
        for(const a of (interaction.answers||[])){ priorAnswers[a.questionId]=a; }
        const getters={};
        for(const q of interaction.questions){
          const wrap=document.createElement('div'); wrap.className='interaction-question';
          const label=document.createElement('div'); label.className='interaction-prompt';
          label.textContent=q.prompt+(q.required?' *':' (optional)');
          wrap.appendChild(label);
          if(q.helpText){ const help=document.createElement('div'); help.className='interaction-help'; help.textContent=q.helpText; wrap.appendChild(help); }
          const prior=priorAnswers[q.questionId];
          if(q.kind==='text'){
            const ta=document.createElement('textarea'); ta.rows=2; ta.maxLength=${DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1}; ta.setAttribute('aria-label',q.prompt);
            if(prior && prior.state==='answered') ta.value=prior.value;
            wrap.appendChild(ta);
            getters[q.questionId]=()=>{
              const val=ta.value;
              if(!val){
                if(!q.required) return {questionId:q.questionId,kind:'text',state:'skipped'};
                // A required question can never be submitted as "skipped" —
                // that state is reserved for optional questions. Blank
                // acceptance is derived from "required" only (exactly what
                // textAnswerPolicyV1 derives server-side), never read off
                // q.allowBlank: a historical persisted record's stored value
                // is migration-only data and must not drive runtime UI
                // behaviour. required===true here always means blank is
                // disallowed, so a required question left blank is invalid.
                return null;
              }
              return {questionId:q.questionId,kind:'text',state:'answered',value:val};
            };
          } else if(q.kind==='singleChoice'){
            const groupName='q-'+q.questionId;
            for(const opt of q.options){
              const optWrap=document.createElement('label'); optWrap.className='interaction-option';
              const radio=document.createElement('input'); radio.type='radio'; radio.name=groupName; radio.value=opt.optionId;
              if(prior && prior.state==='answered' && prior.selectedOptionId===opt.optionId) radio.checked=true;
              optWrap.appendChild(radio); optWrap.appendChild(document.createTextNode(' '+opt.label));
              wrap.appendChild(optWrap);
            }
            getters[q.questionId]=()=>{
              const checked=wrap.querySelector('input[name="'+groupName+'"]:checked');
              if(!checked){ return q.required ? null : {questionId:q.questionId,kind:'singleChoice',state:'skipped'}; }
              return {questionId:q.questionId,kind:'singleChoice',state:'answered',selectedOptionId:checked.value};
            };
          } else {
            const priorSelected=new Set(prior && prior.state==='answered' ? prior.selectedOptionIds : []);
            for(const opt of q.options){
              const optWrap=document.createElement('label'); optWrap.className='interaction-option';
              const cb=document.createElement('input'); cb.type='checkbox'; cb.value=opt.optionId;
              if(priorSelected.has(opt.optionId)) cb.checked=true;
              optWrap.appendChild(cb); optWrap.appendChild(document.createTextNode(' '+opt.label));
              wrap.appendChild(optWrap);
            }
            getters[q.questionId]=()=>{
              const checked=[...wrap.querySelectorAll('input[type=checkbox]:checked')].map(el=>el.value);
              if(checked.length===0){ return q.required ? null : {questionId:q.questionId,kind:'multipleChoice',state:'skipped'}; }
              // A non-empty selection must still fall within the question's
              // declared cardinality bounds, whether or not the question is
              // required — an out-of-bounds selection is never "skipped".
              if(checked.length<q.minSelections || checked.length>q.maxSelections){ return null; }
              return {questionId:q.questionId,kind:'multipleChoice',state:'answered',selectedOptionIds:checked};
            };
          }
          ic.appendChild(wrap);
        }
        function collect(){
          const answers=[];
          for(const q of interaction.questions){
            const a=getters[q.questionId]();
            if(a===null){
              const bounds=q.kind==='multipleChoice' ? ' (choose '+q.minSelections+'-'+q.maxSelections+' option(s))' : '';
              err.textContent='Please answer: '+q.prompt+bounds; err.style.display='block'; return null;
            }
            answers.push(a);
          }
          err.style.display='none';
          return answers;
        }
        // ONE commit path. The previous three buttons were 'Save Answers'
        // (submit, do not continue), 'Resume' (submit AND continue) and
        // 'Cancel'. Two of them submitted, so reading the labels literally —
        // save, then resume — submitted twice and failed the second with
        // interactionAlreadySettled. 'Save Answers' also had no user-facing
        // purpose: nothing later consumes a recorded-but-unresumed answer.
        // 'Resume' named the system's concept (an action resuming) rather
        // than the user's (going ahead with a choice).
        const actions=document.createElement('div'); actions.className='interaction-actions';
        const confirmBtn=document.createElement('button'); confirmBtn.type='button'; confirmBtn.textContent='Confirm';
        confirmBtn.addEventListener('click',()=>{
          const answers=collect(); if(!answers) return;
          // Acknowledge the press immediately and make a second one
          // impossible. The absence of any visible change is what caused a
          // user to press again and collect a second failure for answers
          // that had already been recorded correctly.
          confirmBtn.disabled=true; cancelBtn.disabled=true; confirmBtn.textContent='Confirmed';
          v.postMessage({type:'confirmInteraction',operationId:interaction.operationId,interactionId:interaction.interactionId,answers});
        });
        // Escape hatch for "none of these options fit". Deliberately does NOT
        // settle the interaction — it just puts the cursor in the composer so
        // the user can say what they actually want. Settling here would
        // discard a question they are about to answer in prose.
        const chatBtn=document.createElement('button'); chatBtn.type='button'; chatBtn.className='secondary';
        chatBtn.textContent='Answer in chat instead';
        chatBtn.title='Leaves the question open and puts the cursor in the message box, so you can reply in your own words.';
        chatBtn.addEventListener('click',()=>{ const box=document.getElementById('message'); if(box){ box.focus(); } });
        const cancelBtn=document.createElement('button'); cancelBtn.type='button'; cancelBtn.className='secondary'; cancelBtn.textContent='Cancel';
        // The label alone never said what it discards; the handler settles the
        // interaction as cancelled, so the action that asked does not proceed.
        cancelBtn.title='Dismisses this question without answering. The action that asked it will not continue.';
        cancelBtn.addEventListener('click',()=>{ v.postMessage({type:'cancelInteraction',operationId:interaction.operationId,interactionId:interaction.interactionId}); });
        actions.appendChild(confirmBtn); actions.appendChild(chatBtn); actions.appendChild(cancelBtn);
        ic.appendChild(actions);
      }
      // Renders every pending WorkflowDecisionV1 for this task/stage as an
      // explained choice: what happened, why the user is needed, evidence
      // (case-4 decisions), enumerated options each with its own consequence
      // text and a destructive flag, a recommendation (or explicit "no
      // basis"), and ONE Confirm button per card — the same single-commit-
      // path and acknowledge-on-press rules renderInteraction above applies
      // to structured questions, so the two decision surfaces do not diverge.
      function renderDecisions(decisions){
        dc.replaceChildren();
        if(!decisions || !decisions.length){ dc.style.display='none'; return; }
        dc.style.display='block';
        for(const dcs of decisions){
          const card=document.createElement('div'); card.className='decision-card'+(dcs.isGating?' decision-card-gating':'');
          const err=document.createElement('div'); err.className='interaction-error';
          card.appendChild(err);
          const title=document.createElement('div'); title.className='interaction-title';
          title.textContent=(dcs.isBlockingDecision!==false)?'Decision needed':'Optional';
          card.appendChild(title);
          const what=document.createElement('div'); what.className='interaction-prompt';
          what.textContent=dcs.whatHappened;
          card.appendChild(what);
          const why=document.createElement('div'); why.className='decision-why';
          why.textContent=dcs.whyUserNeeded;
          card.appendChild(why);
          if(dcs.evidence && dcs.evidence.length){
            const evWrap=document.createElement('div'); evWrap.className='decision-evidence';
            const evTitle=document.createElement('div'); evTitle.className='decision-evidence-title'; evTitle.textContent='Evidence';
            evWrap.appendChild(evTitle);
            for(const ev of dcs.evidence){
              const line=document.createElement('div'); line.textContent=ev.label+': '+ev.detail;
              evWrap.appendChild(line);
            }
            card.appendChild(evWrap);
          }
          const groupName='decision-'+dcs.decisionId;
          const radios=[];
          for(const opt of dcs.options){
            const optWrap=document.createElement('label'); optWrap.className='decision-option';
            const radio=document.createElement('input'); radio.type='radio'; radio.name=groupName; radio.value=opt.optionId;
            radios.push(radio);
            optWrap.appendChild(radio);
            const isRecommended=dcs.recommendation.kind==='option' && dcs.recommendation.optionId===opt.optionId;
            const labelText=document.createElement('span');
            labelText.textContent=' '+opt.label+(isRecommended?' (Recommended)':'');
            if(opt.destructive){ labelText.appendChild(document.createTextNode(' ')); const warn=document.createElement('span'); warn.className='decision-option-destructive'; warn.textContent='⚠ irreversible'; labelText.appendChild(warn); }
            optWrap.appendChild(labelText);
            const consequence=document.createElement('div'); consequence.className='decision-option-consequence';
            consequence.textContent=opt.consequence;
            optWrap.appendChild(consequence);
            card.appendChild(optWrap);
          }
          const rec=document.createElement('div'); rec.className='decision-recommendation';
          if(dcs.recommendation.kind==='option'){
            const recOpt=dcs.options.find(o=>o.optionId===dcs.recommendation.optionId);
            rec.textContent='Recommendation: '+(recOpt?recOpt.label:dcs.recommendation.optionId)+' — '+dcs.recommendation.reasoning;
          } else {
            rec.textContent='No recommendation: '+dcs.recommendation.reasoning;
          }
          card.appendChild(rec);
          // Whether resolving this decision actually unblocks the task —
          // pre-rendered host-side (chatView.ts) via the shared hand-off
          // contract, including its "not recorded" fallback for records
          // that predate this metadata.
          const gating=document.createElement('div'); gating.className='decision-gating'+(dcs.isGating?' decision-gating-active':'');
          gating.textContent=dcs.gatingLine;
          card.appendChild(gating);
          // Paused-answer sequencing (task PART 5, verified against
          // workflowDecisionStoreV1.ts's resolve(): it never reads task-pause
          // state, so a decision is always retained and its effect always
          // dispatched immediately, whether the task is paused or active).
          // Stated at the point of asking, for every decision, rather than
          // left for the user to discover after answering. Worded to avoid
          // two overclaims a reviewer caught in an earlier draft: (1) the
          // dispatched command can still refuse on its own terms — recording
          // your choice is not a promise the action succeeds — and (2)
          // recording an answer does not itself resume a paused task unless
          // the option's own effect does so, which is what the "Unblocks"
          // line right above already states per-decision.
          const pausedNote=document.createElement('div'); pausedNote.className='decision-paused-note';
          pausedNote.textContent='Your choice is recorded immediately, whether the task is paused or active. The action it runs can still refuse on its own terms, and recording your choice does not by itself resume the task — see "Unblocks" above.';
          card.appendChild(pausedNote);
          const actions=document.createElement('div'); actions.className='interaction-actions';
          const confirmBtn=document.createElement('button'); confirmBtn.type='button'; confirmBtn.textContent='Confirm';
          confirmBtn.addEventListener('click',()=>{
            const checked=radios.find(r=>r.checked);
            if(!checked){ err.textContent='Please choose an option.'; err.style.display='block'; return; }
            err.style.display='none';
            // Acknowledge the press immediately and make a second one
            // impossible — the same rule PART 0 established for structured
            // questions, for the same reason: silence after a click is what
            // caused a double press before.
            confirmBtn.disabled=true; confirmBtn.textContent='Confirmed';
            for(const r of radios){ r.disabled=true; }
            v.postMessage({type:'resolveWorkflowDecision',decisionId:dcs.decisionId,optionId:checked.value});
          });
          actions.appendChild(confirmBtn);
          card.appendChild(actions);
          dc.appendChild(card);
        }
      }
      window.addEventListener('message', event=>{
        const s=event.data;if(s.type!=='state')return;
        const nextKey=targetKey(s.target);
        const switchedChat=nextKey!==currentKey;
        const stick=!switchedChat&&isNearBottom();
        c.textContent=s.label??'No chat available yet.';
        sp.textContent=s.schedulingPostureLine??'';sp.classList.toggle('visible',!!s.schedulingPostureLine);
        m.replaceChildren(...s.entries.map(x=>{
          const row=document.createElement('div');row.className='msg-row';
          const meta=document.createElement('div');meta.className='msg-meta';
          const time=document.createElement('span');time.className='msg-time';time.textContent=x.atLabel??'';time.title=x.atTitle??'';
          const copyBtn=document.createElement('button');copyBtn.type='button';copyBtn.className='msg-copy';copyBtn.title='Copy message';copyBtn.setAttribute('aria-label','Copy message');copyBtn.textContent='⧉';
          let copyTimer;
          copyBtn.addEventListener('click',()=>{
            navigator.clipboard.writeText(x.text);
            // Re-clicking restarts the ~1 s "copied" confirmation instead of
            // letting a stale timer revert the fresh checkmark early.
            if(copyTimer!==undefined)clearTimeout(copyTimer);
            copyBtn.textContent='✓';copyBtn.setAttribute('aria-label','Copied');copyBtn.title='Copied';
            copyTimer=setTimeout(()=>{copyTimer=undefined;copyBtn.textContent='⧉';copyBtn.setAttribute('aria-label','Copy message');copyBtn.title='Copy message';},1000);
          });
          meta.appendChild(copyBtn);meta.appendChild(time);
          const d=document.createElement('p');d.className=x.role==='user'?'msg-user':'msg-agent';d.textContent='['+x.role+(x.awaitingAnswer?' — awaiting your answer':'')+'] '+x.text;
          row.appendChild(d);row.appendChild(meta);
          return row;
        }));
        renderInteraction(s.interaction);
        renderDecisions(s.decisions);
        en.textContent=s.emptyNotice??'';en.style.display=s.emptyNotice?'block':'none';
        e.textContent=s.errorMessage??'';e.style.display=s.errorMessage?'block':'none';
        if(s.busy){bs.style.display='inline-block';bt.textContent=s.busyDetail?('Waiting for the AI… ('+s.busyDetail+')'):'Waiting for the AI… — no status is available until this finishes';b.style.display='block';b.title='';}
        else if(s.waitingForUser){
          bs.style.display='none';bt.textContent='Waiting for your answer';b.style.display='block';
          b.title=s.waitingForUserSource==='liveOperation'?'A running operation is paused waiting on your input.':'';
        }
        else{b.style.display='none';b.title='';}
        currentKey=nextKey;
        requestAnimationFrame(()=>{
          if(stick){window.scrollTo(0,document.documentElement.scrollHeight);}
          else if(switchedChat&&Object.prototype.hasOwnProperty.call(scrollPositions,nextKey)){window.scrollTo(0,scrollPositions[nextKey]);}
          else if(switchedChat){window.scrollTo(0,document.documentElement.scrollHeight);}
        });
      });
      f.addEventListener('submit',e=>{e.preventDefault();v.postMessage({type:'send',text:i.value});i.value='';});
      i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey){e.preventDefault();f.requestSubmit();}else if(e.key==='Escape'){i.blur();}});
      v.postMessage({type:'ready'});</script>
    </body></html>`;
  }
}
