/**
 * Pure, `expo-auth-session`-free pieces of the AuthSession driver (plan
 * Part 6), split out so they can run under `node --test` without pulling in
 * the native-module-backed package — the driver itself
 * (`expoAuthSessionDriverV1.ts`) is excluded from that suite because
 * importing `expo-auth-session` requires a React Native runtime.
 */

/** Structural subset of `expo-auth-session`'s `AuthSessionResult` union. */
export type AuthSessionResultLikeV1 =
  | { readonly type: 'success'; readonly params: Readonly<Record<string, string | undefined>> }
  | { readonly type: 'cancel' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'locked' }
  | { readonly type: 'opened' }
  | {
      readonly type: 'error';
      readonly error?: { readonly message?: string | null } | null;
      readonly errorCode?: string | null;
    };

export type AuthorizeOutcomeV1 =
  | { readonly kind: 'success'; readonly code: string; readonly state: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export function mapAuthSessionResultV1(result: AuthSessionResultLikeV1): AuthorizeOutcomeV1 {
  // Checking the 'success' literal first is what lets TS narrow `result` to
  // the branch carrying `params` — the branches of `AuthSessionResult` share
  // their `type` property across a union of literals rather than each having
  // one unique tag, so excluding non-success values ONE AT A TIME (as
  // opposed to this positive check) does not narrow reliably.
  if (result.type === 'success') {
    const { code, state } = result.params;
    if (typeof code !== 'string' || typeof state !== 'string') {
      return { kind: 'unavailable', reason: 'the redirect did not include an authorization code' };
    }
    return { kind: 'success', code, state };
  }
  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { kind: 'cancelled' };
  }
  if (result.type === 'error') {
    return {
      kind: 'unavailable',
      reason:
        result.error?.message ?? result.errorCode ?? 'the provider returned an authorization error',
    };
  }
  // `locked`: another AuthSession is already open; `opened`: a browser-only
  // intermediate state that should never reach here because `promptAsync`
  // only resolves once the session concludes.
  return { kind: 'unavailable', reason: `unexpected auth session state: ${result.type}` };
}

/**
 * `buildAuthorizeUrlV1` (pkceV1.ts) always embeds `state` in the URL it
 * builds. `AuthRequest` must be constructed with that SAME state — not a
 * random one of its own — or its `parseReturnUrl` CSRF guard rejects every
 * real provider redirect as `state_mismatch`, since the provider only ever
 * echoes back the state that was in the URL it received.
 */
export function extractStateFromAuthorizeUrlV1(authorizeUrl: string): string | undefined {
  return new URL(authorizeUrl).searchParams.get('state') ?? undefined;
}
