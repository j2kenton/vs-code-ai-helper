/**
 * bugs4 item 23 / Step 22: a round recorded incomplete because of its report format, with the provider
 * having run normally, is never described as "the previous attempt ... failed" and never recommends a
 * model change. A genuine provider failure still does.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOwedContinuationDecisionV1 } from "../commands/scheduleTaskResume";

const target = { canonicalId: "task-id", taskFolderPath: "/tmp/owed", stage: "impl" as const, taskName: "Owed" };

function build(trigger: string | undefined) {
  return buildOwedContinuationDecisionV1(target, undefined, "an earlier attempt has not started a round", undefined, {
    failedProvider: "Claude Code",
    failedModel: "claude-cli:claude-sonnet-5-5@high",
    ...(trigger ? { trigger } : {}),
  });
}

function recommendedOptionId(decision: ReturnType<typeof build>): string | undefined {
  return decision.recommendation?.kind === "option" ? decision.recommendation.optionId : undefined;
}

void describe("report-format recovery card (bugs4 item 23)", () => {
  for (const trigger of ["roundIncomplete", "roundDeferred", "summaryRejected"]) {
    void it(`${trigger}: says the report was unusable, offers no model change, recommends the retry`, () => {
      const decision = build(trigger);
      assert.doesNotMatch(decision.whatHappened, /failed\./);
      assert.match(decision.whatHappened, /ran normally, but its report could not be used/);
      assert.equal(decision.options.some((option) => option.optionId === "changeModel"), false);
      assert.equal(recommendedOptionId(decision), "waitForRetry");
      assert.match(decision.recommendation?.reasoning ?? "", /changing the model would not help/);
      assert.ok(decision.options.some((option) => option.optionId === "runNow"), "Run now stays available");
    });
  }

  void it("a provider failure (externallyTerminated / providerFailedMidRound / no trigger) still says failed and offers Change the model", () => {
    for (const trigger of ["externallyTerminated", "providerFailedMidRound", undefined]) {
      const decision = build(trigger);
      assert.match(decision.whatHappened, /\(claude-cli:claude-sonnet-5-5@high\) failed\./);
      assert.ok(decision.options.some((option) => option.optionId === "changeModel"));
      assert.equal(recommendedOptionId(decision), "changeModel");
    }
  });
});
