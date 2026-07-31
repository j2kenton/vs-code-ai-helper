import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { ViewProgressBinder } from "../utils/viewProgressBinder";
import { TaskOperationRegistry } from "../utils/taskOperations";
import { STATUS_VIEW_ID } from "../views/statusView";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls instead of sleeping a fixed window: under heavy parallel test load a
// setTimeout can fire later than its nominal delay, so a fixed short sleep
// (e.g. 5ms after a 0ms delay) is a timing race, not a correctness check.
// Polling still resolves immediately in the common case but tolerates
// scheduler latency up to maxWaitMs.
//
// Asserts on timeout so a starved poll fails here, with an explicit message,
// rather than falling through silently into the caller's next assertion
// (which would otherwise have to infer "timed out" from an empty array).
async function waitUntil(condition: () => boolean, maxWaitMs: number, message: string): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(5);
  }
  assert.ok(condition(), message);
}

void describe("ViewProgressBinder", () => {
  void it("shows the view progress line only in Notifications, not Tasks", async () => {
    const registry = new TaskOperationRegistry();
    // Zero delay: this test is about WHERE the bar shows, not the debounce.
    const binder = new ViewProgressBinder(registry, 0);
    const calls: Array<{ options: { location?: { viewId?: string } } }> = [];
    const windowWithCalls = vscode.window as typeof vscode.window & {
      _withProgressCalls?: typeof calls;
    };
    windowWithCalls._withProgressCalls = calls;

    try {
      const operation = registry.begin("/dev/progress-binder", { label: "Review", stage: "plan-high-review" });
      await waitUntil(() => calls.length > 0, 500, "expected a withProgress call within 500ms of begin()");

      assert.equal(operation !== null, true);
      assert.deepEqual(calls.map((call) => call.options.location?.viewId), [STATUS_VIEW_ID]);
      registry.end(operation);
    } finally {
      delete windowWithCalls._withProgressCalls;
      binder.dispose();
      registry.dispose();
    }
  });

  void it("never flashes the bar for an operation that finishes within the show delay", async () => {
    const registry = new TaskOperationRegistry();
    // Real-world delay is 250ms; a short one keeps the test fast while still
    // exercising the "ended before the delay elapsed" path.
    const binder = new ViewProgressBinder(registry, 30);
    const calls: Array<{ options: { location?: { viewId?: string } } }> = [];
    const windowWithCalls = vscode.window as typeof vscode.window & {
      _withProgressCalls?: typeof calls;
    };
    windowWithCalls._withProgressCalls = calls;

    try {
      // An instant mutation: begin + end long before the delay fires. This is
      // the reported "blue flicker in the top left of the Tasks section".
      const operation = registry.begin("/dev/progress-binder-instant", { label: "Rename Task" });
      assert.equal(operation !== null, true);
      registry.end(operation);

      await sleep(60);
      assert.deepEqual(calls, [], "an instant operation must not flash the Tasks progress bar");
    } finally {
      delete windowWithCalls._withProgressCalls;
      binder.dispose();
      registry.dispose();
    }
  });

  void it("still shows the bar for an operation that outlasts the show delay", async () => {
    const registry = new TaskOperationRegistry();
    const binder = new ViewProgressBinder(registry, 10);
    const calls: Array<{ options: { location?: { viewId?: string } } }> = [];
    const windowWithCalls = vscode.window as typeof vscode.window & {
      _withProgressCalls?: typeof calls;
    };
    windowWithCalls._withProgressCalls = calls;

    try {
      const operation = registry.begin("/dev/progress-binder-long", { label: "Review", stage: "plan-low-review" });
      assert.equal(operation !== null, true);
      await waitUntil(
        () => calls.length > 0,
        500,
        "expected the long-running operation to surface a withProgress call within 500ms of the show delay"
      );

      assert.deepEqual(
        calls.map((call) => call.options.location?.viewId),
        [STATUS_VIEW_ID],
        "a long-running operation must surface the Notifications progress bar after the delay"
      );
      registry.end(operation);
    } finally {
      delete windowWithCalls._withProgressCalls;
      binder.dispose();
      registry.dispose();
    }
  });
});
