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
  /** How the prompt is passed to the CLI. Defaults to stdin. */
  promptTransport?: "stdin" | "argv";
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
    lastMessageFile: string | undefined
  ): string[];
  /**
   * True when the CLI's stdout is an event stream rather than the final
   * answer, and the answer must instead be read from lastMessageFile.
   */
  usesLastMessageFile: boolean;
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
    // Keep the provider-level fallback to CLI default only. Temporary picker
    // options are seeded separately until live loading is fixed.
    models: [{ model: undefined, name: "Claude (CLI default)" }],
    usesLastMessageFile: false,
    buildArgs(mode, model): string[] {
      const args = ["-p", "--output-format", "text"];
      if (mode === "edit") {
        // Allow file edits in the workspace without per-edit prompts;
        // anything beyond edits (e.g. arbitrary shell) stays denied.
        args.push("--permission-mode", "acceptEdits");
      }
      if (model) {
        args.push("--model", model);
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
    // Keep the provider-level fallback to CLI default only. The picker can
    // seed temporary model options elsewhere without changing runner
    // semantics here, and any unsupported custom ID can still be set
    // directly via "codex-cli:<model>" in settings.
    models: [{ model: undefined, name: "Codex (CLI default)" }],
    usesLastMessageFile: true,
    buildArgs(mode, model, lastMessageFile): string[] {
      const args = ["exec", "--skip-git-repo-check", "--color", "never"];
      // exec is non-interactive; the sandbox policy is what limits writes.
      args.push("--sandbox", mode === "edit" ? "workspace-write" : "read-only");
      if (model) {
        args.push("--model", model);
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
    usesLastMessageFile: false,
    promptTransport: "stdin",
    useShell: false,
    buildArgs(mode, model): string[] {
      const args: string[] = [];
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
    // command-line argument limits.
    // Keep the provider-level fallback to CLI default only. Temporary picker
    // options are seeded separately until live loading is fixed.
    models: [{ model: undefined, name: "Kiro (CLI default)" }],
    usesLastMessageFile: false,
    buildArgs(mode): string[] {
      const args = ["chat", "--no-interactive"];
      if (mode === "edit") {
        args.push("--trust-all-tools");
      } else {
        args.push("--trust-tools", "read,grep");
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
    if (getCliProvider(prefix)) {
      return {
        provider: prefix as CliProviderId,
        model: rest === "default" || rest === "" ? undefined : rest,
      };
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
