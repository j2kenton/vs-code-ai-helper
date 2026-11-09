import { describeModelWithProviderV1 } from "../runners/providers";
import type { ProviderChainCandidateStatusV1 } from "../types/taskActionOutcomeV1";
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import { isAuthenticationFailure } from "./quota";
import { describeWaitForLimitResetV1 } from "./roundStopCauseV1";
import { plainCandidateReasonV1 } from "./settledRoundWordingV1";

/**
 * One line naming every model a stage's chain tried and why each could not run
 * — `model (provider name in words) — reason` — so a fully-blocked chain is explained in the
 * message itself rather than by pointing at a run log. Empty when the chain
 * had no candidates at all.
 */
export function describeChainCandidatesV1(
  candidates: readonly ProviderChainCandidateStatusV1[],
  options: { readonly raw?: boolean } = {}
): string {
  // run1 Step 8: the owner-facing line words an Ensemble stop through the shared stop wording; the run
  // log asks for the raw reason (`raw: true`).
  return candidates
    .map((candidate) => {
      const reason =
        options.raw === true ? candidate.reason : plainCandidateReasonV1(candidate.reason, candidate.providerLabel);
      return `${describeModelWithProviderV1(candidate.storedModelId)} — ${reason}`;
    })
    .join("; ");
}

/**
 * The tail of the single "no model can run" message: which models were
 * tried, and where the user changes them. Selection order is not touched by
 * this text or by the settings it points to — each run still starts at the top
 * of the list and falls back in order.
 */
export function describeChainExhaustionTailV1(
  stageName: string,
  candidates: readonly ProviderChainCandidateStatusV1[]
): string {
  const tried =
    candidates.length > 0
      ? `Models tried, in order: ${describeChainCandidatesV1(candidates)}. `
      : "No model is configured for this stage. ";
  return (
    `${tried}To change the list, choose "Change the model in AI Models"; it opens AI Models focused on ${stageName}.`
  );
}

/**
 * bugs3 Step 3: the cheapest next step for each kind of reason in an exhausted
 * chain, instead of one fixed pointer. A quota or usage-limit candidate points
 * at waiting for the reset (with its time when the provider gave one), a
 * credential failure points at signing in to that provider again, and
 * switching the stage's model is always offered because it works for every
 * reason. Never suggests signing in for a quota candidate.
 */
export function describeChainRecoveryV1(
  candidates: readonly ProviderChainCandidateStatusV1[],
  stageKey?: string
): string {
  if (candidates.length === 0) {
    return "";
  }
  const stageName = stageKey !== undefined ? (STAGE_DISPLAY_NAMES[stageKey as TaskStage] ?? stageKey) : undefined;
  const steps: string[] = [];
  const quota = candidates.filter((candidate) => candidate.deferredFailureKind === "quota");
  if (quota.length > 0) {
    const resets = quota
      .map((candidate) => (candidate.deferredResetAt !== undefined ? Date.parse(candidate.deferredResetAt) : Number.NaN))
      .filter((time) => !Number.isNaN(time))
      .sort((a, b) => a - b);
    // run1 plain words: the shared stop wording decides whether a usage limit may be named.
    steps.push(
      describeWaitForLimitResetV1(
        quota.map((candidate) => candidate.reason),
        resets.length > 0 ? new Date(resets[0]!).toLocaleString() : undefined
      )
    );
  }
  const signIn = candidates.filter(
    (candidate) => candidate.deferredFailureKind === undefined && isAuthenticationFailure(candidate.reason)
  );
  if (signIn.length > 0) {
    const providers = [...new Set(signIn.map((candidate) => candidate.providerLabel))];
    steps.push(`sign in again to ${providers.join(" and ")}`);
  }
  steps.push(
    stageName !== undefined
      ? `switch ${stageName}'s model (open AI Models on that stage)`
      : "switch the stage's model in AI Models"
  );
  return `Next: ${steps.join(", or ")}.`;
}
