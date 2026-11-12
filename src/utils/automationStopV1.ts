/**
 * review1 Steps 29 and 35: what Ensemble says when automation stops with work left, and which next step it
 * recommends. Pure, so the wording and the recommendation are testable without a host.
 *
 * Every ending that leaves work behind (a one-cycle choice finished, Fast Forward hit its cap or stalled, a stop
 * rule tripped) raises one card: why it stopped, where things stand, and the next steps with the one that moves
 * the task recommended. The card has one decision key per task, so each new card replaces the last.
 */
import { STAGE_DISPLAY_NAMES, STAGE_ORDER, type ReportContractRejectionV1, type TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import {
  describeContinueTheWorkLabelV1,
  describePlanItemsLeftV1,
  planItemsLeftFromCountsV1,
  type PlanItemsLeftV1,
} from "./continueTheWorkLabelV1";
import { normalizePath } from "./taskRoot";
import { RUN_PUBLISH_CHECKS_NOW_COMMAND_V1 } from "./testFailuresV1";
import type { PostWorkflowDecisionInputV1 } from "./workflowDecisionDispatchV1";

export const AUTOMATION_STOPPED_DECISION_KEY_V1 = "automationStopped";

export type AutomationStopEndingV1 =
  /** The owner chose a one-cycle option and the cycle finished. */
  | "one-cycle"
  /** A Fast Forward run reached its attempt cap with work left. */
  | "fast-forward-cap"
  /** A Fast Forward run stopped because nothing moved. */
  | "fast-forward-stalled"
  /** A stop rule (breaker, churn ceiling, a standing hold) ended the run. */
  | "stop-rule"
  /** The run improved the score but stopped before the work was done. */
  | "improved-but-stopped"
  /** A review came back clean for Publish but plan work remains. */
  | "publish-clean"
  /** A resumed run ended. */
  | "resumed-run"
  /** Step 31: the owner's own action (an answer, a tick or exclusion, a test run) left the stage ready to move on. */
  | "stage-ready"
  /** bugs7 item 3: a review started by the owner (an answer, a click) ended below the threshold and nothing runs next. */
  | "review-ended";

export interface AutomationStopFactsV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly ending: AutomationStopEndingV1;
  /** Why it stopped, in plain words ("the one cycle you chose is done"). */
  readonly stopReason: string;
  /**
   * bugs7 item 6: a hash of the state the card describes (stage, ending, the review's content, the plan revision and
   * the settled counts), never of the caller's wording. The same state is one card, whoever raised it.
   */
  readonly stateFingerprint?: string;
  readonly score?: number | null;
  readonly previousScore?: number | null;
  /** The sorted blockers (Step 19): work a round can do, and blockers that cannot move in another round. */
  readonly blockers: {
    readonly fixFirst: number;
    readonly buildToClear: number;
    readonly notThisRound: number;
    /** bugs6 item 45: how many of `notThisRound` are lines the review wrote with no resolver tag. */
    readonly unstated?: number;
  };
  /** Step 5's counts. */
  readonly planItems?: { readonly total: number; readonly settled: number; readonly open: number; readonly provisional: number };
  /** The review's "Build next" / "Next step" lines, already shortened. */
  readonly buildNext: readonly string[];
  /** Dismissed cards something still depends on (for example a refused test command). */
  readonly dismissedDependencies: readonly string[];
  /** The review on record is current and clean (no blocker of any group). */
  readonly reviewClean: boolean;
  /** The completeness gate is complete: every plan item ticked, excluded or handed to the owner. */
  readonly gateComplete: boolean;
  /**
   * The plan's item count could not be read (the plan or the progress file was unreadable). The gate is then
   * unknown, never complete: `gateComplete` is false and the card says so instead of treating the stage as ready.
   */
  readonly planCountUnavailable?: boolean;
  /** Fast Forward was the thing running when it stopped (used for the wording of "Start Fast Forward"). */
  readonly fastForwardWasRunning: boolean;
  /** Step 51: how many of the review's blockers are about tests that fail (each is a reason to run the checks and look). */
  readonly failingTestsBlockers?: number;
  /** Step 35: a report-contract rejection that has now happened three times in the task. */
  readonly repeatedRejection?: { readonly kind: ReportContractRejectionV1["kind"]; readonly count: number; readonly lastReason: string };
  /**
   * review2 Step 23: why Fast Forward would stop at once if started now (an open partial-scope hold). While it is open,
   * "Start Fast Forward" is never the recommendation: it would dispatch no round.
   */
  readonly startHold?: string;
}

/**
 * What Fast Forward covers, said the same way on every card that offers it (owner decision 2026-11-11,
 * step-19-chain-boundary): it continues through the review stages, Publish Checks, fix rounds and the Publish review,
 * and stops at Commit & Push, which stays the owner's click. It also stops where a decision is genuinely the owner's.
 */
export const FAST_FORWARD_COVERS_V1 =
  "When a stage is done it moves on and carries on through the review stages, Publish Checks, fix rounds and the Publish review. " +
  "It stops at Commit & Push, which stays your click, and wherever a decision is genuinely yours.";

export type AutomationNextStepIdV1 = "moveOn" | "startFastForward" | "runOneMoreCycle" | "continueTheWork" | "leaveWithMe";

export function nextStageAfterV1(stage: TaskStage): TaskStage | undefined {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 ? STAGE_ORDER[index + 1] : undefined;
}

/**
 * The next step that moves the task, or `undefined` when no step is better than the owner's own judgement.
 * Move on only when the gate is complete and the review is clean; otherwise work a round can do comes first;
 * otherwise (only blockers that cannot move remain) the move is the owner's.
 */
export function recommendNextStepV1(facts: AutomationStopFactsV1): AutomationNextStepIdV1 | undefined {
  const nextStage = nextStageAfterV1(facts.stage);
  if (facts.gateComplete && facts.reviewClean && nextStage !== undefined) return "moveOn";
  const workable = facts.blockers.fixFirst + facts.blockers.buildToClear;
  const itemsToBuild = facts.planItems?.open ?? 0;
  // Nothing a round can build or fix is left, and the stage is not ready to move on (a blocker only the owner can
  // settle, or built items still waiting for a check): the move is the owner's.
  // An unreadable plan count is not "nothing left": recommend nothing rather than something false.
  if (workable === 0 && facts.planCountUnavailable === true) return undefined;
  if (workable === 0 && itemsToBuild === 0) return "leaveWithMe";
  // A run that stalled made no progress: starting the same thing again is not a recommendation.
  if (facts.ending === "fast-forward-stalled" || facts.ending === "stop-rule") return undefined;
  if (facts.stage === "impl") return "continueTheWork";
  // review2 Step 23: Fast Forward would stop at once on an open hold; recommend what can run instead.
  return facts.startHold !== undefined ? "runOneMoreCycle" : "startFastForward";
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The lines under a review's "Build next" or "Next step" heading, shortened to a few lines. */
export function extractBuildNextLinesV1(reviewText: string | undefined, maxLines = 4): string[] {
  if (!reviewText) return [];
  const lines = reviewText.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s*(?:#{1,6}\s*|\*\*)?\s*(?:build next|next steps?)\b/i.test(line));
  if (headingIndex < 0) return [];
  const heading = lines[headingIndex]!;
  const out: string[] = [];
  // "**Next step:** run those tests." — text on the heading line itself.
  const inline = /(?:build next|next steps?)\s*\**\s*:\s*\**\s*(.+)$/i.exec(heading);
  if (inline?.[1] && inline[1].replace(/[*_#:\s]/g, "").length > 0) out.push(shorten(inline[1].replace(/^\**\s*/, ""), 160));
  for (let i = headingIndex + 1; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i]!;
    if (/^\s*#{1,6}\s/.test(line)) break;
    const item = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)/.exec(line);
    if (item?.[1]) out.push(shorten(item[1], 160));
    else if (line.trim() === "" && out.length > 0) break;
  }
  return out;
}

/** review1 Step 56: the same "N of M plan items left" figure the Tasks row tooltip and the stage action show, from Step 5's counts. */
function itemsLeftOf(facts: AutomationStopFactsV1): PlanItemsLeftV1 | undefined {
  return facts.planItems && facts.planItems.total > 0 ? planItemsLeftFromCountsV1(facts.planItems) : undefined;
}

function scoreLine(facts: AutomationStopFactsV1): string | undefined {
  if (typeof facts.score !== "number") return undefined;
  const prior = typeof facts.previousScore === "number" ? facts.previousScore : undefined;
  const left = itemsLeftOf(facts);
  // N of M sits next to the score, so the verdict is never read without how much of the plan is still unbuilt.
  const withItems = left ? ` (${describePlanItemsLeftV1(left)})` : "";
  if (prior === undefined || prior === facts.score) {
    return `The latest review scored ${facts.score}/10${prior === facts.score ? " (unchanged)" : ""}${withItems}.`;
  }
  return `The latest review scored ${facts.score}/10, ${facts.score > prior ? "up" : "down"} from ${prior}/10${withItems}.`;
}

function blockersLine(facts: AutomationStopFactsV1): string {
  const { fixFirst, buildToClear } = facts.blockers;
  const unstated = Math.min(facts.blockers.unstated ?? 0, facts.blockers.notThisRound);
  const notThisRound = facts.blockers.notThisRound - unstated;
  const total = fixFirst + buildToClear + notThisRound + unstated;
  if (total === 0) return "The review lists no blockers.";
  const parts: string[] = [];
  if (fixFirst > 0) parts.push(`${fixFirst} to fix first`);
  if (buildToClear > 0) parts.push(`${buildToClear} that building the named plan steps clears`);
  if (notThisRound > 0) parts.push(`${notThisRound} that another round cannot move (they need you, or no code change resolves them)`);
  if (unstated > 0) parts.push(`${unstated} whose kind the review didn't state (read ${unstated === 1 ? "it" : "them"} in the review)`);
  return `${total} blocker${total === 1 ? "" : "s"} left: ${parts.join(", ")}.`;
}

function planItemsLine(facts: AutomationStopFactsV1): string | undefined {
  if (facts.planCountUnavailable === true) {
    return "The plan's item count could not be read just now, so it is not known whether any plan items are left.";
  }
  const items = facts.planItems;
  if (!items) return undefined;
  const left = items.open + items.provisional;
  return `${items.settled} of ${items.total} plan items are settled; ${left === 0 ? "none are left" : `${left} left (${items.open} to build, ${items.provisional} built but not yet checked)`}.`;
}

/** The card for a stop with work left. */
export function buildAutomationStoppedCardInputV1(facts: AutomationStopFactsV1): Omit<PostWorkflowDecisionInputV1, "createdAt"> {
  const stageName = STAGE_DISPLAY_NAMES[facts.stage] ?? facts.stage;
  const nextStage = nextStageAfterV1(facts.stage);
  const nextStageName = nextStage !== undefined ? STAGE_DISPLAY_NAMES[nextStage] : undefined;
  const taskArg = { taskFolderPath: facts.taskFolderPath };

  const ready = facts.ending === "stage-ready";
  const lines = [
    ready
      ? `${stageName} is done: ${facts.stopReason}.`
      : facts.ending === "review-ended"
        ? `${stageName}: ${facts.stopReason}.`
        : `Automation stopped on ${stageName}: ${facts.stopReason}.`,
    scoreLine(facts),
    blockersLine(facts),
    planItemsLine(facts),
    // Owner decision 2026-11-11: the end of Publish is Commit & Push, the owner's click; no option here runs it.
    ready && facts.stage === "publish"
      ? "Next: Commit & Push. It stays your click: Fast Forward and the countdown never run it."
      : undefined,
    facts.buildNext.length > 0 ? `The review's next steps: ${facts.buildNext.map((line, i) => `${i + 1}. ${line}`).join(" ")}` : undefined,
    ...facts.dismissedDependencies.map((line) => `Still outstanding from a card you dismissed: ${line}`),
    facts.repeatedRejection
      ? `A round's report has been rejected for the same reason ${facts.repeatedRejection.count} times in this task (${facts.repeatedRejection.kind}); the last reason: ${shorten(facts.repeatedRejection.lastReason, 240)}`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  const options: WorkflowDecisionOptionV1[] = [];
  const nextStageMovesOn = facts.gateComplete && facts.reviewClean && nextStage !== undefined;
  if (nextStageMovesOn) {
    options.push({
      optionId: "moveOn",
      label: `Move on to ${nextStageName}`,
      consequence: `Every plan item is settled and the review is clean, so this advances to ${nextStageName} and starts its own next action.`,
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.nextStage", args: [taskArg] },
      recordedNext: `${nextStageName} starts`,
      // review1 Step 53: moving on to the next *review* after a clean review loses nothing and needs no judgement,
      // so it may run by itself after the wait. Moving on to Publish stays the owner's call.
      ...(/review$/.test(nextStage) ? { unattendedSafe: true } : {}),
    });
    // bugs7 item 7 (Step 17): on a done stage Fast Forward moves on by itself and carries on in the next stage (a
    // review stage, then Publish). The command is the ordinary Fast Forward: started on a stage that is already done,
    // it crosses the edge instead of ending at once. Commit & Push is never part of it.
    if (/review$/.test(nextStage) || nextStage === "publish") {
      options.push({
        optionId: "moveOnAndFastForward",
        label: `Move on and Fast Forward ${nextStageName}`,
        consequence: `Moves on to ${nextStageName} now and keeps going there (fix, build, re-review). ${FAST_FORWARD_COVERS_V1}`,
        resumeKind: "continue",
        effect: { kind: "command", command: "vs-code-ai-helper.fastForwardReviewWithAI", args: [taskArg] },
        recordedNext: `${nextStageName} starts and Fast Forward runs there`,
      });
    }
  }
  if (facts.stage === "impl") {
    options.push({
      optionId: "continueTheWork",
      label: describeContinueTheWorkLabelV1(itemsLeftOf(facts)),
      consequence: "Runs one more Implementation round against the plan items still open, then stops and tells you where things stand.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction", args: [taskArg] },
      recordedNext: "one more Implementation round runs",
    });
  } else if (!(facts.gateComplete && facts.reviewClean)) {
    // bugs7 item 6: a stage that is already done has nothing for Fast Forward or a cycle to do: both would stop at
    // once. The card then offers moving on (above) and leaving it, never a run that cannot do anything.
    options.push({
      optionId: "startFastForward",
      label: "Start Fast Forward",
      consequence: `Keeps going on ${stageName} (fix, build, re-review) up to its round limit, stopping when the review is clean and every plan item is settled, or when nothing moves. ${FAST_FORWARD_COVERS_V1}`,
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.fastForwardReviewWithAI", args: [taskArg] },
      recordedNext: "Fast Forward runs",
    });
    options.push({
      optionId: "runOneMoreCycle",
      // Step 56: this is the "Continue the work" round, named for the work and never as a step back to Implementation.
      // The label carries the shared N-of-M figure and says up front that it is one cycle.
      label: `${describeContinueTheWorkLabelV1(itemsLeftOf(facts))} — one cycle, then stops`,
      consequence: `${describeContinueTheWorkLabelV1(itemsLeftOf(facts))}: runs one Apply Review (fix the blockers it can, build the next plan steps) and one re-review of ${stageName}, then stops and tells you where things stand. It does not start Fast Forward.`,
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction", args: [taskArg] },
      recordedNext: "one Apply Review and one re-review run, then it stops",
    });
  }
  if ((facts.failingTestsBlockers ?? 0) > 0) {
    options.push({
      optionId: "runPublishChecksNow",
      label: "Run Publish Checks now",
      consequence:
        "Runs the project's Publish Checks once, now, with no model round, and saves the failing tests it finds " +
        "(name, assertion, file and line). The next Apply Review is given them, so it fixes the tests it can see failing.",
      resumeKind: "unpause",
      effect: {
        kind: "command",
        command: RUN_PUBLISH_CHECKS_NOW_COMMAND_V1,
        args: [{ ...taskArg, stage: facts.stage }],
      },
      recordedNext: "Publish Checks run and the failing tests are saved for the next round",
    });
  }
  if (facts.repeatedRejection) {
    options.push({
      optionId: "changeStageModel",
      label: "Change this stage's model",
      consequence: `Opens AI Models on ${stageName} so you can switch the model whose reports keep being rejected. Nothing runs until you start it again.`,
      resumeKind: "unpause",
      effect: { kind: "command", command: "vs-code-ai-helper.openAiModels", args: [facts.stage] },
      recordedNext: "AI Models is open on this stage",
    });
  }
  options.push({
    optionId: "leaveWithMe",
    label: "Leave it with me",
    consequence: "Does nothing now. The task stays where it is; start Fast Forward or any stage action when you are ready.",
    resumeKind: "unpause",
    effect: { kind: "doNothing", recordedNext: "the task stays where it is" },
  });

  const recommended = recommendNextStepV1(facts);
  const recommendation: WorkflowDecisionRecommendationV1 =
    recommended === undefined
      ? {
          kind: "none",
          reasoning:
            facts.planCountUnavailable === true
              ? "The plan's item count could not be read, so Ensemble can't tell whether the stage is finished or which step is right. Check the plan, then choose."
              : "Starting the same automation again is unlikely to change the result, and Ensemble can't tell which of the other steps is right. That is your call.",
        }
      : recommended === "moveOn"
        ? { kind: "option", optionId: "moveOn", reasoning: "Every plan item is settled and the review is clean: this moves the task forward." }
        : recommended === "leaveWithMe"
          ? {
              kind: "option",
              optionId: "leaveWithMe",
              reasoning: "What is left is for you to settle (an owner decision, or something no code change resolves); another round would not move it.",
            }
          : recommended === "runOneMoreCycle"
            ? {
                kind: "option",
                optionId: "runOneMoreCycle",
                reasoning:
                  `Fast Forward would stop at once (${facts.startHold}), so no round would run. ` +
                  "One cycle does not depend on that hold and works on what a round can do.",
              }
            : {
                kind: "option",
                optionId: recommended === "continueTheWork" ? "continueTheWork" : "startFastForward",
                reasoning: "Work a round can do is left, and this is the step that does it.",
              };

  return {
    decisionKey: AUTOMATION_STOPPED_DECISION_KEY_V1,
    taskCanonicalId: normalizePath(facts.taskFolderPath),
    stage: facts.stage,
    whatHappened: lines.join(" "),
    whyUserNeeded: ready
      ? facts.stage === "publish"
        ? "Commit & Push publishes the work, so it waits for your click."
        : "Moving to the next stage changes what the task works on, so it waits for you."
      : // review2 Step 23: a card that marks a step as recommended does not claim to stay neutral.
        recommendation.kind === "none"
        ? "Automation stopped with work left, and it does not choose between these next steps for you."
        : "Automation stopped with work left. One step is marked as the one Ensemble would take; the choice is still yours.",
    options,
    recommendation,
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Choose the next step for this stage" },
  };
}
