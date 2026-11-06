/**
 * review1 Step 34 / Step 53 (review pass 34 blockers): items a review verified but whose test report does not
 * count are named on a card that offers Ensemble's own Publish Checks run, the owner's recorded run and the owner's
 * tick, and never an Apply Review. The latched-checklist review-completion path raises that card too, for an
 * all-withheld outcome and for a mixed one (the eligible items are still ticked at once).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { applyVerifiedTicksForLatchedChecklistV1 } from "../commands/reviewActions";
import { runChecksForWithheldItemsV1, tickWithheldTestItemsV1 } from "../commands/withheldTestEvidenceCommandsV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import { listCheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import {
  buildWithheldTestEvidenceCardInputV1,
  RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1,
  TICK_WITHHELD_TEST_ITEMS_COMMAND_V1,
  WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1,
} from "../utils/withheldTestEvidenceCardV1";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ALPHA = "Write the tests for Part 1 in src/test/alpha.test.ts";
const BETA = "Write the tests for Part 2 in src/test/beta.test.ts";
const GATE = "Wire the completeness gate";

function planOf(items: readonly string[]): string {
  return ["<!-- ensemble:implementation-checklist -->", "", "# Plan", "", ...items.map((item) => `- [ ] ${item}`), ""].join("\n");
}

function reviewNaming(items: readonly string[]): string {
  return [
    "Readiness: 8/10",
    "",
    "<!-- verified-complete:start -->",
    ...items.flatMap((item) => [`- ${item}`, "  evidence: src/gate.ts:12 reads the shared count"]),
    "<!-- verified-complete:end -->",
    "",
    "<!-- blockers:start -->",
    "<!-- blockers:end -->",
    "",
  ].join("\n");
}

void describe("withheld test evidence: the card, the latched path and the commands (Step 34/53)", () => {
  const roots: string[] = [];
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fsApi };
  const workspace = vscode.workspace as unknown as { workspaceFolders?: unknown };
  const originalFolders = workspace.workspaceFolders;
  let memento: vscode.Memento;

  beforeEach(() => {
    initNotificationRouter({ addEntry: () => undefined } as unknown as Parameters<typeof initNotificationRouter>[0]);
    fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsApi.createDirectory = (): Promise<void> => Promise.resolve();
    fsApi.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    fsApi.stat = (uri: vscode.Uri): Promise<unknown> => fs.promises.stat(uri.fsPath);
    const backing = new Map<string, unknown>();
    memento = {
      get: <T>(key: string, fallback?: T): T => (backing.has(key) ? (backing.get(key) as T) : (fallback as T)),
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...backing.keys()],
    } as unknown as vscode.Memento;
    setExtensionContextV1({ globalState: memento, workspaceState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    Object.assign(fsApi, original);
    workspace.workspaceFolders = originalFolders;
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    deactivateNotificationRouter();
    for (const root of roots.splice(0)) safeRemoveDir(root);
  });

  /** A task at High-Level Code Review whose review verified `reviewItems`, over a plan of `planItems`. */
  function stage(planItems: readonly string[], reviewItems: readonly string[], latched = true): { folder: string; root: string } {
    const { folder } = makeOwnedTaskFolder("withheld-evidence-");
    const root = path.dirname(path.dirname(folder));
    roots.push(root);
    const progressPath = path.join(folder, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    progress.currentStage = "impl-high-review";
    progress.status = "active";
    if (latched) progress.checklistProgressUnreliable = true;
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    fs.writeFileSync(path.join(folder, "plan-final.md"), planOf(planItems));
    fs.writeFileSync(path.join(folder, "impl-high-review.md"), reviewNaming(reviewItems));
    // The tested files exist in the "workspace" the task sits in, so a Publish Checks report can hash them.
    fs.mkdirSync(path.join(root, "src", "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "test", "alpha.test.ts"), "// alpha\n");
    fs.writeFileSync(path.join(root, "src", "test", "beta.test.ts"), "// beta\n");
    workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: "ws", index: 0 }];
    return { folder, root };
  }

  function pendingKey(folder: string, key: string): WorkflowDecisionV1[] {
    return new WorkflowDecisionStoreV1(memento).listPending(folder).filter((d) => d.decisionKey === key);
  }

  void it("the card offers Publish Checks, a recorded run and the owner's tick, and never a model round", () => {
    const card = buildWithheldTestEvidenceCardInputV1({
      taskFolderPath: "/t",
      stage: "impl-high-review",
      taskLabel: "chat1",
      items: [ALPHA, BETA],
      reasonFor: () => "no test report is recorded for this item",
    });
    assert.deepEqual(
      card.options.map((o) => o.optionId),
      ["runChecks", "recordRun", "tickThese", "notNow"]
    );
    const commands = card.options.flatMap((o) => (o.effect.kind === "command" ? [o.effect.command] : []));
    assert.ok(commands.includes(RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1));
    assert.ok(commands.includes(TICK_WITHHELD_TEST_ITEMS_COMMAND_V1));
    assert.ok(commands.includes("vs-code-ai-helper.postOwnerTestRunCard"));
    assert.ok(
      commands.every((c) => !/resumeAndApplyCurrentStageAction|applyReview|runImplementation/i.test(c)),
      "no option dispatches an editing round"
    );
    assert.equal(card.recommendation.kind, "option");
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : "", "runChecks");
    assert.match(card.whatHappened, /alpha\.test\.ts/);
    assert.match(card.whatHappened, /beta\.test\.ts/);
    assert.match(card.whatHappened, /no test report is recorded for this item/);
    assert.match(card.whatHappened, /another round cannot produce a test report that counts/);
  });

  void it("latched, all items withheld: nothing is ticked and the card names every withheld item", async () => {
    const { folder } = stage([ALPHA, BETA], [ALPHA, BETA]);
    const result = await applyVerifiedTicksForLatchedChecklistV1(vscode.Uri.file(folder), "impl-high-review", reviewNaming([ALPHA, BETA]), "chat1");
    assert.equal(result.handled, true);
    assert.equal(result.latchOutcome?.appliedCount, 0);
    assert.equal(result.latchOutcome?.withheldTestItems, 2);
    const cards = pendingKey(folder, WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1);
    assert.equal(cards.length, 1, "one card for the withheld items");
    assert.match(cards[0]!.whatHappened, /alpha\.test\.ts/);
    assert.match(cards[0]!.whatHappened, /beta\.test\.ts/);
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.equal(listCheckedChecklistItemTextsV1(plan).length, 0, "no tick was applied");
  });

  void it("latched, mixed outcome: the eligible item is ticked at once and the card names only the withheld ones", async () => {
    const { folder } = stage([GATE, ALPHA, BETA], [GATE, ALPHA, BETA]);
    const result = await applyVerifiedTicksForLatchedChecklistV1(
      vscode.Uri.file(folder),
      "impl-high-review",
      reviewNaming([GATE, ALPHA, BETA]),
      "chat1"
    );
    assert.equal(result.handled, true);
    assert.equal(result.latchOutcome?.appliedCount, 1);
    assert.equal(result.latchOutcome?.withheldTestItems, 2);
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.deepEqual(listCheckedChecklistItemTextsV1(plan), [GATE]);
    const cards = pendingKey(folder, WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1);
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.whatHappened, /alpha\.test\.ts/);
    assert.match(cards[0]!.whatHappened, /beta\.test\.ts/);
    assert.doesNotMatch(cards[0]!.whatHappened, /completeness gate/, "the ticked item is not on the card");
  });

  void it("latched, nothing withheld: no card is raised", async () => {
    const { folder } = stage([GATE], [GATE]);
    await applyVerifiedTicksForLatchedChecklistV1(vscode.Uri.file(folder), "impl-high-review", reviewNaming([GATE]), "chat1");
    assert.equal(pendingKey(folder, WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1).length, 0);
  });

  void it("Run Publish Checks now: a pass naming one item's test file records a report and ticks that item at once", async () => {
    const { folder } = stage([ALPHA, BETA], [ALPHA, BETA], false);
    const outcome = await runChecksForWithheldItemsV1(
      { taskFolderPath: folder, stage: "impl-high-review", itemTexts: [ALPHA, BETA], displayName: "chat1" },
      { runChecks: () => Promise.resolve({ passed: true, passedTestFiles: ["out/test/alpha.test.js"] }) }
    );
    assert.ok(typeof outcome === "object" && outcome.outcome === "done");
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.deepEqual(listCheckedChecklistItemTextsV1(plan), [ALPHA], "only the item whose test file the output names is ticked");
    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    const rows = (progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.testReports![0]!.source, "publishChecks");
    assert.match(typeof outcome === "object" ? (outcome.message ?? "") : "", /Not recorded/);
  });

  void it("Run Publish Checks now: a failing or refused run records and ticks nothing", async () => {
    const { folder } = stage([ALPHA], [ALPHA], false);
    const failed = await runChecksForWithheldItemsV1(
      { taskFolderPath: folder, itemTexts: [ALPHA] },
      { runChecks: () => Promise.resolve({ passed: false, passedTestFiles: ["out/test/alpha.test.js"] }) }
    );
    assert.ok(typeof failed === "object" && failed.outcome === "done" && /did not pass/.test(failed.message ?? ""));
    const refused = await runChecksForWithheldItemsV1(
      { taskFolderPath: folder, itemTexts: [ALPHA] },
      { runChecks: () => Promise.reject(new Error("the checks were refused")) }
    );
    assert.ok(typeof refused === "object" && refused.outcome === "refused" && /refused/.test(refused.message ?? ""));
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.equal(listCheckedChecklistItemTextsV1(plan).length, 0);
  });

  void it("Tick these myself: ticks each item and records the owner's tick", async () => {
    const { folder } = stage([ALPHA, BETA], [ALPHA, BETA], false);
    const outcome = await tickWithheldTestItemsV1({ taskFolderPath: folder, itemTexts: [ALPHA, BETA] });
    assert.ok(typeof outcome === "object" && outcome.outcome === "done" && /ticked 2 items/.test(outcome.message ?? ""));
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.equal(listCheckedChecklistItemTextsV1(plan).length, 2);
    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    assert.equal((progress?.planItemOwnerDecisions ?? []).filter((d) => d.decision === "tick").length, 2);
  });
});
