/**
 * AI provider definitions. Besides GitHub Copilot (VS Code Language Model
 * API), the extension can drive vendor CLIs that authenticate against the
 * user's existing subscription via their own login flow. Most providers
 * support OAuth/CLI login only; Kiro headless mode requires KIRO_API_KEY:
 *
 *  - Claude Code  (`claude`) — Anthropic Claude Pro/Max subscription
 *  - Codex CLI    (`codex`)  — OpenAI ChatGPT Plus/Pro subscription
 *  - Gemini CLI   (`gemini`) — Google account / Gemini Code Assist
 *  - Antigravity  (`agy` / `antigravity`) — Google Gemini/Antigravity CLI account
 *  - Kiro CLI     (`kiro-cli`) — AWS Kiro subscription/login
 *  - OpenCode Zen / OpenCode Go (`opencode`) — two OpenCode service plans
 *    reached through the same CLI and OpenCode account/API key. Zen models
 *    use the `opencode/` namespace; Go models use `opencode-go/`. They have
 *    separate billing/entitlement, so the settings UI exposes them as two
 *    logical providers even though runs share this one CLI adapter.
 *  - Cline CLI    (`cline`) — ClinePass, Cline's own $9.99/mo subscription
 *    (https://docs.cline.bot/getting-started/clinepass) that bundles a
 *    curated open-weights model catalog (GLM, Kimi, DeepSeek, MiniMax,
 *    MiMo, Qwen) behind one flat fee instead of per-vendor API keys. Cline
 *    also supports bring-your-own-key providers (`-P anthropic`, `-P
 *    openai-native`, etc.) but this integration deliberately only wires up
 *    ClinePass (`-P cline-pass`), matching the subscription-over-API-key
 *    preference every other CLI provider here follows. Models are namespaced
 *    "cline-pass/<model>" (verified live: a bare "<model>" is rejected with
 *    "invalid model format. Expected format: modelType/model").
 *  - Kimi Code CLI (`kimi`) — Moonshot AI's own dedicated coding CLI
 *    (https://github.com/MoonshotAI/kimi-code), distinct from the Kimi
 *    models reachable through Cline's ClinePass catalog above. Auth is
 *    `kimi login`'s OAuth device-code flow against the user's Moonshot/Kimi
 *    account. See its buildArgs comment for why promptTransport is "argv"
 *    (verified live: `-p/--prompt` is the CLI's only prompt input — piped
 *    stdin is never read) and why it carries a permissionWarning stronger
 *    than Antigravity's/Cline's (verified live: `--plan` cannot even be
 *    passed alongside `-p` — "error: Cannot combine --prompt with --plan" —
 *    so there is no read-only invocation shape at all, not merely an
 *    unenforced one).
 *
 * Model IDs are stored as "<provider>:<model>" (e.g. "claude-cli:sonnet",
 * "gemini-cli:default"). Bare IDs with no known provider prefix are Copilot
 * model IDs, which keeps existing saved configurations working unchanged.
 */

import {
  discoverAgyModels,
  discoverDevpassModels,
  discoverKimiModels,
  discoverKiroModels,
  discoverOpencodeModels,
  KIMI_REASONING_EFFORTS_V1,
  type DiscoveredCliModel,
} from "../utils/cliModelDiscovery";
import { FRAME_END_V1, FRAME_START_V1 } from "../types/aiResultEnvelope";

export type CliProviderId =
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli"
  | "antigravity-cli"
  | "kiro-cli"
  | "opencode-cli"
  | "cline-cli"
  | "kimi-cli"
  | "devpass-cli";
export type ProviderId = "copilot" | CliProviderId;

/**
 * IDs shown in Provider Selection. Most are the same as their runner ID;
 * OpenCode is intentionally different: Zen and Go are independently
 * enabled/configured logical services backed by the same `opencode` binary.
 */
export type ProviderAccountId = ProviderId | "opencode-zen" | "opencode-go";

export const OPENCODE_ZEN_ACCOUNT_ID = "opencode-zen" as const;
export const OPENCODE_GO_ACCOUNT_ID = "opencode-go" as const;

/** How a CLI run may touch the workspace. */
export type CliRunMode = "text" | "edit";

export interface CliModelChoice {
  /** Model name passed to the CLI; undefined uses the CLI's own default. */
  model: string | undefined;
  /** Human-readable name shown in the model picker. */
  name: string;
}

export interface CliBuildArgsContext {
  cwd?: string;
  /**
   * Path to a temp file containing the prompt, set only when
   * promptTransport is "file". buildArgs must reference this path in the
   * argument it returns (e.g. `--print=${promptFile}`).
   */
  promptFile?: string;
  /**
   * Continue the provider's most recently persisted conversation instead of
   * starting a new one. Set only by the bounded retry path for providers that
   * declare conversationResume below.
   */
  resumePreviousConversation?: boolean;
  /**
   * This run's reply must be exactly one `<<<ENSEMBLE_AI_RESULT_V1>>>` frame
   * (the V1 text transport parses stdout with `parseAiResultEnvelopeV1`; the
   * legacy path does not). Set only by `createCliTextTransportV1`.
   *
   * It exists for `promptTransport: "file"` providers specifically. The frame
   * contract is stated inside the prompt file, but for a large prompt that is
   * hundreds of lines deep in a document the model reads through its own
   * paginated Read tool — and a live run (kimi-code/k3, 2026-08-06, 15 steps
   * / 23 tool calls over a ~200 KB prompt) carried out the review task
   * faithfully and then answered in plain prose, dropping the output-format
   * contract entirely. A complete, high-quality review was discarded as
   * `invalidFrame` purely on formatting. Restating the frame requirement in
   * argv — the one channel the model receives directly rather than by
   * reading a file — keeps it adjacent to the instruction it must obey last.
   */
  requiresFramedResult?: boolean;
}

export interface CliConversationResumeDefinition {
  /**
   * Exact, provider-owned diagnostic fragments that mean a failed process can
   * be recovered by continuing the conversation it just persisted.
   */
  errorMarkers: readonly string[];
  /** Follow-up prompt sent when continuing that conversation. */
  continuationPrompt: string;
}

export interface CliProviderDefinition {
  id: CliProviderId;
  /** Short label, e.g. "Claude Code". */
  label: string;
  /** Executable name resolved via PATH. */
  command: string;
  /** Fallback executable names accepted for the same provider. */
  commandAliases?: readonly string[];
  /** Shown when the CLI is not installed. */
  installHint: string;
  /** Shown when the CLI reports an authentication problem. */
  loginHint: string;
  /**
   * Optional model-specific authentication recovery guidance. OpenCode's
   * Zen and Go model namespaces share one CLI but require different account
   * entitlements, so a generic "sign in" hint is not enough on a 401.
   */
  loginHintForModel?: (model: string | undefined) => string;
  /** Substrings in CLI output that indicate an auth problem. */
  authErrorMarkers: readonly string[];
  /** Non-interactive command that reports whether this CLI is authenticated. */
  authenticationCheckArgs?: readonly string[];
  /**
   * How the prompt is passed to the CLI. Defaults to stdin.
   *  - "stdin": written to the child's stdin.
   *  - "argv": appended as the final argv element (requires useShell: false).
   *  - "file": written to a temp file whose path is passed to buildArgs as
   *    promptFile; use this when a CLI's flag takes the prompt as a value
   *    but the prompt may be too large for a single argv element.
   */
  promptTransport?: "stdin" | "argv" | "file";
  /**
   * Whether this provider should run with shell:true.
   * Defaults to true so npm/pnpm global .cmd shims resolve on Windows.
   */
  useShell?: boolean;
  /**
   * Maximum UTF-8 bytes allowed for argv-based prompt transport.
   * Ignored for stdin transport.
   */
  maxArgvPromptBytes?: number;
  /**
   * Extra environment variables to set on the spawned CLI process for this
   * invocation's model selection, merged over sanitizedCliEnv() (so this
   * CANNOT unset the sanitization — only add to it). Exists for a provider
   * whose per-invocation model options (e.g. reasoning effort) are exposed
   * as an operational environment-variable override rather than a CLI flag,
   * with no other way to reach them from buildArgs's plain string[] return.
   * Absent for every provider whose options are all expressible as argv
   * flags (the normal case) — kimi-cli is first: its reasoning effort for
   * K3/K3-256k is set via KIMI_MODEL_THINKING_EFFORT, verified live against
   * kimi-code 0.29.2 (`kimi provider list --json`'s support_efforts/
   * default_effort fields, and a live low/high/bogus run: low and high both
   * succeeded, bogus 400'd from the API) — see parseKimiModelSelection.
   */
  buildEnv?: (model: string | undefined) => Record<string, string> | undefined;
  models: readonly CliModelChoice[];
  /**
   * Optional live model discovery: queries the CLI itself for its current
   * model list. Absent for providers whose model list is static (only the
   * seeded `models` field / SEEDED_CLI_MODELS apply). Callers check
   * `discoverModels !== undefined` generically — no provider-id branching.
   */
  discoverModels?: (command: string) => Promise<readonly DiscoveredCliModel[]>;
  /**
   * Maps a model ID this provider used to store (e.g. a slug from before its
   * storage format changed) to the current native model value. Applied by
   * parseModelSelection so a selection saved under the old format keeps
   * working instead of being passed to the CLI verbatim and rejected.
   */
  legacyModelAliases?: Readonly<Record<string, string>>;
  /**
   * Build the CLI arguments. "text" mode must keep the
   * CLI read-only; "edit" mode may let it modify files in the working
   * directory (but not run arbitrary commands unapproved).
   */
  buildArgs(
    mode: CliRunMode,
    model: string | undefined,
    context?: CliBuildArgsContext
  ): string[];
  /**
   * True when the CLI's stdout is an event stream rather than the final
   * answer, and the answer must instead be read from a last-message temp
   * file. No shipped provider sets this — codex-cli was the last one and
   * moved to stdout capture via its `--json` event stream on 2026-08-11.
   *
   * The boolean and the fail-closed V1 gate it feeds
   * (cliProviderSupportsV1StdoutCapture → providerModeUnavailable) are
   * deliberately permanent: without the gate, a provider that answers via a
   * temp file would be reserved for V1 and feed banner text into
   * parseAiResultEnvelopeV1. The PLUMBING behind it (a `lastMessageFile`
   * buildArgs parameter, the file-read branch in normalizeCliOutput, the
   * temp-file creation in the legacy runner) was removed on 2026-08-14:
   * after codex-cli's move it was exercised only by synthetic tests, so the
   * first real temp-file provider would have run production code that had
   * never executed. A future provider that sets this flag must therefore
   * reintroduce that plumbing deliberately, with real coverage, rather than
   * inherit never-executed code — see docs/verification/known-gaps.md.
   */
  usesLastMessageFile: boolean;
  /**
   * Set when this CLI's stdout is a structured JSON-lines EVENT stream whose
   * non-error events embed arbitrary file contents (tool-read output,
   * previews, diffs). Names the schema rather than being a bare boolean
   * because the diagnostic extractor has to know the event shape, not merely
   * that one exists. Absent (the default) means "stdout is opaque text", and
   * failure diagnosis keeps scanning `${stderr}\n${stdout}` exactly as before.
   *
   * Why this exists: opencode's `run --format json` stream re-emits the full
   * text of every file the agent reads. Scanning that raw stream for
   * authErrorMarkers like "api key" / "login" / "authenticate" diagnoses an
   * authentication failure on any run that merely happened to read an
   * auth-related source file — observed live, where a mid-stream transport
   * drop was reported to the user as a Zen billing problem because the agent
   * had read a file whose prose mentioned an API key. See
   * extractStructuredCliDiagnostics in cliAgentRunner.ts. "cline" names the
   * analogous shape for Cline's `--json` NDJSON stream — verified live to
   * carry the SAME risk (its tool-call events re-emit full file/command
   * output verbatim) via a differently-shaped envelope (top-level
   * `{"type":"run_result",...,"text":...}` and `{"type":"error","message"}`
   * lines rather than opencode's `{"type":"error","error":{...}}"` — see
   * extractClineStructuredDiagnostics/extractClineFinalOutput.
   *
   * "codex" names Codex's `--json` JSONL stream: `{"type":"item.completed",
   * "item":{"type":"agent_message","text":...}}` for the final answer, with
   * failures arriving as `{"type":"error","message":...}` /
   * `{"type":"turn.failed","error":{"message":...}}` on STDOUT while stderr
   * stays empty (verified live against codex 0.147.0) — see
   * extractCodexFinalOutput/extractCodexStructuredDiagnostics.
   *
   * "claude" names Claude Code CLI's `--output-format stream-json` JSONL
   * stream: `{"type":"assistant","message":{"content":[{"type":"text",
   * "text":...}]}}` events for each turn of assistant output (last one wins
   * as the final answer), and a terminal `{"type":"result",...,"is_error":
   * boolean,"error":...}` event whose `is_error`/`error` fields carry
   * structured failure info (e.g. a rate-limit refusal) instead of only being
   * inferable from prose the way `--output-format text` left it — see
   * extractClaudeCliFinalOutput/extractClaudeCliStructuredDiagnostics.
   * NEEDS-TOOLCHAIN: this shape is built from Claude Code CLI's documented
   * event model, not yet confirmed live — see the doc comment on
   * ClaudeCliEnvelope in cliAgentRunner.ts.
   */
  structuredEventStream?: "opencode" | "cline" | "kimi" | "codex" | "claude";
  /**
   * Optional same-conversation recovery for a provider whose headless CLI
   * persists a failed turn and exposes a continuation flag. Unlike replaying
   * the original prompt, this deliberately preserves the provider's prior
   * context and any workspace edits it already made.
   */
  conversationResume?: CliConversationResumeDefinition;
  /**
   * Terminal command line(s) for the "Sign In" action. Run in a visible IDE
   * terminal so the provider's interactive login flow works. Validated
   * against the currently supported CLI version before being wired to a
   * button (loginHint text is evidence, not a contract). Last validated
   * 2026-07-17 against installed CLIs: codex 0.144.4 (binary exposes
   * `codex login` / `codex login status`), gemini 0.50.0 (interactive run
   * offers the LOGIN_WITH_GOOGLE auth flow), agy (interactive run performs
   * OAuth; no dedicated login subcommand), and kiro-cli kas 2.12.0 (its own
   * auth-error recovery action is `kiro-cli login`). Re-validate before
   * changing any signInCommand. Absent when the provider's sign-in is an
   * IN-SESSION flow instead — see signInAction.
   */
  signInCommand?: string;
  /**
   * Interactive sign-in flow for providers whose login surface is an
   * in-session slash command rather than a CLI subcommand (Claude Code's
   * `/login`): the CLI is launched in a visible IDE terminal and the slash
   * command is then sent into the running session — the same launch-then-
   * send dispatch the usage actions use, never a one-shot command line.
   * Takes precedence over signInCommand when present.
   */
  signInAction?: { launch: string; send: string; validated: "verified" | "unverified" };
  /**
   * Label for the sign-in action. "Sign in / Switch account" — re-running
   * the same sign-in flow while already authenticated is how a user switches
   * to a different account for CLIs with no dedicated logout/switch command.
   */
  signInLabel: string;
  /** Extra guidance shown alongside the sign-in action (e.g. Kiro's headless API-key requirement). */
  signInGuidance?: string;
  /**
   * Interactive usage/quota check for the "Check usage" action. These usage
   * surfaces are IN-SESSION slash commands, not CLI subcommands: the CLI is
   * launched in a visible IDE terminal (`launch`) and the slash command
   * (`send`) is then sent into the running session — never concatenated into
   * a one-shot command line. Absent when the CLI has no known usage surface;
   * the account entry then carries an "unsupported" usage capability
   * (disabled button with `usageUnsupportedReason` as its tooltip).
   * A descriptor still marked "unverified" is NOT wired to an automated
   * button: the account entry downgrades it to a "manual" capability that
   * shows the launch/slash instructions instead of sending the command —
   * verify it against the installed CLI, flip it to "verified", and the
   * button becomes automated.
   */
  usageAction?: { launch: string; send: string; validated: "verified" | "unverified" };
  /**
   * A one-shot, non-interactive usage/quota command line, for providers whose
   * usage surface can be queried in a single command rather than an
   * in-session slash command. Takes priority over `usageAction` when both are
   * set (no provider currently sets both). `shell`, when set, is the
   * integrated terminal's `shellPath` to launch with — needed when the
   * command's syntax (e.g. PowerShell-specific `$OutputEncoding` assignment
   * and backtick escapes) only parses correctly in a specific shell,
   * regardless of the user's own default integrated-terminal shell.
   */
  usageCommand?: { command: string; shell?: string };
  /** Why usage checking is unsupported, when usageAction is absent. */
  usageUnsupportedReason?: string;
  /**
   * The provider's own account/usage page, when unsupported usage checking
   * has a known one to send the user to instead (e.g. Kiro's account
   * dashboard). Absent when no such page is known — the button then stays
   * disabled rather than linking somewhere unconfirmed.
   */
  usageUnsupportedUrl?: string;
  /**
   * Set when this provider's runs are NOT constrained by the vendor's own
   * permission system, so enabling it carries a risk the other providers
   * don't. Surfaced next to the provider in Provider Selection, before the
   * user enables it — the point is that nobody turns this on without being
   * told what it does. Absent for every provider whose text and edit modes
   * both run under vendor-enforced permissions (the normal case).
   */
  permissionWarning?: string;
}

/**
 * Splits a stored model ID at its last "@" into a base model and a raw
 * suffix, or returns undefined for the suffix when there is no "@" (or it's
 * at index 0, meaning nothing precedes it — e.g. "@high" alone, which isn't
 * a valid "model@suffix" pair). Shared scaffold for every provider that
 * encodes reasoning-effort/variant info as a "model@suffix" qualified ID
 * (Codex, Copilot, Claude, opencode) — each still does its OWN validation
 * of what the suffix means (Codex/Copilot/Claude check the suffix against a
 * fixed known set and fall back to treating the whole string as the model
 * if it doesn't match; opencode has no fixed set to validate against since
 * each model declares its own variants, so it passes the suffix through
 * verbatim — see parseOpencodeModelSelection), only the split-and-empty-
 * suffix-handling mechanics are shared.
 */
function splitModelAtLastAt(
  model: string
): { model: string; suffix: string | undefined } {
  const separator = model.lastIndexOf("@");
  if (separator <= 0) {
    return { model, suffix: undefined };
  }
  return {
    model: model.slice(0, separator) || model,
    suffix: model.slice(separator + 1),
  };
}

const CODEX_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const COPILOT_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS = new Map<
  string,
  number
>([
  ["low", 1024],
  ["medium", 4096],
  ["high", 8192],
  ["xhigh", 16384],
  ["max", 32768],
]);

export interface ParsedCodexModelSelection {
  model: string | undefined;
  reasoningEffort: string | undefined;
  serviceTier: string | undefined;
}

export function parseCodexModelSelection(
  model: string | undefined
): ParsedCodexModelSelection {
  if (!model) {
    return {
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
    };
  }

  const split = splitModelAtLastAt(model);
  if (split.suffix === undefined) {
    return { model, reasoningEffort: undefined, serviceTier: undefined };
  }

  const [reasoningEffort, speedTier] = split.suffix.split("+", 2);
  if (!reasoningEffort || !CODEX_REASONING_EFFORTS.has(reasoningEffort)) {
    return { model, reasoningEffort: undefined, serviceTier: undefined };
  }

  return {
    model: split.model,
    reasoningEffort,
    serviceTier: speedTier === "fast" ? "priority" : undefined,
  };
}

export interface ParsedCopilotModelSelection {
  model: string | undefined;
  reasoningEffort: string | undefined;
  contextWindow?: string;
}

export function parseCopilotModelSelection(
  model: string | undefined
): ParsedCopilotModelSelection {
  if (!model) {
    return { model: undefined, reasoningEffort: undefined };
  }

  const split = splitModelAtLastAt(model);
  if (split.suffix === undefined) {
    return { model, reasoningEffort: undefined };
  }

  const [reasoningEffort, contextWindow] = split.suffix.split("+", 2);
  if (!reasoningEffort || !COPILOT_REASONING_EFFORTS.has(reasoningEffort)) {
    return { model, reasoningEffort: undefined };
  }

  return {
    model: split.model,
    reasoningEffort,
    ...(contextWindow === "long" ? { contextWindow: "long" } : {}),
  };
}

interface ParsedClaudeCliModelSelection {
  model: string | undefined;
  maxThinkingTokens: number | undefined;
}

function parseClaudeCliModelSelection(
  model: string | undefined
): ParsedClaudeCliModelSelection {
  if (!model) {
    return { model: undefined, maxThinkingTokens: undefined };
  }

  const split = splitModelAtLastAt(model);
  if (split.suffix === undefined) {
    return { model, maxThinkingTokens: undefined };
  }

  const maxThinkingTokens =
    CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS.get(split.suffix);
  if (maxThinkingTokens === undefined) {
    return { model, maxThinkingTokens: undefined };
  }

  return {
    model: split.model,
    maxThinkingTokens,
  };
}

/**
 * Cline's `--thinking` flag (verified live against cline 3.0.46 via
 * `cline --help` and a rejected `--thinking bogus` call, which errors with
 * `invalid thinking level "bogus" (expected "none", "low", "medium", "high",
 * or "xhigh")`): one fixed ladder applied uniformly to every model, unlike
 * opencode's per-model variant sets — so this is modeled the same way as
 * Codex/Copilot's fixed reasoning-effort ladders rather than opencode's
 * per-model discovery.
 */
const CLINE_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export interface ParsedClineModelSelection {
  model: string | undefined;
  reasoningEffort: string | undefined;
}

export function parseClineModelSelection(
  model: string | undefined
): ParsedClineModelSelection {
  if (!model) {
    return { model: undefined, reasoningEffort: undefined };
  }

  const split = splitModelAtLastAt(model);
  if (split.suffix === undefined || !CLINE_REASONING_EFFORTS.has(split.suffix)) {
    return { model, reasoningEffort: undefined };
  }

  return { model: split.model, reasoningEffort: split.suffix };
}

/**
 * Kimi's reasoning effort is NOT a CLI flag — `-m`/`--model` only ever
 * accepts a bare model alias (verified live: `-m "kimi-code/k3:low"` and
 * `-m "kimi-code/k3@low"` both fail with "Model ... is not configured in
 * config.toml"). It is instead an operational override read from the
 * `KIMI_MODEL_THINKING_EFFORT` environment variable at process start
 * (confirmed in kimi-code 0.29.2's own bundled source and by a live run:
 * KIMI_MODEL_THINKING_EFFORT=low/high both succeeded against `kimi-code/k3`,
 * =bogus 400'd from the API). So this returns a base model plus an effort
 * to be applied via CliProviderDefinition.buildEnv, not via buildArgs.
 *
 * Only K3 and K3-256k declare `support_efforts` (`kimi provider list
 * --json`); K2.7 Coding / K2.7 Coding Highspeed are `always_thinking` with
 * no effort ladder at all. This function does not special-case that per
 * model the way opencode's per-model variant sets require — the seeded/
 * discovered catalog in modelSelection.ts simply never attaches an
 * `@effort` suffix to a K2.7 model id, so the ambiguity does not arise from
 * the picker. A hand-typed `kimi-code/kimi-for-coding@low` custom id would
 * still parse here (the suffix is a fixed low/high/max ladder, not
 * model-aware) and be sent to the CLI regardless; that is an accepted,
 * narrow gap matching how legacyModelAliases/custom ids are handled
 * elsewhere in this file — the environment variable is documented as
 * ignored by models that don't support it, not rejected.
 *
 * The recognized ladder itself is KIMI_REASONING_EFFORTS_V1, imported from
 * cliModelDiscovery.ts so this parser and the discovery that PRODUCES these
 * suffixes share one constant rather than two copies that can drift. They
 * are two halves of one round trip: an effort discovery publishes but this
 * parser does not recognize would fall through to the `return { model, ... }`
 * below with the suffix still attached, sending `-m kimi-code/k3@medium` to
 * a CLI that rejects it.
 */

export interface ParsedKimiModelSelection {
  model: string | undefined;
  reasoningEffort: string | undefined;
}

export function parseKimiModelSelection(
  model: string | undefined
): ParsedKimiModelSelection {
  if (!model) {
    return { model: undefined, reasoningEffort: undefined };
  }

  const split = splitModelAtLastAt(model);
  if (split.suffix === undefined || !KIMI_REASONING_EFFORTS_V1.has(split.suffix)) {
    return { model, reasoningEffort: undefined };
  }

  return { model: split.model, reasoningEffort: split.suffix };
}

export interface ParsedOpencodeModelSelection {
  model: string | undefined;
  variant: string | undefined;
}

/**
 * Splits a stored opencode model ID into its base "<provider>/<model>" form
 * plus an optional "@<variant>" reasoning-effort suffix. Unlike Codex/Claude,
 * opencode has no single fixed set of valid variant names to validate
 * against — each model declares its own (verified live via `opencode models
 * --verbose`: e.g. "deepseek-v4-flash" has "high"/"max", "north-mini-code-
 * free" has "none"/"high", "gpt-5" has "minimal"/"low"/"medium"/"high"), so
 * whatever follows the last "@" is passed through verbatim as --variant
 * rather than checked against an allowlist. This is safe only because the
 * only source of `@variant`-suffixed IDs is parseOpencodeModelsOutput
 * (cliModelDiscovery.ts), which derives them from that same model's real
 * variants object — an unrecognized --variant value is silently ignored by
 * the CLI rather than rejected (verified live), so a hand-typed bad variant
 * would fail open (silently run without it) rather than error, which is why
 * this must never be reachable from free-text user input.
 */
export function parseOpencodeModelSelection(
  model: string | undefined
): ParsedOpencodeModelSelection {
  if (!model) {
    return { model: undefined, variant: undefined };
  }
  const split = splitModelAtLastAt(model);
  return { model: split.model, variant: split.suffix || undefined };
}

/**
 * Appended to Claude Code CLI's default system prompt for every headless
 * text-mode ("--permission-mode plan") run. Exported so
 * providerCliContracts.test.ts can assert on it without duplicating the
 * literal string. See the buildArgs comment where this is pushed for why
 * it's needed.
 */
export const CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT =
  "This is a non-interactive, headless run. The ExitPlanMode and " +
  "AskUserQuestion tools are not available in this session — do not " +
  "attempt to call them, and do not write your plan or any partial " +
  "output to a file (including anywhere under ~/.claude/plans). Instead, " +
  "write your complete plan, review, or answer directly as this " +
  "response's final text, including any open questions, decisions, or " +
  "assumptions inline in that text.";

/**
 * Fixed, extension-authored positional prompt argument for the Cline CLI.
 *
 * Cline has no true stdin-only prompt mode (verified live against cline
 * 3.0.46): `--json` with only piped stdin and no positional argument fails
 * with "JSON output mode requires a prompt argument or piped stdin
 * (interactive mode is unsupported)", and a literal "-" positional is
 * rejected outright ("Unknown command or unquoted prompt: -"). A prompt
 * *is* required as a positional argv element.
 *
 * That collides with two things every other CLI provider here relies on:
 *  1. Cline installs as an npm .cmd shim on Windows (confirmed:
 *     `%APPDATA%\npm\cline.cmd`), which — like opencode — needs
 *     `spawn(..., {shell:true})` to resolve at all (see the ENOENT note on
 *     runCliModelDiscovery in cliModelDiscovery.ts).
 *  2. `promptTransport: "argv"` requires `useShell: false` (enforced by
 *     execCliAgent as a hard failure, not just a convention) precisely
 *     because shell:true + an argv element built from arbitrary prompt
 *     content is a command-injection risk: the Windows quoting in
 *     execCliAgent only wraps space-containing args in double quotes, with
 *     no escaping of embedded quotes/metacharacters.
 *
 * Verified live that this is resolvable: piped stdin content is NOT ignored
 * just because a positional prompt is also present — it is merged into the
 * model's effective input and actually followed as an instruction (a stdin
 * payload of "Reply with exactly the single word: BANANA" produced exactly
 * "BANANA" even though the positional argument was a generic wrapper
 * sentence). So buildArgs pushes this FIXED string — never derived from user
 * content — as the positional argument, and the provider uses ordinary
 * `promptTransport: "stdin"` to deliver the real (possibly large, possibly
 * adversarial) prompt safely, with `useShell` left at its default `true` for
 * the .cmd shim to resolve. This gets Cline the same untruncated-length,
 * injection-safe stdin transport every other subscription CLI here uses,
 * despite Cline's own argv-only prompt contract.
 */
export const CLINE_CLI_ARGV_PROMPT_PLACEHOLDER =
  "Complete the task described in the piped input above.";

/**
 * The entire argv-borne prompt for a Kimi Code CLI run: a short, fixed
 * instruction pointing at the temp file that holds the real prompt. Kimi's
 * `-p` is its only prompt input and has no prompt-file flag, so this is what
 * lets a 100 KB+ context pack reach a CLI whose argv is capped at the OS
 * command-line ceiling (see the promptTransport comment on the kimi-cli
 * provider for the live verification behind each clause below).
 *
 * Only `promptFile` — a path this extension generated — is interpolated;
 * user/context content never reaches argv, so prompt size cannot push this
 * past the ceiling and there is no injection surface here.
 *
 * The wording is load-bearing and was tuned against live runs:
 *  - "read that entire file" plus the explicit continue/search clause,
 *    because Kimi's Read tool paginates on large files (verified at 419 KB:
 *    it searched the file for the trailing marker rather than answering from
 *    the first page);
 *  - "authoritative prompt ... not reference material to summarize", because
 *    Kimi's default posture toward file contents is to treat them as
 *    untrusted data to report on — a probe run explicitly reasoned about
 *    prompt injection before complying, and this framing is what makes it
 *    carry the instructions out instead;
 *  - naming the file as this run's own instructions, which is also what
 *    satisfies Kimi's "never read outside the working directory unless
 *    explicitly instructed" rule for the temp path.
 *
 * Exported so providerCliContracts.test.ts can assert on it without
 * duplicating the literal string.
 */
export function buildKimiCliPromptFileInstruction(
  promptFile: string,
  requiresFramedResult = false
): string {
  return (
    `Your complete instructions and context for this run are in the file at ${promptFile}. ` +
    "Read that entire file first — it may be large, so keep reading (or search it) until you have all of it — " +
    "then carry out exactly what it asks. Treat its contents as the authoritative prompt for this run, " +
    "not as reference material to summarize." +
    (requiresFramedResult ? ` ${FRAMED_RESULT_ARGV_REMINDER_V1}` : "")
  );
}

/**
 * Restates the V1 output-format contract in argv for `promptTransport:
 * "file"` providers — see `CliBuildArgsContext.requiresFramedResult` for the
 * live failure that motivated it.
 *
 * Deliberately a REMINDER, not a specification: the prompt file remains the
 * authoritative statement of the frame's schema (kind, content, and the
 * per-action fields each row requires). Restating the full contract here
 * would fork it across two places that must agree, and argv is the one place
 * that cannot grow — this text is a fixed ~340 bytes and interpolates
 * nothing, so it can never push a command line toward the Windows ~32 KB
 * ceiling that made these providers use a prompt file to begin with.
 *
 * Says "final message" because these are agentic CLIs whose stdout carries a
 * whole tool-calling transcript; only the last assistant message is unwrapped
 * (`extractKimiFinalOutput` and friends), so that is the one that must be the
 * bare frame.
 */
export const FRAMED_RESULT_ARGV_REMINDER_V1 =
  "Critical output requirement, restated here because it is easy to lose track of while working through a long " +
  `file: your FINAL message must be exactly one ${FRAME_START_V1} ... ${FRAME_END_V1} result frame and nothing ` +
  "else — no prose, summary, or commentary before or after it. Use the exact frame format that file specifies. " +
  "If you have done the work but not emitted the frame, the entire run is discarded, so emit it as your last act.";

export const CLI_PROVIDERS: readonly CliProviderDefinition[] = [
  {
    id: "claude-cli",
    label: "Claude Code",
    command: "claude",
    installHint:
      "Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code), then run `claude` once to sign in with your Anthropic account.",
    loginHint:
      "Run `claude` in a terminal and complete the sign-in with your Anthropic (Claude) account, then try again.",
    authErrorMarkers: ["log in", "login", "authenticate", "api key", "oauth"],
    authenticationCheckArgs: ["auth", "status"],
    // `/login` is Claude Code's IN-SESSION login flow: the CLI is launched
    // interactively and the slash command is then sent into the running
    // session (claude 2.1.209, validated 2026-07-17) — the same
    // launch-then-send dispatch as /usage, never a one-shot command line.
    // NOTE: /login alone does NOT switch accounts when a session is already
    // authenticated (confirmed 2026-07-19) — it just re-confirms the
    // existing session. Switching accounts requires running /logout first;
    // see signInGuidance.
    signInAction: { launch: "claude", send: "/login", validated: "verified" },
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Complete the Anthropic sign-in in the terminal. Already signed in as a different " +
      "account? Type /logout in the terminal first, then click Sign In again.",
    // One-shot, non-interactive usage check: `claude -p "/usage"` prints the
    // usage panel straight to stdout without opening an interactive session,
    // so this runs as a plain terminal command instead of the
    // launch-then-send interactive dispatch every other CLI's usage check
    // uses. The pipeline trims the response down to the panel itself
    // (dropping the trailing "What's contributing to my usage?" footer) and
    // forces UTF-8 output encoding so the panel's box-drawing characters
    // render correctly in the integrated terminal. Requires PowerShell
    // syntax (backtick escapes, $OutputEncoding), hence the explicit shell.
    usageCommand: {
      command:
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Host (((((claude -p \"/usage\") -join \"`n\") -split \"What's contributing\")[0].TrimEnd() -split \"`r?\\n\") -join \"`n`n\") \"`n`n`n\"",
      shell: "powershell.exe",
    },
    // Keep the provider-level fallback to CLI default only. Temporary picker
    // options are seeded separately until live loading is fixed.
    models: [
      {
        model: undefined,
        name: "Sonnet 5 (Default, recommended)",
      },
    ],
    usesLastMessageFile: false,
    structuredEventStream: "claude",
    buildArgs(mode, model): string[] {
      const parsedModel = parseClaudeCliModelSelection(model);
      // Edit mode keeps the original plain "text" output-format, unchanged —
      // only text (read-only, summary-extraction) mode moves to stream-json
      // below. Edit-mode runs are captured for their WORKSPACE FILE changes,
      // not for a parsed summary string, so there is nothing for a
      // structured event stream to buy there, and touching it would be an
      // unrelated behavior change outside this fix's scope.
      const args = ["-p", "--output-format", mode === "edit" ? "text" : "stream-json"];
      if (mode === "edit") {
        // Allow file edits in the workspace without per-edit prompts;
        // anything beyond edits (e.g. arbitrary shell) stays denied.
        args.push("--permission-mode", "acceptEdits");
      } else {
        // stream-json, NOT text — same motivation as kimi-cli's identical
        // move (see its own buildArgs comment): `text` mode's only failure
        // signal is prose, so a 429/rate-limit refusal is inferable only by
        // scanning the model's own free-form output for phrases, unlike
        // every other structuredEventStream provider here
        // (codex/cline/kimi/opencode), which all report failures via a
        // dedicated structured field. In stream-json mode, the terminal
        // `result` event's `is_error`/`error` fields are read structurally
        // by extractClaudeCliStructuredDiagnostics, and the last `assistant`
        // event's text is unwrapped by extractClaudeCliFinalOutput —
        // mirroring extractKimiFinalOutput/extractCodexFinalOutput's "last
        // message wins" shape. `--verbose` is required alongside `-p
        // --output-format stream-json` per Claude Code CLI's documented
        // print-mode contract.
        // NEEDS-TOOLCHAIN: neither flag combination nor the resulting event
        // shape has been confirmed against a live `claude` CLI invocation —
        // see the doc comment on ClaudeCliEnvelope in cliAgentRunner.ts.
        args.push("--verbose");
        // Text mode must stay read-only no matter what the invoking
        // workspace's own .claude/settings.json permits: omitting this flag
        // falls back to "default" permission mode, which still honors any
        // project-level "allow Edit/Write" rule already in effect for that
        // workspace (this extension's own repo included) — it is not a hard
        // deny. A model that then decides to "produce" a requested file
        // itself (via its own Write tool) instead of returning it as the
        // response text ends up overwriting the real target with a short
        // narrative summary instead of the generated content. "plan" forces
        // no-side-effect tool access regardless of those settings, matching
        // every other provider's text-mode contract (Codex `--sandbox
        // read-only`, Kiro `--trust-tools fs_read,grep,glob`).
        args.push("--permission-mode", "plan");
        // "plan" permission mode is Claude Code's interactive plan-approval
        // flow repurposed for a one-shot headless call. The model still
        // carries its baked-in system-prompt instructions to call
        // ExitPlanMode (present the plan for approval) and AskUserQuestion
        // (ask clarifying questions) — neither tool is offered under `-p`,
        // since both need an interactive UI. Verified live 2026-07-21
        // against claude 2.1.216 (`claude -p --permission-mode plan`, no
        // append-system-prompt): the model notices the mismatch, writes its
        // real answer to a scratch file under ~/.claude/plans/ instead of
        // the requested output, and returns only a short pointer/"tools
        // aren't available" note as the actual response text — which is
        // what this extension captures as the stage's result (e.g.
        // plan.md), so the task file ends up with that stub note instead of
        // real content. Re-verified with this flag added: the model stops
        // reaching for those tools and puts the full plan/review/answer
        // (including any open questions, inline) directly in the response
        // text instead.
        args.push(
          "--append-system-prompt",
          CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT
        );
      }
      if (parsedModel.model) {
        args.push("--model", parsedModel.model);
      }
      if (parsedModel.maxThinkingTokens !== undefined) {
        args.push(
          "--max-thinking-tokens",
          String(parsedModel.maxThinkingTokens)
        );
      }
      return args;
    },
  },
  {
    id: "codex-cli",
    label: "OpenAI Codex",
    command: "codex",
    installHint:
      "Install the Codex CLI (npm i -g @openai/codex), then run `codex login` to sign in with your ChatGPT account.",
    loginHint:
      "Run `codex login` in a terminal and sign in with your ChatGPT account, then try again.",
    authErrorMarkers: ["not logged in", "login", "authenticate", "api key"],
    authenticationCheckArgs: ["login", "status"],
    signInCommand: "codex login",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Sign in with your ChatGPT account in the terminal. Running Sign In again mostly " +
      "re-confirms the existing session rather than switching accounts; check the Codex " +
      "CLI docs for how to sign out first if you need a different account.",
    // `/status` is an in-session Codex TUI slash command that reports account
    // and usage information — preferred over `/usage` as the more complete,
    // more informative status view; launched interactively, then sent.
    usageAction: { launch: "codex", send: "/status", validated: "verified" },
    // Keep the provider-level fallback to CLI default only. The picker can
    // seed temporary model options elsewhere without changing runner
    // semantics here, and any unsupported custom ID can still be set
    // directly via "codex-cli:<model>" in settings.
    models: [{ model: undefined, name: "Codex (CLI default)" }],
    // Codex's final answer is read from its `--json` event stream, NOT from
    // `--output-last-message`. This flag is what gates V1 eligibility
    // (cliProviderSupportsV1StdoutCapture → openV1RunnerSelection), and
    // leaving it true is what silently excluded Codex from every V1 action:
    // the registry returned `providerModeUnavailable` at selection time and
    // fell through to a backup model, so Codex resolved, reported available,
    // and was enumerated in the picker while never actually being spawned —
    // zero tokens, no session file, no error. Codex satisfies AC-RUNNER-02
    // from stdout like every other structured-stream provider, so it must
    // stay false; see extractCodexFinalOutput.
    usesLastMessageFile: false,
    structuredEventStream: "codex",
    buildArgs(mode, model, context): string[] {
      const parsedModel = parseCodexModelSelection(model);
      // `--json` for the same reason kimi-cli uses `--output-format
      // stream-json`: Codex's human-readable stdout wraps the answer in a
      // banner ("OpenAI Codex v…", workdir/model header, a `user` echo of the
      // whole prompt, then `codex`, then a "tokens used" footer). V1 requires
      // the captured output to START with the frame marker, so that plain
      // mode cannot satisfy parseAiResultEnvelopeV1 no matter how well the
      // model complies. In `--json` mode the answer is its own
      // `agent_message` item and extracts cleanly.
      const args = ["exec", "--json", "--skip-git-repo-check", "--color", "never"];
      if (context?.cwd) {
        args.push("--cd", context.cwd);
      }
      // Always use Codex's sandbox. The extension must never opt into the
      // approvals-and-sandbox bypass for workspace implementation runs.
      args.push("--sandbox", mode === "edit" ? "workspace-write" : "read-only");
      if (parsedModel.model) {
        args.push("--model", parsedModel.model);
      }
      if (parsedModel.reasoningEffort) {
        args.push(
          "-c",
          `model_reasoning_effort="${parsedModel.reasoningEffort}"`
        );
      }
      if (parsedModel.serviceTier) {
        args.push("-c", `service_tier="${parsedModel.serviceTier}"`);
      }
      // Read the prompt from stdin.
      args.push("-");
      return args;
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    installHint:
      "Install the Gemini CLI (npm i -g @google/gemini-cli), then run `gemini` once to sign in with your Google account.",
    loginHint:
      "Run `gemini` in a terminal and complete the Google sign-in, then try again.",
    authErrorMarkers: ["login", "authenticate", "credentials", "api key"],
    signInCommand: "gemini",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Complete the Google sign-in in the terminal. If already signed in, use the /auth command inside the CLI to switch the auth method or account.",
    // Per the approved capability matrix the Gemini CLI's usage surface is
    // its in-session /stats slash command (model breakdown), not a /usage
    // command. Carried as "unverified" until re-confirmed against the
    // installed CLI version — which renders the Check usage button disabled
    // (see the "unverified always renders disabled" note below); flip to
    // "verified" after confirming in a terminal to automate the button.
    usageAction: { launch: "gemini", send: "/stats model", validated: "unverified" },
    models: [
      { model: undefined, name: "Gemini (CLI default)" },
      { model: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
    usesLastMessageFile: false,
    // Text mode passes no approval flag at all — verified 2026-07-20 against
    // gemini 0.51.0 by direct testing (trusted workspace, asked to write a
    // file) that this is genuinely read-only, not merely unconfigured:
    // headless gemini's default agent has no write_file/run_shell_command/
    // invoke_agent tools available at all ("is not available to this
    // agent"), and `--approval-mode auto_edit` (edit mode, below) is what
    // grants them — there is no separate flag to omit. No file was written.
    buildArgs(mode, model): string[] {
      const args: string[] = [];
      if (mode === "edit") {
        // Auto-approve edit tools only; shell commands still require
        // approval and are therefore skipped in non-interactive runs.
        args.push("--approval-mode", "auto_edit");
      }
      if (model) {
        args.push("--model", model);
      }
      return args;
    },
  },
  {
    id: "antigravity-cli",
    label: "Antigravity CLI",
    command: "agy",
    commandAliases: ["antigravity"],
    installHint:
      "Install the Antigravity CLI, then run `agy` (or `antigravity`) once to sign in with your Google account.",
    loginHint:
      "Run `agy` (or `antigravity`) in a terminal and complete the Google sign-in, then try again.",
    authErrorMarkers: ["login", "authenticate", "credentials", "api key"],
    signInCommand: "agy",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Complete the Google sign-in in the terminal. The CLI has no dedicated logout command; switching accounts may require clearing its stored credentials.",
    // `/usage` is an in-session Antigravity TUI slash command; launched
    // interactively, then sent. Not yet re-confirmed against an installed
    // binary in this environment (interactive CLI sessions can't be driven
    // headlessly here), so this stays "unverified" — the Check usage button
    // renders disabled rather than shipping a nonfunctional or misleading
    // manual-instructions action, following the same pattern as Gemini's
    // /stats (see the "unverified always renders disabled" note below).
    usageAction: { launch: "agy", send: "/usage", validated: "unverified" },
    // Keep the provider-level fallback to CLI default only. The picker seeds
    // temporary cached entries and still prefers live `agy models` results
    // when available.
    models: [{ model: undefined, name: "Antigravity (CLI default)" }],
    discoverModels: discoverAgyModels,
    // Model IDs used to be kebab-case slugs (e.g. "gemini-3.5-flash-medium")
    // before we learned `agy --model` only accepts its own display string
    // verbatim (see SEEDED_CLI_MODELS in modelSelection.ts). A selection
    // saved under the old slug would otherwise still be passed to `agy`
    // as-is and rejected with "invalid --model".
    legacyModelAliases: {
      "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
      "gemini-3.5-flash-high": "Gemini 3.5 Flash (High)",
      "gemini-3.5-flash-low": "Gemini 3.5 Flash (Low)",
      "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
      "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
      "claude-sonnet-4.6-thinking": "Claude Sonnet 4.6 (Thinking)",
      "claude-opus-4.6-thinking": "Claude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
    },
    usesLastMessageFile: false,
    // `agy --print` takes the prompt as its flag value, not stdin — the CLI
    // has no stdin-prompt mode at all: a bare `--print` with the prompt
    // piped over stdin makes its Go flag parser either error ("flag needs
    // an argument: -print") or, with `--print=true`, swallow the literal
    // string "true" as the prompt and ignore stdin entirely. `--print`
    // does accept a file path as its value (reads the file's contents as
    // the prompt), which avoids the OS argv-length ceiling a literal
    // `--print=<prompt>` value would hit on large context packs.
    promptTransport: "file",
    useShell: false,
    conversationResume: {
      // Production capture from five consecutive implementation runs on
      // 2026-07-29. This is agy's own --print timeout, not Ensemble's outer
      // process timeout.
      errorMarkers: ["error: timeout waiting for response"],
      continuationPrompt:
        "Continue the same task from where the previous response timed out. " +
        "Inspect the current workspace state and your existing changes first, then finish " +
        "the remaining requested work without restarting or reverting completed work. " +
        "Run the relevant verification and return the requested final summary.",
    },
    // Deliberate exception to the "text mode stays read-only" contract
    // above, in BOTH modes: headless `agy --print` auto-denies any tool call
    // whose permission it does not already hold and cannot prompt for
    // approval, so without this flag a run fails having done nothing at all.
    //
    // Re-verified 2026-07-20 against agy 1.1.4 by direct testing, in an
    // untrusted scratch directory and in a workspace listed under
    // ~/.gemini/antigravity-cli/settings.json's trustedWorkspaces. A bare
    // read_file of a file in the working directory was denied identically
    // under `--sandbox`, under `--mode plan`, and with no mode flag at all —
    // no mode flag loosens the permission gate, and workspace trust does not
    // either. `--sandbox` is terminal-restriction only (`agy --help`: "Run in
    // a sandbox with terminal restrictions enabled"), so it does not make a
    // text-mode run read-only; only this flag's absence would, and its
    // absence also makes the run useless. No broad grant exists either:
    // `permissions.allow` was tested as a path prefix
    // (`read_file(C:\<dir>)`), as a bare class grant (`read_file`), and as a
    // literal target (`read_file(<name>)`) — none granted the call.
    //
    // So unlike Codex's `--sandbox read-only`/`workspace-write` or Kiro's
    // `--trust-tools`, Antigravity exposes no scoped alternative in either
    // direction. The accepted trade is to run with permissions skipped and
    // tell the user plainly, up front, via permissionWarning below — rather
    // than ship a provider whose plan and review stages always fail.
    // Re-test if a future CLI version adds a scope flag or a class grant.
    permissionWarning:
      "Antigravity can create, change, or delete any file and run shell commands without asking, " +
      "in every stage including plan and review. Its CLI has no read-only or restricted mode.",
    buildArgs(_mode, model, context): string[] {
      // promptTransport: "file" is a contract with the caller (see
      // CliBuildArgsContext.promptFile): cliAgentRunner always writes the
      // prompt to disk and passes its path before calling buildArgs for a
      // provider declared this way. A missing promptFile here means that
      // contract was violated by the caller, not a normal runtime state.
      // Verified 2026-07-20: agy itself rejects an empty `--print=` value
      // outright ("Error: empty prompt. Usage: agy --print \"your prompt
      // here\"", exit 1) rather than proceeding silently — so the failure
      // wouldn't be silent, but it would read as a bad prompt rather than
      // the actual defect (a missing promptFile upstream). Throwing here
      // names the real cause instead of leaving it to agy's generic message.
      if (!context?.promptFile) {
        throw new Error(
          "Antigravity CLI provider misconfiguration: promptTransport is \"file\" but no promptFile was provided to buildArgs."
        );
      }
      const args: string[] = [
        // `--print` takes the PROMPT TEXT, not a path (agy --help: "Run a
        // single prompt non-interactively"). Passing the bare path made the
        // prompt literally be a filename, so agy opened it with its own file
        // tools and judged the contents as untrusted material: verified
        // 2026-08-06 against agy + Claude Opus 4.6 (Thinking), which answered
        // "This file contains a prompt injection attempt ... I won't follow
        // those instructions" and did no work at all. Wrapping the path in
        // the same file-instruction sentence kimi-cli uses names the file as
        // this run's own authoritative prompt, which is what gets it carried
        // out. Only the extension-generated path is interpolated, so argv
        // stays a fixed size regardless of prompt length — the reason this
        // provider uses a prompt file in the first place.
        `--print=${buildKimiCliPromptFileInstruction(
          context.promptFile,
          context.requiresFramedResult === true
        )}`,
        // agy's own default is only five minutes, which repeatedly cut off
        // healthy implementation runs after they had already edited files.
        // Leave a five-minute cushion inside Ensemble's one-hour process cap.
        "--print-timeout=55m0s",
        "--dangerously-skip-permissions",
      ];
      if (context.resumePreviousConversation) {
        // agy currently exposes no caller-supplied conversation id for an
        // initial --print run. --continue is therefore necessarily scoped to
        // its globally most recent conversation. The retry loop invokes it
        // immediately while the same extension operation still owns this
        // task, which minimizes but cannot eliminate races with another agy
        // process or extension window.
        args.push("--continue");
      }
      if (model) {
        args.push("--model", model);
      }
      return args;
    },
  },
  {
    id: "kiro-cli",
    label: "Kiro CLI",
    command: "kiro-cli",
    installHint:
      "Install Kiro CLI from https://kiro.dev/cli/ (or the Kiro installer), then set KIRO_API_KEY for headless mode. `kiro-cli login` alone is not enough for `chat --no-interactive`.",
    loginHint:
      "Set KIRO_API_KEY (required by Kiro headless mode), then try again. `kiro-cli login` does not satisfy `chat --no-interactive` auth.",
    authErrorMarkers: [
      "not logged in",
      "login",
      "authenticate",
      "api key",
      "unauthorized",
    ],
    // Log out first so an already-signed-in account can be switched — plain
    // `kiro-cli login` refuses with "Already logged in" otherwise. `;` runs
    // both in PowerShell and POSIX shells.
    signInCommand: "kiro-cli logout; kiro-cli login",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Logs out first so you can switch accounts. Headless mode additionally requires KIRO_API_KEY — `kiro-cli login` alone does not satisfy `chat --no-interactive` auth.",
    // One-shot, non-interactive usage check: piping "/usage" into
    // `kiro-cli chat` prints the usage panel without an interactive session.
    usageCommand: { command: 'echo "/usage" | kiro-cli chat' },
    promptTransport: "stdin",
    useShell: false,
    // Use stdin transport so large context packs are not constrained by
    // command-line argument limits. The provider definition keeps only the
    // CLI default; seeded and discovered picker choices live in modelSelection.
    models: [{ model: undefined, name: "Kiro (CLI default)" }],
    discoverModels: discoverKiroModels,
    usesLastMessageFile: false,
    buildArgs(mode, model): string[] {
      const args = ["chat", "--no-interactive"];
      if (mode === "edit") {
        args.push("--trust-all-tools");
      } else {
        args.push("--trust-tools", "fs_read,grep,glob");
      }
      if (model) {
        args.push("--model", model);
      }
      return args;
    },
  },
  {
    id: "opencode-cli",
    label: "OpenCode",
    command: "opencode",
    installHint:
      "Install OpenCode (npm i -g opencode-ai), then run `opencode`, use `/connect`, and connect the OpenCode Zen or OpenCode Go service you intend to use.",
    loginHint:
      "Run `opencode` in a terminal, use `/connect`, and connect the OpenCode service for this model, then try again.",
    loginHintForModel(model): string {
      if (model?.startsWith("opencode-go/")) {
        return (
          "OpenCode Go is unavailable to the current OpenCode account. Run `opencode` in a terminal, " +
          "use `/connect`, choose OpenCode Go, and paste the same OpenCode API key. Confirm that the Go subscription is active, then try again."
        );
      }
      if (model?.startsWith("opencode/")) {
        return (
          "OpenCode Zen is unavailable to the current OpenCode account. Run `opencode` in a terminal, " +
          "use `/connect`, choose OpenCode Zen, and paste the OpenCode API key. Confirm that Zen billing is enabled, then try again."
        );
      }
      return this.loginHint;
    },
    authErrorMarkers: [
      "not logged in",
      "login",
      "authenticate",
      "api key",
      "unauthorized",
      "no credentials",
      // Zen returns this exact JSON payload for an unentitled or missing
      // OpenCode service. Treat it like the 401 it carries so the error
      // includes the tier-specific `/connect` recovery instructions.
      "no provider available",
      "401",
    ],
    // OpenCode's documented connection flow is an in-session `/connect`
    // command. There is no non-interactive, tier-specific entitlement/status
    // command, so presence on PATH is the only safe headless check; the
    // Provider Selection rows below launch `/connect` with guidance for the
    // selected service.
    signInCommand: "opencode",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Run `/connect` in the OpenCode terminal and select either OpenCode Zen or OpenCode Go. " +
      "They share your OpenCode account/API key, but each service needs its own billing or subscription entitlement.",
    usageUnsupportedReason:
      "OpenCode has no non-interactive, tier-specific quota or entitlement status command. " +
      "Check Zen billing or the Go subscription in your OpenCode account; `opencode stats` only reports local observed usage.",
    // Model IDs are "<upstream-provider>/<model>" (e.g. "openai/gpt-4o",
    // "anthropic/claude-opus-4-8") — opencode's own namespacing, distinct
    // from this extension's "<CliProviderId>:<model>" qualified-ID prefix.
    // A discovered model may additionally carry a "@<variant>" suffix (e.g.
    // "opencode/deepseek-v4-flash@high") selecting one of that specific
    // model's own reasoning-effort variants — see parseOpencodeModelSelection.
    // No generic CLI-default picker option: an OpenCode default could point
    // at either Zen, Go, or an unrelated upstream provider, which would
    // defeat the explicit service choice this integration promises. Existing
    // saved `opencode-cli:default` selections still run for compatibility;
    // new choices are always a concrete model in one of the two tiers.
    models: [],
    discoverModels: discoverOpencodeModels,
    // The prompt is read from stdin when `run` is given no message argv
    // (verified live: `echo "..." | opencode run --format json -m ...`
    // answers correctly) — preferred over the argv-positional form so large
    // context packs aren't constrained by OS argv-length limits, matching
    // Kiro's and Claude's stdin transport.
    promptTransport: "stdin",
    // The final answer is embedded in the --format json event stream
    // (a "text"-typed part), not a separate last-message file — see
    // normalizeCliOutput's opencode-cli branch in cliAgentRunner.ts.
    usesLastMessageFile: false,
    // That same --format json stream also re-emits every file the agent reads,
    // so failure diagnosis must read only the stream's own "error" events and
    // never the raw stream — see extractStructuredCliDiagnostics. Note this
    // does NOT narrow authErrorMarkers below: a genuine opencode 401 arrives
    // exclusively as a stdout error event (opencode writes nothing to stderr,
    // verified across live runs covering success, bad model, missing
    // credentials and a real 401), and the extractor surfaces that event's
    // statusCode so the "401" marker below still matches it.
    structuredEventStream: "opencode",
    buildArgs(mode, model): string[] {
      const args = ["run", "--format", "json"];
      // Verified live against opencode 1.18.4 via `opencode agent list`:
      // "plan" is a primary agent whose permission set denies `edit` on
      // every path via a wildcard deny rule, followed by a MORE SPECIFIC
      // allow rule scoped to its own `.opencode/plans/*.md` (inside the
      // workspace) and the user's `~/.local/share/opencode/plans/*.md`.
      // "build" (the CLI's own default agent when --agent is omitted,
      // passed explicitly here anyway so the grant is a real, checkable
      // flag rather than an implicit default) allows `edit: *` outright.
      // Neither agent prompts interactively: `question`/`plan_enter`/
      // `plan_exit` permissions are "deny" by default for both, so a
      // headless run never blocks waiting for approval — confirmed by
      // direct testing (a `plan` run wrote no file; a `build` run wrote a
      // file with no prompt, in both cases with no hang).
      //
      // NOT fully verified: whether the plan agent's own system prompt
      // (not this permission grant) ever lets it actually reach that
      // .opencode/plans/*.md allow rule in a headless, non-interactive
      // `opencode run` call. Three different models (opencode/deepseek-v4-
      // flash-free, opencode/mimo-v2.5-free, and one attempt with --auto
      // added) were each directly instructed to call the write tool for
      // that exact path and every one refused at the text level without
      // ever attempting the tool call — consistent with "plan mode" being
      // baked into the agent's own prompt as a hard refusal independent of
      // the permission grant, but not conclusive proof the grant is
      // unreachable by a more compliant model or a future opencode
      // version. Treat plan-mode as read-only for ordinary workspace files
      // (nothing tested ever wrote outside .opencode/plans/), but do not
      // treat the .opencode/plans/*.md exception as provably inert.
      //
      // --auto (bypass-all) is deliberately never used: unlike Antigravity,
      // opencode's normal permission system already grants exactly what
      // each mode needs headlessly, so there is no reason to skip it.
      args.push("--agent", mode === "edit" ? "build" : "plan");
      const parsedModel = parseOpencodeModelSelection(model);
      if (parsedModel.model) {
        args.push("--model", parsedModel.model);
      }
      if (parsedModel.variant) {
        args.push("--variant", parsedModel.variant);
      }
      return args;
    },
  },
  {
    id: "cline-cli",
    label: "Cline CLI",
    command: "cline",
    installHint:
      "Install the Cline CLI (npm i -g cline), then run `cline auth cline-pass` to sign in with ClinePass.",
    loginHint:
      "Run `cline auth cline-pass` in a terminal and complete the ClinePass sign-in, then try again.",
    // Best-effort list, NOT verified against a real unauthenticated cline
    // run: this dev environment's `cline` CLI was already signed in, and
    // deliberately signing it out to observe a genuine auth failure would
    // disrupt the user's real session/credentials. Matches the union of
    // markers used by the other multi-upstream-provider CLIs (Kiro,
    // OpenCode) rather than a narrower guess. Re-verify and narrow/widen
    // once a real unauthenticated failure is observed.
    authErrorMarkers: [
      "not logged in",
      "login",
      "authenticate",
      "api key",
      "unauthorized",
      "401",
      "no credentials",
    ],
    // `cline auth cline-pass` is a genuine one-shot CLI subcommand (not an
    // in-session slash command) that drives an OAuth flow in the terminal —
    // verified via `cline auth --help` (`auth [options] [provider]`, with
    // `provider` documented as "positional shorthand for -p"). Matches
    // Codex's `codex login` terminal pattern rather than Claude's
    // launch-then-send /login pattern.
    signInCommand: "cline auth cline-pass",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Completes ClinePass sign-in in the terminal (an OAuth flow opens in your browser). " +
      "Running Sign In again is how you switch accounts.",
    // No non-interactive auth-status subcommand was found in `cline --help`
    // (unlike Claude's `auth status` / Codex's `login status`), so
    // authenticationCheckArgs is left unset, same as Gemini/Antigravity.
    usageUnsupportedReason:
      "Cline CLI has no non-interactive usage/quota command — check ClinePass usage and " +
      "billing on the Cline dashboard.",
    usageUnsupportedUrl: "https://app.cline.bot/dashboard/subscription",
    // Deliberate exception to the "text mode stays read-only" contract, in
    // BOTH modes — verified live against cline 3.0.46: a run given --plan
    // and directly instructed to call its run_commands tool to create a
    // file DID create the file. --plan only changes the system prompt fed
    // to the model ("Plan Mode: Do NOT edit files... run_commands is for
    // read-only purposes") — it does not gate the tool itself, which stays
    // available and auto-approved. Confirmed the alternative is unusable
    // rather than safer: `--auto-approve false` blocks EVERY tool
    // (including plain file reads) in headless mode with a graceful but
    // fatal "requires interactive approval" error, since there is no TTY to
    // grant that approval — so, like Antigravity, there is no scoped
    // read-only mode to fall back to in either direction.
    permissionWarning:
      "Cline can create, change, or delete any file and run shell commands without asking, " +
      "in every stage including plan and review. Its CLI has no read-only or restricted mode.",
    promptTransport: "stdin",
    // Keep the provider-level fallback to the account's own default model
    // only (mirroring Claude/Codex/Gemini). The full ClinePass catalog,
    // including every reasoning-effort variant, is seeded in
    // modelSelection.ts's SEEDED_CLI_MODELS the same way Claude/Codex seed
    // theirs — cline has no `cline models`-style listing subcommand to
    // discover live from, so there is no discoverModels function either.
    models: [{ model: undefined, name: "ClinePass (account default)" }],
    usesLastMessageFile: false,
    structuredEventStream: "cline",
    buildArgs(mode, model): string[] {
      const parsedModel = parseClineModelSelection(model);
      // The mode flag is pushed right after --json (verified live that
      // cline's option parser doesn't care about flag order) specifically so
      // it is never the last flag before the positional prompt placeholder
      // below — a flag immediately followed by a non-flag token reads as
      // "takes that token as its value" to this repo's own doc-consistency
      // check (permissionFlagText in securityDocsFlagConsistency.test.ts),
      // which would otherwise misread --plan as taking the whole placeholder
      // sentence as its argument. -P/-m/--thinking (pushed after the mode
      // flag below) already guarantee that separation regardless.
      const args = ["--json"];
      if (mode === "edit") {
        // Explicit even though it's the CLI's own default (verified live) —
        // defense against a future cline version flipping that default,
        // matching Codex's always-explicit --sandbox flag.
        args.push("--auto-approve", "true");
      } else {
        args.push("--plan");
      }
      // Deliberately no --cwd argv flag: execCliAgent always spawns with
      // `cwd` set as a real spawn() option (not a shell-parsed argument),
      // which is what actually determines the child process's working
      // directory — verified live that Cline correctly resolves its own
      // working directory from that alone, with no --cwd flag at all.
      // Passing the workspace path through argv on top of that would gain
      // nothing while adding a real risk on a shell:true spawn (useShell
      // stays at its default true here, for the Windows .cmd shim — see
      // CLINE_CLI_ARGV_PROMPT_PLACEHOLDER's doc comment): execCliAgent's
      // Windows quoting only wraps space-containing args in bare double
      // quotes, with no escaping of shell metacharacters, so a workspace
      // path containing one (e.g. "Bob & Co" on Windows, or a POSIX path
      // containing `;`/`|`) could be misparsed or, worse, alter the shell
      // command actually run.
      // Always the ClinePass provider tier — see the module doc comment on
      // why this integration doesn't expose Cline's other (API-key) upstream
      // providers.
      args.push("-P", "cline-pass");
      if (parsedModel.model) {
        args.push("-m", parsedModel.model);
      }
      if (parsedModel.reasoningEffort) {
        args.push("--thinking", parsedModel.reasoningEffort);
      }
      // See CLINE_CLI_ARGV_PROMPT_PLACEHOLDER's doc comment: this fixed
      // string is the required positional prompt argument; the real prompt
      // is delivered via stdin (promptTransport above) instead.
      args.push(CLINE_CLI_ARGV_PROMPT_PLACEHOLDER);
      return args;
    },
  },
  {
    id: "kimi-cli",
    label: "Kimi Code CLI",
    command: "kimi",
    installHint:
      "Install Kimi Code CLI via the official installer (macOS/Linux: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`; " +
      "Windows PowerShell: `irm https://code.kimi.com/kimi-code/install.ps1 | iex`), then run `kimi login` to sign in. " +
      "Do NOT install via `npm install -g @moonshot-ai/kimi-code` — that produces a Windows .cmd shim that this integration " +
      "cannot safely drive (its only prompt-input mode requires shell:false; see the buildArgs comment below), while the " +
      "official installer places a native `kimi` executable on PATH instead.",
    loginHint:
      "Run `kimi login` in a terminal and complete the device-code sign-in with your Moonshot AI / Kimi account, then try again.",
    // Best-effort list, NOT verified against a real unauthenticated `kimi`
    // run: this dev environment's CLI was already signed in via a prior
    // session, and deliberately signing out to observe a genuine auth
    // failure would disrupt the user's real credentials (same caution as
    // cline-cli above). Matches the union of markers used by the other
    // multi-model CLI providers here rather than a narrower guess.
    authErrorMarkers: [
      "not logged in",
      "login",
      "authenticate",
      "api key",
      "unauthorized",
      "401",
    ],
    // A genuine one-shot CLI subcommand (verified via `kimi --help`'s
    // Commands list), not an in-session slash command — matches Codex's
    // `codex login` / Cline's `cline auth cline-pass` terminal pattern.
    signInCommand: "kimi login",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Completes the Kimi Code OAuth device-code sign-in in the terminal. Whether re-running this while " +
      "already authenticated switches accounts or just re-confirms the existing session was not verified live " +
      "(this environment's CLI was already signed in) — check the terminal output after running it.",
    usageUnsupportedReason:
      "Kimi Code CLI has no non-interactive usage/quota subcommand (verified against its full `--help` command " +
      "list: export, provider, acp, web, doctor, vis, migrate, upgrade — no usage/status command among them). " +
      "Check usage and billing on your Moonshot AI / Kimi Code account.",
    // Deliberate exception to the "text mode stays read-only" contract, in
    // BOTH modes, and worse than Antigravity's/Cline's: verified live
    // against kimi-code 0.29.2 that a bare `kimi -p "..."` (no flags at all)
    // both wrote a file and ran an arbitrary shell command without any
    // approval prompt, and that `-p`/`--prompt` rejects ALL of `--plan`,
    // `--yolo`, AND `--auto` outright (each its own OptionConflictError,
    // e.g. "error: Cannot combine --prompt with --plan.", exit code 1/2) —
    // so unlike Antigravity/Cline, there isn't even an unenforced
    // permission *flag* of any kind to pass for a one-shot run; every `-p`
    // invocation runs identically regardless of the extension's own
    // text/edit mode distinction (see buildArgs below).
    permissionWarning:
      "Kimi Code can create, change, or delete any file and run shell commands without asking, " +
      "in every stage including plan and review. Its CLI has no read-only or restricted mode.",
    // Verified live (kimi-code 0.29.2, `kimi -p "..."` with piped stdin and
    // no `--output-format` flag): stdin content is NEVER read in prompt
    // mode — the model reported "no stdin content arrived" even with a
    // clear instruction piped in. `-p`/`--prompt` is the CLI's ONLY prompt
    // input mechanism, and it has no `--prompt-file`-style flag that reads
    // the prompt from disk the way Antigravity's `--print=<path>` does
    // (verified against `kimi --help`).
    //
    // That combination previously forced `promptTransport: "argv"`, which
    // capped the prompt at the OS single-command-line ceiling (~32,767
    // chars on Windows) and made every real context pack fail outright with
    // cliPromptTooLarge — a 118 KB pack against a 20 KB cap. This provider
    // now uses "file" transport WITHOUT a native prompt-file flag instead:
    // the runner writes the full prompt to a temp file (mode 0600) and
    // buildArgs passes only a short, fixed instruction telling Kimi to read
    // that path. Kimi is an agentic CLI whose own Read/search tools then
    // pull the content in, so the argv ceiling stops applying to prompt
    // size entirely.
    //
    // Verified live end to end against kimi-code 0.29.2 before shipping:
    //  - it reads a temp file OUTSIDE the workspace (its system prompt
    //    forbids that "unless explicitly instructed", and the instruction
    //    below is what explicitly instructs it — this is the one soft,
    //    model-judgment-dependent link in the chain);
    //  - it EXECUTES the file's instructions rather than merely summarizing
    //    them (a probe task told it to create a file; the file was created);
    //  - it retrieves content from the very END of a 419 KB file, larger
    //    than any real context pack — when the Read tool paginates, it
    //    searches the file rather than answering from the first page alone.
    //
    // The models' own context windows were never the constraint: every Kimi
    // model reports maxContextSize 262144+ (one is 1048576) via `kimi
    // provider list --json`, and a 118 KB prompt is ~30K tokens.
    //
    // "file" transport still requires useShell: false (enforced by
    // execCliAgent), which is why the native-installer executable is
    // required over an npm .cmd shim — see installHint.
    promptTransport: "file",
    useShell: false,
    // Model IDs are "<alias>" values straight out of `kimi provider list
    // --json`'s "models" map (e.g. "kimi-code/k3") — verified live that a
    // bare "k3" is rejected ("Model \"k3\" is not configured in
    // config.toml") while the full alias works. No CLI default fallback
    // entry is offered: unlike providers whose CLI silently uses its own
    // default when `-m` is omitted, Kimi's config.toml already pins a
    // `default_model`, and the extension has no way to discover what that
    // is without an account-specific query — every choice is therefore a
    // concrete model. Reasoning-effort selection (K3/K3-256k support
    // low/high/max) is wired via `buildEnv` below, not a CLI flag — see
    // parseKimiModelSelection's doc comment for why. K2.7 Coding / K2.7
    // Coding Highspeed have no effort ladder at all (`always_thinking`
    // capability, no `support_efforts` field) — thinking is always on for
    // those two, and the seeded/discovered catalog never attaches an
    // `@effort` suffix to either.
    models: [],
    discoverModels: discoverKimiModels,
    usesLastMessageFile: false,
    // Kimi's `--output-format stream-json` stdout is an NDJSON message
    // stream, not the final answer — see extractKimiFinalOutput, and the
    // buildArgs comment for why plain `text` mode is unusable here. Like
    // opencode's and cline's streams it also re-emits tool input/output
    // (Kimi's `{"role":"tool",...}` lines carry whatever files it read), so
    // failure diagnosis must not scan the raw stream for auth markers.
    structuredEventStream: "kimi",
    // Kimi is by far the slowest provider here — live-timed at ~10 minutes
    // for a plan review in `text` mode and ~18 minutes for the same work in
    // stream-json, against Ensemble's one-hour process cap. That makes a
    // timed-out or dropped run disproportionately expensive: without this,
    // the whole 100 KB+ prompt is replayed from scratch and every minute of
    // model work (and quota) already spent is discarded.
    //
    // Declaring conversationResume changes that in two ways (cliAgentRunner):
    //  - the RUN_TIMEOUT_MS path keys off `def.conversationResume !== undefined`
    //    alone, so Ensemble's own timeout becomes retry-eligible instead of a
    //    dead failure; and
    //  - the retry then re-invokes with `--continue` and sends only
    //    continuationPrompt rather than the original prompt, deliberately
    //    preserving any partial workspace edits (the resume path skips the
    //    clean-snapshot precondition for exactly this reason).
    //
    // errorMarkers is deliberately EMPTY. Antigravity carries one because its
    // own "error: timeout waiting for response" text was observed live; no
    // equivalent Kimi-owned recoverable diagnostic has been observed yet.
    // Every Kimi failure captured so far is terminal and NOT resumable — a
    // rejected model alias ("Model ... is not configured in config.toml"), a
    // rejected thinking effort ("provider.api_error: 400"), a missing session
    // ("Session ... not found") — so inventing a marker would trade a clean
    // failure for a pointless second full-length run. The timeout path above
    // needs no marker, which is where the real value is. Add a marker here
    // only after observing a genuine recoverable one in a real run.
    conversationResume: {
      errorMarkers: [],
      continuationPrompt:
        "Continue the same task from where the previous response stopped. Your earlier " +
        "context, including the instructions file you already read, is still in this " +
        "conversation — do not re-read it from scratch unless you need a specific detail. " +
        "Inspect the current workspace state and any changes you already made first, then " +
        "finish the remaining requested work without restarting or reverting completed work. " +
        "Emit the required final result frame exactly as originally instructed.",
    },
    buildEnv(model): Record<string, string> | undefined {
      const { reasoningEffort } = parseKimiModelSelection(model);
      return reasoningEffort
        ? { KIMI_MODEL_THINKING_EFFORT: reasoningEffort }
        : undefined;
    },
    buildArgs(_mode, model, context): string[] {
      // mode is deliberately NOT branched on for a permission flag here —
      // unlike every other provider in this file. Verified live against
      // kimi-code 0.29.2 that `-p`/`--prompt` rejects ALL THREE of
      // `--yolo`, `--auto`, AND `--plan` outright (each throws its own
      // OptionConflictError, e.g. "Cannot combine --prompt with --yolo.",
      // exit code 1) — confirmed both live and in the CLI's own bundled
      // source (dist/main.mjs's buildPromptModeOptions validation). So
      // there is no flag of any kind this integration can pass alongside
      // `-p` for either mode: edit mode gets the exact same args as text
      // mode, both already running with full unattended tool access (see
      // permissionWarning above).
      //
      // promptTransport: "file" is a contract with the caller (see
      // CliBuildArgsContext.promptFile): cliAgentRunner always writes the
      // prompt to disk and passes its path before calling buildArgs for a
      // provider declared this way. A missing promptFile means that
      // contract was violated upstream — throw naming the real cause rather
      // than sending Kimi an instruction pointing at "undefined", which it
      // would report as a confusing missing-file error instead.
      if (!context?.promptFile) {
        throw new Error(
          "Kimi Code CLI provider misconfiguration: promptTransport is \"file\" but no promptFile was provided to buildArgs."
        );
      }
      // stream-json, NOT text — this is load-bearing, see
      // extractKimiFinalOutput in cliAgentRunner.ts. Kimi narrates before it
      // answers ("• The file is large. Let me page through it in chunks.")
      // and indents the answer; in `text` mode that prose is concatenated
      // ahead of the model's real reply, which makes a V1-migrated action's
      // strict envelope parse fail (parseAiResultEnvelopeV1 rejects any
      // bytes before the frame marker) even when the model answered
      // perfectly. Verified live both ways: `text` mode produced a valid,
      // correct review that still settled as malformedResult, while
      // stream-json's last assistant message is the frame exactly — starting
      // with the start marker and ending with the end marker, no
      // surrounding text.
      const args = ["--output-format", "stream-json"];
      if (context.resumePreviousConversation) {
        // Verified live against kimi-code 0.29.2 that `--continue` is
        // accepted alongside `-p` (unlike `--yolo`/`--auto`/`--plan`, which
        // it rejects outright) and genuinely restores context: a second run
        // recalled a codeword from the first without it being restated, and
        // reported the same session_id.
        //
        // Safer than Antigravity's equivalent: Kimi scopes --continue to the
        // WORKING DIRECTORY ("No sessions to continue under <cwd>; starting
        // a fresh session."), not to its globally most recent conversation,
        // and execCliAgent always spawns with the task's workspace as cwd —
        // so a concurrent Kimi run under a different workspace cannot be
        // continued by mistake. Its no-session fallback is also graceful
        // (fresh session, exit 0) rather than an error.
        args.push("--continue");
      }
      // -m takes only the bare model alias — a trailing "@effort" suffix is
      // rejected outright (verified live), so it must be split off here.
      // The effort itself reaches the CLI via buildEnv's
      // KIMI_MODEL_THINKING_EFFORT, not argv; see parseKimiModelSelection.
      const parsedModel = parseKimiModelSelection(model);
      if (parsedModel.model) {
        args.push("-m", parsedModel.model);
      }
      // The ONLY argv-borne prompt text is this short, fixed instruction —
      // never the user's own prompt — so nothing here scales with context
      // size. It must directly follow "-p" to be read as that flag's value.
      args.push(
        "-p",
        buildKimiCliPromptFileInstruction(context.promptFile, context.requiresFramedResult === true)
      );
      return args;
    },
  },
  {
    // devpass-code (verified live, v1.17.13) is a rebrand/fork of OpenCode:
    // identical subcommand surface (`run`, `models`, `providers`, `agent
    // list`), identical --format json event-stream shape, and its `plan`
    // agent's permission rules still carry the literal OpenCode path
    // `.opencode\plans\*.md` verbatim in its one edit-allow exception. It
    // fronts a single "LLM Gateway DevPass" API-key credential (`devpass-code
    // providers list`) rather than OpenCode's per-service Zen/Go split, so
    // this is a normal single-account entry — no ProviderAccountId split
    // needed, unlike opencode-cli above.
    id: "devpass-cli",
    label: "devpass-code",
    command: "devpass-code",
    installHint:
      "Install devpass-code, then run `devpass-code providers login` and connect the LLM Gateway DevPass credential.",
    loginHint:
      "Run `devpass-code providers login` in a terminal and complete the LLM Gateway DevPass sign-in, then try again.",
    // Not verified against a genuine unauthenticated run (this environment's
    // CLI was already signed in) — matches the union of markers used by the
    // other OpenCode-shaped/multi-model CLI providers here.
    authErrorMarkers: [
      "not logged in",
      "login",
      "authenticate",
      "api key",
      "unauthorized",
      "no credentials",
      "no provider available",
      "401",
    ],
    // `devpass-code providers login` is a genuine one-shot CLI subcommand
    // (verified via `devpass-code providers --help`), not an in-session
    // slash command like OpenCode's `/connect`.
    signInCommand: "devpass-code providers login",
    signInLabel: "Sign in / Switch account",
    signInGuidance:
      "Completes the LLM Gateway DevPass sign-in in the terminal. Whether re-running this while already " +
      "authenticated switches accounts or just re-confirms the existing session was not verified live " +
      "(this environment's CLI was already signed in) — check the terminal output after running it.",
    usageUnsupportedReason:
      "devpass-code has no non-interactive quota/entitlement command — `devpass-code stats` only reports " +
      "local observed token/cost totals, not remaining LLM Gateway DevPass quota. Check usage on the LLM " +
      "Gateway DevPass account directly.",
    // Model IDs are "llmgateway-devpass/<model>" (verified live via
    // `devpass-code models`), devpass-code's own namespacing — every model
    // in the catalog is served through this single upstream account, unlike
    // OpenCode's per-model distinct upstream providers. A discovered model
    // may carry a "@<variant>" suffix selecting one of that model's own
    // reasoning-effort variants, reusing parseOpencodeModelSelection — the
    // suffix scheme is identical, verified via `devpass-code models
    // --verbose`.
    models: [],
    discoverModels: discoverDevpassModels,
    // Verified live: `echo "..." | devpass-code run --format json -m ...`
    // answers correctly, matching OpenCode's stdin transport.
    promptTransport: "stdin",
    // The final answer is embedded in the --format json event stream (a
    // "text"-typed part), identical to OpenCode — see structuredEventStream
    // below and normalizeCliOutput's opencode-cli branch in
    // cliAgentRunner.ts, which keys off that tag value, not the provider ID.
    usesLastMessageFile: false,
    structuredEventStream: "opencode",
    // Without this, an `edit`-mode run that hits Ensemble's own timeout is a
    // DEAD failure: cliAgentRunner's edit-retry gate keys off
    // `def.conversationResume !== undefined`, so devpass rounds recorded
    // "Automatic retry is disabled for devpass-code edit runs: its CLI
    // protocol does not guarantee edit events are flushed before side
    // effects" and stopped there (workflow 5 run 045, 2026-08-17). That was
    // the correct default while resume was unverified — replaying an edit run
    // from scratch can duplicate side effects — but it left devpass with zero
    // completed implementation rounds and no way to recover a timeout.
    //
    // Verified live 2026-08-18 against devpass-code 1.18.11 (three checks,
    // all in `run` + `--agent plan`, no interactive mode):
    //  1. `-c, --continue` is accepted by `run` and documented as "continue
    //     the last session";
    //  2. it genuinely restores context — a second run recalled a codeword
    //     from the first without it being restated;
    //  3. it is scoped to the WORKING DIRECTORY — the same `--continue` from
    //     a different cwd found no session and answered "NO CODEWORD".
    //
    // (3) is the safety property that makes this sound: a retry can only ever
    // resume the conversation belonging to the task's own workspace, never
    // some unrelated session that happened to run last. Same guarantee Kimi
    // relies on above.
    //
    // errorMarkers is deliberately EMPTY, for the same reason as Kimi's: no
    // devpass-owned recoverable diagnostic has been observed in a real run
    // yet, and the value here is the timeout path, which needs no marker.
    // Add one only after seeing a genuine recoverable error live.
    conversationResume: {
      errorMarkers: [],
      continuationPrompt:
        "Continue the same task from where the previous response stopped. Your earlier " +
        "context, including any files you already read, is still in this conversation — " +
        "do not re-read everything from scratch unless you need a specific detail. " +
        "Inspect the current workspace state and any changes you already made first, then " +
        "finish the remaining requested work without restarting or reverting completed work. " +
        "Emit the required final result frame exactly as originally instructed.",
    },
    buildArgs(mode, model, context): string[] {
      const args = ["run", "--format", "json"];
      if (context?.resumePreviousConversation) {
        // See conversationResume above for the live verification. Continues
        // the last session for THIS cwd; the retry sends only
        // continuationPrompt, so prior partial edits are preserved rather
        // than replayed.
        args.push("--continue");
      }
      // Verified live against devpass-code 1.17.13 via `devpass-code agent
      // list` (re-confirmed present on 1.18.11): "plan" carries the same
      // wildcard edit-deny plus a narrow .opencode/plans- and
      // ~/.local/share/devpass-code/plans-scoped allow exception as
      // OpenCode's plan agent; "build" (the CLI's own default agent) allows
      // `edit: *` outright. Directly tested: a `plan` run asked to write a
      // file refused and wrote nothing; a `build` run asked to write the same
      // file wrote it immediately with no prompt.
      args.push("--agent", mode === "edit" ? "build" : "plan");
      const parsedModel = parseOpencodeModelSelection(model);
      if (parsedModel.model) {
        args.push("--model", parsedModel.model);
      }
      if (parsedModel.variant) {
        args.push("--variant", parsedModel.variant);
      }
      return args;
    },
  },
];

export function getCliProvider(
  id: string
): CliProviderDefinition | undefined {
  return CLI_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Capability descriptor for a provider account action (sign-in, usage
 * check). This union is the single source of truth for BOTH the UI button
 * state and the dispatch behavior — the settings webview renders each kind
 * differently and the message handler dispatches on the same value:
 *
 *  - "terminal": run a command line in a visible IDE terminal (the CLI
 *    providers' login subcommands / OAuth flows). `validated` records
 *    against which CLI version the command was last confirmed; "unverified"
 *    means the command follows the CLI's documented conventions but has not
 *    been confirmed against an installed binary — re-validate before
 *    relying on it.
 *  - "interactive": LAUNCH the provider's interactive CLI in a visible IDE
 *    terminal, then SEND an in-session slash command into it (usage panels
 *    like `/usage` and `/stats` only exist inside the running session —
 *    they are not CLI subcommands and must never be concatenated into a
 *    one-shot command line).
 *  - "vscode-command": invoke a VS Code command. Copilot auth is VS
 *    Code-native — its account is the GitHub account VS Code itself is
 *    signed into — so its sign-in must NEVER be a shell command; it goes
 *    through the sign-in candidate list, with the Accounts-menu candidate
 *    list as the fallback when nothing on the primary list is registered
 *    (e.g. the Copilot extension is not installed). See
 *    `ProviderSignInAction`'s own doc comment for why sign-in uses candidate
 *    lists instead of a single command.
 *  - "manual": no runnable command exists, but there is a documented manual
 *    path — the button stays enabled and shows `instructions` (opening
 *    `url` when present) instead of executing anything.
 *  - "unsupported": no known command or manual path. When `url` is present
 *    (a known usage/account page for the provider), the button stays
 *    enabled and opens it instead of running anything; otherwise the button
 *    renders disabled with `reason` as its explanatory tooltip.
 */
export type ProviderActionCapability =
  | { kind: "terminal"; command: string; validated: "verified" | "unverified"; shell?: string }
  | { kind: "interactive"; launch: string; send: string; validated: "verified" | "unverified" }
  | { kind: "vscode-command"; command: string; fallbackCommand?: string }
  | { kind: "manual"; instructions: string; url?: string }
  | { kind: "unsupported"; reason: string; url?: string };

/**
 * Sign-in actions are a DISTINCT union from `ProviderActionCapability`, not
 * an alias — every member matches except "vscode-command". Command IDs for
 * VS Code-native sign-in (Copilot) drift across Copilot/Copilot Chat
 * releases and across the supported `engines.vscode` range (^1.93 -> current
 * stable): the command that used to start sign-in can stop being registered
 * on a newer build, and the Accounts-menu fallback has already renamed once
 * (`workbench.action.showAccounts` -> `workbench.action.manageAccounts`
 * around VS Code 1.106). Both the primary and fallback are therefore ORDERED
 * CANDIDATE LISTS, newest-first: dispatch tries each candidate in order and
 * runs the first one that is actually registered ("first registered
 * candidate wins"), so covering a future rename is a one-line append instead
 * of a breaking rename of this type. The usage capability keeps the old
 * single-command shape untouched — it has no equivalent drift problem today
 * and splitting this union means extending sign-in's candidate lists can
 * never break usage dispatch.
 */
export type ProviderSignInAction =
  | { kind: "terminal"; command: string; validated: "verified" | "unverified" }
  | { kind: "interactive"; launch: string; send: string; validated: "verified" | "unverified" }
  | { kind: "vscode-command"; commands: readonly string[]; fallbackCommands: readonly string[] }
  | { kind: "manual"; instructions: string; url?: string }
  | { kind: "unsupported"; reason: string; url?: string };

/**
 * One provider-account row in the settings UI: every CLI provider plus
 * GitHub Copilot, which is not a CLI runner (it uses the VS Code Language
 * Model API) but still belongs in Provider Selection and gets account
 * controls. Copilot is enabled by default — see isProviderEnabled.
 */
export interface ProviderAccountEntry {
  id: ProviderAccountId;
  label: string;
  signInLabel: string;
  signIn: ProviderSignInAction;
  signInGuidance?: string;
  /** Usage/quota check capability — always present, "unsupported" when no path exists. */
  usage: ProviderActionCapability;
  /** True when the provider is enabled unless explicitly disabled. */
  enabledByDefault: boolean;
  /**
   * Carried through from the CLI definition so Provider Selection can show
   * it before the user enables the provider. Absent for providers whose
   * runs are constrained by the vendor's own permission system.
   */
  permissionWarning?: string;
}

/**
 * Move the "antigravity-cli" entry (if present) to the end of the list,
 * preserving the relative order of everything else. Antigravity is the only
 * provider with a permission model loose enough to need its own warning
 * (see its permissionWarning above) — listing it last keeps that warning
 * from reading as if it applies to the providers around it.
 */
function reorderAntigravityLast<T extends { id: string }>(entries: readonly T[]): T[] {
  const index = entries.findIndex((entry) => entry.id === "antigravity-cli");
  if (index === -1) {
    return [...entries];
  }
  const antigravity = entries[index]!;
  return [...entries.slice(0, index), ...entries.slice(index + 1), antigravity];
}

/**
 * Move the "devpass-cli" entry (if present) to the front of the list,
 * preserving the relative order of everything else — devpass-code leads
 * Provider Selection. Applied after reorderAntigravityLast, so Antigravity
 * still ends up last.
 */
function reorderDevpassFirst<T extends { id: string }>(entries: readonly T[]): T[] {
  const index = entries.findIndex((entry) => entry.id === "devpass-cli");
  if (index === -1) {
    return [...entries];
  }
  const devpass = entries[index]!;
  return [devpass, ...entries.slice(0, index), ...entries.slice(index + 1)];
}

export const PROVIDER_ACCOUNT_ENTRIES: readonly ProviderAccountEntry[] = reorderDevpassFirst([
  {
    id: "copilot",
    label: "GitHub Copilot",
    signInLabel: "Sign in / Switch account",
    // Never a shell command — Copilot auth is VS Code-native. Candidate
    // lists, newest-first, first REGISTERED one wins (see
    // ProviderSignInAction's doc comment for why this is a list, not a
    // single ID). Verified against VS Code 1.129 + current Copilot Chat;
    // supported range is engines.vscode ^1.93.
    signIn: {
      kind: "vscode-command",
      commands: [
        // Current Copilot Chat's sign-in entry point (observed VS Code 1.129).
        "github.copilot.chat.triggerPermissiveSignIn",
        // Legacy Copilot sign-in command, kept for older Copilot builds that
        // still register it.
        "github.copilot.signIn",
      ],
      fallbackCommands: [
        // Current Accounts-menu command (VS Code >= ~1.106).
        "workbench.action.manageAccounts",
        // Legacy Accounts-menu command; no longer registered on current
        // stable but kept for older VS Code within the supported range.
        "workbench.action.showAccounts",
      ],
    },
    signInGuidance:
      "Copilot models inside VS Code use the GitHub account VS Code itself is signed into. Switch accounts from the Accounts menu if needed.",
    // Per the approved capability matrix Copilot usage is UNSUPPORTED: no
    // CLI or VS Code command reports Copilot quota. Because a `url` is set
    // below, the button stays enabled and opens GitHub's Copilot settings
    // page instead of executing anything.
    usage: {
      kind: "unsupported",
      reason:
        "No command reports Copilot quota — check usage on GitHub under Settings → Copilot (github.com/settings/copilot).",
      url: "https://github.com/settings/copilot",
    },
    enabledByDefault: true,
  },
  {
    id: OPENCODE_ZEN_ACCOUNT_ID,
    label: "OpenCode Zen",
    signInLabel: "Connect OpenCode Zen",
    signIn: { kind: "interactive", launch: "opencode", send: "/connect", validated: "verified" },
    signInGuidance:
      "In the terminal, select OpenCode Zen and complete the connection with your OpenCode API key. " +
      "Zen uses the shared OpenCode account/key, but requires Zen billing. Only `opencode/...` models use this row.",
    usage: {
      kind: "unsupported",
      reason:
        "OpenCode does not expose a non-interactive Zen billing or remaining-usage check. " +
        "Check Zen billing in your OpenCode account; `opencode stats` is only local observed usage.",
    },
    enabledByDefault: false,
  },
  {
    id: OPENCODE_GO_ACCOUNT_ID,
    label: "OpenCode Go",
    signInLabel: "Connect OpenCode Go",
    signIn: { kind: "interactive", launch: "opencode", send: "/connect", validated: "verified" },
    signInGuidance:
      "In the terminal, select OpenCode Go and paste the same OpenCode API key. " +
      "Go requires an active Go subscription. Only `opencode-go/...` models use this row; enabling Zen does not enable Go.",
    usage: {
      kind: "unsupported",
      reason:
        "OpenCode does not expose a non-interactive Go subscription or remaining-usage check. " +
        "Confirm the Go subscription in your OpenCode account; `opencode stats` is only local observed usage.",
    },
    enabledByDefault: false,
  },
  // Antigravity is deliberately moved to the very end of the list (see
  // reorderAntigravityLast below): its permissionWarning explicitly names
  // Antigravity and is only meaningful when it's the last row, immediately
  // followed by the account-selection controls — otherwise the warning
  // could visually read as applying to the providers listed after it too.
  ...reorderAntigravityLast(
    CLI_PROVIDERS.filter((provider) => provider.id !== "opencode-cli").map((provider): ProviderAccountEntry => ({
    id: provider.id,
    label: provider.label,
    signInLabel: provider.signInLabel,
    // Sign-in dispatch: an in-session flow (Claude's /login) launches the
    // CLI and then sends the slash command; every other CLI runs its
    // validated login command line in a visible terminal.
    signIn: provider.signInAction
      ? {
          kind: "interactive",
          launch: provider.signInAction.launch,
          send: provider.signInAction.send,
          validated: provider.signInAction.validated,
        }
      : {
          kind: "terminal",
          // Every CLI provider defines exactly one of signInAction /
          // signInCommand; the bare interactive run is the documented
          // fallback if a definition ever carries neither.
          command: provider.signInCommand ?? provider.command,
          validated: provider.signInCommand ? "verified" : "unverified",
        },
    signInGuidance: provider.signInGuidance,
    // Usage dispatch: only a VERIFIED in-session descriptor is automated OR
    // even offered as a manual fallback. An "unverified" in-session slash
    // command (e.g. Gemini's `/stats`, Antigravity's `/usage`) has not been
    // confirmed to actually work inside the CLI's TUI — shipping it as an
    // enabled "manual instructions" button would tell the user to try a
    // command that may not exist, with no way to know it failed. Per the
    // approved capability matrix: "If the retry still fails, leave the
    // button disabled and document the unsupported behavior instead of
    // shipping a nonfunctional action." So "unverified" always renders a
    // DISABLED button (kind "unsupported", no url) until the command is
    // confirmed against the installed CLI and flipped to "verified".
    usage: provider.usageCommand
      ? {
          kind: "terminal",
          command: provider.usageCommand.command,
          validated: "verified",
          ...(provider.usageCommand.shell ? { shell: provider.usageCommand.shell } : {}),
        }
      : provider.usageAction
      ? provider.usageAction.validated === "verified"
        ? {
            kind: "interactive",
            launch: provider.usageAction.launch,
            send: provider.usageAction.send,
            validated: provider.usageAction.validated,
          }
        : {
            kind: "unsupported",
            reason:
              `Checking ${provider.label} usage from here has not been verified against the installed CLI ` +
              `(this would launch \`${provider.usageAction.launch}\` and send \`${provider.usageAction.send}\`, ` +
              `but that is unconfirmed) — check usage directly in the ${provider.label} CLI or app instead.`,
          }
      : {
          kind: "unsupported",
          reason:
            provider.usageUnsupportedReason ??
            "No usage/quota command is known for this provider — check usage on the provider's own site or app.",
          ...(provider.usageUnsupportedUrl ? { url: provider.usageUnsupportedUrl } : {}),
        },
    enabledByDefault: false,
    ...(provider.permissionWarning
      ? { permissionWarning: provider.permissionWarning }
      : {}),
    }))
  ),
]);

export function getProviderAccountEntry(
  id: string
): ProviderAccountEntry | undefined {
  return PROVIDER_ACCOUNT_ENTRIES.find((entry) => entry.id === id);
}

/**
 * A provider's label for splicing into messages that themselves append
 * " CLI" (e.g. "... CLI failed", "Could not start the ... CLI"). Some
 * labels already end in "CLI" (Gemini CLI, Antigravity CLI, Kiro CLI) and
 * would otherwise double up into "Gemini CLI CLI failed"; others (Claude
 * Code, OpenAI Codex) don't and are returned unchanged.
 */
export function cliDisplayLabel(def: CliProviderDefinition): string {
  return def.label.replace(/\s+CLI$/i, "");
}

export interface ParsedModelSelection {
  provider: ProviderId;
  /** Provider-native model name; undefined means the provider's default. */
  model: string | undefined;
}

/**
 * Parse a stored stage model ID into provider + native model name.
 * Bare IDs (no recognized provider prefix) are Copilot model IDs — the
 * pre-provider storage format.
 */
export function parseModelSelection(
  modelId: string | undefined
): ParsedModelSelection {
  if (!modelId) {
    return { provider: "copilot", model: undefined };
  }
  const separator = modelId.indexOf(":");
  if (separator > 0) {
    const prefix = modelId.substring(0, separator);
    const rest = modelId.substring(separator + 1);
    if (prefix === "copilot") {
      return { provider: "copilot", model: rest || undefined };
    }
    const cliDef = getCliProvider(prefix);
    if (cliDef) {
      const model =
        rest === "default" || rest === ""
          ? undefined
          : (cliDef.legacyModelAliases?.[rest] ?? rest);
      return { provider: prefix as CliProviderId, model };
    }
  }
  return { provider: "copilot", model: modelId };
}

/**
 * Resolve the Provider Selection row that governs a stored model ID.
 *
 * `opencode-cli` remains the one execution adapter and storage prefix for
 * compatibility, but its native model namespace identifies the OpenCode
 * service that will actually bill and authorize the request. Only the
 * `opencode/` and `opencode-go/` namespaces are those services; other
 * OpenCode CLI namespaces are external upstream providers and must not be
 * misrepresented as Zen. Keeping this mapping next to storage parsing
 * prevents runner guards, model filtering, and the settings UI from each
 * guessing a tier differently.
 */
export function providerAccountIdForModelId(
  modelId: string | undefined
): ProviderAccountId {
  const parsed = parseModelSelection(modelId);
  if (parsed.provider !== "opencode-cli") {
    return parsed.provider;
  }
  if (parsed.model?.startsWith("opencode-go/")) {
    return OPENCODE_GO_ACCOUNT_ID;
  }
  if (parsed.model?.startsWith("opencode/")) {
    return OPENCODE_ZEN_ACCOUNT_ID;
  }
  // Retain the legacy adapter ID for saved external-provider selections.
  // It deliberately has no visible Provider Selection row: new picker
  // choices are limited to the explicitly supported Zen/Go services.
  return "opencode-cli";
}

/** Build the qualified model ID stored in settings/task files. */
export function toQualifiedModelId(
  provider: CliProviderId,
  model: string | undefined
): string {
  return `${provider}:${model ?? "default"}`;
}

/**
 * Rewrite a stored qualified model ID to its current canonical form,
 * resolving legacyModelAliases so every consumer agrees on the same ID for
 * the same model — not just the execution path (which already applies the
 * alias inside parseModelSelection), but also callers like the settings
 * webview that match a stored ID against getAvailableModels() by exact
 * string. Without this, a selection saved under a provider's old ID format
 * still runs correctly but shows as "Unknown model" and resets to default
 * the next time settings are saved. Copilot/bare IDs have no alias table
 * and are returned unchanged.
 *
 * Overloaded so a defined `string` input (including `""`) is known to
 * produce a defined `string` output: the `if (!modelId)` branch returns
 * `modelId` itself unchanged (`""` stays `""`, a string), and every other
 * branch returns a real provider/qualified-ID string — only an `undefined`
 * input round-trips to `undefined`. Without this a caller with a
 * guaranteed-defined id still has to write a dead `?? id` fallback to
 * satisfy the type checker.
 */
export function normalizeQualifiedModelId(modelId: string): string;
export function normalizeQualifiedModelId(
  modelId: string | undefined
): string | undefined;
export function normalizeQualifiedModelId(
  modelId: string | undefined
): string | undefined {
  if (!modelId) {
    return modelId;
  }
  const parsed = parseModelSelection(modelId);
  if (parsed.provider === "copilot") {
    return modelId;
  }
  return toQualifiedModelId(parsed.provider, parsed.model);
}

/**
 * Reconstruct the fully qualified, canonical `<provider>:<model>` form of
 * whichever model actually produced an AgentRunResult, so it can be compared
 * directly against stage-config backup entries (a run whose stage-wrapped
 * runner silently substituted a backup reports that backup, not the requested
 * model). Two things a naive `${runnerId}:${modelId}` join gets wrong, both
 * handled here:
 *
 *  - An absent `modelId` from a CLI runner means the provider's own default
 *    model ran (see parseModelSelection's "default" mapping) — a real,
 *    nameable model (e.g. "opencode-cli:default"), which several providers
 *    ship as a seeded backup entry.
 *  - A present `modelId` may be the post-alias-resolution name rather than the
 *    raw string a backup entry is stored under; normalizeQualifiedModelId (the
 *    same helper the settings webview uses) resolves both sides to one form.
 *
 * Copilot's stored ids have no alias table and are returned as reported
 * (bare); a Copilot result reporting no `modelId` can't be reconstructed and
 * returns undefined. Shared by every stage cascade that dedupes or attributes
 * runs by the model that truly ran (reviewActions' review cascade,
 * draftTaskWithAI's Description cascade).
 */
export function qualifiedRanModelId(result: {
  runnerId: string;
  modelId?: string;
}): string | undefined {
  if (getCliProvider(result.runnerId)) {
    return normalizeQualifiedModelId(
      toQualifiedModelId(result.runnerId as CliProviderId, result.modelId)
    );
  }
  return result.modelId;
}
