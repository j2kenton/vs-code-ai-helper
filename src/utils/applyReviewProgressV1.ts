import type {
  PlanItemEvidenceV1,
  PlanItemOwnerDecisionV1,
  RoundLedgerEntryV1,
  RoundOutcomeEntryV1,
  TaskStage,
} from "../types/taskProgress";

/**
 * bugs4 Step 24 (items 18 and 21): whether recent Apply Review rounds have moved the plan.
 *
 * The plateau card used to recommend "Keep iterating" while five Apply Reviews in a row left the
 * open-item count unchanged. A round "closed" something when a reviewer verification or an owner
 * decision landed while it (or the review after it) ran. A bare model claim does not settle an item
 * for the gate, so it does not count. The
 * ledger is the only per-round record, so this reads timestamps rather than a stored count.
 */

const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled", "interrupted", "quota-blocked"]);

/**
 * Whether the literal-`impl` ledger row `row` ran while `stage` was displayed. The ledger row does not
 * carry the review stage; the `roundOutcomes` entry written with it does (matched by attempt id).
 */
function originatesFromReviewStage(
  row: RoundLedgerEntryV1,
  stage: TaskStage,
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined
): boolean {
  return (roundOutcomes ?? []).some(
    (outcome) =>
      outcome.stage === "impl" &&
      outcome.originatingReviewStage === stage &&
      outcome.attemptId !== undefined &&
      row.attemptIds.includes(outcome.attemptId)
  );
}

/** The ledger rows that were Apply Review rounds for `stage`, oldest first, terminal only. */
function terminalApplyReviewRows(
  ledger: readonly RoundLedgerEntryV1[] | undefined,
  stage: TaskStage,
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined
): RoundLedgerEntryV1[] {
  return (ledger ?? [])
    .filter(
      (row) =>
        row.mode === "apply-review" &&
        TERMINAL_STATES.has(row.state) &&
        // An Apply Review can be bookkept under the literal `impl` while a review stage is shown. Such a
        // row belongs to `stage` only when its round outcome's `originatingReviewStage` names it; an
        // absent field is never a match, so a high-level history cannot feed the low-level plateau card.
        (row.stage === stage || (row.stage === "impl" && originatesFromReviewStage(row, stage, roundOutcomes)))
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

/**
 * Timestamps at which an open plan item was settled: a reviewer verification or an owner decision.
 * A model claim is deliberately absent. It leaves the item provisional, so the gate's open count does
 * not fall and a round that only claimed items has not moved the plan.
 */
function settlementActivity(
  evidence: readonly PlanItemEvidenceV1[] | undefined,
  ownerDecisions: readonly PlanItemOwnerDecisionV1[] | undefined
): { readonly at: string; readonly roundId?: string }[] {
  const rows: { at: string; roundId?: string }[] = [];
  for (const entry of evidence ?? []) {
    for (const verification of entry.verifications ?? []) {
      rows.push({ at: verification.at, ...(verification.roundId !== undefined ? { roundId: verification.roundId } : {}) });
    }
  }
  for (const decision of ownerDecisions ?? []) {
    rows.push({ at: decision.at });
  }
  return rows;
}

/**
 * How many of the most recent consecutive Apply Review rounds for `stage` closed none of the plan's
 * open items. A round that did close something ends the count. 0 when the latest round did.
 */
export function applyReviewRoundsClosedNoneV1(input: {
  readonly stage: TaskStage;
  readonly ledger: readonly RoundLedgerEntryV1[] | undefined;
  /** `TaskProgress.roundOutcomes`; attributes literal-`impl` rows to the review stage they ran under. */
  readonly roundOutcomes?: readonly RoundOutcomeEntryV1[];
  readonly planItemEvidence?: readonly PlanItemEvidenceV1[];
  readonly ownerDecisions?: readonly PlanItemOwnerDecisionV1[];
}): number {
  const rows = terminalApplyReviewRows(input.ledger, input.stage, input.roundOutcomes);
  if (rows.length === 0) return 0;
  const activity = settlementActivity(input.planItemEvidence, input.ownerDecisions);
  let none = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const windowEnd = rows[i + 1]?.startedAt;
    const closedSomething = activity.some(
      (event) =>
        event.roundId === row.roundId ||
        (event.at >= row.startedAt && (windowEnd === undefined || event.at < windowEnd))
    );
    if (closedSomething) break;
    none++;
  }
  return none;
}

/** Fewest consecutive Apply Review rounds closing nothing that counts as "not moving". */
export const APPLY_REVIEW_NO_PROGRESS_ROUNDS_V1 = 2;

/**
 * The plateau card's stall kind (bugs4 item 21): a flat verified count with many claimed-but-unverified
 * ticks is a verification stall, not a build stall — more of the same rounds will not move it.
 */
export function isVerificationStallV1(input: {
  readonly provisional: number;
  readonly roundsClosedNone: number;
}): boolean {
  return input.provisional > 0 && input.roundsClosedNone >= APPLY_REVIEW_NO_PROGRESS_ROUNDS_V1;
}

/** "N open items; the last K Apply Review rounds closed none of them" (item 18). */
export function describeApplyReviewNoProgressV1(planItemsOpen: number, roundsClosedNone: number): string {
  return (
    `${planItemsOpen} open ${planItemsOpen === 1 ? "item" : "items"}; the last ${roundsClosedNone} Apply Review ` +
    `${roundsClosedNone === 1 ? "round" : "rounds"} closed none of them`
  );
}
