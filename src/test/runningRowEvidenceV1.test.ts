/**
 * run1 Step 18: the running row's proof-of-life wording. The last-activity line and the no-activity
 * warning read the round's own output and provable actions only; files other windows changed never
 * update the line and never hide the warning.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRunningRowEvidenceV1, formatAgoV1 } from "../utils/runningRowEvidenceV1";
import type { ProofOfLifeV1 } from "../utils/proofOfLifeV1";

const MIN = 60_000;
const START = Date.UTC(2026, 10, 6, 6, 0, 0);

void describe("run1 Step 18: running row evidence", () => {
  void it("says when the round last did something provable, with what it was", () => {
    const proof: ProofOfLifeV1 = {
      pid: 12,
      processState: "alive",
      lastContactAt: START + 5 * MIN,
      lastProgressAt: START + 5 * MIN,
      lastProgressWhat: "edited `reviewActions.ts`",
    };
    const evidence = describeRunningRowEvidenceV1({ proof, startedAt: START, now: START + 5 * MIN + 20_000, warningMinutes: 10 });
    assert.equal(evidence.activityLine, "last activity 20 s ago: edited `reviewActions.ts`");
    assert.equal(evidence.stuck, false);
    assert.equal(evidence.warning, undefined);
  });

  void it("warns after the warning time with no output and no provable action, and offers Stop and Wait", () => {
    const proof: ProofOfLifeV1 = { pid: 12, processState: "alive", lastContactAt: START + 2 * MIN };
    const evidence = describeRunningRowEvidenceV1({ proof, startedAt: START, now: START + 16 * MIN, warningMinutes: 10 });
    assert.equal(evidence.stuck, true);
    assert.match(evidence.warning ?? "", /^no activity for 14 min \(since \d\d:\d\d\) — may be stuck$/);
  });

  void it("a workspace change that is only observed neither updates the activity line nor hides the warning", () => {
    const proof: ProofOfLifeV1 = {
      pid: 12,
      processState: "alive",
      lastContactAt: START + MIN,
      lastProgressAt: START + MIN,
      lastProgressWhat: "ran `pnpm run lint`",
      lastObservedChangeAt: START + 14 * MIN,
      lastObservedChangeWhat: "`x.ts`",
    };
    const evidence = describeRunningRowEvidenceV1({ proof, startedAt: START, now: START + 15 * MIN, warningMinutes: 10 });
    assert.equal(evidence.stuck, true, "another window's edit does not make the round look busy");
    assert.ok(!(evidence.activityLine ?? "").includes("x.ts"));
    assert.ok(evidence.tooltipLines.some((line) => /x\.ts.*not proven to be this round's/.test(line)));
  });

  void it("a silent round with an outstanding command names the command, not another host's edits", () => {
    const proof: ProofOfLifeV1 = {
      processState: "alive",
      lastContactAt: START + MIN,
      lastProgressAt: START + MIN,
      lastProgressWhat: "ran `pnpm run build`",
      lastObservedChangeAt: START + 11 * MIN,
      lastObservedChangeWhat: "`src/a.ts`",
    };
    const evidence = describeRunningRowEvidenceV1({ proof, startedAt: START, now: START + 12 * MIN, warningMinutes: 10 });
    assert.equal(evidence.stuck, true);
    assert.match(evidence.activityLine ?? "", /ran `pnpm run build`/);
    assert.ok(!(evidence.activityLine ?? "").includes("src/a.ts"));
  });

  void it("a provider that prints only when it finishes says so, and that the process is still there", () => {
    const proof: ProofOfLifeV1 = { pid: 3, processState: "alive", reportsOnlyAtEnd: true };
    const evidence = describeRunningRowEvidenceV1({
      proof,
      startedAt: START,
      now: START + 14 * MIN,
      warningMinutes: 10,
      providerLabel: "Antigravity CLI",
    });
    assert.match(evidence.warning ?? "", /^no output for 14 min \(since \d\d:\d\d\); Antigravity CLI reports only when it finishes; the process is still there$/);
  });

  void it("says at once that the process ended, without waiting for the warning time", () => {
    const proof: ProofOfLifeV1 = { pid: 3, processState: "ended", lastContactAt: START + MIN };
    const evidence = describeRunningRowEvidenceV1({ proof, startedAt: START, now: START + 2 * MIN, warningMinutes: 10 });
    assert.equal(evidence.processEnded, true);
    assert.match(evidence.warning ?? "", /process has ended/);
    assert.equal(evidence.stuck, false);
  });

  void it("Wait hides the warning until the hidden-until time, and a round waiting for the owner never warns", () => {
    const proof: ProofOfLifeV1 = { processState: "alive", lastContactAt: START };
    const base = { proof, startedAt: START, now: START + 20 * MIN, warningMinutes: 10 } as const;
    assert.equal(describeRunningRowEvidenceV1(base).stuck, true);
    assert.equal(describeRunningRowEvidenceV1({ ...base, warningHiddenUntil: START + 25 * MIN }).stuck, false);
    assert.equal(describeRunningRowEvidenceV1({ ...base, warningHiddenUntil: START + 19 * MIN }).stuck, true);
    assert.equal(describeRunningRowEvidenceV1({ ...base, waitingForUser: true }).stuck, false);
  });

  void it("a row with no proof yet says nothing extra", () => {
    const evidence = describeRunningRowEvidenceV1({ proof: undefined, startedAt: START, now: START + 60 * MIN, warningMinutes: 10 });
    assert.deepEqual(evidence, { stuck: false, processEnded: false, tooltipLines: [] });
  });

  void it("formats ages", () => {
    assert.equal(formatAgoV1(20_000), "20 s");
    assert.equal(formatAgoV1(14 * MIN), "14 min");
    assert.equal(formatAgoV1(125 * MIN), "2 h 5 min");
  });
});
