/**
 * Wire-level CORS tests for the node adapter (plan Part 6 web-cookie flow):
 * the web client's `credentials: 'include'` cookie round-trip only works
 * cross-origin if the server echoes a specific allowlisted origin (never a
 * wildcard) with `Access-Control-Allow-Credentials`, and answers the
 * browser's OPTIONS preflight directly. These exercise `node:http` against
 * a live `createControlPlaneNodeServerV1` instance, mirroring the pattern in
 * `wsTransport.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createControlPlaneHandlerV1, createControlPlaneNodeServerV1 } from "../src/controlPlaneServerV1";
import { createBootSecretKekProviderV1 } from "../src/keyCustodyV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { createInMemorySandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import { createWsHubV1 } from "../src/wsHubV1";
import { makeClock, makeFakeValidator } from "./helpersV1";

const ALLOWED_ORIGIN = "https://app.example.com";

interface CorsWorld {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

async function makeCorsWorld(corsOrigins: readonly string[]): Promise<CorsWorld> {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: clock.now,
  });
  const hub = createWsHubV1({ sessions, store });
  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub,
    kekProvider: createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" }),
    sandboxFactory: { clientFor: () => createInMemorySandboxClientV1() },
    now: clock.now,
  });
  const server: Server = createControlPlaneNodeServerV1(handler, { corsOrigins });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const exchanged = await sessions.exchange({
    provider: "github",
    authorizationCode: "code-a",
    codeVerifier: "v",
    redirectUri: "app://callback",
  });
  assert.ok(exchanged.ok);
  return {
    port: address.port,
    token: exchanged.tokens.accessToken,
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      response.resume();
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("a GET from an allowlisted origin gets a specific Allow-Origin + Allow-Credentials", async () => {
  const world = await makeCorsWorld([ALLOWED_ORIGIN]);
  try {
    const response = await rawRequest(world.port, "GET", "/v1/tasks", {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${world.token}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
    assert.equal(response.headers.vary, "Origin");
  } finally {
    await world.close();
  }
});

test("a GET from a non-allowlisted origin carries no CORS headers", async () => {
  const world = await makeCorsWorld([ALLOWED_ORIGIN]);
  try {
    const response = await rawRequest(world.port, "GET", "/v1/tasks", {
      origin: "https://evil.example.com",
      authorization: `Bearer ${world.token}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  } finally {
    await world.close();
  }
});

test("an OPTIONS preflight from an allowlisted origin is answered directly with 204", async () => {
  const world = await makeCorsWorld([ALLOWED_ORIGIN]);
  try {
    const response = await rawRequest(world.port, "OPTIONS", "/v1/tasks", {
      origin: ALLOWED_ORIGIN,
      "access-control-request-method": "POST",
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
    assert.equal(response.headers["access-control-allow-credentials"], "true");
    assert.ok(
      String(response.headers["access-control-allow-methods"] ?? "").includes("POST")
    );
    assert.ok(
      String(response.headers["access-control-allow-headers"] ?? "").includes("x-ensemble-platform")
    );
  } finally {
    await world.close();
  }
});

test("with no corsOrigins configured, responses carry no CORS headers regardless of Origin", async () => {
  const world = await makeCorsWorld([]);
  try {
    const response = await rawRequest(world.port, "GET", "/v1/tasks", {
      origin: ALLOWED_ORIGIN,
      authorization: `Bearer ${world.token}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await world.close();
  }
});
