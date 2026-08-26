/**
 * Coverage for the strict §3.10 task-progress decoder/selector: exact
 * version selection, fail-closed field validation, legacy alias resolution
 * without permissive coercion, and byte-exact opaque capture. Fixture
 * documents live under test-fixtures/task-progress/ (legacy/ and v1/ decode;
 * recovery/ fails closed).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  LEGACY_STAGE_ALIAS_TABLE_V1,
  decodeTaskProgressTextV1,
  selectTaskProgressFamilyV1,
} from "../services/taskProgressDecoderV1";
import { migrateStage } from "../types/taskProgress";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures", "task-progress");

const BASE = {
  taskFolder: "2026-07-01_task_1",
  currentStage: "impl",
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-02T11:30:00.000Z",
};

function doc(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...BASE, ...overrides }, null, 2);
}

function expectRecovery(text: string, code: string): void {
  const result = decodeTaskProgressTextV1(text);
  assert.equal(result.ok, false, `expected recovery for: ${text}`);
  if (!result.ok) {
    assert.equal(result.code, code, result.reason);
  }
}

void describe("taskProgressDecoderV1", () => {
  void it("decodes minimal legacy input, materializing active status and version 1", () => {
    const result = decodeTaskProgressTextV1(doc({}));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decoded.family, "workspace-legacy-v0");
      assert.equal(result.decoded.progress.ensembleProgressVersion, 1);
      assert.equal(result.decoded.progress.status, "active");
      assert.equal(result.decoded.progress.currentStage, "impl");
      assert.equal(result.decoded.wasEnvelopeWrapped, false);
    }
  });

  void it("selects families strictly by ensembleProgressVersion", () => {
    assert.deepEqual(selectTaskProgressFamilyV1(doc({})), {
      ok: true,
      family: "workspace-legacy-v0",
    });
    assert.deepEqual(selectTaskProgressFamilyV1(doc({ ensembleProgressVersion: 1 })), {
      ok: true,
      family: "ensemble-v1",
    });
    for (const bad of ["1", 2, 1.5, null, true] as const) {
      const selection = selectTaskProgressFamilyV1(doc({ ensembleProgressVersion: bad }));
      assert.equal(selection.ok, false);
      if (!selection.ok) {
        assert.equal(selection.code, "unsupportedProgressVersion");
      }
      expectRecovery(doc({ ensembleProgressVersion: bad }), "unsupportedProgressVersion");
    }
  });

  void it("fails closed on unknown ensemble* fields", () => {
    expectRecovery(doc({ ensembleFutureFeature: true }), "unknownEnsembleField");
    expectRecovery(
      doc({ ensembleProgressVersion: 1, ensembleOperationLease: "x" }),
      "unknownEnsembleField"
    );
  });

  void it("rejects scalar fallbackActive and accepts only the per-stage map", () => {
    expectRecovery(doc({ fallbackActive: true }), "invalidFieldValue");
    const result = decodeTaskProgressTextV1(doc({ fallbackActive: { impl: true } }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.fallbackActive, { impl: true });
    }
  });

  void it("decodes a valid reviewRejections trail and fails closed on malformed entries", () => {
    const valid = {
      stage: "impl-high-review",
      attemptId: "attempt-1",
      at: "2026-07-02T11:00:00.000Z",
      reason: "no parseable Readiness line",
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, reviewRejections: [valid] })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.reviewRejections, [valid]);
    }
    expectRecovery(doc({ ensembleProgressVersion: 1, reviewRejections: [{ ...valid, reason: "" }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, reviewRejections: [{ ...valid, stage: "bogus" }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, reviewRejections: [{ ...valid, extra: true }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, reviewRejections: { not: "an array" } }), "invalidFieldValue");
  });

  void it("decodes a valid roundOutcomes trail and fails closed on malformed entries (wf10 item 4 / Part 4)", () => {
    const valid = {
      stage: "impl",
      classification: "provider-failure-empty",
      at: "2026-07-02T11:00:00.000Z",
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, roundOutcomes: [valid] })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.roundOutcomes, [valid]);
    }
    const withAttempt = { ...valid, attemptId: "attempt-1" };
    const resultWithAttempt = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, roundOutcomes: [withAttempt] })
    );
    assert.equal(resultWithAttempt.ok, true);
    if (resultWithAttempt.ok) {
      assert.deepEqual(resultWithAttempt.decoded.progress.roundOutcomes, [withAttempt]);
    }
    expectRecovery(doc({ ensembleProgressVersion: 1, roundOutcomes: [{ ...valid, classification: "bogus" }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, roundOutcomes: [{ ...valid, stage: "bogus" }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, roundOutcomes: [{ ...valid, extra: true }] }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, roundOutcomes: { not: "an array" } }), "invalidFieldValue");
  });

  void it("decodes a roundOutcomes entry's optional dispatchMode and fails closed on an unrecognized value (item 17a — Part 2 step 6)", () => {
    const valid = {
      stage: "impl",
      classification: "edits-produced",
      at: "2026-07-02T11:00:00.000Z",
      dispatchMode: "apply-review",
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, roundOutcomes: [valid] })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.roundOutcomes, [valid]);
    }
    // Entries written before this field existed decode fine without it.
    const withoutField = { ...valid };
    delete (withoutField as Record<string, unknown>)["dispatchMode"];
    const resultWithout = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, roundOutcomes: [withoutField] })
    );
    assert.equal(resultWithout.ok, true);
    if (resultWithout.ok) {
      assert.deepEqual(resultWithout.decoded.progress.roundOutcomes, [withoutField]);
    }
    expectRecovery(
      doc({ ensembleProgressVersion: 1, roundOutcomes: [{ ...valid, dispatchMode: "bogus" }] }),
      "invalidFieldValue"
    );
  });

  void it("decodes implRecovery's optional sourceDispatchMode/sourceReviewStage and fails closed on unrecognized values (item 17b — Part 2 step 6)", () => {
    const base = {
      sourceAttemptId: "impl-recovery-1",
      reason: "the provider returned no usable summary",
      trigger: "summaryRejected",
      mode: "unconstrained",
      dispatch: "pending",
      at: "2026-07-02T11:00:00.000Z",
    };
    const withApplyReviewSource = {
      ...base,
      sourceDispatchMode: "apply-review",
      sourceReviewStage: "impl-high-review",
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, implRecovery: withApplyReviewSource })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.implRecovery, withApplyReviewSource);
    }
    // A record written before this field existed decodes fine without it.
    const resultWithout = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, implRecovery: base })
    );
    assert.equal(resultWithout.ok, true);
    if (resultWithout.ok) {
      assert.deepEqual(resultWithout.decoded.progress.implRecovery, base);
    }
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        implRecovery: { ...base, sourceDispatchMode: "bogus" },
      }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        implRecovery: { ...base, sourceDispatchMode: "apply-review", sourceReviewStage: "bogus" },
      }),
      "invalidFieldValue"
    );
  });

  void it("decodes reviewScoreHistory entries with a reviewer identity and fails closed on malformed shapes (workflow-2 item 7)", () => {
    const valid = {
      stage: "impl-high-review",
      score: 9,
      attemptId: "attempt-1",
      at: "2026-08-14T11:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
      reviewer: { providerLabel: "Codex", storedModelId: "gpt-5.6-sol@high" },
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, reviewScoreHistory: [valid] })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.reviewScoreHistory, [valid]);
    }
    // Legacy entries with no reviewer field still decode cleanly.
    const { reviewer: _omit, ...legacy } = valid;
    const legacyResult = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, reviewScoreHistory: [legacy] })
    );
    assert.equal(legacyResult.ok, true);
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        reviewScoreHistory: [{ ...valid, reviewer: { ...valid.reviewer, extra: true } }],
      }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        reviewScoreHistory: [{ ...valid, reviewer: { providerLabel: "" } }],
      }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({ ensembleProgressVersion: 1, reviewScoreHistory: [{ ...valid, reviewer: "not-an-object" }] }),
      "invalidFieldValue"
    );
  });

  void it("decodes a reviewScoreHistory blocker's origin (reviewer/mechanical) and fails closed on a bogus value (wf10 continuation item 12)", () => {
    const withOrigin = {
      stage: "impl-high-review",
      score: 6,
      attemptId: "attempt-1",
      at: "2026-08-26T11:00:00.000Z",
      blockerCount: 1,
      taskFixableCount: 1,
      blockers: [
        { category: "completion", resolver: "task-fixable", subject: "npm run test", origin: "mechanical" },
      ],
    };
    const result = decodeTaskProgressTextV1(doc({ ensembleProgressVersion: 1, reviewScoreHistory: [withOrigin] }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.reviewScoreHistory, [withOrigin]);
    }
    // Legacy blockers with no origin still decode cleanly.
    const legacyBlockers = [{ category: "completion", resolver: "task-fixable", subject: "npm run test" }];
    const legacyResult = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, reviewScoreHistory: [{ ...withOrigin, blockers: legacyBlockers }] })
    );
    assert.equal(legacyResult.ok, true);
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        reviewScoreHistory: [
          { ...withOrigin, blockers: [{ ...withOrigin.blockers[0], origin: "ai" }] },
        ],
      }),
      "invalidFieldValue"
    );
  });

  void it("decodes a valid implementationTypeCheckFailure and fails closed on malformed shapes (2g)", () => {
    const valid = {
      at: "2026-08-07T11:00:00.000Z",
      output: "src/foo.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    };
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, implementationTypeCheckFailure: valid })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.decoded.progress.implementationTypeCheckFailure, valid);
    }
    expectRecovery(
      doc({ ensembleProgressVersion: 1, implementationTypeCheckFailure: { ...valid, at: "not-a-timestamp" } }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({ ensembleProgressVersion: 1, implementationTypeCheckFailure: { ...valid, output: 42 } }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({ ensembleProgressVersion: 1, implementationTypeCheckFailure: { ...valid, extra: true } }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({ ensembleProgressVersion: 1, implementationTypeCheckFailure: "not an object" }),
      "invalidFieldValue"
    );
  });

  void it("decodes a valid zeroChangeImplRounds and fails closed on non-negative-integer violations (step 8)", () => {
    const result = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, zeroChangeImplRounds: 3 })
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decoded.progress.zeroChangeImplRounds, 3);
    }
    const zero = decodeTaskProgressTextV1(
      doc({ ensembleProgressVersion: 1, zeroChangeImplRounds: 0 })
    );
    assert.equal(zero.ok, true);
    if (zero.ok) {
      assert.equal(zero.decoded.progress.zeroChangeImplRounds, 0);
    }
    expectRecovery(doc({ ensembleProgressVersion: 1, zeroChangeImplRounds: -1 }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, zeroChangeImplRounds: 1.5 }), "invalidFieldValue");
    expectRecovery(doc({ ensembleProgressVersion: 1, zeroChangeImplRounds: "3" }), "invalidFieldValue");
  });

  void it("resolves the closed legacy stage alias table in parity with migrateStage", () => {
    for (const [alias, canonical] of Object.entries(LEGACY_STAGE_ALIAS_TABLE_V1)) {
      assert.equal(
        migrateStage(alias),
        canonical,
        `alias table drifted from the permissive normalizer for ${alias}`
      );
      const result = decodeTaskProgressTextV1(doc({ currentStage: alias }));
      assert.equal(result.ok, true, `alias ${alias} should decode`);
      if (result.ok) {
        assert.equal(result.decoded.progress.currentStage, canonical);
      }
    }
  });

  void it("rejects unknown stages instead of coercing to desc like the permissive reader", () => {
    expectRecovery(doc({ currentStage: "bogus-stage" }), "invalidFieldValue");
  });

  void it("handles the synthetic legacy completed stage deterministically", () => {
    const completed = decodeTaskProgressTextV1(
      doc({ currentStage: "completed", completedAt: "2026-07-03T12:00:00.000Z" })
    );
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.decoded.progress.currentStage, "publish");
      assert.equal(completed.decoded.progress.status, "completed");
    }

    const active = decodeTaskProgressTextV1(doc({ currentStage: "completed" }));
    assert.equal(active.ok, true);
    if (active.ok) {
      assert.equal(active.decoded.progress.currentStage, "publish");
      assert.equal(active.decoded.progress.status, "active");
    }

    const paused = decodeTaskProgressTextV1(
      doc({ currentStage: "completed", status: "paused" })
    );
    assert.equal(paused.ok, true);
    if (paused.ok) {
      assert.equal(paused.decoded.progress.status, "paused");
    }

    // Ancient publish-artifact evidence makes completion ambiguous — the
    // permissive migrator would synthesize a completedAt (coercion).
    expectRecovery(
      doc({ currentStage: "completed", publishArtifact: { path: "x" } }),
      "invalidFieldValue"
    );
  });

  void it("resolves legacy status aliases only when completion is unambiguous", () => {
    const finished = decodeTaskProgressTextV1(
      doc({ status: "finished", completedAt: "2026-07-03T12:00:00.000Z" })
    );
    assert.equal(finished.ok, true);
    if (finished.ok) {
      assert.equal(finished.decoded.progress.status, "completed");
    }
    expectRecovery(doc({ status: "finished" }), "invalidFieldValue");
    expectRecovery(doc({ status: "wip" }), "invalidFieldValue");
  });

  void it("preserves completedAt as inert history alongside any status (archive/resume shapes)", () => {
    // resumeArchivedTask output: status returns to active while completedAt
    // survives as historical metadata (completion is inferred solely from
    // status — TaskProgress declaration, archiveTask.ts). Resume deletes
    // archivedFrom (set undefined, dropped by JSON.stringify), so the exact
    // persisted shape has no archivedFrom key.
    const resumed = decodeTaskProgressTextV1(
      doc({
        currentStage: "publish",
        status: "active",
        completedAt: "2026-07-03T12:00:00.000Z",
      })
    );
    assert.equal(resumed.ok, true);
    if (resumed.ok) {
      assert.equal(resumed.decoded.progress.status, "active");
      assert.equal(resumed.decoded.progress.completedAt, "2026-07-03T12:00:00.000Z");
    }

    // archiveTask output for a completed task: archived status, preserved
    // completedAt, archivedFrom recording the pre-archive status.
    const archived = decodeTaskProgressTextV1(
      doc({
        currentStage: "publish",
        status: "archived",
        completedAt: "2026-07-03T12:00:00.000Z",
        archivedFrom: "completed",
      })
    );
    assert.equal(archived.ok, true);
    if (archived.ok) {
      assert.equal(archived.decoded.progress.status, "archived");
      assert.equal(archived.decoded.progress.completedAt, "2026-07-03T12:00:00.000Z");
    }
  });

  void it("rejects duplicate properties that JSON.parse silently collapses", () => {
    const text = `{"taskFolder":"a","taskFolder":"b","currentStage":"impl","createdAt":"2026-07-01T10:00:00.000Z","updatedAt":"2026-07-01T10:00:00.000Z"}`;
    expectRecovery(text, "duplicateProperty");
  });

  void it("rejects the conflicting scheduledRun/scheduledResumeTime alias pair", () => {
    expectRecovery(
      doc({
        scheduledRun: { runAt: "2026-07-05T08:00:00.000Z", stage: "impl" },
        scheduledResumeTime: "2026-07-05T08:00:00.000Z",
      }),
      "conflictingAliases"
    );
    const runOnly = decodeTaskProgressTextV1(
      doc({ scheduledRun: { runAt: "2026-07-05T08:00:00.000Z", stage: "impl" } })
    );
    assert.equal(runOnly.ok, true);
    const aliasOnly = decodeTaskProgressTextV1(
      doc({ scheduledResumeTime: "2026-07-05T08:00:00.000Z" })
    );
    assert.equal(aliasOnly.ok, true);
  });

  void it("rejects implReviewFiles entries the permissive reader silently filters", () => {
    expectRecovery(doc({ implReviewFiles: ["src/a.ts", 123] }), "invalidFieldValue");
  });

  void it("canonicalizes completedStages to a stage-order prefix, backfilling gapped terminal ticks", () => {
    const ok = decodeTaskProgressTextV1(
      doc({ completedStages: ["plan", "desc", "plan-high-review"] })
    );
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.deepEqual(ok.decoded.progress.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
      ]);
    }

    // The only non-empty value production has ever written: markTaskDone.ts
    // persists exactly ["publish"]. It backfills to the full prefix rather
    // than failing a real completed task into recovery.
    const completed = decodeTaskProgressTextV1(
      doc({
        currentStage: "publish",
        status: "completed",
        completedAt: "2026-07-03T12:00:00.000Z",
        completedStages: ["publish"],
      })
    );
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.deepEqual(completed.decoded.progress.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
        "impl-high-review",
        "impl-low-review",
        "publish",
      ]);
    }

    const gapped = decodeTaskProgressTextV1(doc({ completedStages: ["desc", "impl"] }));
    assert.equal(gapped.ok, true);
    if (gapped.ok) {
      assert.deepEqual(gapped.decoded.progress.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
      ]);
    }

    const empty = decodeTaskProgressTextV1(doc({ completedStages: [] }));
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.deepEqual(empty.decoded.progress.completedStages, []);
    }

    // "created" aliases to desc for the legacy family — a duplicate after
    // canonicalization is still recovery.
    expectRecovery(doc({ completedStages: ["desc", "created"] }), "invalidFieldValue");
    expectRecovery(doc({ completedStages: ["desc", "bogus"] }), "invalidFieldValue");
  });

  void it("supports the historical envelope wrapper for the legacy family only", () => {
    const inner = { ...BASE, custom: { keep: true } };
    const wrapped = JSON.stringify({ schemaVersion: 1, data: inner }, null, 2);
    const result = decodeTaskProgressTextV1(wrapped);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decoded.wasEnvelopeWrapped, true);
      assert.equal(result.decoded.family, "workspace-legacy-v0");
      assert.equal(result.decoded.progress.taskFolder, BASE.taskFolder);
      const opaque = result.decoded.entries.filter((e) => e.kind === "opaque");
      assert.equal(opaque.length, 1);
    }

    const v1Wrapped = JSON.stringify(
      { schemaVersion: 1, data: { ...BASE, ensembleProgressVersion: 1 } },
      null,
      2
    );
    expectRecovery(v1Wrapped, "unsupportedProgressVersion");
  });

  void it("rejects a taskFolder that does not match the discovered folder", () => {
    const result = decodeTaskProgressTextV1(doc({}), {
      expectedTaskFolder: "some-other-folder",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "taskFolderMismatch");
    }
  });

  void it("rejects legacy aliases inside a V1 document", () => {
    expectRecovery(
      doc({ ensembleProgressVersion: 1, currentStage: "plan-final" }),
      "invalidFieldValue"
    );
    expectRecovery(
      doc({
        ensembleProgressVersion: 1,
        status: "finished",
        completedAt: "2026-07-03T12:00:00.000Z",
      }),
      "invalidFieldValue"
    );
  });

  void it("captures opaque properties byte-identically and in order", () => {
    const text =
      `{"taskFolder":"2026-07-01_task_1","zeta":  {"nested": [1, 2,   3]},` +
      `"currentStage":"impl","alpha":"u\\u00e9nicode",` +
      `"createdAt":"2026-07-01T10:00:00.000Z","updatedAt":"2026-07-01T10:00:00.000Z"}`;
    const result = decodeTaskProgressTextV1(text);
    assert.equal(result.ok, true);
    if (result.ok) {
      const opaque = result.decoded.entries.flatMap((e) =>
        e.kind === "opaque" ? [e.entry] : []
      );
      assert.deepEqual(
        opaque.map((e) => e.name),
        ["zeta", "alpha"]
      );
      assert.equal(opaque[0]?.rawValue, `{"nested": [1, 2,   3]}`);
      assert.equal(opaque[1]?.rawValue, `"u\\u00e9nicode"`);
    }
  });

  void it("returns invalidJson / notAnObject for structurally unusable documents", () => {
    expectRecovery("not json at all", "invalidJson");
    expectRecovery("[1, 2]", "notAnObject");
    expectRecovery("null", "notAnObject");
  });

  void it("decodes every checked-in valid fixture and recovers every recovery fixture", () => {
    for (const family of ["legacy", "v1"]) {
      const dir = path.join(FIXTURE_ROOT, family);
      for (const file of fs.readdirSync(dir).sort()) {
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        const result = decodeTaskProgressTextV1(text);
        assert.equal(result.ok, true, `${family}/${file} should decode strictly`);
      }
    }
    const recoveryDir = path.join(FIXTURE_ROOT, "recovery");
    for (const file of fs.readdirSync(recoveryDir).sort()) {
      const text = fs.readFileSync(path.join(recoveryDir, file), "utf8");
      const result = decodeTaskProgressTextV1(text);
      assert.equal(result.ok, false, `recovery/${file} must fail closed`);
    }
  });
});
