import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDisplayTimestampPairV1 } from "../utils/timeFormat";
import { buildDecisionCopyTextV1, buildInteractionCopyTextV1 } from "../views/chatView";

void describe("formatDisplayTimestampPairV1", () => {
  const now = new Date(2026, 8, 20, 12, 0, 0);

  void it("gives an HH:mm label and a non-empty title for a timestamp from today", () => {
    const pair = formatDisplayTimestampPairV1(new Date(2026, 8, 20, 9, 5, 0).toISOString(), now);
    assert.match(pair.atLabel, /^\d{1,2}[:.]\d{2}/);
    assert.ok(pair.atTitle.length > 0);
  });

  void it("gives a date label for a timestamp from another day", () => {
    const pair = formatDisplayTimestampPairV1(new Date(2026, 8, 1, 9, 5, 0).toISOString(), now);
    assert.equal(pair.atLabel, "2026-09-01");
    assert.ok(pair.atTitle.length > 0);
  });

  void it("gives exactly empty strings — never NaN or Invalid — for missing or unparsable input", () => {
    for (const input of [undefined, "", "not-a-date"]) {
      const pair = formatDisplayTimestampPairV1(input, now);
      assert.deepEqual(pair, { atLabel: "", atTitle: "" }, String(input));
    }
  });
});

void describe("buildDecisionCopyTextV1", () => {
  const base = {
    // Effects are irrelevant to the copy text, so the fixture omits them.
    whatHappened: "A round failed.",
    whyUserNeeded: "Cannot decide alone.",
    recommendation: { kind: "option" as const, optionId: "retry", reasoning: "Cheapest." },
    options: [
      { optionId: "retry", label: "Retry", consequence: "Runs again.", destructive: false },
      {
        optionId: "restore",
        label: "Restore",
        consequence: "Discards the round.",
        destructive: true,
        disabled: true,
        disabledReason: "resume the task first",
      },
    ],
    evidence: [{ label: "Attempts", detail: "3" }],
  } as unknown as Parameters<typeof buildDecisionCopyTextV1>[0];

  void it("lists title, facts, gating, evidence and each option with consequence, recommendation and disabled reason", () => {
    const text = buildDecisionCopyTextV1(base, "Unblocks: this waits for you", true);
    assert.deepEqual(text.split("\n"), [
      "Decision needed",
      "A round failed.",
      "Cannot decide alone.",
      "Unblocks: this waits for you",
      "Attempts: 3",
      "- Retry (Recommended) — Runs again.",
      "- Restore — Discards the round. (unavailable: resume the task first)",
    ]);
  });

  void it("titles a non-blocking decision Optional", () => {
    assert.match(buildDecisionCopyTextV1(base, "g", false), /^Optional\n/);
  });
});

void describe("buildInteractionCopyTextV1", () => {
  void it("lists each question's prompt with its required/optional marker, help text and option labels", () => {
    const text = buildInteractionCopyTextV1({
      questions: [
        {
          questionId: "q1",
          kind: "singleChoice",
          prompt: "Which way?",
          helpText: "Pick one.",
          required: true,
          options: [
            { optionId: "a", label: "Left" },
            { optionId: "b", label: "Right" },
          ],
        },
        {
          questionId: "q2",
          kind: "multipleChoice",
          prompt: "Extras?",
          required: false,
          minSelections: 0,
          maxSelections: 2,
          options: [{ optionId: "x", label: "Cheese" }],
        },
        {
          questionId: "q3",
          kind: "text",
          prompt: "Anything else?",
          required: false,
          allowBlank: true,
          maxLength: 100,
        },
      ],
    } as unknown as Parameters<typeof buildInteractionCopyTextV1>[0]);
    assert.deepEqual(text.split("\n"), [
      "Needs your reply",
      "Which way? *",
      "Pick one.",
      "- Left",
      "- Right",
      "Extras? (optional)",
      "- Cheese",
      "Anything else? (optional)",
    ]);
  });
});
