/**
 * chat1 Step 2: the transcript shows conversation only. Every entry shape that bugs5's
 * `chat-v1.json` holds is covered: owner messages, questions, untyped replies and the machine status
 * lines the chat used to render as turns.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isConversationEntryV1, isLegacyStatusLineV1, type TranscriptFilterEntryV1 } from "../views/chatTranscriptFilterV1";

function reply(text: string, extra: Partial<TranscriptFilterEntryV1> = {}): TranscriptFilterEntryV1 {
  return { role: "assistant", text, ...extra };
}

void describe("isConversationEntryV1", () => {
  void it("always shows the owner's messages and questions", () => {
    assert.equal(isConversationEntryV1({ role: "user", text: "Progress: please look at this." }), true);
    assert.equal(isConversationEntryV1({ role: "question", text: "Started or Ended?" }), true);
    // Even a user message that happens to look like a status line.
    assert.equal(isConversationEntryV1({ role: "user", text: "Started Apply Review at 13:58." }), true);
  });

  void it("shows an untyped assistant reply", () => {
    assert.equal(isConversationEntryV1(reply("I changed the parser and ran the tests.")), true);
    assert.equal(isConversationEntryV1(reply("Here is the plan.\nProgress: 3 of 5 items are done.")), true);
  });

  void it("shows a reply that only mentions a status word mid-text", () => {
    assert.equal(isConversationEntryV1(reply("Your last Progress: update was clear, thanks.")), true);
    assert.equal(isConversationEntryV1(reply("The run Started 5 minutes ago and has not Ended.")), true);
    assert.equal(isConversationEntryV1(reply("I Recorded: nothing new today.\nSee below.")), true);
  });

  void it("shows an entry whose kind it does not know", () => {
    assert.equal(isConversationEntryV1(reply("Something new", { kind: "futureKind" })), true);
  });

  void it("hides activity and outcome entries", () => {
    assert.equal(isConversationEntryV1(reply("_Auto-starting: x (not setting-driven)._", { kind: "activity" })), false);
    assert.equal(isConversationEntryV1(reply("_Ended: Apply Review — failed_", { kind: "outcome" })), false);
  });

  void it("hides an Ended line by the operation it closes, even without a kind", () => {
    assert.equal(isConversationEntryV1(reply("anything", { endedOperationId: "op-1" })), false);
  });

  void it("hides a decision anchor only when its card is rendered", () => {
    const anchor = reply("Decision raised: x", { kind: "decision", decisionId: "d1" });
    assert.equal(isConversationEntryV1(anchor, { renderedDecisionIds: new Set(["d1"]) }), false);
    assert.equal(isConversationEntryV1(anchor, { renderedDecisionIds: new Set(["other"]) }), true);
    assert.equal(isConversationEntryV1(anchor), true);
  });

  void describe("untyped status lines written before they carried a kind", () => {
    const lines = [
      "Started Re-running review — High-Level Code Review at 13:58.",
      "Started Apply Review — High-Level Code Review at 2026-11-01.",
      "Resumed Apply Review — High-Level Code Review.",
      "Progress: Apply Review — High-Level Code Review: 2 checks running · pnpm run lint (+1) · 0/12 complete.",
      "Progress: Apply Review — High-Level Code Review: starting.",
      "Ended Apply Review — High-Level Code Review — succeeded.",
      "Ended Implementation — Implementation — failed: the model returned nothing.",
      'Recorded: "Apply 2 Reviewer-Verified Ticks" — applying now. Ticks the two items.',
      "Recorded: your answer was submitted. Resuming…",
      'Dismissed "This task\'s plan checklist is flagged unreliable". Nothing was run and task.md was not changed.',
      "Dismissed “Commit Everything Together”. Nothing was run and task.md was not changed.",
      'Dismissed: "Run Publish Checks" was waiting on a run that a reload ended, so it can no longer be answered.',
      "Withdrawn: the continuation started, so this card no longer applies.",
      "Commit & Push is starting — wait here; progress appears below.",
      "Commit & Push is still starting (1.5 min).",
      "Commit & Push stopped before it started, so nothing ran. The notification above says why; choose it again when that is resolved.",
    ];
    for (const text of lines) {
      void it(`hides: ${text.slice(0, 60)}`, () => {
        assert.equal(isLegacyStatusLineV1(reply(text)), true);
        assert.equal(isConversationEntryV1(reply(text)), false);
      });
    }

    void it("does not hide the same text when it is typed (a typed entry is never guessed at)", () => {
      assert.equal(isConversationEntryV1(reply("Progress: Apply Review: starting.", { kind: "futureKind" })), true);
    });

    void it("does not hide a multi-line reply that starts like a status line", () => {
      assert.equal(isConversationEntryV1(reply("Progress: here is where I am.\nNext I will run the tests.")), true);
    });
  });
});
