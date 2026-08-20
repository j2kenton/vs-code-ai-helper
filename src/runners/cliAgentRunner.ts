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
import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  boundedTransportDetailV1,
  BoundedResultWriterV1,
} from "../types/agentExecutionV1";
import { FRAME_START_V1 } from "../types/aiResultEnvelope";
import { createCliStdoutResultCaptureV1 } from "../services/cliStdoutResultCaptureV1";
import { withAttribution, writeTextFile } from "../utils/fileUtils";
import { ImplementationRunResult } from "./copilotImplementationRunner";
import { cliDisplayLabel, CliProviderDefinition, CliRunMode } from "./providers";
import { classifyCliFailure, isAuthenticationFailure, isModelEntitlementFailure, isTransportError } from "../utils/quota";
import { getResilienceSettings } from "../config/settings";
import { writeRunLog } from "../utils/runLog";
import { taskOperations } from "../utils/taskOperations";
import {
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";
import { looksLikeGeneratedImplementationSummary } from "../utils/implementationArtifactResolver";
import { killProcessTree, sanitizedCliEnv } from "../utils/cliProcessUtils";
import { readPackageScripts } from "../utils/completionLint";

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
// Deliberately NOT including IMPLEMENTATION_SUMMARY_FILENAME. These two names
// are reserved because the implementation prompt mentions them by name, so a
// model can misread the mention as an instruction to write the file. Nothing
// ever tells a provider to write impl-summary.md — the summary is returned as
// text — so reserving it would guard against a misdirection that cannot
// happen, while a repository that legitimately owns a root impl-summary.md
// with the natural "## Files Changed"/"## Verification" sections would have
// real edits to it silently dropped from filesChanged.
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
 * Exported for direct unit testing of the retry-evidence matrix. Built on
 * parseJsonLineEvents (defined below — hoisted, so the forward reference is
 * fine) rather than re-implementing its own parse loop: re-serializing each
 * already-parsed event and pattern-matching that is equivalent to matching
 * the original raw line (JSON.parse then JSON.stringify preserves key order
 * and string contents; only whitespace could differ, which the pattern
 * already tolerates via `\s*`), without a second hand-written copy of the
 * strip/split/shape-check/parse loop to keep in sync.
 */
export function analyzeCliEventStream(stdoutRaw: string): CliEditEventEvidence {
  const { events } = parseJsonLineEvents(stdoutRaw);
  return {
    streamAvailable: events.length > 0,
    sawToolOrEditEvent: events.some((event) =>
      TOOL_OR_EDIT_EVENT_PATTERN.test(JSON.stringify(event))
    ),
  };
}

export interface EditRetryDecision {
  retry: boolean;
  /** Human-readable evidence/justification, recorded in the retry audit log. */
  reason: string;
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
  failureKind?: "quota" | "temporarily-unavailable" | "model-entitlement" | "generic";
  /**
   * True when the failure is a transient transport-level condition — a run
   * timeout, or a mid-stream transport drop — that is in principle retryable.
   * Auth errors, non-zero tool exits, and content errors are never marked
   * transient. A run timeout sets this for BOTH modes, but an edit-mode run
   * only actually retries via same-conversation resume (when the provider
   * supports it); every other timed-out edit run refuses regardless of this
   * flag. A mid-stream transport drop, by contrast, is promoted to transient
   * for read-only (text) runs ONLY: unlike a killed-after-buffering-everything
   * timeout, a dropped stream is TRUNCATED, so the absence of tool/edit events
   * in it proves nothing about whether files were already changed — see
   * applyTransportTransience.
   */
  transient?: boolean;
  /**
   * Event-stream evidence captured for timed-out runs. Deliberately NOT
   * populated for transport drops: a truncated stream would look like a clean
   * one.
   */
  editEvidence?: CliEditEventEvidence;
  /**
   * The provider's own authErrorMarkers verdict, captured BEFORE the login
   * hint is appended to errorMessage. Exists because that hint text itself
   * contains the phrase "paste the OpenCode API key", which the downstream
   * isAuthenticationFailure regex then matches — so an error that tripped a
   * false-positive auth diagnosis was guaranteed to be re-confirmed as an auth
   * failure by the very hint Ensemble added to explain it.
   */
  authFailure?: boolean;
  /** errorMessage minus the appended login hint: the form safe to classify. */
  authDiagnosticText?: string;
  /**
   * True when this provider can recover the failed turn by continuing the
   * conversation it just persisted. This is distinct from replay eligibility:
   * continuation intentionally keeps prior context and partial workspace edits.
   */
  resumeConversation?: boolean;
  /**
   * Part 7: which watchdog produced a timed-out result, when applicable.
   * "wall-clock" is the flat RUN_TIMEOUT_MS cap; "inactivity" fired earlier
   * because the process produced no stdout/stderr/raw-transport bytes for
   * ensemble.resilience.inactivityTimeoutMinutes. Absent for non-timeout
   * failures. Downstream recovery routing and run records use this to tell a
   * wedged process apart from a genuinely long-running one.
   */
  timeoutReason?: "wall-clock" | "inactivity";
  /**
   * The provider's own session identifier for THIS run, when its event stream
   * reports one.
   *
   * A resume that says only "continue the last session" is ambiguous: the
   * OpenCode-shaped CLIs scope `--continue` to the WORKING DIRECTORY, and
   * every task in a workspace shares that directory. A second task (or the
   * user running the CLI by hand) between the timed-out run and its retry
   * makes "the last session" someone else's — and an edit-mode retry would
   * then continue unrelated context and apply its edits here. Pinning the
   * exact id removes the ambiguity entirely.
   */
  sessionId?: string;
}

/**
 * First `sessionID` reported by an OpenCode-shaped `--format json` event
 * stream (opencode-cli, devpass-cli). Every event in that stream carries it,
 * so the first match identifies the session this run created. Deliberately a
 * narrow literal match rather than a JSON parse: the stream is line-delimited
 * and may be truncated by a timeout — exactly the case this matters for — so
 * the extraction has to work on a partial buffer.
 */
export function extractOpencodeSessionIdV1(rawStdout: string): string | undefined {
  const match = /"sessionID"\s*:\s*"([A-Za-z0-9_-]{1,128})"/.exec(rawStdout);
  return match?.[1];
}

/**
 * Everything toFriendlyError learned while rendering a failure. Returned as a
 * struct rather than a bare string because the auth verdict used to be a local
 * boolean that was collapsed into prose and thrown away, forcing downstream to
 * re-derive it by regexing the returned message — which by then contained the
 * login hint this function had just appended.
 */
interface CliFriendlyError {
  /** User-facing message, login hint appended when authFailure is true. */
  message: string;
  /** Provider-marker verdict, computed BEFORE any hint is injected. */
  authFailure: boolean;
  /** `message` minus the hint — the classification-safe form of the same text. */
  diagnosticText: string;
  /** True when the provider's own error channel said the failure is retryable. */
  retryableHint: boolean;
  /**
   * True when a structured event explicitly identified the failure as a
   * quota/rate-limit condition (see StructuredCliDiagnostics.quotaSignal).
   * Threaded into classifyCliFailure's structuredQuotaSignal alongside the
   * phrase-based scan quota.ts's isQuotaError always still runs. Optional
   * (rather than required like retryableHint) purely so existing
   * hand-constructed CliFriendlyError test fixtures that predate this field
   * don't all need updating — toFriendlyError itself always sets it.
   */
  quotaSignal?: boolean;
}

/** Bounded retry policy for transient CLI failures (timeouts). */
export const CLI_RETRY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
export const CLI_RETRY_DELAY_MS = 5_000;

/**
 * The text-mode retry rule (exported for direct unit testing): retry only a
 * failure classified transient while attempts remain and the run has not been
 * cancelled. Ordinary providers replay only when their text mode is enforced
 * read-only. A provider with `resumeConversation` set takes the separate
 * same-conversation path instead, which intentionally preserves its prior
 * context and any partial edits rather than replaying the original prompt.
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

/**
 * Whether this provider's text (read-only) mode is actually guaranteed
 * side-effect free — i.e. it carries no permissionWarning. Every ordinary
 * provider's text mode is enforced read-only by the vendor CLI itself
 * (Claude `--permission-mode plan`, Codex `--sandbox read-only`, etc.), which
 * is the assumption `shouldRetryReadOnlyRun`'s "no further evidence
 * required" free-retry rule and this function's own text-mode promotion
 * below both rely on. Antigravity and Cline are the exception: BOTH modes
 * run with every tool auto-approved (including shell/file-write-capable
 * ones), so for them an ambiguous transient failure — a 60-minute timeout,
 * or a mid-stream transport drop — proves nothing about whether the run
 * already mutated the workspace before it failed. Reusing permissionWarning
 * (rather than a new dedicated capability flag) keeps this tied to the SAME
 * disclosure the settings UI already shows the user before they enable such
 * a provider, and automatically covers any future provider that needs the
 * same disclosure.
 */
function isTextModeGuaranteedReadOnly(def: CliProviderDefinition): boolean {
  return !def.permissionWarning;
}

/**
 * Exported capability probe for the summary-only recovery continuation
 * (workflow-robustness Part 2 item 4): whether this provider's text mode is
 * vendor-enforced read-only, i.e. dispatching a continuation through it
 * actually WITHHOLDS edit permissions rather than merely instructing the
 * model not to edit. Same rule `shouldRetryReadOnlyRun`'s free-retry gate
 * relies on — see `isTextModeGuaranteedReadOnly` directly above.
 */
export function isCliTextModeGuaranteedReadOnlyV1(def: CliProviderDefinition): boolean {
  return isTextModeGuaranteedReadOnly(def);
}

/**
 * Exported capability probe for `summary-only` continuation SELECTION
 * specifically (workflow findings, 2026-08-20: "summary-only continuations
 * are selected for claude-cli, whose text mode cannot produce the required
 * report"). Stricter than `isCliTextModeGuaranteedReadOnlyV1` above: that
 * probe answers only "does text mode withhold edits", which claude-cli's
 * `--permission-mode plan` satisfies — but plan mode is a repurposed
 * INTERACTIVE flow whose own baked-in behavior (plan-approval prompting, a
 * `~/.claude/plans/*.md` scratch file) can override the specific report
 * format a summary-only continuation requires, observed live even with the
 * mitigation system prompt attached. A `summary-only` dispatch needs BOTH
 * properties — no edits AND the requested response contract honoured — so
 * this is the probe that selection must use, while the free-retry gate
 * (`shouldRetryReadOnlyRun`) and any other caller that only cares about
 * "did this run mutate the tree" keeps using the read-only-only probe above.
 */
export function isCliTextModeSummaryOnlyCapableV1(def: CliProviderDefinition): boolean {
  return isTextModeGuaranteedReadOnly(def) && def.textModeResponseContractV1 === "honours";
}

/**
 * Promote a mid-stream transport drop from "generic" (terminal at both backup
 * cascade gates) to "temporarily-unavailable" (cascade-eligible) — but only
 * where doing so is actually safe. See the guards below for what "safe"
 * excludes; this is intentionally the ONLY place TRANSPORT_MARKERS-style
 * transport detection happens (classifyFailure/quota.ts deliberately does not
 * do this itself — see its own comment), because this function is the only
 * one with the provider and mode context needed to gate it correctly.
 */
function applyTransportTransience(
  result: CliExecResult & { failureKind: "quota" | "temporarily-unavailable" | "model-entitlement" | "generic" },
  friendly: CliFriendlyError,
  mode: CliRunMode,
  def: CliProviderDefinition
): CliExecResult {
  // An authentication failure is terminal for the selected provider and must
  // stay that way. This guard is load-bearing rather than defensive: the
  // text-mode cascade gate in runnerRegistry checks failureKind ONLY and has no
  // auth check of its own, so promoting an auth error here would start spending
  // backup-model allocations on a credentials problem — exactly what callers
  // must never do.
  //
  // Checks both signals, same as runnerRegistry's own gate: friendly.authFailure
  // is only the provider's OWN authErrorMarkers verdict, which is narrower than
  // isAuthenticationFailure's regex (e.g. claude-cli carries no 401/403/forbidden
  // marker) — a 403 Forbidden that also happens to mention a transport phrase
  // would otherwise pass this guard and get retried/cascaded as if it were a
  // dropped connection instead of a credentials problem.
  if (friendly.authFailure || isAuthenticationFailure(friendly.diagnosticText)) {
    return result;
  }
  // Only promote from "generic": quota and (auth-gated) TEMPORARY_MARKERS
  // classifications from classifyFailure are left exactly as they are.
  if (result.failureKind !== "generic") {
    return result;
  }
  const normalizedDiagnostic = friendly.diagnosticText.toLowerCase();
  const canResumeConversation =
    def.conversationResume?.errorMarkers.some((marker) =>
      normalizedDiagnostic.includes(marker.toLowerCase())
    ) === true;
  if (canResumeConversation) {
    // Keep failureKind generic. A temporarily-unavailable classification is
    // eligible for the backup cascade, but a resumable run may already have
    // edited the working tree. Only the same-provider retry loop may consume
    // this signal, and it does so with --continue rather than prompt replay.
    return {
      ...result,
      transient: true,
      resumeConversation: true,
    };
  }
  // Edit-mode runs may have already written partial changes. The same-model
  // retry path refuses to retry at all — except via same-conversation resume
  // — but the backup CASCADE (runnerRegistry.ts) has no equivalent gate at
  // all: it dispatches a different model at the current
  // (possibly half-edited) working tree the moment failureKind is
  // quota/temporarily-unavailable, with nothing checking whether the primary
  // left it dirty. Promoting an edit-mode transport drop here would spend
  // that ungated cascade on exactly the tree state its same-model sibling
  // refuses to touch — a strictly worse hazard than the retry withheld below.
  // Restricted to text mode (which never writes files FOR PROVIDERS WHOSE
  // TEXT MODE IS ENFORCED READ-ONLY, so no such risk exists there) until the
  // cascade itself gains real dirty-tree gating — a separate, larger fix
  // than this one. Antigravity/Cline's text mode carries the exact same
  // risk edit mode does (see isTextModeGuaranteedReadOnly) and must be
  // excluded here for the same reason edit mode is.
  if (mode !== "text" || !isTextModeGuaranteedReadOnly(def)) {
    return result;
  }
  // retryableHint is a structural signal (the provider's own error event
  // reported isRetryable) and safe for any provider. Text-based matching via
  // isTransportError is safe ONLY for structured-stream providers, whose
  // diagnosticText is scoped to parsed error events and never raw stdout
  // (see toFriendlyError) — for opaque-text providers (kiro-cli; codex-cli
  // left this bucket when it adopted --json),
  // diagnosticText IS raw stdout/model prose, and a transport phrase
  // appearing in ordinary output would falsely promote (and retry) a
  // deterministic failure. Opaque providers simply never set retryableHint,
  // since they have no structured field to report it from — this is not an
  // extra branch for them, just the natural result of the OR.
  const transport =
    friendly.retryableHint ||
    (def.structuredEventStream !== undefined && isTransportError(friendly.diagnosticText));
  if (!transport) {
    return result;
  }
  return {
    ...result,
    failureKind: "temporarily-unavailable",
    // mode is guaranteed "text" here (checked above).
    transient: true,
  };
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

/**
 * Quote a single argv value for safe inclusion in a `/bin/sh -c "..."`
 * command line, the shape Node's own `spawn(..., {shell:true})` constructs
 * on POSIX by joining `[command, ...args]` with plain spaces and handing the
 * whole string to the shell — see the spawnArgs comment in execCliAgent for
 * why this is needed at all. Standard POSIX single-quote escaping: wrap the
 * whole value in single quotes, and for each literal single quote inside it,
 * close the quote, emit a backslash-escaped literal quote (valid unquoted),
 * then reopen the quote — e.g. `it's` becomes `'it'\''s'`. Single-quoting
 * is used (rather than double-quoting) because POSIX shells perform NO
 * expansion at all inside single quotes — not `$variable`, not backticks,
 * not `\` escapes — so this is safe for arbitrary content without needing
 * to separately handle those cases. Applied unconditionally to every argv
 * value (not just ones containing a space or other metacharacter): quoting
 * a value that never needed it is always harmless, and a conditional check
 * is one more thing to get subtly wrong.
 */
function quotePosixShellArg(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
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

/**
 * Unwrap one level of JSON string encoding. opencode double-encodes some error
 * messages — a captured production failure carried
 * `"data":{"message":"\"Streaming response failed\""}`, i.e. the value is a
 * JSON string whose content is itself a quoted string — so the raw value
 * arrives with literal quote characters around it and would not match a
 * transport marker.
 *
 * Single-level and string-results-only by design: never recurse, because a
 * legitimate `responseBody` is itself quoted JSON and unwrapping it would
 * discard structure rather than reveal it.
 */
function unwrapJsonString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    // Not valid JSON after all — keep the original text as-is rather than
    // treating a parse failure as a transport error.
    return value;
  }
}

interface ParsedCliEventLines {
  /** Every line that parsed as a JSON object. */
  events: Record<string, unknown>[];
  /**
   * Text from every line that did NOT parse as a JSON object — i.e. content
   * no recognized event captured. Distinct from "no events were seen at
   * all" (events.length === 0): a stream can contain SOME legitimate events
   * (a few tool/text events, say) and then die writing a plain-text failure
   * straight to stdout instead of a structured error event. A fallback
   * gated on "did we see any event at all" would incorrectly suppress that
   * trailing text — the right question is "was THIS content captured by
   * any event", which is what this field answers directly.
   *
   * Includes lines that LOOK like a cut-off event object (start with "{" but
   * never finished parsing) — safe for `detail` (a user-facing message can
   * afford to show a partial line), but NOT safe for markerScanText: a
   * mid-stream transport drop truncates whatever line was being written,
   * which for a JSON-lines event stream is exactly a tool/text event, and a
   * partial write of one can carry the same embedded file content
   * extractStructuredCliDiagnostics exists to keep out of the auth scan. See
   * unparsedScanSafeText for the subset actually safe to scan.
   */
  unparsedText: string;
  /**
   * Subset of unparsedText from lines that never even looked like a JSON
   * object (don't start with "{") — plain text a CLI wrote outside the event
   * stream entirely (e.g. before it enters --format json mode, or after a
   * crash bypasses it). A truncated write always cuts off a line that WAS
   * mid-way through being written as an event, so it necessarily starts with
   * "{"; a line that never starts with "{" therefore cannot be a partial
   * tool/text event, and is safe to include in markerScanText.
   */
  unparsedScanSafeText: string;
}

/**
 * Strip ANSI escapes and parse a CLI's raw stdout as JSON-lines events.
 * Shared by extractOpencodeFinalOutput and extractStructuredCliDiagnostics,
 * which both accept an already-parsed result via their optional second
 * parameter — execCliAgent's close handler parses once and passes it to
 * both, since a failing opencode run's stream can be multi-megabyte (it
 * re-emits the full text of every file the agent read), and parsing it
 * twice for two different purposes is pure waste. Callers that don't have
 * (or don't need) a shared result — every existing test, and any future
 * direct caller — get identical behavior by omitting it, since the default
 * parameter parses internally.
 */
function parseJsonLineEvents(stdout: string): ParsedCliEventLines {
  const events: Record<string, unknown>[] = [];
  const unparsed: string[] = [];
  const unparsedScanSafe: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith("{")) {
      // Never a truncated/malformed event write — see unparsedScanSafeText's
      // doc comment on the interface above.
      unparsed.push(line);
      unparsedScanSafe.push(line);
      continue;
    }
    if (!line.endsWith("}")) {
      // Looks like a cut-off event write (e.g. a mid-stream transport drop)
      // — may carry partial tool/text-event content. Safe for `detail`,
      // NOT safe for markerScanText.
      unparsed.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Starts and ends with brace-like characters but still didn't parse —
      // an unverified shape, treated the same as a cut-off event rather
      // than assumed safe.
      unparsed.push(line);
      continue;
    }
    if (parsed && typeof parsed === "object") {
      events.push(parsed as Record<string, unknown>);
    } else {
      // Parsed successfully but wasn't actually an object (e.g. a bare JSON
      // string or number on its own line) — genuinely not an event, safe to
      // scan.
      unparsed.push(line);
      unparsedScanSafe.push(line);
    }
  }
  return {
    events,
    unparsedText: unparsed.join("\n"),
    unparsedScanSafeText: unparsedScanSafe.join("\n"),
  };
}

interface StructuredCliDiagnostics {
  /** Everything extractable, for authErrorMarkers matching only. */
  markerScanText: string;
  /** Human-readable summary, for the user-facing error message. */
  detail: string;
  /** Any error event reported the failure as retryable. */
  retryable: boolean;
  /** Whether stdout parsed as a JSON-lines event stream at all. */
  sawAnyEvent: boolean;
  /**
   * A structured event explicitly identified the failure as a quota/rate-limit
   * condition (e.g. claude-cli's stream-json `result` event carrying
   * `error: "rate_limit"`), independent of any phrase match. Optional and
   * omitted (falsy) for providers with no such structural field — see
   * quota.ts's isQuotaError, which OR's this in as an ADDITIONAL signal
   * alongside its existing phrase-based scan, never a replacement for it.
   */
  quotaSignal?: boolean;
}

/**
 * Pull just the diagnosable content out of a structured (JSON-lines) CLI event
 * stream: the stream's own "error" events, plus any trailing content no event
 * captured — and nothing else.
 *
 * The "and nothing else" is the whole point. opencode's --format json stream
 * embeds the full text of every file the agent reads inside its tool events, so
 * scanning the raw stream for markers like "api key" / "login" / "authenticate"
 * diagnoses an auth failure whenever the agent happened to read an auth-related
 * source file. Only type === "error" events are read from `events`; text and
 * tool events are skipped entirely — their content is exactly the risk this
 * function exists to avoid. `unparsedScanSafeText` (lines that never even
 * looked like a JSON object — see parseJsonLineEvents) is safe to include in
 * markerScanText unconditionally, for the same reason: it cannot be a
 * tool/text event's embedded content. The wider `unparsedText` ALSO includes
 * lines that looked like a cut-off event but never finished parsing — e.g. a
 * mid-stream transport drop truncates whatever line was being written, which
 * for this stream shape is exactly a tool/text event — so it is used for
 * `detail` only, never for the auth scan.
 *
 * Three separated products, because they have three different consumers:
 *  - markerScanText feeds def.authErrorMarkers ONLY. It must include the status
 *    code: a genuine balance-exhausted 401 from opencode reads "Insufficient
 *    balance. Manage your billing here: ..." and matches none of opencode's
 *    auth markers — the statusCode is the only auth signal it carries.
 *  - detail feeds the user-facing message, and therefore classifyFailure's
 *    input. responseBody is deliberately EXCLUDED from it: a 401 body can
 *    contain "CreditsError", which lowercases into the "credits" quota marker
 *    and would silently reclassify a credentials problem as a quota event.
 *  - retryable is the structural transient signal, stronger than matching
 *    transport phrases — though absent from the error shapes that carry no
 *    such field, which is why TRANSPORT_MARKERS still exists (in
 *    applyTransportTransience, not here).
 */
function extractStructuredCliDiagnostics(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): StructuredCliDiagnostics {
  const { events, unparsedText, unparsedScanSafeText } = parsed;
  const scan: string[] = [];
  const details: string[] = [];
  let retryable = false;
  // Any parsed object counts, regardless of whether it turns out to be an
  // "error" event below — distinct from extractOpencodeFinalOutput's own
  // narrower sawRecognizedEvent (which additionally requires a string
  // `type` field), since the two functions use this signal for different
  // purposes and must not be conflated.
  const sawAnyEvent = events.length > 0;

  for (const rawEvent of events) {
    const event = rawEvent as { type?: unknown; error?: unknown };
    if (event.type !== "error") {
      continue;
    }

    const err = event.error;
    if (!err || typeof err !== "object") {
      // Unrecognized error-event shape (a future opencode version).
      // Re-serialize rather than silently dropping a real failure — an
      // error event never carries file contents, so this is safe.
      const line = JSON.stringify(rawEvent);
      scan.push(line);
      details.push(line);
      continue;
    }

    const errorObject = err as { name?: unknown; data?: unknown };
    const name =
      typeof errorObject.name === "string" ? errorObject.name : undefined;
    if (name) {
      scan.push(name);
    }

    const data = errorObject.data;
    if (data && typeof data === "object") {
      const fields = data as Record<string, unknown>;
      const scanLengthBefore = scan.length;
      let message: string | undefined;
      let statusCode: number | undefined;

      if (typeof fields.message === "string") {
        message = unwrapJsonString(fields.message);
        scan.push(message);
      }
      // "status" is another spelling of the same thing across error shapes.
      // Only the delimited "HTTP 401" form is pushed — a bare number would
      // let opencode's bare "401" marker match a coincidental substring
      // inside an unrelated field (e.g. responseBody echoing a request id
      // like "req_9401f2"). "HTTP 401" still contains "401" as a substring,
      // so a provider marker of either form still matches it.
      for (const key of ["statusCode", "status"] as const) {
        const value = fields[key];
        if (typeof value === "number") {
          statusCode = statusCode ?? value;
          scan.push(`HTTP ${value}`);
        }
      }
      if (typeof fields.providerID === "string") {
        scan.push(fields.providerID);
      }
      if (typeof fields.responseBody === "string") {
        scan.push(fields.responseBody);
      }
      if (typeof fields.isRetryable === "boolean") {
        scan.push(`isRetryable=${String(fields.isRetryable)}`);
        if (fields.isRetryable) {
          retryable = true;
        }
      }
      // Several error shapes carry no fields at all, or only an opaque one, so
      // fall back to the whole data object rather than extracting nothing.
      if (scan.length === scanLengthBefore) {
        scan.push(JSON.stringify(fields));
      }

      // Same exclusion as markerScanText vs. detail above: responseBody can
      // contain "CreditsError"-style text that would silently reclassify
      // this failure as a quota event once it reaches classifyFailure via
      // `detail`. Only this text-fallback copy needs it stripped — scan's
      // own JSON.stringify(fields) fallback above feeds markerScanText, not
      // detail, so responseBody there is intentional and unchanged.
      const { responseBody: _responseBody, ...fieldsForDetail } = fields;
      const text =
        [name, message].filter((part): part is string => Boolean(part)).join(": ") ||
        name ||
        JSON.stringify(fieldsForDetail);
      details.push(
        statusCode === undefined ? text : `${text} (HTTP ${statusCode})`
      );
    } else if (typeof data === "string") {
      const text = unwrapJsonString(data);
      scan.push(text);
      details.push(name ? `${name}: ${text}` : text);
    } else if (name) {
      details.push(name);
    }
  }

  return {
    // unparsedScanSafeText is always safe to append: by construction it
    // never came from a line that even looked like a JSON object, so it
    // cannot be a truncated tool/text-event's embedded file content — see
    // the interface doc. Deliberately narrower than unparsedText here: a
    // cut-off event write is exactly the risk this scan must exclude.
    markerScanText: [scan.join("\n"), unparsedScanSafeText].filter(Boolean).join("\n"),
    // Fallback only (not always-appended): when a real error event WAS
    // found, the user-facing message should stay that specific text rather
    // than being diluted with unrelated trailing content. Uses the wider
    // unparsedText — a partial line is still worth showing the user even
    // though it isn't safe to auth-scan.
    detail: details.join("\n") || unparsedText,
    retryable,
    sawAnyEvent,
  };
}

/**
 * Cline's `--json` stdout is also a JSON-lines event stream (verified live
 * against cline 3.0.46), but a simpler shape than opencode's: every line has
 * a top-level `type` of "hook_event", "agent_event", "run_result", or
 * "error", and exactly one `{"type":"run_result",...}` line is emitted at
 * the very end of every run carrying the run's complete final answer in its
 * own `text` field — for BOTH a successful run and a failed one (a rejected
 * model ID's `run_result.text` was literally "invalid model format.
 * Expected format: modelType/model"). Unlike opencode there is no need to
 * reconstruct the reply by concatenating multiple streamed text parts: the
 * intermediate `agent_event`-wrapped `content_start`/`content_end` events
 * stream token-by-token (and, for tool calls, re-emit full tool
 * input/output — the same file-content-leak risk opencode has, see
 * extractClineStructuredDiagnostics), but the LAST `run_result.text` is
 * always the authoritative complete answer.
 */
const CLINE_NO_TEXT_REPLY_PLACEHOLDER =
  "(cline completed the run without returning any text reply.)";

/** Kimi's counterpart to CLINE_NO_TEXT_REPLY_PLACEHOLDER — see extractKimiFinalOutput. */
const KIMI_NO_TEXT_REPLY_PLACEHOLDER =
  "(Kimi Code CLI completed the run without returning any text reply.)";

interface ClineEnvelope {
  type?: unknown;
  message?: unknown;
  finishReason?: unknown;
  text?: unknown;
}

function extractClineFinalOutput(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  let sawRecognizedEvent = false;
  let finalText: string | undefined;
  for (const rawEvent of parsed.events) {
    const event = rawEvent as ClineEnvelope;
    if (typeof event.type === "string") {
      sawRecognizedEvent = true;
    }
    if (event.type === "run_result" && typeof event.text === "string") {
      // Last one wins — a single run emits exactly one run_result line in
      // every observed case, but "last" is the same forward-compatible
      // choice extractOpencodeFinalOutput makes for its own text parts.
      finalText = event.text;
    }
  }

  // An explicit empty string is treated the same as "no run_result.text at
  // all": a legitimate exit-0 run whose model returned nothing to say (e.g.
  // a silent tool-only turn) must still produce the placeholder below, not
  // "" — an empty return here is misread downstream as "CLI produced no
  // output" and routed through the failure path with a generic message
  // instead of this placeholder.
  if (finalText !== undefined && finalText.trim().length > 0) {
    return finalText.trim();
  }
  if (sawRecognizedEvent) {
    return CLINE_NO_TEXT_REPLY_PLACEHOLDER;
  }
  // Nothing parsed as a recognizable cline JSON event at all — fall back to
  // the raw stream so the failure is still visible instead of silently
  // empty or generic (same rationale as extractOpencodeFinalOutput's own
  // final fallback).
  return cleaned;
}

/**
 * Kimi Code CLI's `--output-format stream-json` line shape (verified live
 * against kimi-code 0.29.2): NDJSON where each line is a chat message —
 * `{"role":"assistant","content":"..."}` for model text,
 * `{"role":"assistant","tool_calls":[...]}` and `{"role":"tool",...}` for
 * tool turns, plus a trailing `{"role":"meta","type":"session.resume_hint"}`.
 */
interface KimiEnvelope {
  role?: unknown;
  content?: unknown;
}

/**
 * Kimi's LAST assistant text message is the authoritative final answer.
 *
 * This extractor is why kimi-cli uses `--output-format stream-json` at all.
 * In its plain `text` mode Kimi is an agentic CLI that NARRATES before
 * answering — real captured output began "• The file is large. Let me page
 * through it in chunks." and then indented the answer by two spaces. That is
 * fatal for a V1-migrated action: parseAiResultEnvelopeV1 requires the
 * captured output to START with `<<<ENSEMBLE_AI_RESULT_V1>>>` and rejects any
 * leading bytes, so a genuinely COMPLETED review (a real, correct 7/10 with a
 * valid frame) settled as `malformedResult` purely because of the narration
 * in front of it.
 *
 * In stream-json mode those same narration turns are separate earlier
 * `assistant` lines, so taking the last one yields the frame exactly — live
 * verified: the last assistant `content` both starts with the frame marker
 * and ends with the end marker, with no surrounding text and no indentation.
 *
 * "Last wins" matches extractClineFinalOutput/extractOpencodeFinalOutput's
 * own forward-compatible choice. Intermediate assistant lines carrying
 * `tool_calls` have no string `content` and are skipped by construction.
 */
function extractKimiFinalOutput(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  let sawRecognizedEvent = false;
  let finalText: string | undefined;
  for (const rawEvent of parsed.events) {
    const event = rawEvent as KimiEnvelope;
    if (typeof event.role === "string") {
      sawRecognizedEvent = true;
    }
    if (event.role === "assistant" && typeof event.content === "string") {
      finalText = event.content;
    }
  }

  // Same rationale as extractClineFinalOutput: an explicit empty string is
  // treated as "no text reply", so a legitimate exit-0 tool-only turn still
  // produces a visible placeholder rather than "" (which downstream misreads
  // as "the CLI produced no output" and routes through a generic failure).
  if (finalText !== undefined && finalText.trim().length > 0) {
    return finalText.trim();
  }
  if (sawRecognizedEvent) {
    return KIMI_NO_TEXT_REPLY_PLACEHOLDER;
  }
  // Nothing parsed as a recognizable Kimi message line at all — fall back to
  // the raw stream so a failure stays visible instead of silently empty.
  return cleaned;
}

/**
 * Diagnosable content from Kimi's stream-json stdout — deliberately almost
 * nothing, because Kimi puts its failures somewhere else.
 *
 * Verified live against kimi-code 0.29.2: a failing run reports on STDERR as
 * plain (non-JSON) text — `error: failed to run prompt: config.invalid:
 * Model "k3" is not configured in config.toml.` for a bad model alias, and
 * `error: failed to run prompt: provider.api_error: 400 Invalid request
 * Error` for a rejected thinking effort. Its stdout NDJSON carries no error
 * event kind at all; it is purely the conversation (`assistant`/`tool`/
 * `meta` message lines).
 *
 * So this contributes NO markerScanText from stdout. That is the entire
 * reason it exists: without it, `def.structuredEventStream` being set but
 * unhandled would fall through to scanning `${stderr}\n${stdout}` RAW — and
 * Kimi's `{"role":"tool",...}` lines re-emit the full content of every file
 * it read, exactly the leak class that made an opencode transport drop get
 * misreported as a billing/auth failure (see extractStructuredCliDiagnostics).
 * The caller concatenates stderr itself, so Kimi's real errors are still
 * scanned and still shown; only the file-content-bearing stdout is withheld.
 *
 * `unparsedScanSafeText` is still included: parseJsonLineEvents scopes it to
 * trailing non-JSON output that no message line accounted for, which for
 * Kimi is where a plain-text failure would land if it ever reached stdout.
 */
function extractKimiStructuredDiagnostics(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): StructuredCliDiagnostics {
  const { events, unparsedText, unparsedScanSafeText } = parsed;
  return {
    markerScanText: unparsedScanSafeText,
    detail: unparsedText,
    // Kimi's stream carries no structural retryable signal (same as cline);
    // transient-transport classification stays with applyTransportTransience
    // over the scoped diagnosticText.
    retryable: false,
    sawAnyEvent: events.length > 0,
  };
}

/** Codex's counterpart to CLINE_NO_TEXT_REPLY_PLACEHOLDER — see extractCodexFinalOutput. */
const CODEX_NO_TEXT_REPLY_PLACEHOLDER =
  "(Codex completed the run without returning any text reply.)";

/**
 * Codex's `--json` JSONL line shape (verified live against codex 0.147.0):
 * `{"type":"thread.started","thread_id":...}`, `{"type":"turn.started"}`,
 * `{"type":"item.completed","item":{"id":...,"type":"agent_message","text":...}}`
 * for the model's answer, and `{"type":"turn.completed","usage":{...}}`.
 * Failures instead emit `{"type":"error","message":...}` and
 * `{"type":"turn.failed","error":{"message":...}}`, and non-fatal notices
 * arrive as an `item.completed` whose item `type` is "error".
 */
interface CodexEnvelope {
  type?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  item?: { type?: unknown; text?: unknown; message?: unknown };
}

/**
 * Codex's LAST `agent_message` item is the authoritative final answer.
 *
 * This extractor is why codex-cli passes `--json` at all. Codex's plain
 * stdout is a human-readable transcript: an "OpenAI Codex v0.147.0" banner, a
 * workdir/model header, a `user` section echoing the ENTIRE prompt back, then
 * `codex` and the answer, then a "tokens used" footer. parseAiResultEnvelopeV1
 * requires the captured output to START with `<<<ENSEMBLE_AI_RESULT_V1>>>`, so
 * that shape can never satisfy V1 — the banner alone guarantees
 * `invalidFrame` regardless of how perfectly the model complies. This is the
 * identical failure mode that moved kimi-cli to stream-json (see
 * extractKimiFinalOutput); Codex's version is worse only in that it echoes the
 * prompt, so the frame the model emitted appears TWICE in the raw stream.
 *
 * "Last wins" matches extractKimiFinalOutput/extractClineFinalOutput's
 * forward-compatible choice: a turn that narrates before answering emits each
 * narration as its own earlier `agent_message`, so the last one is the answer.
 * Reasoning and tool items carry a different item `type` and are skipped by
 * construction.
 */
function extractCodexFinalOutput(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  let sawRecognizedEvent = false;
  let finalText: string | undefined;
  for (const rawEvent of parsed.events) {
    const event = rawEvent as CodexEnvelope;
    if (typeof event.type === "string") {
      sawRecognizedEvent = true;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalText = event.item.text;
    }
  }

  // Same rationale as extractKimiFinalOutput: an explicit empty string is
  // treated as "no text reply" so a legitimate exit-0 tool-only turn still
  // produces a visible placeholder rather than "" (which downstream misreads
  // as "the CLI produced no output" and routes through a generic failure).
  if (finalText !== undefined && finalText.trim().length > 0) {
    return finalText.trim();
  }
  if (sawRecognizedEvent) {
    return CODEX_NO_TEXT_REPLY_PLACEHOLDER;
  }
  // Nothing parsed as a recognizable Codex event at all — fall back to the raw
  // stream so a failure stays visible instead of silently empty.
  return cleaned;
}

/**
 * Pull just the diagnosable content out of Codex's `--json` stream: its own
 * `{"type":"error"}` lines, the `turn.failed` error message, and
 * `item.completed` items whose item `type` is "error" — and nothing else.
 *
 * Codex is the case that makes this mandatory rather than merely tidy. Its
 * failures arrive EXCLUSIVELY on stdout as events, with stderr completely
 * empty and exit 1 (verified live: a rejected model produced
 * `{"type":"error","message":"{…\\"message\\":\\"The 'x' model is not
 * supported when using Codex with a ChatGPT account.\\"}"}` plus a matching
 * `turn.failed`, and nothing at all on stderr). That is precisely the opencode
 * 401 situation called out in toFriendlyError: scoping diagnosis to stderr
 * alone would reduce every Codex failure — including auth failures that must
 * gate the backup cascade — to a bare "exit code 1".
 *
 * `agent_message` items are excluded for the standard reason (see
 * extractClineStructuredDiagnostics): they are the model's own free-form prose
 * and can quote file contents back verbatim, so feeding them to the
 * authErrorMarkers scan would diagnose an auth failure on any run that merely
 * read a file mentioning credentials. Before this provider became
 * structured, codex-cli was in toFriendlyError's "opaque-text" bucket where
 * stdout was withheld from the scan entirely for exactly that reason; routing
 * it through this curated extractor is what makes scanning safe AND restores
 * the real error text.
 *
 * A non-flat error payload is re-serialized via JSON.stringify rather than
 * dropped, the same fallback (and justification) as the cline/opencode
 * siblings: an error event never carries file contents, and losing a real
 * failure silently is worse than a noisier message.
 *
 * As with cline, a bare error line is not on its own proof the run failed —
 * the observed "Model metadata … not found. Defaulting to fallback metadata"
 * notice is a warning-shaped `item.completed`. This function is only reached
 * via toFriendlyError, which the caller gates on a non-zero exit or empty
 * output, so that ambiguity is resolved by the caller.
 */
function extractCodexStructuredDiagnostics(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): StructuredCliDiagnostics {
  const { events, unparsedText, unparsedScanSafeText } = parsed;
  const collected: string[] = [];

  for (const rawEvent of events) {
    const event = rawEvent as CodexEnvelope;
    if (event.type === "error") {
      collected.push(
        typeof event.message === "string" ? event.message : JSON.stringify(rawEvent)
      );
      continue;
    }
    if (event.type === "turn.failed") {
      collected.push(
        typeof event.error?.message === "string"
          ? event.error.message
          : JSON.stringify(rawEvent)
      );
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "error") {
      collected.push(
        typeof event.item.message === "string"
          ? event.item.message
          : JSON.stringify(rawEvent)
      );
    }
  }

  const joined = collected.join("\n");
  return {
    markerScanText: [joined, unparsedScanSafeText].filter((part) => part.length > 0).join("\n"),
    detail: [joined, unparsedText].filter((part) => part.length > 0).join("\n"),
    // Codex's stream carries no structural retryable signal (same as cline and
    // kimi); transient-transport classification stays with
    // applyTransportTransience over the scoped diagnosticText.
    retryable: false,
    sawAnyEvent: events.length > 0,
  };
}

/** Claude Code CLI's counterpart to CODEX_NO_TEXT_REPLY_PLACEHOLDER — see extractClaudeCliFinalOutput. */
const CLAUDE_CLI_NO_TEXT_REPLY_PLACEHOLDER =
  "(Claude Code completed the run without returning any text reply.)";

/**
 * Claude Code CLI's `--output-format stream-json` JSONL line shape, per its
 * documented event model: an initial `{"type":"system","subtype":"init",...}`,
 * one `{"type":"assistant","message":{"role":"assistant","content":[{"type":
 * "text","text":...}, ...]}}` per turn of assistant output, and a terminal
 * `{"type":"result","subtype":"success"|"error_...","is_error":boolean,
 * "result":"...","error":"..."}` line. A rate-limited turn is expected to
 * surface as a terminal `result`/`system` event with `is_error: true` and
 * either an `error` field (e.g. `"rate_limit"`) or `result` text describing
 * the limit, structurally mirroring how Codex's `turn.failed`/`error` events
 * carry Codex's own failure text (see extractCodexFinalOutput /
 * extractCodexStructuredDiagnostics just above, whose "last event wins" /
 * "collect only error-shaped events" structure this adapts).
 *
 * NEEDS-TOOLCHAIN: this shape has not been confirmed against a live
 * `claude` CLI invocation (out of scope for this change — see the plan step
 * that introduced it); it is built from the documented event model and from
 * this file's existing structured-stream extractors, the same way
 * extractCodexFinalOutput's shape was derived before its own live
 * verification. Re-verify the exact field names (particularly `error`'s
 * shape/value on a real rate-limited run) the first time a live Claude Code
 * CLI is available, the same way codex's shape above was confirmed against
 * codex 0.147.0.
 */
interface ClaudeCliEnvelope {
  type?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  error?: unknown;
  result?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * Pull the text out of a single stream-json `assistant` event's
 * `message.content` array: only `{"type":"text","text":...}` parts count
 * (tool_use/tool_result parts are skipped by construction, same as Codex's
 * item.type gate above).
 */
function claudeCliAssistantMessageText(event: ClaudeCliEnvelope): string | undefined {
  const content = event.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/**
 * Claude Code CLI's LAST `assistant` message wins — same "last wins" choice
 * as extractCodexFinalOutput/extractKimiFinalOutput/extractClineFinalOutput:
 * a turn that narrates before answering emits each narration as its own
 * earlier `assistant` event, so the last one is the real answer.
 *
 * This is why claude-cli's text mode moves off `--output-format text`: plain
 * text mode has no structural way to tell a rate-limit refusal from an
 * ordinary reply short of scanning prose, unlike every other
 * structuredEventStream provider here — see providers.ts's buildArgs comment
 * for claude-cli.
 */
function extractClaudeCliFinalOutput(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  let sawRecognizedEvent = false;
  let finalText: string | undefined;
  for (const rawEvent of parsed.events) {
    const event = rawEvent as ClaudeCliEnvelope;
    if (typeof event.type === "string") {
      sawRecognizedEvent = true;
    }
    if (event.type !== "assistant") {
      continue;
    }
    const text = claudeCliAssistantMessageText(event);
    if (text !== undefined) {
      finalText = text;
    }
  }

  // Same rationale as extractCodexFinalOutput/extractKimiFinalOutput: an
  // explicit empty string is treated as "no text reply" so a legitimate
  // exit-0 tool-only turn still produces a visible placeholder instead of ""
  // (which downstream misreads as "the CLI produced no output").
  if (finalText !== undefined && finalText.trim().length > 0) {
    return finalText.trim();
  }
  if (sawRecognizedEvent) {
    return CLAUDE_CLI_NO_TEXT_REPLY_PLACEHOLDER;
  }
  // Nothing parsed as a recognizable Claude Code event at all — fall back to
  // the raw stream so a failure stays visible instead of silently empty.
  return cleaned;
}

/**
 * Structural rate-limit vocabulary recognized in a `result`/`system` event's
 * `error` field or `is_error: true` `result` text. Deliberately narrow (an
 * underscored CLI error CODE, not free prose) — this is the structural
 * counterpart to quota.ts's QUOTA_MARKERS phrase list, not a replacement for
 * it; see isQuotaError's structuredSignal parameter.
 */
const CLAUDE_CLI_STRUCTURAL_RATE_LIMIT_MARKERS = ["rate_limit", "usage_limit", "quota_exceeded"];

/**
 * Pull just the diagnosable content out of Claude Code CLI's stream-json
 * stream: an `is_error: true` `result`/`system` event's own `error` field
 * and/or `result` text — and nothing else.
 *
 * Same exclusion every sibling extractor in this file applies: `assistant`
 * message text is the model's own free-form prose (and, mid-conversation,
 * can quote file contents back verbatim), so it is never fed to the
 * authErrorMarkers/quota scan — only consulted for output via
 * extractClaudeCliFinalOutput, never for this diagnostic scan. Before this
 * provider moved to stream-json it was in toFriendlyError's
 * opaque-text/full-stdout-scan bucket; routing it through this curated
 * extractor is what makes scanning safe (see providers.ts's buildArgs
 * comment for the false-positive this closes) while still surfacing the real
 * failure text.
 *
 * quotaSignal is set when the error event's own field matches
 * CLAUDE_CLI_STRUCTURAL_RATE_LIMIT_MARKERS — a structural signal distinct
 * from (and in addition to) the phrase-based scan quota.ts's isQuotaError
 * still runs over `detail`/markerScanText as a fallback.
 *
 * See the NEEDS-TOOLCHAIN note on ClaudeCliEnvelope above: this shape has not
 * been confirmed against a live `claude` CLI run.
 */
function extractClaudeCliStructuredDiagnostics(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): StructuredCliDiagnostics {
  const { events, unparsedText, unparsedScanSafeText } = parsed;
  const collected: string[] = [];
  let quotaSignal = false;

  for (const rawEvent of events) {
    const event = rawEvent as ClaudeCliEnvelope;
    if (event.type !== "result" && event.type !== "system") {
      continue;
    }
    if (event.is_error !== true) {
      continue;
    }
    const errorField = typeof event.error === "string" ? event.error : undefined;
    const resultText = typeof event.result === "string" ? event.result : undefined;
    const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
    const scanCandidates = [errorField, subtype, resultText].filter(
      (part): part is string => Boolean(part)
    );
    if (
      scanCandidates.some((part) =>
        CLAUDE_CLI_STRUCTURAL_RATE_LIMIT_MARKERS.some((marker) =>
          part.toLowerCase().includes(marker)
        )
      )
    ) {
      quotaSignal = true;
    }
    if (scanCandidates.length > 0) {
      collected.push(scanCandidates.join(": "));
    } else {
      collected.push(JSON.stringify(rawEvent));
    }
  }

  const joined = collected.join("\n");
  return {
    markerScanText: [joined, unparsedScanSafeText].filter((part) => part.length > 0).join("\n"),
    detail: [joined, unparsedText].filter((part) => part.length > 0).join("\n"),
    // No general structural retryable signal is documented for Claude Code
    // CLI's stream-json events (same as cline/kimi/codex above);
    // transient-transport classification stays with applyTransportTransience
    // over the scoped diagnosticText. quotaSignal (below) is a narrower,
    // separate structural signal specifically for rate-limit classification.
    retryable: false,
    sawAnyEvent: events.length > 0,
    quotaSignal,
  };
}

/**
 * claude-cli's structured stream is TEXT-MODE ONLY: its buildArgs emits
 * `--output-format stream-json` for text mode but keeps edit mode on plain
 * `--output-format text` (see providers.ts — edit-mode runs are captured for
 * their workspace file changes, not a parsed summary string). The
 * `structuredEventStream: "claude"` tag on the provider definition, however,
 * is mode-blind, and every other carrier of that field emits structured
 * output in ALL modes. Left unscoped, an edit-mode claude failure would be
 * routed through the structured extractors, whose markerScanText includes
 * every non-JSON stdout line — i.e. the model's own free-form prose — and
 * would be scanned by isAuthenticationFailure wholesale, the exact
 * false-positive hazard the opaque-text bucket in toFriendlyError exists to
 * avoid (and a change to edit-mode failure classification, which the plan
 * requires untouched). Strip the tag for claude edit-mode invocations so
 * normalizeCliOutput and toFriendlyError see the same opaque-text provider
 * shape they saw before claude's text mode moved to stream-json. Every other
 * provider (and claude text mode) passes through unchanged.
 */
function effectiveStructuredStreamDefV1(
  def: CliProviderDefinition,
  mode: CliRunMode
): CliProviderDefinition {
  if (def.structuredEventStream === "claude" && mode === "edit") {
    return { ...def, structuredEventStream: undefined };
  }
  return def;
}

/**
 * finishReason values verified LIVE to carry CLI/provider-generated failure
 * text in `run_result.text` rather than the model's own free-form prose —
 * currently only "error" (observed from a rejected model ID). A future
 * cline version may report other non-"completed" reasons (a length cutoff,
 * a cancellation, a tool-loop abort) whose `text` could instead be a
 * genuine PARTIAL MODEL ANSWER — which, like a successful reply, can quote
 * file/tool content back to the user. Only a value in this set is trusted
 * enough to feed the auth-marker scan (markerScanText); any other
 * non-"completed" reason's text still reaches `detail` (shown to the user,
 * never fed to automated auth classification) but is withheld from `scan`.
 * Widen this set only after verifying a new reason's text is genuinely
 * CLI-generated, the same bar CLINE_FAILED_RUN_RESULT_EVENT-style fixtures
 * hold real error text to elsewhere in this file's test suite.
 */
const CLINE_VERIFIED_CLI_TEXT_FINISH_REASONS: ReadonlySet<string> = new Set([
  "error",
]);

/**
 * Pull just the diagnosable content out of Cline's structured `--json`
 * stream: its own top-level `{"type":"error",...}` lines, plus a FAILED
 * run's final `run_result` — and nothing else.
 *
 * The exclusion is exactly opencode's: Cline's tool-call events re-emit full
 * file contents and shell command output verbatim (verified live — a
 * `read_files` tool call's output event carried a planted marker string from
 * the file back out into the stream character-for-character), so scanning
 * the raw stream for authErrorMarkers would diagnose an auth failure on any
 * run that merely happened to read an auth-related file. A SUCCESSFUL run's
 * `run_result.text` is the model's own free-form final answer (which can
 * likewise quote file contents back to the user) and is therefore excluded
 * here too — only consulted for output via extractClineFinalOutput, never
 * for the auth/error scan. `run_result.finishReason` is the first gate: it
 * must be a non-"completed" string for `text` to be considered a failure
 * description at all; CLINE_VERIFIED_CLI_TEXT_FINISH_REASONS is the second,
 * narrower gate on top of that for the scan specifically (see its own doc
 * comment) — `detail` is intentionally less strict than `scan` here, mirroring
 * markerScanText/detail's other asymmetries in this file (e.g. responseBody
 * is scanned but never shown to the user in the opencode sibling above).
 *
 * A recognized error/failed-run_result event whose payload isn't the
 * expected flat-string shape (`message` / `text`) is re-serialized via
 * `JSON.stringify` rather than silently dropped — the same fallback
 * extractStructuredCliDiagnostics uses for opencode's unrecognized error
 * shapes, justified the same way: an error/failure event never carries file
 * contents, so re-serializing it is safe, and dropping a real failure
 * silently (leaving nothing but a bare "exit code N") is worse than a
 * slightly noisier message.
 *
 * A bare `{"type":"error",...}` line is NOT on its own proof the overall run
 * failed: an unrelated "hook dispatch failed: session.hook requires a valid
 * hook event payload" line was observed on otherwise-fully-successful runs
 * (exit code 0) during verification. This function is only ever invoked by
 * toFriendlyError, which the caller (execCliAgent) only reaches when the
 * process already exited non-zero or produced empty output — so that
 * ambiguity is resolved by the caller's own gating, not by this function.
 */
function extractClineStructuredDiagnostics(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout)
): StructuredCliDiagnostics {
  const { events, unparsedText, unparsedScanSafeText } = parsed;
  const scan: string[] = [];
  const details: string[] = [];
  const sawAnyEvent = events.length > 0;

  for (const rawEvent of events) {
    const event = rawEvent as ClineEnvelope;
    if (event.type === "error") {
      if (typeof event.message === "string") {
        scan.push(event.message);
        details.push(event.message);
      } else {
        const line = JSON.stringify(rawEvent);
        scan.push(line);
        details.push(line);
      }
      continue;
    }
    if (
      event.type === "run_result" &&
      typeof event.finishReason === "string" &&
      event.finishReason !== "completed"
    ) {
      const trustedForScan = CLINE_VERIFIED_CLI_TEXT_FINISH_REASONS.has(
        event.finishReason
      );
      if (typeof event.text === "string") {
        details.push(event.text);
        if (trustedForScan) {
          scan.push(event.text);
        }
      } else {
        const line = JSON.stringify(rawEvent);
        details.push(line);
        if (trustedForScan) {
          scan.push(line);
        }
      }
    }
  }

  return {
    markerScanText: [scan.join("\n"), unparsedScanSafeText].filter(Boolean).join("\n"),
    detail: details.join("\n") || unparsedText,
    // No structural retryable signal has been observed in cline's stream
    // (unlike opencode's error.data.isRetryable) — leave false always and
    // rely on applyTransportTransience's text-based isTransportError check
    // against diagnosticText, which is safe here for the same reason it's
    // safe for opencode: diagnosticText is scoped to error events / a
    // failed run's own text, never raw stdout.
    retryable: false,
    sawAnyEvent,
  };
}

function extractOpencodeFinalOutput(
  stdout: string,
  parsed: ParsedCliEventLines = parseJsonLineEvents(stdout),
  /**
   * When true (the V1 `createCliTextTransportV1` path, whose reply is parsed
   * by `parseAiResultEnvelopeV1`), keep only the text part that actually
   * carries the frame — scanning from the end, so a model that keeps talking
   * after the frame ("Done.", or even an empty trailing text event) does not
   * make the LAST part win over the one that matters. Falls back to the
   * true last part when no part contains the frame at all (the coordinator's
   * frameless-content fallback already handles that shape from there).
   * 2026-08-07 live incidents: concatenating narration ahead of a final
   * framed answer ("I'll check X" ... tool call ... the actual frame) fed the
   * parser text whose frame — if the model attempted one at all — was buried
   * mid-response rather than isolated. `parseAiResultEnvelopeV1` also scans
   * for the frame rather than requiring it at byte zero (belt and braces —
   * this fix and that one are independently useful), but not concatenating
   * narration in the first place keeps the captured text itself close to
   * just the model's real answer. Legacy free-text callers (default false)
   * keep the full concatenated reply unchanged — nothing there depends on
   * frame position, and reconstructing the complete multi-part reply is the
   * correct behavior for them.
   */
  requiresFramedResult = false
): string {
  const cleaned = stripAnsi(stdout).trim();
  if (cleaned.length === 0) {
    return cleaned;
  }

  const textParts: string[] = [];
  let sawRecognizedEvent = false;
  for (const rawEvent of parsed.events) {
    const event = rawEvent as {
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
    if (requiresFramedResult) {
      for (let i = textParts.length - 1; i >= 0; i--) {
        if (textParts[i]!.includes(FRAME_START_V1)) {
          return textParts[i]!.trim();
        }
      }
      return textParts[textParts.length - 1]!.trim();
    }
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
  parsed?: ParsedCliEventLines,
  /** Forwarded to extractOpencodeFinalOutput — see its own doc comment. False (the legacy default) for every caller except createCliTextTransportV1's V1 path. */
  requiresFramedResult = false
): string {
  // The answer is always derived from stdout: the last-message-file read
  // branch was removed on 2026-08-14 with the rest of the temp-file plumbing
  // (see the usesLastMessageFile declaration comment in providers.ts), so a
  // caller's already-produced `parsed` stream is always valid to reuse here.
  const output = stripAnsi(stdout).trim();

  if (def.id === "kiro-cli") {
    return extractKiroFinalOutput(output);
  }

  if (def.structuredEventStream === "opencode") {
    // Keyed off the tag, not the literal provider ID: devpass-cli is a
    // rebrand/fork of OpenCode emitting the byte-for-byte same --format
    // json event-stream shape (verified live), so it shares this same
    // extractor rather than needing its own. Passing `parsed` even when
    // undefined is fine: extractOpencodeFinalOutput's own default parameter
    // already parses internally in that case — an explicit undefined
    // argument triggers a default the same as omitting it.
    return extractOpencodeFinalOutput(output, parsed, requiresFramedResult);
  }

  if (def.id === "cline-cli") {
    return extractClineFinalOutput(output, parsed);
  }

  if (def.id === "kimi-cli") {
    return extractKimiFinalOutput(output, parsed);
  }

  if (def.structuredEventStream === "codex") {
    // Keyed off the tag rather than the id purely for symmetry with the
    // opencode branch; codex-cli is currently its only carrier.
    return extractCodexFinalOutput(output, parsed);
  }

  if (def.structuredEventStream === "claude") {
    return extractClaudeCliFinalOutput(output, parsed);
  }

  return output;
}

/**
 * True when this provider can satisfy the V1 text-mode capture contract:
 * its final answer arrives on stdout (AC-RUNNER-02: "CLI results are
 * captured only from bounded stdout"). A provider that writes its final
 * message to a last-message temp file cannot satisfy V1 yet — plan §3.4:
 * such a runner does not silently disappear, it returns
 * `providerModeUnavailable` at selection time (`openV1RunnerSelection` in
 * runnerRegistry.ts) until it implements stdout framing.
 */
export function cliProviderSupportsV1StdoutCapture(def: CliProviderDefinition): boolean {
  return !def.usesLastMessageFile;
}

/**
 * At most this many raw stdout bytes are buffered while unwrapping a
 * structured (JSON-lines) CLI event stream into its final text. The bound
 * exists because opencode's/cline's streams re-emit the full text of every
 * file the agent reads, so a legitimate run's raw stream can be far larger
 * than its final framed result — but it must still be finite before the
 * extraction pass runs. Exceeding it kills the process and fails the
 * transport; nothing is ever written to the result writer.
 */
export const MAX_CLI_STRUCTURED_EVENT_STREAM_BYTES_V1 = 64 * 1024 * 1024;

/**
 * V1 transport (plan §3.2/§3.4) for a vendor CLI's read-only text mode:
 * spawns the CLI exactly like the legacy path (same argument builder,
 * sanitized environment, shell quoting, kill-tree cancellation, and run
 * timeout), captures the framed result from bounded stdout only, and reports
 * how the process exited. It receives no artifact or result path
 * (AC-RUNNER-01), and stderr participates solely in the capture layer's
 * sanitized size/digest summary.
 *
 * Two stdout shapes are supported (AC-RUNNER-02 — the result is captured
 * only from bounded stdout in both):
 *  - opaque-text CLIs (no `structuredEventStream`): stdout IS the model's
 *    final answer, so bytes stream straight into the broker-owned bounded
 *    writer as they arrive;
 *  - structured-event CLIs (opencode's `--format json`, cline's `--json`):
 *    stdout is a JSON-lines event stream that WRAPS the model's final text
 *    in event objects (and re-emits file contents in tool events), so
 *    forwarding it raw could never parse as a framed V1 result. The raw
 *    stream is buffered (bounded by
 *    `MAX_CLI_STRUCTURED_EVENT_STREAM_BYTES_V1`), and on a successful exit
 *    the provider's own final-text extractor (`normalizeCliOutput` — the
 *    same one the legacy path uses) unwraps the model's reply, which is then
 *    written to the bounded writer as the single captured payload. A framed
 *    result the model emitted inside its reply therefore reaches the broker
 *    as directly parseable framed bytes.
 *
 * Selection happens in `runnerRegistry.ts`; constructing this transport is
 * not an invocation.
 */
export function createCliTextTransportV1(options: {
  def: CliProviderDefinition;
  /** Provider-native (unqualified) model id; undefined runs the CLI default. */
  model: string | undefined;
  /**
   * Working directory for the CLI process (the workspace root). This is
   * transport configuration fixed at construction by the registry — the V1
   * request itself never carries a filesystem path.
   */
  cwd: string;
  /**
   * Test seam: overrides `MAX_CLI_STRUCTURED_EVENT_STREAM_BYTES_V1` so the
   * raw-stream bound is exercisable without emitting 64 MiB. Production
   * callers (the registry) never set it.
   */
  maxEventStreamBytes?: number;
}): AgentTransportV1 {
  const { def, model, cwd } = options;
  const maxEventStreamBytes =
    options.maxEventStreamBytes ?? MAX_CLI_STRUCTURED_EVENT_STREAM_BYTES_V1;
  return {
    runnerId: def.id,
    invoke(
      request: AgentExecutionRequestV1,
      output: BoundedResultWriterV1
    ): Promise<AgentTransportExitV1> {
      if (request.mode !== "text") {
        // General-workspace CLI processes are unsupported for preflight and
        // edit execution (plan product decisions); the registry never
        // reserves them for those modes, so this is a defensive backstop.
        return Promise.resolve({
          kind: "transportFailure",
          code: "cliModeUnsupported",
          detail: `${def.label} has no general-workspace CLI path for mode "${request.mode}" (text only)`,
        });
      }
      if (!cliProviderSupportsV1StdoutCapture(def)) {
        return Promise.resolve({
          kind: "transportFailure",
          code: "cliStdoutCaptureUnsupported",
          detail: `${def.label} reports its final answer through a last-message file, not bounded stdout`,
        });
      }

      const promptTransport = def.promptTransport ?? "stdin";
      const useShell = def.useShell ?? true;
      if ((promptTransport === "file" || promptTransport === "argv") && useShell) {
        return Promise.resolve({
          kind: "transportFailure",
          code: "cliPromptTransportMisconfigured",
          detail: `${def.label} declares promptTransport "${promptTransport}" with useShell=true; that combination cannot pass a prompt safely`,
        });
      }

      let promptFile: string | undefined;
      if (promptTransport === "file") {
        promptFile = nodePath.join(
          os.tmpdir(),
          `vs-code-ai-helper-${def.id}-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
        );
        try {
          // mode 0o600 for the same reason as the legacy path: prompts can
          // embed full context packs on a world-readable shared tmpdir.
          nodeFs.writeFileSync(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          const detail = boundedTransportDetailV1(error);
          return Promise.resolve({
            kind: "transportFailure",
            code: "cliPromptFileWriteFailed",
            ...(detail !== undefined ? { detail } : {}),
          });
        }
      }
      const cleanupPromptFile = (): void => {
        if (promptFile) {
          try {
            nodeFs.unlinkSync(promptFile);
          } catch {
            // Best-effort cleanup.
          }
        }
      };

      let args: string[];
      try {
        // V1 results are captured from stdout only (AC-RUNNER-02) — the
        // last-message-file parameter no longer exists.
        // requiresFramedResult: this transport's reply is parsed by
        // parseAiResultEnvelopeV1, so a `promptTransport: "file"` provider
        // restates the frame contract in argv rather than relying solely on
        // it being stated deep inside the prompt file (see that context
        // field's own doc comment for the live run this fixes). The legacy
        // path deliberately does NOT set it — legacy replies are free text.
        args = def.buildArgs("text", model, {
          cwd,
          promptFile,
          requiresFramedResult: true,
        });
      } catch (error) {
        cleanupPromptFile();
        const detail = boundedTransportDetailV1(error);
        return Promise.resolve({
          kind: "transportFailure",
          code: "cliArgumentBuildFailed",
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      if (promptTransport === "argv") {
        const argvLimit = checkArgvPromptSizeLimitV1(def, request.prompt);
        if (argvLimit.exceeds) {
          // The checker already produced the measured-vs-limit sentence;
          // discarding it here was what made this code unactionable.
          const detail = boundedTransportDetailV1(argvLimit.errorMessage);
          return Promise.resolve({
            kind: "transportFailure",
            code: "cliPromptTooLarge",
            ...(detail !== undefined ? { detail } : {}),
          });
        }
        args.push(request.prompt);
      }

      return (async (): Promise<AgentTransportExitV1> => {
        const resolvedCommand = await resolveCliCommand(def.command, def.commandAliases);
        if (!resolvedCommand) {
          cleanupPromptFile();
          const tried = [def.command, ...(def.commandAliases ?? [])].join(", ");
          return {
            kind: "transportFailure",
            code: "cliNotInstalled",
            detail: `not found on PATH (tried: ${tried})`,
          };
        }

        return new Promise<AgentTransportExitV1>((resolve) => {
          let settled = false;
          let cancelled = false;
          const capture = createCliStdoutResultCaptureV1(output);
          // Structured-event CLIs buffer raw stdout for post-exit extraction
          // (see the function doc comment); opaque-text CLIs stream directly.
          const structuredStream = def.structuredEventStream !== undefined;
          const rawEventChunks: Buffer[] = [];
          let rawEventBytes = 0;
          // Part 7: last time ANY raw byte arrived on stdout or stderr. Keyed
          // off raw chunk arrival rather than onProgress/capture callbacks,
          // since structured providers buffer everything until close and
          // never call onProgress mid-run — this transport has no other
          // activity signal.
          let lastActivityAt = Date.now();

          // Same shell-quoting rule as execCliAgent: with shell:true Node
          // joins argv with plain spaces, so multi-word values must be
          // quoted on both platforms.
          const spawnArgs = useShell
            ? args.map((a) =>
                process.platform === "win32"
                  ? a.includes(" ")
                    ? `"${a}"`
                    : a
                  : quotePosixShellArg(a)
              )
            : args;
          let child: cp.ChildProcess;
          try {
            child = cp.spawn(resolvedCommand, spawnArgs, {
              cwd,
              shell: useShell,
              windowsHide: true,
              // buildEnv is merged OVER sanitizedCliEnv(), never the other
              // way — a provider's own env additions (e.g. Kimi's
              // KIMI_MODEL_THINKING_EFFORT) can only add variables, not
              // weaken the sanitized base.
              env: { ...sanitizedCliEnv(), ...def.buildEnv?.(model) },
              detached: process.platform !== "win32",
            });
          } catch (error) {
            cleanupPromptFile();
            const detail = boundedTransportDetailV1(error);
            resolve({
              kind: "transportFailure",
              code: "cliSpawnFailed",
              ...(detail !== undefined ? { detail } : {}),
            });
            return;
          }

          const finish = (exit: AgentTransportExitV1): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            if (inactivityCheckHandle) {
              clearInterval(inactivityCheckHandle);
            }
            cancellationListener.dispose();
            cleanupPromptFile();
            resolve(exit);
          };

          const timeoutHandle = setTimeout(() => {
            killProcessTree(child);
            // stderr CONTENT is deliberately never retained (§2.2 — see
            // cliStdoutResultCaptureV1); the byte counts are the sanitized
            // summary its own doc marks safe to log, and they answer the
            // first question about any timeout: was the process saying
            // anything, or silently wedged?
            const stderr = capture.stderrSummary();
            finish({
              kind: "transportFailure",
              code: "cliRunTimeout",
              detail:
                `no exit after ${Math.round(RUN_TIMEOUT_MS / 60_000)}m wall clock; ` +
                `stderr ${stderr.totalByteLength} byte(s)`,
            });
          }, RUN_TIMEOUT_MS);

          // Part 7 inactivity watchdog: mirrors execCliAgent's — kills a
          // process producing zero bytes long before the flat wall-clock cap,
          // with a distinct transportFailure code ("cliRunInactivityTimeout")
          // so the caller (and the run record) can tell a wedged process
          // apart from a genuinely long-running one. 0 disables it.
          const inactivityLimitMinutes = getResilienceSettings().inactivityTimeoutMinutes;
          const inactivityLimitMs = inactivityLimitMinutes * 60_000;
          const inactivityCheckHandle =
            inactivityLimitMinutes > 0
              ? setInterval(() => {
                  if (settled) {
                    return;
                  }
                  if (Date.now() - lastActivityAt >= inactivityLimitMs) {
                    killProcessTree(child);
                    const stderr = capture.stderrSummary();
                    finish({
                      kind: "transportFailure",
                      code: "cliRunInactivityTimeout",
                      detail:
                        `no output for ${inactivityLimitMinutes}m ` +
                        `(ensemble.resilience.inactivityTimeoutMinutes); ` +
                        `stderr ${stderr.totalByteLength} byte(s)`,
                    });
                  }
                }, 15_000)
              : undefined;

          const cancellationListener = request.cancellationToken.onCancellationRequested(() => {
            cancelled = true;
            killProcessTree(child);
            finish({ kind: "callerCancelled" });
          });

          child.on("error", (error) => {
            // Was a bare arrow discarding the error: a spawn/runtime fault
            // (ENOENT, EACCES, EPIPE) reached the user as a bare code with
            // no way to tell which.
            const detail = boundedTransportDetailV1(error);
            finish({
              kind: "transportFailure",
              code: "cliSpawnFailed",
              ...(detail !== undefined ? { detail } : {}),
            });
          });

          child.stdout?.on("data", (chunk: Buffer) => {
            lastActivityAt = Date.now();
            if (!structuredStream) {
              capture.handleStdout(chunk);
              return;
            }
            if (settled) {
              return;
            }
            rawEventBytes += chunk.length;
            if (rawEventBytes > maxEventStreamBytes) {
              // The raw event stream is unboundedly large — discard it and
              // fail without writing anything: no bytes ever reached the
              // result writer, so this stays a pre-response failure.
              rawEventChunks.length = 0;
              killProcessTree(child);
              finish({
                kind: "transportFailure",
                code: "cliEventStreamTooLarge",
                detail: `structured event stream exceeded ${maxEventStreamBytes} bytes (read ${rawEventBytes})`,
              });
              return;
            }
            rawEventChunks.push(Buffer.from(chunk));
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            lastActivityAt = Date.now();
            capture.handleStderr(chunk);
          });

          child.on("close", (code) => {
            if (cancelled) {
              finish({ kind: "callerCancelled" });
              return;
            }
            if (code === 0) {
              if (structuredStream && !settled) {
                // Unwrap the model's final text from the event stream with
                // the provider's own extractor and write it as the single
                // captured payload — a framed result the model emitted
                // arrives at the broker as directly parseable framed bytes.
                // requiresFramedResult: true (2026-08-07) — this reply is
                // parsed by parseAiResultEnvelopeV1, so opencode/devpass-cli
                // keep only the model's LAST text part instead of
                // concatenating narration ahead of the frame; see
                // extractOpencodeFinalOutput's own doc comment.
                const rawStdout = Buffer.concat(rawEventChunks).toString("utf8");
                rawEventChunks.length = 0;
                capture.handleStdout(normalizeCliOutput(def, rawStdout, undefined, true));
              }
              finish({ kind: "completed" });
              return;
            }
            // A structured-event CLI's failed run wrote nothing to the result
            // writer (its final text only materializes on exit 0), so the
            // broker correctly reports this as a pre-response failure.
            rawEventChunks.length = 0;
            // Sanitized stderr accounting only (never its text): "exited 1,
            // stderr 0 bytes" and "exited 1, stderr 4KB" are completely
            // different failures and were previously indistinguishable.
            const stderr = capture.stderrSummary();
            finish({
              kind: "transportFailure",
              code: `cliExit.${String(code)}`,
              detail:
                `${def.label} exited ${String(code)}; stderr ${stderr.totalByteLength} byte(s)` +
                `${stderr.truncated ? " (truncated)" : ""}`,
            });
          });

          if (promptTransport === "stdin") {
            child.stdin?.on("error", () => {
              // Ignore EPIPE when the process exits before consuming the
              // prompt; the close handler reports the real failure.
            });
            child.stdin?.write(request.prompt);
          }
          child.stdin?.end();
        });
      })();
    },
  };
}

export const __testOnly = {
  stripAnsi,
  quotePosixShellArg,
  extractKiroFinalOutput,
  extractOpencodeFinalOutput,
  extractStructuredCliDiagnostics,
  extractClineFinalOutput,
  extractClineStructuredDiagnostics,
  extractKimiFinalOutput,
  extractKimiStructuredDiagnostics,
  extractCodexFinalOutput,
  extractCodexStructuredDiagnostics,
  extractClaudeCliFinalOutput,
  extractClaudeCliStructuredDiagnostics,
  effectiveStructuredStreamDefV1,
  isTextModeGuaranteedReadOnly,
  parseJsonLineEvents,
  unwrapJsonString,
  applyTransportTransience,
  normalizeCliOutput,
  toCliImplementationRunResult,
  sanitizedCliEnv,
  toFriendlyError,
  truncateCliDetail,
  stripHookLifecycleNoiseV1,
  stripKnownBenignCliNoiseV1,
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
function truncateCliDetail(text: string, maxLines = 8, maxChars = 4000): string {
  const lines = text.trim().split(/\r?\n/);
  let byLines: string;
  if (lines.length <= maxLines) {
    byLines = lines.join("\n").trim();
  } else {
    const head = lines[0]!;
    const tail = lines.slice(-(maxLines - 1));
    byLines = (tail.includes(head) ? tail : [head, ...tail]).join("\n").trim();
  }
  if (byLines.length <= maxChars) {
    return byLines;
  }
  // The line-count bound above assumes each line is reasonably short —
  // wrong for a single massive line (e.g. a JSON.stringify fallback for an
  // unrecognized error shape, which can be hundreds of KB on one line and
  // still satisfy "8 lines or fewer"). That is exactly the "megabytes of
  // leaked content in a user-facing error" failure mode the structured
  // scan was built to prevent, just via a different route. Keep a prefix
  // and a suffix rather than truncating from one end only, mirroring the
  // head+tail reasoning above at the character level.
  // slice(-0) is equivalent to slice(0) — the whole string — not an empty
  // one, since JS integer-conversion discards the sign of a negative-zero
  // start index. A non-positive maxChars would otherwise make tailChars the
  // ENTIRE string, so the "truncated" result comes out longer than the
  // input. Guarding halfChars > 0 keeps this bounded for any maxChars.
  const halfChars = Math.floor(maxChars / 2);
  const headChars = byLines.slice(0, maxChars - halfChars);
  const tailChars = halfChars > 0 ? byLines.slice(-halfChars) : "";
  return `${headChars}\n… [truncated] …\n${tailChars}`;
}

/**
 * Convert raw CLI failure output into a user-facing error, surfacing the
 * provider's login hint when the output looks like an auth problem.
 *
 * Returns a struct rather than a string for two reasons:
 *  1. The auth verdict used to be a local boolean collapsed into prose and
 *     discarded. Downstream then re-derived it by regexing the returned
 *     message — which by that point contained the login hint this function had
 *     just appended ("...paste the OpenCode API key."), and that hint matches
 *     the regex. Any error that tripped a false positive was therefore
 *     guaranteed to be re-confirmed as an auth failure by our own hint text.
 *  2. Structured-stream providers can report retryability directly, and that
 *     signal has no string representation worth matching.
 */
/**
 * Matches a line reporting a Claude Code (or similar) lifecycle hook's own
 * outcome — e.g. `SessionEnd hook [...] failed: Hook cancelled` — rather than
 * the underlying failure that triggered the abrupt teardown. A user-installed
 * hook (this codebase's own Codex plugin included) can be cancelled mid-run
 * when the CLI process dies for an unrelated reason (a 429, an OOM, a crash),
 * and its complaint reaching stderr/stdout is collateral damage, not the
 * cause. See src/utils/quota.ts's isQuotaError comment for the incident this
 * guards: a rate-limit synthetic message ("Run /usage-credits to continue")
 * was displaced by a "Hook cancelled" line that matched none of the quota
 * markers, so the real cause was never classified.
 */
const HOOK_LIFECYCLE_LINE_PATTERN_V1 =
  /\b(?:SessionStart|SessionEnd|Stop|SubagentStop|PreCompact|UserPromptSubmit|PreToolUse|PostToolUse|Notification)\s+hook\b|\bhook\s+cancelled\b/i;

/**
 * Drops hook-lifecycle lines from `text` so they never crowd out other
 * diagnostic content in a truncated (head+tail) excerpt. Only strips when
 * something else survives — if hook noise is the ENTIRE text, it is returned
 * unchanged so it still surfaces rather than being reported as "no output".
 */
function stripHookLifecycleNoiseV1(text: string): string {
  if (!text) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !HOOK_LIFECYCLE_LINE_PATTERN_V1.test(line));
  const remainder = filtered.join("\n").trim();
  return remainder.length > 0 ? filtered.join("\n") : text;
}

/**
 * Part 6: CLI error lines that are known to be benign noise, never proof of
 * an actual failure — observed appearing on fully-successful (exit 0) runs
 * as well as failed ones. When one of these is the ONLY diagnosable content
 * on a failed run, presenting it verbatim as "the" failure cause is a red
 * herring: it sends the user chasing a known non-problem while the real
 * cause (hang, crash, timeout) leaves no trace. Matched by regex against a
 * single line (or a whole re-serialized JSON line, which still contains the
 * phrase as a substring) so both the structured-event path and the raw
 * unparsed/JSON-leak fallback path are covered by the same list.
 */
const KNOWN_BENIGN_CLI_ERROR_SIGNATURES_V1: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly hint: string;
}> = [
  {
    pattern: /hook dispatch failed: session\.hook requires a valid hook event payload/i,
    hint:
      "a known Cline shutdown-race artifact (cline/cline#11821), often cleared by " +
      "`cline doctor fix` or restarting the local hub daemon",
  },
];

/**
 * Strips lines matching a known-benign signature out of `text`. Returns the
 * remaining (real) content, plus the first matched signature's hint IFF
 * every line was noise — i.e. nothing real survived the filter. When real
 * content coexists with noise, the hint is omitted and only the real
 * content is returned, per the "surface the real content" rule.
 */
function stripKnownBenignCliNoiseV1(text: string): { filtered: string; hint?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { filtered: text };
  }
  const lines = trimmed.split(/\r?\n/);
  const realLines: string[] = [];
  let matchedHint: string | undefined;
  for (const line of lines) {
    const signature = KNOWN_BENIGN_CLI_ERROR_SIGNATURES_V1.find(({ pattern }) => pattern.test(line));
    if (signature) {
      matchedHint = matchedHint ?? signature.hint;
      continue;
    }
    realLines.push(line);
  }
  if (realLines.length === 0 && matchedHint) {
    return { filtered: "", hint: matchedHint };
  }
  return { filtered: realLines.join("\n") };
}

function toFriendlyError(
  def: CliProviderDefinition,
  model: string | undefined,
  exitCode: number | null,
  rawStderr: string,
  rawStdout: string,
  parsed?: ParsedCliEventLines,
  /**
   * Replaces the computed "CLI failed: <detail>" text wholesale (e.g. the
   * "CLI produced no output" case has its own wording) while still running
   * the auth scan and hint-append below against the real stderr/stdout —
   * letting a caller with different wording reuse this function fully
   * instead of hand-rebuilding a CliFriendlyError from its own pieces.
   */
  diagnosticTextOverride?: string
): CliFriendlyError {
  // Rank hook-lifecycle text below any other diagnostic content present, so a
  // cancelled SessionEnd/Stop hook is never adopted as the sole errorMessage
  // while genuine failure content (a rate-limit line, a traceback, ...) also
  // exists. Falls back to the raw text when hook noise is all there is.
  const stderr = stripHookLifecycleNoiseV1(rawStderr);
  const stdout = stripHookLifecycleNoiseV1(rawStdout);
  // Structured-stream providers are diagnosed from stderr plus the stream's own
  // "error" events (plus any trailing unparsed text — see
  // extractStructuredCliDiagnostics) only. stderr is still concatenated even
  // though it is empirically always empty for opencode — costless today,
  // correct if a future version starts using it. Scoping to stderr ALONE
  // would be a total regression: a genuine opencode 401 arrives exclusively
  // as a stdout event. Passing `parsed` even when undefined is fine:
  // extractStructuredCliDiagnostics's own default parameter already parses
  // internally in that case.
  const structured =
    def.structuredEventStream === "opencode"
      ? extractStructuredCliDiagnostics(stdout, parsed)
      : def.structuredEventStream === "cline"
        ? extractClineStructuredDiagnostics(stdout, parsed)
        : def.structuredEventStream === "kimi"
          ? extractKimiStructuredDiagnostics(stdout, parsed)
          : def.structuredEventStream === "codex"
            ? extractCodexStructuredDiagnostics(stdout, parsed)
            : def.structuredEventStream === "claude"
              ? extractClaudeCliStructuredDiagnostics(stdout, parsed)
              : undefined;

  const scanSource = structured
    ? `${stderr}\n${structured.markerScanText}`
    : `${stderr}\n${stdout}`;
  const combined = scanSource.toLowerCase();
  // The provider's own marker list is necessarily narrow (opencode has no
  // "403"/"forbidden" entry, for instance). isAuthenticationFailure's broader
  // regex is ALSO checked, but the text it scans depends on the provider
  // shape: for structured providers (which now includes codex-cli — it moved
  // out of the opaque-text bucket below when it adopted `--json`, precisely
  // because its failures live only on stdout), the full scanSource — markerScanText is
  // curated by extractStructuredCliDiagnostics to exclude tool/text-event
  // content (safely including fields like responseBody that are deliberately
  // excluded from `detail` below), so an auth signal living only in a field
  // the provider's own markers don't cover is still caught. For opaque-text
  // providers (kiro-cli), stdout is the model's own generated
  // output — arbitrary prose or echoed file content that happens to mention
  // "403"/"credentials"/"authenticate" would false-positive the whole run as
  // an auth failure if scanned, which hard-blocks the backup cascade
  // (runnerRegistry.ts checks authFailure before ever trying a fallback
  // model). stderr, by contrast, is conventionally the CLI tool's OWN
  // diagnostic channel (process/network/permission errors it reports about
  // itself), not a place the model narrates or echoes file content — so it
  // is safe to scan even for opaque providers, and is what still catches a
  // marker-list gap like a bare "403 Forbidden" in stderr.
  // Checked first: a model-entitlement refusal (the credential is valid, the
  // account simply lacks access to THIS model id — e.g. Bedrock's "...is not
  // available for this account") often also carries "403"/"forbidden"
  // wording that def.authErrorMarkers or the broad regex below would
  // otherwise read as auth. A re-login hint can never fix an entitlement
  // block, so it must never classify as authFailure regardless of which
  // provider-specific marker matches.
  const entitlementFailure = isModelEntitlementFailure(structured ? scanSource : stderr);
  const authFailure =
    !entitlementFailure &&
    (def.authErrorMarkers.some((marker) => combined.includes(marker)) ||
      isAuthenticationFailure(structured ? scanSource : stderr));

  // Fallback order for structured providers: parsed error-event text (which
  // already folds in trailing unparsed content — see
  // extractStructuredCliDiagnostics), then stderr, then a bare exit code. A
  // stream that DID fully parse as recognized events is never dumped raw;
  // dumping it is what leaked file contents and thousands of characters of
  // tool-call JSON into user-facing errors in the first place.
  // Part 6: filter known-benign noise (e.g. Cline's session.hook dispatch
  // line) out of every candidate diagnostic source before it can become the
  // presented cause. When filtering leaves nothing real anywhere, fall back
  // to an honest "exit code N / no diagnostic output" plus whichever
  // signature's remediation hint matched, instead of the raw noise line.
  const filteredStructuredDetail = structured
    ? stripKnownBenignCliNoiseV1(structured.detail)
    : undefined;
  const filteredStderr = stripKnownBenignCliNoiseV1(stderr);
  const filteredStdout = stripKnownBenignCliNoiseV1(stdout);
  const realDiagnosticContent = structured
    ? truncateCliDetail(filteredStructuredDetail!.filtered) ||
      truncateCliDetail(filteredStderr.filtered)
    : truncateCliDetail(filteredStderr.filtered) || truncateCliDetail(filteredStdout.filtered);
  const benignNoiseHint =
    filteredStructuredDetail?.hint ?? filteredStderr.hint ?? filteredStdout.hint;
  const diagnosticText =
    diagnosticTextOverride ??
    `${cliDisplayLabel(def)} CLI failed: ${
      realDiagnosticContent ||
      (benignNoiseHint
        ? `exit code ${exitCode ?? "unknown"} / no diagnostic output (${benignNoiseHint})`
        : `exit code ${exitCode ?? "unknown"}`)
    }`;
  // No re-login hint for an entitlement block — the credential already
  // works. Advise switching the stage's model instead; the provider's own
  // "explore other available models" text (when present) already lives in
  // diagnosticText above and is kept, not replaced.
  const authSuffix = authFailure
    ? ` ${def.loginHintForModel?.(model) ?? def.loginHint}`
    : entitlementFailure
      ? " Switch this stage's model to one your account has access to, then try again."
      : "";
  return {
    message: `${diagnosticText}${authSuffix}`,
    authFailure,
    diagnosticText,
    retryableHint: structured?.retryable === true,
    quotaSignal: structured?.quotaSignal === true,
  };
}

/**
 * (2j) Whether `prompt` would be rejected outright by `def`'s own argv-only
 * transport ceiling — a structural per-provider limit (verified before this
 * fix cost 5/5 dispatches to Kimi's now-retired argv transport: 118,611
 * bytes against a 20,000-byte cap, every single time), not a transient
 * condition retrying could ever clear. Pure and provider-agnostic so it can
 * gate dispatch BEFORE any CLI process, retry-loop attempt, or audit-log
 * entry is spent — see the pre-dispatch calls in CliAgentRunner.run and
 * runImplementationWithCli below, which use this to skip the provider
 * entirely rather than let execCliAgent's own (still-present, defense in
 * depth) check burn a doomed attempt first.
 */
export function checkArgvPromptSizeLimitV1(
  def: CliProviderDefinition,
  prompt: string
): { exceeds: false } | { exceeds: true; errorMessage: string } {
  const maxArgvPromptBytes = def.maxArgvPromptBytes;
  if ((def.promptTransport ?? "stdin") !== "argv" || typeof maxArgvPromptBytes !== "number") {
    return { exceeds: false };
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes <= maxArgvPromptBytes) {
    return { exceeds: false };
  }
  return {
    exceeds: true,
    errorMessage:
      `${def.label} prompt is too large for this CLI mode (${promptBytes} bytes; max ${maxArgvPromptBytes} bytes). ` +
      "Reduce context or choose a provider that accepts stdin prompts.",
  };
}

/**
 * Run a provider CLI once: prompt in via stdin, answer out via stdout.
 * Cancellation kills the process tree.
 */
export async function execCliAgent(options: {
  def: CliProviderDefinition;
  mode: CliRunMode;
  model: string | undefined;
  prompt: string;
  cwd: string;
  token: vscode.CancellationToken;
  onProgress?: (message: string) => void;
  /** Continue the provider conversation persisted by the previous attempt. */
  resumePreviousConversation?: boolean;
  /** The exact session to continue — see CliBuildArgsContext.resumeSessionId. */
  resumeSessionId?: string;
}): Promise<CliExecResult> {
  const {
    def,
    mode,
    model,
    prompt,
    cwd,
    token,
    onProgress,
    resumePreviousConversation,
    resumeSessionId,
  } = options;

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
    args = def.buildArgs(mode, model, {
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      cwd,
      promptFile,
      resumePreviousConversation,
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
    const sizeCheck = checkArgvPromptSizeLimitV1(def, prompt);
    if (sizeCheck.exceeds) {
      return classifyCliFailure({
        status: "failed",
        output: "",
        errorMessage: sizeCheck.errorMessage,
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
    // Part 7: last time ANY stdout/stderr byte arrived, used by the
    // inactivity watchdog below. Seeded to spawn time so a process that
    // never produces a single byte still gets caught.
    let lastActivityAt = Date.now();

    // shell:true is the default so Windows resolves .cmd/.ps1 shims from
    // npm/pnpm global installs. With shell:true, Node's own spawn joins
    // `[command, ...args]` with plain spaces and hands that whole string to
    // the shell (`cmd.exe /c "..."` on Windows, `/bin/sh -c "..."` on POSIX)
    // WITHOUT escaping any argv element itself (Node emits its own DEP0190
    // deprecation warning for exactly this) — so any argv value containing a
    // space, if left unquoted, is split into multiple shell words. Verified
    // live and directly reproduced (Windows, via the exact spawn shape here):
    // an unquoted multi-word value comes out the other side as separate
    // argv.slice(1) tokens in the spawned process. Every provider that both
    // uses shell:true (the default) and can emit a multi-word argv value —
    // currently Cline's fixed CLINE_CLI_ARGV_PROMPT_PLACEHOLDER positional,
    // which cline's own parser additionally requires to be multi-word at
    // all (a single-word positional is unconditionally rejected as an
    // unrecognized command, verified live — so shortening the placeholder
    // to one word is not a viable alternative fix) — needs this quoted on
    // BOTH platforms, not just Windows.
    const spawnArgs = useShell
      ? args.map((a) =>
          process.platform === "win32"
            ? a.includes(" ")
              ? `"${a}"`
              : a
            : quotePosixShellArg(a)
        )
      : args;
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(resolvedCommand, spawnArgs, {
        cwd,
        shell: useShell,
        windowsHide: true,
        // buildEnv is merged OVER sanitizedCliEnv(), never the other way —
        // a provider's own env additions (e.g. Kimi's
        // KIMI_MODEL_THINKING_EFFORT) can only add variables, not weaken
        // the sanitized base.
        env: { ...sanitizedCliEnv(), ...def.buildEnv?.(model) },
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
      if (inactivityCheckHandle) {
        clearInterval(inactivityCheckHandle);
      }
      cancellationListener.dispose();
      cleanupPromptFile();
      resolve(result);
    };

    // Shared by both watchdogs below (Part 7): the flat wall-clock cap and
    // the inactivity check kill the process the same way and shape the
    // result the same way, differing only in the message and the
    // timeoutReason marker (wall-clock vs inactivity) that recovery routing
    // and run records use to tell a wedged process apart from a genuinely
    // long-running one.
    // Extracted lazily from whatever stdout has accumulated: on the timeout
    // path the stream is truncated by definition, and the id appears on the
    // very first event, so a partial buffer is enough.
    const sessionIdOfRun = (): string | undefined =>
      def.structuredEventStream === "opencode" ? extractOpencodeSessionIdV1(stdout) : undefined;

    const emitTimeout = (message: string, timeoutReason: "wall-clock" | "inactivity"): void => {
      killProcessTree(child);
      // Edit-mode timeouts are always promoted: edit mode has its OWN
      // separate, stricter retry gate downstream that refuses to act on this
      // promotion for any provider — Cline/Antigravity included — except via
      // same-conversation resume. Text-mode timeouts are only promoted for a
      // provider whose text mode is
      // actually enforced read-only: shouldRetryReadOnlyRun's free-retry
      // rule (and the backup cascade, gated on failureKind alone) both trust
      // this promotion as proof the run could not have mutated the
      // workspace, which is false for Antigravity/Cline — see
      // isTextModeGuaranteedReadOnly.
      const resumeConversation = def.conversationResume !== undefined;
      const promoteForRetry =
        mode === "edit" || isTextModeGuaranteedReadOnly(def) || resumeConversation;
      finish({
        ...classifyCliFailure({
          status: "failed",
          output: stdout,
          errorMessage: message,
        }),
        // Override classifyCliFailure's marker-matched result: the fixed
        // timeout message never contains "quota"/"rate limit"/etc, so it
        // would otherwise fall through to "generic" — which the fallback
        // cascade in runnerRegistry.ts treats as terminal (never tries the
        // next backup model). A provider that is silently unresponsive for
        // the full timeout window (verified live: opencode hangs producing
        // zero stdout, rather than erroring, when its model is over quota)
        // is exactly the "temporarily unavailable" case that cascade exists
        // to handle, so it must be classified that way rather than generic
        // — but only when promoteForRetry allows it; otherwise this stays
        // "generic" (cascade-terminal, not retried), which is what
        // classifyCliFailure already produced above.
        ...(promoteForRetry
          ? {
              // A same-conversation continuation keeps this generic so the
              // backup cascade cannot consume a partially edited tree.
              failureKind: resumeConversation
                ? "generic" as const
                : "temporarily-unavailable" as const,
              // A timeout is the one failure shape that is transport-transient
              // and therefore retry-eligible (read-only runs always, subject
              // to promoteForRetry above; edit runs only under the
              // per-provider flush guarantee — see runImplementationWithCli).
              transient: true,
              ...(resumeConversation ? { resumeConversation: true } : {}),
            }
          : {}),
        // What the event stream showed up to the kill — the primary
        // retry-evidence input for edit-capable runs.
        editEvidence: analyzeCliEventStream(stdout),
        timeoutReason,
        // Pin the session this run created, so a resume continues THIS
        // conversation rather than whatever ran last in the directory.
        ...(sessionIdOfRun() !== undefined ? { sessionId: sessionIdOfRun() } : {}),
      });
    };

    const timeoutHandle = setTimeout(() => {
      emitTimeout(
        `${cliDisplayLabel(def)} CLI timed out after ${RUN_TIMEOUT_MS / 60000} minutes.`,
        "wall-clock"
      );
    }, RUN_TIMEOUT_MS);

    // Part 7 inactivity watchdog: unlike the flat wall-clock cap above, this
    // kills a process that has produced no stdout/stderr bytes at all for
    // ensemble.resilience.inactivityTimeoutMinutes, so a wedged process is
    // caught long before the 60-minute wall clock. 0 disables it. Checked on
    // a short fixed interval (well under the minimum nonzero limit of one
    // minute) rather than a single setTimeout re-armed per byte, so the
    // check logic stays simple and independent of how chatty the stream is.
    const inactivityLimitMinutes = getResilienceSettings().inactivityTimeoutMinutes;
    const inactivityLimitMs = inactivityLimitMinutes * 60_000;
    const inactivityCheckHandle =
      inactivityLimitMinutes > 0
        ? setInterval(() => {
            if (settled) {
              return;
            }
            if (Date.now() - lastActivityAt >= inactivityLimitMs) {
              emitTimeout(
                `${cliDisplayLabel(def)} CLI produced no output for ${inactivityLimitMinutes} minute(s) and was stopped as inactive.`,
                "inactivity"
              );
            }
          }, 15_000)
        : undefined;

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
      lastActivityAt = Date.now();
      stdout += chunk.toString("utf8");
      const lastLine = stdout.trimEnd().split(/\r?\n/).pop();
      if (lastLine && onProgress) {
        onProgress(lastLine.substring(0, 80));
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (cancelled) {
        finish({ status: "cancelled", output: stdout });
        return;
      }

      // claude-cli's structured stream applies to text mode only — its edit
      // mode still runs plain `--output-format text`, so its stdout must be
      // handled through the opaque-text path, exactly as before Step 16. See
      // effectiveStructuredStreamDefV1's doc comment.
      const effectiveDef = effectiveStructuredStreamDefV1(def, mode);
      // Parsed once and shared with toFriendlyError below (both call sites):
      // a failing opencode run's stdout can be multi-megabyte (it re-emits
      // every file the agent read), and parsing that same buffer twice for
      // two different purposes is pure waste. Only structured providers pay
      // for this parse at all — undefined here is a no-op for every other
      // provider's normalizeCliOutput/toFriendlyError call.
      const sharedParsedEvents = effectiveDef.structuredEventStream
        ? parseJsonLineEvents(stdout)
        : undefined;
      const output = normalizeCliOutput(effectiveDef, stdout, sharedParsedEvents);

      if (code !== 0) {
        const friendly = toFriendlyError(effectiveDef, model, code, stderr, stdout, sharedParsedEvents);
        finish(applyTransportTransience(
          classifyCliFailure({
            status: "failed",
            output,
            errorMessage: friendly.message,
            // Captured pre-hint so the backup-cascade gate never re-reads our
            // own login hint as evidence of the auth failure that produced it.
            authFailure: friendly.authFailure,
            authDiagnosticText: friendly.diagnosticText,
            structuredQuotaSignal: friendly.quotaSignal,
          }),
          friendly,
          mode,
          effectiveDef
        ));
        return;
      }

      if (output.length === 0) {
        // A dropped stream can also surface as a clean exit that produced
        // nothing, so this path gets the same transport treatment. The auth
        // verdict must still come from actually scanning stderr/stdout —
        // hardcoding it false here meant a genuine auth signal sitting in
        // stderr was never even checked, and no login hint was ever offered
        // for it. Reuses toFriendlyError fully via diagnosticTextOverride
        // (the specific "produced no output" wording is more informative
        // than toFriendlyError's own generic fallback for an empty result)
        // rather than hand-rebuilding a CliFriendlyError from its pieces.
        // Part 6 fix: this override bypassed the benign-noise filter
        // entirely — diagnosticTextOverride short-circuits toFriendlyError's
        // own filtering — so a stderr line consisting only of a known-benign
        // signature (e.g. Cline's hook-dispatch noise) still leaked through
        // this "clean exit, no output" branch. Filter stderr the same way
        // toFriendlyError filters its own candidate sources before folding
        // it into the override.
        const filteredEmptyStderr = stripKnownBenignCliNoiseV1(stderr);
        const emptyDetailBody = truncateCliDetail(filteredEmptyStderr.filtered, 4).trim();
        const emptyDetail = `${cliDisplayLabel(def)} CLI produced no output.${
          emptyDetailBody
            ? ` ${emptyDetailBody}`
            : filteredEmptyStderr.hint
              ? ` (${filteredEmptyStderr.hint})`
              : ""
        }`.trim();
        const friendly = toFriendlyError(effectiveDef, model, code, stderr, stdout, sharedParsedEvents, emptyDetail);
        finish(applyTransportTransience(
          classifyCliFailure({
            status: "failed",
            output,
            errorMessage: friendly.message,
            authFailure: friendly.authFailure,
            authDiagnosticText: friendly.diagnosticText,
            structuredQuotaSignal: friendly.quotaSignal,
          }),
          friendly,
          mode,
          effectiveDef
        ));
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
    // (2j) A provider's own argv-transport ceiling is a structural,
    // guaranteed failure, never a transient one — check it before the retry
    // loop below even starts. Without this, the loop still "worked" (the
    // in-dispatch check inside execCliAgent fails fast and shouldRetryReadOnlyRun
    // refuses to retry a non-transient result), but only after spending one
    // full dispatch + retry-audit entry on a run that could never succeed.
    // Skipping here spends zero attempts. Same classification
    // (temporarily-unavailable) execCliAgent's own check would have produced,
    // so every downstream backup-cascade decision is unaffected.
    const sizeCheck = checkArgvPromptSizeLimitV1(this.def, request.prompt);
    if (sizeCheck.exceeds) {
      const classified = classifyCliFailure({
        status: "failed" as const,
        output: "",
        errorMessage: sizeCheck.errorMessage,
      });
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage: classified.errorMessage,
        failureKind: classified.failureKind,
      };
    }

    // Ordinary read-only text runs replay transient failures. Providers with
    // a conversationResume contract instead continue the just-failed
    // conversation, preserving its context and any partial workspace edits.
    const retryAudit: RetryAuditEntry[] = [];
    let result: CliExecResult | undefined;
    let resumePreviousConversation = false;
    for (let attempt = 1; attempt <= CLI_RETRY_MAX_ATTEMPTS; attempt++) {
      result = await execCliAgent({
        def: this.def,
        mode: "text",
        model: request.modelId,
        prompt: resumePreviousConversation
          ? this.def.conversationResume!.continuationPrompt
          : request.prompt,
        cwd: request.workspaceUri.fsPath,
        token,
        resumePreviousConversation,
      });
      if (!shouldRetryReadOnlyRun(result, attempt, token.isCancellationRequested)) {
        break;
      }
      const willResumeConversation = result.resumeConversation === true;
      retryAudit.push({
        attempt,
        classification: willResumeConversation
          ? "transient (provider response timeout)"
          : result.editEvidence
            ? "transient (run timeout)"
            : "transient (stream transport)",
        capabilityFlag: undefined,
        evidence: willResumeConversation
          ? "same-conversation continuation — preserves prior provider context and workspace state"
          : "read-only (text-mode) run — side-effect free by provider permission configuration",
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
      resumePreviousConversation = willResumeConversation;
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
        // Carried so a future auth check on a text/review-path result can
        // prefer these over regexing errorMessage — see AgentRunResult's doc.
        authFailure: result.authFailure,
        authDiagnosticText: result.authDiagnosticText,
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

/**
 * Part 7: the three honest timeout-outcome variants, composed once
 * filesChanged/filesChangedUnknown are known (i.e. AFTER the retry loop and
 * the post-run git snapshot, never before). Pulled out to a pure function so
 * each variant is directly unit-testable without spawning a CLI process:
 *  - `filesChangedUnknown`: keep the pre-existing hedge — git couldn't be
 *    consulted (not a repo / unavailable), so nothing more specific can
 *    honestly be said.
 *  - known non-empty change set: name the files, so the message is
 *    actionable rather than a blanket "may have changed something".
 *  - known empty change set: state plainly the tree is clean — no hedge
 *    needed, nothing to review.
 */
export function composeCliTimeoutOutcomeV1(
  baseErrorMessage: string | undefined,
  filesChanged: readonly string[],
  filesChangedUnknown: boolean,
  breakReason: string
): string {
  const outcomeText = filesChangedUnknown
    ? "This run may already have made changes; review your working tree before retrying."
    : filesChanged.length > 0
      ? `This run timed out after changing ${filesChanged.length} file(s): ${filesChanged.join(", ")} — review these before retrying.`
      : "This run timed out but left the working tree clean — no files were changed.";
  return `${baseErrorMessage ?? "The run did not complete."} ${outcomeText} (${breakReason})`;
}

function toCliImplementationRunResult(
  def: CliProviderDefinition,
  result: CliExecResult,
  filesChanged: string[],
  filesChangedUnknown: boolean,
  requireFileChange = true,
  noChangeCompletionIsSuccess = false
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
      // Carried so the backup-cascade gate can consult the provider's own
      // pre-hint verdict instead of regexing errorMessage, which by this point
      // may contain the login hint that Ensemble itself appended.
      authFailure: result.authFailure,
      authDiagnosticText: result.authDiagnosticText,
      // Part 7: surfaced so recovery routing (beginImplementationRecoveryV1
      // call site) can tell an externally-killed round apart from an
      // ordinary provider failure without re-parsing errorMessage.
      timedOut: result.timeoutReason !== undefined,
      timeoutReason: result.timeoutReason,
    };
  }
  if (noChangeCompletionIsSuccess && !filesChangedUnknown && filesChanged.length === 0) {
    // ensemble.resilience.nothingToFixRoutesToReview: a completed run that
    // changed nothing is a legitimate outcome — an implementer that
    // inspected the tree, found the plan already satisfied, and declined to
    // fabricate work. The caller (executeImplementationRun) decides whether
    // prior rounds actually changed the tree before routing this onward.
    return {
      status: "completed",
      filesChanged,
      filesChangedUnknown,
      summary: result.output || undefined,
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

export interface PostImplementationTypeCheckResult {
  passed: boolean;
  /** Truncated combined stdout+stderr — only populated when `passed` is false. */
  output: string;
}

const TYPE_CHECK_OUTPUT_MAX_CHARS = 4000;
const TYPE_CHECK_TIMEOUT_MS = 120_000;

function truncateTypeCheckOutputV1(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > TYPE_CHECK_OUTPUT_MAX_CHARS
    ? `${trimmed.slice(0, TYPE_CHECK_OUTPUT_MAX_CHARS)}\n… (truncated)`
    : trimmed;
}

/**
 * Run the project's type-check after an implementation round (plan §2g): a
 * round that leaves the tree non-compiling must never be handed to a
 * reviewer as if it were reviewable — a reviewer that instead diagnoses a
 * build failure has wasted its round (observed directly: a quota kill
 * mid-write left a truncated file with 24 TS errors, surfaced a full review
 * round later as a 6.5 → 4.4 "Regressed" score spent diagnosing the break
 * instead of reviewing the work).
 *
 * Prefers the repo's own `check-types` package.json script — the same
 * command a human (or `npm run verify`) would run — and falls back to a bare
 * `npx tsc --noEmit` when no such script is declared. Any infrastructure
 * failure (the tool itself missing, a cancelled round) reports `passed: true`
 * rather than a false positive: this check exists to catch a broken BUILD,
 * not to gate on unrelated environment gaps — that distinction is exactly
 * what 1d's environment-disclosure item is for at the review stage.
 */
export async function runProjectTypeCheckV1(
  cwd: string,
  token: vscode.CancellationToken
): Promise<PostImplementationTypeCheckResult> {
  if (token.isCancellationRequested) {
    return { passed: true, output: "" };
  }
  const scripts = readPackageScripts(cwd);
  const hasCheckTypesScript = typeof scripts?.["check-types"] === "string";
  const command = hasCheckTypesScript ? "npm" : "npx";
  const args = hasCheckTypesScript ? ["run", "check-types"] : ["tsc", "--noEmit"];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PostImplementationTypeCheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(command, args, {
        cwd,
        // Windows needs a shell to resolve the npm/npx .cmd shim; POSIX
        // shells resolve the real executable directly (see runCheck in
        // completionLint.ts for the same platform split).
        shell: process.platform === "win32",
        env: sanitizedCliEnv(),
        windowsHide: true,
      });
    } catch {
      finish({ passed: true, output: "" });
      return;
    }

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({
        passed: false,
        output: truncateTypeCheckOutputV1(
          `${output}\n[type-check timed out after ${TYPE_CHECK_TIMEOUT_MS}ms]`
        ),
      });
    }, TYPE_CHECK_TIMEOUT_MS);

    const cancellation = token.onCancellationRequested(() => {
      clearTimeout(timer);
      killProcessTree(child);
      finish({ passed: true, output: "" });
    });

    child.on("error", () => {
      clearTimeout(timer);
      cancellation.dispose();
      finish({ passed: true, output: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cancellation.dispose();
      finish(
        code === 0
          ? { passed: true, output: "" }
          : { passed: false, output: truncateTypeCheckOutputV1(output) }
      );
    });
  });
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
  /** Test seam; production uses CLI_RETRY_DELAY_MS. */
  retryDelayMs?: number;
  /**
   * Test seam (2g); production always uses runProjectTypeCheckV1. Lets a
   * test substitute a fake type-check outcome instead of spawning a real
   * compiler.
   */
  typeCheckRunner?: (
    cwd: string,
    token: vscode.CancellationToken
  ) => Promise<PostImplementationTypeCheckResult>;
}): Promise<ImplementationRunResult> {
  const { def, model, prompt, workspaceUri, token, onProgress, requireFileChange } = options;
  const cwd = workspaceUri.fsPath;

  // (2j) Same structural, guaranteed-failure pre-check as CliAgentRunner.run
  // (text mode) above — see its comment. Checked before the git snapshot and
  // any dispatch: nothing ran, so filesChanged is definitively empty rather
  // than unknown, which keeps the caller's dirty-tree cascade gate reading
  // this as safe to continue past.
  const sizeCheck = checkArgvPromptSizeLimitV1(def, prompt);
  if (sizeCheck.exceeds) {
    const classified = classifyCliFailure({
      status: "failed" as const,
      output: "",
      errorMessage: sizeCheck.errorMessage,
    });
    return {
      status: "failed",
      filesChanged: [],
      filesChangedUnknown: false,
      errorMessage: classified.errorMessage,
      failureKind: classified.failureKind,
    };
  }

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

  // Edit-capable runs normally replay only when a provider flush guarantee,
  // clean event stream, and unchanged working tree prove that safe. A
  // provider-specific conversationResume signal is different: it continues
  // the persisted conversation and intentionally preserves prior edits.
  const retryAudit: RetryAuditEntry[] = [];
  /**
   * The provider session this run established, remembered across attempts.
   * An edit-mode resume is only safe when it names an exact session — see
   * `CliBuildArgsContext.resumeSessionId`.
   */
  let lastKnownSessionId: string | undefined;
  const retryDelayMs = options.retryDelayMs ?? CLI_RETRY_DELAY_MS;
  let attempt = 1;
  // Part 7: when a timed-out run refuses to retry, the reason is recorded
  // here rather than folded into result.errorMessage immediately — the
  // honest final message (which of the three variants below applies)
  // depends on filesChanged/filesChangedUnknown, computed from the git
  // snapshot AFTER this loop exits.
  let terminalTimeoutReason: string | undefined;
  while (
    result.status === "failed" &&
    result.transient === true &&
    attempt < CLI_RETRY_MAX_ATTEMPTS &&
    !token.isCancellationRequested
  ) {
    // Fail closed: a resume without a pinned session id would continue "the
    // last session in this directory", which is not necessarily this task's.
    // For an EDIT run that means applying another conversation's edits here,
    // so a timeout that produced no id is not retried at all — the audit
    // below records exactly that, rather than the retry happening blind.
    const resumeSessionId = result.sessionId ?? lastKnownSessionId;
    // Only providers that DECLARE they need a pinned session are held to it.
    // Extending the requirement to every provider would silently disable
    // Antigravity's and Kimi's long-shipping resume, whose streams report no
    // id for us to pin — a regression, not a fix.
    const needsPinnedSession = def.conversationResume?.requiresPinnedSession === true;
    const resumeConversation =
      result.resumeConversation === true &&
      def.conversationResume !== undefined &&
      (!needsPinnedSession || resumeSessionId !== undefined);
    const decision: EditRetryDecision = resumeConversation
      ? {
          retry: true,
          reason:
            "same-conversation continuation — preserves prior provider context and workspace state",
        }
      : {
          retry: false,
          reason:
            needsPinnedSession && resumeSessionId === undefined
              ? `Automatic retry is disabled for this ${def.label} edit run: the timed-out ` +
                "attempt reported no session id, and resuming without one would continue " +
                "whichever session ran last in this working directory — possibly another task's."
              : `Automatic retry is disabled for ${def.label} edit runs: its CLI protocol ` +
                "does not guarantee edit events are flushed before side effects.",
        };
    retryAudit.push({
      attempt,
      classification: resumeConversation
        ? "transient (provider response timeout)"
        : "transient (run timeout)",
      capabilityFlag: false,
      evidence: decision.reason,
      delayMs: retryDelayMs,
      retried: decision.retry,
    });
    if (!decision.retry) {
      result = {
        ...result,
        transient: false,
      };
      terminalTimeoutReason = decision.reason;
      break;
    }
    onProgress(resumeConversation
      ? `${def.label} response timed out; resuming the same conversation (attempt ${attempt + 1}/${CLI_RETRY_MAX_ATTEMPTS})...`
      : `${def.label} timed out with no observed changes; retrying (attempt ${attempt + 1}/${CLI_RETRY_MAX_ATTEMPTS})...`
    );
    await retryDelay(token, retryDelayMs);
    if (token.isCancellationRequested) {
      break;
    }
    attempt++;
    // Carried across attempts: a later attempt that dies before its stream
    // reports an id must not lose the one an earlier attempt established, or
    // the resume silently degrades to "whatever ran last in this directory".
    lastKnownSessionId = result.sessionId ?? lastKnownSessionId;
    result = await execCliAgent({
      def,
      mode: "edit",
      model,
      prompt: resumeConversation
        ? def.conversationResume!.continuationPrompt
        : prompt,
      cwd,
      token,
      onProgress,
      resumePreviousConversation: resumeConversation,
      // Continue THIS run's conversation, not whatever ran last in the
      // directory — see CliBuildArgsContext.resumeSessionId.
      ...(lastKnownSessionId !== undefined ? { resumeSessionId: lastKnownSessionId } : {}),
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

  // Part 7: compose the honest timeout message now that filesChanged is
  // known, rather than the generic hedge composed inside the retry loop
  // above (before the snapshot existed). See composeCliTimeoutOutcomeV1 for
  // the three variants.
  if (terminalTimeoutReason !== undefined) {
    result = {
      ...result,
      errorMessage: composeCliTimeoutOutcomeV1(
        result.errorMessage,
        filesChanged,
        filesChangedUnknown,
        terminalTimeoutReason
      ),
    };
  }

  const implResult = toCliImplementationRunResult(
    def,
    result,
    filesChanged,
    filesChangedUnknown,
    requireFileChange,
    // Read per-run, not cached: mid-task settings changes take effect on the
    // next round. Only softens the zero-change failure for callers that
    // REQUIRE file changes (Run Implementation); requireFileChange:false
    // callers already treat no-change completions as success.
    getResilienceSettings().nothingToFixRoutesToReview
  );

  // (2g) Only worth checking a round that actually left real, known edits —
  // a failed/cancelled run or a genuine no-op has nothing new to compile,
  // and an unknown change set already routes to manual review regardless.
  if (
    implResult.status === "completed" &&
    !filesChangedUnknown &&
    filesChanged.length > 0 &&
    !token.isCancellationRequested
  ) {
    onProgress("Verifying the project still type-checks...");
    const typeCheck = await (options.typeCheckRunner ?? runProjectTypeCheckV1)(cwd, token);
    if (!typeCheck.passed) {
      onProgress(`${def.label}'s changes left the project failing to type-check.`);
      return { ...implResult, typeCheckFailed: true, typeCheckOutput: typeCheck.output };
    }
  }

  return implResult;
}
