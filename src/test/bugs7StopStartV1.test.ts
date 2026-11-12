/**
 * bugs7 (Steps 9-14, 17, 19, 21): an owner's answer leads to the round that applies it, a blocker an answer narrowed is
 * not "standing", the "stage is done" card offers nothing inert, and Fast Forward crosses a clean stage edge.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  followUpAfterOwnerAnswerV1,
  describeOwnerAnswerNextV1,
  ownerOptionNeedsCodeChangeV1,
  reviewNextRoundTextV1,
  type OwnerFollowUpDepsV1,
  type RecordOwnerPlanDecisionArgV1,
} from "../commands/ownerPlanDecisionCommandV1";
import {
  FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1,
  commitPushBoundaryLineV1,
  fastForwardAcrossCleanStagesV1,
  fastForwardCrossingTargetV1,
  type StageEdgeFactsV1,
} from "../utils/fastForwardStageEdgeV1";
import { buildAutomationStoppedCardInputV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import { buildBlockerWorkListV1, countReviewsBlockerHasStoodV1 } from "../utils/blockerWorkListV1";
import { latestOwnerAnswerAtV1 } from "../utils/ownerAnswerTimeV1";
import { blockerIdentity } from "../utils/reviewRouting";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import type { ReviewBlockerIdentity, TaskStage } from "../types/taskProgress";

// ── Part 2: grouped answers keep the strongest requirement ───────────────────────────────────────────────────────────

void describe("an answer group keeps the strongest outstanding requirement (bugs7 item 3, review fix)", () => {
  const ARG = (blockerId: string, extra: Partial<RecordOwnerPlanDecisionArgV1> = {}): RecordOwnerPlanDecisionArgV1 => ({
    taskFolderPath: "/tmp/.ensemble/bugs7-group-task",
    stage: "impl-high-review",
    blockerId,
    optionId: "x",
    optionLabel: "x",
    ...extra,
  });
  function fakeDeps(open: { value: number }) {
    const started: RecordOwnerPlanDecisionArgV1[] = [];
    const deps: OwnerFollowUpDepsV1 = {
      openSiblings: () => open.value,
      start: (arg) => {
        started.push(arg);
        return Promise.resolve({ kind: "started" } as const);
      },
      say: () => Promise.resolve(),
      offerRunNow: () => Promise.resolve(),
      reviewStartedSince: () => Promise.resolve(false),
    };
    return { deps, started };
  }

  void it("an earlier answer that owes Apply Review is not dropped when the last answer only needs a re-review", async () => {
    const open = { value: 1 };
    const { deps, started } = fakeDeps(open);
    await followUpAfterOwnerAnswerV1(ARG("needs-code", { thenApplyReview: true }), deps);
    open.value = 0;
    await followUpAfterOwnerAnswerV1(ARG("re-review-only"), deps);
    assert.equal(started.length, 1);
    assert.equal(started[0]!.thenApplyReview, true, "the group's run is the Apply Review");
  });

  void it("a later answer that needs a code change after an earlier re-review-only answer also runs Apply Review", async () => {
    const open = { value: 1 };
    const { deps, started } = fakeDeps(open);
    await followUpAfterOwnerAnswerV1(ARG("re-review-only"), deps);
    open.value = 0;
    await followUpAfterOwnerAnswerV1(ARG("needs-code", { thenApplyReview: true }), deps);
    assert.equal(started[0]!.thenApplyReview, true);
  });

  void it("with no answer needing code, the run stays a re-review", async () => {
    const open = { value: 1 };
    const { deps, started } = fakeDeps(open);
    await followUpAfterOwnerAnswerV1(ARG("a"), deps);
    open.value = 0;
    await followUpAfterOwnerAnswerV1(ARG("b"), deps);
    assert.equal(started[0]!.thenApplyReview, undefined);
  });
});

void describe("the fallback reads the recommendation and the review's own build-next text (bugs7 item 3, review fix)", () => {
  const block = {
    problem: "The round-clock prompt calls the start plus 60 minutes the hard stop.",
    technicalDetails: undefined,
    recommendation: { optionId: "keep", reason: "One round rewords two sentences." },
    options: [
      { id: "keep", label: "Keep the 60 minutes, reworded", consequence: "The wording changes." },
      { id: "drop", label: "Drop the rule", consequence: "Nothing else changes." },
    ],
  };
  const keep = block.options[0]! as Parameters<typeof ownerOptionNeedsCodeChangeV1>[0];
  const drop = block.options[1]! as Parameters<typeof ownerOptionNeedsCodeChangeV1>[0];

  void it("the recommendation's reason says one round rewords it, so the recommended option runs Apply Review", () => {
    assert.equal(ownerOptionNeedsCodeChangeV1(keep, block), true);
    assert.equal(ownerOptionNeedsCodeChangeV1(drop, block), false, "the reason speaks for the recommended option only");
  });

  void it("the review's separate Build next line speaks for the recommended option", () => {
    const bare = { ...block, recommendation: { optionId: "keep", reason: "Recommended." } };
    assert.equal(ownerOptionNeedsCodeChangeV1(keep, bare), false);
    const review = "## Summary\nThe next round should reword Step 12's two sentences.\n\n## Build next\n- Step 12's rewording\n";
    assert.match(reviewNextRoundTextV1(review) ?? "", /the next round should reword/i);
    assert.equal(ownerOptionNeedsCodeChangeV1(keep, bare, reviewNextRoundTextV1(review)), true);
    assert.equal(ownerOptionNeedsCodeChangeV1(drop, bare, reviewNextRoundTextV1(review)), false);
    assert.match(describeOwnerAnswerNextV1(keep, bare, "High-Level Code Review", reviewNextRoundTextV1(review)), /^Apply Review builds it/);
    assert.match(describeOwnerAnswerNextV1(drop, bare, "High-Level Code Review", reviewNextRoundTextV1(review)), /checks it next$/);
  });
});

// ── Part 2: standing counts restart after an answer or a change of resolver ──────────────────────────────────────────

const DESCRIPTION = "Step 12 rewording per owner decision step-12-hard-stop is not applied: roundClockV1.ts still says hard stop";
function blocker(resolver: ReviewBlocker["resolver"], description = DESCRIPTION): ReviewBlocker {
  return { category: "completion", resolver, description } as ReviewBlocker;
}
/** What an earlier review recorded for the same blocker line, with the resolver that review gave it. */
const earlier = (resolver: ReviewBlocker["resolver"]): ReviewBlockerIdentity => blockerIdentity(blocker(resolver));

void describe("a blocker the owner's answer narrowed is not standing (bugs7 item 4)", () => {
  const narrowed = blocker("task-fixable");
  const plan = "<!-- ensemble:implementation-checklist -->\n- [ ] Step 12: reword the round clock prompt";
  // Two reviews carried the line as an owner decision; the owner answered at 05:10:52 (Israel 07:10:52).
  const priorOwner = [[earlier("environmental")], [earlier("environmental")]];
  const priorAts = ["2026-11-11T04:30:00.000Z", "2026-11-11T05:00:00.000Z"];

  void it("the count restarts where the resolver changed (owner, owner, then task-fixable)", () => {
    assert.equal(countReviewsBlockerHasStoodV1(narrowed, priorOwner, [undefined, true, true]), 1);
    // The same resolver all the way is a standing blocker: three observations.
    assert.equal(countReviewsBlockerHasStoodV1(narrowed, [[earlier("task-fixable")], [earlier("task-fixable")]], [undefined, true, true]), 3);
    // A history entry that recorded no resolver does not break the chain.
    assert.equal(countReviewsBlockerHasStoodV1(narrowed, [[earlier("unknown")], [earlier("task-fixable")]], [undefined, true, true]), 3);
  });

  void it("reviews before the owner's answer do not count towards standing; the list lands in work a round can do", () => {
    const sameResolver = [[earlier("task-fixable")], [earlier("task-fixable")]];
    const list = buildBlockerWorkListV1({
      blockers: [narrowed],
      planOfRecord: plan,
      priorReviewBlockers: sameResolver,
      priorReviewAts: priorAts,
      ownerAnswerAtOf: () => "2026-11-11T05:10:52.000Z",
      reviewSeparatedByFixRound: [undefined, true, true],
      plateauRounds: 3,
    });
    assert.equal(list.notThisRound.length, 0, "not standing");
    assert.equal(list.fixFirst.length + list.buildToClear.length, 1, "a round can work on it");
  });

  void it("the three reviews' blocker blocks (same, same, then narrowed after an answer) are work for a round; the unchanged history is standing", () => {
    const withoutAnswer = buildBlockerWorkListV1({
      blockers: [narrowed],
      planOfRecord: plan,
      priorReviewBlockers: [[earlier("task-fixable")], [earlier("task-fixable")]],
      priorReviewAts: priorAts,
      reviewSeparatedByFixRound: [undefined, true, true],
      plateauRounds: 3,
    });
    assert.equal(withoutAnswer.notThisRound.length, 1);
    assert.equal(withoutAnswer.notThisRound[0]!.kind, "standing");
    const changedResolver = buildBlockerWorkListV1({
      blockers: [narrowed],
      planOfRecord: plan,
      priorReviewBlockers: priorOwner,
      priorReviewAts: priorAts,
      reviewSeparatedByFixRound: [undefined, true, true],
      plateauRounds: 3,
    });
    assert.equal(changedResolver.notThisRound.length, 0, "the resolver changed, so the count restarted");
  });

  void it("finds the answer's time from the settled card whose id the blocker names, or whose identities carry its lineage", () => {
    const decisions = [
      { decisionKey: "ownerPlanDecision:step-12-hard-stop", state: "resolved" as const, resolvedAt: "2026-11-11T05:10:52.000Z" },
      { decisionKey: "ownerPlanDecision:other", state: "resolved" as const, resolvedAt: "2026-11-11T09:00:00.000Z" },
      { decisionKey: "ownerPlanDecision:step-12-hard-stop", state: "pending" as const },
      { decisionKey: "automationStopped", state: "resolved" as const, resolvedAt: "2026-11-11T10:00:00.000Z" },
    ];
    assert.equal(latestOwnerAnswerAtV1(decisions, narrowed.description), "2026-11-11T05:10:52.000Z");
    assert.equal(latestOwnerAnswerAtV1(decisions, "an unrelated blocker"), undefined);
    const byLineage = [
      { decisionKey: "ownerPlanDecision:x", state: "resolved" as const, resolvedAt: "2026-11-11T06:00:00.000Z", blockerIdentities: ["owner:6a9b5ae8-3"] },
    ];
    assert.equal(latestOwnerAnswerAtV1(byLineage, "no id here", "6a9b5ae8-3"), "2026-11-11T06:00:00.000Z");
  });
});

// ── Part 2: every review that ends names the next click; both standing-card sites pass the named work ───────────────

void describe("the review routing wires the end card, the ready card and the named build work (bugs7 items 3 and 4)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");

  void it("a review that nothing follows, however it started, posts the review-ended card below the threshold and the ready card or next-click line when it passes", () => {
    const block = source.slice(source.indexOf("a review that nothing follows ends with a card or a line naming the next click"));
    assert.match(block.slice(0, 3000), /ending: "review-ended"/);
    assert.match(block.slice(0, 3000), /options\.chainedReReview !== true && !isFastForwardRunActiveV1\(folderUri\.fsPath\) && !isAutomationDispatchContextV1\(\)/);
    assert.match(block.slice(0, 3500), /Start Fast Forward to build them, or Complete Stage & Move On/);
    assert.match(block.slice(0, 3800), /postStageReadyCardIfReadyV1\(folderUri\.fsPath, "With the review done"\)/, "the complete-gate path raises the ready card, once per state");
  });

  void it("both places that stop Fast Forward on a standing blocker give the card the work the review named", () => {
    const sites = source.split("postOwnerOnlyBlockersCardV1({").slice(1);
    const withBuildNext = sites.filter((site) => site.slice(0, 700).includes("buildNext"));
    assert.ok(withBuildNext.length >= 2, "the start-of-run site and the after-review site both pass buildNext");
    assert.ok(source.includes("namedWorkAfterReview"), "the after-review site reads the review's build-next lines");
  });

  void it("the Fast Forward command crosses a clean stage edge through the shared loop", () => {
    assert.match(source, /fastForwardAcrossCleanStagesHostV1\(context, arg, chatViewProvider\)/);
    assert.match(source, /endReport\?\.\(\{ folderPath: resolved\.folderUri\.fsPath, stage: targetStage, movedOn: false \}\)/);
  });
});

// ── Part 3: the "stage is done" card ─────────────────────────────────────────────────────────────────────────────────

function doneFacts(stage: TaskStage, over: Partial<AutomationStopFactsV1> = {}): AutomationStopFactsV1 {
  return {
    taskFolderPath: "/tmp/.ensemble/done-task",
    stage,
    ending: "stage-ready",
    stopReason: "after your tick, every plan item is now settled and the latest review is clean",
    score: 9,
    previousScore: 8,
    blockers: { fixFirst: 0, buildToClear: 0, notThisRound: 0 },
    planItems: { total: 5, settled: 5, open: 0, provisional: 0 },
    buildNext: [],
    dismissedDependencies: [],
    reviewClean: true,
    gateComplete: true,
    fastForwardWasRunning: false,
    ...over,
  };
}

void describe("the done card offers nothing inert (bugs7 items 6 and 7)", () => {
  void it("High-Level Code Review done: Move on is recommended, Move on and Fast Forward is offered, no inert Fast Forward or cycle", () => {
    const card = buildAutomationStoppedCardInputV1(doneFacts("impl-high-review"));
    const ids = card.options.map((o) => o.optionId);
    assert.ok(ids.includes("moveOn") && ids.includes("moveOnAndFastForward"));
    assert.ok(!ids.includes("startFastForward") && !ids.includes("runOneMoreCycle"));
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : "", "moveOn");
    const combined = card.options.find((o) => o.optionId === "moveOnAndFastForward")!;
    assert.equal(combined.label, "Move on and Fast Forward Low-Level Code Review");
    assert.equal(combined.effect.kind === "command" ? combined.effect.command : "", "vs-code-ai-helper.fastForwardReviewWithAI");
    assert.match(combined.consequence, /Publish Checks, fix rounds and the Publish review/);
    assert.match(combined.consequence, /Commit & Push, which stays your click/);
    assert.doesNotMatch(combined.consequence, /stops before Publish/);
  });

  void it("Low-Level Code Review done: Move on and Fast Forward Publish is offered, and moving on to Publish is never unattended", () => {
    const card = buildAutomationStoppedCardInputV1(doneFacts("impl-low-review"));
    const ids = card.options.map((o) => o.optionId);
    assert.ok(ids.includes("moveOn"));
    assert.ok(ids.includes("moveOnAndFastForward"));
    const combined = card.options.find((o) => o.optionId === "moveOnAndFastForward")!;
    assert.equal(combined.label, "Move on and Fast Forward Publish");
    const moveOn = card.options.find((o) => o.optionId === "moveOn")!;
    assert.notEqual(moveOn.unattendedSafe, true, "moving on to Publish never runs by itself");
    assert.notEqual(combined.unattendedSafe, true);
  });

  void it("the end of Publish names Commit & Push as the owner's click and offers no option that runs it", () => {
    const card = buildAutomationStoppedCardInputV1(doneFacts("publish"));
    assert.match(card.whatHappened, /Next: Commit & Push\. It stays your click/);
    assert.match(card.whyUserNeeded, /Commit & Push/);
    for (const option of card.options) {
      assert.notEqual(option.unattendedSafe, true);
      assert.doesNotMatch(JSON.stringify(option.effect), /commitAndPush/i, option.optionId);
      assert.doesNotMatch(option.label, /commit|push/i, option.optionId);
    }
  });

  void it("a stage with work left offers Fast Forward, and its consequence says it continues through Publish and stops at Commit & Push", () => {
    const card = buildAutomationStoppedCardInputV1(
      doneFacts("impl-high-review", { ending: "fast-forward-stalled", reviewClean: false, gateComplete: false, blockers: { fixFirst: 1, buildToClear: 0, notThisRound: 0 } })
    );
    const ff = card.options.find((o) => o.optionId === "startFastForward")!;
    assert.match(ff.consequence, /Publish Checks, fix rounds and the Publish review/);
    assert.match(ff.consequence, /stops at Commit & Push, which stays your click/);
    assert.doesNotMatch(ff.consequence, /never moves into Publish/);
    assert.ok(!card.options.some((o) => o.optionId === "moveOnAndFastForward"));
  });
});

// ── Part 3: Fast Forward crosses a clean stage edge ──────────────────────────────────────────────────────────────────

void describe("Fast Forward crosses a clean stage edge (bugs7 item 7, Step 19)", () => {
  function harness(initial: TaskStage, script: { clean?: boolean; gate?: boolean; hold?: boolean; moves?: boolean } = {}) {
    const log: string[] = [];
    let stage: TaskStage = initial;
    const eligible: { value: TaskStage | undefined } = { value: undefined };
    let runs = 0;
    const deps = {
      runFastForward: () => {
        runs += 1;
        log.push(`ff:${stage}`);
        eligible.value = stage;
        return Promise.resolve();
      },
      takeEligibleStage: () => {
        const value = eligible.value;
        eligible.value = undefined;
        return value;
      },
      readFacts: (): Promise<StageEdgeFactsV1> =>
        Promise.resolve({
          active: true,
          taskStage: stage,
          reviewClean: script.clean !== false,
          gateComplete: script.gate !== false,
          hold: script.hold === true,
        }),
      advance: () => {
        log.push(`advance:${stage}`);
        if (script.moves !== false) stage = fastForwardCrossingTargetV1(stage) ?? stage;
        return Promise.resolve();
      },
      waitUntilFree: () => Promise.resolve(true),
      say: (text: string) => {
        log.push(`say:${text.slice(0, 30)}`);
        return Promise.resolve();
      },
      stoppedAtCommitPushBoundary: (s: TaskStage) => {
        log.push(`commit-push-boundary:${s}`);
        return Promise.resolve();
      },
    };
    return { deps, log, runs: () => runs };
  }

  void it("a clean, settled High-Level Code Review moves on and Fast Forward runs in Low-Level Code Review, with no card wait", async () => {
    const h = harness("impl-high-review");
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    // Every stage in the harness stays clean and settled, so the run walks on through Publish to the final boundary.
    assert.deepEqual(result.crossedInto, ["impl-low-review", "publish"]);
    assert.equal(h.runs(), 3);
    assert.ok(h.log.indexOf("advance:impl-high-review") < h.log.lastIndexOf("ff:impl-low-review"), "advance, then Fast Forward on the next stage");
  });

  void it("a clean, settled Low-Level Code Review moves into Publish and Fast Forward carries on there (owner decision 2026-11-11)", async () => {
    const h = harness("impl-low-review");
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.deepEqual(result.crossedInto, ["publish"]);
    assert.ok(h.log.indexOf("advance:impl-low-review") < h.log.lastIndexOf("ff:publish"), "advance, then Fast Forward on Publish");
  });

  void it("a clean, settled Publish ends at the Commit & Push boundary: it only names the click and runs nothing further", async () => {
    const h = harness("publish");
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.equal(result.crossings, 0);
    assert.equal(h.runs(), 1);
    assert.deepEqual(h.log.filter((line) => line.startsWith("advance")), []);
    assert.ok(h.log.includes("commit-push-boundary:publish"));
  });

  void it("a Fast Forward started on an already-done review stage walks through to Publish and stops at Commit & Push", async () => {
    const h = harness("impl-high-review");
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.deepEqual(result.crossedInto, ["impl-low-review", "publish"]);
    assert.ok(h.log.includes("commit-push-boundary:publish"));
    assert.ok(!h.log.some((line) => /commit.?push/i.test(line) && line.startsWith("advance")), "no step dispatches Commit & Push");
  });

  void it("failed Publish Checks run a fix round, then Fast Forward carries on to the Publish review (bounded)", async () => {
    const log: string[] = [];
    let runs = 0;
    let failedNext = true;
    const result = await fastForwardAcrossCleanStagesV1({
      runFastForward: () => {
        runs += 1;
        log.push(`ff:${runs}`);
        return Promise.resolve();
      },
      takeEligibleStage: () => (failedNext ? undefined : "publish"),
      takePublishChecksFailed: () => {
        const value = failedNext;
        failedNext = false;
        return value;
      },
      runPublishFixRound: () => {
        log.push("fix");
        return Promise.resolve(true);
      },
      readFacts: (stage): Promise<StageEdgeFactsV1> =>
        Promise.resolve({ active: true, taskStage: stage, reviewClean: true, gateComplete: true, hold: false }),
      advance: () => Promise.resolve(),
      waitUntilFree: () => Promise.resolve(true),
      say: (text: string) => {
        log.push(`say:${text.slice(0, 20)}`);
        return Promise.resolve();
      },
      stoppedAtCommitPushBoundary: () => {
        log.push("boundary");
        return Promise.resolve();
      },
    });
    assert.equal(result.publishFixRounds, 1);
    assert.deepEqual(log.filter((l) => !l.startsWith("say:")), ["ff:1", "fix", "ff:2", "boundary"]);
  });

  void it("Publish Checks that still fail after the bounded fix rounds hand back instead of looping", async () => {
    let runs = 0;
    let fixes = 0;
    const result = await fastForwardAcrossCleanStagesV1({
      runFastForward: () => {
        runs += 1;
        return Promise.resolve();
      },
      takeEligibleStage: () => undefined,
      takePublishChecksFailed: () => true,
      runPublishFixRound: () => {
        fixes += 1;
        return Promise.resolve(true);
      },
      readFacts: (stage): Promise<StageEdgeFactsV1> =>
        Promise.resolve({ active: true, taskStage: stage, reviewClean: false, gateComplete: false, hold: false }),
      advance: () => Promise.resolve(),
      waitUntilFree: () => Promise.resolve(true),
      say: () => Promise.resolve(),
    });
    assert.equal(fixes, FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1);
    assert.equal(result.publishFixRounds, FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1);
    assert.equal(runs, 1 + FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1);
  });

  void it("a fix round that leaves the checks failing, a paused task or a cancelled run goes no further", async () => {
    for (const script of [{ fixPasses: false, active: true }, { fixPasses: true, active: false }]) {
      let runs = 0;
      await fastForwardAcrossCleanStagesV1({
        runFastForward: () => {
          runs += 1;
          return Promise.resolve();
        },
        takeEligibleStage: () => undefined,
        takePublishChecksFailed: () => runs === 1,
        runPublishFixRound: () => Promise.resolve(script.fixPasses),
        readFacts: (stage): Promise<StageEdgeFactsV1> =>
          Promise.resolve({ active: script.active, taskStage: stage, reviewClean: false, gateComplete: false, hold: false }),
        advance: () => Promise.resolve(),
        waitUntilFree: () => Promise.resolve(true),
        say: () => Promise.resolve(),
      });
      assert.equal(runs, 1, JSON.stringify(script));
    }
    // A cancelled run reports nothing, so nothing is eligible and no fix round starts.
    let fixes = 0;
    await fastForwardAcrossCleanStagesV1({
      runFastForward: () => Promise.resolve(),
      takeEligibleStage: () => undefined,
      takePublishChecksFailed: () => false,
      runPublishFixRound: () => {
        fixes += 1;
        return Promise.resolve(true);
      },
      readFacts: (stage): Promise<StageEdgeFactsV1> =>
        Promise.resolve({ active: true, taskStage: stage, reviewClean: false, gateComplete: false, hold: false }),
      advance: () => Promise.resolve(),
      waitUntilFree: () => Promise.resolve(true),
      say: () => Promise.resolve(),
    });
    assert.equal(fixes, 0);
  });

  void it("the crossing target is a review stage or Publish, and nothing after Publish", () => {
    assert.equal(fastForwardCrossingTargetV1("impl-low-review"), "publish");
    assert.equal(fastForwardCrossingTargetV1("impl-high-review"), "impl-low-review");
    assert.equal(fastForwardCrossingTargetV1("publish"), undefined);
    assert.equal(fastForwardCrossingTargetV1("plan-low-review"), undefined, "Implementation is not a Fast Forward stage");
  });

  void it("an unclean review, an incomplete gate or an open hold stops where it is", async () => {
    for (const script of [{ clean: false }, { gate: false }, { hold: true }]) {
      const h = harness("impl-high-review", script);
      const result = await fastForwardAcrossCleanStagesV1(h.deps);
      assert.equal(result.crossings, 0, JSON.stringify(script));
      assert.equal(h.runs(), 1);
    }
  });

  void it("a move that did not happen (a declined confirmation) does not start another run", async () => {
    const h = harness("impl-high-review", { moves: false });
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.equal(result.crossings, 0);
    assert.equal(h.runs(), 1);
  });

  void it("a run that ended with a stop or a cancel (no eligible stage) never crosses", async () => {
    const h = harness("impl-high-review");
    const quiet = { ...h.deps, runFastForward: () => Promise.resolve() };
    const result = await fastForwardAcrossCleanStagesV1(quiet);
    assert.equal(result.crossings, 0);
  });
});

void describe("Fast Forward carries on after the run's own initial review moved the task on (bugs7 item 7, Step 19 review fix)", () => {
  void it("a run that returned right after the initial review's automatic advance carries on in the landed review stage", async () => {
    const log: string[] = [];
    let movedOn: TaskStage | undefined;
    let runs = 0;
    const result = await fastForwardAcrossCleanStagesV1({
      runFastForward: () => {
        runs += 1;
        log.push(`ff:${runs}`);
        movedOn = runs === 1 ? "impl-low-review" : undefined;
        return Promise.resolve();
      },
      takeEligibleStage: () => undefined,
      takeMovedOnStage: () => {
        const stage = movedOn;
        movedOn = undefined;
        return stage;
      },
      readFacts: (stage): Promise<StageEdgeFactsV1> =>
        Promise.resolve({ active: true, taskStage: stage, reviewClean: false, gateComplete: false, hold: false }),
      advance: () => {
        log.push("advance");
        return Promise.resolve();
      },
      waitUntilFree: () => {
        log.push("wait");
        return Promise.resolve(true);
      },
      say: (text: string) => {
        log.push(`say:${text.slice(0, 20)}`);
        return Promise.resolve();
      },
    });
    assert.deepEqual(result.crossedInto, ["impl-low-review"]);
    assert.equal(runs, 2);
    assert.ok(!log.includes("advance"), "the automatic advance already moved the task; the loop does not move it again");
    assert.ok(log.indexOf("wait") < log.lastIndexOf("ff:2"), "it waits for the queued review of the landed stage, then runs Fast Forward");
  });

  void it("a landed stage that the task is no longer on, or that holds, is not carried on", async () => {
    for (const facts of [{ active: false }, { hold: true }, { taskStage: "impl-high-review" as TaskStage }]) {
      let runs = 0;
      await fastForwardAcrossCleanStagesV1({
        runFastForward: () => {
          runs += 1;
          return Promise.resolve();
        },
        takeEligibleStage: () => undefined,
        takeMovedOnStage: () => (runs === 1 ? "impl-low-review" : undefined),
        readFacts: (stage): Promise<StageEdgeFactsV1> =>
          Promise.resolve({ active: true, taskStage: stage, reviewClean: false, gateComplete: false, hold: false, ...facts }),
        advance: () => Promise.resolve(),
        waitUntilFree: () => Promise.resolve(true),
        say: () => Promise.resolve(),
      });
      assert.equal(runs, 1, JSON.stringify(facts));
    }
  });

  void it("the host wrapper handles a run started with no argument and records the initial review's move", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    const host = source.slice(source.indexOf("async function fastForwardAcrossCleanStagesHostV1("));
    const body = host.slice(0, host.indexOf("export async function fastForwardReviewWithAI("));
    assert.doesNotMatch(
      body,
      /folderPath === undefined\) \{\s*await fastForwardReviewWithAI\(context\.extensionUri, context, arg, chatViewProvider\);\s*return;/,
      "no early single run for a no-argument start"
    );
    assert.match(body, /takeMovedOnStage/);
    assert.match(body, /fastForwardReviewWithAI\(context\.extensionUri, context, runArg, chatViewProvider, endReport\)/);
    assert.match(source, /endReport\?\.\(\{ folderPath: resolved\.folderUri\.fsPath, stage: ffStageNow, movedOn: true \}\)/);
  });

  void it("a run's end is reported through its own invocation's callback, never a module-wide slot (another task's run cannot be adopted)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    assert.doesNotMatch(source, /ffLastEndedRunV1|ffStageEdgeEligibleV1|ffMovedOnStageV1/);
    const host = source.slice(source.indexOf("async function fastForwardAcrossCleanStagesHostV1("));
    const body = host.slice(0, host.indexOf("export async function fastForwardReviewWithAI("));
    // A known folder is never replaced by a report about another one, and a cancelled pick (no report) adopts nothing.
    assert.match(body, /normalizePath\(last\.folderPath\) !== keyOf\(\)/);
    assert.match(body, /if \(last === undefined\) return;/);
    // The run reports from all five of its ends: the initial review's move, the clean end, the in-loop stage move, the
    // failed Publish Checks and the already-clean Publish review.
    const fn = source.slice(source.indexOf("export async function fastForwardReviewWithAI("));
    assert.equal((fn.match(/endReport\?\.\(/g) ?? []).length, 5);
  });

  void it("an in-loop review-stage move (a clean re-review that auto-advanced) is handed to the wrapper as a continuation", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    const left = source.indexOf("if (ffStageLeftForV1) {");
    const stalled = source.indexOf("stalled: outcome.stalled === true", left);
    const branch = source.slice(left, stalled);
    assert.match(branch, /fastForwardCanContinueInV1\(ffStageLeftForV1\)/);
    assert.match(branch, /endReport\?\.\(\{ folderPath: resolved\.folderUri\.fsPath, stage: ffStageLeftForV1, movedOn: true \}\)/);
    assert.match(branch, /isCancellationRequested !== true/);
  });

  void it("no guard holds a clean review back from advancing into Publish during Fast Forward (owner decision 2026-11-11)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    assert.doesNotMatch(source, /ffHoldsPublishEdgeV1/);
    assert.match(
      source,
      /if \(!escalated && targetStage !== "publish" && isAutoAdvanceEnabled\(\) && meetsThreshold\) \{/
    );
  });

  void it("the wrapper carries a successor-aware wait, a Publish fix round and the Commit & Push boundary line", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    const host = source.slice(source.indexOf("async function fastForwardAcrossCleanStagesHostV1("));
    const body = host.slice(0, host.indexOf("export async function fastForwardReviewWithAI("));
    assert.match(body, /successorWorkPendingV1\(folderPath\)/);
    assert.match(body, /runPublishFixRound/);
    assert.match(body, /vs-code-ai-helper\.runLintingFixes/);
    assert.match(body, /stoppedAtCommitPushBoundary/);
    // Nothing in the Fast Forward wrapper dispatches Commit & Push.
    assert.doesNotMatch(body, /commitAndPush/i);
  });

  void it("successor chain ids cover ordinary and deferred successor reviews, but not the Fast Forward command itself", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    const list = source.slice(source.indexOf("const SUCCESSOR_CHAIN_IDS_V1 = ["), source.indexOf("] as const;", source.indexOf("const SUCCESSOR_CHAIN_IDS_V1 = [")));
    assert.match(list, /"auto-review"/);
    assert.match(list, /runReviewWithAI/);
    // The Publish review a fix round queues behind itself is a successor too: its chain id is the one runLintingFixes uses.
    assert.match(list, /"publish-review-after-fix"/);
    const fixes = fs.readFileSync(path.resolve(__dirname, "../../src/commands/runLintingFixes.ts"), "utf8");
    assert.match(fixes, /chainId: "publish-review-after-fix"/);
    assert.doesNotMatch(list, /fastForwardReviewWithAI/);
  });

  void it("Publish Checks that fail under a Fast Forward invocation are reported to that invocation, not to a module slot", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    assert.match(source, /publishChecksFailed: true,/);
    const at = source.indexOf("publishChecksFailed: true,");
    const around = source.slice(at - 400, at + 100);
    assert.match(around, /isCancellationRequested !== true/);
    assert.match(around, /endReport\?\.\(/);
  });

  void it("the Commit & Push boundary line names the owner's click and says Fast Forward never runs it", () => {
    const line = commitPushBoundaryLineV1();
    assert.match(line, /Commit & Push is next, and it stays your click/);
    assert.match(line, /never runs it/);
  });
});
