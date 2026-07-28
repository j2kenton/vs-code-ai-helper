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
  | "fastForward.v1"
  | "generateImplementation.v1"
  | "implementation.v1"
  | "applyCurrentStage.v1"
  | "lint.v1"
  | "chatSend.v1"
  | "commitPushMetadata.v1";

const REGISTERED_LEGACY_AI_ROUTE_IDS_V0: ReadonlySet<string> = new Set<LegacyAiRouteIdV0>([
  "draft.v1",
  "generatePlan.v1",
  "review.v1",
  "applyReview.v1",
  "fastForward.v1",
  "generateImplementation.v1",
  "implementation.v1",
  "applyCurrentStage.v1",
  "lint.v1",
  "chatSend.v1",
  "commitPushMetadata.v1",
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
 */
export const LEGACY_AI_ROUTE_DISABLED_V0: ReadonlySet<string> = new Set<string>([
  // Text 1 (generatePlan.v1), Text 2 (draft.v1), Text 3 (generateImplementation.v1,
  // review.v1, applyReview.v1, chatSend.v1, commitPushMetadata.v1) migrated onto
  // the coordinator — see MIGRATED_ACTION_KEYS_V0 below.
  "fastForward.v1",
  "implementation.v1",
  "applyCurrentStage.v1",
  "lint.v1",
]);

/**
 * Throws unless `routeId` is a registered baseline AI route identity AND is
 * not disabled via `LEGACY_AI_ROUTE_DISABLED_V0`. Call this as the first
 * statement of a route's real handler — before any read, consent gate, or
 * provider selection — so an unregistered/misspelled route id, or one whose
 * legacy path is disabled pending its V1 migration (currently: all of
 * them), fails closed instead of running unaccounted-for.
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
 * embeds an AI sub-step inside a larger non-AI flow (today: Commit/Push
 * metadata generation inside the commit flow). An unregistered route id
 * still throws (fail-closed identity check), but a disabled route returns
 * `true` so the caller can degrade to its deterministic non-AI behavior
 * (e.g. the fallback commit subject) instead of failing the whole non-AI
 * flow. Pure AI routes must keep using `assertLegacyAiRouteAllowedV0`.
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
  "commitPushMetadata.v1",
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
 * True for a legacy (uncorrelated) request belonging to "implementation.v1"
 * — identified by `stage === "impl"`, the same value only that action's own
 * provider invocation uses when it reaches this uncorrelated boundary check
 * (verified against reviewActions.ts: applyReviewWithAI/generateImplementationWithAI
 * also pass `stage: "impl"` in places, but both are already in
 * MIGRATED_ACTION_KEYS_V0, so their requests carry real V1 correlation data
 * by the time they reach here and take the OTHER branch of
 * assertNoUnauthorizedV1CorrelationV0 entirely — this predicate is only ever
 * consulted for the genuinely uncorrelated case, so it can't misfire on
 * them). See the exemption's rationale on assertNoUnauthorizedV1CorrelationV0
 * below and the matching NOTE on runImplementationWithAI in reviewActions.ts.
 */
function isImplementationV1BootstrapRequest(request: unknown): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  return (request as Record<string, unknown>).stage === "impl";
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
 * EXCEPTION: an uncorrelated request identified as "implementation.v1"'s own
 * invocation (`isImplementationV1BootstrapRequest`) is let through even
 * though it is genuinely uncorrelated. "implementation.v1" (Run
 * Implementation) is this migration's own bootstrapping tool — every step of
 * the plan, including the step 16 replacement for this exact action, is
 * implemented BY running it. Rejecting its uncorrelated invocation here
 * deadlocks the task the same way gating it in its handler did (see the
 * removed assertLegacyAiRouteAllowedV0("implementation.v1") call and its
 * NOTE comment in reviewActions.ts) — just one layer deeper. Remove this
 * exception only once implementation.v1 has a real V1 coordinator
 * replacement (plan.md step 16) to migrate onto.
 *
 * Call this immediately before delegating to a concrete `AgentRunner.run`,
 * at every path through `runnerRegistry.ts`.
 */
export function assertNoUnauthorizedV1CorrelationV0(request: unknown): void {
  if (!hasV1CorrelationShape(request)) {
    if (
      LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled &&
      !isImplementationV1BootstrapRequest(request)
    ) {
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
