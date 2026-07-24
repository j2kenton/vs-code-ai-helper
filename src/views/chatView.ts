import * as vscode from "vscode";
import * as crypto from "crypto";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { notifyDesktop } from "../utils/desktopNotifier";
import { taskOperations } from "../utils/taskOperations";
import { NotificationRouter, getNotificationRouterStatus } from "../utils/notificationRouter";
import {
  ChatMessage,
  loadTranscriptWithMigration,
  writeChatHistory,
} from "../utils/chatHistoryStore";
import { stripAttributionHeaders } from "../utils/fileUtils";

export type { ChatMessage };

interface ChatTarget {
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

export interface StageChatQuestion extends ChatTarget {
  question: string;
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
      if (!isSendMessage(message) || !this.target) return;
      // Captured before any await, so a target switch mid-send still writes
      // to (and, if still current, renders) the task the message was sent to.
      const target = this.target;
      const text = message.text.trim();
      if (!text) return;
      await this.append("user", text, target.stage, target);
      if (target.kind === "global") {
        // The global assistant has its own send path — it is not a task or
        // stage chat, and chatWithStage cannot resolve its synthetic folder.
        await vscode.commands.executeCommand("vs-code-ai-helper.globalAssistantSend", {
          message: text,
        });
      } else {
        await vscode.commands.executeCommand("vs-code-ai-helper.chatWithStage", {
          ...target,
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
      this.notifyWaitingForFeedback(question, notify);
    }
  }

  private notifyWaitingForFeedback(
    question: StageChatQuestion,
    { blocking, blockedReason }: { blocking?: boolean; blockedReason?: string }
  ): void {
    // Guarded rather than assumed-initialized: production always has
    // NotificationRouter up by the time a chat question can be raised, but
    // this keeps ask() safe to call from any context (e.g. tests) that
    // hasn't wired one up.
    if (!getNotificationRouterStatus()) return;
    const label = question.taskName ?? question.taskFolderPath;
    const stageName = STAGE_DISPLAY_NAMES[question.stage];
    const actionCommand = {
      command: "vs-code-ai-helper.postStageQuestion",
      title: "Open Chat",
      args: [question],
    };
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

  private async persistAppend(identity: ChatIdentity, message: ChatMessage): Promise<void> {
    try {
      const current = await loadTranscriptWithMigration(identity.taskFolderPath, identity.canonicalId, this.state);
      await writeChatHistory(identity.taskFolderPath, [...current, message]);
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
    let errorMessage: string | undefined;
    if (target) {
      try {
        // Stage chats are fully isolated: a stage's view never shows another
        // stage's conversation. The global assistant's history lives in its
        // own dedicated folder, so it is separate by construction.
        entries = await this.transcript(
          target.taskFolderPath,
          target.canonicalId,
          target.kind === "global" ? undefined : target.stage
        );
      } catch (error) {
        // A transcript that fails to read (e.g. corrupt and unquarantinable —
        // see chatHistoryStore's readChatHistory) must not crash render(), or
        // by extension append()/ask() callers that await it. Show it as
        // empty and warn once, mirroring persistAppend's own containment.
        if (!this.warnedTasks.has(target.taskFolderPath)) {
          this.warnedTasks.add(target.taskFolderPath);
          NotificationRouter.showWarning(
            `Could not load chat history for this task. (${error instanceof Error ? error.message : String(error)})`
          );
        }
        errorMessage = "Chat history could not be loaded. Check the Notifications view for details.";
      }
    }
    if (!sameIdentity(target, this.target)) return;
    // Distinguish genuinely-running work from an operation that is merely
    // parked waiting on the user's answer (round-limit pause, a pending
    // question, etc.) — the latter must never show the busy spinner, which
    // reads as "the computer is working, leave it alone" and is exactly
    // backwards when it's actually this chat that's waiting on the user.
    const targetOps = target ? taskOperations.getTaskOperations(target.canonicalId) : [];
    const busy = targetOps.some((op) => !op.waitingForUser);
    const waitingForUser = !busy && targetOps.some((op) => op.waitingForUser);
    // Always show the associated task: the task name when available,
    // otherwise the folder's date/task-ID code — with no bracketed raw
    // stage id. The global assistant is labeled as a global assistant.
    let label: string | undefined;
    if (target?.kind === "global") {
      label = "Global Assistant — cross-task actions (Uses the model currently set for Task Description)";
    } else if (target) {
      const taskLabel = target.taskName ?? target.taskFolderPath.replace(/\\/g, "/").split("/").pop() ?? "task";
      label = `${taskLabel} — ${STAGE_DISPLAY_NAMES[target.stage]} stage chat`;
    }
    // Attribution comments belong in generated artifact files, not in a
    // conversation — strip them from every displayed message (including
    // messages persisted before this stripping existed).
    const displayEntries = entries.map((entry) => ({
      ...entry,
      text: stripAttributionHeaders(entry.text),
    }));
    // A trailing pending question (no reply after it yet) is the one case
    // that genuinely needs the user's attention rather than just being more
    // conversation — a small badge on the view itself draws the eye even
    // when this panel is present but not the currently focused element,
    // mirroring how other views badge unread/actionable counts.
    const lastEntry = entries[entries.length - 1];
    if (this.view) {
      this.view.badge = lastEntry?.role === "question" && lastEntry.pending
        ? { value: 1, tooltip: "Waiting for your answer" }
        : undefined;
    }
    await this.view?.webview.postMessage({
      type: "state",
      target: this.target,
      label,
      entries: displayEntries,
      busy,
      waitingForUser,
      errorMessage,
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
        #messages p {
          margin: 0 0 var(--ensemble-space-2);
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
      </style>
      </head><body>
      <div id="context" role="status">Loading chat…</div><div id="messages" role="log" aria-live="polite" aria-label="Conversation"></div>
      <div id="error" role="alert"></div>
      <div id="busy-indicator" role="status" aria-live="polite"><span id="busy-spinner" class="spinner"></span><span id="busy-text">Waiting for the AI…</span></div>
      <form id="form"><textarea id="message" rows="3" aria-label="Message the AI" placeholder="Message the AI… (Enter to send, Shift+Enter for a new line)"></textarea><button type="submit" title="Send message (Enter)">Send</button></form>
      <script nonce="${nonce}">const v=acquireVsCodeApi(), c=document.getElementById('context'), m=document.getElementById('messages'), e=document.getElementById('error'), b=document.getElementById('busy-indicator'), bs=document.getElementById('busy-spinner'), bt=document.getElementById('busy-text'), f=document.getElementById('form'), i=document.getElementById('message');
      const savedState = v.getState() || {};
      const scrollPositions = savedState.scrollPositions || {};
      let currentKey;
      function targetKey(t){ if(!t) return ''; return t.kind==='global' ? 'global' : (t.canonicalId+':'+t.stage); }
      function isNearBottom(){ return (document.documentElement.scrollHeight-window.scrollY-window.innerHeight)<60; }
      function persistScroll(){ if(currentKey===undefined) return; scrollPositions[currentKey]=window.scrollY; v.setState({scrollPositions:scrollPositions}); }
      window.addEventListener('scroll', persistScroll);
      window.addEventListener('message', event=>{
        const s=event.data;if(s.type!=='state')return;
        const nextKey=targetKey(s.target);
        const switchedChat=nextKey!==currentKey;
        const stick=!switchedChat&&isNearBottom();
        c.textContent=s.label??'No chat available yet.';
        m.replaceChildren(...s.entries.map(x=>{const d=document.createElement('p');d.className=x.role==='user'?'msg-user':'msg-agent';d.textContent='['+x.role+(x.pending?' — awaiting your answer':'')+'] '+x.text;return d;}));
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
