import * as vscode from "vscode";
import * as cp from "child_process";
import * as os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunnerCapabilities,
  AgentRunRequest,
  AgentRunResult,
  AgentWorkflowStage,
} from "../types/agentRunner";
import { withAttribution, writeTextFile } from "../utils/fileUtils";
import { ImplementationRunResult } from "./copilotImplementationRunner";
import { cliDisplayLabel, CliProviderDefinition, CliRunMode } from "./providers";
import { classifyCliFailure } from "../utils/quota";
import { writeRunLog } from "../utils/runLog";
import { taskOperations } from "../utils/taskOperations";
import {
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";
import { looksLikeGeneratedImplementationSummary } from "../utils/implementationArtifactResolver";
import { killProcessTree, sanitizedCliEnv } from "../utils/cliProcessUtils";

/**
 * Reserved artifact filenames the implementation stage writes inside a task
 * folder. CLI agents run with cwd set to the workspace root and are
 * sometimes instructed (via the implementation prompt) to "produce
 * plan-final.md" — a model can misread that as "write ./plan-final.md" in
 * the repo root instead of returning the summary as its final answer. A
 * root-level file with one of these names is only treated as that stray
 * write — and stripped out of filesChanged — when its content actually
 * matches the generated-summary shape (see looksLikeGeneratedImplementationSummary);
 * a workspace's own unrelated file of the same name is left alone.
 */
const RESERVED_ROOT_ARTIFACT_NAMES: ReadonlySet<string> = new Set([
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
]);

/**
 * Hard cap on a single CLI run. Runs are also cancellable from the progress
 * notification; this only guards against a hung process left behind.
 */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Cache of PATH lookups so availability checks (which run on every model
 * picker open and every "with AI" command) don't repeatedly shell out.
 * Entries expire after COMMAND_EXISTS_CACHE_TTL_MS so installing a CLI
 * mid-session (without reloading VS Code) is picked up on the next check
 * rather than staying "not installed" for the rest of the session.
 */
const COMMAND_EXISTS_CACHE_TTL_MS = 60 * 1000;
const commandExistsCache = new Map<string, { exists: boolean; expiresAt: number }>();

function cliCommandCandidates(
  command: string,
  aliases: readonly string[] = []
): readonly string[] {
  return [command, ...aliases];
}

async function lookupCliCommand(command: string): Promise<boolean> {
  const cached = commandExistsCache.get(command);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.exists;
  }
  const exists = await new Promise<boolean>((resolve) => {
    const lookup =
      process.platform === "win32"
        ? cp.spawn("where.exe", [command], { windowsHide: true })
        : cp.spawn("which", [command]);
    lookup.on("error", () => resolve(false));
    lookup.on("close", (code) => resolve(code === 0));
  });
  commandExistsCache.set(command, {
    exists,
    expiresAt: Date.now() + COMMAND_EXISTS_CACHE_TTL_MS,
  });
  return exists;
}

/**
 * Resolve the first executable name for this provider that is available on
 * PATH, trying aliases in order.
 */
export async function resolveCliCommand(
  command: string,
  aliases: readonly string[] = []
): Promise<string | undefined> {
  for (const candidate of cliCommandCandidates(command, aliases)) {
    if (await lookupCliCommand(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Whether an executable is resolvable via PATH (where/which exits 0).
 */
export async function cliCommandExists(
  command: string,
  aliases: readonly string[] = []
): Promise<boolean> {
  return (await resolveCliCommand(command, aliases)) !== undefined;
}

export interface CliSetupStatus {
  installed: boolean;
  /** Undefined means this CLI has no safe non-interactive auth-status command. */
  authenticated: boolean | undefined;
}

/**
 * Test a provider without sending a model request or consuming model usage.
 * A successful auth-status command is the only green result; mere presence on
 * PATH remains explicitly unverified rather than being reported as logged in.
 */
export async function testCliProviderSetup(
  def: CliProviderDefinition
): Promise<CliSetupStatus> {
  const command = await resolveCliCommand(def.command, def.commandAliases);
  if (!command) return { installed: false, authenticated: false };
  if (!def.authenticationCheckArgs) return { installed: true, authenticated: undefined };

  return new Promise((resolve) => {
    const child = cp.spawn(command, [...def.authenticationCheckArgs!], {
      windowsHide: true,
      shell: process.platform === "win32",
      env: sanitizedCliEnv(),
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ installed: true, authenticated: false });
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ installed: true, authenticated: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ installed: true, authenticated: code === 0 });
    });
  });
}

// sanitizedCliEnv and killProcessTree moved to ../utils/cliProcessUtils so
// cliModelDiscovery.ts's discovery spawns can share them too — see that
// module's doc comments for why both spawn paths need the same guarantees.

/**
 * What the CLI's own stdout event stream showed for a timed-out run —
 * the primary evidence gate for auto-retrying an edit-capable run.
 */
export interface CliEditEventEvidence {
  /** Whether stdout carried a parseable per-event (JSON-lines) stream at all. */
  streamAvailable: boolean;
  /** Whether any tool-use / file-edit event was observed before the failure. */
  sawToolOrEditEvent: boolean;
}

/**
 * Markers that identify a tool-use or file-edit boundary event in a
 * provider's JSON event stream. Deliberately broad across the supported
 * CLIs' event vocabularies (Claude stream-json `tool_use`, Codex
 * `function_call`/`exec`/`apply_patch`, Gemini `tool`/`edit` events):
 * a false positive merely suppresses an auto-retry, while a false negative
 * could retry a run that already had side effects.
 */
const TOOL_OR_EDIT_EVENT_PATTERN =
  /"type"\s*:\s*"[^"]*(?:tool|edit|patch|exec|command|file_change|write)[^"]*"|"tool_use"|"tool_name"|"tool_calls?"|"function_call"|"apply_patch"|"file_edit"/i;

/**
 * Parse a CLI's raw stdout as a JSON-lines event stream and report whether
 * one was present and whether it contained tool-use/file-edit activity.
 * Exported for direct unit testing of the retry-evidence matrix.
 */
export function analyzeCliEventStream(stdoutRaw: string): CliEditEventEvidence {
  let streamAvailable = false;
  let sawToolOrEditEvent = false;
  for (const line of stripAnsi(stdoutRaw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    streamAvailable = true;
    if (TOOL_OR_EDIT_EVENT_PATTERN.test(trimmed)) {
      sawToolOrEditEvent = true;
    }
  }
  return { streamAvailable, sawToolOrEditEvent };
}

export interface EditRetryDecision {
  retry: boolean;
  /** Human-readable evidence/justification, recorded in the retry audit log. */
  reason: string;
}

/**
 * The edit-run auto-retry rule (exported for direct unit testing): retry a
 * timed-out edit run ONLY when the provider guarantees tool/edit boundary
 * events are flushed before side effects, the parsed event stream was
 * actually available AND clean of tool/edit activity, and the working-tree
 * snapshot is unchanged. Every other combination refuses the retry — an
 * absent or unverifiable stream from a timed-out process proves nothing.
 */
export function evaluateEditRetryEligibility(options: {
  providerLabel: string;
  guaranteesEditEventFlushBeforeSideEffects: boolean;
  evidence: CliEditEventEvidence | undefined;
  snapshotClean: boolean;
}): EditRetryDecision {
  if (!options.guaranteesEditEventFlushBeforeSideEffects) {
    return {
      retry: false,
      reason:
        `Automatic retry is disabled for ${options.providerLabel} edit runs: its CLI protocol ` +
        "does not guarantee edit events are flushed before side effects.",
    };
  }
  if (!options.evidence?.streamAvailable) {
    return {
      retry: false,
      reason:
        "No parseable event stream was available for the timed-out run, so it cannot be " +
        "proven side-effect free.",
    };
  }
  if (options.evidence.sawToolOrEditEvent) {
    return {
      retry: false,
      reason:
        "The run's event stream shows tool/edit activity before the timeout, so it may " +
        "already have made changes.",
    };
  }
  if (!options.snapshotClean) {
    return {
      retry: false,
      reason: "The working tree changed (or could not be verified) during the timed-out run.",
    };
  }
  return {
    retry: true,
    reason:
      "provider flush guarantee + clean event stream (no tool/edit events) + unchanged " +
      "working-tree snapshot",
  };
}

/** One audited (attempted or refused) retry, persisted via runLog. */
export interface RetryAuditEntry {
  attempt: number;
  classification: string;
  capabilityFlag: boolean | undefined;
  evidence: string;
  delayMs: number;
  retried: boolean;
}

/** Render the retry audit as the Markdown run-log artifact. @internal exported for testing */
export function formatRetryAuditLog(
  providerLabel: string,
  mode: string,
  entries: readonly RetryAuditEntry[]
): string {
  const lines = [
    `# CLI Retry Audit — ${providerLabel} (${mode})`,
    "",
    `- Policy: max ${CLI_RETRY_MAX_ATTEMPTS} attempts, ${CLI_RETRY_DELAY_MS / 1000}s delay between attempts`,
    `- Recorded at: ${new Date().toISOString()}`,
    "",
  ];
  for (const entry of entries) {
    lines.push(
      `## Attempt ${entry.attempt}`,
      "",
      `- Classification: ${entry.classification}`,
      `- Provider flush-guarantee flag: ${entry.capabilityFlag === undefined ? "n/a (read-only run)" : String(entry.capabilityFlag)}`,
      `- Evidence: ${entry.evidence}`,
      `- Decision: ${entry.retried ? `retried after ${entry.delayMs / 1000}s` : "not retried"}`,
      ""
    );
  }
  return lines.join("\n");
}

/** Best-effort persistence of the retry audit — a log failure never fails the run. */
async function persistRetryAuditLog(
  taskFolderUri: vscode.Uri | undefined,
  runnerId: string,
  stage: AgentWorkflowStage | undefined,
  providerLabel: string,
  mode: string,
  entries: readonly RetryAuditEntry[]
): Promise<void> {
  if (!taskFolderUri || entries.length === 0) {
    return;
  }
  try {
    const auditLogUri = await writeRunLog(
      taskFolderUri,
      `${runnerId}-retry`,
      stage ?? "impl",
      formatRetryAuditLog(providerLabel, mode, entries)
    );
    // Best effort, and expected to be superseded once the run's own final
    // log is written (this call site has no operation handle, so resolve
    // the task's live root operation the same way taskOperations.tokenFor
    // does for the run itself).
    taskOperations.setResultTargetUriForTask(taskFolderUri.fsPath, auditLogUri);
  } catch {
    // Auditing is evidence, not control flow.
  }
}

export interface CliExecResult {
  status: "completed" | "failed" | "cancelled";
  output: string;
  errorMessage?: string;
  /** Set on failed results; absent for completed/cancelled. */
  failureKind?: "quota" | "temporarily-unavailable" | "generic";
  /**
   * True when the failure is a transient transport-level condition (a run
   * timeout) that is in principle retryable. Auth errors, non-zero tool
   * exits, and content errors are never marked transient.
   */
  transient?: boolean;
  /** Event-stream evidence captured for transient (timeout) failures. */
  editEvidence?: CliEditEventEvidence;
}

/** Bounded retry policy for transient CLI failures (timeouts). */
export const CLI_RETRY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
export const CLI_RETRY_DELAY_MS = 5_000;

/**
 * The read-only (text-mode) retry rule (exported for direct unit testing):
 * retry only a failure classified transient — a run timeout; auth errors,
 * non-zero tool exits, and content errors are never marked transient — while
 * attempts remain and the run has not been cancelled. Read-only runs are
 * side-effect free by construction, so unlike edit runs no further evidence
 * is required.
 */
export function shouldRetryReadOnlyRun(
  result: Pick<CliExecResult, "status" | "transient">,
  attempt: number,
  cancellationRequested: boolean
): boolean {
  return (
    result.status === "failed" &&
    result.transient === true &&
    attempt < CLI_RETRY_MAX_ATTEMPTS &&
    !cancellationRequested
  );
}

/** Cancellable delay between retry attempts. */
async function retryDelay(
  token: vscode.CancellationToken,
  ms = CLI_RETRY_DELAY_MS
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function tryReadFileUriContent(value: string): string | undefined {
  const fileUriMatches = value.match(/file:\/\/\/[^\s)]+/g);
  if (!fileUriMatches) {
    return undefined;
  }

  for (const rawMatch of fileUriMatches) {
    try {
      const uri = vscode.Uri.parse(rawMatch);
      if (!uri.fsPath || !nodeFs.existsSync(uri.fsPath)) {
        continue;
      }
      const content = nodeFs.readFileSync(uri.fsPath, "utf8").trim();
      if (content.length > 0) {
        return stripAnsi(content).trim();
      }
    } catch {
      // Ignore malformed URIs or unreadable files and keep trying.
    }
  }

  return undefined;
}

function extractKiroFinalOutput(stdout: string): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  const fromFile = tryReadFileUriContent(cleaned);
  if (fromFile) {
    return fromFile;
  }

  const markers = [
    "Based on my analysis",
    "Here's my low-level review:",
    "Here's my high-level review:",
    "## Summary Verdict",
    "## Conclusion",
    "I have completed a high-level review",
  ];

  let bestIndex = -1;
  for (const marker of markers) {
    const index = cleaned.indexOf(marker);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) {
    return cleaned.slice(bestIndex).trim();
  }

  return cleaned;
}

/**
 * opencode's `--format json` stdout is a JSON-lines event stream, not the
 * final answer directly (verified live against opencode 1.18.4): each line
 * is an event object, and the assistant's reply arrives as one or more
 * `{"type":"text",...,"part":{"type":"text","text":"..."}}` lines — each
 * carrying that part's FULL accumulated text, not an incremental delta
 * (confirmed by direct testing: a two-sentence reply arrived as a single
 * complete `text` event, not per-token chunks). A run may include several
 * text parts interleaved with tool-use events (e.g. "I'll do X" ... tool
 * call ... "Done."), so every text part is concatenated in stream order to
 * reconstruct the full reply, rather than keeping only the last one.
 */
/** Placeholder returned when opencode's event stream parsed cleanly (real
 * step/tool events were present) but contained no text reply at all — a
 * genuine exit-0 outcome, verified live: a build-mode run instructed to
 * "silently create this file, no confirmation text" ended on a step-finish
 * with reason "stop" and zero text parts in the whole stream. Distinct from
 * an empty string so execCliAgent's "produced no output" guard (which fails
 * ANY zero-length result, in every mode) does not turn a legitimate silent
 * edit into a false failure — the actual "did nothing" case is still caught
 * downstream by runImplementationWithCli's filesChanged check for edit runs,
 * and this placeholder makes a text-mode (plan/review) run that answered
 * nothing meaningfully visible as such rather than silently empty either. */
const OPENCODE_NO_TEXT_REPLY_PLACEHOLDER =
  "(opencode completed the run without returning any text reply.)";

function extractOpencodeFinalOutput(stdout: string): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  const textParts: string[] = [];
  let sawRecognizedEvent = false;
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const event = parsed as {
      type?: unknown;
      part?: { type?: unknown; text?: unknown };
    };
    if (typeof event.type === "string") {
      sawRecognizedEvent = true;
    }
    if (
      event.type === "text" &&
      event.part?.type === "text" &&
      typeof event.part.text === "string"
    ) {
      textParts.push(event.part.text);
    }
  }

  if (textParts.length > 0) {
    return textParts.join("\n\n").trim();
  }

  if (sawRecognizedEvent) {
    return OPENCODE_NO_TEXT_REPLY_PLACEHOLDER;
  }

  // Nothing in the output was a recognizable opencode JSON event at all
  // (e.g. an "error" event line still parses as an object with a "type" of
  // "error" and IS caught above — this branch is for genuinely unparseable
  // or unrecognized stream shapes from a future opencode version). Fall
  // back to the raw stream so the failure is still visible rather than
  // silently empty or silently generic.
  return cleaned;
}

function normalizeCliOutput(
  def: CliProviderDefinition,
  stdout: string,
  lastMessageFile: string | undefined
): string {
  let output = stripAnsi(stdout).trim();
  if (lastMessageFile) {
    try {
      const fromFile = nodeFs.readFileSync(lastMessageFile, "utf8").trim();
      if (fromFile.length > 0) {
        output = stripAnsi(fromFile).trim();
      }
    } catch {
      // Fall back to stdout when the CLI never wrote the file.
    }
  }

  if (def.id === "kiro-cli") {
    return extractKiroFinalOutput(output);
  }

  if (def.id === "opencode-cli") {
    return extractOpencodeFinalOutput(output);
  }

  return output;
}

export const __testOnly = {
  stripAnsi,
  extractKiroFinalOutput,
  extractOpencodeFinalOutput,
  normalizeCliOutput,
  toCliImplementationRunResult,
  sanitizedCliEnv,
};

/**
 * Trim CLI output to a manageable size for a user-facing error without
 * losing the lead explanation line. A pure tail slice can hide the actual
 * "Error: ..." message when a CLI appends a long fixed-size list after it
 * (e.g. Antigravity's "invalid --model" error is followed by its full
 * "Available models:" list) — the real reason gets pushed out of the
 * window and only the trailing list survives. Keeping the first line plus
 * the tail preserves that lead message while still bounding output size,
 * and costs nothing for CLIs whose meaningful message is on the last line
 * instead (e.g. a Python-style traceback), since the tail is kept either way.
 */
function truncateCliDetail(text: string, maxLines = 8): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= maxLines) {
    return lines.join("\n").trim();
  }
  const head = lines[0]!;
  const tail = lines.slice(-(maxLines - 1));
  return (tail.includes(head) ? tail : [head, ...tail]).join("\n").trim();
}

/**
 * Convert raw CLI failure output into a user-facing error, surfacing the
 * provider's login hint when the output looks like an auth problem.
 */
function toFriendlyError(
  def: CliProviderDefinition,
  exitCode: number | null,
  stderr: string,
  stdout: string
): string {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  const looksLikeAuth = def.authErrorMarkers.some((marker) =>
    combined.includes(marker)
  );
  const detail =
    truncateCliDetail(stderr) ||
    truncateCliDetail(stdout) ||
    `exit code ${exitCode ?? "unknown"}`;
  const authSuffix = looksLikeAuth ? ` ${def.loginHint}` : "";
  return `${cliDisplayLabel(def)} CLI failed: ${detail}${authSuffix}`;
}

/**
 * Run a provider CLI once: prompt in via stdin, answer out via stdout (or
 * the provider's last-message file). Cancellation kills the process tree.
 */
export async function execCliAgent(options: {
  def: CliProviderDefinition;
  mode: CliRunMode;
  model: string | undefined;
  prompt: string;
  cwd: string;
  token: vscode.CancellationToken;
  onProgress?: (message: string) => void;
}): Promise<CliExecResult> {
  const { def, mode, model, prompt, cwd, token, onProgress } = options;

  let lastMessageFile: string | undefined;
  if (def.usesLastMessageFile) {
    lastMessageFile = nodePath.join(
      os.tmpdir(),
      `vs-code-ai-helper-${def.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    );
  }

  const promptTransport = def.promptTransport ?? "stdin";
  const useShell = def.useShell ?? true;
  let promptFile: string | undefined;
  if (promptTransport === "file") {
    if (useShell) {
      return classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: `${def.label} provider misconfiguration: file prompt transport requires shell:false for safe argument passing.`,
      });
    }
    promptFile = nodePath.join(
      os.tmpdir(),
      `vs-code-ai-helper-${def.id}-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    try {
      // mode 0o600: prompt contents may include full context packs (source
      // code, review text). os.tmpdir() is shared across all local users on
      // POSIX systems, and the default write mode (0o666 before umask) can
      // leave the file world-readable depending on the process's umask.
      nodeFs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: `Could not write a temp prompt file for ${def.label}: ${message}`,
      });
    }
  }

  // Once promptFile exists on disk, every return path from here on must
  // clean it up — including the early-return guards below, which run
  // before the finish()/Promise machinery that normally owns cleanup.
  const cleanupPromptFile = (): void => {
    if (promptFile) {
      try {
        nodeFs.unlinkSync(promptFile);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  // A provider's buildArgs may throw on its own precondition violations
  // (e.g. Antigravity's promptFile contract — see its buildArgs comment).
  // Catch it here rather than let it propagate past cleanupPromptFile and
  // persistRetryAuditLog (owned by the caller's retry loop, above this
  // function on the stack): both would otherwise be skipped, leaking the
  // 0600 temp prompt file and silently dropping the retry audit trail.
  // Report it the same way every other transport-precondition check in
  // this function does, via classifyCliFailure.
  let args: string[];
  try {
    args = def.buildArgs(mode, model, lastMessageFile, {
      cwd,
      promptFile,
    });
  } catch (error) {
    cleanupPromptFile();
    const message = error instanceof Error ? error.message : String(error);
    return classifyCliFailure({
      status: "failed",
      output: "",
      errorMessage: message,
    });
  }

  if (promptTransport === "argv") {
    if (useShell) {
      return classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: `${def.label} provider misconfiguration: argv prompt transport requires shell:false for safe argument passing.`,
      });
    }
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const maxArgvPromptBytes = def.maxArgvPromptBytes;
    if (
      typeof maxArgvPromptBytes === "number" &&
      promptBytes > maxArgvPromptBytes
    ) {
      return classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage:
          `${def.label} prompt is too large for this CLI mode (${promptBytes} bytes; max ${maxArgvPromptBytes} bytes). ` +
          "Reduce context or choose a provider that accepts stdin prompts.",
      });
    }
    args.push(prompt);
  }

  const resolvedCommand = await resolveCliCommand(
    def.command,
    def.commandAliases
  );

  if (!resolvedCommand) {
    cleanupPromptFile();
    return classifyCliFailure({
      status: "failed",
      output: "",
      errorMessage: `Could not start the ${cliDisplayLabel(def)} CLI (${def.command}): command not found. ${def.installHint}`,
    });
  }

  return new Promise<CliExecResult>((resolve) => {
    let settled = false;
    let cancelled = false;
    let stdout = "";
    let stderr = "";

    // shell:true is the default so Windows resolves .cmd/.ps1 shims from
    // npm/pnpm global installs. When shell:true on Windows, quote arguments
    // containing spaces.
    const spawnArgs =
      useShell && process.platform === "win32"
        ? args.map((a) => (a.includes(" ") ? `"${a}"` : a))
        : args;
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(resolvedCommand, spawnArgs, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: sanitizedCliEnv(),
        // POSIX only: makes the shell (and everything it execs/forks) its
        // own process group, so killProcessTree can SIGTERM the whole group
        // instead of just the shell's PID — see killProcessTree for why that
        // matters with shell:true. Windows has no process-group concept here
        // and uses taskkill /T on the PID tree instead.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const argvHint =
        promptTransport === "argv"
          ? " Reduce context or choose a provider that accepts stdin prompts."
          : "";
      cleanupPromptFile();
      resolve(classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: `Could not start the ${cliDisplayLabel(def)} CLI (${resolvedCommand}): ${message}.${argvHint} ${def.installHint}`.trim(),
      }));
      return;
    }

    const finish = (result: CliExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      cancellationListener.dispose();
      if (lastMessageFile) {
        try {
          nodeFs.unlinkSync(lastMessageFile);
        } catch {
          // Best-effort cleanup.
        }
      }
      cleanupPromptFile();
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      killProcessTree(child);
      finish({
        ...classifyCliFailure({
          status: "failed",
          output: stdout,
          errorMessage: `${cliDisplayLabel(def)} CLI timed out after ${
            RUN_TIMEOUT_MS / 60000
          } minutes.`,
        }),
        // A timeout is the one failure shape that is transport-transient and
        // therefore retry-eligible (read-only runs always; edit runs only
        // under the per-provider flush guarantee — see runImplementationWithCli).
        transient: true,
        // What the event stream showed up to the kill — the primary
        // retry-evidence input for edit-capable runs.
        editEvidence: analyzeCliEventStream(stdout),
      });
    }, RUN_TIMEOUT_MS);

    const cancellationListener = token.onCancellationRequested(() => {
      cancelled = true;
      killProcessTree(child);
      finish({ status: "cancelled", output: stdout });
    });

    child.on("error", (error) => {
      finish(classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: `Could not start the ${cliDisplayLabel(def)} CLI (${resolvedCommand}): ${error.message}. ${def.installHint}`,
      }));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lastLine = stdout.trimEnd().split(/\r?\n/).pop();
      if (lastLine && onProgress) {
        onProgress(lastLine.substring(0, 80));
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (cancelled) {
        finish({ status: "cancelled", output: stdout });
        return;
      }

      const output = normalizeCliOutput(def, stdout, lastMessageFile);

      if (code !== 0) {
        finish(classifyCliFailure({
          status: "failed",
          output,
          errorMessage: toFriendlyError(def, code, stderr, stdout),
        }));
        return;
      }

      if (output.length === 0) {
        finish(classifyCliFailure({
          status: "failed",
          output,
          errorMessage: `${cliDisplayLabel(def)} CLI produced no output. ${
            truncateCliDetail(stderr, 4)
          }`.trim(),
        }));
        return;
      }

      finish({ status: "completed", output });
    });

    if (promptTransport === "stdin") {
      child.stdin?.on("error", () => {
        // Ignore EPIPE when the process exits before consuming the prompt;
        // the close handler reports the real failure.
      });
      child.stdin?.write(prompt);
    }
    child.stdin?.end();
  });
}

/**
 * Text-producing runner (plans, reviews) backed by a vendor CLI.
 * Providers may use subscription login and/or API-key auth depending on
 * vendor requirements, and prompt transport may be stdin or argv.
 * The CLI answer is written to the requested output file.
 */
export class CliAgentRunner implements AgentRunner {
  readonly id: string;
  readonly label: string;
  readonly capabilities: AgentRunnerCapabilities = {
    planning: true,
    review: true,
    assistant: true,
  };

  constructor(private readonly def: CliProviderDefinition) {
    this.id = def.id;
    this.label = def.label;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const exists = await cliCommandExists(
      this.def.command,
      this.def.commandAliases
    );
    if (!exists) {
      return {
        available: false,
        reason: `The ${cliDisplayLabel(this.def)} CLI (${this.def.command}) is not installed. ${this.def.installHint}`,
      };
    }
    return { available: true };
  }

  async run(
    request: AgentRunRequest,
    token: vscode.CancellationToken
  ): Promise<AgentRunResult> {
    // Read-only (text) runs are side-effect free, so transient timeouts are
    // retried freely: up to CLI_RETRY_MAX_ATTEMPTS with a short delay. Each
    // attempt is audited to the task's run log (attempt, classification,
    // evidence, delay), not just the debug console.
    const retryAudit: RetryAuditEntry[] = [];
    let result: CliExecResult | undefined;
    for (let attempt = 1; attempt <= CLI_RETRY_MAX_ATTEMPTS; attempt++) {
      result = await execCliAgent({
        def: this.def,
        mode: "text",
        model: request.modelId,
        prompt: request.prompt,
        cwd: request.workspaceUri.fsPath,
        token,
      });
      if (!shouldRetryReadOnlyRun(result, attempt, token.isCancellationRequested)) {
        break;
      }
      retryAudit.push({
        attempt,
        classification: "transient (run timeout)",
        capabilityFlag: undefined,
        evidence: "read-only (text-mode) run — side-effect free by construction",
        delayMs: CLI_RETRY_DELAY_MS,
        retried: true,
      });
      await retryDelay(token);
      if (token.isCancellationRequested) {
        await persistRetryAuditLog(
          request.taskFolderUri, this.id, request.stage, this.label, "text", retryAudit
        );
        return { runnerId: this.id, status: "cancelled" };
      }
    }
    await persistRetryAuditLog(
      request.taskFolderUri, this.id, request.stage, this.label, "text", retryAudit
    );
    if (!result) {
      return { runnerId: this.id, status: "failed", errorMessage: "unknown error" };
    }

    if (result.status === "cancelled") {
      return { runnerId: this.id, status: "cancelled" };
    }
    if (result.status === "failed") {
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage: result.errorMessage ?? "unknown error",
        failureKind: result.failureKind,
      };
    }

    const signedOutput = withAttribution(
      result.output,
      this.label,
      request.modelId
    );
    await writeTextFile(request.outputFile, signedOutput);
    return {
      runnerId: this.id,
      status: "completed",
      outputFile: request.outputFile,
      modelId: request.modelId,
      summary: `Generated ${result.output.length} characters using ${this.label}.`,
    };
  }
}

/**
 * Per-path fingerprint used to detect changes: the porcelain status code
 * (so untracked/added/deleted files are caught) plus a content hash (so a
 * file that was already modified before the run, and gets modified again
 * during it, is still detected — a plain before/after status-line diff
 * would treat "M foo.ts" -> "M foo.ts" as unchanged).
 */
type GitSnapshot = Map<string, string>;

interface GitStatusEntry {
  statusCode: string;
  path: string;
}

function parseGitStatusEntries(statusOutput: string): GitStatusEntry[] {
  const entries = statusOutput.split("\0");
  const parsed: GitStatusEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    index++;
    if (entry.length < 4) {
      continue;
    }

    const statusCode = entry.substring(0, 2);
    const path = entry.substring(3).replace(/\\/g, "/");
    if (path.length > 0) {
      parsed.push({ statusCode, path });
    }

    if (
      (statusCode[0] === "R" ||
        statusCode[0] === "C" ||
        statusCode[1] === "R" ||
        statusCode[1] === "C") &&
      entries[index]
    ) {
      parsed.push({
        statusCode,
        path: entries[index]!.replace(/\\/g, "/"),
      });
      index++;
    }
  }
  return parsed;
}

/**
 * Snapshot of the workspace's git working-tree state, keyed by
 * workspace-relative path, used to detect which files an agentic CLI run
 * changed. Undefined when git is unavailable or the workspace is not a
 * repository — callers must treat that as "unknown", not "no changes".
 */
async function gitStatusSnapshot(
  cwd: string
): Promise<GitSnapshot | undefined> {
  const statusOutput = await execGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (statusOutput === undefined) {
    return undefined;
  }

  const snapshot: GitSnapshot = new Map();
  const paths: string[] = [];
  for (const { statusCode, path } of parseGitStatusEntries(statusOutput)) {
    snapshot.set(path, statusCode);
    paths.push(path);
  }

  // Hash working-tree content for every dirty/untracked path so re-edits to
  // an already-dirty file are detected even though its status code doesn't
  // change. git hash-object handles untracked files too (unlike git diff).
  // Hashed one path at a time: a single batched call fails its entire
  // stdout (and thus every path's hash) if even one path is missing on
  // disk — e.g. a file git already reports as deleted — which would have
  // silently degraded every other dirty path back to status-only
  // fingerprinting instead of just the missing one.
  if (paths.length > 0) {
    const hashResults = await Promise.all(
      paths.map((path) => execGit(cwd, ["hash-object", "--", path]))
    );
    paths.forEach((path, index) => {
      const statusCode = snapshot.get(path) ?? "";
      const hash = hashResults[index]?.trim();
      // Missing/unreadable files (e.g. deleted, or a race with the CLI
      // still writing) fall back to the status code alone for that path
      // only — every other path keeps its precise content fingerprint.
      snapshot.set(path, hash ? `${statusCode}:${hash}` : statusCode);
    });
  }

  return snapshot;
}

/**
 * Run a git command and return trimmed stdout, or undefined if git is
 * unavailable, the directory isn't a repository, or the command errors.
 */
async function execGit(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      }
    );
  });
}

/**
 * Workspace-relative paths whose fingerprint differs between two snapshots
 * (added, removed, or changed content/status).
 */
function changedPathsSince(
  before: GitSnapshot,
  after: GitSnapshot
): string[] {
  const paths = new Set<string>();
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) {
      paths.add(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function toCliImplementationRunResult(
  def: CliProviderDefinition,
  result: CliExecResult,
  filesChanged: string[],
  filesChangedUnknown: boolean,
  requireFileChange = true
): ImplementationRunResult {
  if (result.status === "cancelled") {
    return { status: "cancelled", filesChanged, filesChangedUnknown };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      filesChanged,
      filesChangedUnknown,
      errorMessage: result.errorMessage,
      failureKind: result.failureKind,
    };
  }
  if (requireFileChange && !filesChangedUnknown && filesChanged.length === 0) {
    const providerOutput = result.output.trim();
    return {
      status: "failed",
      filesChanged,
      filesChangedUnknown,
      errorMessage:
        `${def.label} reported completion but did not modify any workspace files. ` +
        "The implementation runner requires real file edits; check provider permissions " +
        "or choose another implementation model." +
        (providerOutput ? `\n\nProvider output:\n${providerOutput}` : ""),
      // Not a CLI-reported failure — the run itself succeeded, so this can
      // never be a quota exhaustion; classify explicitly rather than
      // leaving failureKind unset for a "failed" result.
      failureKind: "generic",
    };
  }

  return {
    status: "completed",
    filesChanged,
    filesChangedUnknown,
    summary: result.output || undefined,
  };
}

/**
 * Run an agentic implementation with a vendor CLI: the CLI edits files in
 * the workspace itself (with edit-level permissions only), and the files it
 * changed are detected via a git status snapshot taken before and after.
 * Mirrors runImplementationWithCopilot's result shape so callers treat all
 * providers uniformly.
 *
 * requireFileChange (default true) fails the run when the CLI reports
 * completion without touching any file — appropriate for "Run
 * Implementation", where a no-op really is a failure. Callers whose prompt
 * may legitimately be answered without an edit (e.g. stage-response chat)
 * should pass false so a real "just an answer" completion isn't misreported
 * as an error.
 */
export async function runImplementationWithCli(options: {
  def: CliProviderDefinition;
  model: string | undefined;
  prompt: string;
  workspaceUri: vscode.Uri;
  token: vscode.CancellationToken;
  onProgress: (message: string) => void;
  requireFileChange?: boolean;
  /** When provided, retry attempts/refusals are audited to this task's run log. */
  taskFolderUri?: vscode.Uri;
  stage?: AgentWorkflowStage;
}): Promise<ImplementationRunResult> {
  const { def, model, prompt, workspaceUri, token, onProgress, requireFileChange } = options;
  const cwd = workspaceUri.fsPath;

  onProgress(`Using ${def.label}...`);
  const before = await gitStatusSnapshot(cwd);

  let result = await execCliAgent({
    def,
    mode: "edit",
    model,
    prompt,
    cwd,
    token,
    onProgress,
  });

  // Edit-capable runs may auto-retry a transient timeout ONLY on providers
  // whose CLI protocol guarantees tool/edit boundary events are flushed
  // before any side effect (per-provider capability flag, default off), and
  // even then only with double evidence: the parsed event stream must be
  // available and free of tool-use/file-edit events, AND the working-tree
  // snapshot must be unchanged. On any other combination the timed-out run
  // may already have made changes, so it is never auto-retried — the user
  // must review and retry explicitly. Every decision (retry or refusal) is
  // audited to the task's run log.
  const retryAudit: RetryAuditEntry[] = [];
  let attempt = 1;
  while (
    result.status === "failed" &&
    result.transient === true &&
    attempt < CLI_RETRY_MAX_ATTEMPTS &&
    !token.isCancellationRequested
  ) {
    const capabilityFlag = def.guaranteesEditEventFlushBeforeSideEffects === true;
    const snapshotNow = capabilityFlag && before ? await gitStatusSnapshot(cwd) : undefined;
    const snapshotClean =
      before !== undefined &&
      snapshotNow !== undefined &&
      changedPathsSince(before, snapshotNow).length === 0;
    const decision = evaluateEditRetryEligibility({
      providerLabel: def.label,
      guaranteesEditEventFlushBeforeSideEffects: capabilityFlag,
      evidence: result.editEvidence,
      snapshotClean,
    });
    retryAudit.push({
      attempt,
      classification: "transient (run timeout)",
      capabilityFlag,
      evidence: decision.reason,
      delayMs: CLI_RETRY_DELAY_MS,
      retried: decision.retry,
    });
    if (!decision.retry) {
      result = {
        ...result,
        transient: false,
        errorMessage:
          `${result.errorMessage ?? "The run timed out."} ` +
          "This run may already have made changes; review your working tree before retrying. " +
          `(${decision.reason})`,
      };
      break;
    }
    onProgress(
      `${def.label} timed out with no observed changes; retrying (attempt ${attempt + 1}/${CLI_RETRY_MAX_ATTEMPTS})...`
    );
    await retryDelay(token);
    if (token.isCancellationRequested) {
      break;
    }
    attempt++;
    result = await execCliAgent({
      def,
      mode: "edit",
      model,
      prompt,
      cwd,
      token,
      onProgress,
    });
  }
  await persistRetryAuditLog(
    options.taskFolderUri, def.id, options.stage, def.label, "edit", retryAudit
  );

  // Git unavailable or not a repository — we genuinely can't tell what
  // changed, which is different from "nothing changed". Callers must fall
  // back to open-editor review scope in this case, same as manual
  // implementations, rather than trusting an empty filesChanged.
  const after = before ? await gitStatusSnapshot(cwd) : undefined;
  const filesChangedUnknown = before === undefined || after === undefined;
  const rawFilesChanged = filesChangedUnknown
    ? []
    : changedPathsSince(before, after);

  const strayReservedNames = rawFilesChanged.filter((path) => {
    if (!RESERVED_ROOT_ARTIFACT_NAMES.has(path)) {
      return false;
    }
    let content: string | undefined;
    try {
      content = nodeFs.readFileSync(nodePath.join(cwd, path), "utf8");
    } catch {
      // Deleted, or unreadable — can't confirm the generated-summary shape,
      // so leave it as a normal tracked change rather than assuming it's stray.
      return false;
    }
    return looksLikeGeneratedImplementationSummary(content);
  });
  const filesChanged = rawFilesChanged.filter(
    (path) => !strayReservedNames.includes(path)
  );
  if (strayReservedNames.length > 0) {
    onProgress(
      `Note: ${def.label} wrote its implementation summary to a repo-root ` +
        `${strayReservedNames.join("/")} instead of returning it as its final answer; ` +
        "ignoring that stray file."
    );
  }

  return toCliImplementationRunResult(
    def,
    result,
    filesChanged,
    filesChangedUnknown,
    requireFileChange
  );
}
