/**
 * v1 fixes 2, item 31 (Part 5a): when the newest review has nothing task-fixable
 * and only hand-off checks remain unticked, no further automatic Implementation
 * round is dispatched — and the stop stays narrow.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import type { ReviewScoreHistoryEntry } from "../types/taskProgress";
import { classifyUncheckedChecklistItemsV1, tickHandoffChecksV1 } from "../utils/implementationChecklist";
import {
  ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1,
  acceptHandoffChecksV1,
  buildHandoffChecksDecisionInputV1,
  keepHandoffChecksV1,
  tickHandoffCheckV1,
  type HandoffChecksArgV1,
  type HandoffCommandIoV1,
} from "../commands/handoffChecksV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";
import { decideHandoffOnlyStopV1, IMPL_REVIEW_STAGES_V1 } from "../utils/reviewRouting";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  "- [x] Build the thing",
  "- [ ] Build the other thing",
  "",
  "## Verification",
  "",
  "- [ ] Run check-types, lint and the full test suite",
  "- [ ] Confirm the toast reads correctly in a real window <!-- ensemble:excluded -->",
  "- [ ] Click through the card in a live window",
].join("\n");

function planWith(buildOpen: boolean): string {
  return PLAN.replace("- [ ] Build the other thing", buildOpen ? "- [ ] Build the other thing" : "- [x] Build the other thing");
}

function review(taskFixableCount: number): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score: 9,
    at: "2026-09-20T00:00:00.000Z",
    taskFixableCount,
  } as ReviewScoreHistoryEntry;
}

void describe("classifyUncheckedChecklistItemsV1", () => {
  void it("separates buildable items from Verification hand-off checks and skips excluded ones", () => {
    const result = classifyUncheckedChecklistItemsV1(PLAN);
    assert.deepEqual(result.buildable, ["Build the other thing"]);
    assert.deepEqual(result.handoff, [
      "Run check-types, lint and the full test suite",
      "Click through the card in a live window",
    ]);
  });

  void it("reports nothing buildable once the build items are ticked", () => {
    assert.deepEqual(classifyUncheckedChecklistItemsV1(planWith(false)).buildable, []);
  });
});

void describe("decideHandoffOnlyStopV1", () => {
  const stages = IMPL_REVIEW_STAGES_V1;

  void it("stops when the review is clean and only hand-off checks remain, listing them", () => {
    const stop = decideHandoffOnlyStopV1({
      history: [review(0)],
      stages,
      unchecked: classifyUncheckedChecklistItemsV1(planWith(false)),
    });
    assert.ok(stop);
    assert.equal(stop.checks.length, 2);
    assert.match(stop.reason, /hand-off checks/);
  });

  void it("does not stop while a buildable item remains", () => {
    assert.equal(
      decideHandoffOnlyStopV1({ history: [review(0)], stages, unchecked: classifyUncheckedChecklistItemsV1(planWith(true)) }),
      undefined
    );
  });

  void it("does not stop while the review still reports task-fixable blockers", () => {
    assert.equal(
      decideHandoffOnlyStopV1({ history: [review(2)], stages, unchecked: classifyUncheckedChecklistItemsV1(planWith(false)) }),
      undefined
    );
  });

  void it("does not stop when no review has run", () => {
    assert.equal(
      decideHandoffOnlyStopV1({ history: [], stages, unchecked: classifyUncheckedChecklistItemsV1(planWith(false)) }),
      undefined
    );
  });

  void it("does not stop while a continuation or quarantine is owed", () => {
    const unchecked = classifyUncheckedChecklistItemsV1(planWith(false));
    assert.equal(decideHandoffOnlyStopV1({ history: [review(0)], stages, unchecked, continuationOwed: true }), undefined);
    assert.equal(decideHandoffOnlyStopV1({ history: [review(0)], stages, unchecked, pendingImplReviewFilesCount: 3 }), undefined);
  });

  void it("does not stop when nothing at all is outstanding", () => {
    assert.equal(
      decideHandoffOnlyStopV1({ history: [review(0)], stages, unchecked: { buildable: [], handoff: [] } }),
      undefined
    );
  });
});

void describe("tickHandoffChecksV1", () => {
  void it("ticks a named hand-off check with its note and leaves every other byte alone", () => {
    const result = tickHandoffChecksV1(PLAN, [
      { itemText: "Click through the card in a live window", note: "card read correctly." },
    ]);
    assert.deepEqual(result.tickedItemTexts, ["Click through the card in a live window"]);
    assert.equal(
      result.content,
      PLAN.replace(
        "- [ ] Click through the card in a live window",
        "- [x] Click through the card in a live window — Checked: card read correctly."
      )
    );
  });

  void it("never settles buildable work, excluded items or already-ticked items", () => {
    const result = tickHandoffChecksV1(PLAN, [
      { itemText: "Build the other thing", note: "done" },
      { itemText: "Confirm the toast reads correctly in a real window", note: "seen" },
      { itemText: "Build the thing", note: "done" },
    ]);
    assert.deepEqual(result.tickedItemTexts, []);
    assert.equal(result.content, PLAN);
  });

  void it("accepting the rest settles every remaining hand-off check and leaves nothing outstanding", () => {
    const remaining = classifyUncheckedChecklistItemsV1(planWith(false)).handoff;
    const result = tickHandoffChecksV1(
      planWith(false),
      remaining.map((itemText) => ({ itemText, note: ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1 }))
    );
    assert.equal(result.tickedItemTexts.length, 2);
    assert.deepEqual(classifyUncheckedChecklistItemsV1(result.content), { buildable: [], handoff: [] });
    assert.ok(result.content.includes(ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1));
  });

  void it("falls back to a plain note when none is given", () => {
    const result = tickHandoffChecksV1(PLAN, [{ itemText: "Click through the card in a live window", note: "  " }]);
    assert.ok(result.content.includes("— Checked: confirmed by you."));
  });
});

void describe("buildHandoffChecksDecisionInputV1", () => {
  const checks = ["Check one", "Check two"];
  const input = buildHandoffChecksDecisionInputV1({
    canonicalId: "/tmp/task",
    taskFolderPath: "/tmp/task",
    stage: "impl-high-review",
    reason: "Only hand-off checks remain.",
    checks,
  });

  void it("offers a tick per check, an accept-the-rest action and a do-nothing choice", () => {
    assert.deepEqual(
      input.options.map((option) => option.optionId),
      ["tick-0", "tick-1", "acceptRest", "notYet"]
    );
    const tick = input.options[0]!.effect;
    assert.equal(tick.kind, "command");
    assert.deepEqual(tick.kind === "command" ? tick.args : undefined, [
      { taskFolderPath: "/tmp/task", itemText: "Check one", stage: "impl-high-review" },
    ]);
    // "Not yet" must be a command, never `doNothing`: a decision resolves as
    // soon as an option is chosen, so a bare no-op would leave no card behind.
    const notYet = input.options[3]!.effect;
    assert.equal(notYet.kind, "command");
    assert.equal(notYet.kind === "command" ? notYet.command : undefined, "vs-code-ai-helper.keepHandoffChecks");
  });

  void it("says plainly that it is waiting for the user and claims no recommendation it cannot make", () => {
    assert.ok(input.whatHappened.startsWith("Waiting for you:"));
    assert.equal(input.recommendation.kind, "none");
    assert.ok(/no basis to recommend/i.test(input.recommendation.reasoning));
  });

  void it("caps the per-check options while accept-the-rest still counts every check", () => {
    const many = Array.from({ length: 9 }, (_, i) => `Check ${i}`);
    const big = buildHandoffChecksDecisionInputV1({
      canonicalId: "/tmp/task",
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review",
      reason: "r",
      checks: many,
    });
    assert.equal(big.options.filter((option) => option.optionId.startsWith("tick-")).length, 6);
    assert.equal(big.evidence?.length, 9);
    assert.ok(big.options.some((option) => option.optionId === "acceptRest" && option.label.includes("9")));
  });

  void it("lists every check as evidence up to the itemisation limit and says how many more there are", () => {
    const many = Array.from({ length: 25 }, (_, i) => `Check ${i}`);
    const big = buildHandoffChecksDecisionInputV1({
      canonicalId: "/tmp/task",
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review",
      reason: "r",
      checks: many,
    });
    assert.equal(big.evidence?.length, 21);
    assert.match(big.evidence?.[20]?.detail ?? "", /5 further checks/);
  });
});

void describe("hand-off card lifecycle", () => {
  // The stub workspace filesystem does not touch disk; point it at the real one
  // for these tests so the plan the commands read and write is the temp file.
  let restoreFs: (() => void) | undefined;
  beforeEach(() => {
    initNotificationRouter({ addEntry: () => undefined } as unknown as Parameters<typeof initNotificationRouter>[0]);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = { ...fsObj };
    fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsObj.createDirectory = (): Promise<void> => Promise.resolve();
    fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    restoreFs = (): void => {
      Object.assign(fsObj, orig);
    };
  });
  afterEach(() => {
    restoreFs?.();
    deactivateNotificationRouter();
  });

  async function withPlan(run: (folder: string, planPath: string) => Promise<void>): Promise<void> {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-card-"));
    const planPath = path.join(folder, "plan-final.md");
    fs.writeFileSync(planPath, planWith(false));
    try {
      await run(folder, planPath);
    } finally {
      safeRemoveDir(folder);
    }
  }

  function makeIo(note: string | undefined): {
    io: HandoffCommandIoV1;
    reposts: (readonly string[])[];
    lastRepostArg: () => HandoffChecksArgV1 | undefined;
  } {
    const reposts: (readonly string[])[] = [];
    let lastArg: HandoffChecksArgV1 | undefined;
    return {
      reposts,
      lastRepostArg: () => lastArg,
      io: {
        askNote: () => Promise.resolve(note),
        refresh: () => Promise.resolve(),
        repost: (arg, remaining): Promise<void> => {
          lastArg = arg;
          reposts.push(remaining);
          return Promise.resolve();
        },
      },
    };
  }

  void it("re-posts the card with the checks still outstanding after one is ticked", async () => {
    await withPlan(async (folder, planPath) => {
      const { io, reposts, lastRepostArg } = makeIo("saw it work");
      const ok = await tickHandoffCheckV1(
        { taskFolderPath: folder, itemText: "Click through the card in a live window", stage: "impl-high-review" },
        io
      );
      assert.equal(ok, true);
      assert.ok(fs.readFileSync(planPath, "utf8").includes("— Checked: saw it work."));
      assert.deepEqual(reposts, [["Run check-types, lint and the full test suite"]]);
      assert.equal(lastRepostArg()?.stage, "impl-high-review");
    });
  });

  void it("re-posts the card, ticking nothing, when the user chooses Not yet", async () => {
    await withPlan(async (folder, planPath) => {
      const before = fs.readFileSync(planPath, "utf8");
      const { io, reposts, lastRepostArg } = makeIo("unused");
      const ok = await keepHandoffChecksV1({ taskFolderPath: folder, stage: "impl-high-review" }, io);
      assert.equal(ok, true);
      assert.equal(fs.readFileSync(planPath, "utf8"), before);
      assert.equal(reposts.length, 1);
      assert.equal(reposts[0]!.length, 2);
      assert.equal(lastRepostArg()?.stage, "impl-high-review");
    });
  });

  void it("brings the card back, and reports no tick, when the note prompt is cancelled", async () => {
    await withPlan(async (folder, planPath) => {
      const before = fs.readFileSync(planPath, "utf8");
      const { io, reposts } = makeIo(undefined);
      const ok = await tickHandoffCheckV1({ taskFolderPath: folder, itemText: "Click through the card in a live window" }, io);
      assert.equal(ok, false);
      assert.equal(fs.readFileSync(planPath, "utf8"), before);
      assert.equal(reposts.length, 1);
      assert.equal(reposts[0]!.length, 2);
    });
  });

  void it("does not re-post once the last check is ticked", async () => {
    await withPlan(async (folder) => {
      const { io, reposts } = makeIo("ok");
      await tickHandoffCheckV1({ taskFolderPath: folder, itemText: "Click through the card in a live window" }, io);
      await tickHandoffCheckV1({ taskFolderPath: folder, itemText: "Run check-types, lint and the full test suite" }, io);
      assert.equal(reposts.length, 1);
    });
  });

  void it("reaches a check beyond the option cap by ticking through successive cards", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-card-many-"));
    try {
      const checks = Array.from({ length: 9 }, (_, i) => `Hand-off check number ${i}`);
      const planPath = path.join(folder, "plan-final.md");
      fs.writeFileSync(planPath, ["## Verification", "", ...checks.map((c) => `- [ ] ${c}`)].join("\n"));
      const { io, reposts } = makeIo("ok");
      let outstanding: readonly string[] = checks;
      for (let round = 0; round < 9 && outstanding.length > 0; round += 1) {
        const card = buildHandoffChecksDecisionInputV1({
          canonicalId: folder,
          taskFolderPath: folder,
          stage: "impl-high-review",
          reason: "r",
          checks: outstanding,
        });
        const ticks = card.options.filter((option) => option.optionId.startsWith("tick-"));
        assert.ok(ticks.length > 0);
        const effect = ticks[0]!.effect;
        assert.equal(effect.kind, "command");
        await tickHandoffCheckV1(effect.kind === "command" ? (effect.args?.[0] as HandoffChecksArgV1) : undefined, io);
        // The last tick leaves nothing to re-post, so what is outstanding is what is on disk.
        outstanding = classifyUncheckedChecklistItemsV1(fs.readFileSync(planPath, "utf8")).handoff;
      }
      assert.ok(reposts.length >= 1);
      assert.deepEqual(outstanding, []);
      assert.deepEqual(classifyUncheckedChecklistItemsV1(fs.readFileSync(planPath, "utf8")).handoff, []);
    } finally {
      safeRemoveDir(folder);
    }
  });

  void it("accept settles only the checks the card displayed, and leaves a later-added check outstanding", async () => {
    await withPlan(async (folder, planPath) => {
      fs.appendFileSync(planPath, "\n- [ ] A check added after the card was posted\n");
      const { io, reposts } = makeIo("unused");
      const ok = await acceptHandoffChecksV1(
        {
          taskFolderPath: folder,
          itemTexts: ["Run check-types, lint and the full test suite", "Click through the card in a live window"],
          stage: "impl-high-review",
        },
        io
      );
      assert.equal(ok, true);
      const plan = fs.readFileSync(planPath, "utf8");
      assert.ok(plan.includes(ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1));
      assert.deepEqual(classifyUncheckedChecklistItemsV1(plan).handoff, ["A check added after the card was posted"]);
      assert.deepEqual(reposts, [["A check added after the card was posted"]]);
    });
  });
});
