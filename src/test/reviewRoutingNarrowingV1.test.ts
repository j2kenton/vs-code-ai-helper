import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideReviewRoute } from "../utils/reviewRouting";
import { ReviewBlocker } from "../utils/reviewReadiness";

function blocker(overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return { category: "completion", resolver: "task-fixable", description: "x", ...overrides };
}

void describe("decideReviewRoute: plan-item narrowing blockers (RC4 item 3)", () => {
  const narrowing = blocker({
    resolver: "environmental",
    description: "Narrowing needs an owner decision: `Update the scan test` — second file not updated",
  });
  const base = { score: 7, threshold: 9, plateaued: false, secondOpinionTriedThisPlateau: false };

  void it("escalates on the first review when the narrowing is the only blocker", () => {
    assert.strictEqual(decideReviewRoute({ ...base, blockers: [narrowing] }).route, "escalate");
  });

  void it("iterates while a task-fixable blocker is still on record", () => {
    assert.strictEqual(decideReviewRoute({ ...base, blockers: [narrowing, blocker()] }).route, "iterate");
  });
});
