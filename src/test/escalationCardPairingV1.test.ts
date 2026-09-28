/**
 * RC1 item 11 (f3 Part 14): the escalation card's `whatHappened` /
 * `whyUserNeeded` text must agree with its own `recommendation`. Before this,
 * a card recommending "keep iterating" opened with "can't progress on its own"
 * and "has done what it can here" — contradicting the option it recommended.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEscalationDecisionV1,
  describeFixableSplitV1,
  type EscalationPlateauContextV1,
} from "../utils/reviewEscalation";

const TARGET = { canonicalId: "task-id", taskFolderPath: "/tmp/task", taskName: "Task A" };

function context(overrides: Partial<EscalationPlateauContextV1>): EscalationPlateauContextV1 {
  return {
    blockersCount: 4,
    primaryBlockerDescription: "The retry path is untested.",
    allBlockerDescriptions: ["The retry path is untested."],
    narrowedNote: "",
    progressNote: "12 of 20 plan steps verified.",
    taskFixableCount: 3,
    hasSpecDefect: false,
    hasNonFixableBlocker: true,
    nextStageHasRun: false,
    clearingNote: "Fix the blockers.",
    dispatchModeEvidence: [],
    ...overrides,
  };
}

function recommended(ctx: Partial<EscalationPlateauContextV1>): {
  optionId: string | undefined;
  whatHappened: string;
  whyUserNeeded: string;
} {
  const decision = buildEscalationDecisionV1("plateau", "impl-high-review", "no progress", TARGET, context(ctx));
  return {
    optionId: decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined,
    whatHappened: decision.whatHappened,
    whyUserNeeded: decision.whyUserNeeded,
  };
}

void describe("escalation card pairing (RC1 item 11)", () => {
  void it("states the fixable/needs-you split when some blockers are task-fixable, and recommends keep iterating", () => {
    const card = recommended({ taskFixableCount: 3, blockersCount: 4 });
    assert.equal(card.optionId, "keepIterating");
    assert.match(card.whyUserNeeded, /^Automation can still act on 3 of the 4 blockers; the other 1 need you\./);
    assert.match(card.whatHappened, /Automation can still act on 3 of the 4 blockers; the other 1 need you\./);
    assert.doesNotMatch(card.whatHappened, /can't progress on its own/);
    assert.doesNotMatch(card.whyUserNeeded, /has done what it can here/);
  });

  void it("does not claim anything needs the user when every remaining blocker is task-fixable", () => {
    const card = recommended({ taskFixableCount: 2, blockersCount: 2, hasNonFixableBlocker: false });
    assert.equal(card.optionId, "keepIterating");
    assert.match(card.whyUserNeeded, /^Automation can still act on all 2 blockers, but it stopped iterating\./);
    assert.doesNotMatch(card.whyUserNeeded, /need you/);
  });

  void it("keeps the 'nothing left for automation' sentences when no blocker is task-fixable (advance / handleMyself)", () => {
    const advance = recommended({ taskFixableCount: 0, nextStageHasRun: false });
    assert.equal(advance.optionId, "advance");
    assert.match(advance.whatHappened, /can't progress on its own\./);
    assert.match(advance.whyUserNeeded, /^Automation has done what it can here — /);

    const handle = recommended({ taskFixableCount: 0, nextStageHasRun: true });
    assert.equal(handle.optionId, "handleMyself");
    assert.match(handle.whatHappened, /can't progress on its own\./);
    assert.match(handle.whyUserNeeded, /^Automation has done what it can here — /);
  });

  void it("pairs the reconsiderRequirement branch with the same split wording", () => {
    const card = recommended({ hasSpecDefect: true, taskFixableCount: 1, blockersCount: 3 });
    assert.equal(card.optionId, "reconsiderRequirement");
    assert.match(card.whyUserNeeded, /Automation can still act on 1 of the 3 blockers; the other 2 need you\./);
  });

  void it("describeFixableSplitV1 handles the singular case", () => {
    assert.equal(describeFixableSplitV1(1, 1), "Automation can still act on the 1 blocker, but it stopped iterating.");
  });
});
