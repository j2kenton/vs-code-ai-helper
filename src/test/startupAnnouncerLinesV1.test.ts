/**
 * bugs5 Step 18: the start-up lines name the action in plain words, and a live Publish Checks run
 * counts as started (so "no command has started yet" is never posted while one runs).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  endedBeforeStartLineV1,
  isLivePublishChecksRunV1,
  startingLineV1,
  STARTUP_ANNOUNCER_MAX_AGE_MS_V1,
  startupAnnouncerExpiredV1,
  stillStartingLineV1,
} from "../utils/startupAnnouncerLinesV1";
import type { PublishChecksOutcomeV1 } from "../utils/publishChecksOutcomeV1";

const INTERNAL_TERMS = /holds this task|admission|no command has started|the action\b/i;

void describe("bugs5 Step 18: start-up lines", () => {
  void it("name the action and say to wait, without internal terms", () => {
    const lines = [
      startingLineV1("Advance to Publish"),
      stillStartingLineV1("Advance to Publish", 1.6),
      endedBeforeStartLineV1("Advance to Publish"),
    ];
    assert.equal(lines[0], "Advance to Publish is starting — wait here; progress appears below.");
    assert.equal(lines[1], "Advance to Publish is still starting (1.6 min).");
    for (const line of lines) {
      assert.match(line, /Advance to Publish/);
      assert.doesNotMatch(line, INTERNAL_TERMS);
    }
  });

  void it("rounds the waiting time to one decimal", () => {
    assert.equal(stillStartingLineV1("Run", 2.04999), "Run is still starting (2 min).");
    assert.equal(stillStartingLineV1("Run", 2.26), "Run is still starting (2.3 min).");
  });
});

void describe("bugs5 Step 18: a live Publish Checks run is started", () => {
  const running: PublishChecksOutcomeV1 = {
    outcome: "running",
    at: "2026-11-01T16:38:31.000Z",
    pid: 4242,
    hostname: "box",
    finishedCommands: [],
    runningCommands: ["pnpm run verify"],
  };

  void it("is true for a running record whose process is alive", () => {
    assert.equal(isLivePublishChecksRunV1(running, (pid) => pid === 4242), true);
  });

  void it("is false for a dead process, no record, or any other outcome", () => {
    assert.equal(isLivePublishChecksRunV1(running, () => false), false);
    assert.equal(isLivePublishChecksRunV1(undefined, () => true), false);
    assert.equal(isLivePublishChecksRunV1({ outcome: "passed", at: running.at }, () => true), false);
    assert.equal(
      isLivePublishChecksRunV1({ outcome: "interrupted", at: running.at, finishedCommands: [], unknownCommands: [] }, () => true),
      false
    );
  });
});

void describe("review2 Step 42: a long-waiting announcer does not name its action for a later click", () => {
  void it("expires after the maximum age, so a command awaited for hours cannot announce another start", () => {
    const armed = Date.parse("2026-11-07T16:00:00.000Z");
    assert.equal(startupAnnouncerExpiredV1(armed, armed + 60_000), false);
    assert.equal(startupAnnouncerExpiredV1(armed, armed + STARTUP_ANNOUNCER_MAX_AGE_MS_V1), false);
    // run1 2026-11-07: armed at 16:00, the owner clicked Start Fast Forward at 17:59.
    assert.equal(startupAnnouncerExpiredV1(armed, Date.parse("2026-11-07T17:59:53.000Z")), true);
  });
});
