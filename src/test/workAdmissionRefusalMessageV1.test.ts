/**
 * The "already in progress" refusal must describe the claim honestly
 * (describeWorkAdmissionRefusalV1).
 *
 * It used to report the marker's age as "started ~Ns ago". Since the
 * heartbeat touches the marker on every renewal, that number is the age of
 * the last RENEWAL — so a claim whose owner had just died read as work that
 * had only just begun. Seen live 2026-09-18: a container recreated mid-round
 * left a claim renewed seconds before its owner vanished, and the refusal
 * announced "started ~347s ago" about a task where nothing was running.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWorkAdmissionRefusalV1, WorkAdmissionBusyV1 } from "../state/workAdmissionV1";

function busy(overrides: Partial<WorkAdmissionBusyV1> = {}): WorkAdmissionBusyV1 {
  return {
    outcome: "busy",
    owner: {
      claimId: "c1",
      ownerToken: "o1",
      hostId: "host-a",
      pid: 296899,
      commandId: "fastForwardReviewWithAI",
      purpose: "admission",
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    },
    markerPath: "/w/.ensemble/t1/admission-v1/admission.o1.g8.abc",
    ageMs: 347_000,
    likelyStale: false,
    ...overrides,
  } as WorkAdmissionBusyV1;
}

void describe("describeWorkAdmissionRefusalV1", () => {
  void it("separates how long the claim has run from how long since it was renewed", () => {
    const message = describeWorkAdmissionRefusalV1(busy());
    assert.match(message, /held by fastForwardReviewWithAI \(pid 296899 on host-a\)/);
    assert.match(message, /running for ~20 min/, "the claim's own recorded start");
    assert.match(message, /last renewed ~347s ago/, "the marker's age, named for what it is");
    assert.doesNotMatch(message, /started ~347s ago/, "the renewal age must never be reported as the start");
  });

  void it("says so plainly when the record cannot be read", () => {
    const message = describeWorkAdmissionRefusalV1(busy({ owner: undefined }));
    assert.match(message, /held by an unreadable record/);
    assert.match(message, /start time unknown/);
    assert.match(message, /last renewed ~347s ago/);
  });

  void it("still offers the stale explanation when the claim looks abandoned", () => {
    const message = describeWorkAdmissionRefusalV1(busy({ likelyStale: true }));
    assert.match(message, /this looks stale/);
    assert.match(message, /takeover/);
  });

  void it("a write failure names the real error instead of blaming a busy task", () => {
    assert.equal(
      describeWorkAdmissionRefusalV1({ outcome: "writeFailed", error: new Error("EACCES: permission denied") }),
      "Could not start this stage action: EACCES: permission denied"
    );
  });
});
