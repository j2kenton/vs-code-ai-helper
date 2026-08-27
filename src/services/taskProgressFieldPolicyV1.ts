/**
 * Exhaustive, type-correct task-progress field policy (plan §3.11).
 *
 * `TASK_PROGRESS_FIELD_POLICY_V1` mirrors the plan's per-field lifecycle
 * table; its `Record` type over every persisted field (plus the version
 * marker) makes omitting a field a COMPILE error — this is the plan's
 * completeness proof ("no current persisted field is omitted from this
 * table"). The transition functions below are the only implementation of
 * the nextStage / markTaskDone / reopen columns; the migration column is
 * realized by the strict decoder + writer (taskProgressDecoderV1 /
 * taskProgressWriterV1).
 *
 * Invariants enforced here (plan §3.11):
 *  - `ownership` is never cleared — it is the persisted binding, not a lease;
 *  - operation leases live in workflowLeaseStoreV1, never in task progress;
 *  - `fallbackActive` is only ever a per-stage map, never a scalar;
 *  - `completedStages` remains a canonical stage-order prefix;
 *  - the current-task checkpoint is external coordinator state, untouched here.
 */
import { STAGE_ORDER, TaskProgress, TaskStage } from "../types/taskProgress";
import {
  ENSEMBLE_PROGRESS_VERSION_FIELD_V1,
  PersistedTaskProgressV1,
} from "./taskProgressDecoderV1";
import {
  MarkTaskDonePolicyInputV1,
  NextStagePolicyInputV1,
  ReopenPolicyInputV1,
  TaskProgressFieldPolicyRowV1,
  TaskProgressPolicyResultV1,
} from "../types/taskProgressFieldPolicyV1";

/**
 * The plan §3.11 table, one row per persisted field. The type annotation is
 * the compile-time completeness check: adding a field to `TaskProgress`
 * without adding a row here fails the build.
 */
export const TASK_PROGRESS_FIELD_POLICY_V1: Record<
  keyof TaskProgress | typeof ENSEMBLE_PROGRESS_VERSION_FIELD_V1,
  TaskProgressFieldPolicyRowV1
> = {
  ensembleProgressVersion: {
    migration: "Set to 1 after strict selection; new tasks emit 1.",
    nextStage: "Retain 1.",
    markTaskDone: "Retain 1.",
    reopen: "Retain 1.",
  },
  ownership: {
    migration:
      "Preserve validated project/meta-root binding; a family that legitimately lacks it resolves only from one unambiguous current binding or enters recovery.",
    nextStage: "Preserve exactly.",
    markTaskDone: "Preserve exactly.",
    reopen: "Preserve exactly.",
  },
  taskFolder: {
    migration: "Validate against the discovered task folder; set once for new tasks.",
    nextStage: "Preserve exactly.",
    markTaskDone: "Preserve exactly.",
    reopen: "Preserve exactly.",
  },
  status: {
    migration: "Preserve valid historical state; new task starts creating.",
    nextStage: "Require/remain active.",
    markTaskDone: "Set completed.",
    reopen: "Set active.",
  },
  currentStage: {
    migration: "Preserve one valid canonical stage; new task uses first stage.",
    nextStage: "Set immediate next stage.",
    markTaskDone: "Retain terminal/current stage.",
    reopen: "Set selected stage.",
  },
  createdAt: {
    migration: "Validate and preserve; new task sets once.",
    nextStage: "Preserve.",
    markTaskDone: "Preserve.",
    reopen: "Preserve.",
  },
  updatedAt: {
    migration: "Validate/preserve on format-only migration; new task sets coordinator time.",
    nextStage: "Set coordinator time.",
    markTaskDone: "Set coordinator time.",
    reopen: "Set coordinator time.",
  },
  progressVersion: {
    migration: "Validate non-negative integer/current optionality; absent record stays absent — stamping happens only in patchTaskProgressStrictV1, on the first write that follows.",
    nextStage: "Preserve exactly — patchTaskProgressStrictV1 owns the increment, never a transition builder.",
    markTaskDone: "Preserve exactly — patchTaskProgressStrictV1 owns the increment, never a transition builder.",
    reopen: "Preserve exactly — patchTaskProgressStrictV1 owns the increment, never a transition builder.",
  },
  displayName: {
    migration: "Validate according to current optionality; set from creation input/default.",
    nextStage: "Preserve.",
    markTaskDone: "Preserve.",
    reopen: "Preserve.",
  },
  checklistProgressUnreliable: {
    migration: "Validate exact boolean/current optionality; absent on new tasks.",
    nextStage: "Preserve — a stage change does not reconcile the checklist.",
    markTaskDone: "Preserve.",
    reopen: "Preserve — reopening does not make an under-counting checklist accurate.",
  },
  checklistProgressUnreliableReason: {
    migration: "Validate bounded non-empty string/current optionality; absent on new tasks.",
    nextStage: "Preserve — travels with checklistProgressUnreliable, whose reason it explains.",
    markTaskDone: "Preserve.",
    reopen: "Preserve — same rationale as checklistProgressUnreliable.",
  },
  zeroChangeImplRounds: {
    migration: "Validate non-negative integer/current optionality; absent on new tasks.",
    nextStage: "Clear — a stage transition means the prior stage's zero-change streak no longer describes the stage now current.",
    markTaskDone: "Clear.",
    reopen: "Clear — reopening starts the streak over for the newly selected stage.",
  },
  nameIsDefault: {
    migration: "Validate exact boolean/current optionality; derive during creation.",
    nextStage: "Preserve.",
    markTaskDone: "Preserve.",
    reopen: "Preserve.",
  },
  preImageDescription: {
    migration:
      "Validate bounded current representation; preserve or omit according to historical family.",
    nextStage: "Preserve.",
    markTaskDone: "Preserve.",
    reopen: "Preserve.",
  },
  completedAt: {
    migration:
      "Validate ISO timestamp; preserve as inert historical metadata with any status — completion is inferred solely from status (declaration doc; archiveTask/resumeArchivedTask persist archived/active documents that keep it).",
    nextStage: "Omit.",
    markTaskDone: "Set once from coordinator clock.",
    reopen: "Clear.",
  },
  completedStages: {
    migration:
      "Validate known unique stages and canonicalize to a prefix, backfilling earlier stages through the highest recorded tick (markTaskDone persists only [\"publish\"]).",
    nextStage: "Add departing stage exactly once.",
    markTaskDone: "Add current stage exactly once.",
    reopen: "Retain only stages strictly before selected stage.",
  },
  implReviewFiles: {
    migration:
      "Validate bounded task-local review references; map absence only where its historical family permits.",
    nextStage: "Preserve.",
    markTaskDone: "Preserve.",
    reopen:
      "Preserve only when its owner stage (impl) is strictly before selected stage; otherwise [].",
  },
  pendingImplReviewFiles: {
    migration: "Validate bounded task-local paths (same bounds as implReviewFiles); absent on new tasks.",
    nextStage: "Preserve — quarantined edits from an incomplete round must survive until a successful round promotes them.",
    markTaskDone: "Preserve.",
    reopen:
      "Preserve only when its owner stage (impl) is strictly before selected stage; otherwise clear — a reopened earlier stage restarts the cycle the quarantine belonged to.",
  },
  reviewInvalidatedByRound: {
    migration: "Validate exact { stage, at } shape; absent on new tasks.",
    nextStage:
      "Preserve — a stage change is not replacement review-tracking state; the marker clears only after a stale stamp or a fresh review round persists.",
    markTaskDone: "Clear — terminal completion is an explicit human acceptance of the current state.",
    reopen: "Clear — reopening restarts review tracking for the selected stage.",
  },
  incompleteRoundContinuations: {
    migration: "Validate non-negative integer/current optionality; absent on new tasks.",
    nextStage: "Clear — the continuation streak belongs to the stage being left.",
    markTaskDone: "Clear.",
    reopen: "Clear — reopening starts the streak over.",
  },
  implRecovery: {
    migration:
      "Validate exact record shape (source attempt, reason, trigger, mode, dispatch state, optional lease/attempt/sourceDispatchMode/sourceReviewStage fields); absent on new tasks.",
    nextStage:
      "Clear — the owed recovery continuation belongs to the implementation loop of the stage being left (parity with incompleteRoundContinuations).",
    markTaskDone: "Clear.",
    reopen: "Clear — reopening restarts the cycle the recovery belonged to.",
  },
  quotaParkRecord: {
    migration:
      "Validate exact record shape (modelId, providerId, optional accountKey, failureKind restricted to quota/model-entitlement, optional resetAt, observedAt); absent on new tasks.",
    nextStage:
      "Clear — the park record belongs to the specific stage attempt that hit the failure, not to future stages (parity with implRecovery).",
    markTaskDone: "Clear.",
    reopen: "Clear — reopening restarts the cycle the park record belonged to.",
  },
  pausedReason: {
    migration: "Validate bounded non-empty string/current optionality; absent on new tasks.",
    nextStage: "Clear — a stage transition requires an active task, and the reason only describes a paused state.",
    markTaskDone: "Clear.",
    reopen: "Clear — reopening reactivates the task; the workflow-imposed pause it described is over.",
  },
  lintPayload: {
    migration: "Validate/preserve without granting runtime ownership.",
    nextStage: "Consume before transition, then clear.",
    markTaskDone: "Clear.",
    reopen: "Clear.",
  },
  scheduledRun: {
    migration: "Validate with companion fields; inconsistent combinations recover.",
    nextStage: "Clear.",
    markTaskDone: "Clear.",
    reopen: "Clear.",
  },
  scheduledResumeTime: {
    migration: "Validate with scheduledRun; no coercion.",
    nextStage: "Clear.",
    markTaskDone: "Clear.",
    reopen: "Clear.",
  },
  fallbackActive: {
    migration:
      "Decode only the existing per-stage map; reject scalar booleans; new tasks use the current map factory/default.",
    nextStage:
      "Set the departing-stage entry to false where an entry exists; retain other valid stage entries; never materialize entries (or a map) for stages no reservation created. (Plan-authored: the permissive updateTaskProgressStage instead deletes the DESTINATION stage's entry — the Lifecycle cohort cutover to this row is a deliberate semantic change, not drift.)",
    markTaskDone:
      "Set the current-stage entry to false where an entry exists; never materialize entries (or a map) for stages no reservation created.",
    reopen:
      "Set selected and later-stage entries to false where an entry exists; retain earlier entries; never materialize entries for absent stages.",
  },
  fallbackModelId: {
    migration:
      "Validate per-stage map of bounded non-empty model-id strings with canonical stage keys only.",
    nextStage:
      "Clear the departing-stage entry; retain other entries (companion to fallbackActive; same deliberate departing-vs-destination change from updateTaskProgressStage as fallbackActive's row).",
    markTaskDone: "Clear the current-stage entry.",
    reopen: "Clear selected and later-stage entries; retain earlier entries.",
  },
  reviewAttemptId: {
    migration: "Validate/preserve only as inert historical state.",
    nextStage: "Clear before follow-up scheduling.",
    markTaskDone: "Clear.",
    reopen: "Clear.",
  },
  reviewScoreHistory: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable cross-invocation review trail).",
    markTaskDone: "Preserve (durable cross-invocation review trail).",
    reopen: "Preserve (durable cross-invocation review trail).",
  },
  reviewRejections: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable degenerate-round rejection trail).",
    markTaskDone: "Preserve (durable degenerate-round rejection trail).",
    reopen: "Preserve (durable degenerate-round rejection trail).",
  },
  roundOutcomes: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable round-outcome classification trail).",
    markTaskDone: "Preserve (durable round-outcome classification trail).",
    reopen: "Preserve (durable round-outcome classification trail).",
  },
  roundLedger: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable round-lifecycle trail — the sole record of every round's start/end, spanning stage transitions by design).",
    markTaskDone: "Preserve (durable round-lifecycle trail).",
    reopen: "Preserve (durable round-lifecycle trail — a reopen does not erase the history of rounds that already ran).",
  },
  blockerSupersessions: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable chat-resolved-blocker trail — parity with reviewRejections; each entry is stage-scoped, so a later stage's blocker list can never accidentally match one).",
    markTaskDone: "Preserve (durable chat-resolved-blocker trail — parity with reviewRejections).",
    reopen: "Preserve (durable chat-resolved-blocker trail — parity with reviewRejections).",
  },
  escalation: {
    migration: "Validate exact shape; preserve.",
    nextStage:
      "Clear (a stage transition resolves the departing stage's stuck iteration — parity with updateTaskProgressStage, which drops escalation on every advance).",
    markTaskDone: "Clear.",
    reopen: "Clear (explicit user resume decision — parity with reopenTask's clearEscalation).",
  },
  overriddenEscalations: {
    migration: "Validate bounded exact-shape entry array; preserve.",
    nextStage: "Preserve (durable Fast Forward override trail — parity with reviewRejections).",
    markTaskDone: "Preserve (durable Fast Forward override trail — parity with reviewRejections).",
    reopen: "Preserve (durable Fast Forward override trail — parity with reviewRejections).",
  },
  archivedFrom: {
    migration: "Validate exact TaskStatus; preserve as archival history.",
    nextStage: "Preserve (archival history).",
    markTaskDone: "Preserve (archival history).",
    reopen: "Preserve (archival history).",
  },
  pinnedAt: {
    migration: "Validate ISO timestamp; preserve.",
    nextStage: "Preserve (pinning is orthogonal to lifecycle).",
    markTaskDone: "Preserve (pinning is orthogonal to lifecycle).",
    reopen: "Preserve (pinning is orthogonal to lifecycle).",
  },
  publishScopePath: {
    migration: "Validate bounded string; preserve.",
    nextStage: "Preserve (publish verification scope).",
    markTaskDone: "Preserve (publish verification scope).",
    reopen: "Preserve (publish verification scope).",
  },
  implementationTypeCheckFailure: {
    migration: "Validate exact shape; preserve.",
    nextStage:
      "Clear (per-round build-health state tied to the departing stage's implementation; a stage transition implies the build issue was resolved or accepted, parity with lintPayload/escalation).",
    markTaskDone: "Clear.",
    reopen: "Clear (explicit user resume decision — parity with escalation/lintPayload).",
  },
};

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isCoordinatorTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function failure(
  code: Extract<TaskProgressPolicyResultV1, { ok: false }>["code"],
  reason: string
): TaskProgressPolicyResultV1 {
  return { ok: false, code, reason };
}

function stageIndex(stage: TaskStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * Add one stage to `completedStages` and canonicalize to the contiguous
 * stage-order prefix through the highest stage present. `undefined` existing
 * state is the normal mid-flight shape — no production writer records a tick
 * before the terminal action (markTaskDone.ts persists only ["publish"]) —
 * so earlier stages are backfilled rather than treated as an error.
 */
function addCompletedStage(
  existing: readonly TaskStage[] | undefined,
  stage: TaskStage
): TaskStage[] {
  const highestIndex = Math.max(
    stageIndex(stage),
    ...(existing ?? []).map((s) => stageIndex(s))
  );
  return [...STAGE_ORDER.slice(0, highestIndex + 1)];
}

/**
 * Set one stage's fallbackActive entry to false where an entry exists. Never
 * materializes an entry (or a map) for a stage no reservation ever created —
 * all three transition columns share this rule (parity with production's
 * clearStageFallbackReservation, which likewise touches only existing
 * entries), so a task that never had a fallback map never acquires one.
 */
function deactivateFallbackEntry(
  map: Partial<Record<TaskStage, boolean>> | undefined,
  stage: TaskStage
): Partial<Record<TaskStage, boolean>> | undefined {
  if (map === undefined || map[stage] === undefined) {
    return map;
  }
  return { ...map, [stage]: false };
}

/** Clear one stage's entry from a per-stage string map, dropping an emptied map. */
function clearMapEntry(
  map: Partial<Record<TaskStage, string>> | undefined,
  stage: TaskStage
): Partial<Record<TaskStage, string>> | undefined {
  if (map === undefined || map[stage] === undefined) {
    return map;
  }
  const next = { ...map };
  delete next[stage];
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * `nextStage.v1` column: advance an active task to the immediate next stage,
 * consuming per-run state (lint payload, schedule, review attempt,
 * escalation) and marking the departing stage complete.
 */
export function applyNextStagePolicyV1(
  progress: PersistedTaskProgressV1,
  input: NextStagePolicyInputV1
): TaskProgressPolicyResultV1 {
  if (!isCoordinatorTimestamp(input.now)) {
    return failure("invalidTimestamp", "coordinator clock must be a valid ISO timestamp");
  }
  if (progress.status !== "active") {
    return failure(
      "statusNotActive",
      `nextStage requires an active task, found status ${JSON.stringify(progress.status)}`
    );
  }
  const departing = progress.currentStage;
  const departingIndex = stageIndex(departing);
  const defaultNextStage = STAGE_ORDER[departingIndex + 1];
  if (departingIndex < 0 || defaultNextStage === undefined) {
    return failure(
      "noNextStage",
      `stage ${JSON.stringify(departing)} has no immediate next stage — terminal completion is markTaskDone.v1's job`
    );
  }
  let nextStage: TaskStage = defaultNextStage;
  if (input.targetStage !== undefined) {
    const targetIndex = stageIndex(input.targetStage);
    if (targetIndex < 0 || targetIndex <= departingIndex) {
      return failure(
        "invalidTargetStage",
        `targetStage ${JSON.stringify(input.targetStage)} is not strictly forward of ${JSON.stringify(departing)}`
      );
    }
    nextStage = input.targetStage;
  }
  const result: PersistedTaskProgressV1 = {
    ensembleProgressVersion: 1,
    ownership: progress.ownership,
    taskFolder: progress.taskFolder,
    status: "active",
    currentStage: nextStage,
    createdAt: progress.createdAt,
    updatedAt: input.now,
    progressVersion: progress.progressVersion,
    displayName: progress.displayName,
    checklistProgressUnreliable: progress.checklistProgressUnreliable,
    checklistProgressUnreliableReason: progress.checklistProgressUnreliableReason,
    zeroChangeImplRounds: undefined,
    nameIsDefault: progress.nameIsDefault,
    preImageDescription: progress.preImageDescription,
    completedAt: undefined,
    completedStages: addCompletedStage(progress.completedStages, departing),
    implReviewFiles: progress.implReviewFiles,
    pendingImplReviewFiles: progress.pendingImplReviewFiles,
    reviewInvalidatedByRound: progress.reviewInvalidatedByRound,
    incompleteRoundContinuations: undefined,
    implRecovery: undefined,
    quotaParkRecord: undefined,
    pausedReason: undefined,
    lintPayload: undefined,
    scheduledRun: undefined,
    scheduledResumeTime: undefined,
    fallbackActive: deactivateFallbackEntry(progress.fallbackActive, departing),
    fallbackModelId: clearMapEntry(progress.fallbackModelId, departing),
    reviewAttemptId: undefined,
    reviewScoreHistory: progress.reviewScoreHistory,
    reviewRejections: progress.reviewRejections,
    roundOutcomes: progress.roundOutcomes,
    roundLedger: progress.roundLedger,
    blockerSupersessions: progress.blockerSupersessions,
    overriddenEscalations: progress.overriddenEscalations,
    escalation: undefined,
    archivedFrom: progress.archivedFrom,
    pinnedAt: progress.pinnedAt,
    publishScopePath: progress.publishScopePath,
  };
  return { ok: true, progress: result };
}

/**
 * `markTaskDone.v1` column: terminally complete an active task, retaining
 * its current stage and stamping completion once from the coordinator clock.
 */
export function applyMarkTaskDonePolicyV1(
  progress: PersistedTaskProgressV1,
  input: MarkTaskDonePolicyInputV1
): TaskProgressPolicyResultV1 {
  if (!isCoordinatorTimestamp(input.now)) {
    return failure("invalidTimestamp", "coordinator clock must be a valid ISO timestamp");
  }
  if (progress.status !== "active") {
    return failure(
      "statusNotActive",
      `markTaskDone requires an active task, found status ${JSON.stringify(progress.status)}`
    );
  }
  const result: PersistedTaskProgressV1 = {
    ensembleProgressVersion: 1,
    ownership: progress.ownership,
    taskFolder: progress.taskFolder,
    status: "completed",
    currentStage: progress.currentStage,
    createdAt: progress.createdAt,
    updatedAt: input.now,
    progressVersion: progress.progressVersion,
    displayName: progress.displayName,
    checklistProgressUnreliable: progress.checklistProgressUnreliable,
    checklistProgressUnreliableReason: progress.checklistProgressUnreliableReason,
    zeroChangeImplRounds: undefined,
    nameIsDefault: progress.nameIsDefault,
    preImageDescription: progress.preImageDescription,
    completedAt: input.now,
    completedStages: addCompletedStage(progress.completedStages, progress.currentStage),
    implReviewFiles: progress.implReviewFiles,
    pendingImplReviewFiles: progress.pendingImplReviewFiles,
    reviewInvalidatedByRound: undefined,
    incompleteRoundContinuations: undefined,
    implRecovery: undefined,
    quotaParkRecord: undefined,
    pausedReason: undefined,
    lintPayload: undefined,
    scheduledRun: undefined,
    scheduledResumeTime: undefined,
    fallbackActive: deactivateFallbackEntry(progress.fallbackActive, progress.currentStage),
    fallbackModelId: clearMapEntry(progress.fallbackModelId, progress.currentStage),
    reviewAttemptId: undefined,
    reviewScoreHistory: progress.reviewScoreHistory,
    reviewRejections: progress.reviewRejections,
    roundOutcomes: progress.roundOutcomes,
    roundLedger: progress.roundLedger,
    blockerSupersessions: progress.blockerSupersessions,
    overriddenEscalations: progress.overriddenEscalations,
    escalation: undefined,
    archivedFrom: progress.archivedFrom,
    pinnedAt: progress.pinnedAt,
    publishScopePath: progress.publishScopePath,
  };
  return { ok: true, progress: result };
}

/**
 * Reopen column: reactivate a completed task at the selected stage, clearing
 * later completion ticks and later-stage runtime state while preserving the
 * binding, creation metadata, and display metadata exactly.
 */
export function applyReopenPolicyV1(
  progress: PersistedTaskProgressV1,
  input: ReopenPolicyInputV1
): TaskProgressPolicyResultV1 {
  if (!isCoordinatorTimestamp(input.now)) {
    return failure("invalidTimestamp", "coordinator clock must be a valid ISO timestamp");
  }
  if (progress.status !== "completed") {
    return failure(
      "statusNotCompleted",
      `reopen requires a completed task, found status ${JSON.stringify(progress.status)}`
    );
  }
  const selectedIndex = stageIndex(input.selectedStage);
  if (selectedIndex < 0) {
    return failure(
      "invalidSelectedStage",
      `selected stage ${JSON.stringify(input.selectedStage)} is not a canonical stage`
    );
  }

  const retainedStages = (progress.completedStages ?? []).filter(
    (stage) => stageIndex(stage) < selectedIndex
  );

  const implOwnerIndex = stageIndex("impl");
  const implReviewFiles =
    implOwnerIndex < selectedIndex ? progress.implReviewFiles : [];
  const pendingImplReviewFiles =
    implOwnerIndex < selectedIndex ? progress.pendingImplReviewFiles : undefined;

  // Set selected/later-stage entries to false only where an entry exists —
  // materializing false for every absent stage would grow the persisted map
  // with entries no reservation ever created (production's
  // clearStageFallbackReservation likewise touches only existing entries).
  let fallbackActive: Partial<Record<TaskStage, boolean>> | undefined;
  if (progress.fallbackActive !== undefined) {
    fallbackActive = {};
    for (const [stage, active] of Object.entries(progress.fallbackActive)) {
      fallbackActive[stage as TaskStage] =
        stageIndex(stage as TaskStage) < selectedIndex ? active : false;
    }
  }

  let fallbackModelId = progress.fallbackModelId;
  for (const stage of STAGE_ORDER) {
    if (stageIndex(stage) >= selectedIndex) {
      fallbackModelId = clearMapEntry(fallbackModelId, stage);
    }
  }

  const result: PersistedTaskProgressV1 = {
    ensembleProgressVersion: 1,
    ownership: progress.ownership,
    taskFolder: progress.taskFolder,
    status: "active",
    currentStage: input.selectedStage,
    createdAt: progress.createdAt,
    updatedAt: input.now,
    progressVersion: progress.progressVersion,
    displayName: progress.displayName,
    checklistProgressUnreliable: progress.checklistProgressUnreliable,
    checklistProgressUnreliableReason: progress.checklistProgressUnreliableReason,
    zeroChangeImplRounds: undefined,
    nameIsDefault: progress.nameIsDefault,
    preImageDescription: progress.preImageDescription,
    completedAt: undefined,
    completedStages: retainedStages,
    implReviewFiles,
    pendingImplReviewFiles,
    reviewInvalidatedByRound: undefined,
    incompleteRoundContinuations: undefined,
    implRecovery: undefined,
    quotaParkRecord: undefined,
    pausedReason: undefined,
    lintPayload: undefined,
    scheduledRun: undefined,
    scheduledResumeTime: undefined,
    fallbackActive,
    fallbackModelId,
    reviewAttemptId: undefined,
    reviewScoreHistory: progress.reviewScoreHistory,
    reviewRejections: progress.reviewRejections,
    roundOutcomes: progress.roundOutcomes,
    roundLedger: progress.roundLedger,
    blockerSupersessions: progress.blockerSupersessions,
    overriddenEscalations: progress.overriddenEscalations,
    escalation: undefined,
    archivedFrom: progress.archivedFrom,
    pinnedAt: progress.pinnedAt,
    publishScopePath: progress.publishScopePath,
  };
  return { ok: true, progress: result };
}
