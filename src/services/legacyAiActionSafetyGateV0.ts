/**
 * Fail-closed AI action safety gate (plan §1.3, "Install fail-closed AI
 * gates").
 *
 * ENFORCEMENT STATE
 * -----------------
 * Per the approved plan's staged-migration contract (§1.3, §8's Safety
 * cohort, and the Risks section's "Temporary gates make unmigrated AI
 * actions unavailable during staged rollout"), every baseline
 * question-capable or edit-capable legacy AI route is DISABLED until its V1
 * coordinator replacement lands (plan §8's Text/Lifecycle/Edit/Git cohorts).
 * A cohort re-enables a route by removing it from
 * `LEGACY_AI_ROUTE_DISABLED_V0` in the same change that lands the
 * replacement able to serve its traffic.
 *
 * Two independent checks, both enforcing today:
 *
 *  1. `assertLegacyAiRouteAllowedV0` — every baseline question-capable or
 *     edit-capable route (draft, generate plan, review, apply review, fast
 *     forward, generate implementation, implementation, the composite
 *     "current stage action" dispatcher, lint's AI fallback, Chat Send, and
 *     Commit/Push metadata generation) declares its stable route identity as
 *     the very first statement in its real handler, before any task/
 *     workspace/artifact read, consent prompt, or provider selection. An
 *     unregistered route id throws immediately, and a registered route whose
 *     id is in `LEGACY_AI_ROUTE_DISABLED_V0` (all of them, until its cohort
 *     migrates it) throws immediately as well — the handler performs no read
 *     and mutates no state. The one composite exception is Commit/Push
 *     metadata generation, which uses the non-throwing
 *     `isLegacyAiRouteDisabledV0` query so the disabled AI sub-step degrades
 *     to the deterministic fallback subject without breaking the non-AI
 *     commit flow.
 *
 *     Three SUPPLEMENTARY provider-invoking routes outside the original §1.2
 *     baseline table were discovered during the runner-boundary audit that
 *     fixed check 2's stage-less bypass below: review escalation's plateau
 *     second opinion (`runSecondOpinionReview` in reviewActions.ts), the
 *     Global Assistant (`globalAssistantSend`/`openGeneralAssistant` in
 *     openGeneralAssistant.ts), and Publish AI plan verification
 *     (`runAiPlanVerification` in completionLint.ts). None had a planned V1
 *     coordinator `actionKey` at the time, and two of the three's actual
 *     output shapes still have no member in the plan's closed completed-
 *     content union (§3.5) — a full-opinion review verdict never published
 *     as an artifact, and per-plan-item JSON verdicts — so migrating THOSE
 *     two onto the coordinator would mean inventing coordinator machinery
 *     the approved plan does not authorize. Per the Cleanup cohort's
 *     disposition of "proven-unreachable legacy consumers/output paths"
 *     (plan §8), their dead runner-invocation code (prompt construction,
 *     `resolveRunnerForModel`/`AgentRunner.run` calls, scratch `outputFile`
 *     handling) has been REMOVED outright rather than left permanently gated
 *     in an undecided limbo state. Second opinion now unconditionally
 *     escalates on the primary review alone, and plan verification
 *     unconditionally reports the deterministic baseline only — the exact
 *     behavior each already had in production, since
 *     `LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0` made their
 *     runner-invocation code permanently unreachable. Neither route id
 *     remains in this catalog; there is nothing left to re-enable for
 *     either, only a real V1 migration (a new coordinator action with a
 *     genuine completed-content type) could restore actual AI behavior for
 *     them, and that would need its own scope decision.
 *
 *     The Global Assistant's output shape, unlike the other two, IS a
 *     `chat-message.v1` — it is free-form assistant chat, just outside any
 *     task's Chat document rather than inside one. It migrated onto the
 *     coordinator as `globalAssistantSend.v1` (globalAssistantSendRowV1.ts):
 *     its folder registers as dedicated non-task storage
 *     (`ensureWorkflowNonTaskStorageRootV1`, not a task-folder root), and its
 *     `taskBinding.taskBindingId` is chatHistoryStore.ts's own
 *     `localTaskBindingId(GLOBAL_ASSISTANT_CANONICAL_ID)` — the same local
 *     digest stand-in that module already used as this conversation's
 *     default binding, now supplied explicitly instead of only defaulted
 *     internally. Its command, toolbar entry, default-Chat-target wiring,
 *     and prompt builder are all restored (openGeneralAssistant.ts); the
 *     only thing that changed from the pre-audit implementation is HOW it
 *     reaches a provider — through this route id, `assertLegacyAiRouteAllowedV0`,
 *     and the coordinator's V1-correlated runner boundary, never the direct
 *     `resolveRunnerForModel(...).runner.run(...)` call the audit found
 *     bypassing check 2 below.
 *
 *  2. `assertNoUnauthorizedV1CorrelationV0` — the shared runner/provider
 *     boundary in `runnerRegistry.ts` (`resolveRunnerForModel` and
 *     `runImplementationForModel`, which together are the only two paths
 *     every command funnels a provider invocation through) rejects:
 *       - any request carrying V1 correlation data (plan §3.1) whose
 *         `actionKey` is not in `MIGRATED_ACTION_KEYS_V0`; and
 *       - any legacy (uncorrelated) request, while
 *         `LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled` is
 *         true (plan §1.3: "unknown or legacy calls are rejected"). This is
 *         the backstop for any invocation path that reached the provider
 *         boundary without passing a handler-level route gate first.
 *
 *     `resolveRunnerForModel`'s `stage`-less branch (used by callers that
 *     resolve a runner outside the stage-reservation/quota-observation
 *     machinery — the three supplementary routes above) used to return the
 *     raw concrete runner untouched, reaching the transport with no
 *     assertion at all rather than merely being subject to one. It now wraps
 *     that branch the same way the stage-bearing branches always did, so
 *     every exit of the function enforces this check identically regardless
 *     of whether the caller passed a `stage`.
 *
 * TESTS
 * -----
 * The unit-test harness (`test-stubs/register.js`) suspends both
 * enforcement switches before behavioral tests load: those suites
 * deliberately exercise the legacy runner/handler machinery that stays in
 * the tree until the V1 cutover (plan §3.4) and would otherwise all fail at
 * the first gate statement. Enforcement itself — and the production values
 * of both switches — is covered explicitly by
 * `legacyAiActionSafetyGateV0.test.ts`, which re-enables them per-test and
 * statically asserts this file's production initializers.
 */

/** Stable identity for every baseline question-capable or edit-capable AI route (plan §1.2's route table). */
export type LegacyAiRouteIdV0 =
  | "draft.v1"
  | "generatePlan.v1"
  | "review.v1"
  | "applyReview.v1"
  | "applyReviewEdit.v1"
  | "fastForward.v1"
  | "generateImplementation.v1"
  | "implementation.v1"
  | "applyCurrentStage.v1"
  | "lint.v1"
  | "chatSend.v1"
  | "commitPushMetadata.v1"
  | "globalAssistantSend.v1";

const REGISTERED_LEGACY_AI_ROUTE_IDS_V0: ReadonlySet<string> = new Set<LegacyAiRouteIdV0>([
  "draft.v1",
  "generatePlan.v1",
  "review.v1",
  "applyReview.v1",
  "applyReviewEdit.v1",
  "fastForward.v1",
  "generateImplementation.v1",
  "implementation.v1",
  "applyCurrentStage.v1",
  "lint.v1",
  "chatSend.v1",
  "commitPushMetadata.v1",
  "globalAssistantSend.v1",
]);

export class LegacyAiActionSafetyGateErrorV0 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyAiActionSafetyGateErrorV0";
  }
}

/**
 * Route ids whose LEGACY invocation path is disabled. Per the approved
 * plan's fail-closed staged migration (§1.3, §8), this contains EVERY
 * registered baseline route until that route's V1 coordinator replacement
 * lands — the cohort that lands a replacement removes its route id from
 * this set in the same change. Do not remove a route id here without its
 * real V1 migration landing in the same change.
 *
 * Two of the three `.v0` supplementary routes discussed in the file header
 * (review second opinion, Publish plan verification) are no longer
 * registered here at all: their Cleanup-cohort disposition was removal (see
 * the file header), not an entry in this set, since there is no dead
 * runner-invocation code left for an entry to disable. The third,
 * `globalAssistantSend.v1`, IS registered above (as a real `.v1`, not a
 * `.v0` route) and stays enabled: it migrated onto the coordinator instead
 * of being retired.
 */
export const LEGACY_AI_ROUTE_DISABLED_V0: ReadonlySet<string> = new Set<string>([
  // Every ".v1" baseline route id is EMPTY since the §7.8 Edit-cohort
  // cutover: the final five ids (implementation.v1, fastForward.v1,
  // applyReviewEdit.v1, applyCurrentStage.v1, lint.v1) migrated onto the
  // sealed two-phase preflight/edit pipeline (runEditActionV1.ts →
  // preflight rows → editExecution.v1) in the same change that emptied it.
  // The fail-closed assert below stays in place so a future ".v1" route
  // lands disabled-by-default again by adding its id here.
]);

/**
 * Throws unless `routeId` is a registered baseline AI route identity AND is
 * not disabled via `LEGACY_AI_ROUTE_DISABLED_V0`. Call this as the first
 * statement of a route's real handler — before any read, consent gate, or
 * provider selection — so an unregistered/misspelled route id, or one whose
 * legacy path is disabled pending its V1 migration, fails closed instead of
 * running unaccounted-for. A future route lands disabled-by-default by
 * adding its id to `LEGACY_AI_ROUTE_DISABLED_V0`.
 */
export function assertLegacyAiRouteAllowedV0(routeId: string): void {
  if (!REGISTERED_LEGACY_AI_ROUTE_IDS_V0.has(routeId)) {
    throw new LegacyAiActionSafetyGateErrorV0(
      `Unregistered AI action route id: ${JSON.stringify(routeId)}. Every baseline ` +
        "question-capable or edit-capable route must be added to " +
        "REGISTERED_LEGACY_AI_ROUTE_IDS_V0 in legacyAiActionSafetyGateV0.ts before it can run."
    );
  }
  if (LEGACY_AI_ROUTE_DISABLED_V0.has(routeId)) {
    throw new LegacyAiActionSafetyGateErrorV0(
      `This AI action (route ${JSON.stringify(routeId)}) is temporarily unavailable: its legacy ` +
        "invocation path is disabled while Ensemble's staged workflow migration is in progress " +
        "(LEGACY_AI_ROUTE_DISABLED_V0 in legacyAiActionSafetyGateV0.ts). It will be re-enabled by the " +
        "migration cohort that lands its V1 coordinator replacement."
    );
  }
}

/**
 * Non-throwing variant of the route gate for COMPOSITE routes whose handler
 * must degrade gracefully rather than throw when disabled: an AI sub-step
 * embedded inside a larger non-AI flow (Commit/Push metadata generation
 * inside the commit flow, degrading to the deterministic fallback subject).
 * An unregistered route id still throws (fail-closed identity check), but a
 * disabled route returns `true` so the caller can degrade instead of failing
 * outright. Pure AI routes with no graceful degradation path must keep using
 * `assertLegacyAiRouteAllowedV0`.
 */
export function isLegacyAiRouteDisabledV0(routeId: string): boolean {
  if (!REGISTERED_LEGACY_AI_ROUTE_IDS_V0.has(routeId)) {
    throw new LegacyAiActionSafetyGateErrorV0(
      `Unregistered AI action route id: ${JSON.stringify(routeId)}. Every baseline ` +
        "question-capable or edit-capable route must be added to " +
        "REGISTERED_LEGACY_AI_ROUTE_IDS_V0 in legacyAiActionSafetyGateV0.ts before it can run."
    );
  }
  return LEGACY_AI_ROUTE_DISABLED_V0.has(routeId);
}

/**
 * Action keys allowed to carry V1 correlation data (plan §3.1) through the
 * shared runner/provider boundary. Populated one action at a time, in the
 * same change that removes its route id from `LEGACY_AI_ROUTE_DISABLED_V0`
 * above — "generatePlan.v1" was the first (plan §6.2's Generate Plan
 * vertical slice); "draft.v1" is the second (plan §6.3's Draft migration).
 */
export const MIGRATED_ACTION_KEYS_V0: ReadonlySet<string> = new Set<string>([
  "generatePlan.v1",
  "draft.v1",
  "generateImplementation.v1",
  "review.v1",
  "applyReview.v1",
  "chatSend.v1",
  "globalAssistantSend.v1",
  "commitPushMetadata.v1",
  // Edit cohort (§7.8): the four preflight actions and the composite
  // dispatcher, plus the internal mutation session — all running through
  // the sealed two-phase pipeline. applyCurrentStage.v1 itself never
  // reaches the provider boundary (it dispatches to the others) but is
  // migrated in the route sense: its legacy gate id left the disabled set.
  "implementation.v1",
  "fastForward.v1",
  "applyReviewEdit.v1",
  "lint.v1",
  "applyCurrentStage.v1",
  "editExecution.v1",
  // Internal-only like editExecution.v1: no registered legacy route id —
  // renameTask.v1 is invoked directly through the coordinator by the Rename
  // Task with AI command (renameTask.ts).
  "renameTask.v1",
  // Internal-only text-mode dispatch for a summary-only recovery
  // continuation (workflow-robustness Part 2 item 4) — invoked by the
  // implementation stage owner via the coordinator, inside the already-gated
  // "implementation.v1" route.
  "implContinuationReport.v1",
]);

/**
 * Enforcement switch for the boundary-level rejection of legacy
 * (uncorrelated) runner invocations. Enabled in production per plan §1.3
 * ("unknown or legacy calls are rejected" at the shared runner/provider
 * boundary): no provider invocation is authorized today, because no action
 * has migrated to the V1 coordinator and every legacy route is disabled.
 * The unit-test harness disables this so behavioral suites can continue to
 * exercise the retained legacy runner machinery (see file header).
 */
export const LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0 = { enabled: true };

function hasV1CorrelationShape(
  request: unknown
): request is { readonly correlation: Record<string, unknown> } {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const correlation = (request as Record<string, unknown>).correlation;
  return typeof correlation === "object" && correlation !== null;
}

/**
 * Provider-boundary backstop (plan §1.3). Throws if `request`:
 *  - carries a V1 `correlation` field whose `actionKey` is not in
 *    `MIGRATED_ACTION_KEYS_V0` (a not-yet-migrated action can never slip
 *    V1-correlated work through to a legacy runner or legacy `outputFile`
 *    write path); or
 *  - is a legacy (uncorrelated) request while
 *    `LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled` is true —
 *    the fail-closed boundary state for the staged migration, catching any
 *    invocation path that reached the provider boundary without a
 *    handler-level route gate.
 *
 * This function has NO knowledge of "implementation.v1" or any other route
 * id for the uncorrelated case, and must not gain one via a shared,
 * reusable field like `stage`: a prior version exempted any request with
 * `stage === "impl"`, which also matched generateImplementationWithAI's
 * (already "migrated") uncorrelated runAiToFile call — silently letting a
 * genuinely-legacy request through this boundary under a route id it does
 * not belong to. That "implementation.v1" bootstrap exemption has since been
 * removed entirely: this check is enforced unconditionally for every caller,
 * including runImplementationWithAI's own invocation, which now calls
 * `assertLegacyAiRouteAllowedV0("implementation.v1")` as its first statement
 * and never reaches the runner boundary while "implementation.v1" stays in
 * `LEGACY_AI_ROUTE_DISABLED_V0`.
 *
 * Call this immediately before delegating to a concrete `AgentRunner.run`,
 * at every path through `runnerRegistry.ts`.
 */
export function assertNoUnauthorizedV1CorrelationV0(request: unknown): void {
  if (!hasV1CorrelationShape(request)) {
    if (LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled) {
      throw new LegacyAiActionSafetyGateErrorV0(
        "Rejected a legacy (uncorrelated) provider invocation at the runner boundary: no AI action is " +
          "authorized to invoke a provider until its V1 coordinator migration lands " +
          "(LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0 in legacyAiActionSafetyGateV0.ts)."
      );
    }
    return;
  }
  const actionKey = request.correlation.actionKey;
  if (typeof actionKey !== "string" || !MIGRATED_ACTION_KEYS_V0.has(actionKey)) {
    throw new LegacyAiActionSafetyGateErrorV0(
      `Rejected a V1-correlated request at the legacy runner boundary: actionKey=${JSON.stringify(
        actionKey
      )} is not in MIGRATED_ACTION_KEYS_V0. Legacy runners and output-file APIs must never ` +
        "receive V1 correlation data for an action that has not migrated to the coordinator."
    );
  }
}
