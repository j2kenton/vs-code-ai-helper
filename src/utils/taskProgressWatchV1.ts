/**
 * review1 Step 23: the one measure of "is this task moving?".
 *
 * bugs6 item 7 ran 61 automatic rounds in three hours, 57 of them failed retries, while every narrower "no progress"
 * stop (zero-change rounds, churn ceiling, Fast Forward iterations, recovery re-arms) counted one kind of round under
 * narrow conditions and stayed quiet. This module keeps one record in `TaskProgress.progressWatch` that every round
 * ending and every owner action updates, and one decision (`evaluateProgressWatchV1`) the gate in front of every
 * automatic dispatch reads. It is pure: reading settings, writing task-progress and raising the card live in
 * `automaticDispatchGateV1.ts`.
 *
 * Progress is the work, not the review's text: plan items settled went up, task-fixable blockers went down, the review
 * score went up (each against the best so far on the same stage), or the owner did something.
 */
import type {
  ProgressWatchEndingKindV1,
  ProgressWatchEndingV1,
  ProgressWatchV1,
  RoundLedgerEntryV1,
  RoundLedgerStateV1,
  TaskProgress,
} from "../types/taskProgress";
import { MAX_PROGRESS_WATCH_ENDINGS_V1 } from "../types/taskProgress";
import { parseQuotaResetV1 } from "./quota";

const QUOTA_TEXT = /\b(quota|rate[- ]?limit|usage limit|too many requests|429|resets? (?:in|at|after)|exhausted)\b/i;
const CUT_OFF_TEXT = /\b(55[- ]minute|time[- ]?limit|timed? ?out|turn limit|cut (?:short|off)|inactivity|waiting for the background|incomplete)\b/i;
const REFUSED_TEXT = /\b(refus|declin|not allowed|permission denied|requires approval|blocked by policy)/i;

/** Stop causes that are a cut-off: Ensemble's own stops, a provider's per-turn time cap, a vanished process. */
const CUT_OFF_STOP_CAUSES_V1: ReadonlySet<string> = new Set([
  "ensembleBackstop",
  "ensembleIdleStop",
  "ensembleRepeatStop",
  "ensembleEndOfTurn",
  "providerTimeCap",
  "processEnded",
]);

/** Endings that count as "failed, refused or cut off" for the consecutive-failure limit. */
const FAILED_KINDS: ReadonlySet<ProgressWatchEndingKindV1> = new Set([
  "cut-off", "quota", "provider-error", "refused", "rejected",
]);

export function isFailedEndingKindV1(kind: ProgressWatchEndingKindV1): boolean {
  return FAILED_KINDS.has(kind);
}

/** What kind of ending a terminal ledger state plus its reason text describes. */
export function classifyRoundEndingV1(
  state: RoundLedgerStateV1,
  reason: string | undefined,
  now: Date = new Date(),
  stopCause?: string
): { readonly kind: ProgressWatchEndingKindV1; readonly quotaResetAt?: string } {
  const text = reason ?? "";
  const quotaResetAt = QUOTA_TEXT.test(text) ? parseQuotaResetV1(text, now) : undefined;
  const withReset = (kind: ProgressWatchEndingKindV1) => ({ kind, ...(quotaResetAt !== undefined ? { quotaResetAt } : {}) });
  // run1 Step 15: a cause the round's settlement recorded decides the kind before any text does. Ensemble's
  // own stops and a provider's per-turn time cap are cut-offs (the old text match read "Ensemble stopped the
  // round" as a provider error); a provider limit is a quota ending.
  if (stopCause !== undefined && (state === "failed" || state === "interrupted")) {
    if (CUT_OFF_STOP_CAUSES_V1.has(stopCause)) return { kind: "cut-off" };
    if (stopCause === "providerUsageLimit" || stopCause === "providerQuota") return withReset("quota");
  }
  switch (state) {
    case "completed":
      return { kind: "completed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "dropped":
      return { kind: "dropped" };
    case "rejected":
      return { kind: "rejected" };
    case "quota-blocked":
      return withReset("quota");
    case "interrupted":
      return CUT_OFF_TEXT.test(text) ? withReset("cut-off") : QUOTA_TEXT.test(text) ? withReset("quota") : { kind: "other" };
    case "failed":
    default:
      if (QUOTA_TEXT.test(text)) return withReset("quota");
      if (CUT_OFF_TEXT.test(text)) return { kind: "cut-off" };
      if (REFUSED_TEXT.test(text)) return { kind: "refused" };
      return { kind: "provider-error" };
  }
}

function freshWatch(nowIso: string, what: string): ProgressWatchV1 {
  return {
    lastProgressAt: nowIso,
    lastProgressWhat: what,
    autoRoundsSinceProgress: 0,
    consecutiveFailedAutoRounds: 0,
    endings: [],
  };
}

function withProgress(watch: ProgressWatchV1, nowIso: string, what: string): ProgressWatchV1 {
  const { heldAt: _heldAt, heldFor: _heldFor, ...rest } = watch;
  return {
    ...rest,
    lastProgressAt: nowIso,
    lastProgressWhat: what.slice(0, 300),
    autoRoundsSinceProgress: 0,
    consecutiveFailedAutoRounds: 0,
    endings: [],
  };
}

/**
 * Compare the newest review in `reviewScoreHistory` with the best so far on its stage. A review is compared once
 * (`signalsSeenAt`). Returns the updated watch and, when something moved, what.
 */
export function observeReviewSignalsV1(
  progress: TaskProgress,
  watch: ProgressWatchV1
): { readonly watch: ProgressWatchV1; readonly moved?: string } {
  const history = progress.reviewScoreHistory ?? [];
  const entry = history[history.length - 1];
  if (!entry || entry.at === watch.signalsSeenAt) return { watch };
  const score = typeof entry.score === "number" ? entry.score : undefined;
  const settled = entry.settledItemCount;
  const taskFixable = entry.taskFixableCount;
  const marked: ProgressWatchV1 = { ...watch, bestStage: entry.stage, signalsSeenAt: entry.at };
  if (watch.bestStage !== entry.stage || watch.best === undefined) {
    // The first review on this stage is the baseline, not progress by itself.
    return {
      watch: {
        ...marked,
        best: {
          ...(score !== undefined ? { score } : {}),
          ...(settled !== undefined ? { settled } : {}),
          ...(taskFixable !== undefined ? { taskFixable } : {}),
        },
      },
      ...(watch.bestStage !== undefined && watch.bestStage !== entry.stage ? { moved: `the task moved on to ${entry.stage}` } : {}),
    };
  }
  const best = watch.best;
  const moved: string[] = [];
  if (settled !== undefined && (best.settled === undefined || settled > best.settled)) {
    if (best.settled !== undefined) moved.push(`plan items settled: ${best.settled} → ${settled}`);
  }
  if (taskFixable !== undefined && best.taskFixable !== undefined && taskFixable < best.taskFixable) {
    moved.push(`task-fixable blockers: ${best.taskFixable} → ${taskFixable}`);
  }
  if (score !== undefined && best.score !== undefined && score > best.score) {
    moved.push(`review score: ${best.score} → ${score}`);
  }
  const nextBest = {
    ...(score !== undefined ? { score: Math.max(score, best.score ?? score) } : best.score !== undefined ? { score: best.score } : {}),
    ...(settled !== undefined ? { settled: Math.max(settled, best.settled ?? settled) } : best.settled !== undefined ? { settled: best.settled } : {}),
    ...(taskFixable !== undefined ? { taskFixable: Math.min(taskFixable, best.taskFixable ?? taskFixable) } : best.taskFixable !== undefined ? { taskFixable: best.taskFixable } : {}),
  };
  return { watch: { ...marked, best: nextBest }, ...(moved.length > 0 ? { moved: moved.join("; ") } : {}) };
}

export interface RoundEndedInputV1 {
  readonly automatic: boolean;
  readonly model?: string;
  readonly now?: Date;
  /** Overrides the ledger entry's `outcome.rejectionReason` as the failure text. */
  readonly reason?: string;
}

/**
 * Fold one terminal ledger row into `progressWatch`. Called inside the same task-progress patch that terminalizes the
 * round (`terminalizeRoundV1`), after the review history for that round was written, so a review's score, blockers and
 * settled count are compared in the same step.
 */
export function recordRoundEndedInWatchV1(
  progress: TaskProgress,
  entry: Pick<RoundLedgerEntryV1, "roundId" | "stage" | "state" | "outcome">,
  input: RoundEndedInputV1
): TaskProgress {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const stopCause = entry.outcome?.stopCause;
  const { kind, quotaResetAt } = classifyRoundEndingV1(
    entry.state,
    input.reason ?? entry.outcome?.rejectionReason,
    now,
    stopCause
  );
  // A round that never ran, or that the owner stopped, says nothing about whether the task is moving.
  if (kind === "dropped" || kind === "cancelled") return progress;

  let watch = progress.progressWatch ?? freshWatch(nowIso, "first round watched");
  const observed = observeReviewSignalsV1(progress, watch);
  watch = observed.watch;
  if (observed.moved !== undefined) {
    // This round moved the work: it is the progress, not another round without any.
    return { ...progress, progressWatch: withProgress(watch, nowIso, observed.moved) };
  }
  // run1 Step 15: a round that was cut short or failed, but whose own stream shows it changing files, did
  // work: that is progress, not another failure. Only files the round's stream named count. Files that
  // merely changed in the workspace while it ran (`observedFiles`) and output alone never do.
  const attributedFileCount = entry.outcome?.attributedFiles?.length ?? 0;
  if (attributedFileCount > 0 && (kind === "completed" || isFailedEndingKindV1(kind))) {
    return {
      ...progress,
      progressWatch: withProgress(
        watch,
        nowIso,
        `a round changed ${attributedFileCount} file${attributedFileCount === 1 ? "" : "s"} ${kind === "completed" ? "and finished" : "before it was stopped"}`
      ),
    };
  }

  const ending: ProgressWatchEndingV1 = {
    at: nowIso,
    kind,
    automatic: input.automatic,
    roundId: entry.roundId,
    stage: entry.stage,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(quotaResetAt !== undefined ? { quotaResetAt } : {}),
    ...(stopCause !== undefined ? { stopCause } : {}),
    ...(attributedFileCount > 0 ? { attributedFileCount } : {}),
  };
  const endings =[...watch.endings, ending].slice(-MAX_PROGRESS_WATCH_ENDINGS_V1);
  let autoRounds = watch.autoRoundsSinceProgress;
  let failedInARow = watch.consecutiveFailedAutoRounds;
  if (input.automatic) {
    autoRounds += 1;
    failedInARow = isFailedEndingKindV1(kind) ? failedInARow + 1 : 0;
  }
  return { ...progress, progressWatch: { ...watch, endings, autoRoundsSinceProgress: autoRounds, consecutiveFailedAutoRounds: failedInARow } };
}

/**
 * The owner did something (answered a card, changed a model, edited the plan or `task.md`, ticked or excluded an
 * item): that is progress by definition, and it answers a held gate.
 */
export function recordOwnerActionInWatchV1(progress: TaskProgress, what: string, now: Date = new Date()): TaskProgress {
  const nowIso = now.toISOString();
  const base = progress.progressWatch ?? freshWatch(nowIso, what);
  return { ...progress, progressWatch: withProgress(base, nowIso, what) };
}

export { evaluateProgressWatchV1 } from "../state/progressWatchGateV1";
export type { ProgressWatchDecisionV1, ProgressWatchLimitsV1 } from "../state/progressWatchGateV1";

/** Record that the gate tripped, so every automatic dispatch for the task is refused until the owner answers. */
export function markProgressWatchHeldV1(progress: TaskProgress, reason: "rounds" | "failed", now: Date = new Date()): TaskProgress {
  const nowIso = now.toISOString();
  const base = progress.progressWatch ?? freshWatch(nowIso, "first round watched");
  return { ...progress, progressWatch: { ...base, heldAt: nowIso, heldFor: reason } };
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const KIND_PHRASES: Record<ProgressWatchEndingKindV1, (count: number, resetAt?: string) => string> = {
  completed: (n) => `${n} finished`,
  "cut-off": (n) => `${n} cut off`,
  quota: (n, reset) => `${n} quota reached${reset ? `, resets ${formatClock(reset)}` : ""}`,
  "provider-error": (n) => `${n} failed with a provider error`,
  refused: (n) => `${n} refused`,
  rejected: (n) => `${n} ended with a report that was rejected`,
  cancelled: (n) => `${n} cancelled`,
  dropped: (n) => `${n} never started`,
  other: (n) => `${n} ended another way`,
};

/** "3 cut off, 57 quota reached, resets 13:27" — the round endings since the last progress, grouped. */
export function describeRoundEndingsV1(endings: readonly ProgressWatchEndingV1[]): string {
  // run1 Step 15: a cut-off whose cause the settlement recorded is told apart: a model that kept repeating
  // itself, one that went quiet, and a time limit are different things to do something about.
  const groupKey = (ending: ProgressWatchEndingV1): string =>
    ending.kind === "cut-off" && ending.stopCause !== undefined && CUT_OFF_PHRASES_BY_CAUSE_V1[ending.stopCause] !== undefined
      ? `cut-off:${ending.stopCause}`
      : ending.kind;
  const groups = new Map<string, { kind: ProgressWatchEndingKindV1; count: number; resetAt?: string; stopCause?: string }>();
  for (const ending of endings) {
    const key = groupKey(ending);
    const group = groups.get(key) ?? { kind: ending.kind, count: 0, ...(key.startsWith("cut-off:") && ending.stopCause !== undefined ? { stopCause: ending.stopCause } : {}) };
    group.count += 1;
    if (ending.quotaResetAt !== undefined && (group.resetAt === undefined || ending.quotaResetAt > group.resetAt)) {
      group.resetAt = ending.quotaResetAt;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) =>
      group.stopCause !== undefined
        ? `${group.count} ${CUT_OFF_PHRASES_BY_CAUSE_V1[group.stopCause]}`
        : KIND_PHRASES[group.kind](group.count, group.resetAt)
    )
    .join(", ");
}

const CUT_OFF_PHRASES_BY_CAUSE_V1: Record<string, string | undefined> = {
  ensembleRepeatStop: "stopped because the model kept repeating itself",
  ensembleIdleStop: "stopped with no reply from the model",
  ensembleBackstop: "stopped at Ensemble's time limit",
  ensembleEndOfTurn: "finished their turn but did not exit",
  providerTimeCap: "ended at the provider's own time cap for one turn",
  processEnded: "ended when the model's process disappeared",
};

/** The distinct models that ran since the last progress, in order of first appearance. */
export function listModelsInEndingsV1(endings: readonly ProgressWatchEndingV1[]): string[] {
  const seen: string[] = [];
  for (const ending of endings) {
    if (ending.model !== undefined && !seen.includes(ending.model)) seen.push(ending.model);
  }
  return seen;
}

/** Stop causes that are the provider's own limit or a sign-in failure: another model may well work. */
const SWITCH_MODEL_STOP_CAUSES_V1: ReadonlySet<string> = new Set([
  "providerUsageLimit",
  "providerQuota",
  "providerPayment",
  "signIn",
]);

/**
 * True when the endings since the last progress support "switch the model": repeated provider limits or
 * sign-in failures, or the same model stopped twice for repeating itself.
 */
export function endingsAreRepeatedProviderFailuresV1(endings: readonly ProgressWatchEndingV1[]): boolean {
  // run1 Step 15: another model is recommended only for a provider limit, a sign-in failure, or the same
  // model being stopped for repeating itself twice. A time limit, a quiet stretch, a vanished process, a
  // finished turn that did not exit, a provider's per-turn cap and a generic failure never are.
  const repeatStopsByModel = new Map<string, number>();
  for (const ending of endings) {
    if (ending.stopCause === "ensembleRepeatStop") {
      const key = ending.model ?? "";
      repeatStopsByModel.set(key, (repeatStopsByModel.get(key) ?? 0) + 1);
    }
  }
  const failures = endings.filter((ending) => {
    if (ending.stopCause === "ensembleRepeatStop") return (repeatStopsByModel.get(ending.model ?? "") ?? 0) >= 2;
    if (ending.stopCause !== undefined) return SWITCH_MODEL_STOP_CAUSES_V1.has(ending.stopCause);
    return ending.kind === "quota";
  });
  return failures.length >= 2 && failures.length * 2 >= endings.length;
}
