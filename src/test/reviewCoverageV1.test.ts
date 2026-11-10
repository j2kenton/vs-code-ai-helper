/**
 * review2 Steps 17-20: the per-file review coverage record, the "Files not fully inspected" list, "Reviewed: N of M
 * changed files", the advance warning and the plateau card's "Review the remaining N files".
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";

import {
  describeUnreviewedFilesPopUpV1,
  moveNeedsUnreviewedFilesConfirmationV1,
} from "../commands/confirmUnreviewedFilesV1";
import type { ReviewCoverageV1 } from "../types/taskProgress";
import { readReviewCoverageSummaryV1 } from "../utils/reviewCoverageIoV1";
import {
  computeReviewCoverageV1,
  describeReviewedLineV1,
  describeUnreviewedConfirmationV1,
  describeUnreviewedWarningV1,
  hashFileContentV1,
  parseFilesNotFullyInspectedV1,
  recordReviewCoverageV1,
  stripFilesNotFullyInspectedV1,
  unreviewedConfirmLabelV1,
} from "../utils/reviewCoverageV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";

const NOW = "2026-11-09T12:00:00.000Z";

function hashes(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries).map(([file, content]) => [file, hashFileContentV1(content)]));
}

function record(
  changedFiles: string[],
  shown: string[],
  contents: Record<string, string>,
  notInspected: string[] = [],
  previous?: ReviewCoverageV1
): ReviewCoverageV1 {
  return recordReviewCoverageV1({
    record: previous,
    changedFiles,
    shownFiles: shown,
    notInspected,
    hashes: hashes(contents),
    runId: "run-1",
    stage: "impl-low-review",
    now: NOW,
  });
}

void describe("review coverage record (Steps 17 and 20)", () => {
  void it("a file read in full is recorded at its content hash with the run and stage", () => {
    const coverage = record(["src/a.ts"], ["src/a.ts"], { "src/a.ts": "one" });
    assert.deepEqual(coverage.files["src/a.ts"], { hash: hashFileContentV1("one"), runId: "run-1", stage: "impl-low-review" });
    assert.deepEqual(coverage.changedFiles, ["src/a.ts"]);
  });

  void it("a file changed after the review drops out of N", () => {
    const coverage = record(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"], { "src/a.ts": "one", "src/b.ts": "two" });
    const before = computeReviewCoverageV1(coverage, ["src/a.ts", "src/b.ts"], hashes({ "src/a.ts": "one", "src/b.ts": "two" }));
    assert.equal(before.reviewedCount, 2);
    const after = computeReviewCoverageV1(coverage, ["src/a.ts", "src/b.ts"], hashes({ "src/a.ts": "one", "src/b.ts": "two, edited" }));
    assert.equal(after.reviewedCount, 1);
    assert.deepEqual(after.unreviewed, ["src/b.ts"]);
    assert.equal(describeReviewedLineV1(after), "Reviewed: 1 of 2 changed files");
  });

  void it("a file the reviewer lists as not fully inspected does not count", () => {
    const coverage = record(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"], { "src/a.ts": "one", "src/b.ts": "two" }, ["src/b.ts"]);
    assert.equal(coverage.files["src/b.ts"], undefined);
    const summary = computeReviewCoverageV1(coverage, ["src/a.ts", "src/b.ts"], hashes({ "src/a.ts": "one", "src/b.ts": "two" }));
    assert.equal(summary.reviewedCount, 1);
  });

  void it("a file outside the pack (not shown) never counts, and a new file is unreviewed until a review reads it", () => {
    const coverage = record(["src/a.ts", "src/b.ts"], ["src/a.ts"], { "src/a.ts": "one", "src/b.ts": "two" });
    assert.equal(coverage.files["src/b.ts"], undefined);
    const summary = computeReviewCoverageV1(coverage, ["src/a.ts", "src/b.ts", "src/c.ts"], hashes({ "src/a.ts": "one", "src/b.ts": "two", "src/c.ts": "three" }));
    assert.equal(summary.changedCount, 3);
    assert.equal(summary.reviewedCount, 1);
  });

  void it("an earlier review's hash stays while a later review declines the file; once the file changes it is unreviewed", () => {
    const first = record(["src/a.ts"], ["src/a.ts"], { "src/a.ts": "one" });
    const second = record(["src/a.ts"], ["src/a.ts"], { "src/a.ts": "one, edited" }, ["src/a.ts"], first);
    assert.equal(second.files["src/a.ts"]?.hash, hashFileContentV1("one"), "the declined re-read leaves the earlier read in place");
    const summary = computeReviewCoverageV1(second, ["src/a.ts"], hashes({ "src/a.ts": "one, edited" }));
    assert.equal(summary.reviewedCount, 0);
  });

  void it("counts production files separately and lists them first among the unreviewed", () => {
    const summary = computeReviewCoverageV1(undefined, ["src/a.ts", "src/test/a.test.ts"], hashes({ "src/a.ts": "x", "src/test/a.test.ts": "y" }));
    assert.equal(summary.productionChangedCount, 1);
    assert.deepEqual(summary.unreviewedProduction, ["src/a.ts"]);
  });
});

void describe("the 'Files not fully inspected' list (Steps 17 and 20)", () => {
  const review = [
    "# Review",
    "",
    "## Files not fully inspected",
    "",
    "- `src/a.ts` (only the first 200 lines)",
    "- src/b.ts — skimmed",
    "",
    "## Non-blocking suggestions",
    "- none",
  ].join("\n");

  void it("reads backticked and plain bullets and stops at the next heading", () => {
    assert.deepEqual(parseFilesNotFullyInspectedV1(review), ["src/a.ts", "src/b.ts"]);
  });

  void it("'none' and an empty list name no file", () => {
    assert.deepEqual(parseFilesNotFullyInspectedV1("## Files not fully inspected\n\nnone\n"), []);
    assert.deepEqual(parseFilesNotFullyInspectedV1("## Files not fully inspected\n- none\n"), []);
    assert.deepEqual(parseFilesNotFullyInspectedV1("# Review\nNo list here."), []);
  });

  void it("a list copied from a previous review file is removed before the new review runs", () => {
    const stripped = stripFilesNotFullyInspectedV1(review);
    assert.doesNotMatch(stripped, /Files not fully inspected/);
    assert.doesNotMatch(stripped, /src\/a\.ts/);
    assert.match(stripped, /## Non-blocking suggestions/, "the rest of the review stays");
    assert.deepEqual(parseFilesNotFullyInspectedV1(stripped), []);
  });

  void it("a review with no such section is returned unchanged", () => {
    assert.equal(stripFilesNotFullyInspectedV1("# Review\nbody\n"), "# Review\nbody\n");
  });
});

void describe("the advance warning and its confirmation (Steps 19 and 20)", () => {
  const partial = computeReviewCoverageV1(undefined, ["src/a.ts", "src/b.ts", "src/test/a.test.ts"], hashes({ "src/a.ts": "x", "src/b.ts": "y", "src/test/a.test.ts": "z" }));
  const complete = computeReviewCoverageV1(
    record(["src/a.ts"], ["src/a.ts"], { "src/a.ts": "x" }),
    ["src/a.ts"],
    hashes({ "src/a.ts": "x" })
  );

  void it("warns with the unreviewed number only when N < M", () => {
    assert.match(describeUnreviewedWarningV1(partial) ?? "", /^3 changed files have not been reviewed \(Reviewed: 0 of 3 changed files\)\.$/);
    assert.equal(describeUnreviewedWarningV1(complete), undefined);
  });

  void it("the confirmation button names the number and the chat line records the choice", () => {
    assert.equal(unreviewedConfirmLabelV1(partial, "Advance to Publish"), "Advance to Publish with 3 files unreviewed");
    assert.match(describeUnreviewedConfirmationV1(partial, "Commit & Push"), /^You confirmed: Commit & Push with 3 files not reviewed/);
  });

  void it("the pop-up message says how many are production files and that nothing is lost", () => {
    const message = describeUnreviewedFilesPopUpV1(partial, "Advance to Publish");
    assert.match(message, /3 changed files have not been reviewed/);
    assert.match(message, /2 of them are production files/);
    assert.match(message, /Nothing is lost/);
  });

  void it("only a move into Publish needs the confirmation", () => {
    assert.equal(moveNeedsUnreviewedFilesConfirmationV1("publish"), true);
    assert.equal(moveNeedsUnreviewedFilesConfirmationV1("impl-low-review"), false);
  });
});

void describe("reading the summary from disk (Steps 18 and 20)", () => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "review-coverage-"));
  after(() => nodeFs.rmSync(root, { recursive: true, force: true }));

  void it("claims nothing for a task with no recorded coverage", async () => {
    assert.equal(await readReviewCoverageSummaryV1(root, { implReviewFiles: ["src/a.ts"] }), undefined);
  });

  void it("hashes the files now: a file edited after the review is unreviewed, and a file tracked since is added to M", async () => {
    nodeFs.mkdirSync(nodePath.join(root, "src"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(root, "src/a.ts"), "one");
    nodeFs.writeFileSync(nodePath.join(root, "src/b.ts"), "two");
    const coverage = record(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"], { "src/a.ts": "one", "src/b.ts": "two" });
    const same = await readReviewCoverageSummaryV1(root, { reviewCoverage: coverage, implReviewFiles: ["src/a.ts", "src/b.ts"] });
    assert.equal(describeReviewedLineV1(same!), "Reviewed: 2 of 2 changed files");
    nodeFs.writeFileSync(nodePath.join(root, "src/b.ts"), "two, edited");
    nodeFs.writeFileSync(nodePath.join(root, "src/c.ts"), "three");
    const later = await readReviewCoverageSummaryV1(root, { reviewCoverage: coverage, implReviewFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    assert.equal(describeReviewedLineV1(later!), "Reviewed: 1 of 3 changed files");
  });
});

void describe("the plateau card's coverage line and 'Review the remaining N files' (Steps 18, 19 and 20)", () => {
  const BASE = {
    blockersCount: 1,
    primaryBlockerDescription: "A defect.",
    allBlockerDescriptions: ["A defect."],
    narrowedNote: "",
    progressNote: "",
    taskFixableCount: 1,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: false,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 0,
  };
  const TARGET = { canonicalId: "c", taskFolderPath: "/t" };
  const partial = computeReviewCoverageV1(undefined, ["src/a.ts", "src/b.ts"], hashes({ "src/a.ts": "x", "src/b.ts": "y" }));

  void it("shows 'Reviewed: N of M changed files', offers and recommends reviewing the remaining files, and the option adds exactly the unreviewed files", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-low-review", "plateau", TARGET, { ...BASE, coverage: partial });
    assert.ok((card.evidence ?? []).some((e) => e.detail === "Reviewed: 0 of 2 changed files"));
    const option = card.options.find((o) => o.optionId === "reviewRemaining");
    assert.ok(option, "the option is offered");
    assert.equal(option.label, "Review the remaining 2 files");
    assert.equal(option.effect.kind, "command");
    if (option.effect.kind === "command") {
      assert.equal(option.effect.command, "vs-code-ai-helper.resolvePartialReviewScopeV1");
      assert.deepEqual(option.effect.args, [
        { taskFolderPath: "/t", stage: "impl-low-review", action: "addAndRereview", missingFiles: ["src/a.ts", "src/b.ts"], hash: "" },
      ]);
    }
    assert.ok(card.recommendation.kind === "option");
    assert.equal(card.recommendation.optionId, "reviewRemaining");
  });

  void it("a card with full coverage shows the line but neither offers nor recommends the option", () => {
    const full = computeReviewCoverageV1(
      record(["src/a.ts"], ["src/a.ts"], { "src/a.ts": "x" }),
      ["src/a.ts"],
      hashes({ "src/a.ts": "x" })
    );
    const card = buildEscalationDecisionV1("plateau", "impl-low-review", "plateau", TARGET, { ...BASE, coverage: full });
    assert.ok((card.evidence ?? []).some((e) => e.detail === "Reviewed: 1 of 1 changed files"));
    assert.equal(card.options.some((o) => o.optionId === "reviewRemaining"), false);
    assert.ok(card.recommendation.kind === "option");
    assert.notEqual(card.recommendation.optionId, "reviewRemaining");
  });

  void it("a card with no recorded coverage is unchanged", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-low-review", "plateau", TARGET, BASE);
    assert.equal(card.options.some((o) => o.optionId === "reviewRemaining"), false);
    assert.equal((card.evidence ?? []).some((e) => e.label === "Review coverage"), false);
  });
});
