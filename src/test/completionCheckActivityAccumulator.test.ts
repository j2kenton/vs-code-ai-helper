/**
 * Notifications in-flight visibility (plan Part III):
 * `createCompletionCheckActivityAccumulatorV1` (reviewActions.ts) turns
 * `collectCompletionLintPreview`'s per-check `onCheckEvent` callbacks into
 * ONE aggregate activity report on the workflow root operation, instead of
 * one Notifications update per check. This file tests the accumulator in
 * isolation against a fake `TaskOperationHandle` — the underlying checks
 * themselves keep running exactly as before (see
 * completionLintCheckObserver.test.ts for the real-process concurrency
 * proof); this suite only proves the aggregation/rendering/closing logic.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCompletionCheckActivityAccumulatorV1 } from "../commands/reviewActions";
import { CompletionCheckDescriptor } from "../utils/completionLint";
import { TaskOperationHandle } from "../utils/taskOperations";

interface RecordedCall {
  activity: string | undefined;
  options?: { resetElapsedOrigin?: boolean; stageToken?: number; elapsedOrigin?: number };
}

function makeFakeOp(): { calls: RecordedCall[]; handle: TaskOperationHandle } {
  const calls: RecordedCall[] = [];
  const handle: Pick<TaskOperationHandle, "reportActivity"> = {
    reportActivity: (activity, options) => {
      calls.push({ activity, options });
      return 1;
    },
  };
  return { calls, handle: handle as TaskOperationHandle };
}

void describe("createCompletionCheckActivityAccumulatorV1", () => {
  void it("is a safe no-op when no operation handle is supplied (preflight/commit-push callers)", () => {
    const acc = createCompletionCheckActivityAccumulatorV1(undefined, undefined);
    assert.doesNotThrow(() => {
      acc.onCheckEvent.planned(1);
      acc.onCheckEvent.started({ command: "npm run lint" });
      acc.onCheckEvent.settled({ command: "npm run lint" });
      acc.onCheckEvent.batchBoundary();
      acc.close();
    });
  });

  void it("renders a single active check directly, with a running completed/planned count", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, 7);
    const descriptor: CompletionCheckDescriptor = { command: "npm run lint" };

    acc.onCheckEvent.planned(1);
    acc.onCheckEvent.started(descriptor);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.activity, "npm run lint · 0/1 complete");
    assert.equal(calls[0]!.options?.stageToken, 7);
    assert.equal(typeof calls[0]!.options?.elapsedOrigin, "number");

    acc.onCheckEvent.settled(descriptor);
    assert.equal(calls.length, 2);
    // No more active checks and no batchBoundary call: a neutral count, NOT
    // "starting next batch" — nothing tells the accumulator a next batch is
    // actually coming, and this may in fact be the true end of the pass.
    assert.equal(calls[1]!.activity, "1/1 complete");
    assert.equal(calls[1]!.options?.elapsedOrigin, undefined);
  });

  void it('never renders "starting next batch" from the active set emptying out on its own — only from an explicit batchBoundary call', () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const a: CompletionCheckDescriptor = { command: "npm run lint" };
    const b: CompletionCheckDescriptor = { command: "npm run test" };

    acc.onCheckEvent.planned(2);
    acc.onCheckEvent.started(a);
    acc.onCheckEvent.settled(a);
    acc.onCheckEvent.started(b);
    acc.onCheckEvent.settled(b);

    assert.ok(
      calls.every((call) => !call.activity?.includes("starting next batch")),
      "no rendered activity may claim a next batch without an explicit batchBoundary signal"
    );
  });

  void it("planned() sets the fixed denominator up front, so the shown total is correct from the FIRST report and never appears to grow after N/N", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined, 12345);
    const rootCheck: CompletionCheckDescriptor = { command: "npm run lint" };
    const memberCheck: CompletionCheckDescriptor = { command: "[apps/server] npm run test" };

    // The true grand total (root + member) is known and reported BEFORE any
    // check starts — the very first rendered count already reads "0/2", not
    // "0/1" growing later to "0/2".
    acc.onCheckEvent.planned(2);

    acc.onCheckEvent.started(rootCheck);
    assert.equal(calls[calls.length - 1]!.activity, "npm run lint · 0/2 complete");
    acc.onCheckEvent.settled(rootCheck);
    assert.equal(calls[calls.length - 1]!.activity, "1/2 complete");

    // batchBoundary carries no count of its own (the total was already
    // correct) — it only marks the real transition point in time.
    acc.onCheckEvent.batchBoundary();
    assert.equal(calls[calls.length - 1]!.activity, "1/2 complete · starting next batch");
    // Between batches, the elapsed origin is restored to the completion
    // stage's own origin, not the now-stale settled check's start time.
    assert.equal(calls[calls.length - 1]!.options?.elapsedOrigin, 12345);

    acc.onCheckEvent.started(memberCheck);
    assert.equal(calls[calls.length - 1]!.activity, "[apps/server] npm run test · 1/2 complete");

    acc.onCheckEvent.settled(memberCheck);
    // Final settle with no further batchBoundary call: neutral count, no
    // false "starting next batch" claim, stage origin restored again.
    assert.equal(calls[calls.length - 1]!.activity, "2/2 complete");
    assert.equal(calls[calls.length - 1]!.options?.elapsedOrigin, 12345);
  });

  void it("batchBoundary is ignored after close()", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);

    acc.close();
    acc.onCheckEvent.planned(3);
    acc.onCheckEvent.batchBoundary();
    assert.equal(calls.length, 0, "planned/batchBoundary after close() must be a no-op");
  });

  void it("shows a deterministic representative (earliest-started) plus a count when several checks are active", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const a: CompletionCheckDescriptor = { command: "npm run lint" };
    const b: CompletionCheckDescriptor = { command: "npm run check-types" };
    const c: CompletionCheckDescriptor = { command: "[apps/server] npm run test" };

    acc.onCheckEvent.planned(3);
    acc.onCheckEvent.started(a);
    acc.onCheckEvent.started(b);
    acc.onCheckEvent.started(c);

    const last = calls[calls.length - 1]!;
    assert.equal(last.activity, "3 checks running · npm run lint (+2) · 0/3 complete");
  });

  void it("keeps the same representative under out-of-order completion, until it is itself the one that settles", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const a: CompletionCheckDescriptor = { command: "npm run lint" };
    const b: CompletionCheckDescriptor = { command: "npm run check-types" };

    acc.onCheckEvent.planned(2);
    acc.onCheckEvent.started(a);
    acc.onCheckEvent.started(b);

    // b (started second) settles first — a, the earliest-started, is still
    // the representative, and only a remains active.
    acc.onCheckEvent.settled(b);
    let last = calls[calls.length - 1]!;
    assert.equal(last.activity, "npm run lint · 1/2 complete");

    acc.onCheckEvent.settled(a);
    last = calls[calls.length - 1]!;
    assert.equal(last.activity, "2/2 complete");
  });

  void it("accumulates completed counts cumulatively across separate batches (root pass then monorepo pass)", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const rootCheck: CompletionCheckDescriptor = { command: "npm run lint" };
    const memberCheck: CompletionCheckDescriptor = { command: "[apps/server] npm run test" };

    // The true combined total (root pass + monorepo member pass) is reported
    // once, up front, exactly as collectCompletionLint now does via
    // `planned` before its root batch starts.
    acc.onCheckEvent.planned(2);

    // First batch (e.g. the root/explicit pass).
    acc.onCheckEvent.started(rootCheck);
    acc.onCheckEvent.settled(rootCheck);
    assert.equal(calls[calls.length - 1]!.activity, "1/2 complete");

    // Second batch (e.g. the monorepo member pass), announced via
    // batchBoundary as collectCompletionLint itself now does — completed
    // carries over rather than resetting, matching the worked example's
    // "4/9 complete", with the total already correct throughout.
    acc.onCheckEvent.batchBoundary();
    assert.equal(calls[calls.length - 1]!.activity, "1/2 complete · starting next batch");
    acc.onCheckEvent.started(memberCheck);
    assert.equal(calls[calls.length - 1]!.activity, "[apps/server] npm run test · 1/2 complete");
    acc.onCheckEvent.settled(memberCheck);
    assert.equal(calls[calls.length - 1]!.activity, "2/2 complete");
  });

  void it("sets elapsedOrigin to the earliest active check's own start time, advancing when that check settles", async () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const a: CompletionCheckDescriptor = { command: "npm run lint" };
    const b: CompletionCheckDescriptor = { command: "npm run check-types" };

    acc.onCheckEvent.planned(2);
    acc.onCheckEvent.started(a);
    const aStartedAt = calls[calls.length - 1]!.options?.elapsedOrigin;
    assert.equal(typeof aStartedAt, "number");

    await new Promise((resolve) => setTimeout(resolve, 20));
    acc.onCheckEvent.started(b);
    // a is still the oldest active check — the origin must not have moved
    // to b's later start time.
    assert.equal(calls[calls.length - 1]!.options?.elapsedOrigin, aStartedAt);

    acc.onCheckEvent.settled(a);
    // a has settled; b is now the sole (and therefore oldest) active check —
    // the origin must advance to b's own start time.
    const afterASettled = calls[calls.length - 1]!.options?.elapsedOrigin;
    assert.equal(typeof afterASettled, "number");
    assert.ok((afterASettled as number) > (aStartedAt as number));
  });

  void it("close() makes every later callback a no-op, so a check that settles after the pass has ended cannot overwrite a newer stage", () => {
    const { calls, handle } = makeFakeOp();
    const acc = createCompletionCheckActivityAccumulatorV1(handle, undefined);
    const a: CompletionCheckDescriptor = { command: "npm run lint" };

    acc.onCheckEvent.planned(2);
    acc.onCheckEvent.started(a);
    const countBeforeClose = calls.length;

    acc.close();
    acc.onCheckEvent.settled(a);
    acc.onCheckEvent.started({ command: "npm run build" });
    acc.onCheckEvent.batchBoundary();

    assert.equal(calls.length, countBeforeClose, "no reportActivity call may happen after close()");
  });
});
