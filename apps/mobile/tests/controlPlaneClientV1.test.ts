/**
 * Behavioral tests for the typed control-plane client: bearer-only
 * authentication (local typed 401 without a network call when signed out),
 * typed-error surfacing, network-failure mapping, and path encoding for the
 * read-only file endpoints.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createControlPlaneClientV1 } from '../src/api/controlPlaneClientV1';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly credentials: RequestCredentials | undefined;
}

function fakeFetch(
  respond: (request: RecordedRequest) => Response
): { readonly requests: RecordedRequest[]; readonly fetchImpl: typeof fetch } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
      credentials: init?.credentials,
    };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

test('authorized calls carry the bearer token from the session seam', async () => {
  const { requests, fetchImpl } = fakeFetch(() => json(200, []));
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com/',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
  });
  const result = await client.listTasks();
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://cp.example.com/v1/tasks');
  assert.equal(requests[0]?.headers['authorization'], 'Bearer token-1');
});

test('a signed-out caller gets a local typed 401 with no network call', async () => {
  const { requests, fetchImpl } = fakeFetch(() => json(200, []));
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve(null),
    fetchImpl,
  });
  const result = await client.listTasks();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'unauthorized');
  assert.equal(requests.length, 0);
});

test('auth exchange and refresh do not require a session token', async () => {
  const { requests, fetchImpl } = fakeFetch(() =>
    json(200, {
      accessToken: 'a',
      accessTokenExpiresAt: '2026-08-12T01:00:00.000Z',
      refreshToken: 'r',
    })
  );
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve(null),
    fetchImpl,
  });
  const exchanged = await client.exchange({
    provider: 'github',
    authorizationCode: 'code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'ensemble://auth/callback',
  });
  assert.equal(exchanged.ok, true);
  const refreshed = await client.refresh('r');
  assert.equal(refreshed.ok, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers['authorization'], undefined);
    // Native (the default): no web-cookie transport hint, no credentials.
    assert.equal(request.headers['x-ensemble-platform'], undefined);
    assert.equal(request.credentials, undefined);
  }
});

test('web platform: auth routes send the cookie transport hint and credentials, other routes do not', async () => {
  const { requests, fetchImpl } = fakeFetch(() =>
    json(200, { accessToken: 'a', accessTokenExpiresAt: '2026-08-12T01:00:00.000Z' })
  );
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
    platform: 'web',
  });

  await client.exchange({
    provider: 'github',
    authorizationCode: 'code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'https://app.example.com/auth/callback',
  });
  await client.refresh();
  await client.revoke();
  await client.listTasks();

  const [exchangeReq, refreshReq, revokeReq, listReq] = requests;
  for (const request of [exchangeReq, refreshReq, revokeReq]) {
    assert.equal(request?.headers['x-ensemble-platform'], 'web');
    assert.equal(request?.credentials, 'include');
  }
  // refreshToken is omitted (undefined) on web: JSON.stringify drops it, so
  // the body carries no refresh-token field at all — nothing to leak.
  assert.equal(refreshReq?.body, '{}');
  // Non-auth routes are unaffected: no cookie hint, no forced credentials.
  assert.equal(listReq?.headers['x-ensemble-platform'], undefined);
  assert.equal(listReq?.credentials, undefined);
});

test('typed error bodies surface their code and message', async () => {
  const { fetchImpl } = fakeFetch(() =>
    json(422, { code: 'sandboxBindingInvalid', message: 'provider must be "e2b" or "daytona"' })
  );
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
  });
  const result = await client.createTask({
    request: 'do the thing',
    sandboxBinding: {
      provider: 'e2b',
      // No sandboxId: a task-owned sandbox is created by the control plane,
      // which assigns the id.
      source: { kind: 'gitClone', repoUrl: 'https://example.com/r.git', ref: 'main' },
      workingDirectoryRoot: '/workspace',
      lifecycle: 'task-owned-ephemeral',
      cleanup: 'destroy-on-completion',
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 422);
    assert.equal(result.code, 'sandboxBindingInvalid');
    assert.equal(result.message, 'provider must be "e2b" or "daytona"');
  }
});

test('a non-JSON error response maps to requestFailed with its status', async () => {
  const { fetchImpl } = fakeFetch(() => new Response('gateway timeout', { status: 504 }));
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
  });
  const result = await client.listTasks();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 504);
    assert.equal(result.code, 'requestFailed');
  }
});

test('a thrown fetch maps to the typed networkUnavailable result', async () => {
  const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch;
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
  });
  const result = await client.listTasks();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 0);
    assert.equal(result.code, 'networkUnavailable');
    assert.equal(result.message, 'offline');
  }
});

test('file and gate paths are URL-encoded and gate decisions post their key', async () => {
  const { requests, fetchImpl } = fakeFetch((request) =>
    request.method === 'POST'
      ? json(200, { gateId: 'g 1', state: 'approved', decidedAt: 'now', replayed: false })
      : json(200, { path: 'src/a b.ts', text: '' })
  );
  const client = createControlPlaneClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve('token-1'),
    fetchImpl,
  });
  await client.getFile('task/1', 'src/a b.ts');
  assert.equal(
    requests[0]?.url,
    'https://cp.example.com/v1/tasks/task%2F1/file?path=src%2Fa%20b.ts'
  );
  const decision = await client.decideGate('g 1', {
    decision: 'approve',
    idempotencyKey: 'key-1',
  });
  assert.equal(decision.ok, true);
  assert.equal(requests[1]?.url, 'https://cp.example.com/v1/gates/g%201/decision');
  assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), {
    decision: 'approve',
    idempotencyKey: 'key-1',
  });
});
