/**
 * Regression coverage for the Part 6 AuthSession driver's pure seam
 * (`authSessionOutcomeV1.ts`). The state-mismatch defect this guards
 * against: `AuthRequest` was previously constructed without the
 * URL-embedded `state`, so it generated its own random state, and its
 * `parseReturnUrl` CSRF guard then rejected every real provider redirect
 * (the provider only ever echoes back the state it was sent) — sign-in
 * could never complete. `extractStateFromAuthorizeUrlV1` is what lets the
 * driver pass the SAME state into `AuthRequest`'s config.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAuthorizeUrlV1, type PkcePairV1 } from '../src/auth/pkceV1';
import {
  extractStateFromAuthorizeUrlV1,
  mapAuthSessionResultV1,
  type AuthSessionResultLikeV1,
} from '../src/auth/authSessionOutcomeV1';

const FIXED_PAIR: PkcePairV1 = {
  codeVerifier: 'verifier',
  codeChallenge: 'challenge',
  state: 'the-csrf-state',
  nonce: 'the-nonce',
};

test('extractStateFromAuthorizeUrlV1 recovers the exact state buildAuthorizeUrlV1 embedded', () => {
  const url = buildAuthorizeUrlV1({
    provider: 'google',
    clientId: 'client-1',
    redirectUri: 'ensemble://auth/callback',
    pkce: FIXED_PAIR,
  });
  assert.equal(extractStateFromAuthorizeUrlV1(url), 'the-csrf-state');
});

test('extractStateFromAuthorizeUrlV1 returns undefined when state is absent', () => {
  assert.equal(extractStateFromAuthorizeUrlV1('https://example.com/authorize?foo=bar'), undefined);
});

test('mapAuthSessionResultV1 maps a success result with code and state', () => {
  const result: AuthSessionResultLikeV1 = {
    type: 'success',
    params: { code: 'auth-code-1', state: 'the-csrf-state' },
  };
  assert.deepEqual(mapAuthSessionResultV1(result), {
    kind: 'success',
    code: 'auth-code-1',
    state: 'the-csrf-state',
  });
});

test('mapAuthSessionResultV1 reports unavailable when the redirect is missing code or state', () => {
  const missingCode: AuthSessionResultLikeV1 = { type: 'success', params: { state: 'x' } };
  const missingState: AuthSessionResultLikeV1 = { type: 'success', params: { code: 'x' } };
  assert.equal(mapAuthSessionResultV1(missingCode).kind, 'unavailable');
  assert.equal(mapAuthSessionResultV1(missingState).kind, 'unavailable');
});

test('mapAuthSessionResultV1 maps cancel and dismiss to cancelled', () => {
  assert.deepEqual(mapAuthSessionResultV1({ type: 'cancel' }), { kind: 'cancelled' });
  assert.deepEqual(mapAuthSessionResultV1({ type: 'dismiss' }), { kind: 'cancelled' });
});

test('mapAuthSessionResultV1 surfaces the error message, falling back to errorCode', () => {
  const withMessage: AuthSessionResultLikeV1 = {
    type: 'error',
    error: { message: 'state_mismatch' },
  };
  assert.deepEqual(mapAuthSessionResultV1(withMessage), {
    kind: 'unavailable',
    reason: 'state_mismatch',
  });
  const codeOnly: AuthSessionResultLikeV1 = { type: 'error', errorCode: 'access_denied' };
  assert.deepEqual(mapAuthSessionResultV1(codeOnly), {
    kind: 'unavailable',
    reason: 'access_denied',
  });
});

test('mapAuthSessionResultV1 reports unavailable for locked/opened intermediate states', () => {
  assert.equal(mapAuthSessionResultV1({ type: 'locked' }).kind, 'unavailable');
  assert.equal(mapAuthSessionResultV1({ type: 'opened' }).kind, 'unavailable');
});
