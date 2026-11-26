/**
 * chat1 Step 6: the live run strip answers "is it running?" without a log. It names what runs, on
 * which model, since when and its latest progress; it is absent when nothing runs.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRunStripV1, runStripChangedV1, type RunStripOperationV1 } from "../views/chatRunStripV1";

const clock = (epochMs: number): string => `t${epochMs}`;

function operation(overrides: Partial<RunStripOperationV1> = {}): RunStripOperationV1 {
  return {
    id: "op-1",
    label: "Apply Review",
    stage: "impl-high-review",
    startedAt: 1000,
    waitingForUser: false,
    cancellable: true,
    state: "running",
    ...overrides,
  };
}

void describe("buildRunStripV1", () => {
  void it("is absent when nothing runs", () => {
    assert.equal(buildRunStripV1([], "impl", clock), undefined);
    assert.equal(buildRunStripV1([operation({ state: "succeeded" })], "impl", clock), undefined);
  });

  void it("names what runs, since when, the model and the latest progress", () => {
    const strip = buildRunStripV1(
      [operation({ modelId: "", activity: "pnpm run lint · 1/12 complete", detail: "ignored" })],
      "impl",
      clock
    );
    assert.ok(strip);
    assert.equal(strip.operationId, "op-1");
    assert.match(strip.label, /Apply Review/);
    assert.equal(strip.sinceClock, "t1000");
    assert.equal(strip.latest, "pnpm run lint · 1/12 complete");
    assert.equal(strip.waiting, false);
    assert.equal(strip.cancellable, true);
  });

  void it("does not repeat the progress text inside the label", () => {
    const strip = buildRunStripV1([operation({ activity: "reading context (80 KB)" })], "impl", clock);
    assert.ok(strip);
    assert.doesNotMatch(strip.label, /reading context/);
  });

  void it("says the model has not started yet while checks run, never a stale one", () => {
    const strip = buildRunStripV1([operation({ activity: "2 checks running · pnpm run lint (+1) · 0/12 complete" })], "impl", clock);
    assert.equal(strip?.model, "checks running; model not started yet");
  });

  void it("counts root operations only", () => {
    const strip = buildRunStripV1(
      [operation({ id: "child", parentId: "op-1", startedAt: 2000 }), operation({ id: "op-1" })],
      "impl",
      clock
    );
    assert.equal(strip?.operationId, "op-1");
    assert.equal(buildRunStripV1([operation({ parentId: "x" })], "impl", clock), undefined);
  });

  void it("prefers an operation that is moving over one waiting on the owner, then the newest", () => {
    const waiting = operation({ id: "waiting", startedAt: 3000, waitingForUser: true });
    const older = operation({ id: "older", startedAt: 1000 });
    const newer = operation({ id: "newer", startedAt: 2000 });
    assert.equal(buildRunStripV1([waiting, older, newer], "impl", clock)?.operationId, "newer");
    assert.equal(buildRunStripV1([waiting], "impl", clock)?.waiting, true);
  });
});

void describe("runStripChangedV1", () => {
  void it("only reports a difference the owner would see", () => {
    const a = buildRunStripV1([operation()], "impl", clock);
    const same = buildRunStripV1([operation()], "impl", clock);
    const moved = buildRunStripV1([operation({ activity: "2/12 complete" })], "impl", clock);
    assert.equal(runStripChangedV1(a, same), false);
    assert.equal(runStripChangedV1(a, moved), true);
    assert.equal(runStripChangedV1(a, undefined), true);
    assert.equal(runStripChangedV1(undefined, undefined), false);
  });
});
