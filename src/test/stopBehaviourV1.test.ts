/**
 * Coverage for `chooseStopBehaviourV1`/`describeMidRoundOutcomeV1` (task
 * "stage chat as a record of work" item 7a/8, Part 14): the classifier that
 * decides whether a mid-round failure durably parks the stage (and offers a
 * scheduled resume), simply alerts, or alerts and stops for a sign-in
 * failure — and the shared explanation text used for every failure kind,
 * including the authentication case that previously had none at all.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseStopBehaviourV1,
  describeMidRoundOutcomeV1,
} from "../utils/stopBehaviourV1";

void describe("chooseStopBehaviourV1", () => {
  void it("parks and schedules a quota failure with a known, near reset", () => {
    assert.equal(
      chooseStopBehaviourV1({
        failureKind: "quota",
        authFailure: false,
        knownNearResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      "park-and-schedule"
    );
  });

  void it("parks and schedules a model-entitlement failure with a known, near reset", () => {
    assert.equal(
      chooseStopBehaviourV1({
        failureKind: "model-entitlement",
        authFailure: false,
        knownNearResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      "park-and-schedule"
    );
  });

  void it("parks (without scheduling) a quota failure with no known near reset", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "quota", authFailure: false }),
      "park"
    );
  });

  void it("parks (without scheduling) a model-entitlement failure with no known near reset", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "model-entitlement", authFailure: false }),
      "park"
    );
  });

  void it("alerts (does not park) a temporarily-unavailable outage", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "temporarily-unavailable", authFailure: false }),
      "alert"
    );
  });

  void it("alerts (does not park) a generic failure", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "generic", authFailure: false }),
      "alert"
    );
  });

  void it("alerts (does not park) an undefined failure kind", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: undefined, authFailure: false }),
      "alert"
    );
  });

  void it("alert-and-stops any authentication failure, regardless of failureKind", () => {
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "quota", authFailure: true }),
      "alert-and-stop"
    );
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "temporarily-unavailable", authFailure: true }),
      "alert-and-stop"
    );
    assert.equal(
      chooseStopBehaviourV1({ failureKind: "generic", authFailure: true }),
      "alert-and-stop"
    );
  });

  void it("alert-and-stops an authentication failure even when a known near reset is also present", () => {
    // The exact wf10 run-042 shape: a message can carry BOTH quota wording
    // AND a 403/sign-in verdict. Auth must win regardless of reset presence.
    assert.equal(
      chooseStopBehaviourV1({
        failureKind: "quota",
        authFailure: true,
        knownNearResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      "alert-and-stop"
    );
  });
});

void describe("describeMidRoundOutcomeV1", () => {
  void it("cascadeWithheldDirtyTree names the limit, the file count, the remedy and any affected stages", () => {
    const text = describeMidRoundOutcomeV1("Claude Code", "429 rate limited", {
      kind: "cascadeWithheldDirtyTree",
      limitLabel: "a quota/rate limit",
      filesChangedCount: 5,
      remedyText: "Rerun this stage later.",
      affectedStagesClause: " This also affects: impl (falls back to Codex).",
    });
    assert.match(text, /Hit a quota\/rate limit on Claude Code \(429 rate limited\)/);
    assert.match(text, /changed 5 file\(s\)/);
    assert.match(text, /withheld the automatic switch to this stage's backup model/);
    assert.match(text, /Rerun this stage later\./);
    assert.match(text, /This also affects: impl/);
  });

  void it("notCascadeEligible explains that this failure kind is never retried against a backup, regardless of chain/tree state", () => {
    const text = describeMidRoundOutcomeV1("Cline CLI", "Unexpected tool-call format", {
      kind: "notCascadeEligible",
      failureKind: "generic",
      dirtyTree: false,
    });
    assert.match(text, /Cline CLI hit generic failure/);
    assert.match(text, /Unexpected tool-call format/);
    assert.match(text, /does not automatically retry this kind of failure against a backup model/);
    assert.doesNotMatch(text, /no backup model is configured/);
    assert.doesNotMatch(text, /Never switch/);
    assert.doesNotMatch(
      text,
      /already changed/,
      "a clean-tree notCascadeEligible failure has nothing to have withheld a switch over"
    );
  });

  // Review completion blocker (2026-09-01, round 3): item 8's rule is "any
  // round that changed files and then failed for any reason should carry
  // the same sentence" — a non-cascade-eligible failure kind changed files
  // and then failed just as much as a cascade-eligible one, so it must carry
  // the guard sentence too, alongside (not instead of) the failure-kind
  // explanation.
  void it("notCascadeEligible also carries the withheld-switch guard sentence when the round changed files", () => {
    const text = describeMidRoundOutcomeV1("Cline CLI", "Unexpected tool-call format", {
      kind: "notCascadeEligible",
      failureKind: "generic",
      dirtyTree: true,
      filesChangedCount: 3,
    });
    assert.match(text, /does not automatically retry this kind of failure against a backup model/);
    assert.match(
      text,
      /This round already changed 3 file\(s\), so Ensemble withheld the automatic switch to this stage's backup model/
    );
  });

  void it("noBackupConfigured names the failure kind and says nothing was attempted", () => {
    const text = describeMidRoundOutcomeV1("Codex", undefined, {
      kind: "noBackupConfigured",
      failureKind: "temporarily-unavailable",
    });
    assert.match(text, /Codex hit temporarily-unavailable failure/);
    assert.match(text, /no backup model is configured/);
    assert.match(text, /no automatic fallback was attempted/);
  });

  void it("neverSwitchConfigured is distinct from noBackupConfigured: it names the setting, not an absent chain", () => {
    const text = describeMidRoundOutcomeV1("Codex", undefined, {
      kind: "neverSwitchConfigured",
      failureKind: "quota",
    });
    assert.match(text, /Codex hit quota failure/);
    assert.match(text, /Never switch/);
    assert.doesNotMatch(text, /no backup model is configured/);
  });

  void it("treeStateUnknown explains the git-unavailable case", () => {
    const text = describeMidRoundOutcomeV1("Gemini CLI", undefined, {
      kind: "treeStateUnknown",
      failureKind: "quota",
    });
    assert.match(text, /Gemini CLI hit quota failure/);
    assert.match(text, /working tree state unknown/);
    assert.match(text, /dirty-vs-clean tree could not be confirmed/);
  });

  void it("authFailureBackupWithheld on a dirty tree names the file count and the withheld switch, matching the quota wording", () => {
    const text = describeMidRoundOutcomeV1("Claude Code", "403 Unable to verify organization membership", {
      kind: "authFailureBackupWithheld",
      dirtyTree: true,
      filesChangedCount: 2,
    });
    assert.match(text, /Hit an authentication failure on Claude Code/);
    assert.match(text, /403 Unable to verify organization membership/);
    assert.match(text, /changed 2 file\(s\)/);
    assert.match(text, /withheld the automatic switch to this stage's backup model/);
    assert.match(text, /never auto-retried against a different model/);
    assert.match(text, /Sign in again/);
  });

  void it("authFailureBackupWithheld on a clean tree makes no false claim about withheld files", () => {
    const text = describeMidRoundOutcomeV1("Claude Code", "403 Unable to verify organization membership", {
      kind: "authFailureBackupWithheld",
      dirtyTree: false,
    });
    assert.match(text, /Hit an authentication failure on Claude Code/);
    assert.doesNotMatch(text, /file\(s\)/);
    assert.match(text, /does not automatically switch to a backup model on an authentication failure/);
    assert.match(text, /Sign in again/);
  });
});
