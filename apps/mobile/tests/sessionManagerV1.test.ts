/**
 * Behavioral tests for the client session lifecycle (plan Part 6):
 * single-flight refresh ahead of expiry (one rotation shared by concurrent
 * callers — a replayed rotated token would trip the server's reuse
 * detection), fail-closed local sign-out on refresh rejection, restore
 * round-trip, and revoke-on-sign-out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApiResultV1, SessionTokensV1 } from '../src/api/controlPlaneClientV1';
import {
  createInMemoryTokenStoreV1,
  createSessionManagerV1,
  type SecureTokenStoreV1,
} from '../src/auth/sessionManagerV1';

const BASE_MS = Date.parse('2026-08-12T00:00:00.000Z');

function tokens(suffix: string, expiresInMs: number): SessionTokensV1 {
  return {
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: new Date(BASE_MS + expiresInMs).toISOString(),
    refreshToken: `refresh-${suffix}`,
  };
}

interface FakeAuthClient {
  refreshCalls: Array<string | undefined>;
  revokeCalls: number;
  nextRefresh: () => Promise<ApiResultV1<SessionTokensV1>>;
  refresh(refreshToken?: string): Promise<ApiResultV1<SessionTokensV1>>;
  revoke(): Promise<ApiResultV1<undefined>>;
}

function fakeAuthClient(): FakeAuthClient {
  const client: FakeAuthClient = {
    refreshCalls: [],
    revokeCalls: 0,
    nextRefresh: () =>
      Promise.resolve({ ok: true, status: 200, body: tokens('rotated', 3_600_000) }),
    refresh(refreshToken?: string) {
      client.refreshCalls.push(refreshToken);
      return client.nextRefresh();
    },
    revoke() {
      client.revokeCalls += 1;
      return Promise.resolve({ ok: true, status: 204, body: undefined });
    },
  };
  return client;
}

test('a fresh access token is returned without any refresh call', async () => {
  const client = fakeAuthClient();
  const manager = createSessionManagerV1({
    client,
    tokenStore: createInMemoryTokenStoreV1(),
    now: () => new Date(BASE_MS),
  });
  await manager.completeSignIn(tokens('initial', 3_600_000));
  assert.equal(await manager.getAccessToken(), 'access-initial');
  assert.equal(client.refreshCalls.length, 0);
});

test('a near-expiry token refreshes and the rotated pair is persisted', async () => {
  const client = fakeAuthClient();
  const store = createInMemoryTokenStoreV1();
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  // Expires within the default 60s skew: must rotate.
  await manager.completeSignIn(tokens('stale', 30_000));
  assert.equal(await manager.getAccessToken(), 'access-rotated');
  assert.deepEqual(client.refreshCalls, ['refresh-stale']);
  const persisted = await store.get('ensemble.session.v1');
  assert.notEqual(persisted, null);
  assert.equal((JSON.parse(persisted as string) as SessionTokensV1).refreshToken, 'refresh-rotated');
});

test('concurrent callers share one single-flight rotation', async () => {
  const client = fakeAuthClient();
  let releaseRefresh: (result: ApiResultV1<SessionTokensV1>) => void = () => undefined;
  client.nextRefresh = () =>
    new Promise((resolve) => {
      releaseRefresh = resolve;
    });
  const manager = createSessionManagerV1({
    client,
    tokenStore: createInMemoryTokenStoreV1(),
    now: () => new Date(BASE_MS),
  });
  await manager.completeSignIn(tokens('stale', 10_000));
  const inFlight = [manager.getAccessToken(), manager.getAccessToken(), manager.getAccessToken()];
  releaseRefresh({ ok: true, status: 200, body: tokens('rotated', 3_600_000) });
  const results = await Promise.all(inFlight);
  assert.deepEqual(results, ['access-rotated', 'access-rotated', 'access-rotated']);
  assert.equal(client.refreshCalls.length, 1);
});

test('a rejected refresh fails closed: local sign-out, cleared store, null token', async () => {
  const client = fakeAuthClient();
  client.nextRefresh = () =>
    Promise.resolve({ ok: false, status: 401, code: 'refreshTokenReused', message: 'family revoked' });
  const store = createInMemoryTokenStoreV1();
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  await manager.completeSignIn(tokens('stale', 10_000));
  const statuses: string[] = [];
  manager.onChange((snapshot) => statuses.push(snapshot.status));
  assert.equal(await manager.getAccessToken(), null);
  assert.equal(manager.snapshot().status, 'signedOut');
  assert.equal(await store.get('ensemble.session.v1'), null);
  assert.deepEqual(statuses, ['signedOut']);
});

test('restore round-trips a persisted session and rejects corrupted state', async () => {
  const client = fakeAuthClient();
  const store = createInMemoryTokenStoreV1();
  await store.set('ensemble.session.v1', JSON.stringify(tokens('persisted', 3_600_000)));
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  const restored = await manager.restore();
  assert.equal(restored.status, 'signedIn');
  assert.equal(await manager.getAccessToken(), 'access-persisted');

  // Corrupt local state must not yield a session — but restore now also asks
  // the control plane whether a refresh cookie identifies one, so this half
  // needs a client that says no. Otherwise it asserts against the cookie path
  // rather than against corruption handling.
  const corruptStore = createInMemoryTokenStoreV1();
  await corruptStore.set('ensemble.session.v1', '{not json');
  const noCookieClient = fakeAuthClient();
  noCookieClient.nextRefresh = () =>
    Promise.resolve({
      ok: false,
      status: 401,
      code: 'refreshTokenInvalid',
      message: 'missing refresh cookie',
    });
  const corruptManager = createSessionManagerV1({
    client: noCookieClient,
    tokenStore: corruptStore,
    now: () => new Date(BASE_MS),
  });
  assert.equal((await corruptManager.restore()).status, 'signedOut');
  assert.equal(await corruptStore.get('ensemble.session.v1'), null);
});

/**
 * The web reload path. Nothing is in the token store — by policy the refresh
 * token never reaches the app there — so the only evidence of a live session
 * is the HttpOnly cookie the browser replays on the refresh call.
 */
test('restore adopts a cookie-backed session when nothing is stored locally', async () => {
  const client = fakeAuthClient();
  const store = createInMemoryTokenStoreV1();
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });

  assert.equal((await manager.restore()).status, 'signedIn');
  assert.equal(await manager.getAccessToken(), 'access-rotated');
});

test('restore stays signed out when no local tokens and no valid cookie exist', async () => {
  const client = fakeAuthClient();
  client.nextRefresh = () =>
    Promise.resolve({
      ok: false,
      status: 401,
      code: 'refreshTokenInvalid',
      message: 'missing refresh cookie',
    });
  const manager = createSessionManagerV1({
    client,
    tokenStore: createInMemoryTokenStoreV1(),
    now: () => new Date(BASE_MS),
  });

  assert.equal((await manager.restore()).status, 'signedOut');
  assert.equal(await manager.getAccessToken(), null);
});

test('signOut revokes server-side and clears local state', async () => {
  const client = fakeAuthClient();
  const store = createInMemoryTokenStoreV1();
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  await manager.completeSignIn(tokens('active', 3_600_000));
  await manager.signOut();
  assert.equal(client.revokeCalls, 1);
  assert.equal(manager.snapshot().status, 'signedOut');
  assert.equal(await store.get('ensemble.session.v1'), null);
  // Signing out while already signed out must not revoke again.
  await manager.signOut();
  assert.equal(client.revokeCalls, 1);
});

test('web sessions (no refreshToken field) still refresh and restore: the cookie carries it, not this manager', async () => {
  const webTokens = (suffix: string, expiresInMs: number): SessionTokensV1 => ({
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: new Date(BASE_MS + expiresInMs).toISOString(),
    // Deliberately absent: Part 6 delivers it as an HttpOnly cookie on web.
  });
  const client = fakeAuthClient();
  client.nextRefresh = () =>
    Promise.resolve({ ok: true, status: 200, body: webTokens('rotated', 3_600_000) });
  const store = createInMemoryTokenStoreV1();
  const manager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  await manager.completeSignIn(webTokens('stale', 30_000));
  assert.equal(await manager.getAccessToken(), 'access-rotated');
  // The manager calls refresh with `undefined` — nothing to send, the
  // browser attaches the HttpOnly cookie itself.
  assert.deepEqual(client.refreshCalls, [undefined]);
  const persisted = await store.get('ensemble.session.v1');
  assert.notEqual(persisted, null);
  assert.equal((JSON.parse(persisted as string) as SessionTokensV1).refreshToken, undefined);

  // restore() must accept an absent refreshToken as valid, not corrupted.
  const restoreManager = createSessionManagerV1({
    client,
    tokenStore: store,
    now: () => new Date(BASE_MS),
  });
  const restored = await restoreManager.restore();
  assert.equal(restored.status, 'signedIn');
});

// ─── Origin-scoped storage keys ─────────────────────────────────────────

/** Records every key the manager touches, so the key itself can be asserted. */
function keyRecordingStore(): { store: SecureTokenStoreV1; keys: string[] } {
  const values = new Map<string, string>();
  const keys: string[] = [];
  return {
    keys,
    store: {
      get(key) {
        keys.push(key);
        return Promise.resolve(values.get(key) ?? null);
      },
      set(key, value) {
        keys.push(key);
        values.set(key, value);
        return Promise.resolve();
      },
      remove(key) {
        keys.push(key);
        values.delete(key);
        return Promise.resolve();
      },
    },
  };
}

test('every storage key is legal for expo-secure-store', async () => {
  // SecureStore accepts ONLY alphanumerics, '.', '-' and '_', and rejects the
  // key outright otherwise. Every real origin contains ':' and '/', so a key
  // built from a raw origin would throw on every native read and write —
  // breaking sign-in and restore completely.
  const client = fakeAuthClient();
  for (const baseUrl of [
    'https://control-plane.example.com',
    'http://localhost:8787',
    'http://127.0.0.1:8787/',
    'https://user:pass@host.example.com:9443/deep/path?q=1#frag',
    'not a url at all',
  ]) {
    const recorder = keyRecordingStore();
    const manager = createSessionManagerV1({
      client,
      tokenStore: recorder.store,
      baseUrl,
      now: () => new Date(BASE_MS),
    });
    await manager.completeSignIn(tokens('initial', 3_600_000));
    await manager.restore();
    assert.ok(recorder.keys.length > 0, `no key was used for ${baseUrl}`);
    for (const key of recorder.keys) {
      assert.match(key, /^[A-Za-z0-9._-]+$/, `illegal SecureStore key for ${baseUrl}: ${key}`);
    }
  }
});

test('tokens stored for one control plane are never restored against another', async () => {
  // The leak this prevents: switching the control-plane URL builds a new
  // manager, and a shared key would hand the PREVIOUS server's still-valid
  // token to the new origin as a bearer.
  const client = fakeAuthClient();
  client.nextRefresh = () =>
    Promise.resolve({ ok: false, status: 401, code: 'unauthorized', message: 'no session' });
  const recorder = keyRecordingStore();

  const first = createSessionManagerV1({
    client,
    tokenStore: recorder.store,
    baseUrl: 'https://alpha.example.com',
    now: () => new Date(BASE_MS),
  });
  await first.completeSignIn(tokens('alpha', 3_600_000));

  const second = createSessionManagerV1({
    client,
    tokenStore: recorder.store,
    baseUrl: 'https://beta.example.com',
    now: () => new Date(BASE_MS),
  });
  assert.equal((await second.restore()).status, 'signedOut');
  assert.equal(await second.getAccessToken(), null);

  // The same origin still recovers its own session (a port is part of it).
  const again = createSessionManagerV1({
    client,
    tokenStore: recorder.store,
    baseUrl: 'https://alpha.example.com/some/path',
    now: () => new Date(BASE_MS),
  });
  assert.equal((await again.restore()).status, 'signedIn');
  assert.equal(await again.getAccessToken(), 'access-alpha');
});
