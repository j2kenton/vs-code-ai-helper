import * as vscode from "vscode";
import * as crypto from "crypto";
import { TaskStage } from "../types/taskProgress";

export interface ChatMessage {
  role: "user" | "assistant" | "question";
  text: string;
  stage: TaskStage;
  at: string;
  /** A question remains pending until the user sends a follow-up message. */
  pending?: boolean;
}

interface ChatTarget {
  canonicalId: string;
  taskFolderPath: string;
  stage: TaskStage;
}

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

/** A workspace-scoped, persistent conversation surface for the active task. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "vs-code-ai-helper.chatView";
  private view?: vscode.WebviewView;
  private target?: ChatTarget;
  /** Serialize updates so rapid user/agent messages cannot lose one another. */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isSendMessage(message) || !this.target) return;
      const target = this.target;
      const text = message.text.trim();
      if (!text) return;
      await this.append("user", text, target.stage, target.canonicalId);
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

  async ask(question: StageChatQuestion): Promise<void> {
    await this.open(question);
    await this.append("question", question.question, question.stage, question.canonicalId, true);
  }

  async append(
    role: ChatMessage["role"],
    text: string,
    stage: TaskStage,
    canonicalId = this.target?.canonicalId,
    pending = false
  ): Promise<void> {
    if (!canonicalId) return;
    const key = this.keyFor(canonicalId);
    this.writes = this.writes.then(async () => {
      const entries = this.entriesFor(key);
      entries.push({ role, text, stage, at: new Date().toISOString(), pending });
      await this.state.update(key, entries.slice(-200));
    });
    await this.writes;
    await this.render();
  }

  /** Recent conversation is supplied to the runner so a response can safely
   * answer an AI's earlier clarification question rather than becoming an
   * unrelated one-shot prompt. */
  transcript(canonicalId: string): ChatMessage[] {
    return this.entriesFor(this.keyFor(canonicalId));
  }

  private keyFor(canonicalId: string): string {
    // Canonical IDs are workspace-local, but encoding keeps a Memento key
    // safe even for legacy IDs containing punctuation.
    return `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
  }

  private entriesFor(key: string): ChatMessage[] {
    const value = this.state.get<ChatMessage[]>(key, []);
    return Array.isArray(value) ? value.slice(-200) : [];
  }

  private async render(): Promise<void> {
    const entries = this.target ? this.entriesFor(this.keyFor(this.target.canonicalId)) : [];
    await this.view?.webview.postMessage({ type: "state", target: this.target, entries });
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body>
      <div id="context">Select an active task to start a stage conversation.</div><div id="messages"></div>
      <form id="form"><textarea id="message" rows="3" placeholder="Ask the current stage AI…"></textarea><button>Send</button></form>
      <script nonce="${nonce}">const v=acquireVsCodeApi(), c=document.getElementById('context'), m=document.getElementById('messages');
      window.addEventListener('message', e=>{const s=e.data;if(s.type!=='state')return;c.textContent=s.target?'Chatting with '+s.target.stage.replaceAll('-',' ')+' AI':'Select an active task to start a stage conversation.';m.replaceChildren(...s.entries.map(x=>{const d=document.createElement('p');d.textContent='['+x.role+(x.pending?' — awaiting your answer':'')+'] '+x.text;return d;}));});
      document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();const input=document.getElementById('message');v.postMessage({type:'send',text:input.value});input.value='';});</script>
    </body></html>`;
  }
}
