/**
 * bugs4 item 21 / Step 19: a test run the owner ran by hand and recorded counts as test evidence
 * for the items it names, with owner provenance, and never loosens the rule for model claims.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { TaskProgress } from "../types/taskProgress";
import { normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";
import { recordPlanItemOwnerTestRunV1 } from "../utils/taskProgressTransforms";
import { ownerRecordedPassingRunCoversItemV1 } from "../commands/applyReviewerVerifiedTicks";

const REVISION = "a".repeat(64);
const ITEM = "Run the portable resilience drill against Postgres 16 and confirm it passes.";

const base = {
  taskFolder: "2026-07-01_task_1",
  currentStage: "impl",
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-02T11:30:00.000Z",
};
const row = (overrides: Record<string, unknown> = {}) => ({
  planRevision: REVISION,
  source: "owner",
  at: "2026-10-30T20:00:00.000Z",
  formId: "form-1",
  command: "npm run resilience:test:portable -- --synthetic --require-postgres16",
  exitCode: 0,
  summary: "exit 0, 2m45s, 25 negative fixtures refused",
  itemKeys: [normalizeChecklistItemTextV1(ITEM)],
  ...overrides,
});

void describe("owner-recorded test runs (bugs4 item 21, Step 19)", () => {
  void it("stores the command, exit code, summary and covered items with owner provenance", () => {
    const progress = recordPlanItemOwnerTestRunV1({ ...base } as unknown as TaskProgress, {
      planRevision: REVISION,
      itemTexts: [ITEM, ITEM],
      at: "2026-10-30T20:00:00.000Z",
      formId: "form-1",
      command: "  npm run resilience:test:portable -- --synthetic --require-postgres16 ",
      exitCode: 0,
      summary: "exit 0, 2m45s, 25 negative fixtures refused",
    });
    const runs = progress.planItemOwnerTestRuns ?? [];
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.source, "owner");
    assert.equal(runs[0]?.exitCode, 0);
    assert.deepEqual(runs[0]?.itemKeys, [normalizeChecklistItemTextV1(ITEM)]);
  });

  void it("records the same form submission once", () => {
    const input = {
      planRevision: REVISION, itemTexts: [ITEM], at: "2026-10-30T20:00:00.000Z", formId: "form-1",
      command: "npm test", exitCode: 0, summary: "ok",
    };
    const once = recordPlanItemOwnerTestRunV1({ ...base } as unknown as TaskProgress, input);
    const twice = recordPlanItemOwnerTestRunV1(once, input);
    assert.equal(twice.planItemOwnerTestRuns?.length, 1);
  });

  void it("records nothing when no item is named", () => {
    const progress = recordPlanItemOwnerTestRunV1({ ...base } as unknown as TaskProgress, {
      planRevision: REVISION, itemTexts: [], at: "2026-10-30T20:00:00.000Z", formId: "f",
      command: "npm test", exitCode: 0, summary: "",
    });
    assert.equal(progress.planItemOwnerTestRuns, undefined);
  });

  void it("counts only a passing run for the same item as evidence for it, whatever the plan revision (review1 Step 2)", () => {
    const key = normalizeChecklistItemTextV1(ITEM);
    const passing = [row()] as unknown as import("../types/taskProgress").PlanItemOwnerTestRunV1[];
    assert.equal(ownerRecordedPassingRunCoversItemV1(passing, key), true);
    // A failing run is recorded but settles nothing.
    const failing = [row({ exitCode: 1 })] as unknown as typeof passing;
    assert.equal(ownerRecordedPassingRunCoversItemV1(failing, key), false);
    // A run for another item does not apply.
    assert.equal(ownerRecordedPassingRunCoversItemV1(passing, "some other item"), false);
    // A run recorded against an item's content hash applies only while that hash is unchanged.
    const hashed = [row({ itemContentHashes: { [key]: "h1" } })] as unknown as typeof passing;
    assert.equal(ownerRecordedPassingRunCoversItemV1(hashed, key, "h1"), true);
    assert.equal(ownerRecordedPassingRunCoversItemV1(hashed, key, "h2"), false);
    // No runs at all: a test-dependent model claim stays unverified (control).
    assert.equal(ownerRecordedPassingRunCoversItemV1([], key), false);
  });

  void it("round-trips through the task-progress decoder and rejects malformed records", () => {
    const rows = [row()];
    const result = decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: rows }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.decoded.progress.planItemOwnerTestRuns, rows);
    for (const bad of [
      row({ source: "reviewer" }),
      row({ exitCode: "0" }),
      row({ exitCode: 0.5 }),
      row({ itemKeys: [] }),
      row({ command: "" }),
      row({ extra: 1 }),
      "pass",
    ]) {
      assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: [bad] })).ok, false);
    }
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: "pass" })).ok, false);
  });
});
