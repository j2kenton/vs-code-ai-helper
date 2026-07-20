import * as fs from "node:fs";

/**
 * Best-effort recursive directory removal for test teardown. On Windows, a
 * git-repo fixture's `.git` directory can still have a file lock held by a
 * just-exited child process (git, or a spawned lint/test command) for a
 * brief window after that process's promise/callback has already resolved —
 * `fs.rmSync`'s own `maxRetries`/`retryDelay` do not reliably outlast this,
 * so it can still throw `EPERM`/`EBUSY`/`ENOTEMPTY` even after the test's
 * actual assertions have already passed. A `finally` block is the wrong
 * place for that to be fatal: swallow it here so a real assertion failure
 * is never masked, and a cleanup-phase race is never mistaken for one.
 */
export function safeRemoveDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort: the OS will reclaim the OS temp directory eventually.
  }
}
