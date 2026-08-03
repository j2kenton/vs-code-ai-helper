/**
 * `commitPush.v1` registry row (plan §3.8, executable step 17, §10.1/§10.2).
 *
 * A non-provider (lifecycle) row like `nextStage.v1`/`markTaskDone.v1`, but
 * one whose actual work — index/privacy checks, lint, prompts, staging,
 * commit, push, and presentation — is a long-running, interactively-
 * confirmed Git workflow that cannot be expressed as `rawInput`/a strict
 * progress-field patch.
 *
 * `executeCommitPushV1` below owns the flow's sequencing end to end,
 * including the tracked-operation lock lifecycle itself (open/close), by
 * calling every coordinator-native step directly, in order — there is no
 * remaining opaque delegated "core" call:
 *
 *  1. the §2.4/§10.2-step-1 index/privacy check
 *     (`checkCommitPushIndexPrivacyV1`) — lock-free, before anything opens;
 *  2. the read-only git readiness check (`checkGitPublishReadiness` —
 *     repo/branch/push-destination; never stages, commits, or pushes) —
 *     also lock-free, before anything opens;
 *  3. opens the "Commit and Push" tracked operation (`taskOperations.begin`);
 *  4. the stage-eligibility recheck (defense-in-depth against a stage that
 *     changed between the row's own `eligibility` admission and this point);
 *  5. the failing-checks decision loop — Publish Anyway / Fix with AI /
 *     Cancel (plan C3) — via `runCommitPushCompletionChecksV1`, run under the
 *     SAME operation handle opened in step 3;
 *  6. the staging-scope decision (`resolveCommitPushStagingScopeV1`) — the
 *     pre-existing-staged-changes prompt and the default/"Include Task
 *     Folder"/"Include Run Artifacts" fallback prompts;
 *  7. the final preview-and-confirmation step (`confirmCommitPushScopeV1`) —
 *     the flow's critical, largely-irreversible-once-accepted safety gate;
 *  8. saving relevant dirty documents (`saveCommitPushDocumentsV1`);
 *  9. generating and writing `pr-description.md` (`generateCommitPushPrDescriptionV1`),
 *     which also reapplies the §2.4 sensitive/control-path gate to
 *     `scopedFiles` immediately before the commit-message preview;
 * 10. the commit-message review/regenerate/confirm modal
 *     (`reviewCommitPushMessageV1`) — may instead settle with structured
 *     questions routed to Chat With AI, in which case this attempt ends here;
 * 11. staging and committing (`stageAndCommitCommitPushV1`), including the
 *     §2.4 rule 7 post-add re-verification and rollback-on-failure;
 * 12. pushing (`pushCommitPushV1`), which keeps the local commit even if the
 *     push itself fails;
 * 13. ends the tracked operation (`taskOperations.end`), deriving its
 *     terminal state from the result via `deriveCommitPushOperationEndStateV1`.
 *
 * Steps 1-2 are safe to hoist as cheap, side-effect-free reads that are run
 * twice for nothing (once as an early-rejection fast path here, once as the
 * authoritative revalidation inside step 6). Steps 5-12 do NOT have that
 * property — each can run real work (a test/build suite, a git command) and
 * several drive their own interactive modal, so double-running any of them
 * would double-prompt the user or double-run expensive work; each therefore
 * runs exactly ONCE, in this exact order, directly from `executeCommitPushV1`
 * below. The primitive that makes holding the lock across all of these
 * sequenced steps possible is the explicit acquire/release API
 * `taskOperations.begin`/`taskOperations.end` (`utils/taskOperations.ts`),
 * used directly by steps 3/13 above instead of one opaque
 * `runTrackedOperation` callback span (`runTrackedOperation` is a
 * convenience wrapper over that same pair, not a different lock).
 *
 * The registry row genuinely owns eligibility, the operation lease,
 * presentation (progress label), and settlement logging for Commit/Push,
 * exactly like every other migrated action (plan §3.8's "The coordinator
 * owns ... eligibility, leases, ... presentation ... and follow-up
 * scheduling"). `requiresTaskOperationLease` below is `true`, held for this
 * row's whole execution span; a nested `commitPushMetadata.v1` invocation
 * against the SAME binding opens a CHILD lease instead of self-deadlocking
 * (see that field's comment and `workflowLeaseStoreV1.acquireChild`). This is
 * layered ON TOP OF, not instead of, the pre-existing independent
 * process-global token and the "Commit and Push" tracked-operation lock
 * `executeCommitPushV1` opens directly.
 *
 * Every step is transparent on the way OUT: `runCommitPushCompletionChecksV1`,
 * `resolveCommitPushStagingScopeV1`, `confirmCommitPushScopeV1`,
 * `saveCommitPushDocumentsV1`, `generateCommitPushPrDescriptionV1`,
 * `reviewCommitPushMessageV1`, `stageAndCommitCommitPushV1`, and
 * `pushCommitPushV1` each return a discriminated result whose `notCompleted`
 * case carries a specific `CommitAndPushNotCompletedReasonV1` (ineligible
 * stage, declined confirmation, failed git command, ...) set at every one of
 * their internal stopping points, which `executeCommitPushV1` below turns
 * into a distinct `commitPush.<reason>` outcome code instead of one
 * undifferentiated `commitPush.notCompleted` — the coordinator can tell WHY
 * an attempt didn't complete for every step in the sequence.
 *
 * The independent process-global duplicate-invocation token (plan §10.1,
 * `CommitPushEarlyGateV0` in `commitAndPushTask.ts`) is UNCHANGED and stays
 * outside the coordinator entirely — both public entry points still acquire
 * it before this row (or anything else) runs, exactly as §3.8 requires
 * ("Commit/Push retains its independent process-global token").
 *
 * `commitPushMetadata.v1` (a separate, existing PROVIDER row) remains the
 * one AI sub-step inside the Git workflow this row's `execute` runs — commit-
 * message generation, its structured questions, and its `replacementOperation`
 * Resume semantics are unchanged (§10.2 steps 3-5).
 *
 * Because the actual work needs live, non-JSON-serializable dependencies
 * (`TaskInventory`, the already-resolved `ResolvedTaskContext`, a
 * `ChatViewProvider`, a `vscode.ExtensionContext`) that `rawInput` cannot
 * represent, this row reads them from `LifecycleExecutionContextV1.services`
 * (the lifecycle-only side channel — see that field's header) rather than
 * `validatedInput`.
 */
import * as vscode from "vscode";
import {
  LifecycleExecutionContextV1,
  LifecycleTaskActionRowV1,
  TaskActionInputValidationResultV1,
} from "../taskActionRegistryV1";
import { allocateHex128IdV1 } from "../../types/actionCorrelationV1";
import { TaskActionOutcomeV1 } from "../../types/taskActionOutcomeV1";
import {
  checkCommitPushIndexPrivacyV1,
  CommitAndPushCoreResultV1,
  CommitAndPushNotCompletedReasonV1,
  CommitAndPushTaskArg,
  confirmCommitPushScopeV1,
  generateCommitPushPrDescriptionV1,
  pushCommitPushV1,
  resolveCommitPushStagingScopeV1,
  reviewCommitPushMessageV1,
  runCommitPushCompletionChecksV1,
  saveCommitPushDocumentsV1,
  stageAndCommitCommitPushV1,
} from "../../commands/commitAndPushTask";
import { TaskInventory } from "../../state/taskInventory";
import {
  TaskOperationHandle,
  TaskOperationState,
  taskOperations,
  showTaskBusyWarning,
} from "../../utils/taskOperations";
import { ChatViewProvider } from "../../views/chatView";
import { ResolvedTaskContext } from "../../utils/resolveTaskContext";
import { checkGitPublishReadiness } from "../../utils/gitRepoInfo";
import { NotificationRouter } from "../../utils/notificationRouter";
import { STAGE_DISPLAY_NAMES } from "../../types/taskProgress";

export const COMMIT_PUSH_ACTION_KEY_V1 = "commitPush.v1";

export interface CommitPushActionInputV1 {
  readonly taskFolderPath: string;
}

/**
 * The live service objects the coordinator-native steps below need, threaded
 * through `LifecycleExecutionContextV1.services` — never part of `rawInput` (plan
 * §3.1: a Chat interaction's validated-input snapshot must be canonically
 * digestible JSON, which in-process object references are not; this row has
 * no structured question of its own anyway — `commitPushMetadata.v1` owns
 * that — so nothing here is ever a Resume reconstruction input).
 *
 * `resolvedTask` is the SEALED task the coordinator already resolved and
 * bound its correlation/eligibility check to (built in
 * `invokeCommitPushRowV1`, `commitAndPushTask.ts`) — `execute` below passes
 * it straight into every coordinator-native step instead of letting any of
 * them re-resolve a target from `explicitArg`/current-task state, which
 * could otherwise pick a DIFFERENT task than the one just bound (e.g. a
 * no-argument invocation racing a concurrent current-task change) and let
 * the acted-on task diverge from its own correlation/audit identity. There
 * is deliberately no `currentTaskStore` here: this row never resolves a
 * task itself, so it has nothing to resolve one FROM.
 */
export interface CommitPushServicesV1 {
  readonly inventory: TaskInventory;
  readonly resolvedTask: ResolvedTaskContext;
  readonly explicitArg?: CommitAndPushTaskArg;
  readonly parentOperation?: TaskOperationHandle;
  readonly extensionContext?: vscode.ExtensionContext;
  readonly chatViewProvider?: ChatViewProvider;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateCommitPushInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input is missing a non-empty \"taskFolderPath\" string" };
  }
  const allowedKeys = new Set(["taskFolderPath"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: CommitPushActionInputV1 = { taskFolderPath: raw.taskFolderPath };
  return { ok: true, input: validated };
}

/**
 * Pure mapping from the composed `CommitAndPushCoreResultV1` (built by
 * `executeCommitPushV1` below from whichever coordinator-native step
 * settled the attempt) to the coordinator outcome union — split out so the
 * WHY-code translation (`CommitAndPushNotCompletedReasonV1` ->
 * `commitPush.<reason>`) is unit-testable on its own, without driving the
 * real git/UI flow.
 *
 * @internal exported for testing
 */
/**
 * Reasons that represent the user explicitly declining/deferring a prompt —
 * "nothing failed, they just said no (yet)" — as opposed to a genuine error
 * (a failed git command, an unavailable tool, a stale precondition).
 * `presentCommitPushCoreResultV1` below always presents these at
 * information level, never a warning/error, which is the same signal
 * `userCancelled` already gets the standard `cancelled` outcome for below.
 */
const COMMIT_PUSH_DECLINED_REASONS: ReadonlySet<CommitAndPushNotCompletedReasonV1> = new Set([
  "checksDeclined",
  "taskFolderChangesDeclined",
  "runArtifactsDeclined",
  "viewedFullFileList",
  "commitMessageCancelled",
]);

export function mapCommitAndPushCoreResultToOutcomeV1(
  result: CommitAndPushCoreResultV1,
  context: Pick<LifecycleExecutionContextV1, "actionKey" | "operationId" | "taskBindingId" | "chatDocumentId">
): TaskActionOutcomeV1 {
  if (result.kind === "completed" || result.kind === "noChanges") {
    return {
      kind: "completed",
      correlation: {
        actionKey: context.actionKey,
        operationId: context.operationId,
        attemptId: allocateHex128IdV1(),
        taskBindingId: context.taskBindingId,
        chatDocumentId: context.chatDocumentId,
      },
      code: result.kind,
    };
  }
  if (result.kind === "questionsPosted") {
    // The commit-message step returned structured questions instead of a
    // message to confirm — a genuine `questions` outcome (plan §3.7's closed
    // union), not a failure or a decline. Uses the REAL metadata attempt's
    // correlation/interactionId (commitPushMetadata.v1's own operationId),
    // not this commitPush.v1 attempt's context, because that is the
    // correlation the persisted Chat interaction transaction is actually
    // keyed on (§5.5) — Resume/answer lookups need to find it there.
    return {
      kind: "questions",
      correlation: result.correlation,
      interactionId: result.interactionId,
    };
  }
  if (result.reason === "userCancelled" || COMMIT_PUSH_DECLINED_REASONS.has(result.reason)) {
    // Explicit user cancellation or decline (dismissing the pre-staged-
    // changes prompt, the failing-checks modal, the task-folder/run-artifact
    // include prompts, "View Full List", or the final "Commit & Push"
    // confirmation) is the standard coordinator `cancelled` outcome (plan
    // §3.7's closed union), not a retryable failure — nothing failed, the
    // user simply chose not to proceed (or deferred to review first), so
    // product/UI code consuming this outcome should treat it like any other
    // cancellation rather than surfacing failure messaging. `code` stays the
    // single stable `"userCancelled"` value the closed `cancelled` union
    // permits (plan §3.7) for every one of these reasons — none of them are
    // a *provider* cancellation.
    return {
      kind: "cancelled",
      correlation: {
        actionKey: context.actionKey,
        operationId: context.operationId,
        attemptId: allocateHex128IdV1(),
        taskBindingId: context.taskBindingId,
        chatDocumentId: context.chatDocumentId,
      },
      code: "userCancelled",
    };
  }
  // `result.reason` distinguishes WHY (ineligible stage, an unavailable
  // tool, a failed git command, ...) — see CommitAndPushNotCompletedReasonV1's
  // header. The user-facing explanation is shown separately, exactly once,
  // by `presentCommitPushCoreResultV1` below (plan §3.8: "the coordinator
  // owns ... presentation"); this is only the machine-readable
  // classification of that same stopping point. Every remaining reason is
  // retryable: each one is a fresh-invocation-safe stopping point, not a
  // corrupted state.
  return { kind: "failed", code: `commitPush.${result.reason}`, retryable: true };
}

/**
 * Level (error/warning/information) each `CommitAndPushNotCompletedReasonV1`
 * is presented at — a fixed, deterministic mapping (every reason always used
 * the same `NotificationRouter` method at whichever coordinator-native step
 * call site used to produce it), so `presentCommitPushCoreResultV1` below can
 * pick the right method from `reason` alone.
 */
const COMMIT_PUSH_NOT_COMPLETED_LEVEL_V1: Readonly<
  Record<CommitAndPushNotCompletedReasonV1, "error" | "warning" | "information">
> = {
  ineligibleStage: "warning",
  noGitRepository: "error",
  gitIndexReadFailed: "error",
  privateContentStaged: "error",
  gitNotReady: "error",
  checksDeclined: "information",
  fixWithAiUnavailable: "warning",
  taskFolderChangesDeclined: "information",
  runArtifactsDeclined: "information",
  viewedFullFileList: "information",
  userCancelled: "information",
  saveFailed: "error",
  commitMessageCancelled: "information",
  gitCommitFailed: "error",
  pushFailed: "error",
  unexpectedError: "error",
};

/**
 * Default text for a `notCompleted` reason with no dynamic content of its
 * own. Every reason with real dynamic content (a caught error's message, a
 * git-readiness reason, a push destination, ...) always supplies
 * `result.detail` instead (populated by the coordinator-native step that
 * produced it — see `CommitAndPushCoreResultV1`'s header); this table
 * supplies the fixed text for reasons that never carry one, and is a
 * defensive backstop if `detail` is ever missing.
 */
const COMMIT_PUSH_NOT_COMPLETED_DEFAULT_TEXT_V1: Readonly<Record<CommitAndPushNotCompletedReasonV1, string>> = {
  ineligibleStage: "Task is not at a stage where Commit and Push is available.",
  noGitRepository:
    "Commit and push failed: Could not find git repository. Make sure the task is inside a git repository.",
  gitIndexReadFailed: "Commit and push failed: could not read the git index.",
  privateContentStaged:
    "Commit and push blocked: private/workflow-control file(s) are already staged in the git index. " +
    "See 'Ensemble: Commit Preview' for the list — unstage them and retry.",
  gitNotReady: "Commit and push failed: the repository is not ready to push.",
  checksDeclined: "Commit and push cancelled.",
  fixWithAiUnavailable:
    'Fix with AI is unavailable here — run "Linting Fixes" from the task\'s Publish actions, then retry Commit and Push.',
  taskFolderChangesDeclined: "Commit and push cancelled.",
  runArtifactsDeclined: "Commit and push cancelled.",
  viewedFullFileList: "Full file list shown in 'Ensemble: Commit Preview'. Re-run the command to proceed.",
  userCancelled: "Commit and push cancelled.",
  saveFailed: "Could not save one or more files. Please save all files before committing.",
  commitMessageCancelled: "Commit and push cancelled.",
  gitCommitFailed: "Commit failed.",
  pushFailed: "Push failed. Your local commit was kept — it has NOT been rolled back automatically.",
  unexpectedError: "Commit and push failed.",
};

/**
 * Coordinator-owned terminal presentation for `commitPush.v1` (plan §3.8:
 * "the coordinator owns ... presentation"). None of the coordinator-native
 * steps `executeCommitPushV1` calls below (`checkCommitPushIndexPrivacyV1`
 * through `pushCommitPushV1`) show their own notification — each reports its
 * stopping point through a plain `CommitAndPushCoreResultV1`-shaped result
 * instead. `executeCommitPushV1` calls this function exactly once, after the
 * terminal result is known, so the notification the user sees is a pure
 * function of that one result rather than a side effect scattered across
 * nine different call sites.
 *
 * @internal exported for testing
 */
export function presentCommitPushCoreResultV1(result: CommitAndPushCoreResultV1): void {
  if (result.kind === "completed") {
    NotificationRouter.showInformation(result.detail ?? "Committed and pushed successfully.");
    return;
  }
  if (result.kind === "noChanges") {
    NotificationRouter.showInformation("No changes to commit — the repository is clean.");
    return;
  }
  if (result.kind === "questionsPosted") {
    // Already reached Chat With AI: buildCommitMessage/resumeCommitMessage
    // (commitAndPushTask.ts) show their own "answer in Chat With AI, then
    // start Commit and Push again" notice at the exact point the question
    // was generated — a distinct, already-approved presentation concern
    // (plan §6.1's universal question flow), not this function's job.
    return;
  }
  const text = result.detail ?? COMMIT_PUSH_NOT_COMPLETED_DEFAULT_TEXT_V1[result.reason];
  switch (COMMIT_PUSH_NOT_COMPLETED_LEVEL_V1[result.reason]) {
    case "error":
      NotificationRouter.showError(text);
      return;
    case "warning":
      NotificationRouter.showWarning(text);
      return;
    case "information":
      NotificationRouter.showInformation(text);
      return;
  }
}

/**
 * Present the terminal result exactly once, then map it to the stable
 * coordinator outcome — the single choke point every return in
 * `executeCommitPushV1` below routes through, so presentation can never be
 * skipped for a result the function actually produces.
 */
function finishCommitPushV1(
  result: CommitAndPushCoreResultV1,
  context: Pick<LifecycleExecutionContextV1, "actionKey" | "operationId" | "taskBindingId" | "chatDocumentId">
): TaskActionOutcomeV1 {
  presentCommitPushCoreResultV1(result);
  return mapCommitAndPushCoreResultToOutcomeV1(result, context);
}

/**
 * Derive the "Commit and Push" tracked operation's terminal Notifications-row
 * state from the coordinator-visible result — the job `runTrackedOperation`'s
 * own `end()` used to do implicitly when `commitAndPushTaskCore` opened this
 * operation internally (derive `cancelled` from token cancellation, else
 * default to `succeeded`). Now that `executeCommitPushV1` below owns opening
 * AND ending this operation itself, it owns deriving this too. Real
 * token-based cancellation still wins outright; every declined-prompt reason
 * (the same set `mapCommitAndPushCoreResultToOutcomeV1` above already maps to
 * the standard `cancelled` coordinator outcome) now also ends the tracked
 * operation as `cancelled` rather than `succeeded` — every other
 * `notCompleted` reason is a genuine failure.
 *
 * @internal exported for testing
 */
export function deriveCommitPushOperationEndStateV1(
  op: TaskOperationHandle,
  result: CommitAndPushCoreResultV1
): Exclude<TaskOperationState, "running" | "interrupted"> {
  if (op.token?.isCancellationRequested) {
    return "cancelled";
  }
  if (result.kind === "completed" || result.kind === "noChanges" || result.kind === "questionsPosted") {
    return "succeeded";
  }
  if (result.reason === "userCancelled" || COMMIT_PUSH_DECLINED_REASONS.has(result.reason)) {
    return "cancelled";
  }
  return "failed";
}

/** @internal exported for testing */
export async function executeCommitPushV1(
  context: LifecycleExecutionContextV1
): Promise<TaskActionOutcomeV1> {
  const services = context.services as CommitPushServicesV1 | undefined;
  if (!services) {
    // Unreachable in production (productionTaskActionRuntimeV1's helper
    // always supplies it) — a fail-closed guard against a future caller that
    // forgets the side channel, rather than a silent no-op run.
    return { kind: "failed", code: "commitPush.servicesUnavailable", retryable: false };
  }

  // §10.2 step 1 / §3.8: run the index/privacy check as its own
  // coordinator-native step, BEFORE ever opening the tracked operation or
  // calling into any of the remaining coordinator-native steps below —
  // genuine coordinator ownership of sequencing for the flow's first real
  // step, not just admission/leasing/outcome mapping. A privacy-blocked
  // attempt now short-circuits here, without ever spinning up the
  // tracked-operation UI row at all. resolveCommitPushStagingScopeV1
  // (checkCommitPushIndexPrivacyV1's own header) runs this exact check again
  // immediately before it actually needs the result — that copy is the
  // authoritative revalidation; this one is the coordinator's real, distinct
  // first step.
  const indexCheck = await checkCommitPushIndexPrivacyV1(services.resolvedTask);
  if (!indexCheck.ok) {
    return finishCommitPushV1(
      { kind: "notCompleted", reason: indexCheck.reason, detail: indexCheck.detail },
      context
    );
  }

  // §10.2 step 2 / §3.8: the read-only git readiness check (repo, branch,
  // push destination — never stages, commits, or pushes) as the second
  // coordinator-native step, still before the tracked operation opens. A
  // not-ready repo now short-circuits here too, exactly like the index
  // check above; confirmCommitPushScopeV1 re-runs the exact same
  // checkGitPublishReadiness call immediately before it actually needs the
  // result (§7.7) — that copy remains the authoritative revalidation, this
  // one is real, distinct sequencing. Unlike checkCommitPushIndexPrivacyV1,
  // checkGitPublishReadiness is a pure read-only helper shared with
  // publishPreflight.ts and carries no notification of its own — this
  // short-circuit builds the exact same message text as a `detail` for
  // `presentCommitPushCoreResultV1` to show, rather than leaving the user
  // with no explanation at all.
  const gitReadinessCheck = await checkGitPublishReadiness(services.resolvedTask.taskFolderPath);
  if (!gitReadinessCheck.ok) {
    return finishCommitPushV1(
      {
        kind: "notCompleted",
        reason: "gitNotReady",
        detail: `Commit and push failed: ${gitReadinessCheck.reason}`,
      },
      context
    );
  }

  // §10.2 step 3 / §3.8: open the "Commit and Push" tracked operation as a
  // genuine coordinator-owned step. The stage-eligibility recheck, the
  // completion-checks decision loop (runCommitPushCompletionChecksV1), and
  // every remaining coordinator-native step (staging-scope resolution
  // through push) all run under this ONE handle, and this function alone
  // owns ending it (contract C1) — mirroring exactly what
  // `runTrackedOperation` used to do around the whole flow, just with the
  // coordinator holding the span directly instead of one delegated callback.
  const lockKey = services.resolvedTask.taskFolderPath;
  const op = taskOperations.begin(lockKey, {
    label: "Commit and Push",
    taskName: services.resolvedTask.folderName,
    kind: "commit-push",
    parent: services.parentOperation,
    // The V1 action coordinator requires a real CancellationToken for every
    // provider action (TaskActionRequestV1.cancellationToken is not
    // optional) — commit-message generation (inside reviewCommitPushMessageV1)
    // passes op.token into it. Without cancellable:true here, op.token would
    // stay undefined and the coordinator's admission phase would throw on
    // `cancellationToken.isCancellationRequested` before ever reaching a
    // provider.
    cancellable: true,
  });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return mapCommitAndPushCoreResultToOutcomeV1(
      { kind: "notCompleted", reason: "unexpectedError" },
      context
    );
  }

  let result: CommitAndPushCoreResultV1 = { kind: "notCompleted", reason: "unexpectedError" };
  try {
    // Allow committing from completed stage only. The row's `eligibility`
    // below already gates this before `execute` ever runs; this recheck is
    // defense-in-depth against a stage that changed between admission and
    // this point.
    if (services.resolvedTask.progress.currentStage !== "publish") {
      result = {
        kind: "notCompleted",
        reason: "ineligibleStage",
        detail: `Task is at stage "${STAGE_DISPLAY_NAMES[services.resolvedTask.progress.currentStage]}" — must be completed before committing and pushing.`,
      };
    } else {
      const checksResult = await runCommitPushCompletionChecksV1(
        services.inventory,
        services.resolvedTask,
        services.extensionContext,
        op,
        lockKey
      );
      if (!checksResult.ok) {
        result = { kind: "notCompleted", reason: checksResult.reason };
      } else {
        // §10.2's "staging-scope decisions" step, run directly by this
        // coordinator, before any of the remaining steps below.
        const scopeResult = await resolveCommitPushStagingScopeV1(services.resolvedTask);
        if (scopeResult.kind === "noChanges") {
          result = { kind: "noChanges" };
        } else if (scopeResult.kind === "notCompleted") {
          result = { kind: "notCompleted", reason: scopeResult.reason, detail: scopeResult.detail };
        } else {
          const repoRoot = scopeResult.repoRoot;
          // §10.2's "final preview and confirmation" step — the critical,
          // irreversible-once-accepted safety gate — likewise run directly
          // by this coordinator, immediately after staging-scope resolution
          // and before the remaining save/PR-description/commit-message/
          // staging/commit/push steps.
          const confirmResult = await confirmCommitPushScopeV1(
            services.resolvedTask,
            repoRoot,
            scopeResult.scope
          );
          if (confirmResult.kind === "notCompleted") {
            result = { kind: "notCompleted", reason: confirmResult.reason, detail: confirmResult.detail };
          } else {
            // The remaining save/PR-description/commit-message/staging/
            // commit/push work, each its own coordinator-native step, called
            // directly in sequence rather than living opaquely inside one
            // delegated call (plan §3.8's full "sequencing ... and
            // presentation" ownership).
            const saveResult = await saveCommitPushDocumentsV1(
              services.resolvedTask,
              repoRoot,
              confirmResult.scope.includeTaskFolder
            );
            if (saveResult.kind === "notCompleted") {
              result = { kind: "notCompleted", reason: saveResult.reason, detail: saveResult.detail };
            } else {
              const prResult = await generateCommitPushPrDescriptionV1(
                services.resolvedTask,
                repoRoot,
                confirmResult.scope.scopedFiles
              );
              if (prResult.kind === "notCompleted") {
                result = { kind: "notCompleted", reason: prResult.reason, detail: prResult.detail };
              } else {
                const messageResult = await reviewCommitPushMessageV1(
                  op,
                  services.resolvedTask,
                  repoRoot,
                  prResult.scopedFiles,
                  confirmResult.scope.runArtifactPaths,
                  confirmResult.gitReadiness.pushDestination,
                  services.explicitArg,
                  services.chatViewProvider,
                  // This row's own coordinator-held lease (requiresTaskOperationLease
                  // below is true): threaded through so the nested
                  // commitPushMetadata.v1 invocation inside
                  // reviewCommitPushMessageV1's reviewCommitMessage step opens a
                  // CHILD lease on the same binding instead of self-deadlocking
                  // against this lease as a false-positive duplicate
                  // (workflowLeaseStoreV1's acquireChild).
                  context.operationId
                );
                if (messageResult.kind === "questionsPosted") {
                  result = {
                    kind: "questionsPosted",
                    interactionId: messageResult.interactionId,
                    correlation: messageResult.correlation,
                  };
                } else if (messageResult.kind === "notCompleted") {
                  result = { kind: "notCompleted", reason: messageResult.reason, detail: messageResult.detail };
                } else {
                  const commitResult = await stageAndCommitCommitPushV1(
                    services.resolvedTask,
                    repoRoot,
                    prResult.scopedFiles,
                    messageResult.message
                  );
                  if (commitResult.kind === "notCompleted") {
                    result = { kind: "notCompleted", reason: commitResult.reason, detail: commitResult.detail };
                  } else {
                    const pushResult = await pushCommitPushV1(
                      services.resolvedTask,
                      repoRoot,
                      confirmResult.gitReadiness
                    );
                    result =
                      pushResult.kind === "completed"
                        ? { kind: "completed", detail: pushResult.detail }
                        : { kind: "notCompleted", reason: pushResult.reason, detail: pushResult.detail };
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    // A genuine mid-flight cancellation rethrown by reviewCommitPushMessageV1
    // (its token fired while awaiting a provider call) — mirrors the old
    // runTrackedOperation-wrapped behavior of ending the operation as
    // cancelled and falling back to the same default result. Any other
    // exception is a real bug: end the operation as failed and propagate —
    // it must never leak with the operation left registered as "running".
    if (!(error instanceof vscode.CancellationError)) {
      taskOperations.end(op, "failed");
      throw error;
    }
    // A genuine cancellation, not a decline or a failure — previously showed
    // no notification of its own (the operation's Notifications row already
    // reflects "cancelled" via `deriveCommitPushOperationEndStateV1` below);
    // `"userCancelled"` keeps `presentCommitPushCoreResultV1` from now
    // showing a misleading generic failure message for it.
    result = { kind: "notCompleted", reason: "userCancelled" };
  }

  taskOperations.end(op, deriveCommitPushOperationEndStateV1(op, result));
  return finishCommitPushV1(result, context);
}

export function createCommitPushRowV1(): LifecycleTaskActionRowV1 {
  return {
    kind: "lifecycle",
    actionKey: COMMIT_PUSH_ACTION_KEY_V1,
    routes: [
      "vs-code-ai-helper.commitAndPushTask",
      "vs-code-ai-helper.completeCommitAndPushTask",
    ],
    // Real, coordinator-owned stage eligibility (plan §3.8: "the coordinator
    // owns ... eligibility"): every call site resolves/advances the task to
    // "publish" before invoking this row (commitAndPushTask's plain entry
    // resolves with allowPaused:true and no stage filter, but the composite
    // flow always transitions through nextStage.v1 to "publish" first, and
    // the already-completed early-return path only reaches here when the
    // task IS already at "publish"). A task at any other stage is rejected
    // here, before executeCommitPushV1's tracked operation/lock ever starts;
    // invokeCommitPushRowV1 (commitAndPushTask.ts) turns the resulting
    // actionNotEligibleForStage outcome into the same stage-name warning
    // that used to be shown internally, so the user-facing message is
    // unchanged even though the coordinator now owns the check.
    eligibility: { statuses: ["active", "paused", "completed"], stages: ["publish"] },
    // The coordinator's per-task lease, now genuinely held for this row's
    // whole (long, interactive) execution span: the nested
    // reviewCommitPushMessageV1 step invokes commitPushMetadata.v1 (also
    // requiresTaskOperationLease: true) for this SAME task, which would
    // normally self-deadlock into duplicateRejected against the one-lease-
    // per-binding invariant — executeCommitPushV1 above avoids that by
    // threading this row's own `operationId` through to
    // reviewCommitPushMessageV1 as `coordinatorOperationId`, so that nested
    // call opens a CHILD lease (`workflowLeaseStoreV1.acquireChild`) instead
    // of a top-level one. A child lease is granted ONLY while the exact
    // matching parent operation currently holds the binding, so this cannot
    // be used to let an unrelated operation bypass exclusivity — see that
    // method's header for the safety argument. Commit/Push's mutual
    // exclusion is still layered with the independent process-global token
    // (plan §3.8: "Commit/Push retains its independent process-global
    // token") plus the per-task tracked-operation lock
    // `taskOperations.begin`/`taskOperations.end` open and close above
    // (guards against a DIFFERENT concurrent operation on this task); this
    // lease is now an ADDITIONAL, genuinely coordinator-owned layer, not a
    // replacement for either.
    requiresTaskOperationLease: true,
    progressLabel: "Committing and pushing…",
    validateInput: validateCommitPushInputV1,
    loggingPolicy: { channel: "action.commitPush", includeResultMetrics: false },
    execute: executeCommitPushV1,
  };
}
