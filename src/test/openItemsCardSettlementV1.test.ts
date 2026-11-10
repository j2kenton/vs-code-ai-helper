/**
 * review2 Steps 6-7 (bugs6 items 25 and 26): the open-items card offers owner-work wording only for owner work, offers
 * the round's own test runs (or a re-run) for dropped round claims, is withdrawn once the items it lists are settled,
 * and the latched clean-review card recommends "Back to Implementation" only when a round can act.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { planRoundTestRunAcceptanceV1 } from "../commands/acceptRoundTestRunsV1";
import { buildOpenPlanItemsNeedDecisionCardInputV1 } from "../commands/decideOpenPlanItemsV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";
import { pickLatestEditingRunFileV1 } from "../utils/openPlanItemClassificationV1";
import {
  countSettledOpenItemsCardItemsV1,
  describeOpenItemsCardAllSettledV1,
  listOpenItemsCardItemTextsV1,
  OPEN_PLAN_ITEMS_DECISION_KEY_V1,
} from "../utils/openItemsCardStalenessV1";
import { latchedOpenItemsRecommendationV1 } from "../utils/reviewEscalation";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { withdrawStaleOpenItemsCardV1 } from "../utils/withdrawStaleOpenItemsCardV1";
import { normalizePath } from "../utils/taskRoot";

const ITEMS = [
  "Write the tests for Part 2",
  "Write the tests for Part 3",
];
const PLAN = ["<!-- ensemble:implementation-checklist -->", "", ...ITEMS.map((item) => `- [ ] ${item}`), ""].join("\n");

function card(opts: { dropped: readonly string[]; items?: readonly string[]; runFile?: string }) {
  const items = opts.items ?? ITEMS;
  return buildOpenPlanItemsNeedDecisionCardInputV1({
    taskFolderPath: "/tasks/t",
    taskCanonicalId: "/tasks/t",
    stage: "impl-high-review",
    items: items.map((itemText) => ({ itemText, reason: "" })),
    droppedClaimKeys: new Set(opts.dropped.map((text) => normalizeChecklistItemTextV1(text))),
    ...(opts.runFile ? { droppedClaimRunFile: opts.runFile } : {}),
    createdAt: "2026-11-09T00:00:00.000Z",
  });
}

void describe("the open-items card for a round's dropped claims (review2 Step 6)", () => {
  void it("offers the round's test runs, naming the run file, or a re-run; never 'tick it because you already did it'", () => {
    const built = card({ dropped: ITEMS, runFile: "runs/161-claude-cli-impl.md" });
    const accept = built.options.find((option) => option.optionId === "acceptRoundTestRuns");
    const rerun = built.options.find((option) => option.optionId === "rerunRoundToRecord");
    assert.equal(accept?.label, "Accept the round's test runs (runs/161-claude-cli-impl.md)");
    assert.equal(rerun?.label, "Re-run the round to record them");
    const decide = built.options.find((option) => option.optionId === "decideItemByItem");
    assert.doesNotMatch(decide?.consequence ?? "", /already did it/);
    assert.match(built.whatHappened, /contradicted itself/);
    assert.doesNotMatch(built.whatHappened, /not reached/i);
    assert.equal(built.recommendation.kind === "option" ? built.recommendation.optionId : undefined, "acceptRoundTestRuns");
    const args = accept?.effect.kind === "command" ? (accept.effect.args?.[0] as { itemTexts: string[]; runFile: string }) : undefined;
    assert.deepEqual(args?.itemTexts, ITEMS);
    assert.equal(args?.runFile, "runs/161-claude-cli-impl.md");
  });

  void it("marks the dropped items so the form words their tick as accepting the round's claim", () => {
    const built = card({ dropped: [ITEMS[0] as string] });
    const decide = built.options.find((option) => option.optionId === "decideItemByItem");
    const formItems = decide?.effect.kind === "command" ? (decide.effect.args?.[0] as { items: { itemText: string; roundClaimDropped?: boolean }[] }).items : [];
    assert.equal(formItems.find((item) => item.itemText === ITEMS[0])?.roundClaimDropped, true);
    assert.equal(formItems.find((item) => item.itemText === ITEMS[1])?.roundClaimDropped, undefined);
  });

  void it("keeps the owner-work wording when some listed items are owner work, and offers no round options without dropped claims", () => {
    const mixed = card({ dropped: [ITEMS[0] as string] });
    assert.match(mixed.options.find((option) => option.optionId === "decideItemByItem")?.consequence ?? "", /already did it/);
    const none = card({ dropped: [] });
    assert.equal(none.options.some((option) => option.optionId === "acceptRoundTestRuns"), false);
    assert.equal(none.options.some((option) => option.optionId === "rerunRoundToRecord"), false);
  });

  void it("names the newest editing run file only", () => {
    assert.equal(
      pickLatestEditingRunFileV1([
        "009-review-v1-impl-high-review.md",
        "007-claude-cli-impl.md",
        "007-claude-cli-impl_prev.md",
        "161-claude-cli-impl.md",
        "020-claude-cli-impl.md",
      ]),
      "runs/161-claude-cli-impl.md"
    );
    assert.equal(pickLatestEditingRunFileV1(["009-review-v1-impl-high-review.md"]), undefined);
  });

  void it("accepting records only the items the report backs with a passing command, and says why for the rest", () => {
    const report = [
      "## Verification",
      "",
      "- `pnpm run test:unit -- src/test/a.test.ts` — 314 tests, 314 passed, 0 failed",
      "",
    ].join("\n");
    const plan = planRoundTestRunAcceptanceV1(PLAN, report, ITEMS);
    assert.equal(plan.accepted.length, 0, "no command names these items' own tests");
    assert.equal(plan.notRecorded.length, 2);
    assert.ok(plan.notRecorded.every((entry) => entry.reason.length > 0));
    const backed = planRoundTestRunAcceptanceV1(
      PLAN,
      [
        "Ran the tests; no source changed.",
        "",
        "## Files Changed",
        "",
        "None.",
        "",
        "## Plan Item Checklist",
        "",
        "- Write the tests for Part 2 — done — src/test/a.test.ts",
        "",
        "## Verification",
        "",
        "- `pnpm run test:unit -- src/test/a.test.ts` — 314 tests, 314 passed, 0 failed",
        "",
      ].join("\n"),
      ITEMS
    );
    assert.deepEqual(backed.accepted.map((entry) => entry.itemText), ["Write the tests for Part 2"]);
    assert.equal(backed.accepted[0]?.report.passed, 314);
    assert.deepEqual(backed.notRecorded.map((entry) => entry.itemText), ["Write the tests for Part 3"]);
  });
});

void describe("the open-items card follows the items it lists (review2 Step 7)", () => {
  void it("reads the listed items from the card's item-by-item option and counts the settled ones", () => {
    const built = card({ dropped: [] });
    const listed = listOpenItemsCardItemTextsV1(built.options);
    assert.deepEqual(listed, ITEMS);
    assert.deepEqual(countSettledOpenItemsCardItemsV1(listed, [ITEMS[1] as string], normalizeChecklistItemTextV1), { listed: 2, settled: 1 });
    assert.deepEqual(countSettledOpenItemsCardItemsV1(listed, [], normalizeChecklistItemTextV1), { listed: 2, settled: 2 });
    assert.equal(describeOpenItemsCardAllSettledV1(9), "the 9 items are now settled; nothing is open on this card");
    assert.equal(describeOpenItemsCardAllSettledV1(1), "the 1 item is now settled; nothing is open on this card");
  });

  let contextActive = false;
  afterEach(() => {
    if (contextActive) {
      __extensionContextV1TestOnly.reset();
      contextActive = false;
    }
  });

  function extensionContext(): vscode.ExtensionContext {
    const backing = new Map<string, unknown>();
    const memento = {
      keys: (): readonly string[] => [...backing.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined => (backing.has(key) ? (backing.get(key) as T) : defaultValue),
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
    };
    return { subscriptions: [], extensionUri: vscode.Uri.file("/tasks"), workspaceState: memento, globalState: memento } as unknown as vscode.ExtensionContext;
  }

  void it("withdraws the pending card once every item it lists is settled, saying so, and leaves it while one is open", async () => {
    const context = extensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const folder = { fsPath: "/tasks/t" };
    const posted = await store.post({ decisionId: "open-items-1", ...card({ dropped: [] }), taskCanonicalId: normalizePath(folder.fsPath) });
    assert.equal(posted.ok, true);
    assert.equal(posted.ok ? posted.decision.decisionKey : "", OPEN_PLAN_ITEMS_DECISION_KEY_V1);

    // Nothing settled: the card stays.
    await withdrawStaleOpenItemsCardV1(folder, PLAN);
    assert.equal(store.get("open-items-1")?.state, "pending");

    // Everything settled: withdrawn with the "now settled" reason.
    const allTicked = PLAN.replace(/- \[ \]/g, "- [x]");
    await withdrawStaleOpenItemsCardV1(folder, allTicked);
    const after = store.get("open-items-1");
    assert.equal(after?.state, "withdrawn");
    assert.equal(after?.withdrawnReason, "the 2 items are now settled; nothing is open on this card");
  });
});

void describe("the latched clean-review card's recommendation (review2 Step 7)", () => {
  const open = (items: string[]) => ({ items, total: items.length });

  void it("does not recommend Back to Implementation when the review says nothing is left to build", () => {
    const rec = latchedOpenItemsRecommendationV1(open(["Add the retry loop to the sync worker"]), true);
    assert.equal(rec.optionId, "moveOn");
    assert.match(rec.reasoning, /nothing to act on/);
  });

  void it("recommends moving on when every open item waits on test evidence or a check", () => {
    const rec = latchedOpenItemsRecommendationV1(open(ITEMS), false);
    assert.equal(rec.optionId, "moveOn");
    assert.match(rec.reasoning, /test evidence/);
    assert.equal(latchedOpenItemsRecommendationV1(open(["Verify the build on the box"]), false).optionId, "moveOn");
  });

  void it("recommends Back to Implementation only when build work is open and the review did not say otherwise", () => {
    const rec = latchedOpenItemsRecommendationV1(open(["Add the retry loop to the sync worker"]), false);
    assert.equal(rec.optionId, "backToImplementation");
  });
});
