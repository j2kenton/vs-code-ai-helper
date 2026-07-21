import * as cp from "child_process";

/**
 * Env var name prefixes/exact-names that identify an in-progress Claude Code
 * session hosting *this extension itself*. These must never reach a spawned
 * provider CLI: this extension host typically runs inside a Claude Code
 * session (e.g. the Claude Code VS Code extension), so process.env carries
 * that session's identity (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_EFFORT, etc.).
 * Passed through unfiltered, a nested `claude -p ...` child can detect it's
 * being launched as an IDE-companion/child session and behave differently
 * than a fresh headless call.
 *
 * Deliberately scoped to Claude-session-identity variables only, not other
 * vendors' own env namespaces: this extension host has no comparable reason
 * to ever itself be a Codex or Gemini session, and those vendors' own env
 * vars (e.g. CODEX_HOME) are the user's legitimate CLI config/auth —
 * stripping them would silently break an intentionally-configured
 * login/profile rather than prevent any actual leak.
 */
const AGENTIC_SESSION_ENV_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
]);
const AGENTIC_SESSION_ENV_PREFIXES = ["CLAUDE_CODE_"];

/**
 * Env to pass to every spawned provider CLI process — both an actual run
 * (execCliAgent) and a model-discovery call (cliModelDiscovery.ts). Shared
 * so the two spawn paths can never drift: an earlier version had discovery
 * pass raw process.env while the run path used this filtered form, which
 * was latent (discovery never actually spawned a Windows npm-shim CLI like
 * opencode.cmd until shell:true was added there) but would have leaked the
 * session-identity vars this function strips the moment it did.
 */
export function sanitizedCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (AGENTIC_SESSION_ENV_EXACT.has(key)) {
      continue;
    }
    if (AGENTIC_SESSION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Kill a CLI process and its children (agent CLIs spawn helpers, and since
 * they're launched with shell:true there's always at least a shell process
 * in between). On Windows, taskkill /T walks the whole process tree by PID.
 * On POSIX, a caller that wants the same guarantee must spawn its child
 * detached (see execCliAgent) so it heads its own process group; signalling
 * the negated PID then sends SIGTERM to that whole group — the shell, the
 * exec'd CLI, and any children it forked — rather than only the single PID
 * Node handed back, which a plain child.kill("SIGTERM") would otherwise
 * leave running past cancellation/timeout.
 */
export function killProcessTree(child: cp.ChildProcess): void {
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
