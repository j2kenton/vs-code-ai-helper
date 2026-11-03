/**
 * chat1 Step 10: one card lifecycle. Open cards start expanded; a finished card is read-only and
 * collapses to one line with its outcome.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cardHeaderTextV1,
  cardOutcomeLineV1,
  cardViewFromDecisionV1,
  cardViewFromSettlementV1,
  decisionCardStateV1,
  defaultCardExpandedV1,
  formatCardTimeV1,
  formSettlementV1,
  interactionSettlementV1,
  isCardFinishedV1,
  trimmedCardViewV1,
} from "../views/chatCardLifecycleV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { decisionCardTitleV1, settledDecisionsForTimelineV1 } from "../views/chatView";

const AT = new Date(2026, 10, 2, 3, 41, 0).toISOString();
const HHMM = new Date(AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function decision(overrides: Partial<WorkflowDecisionV1>): WorkflowDecisionV1 {
  return {
    decisionId: "d-1",
    decisionKey: "k",
    taskCanonicalId: "/t",
    stage: "impl-high-review",
    whatHappened: "x",
    whyUserNeeded: "y",
    options: [
      { optionId: "apply", label: "Apply", resumeKind: "continue", consequence: "c", effect: { kind: "doNothing" } },
      { optionId: "notNow", label: "Not now", resumeKind: "unpause", consequence: "c", effect: { kind: "doNothing" } },
    ],
    recommendation: { kind: "none", reasoning: "r" },
    createdAt: AT,
    state: "pending",
    ...overrides,
  } as WorkflowDecisionV1;
}

void describe("card outcome lines", () => {
  void it("words each state in plain words", () => {
    assert.equal(cardOutcomeLineV1("open"), "needs your answer");
    assert.equal(cardOutcomeLineV1("answered", { choice: "Apply", at: AT }), `answered: Apply · ${HHMM}`);
    assert.equal(cardOutcomeLineV1("dismissed", { at: AT }), `dismissed · ${HHMM}`);
    assert.equal(cardOutcomeLineV1("dismissed"), "dismissed");
    assert.equal(cardOutcomeLineV1("withdrawn", { reason: "the continuation started." }), "withdrawn: the continuation started");
    assert.equal(cardOutcomeLineV1("retired", { reason: "the task moved on" }), "closed: the task moved on");
  });

  void it("falls back to a plain reason when none was recorded", () => {
    assert.equal(cardOutcomeLineV1("withdrawn"), "withdrawn: it no longer applies");
    assert.match(cardOutcomeLineV1("retired"), /^closed: retired by the task moving on/);
    assert.equal(cardOutcomeLineV1("answered", {}), "answered");
  });

  void it("ignores an unreadable time", () => {
    assert.equal(formatCardTimeV1("not a date"), undefined);
    assert.equal(formatCardTimeV1(undefined), undefined);
    assert.equal(cardOutcomeLineV1("dismissed", { at: "nope" }), "dismissed");
  });

  void it("joins title and outcome for the collapsed line", () => {
    assert.equal(
      cardHeaderTextV1({ title: "Apply 2 Reviewer-Verified Ticks", outcome: "needs your answer" }),
      "Apply 2 Reviewer-Verified Ticks — needs your answer"
    );
  });
});

void describe("card state defaults", () => {
  void it("opens an open card expanded and collapses every finished state", () => {
    assert.equal(defaultCardExpandedV1("open"), true);
    for (const state of ["answered", "dismissed", "withdrawn", "retired"] as const) {
      assert.equal(defaultCardExpandedV1(state), false, state);
      assert.equal(isCardFinishedV1(state), true, state);
    }
    assert.equal(isCardFinishedV1("open"), false);
  });
});

void describe("cardViewFromDecisionV1", () => {
  void it("maps every stored state", () => {
    assert.equal(decisionCardStateV1({ state: "pending" }), "open");
    assert.equal(decisionCardStateV1({ state: "resolved" }), "answered");
    assert.equal(decisionCardStateV1({ state: "dismissed" }), "dismissed");
    assert.equal(decisionCardStateV1({ state: "withdrawn" }), "withdrawn");
    assert.equal(decisionCardStateV1({ state: "superseded" }), "retired");
  });

  void it("shows the chosen option's label and time for an answered card", () => {
    const view = cardViewFromDecisionV1(decision({ state: "resolved", resolvedOptionId: "apply", resolvedAt: AT }), "Apply 2 Ticks");
    assert.equal(view.state, "answered");
    assert.equal(view.outcome, `answered: Apply · ${HHMM}`);
    assert.equal(view.cardId, "d-1");
  });

  void it("shows a dismissed, withdrawn and still-open card", () => {
    assert.equal(cardViewFromDecisionV1(decision({ state: "dismissed", dismissedAt: AT }), "T").outcome, `dismissed · ${HHMM}`);
    assert.equal(
      cardViewFromDecisionV1(decision({ state: "withdrawn", withdrawnReason: "the continuation started" }), "T").outcome,
      "withdrawn: the continuation started"
    );
    const open = cardViewFromDecisionV1(decision({}), "T");
    assert.equal(open.state, "open");
    assert.equal(open.outcome, "needs your answer");
  });
});

void describe("question-style cards", () => {
  void it("an open one needs an answer; an answered one that is still resuming says so; a settled one reads its outcome", () => {
    assert.equal(cardViewFromSettlementV1("q-1", "question", "Which file?").outcome, "needs your answer");
    assert.equal(
      cardViewFromSettlementV1("i-1", "interaction", "Pick", { kind: "answered", choice: "Yes", resuming: true }).outcome,
      "answered: Yes — resuming"
    );
    assert.equal(
      cardViewFromSettlementV1("i-1", "interaction", "Pick", { kind: "answered", choice: "Yes" }).outcome,
      "answered: Yes"
    );
    assert.equal(cardViewFromSettlementV1("f-1", "form", "Open items", { kind: "dismissed", at: AT }).outcome, `dismissed · ${HHMM}`);
    assert.equal(
      cardViewFromSettlementV1("q-2", "question", "Q", { kind: "retired", reason: "the stage was left" }).outcome,
      "closed: the stage was left"
    );
  });

  void it("chat1 Step 8: the timeline keeps finished cards but drops a withdrawn copy a fresher repost replaced", () => {
    const older = new Date(2026, 10, 2, 3, 0, 0).toISOString();
    const newer = new Date(2026, 10, 2, 4, 0, 0).toISOString();
    const records = [
      decision({ decisionId: "a", decisionKey: "k1", state: "resolved", createdAt: older }),
      decision({ decisionId: "b", decisionKey: "k2", state: "dismissed", createdAt: older }),
      decision({ decisionId: "c", decisionKey: "k3", state: "withdrawn", createdAt: older }),
      decision({ decisionId: "c2", decisionKey: "k3", state: "pending", createdAt: newer }),
      decision({ decisionId: "d", decisionKey: "k4", state: "withdrawn", withdrawnReason: "the files were cleared", createdAt: older }),
      decision({ decisionId: "e", decisionKey: "k5", state: "resolved", stage: "impl", createdAt: older }),
    ];
    assert.deepEqual(
      settledDecisionsForTimelineV1(records, "impl-high-review").map((record) => record.decisionId),
      ["a", "b", "d"],
      "answered, dismissed and a withdrawn card with no repost stay; the replaced copy, the open card and other stages do not"
    );
  });

  void it("chat1 Step 8: a card title is the heading plus the first line of what happened, kept short", () => {
    assert.equal(decisionCardTitleV1("Decision needed", "A round failed.\nMore detail."), "Decision needed: A round failed.");
    assert.equal(decisionCardTitleV1("Optional", ""), "Optional");
    assert.ok(decisionCardTitleV1("Decision needed", "x".repeat(300)).length < 120);
  });

  void it("a trimmed record is a collapsed one-line card", () => {
    const view = trimmedCardViewV1("d-9", "decision", "Old card");
    assert.equal(view.outcome, "details no longer kept");
    assert.equal(isCardFinishedV1(view.state), true);
  });
});

void describe("chat1 Step 9: settled interactions and open-items forms stay as finished cards", () => {
  void it("an unresolved interaction has no settlement; a resumed one is answered with the choice", () => {
    assert.equal(interactionSettlementV1({ state: "unresolved" }, undefined), undefined);
    const view = cardViewFromSettlementV1("i1", "interaction", "Needs your reply", interactionSettlementV1({ state: "resumed" }, "Left"));
    assert.equal(view.state, "answered");
    assert.equal(view.outcome, "answered: Left");
    assert.equal(isCardFinishedV1(view.state), true);
  });

  void it("a cancelled interaction is dismissed, with its time", () => {
    const view = cardViewFromSettlementV1(
      "i1",
      "interaction",
      "Needs your reply",
      interactionSettlementV1({ state: "cancelled", dismissedAt: AT }, undefined)
    );
    assert.equal(view.state, "dismissed");
    assert.equal(view.outcome, `dismissed · ${HHMM}`);
  });

  void it("every other settled state is closed with a plain reason, never an internal state name", () => {
    for (const state of ["expired", "supersededByReplacementOperation", "resetByChatRecovery", "missingTransaction", "orphanedTransaction"]) {
      const view = cardViewFromSettlementV1("i1", "interaction", "Needs your reply", interactionSettlementV1({ state }, undefined));
      assert.equal(view.state, "retired");
      assert.match(view.outcome, /^closed: /);
      assert.doesNotMatch(view.outcome, /Transaction|Operation|ByChatRecovery/);
    }
    const withReason = interactionSettlementV1({ state: "expired", retirementReason: "the run ended" }, undefined);
    assert.equal(cardViewFromSettlementV1("i1", "interaction", "t", withReason).outcome, "closed: the run ended");
  });

  void it("forms: open has no settlement; applied, dismissed and stale finish the card", () => {
    assert.equal(formSettlementV1({ state: "open" }), undefined);
    assert.equal(cardViewFromSettlementV1("f1", "form", "Decide", formSettlementV1({ state: "applied", closedAt: AT })).outcome, `answered: applied · ${HHMM}`);
    assert.equal(cardViewFromSettlementV1("f1", "form", "Decide", formSettlementV1({ state: "dismissed", closedAt: AT })).outcome, `dismissed · ${HHMM}`);
    assert.equal(
      cardViewFromSettlementV1("f1", "form", "Decide", formSettlementV1({ state: "stale" })).outcome,
      "closed: the plan changed after it was posted"
    );
  });
});
