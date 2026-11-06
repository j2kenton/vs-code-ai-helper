/**
 * review1 Step 45 (first slice): which commands an owner-evidence card may offer to run for the owner, and how
 * their output is cleaned before it is recorded.
 *
 * The commands come from review text, so the list is deliberately narrow and everything is matched exactly:
 *   - a known provider CLI with `--version` / `--help` (or `-v` / `-h`), or with a `list` / `status` subcommand
 *     (`claude --version`, `codex mcp list`, `opencode status`);
 *   - `git status`, `git log` or `git diff`, with only read-only flags and plain paths or revisions.
 * Anything else (a shell metacharacter, a flag that can write, an unknown program, extra words) is not offered.
 * Nothing here runs a command; the card shows {@link AllowlistedCommandV1.display} and runs it only after the
 * owner confirms in the chat.
 */

export interface AllowlistedCommandV1 {
  readonly executable: string;
  readonly args: readonly string[];
  /** The command exactly as it will run, for the confirmation line. */
  readonly display: string;
}

/** The longest a confirmed command may run. */
export const OWNER_EVIDENCE_COMMAND_TIMEOUT_MS_V1 = 60_000;

/** The registered command behind the "Run it for me" option. */
export const RUN_OWNER_EVIDENCE_COMMAND_V1 = "vs-code-ai-helper.runOwnerEvidenceCommandV1";

/** review1 Step 50: "I ran it — record the result" (commands/recordOwnerRunCommandV1.ts). */
export const RECORD_OWNER_RUN_COMMAND_V1 = "vs-code-ai-helper.recordOwnerRunCommandV1";

const PROVIDER_CLIS_V1: ReadonlySet<string> = new Set(["claude", "codex", "gemini", "copilot", "opencode", "agy", "cline"]);
const INFO_FLAGS_V1: ReadonlySet<string> = new Set(["--version", "-v", "-V", "--help", "-h"]);
const LISTABLE_NOUNS_V1: ReadonlySet<string> = new Set([
  "mcp",
  "models",
  "model",
  "plugin",
  "plugins",
  "extensions",
  "skills",
  "agents",
  "sessions",
  "auth",
  "config",
]);
const READ_ONLY_LAST_WORD_RE = /^(?:list|ls|status|version)$/;
const GIT_SUBCOMMANDS_V1: ReadonlySet<string> = new Set(["status", "log", "diff"]);
const GIT_FLAGS_V1: ReadonlySet<string> = new Set([
  "--short",
  "-s",
  "-sb",
  "-b",
  "--branch",
  "--porcelain",
  "--stat",
  "--name-only",
  "--name-status",
  "--oneline",
  "--no-color",
  "--cached",
  "--staged",
]);
const GIT_COUNT_FLAG_RE = /^-(?:n)?\d{1,3}$/;
const GIT_PLAIN_ARG_RE = /^[A-Za-z0-9_@^~][A-Za-z0-9_./@^~-]*$/;
/** Characters a shell would act on, or that quote or continue a command. */
const SHELL_SYNTAX_RE = /[;&|<>$`\\(){}[\]*?!"'#\r\n\t]/;

/**
 * The command in `candidate` when it is on the read-only allowlist, otherwise undefined. `candidate` is one
 * command line with nothing around it (no backticks, no prompt).
 */
export function parseAllowlistedCommandV1(candidate: string): AllowlistedCommandV1 | undefined {
  const text = candidate.trim();
  if (text.length === 0 || text.length > 200 || SHELL_SYNTAX_RE.test(text)) {
    return undefined;
  }
  const tokens = text.split(/ +/);
  const executable = tokens[0]!;
  const args = tokens.slice(1);
  if (args.length === 0) {
    return undefined;
  }
  if (executable === "git") {
    return isAllowlistedGitV1(args) ? { executable, args, display: text } : undefined;
  }
  if (!PROVIDER_CLIS_V1.has(executable)) {
    return undefined;
  }
  if (args.length === 1 && INFO_FLAGS_V1.has(args[0]!)) {
    return { executable, args, display: text };
  }
  // `<cli> status`, or `<cli> <noun> list|ls|status`. A verb before the last word (`codex exec ls`) is not a noun.
  const last = args[args.length - 1]!;
  if (READ_ONLY_LAST_WORD_RE.test(last)) {
    if (args.length === 1) {
      return { executable, args, display: text };
    }
    if (args.length === 2 && LISTABLE_NOUNS_V1.has(args[0]!)) {
      return { executable, args, display: text };
    }
  }
  return undefined;
}

function isAllowlistedGitV1(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !GIT_SUBCOMMANDS_V1.has(subcommand)) {
    return false;
  }
  return rest.every((arg) => {
    if (arg.startsWith("-")) {
      return GIT_FLAGS_V1.has(arg) || GIT_COUNT_FLAG_RE.test(arg);
    }
    // A plain path or revision: relative, no "..", nothing that could name a file outside the workspace.
    return GIT_PLAIN_ARG_RE.test(arg) && !arg.includes("..");
  });
}

/** The first allowlisted command quoted in backticks in `text` (an owner-evidence request), if any. */
export function findAllowlistedCommandInTextV1(text: string): AllowlistedCommandV1 | undefined {
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const parsed = parseAllowlistedCommandV1(match[1]!);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

const SECRET_PATTERNS_V1: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // A long opaque run that mixes upper case, lower case and digits. Paths (they carry "/" or "."), plain words
  // and commit hashes (hex only, no upper case) are left alone.
  /\b(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}(?=\s|$)/g,
];
const SECRET_ASSIGNMENT_RE = /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|auth|credential|bearer)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(\S+)/gi;

/**
 * Removes anything that looks like a secret from a command's output before it is shown or recorded: well-known
 * token shapes, long opaque strings, and the value of any `token=` / `password:` style assignment.
 */
export function redactSecretsFromCommandOutputV1(output: string): string {
  let cleaned = output.replace(SECRET_ASSIGNMENT_RE, (_whole, name: string, separator: string) => `${name}${separator}[redacted]`);
  for (const pattern of SECRET_PATTERNS_V1) {
    cleaned = cleaned.replace(pattern, "[redacted]");
  }
  return cleaned;
}
