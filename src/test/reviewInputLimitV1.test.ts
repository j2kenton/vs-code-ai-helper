/**
 * RC1 item 4: the review input limit and what the review is given.
 * Pure helpers only (no VS Code host).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  MAX_CHAT_TRANSACTION_FILE_BYTES_V1,
  MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1,
} from "../types/chatInteractionTransactionV1";
import {
  boundTaskDescriptionForReviewV1,
  describeOversizedInputRemedyV1,
  type ImplReviewLedgerRowV1,
  isImplReviewOnZeroFilesV1,
  resolveLedgerImplReviewFilesV1,
  REVIEW_TASK_DESCRIPTION_MAX_CHARS_V1,
  shouldClearImplReviewFilesAfterReviewV1,
} from "../utils/implReviewFileSelection";

void describe("review input limit", () => {
  void it("is derived from the transaction file's 1 MB ceiling, not a free number", () => {
    assert.equal(MAX_CHAT_TRANSACTION_FILE_BYTES_V1, 1024 * 1024);
    assert.equal(MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1, MAX_CHAT_TRANSACTION_FILE_BYTES_V1 / 2);
    // The snapshot is stored JSON-escaped inside the record: even doubled it
    // must still fit the record's own read ceiling.
    assert.ok(MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 * 2 <= MAX_CHAT_TRANSACTION_FILE_BYTES_V1);
    assert.ok(MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 >= 512 * 1024, "at least what the hand-patched box ran");
  });
});

void describe("boundTaskDescriptionForReviewV1", () => {
  const long = Array.from({ length: 2000 }, (_, i) => `Requirement line ${i} — keep this behaviour.`).join("\n");

  void it("leaves a task with no plan unchanged", () => {
    assert.equal(boundTaskDescriptionForReviewV1(long, false), long);
  });

  void it("leaves a short task unchanged even with a plan", () => {
    assert.equal(boundTaskDescriptionForReviewV1("short", true), "short");
  });

  void it("bounds a long task once a plan exists, at a line boundary, and says what was left out", () => {
    const bounded = boundTaskDescriptionForReviewV1(long, true);
    assert.ok(bounded.length < REVIEW_TASK_DESCRIPTION_MAX_CHARS_V1 + 400);
    assert.ok(bounded.startsWith("Requirement line 0 "));
    const shown = bounded.split("\n\n_Task description bounded")[0]!;
    assert.ok(/line \d+ — keep this behaviour\.$/.test(shown), "cut on a whole line, not mid-sentence");
    assert.match(bounded, /characters shown/);
    assert.match(bounded, /complete text is in task\.md/);
  });
});

void describe("describeOversizedInputRemedyV1", () => {
  const drivers = {
    "task.md": 60 * 1024,
    "plan.md": 200 * 1024,
    "previous review": 10 * 1024,
    "prompt variable: ownerDecisions": 0,
    "template text and encoding overhead": 5 * 1024,
  };

  void it("names the largest inputs first, with what to do, and the amount to cut", () => {
    const text = describeOversizedInputRemedyV1(drivers, 512 * 1024, 600 * 1024);
    assert.match(text, /cut at least 88 KB/);
    assert.ok(text.indexOf("plan.md") < text.indexOf("task.md"), "largest first");
    assert.match(text, /trim plan\.md/);
    assert.ok(!/splitting/i.test(text), "no longer tells the user to split the task");
    assert.ok(!text.includes("ownerDecisions"), "zero-size inputs are not offered as remedies");
  });
});

void describe("review pre-dispatch abort (source wiring)", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
  const start = source.indexOf("if (oversizedAfterShrink) {");
  const block = source.slice(start, start + 6500);

  void it("rebuilds the pack at most once before failing", () => {
    assert.match(source, /maxTotalChars = shrinkFloorChars;/);
    assert.ok(!source.includes("maxShrinkAttempts = 64;\n    for (let attempt = 0; ; attempt++) {\n      const written"));
  });

  void it("the Apply Review abort is also a failed round with a real remedy, never 'consider splitting'", () => {
    const at = source.indexOf("Applying this review would assemble");
    assert.ok(at >= 0);
    const applyBlock = source.slice(at - 900, at + 2200);
    assert.match(applyBlock, /describeOversizedInputRemedyV1\(/);
    assert.match(applyBlock, /mode: "apply-review"/);
    assert.match(applyBlock, /"failed"/);
    assert.ok(!/Consider splitting/i.test(source), "no 'Consider splitting' remains anywhere in reviewActions");
  });

  void it("records the abort as a failed round and lists every input with its size", () => {
    assert.match(block, /terminalizeRoundV1\(\s*abortRoundId,\s*"failed"/);
    assert.match(block, /synthesizeIfMissing/);
    assert.match(block, /prompt variable: \$\{name\}/);
    assert.match(block, /template text and encoding overhead/);
    assert.ok(!block.includes("Consider splitting the task"));
  });
});

// ---------------------------------------------------------------------------
// RC1 item 5 / RC3 item 10 — a clean review leaves the next review its files;
// only a clean PUBLISH review (the last of the three) may clear the set.
// ---------------------------------------------------------------------------

void describe("shouldClearImplReviewFilesAfterReviewV1", () => {
  void it("a clean HIGH-level review does not clear the set later stages still need", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("impl-high-review", 0), false);
  });

  void it("a clean LOW-level review does not clear the set Publish still needs", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("impl-low-review", 0), false);
  });

  void it("a clean PUBLISH review (the last one) clears it", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("publish", 0), true);
  });

  void it("a Publish review with any remaining blocker never clears it", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("publish", 2), false);
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("impl-low-review", 2), false);
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("impl-high-review", 2), false);
  });

  void it("non-implementation, non-publish stages never clear it", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("plan-high-review", 0), false);
  });

  void it("a clean Publish review scoped to open editors never clears it (2026-09-30 review)", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("publish", 0, "open-editors"), false);
  });

  void it("a clean Publish review scoped to the tracked set, or with no scope recorded, clears it", () => {
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("publish", 0, "tracked"), true);
    assert.equal(shouldClearImplReviewFilesAfterReviewV1("publish", 0, undefined), true);
  });
});

void describe("isImplReviewOnZeroFilesV1", () => {
  void it("tracked mode: an empty tracked set is zero files, a non-empty one is not", () => {
    assert.equal(isImplReviewOnZeroFilesV1({ trackedFileCount: 0, embeddedContentBytes: 0, omittedFileCount: 0 }), true);
    assert.equal(isImplReviewOnZeroFilesV1({ trackedFileCount: 3, embeddedContentBytes: 0, omittedFileCount: 0 }), false);
  });

  void it("fallback mode: zero only when no open editor supplied any file", () => {
    assert.equal(isImplReviewOnZeroFilesV1({ trackedFileCount: undefined, embeddedContentBytes: 0, omittedFileCount: 0 }), true);
    assert.equal(isImplReviewOnZeroFilesV1({ trackedFileCount: undefined, embeddedContentBytes: 120, omittedFileCount: 0 }), false);
    assert.equal(isImplReviewOnZeroFilesV1({ trackedFileCount: undefined, embeddedContentBytes: 0, omittedFileCount: 2 }), false);
  });
});

void describe("zero-file refusal and clearing (source wiring)", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");

  void it("refuses with a way out and does not dispatch", () => {
    const at = source.indexOf("isImplReviewOnZeroFilesV1({");
    assert.ok(at >= 0);
    const block = source.slice(at, at + 1200);
    assert.match(block, /there are no changed files to review/);
    assert.match(block, /Run an Implementation round/);
    assert.match(block, /move the task back a stage/);
    assert.match(block, /return;/);
  });

  void it("the clearing decision goes through the shared predicate, using the total blocker count and the review's scope", () => {
    assert.match(source, /shouldClearImplReviewFilesAfterReviewV1\(targetStage, historyEntry\.blockerCount, reviewScope\)/);
  });
});

// ---------------------------------------------------------------------------
// RC3 item 10 (Step 6) — rebuild implReviewFiles from the round ledger
// ---------------------------------------------------------------------------

void describe("resolveLedgerImplReviewFilesV1", () => {
  const implRow = (
    overrides: Partial<ImplReviewLedgerRowV1> & { roundId: string }
  ): ImplReviewLedgerRowV1 => ({
    mode: "implementation",
    state: "completed",
    outcome: { filesChanged: [] },
    ...overrides,
  });

  void it("unions filesChanged across all three implementation modes, most-recent round first", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [
        implRow({ roundId: "r1", mode: "implementation", outcome: { filesChanged: ["src/a.ts"] } }),
        implRow({ roundId: "r2", mode: "apply-review", outcome: { filesChanged: ["src/b.ts", "src/a.ts"] } }),
        implRow({ roundId: "r3", mode: "continuation", outcome: { filesChanged: [] } }),
      ],
      200
    );
    assert.deepEqual(result, { established: true, files: ["src/b.ts", "src/a.ts"] });
  });

  void it("ignores review rows entirely, live or terminal", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [
        implRow({ roundId: "r1", outcome: { filesChanged: ["src/a.ts"] } }),
        implRow({ roundId: "r2", mode: "review", state: "open", outcome: undefined }),
        { roundId: "r3", mode: "review", state: "completed", outcome: { filesChanged: ["src/should-not-appear.ts"] } },
      ],
      200
    );
    assert.deepEqual(result, { established: true, files: ["src/a.ts"] });
  });

  void it("a filesChangedUnknown round makes the ledger unavailable", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [implRow({ roundId: "r1", outcome: { filesChangedUnknown: true } })],
      200
    );
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /r1/);
      assert.match(result.reason, /no change list/);
    }
  });

  void it("an open implementation row makes the ledger unavailable, naming the row", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [
        implRow({ roundId: "r1", outcome: { filesChanged: ["src/a.ts"] } }),
        implRow({ roundId: "r2", state: "open", outcome: undefined }),
      ],
      200
    );
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /r2/);
      assert.match(result.reason, /open/);
    }
  });

  void it("a scheduled implementation row makes the ledger unavailable, naming the row", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [implRow({ roundId: "r9", state: "scheduled", outcome: undefined })],
      200
    );
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /r9/);
      assert.match(result.reason, /scheduled/);
    }
  });

  void it("a terminal row with filesChanged omitted (e.g. interrupted) makes the ledger unavailable", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [implRow({ roundId: "r1", state: "interrupted", outcome: {} })],
      200
    );
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /r1/);
      assert.match(result.reason, /no change list/);
    }
  });

  void it("a ledger at the retention cap is never trusted, whatever it contains", () => {
    const rows = [implRow({ roundId: "r1", outcome: { filesChanged: ["src/a.ts"] } })];
    const result = resolveLedgerImplReviewFilesV1(rows, 1);
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /retention cap/);
    }
  });

  void it("no implementation-mode rows at all is unavailable", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [{ roundId: "r1", mode: "review", state: "completed", outcome: { filesChanged: ["x"] } }],
      200
    );
    assert.equal(result.established, false);
  });

  void it("an empty ledger is unavailable", () => {
    assert.equal(resolveLedgerImplReviewFilesV1(undefined, 200).established, false);
    assert.equal(resolveLedgerImplReviewFilesV1([], 200).established, false);
  });

  void it("an established result can legitimately be an empty file set (no changes)", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [implRow({ roundId: "r1", outcome: { filesChanged: [] } })],
      200
    );
    assert.deepEqual(result, { established: true, files: [] });
  });
});
