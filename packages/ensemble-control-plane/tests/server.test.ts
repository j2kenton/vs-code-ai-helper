/**
 * Contract tests for the Part 3 reference server (plan Part 5; criteria
 * 1/3/5/8): bearer-only authentication, cross-user denial across tasks /
 * gates / files / diffs / keys, typed SandboxBinding errors (no unbound
 * execution path), the gate idempotency HTTP mapping, full path confinement
 * on the read-only file endpoints (lexical + provider resolve-then-check,
 * symlinks included), chat-answer idempotency, and write-only key custody
 * with masked metadata.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import {
  createInMemorySandboxClientV1,
  InMemorySandboxClientV1,
} from "../../ensemble-engine/src/sandboxClientV1";
import type { SandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import {
  ControlPlaneHandlerV1,
  ControlPlaneHttpRequestV1,
  createControlPlaneHandlerV1,
} from "../src/controlPlaneServerV1";
import { createBootSecretKekProviderV1, createUnavailableKekProviderV1 } from "../src/keyCustodyV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { createWsHubV1 } from "../src/wsHubV1";
import { makeClock, makeFakeValidator } from "./helpersV1";

const BASE = { codeVerifier: "v", redirectUri: "app://callback" };

const VALID_BINDING = {
  provider: "e2b",
  sandboxId: "sbx-1",
  source: { kind: "attachExisting", path: "/workspace" },
  workingDirectoryRoot: "/workspace",
  lifecycle: "user-managed-persistent",
  cleanup: "retain",
};

interface World {
  readonly handler: ControlPlaneHandlerV1;
  readonly sandbox: InMemorySandboxClientV1;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly userA: string;
  readonly store: ReturnType<typeof createControlPlaneStoreV1>;
  call(
    token: string | undefined,
    method: string,
    path: string,
    options?: {
      readonly query?: Record<string, string>;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  ): Promise<{ status: number; body?: unknown; headers?: Readonly<Record<string, string>> }>;
}

async function makeWorld(options?: {
  readonly kekDown?: boolean;
  readonly log?: (line: string) => void;
  readonly allowEphemeralSandboxWithoutRunHost?: boolean;
}): Promise<World> {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a", "code-b": "subject-b" })],
    now: clock.now,
  });
  const hub = createWsHubV1({ sessions, store });
  const sandbox = createInMemorySandboxClientV1();
  sandbox.addDirectory("sbx-1", "/workspace/src");
  sandbox.addFile("sbx-1", "/workspace/src/app.ts", "export const app = 1;\n");
  sandbox.addFile("sbx-1", "/etc/secret", "outside the root");
  sandbox.addSymlink("sbx-1", "/workspace/escape", "/etc/secret");
  const kekProvider = options?.kekDown === true
    ? createUnavailableKekProviderV1("kek-1")
    : createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" });
  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub,
    kekProvider,
    sandboxFactory: { clientFor: (): SandboxClientV1 => sandbox },
    now: clock.now,
    ...(options?.allowEphemeralSandboxWithoutRunHost === true
      ? { allowEphemeralSandboxWithoutRunHost: true }
      : {}),
    ...(options?.log !== undefined ? { log: options.log } : {}),
  });
  const a = await sessions.exchange({ provider: "github", authorizationCode: "code-a", ...BASE });
  const b = await sessions.exchange({ provider: "github", authorizationCode: "code-b", ...BASE });
  assert.ok(a.ok && b.ok);
  return {
    handler,
    sandbox,
    store,
    tokenA: a.tokens.accessToken,
    tokenB: b.tokens.accessToken,
    userA: a.userId,
    call(token, method, path, callOptions) {
      const request: ControlPlaneHttpRequestV1 = {
        method,
        path,
        query: callOptions?.query ?? {},
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...callOptions?.headers,
        },
        ...(callOptions?.body !== undefined ? { body: callOptions.body } : {}),
      };
      return handler.handle(request);
    },
  };
}

async function storeKeyAndCreateTask(world: World): Promise<string> {
  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: "e2b_live_key_A_9876" },
  });
  assert.equal(put.status, 204);
  const created = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", displayName: "Demo", sandboxBinding: VALID_BINDING },
  });
  assert.equal(created.status, 201);
  const body = created.body as { taskId: string; ownerUserId: string };
  assert.equal(body.ownerUserId, world.userA);
  return body.taskId;
}

/** A task-owned binding: names no sandbox, so the server must allocate one. */
const EPHEMERAL_BINDING = {
  provider: "e2b",
  source: { kind: "attachExisting", path: "/workspace" },
  workingDirectoryRoot: "/workspace",
  lifecycle: "task-owned-ephemeral",
  cleanup: "destroy-on-completion",
};

async function storeSandboxKey(world: World): Promise<void> {
  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: "e2b_live_key_A_9876" },
  });
  assert.equal(put.status, 204);
}

test("a task-owned sandbox is refused outright when the deployment has no engine run host", async () => {
  // Creating one would allocate a BILLABLE sandbox that nothing can drive:
  // no run host means source is never acquired, the task never leaves
  // `creating`, and teardown — which honours destroy-on-completion — is never
  // called. Refusing costs the user nothing; allocating costs them money.
  const world = await makeWorld();
  await storeSandboxKey(world);

  const created = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: EPHEMERAL_BINDING },
  });

  assert.equal(created.status, 422);
  assert.equal(code(created), "sandboxBindingInvalid");
  assert.match(String((created.body as { message?: string }).message), /run host/);
  // Refused BEFORE contacting the provider: nothing allocated, nothing to reclaim.
  assert.deepEqual(world.sandbox.destroyedSandboxIds, []);
  const listed = await world.call(world.tokenA, "GET", "/v1/tasks");
  assert.deepEqual(listed.body, []);
});

test("a user-managed sandbox is unaffected by the run-host refusal (it allocates nothing)", async () => {
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);
  assert.ok(taskId.length > 0);
});

test("with the opt-in, a task-owned binding allocates a sandbox and adopts its id", async () => {
  // The binding names no sandbox — the id can only come from the provider,
  // which is what makes the default mode usable at all.
  const world = await makeWorld({ allowEphemeralSandboxWithoutRunHost: true });
  await storeSandboxKey(world);

  const created = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: EPHEMERAL_BINDING },
  });

  assert.equal(created.status, 201);
  const taskId = (created.body as { taskId: string }).taskId;
  const stored = world.store.readTask(taskId);
  assert.ok(stored !== undefined);
  assert.ok(
    stored.binding.sandboxId.length > 0 && stored.binding.sandboxId !== "sbx-1",
    "the persisted binding must carry the provider-allocated id"
  );
  assert.deepEqual(world.sandbox.destroyedSandboxIds, [], "a successful creation destroys nothing");
});

test("a failure after allocation releases the sandbox it created", async () => {
  // The window this covers: the sandbox exists at the provider, but its id
  // lives ONLY in the request's stack frame — no task, no binding, nothing
  // persisted. Without compensating teardown it bills until someone finds it
  // in a provider dashboard.
  const store = createControlPlaneStoreV1({ now: makeClock().now });
  const clock = makeClock();
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: clock.now,
  });
  const sandbox = createInMemorySandboxClientV1();
  const unreachableClient: SandboxClientV1 = {
    ...sandbox,
    resolveRealPath: () => Promise.reject(new Error("provider down")),
  };
  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub: createWsHubV1({ sessions, store }),
    kekProvider: createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" }),
    sandboxFactory: { clientFor: (): SandboxClientV1 => unreachableClient },
    allowEphemeralSandboxWithoutRunHost: true,
    now: clock.now,
  });
  const a = await sessions.exchange({ provider: "github", authorizationCode: "code-a", ...BASE });
  assert.ok(a.ok);
  const auth = { authorization: `Bearer ${a.tokens.accessToken}` };
  await handler.handle({
    method: "PUT",
    path: "/v1/keys/sandbox:e2b",
    query: {},
    headers: auth,
    body: { key: "e2b_live_key_A_9876" },
  });

  const created = await handler.handle({
    method: "POST",
    path: "/v1/tasks",
    query: {},
    headers: auth,
    body: { request: "x", sandboxBinding: EPHEMERAL_BINDING },
  });

  assert.equal(created.status, 422);
  assert.equal(code(created), "sandboxUnreachable");
  assert.equal(
    sandbox.destroyedSandboxIds.length,
    1,
    "the sandbox allocated by this request must be destroyed before the error returns"
  );
});

function code(response: { body?: unknown }): string {
  return (response.body as { code?: string })?.code ?? "";
}

/** Extract one cookie's value from a `Set-Cookie` response header. */
function setCookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = new RegExp(`^${name}=([^;]*)`).exec(header);
  return match?.[1];
}

test("web platform: exchange/refresh deliver the refresh token ONLY via an HttpOnly cookie, never the body", async () => {
  const world = await makeWorld();
  const exchange = await world.call(undefined, "POST", "/v1/auth/exchange", {
    headers: { "x-ensemble-platform": "web" },
    body: { provider: "github", authorizationCode: "code-a", ...BASE },
  });
  assert.equal(exchange.status, 200);
  const exchangeBody = exchange.body as { accessToken: string; refreshToken?: string };
  assert.equal(exchangeBody.refreshToken, undefined, "refreshToken must not appear in the web body");
  const setCookie = exchange.headers?.["set-cookie"];
  assert.ok(setCookie !== undefined, "exchange must set the refresh cookie on web");
  assert.match(setCookie as string, /HttpOnly/);
  assert.match(setCookie as string, /Secure/);
  assert.match(setCookie as string, /SameSite=Strict/);
  assert.match(setCookie as string, /Path=\/v1\/auth/);
  const cookieValue = setCookieValue(setCookie, "ensemble_rt");
  assert.ok(cookieValue !== undefined && cookieValue.length > 0);

  // Refresh relies on the cookie header, not a body field, and rotates it.
  const refresh = await world.call(undefined, "POST", "/v1/auth/refresh", {
    headers: { "x-ensemble-platform": "web", cookie: `ensemble_rt=${cookieValue}` },
    body: {},
  });
  assert.equal(refresh.status, 200);
  const refreshBody = refresh.body as { accessToken: string; refreshToken?: string };
  assert.equal(refreshBody.refreshToken, undefined);
  const rotatedCookie = setCookieValue(refresh.headers?.["set-cookie"], "ensemble_rt");
  assert.ok(rotatedCookie !== undefined && rotatedCookie !== cookieValue, "the cookie must rotate too");

  // The access token from the web refresh authorizes normally.
  const authed = await world.call(refreshBody.accessToken, "GET", "/v1/tasks");
  assert.equal(authed.status, 200);
});

test("web platform: a missing refresh cookie is rejected; replaying a rotated cookie revokes the family", async () => {
  const world = await makeWorld();
  const noCookie = await world.call(undefined, "POST", "/v1/auth/refresh", {
    headers: { "x-ensemble-platform": "web" },
    body: {},
  });
  assert.equal(noCookie.status, 401);
  assert.equal(code(noCookie), "refreshTokenInvalid");

  const exchange = await world.call(undefined, "POST", "/v1/auth/exchange", {
    headers: { "x-ensemble-platform": "web" },
    body: { provider: "github", authorizationCode: "code-a", ...BASE },
  });
  const original = setCookieValue(exchange.headers?.["set-cookie"], "ensemble_rt");
  assert.ok(original !== undefined);
  await world.call(undefined, "POST", "/v1/auth/refresh", {
    headers: { "x-ensemble-platform": "web", cookie: `ensemble_rt=${original}` },
    body: {},
  });

  // Replaying the now-rotated-away cookie is reuse: the family is revoked,
  // and the response clears the dead cookie instead of leaving it live.
  const replay = await world.call(undefined, "POST", "/v1/auth/refresh", {
    headers: { "x-ensemble-platform": "web", cookie: `ensemble_rt=${original}` },
    body: {},
  });
  assert.equal(replay.status, 401);
  assert.equal(code(replay), "refreshTokenReused");
  assert.match(replay.headers?.["set-cookie"] ?? "", /Max-Age=0/);
});

test("web platform: sign-out clears the refresh cookie; native sign-out sets no cookie", async () => {
  const world = await makeWorld();
  const revokeWeb = await world.call(world.tokenA, "POST", "/v1/auth/revoke", {
    headers: { "x-ensemble-platform": "web" },
  });
  assert.equal(revokeWeb.status, 204);
  assert.match(revokeWeb.headers?.["set-cookie"] ?? "", /ensemble_rt=;.*Max-Age=0/);

  const revokeNative = await world.call(world.tokenB, "POST", "/v1/auth/revoke");
  assert.equal(revokeNative.status, 204);
  assert.equal(revokeNative.headers, undefined);
});

test("native platform (no x-ensemble-platform header) is unaffected: refreshToken stays in the body, no cookie is set", async () => {
  const world = await makeWorld();
  const exchange = await world.call(undefined, "POST", "/v1/auth/exchange", {
    body: { provider: "github", authorizationCode: "code-a", ...BASE },
  });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.headers, undefined);
  const exchangeBody = exchange.body as { accessToken: string; refreshToken: string };
  assert.equal(typeof exchangeBody.refreshToken, "string");

  const refresh = await world.call(undefined, "POST", "/v1/auth/refresh", {
    body: { refreshToken: exchangeBody.refreshToken },
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.headers, undefined);
});

test("only the control-plane session credential authorizes: absent or forged bearers get 401", async () => {
  const world = await makeWorld();
  assert.equal((await world.call(undefined, "GET", "/v1/tasks")).status, 401);
  assert.equal((await world.call("cpat_forged", "GET", "/v1/tasks")).status, 401);
});

test("task creation enforces the typed binding contract — no unbound execution path", async () => {
  const world = await makeWorld();

  const missing = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "x" },
  });
  assert.equal(missing.status, 400);
  assert.equal(code(missing), "sandboxBindingMissing");

  const invalid = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "x", sandboxBinding: { ...VALID_BINDING, provider: "aws-ec2" } },
  });
  assert.equal(invalid.status, 422);
  assert.equal(code(invalid), "sandboxBindingInvalid");

  const badRoot = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "x", sandboxBinding: { ...VALID_BINDING, workingDirectoryRoot: "../up" } },
  });
  assert.equal(badRoot.status, 422);
  assert.equal(code(badRoot), "workingDirectoryRootInvalid");

  // No stored provider key: typed refusal before anything reaches a sandbox.
  const noKey = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "x", sandboxBinding: VALID_BINDING },
  });
  assert.equal(noKey.status, 422);
  assert.equal(code(noKey), "sandboxProviderKeyMissing");
});

test("an unreachable sandbox is a typed creation failure", async () => {
  const world = await makeWorld();
  await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", { body: { key: "k" } });
  const unreachableClient: SandboxClientV1 = {
    ...world.sandbox,
    resolveRealPath: () => Promise.reject(new Error("provider down")),
  };
  const store = world.store;
  const clock = makeClock();
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: clock.now,
  });
  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub: createWsHubV1({ sessions, store }),
    kekProvider: createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" }),
    sandboxFactory: { clientFor: (): SandboxClientV1 => unreachableClient },
    now: clock.now,
  });
  const a = await sessions.exchange({ provider: "github", authorizationCode: "code-a", ...BASE });
  assert.ok(a.ok);
  const created = await handler.handle({
    method: "POST",
    path: "/v1/tasks",
    query: {},
    headers: { authorization: `Bearer ${a.tokens.accessToken}` },
    body: { request: "x", sandboxBinding: VALID_BINDING },
  });
  assert.equal(created.status, 422);
  assert.equal(code(created), "sandboxUnreachable");
});

test("cross-user denial: tasks, history, chat, files, and diffs read as absent to a foreign user", async () => {
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);

  for (const [method, path, query] of [
    ["GET", `/v1/tasks/${taskId}`, undefined],
    ["GET", `/v1/tasks/${taskId}/history`, undefined],
    ["GET", `/v1/tasks/${taskId}/chat`, undefined],
    ["GET", `/v1/tasks/${taskId}/gates`, undefined],
    ["GET", `/v1/tasks/${taskId}/file`, { path: "src/app.ts" }],
    ["GET", `/v1/tasks/${taskId}/diff`, undefined],
  ] as const) {
    const denied = await world.call(world.tokenB, method, path, query ? { query: { ...query } } : undefined);
    assert.equal(denied.status, 404, `${method} ${path}`);
  }

  const listedByB = await world.call(world.tokenB, "GET", "/v1/tasks");
  assert.deepEqual(listedByB.body, []);
  const listedByA = await world.call(world.tokenA, "GET", "/v1/tasks");
  assert.equal((listedByA.body as unknown[]).length, 1);
});

test("gate decisions map the idempotency contract to HTTP: replay 200, mismatch 422, conflict 409, foreign 404", async () => {
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);
  const gate = await world.store.gates.create({
    taskId,
    ownerId: world.userA,
    summary: "apply changes",
    diffUnified: "--- a/src/app.ts\n+++ b/src/app.ts\n",
  });
  const key = allocateHex128IdV1();

  const foreign = await world.call(world.tokenB, "POST", `/v1/gates/${gate.gateId}/decision`, {
    body: { decision: "approve", idempotencyKey: key },
  });
  assert.equal(foreign.status, 404);

  const decided = await world.call(world.tokenA, "POST", `/v1/gates/${gate.gateId}/decision`, {
    body: { decision: "approve", idempotencyKey: key },
  });
  assert.equal(decided.status, 200);
  assert.equal((decided.body as { replayed: boolean }).replayed, false);

  const replayed = await world.call(world.tokenA, "POST", `/v1/gates/${gate.gateId}/decision`, {
    body: { decision: "approve", idempotencyKey: key },
  });
  assert.equal(replayed.status, 200);
  assert.equal((replayed.body as { replayed: boolean }).replayed, true);

  const mismatch = await world.call(world.tokenA, "POST", `/v1/gates/${gate.gateId}/decision`, {
    body: { decision: "approve", idempotencyKey: key, comment: "changed payload" },
  });
  assert.equal(mismatch.status, 422);
  assert.equal(code(mismatch), "gateDecisionPayloadMismatch");

  const conflict = await world.call(world.tokenA, "POST", `/v1/gates/${gate.gateId}/decision`, {
    body: { decision: "reject", idempotencyKey: allocateHex128IdV1() },
  });
  assert.equal(conflict.status, 409);
  assert.equal(code(conflict), "gateAlreadyDecided");

  // The gate detail endpoint mirrors ownership: foreign read is 404.
  assert.equal((await world.call(world.tokenB, "GET", `/v1/gates/${gate.gateId}`)).status, 404);
  const detail = await world.call(world.tokenA, "GET", `/v1/gates/${gate.gateId}`);
  assert.equal((detail.body as { state: string }).state, "approved");

  // The diff endpoint serves the gate's reviewed unified diff, read-only.
  const diff = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/diff`, {
    query: { gateId: gate.gateId },
  });
  assert.equal((diff.body as { unifiedDiff: string }).unifiedDiff.startsWith("--- a/"), true);
});

test("file retrieval enforces the full confinement rule: lexical escapes 400, symlink escapes 400, reads are read-only", async () => {
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);

  const ok = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, {
    query: { path: "src/app.ts" },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    path: "src/app.ts",
    text: "export const app = 1;\n",
    language: "typescript",
    // Server-side highlighting (Part 10): the shared token-span schema,
    // offsets into the served text.
    tokenSpans: [
      { start: 0, end: 6, scope: "keyword" },
      { start: 7, end: 12, scope: "keyword" },
      { start: 19, end: 20, scope: "number" },
    ],
  });

  const listing = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/files`, {
    query: { path: "src" },
  });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body, [{ name: "app.ts", kind: "file", sizeBytes: 22 }]);

  // `.` lists the binding root itself (the file browser's start directory).
  const rootListing = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/files`, {
    query: { path: "." },
  });
  assert.equal(rootListing.status, 200);
  const rootNames = (rootListing.body as Array<{ name: string }>).map((entry) => entry.name);
  assert.deepEqual(rootNames, ["src"]);
  // But `.` is a directory, never a readable file, and `..`-ish tricks via
  // the root name are still rejected by the lexical rule.
  assert.equal(
    (await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, { query: { path: "." } })).status,
    404
  );
  const dotDotRoot = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/files`, {
    query: { path: "./.." },
  });
  assert.equal(dotDotRoot.status, 400);
  assert.equal(code(dotDotRoot), "pathOutsideBindingRoot");

  const dotDot = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, {
    query: { path: "../etc/secret" },
  });
  assert.equal(dotDot.status, 400);
  assert.equal(code(dotDot), "pathOutsideBindingRoot");

  const absolute = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, {
    query: { path: "/etc/secret" },
  });
  assert.equal(absolute.status, 400);
  assert.equal(code(absolute), "pathOutsideBindingRoot");

  // The symlink resolves OUTSIDE the root via the provider API: rejected
  // BEFORE any read happens — followed-then-checked, never trusted as given.
  const symlink = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, {
    query: { path: "escape" },
  });
  assert.equal(symlink.status, 400);
  assert.equal(code(symlink), "symlinkEscapesBindingRoot");

  const missing = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/file`, {
    query: { path: "src/nope.ts" },
  });
  assert.equal(missing.status, 400);
});

test("task creation validates and normalizes the optional model selection (Part 9)", async () => {
  const world = await makeWorld();
  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: "e2b_live_key_A_9876" },
  });
  assert.equal(put.status, 204);

  // A legacy alias normalizes to the canonical provider-qualified id.
  const created = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: VALID_BINDING, model: "anthropic:opus" },
  });
  assert.equal(created.status, 201);
  const taskId = (created.body as { taskId: string }).taskId;
  assert.equal(world.store.readTask(taskId)?.modelId, "anthropic:claude-opus-5");

  // An unqualified id and an unknown provider both fail with the typed error
  // and create nothing.
  const before = world.store.listTasksForOwner(world.userA).length;
  const unqualified = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: VALID_BINDING, model: "sonnet" },
  });
  assert.equal(unqualified.status, 422);
  assert.equal(code(unqualified), "modelSelectionInvalid");
  const unknownProvider = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: VALID_BINDING, model: "meta:llama" },
  });
  assert.equal(unknownProvider.status, 422);
  assert.equal(code(unknownProvider), "modelSelectionInvalid");
  assert.equal(world.store.listTasksForOwner(world.userA).length, before);

  // Absent model stays absent — the host's default chain applies.
  const defaulted = await world.call(world.tokenA, "POST", "/v1/tasks", {
    body: { request: "do the thing", sandboxBinding: VALID_BINDING },
  });
  assert.equal(defaulted.status, 201);
  assert.equal(world.store.readTask((defaulted.body as { taskId: string }).taskId)?.modelId, undefined);
});

test("GET /v1/tasks carries the newest round as latestRound, absent when there are none (Part 7)", async () => {
  interface TaskListingDto {
    readonly taskId: string;
    readonly latestRound?: {
      readonly roundId: string;
      readonly stage: string;
      readonly startedAt: string;
      readonly completedAt?: string;
      readonly summary?: string;
    };
  }
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);

  // No rounds yet: the field is entirely absent, not null/undefined-valued.
  const freshListing = await world.call(world.tokenA, "GET", "/v1/tasks");
  assert.equal(freshListing.status, 200);
  const freshTasks = freshListing.body as readonly TaskListingDto[];
  const freshTask = freshTasks.find((entry) => entry.taskId === taskId);
  assert.ok(freshTask !== undefined);
  assert.equal("latestRound" in freshTask, false);

  world.store.appendTaskRound(taskId, {
    roundId: "round-1",
    stage: "impl",
    startedAt: "2026-08-12T00:00:01.000Z",
    completedAt: "2026-08-12T00:00:02.000Z",
    summary: "first round",
  });
  world.store.appendTaskRound(taskId, {
    roundId: "round-2",
    stage: "review",
    startedAt: "2026-08-12T00:00:03.000Z",
  });

  const listing = await world.call(world.tokenA, "GET", "/v1/tasks");
  assert.equal(listing.status, 200);
  const tasks = listing.body as readonly TaskListingDto[];
  const task = tasks.find((entry) => entry.taskId === taskId);
  assert.ok(task !== undefined);
  // The NEWEST round, not the first — and the un-completed round has no
  // completedAt/summary keys rather than null-valued ones.
  assert.deepEqual(task.latestRound, {
    roundId: "round-2",
    stage: "review",
    startedAt: "2026-08-12T00:00:03.000Z",
  });
});

test("chat: messages append; structured answers dedupe by idempotency id", async () => {
  const world = await makeWorld();
  const taskId = await storeKeyAndCreateTask(world);

  const message = await world.call(world.tokenA, "POST", `/v1/tasks/${taskId}/chat`, {
    body: { kind: "message", text: "hello" },
  });
  assert.equal(message.status, 202);

  const answerId = allocateHex128IdV1();
  const answers = {
    kind: "structuredAnswers",
    interactionId: "i-1",
    answers: [],
    answerIdempotencyId: answerId,
  };
  assert.equal(
    (await world.call(world.tokenA, "POST", `/v1/tasks/${taskId}/chat`, { body: answers })).status,
    202
  );
  assert.equal(
    (await world.call(world.tokenA, "POST", `/v1/tasks/${taskId}/chat`, { body: answers })).status,
    202
  );
  const turns = await world.call(world.tokenA, "GET", `/v1/tasks/${taskId}/chat`);
  assert.equal((turns.body as unknown[]).length, 2);
});

test("key custody over HTTP: write-only, masked metadata, deletable, never echoed", async () => {
  const world = await makeWorld();
  const material = "e2b_live_key_A_9876";
  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: material },
  });
  assert.equal(put.status, 204);
  assert.equal(put.body, undefined);

  const metadata = await world.call(world.tokenA, "GET", "/v1/keys");
  assert.deepEqual(
    (metadata.body as { keyKind: string; maskedHint: string }[]).map((entry) => ({
      keyKind: entry.keyKind,
      maskedHint: entry.maskedHint,
    })),
    [{ keyKind: "sandbox:e2b", maskedHint: "••••9876" }]
  );
  assert.ok(!JSON.stringify(metadata.body).includes(material));

  // Foreign users see no metadata; deletion is owner-scoped.
  assert.deepEqual((await world.call(world.tokenB, "GET", "/v1/keys")).body, []);
  assert.equal(
    (await world.call(world.tokenB, "DELETE", "/v1/keys/sandbox:e2b")).status,
    404
  );
  assert.equal(
    (await world.call(world.tokenA, "DELETE", "/v1/keys/sandbox:e2b")).status,
    204
  );
  assert.equal(
    (await world.call(world.tokenA, "DELETE", "/v1/keys/sandbox:e2b")).status,
    404
  );

  const badKind = await world.call(world.tokenA, "PUT", "/v1/keys/other:thing", {
    body: { key: "x" },
  });
  assert.equal(badKind.status, 422);
});

test("fail-closed custody: with the KEK unavailable, key writes and key-dependent reads refuse", async () => {
  const world = await makeWorld({ kekDown: true });
  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: "material" },
  });
  assert.equal(put.status, 503);
  assert.equal(code(put), "keyCustodyUnavailable");
  // Nothing was stored — not even ciphertext under a missing KEK.
  assert.deepEqual((await world.call(world.tokenA, "GET", "/v1/keys")).body, []);
});

test("the event stream endpoint requires the WS upgrade; no plain-HTTP stream exists", async () => {
  const world = await makeWorld();
  assert.equal((await world.call(world.tokenA, "GET", "/v1/events")).status, 426);
});

test("Part 11 log redaction: request logs carry method/path/status only — no tokens, no key material", async () => {
  const lines: string[] = [];
  const world = await makeWorld({ log: (line) => lines.push(line) });

  const put = await world.call(world.tokenA, "PUT", "/v1/keys/sandbox:e2b", {
    body: { key: "e2b_live_key_A_9876" },
  });
  assert.equal(put.status, 204);
  const exchange = await world.handler.handle({
    method: "POST",
    path: "/v1/auth/exchange",
    query: {},
    headers: {},
    body: { provider: "github", authorizationCode: "code-a", ...BASE },
  });
  assert.equal(exchange.status, 200);
  const denied = await world.call(undefined, "GET", "/v1/tasks");
  assert.equal(denied.status, 401);

  // Every handled request logged exactly one line, shaped method/path/status.
  assert.deepEqual(lines, [
    "PUT /v1/keys/sandbox:e2b -> 204",
    "POST /v1/auth/exchange -> 200",
    "GET /v1/tasks -> 401",
  ]);

  // Nothing secret anywhere in the log output: no access tokens, no key
  // material, no authorization codes, no issued session tokens.
  const joined = lines.join("\n");
  const issued = exchange.body as { accessToken: string; refreshToken: string };
  for (const secret of [
    world.tokenA,
    world.tokenB,
    "e2b_live_key_A_9876",
    "code-a",
    issued.accessToken,
    issued.refreshToken,
  ]) {
    assert.ok(!joined.includes(secret), `log output must not contain ${secret}`);
  }
});
