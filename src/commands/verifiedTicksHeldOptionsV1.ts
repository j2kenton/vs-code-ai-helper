import type {
  WorkflowDecisionDeferredAnswerV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionV1,
} from "../types/workflowDecisionV1";

/**
 * bugs5 Steps 2-3: the two answers the reviewer-verified-ticks card offers while an operation (a
 * Fast Forward run, say) holds the task, beside the dispatching "Apply" the operation holds back:
 *
 * - **Apply the N ticks now**: only the monotonic tick merge, no dispatch. Dispatching stays Fast
 *   Forward's job.
 * - **Apply when Fast Forward next pauses**: the full answer (ticks, then the next action),
 *   accepted now and carried out when nothing runs for the task.
 *
 * Pure of VS Code so the card's view layer, the store and the tests can all share it.
 */

export const APPLY_OPTION_ID_V1 = "apply";
export const APPLY_TICKS_NOW_OPTION_ID_V1 = "applyTicksNow";
export const APPLY_WHEN_PAUSED_OPTION_ID_V1 = "applyWhenFastForwardPauses";
export const APPLY_TICKS_NOW_COMMAND_V1 = "vs-code-ai-helper.applyReviewerVerifiedTicksNow";
export const APPLY_TICKS_DECISION_KEY_V1 = "applyReviewerVerifiedTicks";

/** What the card says while its Apply is held and the answer can be given now for later (Step 3). */
export const HELD_CARD_STAYS_OPEN_NOTE_V1 =
  "This card stays open. Its Apply button comes back when Fast Forward ends. A newer review's card would " +
  "replace this one, and your answer carries over to the items they share.";

interface ApplyArgsV1 {
  readonly offeredItems?: readonly string[];
  readonly [key: string]: unknown;
}

function applyOptionOfV1(record: Pick<WorkflowDecisionV1, "options">): WorkflowDecisionOptionV1 | undefined {
  return record.options.find((option) => option.optionId === APPLY_OPTION_ID_V1);
}

function applyArgsOfV1(option: WorkflowDecisionOptionV1 | undefined): ApplyArgsV1 | undefined {
  if (!option || option.effect.kind !== "command") {
    return undefined;
  }
  const first = option.effect.args?.[0];
  return first && typeof first === "object" ? (first as ApplyArgsV1) : undefined;
}

/** The item texts the card offers to tick (the Apply option's `offeredItems`), or `[]`. */
export function offeredTickItemsOfV1(record: Pick<WorkflowDecisionV1, "options">): readonly string[] {
  return applyArgsOfV1(applyOptionOfV1(record))?.offeredItems ?? [];
}

export function isVerifiedTicksDecisionV1(record: Pick<WorkflowDecisionV1, "decisionKey">): boolean {
  return record.decisionKey === APPLY_TICKS_DECISION_KEY_V1;
}

/**
 * The two held-answer options for a reviewer-verified-ticks card, or `[]` for any other card or
 * one whose Apply option carries no offered items. Independent of whether an operation is live, so
 * a click that arrives just after the operation ended still finds its option.
 */
export function buildHeldTicksAnswerOptionsV1(
  record: Pick<WorkflowDecisionV1, "decisionKey" | "options">
): readonly WorkflowDecisionOptionV1[] {
  if (!isVerifiedTicksDecisionV1(record)) {
    return [];
  }
  const apply = applyOptionOfV1(record);
  const args = applyArgsOfV1(apply);
  if (!apply || apply.effect.kind !== "command" || !args?.offeredItems?.length) {
    return [];
  }
  const count = args.offeredItems.length;
  const noun = count === 1 ? "tick" : "ticks";
  const { resumeFastForwardV1: _resume, ...tickOnlyArgs } = args;
  return [
    {
      optionId: APPLY_TICKS_NOW_OPTION_ID_V1,
      label: `Apply the ${count} ${noun} now`,
      resumeKind: "unpause",
      consequence:
        `Ticks the ${count} item(s) in plan-final.md and dispatches nothing, so Fast Forward keeps running and its ` +
        "next round counts them. If a round is open, the ticks are applied as soon as it ends, before Fast " +
        "Forward's next decision. An item that is already ticked is reported, never ticked twice.",
      recordedNext: `ticking the ${count} ${noun} in plan-final.md without starting anything`,
      effect: { kind: "command", command: APPLY_TICKS_NOW_COMMAND_V1, args: [tickOnlyArgs] },
    },
    {
      optionId: APPLY_WHEN_PAUSED_OPTION_ID_V1,
      label: "Apply when Fast Forward next pauses",
      resumeKind: "continue",
      runsWhenTaskFree: true,
      consequence:
        `Keeps your answer now and carries it out the first time nothing is running for this task: ticks the ` +
        `${count} item(s), then dispatches the stage's next action, as Apply does. ${HELD_CARD_STAYS_OPEN_NOTE_V1}`,
      recordedNext: "your answer is kept and will be carried out when nothing is running for this task",
      effect: apply.effect,
    },
  ];
}

export interface DeferredAnswerCarryOverV1 {
  /** Items the earlier answer covered that the replacement card also offers. */
  readonly carried: readonly string[];
  /** Items the earlier answer covered that the replacement no longer offers. */
  readonly dropped: readonly string[];
  /** Items the replacement offers that the earlier answer never saw. */
  readonly newItems: readonly string[];
}

/** Which of an earlier answer's items carry over to a replacement card's offered items (same text). */
export function computeDeferredAnswerCarryOverV1(
  answeredItems: readonly string[],
  replacementItems: readonly string[]
): DeferredAnswerCarryOverV1 {
  const replacement = new Set(replacementItems);
  const answered = new Set(answeredItems);
  return {
    carried: answeredItems.filter((item) => replacement.has(item)),
    dropped: answeredItems.filter((item) => !replacement.has(item)),
    newItems: replacementItems.filter((item) => !answered.has(item)),
  };
}

function shorten(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The one chat line for a carry-over (Step 3), naming any item that dropped out. */
export function describeDeferredAnswerCarryOverV1(carryOver: DeferredAnswerCarryOverV1): string {
  const total = carryOver.carried.length + carryOver.newItems.length;
  if (carryOver.carried.length === 0) {
    return (
      "A newer review replaced the card, and none of its items are ones your earlier answer covered, so the " +
      "answer was not carried over. The new card waits for you."
    );
  }
  const dropped =
    carryOver.dropped.length > 0
      ? ` These items dropped out because the newer review no longer lists them: ${carryOver.dropped
          .map((item) => `"${shorten(item)}"`)
          .join(", ")}.`
      : "";
  return (
    `Your earlier answer was carried over to ${carryOver.carried.length} of the ${total} items; ` +
    `${carryOver.newItems.length} new item${carryOver.newItems.length === 1 ? " waits" : "s wait"} for you.${dropped}`
  );
}

/**
 * The deferred answer a replacement card keeps, restricted to the items it shares with the earlier
 * answer; `undefined` when nothing is shared.
 */
export function carryDeferredAnswerOverV1(
  previous: WorkflowDecisionDeferredAnswerV1,
  carryOver: DeferredAnswerCarryOverV1
): WorkflowDecisionDeferredAnswerV1 | undefined {
  return carryOver.carried.length > 0 ? { ...previous, itemKeys: carryOver.carried } : undefined;
}

/** The note the held card shows about its own kept answer. */
export function describeKeptDeferredAnswerV1(answer: WorkflowDecisionDeferredAnswerV1): string {
  const n = answer.itemKeys.length;
  return (
    `Your answer is kept: apply ${n} tick${n === 1 ? "" : "s"} and dispatch the next action, accepted ` +
    `${answer.acceptedAt.slice(11, 16)} UTC. It runs the first time nothing is running for this task.`
  );
}
