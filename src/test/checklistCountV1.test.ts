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
  countChecklistProgressV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  formatChecklistProgressForReviewerV1,
  formatImplementationProgressLabelV1,
  isExcludedChecklistItemText,
} from "../utils/implementationChecklist";

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
