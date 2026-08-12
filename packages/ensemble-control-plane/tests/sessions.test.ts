/**
 * The trust boundary + session lifecycle (plan Parts 5/6; criteria 8/9):
 *
 * - OIDC validator: real RS256 JWKS verification with issuer / audience /
 *   expiry / nonce checks, every failure fail-closed;
 * - GitHub validator: server-side code exchange + user-API verification;
 * - identity keyed by stable (provider, provider-subject-id) — never email;
 * - forged/unvalidated identity assertions rejected;
 * - short-lived access tokens, rotating refresh tokens, reuse detection
 *   revoking the family, sign-out revocation, expiry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { FetchLikeV1 } from "../../ensemble-engine/src/providerAdaptersV1";
import {
  createGitHubIdentityValidatorV1,
  createOidcIdentityValidatorV1,
  IdentityValidationErrorV1,
} from "../src/identityValidatorsV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { makeClock, makeFakeValidator } from "./helpersV1";

const NOW_ISO = "2026-08-12T00:00:00.000Z";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "kid-1" };

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeIdToken(
  payloadOverrides: Record<string, unknown>,
  options?: { readonly signWithRogueKey?: boolean }
): string {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "kid-1" }), "utf8"));
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        iss: "https://accounts.example",
        aud: "client-1",
        sub: "subject-1",
        exp: Math.floor(Date.parse(NOW_ISO) / 1000) + 3600,
        nonce: "nonce-1",
        ...payloadOverrides,
      }),
      "utf8"
    )
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`, "utf8")
    .sign(options?.signWithRogueKey === true ? rogue.privateKey : rsa.privateKey);
  return `${header}.${payload}.${base64Url(signature)}`;
}

function oidcFetch(idToken: string): FetchLikeV1 {
  return (url: string): Promise<{ status: number; text(): Promise<string> }> => {
    if (url === "https://accounts.example/token") {
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id_token: idToken })),
      });
    }
    if (url === "https://accounts.example/jwks") {
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ keys: [jwk] })),
      });
    }
    return Promise.resolve({ status: 404, text: () => Promise.resolve("") });
  };
}

function oidcValidator(idToken: string) {
  return createOidcIdentityValidatorV1({
    provider: "google",
    fetch: oidcFetch(idToken),
    clientId: "client-1",
    tokenEndpoint: "https://accounts.example/token",
    jwksUri: "https://accounts.example/jwks",
    issuer: "https://accounts.example",
    now: makeClock(NOW_ISO).now,
  });
}

const EXCHANGE_REQUEST = {
  provider: "google" as const,
  authorizationCode: "code-1",
  codeVerifier: "verifier-1",
  redirectUri: "app://callback",
  nonce: "nonce-1",
};

test("OIDC: a well-formed ID token verifies and yields the (provider, subject) identity", async () => {
  const identity = await oidcValidator(makeIdToken({})).validate(EXCHANGE_REQUEST);
  assert.deepEqual(identity, { provider: "google", providerSubjectId: "subject-1" });
});

test("OIDC: signature, issuer, audience, expiry, and nonce failures all reject", async () => {
  const cases: readonly [string, string][] = [
    ["bad signature", makeIdToken({}, { signWithRogueKey: true })],
    ["wrong issuer", makeIdToken({ iss: "https://evil.example" })],
    ["wrong audience", makeIdToken({ aud: "someone-else" })],
    ["expired", makeIdToken({ exp: Math.floor(Date.parse(NOW_ISO) / 1000) - 60 })],
    ["nonce mismatch", makeIdToken({ nonce: "different-nonce" })],
  ];
  for (const [label, token] of cases) {
    await assert.rejects(
      oidcValidator(token).validate(EXCHANGE_REQUEST),
      IdentityValidationErrorV1,
      label
    );
  }
  // A request without the client's nonce cannot validate at all.
  const { nonce: _nonce, ...withoutNonce } = EXCHANGE_REQUEST;
  await assert.rejects(
    oidcValidator(makeIdToken({})).validate(withoutNonce),
    IdentityValidationErrorV1
  );
});

test("GitHub: server-side exchange + user-API verification; failures reject", async () => {
  const fetchOk: FetchLikeV1 = (url, init) => {
    if (url === "https://github.example/token") {
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "gho_once" })),
      });
    }
    if (url === "https://github.example/user") {
      // The exchanged token is presented server-side, exactly once.
      assert.equal(init.headers["authorization"], "Bearer gho_once");
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id: 4242, email: "ignored@example.com" })),
      });
    }
    return Promise.resolve({ status: 404, text: () => Promise.resolve("") });
  };
  const validator = createGitHubIdentityValidatorV1({
    fetch: fetchOk,
    clientId: "client-1",
    clientSecret: "server-secret",
    tokenEndpoint: "https://github.example/token",
    userEndpoint: "https://github.example/user",
  });
  const identity = await validator.validate({
    provider: "github",
    authorizationCode: "code-1",
    codeVerifier: "verifier-1",
    redirectUri: "app://callback",
  });
  // The subject is the stable numeric id — never the email.
  assert.deepEqual(identity, { provider: "github", providerSubjectId: "4242" });

  const fetchNoToken: FetchLikeV1 = () =>
    Promise.resolve({ status: 401, text: () => Promise.resolve("{}") });
  const failing = createGitHubIdentityValidatorV1({
    fetch: fetchNoToken,
    clientId: "client-1",
    clientSecret: "server-secret",
    tokenEndpoint: "https://github.example/token",
    userEndpoint: "https://github.example/user",
  });
  await assert.rejects(
    failing.validate({
      provider: "github",
      authorizationCode: "bad",
      codeVerifier: "v",
      redirectUri: "app://callback",
    }),
    IdentityValidationErrorV1
  );
});

function makeService(clock = makeClock(NOW_ISO)) {
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [
      makeFakeValidator("github", { "code-a": "subject-a", "code-b": "subject-b" }),
      makeFakeValidator("google", { "code-g": "subject-a" }),
    ],
    now: clock.now,
    accessTtlMs: 15 * 60 * 1000,
  });
  return { store, sessions, clock };
}

const BASE = {
  authorizationCode: "code-a",
  codeVerifier: "v",
  redirectUri: "app://callback",
};

test("identity is keyed by (provider, subject): same pair → same user; same subject on another provider → different user", async () => {
  const { sessions } = makeService();
  const first = await sessions.exchange({ provider: "github", ...BASE });
  const again = await sessions.exchange({ provider: "github", ...BASE });
  const other = await sessions.exchange({ provider: "google", ...BASE, authorizationCode: "code-g" });
  assert.ok(first.ok && again.ok && other.ok);
  assert.equal(first.userId, again.userId);
  assert.notEqual(first.userId, other.userId);
});

test("forged identity assertions are rejected: bad codes fail exchange, fabricated bearers do not authenticate", async () => {
  const { sessions } = makeService();
  const forged = await sessions.exchange({ provider: "github", ...BASE, authorizationCode: "evil" });
  assert.deepEqual(
    { ok: forged.ok, code: forged.ok ? "" : forged.code },
    { ok: false, code: "identityValidationFailed" }
  );
  assert.equal(await sessions.authenticate(`cpat_${"0".repeat(48)}`), undefined);
});

test("refresh rotates; reusing a rotated refresh token revokes the WHOLE family", async () => {
  const { sessions } = makeService();
  const exchange = await sessions.exchange({ provider: "github", ...BASE });
  assert.ok(exchange.ok);
  const rotated = await sessions.refresh(exchange.tokens.refreshToken);
  assert.ok(rotated.ok);
  assert.notEqual(rotated.tokens.refreshToken, exchange.tokens.refreshToken);
  assert.deepEqual(await sessions.authenticate(rotated.tokens.accessToken), {
    userId: exchange.userId,
  });

  // REUSE of the already-rotated token: typed error + family revocation.
  const reused = await sessions.refresh(exchange.tokens.refreshToken);
  assert.deepEqual(
    { ok: reused.ok, code: reused.ok ? "" : reused.code },
    { ok: false, code: "refreshTokenReused" }
  );
  assert.equal(await sessions.authenticate(rotated.tokens.accessToken), undefined);
  const successor = await sessions.refresh(rotated.tokens.refreshToken);
  assert.equal(successor.ok, false);
});

test("sign-out revokes the session: neither the access nor the refresh token survives", async () => {
  const { sessions } = makeService();
  const exchange = await sessions.exchange({ provider: "github", ...BASE });
  assert.ok(exchange.ok);
  assert.equal(await sessions.revokeByAccessToken(exchange.tokens.accessToken), true);
  assert.equal(await sessions.authenticate(exchange.tokens.accessToken), undefined);
  const refreshAfter = await sessions.refresh(exchange.tokens.refreshToken);
  assert.equal(refreshAfter.ok, false);
});

test("access tokens are short-lived: authentication fails past expiry", async () => {
  const { sessions, clock } = makeService();
  const exchange = await sessions.exchange({ provider: "github", ...BASE });
  assert.ok(exchange.ok);
  assert.notEqual(await sessions.authenticate(exchange.tokens.accessToken), undefined);
  clock.advance(16 * 60 * 1000);
  assert.equal(await sessions.authenticate(exchange.tokens.accessToken), undefined);
});
