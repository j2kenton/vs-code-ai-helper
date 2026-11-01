import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  clearStageActionRefusalReasonV1,
  peekRecentStageActionRefusalReasonV1,
  recordStageActionRefusalReasonV1,
  takeStageActionRefusalReasonV1,
} from "../utils/stageActionRefusalV1";

// bugs4 item 3: the automation chain names the real cause of a declined
// dispatch (e.g. a typed preflight refusal) by peeking at the recorded reason
// without consuming it, and never attributes a stale reason to a later decline.
void describe("peekRecentStageActionRefusalReasonV1", () => {
  const folder = "/tmp/peek-refusal-task";

  void it("returns a fresh reason without consuming it, so the owning caller can still take it", () => {
    recordStageActionRefusalReasonV1(folder, "High-Level Code Review was not run (no reviewer was invoked): x.");
    assert.match(peekRecentStageActionRefusalReasonV1(folder) ?? "", /was not run/);
    assert.match(peekRecentStageActionRefusalReasonV1(folder) ?? "", /was not run/, "peeking twice still sees it");
    assert.match(takeStageActionRefusalReasonV1(folder) ?? "", /was not run/);
    assert.equal(peekRecentStageActionRefusalReasonV1(folder), undefined, "taken: nothing left to peek");
  });

  void it("ignores a reason older than the window (a stale refusal is not blamed for a later decline)", () => {
    recordStageActionRefusalReasonV1(folder, "old reason");
    assert.equal(peekRecentStageActionRefusalReasonV1(folder, 30_000, Date.now() + 31_000), undefined);
    assert.equal(peekRecentStageActionRefusalReasonV1(folder, 30_000, Date.now()), "old reason");
    clearStageActionRefusalReasonV1(folder);
  });

  void it("is undefined for an unknown folder or no folder", () => {
    assert.equal(peekRecentStageActionRefusalReasonV1(undefined), undefined);
    assert.equal(peekRecentStageActionRefusalReasonV1("/tmp/never-recorded"), undefined);
  });
});
