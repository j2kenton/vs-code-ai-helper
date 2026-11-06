/**
 * review1 Step 24: the vscode-free half of the "is this working?" gate, so the work-admission layer can read it.
 *
 * `evaluateProgressWatchV1` is the one decision: given a task's `progressWatch` and the two limits, must the next
 * automatic dispatch stop and ask the owner? `registerAutomaticGateLimitsProviderV1` lets the extension tell the
 * admission layer where the limits (settings) live; without a provider the admission layer enforces nothing, which is
 * what unit tests that exercise admission alone rely on.
 */
import type { ProgressWatchV1 } from "../types/taskProgress";

export interface ProgressWatchLimitsV1 {
  /** `ensemble.resilience.askOwnerAfterRounds` (0 = off). */
  readonly askOwnerAfterRounds: number;
  /** `ensemble.resilience.askOwnerAfterFailedRounds` (0 = off). */
  readonly askOwnerAfterFailedRounds: number;
}

export type ProgressWatchDecisionV1 =
  | { readonly trip: false }
  | { readonly trip: true; readonly reason: "rounds" | "failed"; readonly alreadyHeld: boolean };

/** Whether the next automatic dispatch must stop and ask the owner. */
export function evaluateProgressWatchV1(watch: ProgressWatchV1 | undefined, limits: ProgressWatchLimitsV1): ProgressWatchDecisionV1 {
  if (watch === undefined) return { trip: false };
  if (watch.heldAt !== undefined && watch.heldFor !== undefined) {
    return { trip: true, reason: watch.heldFor, alreadyHeld: true };
  }
  if (limits.askOwnerAfterFailedRounds > 0 && watch.consecutiveFailedAutoRounds >= limits.askOwnerAfterFailedRounds) {
    return { trip: true, reason: "failed", alreadyHeld: false };
  }
  if (limits.askOwnerAfterRounds > 0 && watch.autoRoundsSinceProgress >= limits.askOwnerAfterRounds) {
    return { trip: true, reason: "rounds", alreadyHeld: false };
  }
  return { trip: false };
}

let limitsProvider: (() => ProgressWatchLimitsV1) | undefined;

/** Called once at activation; pass `undefined` to turn admission-layer enforcement off (tests). */
export function registerAutomaticGateLimitsProviderV1(provider: (() => ProgressWatchLimitsV1) | undefined): void {
  limitsProvider = provider;
}

/** The current limits, or `undefined` when no provider is registered (the admission layer then enforces nothing). */
export function readAutomaticGateLimitsV1(): ProgressWatchLimitsV1 | undefined {
  return limitsProvider?.();
}
