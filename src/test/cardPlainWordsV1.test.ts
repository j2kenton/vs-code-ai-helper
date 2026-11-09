/**
 * run1 Step 6 (bugs6 item 16): the two 2026-11-03 19:11 cards said "Claude Code hit a usage limit",
 * "The continuation budget (3) is exhausted" and "(externallyTerminated)" when the stop was
 * Ensemble's own 60-minute limit. Built from the same inputs, neither card may use plan-limit
 * words or an internal identifier, and each must say whose limit it was.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeImplRecoveryTriggerV1 } from "../commands/implementationRecoveryV1";
import { describeOwedContinuationRefusalV1 } from "../utils/owedContinuationRefusalV1";
import { describeMidRoundOutcomeV1 } from "../utils/stopBehaviourV1";
import {
  classifyRoundStopV1,
  describeChangedFilesKeptV1,
  describeEnsembleRetriesGaveUpV1,
  describeRoundStopV1,
} from "../utils/roundStopCauseV1";
import { MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1, type ImplRecoveryV1 } from "../types/taskProgress";

const WALL_CLOCK_ERROR = "Claude Code CLI hit the 60-minute wall-clock limit and was stopped.";
const BANNED = /budget|usage limit|quota|externallyTerminated|pendingImplReviewFiles|quarantin|_prev/i;
const CAMEL_CASE_IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z]+\b/;

function owedRecord(): ImplRecoveryV1 {
  return {
    trigger: "externallyTerminated",
    reason: describeImplRecoveryTriggerV1("externallyTerminated"),
    at: "2026-11-03T19:11:00.000Z",
    dispatch: "pending",
    filesChangedUnknown: false,
  } as unknown as ImplRecoveryV1;
}

void describe("run1 Step 6: cards use plain words and name Ensemble's own limits", () => {
  void it("the first 19:11 card (the round did not finish) names Ensemble's own time limit", () => {
    const cause = classifyRoundStopV1({ failureKind: "generic", timedOut: true, timeoutReason: "wall-clock", errorMessage: WALL_CLOCK_ERROR });
    assert.equal(cause.kind, "ensembleBackstop");
    const card = [
      `The implementation round did not finish its turn: ${describeRoundStopV1(cause, { providerLabel: "Claude Code" })}`,
      describeChangedFilesKeptV1(74),
      describeEnsembleRetriesGaveUpV1(MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1),
    ].join(" ");
    assert.doesNotMatch(card, BANNED);
    assert.doesNotMatch(card, CAMEL_CASE_IDENTIFIER);
    assert.match(card, /Ensemble stops a round after 1 hour/);
    assert.match(card, /Ensemble tried 3 times by itself to finish this round and has stopped trying/);
    assert.match(card, /The 74 changed files are kept for the next round/);
  });

  void it("the same round, run out of backups, no longer reads as a usage limit", () => {
    const cause = classifyRoundStopV1({ failureKind: "generic", timedOut: true, timeoutReason: "wall-clock", errorMessage: WALL_CLOCK_ERROR });
    const text = describeMidRoundOutcomeV1(
      "Claude Code",
      WALL_CLOCK_ERROR,
      { kind: "backupsExhausted", cause, backups: [], remedyText: "Run Implementation again." }
    );
    assert.doesNotMatch(text, BANNED);
    assert.match(text, /Ensemble stops a round after 1 hour/);
  });

  void it("the second 19:11 card (needs your decision) names Ensemble's stop, not an identifier", () => {
    const reason =
      `${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1} implementation rounds in a row ended without a usable report ` +
      `(${describeImplRecoveryTriggerV1("externallyTerminated")}).`;
    assert.doesNotMatch(reason, BANNED);
    assert.doesNotMatch(reason, CAMEL_CASE_IDENTIFIER);
    assert.match(reason, /stopped by Ensemble/);
  });

  void it("the refusal explainer says Ensemble stopped trying and keeps files, not budget or quarantine", () => {
    const message = describeOwedContinuationRefusalV1(
      owedRecord(),
      ["src/a.ts", "src/b.ts"],
      MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1
    );
    assert.doesNotMatch(message, BANNED);
    assert.match(message, /Ensemble tried 3 times by itself/);
    assert.match(message, /The 2 changed files are kept for the next round/);
  });

  void it("a real provider usage limit still says so, and names the provider", () => {
    const cause = classifyRoundStopV1({ failureKind: "quota", errorMessage: "429 You've reached your 5-hour usage limit." });
    assert.match(describeRoundStopV1(cause, { providerLabel: "Claude Code" }), /^Claude Code reports that its usage limit is used up/);
  });
});
