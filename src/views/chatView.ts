import * as vscode from "vscode";
import * as crypto from "crypto";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { notifyDesktop } from "../utils/desktopNotifier";
import { taskOperations } from "../utils/taskOperations";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  ChatMessage,
  loadTranscriptWithMigration,
  writeChatHistory,
} from "../utils/chatHistoryStore";

export type { ChatMessage };

interface ChatTarget {
  canonicalId: string;
  taskFolderPath: string;
  stage: TaskStage;
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

export interface StageChatQuestion extends ChatTarget {
  question: string;
}

function sameIdentity(a: ChatIdentity | undefined, b: ChatIdentity | undefined): boolean {
  if (!a || !b) return a === b;
  return a.canonicalId === b.canonicalId && a.taskFolderPath === b.taskFolderPath;
}

/** A workspace-scoped, persistent conversation surface for the active task.
 * Transcripts are persisted to `chat-v1.json` inside each task folder (see
 * chatHistoryStore.ts) so they travel with the task, with a lazy one-time
 * migration from the legacy per-workspace Memento transcript. */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "vs-code-ai-helper.chatView";
  private view?: vscode.WebviewView;
  private target?: ChatTarget;
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSendMessage(message) || !this.target) return;
      // Captured before any await, so a target switch mid-send still writes
      // to (and, if still current, renders) the task the message was sent to.
      const target = this.target;
      const text = message.text.trim();
      if (!text) return;
      await this.append("user", text, target.stage, target);
      await vscode.commands.executeCommand("vs-code-ai-helper.chatWithStage", {
        ...target,
        message: text,
      });
    });
    void this.render();
  }

  async open(target: ChatTarget): Promise<void> {
    this.target = target;
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    void this.render();
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
   */
  async ask(question: StageChatQuestion): Promise<void> {
    if (!this.target || sameIdentity(this.target, question)) {
      await this.open(question);
    }
    await this.append("question", question.question, question.stage, question, true);
    notifyDesktop("Ensemble — question", question.question);
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
   * unrelated one-shot prompt. */
  async transcript(taskFolderPath: string, canonicalId: string): Promise<ChatMessage[]> {
    return this.runQueued(taskFolderPath, () =>
      loadTranscriptWithMigration(taskFolderPath, canonicalId, this.state)
    );
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
    // Captured before the (now async, file-backed) transcript read so a
    // target switch mid-read can be detected and the stale render dropped
    // instead of painting one task's history into another's view.
    const target = this.target;
    let entries: ChatMessage[] = [];
    if (target) {
      try {
        entries = await this.transcript(target.taskFolderPath, target.canonicalId);
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
      }
    }
    if (!sameIdentity(target, this.target)) return;
    const busy = target ? taskOperations.getTaskOperations(target.canonicalId).some(op => !op.exclusive) : false;
    // Full, user-facing stage name rather than the raw stage id (e.g. "impl-high-review")
    // so the chat header reads as prose instead of an abbreviated identifier.
    const label = target
      ? `Chatting with the AI in charge of the ${STAGE_DISPLAY_NAMES[target.stage]} stage (${target.stage})`
      : undefined;
    await this.view?.webview.postMessage({ type: "state", target: this.target, label, entries, busy });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <style>
        .spinner {
          display: inline-block;
          width: 1em;
          height: 1em;
          border: 2px solid currentColor;
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
          margin: 10px;
          font-style: italic;
          opacity: 0.8;
        }
        #form {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        #form textarea {
          resize: vertical;
        }
        #form button {
          align-self: flex-end;
        }
      </style>
      </head><body>
      <div id="context">Select an active task to start a stage conversation.</div><div id="messages"></div>
      <div id="busy-indicator" style="display:none"><span class="spinner"></span>Waiting for the stage AI…</div>
      <form id="form"><textarea id="message" rows="3" placeholder="Ask the current stage AI… (Ctrl+Enter to send)"></textarea><button>Send</button></form>
      <script nonce="${nonce}">const v=acquireVsCodeApi(), c=document.getElementById('context'), m=document.getElementById('messages'), b=document.getElementById('busy-indicator'), f=document.getElementById('form'), i=document.getElementById('message');
      window.addEventListener('message', e=>{const s=e.data;if(s.type!=='state')return;c.textContent=s.label??'Select an active task to start a stage conversation.';m.replaceChildren(...s.entries.map(x=>{const d=document.createElement('p');d.textContent='['+x.role+(x.pending?' — awaiting your answer':'')+'] '+x.text;return d;}));b.style.display=s.busy?'block':'none';});
      f.addEventListener('submit',e=>{e.preventDefault();v.postMessage({type:'send',text:i.value});i.value='';});
      i.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.ctrlKey){e.preventDefault();f.requestSubmit();}});</script>
    </body></html>`;
  }
}
