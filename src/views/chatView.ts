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
  CHAT_HISTORY_FILENAME,
  ChatDocumentInteractionV1,
  ChatHistoryRecoveryErrorV1,
  ChatMessage,
  loadTranscriptWithMigration,
  readChatDocumentIdentityV1,
  readChatInteractions,
  recordChatInteractionAnswers,
  resetChatHistoryV1,
  settleChatInteraction,
  writeChatHistory,
} from "../utils/chatHistoryStore";
import { stripAttributionHeaders } from "../utils/fileUtils";
import { formatTimestampForDisplay } from "../utils/timeFormat";
import {
  decodeStructuredAnswersArrayV1,
  DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../types/structuredQuestionV1";

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
  type: "submitInteractionAnswers" | "cancelInteraction" | "resumeInteraction";
  operationId: string;
  interactionId: string;
  /** Present only for "submitInteractionAnswers". */
  answers?: unknown;
}

function isInteractionActionMessage(value: unknown): value is InteractionActionMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "submitInteractionAnswers" || v.type === "cancelInteraction" || v.type === "resumeInteraction") &&
    typeof v.operationId === "string" &&
    v.operationId.length > 0 &&
    typeof v.interactionId === "string" &&
    v.interactionId.length > 0
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
  /** Set only once wired from extension.ts (see ChatInteractionServicesV1's doc comment). */
  private interactionServices?: ChatInteractionServicesV1;

  constructor(private readonly state: vscode.Memento) {
    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose. Only re-render when there is a
    // target to render — operations on other tasks must not rebuild this view.
    this.operationsSub = taskOperations.onDidChange(() => {
      if (!this.target || !this.view) return;
      void this.render().catch(() => undefined);
    });
  }

  dispose(): void {
    this.operationsSub.dispose();
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
      if (isInteractionActionMessage(message)) {
        const clientRef: ChatInteractionClientRefV1 = {
          operationId: message.operationId,
          interactionId: message.interactionId,
        };
        if (message.type === "submitInteractionAnswers") {
          await this.submitInteractionAnswers(clientRef, message.answers);
        } else if (message.type === "cancelInteraction") {
          await this.cancelInteraction(clientRef);
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
   */
  private async submitInteractionAnswers(clientRef: ChatInteractionClientRefV1, rawAnswers: unknown): Promise<void> {
    if (!this.target) return;
    const identity = this.target;
    const decoded = decodeStructuredAnswersArrayV1(rawAnswers);
    if (!decoded.ok) {
      NotificationRouter.showWarning(`Could not submit your answers: ${decoded.reason}`);
      return;
    }
    await this.runQueued(identity.taskFolderPath, () =>
      this.doSubmitInteractionAnswers(identity, clientRef, decoded.answers)
    );
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  private async doSubmitInteractionAnswers(
    identity: ChatIdentity,
    clientRef: ChatInteractionClientRefV1,
    answers: readonly StructuredAnswerV1[]
  ): Promise<void> {
    if (this.interactionServices) {
      const ref = await this.resolveInteractionRef(identity, clientRef);
      if (!ref) {
        NotificationRouter.showWarning("Could not submit answers: no matching question exists in this task's chat.");
        return;
      }
      let result: ChatInteractionServiceResultV1;
      try {
        result = await this.interactionServices.submitAnswers(
          ref,
          answers,
          crypto.randomBytes(16).toString("hex")
        );
      } catch (error) {
        NotificationRouter.showWarning(
          `Could not submit answers. (${error instanceof Error ? error.message : String(error)})`
        );
        return;
      }
      if (!result.ok) {
        NotificationRouter.showWarning(`Could not submit answers: ${result.reason}`);
        return;
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
    }
  }

  /** Cancel the current target's unresolved interaction (plan §6.1's Cancel control). Never invokes a provider. */
  private async cancelInteraction(clientRef: ChatInteractionClientRefV1): Promise<void> {
    if (!this.target) return;
    const identity = this.target;
    await this.runQueued(identity.taskFolderPath, async () => {
      try {
        if (this.interactionServices) {
          const ref = await this.resolveInteractionRef(identity, clientRef);
          if (!ref) {
            NotificationRouter.showWarning("Could not cancel: no matching question exists in this task's chat.");
            return;
          }
          const result = await this.interactionServices.cancel(ref);
          if (!result.ok) {
            NotificationRouter.showWarning(`Could not cancel: ${result.reason}`);
            return;
          }
        }
        await settleChatInteraction(
          identity.taskFolderPath,
          identity.canonicalId,
          clientRef.interactionId,
          "cancelled"
        );
      } catch (error) {
        NotificationRouter.showWarning(
          `Could not cancel this question. (${error instanceof Error ? error.message : String(error)})`
        );
      }
    });
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  /**
   * Resume the current target's unresolved interaction (plan §6.1's Resume
   * control). Requires the production action coordinator; until it is wired
   * (see ChatInteractionServicesV1's doc comment) this surfaces a clear
   * "not available yet" message rather than silently doing nothing.
   */
  private async resumeInteraction(clientRef: ChatInteractionClientRefV1): Promise<void> {
    if (!this.target) return;
    if (!this.interactionServices?.resume) {
      NotificationRouter.showWarning(
        "Resume isn't available yet for this question — the action that asked it hasn't been migrated to the new Resume flow."
      );
      return;
    }
    const identity = this.target;
    const services = this.interactionServices;
    const resume = (r: ChatInteractionRefV1, id: string): Promise<ChatInteractionResumeResultV1> =>
      services.resume!(r, id);
    await this.runQueued(identity.taskFolderPath, async () => {
      try {
        const ref = await this.resolveInteractionRef(identity, clientRef);
        if (!ref) {
          NotificationRouter.showWarning("Could not resume: no matching question exists in this task's chat.");
          return;
        }
        const result = await resume(ref, crypto.randomBytes(16).toString("hex"));
        if (!result.ok) {
          NotificationRouter.showWarning(`Could not resume: ${result.reason}`);
          return;
        }
        await settleChatInteraction(
          identity.taskFolderPath,
          identity.canonicalId,
          clientRef.interactionId,
          result.settlement
        );
      } catch (error) {
        NotificationRouter.showWarning(
          `Could not resume this question. (${error instanceof Error ? error.message : String(error)})`
        );
      }
    });
    if (sameIdentity(this.target, identity)) {
      await this.render();
    }
  }

  private async persistAppend(identity: ChatIdentity, message: ChatMessage): Promise<void> {
    try {
      const current = await loadTranscriptWithMigration(identity.taskFolderPath, identity.canonicalId, this.state);
      await writeChatHistory(identity.taskFolderPath, [...current, message], identity.canonicalId);
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
    // Distinguish genuinely-running work from an operation that is merely
    // parked waiting on the user's answer (round-limit pause, a pending
    // question, etc.) — the latter must never show the busy spinner, which
    // reads as "the computer is working, leave it alone" and is exactly
    // backwards when it's actually this chat that's waiting on the user.
    const targetOps = target ? taskOperations.getTaskOperations(target.canonicalId) : [];
    // A trailing pending question (no reply after it yet) is the one case
    // that genuinely needs the user's attention rather than just being more
    // conversation — computed here (ahead of busy/waitingForUser) so it can
    // win over an operation that is still technically running: a question
    // posted mid-operation means the operation is now blocked on the user,
    // not "busy", no matter what targetOps still reports.
    const lastEntry = entries[entries.length - 1];
    const hasPendingQuestion = lastEntry?.role === "question" && lastEntry.pending;
    const waitingForUser =
      interaction !== undefined || hasPendingQuestion || targetOps.some((op) => op.waitingForUser);
    const busy = !waitingForUser && targetOps.some((op) => !op.waitingForUser);
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
    const displayEntries = entries.map((entry) => {
      const date = new Date(entry.at);
      return {
        ...entry,
        text: stripAttributionHeaders(entry.text),
        atLabel: formatTimestampForDisplay(date),
        atTitle: date.toLocaleString(),
      };
    });
    // A small badge on the view itself draws the eye even when this panel is
    // present but not the currently focused element, mirroring how other
    // views badge unread/actionable counts.
    if (this.view) {
      this.view.badge = hasPendingQuestion || interaction !== undefined
        ? { value: 1, tooltip: "Waiting for your answer" }
        : undefined;
    }
    await this.view?.webview.postMessage({
      type: "state",
      target: this.target,
      label,
      entries: displayEntries,
      interaction,
      busy,
      waitingForUser,
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
      </style>
      </head><body>
      <div id="context" role="status">Loading chat…</div><div id="messages" role="log" aria-live="polite" aria-label="Conversation"></div>
      <div id="interaction" role="form" aria-label="Question from the AI"></div>
      <div id="empty-notice" role="status"></div>
      <div id="error" role="alert"></div>
      <div id="busy-indicator" role="status" aria-live="polite"><span id="busy-spinner" class="spinner"></span><span id="busy-text">Waiting for the AI…</span></div>
      <form id="form"><textarea id="message" rows="3" aria-label="Message the AI" placeholder="Message the AI… (Enter to send, Shift+Enter for a new line)"></textarea><button type="submit" title="Send message (Enter)">Send</button></form>
      <script nonce="${nonce}">const v=acquireVsCodeApi(), c=document.getElementById('context'), m=document.getElementById('messages'), ic=document.getElementById('interaction'), en=document.getElementById('empty-notice'), e=document.getElementById('error'), b=document.getElementById('busy-indicator'), bs=document.getElementById('busy-spinner'), bt=document.getElementById('busy-text'), f=document.getElementById('form'), i=document.getElementById('message');
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
        const actions=document.createElement('div'); actions.className='interaction-actions';
        const saveBtn=document.createElement('button'); saveBtn.type='button'; saveBtn.textContent='Save Answers';
        saveBtn.addEventListener('click',()=>{ const answers=collect(); if(answers) v.postMessage({type:'submitInteractionAnswers',operationId:interaction.operationId,interactionId:interaction.interactionId,answers}); });
        const resumeBtn=document.createElement('button'); resumeBtn.type='button'; resumeBtn.textContent='Resume';
        resumeBtn.addEventListener('click',()=>{ const answers=collect(); if(answers){ v.postMessage({type:'submitInteractionAnswers',operationId:interaction.operationId,interactionId:interaction.interactionId,answers}); v.postMessage({type:'resumeInteraction',operationId:interaction.operationId,interactionId:interaction.interactionId}); } });
        const cancelBtn=document.createElement('button'); cancelBtn.type='button'; cancelBtn.className='secondary'; cancelBtn.textContent='Cancel';
        cancelBtn.addEventListener('click',()=>{ v.postMessage({type:'cancelInteraction',operationId:interaction.operationId,interactionId:interaction.interactionId}); });
        actions.appendChild(saveBtn); actions.appendChild(resumeBtn); actions.appendChild(cancelBtn);
        ic.appendChild(actions);
      }
      window.addEventListener('message', event=>{
        const s=event.data;if(s.type!=='state')return;
        const nextKey=targetKey(s.target);
        const switchedChat=nextKey!==currentKey;
        const stick=!switchedChat&&isNearBottom();
        c.textContent=s.label??'No chat available yet.';
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
          const d=document.createElement('p');d.className=x.role==='user'?'msg-user':'msg-agent';d.textContent='['+x.role+(x.pending?' — awaiting your answer':'')+'] '+x.text;
          row.appendChild(d);row.appendChild(meta);
          return row;
        }));
        renderInteraction(s.interaction);
        en.textContent=s.emptyNotice??'';en.style.display=s.emptyNotice?'block':'none';
        e.textContent=s.errorMessage??'';e.style.display=s.errorMessage?'block':'none';
        if(s.busy){bs.style.display='inline-block';bt.textContent='Waiting for the AI…';b.style.display='block';}
        else if(s.waitingForUser){bs.style.display='none';bt.textContent='Waiting for your answer';b.style.display='block';}
        else{b.style.display='none';}
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
