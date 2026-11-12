/**
 * review1 Steps 29-33 and 35: every stop says why and offers the next step; the lost-round card continues what was
 * lost; the reviewer-verified ticks card matches the task's state; repeated report rejections reach the owner.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import * as os from "node:os";
import * as vscode from "vscode";

import { readReviewCleanFactsV1 } from "../commands/automationStoppedCardV1";
import {
  adaptVerifiedTicksCardToFastForwardStateV1,
  buildLedgerBackedFastForwardResumeV1,
  buildOwnerStartedFastForwardResumeV1,
  decideLedgerBackedFastForwardResumeV1,
} from "../commands/fastForwardResumeSuffixV1";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { buildStalledTaskEscalationDecisionV1 } from "../commands/scheduleTaskResume";
import {
  APPLY_OPTION_ID_V1,
  APPLY_TICKS_DECISION_KEY_V1,
  APPLY_TICKS_NOW_OPTION_ID_V1,
  buildHeldTicksAnswerOptionsV1,
} from "../commands/verifiedTicksHeldOptionsV1";
import type { ReportContractRejectionV1, RoundLedgerEntryV1, TaskProgress } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  clearFastForwardRunActiveV1,
  fastForwardRoundFieldsV1,
  fastForwardRoundStampV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
import {
  AUTOMATION_STOPPED_DECISION_KEY_V1,
  buildAutomationStoppedCardInputV1,
  extractBuildNextLinesV1,
  recommendNextStepV1,
  type AutomationStopFactsV1,
} from "../utils/automationStopV1";
import {
  buildLostEditingRoundCardPartsV1,
  failureWillRepeatV1,
  findContinuableLostEditingRoundV1,
} from "../utils/lostRoundNextStepV1";
import {
  appendReportContractRejectionV1,
  formatRepeatedRejectionLineV1,
  selectRepeatedRejectionV1,
} from "../utils/reportContractRejectionsV1";
import { planResumeActionV1, type ResumeActionFactsV1 } from "../utils/resumeActionPlanV1";
import { reviewPredatesLatestImplementationRoundV1 } from "../utils/reviewReadiness";

const TASK = "/work/tasks/review1";
const BASE_FACTS: AutomationStopFactsV1 = {
  taskFolderPath: TASK,
  stage: "impl-high-review",
  ending: "one-cycle",
  stopReason: "the one cycle you chose is done",
  score: 7,
  previousScore: 6,
  blockers: { fixFirst: 1, buildToClear: 1, notThisRound: 1 },
  planItems: { total: 140, settled: 133, open: 4, provisional: 3 },
  buildNext: ["Build Steps 22-27", "Fix the two named defects"],
  dismissedDependencies: [],
  reviewClean: false,
  gateComplete: false,
  fastForwardWasRunning: false,
};

function facts(over: Partial<AutomationStopFactsV1>): AutomationStopFactsV1 {
  return { ...BASE_FACTS, ...over };
}

void describe("the automation-stopped card (Steps 29-30)", () => {
  void it("says why it stopped, where things stand, and offers the next steps with the one that moves the task recommended", () => {
    const card = buildAutomationStoppedCardInputV1(BASE_FACTS);
    assert.equal(card.decisionKey, AUTOMATION_STOPPED_DECISION_KEY_V1, "one decision key per task, so each new card replaces the last");
    assert.match(card.whatHappened, /the one cycle you chose is done/);
    assert.match(card.whatHappened, /scored 7\/10, up from 6\/10/);
    assert.match(card.whatHappened, /3 blockers left: 1 to fix first, 1 that building the named plan steps clears, 1 that another round cannot move/);
    assert.match(card.whatHappened, /133 of 140 plan items are settled; 7 left \(4 to build, 3 built but not yet checked\)/);
    assert.match(card.whatHappened, /1\. Build Steps 22-27 2\. Fix the two named defects/);
    assert.deepEqual(card.options.map((o) => o.optionId), ["startFastForward", "runOneMoreCycle", "leaveWithMe"]);
    assert.deepEqual(card.recommendation.kind === "option" && card.recommendation.optionId, "startFastForward");
    const oneCycle = card.options.find((o) => o.optionId === "runOneMoreCycle")!;
    assert.match(oneCycle.consequence, /then stops/, "a one-cycle option says on the card that it stops after one cycle");
  });

  void it("offers Move on only when the gate is complete and the review is clean, and recommends it then", () => {
    const ready = buildAutomationStoppedCardInputV1(
      facts({ ending: "stage-ready", stopReason: "After your tick, every plan item is now settled and the latest review is clean", reviewClean: true, gateComplete: true, blockers: { fixFirst: 0, buildToClear: 0, notThisRound: 0 }, planItems: { total: 48, settled: 48, open: 0, provisional: 0 } })
    );
    assert.match(ready.whatHappened, /^Low-Level Code Review is done|^High-Level Code Review is done/);
    assert.ok(ready.options.some((o) => o.optionId === "moveOn" && /Move on to Low-Level Code Review/.test(o.label)));
    assert.deepEqual(ready.recommendation.kind === "option" && ready.recommendation.optionId, "moveOn");
    // bugs7 item 6: on a stage that is done, Fast Forward and a one-cycle round would stop at once, so neither is offered.
    // Moving on and Fast Forward in the next review stage is offered when the next stage is a review stage.
    const nextIsReview = ready.options.some((o) => o.optionId === "moveOnAndFastForward");
    assert.deepEqual(ready.options.map((o) => o.optionId), nextIsReview ? ["moveOn", "moveOnAndFastForward", "leaveWithMe"] : ["moveOn", "leaveWithMe"]);
    assert.ok(
      ready.options.every((o) => o.optionId !== "startFastForward" && o.optionId !== "runOneMoreCycle"),
      "no option dispatches a run that cannot do anything on a done stage"
    );
    const notReady = buildAutomationStoppedCardInputV1(BASE_FACTS);
    assert.ok(!notReady.options.some((o) => o.optionId === "moveOn"), "no Move on while plan work or blockers remain");
  });

  void it("recommends leaving it to the owner when only blockers no round can move are left, and nothing after a stalled run", () => {
    assert.equal(recommendNextStepV1(facts({ blockers: { fixFirst: 0, buildToClear: 0, notThisRound: 2 }, planItems: { total: 10, settled: 8, open: 0, provisional: 2 } })), "leaveWithMe");
    assert.equal(recommendNextStepV1(facts({ ending: "fast-forward-stalled" })), undefined);
    assert.equal(recommendNextStepV1(facts({ stage: "impl", ending: "fast-forward-cap" })), "continueTheWork");
    const stalled = buildAutomationStoppedCardInputV1(facts({ ending: "fast-forward-stalled" }));
    assert.equal(stalled.recommendation.kind, "none", "no forward option is recommended over the owner's judgement when nothing moved");
  });

  void it("mentions a dismissed card something still depends on", () => {
    const card = buildAutomationStoppedCardInputV1(
      facts({ dismissedDependencies: ["the provider refused the test command `pnpm test`, so 3 built plan items stay unchecked."] })
    );
    assert.match(card.whatHappened, /Still outstanding from a card you dismissed: the provider refused the test command/);
  });

  void it("pulls the review's Build next and Next step lines, shortened", () => {
    const review = "# Review\n\n## Build next, in this order\n\n1. Build Step 22\n2. Build Step 23\n\n## Notes\n- nothing";
    assert.deepEqual(extractBuildNextLinesV1(review), ["Build Step 22", "Build Step 23"]);
    assert.deepEqual(extractBuildNextLinesV1("**Next step:** no code changes are needed; re-run the 12 test files."), [
      "no code changes are needed; re-run the 12 test files.",
    ]);
    assert.deepEqual(extractBuildNextLinesV1("nothing here"), []);
  });
});

void describe("an unreadable plan count is never read as a complete gate (Step 29)", () => {
  const unknown = facts({
    ending: "fast-forward-cap",
    reviewClean: true,
    gateComplete: false,
    planCountUnavailable: true,
    blockers: { fixFirst: 0, buildToClear: 0, notThisRound: 0 },
  });
  delete (unknown as { planItems?: unknown }).planItems;

  void it("the card says the count could not be read, offers no Move on, and recommends nothing false", () => {
    const card = buildAutomationStoppedCardInputV1(unknown);
    assert.match(card.whatHappened, /plan's item count could not be read just now/);
    assert.ok(!card.options.some((o) => o.optionId === "moveOn"), "an unknown gate never offers Move on");
    assert.equal(card.recommendation.kind, "none");
    assert.equal(recommendNextStepV1(unknown), undefined);
    assert.ok(card.options.some((o) => o.optionId === "leaveWithMe"), "the owner still has a way out");
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stop-gate-"));
  // The stubbed workspace.fs reads nothing by default; read the real temp files, and put the stub back afterwards.
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  before(() => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
  });
  after(() => {
    fsApi.readFile = origReadFile;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const CLEAN_REVIEW = "Readiness: 9/10\n\nNo blockers.\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";
  const folderWith = (name: string, plan: string | undefined): vscode.Uri => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "impl-high-review.md"), CLEAN_REVIEW, "utf8");
    if (plan !== undefined) fs.writeFileSync(path.join(folder, "plan-final.md"), plan, "utf8");
    return vscode.Uri.file(folder);
  };

  void it("a clean review with a plan that cannot be read leaves the gate incomplete, so the stage is not called ready", async () => {
    const result = await readReviewCleanFactsV1(folderWith("no-plan", undefined), "impl-high-review");
    assert.equal(result.reviewClean, true);
    assert.equal(result.gateComplete, false, "a missing or unreadable plan says nothing about the work");
  });

  void it("a plan that is readable and has no countable checklist has nothing to gate", async () => {
    const result = await readReviewCleanFactsV1(folderWith("no-checklist", "# Plan\n\nNothing to tick here.\n"), "impl-high-review");
    assert.equal(result.reviewClean, true);
    assert.equal(result.gateComplete, true);
  });

  void it("a plan with an open item is incomplete", async () => {
    const plan = "<!-- ensemble:implementation-checklist -->\n\n- [ ] Step 1: Build it\n";
    const result = await readReviewCleanFactsV1(folderWith("open-item", plan), "impl-high-review");
    assert.equal(result.gateComplete, false);
  });
});

void describe("every automation ending with work left raises the card (Step 30)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
  void it("Fast Forward's stalled, cap, improved-but-stopped and zero-fixable endings each post it, never when the owner cancelled", () => {
    for (const ending of ["fast-forward-stalled", "fast-forward-cap", "improved-but-stopped"]) {
      assert.ok(source.includes(`"${ending}"`), `reviewActions.ts posts the ${ending} ending`);
    }
    assert.match(source, /ownerCancelled: op\.token\?\.isCancellationRequested === true/);
  });
  void it("the Publish-clean silent return, a resumed run's end and the one-cycle re-review each post it", () => {
    assert.match(source, /ending: "publish-clean"/);
    assert.match(source, /ending: "resumed-run"/);
    assert.match(source, /ending: "one-cycle"/);
    assert.match(source, /decision\.route === "iterate" && options\.chainedReReview === true && !isFastForwardRunActiveV1/);
  });
  void it("bugs7 item 3: a review that ends below the threshold with nothing running posts the review-ended card, inside no Fast Forward or automation dispatch", () => {
    assert.match(source, /ending: "review-ended"/);
    assert.match(
      source,
      /options\.chainedReReview !== true && !isFastForwardRunActiveV1\(folderUri\.fsPath\) && !isAutomationDispatchContextV1\(\)/
    );
    // The chained one-cycle review keeps its own card, so the two never both post.
    assert.match(source, /decision\.route === "iterate" && options\.chainedReReview === true/);
  });
  void it("bugs7 item 3: the review-ended card names the review's work and offers Apply Review or Fast Forward as the next click", () => {
    const card = buildAutomationStoppedCardInputV1(
      facts({
        ending: "review-ended",
        stopReason: "the review scored 7/10, below the 8 needed, and nothing is running",
        buildNext: ["Build Step 12's rewording"],
        reviewClean: false,
        gateComplete: false,
      })
    );
    assert.match(card.whatHappened, /^High-Level Code Review: the review scored 7\/10/);
    assert.doesNotMatch(card.whatHappened, /Automation stopped/);
    assert.match(card.whatHappened, /Build Step 12's rewording/);
    const ids = card.options.map((o) => o.optionId);
    assert.ok(ids.includes("startFastForward") && ids.includes("runOneMoreCycle"), "a click that moves it is on the card");
    assert.equal(card.recommendation.kind, "option");
  });
  void it("a hold or a pause already carries its own card, so only the four non-held endings call the helper", () => {
    const calls = source.match(/postFfStopCardV1\(/g) ?? [];
    assert.equal(calls.length, 4, "improved, zero-fixable, stalled and cap: one call each");
  });
});

void describe("replay of review1 item 2: an Apply Review cut off after 55 minutes (Step 32)", () => {
  const cutOffRow = (over: Partial<RoundLedgerEntryV1> = {}): RoundLedgerEntryV1 =>
    ({
      roundId: "r-lost",
      attemptIds: [],
      stage: "impl-high-review",
      mode: "apply-review",
      startedAt: "2026-11-02T06:42:00.000Z",
      endedAt: "2026-11-02T07:37:55.000Z",
      state: "failed",
      outcome: { rejectionReason: "Antigravity turn limit: cut off after 55 minutes", filesChanged: ["a.ts", "b.ts"] },
      ...over,
    }) as RoundLedgerEntryV1;
  const reviewedProgress = (rows: RoundLedgerEntryV1[]): Pick<TaskProgress, "roundLedger" | "reviewScoreHistory"> => ({
    roundLedger: rows,
    reviewScoreHistory: [{ stage: "impl-high-review", score: 7, at: "2026-11-02T06:38:00.000Z", blockerCount: 3, taskFixableCount: 3 } as never],
  });

  void it("finds the lost editing round while its review is still the latest, and not a lost review", () => {
    const lost = findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow()]), "impl-high-review");
    assert.equal(lost?.mode, "apply-review");
    assert.match(lost?.failure ?? "", /55 minutes/);
    assert.equal(findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow({ mode: "review" })]), "impl-high-review"), undefined);
    assert.equal(findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow({ state: "completed" })]), "impl-high-review"), undefined);
    assert.equal(findContinuableLostEditingRoundV1({ roundLedger: [cutOffRow()], reviewScoreHistory: [] }, "impl-high-review"), undefined, "no review on record to continue against");
  });

  void it("the lost round's own edits no longer make its review count as stale; a completed round's still do", () => {
    const progress = { ...reviewedProgress([cutOffRow()]), stageReviewPasses: { "impl-high-review": 1 } } as never as Parameters<typeof reviewPredatesLatestImplementationRoundV1>[0];
    (progress as { reviewScoreHistory: unknown[] }).reviewScoreHistory = [
      { stage: "impl-high-review", score: 7, at: "2026-11-02T06:38:00.000Z", reviewPass: 1, blockerCount: 3, taskFixableCount: 3 },
    ];
    assert.equal(reviewPredatesLatestImplementationRoundV1(progress, "impl-high-review"), true);
    assert.equal(reviewPredatesLatestImplementationRoundV1(progress, "impl-high-review", { ignoreLostEditingRounds: true }), false);
    const completed = { ...progress, roundLedger: [cutOffRow({ state: "completed" })] };
    assert.equal(reviewPredatesLatestImplementationRoundV1(completed, "impl-high-review", { ignoreLostEditingRounds: true }), true);
  });

  void it("the resume plan continues the Apply Review instead of sending the task back through a fresh review", () => {
    const review = "Readiness: 7/10\n\n## Blockers\n- [task-fixable] [defect] Build Steps 22-27.\n";
    const base: ResumeActionFactsV1 = {
      stage: "impl-high-review",
      nextActor: "automation",
      reviewContent: review,
      headSha: undefined,
      unmet: {},
      providers: { review: "Claude Code", apply: "Gemini Flash" },
    };
    const lost = findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow()]), "impl-high-review")!;
    const plan = planResumeActionV1({ ...base, lostEditingRound: lost });
    assert.equal(plan.kind, "apply-review");
    assert.match((plan as { label: string }).label, /Continue the Apply Review from the working tree \(its edits are kept\)/);
    const staleReview = planResumeActionV1({ ...base, reviewContent: `${review}\n<!-- stale -->`, reviewPassCurrent: false });
    assert.equal(staleReview.kind === "run-review", true, "a lost REVIEW round (no lost editing round) still recommends running the review");
  });

  void it("the card names the failure, recommends continuing, offers another enabled model and a fresh review and leaving it paused", () => {
    const lost = findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow()]), "impl-high-review")!;
    const parts = buildLostEditingRoundCardPartsV1({
      taskFolderPath: TASK,
      stage: "impl-high-review",
      lost,
      continueLabel: "Continue the Apply Review from the working tree (its edits are kept) (Gemini Flash)",
      chainModels: ["antigravity-cli:gemini-3.8-flash-high", "claude-cli:claude-sonnet-5-5"],
      lostModel: "antigravity-cli:gemini-3.8-flash-high",
    });
    assert.match(parts.sentence, /Apply Review failed/);
    assert.match(parts.sentence, /Its edits are kept in the working tree/);
    assert.deepEqual(parts.options.map((o) => o.optionId), ["continueLostRound", "changeModel", "freshReview", "handleMyself"]);
    assert.deepEqual(parts.recommendation.kind === "option" && parts.recommendation.optionId, "continueLostRound");
    const change = parts.options.find((o) => o.optionId === "changeModel")!;
    assert.match(change.consequence, /claude-cli:claude-sonnet-5-5/, "names the other enabled model");
    assert.ok(!/gemini-3\.8-flash-high/.test(change.consequence), "the model that failed is not offered");
    const onlyOne = buildLostEditingRoundCardPartsV1({
      taskFolderPath: TASK, stage: "impl-high-review", lost, continueLabel: "Continue", chainModels: ["antigravity-cli:gemini-3.8-flash-high"], lostModel: "antigravity-cli:gemini-3.8-flash-high",
    });
    assert.match(onlyOne.options.find((o) => o.optionId === "changeModel")!.label, /No other model is enabled/);
    assert.ok(failureWillRepeatV1("failed", "cut off after 55 minutes"));
    assert.ok(failureWillRepeatV1("failed", "Please sign in again (401)"));
    assert.ok(!failureWillRepeatV1("failed", "TypeError: x is not a function"));
  });

  void it("through the real caller: a clean-and-complete review drops Apply Review, and a live Fast Forward run is resumed", () => {
    const target = { canonicalId: "task-id", taskFolderPath: TASK, stage: "impl-high-review" as const, taskName: "review1" };
    // A round opened by an Ensemble that stamps every round: no run stamp means it was not part of a Fast Forward run.
    const progress = { ...reviewedProgress([cutOffRow({ fastForwardStampedV1: true })]), taskFolder: "t", currentStage: "impl-high-review", status: "active" } as unknown as TaskProgress;
    const plan = { kind: "apply-review" as const, label: "Continue the Apply Review from the working tree (its edits are kept) (Gemini Flash)" } as never;

    const plain = buildStalledTaskEscalationDecisionV1(false, target, plan, progress);
    assert.equal(plain.recommendation.kind === "option" && plain.recommendation.optionId, "continueLostRound");
    const plainContinue = plain.options.find((o) => o.optionId === "continueLostRound")!;
    assert.match(plainContinue.consequence, /runs one cycle and stops/);
    assert.ok(!JSON.stringify(plainContinue.effect).includes("resumeFastForwardV1"));

    const clean = buildStalledTaskEscalationDecisionV1(false, target, plan, progress, { reviewClean: true, gateComplete: true });
    assert.ok(!clean.options.some((o) => o.optionId === "continueLostRound"), "a clean review never recommends or offers Apply Review");
    assert.equal(clean.recommendation.kind, "none");
    assert.ok(clean.options.some((o) => o.optionId === "freshReview"));

    markFastForwardRunActiveV1(TASK, { attemptNumber: 3, maxAttempts: 10 });
    try {
      const ff = buildStalledTaskEscalationDecisionV1(false, target, plan, progress, {
        fastForwardState: { attemptNumber: 3, maxAttempts: 10 },
      });
      const ffContinue = ff.options.find((o) => o.optionId === "continueLostRound")!;
      assert.match(ffContinue.consequence, /resumes the Fast Forward run/i);
      assert.ok(JSON.stringify(ffContinue.effect).includes("resumeFastForwardV1"), "continuing carries the captured run so Fast Forward resumes");
    } finally {
      clearFastForwardRunActiveV1(TASK);
    }
  });

  void it("never recommends Apply Review when the latest review is clean and every item is settled", () => {
    const lost = findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow()]), "impl-high-review")!;
    const parts = buildLostEditingRoundCardPartsV1({
      taskFolderPath: TASK, stage: "impl-high-review", lost, continueLabel: "Continue", chainModels: [], reviewClean: true, gateComplete: true,
    });
    assert.equal(parts.recommendation.kind, "none");
    assert.ok(!parts.options.some((o) => o.optionId === "continueLostRound"));
  });

  void it("a clean review never recommends Apply Review even when plan items are still open or provisional", () => {
    const lost = findContinuableLostEditingRoundV1(reviewedProgress([cutOffRow()]), "impl-high-review")!;
    const parts = buildLostEditingRoundCardPartsV1({
      taskFolderPath: TASK, stage: "impl-high-review", lost, continueLabel: "Continue", chainModels: [], reviewClean: true, gateComplete: false,
    });
    assert.equal(parts.recommendation.kind, "none", "a clean review with a provisional test item gets no Apply Review recommendation");
    assert.ok(parts.options.some((o) => o.optionId === "continueLostRound"), "the owner may still choose to continue the build");
    assert.ok(parts.options.some((o) => o.optionId === "freshReview"));

    // Through the real caller.
    const target = { canonicalId: "task-id", taskFolderPath: TASK, stage: "impl-high-review" as const, taskName: "review1" };
    const progress = { ...reviewedProgress([cutOffRow()]), taskFolder: "t", currentStage: "impl-high-review", status: "active" } as unknown as TaskProgress;
    const plan = { kind: "apply-review" as const, label: "Continue the Apply Review from the working tree (its edits are kept) (Gemini Flash)" } as never;
    const card = buildStalledTaskEscalationDecisionV1(false, target, plan, progress, { reviewClean: true, gateComplete: false });
    assert.equal(card.recommendation.kind, "none");
    assert.match(card.gating?.detail ?? "", /Choosing Continue resumes the task/);
  });

  void it("a lost Fast Forward round still resumes Fast Forward after the live run state is gone", () => {
    const target = { canonicalId: "task-id", taskFolderPath: TASK, stage: "impl-high-review" as const, taskName: "review1" };
    const stamped = cutOffRow({ fastForwardRunV1: { attemptNumber: 4, maxAttempts: 10 } });
    const progress = { ...reviewedProgress([stamped]), taskFolder: "t", currentStage: "impl-high-review", status: "paused" } as unknown as TaskProgress;
    const plan = { kind: "apply-review" as const, label: "Continue the Apply Review from the working tree (its edits are kept) (Gemini Flash)" } as never;

    clearFastForwardRunActiveV1(TASK); // the run ended or the window reloaded: no live state
    const card = buildStalledTaskEscalationDecisionV1(false, target, plan, progress);
    const cont = card.options.find((o) => o.optionId === "continueLostRound")!;
    assert.match(cont.consequence, /resumes the Fast Forward run/i);
    const args = (cont.effect as unknown as { args: Array<{ resumeFastForwardV1?: Record<string, unknown> }> }).args[0];
    assert.equal(args?.resumeFastForwardV1?.attemptNumber, 4);
    assert.equal(args?.resumeFastForwardV1?.maxAttempts, 10);
    assert.equal(args?.resumeFastForwardV1?.fastForwardLedgerRoundIdV1, stamped.roundId);

    const notFastForward = { ...progress, roundLedger: [cutOffRow({ fastForwardStampedV1: true })] } as unknown as TaskProgress;
    const plain = buildStalledTaskEscalationDecisionV1(false, target, plan, notFastForward);
    assert.match(plain.options.find((o) => o.optionId === "continueLostRound")!.consequence, /runs one cycle and stops/);
    assert.ok(!plain.options.some((o) => o.optionId === "continueLostRoundWithFastForward"), "the record says it was not a run, so nothing is guessed");
  });

  void it("a round opened before stamps existed: the card says it cannot tell and recommends continuing with Fast Forward", () => {
    const target = { canonicalId: "task-id", taskFolderPath: TASK, stage: "impl-high-review" as const, taskName: "review1" };
    const unstamped = cutOffRow();
    const progress = { ...reviewedProgress([unstamped]), taskFolder: "t", currentStage: "impl-high-review", status: "paused" } as unknown as TaskProgress;
    const plan = { kind: "apply-review" as const, label: "Continue the Apply Review from the working tree (its edits are kept) (Gemini Flash)" } as never;

    clearFastForwardRunActiveV1(TASK);
    const card = buildStalledTaskEscalationDecisionV1(false, target, plan, progress);
    // The recommended continue keeps a Fast Forward run if there was one, so the default cannot lose it; the
    // one-cycle option stays beside it, honest about stopping after one cycle.
    assert.equal(card.recommendation.kind === "option" && card.recommendation.optionId, "continueLostRoundWithFastForward");
    assert.deepEqual(card.options.map((o) => o.optionId).slice(0, 2), ["continueLostRoundWithFastForward", "continueLostRound"]);
    const oneCycle = card.options.find((o) => o.optionId === "continueLostRound")!;
    assert.ok(!JSON.stringify(oneCycle.effect).includes("resumeFastForwardV1"));
    assert.match(oneCycle.consequence, /runs one cycle and stops/);
    // …and the recommended option carries an owner-started Fast Forward run for exactly this lost round.
    const withFf = card.options.find((o) => o.optionId === "continueLostRoundWithFastForward")!;
    assert.ok(withFf, "an unstamped lost round offers Fast Forward");
    assert.match(withFf.consequence, /cannot say whether the lost round was part of a Fast Forward run/);
    const payload = (withFf.effect as unknown as { args: Array<{ resumeFastForwardV1?: Record<string, unknown> }> }).args[0]
      ?.resumeFastForwardV1;
    assert.equal(payload?.fastForwardOwnerStartedV1, true);
    assert.equal(payload?.fastForwardLedgerRoundIdV1, unstamped.roundId);
    assert.equal(payload?.attemptNumber, 1);

    // A stamped round already resumes its own run, so the extra option is not offered next to it.
    const stampedCard = buildStalledTaskEscalationDecisionV1(false, target, plan, {
      ...progress,
      roundLedger: [cutOffRow({ fastForwardRunV1: { attemptNumber: 4, maxAttempts: 10 } })],
    } as unknown as TaskProgress);
    assert.ok(!stampedCard.options.some((o) => o.optionId === "continueLostRoundWithFastForward"));

    // A round the stamping Ensemble opened outside any run is known not to be a run: one cycle is exact, no guess.
    const knownPlain = buildStalledTaskEscalationDecisionV1(false, target, plan, {
      ...progress,
      roundLedger: [cutOffRow({ fastForwardStampedV1: true })],
    } as unknown as TaskProgress);
    assert.ok(!knownPlain.options.some((o) => o.optionId === "continueLostRoundWithFastForward"));
    assert.equal(knownPlain.recommendation.kind === "option" && knownPlain.recommendation.optionId, "continueLostRound");

    // The finder reports which of the three the record is.
    const finder = (row: RoundLedgerEntryV1) => findContinuableLostEditingRoundV1(reviewedProgress([row]), "impl-high-review")!.fastForwardKnown;
    assert.equal(finder(cutOffRow()), false);
    assert.equal(finder(cutOffRow({ fastForwardStampedV1: true })), true);
    assert.equal(finder(cutOffRow({ fastForwardRunV1: { attemptNumber: 1, maxAttempts: 2 } })), true);
  });

  void it("the owner-started resume is trusted without a stamp, but every other check still applies", () => {
    const state = buildOwnerStartedFastForwardResumeV1({ stage: "impl-high-review", lostRoundId: "r1", maxAttempts: 10 });
    const ok = {
      status: "paused", currentStage: "impl-high-review", hasLiveOperation: false, fastForwardRunLive: false,
      lostRound: { startedAtMs: 1000, hasFastForwardStamp: false }, latestRoundStartedAtMs: 1000,
    } as const;
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, ok).trusted, true);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, status: "active" }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, currentStage: "impl-low-review" }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, hasLiveOperation: true }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, fastForwardRunLive: true }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, latestRoundStartedAtMs: 2000 }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, lostRound: undefined }).trusted, false);
    // Without the owner's flag an unstamped row is still refused (the earlier test), so a stale card cannot borrow it.
    const stampless = buildLedgerBackedFastForwardResumeV1({ stage: "impl-high-review", lostRoundId: "r1", run: { attemptNumber: 1, maxAttempts: 10 } });
    assert.equal(decideLedgerBackedFastForwardResumeV1(stampless, ok).trusted, false);
  });

  void it("the ledger-backed resume is trusted only while the lost round is still the newest and the task is still paused", () => {
    const state = buildLedgerBackedFastForwardResumeV1({ stage: "impl-high-review", lostRoundId: "r1", run: { attemptNumber: 4, maxAttempts: 10 } });
    const ok = {
      status: "paused", currentStage: "impl-high-review", hasLiveOperation: false, fastForwardRunLive: false,
      lostRound: { startedAtMs: 1000, hasFastForwardStamp: true }, latestRoundStartedAtMs: 1000,
    } as const;
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, ok).trusted, true);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, status: "active" }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, currentStage: "impl-low-review" }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, hasLiveOperation: true }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, fastForwardRunLive: true }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, latestRoundStartedAtMs: 2000 }).trusted, false, "a later round means the lost one is no longer the state");
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, lostRound: { startedAtMs: 1000, hasFastForwardStamp: false } }).trusted, false);
    assert.equal(decideLedgerBackedFastForwardResumeV1(state, { ...ok, lostRound: undefined }).trusted, false);
  });

  void it("a round opened during a Fast Forward run carries the run's counters, and the progress file accepts the field", () => {
    clearFastForwardRunActiveV1(TASK);
    assert.deepEqual(fastForwardRoundStampV1(TASK), {});
    markFastForwardRunActiveV1(TASK, { attemptNumber: 2, maxAttempts: 9 });
    try {
      assert.deepEqual(fastForwardRoundStampV1(TASK), { fastForwardRunV1: { attemptNumber: 2, maxAttempts: 9 } });
    } finally {
      clearFastForwardRunActiveV1(TASK);
    }
    const base = {
      roundId: "r1", attemptIds: ["r1"], stage: "impl", mode: "apply-review", startedAt: "2026-11-02T06:42:00.000Z", state: "open",
    };
    const decode = (row: Record<string, unknown>) =>
      decodeTaskProgressTextV1(
        JSON.stringify({
          taskFolder: "2026-07-01_task_1",
          currentStage: "impl",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T11:30:00.000Z",
          roundLedger: [row],
        })
      );
    assert.equal(decode({ ...base, fastForwardRunV1: { attemptNumber: 2, maxAttempts: 9 } }).ok, true);
    assert.equal(decode({ ...base, fastForwardRunV1: { attemptNumber: -1, maxAttempts: 9 } }).ok, false);
    assert.equal(decode({ ...base, fastForwardRunV1: { attemptNumber: 2, maxAttempts: 9, extra: 1 } }).ok, false);
    assert.equal(decode({ ...base, fastForwardStampedV1: true }).ok, true);
    assert.equal(decode({ ...base, fastForwardStampedV1: false }).ok, false);
  });

  void it("every round the ledger opens says whether Fast Forward was running, so a missing run stamp means it was not", () => {
    clearFastForwardRunActiveV1(TASK);
    assert.deepEqual(fastForwardRoundFieldsV1(TASK), { fastForwardStampedV1: true });
    markFastForwardRunActiveV1(TASK, { attemptNumber: 2, maxAttempts: 9 });
    try {
      assert.deepEqual(fastForwardRoundFieldsV1(TASK), { fastForwardStampedV1: true, fastForwardRunV1: { attemptNumber: 2, maxAttempts: 9 } });
    } finally {
      clearFastForwardRunActiveV1(TASK);
    }
  });
});

void describe("the reviewer-verified ticks card matches the task's state (Step 33)", () => {
  afterEach(() => clearFastForwardRunActiveV1(TASK));

  function ticksCard(): WorkflowDecisionV1 {
    const applyArgs = { taskFolderPath: TASK, offeredItems: ["Step 1", "Step 2"] };
    const apply: WorkflowDecisionOptionV1 = {
      optionId: APPLY_OPTION_ID_V1,
      label: "Apply 2 Reviewer-Verified Ticks and try again (one cycle, then stops)",
      consequence: "Ticks the items. This runs one cycle and stops there — this was not raised by an active Fast Forward run (or that run has since ended), so it does not start or resume Fast Forward.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.applyReviewerVerifiedTicks", args: [applyArgs] },
    };
    const notYet: WorkflowDecisionOptionV1 = { optionId: "notYet", label: "Not yet", consequence: "Nothing.", resumeKind: "unpause", effect: { kind: "doNothing" } };
    const tickNow = buildHeldTicksAnswerOptionsV1({ decisionKey: APPLY_TICKS_DECISION_KEY_V1, options: [apply, notYet] }).find(
      (o) => o.optionId === APPLY_TICKS_NOW_OPTION_ID_V1
    )!;
    return {
      decisionId: "d1",
      decisionKey: APPLY_TICKS_DECISION_KEY_V1,
      taskCanonicalId: TASK,
      stage: "impl-high-review",
      whatHappened: "impl-high-review.md named 2 plan item(s) as verified complete that are still unticked.",
      whyUserNeeded: "Applying them re-arms the gate on the reviewer's word.",
      options: [apply, tickNow, notYet],
      recommendation: { kind: "option", optionId: tickNow.optionId, reasoning: "Recorded while Fast Forward ran." },
      createdAt: "2026-11-02T22:59:05.000Z",
      state: "pending",
    };
  }

  void it("with Fast Forward active the tick-only option says Fast Forward continues, and no card text says it was not raised by one", () => {
    markFastForwardRunActiveV1(TASK, { attemptNumber: 2, maxAttempts: 10 });
    const view = adaptVerifiedTicksCardToFastForwardStateV1(ticksCard());
    const tickNow = view.options.find((o) => o.optionId === APPLY_TICKS_NOW_OPTION_ID_V1)!;
    assert.match(tickNow.label, /Apply the 2 ticks now \(Fast Forward continues\)/);
    assert.deepEqual(view.recommendation.kind === "option" && view.recommendation.optionId, APPLY_TICKS_NOW_OPTION_ID_V1);
  });

  void it("with Fast Forward ended the tick-only option is not offered and the recommended option applies the ticks AND continues, saying which", () => {
    const view = adaptVerifiedTicksCardToFastForwardStateV1(ticksCard());
    assert.ok(!view.options.some((o) => o.optionId === APPLY_TICKS_NOW_OPTION_ID_V1));
    assert.deepEqual(view.recommendation.kind === "option" && view.recommendation.optionId, APPLY_OPTION_ID_V1);
    assert.match(view.recommendation.reasoning, /runs the stage's next action once; no Fast Forward run is active/);
    const texts = view.options.map((o) => `${o.label} ${o.consequence}`).join(" ");
    assert.ok(!/keeps running/.test(texts), "no option says Fast Forward keeps running when none does");
  });

  void it("a captured Fast Forward run is resumed by the recommended option, and the card says so", () => {
    const card = ticksCard();
    const resumed: WorkflowDecisionV1 = {
      ...card,
      options: card.options.map((o) =>
        o.optionId === APPLY_OPTION_ID_V1 ? { ...o, label: "Apply 2 Reviewer-Verified Ticks and resume Fast Forward (iteration 2 of 10)" } : o
      ),
    };
    const view = adaptVerifiedTicksCardToFastForwardStateV1(resumed);
    assert.match(view.recommendation.reasoning, /resumes the Fast Forward run this card was raised in/);
  });
});

void describe("repeated report-contract rejections reach the owner (Step 35)", () => {
  const rejections = (n: number, kind = "checklist-claim"): ReportContractRejectionV1[] => {
    let list: ReportContractRejectionV1[] = [];
    for (let i = 0; i < n; i++) {
      list = appendReportContractRejectionV1(list, {
        at: `2026-11-02T10:0${i}:00.000Z`,
        reason:
          kind === "checklist-claim"
            ? "The final response declares no-checklist-change but also reports a plan-item completion in Plan Item Checklist."
            : "The report returned no final summary text.",
      });
    }
    return list;
  };

  void it("nothing is said for the first two, and the third names the count and quotes the last reason", () => {
    assert.equal(selectRepeatedRejectionV1(rejections(2)), undefined);
    assert.equal(formatRepeatedRejectionLineV1(rejections(2)), "");
    const third = selectRepeatedRejectionV1(rejections(3));
    assert.equal(third?.count, 3);
    assert.equal(third?.kind, "checklist-claim");
    const line = formatRepeatedRejectionLineV1(rejections(3));
    assert.match(line, /rejected for the same reason 3 times/);
    assert.match(line, /no-checklist-change/);
    assert.match(line, /Changing this stage's model/);
  });

  void it("the next stop card says how many times, quotes the last reason and offers Change this stage's model", () => {
    const repeated = selectRepeatedRejectionV1(rejections(4))!;
    const card = buildAutomationStoppedCardInputV1(facts({ repeatedRejection: repeated }));
    assert.match(card.whatHappened, /rejected for the same reason 4 times/);
    assert.match(card.whatHappened, /no-checklist-change/);
    assert.ok(card.options.some((o) => o.optionId === "changeStageModel" && /Change this stage's model/.test(o.label)));
    const quiet = buildAutomationStoppedCardInputV1(BASE_FACTS);
    assert.ok(!quiet.options.some((o) => o.optionId === "changeStageModel"));
  });

  void it("the round-end line is added to a rejected round's ending while automation is running", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/utils/roundLedgerV1.ts"), "utf8");
    assert.match(source, /entry\.state === "rejected" && \(hasAutomaticOriginV1\(\) \|\| isFastForwardRunActiveV1/);
    assert.match(source, /formatRepeatedRejectionLineV1\(patched\.reportContractRejections\)/);
  });
});

void describe("review1 Step 56: the stop card shows N of M plan items left next to the score and names the continue action for the work", () => {
  void it("puts the figure beside the score, from the shared counts", () => {
    const card = buildAutomationStoppedCardInputV1(BASE_FACTS);
    assert.match(card.whatHappened, /scored 7\/10, up from 6\/10 \(7 of 140 plan items left\)/);
  });

  void it("a review stage's one-more-cycle option is the Continue the work round, named for the work", () => {
    const card = buildAutomationStoppedCardInputV1(BASE_FACTS);
    const option = card.options.find((candidate) => candidate.optionId === "runOneMoreCycle");
    assert.ok(option, "the review stage keeps its one-cycle option");
    assert.equal(option.label, "Continue the work (7 of 140 plan items left) — one cycle, then stops");
    assert.doesNotMatch(option.label, /one more cycle/i, "the action is named for the work, not for another pass");
    assert.match(option.consequence, /^Continue the work \(7 of 140 plan items left\): runs one Apply Review/);
    assert.doesNotMatch(option.consequence, /back to|previous stage/i);
  });

  void it("the Implementation stage's continue option carries the count in its label", () => {
    const card = buildAutomationStoppedCardInputV1({ ...BASE_FACTS, stage: "impl" });
    const option = card.options.find((candidate) => candidate.optionId === "continueTheWork");
    assert.equal(option?.label, "Continue the work (7 of 140 plan items left)");
  });

  void it("a stop with no plan items keeps the plain wording", () => {
    const card = buildAutomationStoppedCardInputV1({ ...BASE_FACTS, planItems: undefined, stage: "impl" });
    assert.match(card.whatHappened, /scored 7\/10, up from 6\/10\./);
    assert.equal(card.options.find((candidate) => candidate.optionId === "continueTheWork")?.label, "Continue the work");
  });
});
