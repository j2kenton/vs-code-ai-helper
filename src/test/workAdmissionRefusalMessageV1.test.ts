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
 *
 * Reporting the renewal age was still not enough on its own: "last renewed
 * ~347s ago" only means something to a reader who knows the heartbeat is two
 * minutes. Once the renewal age passes five missed heartbeats — far enough
 * out that a sleeping laptop cannot reach it — the refusal leads with the
 * conclusion instead (verification review, 2026-09-18).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
  WorkAdmissionBusyV1,
  describeWorkAdmissionRefusalV1,
} from "../state/workAdmissionV1";

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
    // Inside one heartbeat: a genuinely busy task.
    ageMs: 47_000,
    likelyStale: false,
    ...overrides,
  } as WorkAdmissionBusyV1;
}

void describe("describeWorkAdmissionRefusalV1", () => {
  void it("separates how long the claim has run from how long since it was renewed", () => {
    const message = describeWorkAdmissionRefusalV1(busy());
    assert.match(message, /held by fastForwardReviewWithAI \(pid 296899 on host-a\)/);
    assert.match(message, /running for ~20 min/, "the claim's own recorded start");
    assert.match(message, /last renewed ~47s ago/, "the marker's age, named for what it is");
    assert.doesNotMatch(message, /started ~47s ago/, "the renewal age must never be reported as the start");
  });

  void it("says so plainly when the record cannot be read", () => {
    const message = describeWorkAdmissionRefusalV1(busy({ owner: undefined }));
    assert.match(message, /held by an unreadable record/);
    assert.match(message, /start time unknown/);
    assert.match(message, /last renewed ~47s ago/);
  });

  void it("still offers the stale explanation when the claim looks abandoned", () => {
    const message = describeWorkAdmissionRefusalV1(busy({ likelyStale: true }));
    assert.match(message, /this looks stale/);
    assert.match(message, /takeover/);
  });

  void it("calls an unrenewed claim stuck rather than busy, well before the 20-minute stale threshold", () => {
    // Renewed 11 minutes ago — five missed heartbeats — while `likelyStale`
    // is still false because the 20-minute threshold has not passed.
    const message = describeWorkAdmissionRefusalV1(busy({ ageMs: 11 * 60_000, likelyStale: false }));
    assert.match(message, /looks stuck rather than busy/);
    assert.match(message, /renewed its claim for ~11 min/);
    assert.match(message, /renews every 2/, "the heartbeat interval is stated, not assumed knowledge");
    assert.match(message, /takeover/, "one concrete next step");
    assert.doesNotMatch(
      message,
      /already has a stage action in progress/,
      "the busy wording is what misled the user in the incident"
    );
  });

  void it("keeps the busy wording while renewals are arriving", () => {
    const message = describeWorkAdmissionRefusalV1(busy({ ageMs: WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 + 1_000 }));
    assert.match(message, /already has a stage action in progress/);
    assert.doesNotMatch(message, /looks stuck/);
  });

  void it("a laptop that slept through a few heartbeats is not called stuck", () => {
    // `setInterval` does not fire while the machine is asleep, so a healthy
    // round can be several minutes unrenewed and catch up on its next tick.
    // Calling that task stuck is the same lie in the other direction
    // (verification review, 2026-09-18).
    const message = describeWorkAdmissionRefusalV1(busy({ ageMs: 4 * WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 }));
    assert.doesNotMatch(message, /looks stuck/);
    assert.match(message, /already has a stage action in progress/);
  });

  void it("an unreadable renewal time is named as unknown, never printed as Infinity", () => {
    // `describeMarkerAsBlockerV1` uses POSITIVE_INFINITY when it cannot stat
    // the marker; "~Infinitys ago" reached the user.
    const message = describeWorkAdmissionRefusalV1(busy({ ageMs: Number.POSITIVE_INFINITY }));
    assert.doesNotMatch(message, /Infinity/);
    assert.match(message, /last renewed at an unknown time/);
  });

  void it("never prints a negative run time when the owner's clock is ahead", () => {
    // The runner is on another machine: its startedAt can be in this
    // window's future, and "running for ~-3 min" is worse than nothing.
    const base = busy();
    const skewed = busy({
      owner: { ...base.owner!, startedAt: new Date(Date.now() + 3 * 60 * 1000).toISOString() },
    });
    assert.match(describeWorkAdmissionRefusalV1(skewed), /running for ~0 min/);
    assert.doesNotMatch(describeWorkAdmissionRefusalV1(skewed), /~-/);
  });

  void it("a write failure names the real error instead of blaming a busy task", () => {
    assert.equal(
      describeWorkAdmissionRefusalV1({ outcome: "writeFailed", error: new Error("EACCES: permission denied") }),
      "Could not start this stage action: EACCES: permission denied"
    );
  });
});
