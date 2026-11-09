/**
 * The Chat With AI stage arrows (owner request, 2026-11-09): which neighbours a stage chat offers,
 * and when a button says something there needs the owner.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStageNavV1, isNavigableStageV1 } from "../views/chatStageNavV1";

void describe("buildStageNavV1", () => {
  void it("offers the previous and next stage by name, with no count when nothing waits", () => {
    const nav = buildStageNavV1({ stage: "impl-low-review", currentStage: "impl-low-review", attentionOnCurrentStage: 0 });
    assert.equal(nav.previous?.stage, "impl-high-review");
    assert.equal(nav.previous?.label, "Chat with High-Level Code Review");
    assert.equal(nav.previous?.attention, 0);
    assert.equal(nav.next?.stage, "publish");
    assert.equal(nav.next?.label, "Chat with Publish");
  });

  void it("has no previous button on the first stage and no next button on the last", () => {
    assert.equal(buildStageNavV1({ stage: "desc", currentStage: "desc", attentionOnCurrentStage: 0 }).previous, undefined);
    assert.equal(buildStageNavV1({ stage: "publish", currentStage: "publish", attentionOnCurrentStage: 0 }).next, undefined);
  });

  void it("puts the count on the button for the stage that needs the owner", () => {
    const nav = buildStageNavV1({ stage: "impl-low-review", currentStage: "publish", attentionOnCurrentStage: 2 });
    assert.equal(nav.next?.label, "Chat with Publish [2]");
    assert.equal(nav.next?.attention, 2);
    assert.match(nav.next?.tooltip ?? "", /2 items need you on Publish/);
    assert.equal(nav.previous?.attention, 0, "the other direction stays plain");
  });

  void it("marks the way towards a stage further along, and names it", () => {
    const nav = buildStageNavV1({ stage: "plan", currentStage: "impl-low-review", attentionOnCurrentStage: 1 });
    assert.equal(nav.next?.label, "Chat with High-Level Review (Plan) [1 at Low-Level Code Review]");
    assert.match(nav.next?.tooltip ?? "", /1 item needs you on Low-Level Code Review/);
    const back = buildStageNavV1({ stage: "publish", currentStage: "impl", attentionOnCurrentStage: 3 });
    assert.equal(back.previous?.label, "Chat with Low-Level Code Review [3 at Implementation]");
  });

  void it("counts nothing on the current stage's own chat; the cards are on screen there", () => {
    const nav = buildStageNavV1({ stage: "impl", currentStage: "impl", attentionOnCurrentStage: 4 });
    assert.equal(nav.previous?.attention, 0);
    assert.equal(nav.next?.attention, 0);
  });

  void it("shows plain buttons when the current stage is unknown", () => {
    const nav = buildStageNavV1({ stage: "impl", currentStage: undefined, attentionOnCurrentStage: 5 });
    assert.equal(nav.next?.label, "Chat with High-Level Code Review");
    assert.equal(nav.previous?.label, "Chat with Low-Level Review (Plan)");
  });
});

void describe("isNavigableStageV1", () => {
  void it("accepts only the workflow's stages", () => {
    assert.equal(isNavigableStageV1("publish"), true);
    assert.equal(isNavigableStageV1("completed"), false);
    assert.equal(isNavigableStageV1("../x"), false);
    assert.equal(isNavigableStageV1(undefined), false);
  });
});
