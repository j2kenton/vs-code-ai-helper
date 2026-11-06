/**
 * bugs4 Step 17 / item 21: the reviewer is told WHICH ticked items are still provisional (oldest
 * first, within a size limit) so it can name the ones it confirmed under `## Verified Complete`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatProvisionalTickedItemsForReviewerV1,
  getPlanRevisionV1,
  listProvisionalTickedItemsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { describeWithheldTestItemsV1 } from "../commands/applyReviewerVerifiedTicks";

const PLAN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Wire the completeness gate",
  "- [x] Parse links in gitIndexLockV1.test.ts reports",
  "- [x] Add a test for the Publish stale-verdict guard",
  "- [x] Already verified by a reviewer",
  "- [x] Settled by the owner through the form",
  "- [ ] Not ticked yet",
  "- [ ] Hand-off owned by the owner <!-- ensemble:excluded -->",
  "",
].join("\n");

const REVISION = getPlanRevisionV1(PLAN);
const key = normalizeChecklistItemTextV1;

const EVIDENCE = [
  {
    planRevision: REVISION,
    itemKey: key("Add a test for the Publish stale-verdict guard"),
    claims: [{ at: "2026-10-30T10:00:00.000Z" }],
  },
  {
    planRevision: REVISION,
    itemKey: key("Wire the completeness gate"),
    claims: [{ at: "2026-10-31T10:00:00.000Z" }],
  },
  {
    planRevision: REVISION,
    itemKey: key("Already verified by a reviewer"),
    claims: [{ at: "2026-10-29T10:00:00.000Z" }],
    verifications: [{}],
  },
];

const OWNER = [
  {
    planRevision: REVISION,
    itemKey: key("Settled by the owner through the form"),
    decision: "tick",
  },
];

void describe("listProvisionalTickedItemsV1", () => {
  void it("lists only ticked items with neither a reviewer verification nor an owner decision, oldest first", () => {
    const items = listProvisionalTickedItemsV1(PLAN, EVIDENCE, OWNER);
    assert.deepEqual(
      items.map((item) => item.text),
      [
        // no recorded claim time: ticked before evidence tracking, so oldest
        "Parse links in gitIndexLockV1.test.ts reports",
        "Add a test for the Publish stale-verdict guard",
        "Wire the completeness gate",
      ]
    );
  });

  void it("classifies test dependence by requirement, not by a test filename", () => {
    const byText = new Map(listProvisionalTickedItemsV1(PLAN, EVIDENCE, OWNER).map((i) => [i.text, i.testDependent]));
    assert.equal(byText.get("Parse links in gitIndexLockV1.test.ts reports"), false);
    assert.equal(byText.get("Add a test for the Publish stale-verdict guard"), true);
    assert.equal(byText.get("Wire the completeness gate"), false);
  });
});

void describe("formatProvisionalTickedItemsForReviewerV1", () => {
  void it("asks the reviewer to name confirmed items by their id and flags the ones needing a test report", () => {
    const text = formatProvisionalTickedItemsForReviewerV1(PLAN, EVIDENCE, OWNER);
    assert.match(text, /3 ticked items are still provisional/);
    assert.match(text, /## Verified Complete/);
    assert.match(text, /\[item:<id>\]/);
    assert.match(text, /- \[item:[0-9a-f]{16}\] Add a test for the Publish stale-verdict guard \[needs a passing test report\]/);
    assert.match(text, /- \[item:[0-9a-f]{16}\] Wire the completeness gate$/m);
    assert.doesNotMatch(text, /Already verified by a reviewer/);
    assert.doesNotMatch(text, /Settled by the owner/);
    assert.match(text, /pnpm run test:unit -- /, "it names the command that would satisfy the test-evidence rule");
  });

  void it("covers the oldest first and says how many more come up later when over the limit", () => {
    const text = formatProvisionalTickedItemsForReviewerV1(PLAN, EVIDENCE, OWNER, { maxItems: 1, maxChars: 8000 });
    assert.match(text, /Parse links in gitIndexLockV1\.test\.ts reports/);
    assert.doesNotMatch(text, /Wire the completeness gate/);
    assert.match(text, /1 shown, 2 more come up in later reviews/);
  });

  void it("says so plainly when nothing is provisional, and reports unknown without a plan", () => {
    const allVerified = EVIDENCE.concat(
      ["Parse links in gitIndexLockV1.test.ts reports"].map((t) => ({
        planRevision: REVISION,
        itemKey: key(t),
        claims: [{ at: "2026-10-28T10:00:00.000Z" }],
        verifications: [{}],
      }))
    ).map((entry) => ({ ...entry, verifications: [{}] }));
    assert.match(formatProvisionalTickedItemsForReviewerV1(PLAN, allVerified, OWNER), /^None:/);
    assert.equal(formatProvisionalTickedItemsForReviewerV1(undefined, [], []), "unknown");
  });
});

void describe("describeWithheldTestItemsV1 (bugs4 item 32)", () => {
  void it("renders a readable bulleted list, not one joined paragraph, and caps a long list", () => {
    const items = Array.from({ length: 30 }, (_, i) => `Item number ${i + 1}`);
    const text = describeWithheldTestItemsV1(items);
    assert.match(text, /30 test-dependent items wait for a passing test report/);
    assert.equal((text.match(/\n {2}- Item number/g) ?? []).length, 12);
    assert.match(text, /…and 18 more/);
    assert.ok(text.length < 1500, "the message stays readable");
    assert.doesNotMatch(text, /; Item number/, "items are not joined with '; '");
  });
});
