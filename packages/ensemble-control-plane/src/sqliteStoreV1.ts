/**
 * SQLite-backed durable store (plan Part 5).
 *
 * The plan's durable-store requirement names Postgres as the reference
 * default and SQLite as acceptable for single-node dev; this adapter is that
 * single-node implementation, built on Node's built-in `node:sqlite` (no
 * external dependency) behind the SAME `ControlPlaneStoreV1` interface as
 * the persisted-document store in `storeV1.ts`. Swapping in Postgres touches
 * only this module: every semantic the plan makes a requirement on the store
 * interface exists here as a real database mechanism, not application-level
 * bookkeeping —
 *
 * - the gate decision is an atomic `UPDATE … WHERE state = 'pending'`
 *   compare-and-set on the gate row, committed in one transaction with the
 *   decision row;
 * - decision idempotency is a real `UNIQUE (owner_id, gate_id,
 *   idempotency_key)` constraint on the decision table, with the stored
 *   request fingerprint deciding replay vs. typed mismatch;
 * - `markResumed` is an `UPDATE … WHERE resumed_at IS NULL` consumption CAS;
 * - execution-attempt begin is exclusive-insert by primary key, and terminal
 *   outcomes are a `WHERE state = 'pending'` CAS so the first terminal state
 *   wins;
 * - the single-worker lease is a leased job row with holder and expiry
 *   columns, taken over only past expiry;
 * - every mutation commits BEFORE its promise resolves, so a crash between
 *   calls never leaves a half-applied mutation (SQLite's journal guarantees
 *   the transaction is all-or-nothing on disk).
 *
 * The Part 4c crash-injection suite re-runs against THIS implementation with
 * real restarts — a brand-new store over the same database file — in
 * `tests/sqliteCrashInjection.test.ts`, and the store-semantics suite in
 * `tests/sqliteStore.test.ts` pins the same behavior the document store's
 * tests pin. Session tokens are stored as hashes only, exactly like
 * `storeV1.ts` (the at-rest scan test reads the raw database bytes).
 */
import { DatabaseSync } from "node:sqlite";
import { allocateHex128IdV1, isHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import {
  computeGateDecisionFingerprintV1,
  GateDecisionCommandV1,
  GateDecisionRecordV1,
  gateStateForDecisionV1,
} from "../../ensemble-core/src/gateV1";
import type { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import type {
  CreateEngineGateInputV1,
  EngineGateDecideResultV1,
  EngineGateRecordV1,
  EngineGateStoreV1,
} from "../../ensemble-engine/src/gateStoreV1";
import type {
  BeginExecutionAttemptInputV1,
  EngineExecutionAttemptStoreV1,
  ExecutionAttemptRecordV1,
} from "../../ensemble-engine/src/executionAttemptStoreV1";
import type {
  EngineLeaseAcquireResultV1,
  EngineLeaseStoreV1,
} from "../../ensemble-engine/src/leaseStoreV1";
import type { EngineTransactionStoreBackendV1 } from "../../ensemble-engine/src/transactionStoreV1";
import type {
  AccessTokenRecordV1,
  ChatTurnRecordV1,
  ControlPlaneKeyRecordV1,
  ControlPlaneStoreV1,
  ControlPlaneTaskRecordV1,
  ControlPlaneUserRecordV1,
  EngineJobRecordV1,
  EngineJobStatusV1,
  RefreshFamilyRecordV1,
  RefreshTokenRecordV1,
  TaskRoundRecordV1,
} from "./storeV1";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     user_id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (provider, subject_id)
   )`,
  `CREATE TABLE IF NOT EXISTS families (
     family_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     revoked_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
     token_hash TEXT PRIMARY KEY,
     family_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     status TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS access_tokens (
     token_hash TEXT PRIMARY KEY,
     family_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS tasks (
     task_id TEXT PRIMARY KEY,
     owner_user_id TEXT NOT NULL,
     record TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chat_turns (
     task_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     record TEXT NOT NULL,
     PRIMARY KEY (task_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS chat_answer_idempotency (
     task_id TEXT NOT NULL,
     answer_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     PRIMARY KEY (task_id, answer_id)
   )`,
  `CREATE TABLE IF NOT EXISTS gates (
     gate_id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     state TEXT NOT NULL,
     resumed_at TEXT,
     record TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gate_decisions (
     gate_id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     request_fingerprint TEXT NOT NULL,
     decided_at TEXT NOT NULL,
     UNIQUE (owner_id, gate_id, idempotency_key)
   )`,
  `CREATE TABLE IF NOT EXISTS execution_attempts (
     attempt_key TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     gate_id TEXT NOT NULL,
     effect_kind TEXT NOT NULL,
     lineage INTEGER NOT NULL,
     state TEXT NOT NULL,
     started_at TEXT NOT NULL,
     completed_at TEXT,
     outcome_code TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS leases (
     job_id TEXT PRIMARY KEY,
     worker_id TEXT NOT NULL,
     expires_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS jobs (
     job_id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     record TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS key_records (
     owner_user_id TEXT NOT NULL,
     key_kind TEXT NOT NULL,
     record TEXT NOT NULL,
     PRIMARY KEY (owner_user_id, key_kind)
   )`,
  `CREATE TABLE IF NOT EXISTS engine_transactions (
     operation_id TEXT PRIMARY KEY,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS engine_transaction_claims (
     operation_id TEXT PRIMARY KEY,
     claimed_at TEXT NOT NULL
   )`,
];

export interface CreateSqliteControlPlaneStoreOptionsV1 {
  /** Database file path (`:memory:` is accepted for throwaway stores). */
  readonly databasePath: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/** The durable store plus connection lifecycle. */
export interface SqliteControlPlaneStoreV1 extends ControlPlaneStoreV1 {
  close(): void;
}

export function createSqliteControlPlaneStoreV1(
  options: CreateSqliteControlPlaneStoreOptionsV1
): SqliteControlPlaneStoreV1 {
  const now = options.now ?? ((): Date => new Date());
  const db = new DatabaseSync(options.databasePath);
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }

  const beginStatement = db.prepare("BEGIN IMMEDIATE");
  const commitStatement = db.prepare("COMMIT");
  const rollbackStatement = db.prepare("ROLLBACK");

  /** All-or-nothing commit; a thrown body rolls back every write. */
  function inTransaction<T>(body: () => T): T {
    beginStatement.run();
    try {
      const result = body();
      commitStatement.run();
      return result;
    } catch (error) {
      rollbackStatement.run();
      throw error;
    }
  }

  function changesOf(result: { readonly changes: number | bigint }): number {
    return Number(result.changes);
  }

  function readGateRow(gateId: string): EngineGateRecordV1 | undefined {
    const row = db.prepare("SELECT record FROM gates WHERE gate_id = ?").get(gateId) as
      | { record: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.record) as EngineGateRecordV1);
  }

  function writeGateRow(record: EngineGateRecordV1, casClause: string): number {
    return changesOf(
      db
        .prepare(`UPDATE gates SET state = ?, resumed_at = ?, record = ? WHERE gate_id = ? ${casClause}`)
        .run(record.state, record.resumedAt ?? null, JSON.stringify(record), record.gateId)
    );
  }

  const gates: EngineGateStoreV1 = {
    create(input: CreateEngineGateInputV1): Promise<EngineGateRecordV1> {
      try {
        return Promise.resolve(
          inTransaction(() => {
            const gateId = input.gateId ?? allocateHex128IdV1();
            if (readGateRow(gateId) !== undefined) {
              throw new Error(`a gate already exists with id ${gateId}`);
            }
            const record: EngineGateRecordV1 = {
              gateId,
              taskId: input.taskId,
              ownerId: input.ownerId,
              summary: input.summary,
              state: "pending",
              createdAt: now().toISOString(),
              ...(input.diffUnified !== undefined ? { diffUnified: input.diffUnified } : {}),
              ...(input.reofferOfAttemptKey !== undefined
                ? { reofferOfAttemptKey: input.reofferOfAttemptKey }
                : {}),
            };
            db.prepare(
              "INSERT INTO gates (gate_id, task_id, owner_id, state, resumed_at, record) VALUES (?, ?, ?, ?, NULL, ?)"
            ).run(gateId, record.taskId, record.ownerId, record.state, JSON.stringify(record));
            return record;
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    read(gateId: string): Promise<EngineGateRecordV1 | undefined> {
      return Promise.resolve(readGateRow(gateId));
    },

    decide(ownerId: string, command: GateDecisionCommandV1): Promise<EngineGateDecideResultV1> {
      if (!isHex128IdV1(command.idempotencyKey)) {
        return Promise.resolve({
          kind: "rejected",
          reason: "gate idempotency keys are 128-bit lowercase-hex identifiers",
        });
      }
      if (command.decision !== "approve" && command.decision !== "reject") {
        return Promise.resolve({
          kind: "rejected",
          reason: "a gate decision is either approve or reject",
        });
      }
      try {
        return Promise.resolve(
          inTransaction((): EngineGateDecideResultV1 => {
            const record = readGateRow(command.gateId);
            if (record === undefined || record.ownerId !== ownerId) {
              // Ownership mismatch deliberately reads identically to absence.
              return {
                kind: "error",
                code: "gateNotFound",
                reason: "no such gate for the authenticated owner",
              };
            }
            const fingerprint = computeGateDecisionFingerprintV1(command);
            if (record.decision !== undefined) {
              if (record.decision.idempotencyKey === command.idempotencyKey) {
                if (record.decision.requestFingerprint === fingerprint) {
                  return { kind: "replayed", record };
                }
                return {
                  kind: "error",
                  code: "gateDecisionPayloadMismatch",
                  reason: "this idempotency key was already used with a different decision payload",
                };
              }
              return {
                kind: "error",
                code: "gateAlreadyDecided",
                reason: `the gate is already ${record.state}`,
              };
            }
            if (record.state !== "pending") {
              return {
                kind: "error",
                code: "gateAlreadyDecided",
                reason: `the gate is already ${record.state}`,
              };
            }
            const decision: GateDecisionRecordV1 = {
              gateId: record.gateId,
              decision: command.decision,
              idempotencyKey: command.idempotencyKey,
              requestFingerprint: fingerprint,
              decidedAt: now().toISOString(),
            };
            const next: EngineGateRecordV1 = {
              ...record,
              state: gateStateForDecisionV1(command.decision),
              decision,
            };
            // The atomic CAS `pending → approved|rejected` on the gate row,
            // committed in ONE transaction with the decision row whose
            // UNIQUE (owner_id, gate_id, idempotency_key) constraint is the
            // plan's scoped-uniqueness mechanism.
            if (writeGateRow(next, "AND state = 'pending'") !== 1) {
              return {
                kind: "error",
                code: "gateAlreadyDecided",
                reason: `the gate is already ${record.state}`,
              };
            }
            db.prepare(
              "INSERT INTO gate_decisions (gate_id, owner_id, idempotency_key, request_fingerprint, decided_at) VALUES (?, ?, ?, ?, ?)"
            ).run(next.gateId, ownerId, decision.idempotencyKey, fingerprint, decision.decidedAt);
            return { kind: "decided", record: next };
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    markResumed(
      gateId: string
    ): Promise<{ readonly consumed: boolean; readonly record: EngineGateRecordV1 | undefined }> {
      try {
        return Promise.resolve(
          inTransaction(() => {
            const record = readGateRow(gateId);
            if (record === undefined) {
              return { consumed: false, record: undefined };
            }
            if (record.resumedAt !== undefined) {
              return { consumed: false, record };
            }
            const next: EngineGateRecordV1 = { ...record, resumedAt: now().toISOString() };
            // Exactly-once consumption CAS on the resumed_at column.
            const consumed = writeGateRow(next, "AND resumed_at IS NULL") === 1;
            return { consumed, record: consumed ? next : record };
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    listForTask(taskId: string): Promise<readonly EngineGateRecordV1[]> {
      const rows = db
        .prepare("SELECT record FROM gates WHERE task_id = ? ORDER BY rowid")
        .all(taskId) as { record: string }[];
      return Promise.resolve(rows.map((row) => JSON.parse(row.record) as EngineGateRecordV1));
    },
  };

  function attemptFromRow(row: {
    attempt_key: string;
    task_id: string;
    gate_id: string;
    effect_kind: string;
    lineage: number;
    state: string;
    started_at: string;
    completed_at: string | null;
    outcome_code: string | null;
  }): ExecutionAttemptRecordV1 {
    return {
      attemptKey: row.attempt_key,
      taskId: row.task_id,
      gateId: row.gate_id,
      effectKind: row.effect_kind as ExecutionAttemptRecordV1["effectKind"],
      lineage: row.lineage,
      state: row.state as ExecutionAttemptRecordV1["state"],
      startedAt: row.started_at,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      ...(row.outcome_code !== null ? { outcomeCode: row.outcome_code } : {}),
    };
  }

  function readAttemptRow(attemptKey: string): ExecutionAttemptRecordV1 | undefined {
    const row = db
      .prepare("SELECT * FROM execution_attempts WHERE attempt_key = ?")
      .get(attemptKey) as Parameters<typeof attemptFromRow>[0] | undefined;
    return row === undefined ? undefined : attemptFromRow(row);
  }

  function terminalAttempt(
    attemptKey: string,
    state: "succeeded" | "failed" | "indeterminate",
    outcomeCode?: string
  ): Promise<ExecutionAttemptRecordV1> {
    try {
      return Promise.resolve(
        inTransaction(() => {
          const record = readAttemptRow(attemptKey);
          if (record === undefined) {
            throw new Error(`no execution attempt exists for key ${attemptKey}`);
          }
          if (record.state !== "pending") {
            // First terminal state wins; repeats are idempotent no-ops.
            return record;
          }
          const next: ExecutionAttemptRecordV1 = {
            ...record,
            state,
            completedAt: now().toISOString(),
            ...(outcomeCode !== undefined ? { outcomeCode } : {}),
          };
          db.prepare(
            "UPDATE execution_attempts SET state = ?, completed_at = ?, outcome_code = ? WHERE attempt_key = ? AND state = 'pending'"
          ).run(next.state, next.completedAt ?? null, next.outcomeCode ?? null, attemptKey);
          return next;
        })
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const attempts: EngineExecutionAttemptStoreV1 = {
    begin(
      input: BeginExecutionAttemptInputV1
    ): Promise<{ readonly created: boolean; readonly record: ExecutionAttemptRecordV1 }> {
      try {
        return Promise.resolve(
          inTransaction(() => {
            const existing = readAttemptRow(input.attemptKey);
            if (existing !== undefined) {
              return { created: false, record: existing };
            }
            const record: ExecutionAttemptRecordV1 = {
              attemptKey: input.attemptKey,
              taskId: input.taskId,
              gateId: input.gateId,
              effectKind: input.effectKind,
              lineage: input.lineage,
              state: "pending",
              startedAt: now().toISOString(),
            };
            db.prepare(
              "INSERT INTO execution_attempts (attempt_key, task_id, gate_id, effect_kind, lineage, state, started_at, completed_at, outcome_code) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
            ).run(
              record.attemptKey,
              record.taskId,
              record.gateId,
              record.effectKind,
              record.lineage,
              record.state,
              record.startedAt
            );
            return { created: true, record };
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    complete(
      attemptKey: string,
      state: "succeeded" | "failed",
      outcomeCode?: string
    ): Promise<ExecutionAttemptRecordV1> {
      return terminalAttempt(attemptKey, state, outcomeCode);
    },

    markIndeterminate(attemptKey: string): Promise<ExecutionAttemptRecordV1> {
      return terminalAttempt(attemptKey, "indeterminate", "recoveryIndeterminate");
    },

    read(attemptKey: string): Promise<ExecutionAttemptRecordV1 | undefined> {
      return Promise.resolve(readAttemptRow(attemptKey));
    },

    listForGate(gateId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      const rows = db
        .prepare("SELECT * FROM execution_attempts WHERE gate_id = ? ORDER BY lineage")
        .all(gateId) as Parameters<typeof attemptFromRow>[0][];
      return Promise.resolve(rows.map(attemptFromRow));
    },

    listOpenForTask(taskId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      const rows = db
        .prepare(
          "SELECT * FROM execution_attempts WHERE task_id = ? AND state = 'pending' ORDER BY lineage"
        )
        .all(taskId) as Parameters<typeof attemptFromRow>[0][];
      return Promise.resolve(rows.map(attemptFromRow));
    },
  };

  const leases: EngineLeaseStoreV1 = {
    acquire(jobId: string, workerId: string, ttlMs: number): Promise<EngineLeaseAcquireResultV1> {
      try {
        return Promise.resolve(
          inTransaction((): EngineLeaseAcquireResultV1 => {
            const nowMs = now().getTime();
            const row = db
              .prepare("SELECT worker_id, expires_at_ms FROM leases WHERE job_id = ?")
              .get(jobId) as { worker_id: string; expires_at_ms: number } | undefined;
            if (row !== undefined && row.worker_id !== workerId && row.expires_at_ms > nowMs) {
              return { acquired: false, holderWorkerId: row.worker_id };
            }
            db.prepare(
              "INSERT INTO leases (job_id, worker_id, expires_at_ms) VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET worker_id = excluded.worker_id, expires_at_ms = excluded.expires_at_ms"
            ).run(jobId, workerId, nowMs + ttlMs);
            return { acquired: true };
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    heartbeat(jobId: string, workerId: string, ttlMs: number): Promise<boolean> {
      try {
        return Promise.resolve(
          inTransaction(() => {
            const nowMs = now().getTime();
            // Renewal CAS: only the current, unexpired holder extends.
            const changed = changesOf(
              db
                .prepare(
                  "UPDATE leases SET expires_at_ms = ? WHERE job_id = ? AND worker_id = ? AND expires_at_ms > ?"
                )
                .run(nowMs + ttlMs, jobId, workerId, nowMs)
            );
            return changed === 1;
          })
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },

    release(jobId: string, workerId: string): Promise<void> {
      try {
        db.prepare("DELETE FROM leases WHERE job_id = ? AND worker_id = ?").run(jobId, workerId);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  const transactionTextEncoder = new TextEncoder();
  const transactionTextDecoder = new TextDecoder();

  const engineTransactions: EngineTransactionStoreBackendV1 = {
    readRecordBytes(operationId: string): Uint8Array | undefined {
      const row = db
        .prepare("SELECT body FROM engine_transactions WHERE operation_id = ?")
        .get(operationId) as { body: string } | undefined;
      return row === undefined ? undefined : transactionTextEncoder.encode(row.body);
    },
    writeRecordBytes(operationId: string, bytes: Uint8Array): void {
      db.prepare(
        "INSERT INTO engine_transactions (operation_id, body) VALUES (?, ?) ON CONFLICT (operation_id) DO UPDATE SET body = excluded.body"
      ).run(operationId, transactionTextDecoder.decode(bytes));
    },
    deleteRecord(operationId: string): void {
      db.prepare("DELETE FROM engine_transactions WHERE operation_id = ?").run(operationId);
    },
    listOperationIds(): readonly string[] {
      const rows = db
        .prepare("SELECT operation_id FROM engine_transactions ORDER BY rowid")
        .all() as { operation_id: string }[];
      return rows.map((row) => row.operation_id);
    },
    claim(operationId: string, claimedAt: string): boolean {
      // Invocation-once via the primary key: a second claim inserts nothing.
      const changed = changesOf(
        db
          .prepare(
            "INSERT INTO engine_transaction_claims (operation_id, claimed_at) VALUES (?, ?) ON CONFLICT (operation_id) DO NOTHING"
          )
          .run(operationId, claimedAt)
      );
      return changed === 1;
    },
    hasClaim(operationId: string): boolean {
      const row = db
        .prepare("SELECT operation_id FROM engine_transaction_claims WHERE operation_id = ?")
        .get(operationId);
      return row !== undefined;
    },
  };

  function readTaskRow(taskId: string): ControlPlaneTaskRecordV1 | undefined {
    const row = db.prepare("SELECT record FROM tasks WHERE task_id = ?").get(taskId) as
      | { record: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.record) as ControlPlaneTaskRecordV1);
  }

  function updateTaskRow(record: ControlPlaneTaskRecordV1): void {
    db.prepare("UPDATE tasks SET record = ? WHERE task_id = ?").run(
      JSON.stringify(record),
      record.taskId
    );
  }

  return {
    gates,
    attempts,
    leases,
    engineTransactions,

    upsertUserByIdentity(provider: string, providerSubjectId: string): ControlPlaneUserRecordV1 {
      return inTransaction(() => {
        const existing = db
          .prepare("SELECT * FROM users WHERE provider = ? AND subject_id = ?")
          .get(provider, providerSubjectId) as
          | { user_id: string; provider: string; subject_id: string; created_at: string }
          | undefined;
        if (existing !== undefined) {
          return {
            userId: existing.user_id,
            identityProvider: existing.provider,
            providerSubjectId: existing.subject_id,
            createdAt: existing.created_at,
          };
        }
        const record: ControlPlaneUserRecordV1 = {
          userId: allocateHex128IdV1(),
          identityProvider: provider,
          providerSubjectId,
          createdAt: now().toISOString(),
        };
        // The stable (provider, provider-subject-id) identity is a real
        // UNIQUE constraint on this table (plan Part 6).
        db.prepare(
          "INSERT INTO users (user_id, provider, subject_id, created_at) VALUES (?, ?, ?, ?)"
        ).run(record.userId, provider, providerSubjectId, record.createdAt);
        return record;
      });
    },

    readUser(userId: string): ControlPlaneUserRecordV1 | undefined {
      const row = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as
        | { user_id: string; provider: string; subject_id: string; created_at: string }
        | undefined;
      return row === undefined
        ? undefined
        : {
            userId: row.user_id,
            identityProvider: row.provider,
            providerSubjectId: row.subject_id,
            createdAt: row.created_at,
          };
    },

    createSessionFamily(
      family: RefreshFamilyRecordV1,
      refresh: RefreshTokenRecordV1,
      access: AccessTokenRecordV1
    ): void {
      inTransaction(() => {
        db.prepare(
          "INSERT INTO families (family_id, user_id, created_at, revoked_at) VALUES (?, ?, ?, ?)"
        ).run(family.familyId, family.userId, family.createdAt, family.revokedAt ?? null);
        db.prepare(
          "INSERT INTO refresh_tokens (token_hash, family_id, user_id, created_at, status) VALUES (?, ?, ?, ?, ?)"
        ).run(refresh.tokenHash, refresh.familyId, refresh.userId, refresh.createdAt, refresh.status);
        db.prepare(
          "INSERT INTO access_tokens (token_hash, family_id, user_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)"
        ).run(access.tokenHash, access.familyId, access.userId, access.expiresAt, access.revokedAt ?? null);
      });
    },

    findRefreshTokenByHash(tokenHash: string): RefreshTokenRecordV1 | undefined {
      const row = db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash) as
        | { token_hash: string; family_id: string; user_id: string; created_at: string; status: string }
        | undefined;
      return row === undefined
        ? undefined
        : {
            tokenHash: row.token_hash,
            familyId: row.family_id,
            userId: row.user_id,
            createdAt: row.created_at,
            status: row.status as RefreshTokenRecordV1["status"],
          };
    },

    findAccessTokenByHash(tokenHash: string): AccessTokenRecordV1 | undefined {
      const row = db.prepare("SELECT * FROM access_tokens WHERE token_hash = ?").get(tokenHash) as
        | {
            token_hash: string;
            family_id: string;
            user_id: string;
            expires_at: string;
            revoked_at: string | null;
          }
        | undefined;
      return row === undefined
        ? undefined
        : {
            tokenHash: row.token_hash,
            familyId: row.family_id,
            userId: row.user_id,
            expiresAt: row.expires_at,
            ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
          };
    },

    readFamily(familyId: string): RefreshFamilyRecordV1 | undefined {
      const row = db.prepare("SELECT * FROM families WHERE family_id = ?").get(familyId) as
        | { family_id: string; user_id: string; created_at: string; revoked_at: string | null }
        | undefined;
      return row === undefined
        ? undefined
        : {
            familyId: row.family_id,
            userId: row.user_id,
            createdAt: row.created_at,
            ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
          };
    },

    rotateRefreshToken(
      oldTokenHash: string,
      next: RefreshTokenRecordV1,
      access: AccessTokenRecordV1
    ): void {
      inTransaction(() => {
        // Rotation CAS: only an active token rotates, in one transaction
        // with its successor and the new access token.
        const rotated = changesOf(
          db
            .prepare(
              "UPDATE refresh_tokens SET status = 'rotated' WHERE token_hash = ? AND status = 'active'"
            )
            .run(oldTokenHash)
        );
        if (rotated !== 1) {
          throw new Error("only an active refresh token can rotate");
        }
        db.prepare(
          "INSERT INTO refresh_tokens (token_hash, family_id, user_id, created_at, status) VALUES (?, ?, ?, ?, ?)"
        ).run(next.tokenHash, next.familyId, next.userId, next.createdAt, next.status);
        db.prepare(
          "INSERT INTO access_tokens (token_hash, family_id, user_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)"
        ).run(access.tokenHash, access.familyId, access.userId, access.expiresAt, access.revokedAt ?? null);
      });
    },

    revokeSessionFamily(familyId: string, revokedAt: string): void {
      inTransaction(() => {
        const revoked = changesOf(
          db
            .prepare("UPDATE families SET revoked_at = ? WHERE family_id = ?")
            .run(revokedAt, familyId)
        );
        if (revoked === 0) {
          return;
        }
        db.prepare(
          "UPDATE refresh_tokens SET status = 'revoked' WHERE family_id = ? AND status != 'revoked'"
        ).run(familyId);
        db.prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL"
        ).run(revokedAt, familyId);
      });
    },

    createTask(record: ControlPlaneTaskRecordV1): void {
      inTransaction(() => {
        if (readTaskRow(record.taskId) !== undefined) {
          throw new Error(`a task already exists with id ${record.taskId}`);
        }
        db.prepare("INSERT INTO tasks (task_id, owner_user_id, record) VALUES (?, ?, ?)").run(
          record.taskId,
          record.ownerUserId,
          JSON.stringify(record)
        );
      });
    },

    readTask(taskId: string): ControlPlaneTaskRecordV1 | undefined {
      return readTaskRow(taskId);
    },

    listTasksForOwner(ownerUserId: string): readonly ControlPlaneTaskRecordV1[] {
      const rows = db
        .prepare("SELECT record FROM tasks WHERE owner_user_id = ? ORDER BY rowid")
        .all(ownerUserId) as { record: string }[];
      return rows.map((row) => JSON.parse(row.record) as ControlPlaneTaskRecordV1);
    },

    updateTaskProgress(taskId: string, progress: PersistedTaskProgressV1): void {
      inTransaction(() => {
        const record = readTaskRow(taskId);
        if (record === undefined) {
          throw new Error(`no task exists with id ${taskId}`);
        }
        updateTaskRow({ ...record, progress });
      });
    },

    appendTaskRound(taskId: string, round: TaskRoundRecordV1): void {
      inTransaction(() => {
        const record = readTaskRow(taskId);
        if (record === undefined) {
          throw new Error(`no task exists with id ${taskId}`);
        }
        updateTaskRow({ ...record, rounds: [...record.rounds, round] });
      });
    },

    appendChatTurn(
      taskId: string,
      turn: ChatTurnRecordV1,
      answerIdempotencyId?: string
    ): { readonly appended: boolean; readonly turnId: string } {
      return inTransaction(() => {
        if (answerIdempotencyId !== undefined) {
          const existing = db
            .prepare(
              "SELECT turn_id FROM chat_answer_idempotency WHERE task_id = ? AND answer_id = ?"
            )
            .get(taskId, answerIdempotencyId) as { turn_id: string } | undefined;
          if (existing !== undefined) {
            return { appended: false, turnId: existing.turn_id };
          }
          db.prepare(
            "INSERT INTO chat_answer_idempotency (task_id, answer_id, turn_id) VALUES (?, ?, ?)"
          ).run(taskId, answerIdempotencyId, turn.turnId);
        }
        const nextSeq = db
          .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM chat_turns WHERE task_id = ?")
          .get(taskId) as { next_seq: number };
        db.prepare("INSERT INTO chat_turns (task_id, seq, record) VALUES (?, ?, ?)").run(
          taskId,
          nextSeq.next_seq,
          JSON.stringify(turn)
        );
        return { appended: true, turnId: turn.turnId };
      });
    },

    listChatTurns(taskId: string): readonly ChatTurnRecordV1[] {
      const rows = db
        .prepare("SELECT record FROM chat_turns WHERE task_id = ? ORDER BY seq")
        .all(taskId) as { record: string }[];
      return rows.map((row) => JSON.parse(row.record) as ChatTurnRecordV1);
    },

    upsertJob(job: EngineJobRecordV1): void {
      db.prepare(
        "INSERT INTO jobs (job_id, status, record) VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET status = excluded.status, record = excluded.record"
      ).run(job.jobId, job.status, JSON.stringify(job));
    },

    readJob(jobId: string): EngineJobRecordV1 | undefined {
      const row = db.prepare("SELECT record FROM jobs WHERE job_id = ?").get(jobId) as
        | { record: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.record) as EngineJobRecordV1);
    },

    listJobsByStatus(status: EngineJobStatusV1): readonly EngineJobRecordV1[] {
      const rows = db
        .prepare("SELECT record FROM jobs WHERE status = ? ORDER BY rowid")
        .all(status) as { record: string }[];
      return rows.map((row) => JSON.parse(row.record) as EngineJobRecordV1);
    },

    writeKeyRecord(record: ControlPlaneKeyRecordV1): void {
      db.prepare(
        "INSERT INTO key_records (owner_user_id, key_kind, record) VALUES (?, ?, ?) ON CONFLICT (owner_user_id, key_kind) DO UPDATE SET record = excluded.record"
      ).run(record.ownerUserId, record.keyKind, JSON.stringify(record));
    },

    readKeyRecord(ownerUserId: string, keyKind: string): ControlPlaneKeyRecordV1 | undefined {
      const row = db
        .prepare("SELECT record FROM key_records WHERE owner_user_id = ? AND key_kind = ?")
        .get(ownerUserId, keyKind) as { record: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.record) as ControlPlaneKeyRecordV1);
    },

    deleteKeyRecord(ownerUserId: string, keyKind: string): boolean {
      const changed = changesOf(
        db
          .prepare("DELETE FROM key_records WHERE owner_user_id = ? AND key_kind = ?")
          .run(ownerUserId, keyKind)
      );
      return changed === 1;
    },

    listKeyRecordsForOwner(ownerUserId: string): readonly ControlPlaneKeyRecordV1[] {
      const rows = db
        .prepare("SELECT record FROM key_records WHERE owner_user_id = ? ORDER BY rowid")
        .all(ownerUserId) as { record: string }[];
      return rows.map((row) => JSON.parse(row.record) as ControlPlaneKeyRecordV1);
    },

    close(): void {
      db.close();
    },
  };
}
