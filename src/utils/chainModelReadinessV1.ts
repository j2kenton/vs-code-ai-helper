/**
 * bugs4 Step 32 (item 31): the "is this configured model usable right now?" check behind
 * "Enable <model> and rerun the fix". It reuses the runner availability check the stages already
 * run before dispatch (installed and signed in); it does not read or write any account or
 * permission file.
 */
import { checkRunnerAvailabilityForModel } from "../runners/runnerRegistry";
import type { ChainModelReadinessProbeV1 } from "./enableChainModelV1";

export const defaultChainModelReadinessProbeV1: ChainModelReadinessProbeV1 = async (modelId) => {
  // No stage: only this model's own runner is checked, never a different backup standing in for it.
  const checked = await checkRunnerAvailabilityForModel(modelId);
  if (checked.availability.available) return { ready: true };
  return { ready: false, reason: checked.providerLabel + ": " + (checked.availability.reason ?? "not available") };
};

let probeOverride: ChainModelReadinessProbeV1 | undefined;

/** The active probe: the real availability check unless a test installed its own. */
export function chainModelReadinessProbeV1(): ChainModelReadinessProbeV1 {
  return probeOverride ?? defaultChainModelReadinessProbeV1;
}

export const __chainModelReadinessProbeTestOnly = {
  set(probe: ChainModelReadinessProbeV1): void {
    probeOverride = probe;
  },
  reset(): void {
    probeOverride = undefined;
  },
};
