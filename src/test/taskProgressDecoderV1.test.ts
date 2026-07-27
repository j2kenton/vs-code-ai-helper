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
