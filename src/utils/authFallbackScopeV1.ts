import { formatProviderErrorV1 } from "./providerErrorFormatterV1";

/**
 * bugs4 item 28 / Step 31: an authentication failure is a problem with one provider's sign-in,
 * so it only holds back the other models that share that provider and account. A backup from a
 * different provider has its own sign-in and is still worth trying.
 */

export interface SignInScopeV1 {
  readonly providerId: string;
  readonly accountKey: string | undefined;
}

/** True when both models authenticate through the same provider and account. */
export function sameSignInScopeV1(a: SignInScopeV1 | undefined, b: SignInScopeV1 | undefined): boolean {
  // Unknown scope is treated as the same: never cross a provider boundary on a guess.
  if (a === undefined || b === undefined) return true;
  return a.providerId === b.providerId && a.accountKey === b.accountKey;
}

/**
 * The candidates an auth failure on `failed` does not hold back, in their original order.
 * `scopeOf` returns undefined for a model whose provider cannot be resolved.
 */
export function crossProviderAuthCandidatesV1(
  failed: SignInScopeV1 | undefined,
  candidates: readonly string[],
  scopeOf: (model: string) => SignInScopeV1 | undefined
): string[] {
  return candidates.filter((model) => !sameSignInScopeV1(failed, scopeOf(model)));
}

/** Why a candidate is held back after an authentication failure. */
export const SAME_SIGN_IN_HELD_BACK_REASON_V1 =
  "it uses the same sign-in as the model whose authentication failed, so a retry would fail the same way";

/**
 * The chat line when a backup from another provider ran after an authentication failure:
 * the failed provider, the readable reason, the model that ran and the sign-in step.
 */
export function authFailureRescueNoteV1(failedProviderLabel: string, rawError: string | undefined, ranLabel: string): string {
  const reason = rawError ? formatProviderErrorV1(rawError, { maxChars: 160 }) : undefined;
  return (
    `${failedProviderLabel} sign-in failed${reason ? ` (${reason.replace(/[.\s]+$/, "")})` : ""}; ` +
    `this round ran on ${ranLabel}. Sign in to ${failedProviderLabel} again to use it.`
  );
}
