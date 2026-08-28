/**
 * Coverage for the automation-chain dispatch policy (automationChain.ts):
 * a follow-up command is dispatched immediately when no root operation holds
 * the task lock, deferred until the root operation ends when one does, and
 * dropped when the root operation failed or was cancelled.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  DEFAULT_CHAIN_GUARD_TTL_MS,
  isAutomationChainActive,
  releaseAutomationChain,
  resetAutomationChainGuards,
  scheduleAutomationChain,
  __setAutomationChainGuardForTestV1,
  type AutomationChainDeps,
  type AutomationChainEndSnapshot,
} from "../utils/automationChain";
import { resolveRoundV1 } from "../utils/taskProgressTransforms";
import { TaskProgress } from "../types/taskProgress";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { claimReviewAttempt } from "../commands/reviewActions";
import { terminalizeRoundV1 } from "../utils/roundLedgerV1";

configureWorkflowPrivateStorageRootV1(
  fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-automation-chain-private-"))
);

interface FakeChain {
  deps: AutomationChainDeps;
  executed: Array<{ command: string; arg: unknown }>;
  end(snapshot: AutomationChainEndSnapshot): void;
  listenerCount(): number;
}

function makeFakeChain(): FakeChain {
  const executed: Array<{ command: string; arg: unknown }> = [];
  const listeners = new Set<(s: AutomationChainEndSnapshot) => void>();
  return {
    executed,
    deps: {
      onDidEnd(listener): { dispose(): void } {
        listeners.add(listener);
        return { dispose: (): void => void listeners.delete(listener) };
      },
      execute(command, arg): Promise<unknown> {
        executed.push({ command, arg });
        return Promise.resolve();
      },
    },
    end(snapshot): void {
      for (const listener of [...listeners]) {
        listener(snapshot);
      }
    },
    listenerCount: (): number => listeners.size,
  };
}

void test("dispatches immediately when no root operation is given", async () => {
  const chain = makeFakeChain();
  const dispatched = await scheduleAutomationChain(
    { command: "x.review", arg: { taskFolderPath: "/t" } },
    undefined,
    chain.deps
  );
  assert.equal(dispatched, true);
  assert.deepEqual(chain.executed, [
    { command: "x.review", arg: { taskFolderPath: "/t" } },
  ]);
});

void test("defers until the root operation ends, then dispatches on success", async () => {
  const chain = makeFakeChain();
  const pending = scheduleAutomationChain(
    { command: "x.fastForward", arg: { taskFolderPath: "/t" } },
    { id: "root-1" },
    chain.deps
  );
  assert.equal(chain.executed.length, 0, "must not dispatch while root is live");
  chain.end({ id: "unrelated", state: "succeeded" });
  assert.equal(chain.executed.length, 0, "unrelated operations must not trigger dispatch");
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await pending, true);
  assert.equal(chain.executed.length, 1);
  assert.equal(chain.listenerCount(), 0, "listener must be disposed after the root ends");
});

void test("drops the chain when the root operation failed or was cancelled", async () => {
  for (const state of ["failed", "cancelled"]) {
    const chain = makeFakeChain();
    const pending = scheduleAutomationChain(
      { command: "x.review" },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state });
    assert.equal(await pending, false, state);
    assert.equal(chain.executed.length, 0, state);
    assert.equal(chain.listenerCount(), 0, state);
  }
});

void test("dispatchEvenIfRootFails: true dispatches even when the root operation failed or was cancelled", async () => {
  // wf10 item 14 / Part 7 step 17: a Publish-review dispatch must not be
  // silently dropped just because the root operation that scheduled it
  // later ends unsuccessfully — the stage transition it verifies already
  // committed before this chain was scheduled.
  for (const state of ["failed", "cancelled", "interrupted"]) {
    const chain = makeFakeChain();
    const pending = scheduleAutomationChain(
      { command: "x.publishReview", dispatchEvenIfRootFails: true },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state });
    assert.equal(await pending, true, state);
    assert.equal(chain.executed.length, 1, state);
  }
});

void test("dispatchEvenIfRootFails: true still dispatches on a succeeded root (unchanged happy path)", async () => {
  const chain = makeFakeChain();
  const pending = scheduleAutomationChain(
    { command: "x.publishReview", dispatchEvenIfRootFails: true },
    { id: "root-1" },
    chain.deps
  );
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await pending, true);
  assert.equal(chain.executed.length, 1);
});

void test("dispatchEvenIfRootFails: true still honors stillEnabled at fire time on a failed root", async () => {
  const chain = makeFakeChain();
  const pending = scheduleAutomationChain(
    { command: "x.publishReview", dispatchEvenIfRootFails: true, stillEnabled: () => false },
    { id: "root-1" },
    chain.deps
  );
  chain.end({ id: "root-1", state: "failed" });
  assert.equal(await pending, false, "disabled automation must still drop the chain even with dispatchEvenIfRootFails");
  assert.equal(chain.executed.length, 0);
});

void test("dispatchEvenIfRootFails omitted (default false) keeps dropping on a failed/cancelled root", async () => {
  for (const state of ["failed", "cancelled"]) {
    const chain = makeFakeChain();
    const pending = scheduleAutomationChain(
      { command: "x.review" },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state });
    assert.equal(await pending, false, state);
    assert.equal(chain.executed.length, 0, state);
  }
});

void test("onDropped reports the specific reason for each drop cause", async () => {
  // Duplicate chain (immediate).
  {
    resetAutomationChainGuards();
    const chain = makeFakeChain();
    const reasons: string[] = [];
    const first = scheduleAutomationChain(
      { command: "x.review", taskKey: "/task-a" },
      undefined,
      chain.deps
    );
    void first;
    const dup = await scheduleAutomationChain(
      { command: "x.review", taskKey: "/task-a", onDropped: (r) => reasons.push(r) },
      undefined,
      chain.deps
    );
    assert.equal(dup, false);
    assert.deepEqual(reasons, ["duplicate-chain"]);
  }
  // Automation disabled (immediate).
  {
    resetAutomationChainGuards();
    const chain = makeFakeChain();
    const reasons: string[] = [];
    const result = await scheduleAutomationChain(
      { command: "x.review", stillEnabled: () => false, onDropped: (r) => reasons.push(r) },
      undefined,
      chain.deps
    );
    assert.equal(result, false);
    assert.deepEqual(reasons, ["automation-disabled"]);
  }
  // Automation disabled (deferred, at fire time).
  {
    resetAutomationChainGuards();
    const chain = makeFakeChain();
    const reasons: string[] = [];
    const pending = scheduleAutomationChain(
      { command: "x.review", stillEnabled: () => false, onDropped: (r) => reasons.push(r) },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state: "succeeded" });
    assert.equal(await pending, false);
    assert.deepEqual(reasons, ["automation-disabled"]);
  }
  // Root operation ended unsuccessfully (deferred, dispatchEvenIfRootFails unset).
  {
    resetAutomationChainGuards();
    const chain = makeFakeChain();
    const reasons: string[] = [];
    const pending = scheduleAutomationChain(
      { command: "x.review", onDropped: (r) => reasons.push(r) },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state: "failed" });
    assert.equal(await pending, false);
    assert.deepEqual(reasons, ["root-operation-unsuccessful"]);
  }
});

void test("duplicate (taskKey, command) chain is dropped while the first is pending", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  const first = scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a" },
    { id: "root-1" },
    chain.deps
  );
  assert.equal(isAutomationChainActive("/task-a", "x.review"), true);
  const duplicate = await scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a" },
    { id: "root-2" },
    chain.deps
  );
  assert.equal(duplicate, false, "second identical chain must be dropped");
  // A different task or a different command is NOT a duplicate.
  const otherTask = await scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-b" },
    undefined,
    chain.deps
  );
  assert.equal(otherTask, true);
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await first, true);
  assert.equal(
    chain.executed.filter((e) => e.command === "x.review").length,
    2,
    "only the first /task-a chain and the /task-b chain dispatch"
  );
});

void test("guard slot is released after the chain settles, allowing a new chain", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  assert.equal(
    await scheduleAutomationChain(
      { command: "x.review", taskKey: "/task-a" },
      undefined,
      chain.deps
    ),
    true
  );
  assert.equal(isAutomationChainActive("/task-a", "x.review"), false);
  assert.equal(
    await scheduleAutomationChain(
      { command: "x.review", taskKey: "/task-a" },
      undefined,
      chain.deps
    ),
    true,
    "a fresh chain after the first settled must dispatch"
  );
  assert.equal(chain.executed.length, 2);
});

void test("guard slot is released when the root fails, so the chain is not stuck", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  const pending = scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a" },
    { id: "root-1" },
    chain.deps
  );
  chain.end({ id: "root-1", state: "failed" });
  assert.equal(await pending, false);
  assert.equal(isAutomationChainActive("/task-a", "x.review"), false);
});

void test("chains dispatching different commands share an explicit chainId guard", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  // A single review pass and the review-and-fix loop must never run
  // concurrently for the same task even though they are different commands.
  const deferred = scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a", chainId: "auto-review" },
    { id: "root-1" },
    chain.deps
  );
  assert.equal(isAutomationChainActive("/task-a", "auto-review"), true);
  const duplicate = await scheduleAutomationChain(
    { command: "x.fastForward", taskKey: "/task-a", chainId: "auto-review" },
    undefined,
    chain.deps
  );
  assert.equal(duplicate, false, "a different command with the same chainId must be dropped");
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await deferred, true);
  assert.equal(chain.executed.length, 1);
  const afterwards = await scheduleAutomationChain(
    { command: "x.fastForward", taskKey: "/task-a", chainId: "auto-review" },
    undefined,
    chain.deps
  );
  assert.equal(afterwards, true, "the guard is released once the first chain settles");
  assert.equal(chain.executed.length, 2);
});

void test("stillEnabled=false at immediate dispatch drops the chain and releases the guard", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  const result = await scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a", stillEnabled: () => false },
    undefined,
    chain.deps
  );
  assert.equal(result, false, "a disabled automation must not dispatch");
  assert.equal(chain.executed.length, 0);
  assert.equal(
    isAutomationChainActive("/task-a", "x.review"),
    false,
    "the guard slot must be released so a later chain is not blocked"
  );
});

void test("stillEnabled flipping to false between schedule and the deferred fire drops the chain at fire time", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  let enabled = true;
  const pending = scheduleAutomationChain(
    { command: "x.fastForward", taskKey: "/task-a", stillEnabled: () => enabled },
    { id: "root-1" },
    chain.deps
  );
  // The user turns the automation option off while the root operation runs.
  enabled = false;
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await pending, false, "the queued chain must be dropped at fire time");
  assert.equal(chain.executed.length, 0);
  assert.equal(isAutomationChainActive("/task-a", "x.fastForward"), false);
  assert.equal(chain.listenerCount(), 0, "listener must be disposed after the drop");
});

void test("stillEnabled=true dispatches normally on both the immediate and deferred paths", async () => {
  resetAutomationChainGuards();
  const chain = makeFakeChain();
  const immediate = await scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a", stillEnabled: () => true },
    undefined,
    chain.deps
  );
  assert.equal(immediate, true);
  const deferred = scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-b", stillEnabled: () => true },
    { id: "root-1" },
    chain.deps
  );
  chain.end({ id: "root-1", state: "succeeded" });
  assert.equal(await deferred, true);
  assert.equal(chain.executed.length, 2);
});

void test("a review handing off to the next review stage under the same chainId, from inside its own still-pending dispatch, is not silently dropped", async () => {
  // Regression: a review that auto-advances directly into the next review
  // stage (e.g. plan-high-review scoring above threshold -> plan-low-review)
  // re-dispatches under the same "auto-review" chainId, synchronously from
  // within the command this very slot was claimed for — the outer dispatch's
  // own promise has not settled yet. Without releaseAutomationChain, the
  // follow-up's claim sees its own not-yet-settled predecessor as a
  // duplicate and is silently dropped.
  resetAutomationChainGuards();
  const executed: Array<{ command: string; arg: unknown }> = [];
  let followUpResult: boolean | undefined;
  const deps: AutomationChainDeps = {
    onDidEnd: () => ({ dispose(): void {} }),
    execute: async (command, arg): Promise<unknown> => {
      executed.push({ command, arg });
      if (command === "x.highReview") {
        // Simulate the review's own completion handler handing off to the
        // next review stage before this outer call returns.
        releaseAutomationChain("/task-a", "auto-review");
        followUpResult = await scheduleAutomationChain(
          { command: "x.lowReview", taskKey: "/task-a", chainId: "auto-review" },
          undefined,
          deps
        );
      }
      return undefined;
    },
  };

  const outerResult = await scheduleAutomationChain(
    { command: "x.highReview", taskKey: "/task-a", chainId: "auto-review" },
    undefined,
    deps
  );

  assert.equal(outerResult, true);
  assert.equal(followUpResult, true, "the follow-up review must not be dropped by its own predecessor's still-active guard slot");
  assert.deepEqual(executed.map((e) => e.command), ["x.highReview", "x.lowReview"]);
  // The outer's own (stale) release, firing after both calls above have
  // already returned, must not clobber the follow-up's still-legitimate
  // claim — but by the time everything has settled, nothing should be left
  // dangling either.
  assert.equal(isAutomationChainActive("/task-a", "auto-review"), false);
});

// --- workflow-6 Item 1: a guard whose owning process never releases it ---

void test("a live (non-expired) guard is reported active and blocks a duplicate claim", async () => {
  // Baseline for the expiry test below: a guard well inside its TTL must
  // behave exactly as before — active, and a second dispatch dropped.
  // `now` is anchored to the real clock (not an arbitrary small epoch) since
  // `scheduleAutomationChain` below claims through `claimChainGuard`'s own
  // `Date.now()` default a moment later — an arbitrary tiny "now" here would
  // read as already-expired against the real clock and silently invalidate
  // the test.
  resetAutomationChainGuards();
  const now = Date.now();
  __setAutomationChainGuardForTestV1("/task-a", "impl-continuation", now + DEFAULT_CHAIN_GUARD_TTL_MS);
  assert.equal(isAutomationChainActive("/task-a", "impl-continuation", now), true);
  const chain = makeFakeChain();
  const result = await scheduleAutomationChain(
    { command: "x.review", taskKey: "/task-a", chainId: "impl-continuation" },
    undefined,
    chain.deps
  );
  assert.equal(result, false, "a live guard must still drop a duplicate dispatch");
});

void test("an expired guard is reported inactive and does not suppress a reclaim", () => {
  // Workflow-6 Item 1: a Fast Forward run (or any dispatch) that ends
  // abnormally — crash, cancel, any error path that skips its own release()
  // — must not be able to block recovery past this guard's expiry. Mirrors
  // the exact call scheduleTaskResume.ts's armPendingImplRecoveries makes.
  resetAutomationChainGuards();
  const now = Date.now();
  __setAutomationChainGuardForTestV1("/task-a", "impl-continuation", now - 1);
  assert.equal(
    isAutomationChainActive("/task-a", "impl-continuation", now),
    false,
    "a guard past its expiry must report inactive"
  );
});

void test("an expired guard's stale entry is pruned so a fresh chain can be claimed", async () => {
  resetAutomationChainGuards();
  __setAutomationChainGuardForTestV1("/task-a", "impl-continuation", Date.now() - 1);
  const chain = makeFakeChain();
  const result = await scheduleAutomationChain(
    { command: "vs-code-ai-helper.runImplementationWithAI", taskKey: "/task-a", chainId: "impl-continuation" },
    undefined,
    chain.deps
  );
  assert.equal(result, true, "an expired guard must not block a fresh dispatch under the same key");
  assert.equal(chain.executed.length, 1);
});

// wf "make the stage chat a record of work" Part 4 step 12: an
// automation-dispatched round now opens a round-ledger row (via
// `announceAutoStartBestEffortV1` -> `openAutomationRoundLedgerRowBestEffortV1`)
// and this module's own `deps.execute` settle points must close that SAME
// row — real end-to-end coverage through `scheduleAutomationChain` itself,
// not just the standalone open/close primitives (see roundLedgerV1.test.ts
// for those). Needs a real task folder + real vscode.workspace.fs bridge
// (announce/open both read+write task-progress.json) and a real extension
// context (the scheduling-intent store needs `workspaceState`) — none of
// this file's other tests need either, since they use fake taskKeys and
// never reach past the best-effort try/catch inside announce/record.

function installFsBridgeV1(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

class FakeMementoV1 {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(_key: string, value: unknown): Thenable<void> {
    this.values.set(_key, value);
    return Promise.resolve();
  }
}

function readRawProgress(folder: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
}

/**
 * The generic ledger-close call in `automationChain.ts` is deliberately
 * fire-and-forget — it hangs off `intentIdPromise.then(...)` the SAME way
 * the pre-existing `recordTerminalIntentBestEffortV1` call does, so
 * `scheduleAutomationChain`'s own returned promise resolves before that
 * bookkeeping necessarily lands (matching the module's existing "never let
 * instrumentation delay the caller" discipline). Poll for the row to reach a
 * terminal state instead of asserting immediately after the awaited call.
 */
async function waitUntilRowTerminalV1(folder: string): Promise<TaskProgress> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const raw = readRawProgress(folder);
    const row = raw.roundLedger?.[0];
    if (row && row.state !== "scheduled" && row.state !== "open") {
      return raw;
    }
    if (Date.now() > deadline) {
      return raw;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

void test("a successful automation dispatch opens and closes its own round-ledger row", async () => {
  const fixture = makeOwnedTaskFolder("ensemble-automation-chain-ledger-ok-");
  const fsBridge = installFsBridgeV1();
  __extensionContextV1TestOnly.set({
    workspaceState: new FakeMementoV1(),
  } as unknown as vscode.ExtensionContext);
  try {
    const chain = makeFakeChain();
    const result = await scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runImplementationWithAI",
        taskKey: fixture.folder,
        chainId: "impl-ledger-ok",
        intent: { trigger: "test dispatch", willRetry: false },
      },
      undefined,
      chain.deps
    );
    assert.equal(result, true);

    const raw = await waitUntilRowTerminalV1(fixture.folder);
    assert.equal(raw.roundLedger?.length, 1, "exactly one round-ledger row must have been opened");
    const row = raw.roundLedger?.[0];
    assert.ok(row, "must resolve the opened row");
    assert.equal(row?.mode, "implementation");
    assert.equal(row?.state, "completed", "the row must be closed, not left open, once the command settles");
    assert.ok(row?.endedAt, "a closed row must carry an endedAt timestamp");
    assert.equal(resolveRoundV1(raw, row?.intentId ?? "")?.roundId, row?.roundId, "resolvable by its own intentId");
  } finally {
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});

void test("a failing automation dispatch closes its round-ledger row as failed, not completed", async () => {
  const fixture = makeOwnedTaskFolder("ensemble-automation-chain-ledger-fail-");
  const fsBridge = installFsBridgeV1();
  __extensionContextV1TestOnly.set({
    workspaceState: new FakeMementoV1(),
  } as unknown as vscode.ExtensionContext);
  try {
    const failingDeps: AutomationChainDeps = {
      onDidEnd: () => ({ dispose: () => undefined }),
      execute: () => Promise.reject(new Error("provider exploded")),
    };
    const result = await scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runImplementationWithAI",
        taskKey: fixture.folder,
        chainId: "impl-ledger-fail",
      },
      undefined,
      failingDeps
    ).catch(() => false);
    assert.equal(result, false, "a rejected dispatch propagates its rejection, never resolves true");

    const raw = await waitUntilRowTerminalV1(fixture.folder);
    assert.equal(raw.roundLedger?.length, 1);
    const row = raw.roundLedger?.[0];
    assert.ok(row, "must resolve the opened row");
    assert.equal(row?.state, "failed");
    assert.equal(row?.outcome?.rejectionReason, "provider exploded");
  } finally {
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});

// 2026-08-27 review follow-up, narrowed completion blocker: "the root-
// unsuccessful branch also records the scheduling intent as cancelled but the
// ledger as dropped ... leaving the two durable classifications inconsistent"
// / "terminalizeGenericAutomationRoundBestEffortV1 creates an outcome only
// for failed". Corrected again the same day (blocker "dropped automation
// chains are terminalized as cancelled contrary to the plan"): the two tests
// below now prove both drop causes close the round-ledger row as the ledger's
// OWN `"dropped"` state (`RoundLedgerStateV1` has one; the scheduling-intent
// store's `SchedulingIntentLifecycleStateV1` does not, and keeps recording
// `"cancelled"` for the same event — the two stores deliberately disagree on
// vocabulary because each is using the value that is actually correct for
// what it tracks), and that both carry a human-readable reason rather than an
// empty outcome.
void test("automation disabled before dispatch closes its round-ledger row as dropped with a reason", async () => {
  const fixture = makeOwnedTaskFolder("ensemble-automation-chain-ledger-disabled-");
  const fsBridge = installFsBridgeV1();
  __extensionContextV1TestOnly.set({
    workspaceState: new FakeMementoV1(),
  } as unknown as vscode.ExtensionContext);
  try {
    const chain = makeFakeChain();
    const result = await scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runImplementationWithAI",
        taskKey: fixture.folder,
        chainId: "impl-ledger-disabled",
        stillEnabled: () => false,
      },
      undefined,
      chain.deps
    );
    assert.equal(result, false);

    const raw = await waitUntilRowTerminalV1(fixture.folder);
    assert.equal(raw.roundLedger?.length, 1);
    const row = raw.roundLedger?.[0];
    assert.ok(row, "must resolve the opened row");
    assert.equal(row?.state, "dropped");
    assert.ok(
      row?.outcome?.rejectionReason?.includes("automation was disabled"),
      "a dropped row must carry a human-readable reason, not an empty outcome"
    );
  } finally {
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});

void test("a root operation ending unsuccessfully closes the deferred chain's round-ledger row as dropped with a reason, while the scheduling-intent keeps its own 'cancelled' classification", async () => {
  const fixture = makeOwnedTaskFolder("ensemble-automation-chain-ledger-root-fail-");
  const fsBridge = installFsBridgeV1();
  __extensionContextV1TestOnly.set({
    workspaceState: new FakeMementoV1(),
  } as unknown as vscode.ExtensionContext);
  try {
    const chain = makeFakeChain();
    const pending = scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runImplementationWithAI",
        taskKey: fixture.folder,
        chainId: "impl-ledger-root-fail",
      },
      { id: "root-1" },
      chain.deps
    );
    chain.end({ id: "root-1", state: "failed" });
    const result = await pending;
    assert.equal(result, false);

    const raw = await waitUntilRowTerminalV1(fixture.folder);
    assert.equal(raw.roundLedger?.length, 1);
    const row = raw.roundLedger?.[0];
    assert.ok(row, "must resolve the opened row");
    assert.equal(
      row?.state,
      "dropped",
      'the round-ledger row must use its own "dropped" state, per the plan\'s "chain-drop paths terminalize the round ledger as dropped" requirement'
    );
    assert.ok(
      row?.outcome?.rejectionReason?.includes("did not succeed"),
      "a dropped row must carry a human-readable reason, not an empty outcome"
    );
  } finally {
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});

// 2026-08-27 review follow-up (blocker "coordinator-owned lifecycle
// identity" / "Automated rounds now add an intent-keyed generic row while
// review rows still use a separate synthetic ID"): a dispatched command that
// is ITSELF a review calls `claimReviewAttempt`, which now consumes the
// intentId `scheduleAutomationChain` stages immediately before `deps.execute`
// and reuses the SAME generic row instead of opening a second one. This test
// exercises the real end-to-end path — not the standalone primitives covered
// in roundLedgerV1.test.ts — proving the round collapses to one identity and
// that the review's own richer terminal write (here: "rejected", never
// "completed") wins the race against `automationChain.ts`'s generic
// success-settle write, exactly as the module's idempotency contract
// promises.
void test("an automation-dispatched review reuses the generic row (one identity, not two) and its own outcome wins over the generic 'completed' write", async () => {
  const fixture = makeOwnedTaskFolder("ensemble-automation-chain-ledger-review-");
  const fsBridge = installFsBridgeV1();
  __extensionContextV1TestOnly.set({
    workspaceState: new FakeMementoV1(),
  } as unknown as vscode.ExtensionContext);
  try {
    const fakeReviewDeps: AutomationChainDeps = {
      onDidEnd: () => ({ dispose: () => undefined }),
      execute: async () => {
        const folderUri = vscode.Uri.file(fixture.folder);
        const claimed = await claimReviewAttempt(folderUri, "review-attempt-e2e", "impl-high-review");
        if (!claimed) {
          throw new Error("claim failed");
        }
        // The review's own richer terminal write — simulating a real
        // rejected/blocked outcome, deliberately not "completed", to prove
        // this wins over the generic settle handler's write below.
        await terminalizeRoundV1("review-attempt-e2e", "rejected", { rejectionReason: "blockers remain" }, {
          taskFolderUri: folderUri,
        });
        return undefined;
      },
    };
    const result = await scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runReviewWithAI",
        taskKey: fixture.folder,
        chainId: "auto-review-e2e",
        intent: { trigger: "test review dispatch", willRetry: false },
      },
      undefined,
      fakeReviewDeps
    );
    assert.equal(result, true);

    const raw = await waitUntilRowTerminalV1(fixture.folder);
    assert.equal(raw.roundLedger?.length, 1, "the round must collapse to a single row, not a generic row plus a review row");
    const row = raw.roundLedger?.[0];
    assert.ok(row, "must resolve the row");
    assert.equal(row?.mode, "review");
    assert.equal(row?.state, "rejected", "the review's own richer outcome must win over the generic 'completed' write");
    assert.equal(row?.outcome?.rejectionReason, "blockers remain");
    assert.deepEqual(row?.attemptIds, ["review-attempt-e2e"]);
    assert.equal(resolveRoundV1(raw, "review-attempt-e2e")?.roundId, row?.roundId, "resolvable by the review attempt id");
    assert.equal(resolveRoundV1(raw, row?.intentId ?? "")?.roundId, row?.roundId, "and by the scheduling intentId");
  } finally {
    __extensionContextV1TestOnly.reset();
    fsBridge.restore();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});
