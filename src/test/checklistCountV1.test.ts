/**
 * RC1 item 7: one checklist count everywhere.
 *  - A line that only MENTIONS the exclusion marker is never counted as excluded.
 *  - Ensemble computes settled/total for the reviewer.
 *  - The Implementation row always shows a percentage, including when unverified.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  carryClosedBeforeImplementationMarkersV1,
  CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1,
  countChecklistProgressV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  formatChecklistProgressForReviewerV1,
  formatImplementationProgressLabelV1,
  implementationDisplayCountsV1,
  isClosedBeforeImplementationChecklistItemTextV1,
  isExcludedChecklistItemText,
  markClosedBeforeImplementationV1,
} from "../utils/implementationChecklist";
import { readyToAdvanceStage, reconcileProgressWithChecklistV1 } from "../utils/reviewReadiness";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;

function plan(lines: readonly string[]): string {
  return ["<!-- ensemble:implementation-checklist -->", "", ...lines, ""].join("\n");
}

void describe("exclusion marker counting", () => {
  void it("counts a trailing marker after item text as excluded", () => {
    assert.equal(isExcludedChecklistItemText(`Deploy to production ${M}`), true);
    assert.equal(isExcludedChecklistItemText(`Deploy to production, not applicable ${M}  `), true);
  });

  void it("does not count an item that merely mentions the marker", () => {
    assert.equal(isExcludedChecklistItemText(`Add the marker \`${M}\` to other items`), false);
    assert.equal(isExcludedChecklistItemText(`Document the marker ${M} in the guide`), false);
    assert.equal(isExcludedChecklistItemText(`Write about the literal \`${M}\``), false);
  });

  void it("does not count a marker glued to text or standing alone", () => {
    assert.equal(isExcludedChecklistItemText(`the literal${M}`), false);
    assert.equal(isExcludedChecklistItemText(M), false);
  });

  void it("the count keeps a mention-only item open and an appended marker settled", () => {
    const counted = countChecklistProgressV1(
      plan([
        `- [ ] Add the marker \`${M}\` to descoped items`,
        `- [ ] Deploy to production ${M}`,
        "- [x] Build it",
        `- [ ] Describe the literal ${M} in the docs`,
      ])
    );
    assert.ok(counted);
    assert.equal(counted.total, 4);
    assert.equal(counted.closedWithoutDoing, 1, "only the genuinely appended marker");
    assert.equal(counted.settled, 2);
    assert.equal(counted.remaining, 2);
  });
});

void describe("the count handed to the reviewer", () => {
  void it("is Ensemble's settled/total over the fixed denominator", () => {
    const text = plan([`- [x] One`, `- [ ] Two ${M}`, `- [ ] Three`, `- [x] Four`]);
    assert.equal(formatChecklistProgressForReviewerV1(text), "3/4");
  });

  void it("reads unknown when there is no readable checklist", () => {
    assert.equal(formatChecklistProgressForReviewerV1(undefined), "unknown");
    assert.equal(formatChecklistProgressForReviewerV1("no checklist here"), "unknown");
  });

  void it("both impl-high review prompts state the figure to report", () => {
    for (const name of ["review-impl-high.md", "review-impl-high-rereview.md"]) {
      const body = fs.readFileSync(path.join(process.cwd(), "resources", "prompts", name), "utf8");
      assert.match(body, /\{\{checklistProgress\}\}/, name);
      assert.match(body, /report exactly it/, name);
    }
  });
});

void describe("the Implementation row label", () => {
  void it("is a percentage", () => {
    assert.equal(formatImplementationProgressLabelV1(84, 243, false), "34%");
    assert.equal(formatImplementationProgressLabelV1(243, 243, false), "100%");
  });

  void it("stays a percentage, with its qualifier, when the count is unverified", () => {
    const label = formatImplementationProgressLabelV1(84, 243, true);
    assert.equal(label, "34% · unverified");
    assert.ok(!label.includes("/"), "never a fraction");
  });

  void it("never reads as finished until every item is settled", () => {
    assert.equal(formatImplementationProgressLabelV1(242, 243, true), "99% · unverified");
  });
});

// RC8 item 6: closed-before-implementation marker — display only.
void describe("closed-before-implementation marker", () => {
  const CBI = CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1;
  const lines = (marked: boolean): string[] => [
    "- [x] Build it",
    "- [ ] Wire it",
    "- [ ] Test it",
    `- [ ] Owner checks dark theme ${marked ? `${CBI} ` : ""}${M}`,
    `- [ ] Owner checks light theme ${marked ? `${CBI} ` : ""}${M}`,
  ];

  void it("is recognised only directly before the trailing excluded marker", () => {
    assert.equal(isClosedBeforeImplementationChecklistItemTextV1(`Owner check ${CBI} ${M}`), true);
    assert.equal(isClosedBeforeImplementationChecklistItemTextV1(`Owner check ${M}`), false);
    assert.equal(isClosedBeforeImplementationChecklistItemTextV1(`Owner check ${CBI}`), false);
    assert.equal(isClosedBeforeImplementationChecklistItemTextV1(`Owner check${CBI} ${M}`), false);
    assert.equal(isExcludedChecklistItemText(`Owner check ${CBI} ${M}`), true);
  });

  void it("counts differ only in the display field: total, settled, closedWithoutDoing, remaining are equal", () => {
    const marked = countChecklistProgressV1(plan(lines(true)))!;
    const plain = countChecklistProgressV1(plan(lines(false)))!;
    assert.equal(marked.closedBeforeImplementation, 2);
    assert.equal(plain.closedBeforeImplementation, undefined);
    for (const key of ["total", "settled", "checked", "closedWithoutDoing", "remaining", "excluded"] as const) {
      assert.equal(marked[key], plain[key], key);
    }
    assert.deepEqual(implementationDisplayCountsV1(marked), { complete: 1, total: 3, closedBeforeImplementation: 2 });
    assert.deepEqual(implementationDisplayCountsV1(plain), { complete: 3, total: 5, closedBeforeImplementation: 0 });
  });

  void it("the completeness gate gives the same result with and without the marker", () => {
    const marked = countChecklistProgressV1(plan(lines(true)))!;
    const plain = countChecklistProgressV1(plan(lines(false)))!;
    for (const review of [null, { complete: 29, total: 90 }]) {
      assert.deepEqual(reconcileProgressWithChecklistV1(review, marked), reconcileProgressWithChecklistV1(review, plain));
    }
    assert.equal(
      readyToAdvanceStage(9, 8, reconcileProgressWithChecklistV1(null, marked)),
      readyToAdvanceStage(9, 8, reconcileProgressWithChecklistV1(null, plain))
    );
  });

  void it("when every item was closed before Implementation the row reads 0 of 0", () => {
    const allClosed = countChecklistProgressV1(
      plan([`- [ ] A ${CBI} ${M}`, `- [ ] B ${CBI} ${M}`])
    )!;
    assert.deepEqual(implementationDisplayCountsV1(allClosed), { complete: 0, total: 0, closedBeforeImplementation: 2 });
  });

  void it("mark inserts the marker before the excluded marker, byte-preserving everything else", () => {
    const original = plan(lines(false)).replace(/\n/g, "\r\n");
    const marked = markClosedBeforeImplementationV1(original);
    assert.equal(marked, plan(lines(true)).replace(/\n/g, "\r\n"));
    assert.equal(markClosedBeforeImplementationV1(marked), marked, "idempotent");
    assert.equal(markClosedBeforeImplementationV1(plan(["- [ ] Open", "- [x] Done"])), plan(["- [ ] Open", "- [x] Done"]));
  });

  void it("mark leaves nested items and fenced examples alone", () => {
    const content = plan([
      "- [ ] Parent",
      `  - [ ] Nested closed ${M}`,
      "```",
      `- [ ] Fenced example ${M}`,
      "```",
    ]);
    assert.equal(markClosedBeforeImplementationV1(content), content);
  });

  void it("carry marks only items that carried the marker in the prior content", () => {
    const prior = plan([`- [ ] Old closed ${CBI} ${M}`, "- [ ] Later excluded", "- [ ] Open"]);
    const revised = plan([`- [ ] Old closed ${M}`, `- [ ] Later excluded ${M}`, "- [ ] Open", `- [ ] Brand new ${M}`]);
    const carried = carryClosedBeforeImplementationMarkersV1(revised, prior);
    assert.equal(
      carried,
      plan([`- [ ] Old closed ${CBI} ${M}`, `- [ ] Later excluded ${M}`, "- [ ] Open", `- [ ] Brand new ${M}`])
    );
    assert.equal(carryClosedBeforeImplementationMarkersV1(revised, plan(["- [ ] Old closed", "- [ ] Open"])), revised);
  });
});
