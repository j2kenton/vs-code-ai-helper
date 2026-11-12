/**
 * bugs6 item 42 (Steps 6-8, 11): a Fast Forward run that dispatches no round never reads as "completed"; an accepted
 * partial scope lifts the hold on a failing review too; the end card does not recommend what the hold would stop.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isConversationEntryV1 } from "../views/chatTranscriptFilterV1";
import { describeFastForwardStoppedBeforeAnyRoundV1 } from "../utils/fastForwardHoldV1";
import type { FastForwardHoldV1 } from "../utils/reviewScoreLoop";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import { markOperationStoppedBeforeAnyRoundV1 } from "../utils/operationEndedLineV1";
import type { TaskOperationSnapshot } from "../utils/taskOperations";
import { buildAutomationStoppedCardInputV1, recommendNextStepV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import {
  PARTIAL_SCOPE_HOLD_REASON_V1,
  formatPartialScopeVerdictNoteV1,
  hashMissingFilesV1,
  partialScopeHoldReasonV1,
  type PartialReviewScopeV1,
  type PartialScopeAcceptanceV1,
  type PartialScopeGapRecordV1,
} from "../utils/reviewPartialScopeV1";

const HOLD_KINDS: FastForwardHoldV1["kind"][] = [
  "pending-decision",
  "no-change-decision",
  "test-evidence-unproducible",
  "progress-gate",
  "evidence-gap",
  "standing-blockers",
  "partial-scope",
  "clean-review",
];

function snap(id: string, state: TaskOperationSnapshot["state"]): TaskOperationSnapshot {
  return {
    id,
    key: "/ws/.ensemble/2026-11-06_task_2",
    label: "Fast Forward Review",
    taskName: "review2",
    stage: "impl-high-review",
    startedAt: 1,
    state,
    kind: "fast-forward",
    waitingForUser: false,
  } as unknown as TaskOperationSnapshot;
}

void describe("bugs6 item 42: Fast Forward stopped before any round", () => {
  void it("every hold's text says it stopped before any round, gives the reason, and never says 'completed'", () => {
    for (const kind of HOLD_KINDS) {
      const text = describeFastForwardStoppedBeforeAnyRoundV1({ kind, detail: "the reason" }, "High-Level Code Review");
      assert.match(text, /^Fast Forward stopped before any round: /, kind);
      assert.match(text, /the reason/, kind);
      assert.doesNotMatch(text, /completed/i, kind);
    }
  });

  void it("a partial-scope hold names the scope card's options as the way on", () => {
    const text = describeFastForwardStoppedBeforeAnyRoundV1(
      { kind: "partial-scope", detail: `${PARTIAL_SCOPE_HOLD_REASON_V1}. Choose on the card below: "Accept the partial scope (4 files not reviewed)".` },
      "High-Level Code Review"
    );
    assert.match(text, /Choose on the scope card, then click Start Fast Forward again\./);
  });

  void it("the Notifications entry for a marked run says 'stopped before any round', not 'completed'", () => {
    const reason = describeFastForwardStoppedBeforeAnyRoundV1({ kind: "partial-scope", detail: "no room" }, "High-Level Code Review");
    markOperationStoppedBeforeAnyRoundV1("op-ff-1", reason);
    const entry = terminalEntryFor(snap("op-ff-1", "succeeded"));
    assert.match(entry?.message ?? "", /Fast Forward stopped before any round: no room/);
    assert.doesNotMatch(entry?.message ?? "", /completed/);
    assert.equal(entry?.level, "warning");
  });

  void it("an unmarked succeeded run still reads 'completed' (control), and the mark is used once", () => {
    assert.match(terminalEntryFor(snap("op-ff-2", "succeeded"))?.message ?? "", /: completed$/);
    markOperationStoppedBeforeAnyRoundV1("op-ff-3", "Fast Forward stopped before any round: x");
    assert.match(terminalEntryFor(snap("op-ff-3", "succeeded"))?.message ?? "", /stopped before any round/);
    assert.match(terminalEntryFor(snap("op-ff-3", "succeeded"))?.message ?? "", /: completed$/);
  });
});

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const SCOPE: PartialReviewScopeV1 = {
  missingCount: 4,
  summary: "Reviewed 52 of 56 changed files",
  hash: hashMissingFilesV1(FILES),
  files: FILES,
  sizeLimitFiles: FILES,
};
// A failing review: 7/10 against a threshold of 8, with its partial-scope note unaccepted (the 12:09 review2 shape).
const FAILING_REVIEW = "Readiness: 7/10\n" + formatPartialScopeVerdictNoteV1(SCOPE, false);
const GAP: PartialScopeGapRecordV1 = {
  stage: "impl-high-review",
  scope: SCOPE,
  score: 7,
  threshold: 8,
  scoreClears: false,
  recordedAt: "2026-11-09T12:09:00.000Z",
};
const ACCEPTED: PartialScopeAcceptanceV1 = {
  stage: "impl-high-review",
  hash: SCOPE.hash,
  missingCount: 4,
  acceptedAt: "2026-11-09T12:21:51.000Z",
};

void describe("bugs6 item 42: an accepted gap lifts the hold on a failing review", () => {
  void it("a matching acceptance (stage + hash) does not hold a 7/10 review", () => {
    assert.equal(
      partialScopeHoldReasonV1({ reviewContent: FAILING_REVIEW, stage: "impl-high-review", gap: GAP, acceptance: ACCEPTED }),
      undefined
    );
  });

  void it("a wrong hash, a wrong stage and no acceptance file all still hold", () => {
    const hold = (acceptance: PartialScopeAcceptanceV1 | undefined) =>
      partialScopeHoldReasonV1({ reviewContent: FAILING_REVIEW, stage: "impl-high-review", gap: GAP, acceptance });
    assert.ok(hold({ ...ACCEPTED, hash: hashMissingFilesV1(["src/other.ts"]) }));
    assert.ok(hold({ ...ACCEPTED, stage: "impl-low-review" }));
    assert.ok(hold(undefined));
  });
});

function baseFacts(overrides: Partial<AutomationStopFactsV1> = {}): AutomationStopFactsV1 {
  return {
    taskFolderPath: "/ws/.ensemble/t",
    stage: "impl-high-review",
    ending: "one-cycle",
    stopReason: "the one cycle you chose is done",
    score: 7,
    blockers: { fixFirst: 1, buildToClear: 0, notThisRound: 0 },
    planItems: { total: 64, settled: 0, open: 64, provisional: 0 },
    buildNext: [],
    dismissedDependencies: [],
    reviewClean: false,
    gateComplete: false,
    fastForwardWasRunning: false,
    ...overrides,
  } as AutomationStopFactsV1;
}

void describe("bugs6 item 42: the end card while a hold applies", () => {
  void it("the one-cycle end card never recommends Start Fast Forward while an unaccepted hold applies", () => {
    assert.equal(recommendNextStepV1(baseFacts({ startHold: PARTIAL_SCOPE_HOLD_REASON_V1 })), "runOneMoreCycle");
    const card = buildAutomationStoppedCardInputV1(baseFacts({ startHold: PARTIAL_SCOPE_HOLD_REASON_V1 }));
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : "", "runOneMoreCycle");
  });

  void it("with no hold (an accepted gap) Start Fast Forward is recommended again", () => {
    assert.equal(recommendNextStepV1(baseFacts()), "startFastForward");
  });
});

void describe("bugs6 item 42: the stop is a visible chat line, not only a hidden Ended line", () => {
  const text = describeFastForwardStoppedBeforeAnyRoundV1(
    { kind: "partial-scope", detail: "4 files were not reviewed" },
    "High-Level Code Review"
  );

  void it("a plain assistant line with the stop text is shown in the chat transcript, an outcome-kind line is not", () => {
    assert.match(text, /^Fast Forward stopped before any round:/);
    assert.equal(isConversationEntryV1({ role: "assistant", text }), true);
    assert.equal(isConversationEntryV1({ role: "assistant", text, kind: "outcome" }), false);
  });

  void it("a zero-round hold posts that text as a normal chat line (no kind) next to the Notifications entry", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
    const marker = source.indexOf("markOperationStoppedBeforeAnyRoundV1(op.id, stoppedBeforeAnyRound);");
    assert.ok(marker > 0, "the zero-round hold marks the operation");
    const block = source.slice(marker, marker + 700);
    assert.match(block, /appendChatMessageV1\(resolved\.folderUri\.fsPath, \{\s*role: "assistant",\s*text: stoppedBeforeAnyRound,/);
    assert.doesNotMatch(block, /kind: "outcome"/);
  });
});
