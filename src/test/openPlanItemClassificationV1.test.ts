/**
 * bugs4 items 5 and 27: the open-items card says why each item is open, from
 * what the system knows, instead of "no reason given" and "could not build".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOpenPlanItemsNeedDecisionCardInputV1 } from "../commands/decideOpenPlanItemsV1";
import { listProvisionalTestDependentChecklistItemsV1, normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";
import {
  classifyOpenPlanItemV1,
  classifyOpenPlanItemsV1,
  onlyMissingTestEvidenceV1,
} from "../utils/openPlanItemClassificationV1";

const TEST_ITEMS = [
  "Add an inventory guard test that fails when a table has no eraser.",
  "Add a coverage guard test for TABLE_ERASERS.",
  "Add an integration test and register it in INTEGRATION_TEST_FILES.",
];

const base = {
  taskFolderPath: "/tmp/task",
  taskCanonicalId: "/tmp/task",
  stage: "impl-high-review" as const,
  displayName: "main task for erase work",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const claimed = (...texts: string[]): ReadonlySet<string> => new Set(texts.map(normalizeChecklistItemTextV1));

void describe("classifyOpenPlanItemV1", () => {
  void it("a test item the round claimed built, with no report, waits for a passing test report", () => {
    const result = classifyOpenPlanItemV1({
      itemText: TEST_ITEMS[0]!,
      roundReason: "",
      builtClaimedKeys: claimed(TEST_ITEMS[0]!),
    });
    assert.equal(result.category, "awaiting-test-report");
    assert.match(result.reason, /waiting for a passing test report/);
    assert.doesNotMatch(result.reason, /no reason given|could not build/);
  });

  void it("a test item with no built signal is not reached, never 'waiting for a report'", () => {
    const result = classifyOpenPlanItemV1({ itemText: TEST_ITEMS[0]!, roundReason: "" });
    assert.equal(result.category, "not-reached");
    assert.doesNotMatch(result.reason, /waiting for a passing test report|in the tree/);
  });

  void it("an item with a reason from the round is refused-by-round and shows that reason", () => {
    const result = classifyOpenPlanItemV1({ itemText: "Rotate the production key.", roundReason: "needs prod access" });
    assert.equal(result.category, "refused-by-round");
    assert.equal(result.reason, "the round said: needs prod access");
  });

  void it("a review-verified item is labelled as such, with or without a test requirement", () => {
    const keys = new Set([TEST_ITEMS[0]!, "Rename the helper."].map(normalizeChecklistItemTextV1));
    const withTests = classifyOpenPlanItemV1({ itemText: TEST_ITEMS[0]!, roundReason: "", reviewVerifiedKeys: keys });
    assert.equal(withTests.category, "verified-by-review-no-report");
    assert.match(withTests.reason, /verified built by the review; held back only because no passing test report/);
    const plain = classifyOpenPlanItemV1({ itemText: "Rename the helper.", roundReason: "", reviewVerifiedKeys: keys });
    assert.equal(plain.category, "verified-by-review-no-report");
    assert.match(plain.reason, /not yet ticked/);
  });

  void it("an item with no test requirement and no reason is not reached", () => {
    const result = classifyOpenPlanItemV1({ itemText: "Rename the helper.", roundReason: "" });
    assert.equal(result.category, "not-reached");
  });
});

void describe("open-items card for items waiting only for test evidence (item 5 replay)", () => {
  const card = buildOpenPlanItemsNeedDecisionCardInputV1({
    ...base,
    items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
    builtClaimedKeys: claimed(...TEST_ITEMS),
  });

  void it("unbuilt test items (no built signal) do not recommend a test-running round or claim the work exists", () => {
    const unbuilt = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
    });
    assert.ok(!unbuilt.options.some((o) => o.optionId === "runTestingRound"));
    assert.equal(unbuilt.recommendation.kind === "option" ? unbuilt.recommendation.optionId : undefined, "decideItemByItem");
    assert.doesNotMatch(unbuilt.whatHappened, /waiting for a passing test report/);
    assert.doesNotMatch(JSON.stringify(unbuilt), /work is in the tree/);
  });

  void it("names 'waiting for a passing test report' for each item and neither forbidden phrase", () => {
    for (const text of TEST_ITEMS) {
      assert.match(card.whatHappened, new RegExp(`${text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*waiting for a passing test report`));
    }
    assert.doesNotMatch(card.whatHappened, /no reason given/);
    assert.doesNotMatch(card.whatHappened, /could not build/);
    assert.doesNotMatch(card.whyUserNeeded, /could not build/);
  });

  void it("recommends a round that runs the tests, and keeps Decide item by item as an option", () => {
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "runTestingRound");
    const ids = card.options.map((o) => o.optionId);
    assert.ok(ids.includes("decideItemByItem"));
    assert.ok(ids.includes("leaveOpen"));
    const run = card.options.find((o) => o.optionId === "runTestingRound");
    assert.equal(run?.effect.kind === "command" ? run.effect.command : undefined, "vs-code-ai-helper.runImplementationWithAI");
    assert.doesNotMatch(card.recommendation.kind === "option" ? card.recommendation.reasoning : "", /only way/);
  });
});

void describe("open-items card: refused tests and Tick all (bugs4 Step 20)", () => {
  void it("when the last round's test commands were refused, it says so, points at the setup and does not recommend another round", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
      builtClaimedKeys: claimed(...TEST_ITEMS),
      testsRefused: { commands: ["node --require ./test-stubs/register.js --test out/test/a.test.js"] },
      allowedTestCommand: { template: "pnpm run test:unit -- <test files>", allowedByProjectRules: true },
    });
    const text = `${card.whyUserNeeded} ${card.recommendation.kind === "option" ? card.recommendation.reasoning : ""}`;
    assert.match(text, /provider refused the test command/);
    assert.match(text, /not a test failure/);
    assert.match(text, /allow rule/);
    assert.match(text, /pnpm run test:unit/);
    // None of these items names a run command, so the owner-run card (which never invents one) is
    // not offered; the recommendation falls to settling them by hand, and never to another round.
    assert.equal(card.options.some((o) => o.optionId === "ownerRanTests"), false);
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "decideItemByItem");
    assert.doesNotMatch(card.whatHappened, /no reason given|could not build/);

    const named = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: [{ itemText: "Run `pnpm run test:unit -- src/test/a.test.ts` and record it.", reason: "" }],
      builtClaimedKeys: claimed("Run `pnpm run test:unit -- src/test/a.test.ts` and record it."),
      testsRefused: { commands: ["pnpm run test:unit -- src/test/a.test.ts"] },
    });
    assert.equal(named.recommendation.kind === "option" ? named.recommendation.optionId : undefined, "ownerRanTests");
  });

  void it("without a refusal the recommendation is still a round that runs the tests", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
      builtClaimedKeys: claimed(...TEST_ITEMS),
    });
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "runTestingRound");
  });

  void it("offers and recommends 'Tick all N' when the latest review verified every listed item", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
      reviewVerifiedKeys: claimed(...TEST_ITEMS),
    });
    const tickAll = card.options.find((option) => option.optionId === "tickAllVerified");
    assert.ok(tickAll, "Tick all is offered");
    assert.equal(tickAll.label, "Tick all 3: the review verified them built");
    assert.match(tickAll.consequence, /settled by your decision; no test report recorded/);
    assert.match(tickAll.consequence, /not as test-verified/);
    assert.equal(tickAll.effect.kind === "command" ? tickAll.effect.command : undefined, "vs-code-ai-helper.tickAllVerifiedOpenPlanItems");
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "tickAllVerified");
    assert.ok(card.options.some((option) => option.optionId === "decideItemByItem"), "Decide item by item stays available");
  });

  void it("does not offer Tick all unless the review verified every listed item", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: TEST_ITEMS.map((itemText) => ({ itemText, reason: "" })),
      reviewVerifiedKeys: claimed(TEST_ITEMS[0]!),
    });
    assert.ok(!card.options.some((option) => option.optionId === "tickAllVerified"));
  });
});

void describe("open-items card with mixed categories", () => {
  const items = [
    { itemText: "Rotate the production key.", reason: "needs prod access" },
    TEST_ITEMS[0]!,
    "Rename the helper.",
  ].map((entry) => (typeof entry === "string" ? { itemText: entry, reason: "" } : entry));

  void it("groups the categories, keeps the round's own reason and 'could not build' only for refused items", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items,
      builtClaimedKeys: claimed(TEST_ITEMS[0]!),
      openSummary: "3 open, of which 0 are owner hand-offs",
    });
    assert.match(card.whatHappened, /plan-wide: 3 open, of which 0 are owner hand-offs/);
    assert.match(card.whatHappened, /The round could not build these \(1\):\*\*\n- Rotate the production key\. — the round said: needs prod access/);
    assert.match(card.whatHappened, /Not reached by the round \(1\):\*\*\n- Rename the helper\./);
    assert.match(card.whatHappened, /Waiting for a passing test report \(1\):\*\*/);
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "decideItemByItem");
    assert.ok(!card.options.some((o) => o.optionId === "runTestingRound"));
  });

  void it("onlyMissingTestEvidenceV1 is false for a mixed list and for an empty one", () => {
    assert.equal(onlyMissingTestEvidenceV1(classifyOpenPlanItemsV1(items, undefined, claimed(TEST_ITEMS[0]!))), false);
    assert.equal(onlyMissingTestEvidenceV1([]), false);
  });

  void it("adding a passing report ticks the waiting items: nothing waits, so no open-items card is raised (item 5, 34)", () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", ...TEST_ITEMS.map((text) => `- [x] ${text}`)].join("\n");
    // No report: every test item waits, which is what raises the card.
    assert.deepEqual(listProvisionalTestDependentChecklistItemsV1(plan, undefined), TEST_ITEMS);
    const summary = [
      "## Files Changed",
      "- src/test/inventoryGuard.test.ts",
      "## Plan Item Checklist",
      ...TEST_ITEMS.map((text) => `- ${text} — done — test: inventoryGuard.test.ts`),
      "## Verification",
      "- `pnpm run test:unit -- src/test/inventoryGuard.test.ts` — 17 passed, 0 failed, on the final source.",
    ].join("\n");
    assert.deepEqual(listProvisionalTestDependentChecklistItemsV1(plan, summary), []);
  });
});
