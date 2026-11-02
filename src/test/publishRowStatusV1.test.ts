/**
 * bugs5 Steps 11 and 18: the Publish row says where Publish has got to before the review has scored,
 * and an interrupted checks run never reads as running.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describePublishRowStatusV1 } from "../utils/publishRowStatusV1";
import type { PublishChecksOutcomeV1 } from "../utils/publishChecksOutcomeV1";

const AT = "2026-11-01T10:00:00.000Z";
const base = { hasScore: false, checksOperationLive: false, reviewRunning: false, hostname: "box" } as const;

void describe("describePublishRowStatusV1 (bugs5 Steps 11/18)", () => {
  void it("shows nothing special once a score exists", () => {
    const outcome: PublishChecksOutcomeV1 = { outcome: "passed", at: AT };
    assert.equal(describePublishRowStatusV1({ ...base, outcome, hasScore: true }), undefined);
  });

  void it("a live checks operation reads Checks running", () => {
    assert.equal(describePublishRowStatusV1({ ...base, outcome: undefined, checksOperationLive: true }), "Checks running");
  });

  void it("a running record whose process is gone reads Checks interrupted", () => {
    const outcome: PublishChecksOutcomeV1 = {
      outcome: "running",
      at: AT,
      pid: 999_999,
      hostname: "box",
      finishedCommands: [],
      runningCommands: ["npm run test"],
    };
    assert.equal(describePublishRowStatusV1({ ...base, outcome, isProcessAlive: () => false }), "Checks interrupted");
    assert.equal(describePublishRowStatusV1({ ...base, outcome, isProcessAlive: () => true }), "Checks running");
  });

  void it("a running record written by this process with no live operation of its own is interrupted", () => {
    const outcome: PublishChecksOutcomeV1 = {
      outcome: "running",
      at: AT,
      pid: process.pid,
      hostname: "box",
      finishedCommands: [],
      runningCommands: [],
    };
    assert.equal(describePublishRowStatusV1({ ...base, outcome }), "Checks interrupted");
  });

  void it("an interrupted record reads Checks interrupted", () => {
    const outcome: PublishChecksOutcomeV1 = { outcome: "interrupted", at: AT, finishedCommands: [], unknownCommands: [] };
    assert.equal(describePublishRowStatusV1({ ...base, outcome }), "Checks interrupted");
  });

  void it("failed, passed and the AI review each have their own text", () => {
    assert.equal(
      describePublishRowStatusV1({ ...base, outcome: { outcome: "failed", at: AT, failedCommands: ["a", "b"] } }),
      "Checks failed: 2"
    );
    assert.equal(
      describePublishRowStatusV1({ ...base, outcome: { outcome: "passed", at: AT } }),
      "Checks passed · AI review not run yet"
    );
    assert.equal(
      describePublishRowStatusV1({ ...base, outcome: { outcome: "passed", at: AT }, reviewRunning: true }),
      "AI review running"
    );
  });

  void it("a cancelled run falls back to the earlier completed result, or to nothing", () => {
    assert.equal(
      describePublishRowStatusV1({
        ...base,
        outcome: { outcome: "cancelled", at: AT, cause: "you", lastCompleted: { outcome: "passed", at: AT } },
      }),
      "Checks passed · AI review not run yet"
    );
    assert.equal(describePublishRowStatusV1({ ...base, outcome: { outcome: "cancelled", at: AT, cause: "you" } }), undefined);
  });
});
