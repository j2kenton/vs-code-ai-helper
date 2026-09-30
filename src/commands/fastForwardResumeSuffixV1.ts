import {
  FastForwardRunStateV1,
  isFastForwardRunPausedProvenanceCurrentV1,
  stampFastForwardResumeProvenanceV1,
} from "../utils/activeFastForwardRunsV1";
import { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

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

const SINGLE_CYCLE_LABEL_SUFFIX_V1 = " and try again (one cycle)";
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
