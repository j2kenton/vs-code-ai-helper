/**
 * Client-side session lifecycle for the Part 6 control-plane credential:
 * a short-lived access token plus a rotating refresh token, held behind a
 * secure-storage seam.
 *
 * Storage policy per the plan:
 * - NATIVE: tokens live in `expo-secure-store` (Keychain/Keystore) — see
 *   `secureStoreTokenStoreV1.ts` for the `SecureTokenStoreV1` adapter.
 * - WEB: secure-store's web fallback is NOT secure storage, so the refresh
 *   token must never be persisted client-side on web — the web composition
 *   uses the in-memory store (access token only, shorter lifetime) with the
 *   refresh kept server-side via an HttpOnly cookie.
 * - Sandbox and model-provider API keys are NEVER stored here or anywhere
 *   on-device; they go straight to the control plane over TLS (Settings).
 *
 * `getAccessToken` refreshes single-flight ahead of expiry; a refresh
 * rejection (rotation reuse, family revoked) signs the session out locally —
 * fail closed, matching the server's family-revocation semantics.
 */
import type { ControlPlaneClientV1, SessionTokensV1 } from '../api/controlPlaneClientV1';

export interface SecureTokenStoreV1 {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory store: the web default (refresh never persisted client-side). */
export function createInMemoryTokenStoreV1(): SecureTokenStoreV1 {
  const values = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set(key, value) {
      values.set(key, value);
      return Promise.resolve();
    },
    remove(key) {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

const STORAGE_KEY_PREFIX_V1 = 'ensemble.session.v1';

/** Every character `expo-secure-store` rejects in a key. */
const UNSAFE_KEY_CHARS_V1 = /[^A-Za-z0-9._-]/g;

/**
 * FNV-1a (32-bit). Not a security primitive — it only has to make two distinct
 * origins produce distinct keys. It is here because the key is built
 * SYNCHRONOUSLY at manager construction, and the platform's real hashes are
 * async (`expo-crypto`) or absent (Hermes has no WebCrypto).
 */
function fnv1a32V1(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The secure-store key for one control-plane ORIGIN.
 *
 * A single global key is a credential-leak vector on native, where the store
 * genuinely persists: changing the control-plane URL builds a new client, whose
 * `restore()` would read the PREVIOUS server's tokens and send them as a bearer
 * to the new origin. An attacker-controlled URL — or an honest typo — would
 * hand out a token that is still valid against the original server. Keying by
 * origin means a new control plane simply finds nothing and starts signed out,
 * while switching back recovers the right session.
 *
 * The origin CANNOT be used literally. `expo-secure-store` accepts only
 * alphanumerics, `.`, `-` and `_`, and every real origin carries `:` and `/`
 * (`https://host:8787`), so a literal key makes SecureStore reject on every
 * read and write — which on native breaks sign-in and restore outright, the
 * exact opposite of the fix. So the origin is sanitized for legibility while
 * debugging, bounded in length, and disambiguated by a hash of the ORIGINAL
 * string, so two origins that sanitize or truncate alike still differ.
 *
 * Only the origin is used, so a trailing slash or path does not fork the key.
 * A URL that will not parse falls back to the raw string: still per-URL, and
 * such a value cannot reach a real server anyway.
 */
function sessionStorageKeyV1(baseUrl: string): string {
  let scope: string;
  try {
    scope = new URL(baseUrl).origin;
  } catch {
    scope = baseUrl;
  }
  const readable = scope.replace(UNSAFE_KEY_CHARS_V1, '_').slice(0, 64);
  return `${STORAGE_KEY_PREFIX_V1}.${readable}.${fnv1a32V1(scope)}`;
}

export type SessionStatusV1 = 'signedOut' | 'signedIn';

export interface SessionSnapshotV1 {
  readonly status: SessionStatusV1;
  readonly accessTokenExpiresAt?: string;
}

export interface SessionManagerV1 {
  /** Load a persisted session at startup (native secure store only). */
  restore(): Promise<SessionSnapshotV1>;
  /** Adopt freshly exchanged tokens after the PKCE sign-in completes. */
  completeSignIn(tokens: SessionTokensV1): Promise<SessionSnapshotV1>;
  /** Current access token, refreshed ahead of expiry; null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Revoke server-side, then clear local state. */
  signOut(): Promise<void>;
  snapshot(): SessionSnapshotV1;
  /** Notify on status changes (screens subscribe through the app store). */
  onChange(listener: (snapshot: SessionSnapshotV1) => void): () => void;
}

export interface CreateSessionManagerOptionsV1 {
  /** The auth endpoints used for refresh/revoke; injected to avoid a cycle. */
  readonly client: Pick<ControlPlaneClientV1, 'refresh' | 'revoke'>;
  readonly tokenStore: SecureTokenStoreV1;
  /**
   * Control-plane origin these tokens belong to; scopes the storage key so a
   * session is never restored against a different server. Defaults to the
   * unscoped legacy key only when absent (tests that construct a manager
   * directly), never in app composition.
   */
  readonly baseUrl?: string;
  readonly now?: () => Date;
  /** Refresh when within this window of expiry (default 60s). */
  readonly refreshSkewMs?: number;
}

export function createSessionManagerV1(options: CreateSessionManagerOptionsV1): SessionManagerV1 {
  const now = options.now ?? ((): Date => new Date());
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
  const storageKey =
    options.baseUrl === undefined ? STORAGE_KEY_PREFIX_V1 : sessionStorageKeyV1(options.baseUrl);
  const listeners = new Set<(snapshot: SessionSnapshotV1) => void>();

  let tokens: SessionTokensV1 | undefined;
  let refreshInFlight: Promise<string | null> | undefined;

  function snapshot(): SessionSnapshotV1 {
    return tokens === undefined
      ? { status: 'signedOut' }
      : { status: 'signedIn', accessTokenExpiresAt: tokens.accessTokenExpiresAt };
  }

  function notify(): void {
    const current = snapshot();
    for (const listener of listeners) {
      listener(current);
    }
  }

  async function persist(): Promise<void> {
    if (tokens === undefined) {
      await options.tokenStore.remove(storageKey);
    } else {
      await options.tokenStore.set(storageKey, JSON.stringify(tokens));
    }
  }

  async function clearLocal(): Promise<void> {
    tokens = undefined;
    await persist();
    notify();
  }

  function needsRefresh(): boolean {
    if (tokens === undefined) {
      return true;
    }
    return Date.parse(tokens.accessTokenExpiresAt) - now().getTime() <= refreshSkewMs;
  }

  async function refreshNow(): Promise<string | null> {
    if (tokens === undefined) {
      return null;
    }
    const result = await options.client.refresh(tokens.refreshToken);
    if (!result.ok) {
      // Rotation reuse or family revocation: fail closed, sign out locally.
      await clearLocal();
      return null;
    }
    tokens = result.body;
    await persist();
    notify();
    return tokens.accessToken;
  }

  return {
    async restore(): Promise<SessionSnapshotV1> {
      const stored = await options.tokenStore.get(storageKey);
      if (stored !== null) {
        try {
          const parsed = JSON.parse(stored) as SessionTokensV1;
          // refreshToken is absent on web (cookie-delivered, Part 6): only
          // reject when present but not a string — actual corruption.
          if (
            typeof parsed.accessToken === 'string' &&
            (parsed.refreshToken === undefined || typeof parsed.refreshToken === 'string') &&
            typeof parsed.accessTokenExpiresAt === 'string'
          ) {
            tokens = parsed;
            notify();
          }
        } catch {
          await options.tokenStore.remove(storageKey);
        }
      }
      if (tokens === undefined) {
        // Web has nothing to read: by the Part 6 storage policy its refresh
        // token is never in the app's hands, it lives in an HttpOnly cookie
        // the browser replays for us. So "no stored tokens" does not mean
        // "signed out" there — it means the only way to find out is to ask.
        // `refreshNow` cannot do this: it returns early precisely when
        // `tokens` is undefined, which is the state every reload starts in.
        //
        // On native this costs one rejected request on a genuinely
        // signed-out start, which is cheaper than the alternative of
        // branching on platform here.
        const result = await options.client.refresh(undefined);
        if (result.ok) {
          tokens = result.body;
          await persist();
          notify();
        }
      }
      // Publish the OUTCOME, including "still signed out". Notifying only on
      // success let a stale signed-in state survive a failed restore: the app
      // store is global while managers are per-origin, so pointing at a new
      // control plane built a manager with no token while the store still
      // carried the old server's `signedIn`. Screens then hid sign-in and
      // issued unauthorized requests, recoverable only by signing out by hand.
      // Notifying unconditionally is idempotent — listeners assign a snapshot.
      notify();
      return snapshot();
    },

    async completeSignIn(next: SessionTokensV1): Promise<SessionSnapshotV1> {
      tokens = next;
      await persist();
      notify();
      return snapshot();
    },

    async getAccessToken(): Promise<string | null> {
      if (tokens === undefined) {
        return null;
      }
      if (!needsRefresh()) {
        return tokens.accessToken;
      }
      // Single-flight: concurrent callers share one rotation, because a
      // rotated refresh token replayed by a second caller would trip the
      // server's reuse detection and revoke the whole family.
      refreshInFlight ??= refreshNow().finally(() => {
        refreshInFlight = undefined;
      });
      return refreshInFlight;
    },

    async signOut(): Promise<void> {
      if (tokens !== undefined) {
        await options.client.revoke();
      }
      await clearLocal();
    },

    snapshot,

    onChange(listener: (next: SessionSnapshotV1) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
