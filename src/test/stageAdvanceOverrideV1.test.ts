/**
 * bugs3 Step 16: the label, guidance, de-duplication and audit record for a
 * manual advance over review blockers.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  advanceAnywayLabelV1,
  advanceBlockerGuidanceV1,
  appendStageAdvanceOverrideV1,
  buildStageAdvanceOverrideRecordV1,
  pendingStageAdvanceCountV1,
  runExclusiveStageAdvanceV1,
  skippedBlockerIdV1,
  stageAdvanceConfirmationKeyV1,
  stageAdvanceInFlightKeyV1,
  STAGE_ADVANCE_OVERRIDE_FILE_V1,
  voidStageAdvanceOverrideV1,
} from "../utils/stageAdvanceOverrideV1";

const OWNER_EVIDENCE = {
  category: "completion",
  resolver: "environmental",
  description: "Owner evidence needed: backup-account root/MFA recovery access.",
};
const FIXABLE = { category: "completion", resolver: "task-fixable", description: "Step 3 is not implemented." };

void describe("advance-anyway wording", () => {
  void it("names the destination and never says Complete", () => {
    assert.equal(advanceAnywayLabelV1("Low-Level Review (Plan)"), "Advance to Low-Level Review (Plan) anyway");
    assert.doesNotMatch(advanceAnywayLabelV1("Publish"), /complete/i);
  });

  void it("guides an owner-evidence blocker to the answer or a carried gate, not a plan.md edit", () => {
    const text = advanceBlockerGuidanceV1([OWNER_EVIDENCE], "Low-Level Review (Plan)");
    assert.match(text, /Owner evidence/);
    assert.match(text, /carry the gate forward/);
    assert.doesNotMatch(text, /plan\.md/);
  });

  void it("guides a task-fixable blocker to a fix round and mixes both kinds", () => {
    assert.match(advanceBlockerGuidanceV1([FIXABLE], "Publish"), /fix round/);
    const mixed = advanceBlockerGuidanceV1([FIXABLE, OWNER_EVIDENCE], "Publish");
    assert.match(mixed, /fix round/);
    assert.match(mixed, /owner-evidence/);
  });
});

void describe("confirmation de-duplication", () => {
  void it("keys on task, move and blocker set, independent of blocker order", () => {
    const a = stageAdvanceConfirmationKeyV1("/t", "plan-high-review", "plan-low-review", [FIXABLE, OWNER_EVIDENCE]);
    const b = stageAdvanceConfirmationKeyV1("/t", "plan-high-review", "plan-low-review", [OWNER_EVIDENCE, FIXABLE]);
    const other = stageAdvanceConfirmationKeyV1("/t", "plan-high-review", "plan-low-review", [FIXABLE]);
    const elsewhere = stageAdvanceConfirmationKeyV1("/u", "plan-high-review", "plan-low-review", [FIXABLE, OWNER_EVIDENCE]);
    assert.equal(a, b);
    assert.notEqual(a, other);
    assert.notEqual(a, elsewhere);
  });

  void it("holds the slot across the confirmation AND the transition, not just until the answer", async () => {
    let worked = 0;
    let busy = 0;
    let answerConfirmation: () => void = () => undefined;
    let finishTransition: () => void = () => undefined;
    const confirmation = new Promise<void>((resolve) => {
      answerConfirmation = resolve;
    });
    const transition = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    const first = runExclusiveStageAdvanceV1(
      "k",
      async (release) => {
        worked += 1;
        await confirmation;
        // confirmation answered; the move is still being written
        await transition;
        release();
        return "advanced";
      },
      () => {
        busy += 1;
        return "busy";
      }
    );
    assert.equal(await runExclusiveStageAdvanceV1("k", () => Promise.resolve("x"), () => { busy += 1; return "busy"; }), "busy");
    answerConfirmation();
    await Promise.resolve();
    assert.equal(
      await runExclusiveStageAdvanceV1("k", () => Promise.resolve("x"), () => { busy += 1; return "busy"; }),
      "busy",
      "an answered confirmation whose transition is still running still refuses another click"
    );
    finishTransition();
    assert.equal(await first, "advanced");
    assert.equal(worked, 1);
    assert.equal(busy, 2);
    assert.equal(pendingStageAdvanceCountV1(), 0);
    assert.equal(await runExclusiveStageAdvanceV1("k", () => Promise.resolve("again"), () => "busy"), "again");
  });

  void it("an early release lets the follow-up dispatch run without holding the slot", async () => {
    let inner = "";
    await runExclusiveStageAdvanceV1(
      "released-early",
      async (release) => {
        release();
        inner = await runExclusiveStageAdvanceV1("released-early", () => Promise.resolve("free"), () => "busy");
      },
      () => undefined
    );
    assert.equal(inner, "free");
  });

  void it("releases the slot when the work throws", async () => {
    await assert.rejects(
      runExclusiveStageAdvanceV1("fails", () => Promise.reject(new Error("closed")), () => undefined)
    );
    assert.equal(pendingStageAdvanceCountV1(), 0);
  });

  void it("separates different tasks and source stages", () => {
    assert.notEqual(stageAdvanceInFlightKeyV1("/t", "plan-high-review"), stageAdvanceInFlightKeyV1("/t", "plan-low-review"));
    assert.notEqual(stageAdvanceInFlightKeyV1("/t", "plan-high-review"), stageAdvanceInFlightKeyV1("/u", "plan-high-review"));
  });
});

void describe("override record", () => {
  void it("carries stages, actor, time and every skipped blocker verbatim, appended per line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-override-"));
    try {
      const record = buildStageAdvanceOverrideRecordV1({
        sourceStage: "plan-high-review",
        destinationStage: "plan-low-review",
        blockers: [OWNER_EVIDENCE, FIXABLE],
        now: new Date("2026-10-30T10:00:00.000Z"),
      });
      assert.equal(record.at, "2026-10-30T10:00:00.000Z");
      assert.equal(record.actor, "owner");
      assert.equal(await appendStageAdvanceOverrideV1(dir, record), true);
      assert.equal(await appendStageAdvanceOverrideV1(dir, record), true);
      const lines = fs.readFileSync(path.join(dir, STAGE_ADVANCE_OVERRIDE_FILE_V1), "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]!) as { skippedBlockers: { description: string }[] };
      assert.deepEqual(first.skippedBlockers.map((b) => b.description), [
        OWNER_EVIDENCE.description,
        FIXABLE.description,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("gives every skipped blocker a stable id and keeps the declared lineage", () => {
    const record = buildStageAdvanceOverrideRecordV1({
      sourceStage: "plan-high-review",
      destinationStage: "plan-low-review",
      blockers: [{ ...OWNER_EVIDENCE, declaredLineage: "same:abc-1" }, FIXABLE],
    });
    const [owner, fixable] = record.skippedBlockers;
    assert.equal(owner!.id, skippedBlockerIdV1(OWNER_EVIDENCE));
    assert.equal(owner!.declaredLineage, "same:abc-1");
    assert.equal(fixable!.id, skippedBlockerIdV1(FIXABLE));
    assert.notEqual(owner!.id, fixable!.id);
    assert.equal(fixable!.declaredLineage, undefined);
    const reworded = { ...FIXABLE, description: `  ${FIXABLE.description}  ` };
    assert.equal(skippedBlockerIdV1(reworded), skippedBlockerIdV1(FIXABLE), "whitespace does not change the id");
  });

  void it("writes a void line that names the record it cancels", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-override-void-"));
    try {
      const record = buildStageAdvanceOverrideRecordV1({
        sourceStage: "plan-high-review",
        destinationStage: "plan-low-review",
        blockers: [FIXABLE],
        now: new Date("2026-10-30T10:00:00.000Z"),
      });
      assert.equal(await appendStageAdvanceOverrideV1(dir, record), true);
      assert.equal(await voidStageAdvanceOverrideV1(dir, record, "the stage move was not persisted"), true);
      const lines = fs.readFileSync(path.join(dir, STAGE_ADVANCE_OVERRIDE_FILE_V1), "utf8").trim().split("\n");
      const voided = JSON.parse(lines[1]!) as { kind: string; voids: string; reason: string };
      assert.equal(voided.kind, "stage-advance-override-void");
      assert.equal(voided.voids, "2026-10-30T10:00:00.000Z");
      assert.match(voided.reason, /not persisted/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("reports a failed write instead of throwing", async () => {
    const record = buildStageAdvanceOverrideRecordV1({ sourceStage: "a", destinationStage: "b", blockers: [] });
    assert.equal(await appendStageAdvanceOverrideV1(path.join(os.tmpdir(), "definitely", "missing", "dir"), record), false);
  });
});
