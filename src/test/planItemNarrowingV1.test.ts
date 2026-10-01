import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChecklistChangeProposalV1 } from "../types/taskProgress";
import { findNarrowingBlockerV1 } from "../utils/planItemNarrowingV1";

const TWO_FILE_ITEM =
  "Update `taskProgressFieldPolicyV1.test.ts` and `stageMutatorSourceScanV1.test.ts` for the new Clear policy";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  `- [x] ${TWO_FILE_ITEM}`,
  "- [ ] Add `other.ts` handling",
  "- [x] Touch `shared.ts` once",
  "- [ ] Touch `shared.ts` twice",
  "",
].join("\n");

function proposal(overrides: Partial<ChecklistChangeProposalV1> = {}): ChecklistChangeProposalV1 {
  return {
    at: "2026-09-30T10:00:00Z",
    roundId: "r1",
    stage: "impl-high-review",
    kind: "removed",
    proposedItems: ["Update `taskProgressFieldPolicyV1.test.ts` only: the scan test never references the feature"],
    removedItems: [TWO_FILE_ITEM],
    status: "discarded",
    ...overrides,
  } as ChecklistChangeProposalV1;
}

const SUMMARY = [
  "Intro paragraph with nothing relevant.",
  "`stageMutatorSourceScanV1.test.ts` never mentions Clear (checked with one search), so nothing to update.",
].join("\n\n");

const PREFIX_BLOCKER = {
  description: `Narrowing needs an owner decision: \`${TWO_FILE_ITEM}\` — second file not updated`,
};
const RC3_BLOCKER = {
  description:
    "Item ticked though `stageMutatorSourceScanV1.test.ts` was not updated and no owner decision approves narrowing it",
};

void describe("findNarrowingBlockerV1", () => {
  void it("resolves the prefix form to the plan item verbatim", () => {
    const found = findNarrowingBlockerV1([PREFIX_BLOCKER], PLAN, undefined, undefined);
    assert.ok(found);
    assert.strictEqual(found.itemText, TWO_FILE_ITEM);
    assert.strictEqual(found.blocker, PREFIX_BLOCKER.description);
  });

  void it("resolves the full item when another item shares its first backticked opening span", () => {
    const plan = `${PLAN}- [ ] Update \`other.test.ts\` for the policy\n`;
    const found = findNarrowingBlockerV1([PREFIX_BLOCKER], plan, undefined, undefined);
    assert.ok(found);
    assert.strictEqual(found.itemText, TWO_FILE_ITEM);
  });

  void it("resolves the RC3 fallback wording with the proposal as reason and the summary as evidence", () => {
    const found = findNarrowingBlockerV1([RC3_BLOCKER], PLAN, [proposal()], SUMMARY);
    assert.ok(found);
    assert.strictEqual(found.itemText, TWO_FILE_ITEM);
    assert.strictEqual(found.reasonSource, "the round's refused checklist rewording");
    assert.match(found.reason, /scan test never references/);
    assert.strictEqual(found.evidenceSource, "impl-summary.md");
    assert.match(found.evidence, /never mentions Clear/);
  });

  void it("a proposal without a summary yields the reason and the no-evidence text", () => {
    const found = findNarrowingBlockerV1([RC3_BLOCKER], PLAN, [proposal()], undefined);
    assert.ok(found);
    assert.strictEqual(found.evidenceSource, "none");
    assert.match(found.evidence, /No evidence on file/);
  });

  void it("a summary without a proposal is both reason and evidence with distinct wording of source", () => {
    const found = findNarrowingBlockerV1([RC3_BLOCKER], PLAN, [], SUMMARY);
    assert.ok(found);
    assert.strictEqual(found.reasonSource, "impl-summary.md");
    assert.strictEqual(found.evidenceSource, "impl-summary.md");
    assert.match(found.reason, /never mentions Clear/);
  });

  void it("neither a proposal nor a summary yields the fixed texts", () => {
    const found = findNarrowingBlockerV1([RC3_BLOCKER], PLAN, undefined, undefined);
    assert.ok(found);
    assert.strictEqual(found.reason, "The round left no reason on file.");
    assert.strictEqual(found.reasonSource, "none");
    assert.strictEqual(found.evidenceSource, "none");
  });

  void it("reports whether the item is ticked", () => {
    assert.strictEqual(findNarrowingBlockerV1([PREFIX_BLOCKER], PLAN, undefined, undefined)?.itemTicked, true);
    const open = findNarrowingBlockerV1(
      [{ description: "Narrowing needs an owner decision: `Add `other.ts` handling` — x" }],
      PLAN,
      undefined,
      undefined,
    );
    // Nested backticks end the first span early, so the prefix match is by item start.
    assert.strictEqual(open?.itemTicked, false);
  });

  void it("returns undefined when a fallback token matches two items", () => {
    assert.strictEqual(
      findNarrowingBlockerV1(
        [{ description: "Ticked though `shared.ts` was not updated; no owner decision approves narrowing" }],
        PLAN,
        undefined,
        undefined,
      ),
      undefined,
    );
  });

  void it("returns undefined for a fallback blocker with no backticked token", () => {
    assert.strictEqual(
      findNarrowingBlockerV1([{ description: "no owner decision approves narrowing this item" }], PLAN, undefined, undefined),
      undefined,
    );
  });

  void it("returns undefined when the prefix names an item that is not in the plan", () => {
    assert.strictEqual(
      findNarrowingBlockerV1(
        [{ description: "Narrowing needs an owner decision: `Not a plan item` — x" }],
        PLAN,
        undefined,
        undefined,
      ),
      undefined,
    );
  });
});
