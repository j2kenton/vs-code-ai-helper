/**
 * Coverage for the shared hand-off contract (task: "Actionable Hand-offs:
 * one contract, nine surfaces", PART 1).
 *
 * This is a conformance *scaffold*, not a full audit: it pins the seven-
 * field vocabulary, the fixed rendering order, the plan's own literal
 * per-surface required-field matrix (transcribed independently below,
 * rather than derived from the module under test — see the note on that),
 * the one surface with a conditional requirement, and the "absent metadata
 * renders as an explicit not-recorded statement, never a silently missing
 * line" rule, including the legacy-vs-unknown absence distinction. Later
 * parts extend this file (or add sibling `*.test.ts` files that import
 * `checkHandoffConformanceV1` / `renderRequiredHandoffFieldsV1` directly) as
 * each surface starts supplying real guidance — a manual-verification item
 * (PART 2), a decision record's gating metadata (PART 5), a scheduled-work
 * posture (PART 6), a refusal explainer (PART 8), a routing recommendation
 * (PART 9), a churn escalation (PART 10). None of those are exercised here;
 * this file only pins the contract they will all render through.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkHandoffConformanceV1,
  getRequiredHandoffFieldsV1,
  HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1,
  HANDOFF_FIELD_LABELS_V1,
  HANDOFF_FIELD_ORDER_V1,
  HANDOFF_IMPACT_KIND_BY_SURFACE_V1,
  HANDOFF_REQUIRED_FIELDS_V1,
  HANDOFF_SURFACE_NOUNS_V1,
  HandoffFailureSignalV1,
  HandoffFieldKeyV1,
  HandoffGuidanceFieldsV1,
  HandoffImpactV1,
  HandoffSurfaceV1,
  renderHandoffFieldLineV1,
  renderRequiredHandoffFieldsV1,
} from "../types/handoffGuidanceV1";

const ALL_SURFACES: readonly HandoffSurfaceV1[] = Object.keys(HANDOFF_REQUIRED_FIELDS_V1) as HandoffSurfaceV1[];

/**
 * The plan's literal "Per-surface conformance matrix (PART 11 audits
 * against it)" table, transcribed by hand from plan.md field numbers to
 * field keys, independently of `HANDOFF_REQUIRED_FIELDS_V1`. Pinning the
 * matrix against a second, independently-authored copy (rather than
 * deriving the expectation from the same table the module exports) is the
 * point: it is what makes a future accidental edit to the module's table
 * fail this test instead of silently redefining "conformance".
 *
 * Field numbers -> keys: 1 action, 2 reason, 3 method, 4 failureSignal,
 * 5 impact, 6 gating, 7 acknowledgement.
 */
const EXPECTED_UNCONDITIONAL_MATRIX_V1: Readonly<Record<HandoffSurfaceV1, readonly HandoffFieldKeyV1[]>> = {
  // Manual-verification checklist items: 1-5
  manualVerificationItem: ["action", "reason", "method", "failureSignal", "impact"],
  // Decision records: 1-7 (full contract)
  decisionRecord: ["action", "reason", "method", "failureSignal", "impact", "gating", "acknowledgement"],
  // Refusals (continuation lease, stage prerequisites): 1, 2, 4, 5, 7
  actionRefusal: ["action", "reason", "failureSignal", "impact", "acknowledgement"],
  stagePrerequisite: ["action", "reason", "failureSignal", "impact", "acknowledgement"],
  // Scheduling announcements / next-action line: 2, 4, 6
  scheduledWork: ["reason", "failureSignal", "gating"],
  // Stage-chat envelope outcomes: 7 unconditionally (the "+2 on refusal"
  // half is a conditional requirement, asserted separately below).
  envelopeOutcome: ["acknowledgement"],
  // Chat pending posture: 4, 6
  chatPendingState: ["failureSignal", "gating"],
  // Routing recommendations: 1, 2 (the matrix's "and must see the gating
  // state" clause is a constraint on the recommendation's *input*, not a
  // renderable field — not asserted here as a field requirement).
  routingRecommendation: ["action", "reason"],
  // Churn escalations: 1, 2, 4 (the matrix's "plus an evidence-backed
  // cause" clause is a constraint on what field 2 must be derived from, not
  // an eighth field — not asserted here as a field requirement).
  churnEscalation: ["action", "reason", "failureSignal"],
};

void describe("handoffGuidanceV1 contract", () => {
  void it("declares a required-field table entry, and a noun, for every surface", () => {
    for (const surface of ALL_SURFACES) {
      assert.ok(
        HANDOFF_REQUIRED_FIELDS_V1[surface].length > 0,
        `${surface} must require at least one hand-off field`
      );
      assert.ok(HANDOFF_SURFACE_NOUNS_V1[surface], `${surface} must have a "not recorded" noun`);
    }
  });

  void it("only ever requires fields from the seven-field vocabulary", () => {
    for (const surface of ALL_SURFACES) {
      for (const field of HANDOFF_REQUIRED_FIELDS_V1[surface]) {
        assert.ok(HANDOFF_FIELD_ORDER_V1.includes(field), `${surface} requires unknown field ${field}`);
      }
    }
  });

  void it("matches the plan's literal per-surface conformance matrix, field-for-field", () => {
    // This is the direct fix for the review's architectural blocker: the
    // module's table is compared against an independently-transcribed copy
    // of plan.md's matrix, not against itself.
    for (const surface of ALL_SURFACES) {
      assert.deepEqual(
        [...HANDOFF_REQUIRED_FIELDS_V1[surface]].sort(),
        [...EXPECTED_UNCONDITIONAL_MATRIX_V1[surface]].sort(),
        `${surface}'s unconditional required fields must match the plan's matrix exactly`
      );
    }
  });

  void it("requires field 2 (reason) on envelopeOutcome only when the outcome is a refusal", () => {
    assert.deepEqual(getRequiredHandoffFieldsV1("envelopeOutcome"), ["acknowledgement"]);
    assert.deepEqual(getRequiredHandoffFieldsV1("envelopeOutcome", { refused: false }), ["acknowledgement"]);
    assert.deepEqual(getRequiredHandoffFieldsV1("envelopeOutcome", { refused: true }), ["reason", "acknowledgement"]);
  });

  void it("renders every surface's required fields in the fixed field order", () => {
    for (const surface of ALL_SURFACES) {
      const rendered = renderRequiredHandoffFieldsV1(surface, undefined);
      const expectedFields = HANDOFF_FIELD_ORDER_V1.filter((f) => HANDOFF_REQUIRED_FIELDS_V1[surface].includes(f));
      assert.deepEqual(
        rendered.map((line) => line.field),
        expectedFields
      );
    }
  });

  void it("renders a required-but-absent field as an explicit not-recorded statement, never a blank or missing line", () => {
    for (const surface of ALL_SURFACES) {
      const rendered = renderRequiredHandoffFieldsV1(surface, undefined);
      for (const line of rendered) {
        assert.equal(line.recorded, false);
        assert.match(line.text, /not recorded/);
        assert.match(line.text, new RegExp(HANDOFF_SURFACE_NOUNS_V1[surface].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    }
  });

  void it('defaults absence to "unknown" wording, never claiming proven legacy provenance', () => {
    // Fix for the review's completion blocker: an absent field with no
    // stated reason must not be rendered as though it were proven to
    // predate the contract.
    const line = renderHandoffFieldLineV1("manualVerificationItem", "action", undefined);
    assert.equal(line.recorded, false);
    assert.match(line.text, /unknown/);
    assert.doesNotMatch(line.text, /older record/);
    assert.doesNotMatch(line.text, /predates/);
  });

  void it('renders "not recorded (older record)" only when the caller asserts legacyRecord explicitly', () => {
    const unknownLine = renderHandoffFieldLineV1("decisionRecord", "gating", undefined, "unknown");
    assert.match(unknownLine.text, /unknown/);
    assert.doesNotMatch(unknownLine.text, /older record/);

    const legacyLine = renderHandoffFieldLineV1("decisionRecord", "gating", undefined, "legacyRecord");
    assert.match(legacyLine.text, /older record/);
    assert.match(legacyLine.text, /predates/);
  });

  void it("propagates the absence reason through renderRequiredHandoffFieldsV1", () => {
    const rendered = renderRequiredHandoffFieldsV1("decisionRecord", undefined, undefined, "legacyRecord");
    for (const line of rendered) {
      assert.equal(line.recorded, false);
      assert.match(line.text, /older record/);
    }
  });

  void it("renders a supplied string field with its label and value, marked recorded", () => {
    const fields: HandoffGuidanceFieldsV1 = {
      action: "Open Settings and confirm the note appears.",
      reason: "Confirms the new guidance renders where users will see it.",
      method: "Settings -> AI Models -> Provider Selection.",
      failureSignal: { kind: "clearingSignal", detail: "The note is absent or the panel is empty." },
    };
    const line = renderHandoffFieldLineV1("stagePrerequisite", "action", fields);
    assert.equal(line.recorded, true);
    assert.equal(line.text, `${HANDOFF_FIELD_LABELS_V1.action}: ${fields.action}`);
  });

  void it("formats a structured priority-kind impact field as LEVEL — cost of failure", () => {
    const fields: HandoffGuidanceFieldsV1 = {
      impact: { kind: "priority", level: "high", costOfFailure: "Wrong bytes on disk, silently." },
    };
    const line = renderHandoffFieldLineV1("manualVerificationItem", "impact", fields);
    assert.equal(line.recorded, true);
    assert.equal(line.text, "Priority: HIGH — Wrong bytes on disk, silently.");
  });

  void it("formats a structured collateral-kind impact field under the Collateral label", () => {
    const fields: HandoffGuidanceFieldsV1 = {
      impact: { kind: "collateral", detail: "3 files are quarantined behind this continuation." },
    };
    const line = renderHandoffFieldLineV1("actionRefusal", "impact", fields);
    assert.equal(line.recorded, true);
    assert.equal(line.text, "Collateral: 3 files are quarantined behind this continuation.");
  });

  void it("treats a mismatched impact kind as absent, never rendering it under the wrong label", () => {
    // A `collateral` value handed to a surface that may only render
    // `priority` (or vice versa) must fail conformance identically to a
    // missing value — this is the direct fix for the review's architectural
    // blocker (fields 4/5 rendering context-insensitively).
    const collateralOnManualCheck: HandoffGuidanceFieldsV1 = {
      impact: { kind: "collateral", detail: "Some files are at risk." },
    };
    const line = renderHandoffFieldLineV1("manualVerificationItem", "impact", collateralOnManualCheck);
    assert.equal(line.recorded, false);
    assert.match(line.text, /not recorded/);

    const priorityOnRefusal: HandoffGuidanceFieldsV1 = {
      impact: { kind: "priority", level: "high", costOfFailure: "Something bad." },
    };
    const refusalLine = renderHandoffFieldLineV1("actionRefusal", "impact", priorityOnRefusal);
    assert.equal(refusalLine.recorded, false);
    assert.match(refusalLine.text, /not recorded/);
  });

  void it("renders field 4 under a different label per surface, chosen from the value's own kind", () => {
    const checkLine = renderHandoffFieldLineV1("manualVerificationItem", "failureSignal", {
      failureSignal: { kind: "failureSymptom", detail: "The count grows on a second run." },
    });
    assert.equal(checkLine.recorded, true);
    assert.equal(checkLine.text, "If it fails: The count grows on a second run.");

    const refusalLine = renderHandoffFieldLineV1("actionRefusal", "failureSignal", {
      failureSignal: { kind: "clearingSignal", detail: "Wait for the lease to expire.", clearsAt: "09:45" },
    });
    assert.equal(refusalLine.recorded, true);
    assert.equal(refusalLine.text, "Clears when: Wait for the lease to expire. (clears 09:45)");

    const chatLine = renderHandoffFieldLineV1("chatPendingState", "failureSignal", {
      failureSignal: { kind: "statusSignal", detail: "No status is reported until the round finishes." },
    });
    assert.equal(chatLine.recorded, true);
    assert.equal(chatLine.text, "Status: No status is reported until the round finishes.");
  });

  void it("treats a mismatched failureSignal kind as absent, never rendering it under the wrong label", () => {
    const clearingOnManualCheck: HandoffGuidanceFieldsV1 = {
      failureSignal: { kind: "clearingSignal", detail: "Wait for it." },
    };
    const line = renderHandoffFieldLineV1("manualVerificationItem", "failureSignal", clearingOnManualCheck);
    assert.equal(line.recorded, false);
    assert.match(line.text, /not recorded/);

    const symptomOnRefusal: HandoffGuidanceFieldsV1 = {
      failureSignal: { kind: "failureSymptom", detail: "It just fails." },
    };
    const refusalLine = renderHandoffFieldLineV1("actionRefusal", "failureSignal", symptomOnRefusal);
    assert.equal(refusalLine.recorded, false);
    assert.match(refusalLine.text, /not recorded/);
  });

  void it("formats a structured gating field from its detail sentence", () => {
    const fields: HandoffGuidanceFieldsV1 = {
      gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "This does not resume the task." },
    };
    const line = renderHandoffFieldLineV1("decisionRecord", "gating", fields);
    assert.equal(line.recorded, true);
    assert.equal(line.text, "Unblocks: This does not resume the task.");
  });

  void it("checkHandoffConformanceV1 reports every required field missing for an entirely absent record", () => {
    for (const surface of ALL_SURFACES) {
      const result = checkHandoffConformanceV1(surface, undefined);
      assert.equal(result.ok, false);
      assert.deepEqual(result.missing, HANDOFF_REQUIRED_FIELDS_V1[surface]);
    }
  });

  void it("checkHandoffConformanceV1 reports ok:true once every required field is supplied, using each surface's allowed kind", () => {
    // Fields 4 (failureSignal) and 5 (impact) are context-sensitive per the
    // plan: a manual-verification check needs a `failureSymptom` +
    // `priority` pair, a refusal needs `clearingSignal` + `collateral`, and
    // the chat panel needs only a `statusSignal`. One fixed payload cannot
    // conform for every surface any more (that would be the same defect
    // this fix corrects), so this builds the fields per surface from
    // whichever kind that surface actually allows.
    const impactForSurface = (surface: HandoffSurfaceV1): HandoffImpactV1 | undefined => {
      const kinds = HANDOFF_IMPACT_KIND_BY_SURFACE_V1[surface];
      if (!kinds || kinds.length === 0) {
        return undefined;
      }
      return kinds[0] === "priority"
        ? { kind: "priority", level: "low", costOfFailure: "You will notice in normal use." }
        : { kind: "collateral", detail: "Nothing is at risk." };
    };
    const failureSignalForSurface = (surface: HandoffSurfaceV1): HandoffFailureSignalV1 | undefined => {
      const kinds = HANDOFF_FAILURE_SIGNAL_KIND_BY_SURFACE_V1[surface];
      if (!kinds || kinds.length === 0) {
        return undefined;
      }
      const kind = kinds[0];
      if (kind === "failureSymptom") {
        return { kind, detail: "The thing did not happen." };
      }
      if (kind === "clearingSignal") {
        return { kind, detail: "Wait for the lease to expire." };
      }
      return { kind: "statusSignal", detail: "Nothing is in flight." };
    };
    for (const surface of ALL_SURFACES) {
      const fields: HandoffGuidanceFieldsV1 = {
        action: "Do the thing.",
        reason: "Because of the thing.",
        method: "Steps to do the thing.",
        failureSignal: failureSignalForSurface(surface),
        impact: impactForSurface(surface),
        gating: { holdsTaskPaused: true, unblocksProgress: true, detail: "Choosing an option resumes the task." },
        acknowledgement: "Recorded.",
      };
      const result = checkHandoffConformanceV1(surface, fields);
      assert.equal(result.ok, true, `${surface} should conform once every field is supplied with its allowed kind`);
      assert.deepEqual(result.missing, []);
    }
  });

  void it("checkHandoffConformanceV1 reports exactly the fields left unsupplied", () => {
    const result = checkHandoffConformanceV1("manualVerificationItem", {
      action: "Run the import twice against staging.",
      reason: "The dedupe key changed this round.",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["method", "failureSignal", "impact"]);
  });

  void it("checkHandoffConformanceV1 requires field 2 (reason) on a refused envelope outcome, but not otherwise", () => {
    const acknowledgedOnly: HandoffGuidanceFieldsV1 = { acknowledgement: "Applied." };
    assert.equal(checkHandoffConformanceV1("envelopeOutcome", acknowledgedOnly).ok, true);
    assert.equal(checkHandoffConformanceV1("envelopeOutcome", acknowledgedOnly, { refused: true }).ok, false);
    assert.deepEqual(checkHandoffConformanceV1("envelopeOutcome", acknowledgedOnly, { refused: true }).missing, [
      "reason",
    ]);

    const refusedWithReason: HandoffGuidanceFieldsV1 = {
      reason: "setTaskStage is not a recognized stage-chat action.",
      acknowledgement: "Refused.",
    };
    assert.equal(checkHandoffConformanceV1("envelopeOutcome", refusedWithReason, { refused: true }).ok, true);
  });
});
