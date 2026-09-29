/**
 * The V1 text transport (`createCliTextTransportV1`) carries the same Part B
 * (1.0 RC1, item 2) provider-process guarantees as the legacy `execCliAgent`:
 *
 *  - a CLI it spawns under an operation that holds an admission lock is
 *    recorded next to that lock (claim resolved from `roundProcessContextV1`);
 *  - Cancel, an oversized stream and a failed process record settle the
 *    attempt only once the child is CONFIRMED gone, so the caller's lock
 *    release (in its `finally`) can never reopen admission over a live CLI;
 *  - a record store that cannot be written means the CLI is not started, or is
 *    stopped, rather than left running where a dead-owner cleanup cannot see it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import { createCliTextTransportV1 } from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { runWithRoundProcessTaskFolderV1 } from "../state/roundProcessContextV1";
import {
  hasRoundProcessRecordV1,
  listRoundProcessesV1,
  unconfirmedProcessSpawnCountV1,
} from "../state/roundProcessRecordV1";
import { acquireWorkAdmissionV1, type WorkAdmissionHandleV1 } from "../state/workAdmissionV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import type {
  AgentExecutionRequestV1,
  BoundedResultWriterV1,
  RawAgentExecutionResultV1,
} from "../types/agentExecutionV1";
import { executeAgentRequestV1 } from "../services/agentExecutionBrokerV1";
import { MIGRATED_ACTION_KEYS_V0 } from "../services/legacyAiActionSafetyGateV0";
import { openProviderSelectionSessionV1 } from "../services/providerSelectionPolicyV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { writeOwnershipBackedTaskProgress } from "./taskFolderFixture";

function installFakeExtensionContextV1(
  failOnUpdateCall?: number,
  failDelayMs = 0
): { restore: () => void } {
  const values = new Map<string, unknown>();
  let calls = 0;
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      calls += 1;
      if (calls === failOnUpdateCall) {
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

/** A "CLI" that is node itself: writes its own pid to `pidFile`, then runs until killed. */
function neverExitingDef(pidFile: string, extra = ""): CliProviderDefinition {
  return {
    id: "claude-cli",
    label: "Fake V1 Transport CLI",
    command: "node",
    installHint: "test",
    loginHint: "test",
    authErrorMarkers: [],
    signInLabel: "test",
    models: [],
    usesLastMessageFile: false,
    textModeResponseContractV1: "honours",
    promptTransport: "stdin",
    useShell: false,
    buildArgs(): string[] {
      return [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
          extra +
          "setInterval(() => {}, 1000);",
      ];
    },
  };
}

/**
 * A result frame the transport accepts on the first attempt. Plain `'ok'`
 * output has no result frame, which makes `createCliTextTransportV1` treat it
 * as narration and respawn once with a nudged prompt (item 1 fix 4) — a
 * SECOND real process the record-count tests below do not expect from a
 * single `transport.invoke()` call.
 */
function quickExitStdout(): string {
  const envelope = {
    version: 1,
    correlation: {
      actionKey: "cliTransportRoundProcessTest.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "task-binding-digest",
      chatDocumentId: "chat-document-id",
    },
    kind: "completed",
    content: {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text: "final answer",
    },
  };
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(envelope)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
}

function quickExitDef(): CliProviderDefinition {
  return {
    ...neverExitingDef("unused"),
    buildArgs: (): string[] => [
      "-e",
      `process.stdout.write(${JSON.stringify(quickExitStdout())}); process.exit(0);`,
    ],
  };
}

/** buildArgs returns an argv element containing a NUL byte, which makes
 * `cp.spawn` throw SYNCHRONOUSLY (before any OS process exists) rather than
 * emitting an async 'error' event -- the exact case a review flagged: the
 * pre-spawn `beginProcessSpawnAttemptV1` write has already landed by the
 * time this throws, so the catch block must prove that attempt abandoned
 * before resolving, or a crash in that window leaves a permanently
 * unconfirmed, no-pid "survivor" that blocks dead-owner lock reclamation. */
function syncSpawnFailureDef(): CliProviderDefinition {
  return {
    ...neverExitingDef("unused"),
    buildArgs: (): string[] => ["-e", "x\u0000y"],
  };
}

function nullWriter(): BoundedResultWriterV1 {
  return { write: (): boolean => true, overflowed: false, bytesWritten: 0 };
}

function makeRequest(token: vscode.CancellationToken): AgentExecutionRequestV1 {
  return {
    correlation: {
      actionKey: "cliTransportRoundProcessTest.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "task-binding-digest",
      chatDocumentId: "chat-document-id",
    },
    reservationId: allocateHex128IdV1(),
    mode: "text",
    prompt: "prompt text",
    maxResponseBytes: 4 * 1024 * 1024,
    cancellationToken: token,
  };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withHeldAdmission<T>(
  fn: (ctx: { taskFolderPath: string; handle: WorkAdmissionHandleV1; root: string }) => Promise<T>,
  failOnUpdateCall?: number,
  failDelayMs = 0
): Promise<T> {
  const fake = installFakeExtensionContextV1(failOnUpdateCall, failDelayMs);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-v1-transport-record-"));
  try {
    const taskFolderPath = path.join(root, "task");
    fs.mkdirSync(taskFolderPath, { recursive: true });
    writeOwnershipBackedTaskProgress(taskFolderPath);
    const admission = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "cliTextTransportRoundProcessV1.test",
    });
    assert.equal(admission.outcome, "acquired");
    if (admission.outcome !== "acquired") {
      throw new Error("admission not acquired");
    }
    try {
      return await fn({ taskFolderPath, handle: admission.handle, root });
    } finally {
      await admission.handle.release();
    }
  } finally {
    fake.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void test("a CLI spawned under an operation holding admission is recorded next to that lock", async () => {
  await withHeldAdmission(async ({ taskFolderPath, handle }) => {
    const transport = createCliTextTransportV1({ def: quickExitDef(), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    assert.equal(exit.kind, "completed");
    const recorded = await waitFor(() => {
      const list = listRoundProcessesV1(taskFolderPath, handle.claimId);
      return list.length > 0 ? list : undefined;
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.providerId, "claude-cli");
    assert.equal(recorded[0]!.providerLabel, "Fake V1 Transport CLI");
    assert.ok(Number.isInteger(recorded[0]!.pid) && recorded[0]!.pid > 0);
    assert.ok(recorded[0]!.command.includes("node"));
    assert.equal(hasRoundProcessRecordV1(taskFolderPath, handle.claimId), true);
  });
});

void test("a CLI spawned with no task context, or no held lock, is not recorded", async () => {
  await withHeldAdmission(async ({ taskFolderPath, handle }) => {
    const transport = createCliTextTransportV1({ def: quickExitDef(), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    // No runWithRoundProcessTaskFolderV1 on the call path.
    assert.equal((await transport.invoke(makeRequest(cts.token), nullWriter())).kind, "completed");
    // A context for a task this window holds no lock for.
    const other = path.join(path.dirname(taskFolderPath), "other-task");
    assert.equal(
      (await runWithRoundProcessTaskFolderV1(other, () => transport.invoke(makeRequest(cts.token), nullWriter()))).kind,
      "completed"
    );
    assert.equal(listRoundProcessesV1(taskFolderPath, handle.claimId).length, 0);
    // "other" never had an admission acquired for it in this test, so there is
    // no real claimId to check against — any id shows the same thing, since
    // nothing was ever written under this taskFolderPath at all.
    assert.equal(listRoundProcessesV1(other, "no-admission-held-for-this-task").length, 0);
  });
});

void test("Cancel settles the V1 attempt only after the CLI is confirmed gone, so the lock release cannot reopen admission over it", async () => {
  await withHeldAdmission(async ({ taskFolderPath, handle, root }) => {
    const pidFile = path.join(root, "pid.txt");
    const transport = createCliTextTransportV1({ def: neverExitingDef(pidFile), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    const running = runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    const pid = await waitFor(() => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : undefined));
    const recorded = await waitFor(() => {
      const list = listRoundProcessesV1(taskFolderPath, handle.claimId);
      return list.length > 0 ? list : undefined;
    });
    assert.equal(recorded[0]!.pid, pid);
    assert.ok(pidExists(pid));

    cts.cancel();
    const exit = await running;
    assert.equal(exit.kind, "callerCancelled");
    // Checked the instant the attempt settles — no polling grace period: the
    // caller's `finally` releases the lock right here.
    assert.equal(pidExists(pid), false, "the CLI must already be gone when the cancelled attempt settles");
  });
});

void test("an oversized event stream stops the CLI and settles only once it is confirmed gone", async () => {
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const pidFile = path.join(root, "pid.txt");
    const transport = createCliTextTransportV1({
      def: neverExitingDef(pidFile, "process.stdout.write('x'.repeat(4096));"),
      model: undefined,
      cwd: process.cwd(),
      maxEventStreamBytes: 1024,
    });
    const cts = new vscode.CancellationTokenSource();
    const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    assert.equal(exit.kind, "transportFailure");
    if (exit.kind === "transportFailure") {
      assert.equal(exit.code, "cliEventStreamTooLarge");
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(pidExists(pid), false, "the CLI must already be gone when the failed attempt settles");
  });
});

void test("a record store that cannot be written before spawn means the CLI is not started", async () => {
  // Update call 1 is the round-record `begin` write (beginRoundProcessRecordingV1).
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const pidFile = path.join(root, "pid.txt");
    const transport = createCliTextTransportV1({ def: neverExitingDef(pidFile), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    assert.equal(exit.kind, "transportFailure");
    if (exit.kind === "transportFailure") {
      assert.equal(exit.code, "cliProcessRecordUnavailable");
    }
    assert.equal(fs.existsSync(pidFile), false, "the CLI must never have been spawned");
  }, 1);
});

void test("a record store that cannot be written for the per-attempt pre-spawn write also means the CLI is not started", async () => {
  // Update call 2 is the per-attempt pre-spawn `begin` write
  // (beginProcessSpawnAttemptV1, called once per attempt BEFORE cp.spawn),
  // distinct from call 1's once-per-round beginRoundProcessRecordingV1.
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const pidFile = path.join(root, "pid.txt");
    const transport = createCliTextTransportV1({ def: neverExitingDef(pidFile), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    assert.equal(exit.kind, "transportFailure");
    if (exit.kind === "transportFailure") {
      assert.equal(exit.code, "cliProcessRecordUnavailable");
    }
    assert.equal(fs.existsSync(pidFile), false, "the CLI must never have been spawned");
  }, 2);
});

void test("a process record that fails after spawn stops the CLI and settles only once it is confirmed gone", async () => {
  // Update call 1 is the round-record `begin` write; call 2 is the
  // per-attempt pre-spawn `begin` write; call 3 is the post-spawn `record`
  // write (recordSpawnedCliProcessV1) this test targets.
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const pidFile = path.join(root, "pid.txt");
    const transport = createCliTextTransportV1({ def: neverExitingDef(pidFile), model: undefined, cwd: process.cwd() });
    const cts = new vscode.CancellationTokenSource();
    const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      transport.invoke(makeRequest(cts.token), nullWriter())
    );
    assert.equal(exit.kind, "transportFailure");
    if (exit.kind === "transportFailure") {
      assert.equal(exit.code, "cliProcessRecordFailed");
    }
    // The child may have been stopped before its script wrote its pid; a child
    // confirmed gone cannot write afterwards, so a pid file that exists must
    // name a process that no longer runs.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (fs.existsSync(pidFile)) {
      assert.equal(
        pidExists(Number(fs.readFileSync(pidFile, "utf8"))),
        false,
        "the unrecorded CLI must already be gone when the attempt settles"
      );
    }
  }, 3);
});

void test(
  "a post-spawn record write that fails after a short-lived CLI already exited leaves no unconfirmed spawn attempt behind",
  async () => {
    // Update call 3 is the post-spawn `record` write (recordSpawnedCliProcessV1).
    // Delaying its rejection reproduces the crash-adjacent race a review
    // flagged: the CLI here exits (and the attempt settles as "completed")
    // on its own well before the failing write is discovered, so the write's
    // recovery handler must not simply return having neither recorded the
    // process nor abandoned the spawn attempt — doing so would leave
    // unconfirmedProcessSpawnCountV1 permanently inflated by one, blocking a
    // later dead-owner cleanup (recordedCliStopV1.ts) from ever reclaiming
    // this lock even though nothing is running.
    await withHeldAdmission(
      async ({ taskFolderPath, handle }) => {
        const transport = createCliTextTransportV1({ def: quickExitDef(), model: undefined, cwd: process.cwd() });
        const cts = new vscode.CancellationTokenSource();
        const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
          transport.invoke(makeRequest(cts.token), nullWriter())
        );
        assert.equal(exit.kind, "completed");
        // No post-completion sleep: `transport.invoke()` having already
        // resolved is exactly the claim under test — the delayed, failing
        // record write's abandonment fallback must be durable BEFORE
        // "completed" settles (finishTextCompleted now awaits it), not
        // merely "eventually, if you wait long enough after". A version of
        // this fix that only scheduled the abandonment without awaiting it
        // would still pass an assertion taken after a sleep, which is why an
        // earlier round's version of this test slept 500ms here and a review
        // correctly flagged that as not proving the required ordering.
        assert.equal(
          listRoundProcessesV1(taskFolderPath, handle.claimId).length,
          0,
          "the failed write must not have landed a process entry"
        );
        assert.equal(
          unconfirmedProcessSpawnCountV1(taskFolderPath, handle.claimId),
          0,
          "a spawn attempt proven to have exited must not stay unconfirmed forever, " +
            "and must already be durable by the time the attempt settles as completed"
        );
      },
      3,
      300
    );
  }
);

void test(
  "the V1 transport leaves no unconfirmed spawn attempt behind when cp.spawn itself throws synchronously",
  async () => {
    await withHeldAdmission(async ({ taskFolderPath, handle }) => {
      const transport = createCliTextTransportV1({
        def: syncSpawnFailureDef(),
        model: undefined,
        cwd: process.cwd(),
      });
      const cts = new vscode.CancellationTokenSource();
      const exit = await runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
        transport.invoke(makeRequest(cts.token), nullWriter())
      );
      assert.equal(exit.kind, "transportFailure");
      if (exit.kind === "transportFailure") {
        assert.equal(exit.code, "cliSpawnFailed");
      }
      assert.equal(listRoundProcessesV1(taskFolderPath, handle.claimId).length, 0);
      // No post-completion sleep: this is exactly the ordering under test --
      // the abandonment write behind the synchronous catch must already be
      // durable by the time transport.invoke() itself resolves, not merely
      // "eventually". Before the fix this call was fired with `void` and
      // resolve() happened immediately, so this assertion could observe the
      // pre-spawn attempt still counted as unconfirmed.
      assert.equal(
        unconfirmedProcessSpawnCountV1(taskFolderPath, handle.claimId),
        0,
        "a synchronous cp.spawn throw must not leave the pre-spawn attempt unconfirmed"
      );
    });
  }
);

/**
 * The production path: the broker wraps the transport, so the broker's own
 * Cancel listener and wall-clock deadline must not settle ahead of the
 * transport's confirmed-exit wait (the caller releases admission on settle).
 */
async function brokerRunOverHeldAdmission(
  pidFile: string,
  taskFolderPath: string,
  drive: (cts: vscode.CancellationTokenSource) => void,
  invocationTimeoutMs?: number
): Promise<{ result: RawAgentExecutionResultV1; pid: number }> {
  const actionKey = "cliTransportBrokerRaceTest.v1";
  (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).add(actionKey);
  try {
    const session = openProviderSelectionSessionV1({
      actionKey,
      operationId: allocateHex128IdV1(),
      taskBindingId: "task-binding-digest",
      chatDocumentId: "chat-document-id",
    });
    const attemptId = session.allocateAttempt();
    const handle = session.reserve({
      attemptId,
      mode: "text",
      runnerId: "claude-cli",
      providerId: "claude-cli",
      modelId: "claude-cli:test",
    });
    const claimed = session.claim(handle.reservationId);
    const cts = new vscode.CancellationTokenSource();
    const request: AgentExecutionRequestV1 = {
      correlation: session.correlationForAttempt(attemptId),
      reservationId: handle.reservationId,
      mode: "text",
      prompt: "prompt text",
      maxResponseBytes: 1024,
      cancellationToken: cts.token,
    };
    const transport = createCliTextTransportV1({ def: neverExitingDef(pidFile), model: undefined, cwd: process.cwd() });
    const running = runWithRoundProcessTaskFolderV1(taskFolderPath, () =>
      executeAgentRequestV1(request, claimed, transport, invocationTimeoutMs ? { invocationTimeoutMs } : {})
    );
    const pid = await waitFor(() => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : undefined));
    assert.ok(pidExists(pid));
    drive(cts);
    const result = await running;
    return { result, pid };
  } finally {
    (MIGRATED_ACTION_KEYS_V0 as unknown as Set<string>).delete(actionKey);
  }
}

void test("through the broker, Cancel resolves only after the CLI is confirmed gone", async () => {
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const { result, pid } = await brokerRunOverHeldAdmission(path.join(root, "pid.txt"), taskFolderPath, (cts) =>
      cts.cancel()
    );
    assert.equal(result.kind, "callerCancelled");
    assert.equal(pidExists(pid), false, "the CLI must already be gone when the broker settles a Cancel");
  });
});

void test("through the broker, the wall-clock deadline resolves only after the CLI is confirmed gone", async () => {
  await withHeldAdmission(async ({ taskFolderPath, root }) => {
    const { result, pid } = await brokerRunOverHeldAdmission(
      path.join(root, "pid.txt"),
      taskFolderPath,
      () => undefined,
      1500
    );
    assert.equal(result.kind, "transportFailure");
    if (result.kind === "transportFailure") {
      assert.equal(result.code, "invocationDeadlineExceeded");
    }
    assert.equal(pidExists(pid), false, "the CLI must already be gone when the broker reports the deadline");
  });
});
