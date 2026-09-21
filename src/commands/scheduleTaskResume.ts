import * as vscode from "vscode";
import { isViewerHostV1, VIEWER_HOST_REFUSAL_MESSAGE_V1 } from "../state/hostRoleV1";
import { TaskInventory } from "../state/taskInventory";
import {
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  RUNS_DIRNAME,
  TaskProgress,
} from "../types/taskProgress";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { clearStageActionRefusalReasonV1, takeStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { notificationTaskDisplayNameV1, runWithNotificationTaskContextV1 } from "../utils/notificationTaskContextV1";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import {
  isAutomationChainActive,
  scheduleAutomationChain,
} from "../utils/automationChain";
import {
  IMPL_CONTINUATION_CHAIN_ID_V1,
  owedContinuationSourceV1,
  retireSatisfiedSummaryRejectedRecoveryV1,
} from "./implementationRecoveryV1";
import {
  hasLiveSchedulingIntentBestEffortV1,
  liveSchedulingIntentIdsBestEffortV1,
  syncOwedContinuationLedgerBestEffortV1,
} from "../state/schedulingIntentV1";
import { taskOperations } from "../utils/taskOperations";
import { reconcileRoundLedgerV1 } from "../utils/roundLedgerReconciliationV1";
import { listLiveRoundLeaseIdsV1 } from "../state/roundLeaseV1";
import { retryStuckPlanRevisionAdoptionV1 } from "../utils/implementationArtifactResolver";
import { pauseTaskWithReasonForClaimV1, setNextActorV1 } from "../utils/taskProgressTransforms";
import { isEffectivelyPausedV1 } from "../state/effectivePauseStatusV1";
import { terminalizeRoundV1 } from "../utils/roundLedgerV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
  describeStalledActiveTaskEscalationV1,
  describeUnrecoverableRecoveryEscalationV1,
  isImpossibleActiveStateV1,
  isReconstructableImplRecoveryV1,
  isStaleDispatchedImplRecoveryV1,
  isUnrecoverableImplRecoveryV1,
} from "../utils/taskWatchdogV1";
import {
  acquireWorkAdmissionV1,
  attemptAutomaticWorkAdmissionReclamationV1,
  authorizeWorkAdmissionHandoffV1,
  describeStaleWorkAdmissionTakeoverNoticeV1,
  describeWorkAdmissionRefusalV1,
  garbageCollectStaleWorkAdmissionTombstonesV1,
  hasDurableResolutionInFlightV1,
  hasLiveWorkAdmissionExcludingOwnerV1,
  hasResolutionInFlightBestEffortV1,
  isWatchdogPauseFenceCurrentV1,
  readOrInitPauseFenceGenerationV1,
  revokeWorkAdmissionHandoffV1,
  takeOverStaleWorkAdmissionMarkerV1,
  withWorkAdmissionV1,
  WorkAdmissionAutomaticReclamationOutcomeV1,
} from "../state/workAdmissionV1";
import { resolveTaskRootCandidates } from "../utils/taskRoot";
import {
  postWorkflowDecisionV1,
  PostWorkflowDecisionInputV1,
  withdrawWorkflowDecisionsByKeyV1,
} from "../utils/workflowDecisionDispatchV1";
import { describeResumeOptionV1, loadResumeActionPlanV1, ResumeActionPlanV1 } from "../utils/resumeActionPlanV1";
import { ChatTarget } from "../views/chatView";
import { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";

type ScheduleArg = { canonicalId?: string; taskFolderPath?: string; task?: { folderUri: vscode.Uri } };

/**
 * v1 fixes item 1, Part 1b step 14 ("revoked-pause fencing at all five
 * boundaries") — test-only synchronous injection points bracketing
 * `detectAndRepairStalledActiveTasksV1`'s own pauseCommit commit sequence, so
 * a test can deterministically suspend "the old pauseCommit owner" at each of
 * the plan's five documented boundaries and run a real revocation (from
 * "another window") in between: before the pre-write fence-currency check,
 * immediately after it (before the progress write begins), immediately after
 * the progress write settles (before the post-write admission/fence
 * currency checks), and immediately after those post-write checks pass
 * (before the escalation notification is built and posted). The fifth
 * boundary from the plan ("during the awaited progress write" itself) needs
 * no dedicated hook: a test starts its revocation from inside the "after the
 * pre-write check" hook without awaiting it, then awaits its settlement
 * inside the "after the raw write" hook below, producing a genuine,
 * OS-scheduled overlap between the revocation's own disk I/O and the
 * progress write's — the same "unmediated race" pattern the ordinary
 * pause-ordering invariant tests above already use, rather than a sixth
 * synthetic boundary.
 *
 * `undefined` outside tests; every call site below is a single optional-chain
 * no-op unless a test has installed hooks — never used by production code
 * paths.
 */
export interface PauseCommitTestHooksV1 {
  readonly onBeforePreWriteFenceCheckAsync?: () => Promise<void>;
  readonly onAfterPreWriteFenceCheckAsync?: () => Promise<void>;
  readonly onAfterRawWriteBeforePostValidationAsync?: () => Promise<void>;
  readonly onAfterPostValidationBeforeNotificationAsync?: () => Promise<void>;
}
let pauseCommitTestHooksV1: PauseCommitTestHooksV1 | undefined;
export function setPauseCommitTestHooksForTestV1(hooks: PauseCommitTestHooksV1 | undefined): void {
  pauseCommitTestHooksV1 = hooks;
}

/**
 * v1 fixes item 1, Part 1a step 7: the durable `WorkflowDecisionV1` card a
 * watchdog pause posts, carrying the action that undoes it — see
 * `detectAndRepairStalledActiveTasksV1`'s call site for why this is a posted
 * decision rather than a toast `actionCommand`. Shared between the generic
 * stall (`stuckRecovery: false`) and the unrecoverable-recovery route
 * (`stuckRecovery: true`, `implRecovery` already cleared by the pause write
 * that preceded this call) — both land the task in the identical "paused,
 * nothing running" state, so the same "resume and re-run" remedy applies to
 * either; only the explanatory text differs.
 */
export function buildStalledTaskEscalationDecisionV1(
  stuckRecovery: boolean,
  target: ChatTarget,
  resumePlan?: ResumeActionPlanV1
): PostWorkflowDecisionInputV1 {
  const displayName = notificationTaskDisplayNameV1(target.taskName, target.taskFolderPath);
  const whatHappened = stuckRecovery
    ? describeUnrecoverableRecoveryEscalationV1(displayName)
    : describeStalledActiveTaskEscalationV1(displayName);
  if (resumePlan?.kind === "blocked") {
    return buildBlockedStalledTaskDecisionV1(target, whatHappened, resumePlan);
  }
  // v1 fixes 2, items 14 + 25: the button names the action it will run.
  const resumeOption = describeResumeOptionV1(resumePlan);
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "resumeAndRerun",
      label: resumeOption.label,
      consequence: resumeOption.consequence,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
        args: [{ taskFolderPath: target.taskFolderPath }],
      },
    },
    {
      optionId: "handleMyself",
      label: "Leave it paused — I'll review it first",
      consequence:
        "Leaves the task paused; nothing is dispatched. Review the run log for what happened before resuming.",
      effect: { kind: "doNothing" },
    },
  ];
  const recommendation: WorkflowDecisionRecommendationV1 = {
    kind: "option",
    optionId: "resumeAndRerun",
    reasoning: "The task is paused and this is the action that returns it to a runnable state.",
  };
  return {
    decisionKey: "watchdogStalledEscalation",
    taskCanonicalId: target.canonicalId,
    stage: target.stage,
    whatHappened,
    whyUserNeeded: "Automation paused this task rather than leaving it silently active with nothing running, " +
      "and cannot decide on your behalf whether the underlying stall needs investigation before continuing.",
    options,
    recommendation,
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail:
        `This decision is what is holding the task paused — resolving it with "${resumeOption.label}" ` +
        "resumes the task immediately; \"Leave it paused — I'll review it first\" leaves it paused " +
        "and dispatches nothing.",
    },
  };
}

/**
 * The card for a pause whose resume is blocked by an unmet precondition
 * (`resumeAndApplyCurrentStageAction` would leave the task paused and say so).
 * Offering "Resume" as a recommended, unblocking option here would be false —
 * choosing it is recorded as "applying now" and changes nothing — so the card
 * offers only what can actually change the refusing condition (restoring the
 * last usable summary, when that is the cause) and says the task stays paused
 * until then.
 */
function buildBlockedStalledTaskDecisionV1(
  target: ChatTarget,
  whatHappened: string,
  plan: Extract<ResumeActionPlanV1, { kind: "blocked" }>
): PostWorkflowDecisionInputV1 {
  const options: WorkflowDecisionOptionV1[] = [];
  if (plan.restoreSummary) {
    options.push({
      optionId: "restoreSummary",
      label: "Restore the last usable summary",
      consequence:
        "Restores the previous usable implementation summary, which clears this refusal. The task stays " +
        "paused — resume it afterwards (Resume Task in the task's menu).",
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.restoreRejectedImplementationRound",
        args: [target.taskFolderPath, target.stage],
      },
    });
  }
  options.push({
    optionId: "handleMyself",
    label: "Leave it paused — I'll review it first",
    consequence: "Leaves the task paused; nothing is dispatched.",
    effect: { kind: "doNothing" },
  });
  const recommendation: WorkflowDecisionRecommendationV1 = plan.restoreSummary
    ? {
        kind: "option",
        optionId: "restoreSummary",
        reasoning: "Resuming would be refused until the last usable summary is restored; restoring clears that.",
      }
    : {
        kind: "none",
        reasoning: `No action can run yet: ${plan.precondition} Clear that first, then resume the task.`,
      };
  return {
    decisionKey: "watchdogStalledEscalation",
    taskCanonicalId: target.canonicalId,
    stage: target.stage,
    whatHappened,
    whyUserNeeded:
      "Automation paused this task, and resuming it right now would be refused because a prerequisite " +
      `is missing: ${plan.precondition}`,
    options,
    recommendation,
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: false,
      detail:
        "The task stays paused whichever option you choose: resuming is refused until the missing " +
        "prerequisite is cleared. " +
        (plan.restoreSummary
          ? "Restoring the summary clears it; then resume the task."
          : "Clear it, then resume the task."),
    },
  };
}

/** Why a delayed automatic retry is waiting, for the Run-now card's wording. */
export type DelayedRetryKindV1 = "refused" | "quotaPark";

/**
 * v1 fixes 2, item 22: the one chat card posted beside a delayed automatic
 * retry of a scheduled stage action. It says what is waiting and when the
 * next attempt is due, and offers "Run now" (the very same `fire()` path the
 * timer takes, via `runScheduledActionNow`) beside "Wait" — the default:
 * choosing nothing, or "Wait", leaves the schedule untouched.
 */
export function buildDelayedRetryDecisionV1(
  target: ChatTarget,
  kind: DelayedRetryKindV1,
  dueAt: Date,
  holderNote?: string
): PostWorkflowDecisionInputV1 {
  const displayName = notificationTaskDisplayNameV1(target.taskName, target.taskFolderPath);
  const due = dueAt.toLocaleString();
  const whatHappened =
    kind === "refused"
      ? `The scheduled ${target.stage} action for "${displayName}" could not start` +
        (holderNote ? ` (${holderNote})` : "") +
        `. It stays scheduled; the next automatic attempt is due ${due}.`
      : `The ${target.stage} action for "${displayName}" is waiting for the provider's quota to reset; ` +
        `the automatic rerun is due ${due}.`;
  return {
    decisionKey: "scheduledActionRunNow",
    taskCanonicalId: target.canonicalId,
    stage: target.stage,
    whatHappened,
    whyUserNeeded:
      kind === "refused"
        ? "Something else was working on this task when the schedule fired. Only you can tell whether it has " +
          "finished and the action can go now."
        : "The provider reported a quota window; only you can tell whether it has reopened early.",
    options: [
      {
        optionId: "waitForRetry",
        label: "Wait for the automatic retry",
        consequence: `Does nothing. The scheduled action runs by itself at ${due}.`,
        effect: { kind: "doNothing" },
      },
      {
        optionId: "runNow",
        label: "Run now",
        consequence:
          `Runs the scheduled ${target.stage} action immediately, exactly as the timer would. If something ` +
          "still holds the task, this says what.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.runScheduledActionNow",
          args: [{ taskFolderPath: target.taskFolderPath, canonicalId: target.canonicalId }],
        },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "waitForRetry",
      reasoning: "The automatic retry needs nothing from you; waiting costs only time.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail:
        `The task is not waiting on this answer: the scheduled action runs automatically at ${due} whichever ` +
        "option you pick. \"Run now\" only brings it forward.",
    },
  };
}

/**
 * v1 fixes 2, item 22: the chat card posted beside an owed implementation
 * continuation the recovery sweep is making the user wait for. "Wait" is the
 * default; "Run now" takes the sweep's own claim-and-dispatch path at once.
 * `dueAt` is undefined when the wait ends on a guard clearing, not a clock.
 */
export function buildOwedContinuationDecisionV1(
  target: ChatTarget,
  dueAt: Date | undefined,
  waitingOn: string
): PostWorkflowDecisionInputV1 {
  const displayName = notificationTaskDisplayNameV1(target.taskName, target.taskFolderPath);
  const nextAttempt = dueAt
    ? `the next automatic attempt is due ${dueAt.toLocaleString()}`
    : "the recovery sweep retries automatically every few minutes";
  return {
    decisionKey: "owedContinuationRunNow",
    taskCanonicalId: target.canonicalId,
    stage: target.stage,
    whatHappened:
      `An owed implementation continuation for "${displayName}" is waiting to be retried: ${waitingOn}. ` +
      `It stays owed; ${nextAttempt}.`,
    whyUserNeeded:
      "Only you can tell whether whatever is holding the continuation back has finished, so it can go now.",
    options: [
      {
        optionId: "waitForRetry",
        label: "Wait for the automatic retry",
        consequence: `Does nothing. The continuation is retried by itself; ${nextAttempt}.`,
        effect: { kind: "doNothing" },
      },
      {
        optionId: "runNow",
        label: "Run now",
        consequence:
          "Retries the owed continuation immediately, exactly as the sweep would. If a continuation is " +
          "genuinely still in flight, this says so.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.runOwedContinuationNow",
          args: [{ taskFolderPath: target.taskFolderPath, canonicalId: target.canonicalId }],
        },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "waitForRetry",
      reasoning: "The automatic retry needs nothing from you; waiting costs only time.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail: `The task is not waiting on this answer: ${nextAttempt} whichever option you pick. "Run now" only brings it forward.`,
    },
  };
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface SchedulerProgressStore {
  patch(folder: vscode.Uri, update: (progress: TaskProgress) => TaskProgress): Promise<TaskProgress | undefined>;
}

export const systemSchedulerClock: SchedulerClock = { now: () => Date.now(), setTimeout, clearTimeout };
const progressStore: SchedulerProgressStore = { patch: patchTaskProgressStrictV1 };
const MAX_TIMER_DELAY = 0x7fffffff;
const LEASE_DURATION_MS = 60 * 60 * 1000;
/**
 * How long a schedule waits after its firing was refused because another
 * stage action holds the task. Without it, every `task-progress.json` write
 * by that running action (the progress watcher calls `armAll`) re-armed the
 * overdue schedule for an immediate re-fire — and each re-fire posted the
 * same "could not start yet" warning again (seen live, 2026-09-17).
 */
export const REFUSED_SCHEDULE_RETRY_DELAY_MS_V1 = 60 * 1000;
/** How long a claimed-but-undispatched owed continuation may sit before a Run-now card is posted. */
export const OWED_CONTINUATION_WAIT_ANNOUNCE_AFTER_MS_V1 = 2 * 60 * 1000;

/** Outcome of one claim-and-dispatch attempt on an owed continuation. */
type OwedDispatchResultV1 =
  | { kind: "dispatched" }
  | { kind: "notClaimed"; heldBy?: string }
  | { kind: "dropped"; reason: string };

/**
 * Persisted one-shot scheduler. A lease means only one VS Code window arms a
 * timer. Long waits are re-armed in safe timer-sized chunks and each chunk
 * renews the lease. On dispose the owner releases its lease so another window
 * can immediately claim the persisted schedule.
 */
export class TaskActionScheduler implements vscode.Disposable {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Signature of the persisted run represented by each armed timer. */
  private readonly armedRuns = new Map<string, string>();
  /**
   * Schedules whose firing was refused (another stage action held the task):
   * the refused run's signature, and the earliest moment it may be retried.
   * The user is warned once per signature, not once per retry.
   */
  private readonly refusedRuns = new Map<string, { readonly signature: string; readonly retryAt: number }>();
  /** Display name per armed task, for attributing `fire()`'s notifications. */
  private readonly taskNames = new Map<string, string>();
  private readonly owner: string;
  /**
   * `fire()` is deliberately fire-and-forget from its `setTimeout` callback
   * (production code cannot await a timer callback), but it now does real,
   * disk-backed work-admission I/O before it does anything else (v1 fixes
   * item 1, Part 1a step 6) — no longer the near-synchronous body it used to
   * be. Tests that drive firing via a `FakeClock` need a deterministic way to
   * wait for that I/O to actually settle, rather than guessing at a fixed
   * number of ticks; tracked here for exactly that purpose and not consulted
   * anywhere in production logic.
   */
  private readonly inFlightFiresForTestV1 = new Set<Promise<unknown>>();

  constructor(
    private readonly inventory: TaskInventory,
    private readonly clock: SchedulerClock = systemSchedulerClock,
    private readonly store: SchedulerProgressStore = progressStore,
    owner = `${vscode.env.sessionId}:${Math.random().toString(36).slice(2)}`
  ) {
    this.owner = owner;
  }

  async arm(taskFolderPath: string, canonicalId?: string): Promise<void> {
    // A viewer host never claims a schedule lease: the schedule belongs to
    // the runner, and a viewer's timer could only fire into the route gate.
    if (isViewerHostV1()) {
      return;
    }
    const folder = vscode.Uri.file(taskFolderPath);
    const claimed = await this.store.patch(folder, progress => {
      const run = progress.scheduledRun;
      if (!run) return progress;
      const leaseIsLive = run.leaseUntil && new Date(run.leaseUntil).getTime() > this.clock.now();
      if (leaseIsLive && run.leaseOwner !== this.owner) return progress;
      return {
        ...progress,
        scheduledRun: {
          ...run,
          leaseOwner: this.owner,
          leaseUntil: new Date(this.clock.now() + LEASE_DURATION_MS).toISOString(),
        },
      };
    });

    const run = claimed?.scheduledRun;
    if (!run || run.leaseOwner !== this.owner) return;
    // Remembered for `fire()`, which runs from a timer outside any tracked
    // operation: its notifications name this task explicitly (item 6).
    if (claimed?.displayName) {
      this.taskNames.set(taskFolderPath, claimed.displayName);
    }

    const remaining = new Date(run.runAt).getTime() - this.clock.now();
    // Renew the lease before it can expire. Without this, a run scheduled
    // more than an hour ahead could be claimed by another window while this
    // window still had a timer armed.
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY, LEASE_DURATION_MS / 2));
    const signature = `${run.runAt}\u0000${run.stage}`;
    // A refused run waits out its retry delay however often it is re-armed;
    // a different (replaced) schedule starts fresh.
    let timerDelay = delay;
    const refused = this.refusedRuns.get(taskFolderPath);
    if (refused !== undefined) {
      if (refused.signature === signature) {
        timerDelay = Math.max(delay, refused.retryAt - this.clock.now());
      } else {
        this.refusedRuns.delete(taskFolderPath);
      }
    }
    const old = this.timers.get(taskFolderPath);
    if (old) this.clock.clearTimeout(old);
    this.armedRuns.set(taskFolderPath, signature);
    this.timers.set(taskFolderPath, this.clock.setTimeout(() => {
      if (remaining > delay) {
        void this.arm(taskFolderPath, canonicalId);
      } else {
        const firing = runWithNotificationTaskContextV1(
          this.taskNames.get(taskFolderPath),
          taskFolderPath,
          () => this.fire(taskFolderPath, canonicalId, run.runAt, run.stage),
          run.stage
        );
        this.inFlightFiresForTestV1.add(firing);
        void firing.finally(() => this.inFlightFiresForTestV1.delete(firing));
      }
    }, timerDelay));
  }

  /**
   * v1 fixes 2, item 22: post the Run-now card for a delayed automatic retry
   * of this task's scheduled action. Falls back to the plain warning the card
   * replaces when no decision can be posted (no extension context), so the
   * user is never told less than before. Never throws: it runs from the
   * refusal callback, which must not fail the firing that is being retried.
   */
  async announceDelayedRetryV1(
    taskFolderPath: string,
    canonicalId: string | undefined,
    stage: TaskProgress["currentStage"],
    kind: DelayedRetryKindV1,
    dueAt: Date,
    holderNote?: string
  ): Promise<void> {
    const task = this.inventory.getTasks().find((candidate) => candidate.taskFolderPath === taskFolderPath);
    const target: ChatTarget = {
      canonicalId: canonicalId ?? task?.canonicalId ?? taskFolderPath,
      taskFolderPath,
      stage,
      taskName: this.taskNames.get(taskFolderPath) ?? task?.progress.displayName,
    };
    let posted: unknown;
    try {
      posted = await postWorkflowDecisionV1(buildDelayedRetryDecisionV1(target, kind, dueAt, holderNote), target);
    } catch (error) {
      console.error("announceDelayedRetryV1: could not post the Run-now card", error);
    }
    if (posted === undefined && kind === "refused") {
      NotificationRouter.showWarning(
        `A scheduled stage action could not start yet (${holderNote ?? "another action holds the task"}); ` +
          "it remains scheduled and will be retried automatically."
      );
    }
  }

  /** Retire the Run-now card once its schedule has been consumed; best-effort. */
  private async withdrawDelayedRetryCardV1(
    taskFolderPath: string,
    canonicalId: string | undefined,
    reason: string
  ): Promise<void> {
    const task = this.inventory.getTasks().find((candidate) => candidate.taskFolderPath === taskFolderPath);
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath, canonicalId: canonicalId ?? task?.canonicalId ?? taskFolderPath },
      "scheduledActionRunNow",
      reason
    ).catch(() => undefined);
  }

  /**
   * v1 fixes 2, item 22: "Run now" for a scheduled stage action. Claims the
   * schedule's lease like `arm()` does, then takes the SAME `fire()` path the
   * timer would — same admission check, same dispatch, same restore-on-failure
   * — immediately instead of at `runAt`. A refusal therefore names its holder
   * exactly as an automatic one does (the refusal memory is cleared first so
   * it is reported afresh rather than swallowed as already-warned).
   */
  async runNow(
    taskFolderPath: string,
    canonicalId?: string
  ): Promise<"started" | "refused" | "nothingScheduled" | "heldElsewhere"> {
    if (isViewerHostV1()) {
      return "heldElsewhere";
    }
    await this.arm(taskFolderPath, canonicalId);
    const current = await this.store.patch(vscode.Uri.file(taskFolderPath), (progress) => progress);
    const run = current?.scheduledRun;
    if (!run) {
      return "nothingScheduled";
    }
    if (run.leaseOwner !== this.owner) {
      return "heldElsewhere";
    }
    const pending = this.timers.get(taskFolderPath);
    if (pending) {
      this.clock.clearTimeout(pending);
    }
    this.refusedRuns.delete(taskFolderPath);
    const firing = runWithNotificationTaskContextV1(
      this.taskNames.get(taskFolderPath),
      taskFolderPath,
      () => this.fire(taskFolderPath, canonicalId, run.runAt, run.stage),
      run.stage
    );
    this.inFlightFiresForTestV1.add(firing);
    void firing.finally(() => this.inFlightFiresForTestV1.delete(firing));
    // A refusal (something holds the task, or the downstream action declined)
    // is not "started": `fire()` has already restored the schedule and posted
    // the card naming what is in the way.
    return (await firing) === "refused" ? "refused" : "started";
  }

  /** Test-only: resolve once every `fire()` currently in flight has settled
   * — see `inFlightFiresForTestV1`'s doc comment. */
  async waitForPendingFiresForTestV1(): Promise<void> {
    await Promise.allSettled([...this.inFlightFiresForTestV1]);
  }

  /**
   * v1 fixes item 1, Part 1a step 6 ("a scheduled stage action must dispatch,
   * or must not consume its schedule"): admission is acquired BEFORE
   * `scheduledRun` is cleared below and held across the dispatch itself
   * (mirrors `resumeTask.ts`'s `resumeThenDispatchV1`), so there is no window
   * where the schedule has already been consumed but nothing yet protects the
   * task from the stalled-task watchdog. A `busy`/`writeFailed` refusal here
   * means either a genuine owner is already working this task right now, or a
   * real filesystem error prevented even trying — either way this firing is
   * skipped WITHOUT touching `scheduledRun`, so the schedule is never
   * destroyed without having dispatched anything: the very next `armAll()`
   * sweep (on activation, or the periodic 5-minute timer) sees it still
   * present and retries, rather than the run silently vanishing forever.
   */
  private async fire(taskFolderPath: string, canonicalId: string | undefined, expectedRunAt: string, expectedStage: TaskProgress["currentStage"]): Promise<"dispatched" | "refused" | "skipped"> {
    this.timers.delete(taskFolderPath);
    this.armedRuns.delete(taskFolderPath);
    let result: "dispatched" | "refused" | "skipped" = "skipped";

    /** Refusal bookkeeping shared by an admission refusal and a declined dispatch. */
    const recordRefusal = (holderNote: string): void => {
      result = "refused";
      const signature = `${expectedRunAt}\u0000${expectedStage}`;
      const alreadyWarned = this.refusedRuns.get(taskFolderPath)?.signature === signature;
      const retryAt = this.clock.now() + REFUSED_SCHEDULE_RETRY_DELAY_MS_V1;
      this.refusedRuns.set(taskFolderPath, { signature, retryAt });
      if (!alreadyWarned) {
        void this.announceDelayedRetryV1(taskFolderPath, canonicalId, expectedStage, "refused", new Date(retryAt), holderNote);
      }
      // Retry on this window's own timer once the delay has passed, instead
      // of waiting for (or being re-fired by) the next sweep.
      void this.arm(taskFolderPath, canonicalId);
    };

    await withWorkAdmissionV1(
      {
        taskFolderPath,
        purpose: "admission",
        commandId: "vs-code-ai-helper.scheduleTaskResume.fire",
        onRefused: (outcome) => recordRefusal(describeWorkAdmissionRefusalV1(outcome)),
      },
      async () => {
        let clearedByThisOwner = false;
        let stageStillCurrent = false;
        await this.store.patch(vscode.Uri.file(taskFolderPath), current => {
          const run = current.scheduledRun;
          // A stale callback must not consume a replacement schedule created
          // by this same window, nor may it run a stage other than the one
          // selected when the schedule was created.
          if (run?.leaseOwner !== this.owner || run.runAt !== expectedRunAt || run.stage !== expectedStage) return current;
          clearedByThisOwner = true;
          this.refusedRuns.delete(taskFolderPath);
          stageStillCurrent = current.currentStage === run.stage;
          return {
            ...current,
            scheduledRun: undefined,
            scheduledResumeTime: undefined,
            updatedAt: new Date(this.clock.now()).toISOString(),
          };
        });

        // A different window can cancel or replace the schedule while this
        // timer is pending. Only the lease owner that cleared its own
        // schedule may run.
        if (clearedByThisOwner && stageStillCurrent) {
          // 2026-09-09 review completion blocker ("scheduled firing does not
          // dispatch-or-retain"): a thrown exception was the ONLY signal this
          // used to treat as "dispatch failed, restore the schedule" —
          // `applyCurrentStageAction` refusing normally (the task is still
          // paused — `scheduleQuotaResumeAtV1` deliberately allows arming a
          // schedule against a paused task — or a downstream stage command
          // observed this call's own held admission marker as `busy` and
          // refused without dispatching) never threw, so the schedule was
          // silently consumed with nothing having run. `applyCurrentStageAction`
          // now reports back whether it actually dispatched a downstream
          // action; anything else — a thrown error OR a `false`/non-boolean
          // return — is treated identically: restore, warn, retry later.
          //
          // The handoff token also closes the self-block half of that same
          // gap: this admission marker is held for the WHOLE call below (see
          // `withWorkAdmissionV1`'s wrapping above), so a downstream stage
          // command that itself acquires admission (`generatePlanWithAI`,
          // `runImplementationWithAI`) would otherwise observe this marker as
          // an unrelated live admission and refuse `busy` — exactly the
          // "self-blocking admission" reproduction from the review. Presenting
          // the token lets that downstream acquisition ADOPT this same marker
          // instead (`acquireOrAdoptWorkAdmissionV1`), mirroring
          // `resumeTask.ts`'s `resumeThenDispatchV1`.
          const handoffToken = authorizeWorkAdmissionHandoffV1(taskFolderPath);
          let dispatched = false;
          let failureMessage: string | undefined;
          // Drop any reason left by an earlier call so the one read below is
          // this dispatch's own.
          clearStageActionRefusalReasonV1(taskFolderPath);
          try {
            dispatched = (await vscode.commands.executeCommand<boolean>(
              "vs-code-ai-helper.applyCurrentStageAction",
              { canonicalId, taskFolderPath, admissionHandoffTokenV1: handoffToken }
            )) === true;
          } catch (error) {
            failureMessage = error instanceof Error ? error.message : String(error);
          } finally {
            revokeWorkAdmissionHandoffV1(taskFolderPath);
          }
          if (!dispatched) {
            // Dispatch never happened (or failed before any downstream
            // mechanism — its own round ledger row, its own admission —
            // could take over protecting the task). Restore the schedule
            // with its original stage rather than leaving the task silently
            // unprotected AND with the action it promised never having run —
            // only when nobody has since created a different schedule of
            // their own.
            await this.store.patch(vscode.Uri.file(taskFolderPath), current =>
              current.scheduledRun === undefined
                ? { ...current, scheduledRun: { runAt: expectedRunAt, stage: expectedStage } }
                : current
            );
            // The same Run-now card an admission refusal posts, naming the
            // reason — not a bare toast beside a clicked "Run now".
            recordRefusal(
              failureMessage
                ? `the action failed to start: ${failureMessage}`
                : `the action was refused: ${
                    takeStageActionRefusalReasonV1(taskFolderPath) ?? "the stage action declined to start"
                  }`
            );
          } else {
            result = "dispatched";
            await this.withdrawDelayedRetryCardV1(taskFolderPath, canonicalId, "the scheduled action has started");
          }
        } else if (clearedByThisOwner) {
          await this.withdrawDelayedRetryCardV1(
            taskFolderPath,
            canonicalId,
            "the task moved to a different stage, so the scheduled action was skipped"
          );
          NotificationRouter.showInformation("Scheduled action was skipped because the task moved to a different stage.");
        }
      }
    );
    return result;
  }

  async armAll(): Promise<void> {
    const scheduledPaths = new Set<string>();
    for (const task of this.inventory.getTasks()) {
      const run = task.progress.scheduledRun;
      if (!run) continue;
      scheduledPaths.add(task.taskFolderPath);
      const signature = `${run.runAt}\u0000${run.stage}`;
      // Refreshes happen for our own lease writes. Do not repeatedly patch a
      // schedule that is already represented by this window's timer.
      if (this.armedRuns.get(task.taskFolderPath) === signature) continue;
      await this.arm(task.taskFolderPath, task.canonicalId);
    }
    for (const [taskFolderPath, timer] of this.timers) {
      if (scheduledPaths.has(taskFolderPath)) continue;
      this.clock.clearTimeout(timer);
      this.timers.delete(taskFolderPath);
      this.armedRuns.delete(taskFolderPath);
    }
    // Reconcile BEFORE re-arming anything (plan step 14's explicit ordering
    // requirement, 2026-08-27 review-flagged: an earlier version ran this
    // after `armPendingImplRecoveries`, so a round-ledger row an owed
    // continuation's re-dispatch was about to open could race a still-open
    // orphaned row from the SAME task without reconciliation having had a
    // chance to close the stale one first).
    await this.reconcileRoundLedgerOrphans();
    await this.retryStuckPlanRevisionAdoptions();
    await this.armPendingImplRecoveries();
    // v1 fixes item 1, Part 1c step 15/18: reclaim any admission marker whose
    // owner is PROVABLY dead before the watchdog's own stand-down check
    // (immediately below) decides whether a live marker should exempt this
    // task. Ordered here, right before that check, for the same reason as
    // every other self-healing pass above — so the watchdog evaluates each
    // task against the freshest state the rest of this sweep could establish,
    // rather than standing down for a marker that this same pass just proved
    // stale-and-dead.
    await this.reclaimStaleWorkAdmissionMarkersV1();
    // v1 fixes item 1, Part 1c step 17: collect aged reclamation tombstones.
    // Ordered after reclamation (which is what creates them) and independent
    // of the watchdog check below — this is pure disk hygiene for an audit
    // trail, never a decision any other pass depends on.
    await this.garbageCollectStaleWorkAdmissionTombstonesV1();
    // Last, so it only ever fires against whatever the passes above could
    // NOT resolve — an orphaned round is already closed, a reclaimable
    // continuation is already re-armed, by the time this runs.
    await this.detectAndRepairStalledActiveTasksV1();
  }

  /**
   * v1 fixes item 1, Part 1c step 17 — best-effort, per-task tombstone GC.
   * Delegates entirely to {@link garbageCollectStaleWorkAdmissionTombstonesV1};
   * see that function's own doc comment for why it can never touch a live
   * claim/marker, a pause-fence generation, or a pending revocation barrier.
   * One task's failure is logged and never stops the pass for the rest of
   * the inventory, matching every other self-healing pass in `armAll`.
   */
  private async garbageCollectStaleWorkAdmissionTombstonesV1(): Promise<void> {
    const now = this.clock.now();
    for (const task of this.inventory.getTasks()) {
      try {
        const outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task.taskFolderPath, now);
        if (outcome.outcome === "writeFailed") {
          console.error(
            `garbageCollectStaleWorkAdmissionTombstonesV1: failed to collect a tombstone for "${task.taskFolderPath}" ` +
              `(collected ${outcome.partialCount} before the failure)`,
            outcome.error
          );
        }
      } catch (error) {
        console.error(
          `garbageCollectStaleWorkAdmissionTombstonesV1: unexpected error collecting tombstones for ` +
            `"${task.taskFolderPath}" — leaving them for a later sweep.`,
          error
        );
      }
    }
  }

  /**
   * v1 fixes item 1, Part 1c step 16 — per-task tracking of how many
   * CONSECUTIVE sweeps have observed the same stuck, notice-worthy admission
   * owner (`foreignHost`/`sameHostAlive`/`corrupt` — plan step 16's own named
   * three; `sameHostDead` is reclaimed automatically and never reaches here,
   * `indeterminate` stays silent per `describeStaleWorkAdmissionTakeoverNoticeV1`'s
   * doc comment). Keyed by task folder path; the tracked identity
   * (`owner.claimId`, or a corrupt-record sentinel keyed off the marker path
   * itself) resets the count to 1 whenever a DIFFERENT owner is observed, so
   * a takeover notice can never fire for a marker that only just appeared —
   * "never offered for fresh heartbeat" (plan step 16) is automatic here: a
   * fresh marker cannot yet have crossed the staleness threshold that gates
   * `notDead` in the first place. `notified` is one-shot per identity streak
   * — this is a notice, not a repeating alarm; it fires once, and only fires
   * again if the SAME task later cycles through a different stuck owner.
   */
  private readonly staleAdmissionNoticeStateV1 = new Map<
    string,
    { identityKey: string; count: number; notified: boolean }
  >();

  /** How many consecutive sweep observations of the same stuck owner before
   * offering a takeover. Not time-based (armAll's own cadence — a 5-minute
   * timer plus every task-progress.json write — already provides real-world
   * spacing); this only needs to rule out a single transient blip. */
  private static readonly STALE_ADMISSION_TAKEOVER_NOTICE_THRESHOLD_V1 = 3;

  private surfaceStaleWorkAdmissionTakeoverNoticeV1(
    task: { readonly taskFolderPath: string; readonly progress: TaskProgress },
    outcome: Extract<WorkAdmissionAutomaticReclamationOutcomeV1, { outcome: "notDead" }>
  ): void {
    const kind = outcome.liveness.kind;
    if (kind !== "foreignHost" && kind !== "sameHostAlive" && kind !== "corrupt") {
      // `indeterminate` (or any future kind): never notice-worthy — clear any
      // stale tracking so a later genuinely notice-worthy streak starts fresh.
      this.staleAdmissionNoticeStateV1.delete(task.taskFolderPath);
      return;
    }
    const identityKey = outcome.owner ? outcome.owner.claimId : `corrupt:${outcome.markerPath}`;
    const existing = this.staleAdmissionNoticeStateV1.get(task.taskFolderPath);
    const state = existing && existing.identityKey === identityKey ? existing : { identityKey, count: 0, notified: false };
    state.count += 1;
    this.staleAdmissionNoticeStateV1.set(task.taskFolderPath, state);
    if (state.notified || state.count < TaskActionScheduler.STALE_ADMISSION_TAKEOVER_NOTICE_THRESHOLD_V1) {
      return;
    }
    state.notified = true;
    const displayName = notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath);
    const message = describeStaleWorkAdmissionTakeoverNoticeV1(displayName, outcome.liveness, outcome.owner, outcome.ageMs);
    try {
      NotificationRouter.showWarning(message, undefined, undefined, undefined, {
        command: "vs-code-ai-helper.takeOverStaleWorkAdmission",
        title: "Take over this task on this machine",
        args: [{ taskFolderPath: task.taskFolderPath, expectedMarkerPath: outcome.markerPath, expectedClaimId: outcome.owner?.claimId }],
      });
    } catch (error) {
      // Best-effort, like every other notification in this sweep (e.g.
      // `reclaimStaleWorkAdmissionMarkersV1`'s own logging-only failures) —
      // a router that has not been initialized yet must never break the
      // sweep pass itself.
      console.error(
        `surfaceStaleWorkAdmissionTakeoverNoticeV1: could not surface the takeover notice for "${task.taskFolderPath}"`,
        error
      );
    }
  }

  /**
   * v1 fixes item 1, Part 1c step 15/18 — the automatic trigger that was
   * deliberately left unwired when `attemptAutomaticWorkAdmissionReclamationV1`
   * itself was built and fully tested: that function is the entire safety
   * boundary (conservative same-host ESRCH liveness, purpose-specific
   * staleness thresholds, `pauseCommit` routed through 1b's revocation
   * barrier, admission reclaimed by a validated rename to a tombstone) — this
   * method adds no judgment of its own, it only calls that function once per
   * task, every sweep. A task with no marker, a fresh marker, or a marker
   * whose owner cannot be proven dead is always a no-op here; see that
   * function's own doc comment for the full fail-open contract this method
   * relies on rather than re-implements.
   *
   * Best-effort and independent per task: one task's `writeFailed` (a real
   * filesystem error) or unexpected throw is logged and never stops the pass
   * for the rest of the inventory, matching this sweep's other self-healing
   * passes above.
   */
  private async reclaimStaleWorkAdmissionMarkersV1(): Promise<void> {
    const now = this.clock.now();
    for (const task of this.inventory.getTasks()) {
      let outcome: WorkAdmissionAutomaticReclamationOutcomeV1;
      try {
        outcome = await attemptAutomaticWorkAdmissionReclamationV1(task.taskFolderPath, now);
      } catch (error) {
        console.error(
          `reclaimStaleWorkAdmissionMarkersV1: unexpected error probing "${task.taskFolderPath}" for a reclaimable ` +
            "admission marker — leaving it untouched for a later sweep.",
          error
        );
        continue;
      }
      if (outcome.outcome === "reclaimed") {
        console.log(
          `reclaimStaleWorkAdmissionMarkersV1: reclaimed a stale, determinately-dead ${outcome.purpose} marker for ` +
            `"${task.taskFolderPath}" (was owned by pid ${outcome.reclaimedOwner.pid} on ` +
            `${outcome.reclaimedOwner.hostId}, command "${outcome.reclaimedOwner.commandId}").`
        );
      } else if (outcome.outcome === "writeFailed") {
        console.error(
          `reclaimStaleWorkAdmissionMarkersV1: failed to reclaim a stale marker for "${task.taskFolderPath}"`,
          outcome.error
        );
      }
      if (outcome.outcome === "notDead") {
        // v1 fixes item 1, Part 1c step 16: track this task's consecutive
        // observations of a stuck, unreclaimable owner — may surface a
        // one-click takeover notice once it has persisted. See that method's
        // own doc comment for the full identity/threshold/reset contract.
        this.surfaceStaleWorkAdmissionTakeoverNoticeV1(task, outcome);
      } else {
        // Any other outcome ("reclaimed", "nothingToReclaim", "notStale",
        // "raced", "writeFailed") means the marker this task's tracking (if
        // any) was watching is no longer in that same stuck state — clear it
        // so a later, genuinely new stuck streak starts counting from zero
        // rather than inheriting an unrelated earlier count.
        this.staleAdmissionNoticeStateV1.delete(task.taskFolderPath);
      }
      // "nothingToReclaim" / "notStale" / "raced": no action and no log
      // noise beyond the tracking-reset above — these are the overwhelmingly
      // common, entirely unremarkable outcomes of a periodic sweep on
      // healthy tasks.
    }
  }

  /**
   * Guaranteed re-entry for a plan revision whose durable adoption record
   * (`checklistChangeProposals` entry flipping to `"adopted"`) failed to land
   * after its bounded in-place retry (2026-08-28 review fix, completion
   * blocker: "finalizePlanRevisionBestEffortV1 ... permits the stage
   * transition to continue with planRevision and the proposal still in
   * progress" — no code path is guaranteed to retry it, since neither
   * production caller of `preparePlanPromotion` runs again once the task has
   * left `plan`/`plan-review`). Same self-healing slot as the round-ledger
   * reconciliation above and `armPendingImplRecoveries` below: idempotent,
   * cheap once nothing is stuck, safe to call every sweep.
   */
  private async retryStuckPlanRevisionAdoptions(): Promise<void> {
    for (const task of this.inventory.getTasks()) {
      if (task.progress.planRevision === undefined) {
        continue;
      }
      await retryStuckPlanRevisionAdoptionV1(vscode.Uri.file(task.taskFolderPath));
    }
  }

  /**
   * Round-ledger reconciliation, all three passes (wf "make the stage chat a
   * record of work" Part 4 step 14, `roundLedgerReconciliationV1.ts`). Runs
   * on activation and every periodic sweep, same entry point as
   * `armPendingImplRecoveries`'s self-healing: (c) synthesizes a ledger row
   * for any legacy `_Auto-starting_` transcript entry that never had one, (a)
   * closes a `"scheduled"`/`"open"` row as `"interrupted"` once that row's OWN
   * `operationId`/`intentId` is no longer among this task's live operations/
   * scheduling-intents — falling back to the task-wide booleans only for a
   * row with neither id (see `reconcileOrphanedRoundLedgerRowsV1`'s doc
   * comment), and (b)
   * appends a missing outcome message for any terminal row — including one
   * (c) just synthesized. Unlike pass (a) alone, (b)/(c) are not gated on an
   * open row existing, so every task is reconciled every sweep; each pass is
   * independently idempotent and cheap once nothing is outstanding.
   */
  private async reconcileRoundLedgerOrphans(): Promise<void> {
    // Workspace-wide, computed once per sweep rather than per task: a live
    // round-lease entry is keyed by its own globally-unique `roundId`, so one
    // list safely covers every task's rows (2026-09-04 review follow-up,
    // closing the "manually-dispatched round in another window" architectural
    // gap — see `roundLeaseV1.ts` and `isRoundLedgerRowProtectedV1`).
    const liveRoundLeaseIds = listLiveRoundLeaseIdsV1(this.clock.now());
    for (const task of this.inventory.getTasks()) {
      const liveOperations = taskOperations.getTaskOperations(task.taskFolderPath);
      await reconcileRoundLedgerV1({
        taskFolderUri: vscode.Uri.file(task.taskFolderPath),
        hasLiveOperation: liveOperations.length > 0,
        hasLiveSchedulingIntent: hasLiveSchedulingIntentBestEffortV1(task.taskFolderPath),
        liveOperationIds: liveOperations.map((op) => op.id),
        liveSchedulingIntentIds: liveSchedulingIntentIdsBestEffortV1(task.taskFolderPath),
        liveRoundLeaseIds,
        now: this.clock.now(),
      });
    }
  }

  /**
   * Tasks whose stale `dispatched` recovery record this window has already
   * surfaced — once per window, not once per 5-minute sweep.
   */
  private readonly staleRecoveryNotified = new Set<string>();

  /**
   * Tasks whose reclaim this window has already reported as skipped because
   * the chain guard (`isAutomationChainActive`) is still live — once per
   * window per task, not once per sweep, mirroring `staleRecoveryNotified`
   * above. Workflow-6 Item 1: before the guard carried an expiry, a skipped
   * reclaim here was completely silent — a task could sit with an owed
   * continuation and `status: active` for hours with no indication that
   * anything was blocking it (observed 2026-08-17, ~2.5 hours). The guard now
   * expires on its own (`automationChain.ts`), but a *live* guard blocking a
   * reclaim is still worth surfacing: if it turns out to be another stranded
   * process rather than a genuinely in-flight chain, the operator has no way
   * to tell from silence alone.
   */
  private readonly chainGuardSkipNotified = new Set<string>();

  /**
   * Re-arm owed recovery continuations (`implRecovery`, Part 1) that were
   * persisted but never started — the durable half of the deferred-round
   * transition. A `pending` record with no live lease (and the continuation
   * cap not reached) means the transition committed but the process died
   * before the continuation round began: claim it (lease CAS, same one-window
   * rule as scheduledRun) and dispatch the chain exactly once.
   *
   * A1 (1.0.0 gate), second route: a `dispatched` record whose round never
   * settled (the dispatch itself was lost — e.g. the provider hit a usage
   * limit moments after claiming, or the window running it died) used to sit
   * `dispatched` forever, since nothing ever re-read it — the exact same
   * silent-stall symptom as the first route, just surviving instead of being
   * deleted. Once its anchor (`leaseUntil ?? at`) plus `STALE_DISPATCH_GRACE_MS`
   * has elapsed, the round it named is presumed dead and — PROVIDED it is
   * still `isReconstructableImplRecoveryV1` (a `sourceRoundId` to link back
   * to and a quarantined file set, explicit-unknown or otherwise) — it is
   * returned to `pending` so the claim path immediately below re-arms it
   * exactly as a freshly-persisted pending record would. A record still
   * within the grace window is left untouched — the round it covers can
   * legitimately run for the full CLI timeout. A record that IS stale but has
   * lost its reconstructability evidence is left alone here too — re-arming
   * it would dispatch a continuation with nothing to continue — and instead
   * falls to `detectAndRepairStalledActiveTasksV1`, which closes it out
   * through the round ledger's own terminalization path.
   */
  private async armPendingImplRecoveries(): Promise<void> {
    for (const task of this.inventory.getTasks()) {
      let recovery = task.progress.implRecovery;
      if (!recovery) continue;
      // 2026-09-15 post-freeze findings, item 5 (Part 5 step 33): a
      // `summaryRejected` recovery whose blocking condition has already been
      // satisfied (a usable impl-summary.md exists again) has nothing left to
      // wait for — retire it here, BEFORE the dispatch-state handling below,
      // so this sweep never re-arms or leaves dangling a continuation that
      // would just re-review an already-usable summary. Independent of
      // `effectivelyActive` below: a satisfied recovery should retire
      // whether or not the task currently reads as active.
      // v1 fixes 2, Wave I chokepoint (clears a recovery, this call site
      // only): per retireSatisfiedSummaryRejectedRecoveryV1's own doc
      // comment, THIS sweep call site `continue`s immediately — nothing
      // further is arranged for this task in this pass — so "human" is the
      // plain fact of what happens next here, unlike the advancement-gate
      // call site (reviewActions.ts), which may itself fall straight into a
      // stage transition that dispatches a review and must not be guessed at
      // from this function. 2026-09-17 review fix: folded into the SAME
      // atomic CAS write the retirement itself performs (via
      // `options.nextActorOnRetire`) instead of a second, separately-locked
      // patch — the prior two-write shape left a window where a concurrent,
      // newer-and-correct write (e.g. a dispatch starting between the two
      // patches) could be clobbered by this stale "human" guess.
      if (await retireSatisfiedSummaryRejectedRecoveryV1(
        vscode.Uri.file(task.taskFolderPath),
        { nextActorOnRetire: "human" }
      )) {
        continue;
      }
      // Part 1b step 13 ("automation gates"): this sweep automatically
      // re-dispatches a command with no human invoking it, so — unlike a
      // manual command, which will itself refuse a real pause — this is the
      // one place standing between a REVOKED-but-not-yet-repaired watchdog
      // pause and an owed continuation silently never re-arming. A raw
      // `status !== "active"` check here would skip re-arming for a task the
      // tree/status bar already show as active, stranding the recovery until
      // some other reader happens to trigger the resolver's background
      // repair — exactly the state-mismatch the release bar forbids.
      const effectivelyActive =
        task.progress.status === "active" ||
        (task.progress.status === "paused" && !(await isEffectivelyPausedV1(task.taskFolderPath, task.progress)));
      if (!effectivelyActive) continue;
      if (recovery.dispatch === "dispatched") {
        // The wait a Run-now card announced is over: the round started.
        if (this.owedRetryAnnounced.has(task.taskFolderPath)) {
          await this.withdrawOwedContinuationCardV1(task.taskFolderPath, task.canonicalId, "the owed continuation has started");
        }
        if (!isStaleDispatchedImplRecoveryV1(recovery, this.clock.now())) {
          continue;
        }
        if (!isReconstructableImplRecoveryV1(recovery, task.progress)) {
          // No source round or quarantined file set to hand a fresh
          // dispatch — reclaiming here would re-dispatch a continuation with
          // nothing to continue, indistinguishable from starting an
          // unrelated round under this record's name. Leave it for the
          // watchdog (`detectAndRepairStalledActiveTasksV1`) to close out
          // through the ledger's own terminalization path instead.
          continue;
        }
        // Reclaim: return the stale `dispatched` record to `pending` (CAS —
        // re-checks staleness AND reconstructability inside the patch so a
        // concurrent reclaim from another window, or a round that finalizes
        // at the last instant, cannot double-reclaim a record that is no
        // longer stale, no longer reconstructable, or no longer present) so
        // the ordinary pending-claim logic below re-arms it in this same
        // pass.
        const reclaimed = await this.store.patch(vscode.Uri.file(task.taskFolderPath), (progress) => {
          const record = progress.implRecovery;
          if (!record || record.dispatch !== "dispatched") return progress;
          if (!isStaleDispatchedImplRecoveryV1(record, this.clock.now())) return progress;
          if (!isReconstructableImplRecoveryV1(record, progress)) return progress;
          return {
            ...progress,
            implRecovery: {
              ...record,
              dispatch: "pending",
              attemptId: undefined,
              leaseOwner: undefined,
              leaseUntil: undefined,
            },
          };
        });
        if (reclaimed === undefined || reclaimed.implRecovery === undefined || reclaimed.implRecovery.dispatch !== "pending") {
          // Another window already reclaimed it, it finalized in the
          // meantime, or it was no longer stale/reconstructable under the
          // fresh read — no action needed from this pass.
          continue;
        }
        if (!this.staleRecoveryNotified.has(task.taskFolderPath)) {
          this.staleRecoveryNotified.add(task.taskFolderPath);
          NotificationRouter.showWarning(
            `⚠️ A stalled recovery continuation for "${notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath)}" ` +
              "was reclaimed and will be re-armed automatically (the round that had claimed it never " +
              "finalized — the window running it likely died or the provider hit a usage limit). The " +
              "unreported edits remain preserved in pendingImplReviewFiles."
          );
        }
        // Fall through into the pending-claim logic below using the
        // freshly-reclaimed record (its lease fields are now clear, so the
        // liveness check immediately below passes).
        recovery = reclaimed.implRecovery;
      }
      // Cap reached: the transition already escalated (paused the task) or
      // surfaced its failure to do so; re-dispatching would burn a round the
      // budget says a human must authorize.
      if ((task.progress.incompleteRoundContinuations ?? 0) >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1) {
        continue;
      }
      // ANY live lease blocks a re-arm — including this window's own. The
      // sweep runs on every progress change and every 5 minutes; a claim it
      // could immediately re-take would turn one cancelled continuation into
      // a dispatch loop. A pending record is retried only once its previous
      // claim's lease has fully expired.
      const leaseLive =
        recovery.leaseUntil !== undefined &&
        new Date(recovery.leaseUntil).getTime() > this.clock.now();
      if (leaseLive) {
        // A lease normally flips to `dispatched` within seconds of the claim.
        // One that is still `pending` a couple of minutes on is a genuine
        // wait until the lease expires — announce it, with Run now.
        const claimedAt = new Date(recovery.leaseUntil ?? 0).getTime() - LEASE_DURATION_MS;
        if (this.clock.now() - claimedAt > OWED_CONTINUATION_WAIT_ANNOUNCE_AFTER_MS_V1) {
          await this.announceOwedContinuationWaitV1(
            task,
            `lease:${recovery.leaseUntil ?? ""}`,
            new Date(recovery.leaseUntil ?? 0),
            "an earlier attempt claimed it and has not started a round"
          );
        }
        continue;
      }
      if (isAutomationChainActive(task.taskFolderPath, IMPL_CONTINUATION_CHAIN_ID_V1, this.clock.now())) {
        await this.announceOwedContinuationWaitV1(
          task,
          "chainGuard",
          undefined,
          "its automation chain guard is still held by a chain that is in flight"
        );
        if (!this.chainGuardSkipNotified.has(task.taskFolderPath)) {
          this.chainGuardSkipNotified.add(task.taskFolderPath);
          NotificationRouter.showWarning(
            `⚠️ A pending recovery continuation for "${notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath)}" ` +
              "was not re-dispatched this sweep because its automation chain guard is still held. " +
              "This is expected while that chain is genuinely in flight; if it persists, the guard " +
              "will expire on its own and the next sweep will retry."
          );
        }
        continue;
      }
      this.chainGuardSkipNotified.delete(task.taskFolderPath);
      await this.claimAndDispatchOwedContinuationV1(task.taskFolderPath);
    }
  }

  /**
   * Claim a `pending` owed continuation (lease CAS) and dispatch its chain.
   * Shared by the periodic sweep and "Run now" (v1 fixes 2, item 22), so both
   * take exactly the same protected path. Returns whether this window claimed
   * and dispatched it.
   */
  private async claimAndDispatchOwedContinuationV1(taskFolderPath: string): Promise<OwedDispatchResultV1> {
    if (this.owedClaimsInFlight.has(taskFolderPath)) {
      return { kind: "notClaimed", heldBy: this.owner };
    }
    this.owedClaimsInFlight.add(taskFolderPath);
    try {
      return await this.claimAndDispatchOwedContinuationLockedV1(taskFolderPath);
    } finally {
      this.owedClaimsInFlight.delete(taskFolderPath);
    }
  }

  /**
   * Tasks with a claim-and-dispatch attempt in flight in THIS window. The lease
   * owner is a window-wide string, so two attempts here cannot tell their
   * claims apart in the file; this keeps the second from ever entering the
   * claim (and from releasing the first one's lease). Cross-window exclusion is
   * the lease itself.
   */
  private readonly owedClaimsInFlight = new Set<string>();

  /** The claim-and-dispatch body; the caller holds this task's `owedClaimsInFlight` entry. */
  private async claimAndDispatchOwedContinuationLockedV1(taskFolderPath: string): Promise<OwedDispatchResultV1> {
    // Identity of THIS attempt's claim: the exact lease expiry it wrote, and
    // whether its own write (not someone's earlier one) is what landed.
    let wroteClaim = false;
    let claimLeaseUntil: string | undefined;
    const claimed = await this.store.patch(vscode.Uri.file(taskFolderPath), (progress) => {
      wroteClaim = false;
      const record = progress.implRecovery;
      if (!record || record.dispatch !== "pending") return progress;
      const live =
        record.leaseUntil !== undefined &&
        new Date(record.leaseUntil).getTime() > this.clock.now();
      if (live) return progress;
      wroteClaim = true;
      claimLeaseUntil = new Date(this.clock.now() + LEASE_DURATION_MS).toISOString();
      return {
        ...progress,
        implRecovery: {
          ...record,
          leaseOwner: this.owner,
          leaseUntil: claimLeaseUntil,
        },
      };
    });
    if (
      !wroteClaim ||
      claimed?.implRecovery?.leaseOwner !== this.owner ||
      claimed.implRecovery.dispatch !== "pending"
    ) {
      return { kind: "notClaimed", heldBy: claimed?.implRecovery?.leaseOwner };
    }
    // PART 6.5 (review-flagged 2026-08-23): this claim re-arms the lease on
    // the same `implRecovery` record the ledger tracks — push the
    // freshly-claimed fact through right after the CAS resolves (never from
    // inside the callback, which may re-run on a retry).
    await syncOwedContinuationLedgerBestEffortV1(
      taskFolderPath,
      owedContinuationSourceV1(claimed.implRecovery, claimed.pendingImplReviewFiles ?? [])
    );
    // No root operation: nothing holds the task lock (the transition's own
    // in-process chain either fired long ago or died with its window), so
    // the command dispatches immediately. The shared chainId keeps this
    // sweep and any in-flight in-process chain from double-firing.
    // `onDropped` fires synchronously for a duplicate chain or disabled
    // automation, so a drop is known as soon as the call returns; the returned
    // promise itself only settles when the whole round ends.
    const dropped: { reason?: string } = {};
    void scheduleAutomationChain({
      command: "vs-code-ai-helper.runImplementationWithAI",
      // No human on this path — see ReviewCommandArg.automationDispatch.
      arg: { taskFolderPath, automationDispatch: true },
      taskKey: taskFolderPath,
      chainId: IMPL_CONTINUATION_CHAIN_ID_V1,
      onDropped: (reason) => {
        dropped.reason = reason;
      },
      intent: {
        trigger: "owed implementation continuation re-armed by the periodic recovery sweep",
        settingKey: undefined,
        expectedTiming: "immediately — this sweep pass dispatches it now",
        willRetry: true,
        retryNote:
          "This sweep re-arms and retries while the continuation record stays 'pending'; once a round " +
          "actually starts (dispatch flips to 'dispatched'), it will not retry again automatically.",
      },
    });
    if (dropped.reason !== undefined) {
      // Nothing was dispatched: give the claim back so the next attempt is not
      // held off for the whole lease, and do not report a start.
      // Only THIS claim's lease is given back (owner and expiry both match).
      await this.store.patch(vscode.Uri.file(taskFolderPath), (progress) => {
        const record = progress.implRecovery;
        if (
          !record ||
          record.dispatch !== "pending" ||
          record.leaseOwner !== this.owner ||
          record.leaseUntil !== claimLeaseUntil
        ) {
          return progress;
        }
        return { ...progress, implRecovery: { ...record, leaseOwner: undefined, leaseUntil: undefined } };
      });
      return { kind: "dropped", reason: dropped.reason };
    }
    await this.withdrawOwedContinuationCardV1(taskFolderPath, undefined, "the owed continuation has been dispatched");
    return { kind: "dispatched" };
  }

  /** Owed-continuation re-arms already announced (task + the wait they announced). */
  private readonly owedRetryAnnounced = new Map<string, string>();

  /**
   * v1 fixes 2, item 22: post the Run-now card for an owed continuation the
   * sweep is making the user wait for (a live lease from its previous claim,
   * or a still-held automation chain guard). One card per distinct wait —
   * the same wait is never announced twice, however often the sweep runs.
   */
  private async announceOwedContinuationWaitV1(
    task: { taskFolderPath: string; canonicalId?: string; progress: TaskProgress },
    waitKey: string,
    dueAt: Date | undefined,
    waitingOn: string
  ): Promise<void> {
    if (this.owedRetryAnnounced.get(task.taskFolderPath) === waitKey) return;
    this.owedRetryAnnounced.set(task.taskFolderPath, waitKey);
    const target: ChatTarget = {
      canonicalId: task.canonicalId ?? task.taskFolderPath,
      taskFolderPath: task.taskFolderPath,
      stage: task.progress.currentStage,
      taskName: task.progress.displayName,
    };
    try {
      await postWorkflowDecisionV1(buildOwedContinuationDecisionV1(target, dueAt, waitingOn), target);
    } catch (error) {
      console.error("announceOwedContinuationWaitV1: could not post the Run-now card", error);
    }
  }

  private async withdrawOwedContinuationCardV1(
    taskFolderPath: string,
    canonicalId: string | undefined,
    reason: string
  ): Promise<void> {
    this.owedRetryAnnounced.delete(taskFolderPath);
    const task = this.inventory.getTasks().find((candidate) => candidate.taskFolderPath === taskFolderPath);
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath, canonicalId: canonicalId ?? task?.canonicalId ?? taskFolderPath },
      "owedContinuationRunNow",
      reason
    ).catch(() => undefined);
  }

  /**
   * v1 fixes 2, item 22: "Run now" for an owed continuation. It takes the SAME
   * protected claim-and-dispatch path as the sweep, and gives up only what the
   * user can rightly give up: this window's OWN lease (nothing else in this
   * window is using it once the chain guard is clear). A lease held by another
   * window is never cleared from here — that window may be mid-dispatch, and a
   * second dispatch would double-run the continuation — so it is a refusal that
   * names the holder. The chain guard is not bypassed either.
   */
  async runOwedContinuationNow(
    taskFolderPath: string,
    canonicalId?: string
  ): Promise<"started" | "refused" | "nothingOwed" | "alreadyRunning"> {
    const current = await this.store.patch(vscode.Uri.file(taskFolderPath), (progress) => progress);
    const recovery = current?.implRecovery;
    if (!recovery) {
      return "nothingOwed";
    }
    if (recovery.dispatch !== "pending") {
      return "alreadyRunning";
    }
    if (this.owedClaimsInFlight.has(taskFolderPath)) {
      return this.refuseOwedContinuationNowV1(
        taskFolderPath,
        canonicalId,
        "another attempt in this window (the recovery sweep or an earlier Run now) is dispatching it right now"
      );
    }
    // Held across the own-lease clear AND the claim, so an overlapping attempt
    // here can neither clear nor release the lease this one takes.
    this.owedClaimsInFlight.add(taskFolderPath);
    try {
      return await this.runOwedContinuationNowGuardedV1(taskFolderPath, canonicalId, recovery);
    } finally {
      this.owedClaimsInFlight.delete(taskFolderPath);
    }
  }

  private async runOwedContinuationNowGuardedV1(
    taskFolderPath: string,
    canonicalId: string | undefined,
    recovery: NonNullable<TaskProgress["implRecovery"]>
  ): Promise<"started" | "refused"> {
    const leaseLive =
      recovery.leaseUntil !== undefined && new Date(recovery.leaseUntil).getTime() > this.clock.now();
    if (leaseLive && recovery.leaseOwner !== this.owner) {
      return this.refuseOwedContinuationNowV1(
        taskFolderPath,
        canonicalId,
        `another VS Code window (${recovery.leaseOwner ?? "unknown owner"}) holds its claim until ` +
          `${new Date(recovery.leaseUntil ?? 0).toLocaleTimeString()}, and may be dispatching it right now`
      );
    }
    if (isAutomationChainActive(taskFolderPath, IMPL_CONTINUATION_CHAIN_ID_V1, this.clock.now())) {
      return this.refuseOwedContinuationNowV1(
        taskFolderPath,
        canonicalId,
        "its automation chain guard is still held, so a continuation chain is genuinely in flight"
      );
    }
    if (leaseLive) {
      // This window's own earlier claim, with no chain in flight: the wait the
      // user is choosing not to sit out. Compare-and-clear so a concurrent
      // change of owner is left alone.
      await this.store.patch(vscode.Uri.file(taskFolderPath), (progress) => {
        const record = progress.implRecovery;
        if (
          !record ||
          record.dispatch !== "pending" ||
          record.leaseOwner !== this.owner ||
          record.leaseUntil !== recovery.leaseUntil
        ) {
          return progress;
        }
        return { ...progress, implRecovery: { ...record, leaseOwner: undefined, leaseUntil: undefined } };
      });
    }
    const result = await this.claimAndDispatchOwedContinuationLockedV1(taskFolderPath);
    if (result.kind === "dispatched") {
      return "started";
    }
    return this.refuseOwedContinuationNowV1(
      taskFolderPath,
      canonicalId,
      result.kind === "dropped"
        ? `the continuation chain was dropped (${result.reason})`
        : `another window claimed it first${result.heldBy ? ` (${result.heldBy})` : ""}`
    );
  }

  /** A refused Run now: post the card naming why, and report `refused`. */
  private async refuseOwedContinuationNowV1(
    taskFolderPath: string,
    canonicalId: string | undefined,
    reason: string
  ): Promise<"refused"> {
    const task = this.inventory.getTasks().find((candidate) => candidate.taskFolderPath === taskFolderPath);
    if (task) {
      this.owedRetryAnnounced.delete(taskFolderPath);
      await this.announceOwedContinuationWaitV1(
        { ...task, canonicalId: canonicalId ?? task.canonicalId },
        `refused:${this.clock.now()}`,
        undefined,
        reason
      );
    }
    return "refused";
  }

  /**
   * Tasks whose stalled-active state this window has already escalated —
   * mirrors `staleRecoveryNotified`'s once-per-window dedup. Not strictly
   * needed for correctness (once paused, `status` is no longer `"active"` and
   * the predicate stops matching on its own), but avoids a duplicate
   * notification if the pause write itself is still in flight when the next
   * sweep starts.
   */
  private readonly stalledActiveNotified = new Set<string>();

  /**
   * A1's watchdog, both routes, through ONE call into `terminalizeRoundV1` —
   * the round ledger's sole exported transition authority (completion
   * blocker `de9851ef-f5bb-41ed-ac18-f50cafefc245-1`, resolved 2026-09-06 by
   * removing the previously-separate `pauseTaskWithNoLiveRoundV1` export and
   * folding its behavior into `terminalizeRoundV1` itself via the
   * `whenNoLiveRow` option). Given `attemptId` (the stuck-`implRecovery`
   * route's continuation row) or `undefined` (the generic route, which by
   * construction has no open round-ledger row left — see
   * `isImpossibleActiveStateV1`'s `hasOpenRoundLedgerRowV1` check), the SAME
   * call resolves the live-row case (folding the pause, and for the recovery
   * route the `implRecovery` clear, into that transaction via
   * `postTerminalizePatch` so the ledger's ending and the task's paused
   * status can never observably disagree) and the no-live-row case (via
   * `whenNoLiveRow`, never touching `roundLedger`) without the caller ever
   * choosing between two functions. `implRecovery` MUST be cleared for the
   * recovery route, not merely left in place under a paused status: without
   * this, resuming the task reproduces the identical impossible state
   * instantly (the same stuck record, nothing changed). The common case for
   * the recovery route is `alreadyTerminal`/`notFound` — this task's own
   * round-ledger reconciliation pass, earlier in this same sweep, will
   * already have closed the continuation's row as orphaned — so
   * `terminalizeRoundV1` itself falls through to `whenNoLiveRow`; the generic
   * route always takes that same fallback, for the reason above.
   * Fabricating a `RoundLedgerEntryV1` via `terminalizeRoundV1`'s
   * `synthesizeIfMissing` remains rejected for the reason recorded in prior
   * revisions of this comment (the generic route's whole premise is that NO
   * round ran; synthesizing one would render a false "_Ended: … —
   * interrupted …_" into chat history and corrupt the ledger's "one entry
   * per real round" invariant) — `whenNoLiveRow` moves `TaskProgress` off
   * `active` without ever touching `roundLedger`.
   * `isStillImpossible` re-checks `isImpossibleActiveStateV1` against the
   * FRESH state read inside the patch (not the snapshot the caller iterated
   * over) either way, so a concurrent resolution — another window's reclaim
   * of the same `implRecovery` record, or the user resuming the task by
   * hand — between this call's snapshot and its write is a safe no-op, never
   * a stale double-pause. Still writes through `this.store.patch` for the
   * no-live-row branch (the same durable, CAS-guarded,
   * re-checked-against-fresh-state primitive every other transition in this
   * codebase uses, and still injectable for tests) via `whenNoLiveRow.patch`.
   */
  private async closeStalledTaskThroughLedgerV1(
    task: { readonly taskFolderPath: string; readonly progress: TaskProgress },
    attemptId: string | undefined,
    reason: string,
    claimId: string,
    claimOwnerToken: string,
    fenceGeneration: number
  ): Promise<{ readonly progress: TaskProgress | undefined; readonly transitioned: boolean }> {
    const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
    // `excludeWorkAdmissionOwnerToken` is this call's OWN `pauseCommit` claim
    // — without it, re-checking `isImpossibleActiveStateV1` while holding
    // that very claim would see the claim's own marker as live admission and
    // conclude the state is no longer impossible, so the pause below could
    // never actually commit (2026-09-09 fix — see the field's doc comment in
    // `taskWatchdogV1.ts`).
    const isStillImpossible = (current: TaskProgress): boolean =>
      isImpossibleActiveStateV1({
        progress: current,
        taskCanonicalId: task.taskFolderPath,
        now: this.clock.now(),
        excludeWorkAdmissionOwnerToken: claimOwnerToken,
      });
    const clearImplRecovery = reason === UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1;

    // 2026-09-04 review follow-up: a disk-backed concurrency test caught two
    // windows racing the generic no-ledger-row route both reading back
    // `status: "paused"` from the shared file and both posting the
    // stalled-task escalation, even though only one of them performed the
    // write. `liveRowTransitioned` (for the live-row branch) and the result's
    // own `transitioned` field (for the no-live-row branch) are set only by
    // the window whose own fresh read still found the impossible state, so
    // the caller can post the escalation exactly once per real detection
    // rather than once per window that merely observed the already-paused
    // result.
    let liveRowTransitioned = false;
    const result = await terminalizeRoundV1(
      attemptId,
      "interrupted",
      {
        rejectionReason:
          "the continuation was dispatched but never finalized, and its record lost the evidence " +
          "needed to safely re-arm it — closed by the watchdog",
      },
      {
        taskFolderUri,
        postTerminalizePatch: (current) => {
          if (!isStillImpossible(current)) {
            return current;
          }
          liveRowTransitioned = true;
          const cleared = clearImplRecovery ? { ...current, implRecovery: undefined } : current;
          return pauseTaskWithReasonForClaimV1(cleared, reason, claimId, fenceGeneration);
        },
        whenNoLiveRow: {
          reason,
          clearImplRecovery,
          isStillImpossible,
          claimId,
          fenceGeneration,
          patch: (folder, transform) => this.store.patch(folder, transform),
        },
      }
    );

    if (result.ok && "noLiveRow" in result) {
      return { progress: result.progress, transitioned: result.transitioned };
    }
    if (!result.ok) {
      // Unreachable in practice: `whenNoLiveRow` is always supplied above, so
      // `terminalizeRoundV1` never falls through to a bare `ok: false` here.
      return { progress: undefined, transitioned: false };
    }
    return { progress: result.progress, transitioned: liveRowTransitioned };
  }

  /**
   * A1's watchdog (1.0.0 gate): after every other self-healing pass above has
   * had its chance, find any task still `status: active` with no live
   * operation, no owed continuation, and no scheduled intent —
   * `isImpossibleActiveStateV1` (`taskWatchdogV1.ts`) — and move it to an
   * explicit `paused` state with an escalation, rather than leaving it to sit
   * `active` forever with nothing running and no signal that anything is
   * wrong. Deliberately acts ONLY through durable state transitions
   * (`closeStalledTaskThroughLedgerV1` above, for both routes) — never
   * dispatches work itself — so running this twice over unchanged state is a
   * no-op: the first run's pause flips `status` away from `"active"`, which
   * the predicate itself then excludes.
   *
   * v1 fixes item 1, Part 1a step 4 ("make the ordinary pause lose the
   * ordinary race"): committing the pause now happens only while holding the
   * SAME shared `admission.claim` file a work-starting command's own genesis
   * contends for (purpose `pauseCommit`). This claim is deliberately NOT a
   * hard exclusion for a concurrent `admission`-purpose genesis (2026-09-09
   * review, narrowed architectural blocker fix): such a genesis instead
   * polls its own exclusive create (`workAdmissionV1.ts`'s
   * `CLAIM_CONTENTION_POLL_INTERVAL_MS_V1`) for as long as this claim would
   * not yet be judged stale (`WORK_ADMISSION_LIKELY_STALE_MS_V1`) while this
   * claim resolves, and once this sweep's claim becomes a MARKER,
   * `markerBlocksAcquisitionV1` lets that genesis proceed immediately rather
   * than reporting `busy` — so "the loser should be the pause, not the round"
   * holds even while this claim is held, not only once it is gone. What this
   * claim DOES still exclude is another concurrent `pauseCommit` attempt (a
   * second sweep pass or window), so two sweeps can never both believe they
   * have "won" a commit at once. A claim this sweep cannot acquire (busy —
   * another `pauseCommit` attempt is live) means the LOSER here is the pause,
   * not the round: this task is simply skipped for this sweep pass, and the
   * very next sweep re-evaluates from scratch — nothing is stranded by
   * skipping, since `isImpossibleActiveStateV1` will see the same (or a
   * resolved) state again next time.
   */
  private async detectAndRepairStalledActiveTasksV1(): Promise<void> {
    // 2026-09-10 review completion blocker, narrowed further: a command
    // resolving WHICH task it targets (`runPublishChecks.ts`,
    // `commitAndPushTask.ts`/`completeCommitAndPushTask`, between
    // `waitUntilReady()` and the moment its target settles) has no task
    // folder path to admit yet — per-task admission cannot protect a task
    // whose identity isn't known. Stand this whole pass down while any such
    // resolution is in flight in this window, rather than risk pausing the
    // very task that resolution is about to settle on and start work for.
    // See `hasResolutionInFlightBestEffortV1`'s doc comment.
    //
    // 2026-09-10 review completion blocker (new): that same-process check
    // alone is invisible to a DIFFERENT window's sweep — this pass also
    // consults the durable, cross-window counterpart
    // (`hasDurableResolutionInFlightV1`) across every task root candidate
    // this window can see, so a resolution running in ANOTHER window on the
    // same workspace stands this sweep down too.
    if (hasResolutionInFlightBestEffortV1()) {
      return;
    }
    if (hasDurableResolutionInFlightV1(resolveTaskRootCandidates().map((candidate) => candidate.absolutePath))) {
      return;
    }
    for (const task of this.inventory.getTasks()) {
      if (!isImpossibleActiveStateV1({ progress: task.progress, taskCanonicalId: task.taskFolderPath, now: this.clock.now() })) {
        this.stalledActiveNotified.delete(task.taskFolderPath);
        continue;
      }
      if (this.stalledActiveNotified.has(task.taskFolderPath)) {
        continue;
      }
      const claimResult = await acquireWorkAdmissionV1({
        taskFolderPath: task.taskFolderPath,
        purpose: "pauseCommit",
        commandId: "vs-code-ai-helper.watchdogPauseCommit",
      });
      if (claimResult.outcome !== "acquired") {
        continue;
      }
      const { ownerToken, claimId } = claimResult.handle;
      try {
        // Repeat the absence check UNDER the claim: a command's genesis could
        // have completed in the narrow window between this loop's admission
        // pre-check (inside `isImpossibleActiveStateV1` above) and this
        // claim's acquisition. Excludes this claim's own marker, which is
        // this sweep's own transitional lock, never "someone else's" live
        // work.
        if (hasLiveWorkAdmissionExcludingOwnerV1(task.taskFolderPath, ownerToken)) {
          continue;
        }
        // v1 fixes item 1, Part 1b step 1: capture the durable pause-fence
        // generation exactly once here, before this attempt's progress
        // mutation begins — every subsequent step (the write below, and both
        // currency checks) carries this SAME captured value, never a
        // re-read, so a concurrent revocation's later fence advance is
        // unambiguously "after" this attempt's own snapshot rather than
        // something this attempt could race into observing halfway.
        const fenceGeneration = await readOrInitPauseFenceGenerationV1(task.taskFolderPath);
        // Pre-write currency check, matching the plan's literal "pre-write
        // and post-write checks" pairing: Part 1b's revocation protocol
        // (`revokeStalePauseCommitClaimV1` + a barrier-finisher's fence
        // advance) can now genuinely land between the capture immediately
        // above and this read, so this is real, load-bearing currency
        // validation, not the placeholder it was before revocation existed.
        // `onBeforePreWriteFenceCheckAsync`/`onAfterPreWriteFenceCheckAsync`
        // (test-only, see `PauseCommitTestHooksV1` above) bracket exactly
        // this read so a test can deterministically revoke on either side of
        // it.
        await pauseCommitTestHooksV1?.onBeforePreWriteFenceCheckAsync?.();
        if (!(await isWatchdogPauseFenceCurrentV1(task.taskFolderPath, fenceGeneration))) {
          continue;
        }
        await pauseCommitTestHooksV1?.onAfterPreWriteFenceCheckAsync?.();
        const recovery = task.progress.implRecovery;
        const stuckRecovery =
          recovery !== undefined && isUnrecoverableImplRecoveryV1(recovery, task.progress, this.clock.now());
        const expectedReason = stuckRecovery
          ? UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1
          : STALLED_ACTIVE_TASK_PAUSE_REASON_V1;
        const { progress: patched, transitioned } = await this.closeStalledTaskThroughLedgerV1(
          task,
          stuckRecovery ? recovery?.attemptId : undefined,
          expectedReason,
          claimId,
          ownerToken,
          fenceGeneration
        );
        if (!transitioned || patched?.status !== "paused" || patched.pausedReason !== expectedReason) {
          // Either nothing changed, or the task was already paused by a
          // racing window's write between this loop's snapshot and this
          // call's own fresh read — that window already posted the
          // escalation, so this one must not post a second copy of it.
          continue;
        }
        // Test-only boundary (see `PauseCommitTestHooksV1` above): the raw
        // pause write has now landed on disk, but the post-write
        // admission/fence currency checks immediately below have not run
        // yet.
        await pauseCommitTestHooksV1?.onAfterRawWriteBeforePostValidationAsync?.();
        // Post-write checks, again excluding this claim's own marker: a
        // command's genesis that started AFTER our pre-write check but
        // BEFORE our write landed on disk must still be found here and
        // reversed, never announced as a pause — the mirror case of
        // `reconcileWatchdogPauseAgainstAdmissionV1`, which covers the same
        // race from the ADMITTING side. `watchdogPauseClaimId` is checked
        // alongside status/reason so this reversal can only ever clear the
        // EXACT pause attempt this call itself just committed. The fence
        // currency check (Part 1b step 1) is the same idea for revocation,
        // once it exists: a revoke-and-advance that lands during the awaited
        // write above must be found here too, not just a live admission
        // marker.
        const admissionArrivedDuringWrite = hasLiveWorkAdmissionExcludingOwnerV1(task.taskFolderPath, ownerToken);
        const fenceAdvancedDuringWrite = !(await isWatchdogPauseFenceCurrentV1(task.taskFolderPath, fenceGeneration));
        if (admissionArrivedDuringWrite || fenceAdvancedDuringWrite) {
          await this.store.patch(vscode.Uri.file(task.taskFolderPath), (current) => {
            if (
              current.status !== "paused" ||
              current.pausedReason !== expectedReason ||
              current.watchdogPauseClaimId !== claimId
            ) {
              // Something else already moved the task on; do not clobber it.
              return current;
            }
            return {
              ...current,
              status: "active",
              pausedReason: undefined,
              watchdogPauseClaimId: undefined,
              watchdogPauseFenceGeneration: undefined,
              updatedAt: new Date(this.clock.now()).toISOString(),
            };
          });
          continue;
        }
        // Test-only boundary (see `PauseCommitTestHooksV1` above): the
        // post-write admission/fence currency checks just passed — this
        // sweep is committed to notifying — but the escalation has not been
        // built or posted yet.
        await pauseCommitTestHooksV1?.onAfterPostValidationBeforeNotificationAsync?.();
        this.stalledActiveNotified.add(task.taskFolderPath);
        // v1 fixes item 1, Part 1a step 7: "a watchdog pause must carry the
        // action that undoes it" — a mechanism that can pause a task must
        // offer the corresponding restart directly on the pause itself, not
        // merely leave the user to find "Resume Task" in the tree's context
        // menu on their own. Posted as a durable WorkflowDecisionV1 (mirrors
        // every other escalation-driven pause — `reviewEscalation.ts`'s
        // `buildEscalationDecisionV1`), NOT a toast `actionCommand`
        // dispatching the command directly: `scripts/verifyToastAllowlistV1.mjs`
        // enforces the project's notification-ownership rule (a workflow
        // action must not exist ONLY on a transient toast) and rejects a
        // direct-dispatch toast from a background sweep like this one — it is
        // not "inline in the user-invoked command it belongs to", the one
        // shape that would qualify for the allowlist instead. Adding
        // "watchdogStalledEscalation" to `ESCALATION_DECISION_KEYS_V1`
        // (reviewEscalation.ts) means `resumeTask.ts`'s resume-time
        // withdrawal loop retires this card the same way it retires every
        // other escalation, with no extra wiring needed here.
        const target: ChatTarget = {
          canonicalId: task.canonicalId,
          taskFolderPath: task.taskFolderPath,
          stage: task.progress.currentStage,
          taskName: task.progress.displayName,
        };
        // Items 14 + 25: name the action the button will run. A plan that
        // cannot be loaded degrades to a generic (but never "re-run this
        // stage") label rather than blocking the pause card.
        const resumePlan = await loadResumeActionPlanV1(task.taskFolderPath, task.progress).catch(
          () => undefined
        );
        const posted = await postWorkflowDecisionV1(
          buildStalledTaskEscalationDecisionV1(stuckRecovery, target, resumePlan),
          target
        );
        if (!posted) {
          // Best-effort fallback (directAllowlistEntries shape 2): no
          // activating extension context to post a decision through (e.g. a
          // unit test, or a very early sweep before activation finishes).
          // Plain text, no action button — the tree's own "Resume Task"
          // context-menu entry (package.json's `task-paused` clause) remains
          // reachable regardless of whether this notification carries one.
          NotificationRouter.showWarning(
            stuckRecovery
              ? describeUnrecoverableRecoveryEscalationV1(notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath))
              : describeStalledActiveTaskEscalationV1(notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath))
          );
        }
      } finally {
        // Released only after the write and its post-write validation have
        // fully settled (plan step 4) — never earlier, so genesis stays
        // excluded for the whole commit, not just its first half.
        await claimResult.handle.release();
      }
    }
  }

  async cancel(taskFolderPath: string): Promise<void> {
    const timer = this.timers.get(taskFolderPath);
    if (timer) this.clock.clearTimeout(timer);
    this.timers.delete(taskFolderPath);
    this.armedRuns.delete(taskFolderPath);
    await this.store.patch(vscode.Uri.file(taskFolderPath), progress => ({
      ...progress,
      scheduledRun: undefined,
      scheduledResumeTime: undefined,
      updatedAt: new Date(this.clock.now()).toISOString(),
    }));
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    // Disposal cannot await, but releasing the lease is still important for a
    // new window activating immediately after this one closes.
    const ownedPaths = new Set(this.armedRuns.keys());
    this.armedRuns.clear();
    for (const task of this.inventory.getTasks()) {
      // Only schedules leased by this window need releasing. Patching every
      // task here needlessly journals and rewrites unrelated progress files.
      // `ownedPaths` also covers a lease this scheduler just claimed before
      // the inventory watcher has refreshed its in-memory task snapshot.
      if (task.progress.scheduledRun?.leaseOwner !== this.owner && !ownedPaths.has(task.taskFolderPath)) continue;
      void this.store.patch(vscode.Uri.file(task.taskFolderPath), progress => {
        if (progress.scheduledRun?.leaseOwner !== this.owner) return progress;
        return {
          ...progress,
          scheduledRun: { ...progress.scheduledRun, leaseOwner: undefined, leaseUntil: undefined },
        };
      });
    }
    // Recovery-dispatch leases this window claimed are released the same way,
    // so another window can re-arm a still-pending continuation immediately
    // instead of waiting out the lease.
    for (const task of this.inventory.getTasks()) {
      if (task.progress.implRecovery?.leaseOwner !== this.owner) continue;
      const taskFolderPath = task.taskFolderPath;
      void this.store
        .patch(vscode.Uri.file(taskFolderPath), progress => {
          if (progress.implRecovery?.leaseOwner !== this.owner) return progress;
          return {
            ...progress,
            implRecovery: { ...progress.implRecovery, leaseOwner: undefined, leaseUntil: undefined },
          };
        })
        // PART 6.5 (review-flagged 2026-08-23): dispose() cannot await, but
        // the ledger push can still ride the same fire-and-forget chain as
        // the lease-release write itself, closing the last of the nine
        // `implRecovery` mutation sites.
        .then((patched) =>
          syncOwedContinuationLedgerBestEffortV1(
            taskFolderPath,
            owedContinuationSourceV1(patched?.implRecovery, patched?.pendingImplReviewFiles ?? [])
          )
        )
        .catch(() => undefined);
    }
  }
}

export async function scheduleTaskResume(
  inventory: TaskInventory,
  scheduler: TaskActionScheduler,
  arg?: ScheduleArg,
  clock: SchedulerClock = systemSchedulerClock
): Promise<void> {
  // Block on the startup gate's classification pass before this lifecycle
  // command's first task-state read (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();

  const resolverArg = arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg && (arg.canonicalId || arg.taskFolderPath) ? { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath } : undefined;
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: false });
  if (!task) return;
  const value = await vscode.window.showInputBox({ prompt: "Schedule current-stage action (ISO date/time)", value: new Date(clock.now() + LEASE_DURATION_MS).toISOString() });
  const runAt = value ? new Date(value) : undefined;
  if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= clock.now()) {
    if (value) NotificationRouter.showWarning("Enter a future date/time.");
    return;
  }
  // v1 fixes 2, Wave I chokepoint (arms a schedule): arming a scheduled run
  // means automation, not the human, acts next — see `nextActor`'s own doc
  // comment (`effectiveNextActorV1`). Composed via `setNextActorV1` on the
  // SAME progress object the schedule write already produces, rather than a
  // follow-up patch, so no reader ever observes the schedule armed without it.
  await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), p => setNextActorV1({ ...p, scheduledRun: { runAt: runAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date(clock.now()).toISOString() }, "automation"));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  const taskLabel = notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath);
  NotificationRouter.showInformation(`Current-stage action for "${taskLabel}" scheduled for ${runAt.toLocaleString()}.`);
}

export async function cancelScheduledTaskAction(inventory: TaskInventory, scheduler: TaskActionScheduler, arg?: ScheduleArg): Promise<void> {
  // Same activation-barrier contract as scheduleTaskResume above (plan §1.4).
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const task = await resolveTaskContext(inventory, arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg, { allowPaused: true });
  if (task) await scheduler.cancel(task.taskFolderPath);
}

/**
 * How far past a provider's own reported reset time the scheduled rerun is
 * armed — a small margin so the rerun doesn't fire the instant the window
 * theoretically reopens (clock skew between this host and the provider,
 * and providers that report a reset boundary a little optimistically).
 */
export const QUOTA_RESUME_SCHEDULE_BUFFER_MS = 2 * 60 * 1000;

/**
 * Programmatic counterpart to `scheduleTaskResume`'s interactive input box
 * (Part 5 step 1): arms a one-shot `scheduledRun` at an explicit `runAt`
 * WITHOUT prompting the user — used by the quota-park remedy's "Rerun after
 * reset" notification action (runnerRegistry.ts), where the resume time is
 * already known from the provider's own reported reset message, so there is
 * nothing left to ask. Mirrors `beginImplementationRecoveryV1`'s pattern of
 * persisting durable state directly and dispatching without an interactive
 * prompt (implementationRecoveryV1.ts).
 *
 * Goes through the exact same `scheduledRun` field and the exact same
 * `TaskActionScheduler.fire` -> `vs-code-ai-helper.applyCurrentStageAction`
 * path as the interactive command, so the fired run gets identical pre-run
 * checks to a manual rerun (dirty-tree awareness via the stage's own runner
 * cascade, a fresh quota observation via `withQuotaObservation`/
 * `recordQuotaObservationAndClearParkV1`, and the stage-moved skip guard) —
 * nothing about firing programmatically bypasses any of that.
 */
export async function scheduleQuotaResumeAtV1(
  inventory: TaskInventory,
  scheduler: TaskActionScheduler,
  arg: ScheduleArg,
  resetAt: Date,
  clock: SchedulerClock = systemSchedulerClock
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const resolverArg = arg.task
    ? { taskFolderPath: arg.task.folderUri.fsPath }
    : { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath };
  // allowPaused: true (not the sibling helpers' false) — the primary caller
  // of this entry point is the chain-exhaustion pause path
  // (pauseTaskForExhaustedChainV1), which parks the task with status
  // "paused" before this ever runs. Refusing paused tasks here made the
  // "Rerun after reset" action on that path a dead click. Arming a
  // scheduled rerun is exactly the recovery a paused task needs; the
  // eventual fire still goes through applyCurrentStageAction, which already
  // handles resuming from paused.
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) return;
  const runAt = new Date(resetAt.getTime() + QUOTA_RESUME_SCHEDULE_BUFFER_MS);
  if (Number.isNaN(runAt.getTime())) {
    NotificationRouter.showWarning("Could not schedule a rerun: the reported reset time is unreadable.");
    return;
  }
  // A reset time already in the past (the operator clicked the action well
  // after the window reopened) is scheduled for "now plus the buffer" rather
  // than silently doing nothing or rejecting the action outright — the
  // provider's block may already have lifted, so an immediate rerun is
  // exactly the right remedy.
  const effectiveRunAt = runAt.getTime() <= clock.now() ? new Date(clock.now() + QUOTA_RESUME_SCHEDULE_BUFFER_MS) : runAt;
  // v1 fixes 2, Wave I chokepoint (arms a schedule) — same reasoning as
  // scheduleTaskResume above: arming a quota-park rerun means automation
  // acts next.
  await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), p => setNextActorV1({ ...p, scheduledRun: { runAt: effectiveRunAt.toISOString(), stage: p.currentStage }, scheduledResumeTime: undefined, updatedAt: new Date(clock.now()).toISOString() }, "automation"));
  await scheduler.arm(task.taskFolderPath, task.canonicalId);
  // Item 22: a quota park is a delayed automatic retry the user would
  // otherwise just wait out — offer "Run now" beside it, in the task's chat.
  await scheduler.announceDelayedRetryV1(
    task.taskFolderPath,
    task.canonicalId,
    task.progress.currentStage,
    "quotaPark",
    effectiveRunAt
  );
  const taskLabel = notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath);
  NotificationRouter.showInformation(
    `Rerun of "${taskLabel}" scheduled for ${effectiveRunAt.toLocaleString()}, once the quota resets.`
  );
}

/**
 * Bounded, durable record of a takeover event, written beside the task's
 * other run logs (2026-09-15 review, completion blocker: the previous
 * version only logged to the extension console, which is invisible to a
 * user inspecting the task folder and is not retained across host restarts —
 * plan step 16's "records bounded displaced-owner diagnostics in the run
 * log" needs the diagnostic to actually live on disk). Named by timestamp,
 * one file per takeover, the same convention `writeOversizedInputAbortRecordV1`
 * / `writeTaskMdSizeBandAnnouncementRecordV1` (`promptManifestV1.ts`) already
 * use for a non-round diagnostic record under `runs/` — NOT routed through
 * `writeRunLog`, whose `AgentWorkflowStage` parameter models an AI round's
 * own stage and has no value that fits a takeover event. Every field written
 * here is a single already-validated primitive from `WorkAdmissionClaimInfoV1`
 * ("never log unbounded or raw corrupt content", plan step 16) — best-effort,
 * like every other diagnostic writer in this module: the takeover itself has
 * already durably landed by the time this is called, so a failure here must
 * never be treated as though the takeover itself failed.
 */
async function writeStaleWorkAdmissionTakeoverRunLogRecordV1(
  taskFolderPath: string,
  record: {
    readonly at: string;
    readonly outcome: "takenOver" | "reclaimedAsDead";
    readonly purpose: string;
    readonly displacedOwner?: { readonly claimId: string; readonly pid: number; readonly hostId: string; readonly commandId: string };
  }
): Promise<void> {
  try {
    const runsUri = vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), RUNS_DIRNAME);
    await vscode.workspace.fs.createDirectory(runsUri);
    const safeAt = record.at.replace(/[:.]/g, "-");
    const uri = vscode.Uri.joinPath(runsUri, `${safeAt}.stale-work-admission-takeover.json`);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(record, null, 2)));
  } catch (error) {
    console.error(
      `writeStaleWorkAdmissionTakeoverRunLogRecordV1: could not write the run-log record for "${taskFolderPath}" — ` +
        "the takeover itself already landed; only this diagnostic record failed.",
      error
    );
  }
}

/**
 * v1 fixes item 1, Part 1c step 16 — the handler behind the takeover
 * notice's action button (`surfaceStaleWorkAdmissionTakeoverNoticeV1`,
 * above). Deliberately thin: all safety-relevant logic (revalidation against
 * the exact identity the notice named, the still-stale check, the
 * dead-owner deferral, the identity-checked rename/barrier) lives in
 * {@link takeOverStaleWorkAdmissionMarkerV1} itself — this only translates
 * its outcome into what the user sees, a bounded console log line, and (on a
 * successful takeover) the durable run-log record
 * ({@link writeStaleWorkAdmissionTakeoverRunLogRecordV1}) plan step 16
 * requires.
 *
 * Not contributed to `package.json`: like `resumeAndApplyCurrentStageAction`,
 * this is a wiring detail behind a notification action button, not something
 * to offer from the Command Palette on its own — it requires the exact
 * `taskFolderPath`/`expectedMarkerPath`/`expectedClaimId` triple the notice
 * captured.
 */
export async function takeOverStaleWorkAdmissionCommandV1(
  inventory: TaskInventory,
  arg?: { readonly taskFolderPath?: string; readonly expectedMarkerPath?: string; readonly expectedClaimId?: string }
): Promise<void> {
  if (!arg?.taskFolderPath || !arg?.expectedMarkerPath) {
    return;
  }
  const taskFolderPath = arg.taskFolderPath;
  const task = inventory.getTasks().find((t) => t.taskFolderPath === taskFolderPath);
  const displayName = notificationTaskDisplayNameV1(task?.progress.displayName, taskFolderPath);
  const outcome = await takeOverStaleWorkAdmissionMarkerV1(taskFolderPath, arg.expectedMarkerPath, arg.expectedClaimId);
  switch (outcome.outcome) {
    case "takenOver":
    case "reclaimedAsDead": {
      const displaced = outcome.displacedOwner;
      console.log(
        `takeOverStaleWorkAdmissionCommandV1: ${outcome.outcome === "reclaimedAsDead" ? "reclaimed (owner had died)" : "took over"} ` +
          `a stale ${outcome.purpose} marker for "${taskFolderPath}"` +
          (displaced
            ? ` (was claim ${displaced.claimId}, owned by pid ${displaced.pid} on ${displaced.hostId}, command "${displaced.commandId}").`
            : " (owner record was unreadable).")
      );
      await writeStaleWorkAdmissionTakeoverRunLogRecordV1(taskFolderPath, {
        at: new Date().toISOString(),
        outcome: outcome.outcome,
        purpose: outcome.purpose,
        displacedOwner: displaced
          ? { claimId: displaced.claimId, pid: displaced.pid, hostId: displaced.hostId, commandId: displaced.commandId }
          : undefined,
      });
      NotificationRouter.showInformation(`Took over "${displayName}" on this machine. You can now resume or dispatch work on it.`);
      break;
    }
    case "ownerChanged":
      NotificationRouter.showInformation(
        `"${displayName}"'s work-admission owner changed before the takeover could apply — no action was taken.`
      );
      break;
    case "noLongerStale":
      NotificationRouter.showInformation(
        `"${displayName}"'s work-admission marker was renewed before the takeover could apply — no action was taken.`
      );
      break;
    case "nothingToTakeOver":
    case "raced":
      // Nothing left to take over — already resolved by something else
      // (released, reclaimed, or won by a concurrent takeover). No further
      // notice needed; the original notice's job is done either way.
      break;
    case "writeFailed":
      NotificationRouter.showWarning(`Could not take over "${displayName}": ${outcome.error.message}`);
      break;
  }
}

export function registerScheduleTaskResumeCommand(context: vscode.ExtensionContext, inventory: TaskInventory): TaskActionScheduler {
  const scheduler = new TaskActionScheduler(inventory);
  context.subscriptions.push(scheduler);
  // Schedules, lease takeovers and cancellations mutate the shared
  // task-progress.json / admission markers the RUNNER owns: a viewer host
  // refuses them (hostRoleV1.ts) instead of fighting the runner for them.
  const unlessViewer = <A extends unknown[]>(run: (...args: A) => unknown) => (...args: A): unknown => {
    if (isViewerHostV1()) {
      NotificationRouter.showWarning(VIEWER_HOST_REFUSAL_MESSAGE_V1);
      return undefined;
    }
    return run(...args);
  };
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.scheduleTaskResume", unlessViewer((arg?: ScheduleArg) => scheduleTaskResume(inventory, scheduler, arg))));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.cancelScheduledTaskAction", unlessViewer((arg?: ScheduleArg) => cancelScheduledTaskAction(inventory, scheduler, arg))));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.scheduleQuotaResumeV1",
    unlessViewer((arg?: ScheduleArg & { resetAtIso?: string }) => {
      if (!arg?.resetAtIso) return;
      const resetAt = new Date(arg.resetAtIso);
      if (Number.isNaN(resetAt.getTime())) return;
      return scheduleQuotaResumeAtV1(inventory, scheduler, arg, resetAt);
    })
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.runScheduledActionNow",
    unlessViewer(async (arg?: ScheduleArg) => {
      const task = await resolveTaskContext(
        inventory,
        arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg,
        { allowPaused: true }
      );
      if (!task) {
        return;
      }
      const outcome = await scheduler.runNow(task.taskFolderPath, task.canonicalId);
      const taskLabel = notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath);
      if (outcome === "nothingScheduled") {
        NotificationRouter.showInformation(`Nothing is scheduled for "${taskLabel}" any more, so there is nothing to run now.`);
      } else if (outcome === "heldElsewhere") {
        NotificationRouter.showWarning(
          `The scheduled action for "${taskLabel}" is held by another VS Code window, so it cannot be run from here. ` +
            "It will run automatically at its scheduled time."
        );
      }
    })
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.runOwedContinuationNow",
    unlessViewer(async (arg?: ScheduleArg) => {
      const task = await resolveTaskContext(
        inventory,
        arg?.task ? { taskFolderPath: arg.task.folderUri.fsPath } : arg,
        { allowPaused: true }
      );
      if (!task) {
        return;
      }
      const outcome = await scheduler.runOwedContinuationNow(task.taskFolderPath, task.canonicalId);
      const taskLabel = notificationTaskDisplayNameV1(task.progress.displayName, task.taskFolderPath);
      if (outcome === "nothingOwed") {
        NotificationRouter.showInformation(`No continuation is owed for "${taskLabel}" any more, so there is nothing to run now.`);
      } else if (outcome === "alreadyRunning") {
        NotificationRouter.showInformation(`The owed continuation for "${taskLabel}" has already started.`);
      }
    })
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.takeOverStaleWorkAdmission",
    unlessViewer((arg?: { taskFolderPath?: string; expectedMarkerPath?: string; expectedClaimId?: string }) => takeOverStaleWorkAdmissionCommandV1(inventory, arg))
  ));
  return scheduler;
}
