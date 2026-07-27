/**
 * Regression coverage for killProcessTree's PID-reuse guard
 * (completionLint.ts). The retry schedule used to keep firing
 * `taskkill /PID <pid> /T /F` at fixed delays for up to 30s after the
 * tracked child had already exited. Windows reuses freed PIDs, so a stale
 * retry could force-kill an unrelated process that had been assigned the
 * same number in the meantime — observed as the full unit suite's
 * cancellation-guard test finding its freshly spawned `npm run test` check
 * dead (non-zero exit, empty output, no "[check cancelled]" marker) before
 * its own cancellation ever fired.
 *
 * Two deliberately redundant guards enforce the stop, and their observable
 * behavior — no taskkill after exit — is identical with either one alone,
 * so the end-to-end test here cannot detect the removal of just one. The
 * two seam tests close that gap: each uses KillProcessTreeGuardSeam to
 * disable one guard and fails if the other has been removed.
 *
 * Lives in its own file deliberately: node --test runs each file in its own
 * process, so stubbing child_process.execFileSync here cannot interfere
 * with completionLintRunGuards.test.ts, whose tests rely on the real
 * taskkill actually killing real processes.
 */
import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { killProcessTree, type KillProcessTreeGuardSeam } from "../utils/completionLint";

// completionLint.ts reads execFileSync off the CommonJS "child_process"
// module object at call time, so the stub must be installed on that exact
// object — the `import * as` namespace this file would otherwise get is a
// copy with getter-only bindings that rejects assignment.
const childProcess = createRequire(__filename)("child_process") as typeof import("node:child_process");

/**
 * Stub taskkill (counting invocations without killing anything), run
 * killProcessTree on a child that exits on its own, and assert that no
 * taskkill fires after the child's 'exit' event. Retries BEFORE exit are
 * legitimate (the child may genuinely still be running — under full-suite
 * load even `node -e ""` can outlive the first retry delays), so only the
 * post-exit count matters.
 */
async function assertNoTaskkillAfterExit(guardSeam?: KillProcessTreeGuardSeam): Promise<void> {
  const taskkillCalls: string[][] = [];
  const realExecFileSync = childProcess.execFileSync;
  (childProcess as { execFileSync: unknown }).execFileSync = (
    file: string,
    args?: readonly string[],
    options?: object
  ): Buffer => {
    if (file === "taskkill") {
      taskkillCalls.push([file, ...(args ?? [])]);
      return Buffer.alloc(0);
    }
    return realExecFileSync(file, args ? [...args] : [], options) as Buffer;
  };
  try {
    const child = childProcess.spawn(process.execPath, ["-e", ""], { windowsHide: true });
    killProcessTree(child, guardSeam);

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
    });
    const callsAtExit = taskkillCalls.length;

    // The earliest scheduled retries sit at 300ms and 1000ms — wait past
    // both; a surviving guard must keep the post-exit count at zero.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(
      taskkillCalls.length,
      callsAtExit,
      "no taskkill retry may fire after the tracked child has exited (stale retries can hit a reused PID)"
    );
  } finally {
    (childProcess as { execFileSync: unknown }).execFileSync = realExecFileSync;
  }
}

void describe("completionLint killProcessTree — PID-reuse guard", { skip: process.platform !== "win32" }, () => {
  void it("stops retrying taskkill once the tracked child has exited", async () => {
    await assertNoTaskkillAfterExit();
  });

  // Seam tests: each disables one of the two redundant guards, so it fails
  // if a refactor removed the OTHER. Together they prove both guards are
  // independently present — which the end-to-end test above cannot.
  void it("fire-time hasExited() re-check alone suppresses post-exit retries (exit-time cleanup disabled)", async () => {
    await assertNoTaskkillAfterExit({ omitExitTimeTimerCleanup: true });
  });

  void it("exit-time timer cleanup alone prevents post-exit retries (fire-time re-check disabled)", async () => {
    await assertNoTaskkillAfterExit({ omitFireTimeExitCheck: true });
  });
});
