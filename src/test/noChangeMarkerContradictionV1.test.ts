/**
 * review2 Step 11 (bugs6 item 25, `runs/161`): a report that declares no checklist change and also claims items
 * done is a contradiction, named as one. Its still-open claimed items never read as "not reached".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeNoChangeMarkerContradictionV1,
  listDroppedDoneClaimsUnderNoChangeMarkerV1,
} from "../utils/implementationChecklist";
import { classifyOpenPlanItemsV1, formatClassifiedOpenPlanItemsV1 } from "../utils/openPlanItemClassificationV1";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] Write the tests for Part 2",
  "- [ ] Write the tests for Part 3",
  "- [x] Build the thing",
  "",
].join("\n");

function report(opts: { marker: boolean; claims: readonly string[] }): string {
  return [
    "Ran the focused tests; no source changed.",
    "",
    "## Files Changed",
    "",
    "None.",
    "",
    ...(opts.marker ? ["<!-- ensemble:no-checklist-change -->", ""] : []),
    "## Plan Item Checklist",
    "",
    ...opts.claims.map((item) => `- ${item} — done — pnpm run test:unit -- src/test/a.test.ts (3 passed, 0 failed)`),
    "",
    "## Verification",
    "",
    "- `pnpm run test:unit -- src/test/a.test.ts` — 3 passed, 0 failed",
    "",
  ].join("\n");
}

void describe("a no-change marker that contradicts done claims (review2 Step 11)", () => {
  void it("lists the claimed items that are still open as dropped claims", () => {
    const dropped = listDroppedDoneClaimsUnderNoChangeMarkerV1(
      report({ marker: true, claims: ["Write the tests for Part 2", "Write the tests for Part 3"] }),
      PLAN,
      PLAN
    );
    assert.deepEqual(dropped.itemTexts, ["Write the tests for Part 2", "Write the tests for Part 3"]);
    assert.match(
      describeNoChangeMarkerContradictionV1(dropped),
      /contradicted itself: it declared no checklist change, but it also claimed 2 items done\. Those claims were not used/
    );
  });

  void it("lists nothing when the report does not declare the marker", () => {
    const dropped = listDroppedDoneClaimsUnderNoChangeMarkerV1(
      report({ marker: false, claims: ["Write the tests for Part 2"] }),
      PLAN,
      PLAN
    );
    assert.deepEqual(dropped.itemTexts, []);
  });

  void it("a claim the merge did use (its item is ticked afterwards) is not dropped", () => {
    const after = PLAN.replace("- [ ] Write the tests for Part 2", "- [x] Write the tests for Part 2");
    const dropped = listDroppedDoneClaimsUnderNoChangeMarkerV1(
      report({ marker: true, claims: ["Write the tests for Part 2", "Write the tests for Part 3"] }),
      PLAN,
      after
    );
    assert.deepEqual(dropped.itemTexts, ["Write the tests for Part 3"]);
  });

  void it("the open-items card names the contradiction, never 'not reached'", () => {
    const dropped = listDroppedDoneClaimsUnderNoChangeMarkerV1(
      report({ marker: true, claims: ["Write the tests for Part 2"] }),
      PLAN,
      PLAN
    );
    const classified = classifyOpenPlanItemsV1(
      [
        { itemText: "Write the tests for Part 2", reason: "" },
        { itemText: "Write the tests for Part 3", reason: "" },
      ],
      new Set(),
      new Set(),
      new Set(dropped.itemTexts.map((text) => text.toLowerCase()))
    );
    assert.deepEqual(
      classified.map((item) => item.category),
      ["claim-dropped", "not-reached"]
    );
    const text = formatClassifiedOpenPlanItemsV1(classified);
    assert.match(text, /The round's report contradicted itself \(1\):\*\*\n- Write the tests for Part 2 — the round claimed it done/);
    assert.doesNotMatch(
      text.split("\n\n")[0]!,
      /not reached/,
      "the claimed item is not described as not reached"
    );
  });
});
