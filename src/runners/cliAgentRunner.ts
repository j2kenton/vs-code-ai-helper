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
} from "../types/agentRunner";
import { writeTextFile } from "../utils/fileUtils";
import { ImplementationRunResult } from "./copilotImplementationRunner";
import { CliProviderDefinition, CliRunMode } from "./providers";

/**
 * Hard cap on a single CLI run. Runs are also cancellable from the progress
 * notification; this only guards against a hung process left behind.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

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

/**
 * Kill a CLI process and its children (agent CLIs spawn helpers, and since
 * they're launched with shell:true there's always at least a shell process
 * in between). On Windows, taskkill /T walks the whole process tree by PID.
 * On POSIX, the child is spawned detached (see execCliAgent) so it heads
 * its own process group; signalling the negated PID sends SIGTERM to that
 * whole group — the shell, the exec'd CLI, and any children *it* forked —
 * rather than only the single PID Node handed back, which a plain
 * child.kill("SIGTERM") would otherwise leave running past cancellation.
 */
function killProcessTree(child: cp.ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Group may already be gone, or (if spawn's detached setup somehow
      // failed) child.pid isn't a process-group leader — fall back to
      // signalling the process directly so the run still terminates.
      child.kill("SIGTERM");
    }
  }
}

interface CliExecResult {
  status: "completed" | "failed" | "cancelled";
  output: string;
  errorMessage?: string;
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
    stderr.trim().split(/\r?\n/).slice(-8).join("\n").trim() ||
    stdout.trim().split(/\r?\n/).slice(-8).join("\n").trim() ||
    `exit code ${exitCode ?? "unknown"}`;
  const authSuffix = looksLikeAuth ? ` ${def.loginHint}` : "";
  return `${def.label} CLI failed: ${detail}${authSuffix}`;
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
  const args = def.buildArgs(mode, model, lastMessageFile);

  if (promptTransport === "argv") {
    if (useShell) {
      return {
        status: "failed",
        output: "",
        errorMessage: `${def.label} provider misconfiguration: argv prompt transport requires shell:false for safe argument passing.`,
      };
    }
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const maxArgvPromptBytes = def.maxArgvPromptBytes;
    if (
      typeof maxArgvPromptBytes === "number" &&
      promptBytes > maxArgvPromptBytes
    ) {
      return {
        status: "failed",
        output: "",
        errorMessage:
          `${def.label} prompt is too large for this CLI mode (${promptBytes} bytes; max ${maxArgvPromptBytes} bytes). ` +
          "Reduce context or choose a provider that accepts stdin prompts.",
      };
    }
    args.push(prompt);
  }

  const resolvedCommand = await resolveCliCommand(
    def.command,
    def.commandAliases
  );

  if (!resolvedCommand) {
    return {
      status: "failed",
      output: "",
      errorMessage: `Could not start the ${def.label} CLI (${def.command}): command not found. ${def.installHint}`,
    };
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
        env: process.env,
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
      resolve({
        status: "failed",
        output: "",
        errorMessage: `Could not start the ${def.label} CLI (${resolvedCommand}): ${message}.${argvHint} ${def.installHint}`.trim(),
      });
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
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      killProcessTree(child);
      finish({
        status: "failed",
        output: stdout,
        errorMessage: `${def.label} CLI timed out after ${
          RUN_TIMEOUT_MS / 60000
        } minutes.`,
      });
    }, RUN_TIMEOUT_MS);

    const cancellationListener = token.onCancellationRequested(() => {
      cancelled = true;
      killProcessTree(child);
      finish({ status: "cancelled", output: stdout });
    });

    child.on("error", (error) => {
      finish({
        status: "failed",
        output: "",
        errorMessage: `Could not start the ${def.label} CLI (${resolvedCommand}): ${error.message}. ${def.installHint}`,
      });
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

      let output = stdout.trim();
      if (lastMessageFile) {
        try {
          const fromFile = nodeFs
            .readFileSync(lastMessageFile, "utf8")
            .trim();
          if (fromFile.length > 0) {
            output = fromFile;
          }
        } catch {
          // Fall back to stdout when the CLI never wrote the file.
        }
      }

      if (code !== 0) {
        finish({
          status: "failed",
          output,
          errorMessage: toFriendlyError(def, code, stderr, stdout),
        });
        return;
      }

      if (output.length === 0) {
        finish({
          status: "failed",
          output,
          errorMessage: `${def.label} CLI produced no output. ${
            stderr.trim().split(/\r?\n/).slice(-4).join("\n") || ""
          }`.trim(),
        });
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
        reason: `The ${this.def.label} CLI (${this.def.command}) is not installed. ${this.def.installHint}`,
      };
    }
    return { available: true };
  }

  async run(
    request: AgentRunRequest,
    token: vscode.CancellationToken
  ): Promise<AgentRunResult> {
    const result = await execCliAgent({
      def: this.def,
      mode: "text",
      model: request.modelId,
      prompt: request.prompt,
      cwd: request.workspaceUri.fsPath,
      token,
    });

    if (result.status === "cancelled") {
      return { runnerId: this.id, status: "cancelled" };
    }
    if (result.status === "failed") {
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage: result.errorMessage ?? "unknown error",
      };
    }

    await writeTextFile(request.outputFile, result.output);
    return {
      runnerId: this.id,
      status: "completed",
      outputFile: request.outputFile,
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

/**
 * Snapshot of the workspace's git working-tree state, keyed by
 * workspace-relative path, used to detect which files an agentic CLI run
 * changed. Undefined when git is unavailable or the workspace is not a
 * repository — callers must treat that as "unknown", not "no changes".
 */
async function gitStatusSnapshot(
  cwd: string
): Promise<GitSnapshot | undefined> {
  const statusOutput = await execGit(cwd, ["status", "--porcelain"]);
  if (statusOutput === undefined) {
    return undefined;
  }

  const snapshot: GitSnapshot = new Map();
  const paths: string[] = [];
  for (const rawLine of statusOutput.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }
    const statusCode = line.substring(0, 2);
    let path = line.substring(3);
    const renameIdx = path.indexOf(" -> ");
    if (renameIdx >= 0) {
      path = path.substring(renameIdx + 4);
    }
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.substring(1, path.length - 1);
    }
    path = path.replace(/\\/g, "/");
    if (path.length === 0) {
      continue;
    }
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
 * Run an agentic implementation with a vendor CLI: the CLI edits files in
 * the workspace itself (with edit-level permissions only), and the files it
 * changed are detected via a git status snapshot taken before and after.
 * Mirrors runImplementationWithCopilot's result shape so callers treat all
 * providers uniformly.
 */
export async function runImplementationWithCli(options: {
  def: CliProviderDefinition;
  model: string | undefined;
  prompt: string;
  workspaceUri: vscode.Uri;
  token: vscode.CancellationToken;
  onProgress: (message: string) => void;
}): Promise<ImplementationRunResult> {
  const { def, model, prompt, workspaceUri, token, onProgress } = options;
  const cwd = workspaceUri.fsPath;

  onProgress(`Using ${def.label}...`);
  const before = await gitStatusSnapshot(cwd);

  const result = await execCliAgent({
    def,
    mode: "edit",
    model,
    prompt,
    cwd,
    token,
    onProgress,
  });

  // Git unavailable or not a repository — we genuinely can't tell what
  // changed, which is different from "nothing changed". Callers must fall
  // back to open-editor review scope in this case, same as manual
  // implementations, rather than trusting an empty filesChanged.
  const after = before ? await gitStatusSnapshot(cwd) : undefined;
  const filesChangedUnknown = before === undefined || after === undefined;
  const filesChanged = filesChangedUnknown
    ? []
    : changedPathsSince(before, after);

  if (result.status === "cancelled") {
    return { status: "cancelled", filesChanged, filesChangedUnknown };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      filesChanged,
      filesChangedUnknown,
      errorMessage: result.errorMessage,
    };
  }

  return {
    status: "completed",
    filesChanged,
    filesChangedUnknown,
    summary: result.output || undefined,
  };
}
