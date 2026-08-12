/**
 * WS subscription authorization + fan-out (plan Parts 3/5/6; criteria 8/9):
 * subscribe-time authorization, cross-user isolation, per-task filters
 * authorized against ownership, refreshAuth revalidation, and expiry
 * closing the subscription instead of delivering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WsServerEventV1 } from "../../ensemble-contract/src/wsEventsV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { createWsHubV1 } from "../src/wsHubV1";
import { makeClock, makeFakeValidator, makeTaskRecord } from "./helpersV1";

const BASE = { codeVerifier: "v", redirectUri: "app://callback" };

async function makeWorld() {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a", "code-b": "subject-b" })],
    now: clock.now,
    accessTtlMs: 15 * 60 * 1000,
  });
  const hub = createWsHubV1({ sessions, store });
  const a = await sessions.exchange({ provider: "github", authorizationCode: "code-a", ...BASE });
  const b = await sessions.exchange({ provider: "github", authorizationCode: "code-b", ...BASE });
  assert.ok(a.ok && b.ok);
  store.createTask(makeTaskRecord("task-a1", a.userId, clock.now().toISOString()));
  store.createTask(makeTaskRecord("task-a2", a.userId, clock.now().toISOString()));
  return { clock, store, sessions, hub, a, b };
}

function progressEvent(taskId: string): WsServerEventV1 {
  return {
    type: "taskProgress",
    taskId,
    progress: {
      ensembleProgressVersion: 1,
      taskFolder: taskId,
      currentStage: "impl",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  };
}

test("subscribe authorizes the token and fan-out reaches only the owner", async () => {
  const { hub, a, b } = await makeWorld();
  assert.ok(a.ok && b.ok);

  const receivedByA: WsServerEventV1[] = [];
  const receivedByB: WsServerEventV1[] = [];
  const connectionA = hub.connect((event) => receivedByA.push(event));
  const connectionB = hub.connect((event) => receivedByB.push(event));
  await connectionA.handleMessage({ type: "subscribe", accessToken: a.tokens.accessToken });
  await connectionB.handleMessage({ type: "subscribe", accessToken: b.tokens.accessToken });
  assert.deepEqual(receivedByA[0], { type: "subscribed", userId: a.userId });

  await hub.publishToOwner(a.userId, progressEvent("task-a1"));
  assert.equal(receivedByA.length, 2);
  assert.equal(receivedByA[1]?.type, "taskProgress");
  // Cross-user isolation: B's subscription never sees A's events.
  assert.equal(
    receivedByB.filter((event) => event.type === "taskProgress").length,
    0
  );
});

test("an invalid token closes the subscription as unauthorized", async () => {
  const { hub } = await makeWorld();
  const received: WsServerEventV1[] = [];
  const connection = hub.connect((event) => received.push(event));
  await connection.handleMessage({ type: "subscribe", accessToken: "cpat_forged" });
  assert.deepEqual(received, [{ type: "subscriptionClosed", reason: "unauthorized" }]);
  assert.equal(connection.closed, true);
});

test("a task filter is authorized against ownership and filters deliveries", async () => {
  const { hub, a, b } = await makeWorld();
  assert.ok(a.ok && b.ok);

  const received: WsServerEventV1[] = [];
  const connection = hub.connect((event) => received.push(event));
  await connection.handleMessage({
    type: "subscribe",
    accessToken: a.tokens.accessToken,
    taskId: "task-a1",
  });
  await hub.publishToOwner(a.userId, progressEvent("task-a2"));
  await hub.publishToOwner(a.userId, progressEvent("task-a1"));
  const progressEvents = received.filter((event) => event.type === "taskProgress");
  assert.equal(progressEvents.length, 1);
  assert.ok(progressEvents[0]?.type === "taskProgress" && progressEvents[0].taskId === "task-a1");

  // Someone else's task id reads as unauthorized, identically to absence.
  const foreign: WsServerEventV1[] = [];
  const foreignConnection = hub.connect((event) => foreign.push(event));
  await foreignConnection.handleMessage({
    type: "subscribe",
    accessToken: b.tokens.accessToken,
    taskId: "task-a1",
  });
  assert.deepEqual(foreign, [{ type: "subscriptionClosed", reason: "unauthorized" }]);
});

test("expiry closes the subscription on delivery; refreshAuth keeps it alive", async () => {
  const { hub, sessions, clock, a } = await makeWorld();
  assert.ok(a.ok);

  const expired: WsServerEventV1[] = [];
  const refreshed: WsServerEventV1[] = [];
  const expiringConnection = hub.connect((event) => expired.push(event));
  const refreshingConnection = hub.connect((event) => refreshed.push(event));
  await expiringConnection.handleMessage({ type: "subscribe", accessToken: a.tokens.accessToken });
  await refreshingConnection.handleMessage({ type: "subscribe", accessToken: a.tokens.accessToken });

  // Refresh BEFORE expiry with a newly refreshed access token (the Part 3
  // revalidation rule) on one connection only.
  clock.advance(10 * 60 * 1000);
  const rotation = await sessions.refresh(a.tokens.refreshToken);
  assert.ok(rotation.ok);
  await refreshingConnection.handleMessage({
    type: "refreshAuth",
    accessToken: rotation.tokens.accessToken,
  });

  // Past the original token's expiry: the stale connection closes instead
  // of receiving; the refreshed one still delivers.
  clock.advance(6 * 60 * 1000);
  await hub.publishToOwner(a.userId, progressEvent("task-a1"));
  assert.deepEqual(expired.at(-1), { type: "subscriptionClosed", reason: "tokenExpired" });
  assert.equal(expiringConnection.closed, true);
  assert.equal(refreshed.at(-1)?.type, "taskProgress");
  assert.equal(refreshingConnection.closed, false);
});
