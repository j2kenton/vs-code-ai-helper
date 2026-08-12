/**
 * App-level service composition (plan Part 6): the control-plane client, the
 * session manager, and the PKCE sign-in flow wired together behind one
 * factory so screens depend on seams, not platforms.
 *
 * Platform notes, per the plan's storage policy:
 * - The token store is `expo-secure-store` (Keychain/Keystore) on native and
 *   IN-MEMORY on web — web's secure-store fallback is not secure storage, so
 *   web never persists a refresh token client-side (server-held HttpOnly
 *   cookie instead).
 * - The browser driver is `expo-auth-session`'s system-browser flow (native:
 *   an ephemeral browser session; web: `window.open`, via the same package's
 *   `.web` implementation) on every platform.
 * - The PKCE crypto source is WebCrypto where available (web, and modern
 *   Node for tests) and `expo-crypto` otherwise (Hermes on native has no
 *   WebCrypto).
 * - Sandbox/model keys never pass through here to any storage; Settings
 *   submits them straight to the control plane over TLS.
 */
import { Platform } from 'react-native';

import { ControlPlaneClientV1, createControlPlaneClientV1 } from '../api/controlPlaneClientV1';
import { createExpoAuthSessionBrowserDriverV1 } from '../auth/expoAuthSessionDriverV1';
import { createExpoCryptoPkceV1 } from '../auth/expoCryptoPkceV1';
import {
  AuthBrowserDriverV1,
  buildAuthorizeUrlV1,
  createWebCryptoPkceV1,
  generatePkcePairV1,
  IdentityProviderV1,
  PkceCryptoV1,
} from '../auth/pkceV1';
import { createSecureStoreTokenStoreV1 } from '../auth/secureStoreTokenStoreV1';
import {
  createInMemoryTokenStoreV1,
  createSessionManagerV1,
  SecureTokenStoreV1,
  SessionManagerV1,
} from '../auth/sessionManagerV1';
import { logAppEventV1 } from '../log/appLogV1';

export type SignInOutcomeV1 =
  | { readonly kind: 'signedIn' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export interface AppServicesV1 {
  readonly client: ControlPlaneClientV1;
  readonly session: SessionManagerV1;
  signIn(provider: IdentityProviderV1): Promise<SignInOutcomeV1>;
  signOut(): Promise<void>;
}

export interface CreateAppServicesOptionsV1 {
  readonly baseUrl: string;
  /** OAuth client ids registered per provider; absent = provider not configured. */
  readonly oauthClientIds?: Partial<Record<IdentityProviderV1, string>>;
  readonly browserDriver?: AuthBrowserDriverV1;
  readonly pkceCrypto?: PkceCryptoV1;
  readonly tokenStore?: SecureTokenStoreV1;
  readonly fetchImpl?: typeof fetch;
}

function defaultRedirectUri(): string {
  if (Platform.OS === 'web' && typeof location !== 'undefined') {
    return `${location.origin}/auth/callback`;
  }
  // Custom scheme registered in app.json for the native targets.
  return 'ensemble://auth/callback';
}

function hasWebCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle !== undefined;
}

export function createAppServicesV1(options: CreateAppServicesOptionsV1): AppServicesV1 {
  const tokenStore =
    options.tokenStore ??
    (Platform.OS === 'web' ? createInMemoryTokenStoreV1() : createSecureStoreTokenStoreV1());
  const browserDriver = options.browserDriver ?? createExpoAuthSessionBrowserDriverV1();

  // The client asks the session manager for tokens and the manager uses the
  // client's auth endpoints; the closure below is only ever invoked after
  // `boundSession` exists, which breaks the construction cycle.
  const client = createControlPlaneClientV1({
    baseUrl: options.baseUrl,
    getAccessToken: () => boundSession.getAccessToken(),
    // Web never sees the refresh token (Part 6): the client omits it from
    // exchange/refresh bodies and relies on the server's HttpOnly cookie.
    platform: Platform.OS === 'web' ? 'web' : 'native',
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  const boundSession: SessionManagerV1 = createSessionManagerV1({ client, tokenStore });

  async function signIn(provider: IdentityProviderV1): Promise<SignInOutcomeV1> {
    const clientId = options.oauthClientIds?.[provider];
    if (clientId === undefined) {
      return {
        kind: 'unavailable',
        reason: `no OAuth client id is configured for ${provider}`,
      };
    }
    const pkceCrypto =
      options.pkceCrypto ?? (hasWebCrypto() ? createWebCryptoPkceV1() : createExpoCryptoPkceV1());
    const pkce = await generatePkcePairV1(pkceCrypto);
    const redirectUri = defaultRedirectUri();
    const authorizeUrl = buildAuthorizeUrlV1({ provider, clientId, redirectUri, pkce });
    const authorized = await browserDriver.authorize(authorizeUrl, redirectUri);
    if (authorized.kind === 'unavailable') {
      return { kind: 'unavailable', reason: authorized.reason };
    }
    if (authorized.kind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (authorized.state !== pkce.state) {
      // CSRF binding failure: the redirect does not belong to this attempt.
      logAppEventV1(`sign-in failed (${provider}): authorization state mismatch`);
      return { kind: 'failed', code: 'stateMismatch', message: 'authorization state mismatch' };
    }
    const exchanged = await client.exchange({
      provider,
      authorizationCode: authorized.code,
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      nonce: pkce.nonce,
    });
    if (!exchanged.ok) {
      // Diagnostic only — the app log redacts, and this carries no secrets.
      logAppEventV1(`sign-in failed (${provider}): ${exchanged.code}`);
      return { kind: 'failed', code: exchanged.code, message: exchanged.message };
    }
    await boundSession.completeSignIn(exchanged.body);
    logAppEventV1(`signed in (${provider})`);
    return { kind: 'signedIn' };
  }

  return {
    client,
    session: boundSession,
    signIn,
    signOut: () => boundSession.signOut(),
  };
}

let sharedServices: AppServicesV1 | undefined;
let sharedBaseUrl: string | undefined;
let testOverrides: Partial<CreateAppServicesOptionsV1> | undefined;

/** Default control-plane origin; Settings can point elsewhere per session. */
export const DEFAULT_CONTROL_PLANE_URL_V1 = 'https://control-plane.invalid';

/**
 * OAuth client IDs from the build environment.
 *
 * Until this existed, `oauthClientIds` could only be supplied through
 * `setAppServiceTestOverridesV1`, which only the e2e hook calls — so a real
 * build had no client id for any provider and `startSignIn` failed at its own
 * "no client id configured" guard. Sign-in was reachable from a test and
 * unreachable from the app.
 *
 * Client IDs are public by design — they travel in the authorize URL the
 * browser sees — so `EXPO_PUBLIC_*` is the right channel. The client SECRETS
 * deliberately have no counterpart here: they belong only to the control
 * plane, which performs the code exchange (Part 6 trust boundary).
 *
 * Each variable is read as a literal `process.env.EXPO_PUBLIC_…` expression
 * because Metro inlines these at build time by textual substitution; a
 * computed lookup would silently evaluate to undefined in a production bundle.
 */
function oauthClientIdsFromEnvV1(): Partial<Record<IdentityProviderV1, string>> | undefined {
  const github = process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID;
  const google = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  const apple = process.env.EXPO_PUBLIC_APPLE_CLIENT_ID;
  const ids: Partial<Record<IdentityProviderV1, string>> = {};
  if (github !== undefined && github.length > 0) {
    ids.github = github;
  }
  if (google !== undefined && google.length > 0) {
    ids.google = google;
  }
  if (apple !== undefined && apple.length > 0) {
    ids.apple = apple;
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/**
 * Lazily created singleton used by the screens; recreated only when the
 * configured control-plane URL actually changes (which drops the in-memory
 * session — pointing at a different control plane is a new sign-in).
 */
export function getAppServicesV1(baseUrl?: string): AppServicesV1 {
  const resolved = baseUrl ?? sharedBaseUrl ?? DEFAULT_CONTROL_PLANE_URL_V1;
  if (sharedServices === undefined || resolved !== sharedBaseUrl) {
    sharedBaseUrl = resolved;
    // Test overrides spread last so a test still wins over the environment.
    sharedServices = createAppServicesV1({
      baseUrl: resolved,
      oauthClientIds: oauthClientIdsFromEnvV1(),
      ...testOverrides,
    });
  }
  return sharedServices;
}

/**
 * Test-only seam (Part 6 web smoke): Playwright cannot complete a redirect
 * against a real identity provider, so this substitutes a fake `browserDriver`
 * (and, when needed, `oauthClientIds`) and forces `getAppServicesV1` to
 * rebuild with them on its next call. Never invoked outside test code — no
 * production caller imports it.
 */
export function configureAppServicesTestOverridesV1(
  overrides: Partial<CreateAppServicesOptionsV1>
): void {
  testOverrides = overrides;
  sharedServices = undefined;
  sharedBaseUrl = undefined;
}
