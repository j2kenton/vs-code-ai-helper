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
import { createInMemoryTokenStoreV1, createSessionManagerV1 } from '../src/auth/sessionManagerV1';

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

  const corruptStore = createInMemoryTokenStoreV1();
  await corruptStore.set('ensemble.session.v1', '{not json');
  const corruptManager = createSessionManagerV1({
    client,
    tokenStore: corruptStore,
    now: () => new Date(BASE_MS),
  });
  assert.equal((await corruptManager.restore()).status, 'signedOut');
  assert.equal(await corruptStore.get('ensemble.session.v1'), null);
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
