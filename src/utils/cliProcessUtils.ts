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
 *
 * `PWD` is dropped too. It describes the extension host's own directory,
 * never the spawn's `cwd`, and OpenCode 2 prefers it over the real working
 * directory: with a stale `PWD`, `opencode run` read and would have edited
 * files in the extension host's folder instead of the task's workspace
 * (verified live, opencode 2.0.32, 2026-10-20). Without it every CLI falls
 * back to the spawn's actual `cwd`.
 */
export function sanitizedCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Upper-cased: Windows environment names are case-insensitive, so a
    // `Pwd` would still be read as PWD.
    if (key.toUpperCase() === "PWD" || AGENTIC_SESSION_ENV_EXACT.has(key)) {
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

/**
 * True while any process is still alive in the process group a detached child led. Probes the
 * group only (never the bare pid, which a reused pid could answer for an unrelated process), so
 * it is safe to call after the leader has exited. Always false on Windows, where there is no group.
 */
export function processGroupAliveV1(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * run1 Step 8: after a CLI exited on its own, stop whatever it left running (a background `sleep`,
 * a Monitor) and confirm it, so no outcome is handed on while a descendant can still edit the
 * workspace. True when nothing is left.
 *
 * POSIX: the process group the detached child led is probed, then stopped and confirmed (bounded).
 * Windows has no group to probe and a gone leader can no longer be asked for its children, so the
 * only thing available is a best-effort `taskkill /T /F` on the leader's pid (it follows the
 * recorded parent links) which cannot be confirmed; that limit is deliberate and documented rather
 * than claimed as confirmation.
 */
export async function stopLeftoverProcessGroupV1(child: cp.ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) {
    return true;
  }
  if (process.platform === "win32") {
    killProcessTree(child);
    return true;
  }
  if (!processGroupAliveV1(pid)) {
    return true;
  }
  return (await stopProcessTreeConfirmedV1(child)).gone;
}

/** True while the child, or any process still in the group it leads, is alive. */
function processTreeAliveV1(pid: number): boolean {
  const probe = (target: number): boolean => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      // EPERM still means the process exists; only ESRCH means it is gone.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  return process.platform === "win32" ? probe(pid) : probe(-pid) || probe(pid);
}

/**
 * run1 Step 8: stop a CLI process's whole tree and CONFIRM it, within a fixed bound.
 *
 * `killProcessTree` only sends the signal. A leader that ignores SIGTERM, or a descendant that does
 * while the leader exits, would then outlive the round and keep editing the workspace. This sends
 * SIGTERM to the group, waits `termMs` for the group to be gone, escalates to SIGKILL, and waits up
 * to `killMs` more. It never waits longer than `termMs + killMs`, so settlement cannot hang on a
 * process that cannot be killed; `gone` says whether the tree was confirmed gone.
 */
export async function stopProcessTreeConfirmedV1(
  child: cp.ChildProcess,
  options: { termMs?: number; killMs?: number; pollMs?: number } = {}
): Promise<{ gone: boolean; escalated: boolean }> {
  const pid = child.pid;
  if (pid === undefined) {
    return { gone: true, escalated: false };
  }
  const termMs = options.termMs ?? 3_000;
  const killMs = options.killMs ?? 3_000;
  const pollMs = options.pollMs ?? 50;
  const waitGone = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (processTreeAliveV1(pid)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  };
  killProcessTree(child);
  if (await waitGone(termMs)) {
    return { gone: true, escalated: false };
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  return { gone: await waitGone(killMs), escalated: true };
}
