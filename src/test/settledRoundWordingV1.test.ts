import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeReviewFailureV1 } from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import {
  describeSettledFailureV1,
  stopCauseOfFailureEvidenceV1,
  stopCauseOfTransportEvidenceV1,
} from "../utils/settledRoundWordingV1";
import { classifyRoundStopV1, describeRoundStopV1 } from "../utils/roundStopCauseV1";

void describe("run1 Step 8: the command layer words a failed round from the recorded cause", () => {
  void it("says an Ensemble backstop as Ensemble's own limit, with attributed and observed files kept apart", () => {
    const text = describeSettledFailureV1(
      {
        status: "failed",
        errorMessage: "Claude Code CLI hit the 240-minute wall-clock limit",
        stopCauseV1: "ensembleBackstop",
        providerLabel: "Claude Code",
        filesChanged: ["a.ts", "b.ts", "c.ts"],
        activityV1: { workedMs: 4 * 3_600_000, attributedFiles: ["a.ts", "b.ts"], observedFiles: ["c.ts"] },
      },
      { backstopMinutes: 240 }
    );
    assert.match(text ?? "", /Ensemble stops a round after 4 hours/);
    assert.match(text ?? "", /worked 4 hours and changed 2 files/);
    assert.match(text ?? "", /1 file changed in the workspace while it ran/);
    assert.doesNotMatch(text ?? "", /usage limit|budget|externallyTerminated|pendingImplReviewFiles/i);
  });

  void it("never calls files it could not tie to the round the round's own changes", () => {
    const text = describeSettledFailureV1({
      status: "failed",
      stopCauseV1: "ensembleIdleStop",
      providerLabel: "Codex",
      filesChanged: ["a.ts", "b.ts"],
      activityV1: { workedMs: 25 * 60_000, attributedFiles: [], observedFiles: ["a.ts", "b.ts"] },
    });
    assert.doesNotMatch(text ?? "", /changed 2 files\./);
    assert.match(text ?? "", /2 files changed in the workspace while it ran/);
    assert.match(text ?? "", /no reply from the model/);
  });

  void it("keeps the provider's own words for a limit the provider named", () => {
    const message = "Claude Code hit a usage limit: you've hit your limit, resets 5pm";
    assert.equal(
      describeSettledFailureV1({ status: "failed", errorMessage: message, stopCauseV1: "providerUsageLimit" }),
      message
    );
  });

  void it("returns the message unchanged when no cause was recorded", () => {
    assert.equal(describeSettledFailureV1({ status: "failed", errorMessage: "boom" }), "boom");
  });

  void it("says an unconfirmed process stop with the process and what to do, not as 'process ended'", () => {
    const text = describeSettledFailureV1({
      status: "failed",
      providerLabel: "Claude Code",
      stopCauseV1: "processNotConfirmedStopped",
      errorMessage:
        "Claude Code CLI's process (pid 4242) could not be confirmed stopped; it may still be running and editing the workspace. Stop it yourself (for example `kill -9 -4242`) before starting another round.",
    });
    assert.match(text ?? "", /pid 4242/);
    assert.match(text ?? "", /could not be confirmed stopped/);
    assert.doesNotMatch(text ?? "", /ended without giving a result/);
  });

  void it("classifies a recorded processNotConfirmedStopped as itself", () => {
    const cause = classifyRoundStopV1({ status: "failed", recordedCause: "processNotConfirmedStopped", errorMessage: "x" });
    assert.equal(cause.kind, "processNotConfirmedStopped");
    assert.match(describeRoundStopV1(cause, { providerLabel: "Codex" }), /x\./);
  });
});

void describe("run1 Step 8: review rounds read the same recorded cause", () => {
  void it("names the cause a transport failure code carries", () => {
    assert.equal(stopCauseOfTransportEvidenceV1("cliRunTimeout: no exit after 240m wall clock"), "ensembleBackstop");
    assert.equal(stopCauseOfTransportEvidenceV1("cliRunInactivityTimeout: no output for 20m"), "ensembleIdleStop");
    assert.equal(stopCauseOfTransportEvidenceV1("cliRunRepeatStop: the model kept repeating itself"), "ensembleRepeatStop");
    assert.equal(stopCauseOfTransportEvidenceV1("cliProcessNotConfirmedStopped: pid 4"), "processNotConfirmedStopped");
    assert.equal(stopCauseOfTransportEvidenceV1("cliExit.1: usage limit"), undefined);
    assert.equal(stopCauseOfTransportEvidenceV1(undefined), undefined);
  });

  void it("words a failed review outcome through the shared wording and records its cause", () => {
    const outcome = {
      kind: "failed",
      code: "cliRunInactivityTimeout",
      detail: "no output for 20m",
      correlation: {},
    } as unknown as TaskActionOutcomeV1;
    const worded = describeReviewFailureV1(outcome);
    assert.equal(worded.stopCause, "ensembleIdleStop");
    assert.ok(!/budget|usage limit|cliRun/i.test(worded.reason), worded.reason);
    assert.match(worded.reason, /Ensemble/);
    const plain = describeReviewFailureV1({
      kind: "failed",
      code: "cliExit.1",
      detail: "boom",
      correlation: {},
    } as unknown as TaskActionOutcomeV1);
    assert.equal(plain.stopCause, "generic", "an ordinary failure still records a cause, and it is never a limit");
  });

  void it("records a provider error result and a real usage limit on the ledger cause", () => {
    const errorResult = describeReviewFailureV1({
      kind: "failed",
      code: "cliErrorResult",
      detail: "the model ended its turn with an error result",
      correlation: {},
    } as unknown as TaskActionOutcomeV1);
    assert.equal(errorResult.stopCause, "providerError");
    const limit = describeReviewFailureV1({
      kind: "failed",
      code: "cliExit.1",
      detail: "You've hit your usage limit. Try again at 5:00 PM.",
      correlation: {},
    } as unknown as TaskActionOutcomeV1);
    assert.equal(limit.stopCause, "providerUsageLimit");
  });

  void it("records each invoked candidate's cause for an exhausted chain, and skips candidates never run", () => {
    const outcome = {
      kind: "unavailable",
      code: "candidatesExhausted",
      correlation: {},
      chainExhaustion: {
        stage: "impl-high-review",
        candidates: [
          { storedModelId: "a", providerLabel: "A", runnerId: "a", reason: "cliRunInactivityTimeout: no output for 20m", attemptIds: ["x"] },
          { storedModelId: "b", providerLabel: "B", runnerId: "b", reason: "skipped: not signed in" },
          { storedModelId: "c", providerLabel: "C", runnerId: "c", reason: "cliExit.1: boom", attemptIds: ["y"] },
        ],
      },
    } as unknown as TaskActionOutcomeV1;
    const worded = describeReviewFailureV1(outcome);
    assert.deepEqual(worded.candidateStopCauses, ["ensembleIdleStop", "generic"]);
    assert.equal(worded.stopCause, "generic");
  });

  void it("words an exhausted chain's Ensemble stops through the shared stop wording, not transport codes", () => {
    const outcome = {
      kind: "unavailable",
      code: "candidatesExhausted",
      correlation: {},
      chainExhaustion: {
        stage: "impl-high-review",
        candidates: [
          {
            storedModelId: "a",
            providerLabel: "Codex",
            runnerId: "a",
            reason: "invoked, but Ensemble stopped the round because the model had not replied for too long (the inactivity watchdog) - cliRunInactivityTimeout: no output for 20m; stderr 0 byte(s)",
            attemptIds: ["x"],
          },
          {
            storedModelId: "b",
            providerLabel: "Claude Code",
            runnerId: "b",
            reason: "invoked, but Ensemble stopped the round at its own time limit (the wall-clock time limit) - cliRunTimeout: no exit after 240m wall clock; stderr 0 byte(s)",
            attemptIds: ["y"],
          },
          {
            storedModelId: "c",
            providerLabel: "Gemini CLI",
            runnerId: "c",
            reason: "invoked, but the provider reported - cliExit.1: You've hit your usage limit.",
            attemptIds: ["z"],
          },
        ],
      },
    } as unknown as TaskActionOutcomeV1;
    const worded = describeReviewFailureV1(outcome);
    assert.match(worded.reason, /no reply from the model for 20 minutes/);
    assert.match(worded.reason, /Ensemble stops a round after 4 hours/);
    assert.doesNotMatch(worded.reason, /cliRun|watchdog|wall-clock/);
    // A provider's own limit text keeps its words.
    assert.match(worded.reason, /usage limit/);
  });

  void it("maps a probe-settled review round's code to the process-ended cause", () => {
    assert.equal(stopCauseOfFailureEvidenceV1("cliProcessEnded: Codex's process ended without giving a result"), "processEnded");
  });

  void it("never names a limit for a failure whose text names none", () => {
    assert.equal(stopCauseOfFailureEvidenceV1("cliExit.1: segmentation fault"), "generic");
    assert.equal(stopCauseOfFailureEvidenceV1("cliExit.1: You exceeded your current quota"), "providerQuota");
  });
});
