/**
 * Coverage for the automation-chain dispatch policy (automationChain.ts):
 * a follow-up command is dispatched immediately when no root operation holds
 * the task lock, deferred until the root operation ends when one does, and
 * dropped when the root operation failed or was cancelled.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAutomationChainActive,
  releaseAutomationChain,
  resetAutomationChainGuards,
  scheduleAutomationChain,
  type AutomationChainDeps,
  type AutomationChainEndSnapshot,
} from "../utils/automationChain";

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
