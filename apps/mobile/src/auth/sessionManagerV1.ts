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

const STORAGE_KEY_V1 = 'ensemble.session.v1';

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
  readonly now?: () => Date;
  /** Refresh when within this window of expiry (default 60s). */
  readonly refreshSkewMs?: number;
}

export function createSessionManagerV1(options: CreateSessionManagerOptionsV1): SessionManagerV1 {
  const now = options.now ?? ((): Date => new Date());
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
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
      await options.tokenStore.remove(STORAGE_KEY_V1);
    } else {
      await options.tokenStore.set(STORAGE_KEY_V1, JSON.stringify(tokens));
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
      const stored = await options.tokenStore.get(STORAGE_KEY_V1);
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
          await options.tokenStore.remove(STORAGE_KEY_V1);
        }
      }
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
