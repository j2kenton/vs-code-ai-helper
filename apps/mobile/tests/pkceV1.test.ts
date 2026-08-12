/**
 * Behavioral tests for the PKCE core (plan Part 6): base64url encoding,
 * S256 challenge generation against the RFC 7636 appendix-B vector, and
 * per-provider authorize-URL construction (nonce present for OIDC
 * providers, absent for plain-OAuth GitHub). These are the CSRF-sensitive
 * pure pieces of the client half of the trust boundary.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  base64UrlEncodeV1,
  buildAuthorizeUrlV1,
  createWebCryptoPkceV1,
  generatePkcePairV1,
  type PkceCryptoV1,
  type PkcePairV1,
} from '../src/auth/pkceV1';

function deterministicCrypto(seed: number): PkceCryptoV1 {
  let counter = seed;
  return {
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        counter = (counter * 31 + 7) % 251;
        bytes[index] = counter;
      }
      return bytes;
    },
    sha256(data: Uint8Array): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array(createHash('sha256').update(data).digest()));
    },
  };
}

test('base64UrlEncodeV1 matches RFC 4648 base64url (no padding) for all tail lengths', () => {
  for (let length = 0; length <= 33; length += 1) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (index * 37 + length) % 256;
    }
    assert.equal(base64UrlEncodeV1(bytes), Buffer.from(bytes).toString('base64url'));
  }
});

test('S256 challenge matches the RFC 7636 appendix-B vector', async () => {
  // Appendix B: this verifier must hash to this challenge.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const crypto = deterministicCrypto(1);
  const digest = await crypto.sha256(new TextEncoder().encode(verifier));
  assert.equal(base64UrlEncodeV1(digest), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('generatePkcePairV1 derives the challenge from the verifier via S256', async () => {
  const pair = await generatePkcePairV1(deterministicCrypto(3));
  // 48 random bytes -> 64 base64url chars, all in the URL-safe alphabet.
  assert.equal(pair.codeVerifier.length, 64);
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]+$/);
  const expected = Buffer.from(
    createHash('sha256').update(pair.codeVerifier, 'ascii').digest()
  ).toString('base64url');
  assert.equal(pair.codeChallenge, expected);
  assert.notEqual(pair.state, pair.nonce);
  assert.match(pair.state, /^[A-Za-z0-9_-]+$/);
});

test('createWebCryptoPkceV1 produces the same S256 digest as node crypto', async () => {
  const webCrypto = createWebCryptoPkceV1();
  const input = new TextEncoder().encode('ensemble-pkce-parity');
  const viaWeb = await webCrypto.sha256(input);
  const viaNode = new Uint8Array(createHash('sha256').update(input).digest());
  assert.deepEqual(Array.from(viaWeb), Array.from(viaNode));
});

const FIXED_PAIR: PkcePairV1 = {
  codeVerifier: 'verifier-not-sent-to-provider',
  codeChallenge: 'challenge-value',
  state: 'state-value',
  nonce: 'nonce-value',
};

test('buildAuthorizeUrlV1 includes the nonce for OIDC providers only', () => {
  for (const provider of ['google', 'apple'] as const) {
    const url = new URL(
      buildAuthorizeUrlV1({
        provider,
        clientId: 'client-1',
        redirectUri: 'ensemble://auth/callback',
        pkce: FIXED_PAIR,
      })
    );
    assert.equal(url.searchParams.get('nonce'), 'nonce-value', provider);
  }
  const github = new URL(
    buildAuthorizeUrlV1({
      provider: 'github',
      clientId: 'client-1',
      redirectUri: 'ensemble://auth/callback',
      pkce: FIXED_PAIR,
    })
  );
  assert.equal(github.searchParams.get('nonce'), null);
  assert.equal(github.origin + github.pathname, 'https://github.com/login/oauth/authorize');
});

test('buildAuthorizeUrlV1 carries the code flow, S256 challenge, state, and redirect', () => {
  const url = new URL(
    buildAuthorizeUrlV1({
      provider: 'google',
      clientId: 'client-2',
      redirectUri: 'https://app.example.com/auth/callback',
      pkce: FIXED_PAIR,
    })
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('client_id'), 'client-2');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid');
  // The verifier is a client-side secret: it must never appear in the URL.
  assert.equal(url.toString().includes('verifier-not-sent-to-provider'), false);
});
