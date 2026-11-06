/**
 * review1 Step 21: the report contract is hard to break, and a break is recorded by kind and carried into the next
 * round's prompt in one sentence with the fix.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import type { ReportContractRejectionV1 } from "../types/taskProgress";
import { describeImplementationSummaryShapeIssue } from "../utils/implementationArtifactResolver";
import { mergeChecklistProgressV1, NO_CHECKLIST_CHANGE_MARKER_V1 } from "../utils/implementationChecklist";
import {
  appendReportContractRejectionV1,
  classifyReportContractRejectionKindV1,
  countReportContractRejectionsOfKindV1,
  describeReportContractFixV1,
  formatReportContractReminderV1,
  MAX_REPORT_CONTRACT_REJECTIONS_V1,
} from "../utils/reportContractRejectionsV1";

const PLAN = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Step 3: Build the thing", ""].join("\n");

void describe("a marker plus claims is accepted: the claims win (Step 21)", () => {
  const summary = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "",
    "## Files Changed",
    "",
    "- src/a.ts — built it",
    "",
    "## Plan Item Checklist",
    "",
    "- Step 3: Build the thing — done <!-- ensemble:retroactive --> — src/a.ts:12",
    "",
    "## Verification",
    "",
    "- `pnpm run check-types` — passed",
  ].join("\n");

  void it("the shape gate does not reject the round, and the claim is applied", () => {
    assert.equal(describeImplementationSummaryShapeIssue(summary, { planChecklist: PLAN, roundChangedFiles: true }), undefined);
    const merged = mergeChecklistProgressV1(PLAN, summary);
    assert.equal(merged.kind, "merged");
    if (merged.kind === "merged") assert.match(merged.content, /- \[x\] Step 3: Build the thing/);
  });
});

void describe("rejections are recorded by kind (Step 21)", () => {
  void it("classifies the gate's own reasons", () => {
    assert.equal(classifyReportContractRejectionKindV1("the provider returned no final summary text"), "no-summary");
    assert.equal(
      classifyReportContractRejectionKindV1("the final response has a `## Files Changed` section, but its entries are checkboxes, so it cannot be told apart"),
      "checkbox-files-changed"
    );
    assert.equal(
      classifyReportContractRejectionKindV1("the final response is missing `## Files Changed` and `## Verification`"),
      "missing-files-changed"
    );
    assert.equal(classifyReportContractRejectionKindV1("the final response is missing `## Verification`"), "missing-verification");
    assert.equal(
      classifyReportContractRejectionKindV1("the final response is missing any content under `## Verification`"),
      "empty-verification"
    );
    assert.equal(classifyReportContractRejectionKindV1("something nobody has seen before"), "other");
  });

  void it("appends, counts by kind, and keeps the list bounded", () => {
    let list: ReportContractRejectionV1[] = [];
    for (let i = 0; i < MAX_REPORT_CONTRACT_REJECTIONS_V1 + 5; i++) {
      list = appendReportContractRejectionV1(list, { at: `2026-11-03T00:00:${String(i % 60).padStart(2, "0")}.000Z`, reason: "the final response is missing `## Verification`" });
    }
    assert.equal(list.length, MAX_REPORT_CONTRACT_REJECTIONS_V1);
    assert.equal(countReportContractRejectionsOfKindV1(list, "missing-verification"), MAX_REPORT_CONTRACT_REJECTIONS_V1);
    assert.equal(countReportContractRejectionsOfKindV1(list, "no-summary"), 0);
  });

  void it("round-trips through the task-progress decoder", () => {
    const rejections = appendReportContractRejectionV1(undefined, { at: "2026-11-03T00:00:00.000Z", reason: "the final response is missing `## Verification`", roundId: "r1", stage: "impl-high-review" });
    const decoded = decodeTaskProgressTextV1(
      JSON.stringify({
        taskFolder: "t",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        reportContractRejections: rejections,
      })
    );
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(decoded.decoded.progress.reportContractRejections, rejections);
    const bad = decodeTaskProgressTextV1(
      JSON.stringify({
        taskFolder: "t",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        reportContractRejections: [{ at: "x", kind: "not-a-kind", reason: "r" }],
      })
    );
    assert.equal(bad.ok, false);
  });
});

void describe("the next round's prompt carries the last rejection and its fix (Step 21)", () => {
  void it("is one short paragraph naming the reason, the fix and how often it has happened", () => {
    let list: ReportContractRejectionV1[] = [];
    for (let i = 0; i < 3; i++) {
      list = appendReportContractRejectionV1(list, { at: `2026-11-03T00:00:0${i}.000Z`, reason: "the final response is missing `## Verification`" });
    }
    const reminder = formatReportContractReminderV1(list);
    assert.match(reminder, /^\n\n## Your last report was rejected\n\n/);
    assert.ok(reminder.includes("the final response is missing `## Verification`"));
    assert.ok(reminder.includes(describeReportContractFixV1("missing-verification")));
    assert.match(reminder, /This has happened 3 times in this task\./);
    assert.equal(formatReportContractReminderV1(undefined), "");
    assert.equal(formatReportContractReminderV1([]), "");
  });
});
