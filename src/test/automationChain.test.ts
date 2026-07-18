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
