/**
 * bugs4 item 26: a decision answered while a round runs is held, then carried out when the round
 * ends — or reported and re-offered when it cannot be.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  armDeferredOptionRunV1,
  cancelDeferredOptionRunV1,
  describeDeferredOptionHeldV1,
  describeDeferredOptionOutcomeV1,
  isDeferredOptionRunArmedV1,
  type DeferredRunOutcomeV1,
} from "../utils/deferredOptionRunV1";

function harness(options: { busy?: boolean; carryOut?: () => Promise<DeferredRunOutcomeV1>; maxWaitMs?: number } = {}) {
  let busy = options.busy ?? true;
  let listener: (() => void) | undefined;
  let disposed = 0;
  const reports: DeferredRunOutcomeV1[] = [];
  let carried = 0;
  const harnessState = { resolve: (): void => undefined };
  const reported = new Promise<void>((resolve) => {
    harnessState.resolve = resolve;
  });
  const input = {
    key: `k-${Math.random()}`,
    isTaskBusy: () => busy,
    subscribeToTaskFree: (l: () => void) => {
      listener = l;
      return { dispose: (): void => void (disposed += 1) };
    },
    carryOut:
      options.carryOut ??
      ((): Promise<DeferredRunOutcomeV1> => {
        carried += 1;
        return Promise.resolve({ kind: "done" });
      }),
    report: (outcome: DeferredRunOutcomeV1): Promise<void> => {
      reports.push(outcome);
      harnessState.resolve();
      return Promise.resolve();
    },
    pollMs: 60_000,
    ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
  };
  return {
    input,
    reports,
    reported,
    free: (): void => {
      busy = false;
      listener?.();
    },
    stillBusySignal: (): void => listener?.(),
    carried: (): number => carried,
    disposed: (): number => disposed,
  };
}

void describe("armDeferredOptionRunV1 (bugs4 item 26)", () => {
  void it("holds the effect while the task is busy and runs it once when the round ends", async () => {
    const h = harness();
    assert.equal(armDeferredOptionRunV1(h.input), true);
    h.stillBusySignal();
    assert.equal(h.carried(), 0, "nothing runs into the running round");
    h.free();
    h.free();
    await h.reported;
    assert.equal(h.carried(), 1, "a second end signal cannot run it twice");
    assert.deepEqual(h.reports, [{ kind: "done" }]);
    assert.equal(isDeferredOptionRunArmedV1(h.input.key), false);
    assert.ok(h.disposed() >= 1, "the subscription is released");
  });

  void it("arming the same answer twice keeps one waiter", () => {
    const h = harness();
    assert.equal(armDeferredOptionRunV1(h.input), true);
    assert.equal(armDeferredOptionRunV1(h.input), false);
    cancelDeferredOptionRunV1(h.input.key);
    assert.equal(isDeferredOptionRunArmedV1(h.input.key), false);
  });

  void it("an effect that cannot be carried out is reported with its reason", async () => {
    const h = harness({
      carryOut: () => Promise.resolve({ kind: "notCarriedOut", reason: "the task is now at Publish, not Low-Level Code Review." }),
    });
    armDeferredOptionRunV1(h.input);
    h.free();
    await h.reported;
    assert.equal(h.reports[0]?.kind, "notCarriedOut");
    assert.match(
      describeDeferredOptionOutcomeV1("Move on", h.reports[0] as DeferredRunOutcomeV1),
      /could not be carried out now that the round has ended: the task is now at Publish.*The card is back/s
    );
  });

  void it("a throwing effect becomes a reported failure, never an unhandled rejection", async () => {
    const h = harness({ carryOut: () => Promise.reject(new Error("boom")) });
    armDeferredOptionRunV1(h.input);
    h.free();
    await h.reported;
    assert.deepEqual(h.reports, [{ kind: "notCarriedOut", reason: "boom" }]);
  });

  void it("a round that never ends does not hold the answer forever", async () => {
    const h = harness({ maxWaitMs: -1 });
    armDeferredOptionRunV1(h.input);
    h.stillBusySignal();
    await h.reported;
    assert.deepEqual(h.reports, [{ kind: "expired" }]);
    assert.equal(h.carried(), 0);
    assert.match(describeDeferredOptionOutcomeV1("Move on", { kind: "expired" }), /The card is back/);
  });

  void it("says what is running, that the choice is kept, and what happens if it cannot run", () => {
    const text = describeDeferredOptionHeldV1('"Apply Review" (running 3 min so far)', "Move on");
    assert.match(text, /"Apply Review".*still running/);
    assert.match(text, /"Move on" has not run yet/);
    assert.match(text, /offers the choice again/);
  });
});
