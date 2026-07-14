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
 *
 * Model IDs are stored as "<provider>:<model>" (e.g. "claude-cli:sonnet",
 * "gemini-cli:default"). Bare IDs with no known provider prefix are Copilot
 * model IDs, which keeps existing saved configurations working unchanged.
 */

import {
  discoverAgyModels,
  discoverKiroModels,
  type DiscoveredCliModel,
} from "../utils/cliModelDiscovery";

export type CliProviderId =
  | "claude-cli"
  | "codex-cli"
  | "gemini-cli"
  | "antigravity-cli"
  | "kiro-cli";
export type ProviderId = "copilot" | CliProviderId;

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
   *
   * lastMessageFile is only set for providers with usesLastMessageFile,
   * and receives the path of a temp file the CLI should write its final
   * message to.
   */
  buildArgs(
    mode: CliRunMode,
    model: string | undefined,
    lastMessageFile: string | undefined,
    context?: CliBuildArgsContext
  ): string[];
  /**
   * True when the CLI's stdout is an event stream rather than the final
   * answer, and the answer must instead be read from lastMessageFile.
   */
  usesLastMessageFile: boolean;
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

  const separator = model.lastIndexOf("@");
  if (separator <= 0) {
    return { model, reasoningEffort: undefined, serviceTier: undefined };
  }

  const selection = model.slice(separator + 1);
  const [reasoningEffort, speedTier] = selection.split("+", 2);
  if (!reasoningEffort || !CODEX_REASONING_EFFORTS.has(reasoningEffort)) {
    return { model, reasoningEffort: undefined, serviceTier: undefined };
  }

  return {
    model: model.slice(0, separator) || undefined,
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

  const separator = model.lastIndexOf("@");
  if (separator <= 0) {
    return { model, reasoningEffort: undefined };
  }

  const selection = model.slice(separator + 1);
  const [reasoningEffort, contextWindow] = selection.split("+", 2);
  if (!reasoningEffort || !COPILOT_REASONING_EFFORTS.has(reasoningEffort)) {
    return { model, reasoningEffort: undefined };
  }

  return {
    model: model.slice(0, separator) || undefined,
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

  const separator = model.lastIndexOf("@");
  if (separator <= 0) {
    return { model, maxThinkingTokens: undefined };
  }

  const reasoningEffort = model.slice(separator + 1);
  const maxThinkingTokens =
    CLAUDE_REASONING_EFFORT_TO_MAX_THINKING_TOKENS.get(reasoningEffort);
  if (maxThinkingTokens === undefined) {
    return { model, maxThinkingTokens: undefined };
  }

  return {
    model: model.slice(0, separator) || undefined,
    maxThinkingTokens,
  };
}

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
    // Keep the provider-level fallback to CLI default only. Temporary picker
    // options are seeded separately until live loading is fixed.
    models: [
      {
        model: undefined,
        name: "Sonnet 5 (Default, recommended)",
      },
    ],
    usesLastMessageFile: false,
    buildArgs(mode, model): string[] {
      const parsedModel = parseClaudeCliModelSelection(model);
      const args = ["-p", "--output-format", "text"];
      if (mode === "edit") {
        // Allow file edits in the workspace without per-edit prompts;
        // anything beyond edits (e.g. arbitrary shell) stays denied.
        args.push("--permission-mode", "acceptEdits");
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
    // Keep the provider-level fallback to CLI default only. The picker can
    // seed temporary model options elsewhere without changing runner
    // semantics here, and any unsupported custom ID can still be set
    // directly via "codex-cli:<model>" in settings.
    models: [{ model: undefined, name: "Codex (CLI default)" }],
    usesLastMessageFile: true,
    buildArgs(mode, model, lastMessageFile, context): string[] {
      const parsedModel = parseCodexModelSelection(model);
      const args = ["exec", "--skip-git-repo-check", "--color", "never"];
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
      if (lastMessageFile) {
        args.push("--output-last-message", lastMessageFile);
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
    models: [
      { model: undefined, name: "Gemini (CLI default)" },
      { model: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { model: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
    usesLastMessageFile: false,
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
    buildArgs(mode, model, _lastMessageFile, context): string[] {
      const args: string[] = [`--print=${context?.promptFile ?? ""}`];
      if (mode === "edit") {
        args.push("--dangerously-skip-permissions");
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
];

export function getCliProvider(
  id: string
): CliProviderDefinition | undefined {
  return CLI_PROVIDERS.find((provider) => provider.id === id);
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
 */
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
