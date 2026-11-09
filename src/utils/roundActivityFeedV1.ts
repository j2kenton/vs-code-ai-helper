/**
 * run1 Step 11: the one activity feed a round has, owned by the runner. It counts only what the
 * round PROVABLY did.
 *
 * Three kinds of entry:
 *  - `contact`: new stdout or stderr bytes from the round's process. The process is alive and
 *    talking; that is not progress.
 *  - `progress`: a new tool or command event in the round's own stream (counted once, when the event
 *    arrives); a workspace file change the round's own stream names (see `recordFileChanges`); a
 *    change to this round's own `round-progress.md` not saved from an editor on this host.
 *  - `observed`: any other workspace file change while the round ran. An uncertain observation:
 *    another window, another task or a formatter may have written it. It never refreshes the round's
 *    contact or progress times, never holds off the idle stop or the no-activity warning, never counts
 *    as progress in recovery advice and never joins the round's attributed changed files.
 *
 * A file change is the round's only with affirmative evidence naming that file: an edit or write
 * event in the round's stream whose arguments name it, found in the FIRST scan after that event. One
 * event attributes that file once. Timing alone never attributes a change, so a command that is
 * running, stuck or has just ended never makes a file change the round's.
 *
 * Never recorded at all: everything under `.ensemble/` except this round's `round-progress.md`,
 * `.git/`, and the build outputs `dist/` and `out/`.
 *
 * The idle stop, the repeat stop, the no-activity warning, the Notifications row and the progress
 * watch all read this feed; nothing reads raw file events on its own.
 */
import * as path from "node:path";

export type RoundActivityKindV1 = "contact" | "progress" | "observed";

export interface RoundActivityEntryV1 {
  readonly at: number;
  readonly kind: RoundActivityKindV1;
  /** A short description: "ran `pnpm run lint`", "edited `reviewActions.ts`". */
  readonly what: string;
}

export interface RoundActivityFeedOptionsV1 {
  /** Absolute workspace root the round runs in; changed paths are judged relative to it. */
  readonly workspaceRoot?: string;
  /** Absolute path of this round's own `round-progress.md`. */
  readonly roundProgressPath?: string;
  /** True when the provider streams events, so stream lines can name what the round did. */
  readonly streaming: boolean;
  /** Which provider's event vocabulary the stream lines use. Defaults to Claude Code's. */
  readonly provider?: RoundStreamProviderV1;
  /**
   * When the owner last saved this file from an editor on THIS host (epoch ms), if ever. A change to
   * the round's `round-progress.md` that follows such a save is the owner's, not the round's.
   */
  readonly localEditorSaveAt?: (absolutePath: string) => number | undefined;
  readonly now?: () => number;
}

/** The providers whose stdout is a JSON-lines event stream (`structuredEventStream` tags). */
export type RoundStreamProviderV1 = "claude" | "codex" | "opencode" | "cline" | "kimi";

/**
 * Stream tools whose arguments name the file they write, lower-cased: Claude Code's Edit, Write,
 * MultiEdit and NotebookEdit; OpenCode's edit, write, patch and multiedit; Kimi's file tools.
 */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "patch",
  "writefile",
  "write_file",
  "strreplacefile",
  "str_replace_file",
  "str_replace",
]);
/** Stream tools that run a command (lower-cased). */
const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "command_execution",
  "run_command",
  "run_commands",
  "execute_command",
]);
/** The argument keys that name a file. */
const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path"] as const;

/** The same assistant message this many times, with no attributed file change between, is a repeat. */
export const REPEAT_SAME_MESSAGE_LIMIT_V1 = 3;
/** The same tool call with the same input this many times in a row is a repeat. */
export const REPEAT_SAME_TOOL_CALL_LIMIT_V1 = 5;

/** Keep the feed bounded on a round that runs for hours. */
const MAX_ENTRIES = 500;

/** One tool or command event, whichever provider's vocabulary it arrived in. */
interface StreamToolV1 {
  readonly id?: string;
  readonly name: string;
  /**
   * The call's arguments. Absent when the event did not carry any: unknown arguments are never equal
   * to each other, so they cannot make two different calls look like a repeat.
   */
  readonly input?: Record<string, unknown>;
  /** Files the event's arguments name as written (empty for a read or a command). */
  readonly files: readonly string[];
}

interface StreamEventsV1 {
  readonly messages: readonly string[];
  readonly tools: readonly StreamToolV1[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function filesNamedBy(input: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      files.push(value);
    }
  }
  return files;
}

function toolFrom(id: unknown, name: string, input: Record<string, unknown> | undefined): StreamToolV1 {
  const files = input !== undefined && EDIT_TOOLS.has(name.toLowerCase()) ? filesNamedBy(input) : [];
  return { ...(typeof id === "string" ? { id } : {}), name, ...(input !== undefined ? { input } : {}), files };
}

/** Codex `item.*` events: commands, file changes (the paths are listed) and agent messages. */
function codexEvents(event: Record<string, unknown>): StreamEventsV1 | undefined {
  const type = event.type;
  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") {
    return undefined;
  }
  const item = asRecord(event.item);
  if (item === undefined || typeof item.type !== "string") {
    return undefined;
  }
  if (item.type === "agent_message") {
    return type === "item.completed" && typeof item.text === "string"
      ? { messages: [item.text], tools: [] }
      : undefined;
  }
  if (item.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "";
    return { messages: [], tools: [toolFrom(item.id, "command_execution", { command })] };
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const files = changes
      .map((change) => asRecord(change)?.path)
      .filter((file): file is string => typeof file === "string" && file.length > 0);
    const id = typeof item.id === "string" ? { id: item.id } : {};
    return { messages: [], tools: [{ ...id, name: "file_change", input: { files }, files }] };
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "mcp";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return { messages: [], tools: [toolFrom(item.id, `${server}.${tool}`, asRecord(item.arguments))] };
  }
  if (item.type === "web_search") {
    return { messages: [], tools: [toolFrom(item.id, "web_search", { query: item.query ?? "" })] };
  }
  return undefined;
}

/** OpenCode events: `text` parts and `tool_use` parts whose state carries the input. */
function opencodeEvents(event: Record<string, unknown>): StreamEventsV1 | undefined {
  const part = asRecord(event.part);
  if (part === undefined) {
    return undefined;
  }
  if (event.type === "text" && typeof part.text === "string") {
    return { messages: [part.text], tools: [] };
  }
  if (event.type === "tool_use" && typeof part.tool === "string") {
    const input = asRecord(asRecord(part.state)?.input);
    return { messages: [], tools: [toolFrom(part.callID ?? part.id, part.tool, input)] };
  }
  return undefined;
}

/** Kimi stream-json message lines: assistant `content`, and OpenAI-shaped `tool_calls`. */
function kimiEvents(event: Record<string, unknown>): StreamEventsV1 | undefined {
  if (event.role !== "assistant") {
    return undefined;
  }
  const messages = typeof event.content === "string" && event.content.trim().length > 0 ? [event.content] : [];
  const tools: StreamToolV1[] = [];
  if (Array.isArray(event.tool_calls)) {
    for (const call of event.tool_calls) {
      const record = asRecord(call);
      const fn = asRecord(record?.function);
      if (record === undefined || fn === undefined || typeof fn.name !== "string") {
        continue;
      }
      let input: Record<string, unknown> | undefined;
      if (typeof fn.arguments === "string") {
        try {
          input = asRecord(JSON.parse(fn.arguments));
        } catch {
          input = undefined;
        }
      } else {
        input = asRecord(fn.arguments);
      }
      tools.push(toolFrom(record.id, fn.name, input));
    }
  }
  return { messages, tools };
}

/** Claude Code stream-json `assistant` events: text blocks and `tool_use` blocks. */
function claudeEvents(event: Record<string, unknown>): StreamEventsV1 | undefined {
  const content = asRecord(event.message)?.content;
  if (event.type !== "assistant" || !Array.isArray(content)) {
    return undefined;
  }
  const messages: string[] = [];
  const tools: StreamToolV1[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) {
      continue;
    }
    if (record.type === "text" && typeof record.text === "string") {
      messages.push(record.text);
    } else if (record.type === "tool_use" && typeof record.name === "string") {
      tools.push(toolFrom(record.id, record.name, asRecord(record.input)));
    }
  }
  return { messages, tools };
}

/**
 * Cline `--json` `agent_event` lines (shape verified against cline 3.0.46): `content_end` with
 * `contentType: "text"` carries a complete message, and `contentType: "tool"` events carry the
 * `toolCallId` and `toolName` (the input too when the event has one). Cline's file-writing tool
 * arguments are not confirmed, so a Cline tool event is progress and repeat evidence but never names
 * a file: its file changes stay `observed`.
 */
function clineEvents(event: Record<string, unknown>): StreamEventsV1 | undefined {
  if (event.type !== "agent_event") {
    return undefined;
  }
  const inner = asRecord(event.event);
  if (inner === undefined || (inner.type !== "content_start" && inner.type !== "content_end")) {
    return undefined;
  }
  if (inner.contentType === "text") {
    return inner.type === "content_end" && typeof inner.text === "string" && inner.text.trim().length > 0
      ? { messages: [inner.text], tools: [] }
      : undefined;
  }
  if (inner.contentType === "tool" && typeof inner.toolName === "string") {
    // Cline's file-writing arguments are unconfirmed, so its tool events never name files.
    return { messages: [], tools: [{ ...toolFrom(inner.toolCallId, inner.toolName, asRecord(inner.input)), files: [] }] };
  }
  return undefined;
}

/** Normalise one stdout line of the provider's own event vocabulary. */
function normaliseStreamLine(provider: RoundStreamProviderV1, line: string): StreamEventsV1 | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  let event: Record<string, unknown> | undefined;
  try {
    event = asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
  if (event === undefined) {
    return undefined;
  }
  switch (provider) {
    case "claude":
      return claudeEvents(event);
    case "codex":
      return codexEvents(event);
    case "opencode":
      return opencodeEvents(event);
    case "kimi":
      return kimiEvents(event);
    case "cline":
      return clineEvents(event);
    default:
      return undefined;
  }
}

function basename(file: string): string {
  return path.basename(file);
}

export class RoundActivityFeedV1 {
  private readonly now: () => number;
  private readonly entriesList: RoundActivityEntryV1[] = [];
  private contactAt: number | undefined;
  private progressAt: number | undefined;
  private progressWhat: string | undefined;
  private observedAt: number | undefined;
  private observedWhat: string | undefined;
  private readonly seenToolIds = new Set<string>();
  /** Files an edit or write event named that the next scan may attribute (each used once). */
  private pendingEdits = new Set<string>();
  private readonly attributed = new Set<string>();
  private readonly observed = new Set<string>();
  private messageCounts = new Map<string, number>();
  private previousScanAt: number;
  private lastToolKey: string | undefined;
  private lastToolRun = 0;
  private repeatReason: "message" | "toolCall" | undefined;
  private repeatWhat: string | undefined;

  constructor(private readonly options: RoundActivityFeedOptionsV1) {
    this.now = options.now ?? Date.now;
    this.previousScanAt = this.now();
  }

  /** Time of the last stdout/stderr bytes. */
  get lastContactAt(): number | undefined {
    return this.contactAt;
  }

  /** Time of the last thing the round provably did. */
  get lastProgressAt(): number | undefined {
    return this.progressAt;
  }

  get lastProgressWhat(): string | undefined {
    return this.progressWhat;
  }

  get lastObservedChangeAt(): number | undefined {
    return this.observedAt;
  }

  get lastObservedChangeWhat(): string | undefined {
    return this.observedWhat;
  }

  /**
   * The latest time the round showed life it can be credited with: contact or progress. `observed`
   * entries and a still-outstanding command never move it.
   */
  lastLivenessAt(): number | undefined {
    if (this.contactAt === undefined) {
      return this.progressAt;
    }
    return this.progressAt === undefined ? this.contactAt : Math.max(this.contactAt, this.progressAt);
  }

  /** Files the round's own stream named and whose change was seen in the next scan. */
  attributedFiles(): readonly string[] {
    return [...this.attributed].sort();
  }

  /** Files that changed in the workspace while the round ran, not proven to be the round's. */
  observedFiles(): readonly string[] {
    return [...this.observed].sort();
  }

  entries(): readonly RoundActivityEntryV1[] {
    return this.entriesList;
  }

  /** Why the round is repeating itself, once it is; undefined while it is not. */
  repeatStop(): { readonly kind: "message" | "toolCall"; readonly what: string } | undefined {
    return this.repeatReason !== undefined && this.repeatWhat !== undefined
      ? { kind: this.repeatReason, what: this.repeatWhat }
      : undefined;
  }

  /** New stdout or stderr bytes arrived. Contact only: it proves the process is talking. */
  recordContact(at: number = this.now()): void {
    this.contactAt = at;
    const last = this.entriesList[this.entriesList.length - 1];
    // Chatty output is one entry a second at most, so the feed keeps its useful history.
    if (last === undefined || last.kind !== "contact" || at - last.at >= 1_000) {
      this.push({ at, kind: "contact", what: "output" });
    }
  }

  /**
   * One complete stdout line. For a streaming provider, the line is read in that provider's own event
   * vocabulary (Claude Code, Codex, OpenCode, Cline and Kimi): tool and command events are `progress` (once
   * per tool id) and edit or file-change events name the files the next scan may attribute; repeated
   * messages and tool calls are tracked for the repeat stop. Any other line is ignored here (its
   * bytes were already `contact`).
   */
  recordStreamLine(line: string, at: number = this.now()): void {
    if (!this.options.streaming) {
      return;
    }
    const events = normaliseStreamLine(this.options.provider ?? "claude", line);
    if (events === undefined) {
      return;
    }
    for (const text of events.messages) {
      this.noteMessage(text);
    }
    for (const tool of events.tools) {
      this.noteToolUse(tool, at);
    }
  }

  /**
   * The paths (absolute, or relative to the workspace root) that changed since the last scan. Each is
   * `progress` only when an edit or write event named it since the previous scan; every other change
   * is `observed`. Paths that are never recorded (see the module comment) are dropped.
   */
  recordFileChanges(changedPaths: readonly string[], at: number = this.now()): void {
    const named = this.pendingEdits;
    // An event attributes only the FIRST scan after it: whatever was not found now is spent.
    this.pendingEdits = new Set<string>();
    const previousScanAt = this.previousScanAt;
    this.previousScanAt = at;
    for (const changed of changedPaths) {
      const relative = this.relativeToRoot(changed);
      if (relative === undefined || !this.isRecordable(relative, changed)) {
        continue;
      }
      if (this.isRoundProgressFile(changed)) {
        // A save from an editor on this host since the last scan is the owner's edit, not the round's.
        if (this.savedFromLocalEditorSince(changed, previousScanAt)) {
          continue;
        }
        this.progressAt = at;
        this.progressWhat = "updated its round-progress file";
        this.push({ at, kind: "progress", what: this.progressWhat });
        continue;
      }
      if (this.options.streaming && named.has(relative)) {
        this.attributed.add(relative);
        this.progressAt = at;
        this.progressWhat = `edited \`${basename(relative)}\``;
        this.push({ at, kind: "progress", what: this.progressWhat });
        // An attributed change is a real step forward: repeats are counted from here.
        this.resetRepeatCounters();
      } else {
        this.observed.add(relative);
        this.observedAt = at;
        this.observedWhat = `workspace file changed: \`${relative}\` (not proven to be this round's)`;
        this.push({ at, kind: "observed", what: this.observedWhat });
      }
    }
  }

  private noteMessage(text: string): void {
    const key = text.trim().replace(/\s+/g, " ");
    if (key.length === 0) {
      return;
    }
    const count = (this.messageCounts.get(key) ?? 0) + 1;
    this.messageCounts.set(key, count);
    this.lastToolKey = undefined;
    this.lastToolRun = 0;
    if (count >= REPEAT_SAME_MESSAGE_LIMIT_V1 && this.repeatReason === undefined) {
      this.repeatReason = "message";
      this.repeatWhat = `the same message ${count} times`;
    }
  }

  private noteToolUse(tool: StreamToolV1, at: number): void {
    // One tool event is counted once, however many events (started, updated, completed) carry its id.
    if (tool.id !== undefined) {
      if (this.seenToolIds.has(tool.id)) {
        return;
      }
      this.seenToolIds.add(tool.id);
    }
    const name = tool.name;
    const input = tool.input ?? {};
    // The same tool call with the same input, repeated back to back. A call whose arguments are
    // unknown is never evidence of a repeat: it starts a new run and matches nothing.
    if (tool.input === undefined) {
      this.lastToolRun = 1;
      this.lastToolKey = undefined;
    } else {
      const key = `${name}:${JSON.stringify(input)}`;
      this.lastToolRun = key === this.lastToolKey ? this.lastToolRun + 1 : 1;
      this.lastToolKey = key;
    }
    if (this.lastToolRun >= REPEAT_SAME_TOOL_CALL_LIMIT_V1 && this.repeatReason === undefined) {
      this.repeatReason = "toolCall";
      this.repeatWhat = `the same \`${name}\` call ${this.lastToolRun} times in a row`;
    }
    for (const file of tool.files) {
      const relative = this.relativeToRoot(file);
      if (relative !== undefined) {
        this.pendingEdits.add(relative);
      }
    }
    const command = typeof input.command === "string" ? input.command.trim().replace(/\s+/g, " ") : undefined;
    let what: string;
    if (COMMAND_TOOLS.has(name.toLowerCase()) && command !== undefined) {
      what = `ran \`${command.length > 60 ? `${command.slice(0, 57)}...` : command}\``;
    } else if (tool.files.length === 1 && tool.files[0] !== undefined) {
      what = `is editing \`${basename(tool.files[0])}\``;
    } else if (tool.files.length > 1) {
      what = `is editing ${tool.files.length} files`;
    } else {
      what = `used ${name}`;
    }
    // A new command or tool event is progress when it arrives, counted once. A command that is
    // still running adds nothing afterwards.
    this.progressAt = at;
    this.progressWhat = what;
    this.push({ at, kind: "progress", what });
  }

  private savedFromLocalEditorSince(changed: string, sinceMs: number): boolean {
    const lookup = this.options.localEditorSaveAt;
    if (lookup === undefined) {
      return false;
    }
    const root = this.options.workspaceRoot ?? "";
    const absolute = path.resolve(path.isAbsolute(changed) ? changed : path.join(root, changed));
    const savedAt = lookup(absolute);
    return savedAt !== undefined && savedAt > sinceMs;
  }

  private resetRepeatCounters(): void {
    this.messageCounts = new Map<string, number>();
    this.lastToolKey = undefined;
    this.lastToolRun = 0;
  }

  private relativeToRoot(file: string): string | undefined {
    const root = this.options.workspaceRoot;
    if (root === undefined) {
      return path.isAbsolute(file) ? undefined : file.split(path.sep).join("/");
    }
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return relative.split(path.sep).join("/");
  }

  private isRoundProgressFile(changed: string): boolean {
    const own = this.options.roundProgressPath;
    if (own === undefined) {
      return false;
    }
    const root = this.options.workspaceRoot ?? "";
    const absolute = path.isAbsolute(changed) ? changed : path.join(root, changed);
    return path.resolve(absolute) === path.resolve(own);
  }

  /** Everything the module comment lists as never recorded is not recordable. */
  private isRecordable(relative: string, changed: string): boolean {
    if (this.isRoundProgressFile(changed)) {
      return true;
    }
    const segments = relative.split("/");
    if (segments.includes(".git") || segments.includes(".ensemble")) {
      return false;
    }
    return segments[0] !== "dist" && segments[0] !== "out";
  }

  private push(entry: RoundActivityEntryV1): void {
    this.entriesList.push(entry);
    if (this.entriesList.length > MAX_ENTRIES) {
      this.entriesList.splice(0, this.entriesList.length - MAX_ENTRIES);
    }
  }
}

/**
 * The idle stop: true when the round, whose provider streams events, has shown no `contact` and no
 * `progress` for `idleMs`. `observed` entries and an outstanding command never reset it. A provider
 * that prints nothing until it finishes gets no idle stop (it gets the warning and the backstop).
 */
export function isRoundIdleV1(
  feed: RoundActivityFeedV1,
  startedAt: number,
  now: number,
  idleMs: number,
  streaming: boolean
): boolean {
  if (!streaming || idleMs <= 0) {
    return false;
  }
  return now - (feed.lastLivenessAt() ?? startedAt) >= idleMs;
}
