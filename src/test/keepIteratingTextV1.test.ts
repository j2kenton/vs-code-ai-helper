/**
 * review1 Step 58: Keep iterating's consequence names the round, the blockers it works on and the re-review that
 * follows; "I've made changes — re-check" is offered only when the review's inputs changed since the review.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { __resetFastForwardRunsForTestV1, markFastForwardRunActiveV1 } from "../utils/activeFastForwardRunsV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";

const TARGET = { canonicalId: "t", taskFolderPath: "/ws/.ensemble/t" };

const context = (overrides: Record<string, unknown> = {}) => ({
  blockersCount: 4,
  primaryBlockerDescription: "src/a.ts drops the last row",
  allBlockerDescriptions: ["src/a.ts drops the last row"],
  narrowedNote: "",
  progressNote: "",
  taskFixableCount: 3,
  hasSpecDefect: false,
  hasDeclinedBlocker: false,
  hasNonFixableBlocker: false,
  nextStageHasRun: false,
  clearingNote: "",
  dispatchModeEvidence: [],
  planItemsOpen: 0,
  ...overrides,
});

void describe("review1 Step 58: Keep iterating says what it will do", () => {
  afterEach(() => __resetFastForwardRunsForTestV1());

  void it("names the round type, the number of blockers it works on, and the re-review that follows", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "r", TARGET, context());
    const keep = card.options.find((o) => o.optionId === "keepIterating")!;
    assert.match(keep.label, /run Apply Review on the 3 task-fixable blockers/);
    assert.match(keep.consequence, /runs Apply Review against the 3 task-fixable blockers/);
    assert.match(keep.consequence, /then re-reviews High-Level Code Review for a fresh verdict/);
    assert.match(keep.consequence, /one Apply Review and one re-review/);
  });

  void it("the Fast Forward resume text names the blockers and the re-review too", () => {
    markFastForwardRunActiveV1(TARGET.taskFolderPath, { attemptNumber: 3, maxAttempts: 10 });
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "r", TARGET, context({ taskFixableCount: 1 }));
    const keep = card.options.find((o) => o.optionId === "keepIterating")!;
    assert.match(keep.consequence, /against the 1 task-fixable blocker, then re-reviews High-Level Code Review after each round/);
    assert.match(keep.consequence, /iteration 3 of 10/);
  });

  void it("offers 'I've made changes — re-check' only when the review's inputs changed, and it runs only the review", () => {
    const without = buildEscalationDecisionV1("plateau", "impl-high-review", "r", TARGET, context({ reviewInputsChanged: false }));
    assert.ok(!without.options.some((o) => o.optionId === "recheckAfterMyChanges"));
    const unknown = buildEscalationDecisionV1("plateau", "impl-high-review", "r", TARGET, context());
    assert.ok(!unknown.options.some((o) => o.optionId === "recheckAfterMyChanges"));

    const withChange = buildEscalationDecisionV1("plateau", "impl-high-review", "r", TARGET, context({ reviewInputsChanged: true }));
    const recheck = withChange.options.find((o) => o.optionId === "recheckAfterMyChanges")!;
    assert.equal(recheck.label, "I've made changes — re-check");
    assert.equal(recheck.effect.kind === "command" ? recheck.effect.command : undefined, "vs-code-ai-helper.resumeAndRerunReview");
    assert.match(recheck.consequence, /re-runs High-Level Code Review's review only/);
    assert.match(recheck.consequence, /runs no Apply Review and edits no code/);
    // Keep iterating is still there beside it, and is the one that dispatches work.
    assert.ok(withChange.options.some((o) => o.optionId === "keepIterating"));
  });
});
