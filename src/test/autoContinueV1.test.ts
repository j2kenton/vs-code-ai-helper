/**
 * review1 Step 53 (policy slice): which options may run unattended, when the countdown is armed, and what the sweep
 * does with it. The sweep wiring, the card countdown and the dispatch through the automatic-dispatch gate are not
 * covered here because they are not built yet.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { AUTO_CONTINUE_MINUTES_DEFAULT_V1 } from "../config/settings";
import {
  WAIT_FOR_ME_OPTION_ID_V1,
  describeAutoContinueCountdownV1,
  describeAutoContinuedLineV1,
  evaluateAutoContinueV1,
  isAutoContinueOptionV1,
  normaliseAutoContinueMinutesV1,
  pickAutoContinueOptionV1,
  planAutoContinueV1,
  withWaitForMeOptionV1,
} from "../utils/autoContinueV1";
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

const NOW = Date.parse("2026-11-04T21:39:00.000Z");

function option(partial: Partial<WorkflowDecisionOptionV1> & { optionId: string }): WorkflowDecisionOptionV1 {
  return {
    label: partial.optionId,
    consequence: "does it",
    resumeKind: "continue",
    effect: { kind: "command", command: "x.y" },
    ...partial,
  };
}

function card(
  options: WorkflowDecisionOptionV1[],
  recommended: string | undefined,
  extra: Partial<WorkflowDecisionV1> = {}
): Pick<WorkflowDecisionV1, "options" | "recommendation" | "state" | "autoContinue"> {
  return {
    options,
    recommendation:
      recommended !== undefined ? { kind: "option", optionId: recommended, reasoning: "r" } : ({ kind: "none", reasoning: "r" } as never),
    state: "pending",
    ...extra,
  };
}

void describe("review1 Step 53: auto-continue policy", () => {
  void it("only an unattended-safe, non-destructive, enabled command option qualifies", () => {
    assert.equal(isAutoContinueOptionV1(option({ optionId: "a", unattendedSafe: true })), true);
    assert.equal(isAutoContinueOptionV1(option({ optionId: "a" })), false);
    assert.equal(isAutoContinueOptionV1(option({ optionId: "a", unattendedSafe: true, destructive: true })), false);
    assert.equal(isAutoContinueOptionV1(option({ optionId: "a", unattendedSafe: true, disabled: true, disabledReason: "x" })), false);
    assert.equal(isAutoContinueOptionV1(option({ optionId: "a", unattendedSafe: true, effect: { kind: "doNothing" } })), false);
    assert.equal(isAutoContinueOptionV1(undefined), false);
  });

  void it("Publish Anyway, Commit & Push-style and exclusion options never get a countdown, even when recommended", () => {
    const unsafe = card([option({ optionId: "publishAnyway" }), option({ optionId: "exclude", destructive: true })], "publishAnyway");
    assert.equal(pickAutoContinueOptionV1(unsafe), undefined);
    assert.equal(planAutoContinueV1(unsafe, 15, NOW, {}), undefined);
  });

  void it("arms a countdown for a recommended safe option, recording the task state it was armed against", () => {
    const safe = card([option({ optionId: "apply", unattendedSafe: true }), option({ optionId: "notYet" })], "apply");
    const armed = planAutoContinueV1(safe, 15, NOW, { progressVersion: 7, roundCount: 4 });
    assert.deepEqual(armed, {
      optionId: "apply",
      minutes: 15,
      deadline: "2026-11-04T21:54:00.000Z",
      armedProgressVersion: 7,
      armedRoundCount: 4,
    });
    // A safe option that is not the recommended one does not run by itself.
    assert.equal(planAutoContinueV1(card([option({ optionId: "apply", unattendedSafe: true }), option({ optionId: "notYet" })], "notYet"), 15, NOW, {}), undefined);
  });

  void it("setting 0 (or garbage) turns it off", () => {
    const safe = card([option({ optionId: "apply", unattendedSafe: true })], "apply");
    assert.equal(planAutoContinueV1(safe, 0, NOW, {}), undefined);
    assert.equal(normaliseAutoContinueMinutesV1("soon"), 0);
    assert.equal(normaliseAutoContinueMinutesV1(-5), 0);
    assert.equal(normaliseAutoContinueMinutesV1(99999), 1440);
    assert.equal(normaliseAutoContinueMinutesV1(15.9), 15);
  });

  void it("the sweep waits, then runs after the deadline, and cancels when the task moved", () => {
    const safe = card([option({ optionId: "apply", unattendedSafe: true })], "apply");
    const armed = planAutoContinueV1(safe, 15, NOW, { progressVersion: 7, roundCount: 4 })!;
    const withArmed = { ...safe, autoContinue: armed };
    assert.deepEqual(evaluateAutoContinueV1(withArmed, NOW + 14 * 60_000, { progressVersion: 7, roundCount: 4 }), { kind: "wait" });
    assert.deepEqual(evaluateAutoContinueV1(withArmed, NOW + 15 * 60_000, { progressVersion: 7, roundCount: 4 }), {
      kind: "run",
      optionId: "apply",
    });
    const moved = evaluateAutoContinueV1(withArmed, NOW + 15 * 60_000, { progressVersion: 8, roundCount: 4 });
    assert.equal(moved.kind, "cancel");
    const ran = evaluateAutoContinueV1(withArmed, NOW + 15 * 60_000, { progressVersion: 7, roundCount: 5 });
    assert.equal(ran.kind, "cancel");
  });

  void it("an answered, dismissed or cancelled card is left alone, and an option that stopped qualifying cancels", () => {
    const safe = card([option({ optionId: "apply", unattendedSafe: true })], "apply");
    const armed = planAutoContinueV1(safe, 1, NOW, {})!;
    const late = NOW + 10 * 60_000;
    assert.deepEqual(evaluateAutoContinueV1({ ...safe, state: "resolved", autoContinue: armed }, late, {}), { kind: "wait" });
    assert.deepEqual(evaluateAutoContinueV1({ ...safe, state: "dismissed", autoContinue: armed }, late, {}), { kind: "wait" });
    assert.deepEqual(
      evaluateAutoContinueV1({ ...safe, autoContinue: { ...armed, cancelledAt: "2026-11-04T21:40:00.000Z" } }, late, {}),
      { kind: "wait" }
    );
    const downgraded = card([option({ optionId: "apply", unattendedSafe: false })], "apply", { autoContinue: armed });
    assert.equal(evaluateAutoContinueV1(downgraded, late, {}).kind, "cancel");
  });

  void it("'Wait for me' is added once and runs nothing; the countdown and chat lines read as the plan says", () => {
    const once = withWaitForMeOptionV1(withWaitForMeOptionV1([option({ optionId: "apply", unattendedSafe: true })]));
    assert.equal(once.filter((o) => o.optionId === WAIT_FOR_ME_OPTION_ID_V1).length, 1);
    assert.equal(once.find((o) => o.optionId === WAIT_FOR_ME_OPTION_ID_V1)?.effect.kind, "doNothing");
    const safe = card([option({ optionId: "apply", unattendedSafe: true })], "apply");
    const armed = planAutoContinueV1(safe, 15, NOW, {})!;
    assert.equal(
      describeAutoContinueCountdownV1(armed, "Apply 9 Reviewer-Verified Ticks", NOW + 5 * 60_000),
      "Continues with ‘Apply 9 Reviewer-Verified Ticks’ in 10 min unless you choose otherwise."
    );
    assert.equal(
      describeAutoContinuedLineV1("Apply 9 Reviewer-Verified Ticks", 15),
      "Continued automatically with ‘Apply 9 Reviewer-Verified Ticks’ after 15 min (no answer)."
    );
  });
});

void describe("the unattended countdown default (bugs7 item 7)", () => {
  void it("is 2 minutes in package.json and in the code, so the two cannot drift", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const configured = manifest.contributes.configuration.properties["ensemble.decisions.autoContinueMinutes"];
    assert.equal(configured?.default, 2);
    assert.equal(AUTO_CONTINUE_MINUTES_DEFAULT_V1, 2);
  });
});
