/**
 * The durable-store semantics suite re-run against the SQLite adapter
 * (plan Part 5: SQLite is the accepted single-node dev durable store).
 * Same pins as `store.test.ts` — restart durability over the same database
 * file, the gate-decision protocol (database CAS + the scoped
 * (owner, gate, idempotency key) uniqueness with the stored fingerprint),
 * execution attempts (first terminal state wins), the single-worker lease,
 * chat-answer idempotency, engine-transaction claims, and hashes-only
 * session tokens at rest (raw database bytes scanned).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteControlPlaneStoreV1 } from "../src/sqliteStoreV1";
import { makeClock, makeTaskRecord } from "./helpersV1";

const KEY_A = "a".repeat(32);
const KEY_B = "c".repeat(32);

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ensemble-cp-sqlite-")), "store.sqlite");
}

test("sqlite: a new store instance over the same database file loads everything", async () => {
  const path = tempDbPath();
  const clock = makeClock();
  const first = createSqliteControlPlaneStoreV1({ databasePath: path, now: clock.now });
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
  first.engineTransactions.writeRecordBytes("op-1", new TextEncoder().encode('{"v":1}'));
  assert.equal(first.engineTransactions.claim("op-1", clock.now().toISOString()), true);
  first.close();

  // "Restart": a brand-new instance over the same database file.
  const second = createSqliteControlPlaneStoreV1({ databasePath: path, now: clock.now });
  assert.equal(second.upsertUserByIdentity("github", "12345").userId, user.userId);
  assert.equal(second.readTask("task-1")?.ownerUserId, user.userId);
  assert.equal((await second.gates.read(gate.gateId))?.summary, "apply reviewed changes");
  assert.equal((await second.gates.read(gate.gateId))?.diffUnified, "--- a/x\n+++ b/x\n");
  assert.equal((await second.attempts.read("f".repeat(64)))?.state, "pending");
  assert.equal(second.readJob("task-1")?.pausedGateId, gate.gateId);
  assert.deepEqual(second.listJobsByStatus("gatePaused").map((job) => job.jobId), ["task-1"]);
  assert.equal(
    new TextDecoder().decode(second.engineTransactions.readRecordBytes("op-1")),
    '{"v":1}'
  );
  // The invocation-once claim survives the restart: a re-claim is refused.
  assert.equal(second.engineTransactions.claim("op-1", clock.now().toISOString()), false);
  assert.equal(second.engineTransactions.hasClaim("op-1"), true);
  second.close();
});

test("sqlite gate decisions: CAS + scoped idempotency key + fingerprint, ownership reads as absence", async () => {
  const store = createSqliteControlPlaneStoreV1({ databasePath: ":memory:" });
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
  store.close();
});

test("sqlite markResumed consumes exactly once, durably across a restart", async () => {
  const path = tempDbPath();
  const store = createSqliteControlPlaneStoreV1({ databasePath: path });
  const gate = await store.gates.create({ taskId: "t", ownerId: "o", summary: "s" });
  const firstConsume = await store.gates.markResumed(gate.gateId);
  assert.equal(firstConsume.consumed, true);
  const secondConsume = await store.gates.markResumed(gate.gateId);
  assert.equal(secondConsume.consumed, false);
  store.close();

  const restarted = createSqliteControlPlaneStoreV1({ databasePath: path });
  const afterRestart = await restarted.gates.markResumed(gate.gateId);
  assert.equal(afterRestart.consumed, false, "consumption survived the restart");
  restarted.close();
});

test("sqlite execution attempts: begin is idempotent by key; the first terminal state wins", async () => {
  const store = createSqliteControlPlaneStoreV1({ databasePath: ":memory:" });
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

  const open = await store.attempts.listOpenForTask("t");
  assert.equal(open.length, 0);
  const forGate = await store.attempts.listForGate("g");
  assert.equal(forGate.length, 1);
  store.close();
});

test("sqlite lease: unexpired refusal, expiry takeover, heartbeat renewal", async () => {
  const clock = makeClock();
  const store = createSqliteControlPlaneStoreV1({ databasePath: ":memory:", now: clock.now });
  assert.equal((await store.leases.acquire("job", "w1", 1000)).acquired, true);
  const refused = await store.leases.acquire("job", "w2", 1000);
  assert.deepEqual(refused, { acquired: false, holderWorkerId: "w1" });

  assert.equal(await store.leases.heartbeat("job", "w1", 1000), true);
  clock.advance(1500);
  assert.equal(await store.leases.heartbeat("job", "w1", 1000), false);
  assert.equal((await store.leases.acquire("job", "w2", 1000)).acquired, true);
  store.close();
});

test("sqlite chat answer submissions dedupe by (task, answerIdempotencyId)", () => {
  const store = createSqliteControlPlaneStoreV1({ databasePath: ":memory:" });
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
  store.close();
});

test("sqlite session lifecycle: rotation CAS and family-wide revocation", () => {
  const store = createSqliteControlPlaneStoreV1({ databasePath: ":memory:" });
  const at = "2026-08-12T00:00:00.000Z";
  store.createSessionFamily(
    { familyId: "fam-1", userId: "u", createdAt: at },
    { tokenHash: "9".repeat(64), familyId: "fam-1", userId: "u", createdAt: at, status: "active" },
    { tokenHash: "8".repeat(64), familyId: "fam-1", userId: "u", expiresAt: at }
  );
  store.rotateRefreshToken(
    "9".repeat(64),
    { tokenHash: "7".repeat(64), familyId: "fam-1", userId: "u", createdAt: at, status: "active" },
    { tokenHash: "6".repeat(64), familyId: "fam-1", userId: "u", expiresAt: at }
  );
  assert.equal(store.findRefreshTokenByHash("9".repeat(64))?.status, "rotated");
  // A rotated token can never rotate again (the reuse-detection precondition).
  assert.throws(() =>
    store.rotateRefreshToken(
      "9".repeat(64),
      { tokenHash: "5".repeat(64), familyId: "fam-1", userId: "u", createdAt: at, status: "active" },
      { tokenHash: "4".repeat(64), familyId: "fam-1", userId: "u", expiresAt: at }
    )
  );

  store.revokeSessionFamily("fam-1", at);
  assert.equal(store.readFamily("fam-1")?.revokedAt, at);
  assert.equal(store.findRefreshTokenByHash("7".repeat(64))?.status, "revoked");
  assert.equal(store.findAccessTokenByHash("6".repeat(64))?.revokedAt, at);
  store.close();
});

test("sqlite session tokens at rest are hashes only (raw database bytes carry no credential)", () => {
  const path = tempDbPath();
  const store = createSqliteControlPlaneStoreV1({ databasePath: path });
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
  store.close();
  const raw = readFileSync(path, "latin1");
  assert.ok(raw.includes("9".repeat(64)));
  assert.ok(!raw.includes("cpat_"));
  assert.ok(!raw.includes("cprt_"));
});
