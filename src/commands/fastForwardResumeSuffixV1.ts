import {
  FastForwardRunStateV1,
  isFastForwardRunActiveV1,
  isFastForwardRunPausedProvenanceCurrentV1,
  stampFastForwardResumeProvenanceV1,
} from "../utils/activeFastForwardRunsV1";
import { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  APPLY_OPTION_ID_V1,
  APPLY_TICKS_NOW_OPTION_ID_V1,
  APPLY_WHEN_PAUSED_OPTION_ID_V1,
  HELD_CARD_STAYS_OPEN_NOTE_V1,
  buildHeldTicksAnswerOptionsV1,
  describeKeptDeferredAnswerV1,
  isVerifiedTicksDecisionV1,
  offeredTickItemsOfV1,
} from "./verifiedTicksHeldOptionsV1";
import {
  describeLiveTaskOperationV1,
  getLiveTaskOperationV1,
  LiveTaskOperationV1,
} from "../utils/liveTaskOperationLookupV1";

/**
 * RC3 item 4, Step 3: shared by the reconcile card (`reconcilePlanChecklist.ts`)
 * and the reviewer-verified-ticks card (`applyReviewerVerifiedTicks.ts`) for
 * their "…and try again" options. Both cards dispatch this stage's next
 * action once the operator confirms; previously that was always a single
 * cycle, even when a Fast Forward run was genuinely interrupted to raise the
 * card — the operator had to restart Fast Forward by hand. When Fast Forward
 * was actually active for this task at the moment the card was POSTED
 * (`state` — read from `activeFastForwardRunsV1.ts` at post time, never
 * re-derived later, for the same reason `reviewEscalation.ts`'s
 * `buildPlateauKeepIteratingOptionV1` (RC2 item 12) already captures it then:
 * by the time a human answers the card, the in-memory call stack that was
 * running Fast Forward may be long gone), the option instead resumes Fast
 * Forward from the SAME attempt budget via `resumeAndApplyCurrentStageAction`'s
 * `resumeFastForwardV1` argument — the exact path RC2 item 12 already wired
 * up. When no such run was captured (the card was raised by a single
 * owner-chosen action, or the run has since ended), the option keeps today's
 * single cycle and says so, erring towards NOT fast-forwarding per the
 * owner's stated preference (plan.md risks section).
 *
 * Review-flagged completion fix (2026-09-30): capturing the state at post
 * time is necessary but not sufficient — by the time a human answers the
 * card, the extension host may have restarted (the in-memory active-run map
 * this was read from is gone), or a different Fast Forward run for the same
 * task may have started and possibly ended in the meantime, in which case
 * the captured attempt/max numbers no longer describe anything real. Every
 * captured state here is therefore stamped with the CURRENT session id and
 * per-folder run epoch ({@link stampFastForwardResumeProvenanceV1}); the
 * consuming side ({@link isFastForwardResumeStateTrustedV1}, called from
 * `resumeAndApplyCurrentStageActionV1`) re-checks both against their CURRENT
 * values at the moment the option is actually chosen, and falls back to the
 * single-cycle dispatch when they no longer match — never re-using a stale
 * attempt count to start an unrequested Fast Forward run.
 *
 * Review-flagged completion fix, round 2 (2026-09-30, narrowed blocker
 * `62a487ef-0d12-4476-a39f-abc4016bf4d4-0`): a state with NO provenance
 * fields at all used to be trusted unconditionally, on the theory that only
 * a caller predating this fix (the plateau card) could produce that shape —
 * but an older PERSISTED reconcile/ticks card built before this fix exists
 * looks identical, so that carve-out let exactly the cards this fix was
 * meant to distrust through. Every caller that builds a
 * `resumeFastForwardV1` payload — the plateau card included — now stamps it
 * via {@link stampFastForwardResumeProvenanceV1}, so provenance is never
 * legitimately absent; a state missing either field is simply untrusted, no
 * special-casing required. Provenance alone is also not enough on its own:
 * see {@link isFastForwardRunPausedProvenanceCurrentV1}'s doc comment for
 * why the run's own ending must ALSO still be recorded as "paused for this
 * exact card", not superseded by a later, unrelated end.
 */
export interface FastForwardResumeStateV1 extends FastForwardRunStateV1 {
  readonly fastForwardSessionIdV1?: string;
  readonly fastForwardRunEpochV1?: number;
  /** bugs5 Step 19: when the card captured this state (ms since epoch). */
  readonly fastForwardCapturedAtMsV1?: number;
  /** bugs5 Step 19: the stage the run was paused at when the card captured this state. */
  readonly fastForwardStageV1?: string;
  /**
   * review1 Step 32: set only by the lost-round card when the run's in-memory state was gone. It names the lost
   * round whose ledger row carries the run's counters (`RoundLedgerEntryV1.fastForwardRunV1`); the answer is
   * checked against the task's own records by `decideLedgerBackedFastForwardResumeV1`.
   */
  readonly fastForwardLedgerRoundIdV1?: string;
  /**
   * review1 Step 32: set only on the lost-round card's "continue, then keep going with Fast Forward" option, for a
   * lost round whose row carries no run stamp (it was opened before Ensemble recorded one, so the records cannot
   * say whether Fast Forward was running). The owner's own choice of this option stands in for the missing stamp;
   * every other check of `decideLedgerBackedFastForwardResumeV1` still applies.
   */
  readonly fastForwardOwnerStartedV1?: true;
}

/** What `decideLedgerBackedFastForwardResumeV1` reads from the task's own records at the moment of choosing. */
export interface LedgerBackedFastForwardResumeFactsV1 {
  readonly status: string | undefined;
  readonly currentStage: string | undefined;
  /** An operation is running for the task right now. */
  readonly hasLiveOperation: boolean;
  /** A Fast Forward run is live in this window for the task right now. */
  readonly fastForwardRunLive: boolean;
  /** The lost round's ledger row, if it still exists. */
  readonly lostRound: { readonly startedAtMs: number; readonly hasFastForwardStamp: boolean } | undefined;
  /** Start time (ms) of the newest round-ledger row, if any. */
  readonly latestRoundStartedAtMs: number | undefined;
}

/**
 * review1 Step 32: the lost-round card resumes Fast Forward from the round ledger instead of from the window's
 * memory. Trusted only when the task's own records show the lost round carried a Fast Forward stamp, it is still
 * the newest round, and the task is still paused at the captured stage with nothing running.
 */
export function decideLedgerBackedFastForwardResumeV1(
  state: FastForwardResumeStateV1,
  facts: LedgerBackedFastForwardResumeFactsV1
): DurableFastForwardResumeDecisionV1 {
  if (state.fastForwardLedgerRoundIdV1 === undefined) {
    return { trusted: false, reason: "the card did not name the round it continues" };
  }
  if (!facts.lostRound) {
    return { trusted: false, reason: "the lost round's record is no longer in the task's history" };
  }
  if (!facts.lostRound.hasFastForwardStamp && state.fastForwardOwnerStartedV1 !== true) {
    return { trusted: false, reason: "the lost round's record no longer shows it was part of a Fast Forward run" };
  }
  if (facts.fastForwardRunLive || facts.hasLiveOperation) {
    return { trusted: false, reason: "something else is running for this task now" };
  }
  if (facts.status !== "paused") {
    return { trusted: false, reason: "the task is no longer paused for this card" };
  }
  if (state.fastForwardStageV1 !== undefined && facts.currentStage !== state.fastForwardStageV1) {
    return { trusted: false, reason: "the task has moved to another stage since the card was raised" };
  }
  if (facts.latestRoundStartedAtMs !== undefined && facts.latestRoundStartedAtMs > facts.lostRound.startedAtMs) {
    return { trusted: false, reason: "a round started after the lost one" };
  }
  return { trusted: true };
}

/** The resume payload the lost-round card carries when the run's counters come from the lost round's ledger row. */
export function buildLedgerBackedFastForwardResumeV1(input: {
  readonly stage: string;
  readonly lostRoundId: string;
  readonly run: { readonly attemptNumber: number; readonly maxAttempts: number };
}): FastForwardResumeStateV1 {
  return {
    attemptNumber: input.run.attemptNumber,
    maxAttempts: input.run.maxAttempts,
    fastForwardLedgerRoundIdV1: input.lostRoundId,
    fastForwardCapturedAtMsV1: Date.now(),
    fastForwardStageV1: input.stage,
  };
}

/**
 * review1 Step 32: the resume payload for a lost round whose row has no Fast Forward stamp (opened before stamps
 * existed). Choosing the option that carries it starts a Fast Forward run at the first attempt of the configured
 * budget, from the working tree; the owner's choice is recorded on the payload instead of a stamp.
 */
export function buildOwnerStartedFastForwardResumeV1(input: {
  readonly stage: string;
  readonly lostRoundId: string;
  readonly maxAttempts: number;
}): FastForwardResumeStateV1 {
  return {
    attemptNumber: 1,
    maxAttempts: input.maxAttempts,
    fastForwardLedgerRoundIdV1: input.lostRoundId,
    fastForwardOwnerStartedV1: true,
    fastForwardCapturedAtMsV1: Date.now(),
    fastForwardStageV1: input.stage,
  };
}

/** What `decideDurableFastForwardResumeV1` reads from the task's own records at the moment of choosing. */
export interface DurableFastForwardResumeFactsV1 {
  readonly currentSessionId: string;
  readonly status: string | undefined;
  readonly currentStage: string | undefined;
  /** An operation is running for the task right now. */
  readonly hasLiveOperation: boolean;
  /** Start time (ms) of the newest round-ledger row, if any. */
  readonly latestRoundStartedAtMs: number | undefined;
}

export type DurableFastForwardResumeDecisionV1 =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly reason: string };

/**
 * bugs5 Step 19 (item 8): the in-memory pause provenance is lost when the window or extension host
 * restarts, so an owner who answers a plateau card an hour later, after an update, got one
 * Apply Review and one review, then silence. After a restart the card's captured run details
 * (attempt N of M, stage, capture time) are trusted instead when the task's own records show that the
 * run ended by pausing and nothing has started since: the task is still paused at the captured
 * stage, no operation is running, and no round started after the card was captured.
 *
 * Only used when the session id differs. In the SAME session the in-memory record is authoritative:
 * if it no longer names this run's pause, the run ended another way or a new one started.
 */
export function decideDurableFastForwardResumeV1(
  state: FastForwardResumeStateV1,
  facts: DurableFastForwardResumeFactsV1
): DurableFastForwardResumeDecisionV1 {
  if (state.fastForwardSessionIdV1 === undefined || state.fastForwardCapturedAtMsV1 === undefined) {
    return { trusted: false, reason: "the card did not record when its Fast Forward run paused" };
  }
  if (state.fastForwardSessionIdV1 === facts.currentSessionId) {
    return { trusted: false, reason: "that Fast Forward run has since ended another way, or a different run started" };
  }
  if (facts.hasLiveOperation) {
    return { trusted: false, reason: "something else is running for this task now" };
  }
  if (facts.status !== "paused") {
    return { trusted: false, reason: "the task is no longer paused for this card" };
  }
  if (state.fastForwardStageV1 !== undefined && facts.currentStage !== state.fastForwardStageV1) {
    return { trusted: false, reason: "the task has moved to another stage since the card was raised" };
  }
  if (facts.latestRoundStartedAtMs !== undefined && facts.latestRoundStartedAtMs > state.fastForwardCapturedAtMsV1) {
    return { trusted: false, reason: "a round started after the card was raised" };
  }
  return { trusted: true };
}

/**
 * Whether a captured {@link FastForwardResumeStateV1} is still safe to resume
 * Fast Forward from, evaluated at the moment the option is actually chosen
 * (not at post time — see this module's doc comment). `undefined`, or either
 * provenance field missing (an older card built before this fix, or any
 * other malformed record), is never trusted. Otherwise trust requires ALL of:
 * the session id matches (no restart since), the run epoch matches (no
 * other run has started for this folder since), and the folder's most
 * recently recorded pause still names this exact session/epoch (the run
 * that raised this card has not since ended for an unrelated reason).
 */
export function isFastForwardResumeStateTrustedV1(
  state: FastForwardResumeStateV1 | undefined,
  taskFolderPath: string
): boolean {
  if (!state || state.fastForwardSessionIdV1 === undefined || state.fastForwardRunEpochV1 === undefined) {
    return false;
  }
  return isFastForwardRunPausedProvenanceCurrentV1(
    taskFolderPath,
    state.fastForwardSessionIdV1,
    state.fastForwardRunEpochV1
  );
}

/** Exact text of the trusted-resume label suffix for a given captured
 * iteration pair — factored out so {@link downgradeStaleResumeOptionV1} can
 * recognise and replace exactly the substring {@link fastForwardResumeSuffixV1}
 * built, without guessing at or duplicating the wording. */
function trustedResumeLabelSuffixV1(attemptNumber: number, maxAttempts: number): string {
  return ` and resume Fast Forward (iteration ${attemptNumber} of ${maxAttempts})`;
}

/** Consequence-text counterpart of {@link trustedResumeLabelSuffixV1}. */
function trustedResumeConsequenceSuffixV1(attemptNumber: number, maxAttempts: number): string {
  return (
    ` Resumes Fast Forward at iteration ${attemptNumber} of ${maxAttempts} — it keeps ` +
    "iterating through the remaining attempt budget that run already committed to, rather than stopping " +
    "after just one more round."
  );
}

const SINGLE_CYCLE_LABEL_SUFFIX_V1 = " and try again (one cycle, then stops)";
const SINGLE_CYCLE_CONSEQUENCE_SUFFIX_V1 =
  " This runs one cycle and stops there — this was not raised by an active Fast Forward run (or that run " +
  "has since ended), so it does not start or resume Fast Forward.";

export function fastForwardResumeSuffixV1(
  taskFolderPath: string,
  state: FastForwardRunStateV1 | undefined
): {
  readonly labelSuffix: string;
  readonly consequenceSuffix: string;
  readonly extraArgs: { readonly resumeFastForwardV1?: FastForwardResumeStateV1 };
} {
  if (state) {
    const provenanced: FastForwardResumeStateV1 = {
      ...state,
      ...stampFastForwardResumeProvenanceV1(taskFolderPath),
    };
    return {
      labelSuffix: trustedResumeLabelSuffixV1(state.attemptNumber, state.maxAttempts),
      consequenceSuffix: trustedResumeConsequenceSuffixV1(state.attemptNumber, state.maxAttempts),
      extraArgs: { resumeFastForwardV1: provenanced },
    };
  }
  return {
    labelSuffix: SINGLE_CYCLE_LABEL_SUFFIX_V1,
    consequenceSuffix: SINGLE_CYCLE_CONSEQUENCE_SUFFIX_V1,
    extraArgs: {},
  };
}

/**
 * Finds the first `resumeFastForwardV1` payload embedded in a command
 * option's dispatch args, if any — the same shape `fastForwardResumeSuffixV1`
 * places into `extraArgs.resumeFastForwardV1` and callers spread into their
 * command's args object — alongside the `taskFolderPath` carried in that SAME
 * args object. Every current caller (`reconcilePlanChecklist.ts`,
 * `applyReviewerVerifiedTicks.ts`) spreads both into one object, e.g.
 * `{ taskFolderPath, canonicalId, ...ffResume.extraArgs }`. This deliberately
 * reads `taskFolderPath` from THAT object rather than trusting the decision's
 * own `taskCanonicalId` field: `activeFastForwardRunsV1.ts` keys every map by
 * the real folder path (normalized), and while production callers set
 * `taskCanonicalId` to that same normalized path, a caller free to choose its
 * own canonical id (or a test using a synthetic one) would otherwise make
 * every lookup miss and every card look permanently untrusted.
 */
function findResumeFastForwardStateInArgsV1(
  args: readonly unknown[] | undefined
): { readonly state: FastForwardResumeStateV1; readonly taskFolderPath?: string } | undefined {
  if (!args) {
    return undefined;
  }
  for (const arg of args) {
    if (arg && typeof arg === "object" && "resumeFastForwardV1" in (arg as Record<string, unknown>)) {
      const record = arg as Record<string, unknown>;
      const candidate = record.resumeFastForwardV1;
      if (candidate && typeof candidate === "object") {
        return {
          state: candidate as FastForwardResumeStateV1,
          taskFolderPath: typeof record.taskFolderPath === "string" ? record.taskFolderPath : undefined,
        };
      }
    }
  }
  return undefined;
}

/**
 * Downgrades a single option's displayed `label`/`consequence` from the
 * trusted "…and resume Fast Forward (iteration N of M)" wording to the
 * single-cycle "…and try again (one cycle)" wording when the
 * `resumeFastForwardV1` state embedded in its dispatch args is no longer
 * trusted (see {@link isFastForwardResumeStateTrustedV1}) — see
 * {@link refreshFastForwardResumeOptionLabelsV1}'s doc comment for why this
 * exists. Purely textual: `option.effect.args` (and therefore what actually
 * dispatches) is never touched, so this can only ever narrow what the label
 * already claims, never widen it — a genuinely trusted state is left alone,
 * and `resumeAndApplyCurrentStageActionV1`'s own re-check at the moment of
 * choosing remains the actual safety backstop regardless of what this
 * produces. If the label/consequence do not end with EXACTLY the trusted
 * suffix built from the captured iteration numbers (should not happen — it
 * would mean some other builder produced this shape), the option is left
 * unchanged rather than guessed at.
 */
function downgradeStaleResumeOptionV1(
  option: WorkflowDecisionOptionV1,
  taskCanonicalId: string
): WorkflowDecisionOptionV1 {
  if (option.effect.kind !== "command") {
    return option;
  }
  const found = findResumeFastForwardStateInArgsV1(option.effect.args);
  if (!found) {
    return option;
  }
  const { state, taskFolderPath } = found;
  if (isFastForwardResumeStateTrustedV1(state, taskFolderPath ?? taskCanonicalId)) {
    return option;
  }
  const trustedLabelSuffix = trustedResumeLabelSuffixV1(state.attemptNumber, state.maxAttempts);
  const trustedConsequenceSuffix = trustedResumeConsequenceSuffixV1(state.attemptNumber, state.maxAttempts);
  if (!option.label.endsWith(trustedLabelSuffix) || !option.consequence.endsWith(trustedConsequenceSuffix)) {
    return option;
  }
  return {
    ...option,
    label: option.label.slice(0, -trustedLabelSuffix.length) + SINGLE_CYCLE_LABEL_SUFFIX_V1,
    consequence: option.consequence.slice(0, -trustedConsequenceSuffix.length) + SINGLE_CYCLE_CONSEQUENCE_SUFFIX_V1,
  };
}

/**
 * Read-time refresh applied at the store boundary
 * (`WorkflowDecisionStoreV1.all()`), the same place `normalizeWorkflowDecisionV1`
 * already upgrades legacy shapes on every read — a PENDING reconcile or
 * reviewer-verified-ticks card's own option text is downgraded from "…and
 * resume Fast Forward (iteration N of M)" to "…and try again (one cycle)"
 * the moment the run that raised it stops being a trusted resume target,
 * rather than only learning that at the instant the option is chosen.
 *
 * Review-flagged completion fix, round 3 (2026-09-30, narrowed blocker
 * `62a487ef-0d12-4476-a39f-abc4016bf4d4-0`): rounds 1–2 made the CONSUMING
 * side (`resumeAndApplyCurrentStageActionV1`) safe — a stale record can
 * never start an unrequested Fast Forward run — but the card itself kept
 * claiming "resume Fast Forward" right up until the moment of choosing it,
 * when a notification broke the news after the fact. The plan requires the
 * card ITSELF to say "try again (one cycle)" once its record is stale, not
 * just a post-selection explanation. This makes every read of a pending
 * decision (each chat render, each tree-view refresh) re-evaluate trust and
 * correct the text — the trust check is monotonic (a session/epoch that
 * stops matching can never start matching again without a fresh post under
 * the same decision key, which stamps fresh provenance), so once downgraded
 * here a card never flips back to claiming a resume it cannot deliver.
 * `resolved`/`dismissed`/`withdrawn`/`superseded` records are left
 * untouched — they record what was actually offered at the moment answered.
 */
export function refreshFastForwardResumeOptionLabelsV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  if (record.state !== "pending") {
    return record;
  }
  let changed = false;
  const options = record.options.map((option) => {
    const next = downgradeStaleResumeOptionV1(option, record.taskCanonicalId);
    if (next !== option) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...record, options } : record;
}

/**
 * bugs3 Step 2: the decision keys whose "…and try again" options dispatch the
 * stage's next action. Both build their suffix with
 * {@link fastForwardResumeSuffixV1}.
 */
/**
 * "Mark reconciled" dispatches nothing, but its command refuses while an
 * operation holds the task (it rewrites the progress record the operation is
 * also writing), so the card holds it with the dispatching options rather than
 * offering a choice the command would refuse.
 */
const RECONCILE_CONFIRMED_COMMAND_V1 = "vs-code-ai-helper.reconcilePlanChecklistConfirmed";

const OPERATION_HELD_DECISION_KEYS_V1:ReadonlySet<string> = new Set([
  "reconcilePlanChecklist",
  "applyReviewerVerifiedTicks",
]);

function findTaskFolderPathInArgsV1(args: readonly unknown[] | undefined): string | undefined {
  for (const arg of args ?? []) {
    if (arg && typeof arg === "object") {
      const candidate = (arg as Record<string, unknown>).taskFolderPath;
      if (typeof candidate === "string") {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The operation running for the task right now that a dispatching option of
 * `record` would collide with, read from the live operations state — never
 * from how the card was raised. `undefined` when it would not collide.
 */
export function liveOperationBlockingOptionV1(
  record: WorkflowDecisionV1,
  option: WorkflowDecisionOptionV1
): LiveTaskOperationV1 | undefined {
  if (
    record.state !== "pending" ||
    // bugs5 Step 3: an answer accepted now and carried out when the task is free never collides.
    option.runsWhenTaskFree === true ||
    !OPERATION_HELD_DECISION_KEYS_V1.has(record.decisionKey) ||
    option.effect.kind !== "command" ||
    !(option.resumeKind === "continue" || option.effect.command === RECONCILE_CONFIRMED_COMMAND_V1)
  ) {
    return undefined;
  }
  return getLiveTaskOperationV1(findTaskFolderPathInArgsV1(option.effect.args) ?? record.taskCanonicalId);
}

/**
 * review1 Step 33 (bugs6 item 8): the reviewer-verified-ticks card says only what is true of the task NOW. The
 * tick-only option ("dispatches nothing, so Fast Forward keeps running") is persisted at post time, when a Fast
 * Forward run was live; once that run ended the card still carried it, recommended, next to an option saying the
 * card "was not raised by an active Fast Forward run". This render-time view reconciles the two:
 *
 * - Fast Forward is active: the tick-only option reads "Apply the N ticks now (Fast Forward continues)".
 * - It is not: the tick-only option is not offered (its claim is false), and the recommendation is the option that
 *   applies the ticks AND continues, either resuming the captured run or running the stage's next action once; the
 *   recommendation says which.
 *
 * Never both texts on one card. A view only: nothing is persisted.
 */
export function adaptVerifiedTicksCardToFastForwardStateV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  if (record.state !== "pending" || !isVerifiedTicksDecisionV1(record)) {
    return record;
  }
  const apply = record.options.find((option) => option.optionId === APPLY_OPTION_ID_V1);
  const tickNow = record.options.find((option) => option.optionId === APPLY_TICKS_NOW_OPTION_ID_V1);
  if (!apply || !tickNow) {
    return record;
  }
  const folder = findTaskFolderPathInArgsV1(apply.effect.kind === "command" ? apply.effect.args : undefined) ?? record.taskCanonicalId;
  const count = offeredTickItemsOfV1(record).length;
  if (isFastForwardRunActiveV1(folder)) {
    const label = `Apply the ${count > 0 ? `${count} ` : ""}${count === 1 ? "tick" : "ticks"} now (Fast Forward continues)`;
    return tickNow.label === label
      ? record
      : { ...record, options: record.options.map((option) => (option === tickNow ? { ...option, label } : option)) };
  }
  const resumesRun = apply.label.endsWith(trustedResumeLabelSuffixForAnyV1(apply.label));
  const reasoning = resumesRun
    ? "The reviewer already verified these items. Apply ticks them and then resumes the Fast Forward run this card was raised in."
    : "The reviewer already verified these items. Apply ticks them and then runs the stage's next action once; no Fast Forward run is active, so it does not start one.";
  const recommendsTickNow = record.recommendation.kind === "option" && record.recommendation.optionId === tickNow.optionId;
  return {
    ...record,
    options: record.options.filter((option) => option !== tickNow),
    recommendation:
      recommendsTickNow || record.recommendation.kind === "none"
        ? { kind: "option", optionId: apply.optionId, reasoning }
        : record.recommendation,
  };
}

/** The "and resume Fast Forward (iteration N of M)" tail of a trusted option label, or a string that never matches. */
function trustedResumeLabelSuffixForAnyV1(label: string): string {
  const match = / and resume Fast Forward \(iteration \d+ of \d+\)$/.exec(label);
  return match ? match[0] : "\u0000";
}

/**
 * Render-time view of a pending reconcile / reviewer-verified-ticks card while
 * an operation (a Fast Forward run, say) holds the task: each option that
 * would dispatch the stage's next action into it is marked unavailable, naming
 * what is running and that it is offered again when that ends, and the
 * single-cycle consequence's "not raised by an active Fast Forward run" claim
 * is replaced because it is untrue while one runs. This is a VIEW: the store
 * applies it on reads only and never persists it, so the options come back by
 * themselves once the operation ends. Answers are re-checked against the same
 * live state in `WorkflowDecisionStoreV1.resolve`.
 */
export function holdDispatchingOptionsWhileOperationLiveV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  const held = holdDispatchingOptionsV1(record);
  // bugs5 Steps 2-3: a reviewer-verified-ticks card whose Apply is held offers the two answers that
  // do not race the running operation, and says plainly that it stays open.
  const heldApply = held.options.find((option) => option.optionId === APPLY_OPTION_ID_V1);
  if (
    held.state !== "pending" ||
    !isVerifiedTicksDecisionV1(held) ||
    heldApply?.disabled !== true ||
    held.options.some((option) => option.optionId === APPLY_TICKS_NOW_OPTION_ID_V1)
  ) {
    return held;
  }
  const extra = buildHeldTicksAnswerOptionsV1(held).map((option) =>
    option.optionId === APPLY_WHEN_PAUSED_OPTION_ID_V1 && held.deferredAnswer !== undefined
      ? {
          ...option,
          disabled: true,
          disabledReason: "your answer is already kept; it runs when nothing is running for this task",
        }
      : option
  );
  if (extra.length === 0) {
    return held;
  }
  const tickNow = extra.find((option) => option.optionId === APPLY_TICKS_NOW_OPTION_ID_V1);
  const note = held.deferredAnswer
    ? `${describeKeptDeferredAnswerV1(held.deferredAnswer)} ${HELD_CARD_STAYS_OPEN_NOTE_V1}`
    : HELD_CARD_STAYS_OPEN_NOTE_V1;
  return {
    ...held,
    // Not-yet stays last, after the answers that can be given now.
    options: [
      ...held.options.filter((option) => option.effect.kind !== "doNothing"),
      ...extra,
      ...held.options.filter((option) => option.effect.kind === "doNothing"),
    ],
    whyUserNeeded: `${held.whyUserNeeded} ${note}`,
    recommendation:
      tickNow !== undefined
        ? {
            kind: "option",
            optionId: tickNow.optionId,
            reasoning:
              "The reviewer already verified these items; ticking them now lets Fast Forward's next round count " +
              "them, and dispatching stays Fast Forward's job.",
          }
        : held.recommendation,
  };
}

function holdDispatchingOptionsV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  let changed = false;
  const options = record.options.map((option) => {
    const live = liveOperationBlockingOptionV1(record, option);
    if (!live) {
      return option;
    }
    changed = true;
    const running = `${describeLiveTaskOperationV1(live)} is running for this task right now`;
    return {
      ...option,
      disabled: true,
      disabledReason:
        option.resumeKind === "continue"
          ? `${running}, and this would start another action beside it; it is offered again when it ends`
          : `${running}, and changing the task's checklist record now would race it; it is offered again when it ends`,
      consequence: option.consequence.endsWith(SINGLE_CYCLE_CONSEQUENCE_SUFFIX_V1)
        ? option.consequence.slice(0, -SINGLE_CYCLE_CONSEQUENCE_SUFFIX_V1.length) +
          ` ${running}, so this waits: it does not start or resume anything until that ends.`
        : option.consequence,
    };
  });
  return changed ? { ...record, options } : record;
}

/**
 * bugs5 Step 19: the Ended-line note for the one cycle that stands in for a "Keep iterating" answer whose
 * Fast Forward run could not be resumed. It says what ran, why Fast Forward did not continue, and what to
 * choose next, so the line never reads as a bare "succeeded" with nothing scheduled.
 */
export function describeKeepIteratingStandInEndedNoteV1(untrustedReason: string): string {
  return (
    `one cycle finished (Apply Review, then a review) but Fast Forward did not continue — ${untrustedReason}. ` +
    "Next: choose Fast Forward Review to keep iterating"
  );
}

/**
 * bugs5 Step 19: the command and argument a trusted "Keep iterating" answer dispatches. It is Fast Forward
 * itself (not a single Apply Review), carrying the card's captured attempt so the loop continues with the
 * remaining budget, and `fastForwardReviewWithAI` starts a resumed run with Apply Review whenever its review is
 * provably of the current tree.
 */
export function buildFastForwardResumeDispatchV1(
  taskFolderPath: string,
  state: FastForwardResumeStateV1,
  admissionHandoffToken: string | undefined
): { readonly command: "vs-code-ai-helper.fastForwardReviewWithAI"; readonly arg: Record<string, unknown> } {
  return {
    command: "vs-code-ai-helper.fastForwardReviewWithAI",
    arg: {
      taskFolderPath,
      admissionHandoffTokenV1: admissionHandoffToken,
      resumeFromAttemptV1: state,
    },
  };
}
