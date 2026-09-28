import { describeModelWithProviderV1 } from "../runners/providers";
import type { ProviderChainCandidateStatusV1 } from "../types/taskActionOutcomeV1";

/**
 * One line naming every model a stage's chain tried and why each could not run
 * — `model (provider name in words) — reason` — so a fully-blocked chain is explained in the
 * message itself rather than by pointing at a run log. Empty when the chain
 * had no candidates at all.
 */
export function describeChainCandidatesV1(candidates: readonly ProviderChainCandidateStatusV1[]): string {
  return candidates
    .map((candidate) => `${describeModelWithProviderV1(candidate.storedModelId)} — ${candidate.reason}`)
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
    `${tried}To change the list, open Ensemble Settings and edit the model and backup models for ${stageName}` +
    " (the \"Adjust provider settings\" option opens them)."
  );
}
