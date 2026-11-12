/**
 * bugs7 item 7 (Step 19): Fast Forward crosses a clean stage edge. When a Fast Forward run ends because the stage's
 * review is clean and every plan item is settled, and a next stage exists (a review stage, then Publish), the task
 * moves on through the same path "Complete Stage & Move On" uses and Fast Forward carries on there with its own round
 * budget. No card and no countdown in between.
 *
 * Owner decision 2026-11-11 (step-19-chain-boundary, replacement): Fast Forward does not stop before Publish. It carries
 * on into Publish (Publish Checks, fix rounds, the Publish review) and stops at Commit & Push, which stays the owner's
 * click: nothing in this module runs it. When Publish Checks fail, the invocation runs a fix round and checks again
 * (bounded) before the Publish review.
 *
 * Pure: every host effect is a dependency, so the loop is testable without a host.
 */
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import { nextStageAfterV1 } from "./automationStopV1";

/** A bound on stages crossed in one chain (the review stages are few; this only guards a loop). */
export const FAST_FORWARD_MAX_STAGE_CROSSINGS_V1 = 3;

/** Publish fix rounds one Fast Forward invocation runs after failed Publish Checks (then it hands back with the card). */
export const FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1 = 2;

/**
 * The next stage Fast Forward may move into by itself: a review stage, or Publish. `undefined` at Publish: the run
 * ends there at Commit & Push, which Fast Forward never executes.
 */
export function fastForwardCrossingTargetV1(stage: TaskStage): TaskStage | undefined {
  const next = nextStageAfterV1(stage);
  return next !== undefined && (/review$/.test(next) || next === "publish") ? next : undefined;
}

/** The line Fast Forward leaves at the end of Publish: Commit & Push is the owner's click, never run automatically. */
export function commitPushBoundaryLineV1(): string {
  return "Fast Forward is finished: Publish is clean. Commit & Push is next, and it stays your click: Fast Forward never runs it.";
}

/** True when `stage` is `from` or a later stage (walking the stage order forward from `from`). */
export function stageIsAtOrAfterV1(stage: TaskStage, from: TaskStage): boolean {
  for (let cursor: TaskStage | undefined = from; cursor !== undefined; cursor = nextStageAfterV1(cursor)) {
    if (cursor === stage) return true;
  }
  return false;
}

/** True for a stage Fast Forward may carry on in after a move: a review stage or Publish. */
export function fastForwardCanContinueInV1(stage: TaskStage): boolean {
  return /review$/.test(stage) || stage === "publish";
}

export interface StageEdgeFactsV1 {
  /** The task is active (not paused or finished). */
  readonly active: boolean;
  /** The stage the task is on now (a read, never a write). */
  readonly taskStage: TaskStage | undefined;
  readonly reviewClean: boolean;
  readonly gateComplete: boolean;
  /** An open hold (a partial-scope hold) that the owner has to settle first. */
  readonly hold: boolean;
}

export interface StageEdgeDepsV1 {
  /** Runs one Fast Forward on the task's current stage. */
  readonly runFastForward: () => Promise<void>;
  /** The stage the run just ended on when it ended without a stop or a cancel (read once, then cleared). */
  readonly takeEligibleStage: () => TaskStage | undefined;
  /**
   * The review stage the run's own initial review moved the task onto by the automatic advance (read once, then
   * cleared). The run returns right after that move, so the stage was not judged clean here; the loop carries on there.
   */
  readonly takeMovedOnStage?: () => TaskStage | undefined;
  readonly readFacts: (stage: TaskStage) => Promise<StageEdgeFactsV1>;
  /** Moves the task on one stage (the "Complete Stage & Move On" path). */
  readonly advance: () => Promise<void>;
  /**
   * Resolves once nothing else is running for the task (a move-on may start its own run, and an ordinary or deferred
   * successor may be queued behind it). True when the task settled; false when work was still outstanding at the
   * wait's limit, so the invocation hands back instead of starting a run on top of it.
   */
  readonly waitUntilFree: () => Promise<boolean>;
  readonly say: (text: string, stage: TaskStage) => Promise<void>;
  /**
   * The run ended on a clean, settled stage with no stage after it (Publish): the final boundary. Raise the "is done"
   * card and name Commit & Push as the owner's next click. Fast Forward never executes it.
   */
  readonly stoppedAtCommitPushBoundary?: (stage: TaskStage) => Promise<void>;
  /** True when the run ended at Publish because its Publish Checks failed (read once, then cleared). */
  readonly takePublishChecksFailed?: () => boolean;
  /** Runs one fix round for the failed Publish Checks (the fix re-runs them); true when they pass afterwards. */
  readonly runPublishFixRound?: () => Promise<boolean>;
}

export interface StageEdgeResultV1 {
  readonly crossings: number;
  /** The stages Fast Forward moved into, in order. */
  readonly crossedInto: readonly TaskStage[];
  /** Publish fix rounds this invocation ran. */
  readonly publishFixRounds: number;
}

export async function fastForwardAcrossCleanStagesV1(
  deps: StageEdgeDepsV1,
  maxCrossings = FAST_FORWARD_MAX_STAGE_CROSSINGS_V1
): Promise<StageEdgeResultV1> {
  const crossedInto: TaskStage[] = [];
  let publishFixRounds = 0;
  await deps.runFastForward();
  while (crossedInto.length < maxCrossings + publishFixRounds) {
    const stage = deps.takeEligibleStage();
    if (stage === undefined) {
      // Publish Checks failed: run a fix round (it re-runs the checks), then carry on to the Publish review. Bounded;
      // a still-failing run hands back with the fix round's own card.
      if (deps.takePublishChecksFailed?.() === true && deps.runPublishFixRound !== undefined) {
        if (publishFixRounds >= FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1) break;
        const failedFacts = await deps.readFacts("publish");
        if (!failedFacts.active || failedFacts.taskStage !== "publish" || failedFacts.hold) break;
        publishFixRounds += 1;
        await deps.say(
          `Publish Checks failed. Running fix round ${publishFixRounds} of ${FAST_FORWARD_MAX_PUBLISH_FIX_ROUNDS_V1}, then checking again.`,
          "publish"
        );
        const passed = await deps.runPublishFixRound();
        // The fix round queues the Publish review behind itself: wait for it, then carry on from the settled state.
        const settledAfterFix = await deps.waitUntilFree();
        if (!passed || !settledAfterFix) break;
        const afterFixFacts = await deps.readFacts("publish");
        if (!afterFixFacts.active || afterFixFacts.taskStage !== "publish" || afterFixFacts.hold) break;
        await deps.runFastForward();
        continue;
      }
      // The run's own initial review reached the auto-advance threshold and moved the task onto the next review stage
      // (a legitimate automatic move that queued that stage's review). Fast Forward carries on there.
      const landed = deps.takeMovedOnStage?.();
      if (landed === undefined) break;
      const landedFacts = await deps.readFacts(landed);
      if (!landedFacts.active || landedFacts.taskStage !== landed || landedFacts.hold) break;
      await deps.say(
        `The review reached the auto-advance threshold and the task moved on to ${STAGE_DISPLAY_NAMES[landed]}. Carrying on Fast Forward there.`,
        landed
      );
      if (!(await deps.waitUntilFree())) break;
      // The queued review may itself have been clean and moved the task on again while it was awaited: carry on
      // wherever the task legitimately is now.
      const landedNow = await deps.readFacts(landed);
      // (the facts' own stage is the one the task is on now; the review facts above are read for `landed`)
      if (!landedNow.active || landedNow.taskStage === undefined || !stageIsAtOrAfterV1(landedNow.taskStage, landed)) break;
      if (!fastForwardCanContinueInV1(landedNow.taskStage) || landedNow.hold) break;
      crossedInto.push(landedNow.taskStage);
      await deps.runFastForward();
      continue;
    }
    const facts = await deps.readFacts(stage);
    if (!facts.active || facts.taskStage !== stage || !facts.reviewClean || !facts.gateComplete || facts.hold) break;
    const next = fastForwardCrossingTargetV1(stage);
    if (next === undefined) {
      await deps.stoppedAtCommitPushBoundary?.(stage);
      break;
    }
    await deps.say(
      `${STAGE_DISPLAY_NAMES[stage]} is done (clean review, every plan item settled). Moving on to ${STAGE_DISPLAY_NAMES[next]} and carrying on Fast Forward there.`,
      stage
    );
    await deps.advance();
    // The move did not happen (a confirmation was declined, a gate refused): the stage's own card says why.
    const afterMove = await deps.readFacts(next);
    if (afterMove.taskStage === undefined || !stageIsAtOrAfterV1(afterMove.taskStage, next)) break;
    if (!(await deps.waitUntilFree())) break;
    // The move awaits the next stage's own review, and a clean review there may move the task on again before the
    // command returns (for example a clean Low-Level review landing on Publish). That is legitimate progress, not a
    // failed move: carry on at the stage the task is on now.
    const after = await deps.readFacts(afterMove.taskStage);
    if (!after.active || after.taskStage === undefined || !stageIsAtOrAfterV1(after.taskStage, next)) break;
    if (!fastForwardCanContinueInV1(after.taskStage) || after.hold) break;
    crossedInto.push(after.taskStage);
    await deps.runFastForward();
  }
  return { crossings: crossedInto.length, crossedInto, publishFixRounds };
}
