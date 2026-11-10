/**
 * review2 Steps 18, 21-27: one partial-scope hold for both ways out of a review stage, an acceptance that applies to the
 * review already on record, and the wording around it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  buildPartialScopeDecisionInputV1,
  rememberPartialScopeGapV1,
  resolvePartialReviewScopeV1,
} from "../commands/partialScopeDecisionV1";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { describeFastForwardHoldV1 } from "../utils/fastForwardHoldV1";
import { buildAutomationStoppedCardInputV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import { hashWorkspaceFilesV1, readReviewCoverageSummaryV1 } from "../utils/reviewCoverageIoV1";
import { appendReviewedLineV1, recordReviewCoverageV1 } from "../utils/reviewCoverageV1";
import {
  PARTIAL_SCOPE_HOLD_REASON_V1,
  acceptPartialLabelV1,
  addAndRereviewLabelV1,
  describeAcceptedScopeChatLineV1,
  describePartialScopeNextClickV1,
  formatPartialScopeVerdictNoteV1,
  hashMissingFilesV1,
  mergeCarriedOmittedFirstV1,
  partialScopeHoldReasonV1,
  qualifyReviewForPartialScopeV1,
  type PartialReviewScopeV1,
  type PartialScopeAcceptanceV1,
  type PartialScopeGapRecordV1,
} from "../utils/reviewPartialScopeV1";
import { describeDoNothingChoiceV1 } from "../views/chatView";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-scope-hold-"));
after(() => {
  safeRemoveDir(ROOT);
});

const CUT_FILES = ["src/test/a.test.ts", "src/test/b.test.ts"];
const CUT_SCOPE: PartialReviewScopeV1 = {
  missingCount: 2,
  summary: "Reviewed 98 of 100 changed files",
  hash: hashMissingFilesV1(CUT_FILES),
  files: CUT_FILES,
  sizeLimitFiles: CUT_FILES,
};
const MISSING_SCOPE: PartialReviewScopeV1 = {
  missingCount: 1,
  summary: "Reviewed 9 of 10 changed files",
  hash: hashMissingFilesV1(["src/x.ts"]),
  files: ["src/x.ts"],
};

function gapOf(scope: PartialReviewScopeV1, stage = "impl-high-review" as const): PartialScopeGapRecordV1 {
  return { stage, scope, score: 9, threshold: 8, scoreClears: true, recordedAt: "2026-11-09T00:00:00.000Z" };
}

function acceptanceOf(scope: PartialReviewScopeV1, stage = "impl-high-review" as const): PartialScopeAcceptanceV1 {
  return { stage, hash: scope.hash, missingCount: scope.missingCount, acceptedAt: "2026-11-09T00:01:00.000Z" };
}

const HELD_REVIEW = "Readiness: 9/10\n" + formatPartialScopeVerdictNoteV1(CUT_SCOPE, false);

void describe("review2 Step 25: one hold for Fast Forward and Complete Stage & Move On", () => {
  void it("holds for an unaccepted partial verdict and names the card's exact buttons", () => {
    const reason = partialScopeHoldReasonV1({
      reviewContent: HELD_REVIEW,
      stage: "impl-high-review",
      gap: gapOf(CUT_SCOPE),
      acceptance: undefined,
    });
    assert.ok(reason?.startsWith(PARTIAL_SCOPE_HOLD_REASON_V1));
    assert.match(
      reason ?? "",
      /Choose on the card below: "Review the 2 cut files in a separate pass" or "Accept the partial scope \(2 files not reviewed\)"/
    );
  });

  void it("reads the acceptance record, not the note: a matching acceptance releases a note that was never rewritten", () => {
    assert.equal(
      partialScopeHoldReasonV1({
        reviewContent: HELD_REVIEW,
        stage: "impl-high-review",
        gap: gapOf(CUT_SCOPE),
        acceptance: acceptanceOf(CUT_SCOPE),
      }),
      undefined
    );
  });

  void it("an acceptance for another stage or another set of files does not release it", () => {
    const other = { ...acceptanceOf(CUT_SCOPE), stage: "impl-low-review" as const };
    assert.ok(
      partialScopeHoldReasonV1({ reviewContent: HELD_REVIEW, stage: "impl-high-review", gap: gapOf(CUT_SCOPE), acceptance: other })
    );
    const changedSet = { ...acceptanceOf(CUT_SCOPE), hash: hashMissingFilesV1(["src/test/c.test.ts"]) };
    assert.ok(
      partialScopeHoldReasonV1({ reviewContent: HELD_REVIEW, stage: "impl-high-review", gap: gapOf(CUT_SCOPE), acceptance: changedSet })
    );
  });

  void it("a review with no partial-scope marker never holds, and the note's own accepted sentence releases it", () => {
    assert.equal(
      partialScopeHoldReasonV1({ reviewContent: "Readiness: 9/10\n", stage: "impl-high-review", gap: gapOf(CUT_SCOPE), acceptance: undefined }),
      undefined
    );
    const accepted = "Readiness: 9/10\n" + formatPartialScopeVerdictNoteV1(CUT_SCOPE, true);
    assert.equal(
      partialScopeHoldReasonV1({ reviewContent: accepted, stage: "impl-high-review", gap: undefined, acceptance: undefined }),
      undefined
    );
  });

  void it("without a recorded gap the hold still holds, with the generic reason", () => {
    assert.equal(
      partialScopeHoldReasonV1({ reviewContent: HELD_REVIEW, stage: "impl-high-review", gap: undefined, acceptance: undefined }),
      PARTIAL_SCOPE_HOLD_REASON_V1
    );
  });

  void it("Fast Forward's start check and Complete Stage & Move On both call readPartialScopeHoldV1", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const calls = source.match(/readPartialScopeHoldV1\(/g) ?? [];
    assert.ok(calls.length >= 2, "both ways out read the same hold function");
    assert.match(source, /partialScopeHold: async \(\) => \{[\s\S]{0,700}readPartialScopeHoldV1\(/);
    assert.match(source, /export async function nextStage\([\s\S]{0,2500}readPartialScopeHoldV1\(/);
  });
});

void describe("review2 Step 27: the way on names the card's real buttons", () => {
  void it("for files the size limit cut, no 'Add' button is named", () => {
    const line = describePartialScopeNextClickV1(CUT_SCOPE);
    assert.match(line, /Accept the partial scope \(2 files not reviewed\)/);
    assert.doesNotMatch(line, /Add the/);
    assert.match(line, /no room for those files/);
  });

  void it("for a file missing from the list, both buttons are named, with the card's exact labels", () => {
    const line = describePartialScopeNextClickV1(MISSING_SCOPE);
    assert.ok(line.includes(`"${addAndRereviewLabelV1(1)}"`));
    assert.ok(line.includes(`"${acceptPartialLabelV1(1)}"`));
    assert.match(line, /Add the 1 missing file and review again/);
    assert.match(line, /1 file not reviewed/);
  });

  void it("the labels in the line are the labels the built card carries", () => {
    const card = buildPartialScopeDecisionInputV1({
      taskFolderPath: "/ws/.ensemble/t",
      stage: "impl-high-review",
      scope: MISSING_SCOPE,
      score: 9,
      threshold: 8,
    });
    const labels = card.options.map((option) => option.label);
    assert.ok(labels.includes(addAndRereviewLabelV1(1)));
    assert.ok(labels.includes(acceptPartialLabelV1(1)));
    assert.ok(labels.every((label) => !/\(Recommended\)/.test(label)));
  });

  void it("Fast Forward's stop line carries the detail's buttons instead of 'add the missing files'", () => {
    const detail = partialScopeHoldReasonV1({
      reviewContent: HELD_REVIEW,
      stage: "impl-high-review",
      gap: gapOf(CUT_SCOPE),
      acceptance: undefined,
    }) as string;
    const line = describeFastForwardHoldV1({ kind: "partial-scope", detail }, "High-Level Code Review", 0);
    assert.match(line, /Choose on the card below: "Review the 2 cut files in a separate pass" or "Accept the partial scope/);
    assert.doesNotMatch(line, /add the missing files/i);
    assert.doesNotMatch(line, /The way on is the decision card that follows\./);
  });

  void it("a 'Recorded:' line never says 'does nothing further' for an option that moves the task", () => {
    const moves = describeDoNothingChoiceV1("Advance to Publish anyway", "Moves the task to Publish on the older verdict.");
    assert.doesNotMatch(moves, /does nothing further/);
    assert.match(moves, /Moves the task to Publish/);
    const nothing = describeDoNothingChoiceV1("Keep the last review", "Dispatches nothing — the verdict stands.");
    assert.match(nothing, /this does nothing further/);
    assert.match(describeDoNothingChoiceV1("Not now", ""), /this does nothing further\.$/);
  });
});

void describe("review2 Step 24: what Accept says and does", () => {
  void it("says what was accepted, that the score now counts, and that it holds for this stage only", () => {
    const line = describeAcceptedScopeChatLineV1(["src/a.ts", "src/b.ts"], "moved-on", "Low-Level Code Review");
    assert.match(line, /^Accepted: src\/a\.ts, src\/b\.ts\. This review's score now counts\./);
    assert.match(line, /this stage only/);
    assert.match(line, /a later review that is cut at a different set asks again/);
    assert.match(line, /moves on to Low-Level Code Review with no new review/);
  });

  void it("tells the owner the next click when the review's own score still holds the stage", () => {
    assert.match(describeAcceptedScopeChatLineV1(["src/a.ts"], "kept-stage"), /no new review was started: continue with Apply Review/);
  });

  void it("rewriting the note makes the review read as accepted, and does it once", () => {
    const rewritten = qualifyReviewForPartialScopeV1(HELD_REVIEW, CUT_SCOPE, true);
    assert.match(rewritten, /The owner accepted this partial scope\./);
    assert.equal(qualifyReviewForPartialScopeV1(rewritten, CUT_SCOPE, true), rewritten);
  });

  void it("the card's Accept consequence says it applies at once and asks again for a different cut", () => {
    const card = buildPartialScopeDecisionInputV1({
      taskFolderPath: "/ws/.ensemble/t",
      stage: "impl-high-review",
      scope: CUT_SCOPE,
      score: 9,
      threshold: 8,
    });
    const accept = card.options.find((option) => option.optionId === "acceptPartial");
    assert.match(accept?.consequence ?? "", /applies that to this review at once/);
    assert.match(accept?.consequence ?? "", /no new review/);
    assert.match(accept?.consequence ?? "", /different set asks again/);
  });
});

void describe("review2 Step 21: files the last pass had no room for go first", () => {
  void it("carried-over omitted files come before the files a blocker names", () => {
    const merged = mergeCarriedOmittedFirstV1(["src/omitted.ts"], new Set(["src/blocker.ts", "src/omitted.ts"]));
    assert.deepEqual([...(merged ?? [])], ["src/omitted.ts", "src/blocker.ts"]);
  });

  void it("is undefined when there is nothing to prioritise", () => {
    assert.equal(mergeCarriedOmittedFirstV1(undefined, undefined), undefined);
    assert.equal(mergeCarriedOmittedFirstV1([], new Set()), undefined);
  });
});

function baseFacts(overrides: Partial<AutomationStopFactsV1> = {}): AutomationStopFactsV1 {
  return {
    taskFolderPath: "/ws/.ensemble/t",
    stage: "impl-high-review",
    ending: "fast-forward-cap",
    stopReason: "the round limit was reached",
    score: 7,
    blockers: { fixFirst: 1, buildToClear: 0, notThisRound: 0 },
    planItems: { total: 10, settled: 5, open: 5, provisional: 0 },
    buildNext: [],
    dismissedDependencies: [],
    reviewClean: false,
    gateComplete: false,
    fastForwardWasRunning: true,
    ...overrides,
  };
}

void describe("review2 Step 23: the automation-stopped card", () => {
  void it("recommends Start Fast Forward when nothing would stop it", () => {
    const card = buildAutomationStoppedCardInputV1(baseFacts());
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : "", "startFastForward");
  });

  void it("never recommends Start Fast Forward while an open hold would stop it at once; it recommends what can run", () => {
    const card = buildAutomationStoppedCardInputV1(baseFacts({ startHold: PARTIAL_SCOPE_HOLD_REASON_V1 }));
    assert.equal(card.recommendation?.kind, "option");
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : "", "runOneMoreCycle");
    assert.match(card.recommendation?.reasoning ?? "", /Fast Forward would stop at once/);
  });

  void it("a card that says it does not choose has no recommendation, and one with a recommendation does not say so", () => {
    const none = buildAutomationStoppedCardInputV1(baseFacts({ ending: "stop-rule" }));
    assert.equal(none.recommendation?.kind, "none");
    assert.match(none.whyUserNeeded, /does not choose between these next steps/);
    const some = buildAutomationStoppedCardInputV1(baseFacts());
    assert.equal(some.recommendation?.kind, "option");
    assert.doesNotMatch(some.whyUserNeeded, /does not choose/);
  });
});

void describe("review2 Step 18: 'Reviewed: N of M changed files' on the stage row", () => {
  void it("appendReviewedLineV1 puts the coverage line after the score and keeps a bare line when there is no score", () => {
    assert.equal(appendReviewedLineV1("8/10", "Reviewed: 40 of 206 changed files"), "8/10 · Reviewed: 40 of 206 changed files");
    assert.equal(appendReviewedLineV1(undefined, "Reviewed: 1 of 1 changed files"), "Reviewed: 1 of 1 changed files");
    assert.equal(appendReviewedLineV1("8/10", undefined), "8/10");
  });

  void it("the tree-row count follows the files' content: an edit after the review drops a file out of N", async () => {
    const folder = fs.mkdtempSync(path.join(ROOT, "ws-"));
    fs.mkdirSync(path.join(folder, "src"), { recursive: true });
    fs.writeFileSync(path.join(folder, "src", "a.ts"), "one");
    fs.writeFileSync(path.join(folder, "src", "b.ts"), "two");
    const files = ["src/a.ts", "src/b.ts"];
    const hashes = await hashWorkspaceFilesV1(folder, files);
    const record = recordReviewCoverageV1({
      record: undefined,
      changedFiles: files,
      shownFiles: files,
      notInspected: [],
      hashes,
      runId: "run-1",
      stage: "impl-high-review",
      now: "2026-11-09T00:00:00.000Z",
    });
    const progress = { implReviewFiles: files, reviewCoverage: record };
    const cache = new Map();
    const first = await readReviewCoverageSummaryV1(folder, progress, cache);
    assert.equal(first?.reviewedCount, 2);
    assert.equal(first?.changedCount, 2);
    // Same size, new content: the cache is keyed on size and mtime, so move the mtime forward as an edit would.
    fs.writeFileSync(path.join(folder, "src", "b.ts"), "TWO");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(folder, "src", "b.ts"), later, later);
    const second = await readReviewCoverageSummaryV1(folder, progress, cache);
    assert.equal(second?.reviewedCount, 1, "the edited file no longer counts as reviewed");
    assert.deepEqual(second?.unreviewed, ["src/b.ts"]);
  });

  void it("the Tasks tree passes the line into StageNode for the review stages and Publish only", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "views", "taskTreeProvider.ts"), "utf8");
    assert.match(source, /IMPL_REVIEW_STAGES\.includes\(stage\) \|\| stage === "publish"/);
    assert.match(source, /reviewedLine = coverageSummary === undefined \? undefined : describeReviewedLineV1\(coverageSummary\)/);
    assert.match(source, /this\.description = appendReviewedLineV1\(this\.description, reviewedLine\)/);
  });

  void it("every implementation review leaves the line in the chat when it ends", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(source, /await postReviewedLineAfterReviewV1\(folderUri, targetStage\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Accept applies to the review on record (Step 24): driven through the real command over a temp folder.
// ---------------------------------------------------------------------------------------------------------------

/** Bridge the vscode-stub file system onto the real disk for the duration of a test. */
function installDiskBridgeV1(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...fsObj };
  const notFound = (uri: vscode.Uri): Error =>
    Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" });
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then(
      (buf) => new Uint8Array(buf),
      () => Promise.reject(notFound(uri))
    );
  fsObj.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, data);
  };
  fsObj.stat = (uri: vscode.Uri): Promise<unknown> =>
    fs.promises.stat(uri.fsPath).then(
      (s) => ({ type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: 0, size: s.size }),
      () => Promise.reject(notFound(uri))
    );
  fsObj.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  fsObj.delete = (uri: vscode.Uri): Promise<void> => fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  fsObj.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
  return {
    restore: (): void => {
      Object.assign(fsObj, orig);
    },
  };
}

interface AcceptRunV1 {
  readonly commands: string[];
  readonly review: string;
  readonly acceptanceWritten: boolean;
}

async function runAcceptV1(options: { gap: PartialScopeGapRecordV1 | undefined }): Promise<AcceptRunV1> {
  const folder = fs.mkdtempSync(path.join(ROOT, "task-"));
  const bridge = installDiskBridgeV1();
  const commandsStub = vscode.commands as unknown as { _executeCommandOverride?: (id: string, ...args: unknown[]) => unknown };
  const before = commandsStub._executeCommandOverride;
  const commands: string[] = [];
  commandsStub._executeCommandOverride = (id: string): unknown => {
    commands.push(id);
    return undefined;
  };
  try {
    const reviewName = STAGE_ARTIFACT_FILENAMES["impl-high-review"] ?? "impl-high-review.md";
    fs.writeFileSync(path.join(folder, reviewName), HELD_REVIEW);
    if (options.gap !== undefined) {
      await rememberPartialScopeGapV1(folder, {
        stage: options.gap.stage,
        scope: options.gap.scope,
        score: options.gap.score,
        threshold: options.gap.threshold,
        scoreClears: options.gap.scoreClears,
      });
    }
    await resolvePartialReviewScopeV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      action: "accept",
      missingFiles: CUT_FILES,
      hash: CUT_SCOPE.hash,
    });
    return {
      commands,
      review: fs.readFileSync(path.join(folder, reviewName), "utf8"),
      acceptanceWritten: fs.existsSync(path.join(folder, "review-scope-accepted-v1.json")),
    };
  } finally {
    commandsStub._executeCommandOverride = before;
    bridge.restore();
  }
}

void describe("review2 Step 24: Accept on the review that is already there", () => {
  void it("a passing review: the note is rewritten at once and the stage moves on, with no new review", async () => {
    const run = await runAcceptV1({ gap: gapOf(CUT_SCOPE) });
    assert.equal(run.acceptanceWritten, true);
    assert.match(run.review, /The owner accepted this partial scope\./);
    assert.deepEqual(run.commands, ["vs-code-ai-helper.nextStage"], "advances; never runs the review again");
    assert.equal(
      partialScopeHoldReasonV1({ reviewContent: run.review, stage: "impl-high-review", gap: gapOf(CUT_SCOPE), acceptance: acceptanceOf(CUT_SCOPE) }),
      undefined,
      "both exit paths read no hold after the acceptance"
    );
  });

  void it("a review whose own score does not clear the stage gets the note but no advance and no re-run", async () => {
    const run = await runAcceptV1({ gap: { ...gapOf(CUT_SCOPE), scoreClears: false } });
    assert.match(run.review, /The owner accepted this partial scope\./);
    assert.deepEqual(run.commands, []);
  });

  void it("with no recorded gap the answer is recorded and the review runs again, as before", async () => {
    const run = await runAcceptV1({ gap: undefined });
    assert.equal(run.acceptanceWritten, true);
    assert.deepEqual(run.commands, ["vs-code-ai-helper.runReviewWithAI"]);
  });

  void it("an acceptance for a different gap than the review's does not rewrite the review", async () => {
    const run = await runAcceptV1({ gap: gapOf(MISSING_SCOPE) });
    assert.doesNotMatch(run.review, /The owner accepted this partial scope\./);
    assert.deepEqual(run.commands, ["vs-code-ai-helper.runReviewWithAI"]);
  });
});
