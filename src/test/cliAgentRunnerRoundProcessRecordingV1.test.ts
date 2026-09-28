/**
 * Coverage for the round-process-recording wiring added to `execCliAgent`
 * (1.0 RC1, Part B, item 2, "Recording and stopping provider CLI
 * processes"): when a caller supplies both `taskFolderPath` and
 * `roundProcessClaimId`, the spawned provider process is recorded next to
 * the round's admission lock via `roundProcessRecordV1.ts`, before the
 * process's own output is even awaited. A caller that supplies neither
 * continues to skip recording entirely, unchanged from before this wiring
 * existed.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import { execCliAgent } from "../runners/cliAgentRunner";
import { CliProviderDefinition } from "../runners/providers";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  listRoundProcessesV1,
  recordedClaimIdForTaskV1,
  unconfirmedProcessSpawnCountV1,
} from "../state/roundProcessRecordV1";
import { acquireWorkAdmissionV1, hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { writeOwnershipBackedTaskProgress } from "./taskFolderFixture";

/** Same shape as {@link installFakeExtensionContextV1}, but the Nth call to
 * `workspaceState.update` (1-indexed, across every key) rejects — used to
 * simulate a durable-write failure at a specific point in
 * `roundProcessRecordV1.ts`'s write sequence: the round-level `begin` write
 * is always call 1, the pre-spawn per-attempt `beginProcessSpawnAttemptV1`
 * write is always call 2, and the post-spawn `record` write is always
 * call 3. */
function installFakeExtensionContextV1WithUpdateFailureV1(
  failOnCallNumber: number,
  failDelayMs = 0
): { restore: () => void } {
  const values = new Map<string, unknown>();
  let callCount = 0;
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      callCount += 1;
      if (callCount === failOnCallNumber) {
        if (failDelayMs > 0) {
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("simulated workspaceState write failure")), failDelayMs);
          });
        }
        return Promise.reject(new Error("simulated workspaceState write failure"));
      }
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset() };
}

function makeLongRunningProvider(): CliProviderDefinition {
  return {
    id: "claude-cli",
    label: "Fake Long-Running CLI",
    command: "node",
    installHint: "install",
    loginHint: "login",
    authErrorMarkers: [],
    signInCommand: "login",
    signInLabel: "Sign in",
    useShell: false,
    models: [{ model: undefined, name: "default" }],
    usesLastMessageFile: false,
    textModeResponseContractV1: "honours",
    buildArgs(): string[] {
      // Never exits on its own (no listener installed for SIGTERM either),
      // so the test can prove execCliAgent actually stopped it rather than
      // merely outliving a fast, self-exiting fixture.
      return ["-e", "setInterval(() => {}, 1000);"];
    },
  };
}

function pidExistsForTestV1(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM is not instantaneous — poll briefly rather than asserting the pid
 * is gone the instant execCliAgent resolves. */
async function waitForPidGoneV1(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidExistsForTestV1(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function installFakeExtensionContextV1(): { restore: () => void } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset() };
}

/** buildArgs returns an argv element containing a NUL byte, which makes
 * `cp.spawn` throw SYNCHRONOUSLY (before any OS process exists) rather than
 * emitting an async 'error' event — the exact case a review flagged: the
 * pre-spawn `beginProcessSpawnAttemptV1` write has already landed by the
 * time this throws, so the catch block must prove that attempt abandoned
 * before resolving, or a crash in that window leaves a permanently
 * unconfirmed, no-pid "survivor" that blocks dead-owner lock reclamation. */
function makeSyncSpawnFailureProvider(): CliProviderDefinition {
  return {
    id: "claude-cli",
    label: "Fake Sync-Spawn-Failure CLI",
    command: "node",
    installHint: "install",
    loginHint: "login",
    authErrorMarkers: [],
    signInCommand: "login",
    signInLabel: "Sign in",
    useShell: false,
    models: [{ model: undefined, name: "default" }],
    usesLastMessageFile: false,
    textModeResponseContractV1: "honours",
    buildArgs(): string[] {
      return ["-e", "x\u0000y"];
    },
  };
}

function makeFastExitProvider(): CliProviderDefinition {
  return {
    id: "claude-cli",
    label: "Fake Round-Record CLI",
    command: "node",
    installHint: "install",
    loginHint: "login",
    authErrorMarkers: [],
    signInCommand: "login",
    signInLabel: "Sign in",
    useShell: false,
    models: [{ model: undefined, name: "default" }],
    usesLastMessageFile: false,
    textModeResponseContractV1: "honours",
    buildArgs(): string[] {
      return ["-e", "process.stdout.write('ok'); process.exit(0);"];
    },
  };
}

/** Polls listRoundProcessesV1 briefly — recording is deliberately
 * fire-and-forget (must never delay execCliAgent's own return), so the
 * write can land a tick or two after the process is observed to have
 * spawned. */
async function waitForRecordedProcessesV1(
  taskFolderPath: string,
  timeoutMs = 2000
): Promise<ReturnType<typeof listRoundProcessesV1>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recorded = listRoundProcessesV1(taskFolderPath);
    if (recorded.length > 0 || Date.now() >= deadline) {
      return recorded;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

void test("execCliAgent records a spawned process next to the lock when taskFolderPath and roundProcessClaimId are given", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_1";
    const claimId = "claim-abc-123";

    const result = await execCliAgent({
      def: makeFastExitProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    assert.strictEqual(result.status, "completed");

    const recorded = await waitForRecordedProcessesV1(taskFolderPath);
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0]!.providerId, "claude-cli");
    assert.strictEqual(recorded[0]!.providerLabel, "Fake Round-Record CLI");
    assert.ok(Number.isInteger(recorded[0]!.pid) && recorded[0]!.pid > 0);
    assert.ok(recorded[0]!.command.includes("node"));
    assert.strictEqual(recordedClaimIdForTaskV1(taskFolderPath), claimId);
  } finally {
    fakeContext.restore();
  }
});

void test("execCliAgent never persists the raw argv prompt into the process record", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_2";
    const claimId = "claim-argv-redaction";
    const provider: CliProviderDefinition = {
      id: "codex-cli",
      label: "Fake Argv CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: [],
      signInCommand: "login",
      signInLabel: "Sign in",
      useShell: false,
      promptTransport: "argv",
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(): string[] {
        return ["-e", "process.stdout.write('ok'); process.exit(0);"];
      },
    };

    const secretPrompt = "SECRET-CONTEXT-PACK-CONTENTS-should-never-be-persisted";
    await execCliAgent({
      def: provider,
      mode: "text",
      model: undefined,
      prompt: secretPrompt,
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    const recorded = await waitForRecordedProcessesV1(taskFolderPath);
    assert.strictEqual(recorded.length, 1);
    assert.ok(!recorded[0]!.command.includes(secretPrompt));
    assert.ok(recorded[0]!.command.includes("<prompt omitted>"));
  } finally {
    fakeContext.restore();
  }
});

void test("execCliAgent skips recording entirely when no taskFolderPath/roundProcessClaimId is given", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_3";

    const result = await execCliAgent({
      def: makeFastExitProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
    });

    assert.strictEqual(result.status, "completed");
    // Give any (unexpected) fire-and-forget write a chance to land before
    // asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
  } finally {
    fakeContext.restore();
  }
});

void test("execCliAgent refuses to spawn when the pre-spawn process record cannot be durably written", async () => {
  // Call 1 is beginRoundProcessRecordingV1's own write — fail it.
  const fakeContext = installFakeExtensionContextV1WithUpdateFailureV1(1);
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_4";
    const claimId = "claim-begin-write-fails";

    const result = await execCliAgent({
      def: makeFastExitProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /bookkeeping/);
    assert.match(result.errorMessage ?? "", /not started/);
    assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
  } finally {
    fakeContext.restore();
  }
});

void test("execCliAgent refuses to spawn when the pre-spawn per-attempt spawn-record cannot be durably written", async () => {
  // Call 1 (beginRoundProcessRecordingV1) succeeds; call 2
  // (beginProcessSpawnAttemptV1, taken right before cp.spawn) fails — this
  // is the review's own defect-blocker fix: refusing to spawn here, exactly
  // like a failed call 1, is what closes the crash window between cp.spawn
  // returning a pid and the post-spawn append landing (1.0 RC1 Part B item 2).
  const fakeContext = installFakeExtensionContextV1WithUpdateFailureV1(2);
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_4b";
    const claimId = "claim-spawn-attempt-write-fails";

    const result = await execCliAgent({
      def: makeFastExitProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /bookkeeping/);
    assert.match(result.errorMessage ?? "", /not started/);
    assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
  } finally {
    fakeContext.restore();
  }
});

void test("execCliAgent stops and fails a spawned process whose post-spawn process record cannot be durably written", async () => {
  // Call 1 (beginRoundProcessRecordingV1) and call 2 (beginProcessSpawnAttemptV1)
  // succeed; call 3 (the post-spawn recordRoundProcessV1 append) fails.
  const fakeContext = installFakeExtensionContextV1WithUpdateFailureV1(3);
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_5";
    const claimId = "claim-record-write-fails";

    const result = await execCliAgent({
      def: makeLongRunningProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    assert.strictEqual(result.status, "failed");
    const pidMatch = /pid (\d+)/.exec(result.errorMessage ?? "");
    assert.ok(pidMatch, `expected a pid in the error message, got: ${result.errorMessage}`);
    const pid = Number(pidMatch[1]);
    // The process must actually be stopped shortly after execCliAgent
    // resolves — never left running invisibly because its record write
    // failed. SIGTERM isn't instantaneous, so poll rather than assert
    // instantly.
    assert.strictEqual(await waitForPidGoneV1(pid), true, `expected pid ${pid} to have been stopped`);
    assert.match(result.errorMessage ?? "", /stopped before it could keep editing the workspace unrecorded/);
    // The failed append must not have left a partial/incorrect record behind.
    assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
  } finally {
    fakeContext.restore();
  }
});

void test(
  "execCliAgent leaves no unconfirmed spawn attempt behind when the post-spawn record write fails after a short-lived process already exited",
  async () => {
    // Call 1 and call 2 succeed; call 3 (the post-spawn recordRoundProcessV1
    // append) fails, but only after a delay — long enough for this
    // fast-exiting process to have already run to completion and settled.
    // This reproduces the crash-adjacent race a review flagged: a spawn
    // attempt whose process is confirmed gone must not be left neither
    // recorded nor abandoned, which would otherwise inflate
    // unconfirmedProcessSpawnCountV1 forever and block a later dead-owner
    // cleanup (recordedCliStopV1.ts) even though nothing is running.
    const fakeContext = installFakeExtensionContextV1WithUpdateFailureV1(3, 300);
    try {
      const cts = new vscode.CancellationTokenSource();
      const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_5b";
      const claimId = "claim-record-write-fails-after-exit";

      const result = await execCliAgent({
        def: makeFastExitProvider(),
        mode: "text",
        model: undefined,
        prompt: "irrelevant",
        cwd: process.cwd(),
        token: cts.token,
        taskFolderPath,
        roundProcessClaimId: claimId,
      });

      assert.strictEqual(result.status, "completed");
      // No post-completion sleep: `execCliAgent()` having already resolved
      // is exactly the claim under test — the delayed, failing record
      // write's abandonment fallback must be durable BEFORE "completed"
      // settles (the close handler now routes through
      // finishAfterRecordingSettles, which awaits it), not merely
      // "eventually, if you wait long enough after". A version of this fix
      // that only scheduled the abandonment without awaiting it would still
      // pass an assertion taken after a sleep, which is why an earlier
      // round's version of this test slept 500ms here and a review
      // correctly flagged that as not proving the required ordering.
      assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
      assert.strictEqual(
        unconfirmedProcessSpawnCountV1(taskFolderPath, claimId),
        0,
        "a spawn attempt proven to have exited must not stay unconfirmed forever, " +
          "and must already be durable by the time the attempt settles as completed"
      );
    } finally {
      fakeContext.restore();
    }
  }
);

void test(
  "execCliAgent leaves no unconfirmed spawn attempt behind when cp.spawn itself throws synchronously",
  async () => {
    const fakeContext = installFakeExtensionContextV1();
    try {
      const cts = new vscode.CancellationTokenSource();
      const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_5c";
      const claimId = "claim-sync-spawn-throw";

      const result = await execCliAgent({
        def: makeSyncSpawnFailureProvider(),
        mode: "text",
        model: undefined,
        prompt: "irrelevant",
        cwd: process.cwd(),
        token: cts.token,
        taskFolderPath,
        roundProcessClaimId: claimId,
      });

      assert.strictEqual(result.status, "failed");
      assert.match(result.errorMessage ?? "", /Could not start/);
      assert.deepEqual(listRoundProcessesV1(taskFolderPath), []);
      // No post-completion sleep: this is exactly the ordering under test --
      // the abandonment write behind the synchronous catch must already be
      // durable by the time execCliAgent() itself resolves, not merely
      // "eventually". Before the fix this call was fired with `void` and
      // resolve() happened immediately, so this assertion could observe the
      // pre-spawn attempt still counted as unconfirmed.
      assert.strictEqual(
        unconfirmedProcessSpawnCountV1(taskFolderPath, claimId),
        0,
        "a synchronous cp.spawn throw must not leave the pre-spawn attempt unconfirmed"
      );
    } finally {
      fakeContext.restore();
    }
  }
);

void test("execCliAgent settles an ordinary recorded Cancel promptly once the child's close event fires, stopping the recorded process and leaving nothing that would block the next action's admission", async () => {
  // Regression coverage for the review's remaining Part B completion
  // blocker: earlier coverage only exercised recording and record-write
  // failure paths, never an ordinary (no write failure) recorded Cancel
  // through to settlement. This proves Cancel on a normally-recorded,
  // still-running process (a) settles as "cancelled" once the child's own
  // close event fires (not merely once the kill signal is sent), (b)
  // actually stops the OS process, and (c) does so without ever entering
  // record-failure recovery -- i.e. nothing is left pending that a caller's
  // admission-lock `finally` would have to wait out beyond this promise's
  // own settlement, so the next action can be admitted immediately.
  const fakeContext = installFakeExtensionContextV1();
  try {
    const cts = new vscode.CancellationTokenSource();
    const taskFolderPath = "/tasks/.ensemble/2026-09-24_task_6";
    const claimId = "claim-ordinary-cancel";

    const resultPromise = execCliAgent({
      def: makeLongRunningProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    // Wait for the process to actually be recorded (proving it was spawned
    // and its record write succeeded -- the ordinary, non-failure path)
    // before cancelling it.
    const recorded = await waitForRecordedProcessesV1(taskFolderPath);
    assert.strictEqual(recorded.length, 1);
    const pid = recorded[0]!.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);

    cts.cancel();
    const result = await resultPromise;

    assert.strictEqual(result.status, "cancelled");
    // Settlement is proof enough that the wait raced the child's own close
    // event rather than hanging on the kill signal alone -- but also confirm
    // the OS process is actually gone, matching the record-write-failure
    // test's own convention for verifying real termination, not just a
    // resolved promise.
    assert.strictEqual(await waitForPidGoneV1(pid), true, `expected pid ${pid} to have been stopped by Cancel`);
    // A caller's admission-lock release is keyed off this promise settling
    // in an unconditional `finally` (reviewActions.ts); this run reaching
    // "cancelled" here, with the pid already confirmed gone, is exactly the
    // state that release depends on -- so the next action is free to be
    // admitted the instant this promise resolves, with nothing left running
    // under this claim to block it.
  } finally {
    fakeContext.restore();
  }
});

void test("Cancel on a real, recorded work-admission lock actually frees admission for the next action, not merely the execCliAgent promise", async () => {
  // The previous test proves execCliAgent's own promise settles and the
  // pid is stopped. It stops short of the review's actual concern: does a
  // REAL admission lock (workAdmissionV1.ts), released from a caller's own
  // `finally` keyed off this promise settling, actually become free for a
  // subsequent acquireWorkAdmissionV1 call on the SAME task folder? This
  // test exercises that full path end to end with a real, ownership-backed
  // task folder and the real admission module (no fakes), mirroring how
  // reviewActions.ts's dispatch `finally` is documented to depend on this
  // promise's settlement to release the lock it holds.
  const fakeContext = installFakeExtensionContextV1();
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cancel-admission-release-"));
  try {
    const taskFolderPath = path.join(realRoot, "task");
    fs.mkdirSync(taskFolderPath, { recursive: true });
    writeOwnershipBackedTaskProgress(taskFolderPath);

    const admission = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "cliAgentRunnerRoundProcessRecordingV1.test",
    });
    assert.equal(admission.outcome, "acquired");
    if (admission.outcome !== "acquired") {
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    const claimId = admission.handle.claimId;

    const resultPromise = execCliAgent({
      def: makeLongRunningProvider(),
      mode: "text",
      model: undefined,
      prompt: "irrelevant",
      cwd: process.cwd(),
      token: cts.token,
      taskFolderPath,
      roundProcessClaimId: claimId,
    });

    const recorded = await waitForRecordedProcessesV1(taskFolderPath);
    assert.strictEqual(recorded.length, 1);
    const pid = recorded[0]!.pid;

    cts.cancel();
    const result = await resultPromise;
    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(await waitForPidGoneV1(pid), true, `expected pid ${pid} to have been stopped by Cancel`);

    // This is the assertion the previous round's test never made: release
    // the admission handle exactly as a caller's dispatch `finally` would
    // (only once this promise has settled and the recorded process is
    // confirmed gone), then prove the NEXT action can actually be admitted.
    await admission.handle.release();
    assert.strictEqual(
      hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
      false,
      "admission must be free immediately after release following a settled recorded Cancel"
    );

    const nextAction = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "nextActionAfterCancel",
    });
    assert.equal(
      nextAction.outcome,
      "acquired",
      "the next action must be admitted immediately once the recorded Cancel has settled and the lock released"
    );
    if (nextAction.outcome === "acquired") {
      await nextAction.handle.release();
    }
  } finally {
    fakeContext.restore();
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});
