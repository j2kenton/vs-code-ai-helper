/**
 * `commitPush.v1` registry row (plan §3.8, executable step 17, §10.1/§10.2).
 *
 * A non-provider (lifecycle) row like `nextStage.v1`/`markTaskDone.v1`, but
 * one whose actual work — index/privacy checks, lint, prompts, staging,
 * commit, push, and presentation — is a long-running, interactively-
 * confirmed Git workflow that cannot be expressed as `rawInput`/a strict
 * progress-field patch.
 *
 * The flow's first two real steps are now genuine coordinator-native steps,
 * run in `executeCommitPushV1` below BEFORE `commitAndPushTaskCore` is ever
 * invoked, each short-circuiting straight to a mapped outcome on failure
 * without entering the core or its tracked-operation UI row at all:
 *
 *  1. the §2.4/§10.2-step-1 index/privacy check
 *     (`checkCommitPushIndexPrivacyV1`);
 *  2. the read-only git readiness check (`checkGitPublishReadiness` —
 *     repo/branch/push-destination; never stages, commits, or pushes).
 *
 * `commitAndPushTaskCore` calls both exact same functions again, under its
 * own per-task lock, immediately before it actually needs each result (§7.7
 * "revalidate immediately before mutation") — those copies are the
 * authoritative rechecks; the coordinator's are real, distinct sequencing
 * ownership of steps 1-2. The remaining steps — lint/completion-checks,
 * staging-scope resolution, the commit-message step, staging, commit, and
 * push — stay delegated to the core (see the file-level note on the
 * `execute` field below for why).
 *
 * Every step AFTER that — lint/completion-checks (with its own
 * Publish-Anyway/Fix-with-AI modal), staging-scope resolution (with its own
 * Include-Task-Folder/Include-Run-Artifacts modals), the commit-message
 * step, and the actual commit/push — is not yet split out: `execute`
 * delegates the rest to `commitAndPushTaskCore` (`commitAndPushTask.ts`) in
 * one call, whose internals for THOSE steps are UNCHANGED by this row. Each
 * of those steps is a modal decision point whose outcome feeds the next
 * (e.g. a lint-fix rerun changes what staging even sees), all sharing one
 * `runTrackedOperation` lock/UI-row and one cancellation token — splitting
 * them into independent coordinator-native steps is a materially larger,
 * riskier rewrite of a long, interactively-confirmed flow than the
 * self-contained, read-only index/privacy and git-readiness checks were, and
 * remains a real, tracked gap against plan §3.8's full "sequencing ... and
 * presentation" ownership, deliberately left for a future round.
 *
 * Concretely, what blocks it (re-confirmed by direct inspection, not just
 * repeated across review rounds): `checkCommitPushIndexPrivacyV1` and
 * `checkGitPublishReadiness` are safe to hoist into coordinator-native
 * pre-steps specifically because they are cheap, side-effect-free reads —
 * running them once, lock-free, in `executeCommitPushV1`, and running them
 * again inside `commitAndPushTaskCore`'s lock as the authoritative
 * revalidation, costs nothing and shows nothing to the user twice. None of
 * the remaining steps have that property: lint/completion-checks can run a
 * real test/build suite (expensive to duplicate) AND drives an interactive
 * Publish-Anyway/Fix-with-AI modal; staging-scope resolution drives its own
 * Include-Task-Folder/Include-Run-Artifacts modals; hoisting either as a
 * "run once outside the lock, re-run once inside" pre-step would either
 * double-prompt the user or double-run expensive work. The only way to move
 * a step like that into the coordinator without duplicating it is to stop
 * running the whole remaining flow inside ONE `runTrackedOperation` callback
 * span and instead give the per-task lock an explicit acquire/release API
 * (`runTrackedOperation` in `taskOperations.ts` is callback-scoped only —
 * there is no way to acquire the lock in the coordinator, return control to
 * it between steps, and release it later) so the coordinator can sequence
 * each interactive step as its own call while still holding the SAME lock
 * across all of them. `taskOperations.ts` has no such API today, and it is a
 * shared primitive used well beyond Commit/Push, so adding one is its own
 * scoped prerequisite, not a Commit/Push-local change — that is the actual
 * next step for a future round, not a vaguer "rewrite the flow." The
 * registry row DOES
 * genuinely own eligibility, the operation lease, presentation (progress
 * label), and settlement logging for Commit/Push, exactly like every other
 * migrated action (plan §3.8's "The coordinator owns ... eligibility,
 * leases, ... presentation ... and follow-up scheduling").
 * `requiresTaskOperationLease` below is `true`, held for this row's whole
 * execution span; a nested `commitPushMetadata.v1` invocation against the
 * SAME binding opens a CHILD lease instead of self-deadlocking (see that
 * field's comment and `workflowLeaseStoreV1.acquireChild`). This is layered
 * ON TOP OF, not instead of, the pre-existing independent process-global
 * token and `commitAndPushTaskCore`'s own `runTrackedOperation` lock.
 *
 * The remaining delegated call is no longer fully opaque on the way OUT,
 * though: `commitAndPushTaskCore` returns a `CommitAndPushCoreResultV1`
 * discriminated union whose `notCompleted` case carries a specific
 * `CommitAndPushNotCompletedReasonV1` (ineligible stage, declined
 * confirmation, failed git command, ...) set at every one of its internal
 * stopping points, which `executeCommitPushV1` below turns into a distinct
 * `commitPush.<reason>` outcome code instead of one undifferentiated
 * `commitPush.notCompleted` — the coordinator can tell WHY an attempt
 * didn't complete even for the steps it still doesn't sequence itself.
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
  commitAndPushTaskCore,
} from "../../commands/commitAndPushTask";
import { TaskInventory } from "../../state/taskInventory";
import { TaskOperationHandle } from "../../utils/taskOperations";
import { ChatViewProvider } from "../../views/chatView";
import { ResolvedTaskContext } from "../../utils/resolveTaskContext";
import { checkGitPublishReadiness } from "../../utils/gitRepoInfo";
import { NotificationRouter } from "../../utils/notificationRouter";

export const COMMIT_PUSH_ACTION_KEY_V1 = "commitPush.v1";

export interface CommitPushActionInputV1 {
  readonly taskFolderPath: string;
}

/**
 * The live service objects `commitAndPushTaskCore` needs, threaded through
 * `LifecycleExecutionContextV1.services` — never part of `rawInput` (plan
 * §3.1: a Chat interaction's validated-input snapshot must be canonically
 * digestible JSON, which in-process object references are not; this row has
 * no structured question of its own anyway — `commitPushMetadata.v1` owns
 * that — so nothing here is ever a Resume reconstruction input).
 *
 * `resolvedTask` is the SEALED task the coordinator already resolved and
 * bound its correlation/eligibility check to (built in
 * `invokeCommitPushRowV1`, `commitAndPushTask.ts`) — `execute` below passes
 * it straight into `commitAndPushTaskCore` instead of letting the core
 * re-resolve a target from `explicitArg`/current-task state, which could
 * otherwise pick a DIFFERENT task than the one just bound (e.g. a
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
 * Pure mapping from `commitAndPushTaskCore`'s result to the coordinator
 * outcome union — split out from `executeCommitPushV1` so the WHY-code
 * translation (`CommitAndPushNotCompletedReasonV1` -> `commitPush.<reason>`)
 * is unit-testable on its own, without driving the real git/UI flow inside
 * `commitAndPushTaskCore`.
 *
 * @internal exported for testing
 */
/**
 * Reasons that represent the user explicitly declining/deferring a prompt —
 * "nothing failed, they just said no (yet)" — as opposed to a genuine error
 * (a failed git command, an unavailable tool, a stale precondition). Each of
 * these already shows an information-level "cancelled" notice at its call
 * site in commitAndPushTask.ts, never a warning/error, which is the same
 * signal `userCancelled` already gets the standard `cancelled` outcome for
 * below — these just weren't routed there too until now.
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
  // header. The user-facing explanation was already shown via
  // NotificationRouter inside commitAndPushTaskCore at the exact point that
  // produced this reason; this is the machine-readable classification of
  // that same moment. Every remaining reason is retryable: each one is a
  // fresh-invocation-safe stopping point, not a corrupted state.
  return { kind: "failed", code: `commitPush.${result.reason}`, retryable: true };
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
  // coordinator-native step, BEFORE ever calling into the opaque
  // commitAndPushTaskCore — genuine coordinator ownership of sequencing for
  // the flow's first real step, not just admission/leasing/outcome mapping.
  // A privacy-blocked attempt now short-circuits here, without ever
  // entering the core or spinning up its tracked-operation UI row.
  // commitAndPushTaskCore (checkCommitPushIndexPrivacyV1's own header) runs
  // this exact check again under its per-task lock immediately before it
  // actually needs the result — that copy is the authoritative,
  // lock-protected revalidation; this one is the coordinator's real,
  // distinct first step.
  const indexCheck = await checkCommitPushIndexPrivacyV1(services.resolvedTask);
  if (!indexCheck.ok) {
    return mapCommitAndPushCoreResultToOutcomeV1(
      { kind: "notCompleted", reason: indexCheck.reason },
      context
    );
  }

  // §10.2 step 2 / §3.8: the read-only git readiness check (repo, branch,
  // push destination — never stages, commits, or pushes) as the second
  // coordinator-native step, still before commitAndPushTaskCore. A
  // not-ready repo now short-circuits here too, exactly like the index
  // check above; commitAndPushTaskCore re-runs the exact same
  // checkGitPublishReadiness call under its per-task lock immediately
  // before it actually needs the result (§7.7) — that copy remains the
  // authoritative revalidation, this one is real, distinct sequencing.
  // Unlike checkCommitPushIndexPrivacyV1, checkGitPublishReadiness is a pure
  // read-only helper shared with publishPreflight.ts and never shows its own
  // notification — commitAndPushTaskCore's own (now-bypassed) call site is
  // what used to surface this reason to the user, so this short-circuit must
  // show the exact same message itself rather than leaving the user with no
  // explanation at all.
  const gitReadinessCheck = await checkGitPublishReadiness(services.resolvedTask.taskFolderPath);
  if (!gitReadinessCheck.ok) {
    NotificationRouter.showError(`Commit and push failed: ${gitReadinessCheck.reason}`);
    return mapCommitAndPushCoreResultToOutcomeV1(
      { kind: "notCompleted", reason: "gitNotReady" },
      context
    );
  }

  const result = await commitAndPushTaskCore(
    services.inventory,
    services.resolvedTask,
    services.explicitArg,
    services.parentOperation,
    services.extensionContext,
    services.chatViewProvider,
    // This row's own coordinator-held lease (requiresTaskOperationLease
    // below is true): threaded through so the nested commitPushMetadata.v1
    // invocation inside commitAndPushTaskCore's reviewCommitMessage step
    // opens a CHILD lease on the same binding instead of self-deadlocking
    // against this lease as a false-positive duplicate (workflowLeaseStoreV1's
    // acquireChild).
    context.operationId
  );

  return mapCommitAndPushCoreResultToOutcomeV1(result, context);
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
    // here, before commitAndPushTaskCore's tracked operation/lock ever
    // starts; invokeCommitPushRowV1 (commitAndPushTask.ts) turns the
    // resulting actionNotEligibleForStage outcome into the same
    // stage-name warning core used to show internally, so the user-facing
    // message is unchanged even though the coordinator now owns the check.
    eligibility: { statuses: ["active", "paused", "completed"], stages: ["publish"] },
    // The coordinator's per-task lease, now genuinely held for this row's
    // whole (long, interactive) execution span: commitAndPushTaskCore's own
    // nested reviewCommitMessage step invokes commitPushMetadata.v1 (also
    // requiresTaskOperationLease: true) for this SAME task, which would
    // normally self-deadlock into duplicateRejected against the one-lease-
    // per-binding invariant — executeCommitPushV1 above avoids that by
    // threading this row's own `operationId` through to
    // commitAndPushTaskCore as `parentOperationId`, so that nested call opens
    // a CHILD lease (`workflowLeaseStoreV1.acquireChild`) instead of a
    // top-level one. A child lease is granted ONLY while the exact matching
    // parent operation currently holds the binding, so this cannot be used
    // to let an unrelated operation bypass exclusivity — see that method's
    // header for the safety argument. Commit/Push's mutual exclusion is
    // still layered with the independent process-global token (plan §3.8:
    // "Commit/Push retains its independent process-global token") plus
    // commitAndPushTaskCore's own per-task runTrackedOperation lock (guards
    // against a DIFFERENT concurrent operation on this task); this lease is
    // now an ADDITIONAL, genuinely coordinator-owned layer, not a
    // replacement for either.
    requiresTaskOperationLease: true,
    progressLabel: "Committing and pushing…",
    validateInput: validateCommitPushInputV1,
    loggingPolicy: { channel: "action.commitPush", includeResultMetrics: false },
    execute: executeCommitPushV1,
  };
}
