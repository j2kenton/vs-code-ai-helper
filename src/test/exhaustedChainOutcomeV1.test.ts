/**
 * bugs3 Step 3: an exhausted candidate chain ends the round as failed, keeps
 * every attempt it made, names each candidate's own reason and offers the
 * cheapest next step for those reasons.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTaskActionOutcomeV1, type TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import {
  collectAttemptIdsFromOutcomeV1,
  describeTaskActionFailureV1,
  describeTaskActionOutcomeForLogV1,
} from "../utils/taskActionOutcomeTextV1";
import { describeChainRecoveryV1 } from "../utils/chainExhaustionMessageV1";
import {
  clearAutomationCommandOutcomeV1,
  reportAutomationCommandOutcomeV1,
  takeAutomationCommandOutcomeV1,
} from "../utils/automationCommandOutcomeV1";

const KIMI_QUOTA = {
  storedModelId: "kimi-cli:kimi-code/k3.1-pro@max",
  providerLabel: "Kimi Code CLI",
  runnerId: "kimi-cli",
  reason: "429 You've reached your 5-hour usage limit",
  deferredFailureKind: "quota" as const,
  deferredResetAt: "2026-10-27T13:00:00.000Z",
  attemptIds: ["attempt-kimi"],
};
const DEVPASS_AUTH = {
  storedModelId: "devpass-cli:llmgateway-devpass/claude-opus-5-5",
  providerLabel: "devpass-code",
  runnerId: "devpass-cli",
  reason: "Unauthorized: This LLMGateway API token is not active",
  attemptIds: ["attempt-devpass-1", "attempt-devpass-2"],
};

const MIXED_EXHAUSTED: TaskActionOutcomeV1 = {
  kind: "unavailable",
  code: "candidatesExhausted",
  chainExhaustion: { stage: "plan", candidates: [KIMI_QUOTA, DEVPASS_AUTH] },
};

interface PersistedExhaustionV1 {
  chainExhaustion: { candidates: { attemptIds?: string[] }[] };
}

void describe("exhausted chain outcome (bugs3 Step 3)", () => {
  void it("keeps every attempt of every invoked candidate, in order and without duplicates", () => {
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(MIXED_EXHAUSTED), [
      "attempt-kimi",
      "attempt-devpass-1",
      "attempt-devpass-2",
    ]);
    assert.deepEqual(
      collectAttemptIdsFromOutcomeV1({
        kind: "unavailable",
        code: "candidatesExhausted",
        chainExhaustion: { stage: "plan", candidates: [KIMI_QUOTA, { ...KIMI_QUOTA }] },
      }),
      ["attempt-kimi"]
    );
  });

  void it("collects prior rejected attempts before the final one for a failed chain", () => {
    const failed = {
      kind: "failed",
      code: "contentContractFailed",
      retryable: false,
      attemptId: "final",
      priorRejectedAttemptsV1: [
        { attemptId: "first", code: "invalidFrame" },
        { attemptId: "second", code: "invalidFrame" },
      ],
    } as unknown as TaskActionOutcomeV1;
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(failed), ["first", "second", "final"]);
  });

  void it("returns no attempt ids for an outcome that never reached a provider", () => {
    assert.deepEqual(
      collectAttemptIdsFromOutcomeV1({ kind: "unavailable", code: "candidatesExhausted" } as TaskActionOutcomeV1),
      []
    );
  });

  void it("renders 'every model failed' with each candidate's own reason", () => {
    const failure = describeTaskActionFailureV1(MIXED_EXHAUSTED);
    assert.match(failure, /^every model failed: /);
    assert.match(failure, /5-hour usage limit/);
    assert.match(failure, /LLMGateway API token is not active/);
  });

  void it("offers waiting for the reset, signing in and switching the stage's model, each only where it applies", () => {
    const recovery = describeChainRecoveryV1(MIXED_EXHAUSTED.kind === "unavailable" ? MIXED_EXHAUSTED.chainExhaustion!.candidates : [], "plan");
    assert.match(recovery, /wait for the usage limit to reset \(earliest /);
    assert.match(recovery, /sign in again to devpass-code/);
    assert.doesNotMatch(recovery, /sign in again to Kimi/);
    assert.match(recovery, /switch Plan's model \(open AI Models on that stage\)/);
  });

  void it("never suggests signing in when every candidate is out of quota, and says which stage is exhausted", () => {
    const outcome: TaskActionOutcomeV1 = {
      kind: "unavailable",
      code: "candidatesDeferred",
      chainExhaustion: {
        stage: "plan-high-review",
        candidates: [{ ...KIMI_QUOTA, deferredResetAt: undefined }],
      },
    };
    const failure = describeTaskActionFailureV1(outcome);
    assert.match(failure, /^every model failed — High-Level Review \(Plan\)'s models are out of quota/);
    assert.match(failure, /wait for the usage limit to reset, or switch /);
    assert.doesNotMatch(failure, /sign in/i);
    assert.doesNotMatch(failure, /candidatesDeferred|deferred/);
    // The internal code stays in the run log's status line.
    assert.match(describeTaskActionOutcomeForLogV1(outcome), /candidatesDeferred/);
  });

  void it("falls back to the bare code when the record carries no candidate details", () => {
    assert.equal(
      describeTaskActionFailureV1({ kind: "unavailable", code: "candidatesExhausted" } as TaskActionOutcomeV1),
      "candidatesExhausted"
    );
  });

  void it("round-trips attempt ids through the persisted outcome decoder and rejects a malformed list", () => {
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(MIXED_EXHAUSTED)));
    assert.ok(decoded.ok);
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(decoded.outcome), [
      "attempt-kimi",
      "attempt-devpass-1",
      "attempt-devpass-2",
    ]);
    const bad = JSON.parse(JSON.stringify(MIXED_EXHAUSTED)) as PersistedExhaustionV1;
    bad.chainExhaustion.candidates[0]!.attemptIds = [""];
    assert.equal(decodeTaskActionOutcomeV1(bad).ok, false);
  });

  void it("keeps allocated attempts no candidate claimed (the allocation before 'nothing remaining')", () => {
    const withUnclaimed: TaskActionOutcomeV1 = {
      kind: "unavailable",
      code: "candidatesExhausted",
      chainExhaustion: {
        stage: "plan",
        candidates: [KIMI_QUOTA, DEVPASS_AUTH],
        unclaimedAttemptIds: ["attempt-final-allocation", "attempt-kimi"],
      },
    };
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(withUnclaimed), [
      "attempt-kimi",
      "attempt-devpass-1",
      "attempt-devpass-2",
      "attempt-final-allocation",
    ]);
    const decoded = decodeTaskActionOutcomeV1(JSON.parse(JSON.stringify(withUnclaimed)));
    assert.ok(decoded.ok);
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(decoded.outcome), collectAttemptIdsFromOutcomeV1(withUnclaimed));
    const bad = JSON.parse(JSON.stringify(withUnclaimed)) as { chainExhaustion: { unclaimedAttemptIds: unknown } };
    bad.chainExhaustion.unclaimedAttemptIds = [42];
    assert.equal(decodeTaskActionOutcomeV1(bad).ok, false);
  });

  void it("decodes a record persisted before attempt ids existed", () => {
    const legacy = JSON.parse(JSON.stringify(MIXED_EXHAUSTED)) as PersistedExhaustionV1;
    for (const candidate of legacy.chainExhaustion.candidates) {
      delete candidate.attemptIds;
    }
    const decoded = decodeTaskActionOutcomeV1(legacy);
    assert.ok(decoded.ok);
    assert.deepEqual(collectAttemptIdsFromOutcomeV1(decoded.outcome), []);
  });
});

void describe("automation command outcome report (bugs3 Step 3)", () => {
  void it("is read once, and a cleared slot reports nothing", () => {
    reportAutomationCommandOutcomeV1("/t", { state: "failed", reason: "every model failed", attemptIds: ["a"] });
    assert.equal(takeAutomationCommandOutcomeV1("/t")?.state, "failed");
    assert.equal(takeAutomationCommandOutcomeV1("/t"), undefined);
    reportAutomationCommandOutcomeV1("/t", { state: "cancelled", reason: "x", attemptIds: [] });
    clearAutomationCommandOutcomeV1("/t");
    assert.equal(takeAutomationCommandOutcomeV1("/t"), undefined);
  });

  void it("is keyed per task and ignores an absent task key", () => {
    reportAutomationCommandOutcomeV1("/a", { state: "failed", reason: "r", attemptIds: [] });
    assert.equal(takeAutomationCommandOutcomeV1("/b"), undefined);
    assert.equal(takeAutomationCommandOutcomeV1(undefined), undefined);
    assert.equal(takeAutomationCommandOutcomeV1("/a")?.reason, "r");
  });
});
