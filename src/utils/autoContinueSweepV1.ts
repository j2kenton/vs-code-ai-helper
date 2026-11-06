/**
 * review1 Step 53: one pass of the periodic sweep over cards with an armed countdown. The dependencies are passed in
 * so the pass is testable without VS Code; `autoContinueSweepWiringV1.ts` supplies the real ones.
 *
 * For each armed card, in order: a card that is no longer pending is skipped; a countdown whose task moved on is
 * cancelled and the card re-offered from the task's current state (when it cannot be, the card stays, without a
 * countdown); a countdown still running is left; a finished countdown asks the
 * automatic-dispatch gate (Step 24), waits while a round is running on the task, and otherwise runs the option.
 */
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { describeKeepGoingAppliedLineV1 } from "./autoContinueKeepGoingV1";
import {
  describeAutoContinuedLineV1,
  evaluateAutoContinueV1,
  type AutoContinueTaskStateV1,
} from "./autoContinueV1";

export interface AutoContinueSweepDepsV1 {
  listArmed(): readonly WorkflowDecisionV1[];
  readTaskState(taskFolderPath: string): Promise<AutoContinueTaskStateV1>;
  cancel(decisionId: string, reason: string): Promise<void>;
  /** The Step 24 gate. False means the gate holds the task (it has already raised its own card). */
  admit(decision: WorkflowDecisionV1): Promise<boolean>;
  /** True while a round or other operation is running on the task; the countdown then waits for the next pass. */
  taskIsBusy(taskFolderPath: string): boolean;
  /** Runs the option exactly as an owner choice would, as an automatic dispatch that passed the gate. */
  run(decisionId: string, optionId: string): Promise<{ readonly ok: boolean }>;
  say(decisionId: string, text: string): Promise<void>;
  /**
   * Re-offers a card whose countdown was cancelled because the task moved on: withdraws the stale card and lets
   * whatever raised it post a fresh one from the task's current state. Returns false when nothing could be
   * re-offered (the card then stays open without a countdown).
   */
  reoffer(decision: WorkflowDecisionV1): Promise<boolean>;
  now(): number;
}

export interface AutoContinueSweepResultV1 {
  readonly ran: readonly string[];
  readonly cancelled: readonly string[];
  readonly refused: readonly string[];
}

export async function runAutoContinueSweepV1(deps: AutoContinueSweepDepsV1): Promise<AutoContinueSweepResultV1> {
  const ran: string[] = [];
  const cancelled: string[] = [];
  const refused: string[] = [];
  for (const decision of deps.listArmed()) {
    const taskState = await deps.readTaskState(decision.taskCanonicalId);
    const verdict = evaluateAutoContinueV1(decision, deps.now(), taskState);
    if (verdict.kind === "wait") continue;
    if (verdict.kind === "cancel") {
      await deps.cancel(decision.decisionId, verdict.reason);
      if (verdict.stateChanged === true && (await deps.reoffer(decision))) {
        cancelled.push(decision.decisionId);
        continue;
      }
      await deps.say(
        decision.decisionId,
        `The countdown on this card was stopped (${verdict.reason}). The card is still open; choose when you are ready.`
      );
      cancelled.push(decision.decisionId);
      continue;
    }
    if (deps.taskIsBusy(decision.taskCanonicalId)) continue;
    const option = decision.options.find((candidate) => candidate.optionId === verdict.optionId);
    if (!(await deps.admit(decision))) {
      await deps.cancel(decision.decisionId, "the “is this working?” check is holding automation for this task");
      refused.push(decision.decisionId);
      continue;
    }
    // The line first, so the chat reads "continued automatically" before the option's own acknowledgement.
    await deps.say(
      decision.decisionId,
      decision.autoContinue?.keepGoing === true
        ? describeKeepGoingAppliedLineV1(option?.label ?? verdict.optionId)
        : describeAutoContinuedLineV1(option?.label ?? verdict.optionId, decision.autoContinue?.minutes ?? 0)
    );
    const outcome = await deps.run(decision.decisionId, verdict.optionId);
    if (outcome.ok) {
      ran.push(decision.decisionId);
    } else {
      // The option did not take (the card is back, or it could not be recorded): do not retry on every pass.
      await deps.cancel(decision.decisionId, "the option could not be run");
      cancelled.push(decision.decisionId);
    }
  }
  return { ran, cancelled, refused };
}
