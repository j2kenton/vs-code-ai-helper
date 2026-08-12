/**
 * Durable-store semantics (plan Part 5): file persistence surviving a
 * restart, the gate-decision protocol (atomic CAS + (owner, gate,
 * idempotency key) uniqueness with the stored fingerprint), execution
 * attempts (first terminal state wins), the single-worker lease, and
 * chat-answer idempotency.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlPlaneStoreV1,
  createFileControlPlanePersistenceV1,
} from "../src/storeV1";
import { makeClock, makeTaskRecord } from "./helpersV1";

const KEY_A = "a".repeat(32);
const KEY_B = "c".repeat(32);

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ensemble-cp-store-")), "store.json");
}

test("file persistence: a new store instance loads everything the old one persisted", async () => {
  const path = tempStorePath();
  const clock = makeClock();
  const first = createControlPlaneStoreV1({
    persistence: createFileControlPlanePersistenceV1(path),
    now: clock.now,
  });
  const user = first.upsertUserByIdentity("github", "12345");
  first.createTask(makeTaskRecord("task-1", user.userId, clock.now().toISOString()));
  const gate = await first.gates.create({
    taskId: "task-1",
    ownerId: user.userId,
    summary: "apply reviewed changes",
    diffUnified: "--- a/x\n+++ b/x\n",
  });
  await first.attempts.begin({
    attemptKey: "f".repeat(64),
    taskId: "task-1",
    gateId: gate.gateId,
    effectKind: "sandboxCommand",
    lineage: 0,
  });
  first.upsertJob({
    jobId: "task-1",
    taskId: "task-1",
    ownerUserId: user.userId,
    status: "gatePaused",
    pausedGateId: gate.gateId,
    updatedAt: clock.now().toISOString(),
  });

  // "Restart": a brand-new instance over the same file.
  const second = createControlPlaneStoreV1({
    persistence: createFileControlPlanePersistenceV1(path),
    now: clock.now,
  });
  assert.equal(second.upsertUserByIdentity("github", "12345").userId, user.userId);
  assert.equal(second.readTask("task-1")?.ownerUserId, user.userId);
  assert.equal((await second.gates.read(gate.gateId))?.summary, "apply reviewed changes");
  assert.equal((await second.attempts.read("f".repeat(64)))?.state, "pending");
  assert.equal(second.readJob("task-1")?.pausedGateId, gate.gateId);
});

test("gate decisions: CAS + scoped idempotency key + fingerprint, ownership reads as absence", async () => {
  const store = createControlPlaneStoreV1();
  const gate = await store.gates.create({
    taskId: "task-1",
    ownerId: "owner-a",
    summary: "run build",
  });

  const decided = await store.gates.decide("owner-a", {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: KEY_A,
  });
  assert.equal(decided.kind, "decided");

  // Same key + same payload: the ORIGINAL outcome, no second transition.
  const replayed = await store.gates.decide("owner-a", {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: KEY_A,
  });
  assert.equal(replayed.kind, "replayed");

  // Same key + different payload: the typed mismatch.
  const mismatch = await store.gates.decide("owner-a", {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: KEY_A,
    comment: "different payload",
  });
  assert.deepEqual(
    { kind: mismatch.kind, code: mismatch.kind === "error" ? mismatch.code : "" },
    { kind: "error", code: "gateDecisionPayloadMismatch" }
  );

  // A conflicting decision under a NEW key: the typed conflict.
  const conflict = await store.gates.decide("owner-a", {
    gateId: gate.gateId,
    decision: "reject",
    idempotencyKey: KEY_B,
  });
  assert.deepEqual(
    { kind: conflict.kind, code: conflict.kind === "error" ? conflict.code : "" },
    { kind: "error", code: "gateAlreadyDecided" }
  );

  // A foreign owner reads the gate as absent — identifier guessing reveals
  // nothing.
  const foreign = await store.gates.decide("owner-b", {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: KEY_A,
  });
  assert.deepEqual(
    { kind: foreign.kind, code: foreign.kind === "error" ? foreign.code : "" },
    { kind: "error", code: "gateNotFound" }
  );

  // Malformed idempotency keys are shape-rejected, not typed gate errors.
  const malformed = await store.gates.decide("owner-a", {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: "not-hex",
  });
  assert.equal(malformed.kind, "rejected");
});

test("markResumed consumes exactly once", async () => {
  const store = createControlPlaneStoreV1();
  const gate = await store.gates.create({ taskId: "t", ownerId: "o", summary: "s" });
  const firstConsume = await store.gates.markResumed(gate.gateId);
  assert.equal(firstConsume.consumed, true);
  const secondConsume = await store.gates.markResumed(gate.gateId);
  assert.equal(secondConsume.consumed, false);
});

test("execution attempts: begin is idempotent by key; the first terminal state wins", async () => {
  const store = createControlPlaneStoreV1();
  const input = {
    attemptKey: "e".repeat(64),
    taskId: "t",
    gateId: "g",
    effectKind: "sandboxCommand" as const,
    lineage: 0,
  };
  const created = await store.attempts.begin(input);
  assert.equal(created.created, true);
  const repeated = await store.attempts.begin(input);
  assert.equal(repeated.created, false);

  await store.attempts.complete(input.attemptKey, "succeeded", "exit0");
  const late = await store.attempts.complete(input.attemptKey, "failed", "exit1");
  assert.equal(late.state, "succeeded");
  assert.equal(late.outcomeCode, "exit0");
});

test("lease: unexpired refusal, expiry takeover, heartbeat renewal", async () => {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  assert.equal((await store.leases.acquire("job", "w1", 1000)).acquired, true);
  const refused = await store.leases.acquire("job", "w2", 1000);
  assert.deepEqual(refused, { acquired: false, holderWorkerId: "w1" });

  assert.equal(await store.leases.heartbeat("job", "w1", 1000), true);
  clock.advance(1500);
  assert.equal(await store.leases.heartbeat("job", "w1", 1000), false);
  assert.equal((await store.leases.acquire("job", "w2", 1000)).acquired, true);
});

test("chat answer submissions dedupe by (task, answerIdempotencyId)", () => {
  const store = createControlPlaneStoreV1();
  const clock = makeClock();
  store.createTask(makeTaskRecord("task-1", "owner-a", clock.now().toISOString()));
  const turn = {
    turnId: "1".repeat(32),
    role: "user" as const,
    at: clock.now().toISOString(),
    interactionId: "i-1",
  };
  const first = store.appendChatTurn("task-1", turn, "d".repeat(32));
  assert.deepEqual(first, { appended: true, turnId: turn.turnId });
  const replay = store.appendChatTurn(
    "task-1",
    { ...turn, turnId: "2".repeat(32) },
    "d".repeat(32)
  );
  assert.deepEqual(replay, { appended: false, turnId: turn.turnId });
  assert.equal(store.listChatTurns("task-1").length, 1);
});

test("session tokens at rest are hashes only (the serialized document carries no credential)", () => {
  const path = tempStorePath();
  const store = createControlPlaneStoreV1({
    persistence: createFileControlPlanePersistenceV1(path),
  });
  store.createSessionFamily(
    { familyId: "fam-1", userId: "u", createdAt: "2026-08-12T00:00:00.000Z" },
    {
      tokenHash: "9".repeat(64),
      familyId: "fam-1",
      userId: "u",
      createdAt: "2026-08-12T00:00:00.000Z",
      status: "active",
    },
    {
      tokenHash: "8".repeat(64),
      familyId: "fam-1",
      userId: "u",
      expiresAt: "2026-08-12T00:15:00.000Z",
    }
  );
  const serialized = readFileSync(path, "utf8");
  assert.ok(serialized.includes("9".repeat(64)));
  assert.ok(!serialized.includes("cpat_"));
  assert.ok(!serialized.includes("cprt_"));
});
