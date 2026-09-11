/**
 * Sandbox CLI provider runner: an `EngineProviderRunnerV1` that runs the REAL
 * Claude Code CLI inside the task's sandbox for each round, instead of
 * calling a model's HTTP API directly (`providerDispatchV1.ts`).
 *
 * This is the "as close as possible to running it locally" path. Locally,
 * the extension's implementation stage launches `claude -p --permission-mode
 * acceptEdits` as a child of the extension host, and that CLI — with its own
 * tools — reads files, edits files, runs commands, and iterates. Here the
 * very same CLI, with the very same flags, runs inside the sandbox through
 * `SandboxClientV1.runCommand`, authenticated by whatever the CLI itself
 * persisted in that sandbox (the subscription login `cliLoginSessionsV1.ts`
 * drives) or by an env file the composition supplies. Nothing here calls a
 * model API, and nothing here executes anything locally: this module only
 * ever hands argv to the sandbox client.
 *
 * Shape, mirrored from `src/runners/providers.ts`'s Claude Code definition:
 *  - `impl` rounds run in EDIT mode (`--permission-mode acceptEdits`) — the
 *    CLI actually writes files. Every other stage runs in PLAN mode
 *    (`--permission-mode plan` plus the same headless system prompt the
 *    extension appends) — read-only, exactly as the extension's text mode.
 *  - The prompt is the engine's own round prompt (`buildEngineRoundPromptV1`:
 *    plan of record, answers, and the result-frame contract) delivered via
 *    a file redirected onto the CLI's stdin — `runCommand` has no stdin of
 *    its own, and a file avoids argv size limits entirely.
 *  - The CLI's final text is read back from a file the command's stdout is
 *    redirected to, because `runCommand` returns only bounded output TAILS
 *    by design and a round summary can exceed them. It is then parsed with
 *    the same strict `parseAiResultEnvelopeV1` frame contract the direct-API
 *    path uses, so the engine's loop (checklist merge, questions pause,
 *    failure routing) is byte-for-byte the same downstream of either runner.
 *  - Output uses `--output-format text` in BOTH modes (the extension uses
 *    `stream-json` for its text mode); the frame contract makes structured
 *    event parsing unnecessary, and one parser for both modes is one fewer
 *    way to be wrong. The CLI's structural rate-limit signals that
 *    `stream-json` would expose are instead classified from its stderr text.
 *
 * Crash safety: the CLI run is a sandbox-mutating external effect, so it
 * runs under `EngineGateMachineryV1.runUngatedEffect` with a step id unique
 * to the invocation (its correlation attempt id). A worker that crashes
 * mid-round leaves the standard pending attempt record for recovery; a
 * recovery that cannot recover the CLI's output (adopted outcome,
 * indeterminate re-offer) reports a non-retryable failed round rather than
 * running the CLI — and its edits — a second time.
 */
import type { TaskStage } from "../../ensemble-core/src/taskProgressV1";
import {
  classifyEngineProviderFailureV1,
  isAuthenticationFailureV1,
  type EngineFailureKindV1,
} from "./failureClassificationV1";
import type { EngineGateMachineryV1 } from "./gateMachineryV1";
import {
  buildEngineRoundPromptV1,
  ENGINE_CLASSIFIED_FAILURE_CODES_V1,
  ENGINE_ROUND_MAX_RESPONSE_BYTES_V1,
  engineFailureCodeForKindV1,
  type EngineCliRoundOutcomeV1,
  type EngineCliTransportRunnerV1,
} from "./providerDispatchV1";
import { parseAiResultEnvelopeV1 } from "./resultEnvelopeV1";
import { quotePosixShellArgV1, type SandboxClientV1, type SandboxCommandResultV1 } from "./sandboxClientV1";
import type {
  EngineProviderInvocationV1,
  EngineProviderRunnerV1,
  EngineRoundResultV1,
} from "./taskLoopV1";

/**
 * Verbatim copy of the extension's `CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT`
 * (`src/runners/providers.ts`): the extension package depends on `vscode`
 * and cannot be imported here, and this text is part of the CLI contract
 * the sandbox path must reproduce exactly.
 */
export const CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT_V1 =
  "This is a non-interactive, headless run. The ExitPlanMode and " +
  "AskUserQuestion tools are not available in this session — do not " +
  "attempt to call them, and do not write your plan or any partial " +
  "output to a file (including anywhere under ~/.claude/plans). Instead, " +
  "write your complete plan, review, or answer directly as this " +
  "response's final text, including any open questions, decisions, or " +
  "assumptions inline in that text.";

export type SandboxCliRoundModeV1 = "edit" | "plan";

/** Only the implementation stage may write; every other stage is read-only, as locally. */
export function sandboxCliModeForStageV1(stage: TaskStage): SandboxCliRoundModeV1 {
  return stage === "impl" ? "edit" : "plan";
}

/**
 * The extension's `@<effort>` model-suffix ladder for Claude Code
 * (`CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS` in `providers.ts`),
 * copied verbatim for the same reason as the system prompt above: a stored
 * `claude-cli:opus@high` must mean the same flags in both hosts.
 */
const CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS_V1: ReadonlyMap<string, number> = new Map([
  ["low", 1024],
  ["medium", 4096],
  ["high", 8192],
  ["xhigh", 16384],
  ["max", 32768],
]);

export interface ParsedSandboxCliModelSelectionV1 {
  /** The model passed to `--model`; undefined runs the CLI's own default. */
  readonly model: string | undefined;
  readonly maxThinkingTokens: number | undefined;
}

/**
 * Port of the extension's `parseClaudeCliModelSelection`: an `@<effort>`
 * suffix from the known ladder becomes `--max-thinking-tokens`; any other
 * `@` suffix is left on the model name untouched (the CLI decides whether
 * it means anything), exactly as the extension does.
 */
export function parseSandboxCliModelSelectionV1(
  model: string | undefined
): ParsedSandboxCliModelSelectionV1 {
  if (model === undefined || model.length === 0) {
    return { model: undefined, maxThinkingTokens: undefined };
  }
  const separator = model.lastIndexOf("@");
  if (separator <= 0) {
    return { model, maxThinkingTokens: undefined };
  }
  const maxThinkingTokens = CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS_V1.get(model.slice(separator + 1));
  if (maxThinkingTokens === undefined) {
    return { model, maxThinkingTokens: undefined };
  }
  return { model: model.slice(0, separator), maxThinkingTokens };
}

export interface SandboxCliArgvOptionsV1 {
  readonly mode: SandboxCliRoundModeV1;
  /** Provider-native model id (e.g. `opus`, `claude-opus-5`); undefined runs the CLI default. */
  readonly model?: string;
  readonly maxThinkingTokens?: number;
  /** The CLI executable; default `claude`. */
  readonly command?: string;
}

/** Mirrors `providers.ts`'s Claude Code `buildArgs` for the sandbox path. */
export function buildClaudeCliArgvV1(options: SandboxCliArgvOptionsV1): readonly string[] {
  const argv: string[] = [options.command ?? "claude", "-p", "--output-format", "text"];
  if (options.mode === "edit") {
    argv.push("--permission-mode", "acceptEdits");
  } else {
    argv.push(
      "--permission-mode",
      "plan",
      "--append-system-prompt",
      CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT_V1
    );
  }
  if (options.model !== undefined && options.model.length > 0) {
    argv.push("--model", options.model);
  }
  if (options.maxThinkingTokens !== undefined) {
    argv.push("--max-thinking-tokens", String(options.maxThinkingTokens));
  }
  return argv;
}

export interface CreateSandboxCliProviderRunnerOptionsV1 {
  readonly client: SandboxClientV1;
  readonly sandboxId: string;
  /** The binding's confined root; the CLI's working directory. */
  readonly workingDirectoryRoot: string;
  /** This task's gate machinery — the CLI run is an attempt-recorded effect. */
  readonly machinery: EngineGateMachineryV1;
  /**
   * The model for plain `invoke` calls (the `EngineProviderRunnerV1` face);
   * `invokeWithModel` — what dispatch uses — takes the selection's model per
   * call instead, so one runner serves every stage's own configured model.
   * Either form accepts the extension's `@<effort>` suffix.
   */
  readonly model?: string;
  readonly command?: string;
  /**
   * Environment for the CLI process, written to a file inside the sandbox
   * and sourced by the wrapper script — never placed on the command line,
   * where `ps`/`docker top` would expose it. Owner-only permissions and
   * off-the-command-line delivery of the FILE CONTENT are the sandbox
   * client's `writeFile` contract (the Docker client writes over stdin
   * under umask 077). The place for an `ANTHROPIC_API_KEY` when the
   * sandbox has no subscription login.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Where the per-round prompt/output/env files live; default `/tmp/ensemble-cli`. */
  readonly scratchDir?: string;
  readonly maxOutputBytes?: number;
}

/** Exported for tests: the failure codes this runner can report. */
export const SANDBOX_CLI_ROUND_FAILURE_CODES_V1 = {
  outputUnavailable: "cliRoundOutputUnavailable",
  outputMissing: "cliRoundOutputMissing",
  outputTooLarge: "cliRoundOutputTooLarge",
  alreadyExecuted: "cliRoundAlreadyExecuted",
  indeterminate: "cliRoundIndeterminate",
  leaseUnavailable: "cliRoundLeaseUnavailable",
} as const;

const ENV_NAME_PATTERN_V1 = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DIAGNOSTIC_CHARS_V1 = 2000;

function tail(text: string, max = MAX_DIAGNOSTIC_CHARS_V1): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * The Claude Code CLI's own signed-out reply — a short line such as
 * `Not logged in · Please run /login` (2.1.267) — and nothing else. Length-
 * bounded on purpose: a long unframed reply that merely mentions logins is
 * the model's work, not the CLI's refusal.
 */
export function isCliSignedOutMessageV1(output: string): boolean {
  const trimmed = output.trim();
  return trimmed.length > 0 && trimmed.length <= 300 && /not logged in|please run \/login/i.test(trimmed);
}

/** `export NAME='value'` lines, every value strictly single-quoted; names validated. */
export function renderEnvFileV1(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_PATTERN_V1.test(name)) {
      throw new Error(`invalid environment variable name for the sandbox CLI: ${JSON.stringify(name)}`);
    }
    lines.push(`export ${name}=${quotePosixShellArgV1(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The wrapper the sandbox actually runs. Every dynamic piece is strictly
 * quoted, so nothing from the prompt, the model id, or the paths can become
 * shell syntax; the CLI's own argv is passed through the same quoting.
 */
export function buildSandboxCliScriptV1(input: {
  readonly argv: readonly string[];
  readonly promptPath: string;
  readonly outputPath: string;
  readonly stderrPath: string;
  readonly envPath?: string;
}): string {
  const command = input.argv.map((arg) => quotePosixShellArgV1(arg)).join(" ");
  const source = input.envPath !== undefined ? `. ${quotePosixShellArgV1(input.envPath)} && ` : "";
  return (
    `${source}${command} ` +
    `< ${quotePosixShellArgV1(input.promptPath)} ` +
    `> ${quotePosixShellArgV1(input.outputPath)} ` +
    `2> ${quotePosixShellArgV1(input.stderrPath)}`
  );
}

/** Both faces: the task loop's `invoke`, and dispatch's per-selection `invokeWithModel`. */
export interface SandboxCliProviderRunnerV1 extends EngineProviderRunnerV1, EngineCliTransportRunnerV1 {}

export function createSandboxCliProviderRunnerV1(
  options: CreateSandboxCliProviderRunnerOptionsV1
): SandboxCliProviderRunnerV1 {
  const { client, sandboxId, workingDirectoryRoot, machinery } = options;
  const scratchDir = (options.scratchDir ?? "/tmp/ensemble-cli").replace(/\/$/, "");
  const maxOutputBytes = options.maxOutputBytes ?? ENGINE_ROUND_MAX_RESPONSE_BYTES_V1;

  async function cleanup(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try {
        await client.deleteFile(sandboxId, path);
      } catch {
        // Best-effort: a stale scratch file never masks the round's real outcome.
      }
    }
  }

  function failed(code: string, retryable: boolean): EngineCliRoundOutcomeV1 {
    return { result: { kind: "failed", code, retryable } };
  }

  function round(result: EngineRoundResultV1): EngineCliRoundOutcomeV1 {
    return { result };
  }

  /** A failure the TRANSPORT observed (exit status, the CLI's own words) — what dispatch may cascade on. */
  function classifiedFailure(
    failureKind: EngineFailureKindV1,
    authFailure: boolean,
    genericCode: string,
    errorMessage: string
  ): EngineCliRoundOutcomeV1 {
    return {
      result: {
        kind: "failed",
        code: engineFailureCodeForKindV1(failureKind, authFailure, genericCode),
        // Same discipline as the direct-API dispatch: auth never retries,
        // capacity-shaped failures do, anything else is terminal.
        retryable: !authFailure && failureKind !== "generic",
      },
      classification: { failureKind, authFailure, errorMessage },
    };
  }

  const runner: SandboxCliProviderRunnerV1 = {
    async invoke(input: EngineProviderInvocationV1): Promise<EngineRoundResultV1> {
      return (await runner.invokeWithModel(input, options.model)).result;
    },
    async invokeWithModel(
      input: EngineProviderInvocationV1,
      selectedModel: string | undefined
    ): Promise<EngineCliRoundOutcomeV1> {
      const id = input.correlation.attemptId;
      const selection = parseSandboxCliModelSelectionV1(selectedModel);
      const promptPath = `${scratchDir}/${id}.prompt.md`;
      const outputPath = `${scratchDir}/${id}.out`;
      const stderrPath = `${scratchDir}/${id}.err`;
      const envPath = options.env !== undefined ? `${scratchDir}/${id}.env` : undefined;
      const scratch = [promptPath, outputPath, stderrPath, ...(envPath !== undefined ? [envPath] : [])];

      try {
        await client.writeFile(sandboxId, promptPath, buildEngineRoundPromptV1(input));
        if (envPath !== undefined && options.env !== undefined) {
          await client.writeFile(sandboxId, envPath, renderEnvFileV1(options.env));
        }

        const argv = buildClaudeCliArgvV1({
          mode: sandboxCliModeForStageV1(input.stage),
          ...(selection.model !== undefined ? { model: selection.model } : {}),
          ...(selection.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: selection.maxThinkingTokens }
            : {}),
          ...(options.command !== undefined ? { command: options.command } : {}),
        });
        const script = buildSandboxCliScriptV1({
          argv,
          promptPath,
          outputPath,
          stderrPath,
          ...(envPath !== undefined ? { envPath } : {}),
        });

        // The captured command result only exists on a fresh execution (or
        // a reconciled re-issue); every other recovery outcome has no output
        // to parse and is reported as such below.
        let captured: SandboxCommandResultV1 | undefined;
        // The step id carries the model as well as the invocation: dispatch
        // hands the SAME invocation to each cascade candidate, and with the
        // attempt id alone a `claude-cli:opus` backup found the failed
        // `claude-cli:sonnet` primary's attempt record and reported
        // "already executed" without ever running (review finding, 2026-09-11).
        const effect = await machinery.runUngatedEffect(`cli-round/${id}/${selectedModel ?? "cli-default"}`, {
          effectKind: "sandboxCommand",
          supportsIdempotentReplay: false,
          async execute(attemptKey: string) {
            captured = await client.runCommand({
              sandboxId,
              argv: ["sh", "-c", script],
              cwd: workingDirectoryRoot,
              attemptKey,
            });
            return {
              status: captured.exitCode === 0 ? ("succeeded" as const) : ("failed" as const),
              code: `cliExit${captured.exitCode}`,
            };
          },
          reconcile(attemptKey: string) {
            return client.findCommandByAttemptKey(sandboxId, attemptKey);
          },
        });

        switch (effect.kind) {
          case "alreadyExecuted":
            return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.alreadyExecuted, false);
          case "indeterminate":
            return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.indeterminate, false);
          case "leaseUnavailable":
            return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.leaseUnavailable, true);
          case "recovered":
            if (effect.method !== "reconciledReissued" || captured === undefined) {
              return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputUnavailable, false);
            }
            break;
          case "executed":
            break;
        }
        if (captured === undefined) {
          return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputUnavailable, false);
        }

        const stderr = (await client.readFileUtf8(sandboxId, stderrPath)) ?? captured.stderrTail;
        if (captured.exitCode !== 0) {
          // The command's stdout is REDIRECTED to the output file, so the
          // captured `stdoutTail` is empty by construction — the CLI's own
          // words about why it failed are in that file. Confirmed live: a
          // fresh sandbox's signed-out CLI exits 1 with "Not logged in ·
          // Please run /login" on stdout and nothing on stderr, which
          // classified as a bare `cliExit1` until the file was read here.
          const stdout = (await client.readFileUtf8(sandboxId, outputPath)) ?? captured.stdoutTail;
          const errorMessage = tail(`${stderr}\n${stdout}`);
          const classified = classifyEngineProviderFailureV1({
            errorMessage,
            authFailure: isAuthenticationFailureV1(errorMessage),
          });
          return classifiedFailure(
            classified.failureKind,
            classified.authFailure === true,
            `cliExit${captured.exitCode}`,
            errorMessage
          );
        }

        const output = await client.readFileUtf8(sandboxId, outputPath);
        if (output === undefined) {
          // A provider may refuse to read back an oversized file (Docker's
          // client does, past 8 MB) — that is "too large", which a retry
          // cannot fix, not "missing", which it might. Retrying used to
          // re-run a whole edit-mode CLI round for nothing.
          const present = await client.resolveRealPath(sandboxId, outputPath);
          return present !== undefined
            ? failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputTooLarge, false)
            : failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputMissing, true);
        }
        if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
          return failed(SANDBOX_CLI_ROUND_FAILURE_CODES_V1.outputTooLarge, false);
        }

        const envelope = parseAiResultEnvelopeV1(output, input.correlation);
        if (envelope.kind === "malformed") {
          // A signed-out CLI does not fail: `claude -p` prints
          // "Not logged in · Please run /login" to STDOUT and exits 0
          // (confirmed live, Claude Code 2.1.267). Without this check that
          // reads as a malformed frame — retryable — and the loop would
          // burn its whole round budget re-running a CLI that can never
          // answer. Matched narrowly — the CLI's own short message, not any
          // output that mentions logging in (a model working ON login code
          // must not have its unframed reply read as an expired credential).
          if (isCliSignedOutMessageV1(output)) {
            return classifiedFailure("generic", true, ENGINE_CLASSIFIED_FAILURE_CODES_V1.authentication, output.trim());
          }
          return failed(`malformedResult.${envelope.code}`, true);
        }
        if (envelope.kind === "questions") {
          return round({ kind: "questions", questions: envelope.questions });
        }
        if (envelope.kind === "completed") {
          if (envelope.content.contentType !== "markdown-artifact.v1") {
            return failed("unexpectedContentType", true);
          }
          return round({ kind: "completed", summaryMarkdown: envelope.content.markdown });
        }
        if (envelope.kind === "cancelled") {
          return failed("cancelled", false);
        }
        // The model reported a typed failure through the frame. Its `code`
        // is model-written, so it never decides a cascade by itself (it used
        // to: `code: "quotaExhausted"` alone spent a paid backup). Only its
        // MESSAGE is classified — exactly the direct-API path's rule, which
        // lets a provider report its own rate limiting through the frame.
        const reported = classifyEngineProviderFailureV1({ errorMessage: envelope.message });
        if (reported.failureKind === "generic") {
          return failed(envelope.code, envelope.retryable);
        }
        return {
          result: { kind: "failed", code: envelope.code, retryable: true },
          classification: { failureKind: reported.failureKind, authFailure: false, errorMessage: envelope.message },
        };
      } finally {
        await cleanup(scratch);
      }
    },
  };
  return runner;
}
