/**
 * The control plane's durable store (plan Part 5).
 *
 * ONE storage interface holds everything the plan names: sessions and
 * refresh-token families, user identity records keyed by
 * (provider, provider-subject-id), task records, sandbox bindings, engine
 * job state, gate/command records, execution-attempt/effect records, and
 * per-user key material (as encrypted envelopes — `keyCustodyV1.ts` is the
 * only module that ever sees plaintext, and only in memory).
 *
 * The store implements the engine's Part 4c interfaces (`EngineGateStoreV1`,
 * `EngineExecutionAttemptStoreV1`, `EngineLeaseStoreV1`) over a persisted
 * document, so `createEngineGateMachineryV1` runs against it unchanged and
 * the 4c crash-injection tests re-run against THIS implementation
 * (tests/crashInjection.test.ts) — including a real restart: a new store
 * instance loaded from the same persisted document.
 *
 * Atomicity model: every mutation is one synchronous check-and-set on the
 * in-memory document followed by a durable save BEFORE the mutation's
 * promise resolves — the document-store stand-in for the plan's reference
 * Postgres transaction (atomic CAS on the gate row + the scoped unique
 * constraint). A save that throws leaves the caller seeing a failed write
 * and the on-disk document unchanged — exactly what a crashed transaction
 * leaves behind. Swapping in Postgres touches only this module: the CAS +
 * unique-constraint + lease + attempt-record semantics are requirements on
 * this interface, which the store tests pin.
 *
 * The file persistence writes via temp-file + rename (atomic on POSIX; on
 * Windows, rename-over is a single replace) so a crash mid-save never
 * leaves a torn document.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { allocateHex128IdV1, isHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import {
  computeGateDecisionFingerprintV1,
  GateDecisionCommandV1,
  GateDecisionRecordV1,
  gateStateForDecisionV1,
} from "../../ensemble-core/src/gateV1";
import type { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import type { SandboxBindingV1 } from "../../ensemble-contract/src/sandboxBindingV1";
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
import type { KeyEnvelopeV1 } from "./keyCustodyV1";

/** Where the serialized document lives between mutations. */
export interface ControlPlanePersistenceV1 {
  load(): string | undefined;
  save(serializedDocument: string): void;
}

export function createInMemoryControlPlanePersistenceV1(): ControlPlanePersistenceV1 {
  let current: string | undefined;
  return {
    load: (): string | undefined => current,
    save(serializedDocument: string): void {
      current = serializedDocument;
    },
  };
}

/** Atomic file persistence: write a temp file, then rename over the target. */
export function createFileControlPlanePersistenceV1(filePath: string): ControlPlanePersistenceV1 {
  return {
    load(): string | undefined {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return undefined;
      }
    },
    save(serializedDocument: string): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      writeFileSync(temp, serializedDocument, "utf8");
      try {
        renameSync(temp, filePath);
      } catch {
        // Windows rename-over can refuse while a reader holds the target:
        // replace explicitly, still never leaving a torn document.
        rmSync(filePath, { force: true });
        renameSync(temp, filePath);
      }
    },
  };
}

/** A registered user, keyed by stable (provider, provider-subject-id). */
export interface ControlPlaneUserRecordV1 {
  readonly userId: string;
  readonly identityProvider: string;
  readonly providerSubjectId: string;
  readonly createdAt: string;
}

/** A refresh-token family (one sign-in lineage; reuse revokes the family). */
export interface RefreshFamilyRecordV1 {
  readonly familyId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export type RefreshTokenStatusV1 = "active" | "rotated" | "revoked";

/** One refresh token, stored ONLY as a hash — never the token itself. */
export interface RefreshTokenRecordV1 {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly status: RefreshTokenStatusV1;
}

/** One access token, stored ONLY as a hash. */
export interface AccessTokenRecordV1 {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly userId: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

/** One per-round history entry (Part 7 task detail). */
export interface TaskRoundRecordV1 {
  readonly roundId: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly summary?: string;
}

/** One chat turn in a task's thread. */
export interface ChatTurnRecordV1 {
  readonly turnId: string;
  readonly role: "user" | "assistant" | "system";
  readonly at: string;
  readonly text?: string;
  readonly interactionId?: string;
}

/** A persisted task with its owner, binding, and progress snapshot. */
export interface ControlPlaneTaskRecordV1 {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly displayName?: string;
  readonly request: string;
  /**
   * Normalized provider-qualified model id the task's engine rounds run
   * with (Part 9 selection round trip); absent means the default chain.
   */
  readonly modelId?: string;
  readonly binding: SandboxBindingV1;
  readonly progress: PersistedTaskProgressV1;
  readonly rounds: readonly TaskRoundRecordV1[];
  readonly createdAt: string;
}

export type EngineJobStatusV1 =
  | "running"
  | "gatePaused"
  | "questionsPaused"
  | "completed"
  | "failed";

/**
 * The durable resume point of a question-paused hosted run: everything a
 * restarted control plane needs to rebuild the engine task and route the
 * user's answers back into the recorded interaction.
 */
export interface EngineJobPausedInteractionV1 {
  readonly interactionId: string;
  readonly operationId: string;
  readonly taskBindingId: string;
  readonly chatDocumentId: string;
  readonly sourceAttemptId: string;
  /** The plan of record at pause (accumulated checklist state included). */
  readonly planOfRecord: string;
}

/** Engine job checkpoint: what a restarted control plane resumes from. */
export interface EngineJobRecordV1 {
  readonly jobId: string;
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly status: EngineJobStatusV1;
  /** Present while gate-paused: the gate the job is waiting on. */
  readonly pausedGateId?: string;
  /** Present while question-paused: the durable resume point. */
  readonly pausedInteraction?: EngineJobPausedInteractionV1;
  readonly updatedAt: string;
}

/** A stored key record: the encrypted envelope plus display metadata. */
export interface ControlPlaneKeyRecordV1 {
  readonly keyKind: string;
  readonly ownerUserId: string;
  readonly envelope: KeyEnvelopeV1;
  /** Last-4-style mask for display; never the material. */
  readonly maskedHint: string;
  readonly updatedAt: string;
}

interface ControlPlaneDocumentV1 {
  users: Record<string, ControlPlaneUserRecordV1>;
  usersByIdentity: Record<string, string>;
  families: Record<string, RefreshFamilyRecordV1>;
  refreshTokens: Record<string, RefreshTokenRecordV1>;
  accessTokens: Record<string, AccessTokenRecordV1>;
  tasks: Record<string, ControlPlaneTaskRecordV1>;
  chat: Record<string, ChatTurnRecordV1[]>;
  chatAnswerIdempotency: Record<string, string>;
  gates: Record<string, EngineGateRecordV1>;
  attempts: Record<string, ExecutionAttemptRecordV1>;
  leases: Record<string, { workerId: string; expiresAtMs: number }>;
  jobs: Record<string, EngineJobRecordV1>;
  keys: Record<string, ControlPlaneKeyRecordV1>;
  /** Engine chat-transaction records, canonical JSON text per operation. */
  engineTransactions: Record<string, string>;
  /** Invocation-once claims per operation (claimedAt ISO timestamp). */
  engineTransactionClaims: Record<string, string>;
}

function emptyDocument(): ControlPlaneDocumentV1 {
  return {
    users: {},
    usersByIdentity: {},
    families: {},
    refreshTokens: {},
    accessTokens: {},
    tasks: {},
    chat: {},
    chatAnswerIdempotency: {},
    gates: {},
    attempts: {},
    leases: {},
    jobs: {},
    keys: {},
    engineTransactions: {},
    engineTransactionClaims: {},
  };
}

function identityKey(provider: string, subjectId: string): string {
  return `${provider}\n${subjectId}`;
}

function keyRecordKey(userId: string, keyKind: string): string {
  return `${userId}\n${keyKind}`;
}

export interface ControlPlaneStoreV1 {
  /** The engine's Part 4c interfaces, persisted (crash tests run on these). */
  readonly gates: EngineGateStoreV1;
  readonly attempts: EngineExecutionAttemptStoreV1;
  readonly leases: EngineLeaseStoreV1;
  /**
   * Durable backing for the engine's Part 4a chat-transaction store: record
   * bytes and invocation-once claims persist with the document, so a
   * question-paused hosted run survives a control-plane restart.
   */
  readonly engineTransactions: EngineTransactionStoreBackendV1;

  // Identity (Part 6: stable (provider, provider-subject-id), never email).
  upsertUserByIdentity(provider: string, providerSubjectId: string): ControlPlaneUserRecordV1;
  readUser(userId: string): ControlPlaneUserRecordV1 | undefined;

  // Session records (logic in sessionServiceV1; each call here is atomic).
  createSessionFamily(
    family: RefreshFamilyRecordV1,
    refresh: RefreshTokenRecordV1,
    access: AccessTokenRecordV1
  ): void;
  findRefreshTokenByHash(tokenHash: string): RefreshTokenRecordV1 | undefined;
  findAccessTokenByHash(tokenHash: string): AccessTokenRecordV1 | undefined;
  readFamily(familyId: string): RefreshFamilyRecordV1 | undefined;
  /** Mark the old refresh token rotated and insert its successor + new access. */
  rotateRefreshToken(
    oldTokenHash: string,
    next: RefreshTokenRecordV1,
    access: AccessTokenRecordV1
  ): void;
  /** Revoke a whole family: family row, every refresh token, every access token. */
  revokeSessionFamily(familyId: string, revokedAt: string): void;

  // Tasks / bindings / history / chat.
  createTask(record: ControlPlaneTaskRecordV1): void;
  readTask(taskId: string): ControlPlaneTaskRecordV1 | undefined;
  listTasksForOwner(ownerUserId: string): readonly ControlPlaneTaskRecordV1[];
  updateTaskProgress(taskId: string, progress: PersistedTaskProgressV1): void;
  appendTaskRound(taskId: string, round: TaskRoundRecordV1): void;
  /**
   * Append a chat turn; `answerIdempotencyId` (scoped to the task) dedupes
   * structured-answer submissions — a replay returns `appended: false` and
   * the original turn id.
   */
  appendChatTurn(
    taskId: string,
    turn: ChatTurnRecordV1,
    answerIdempotencyId?: string
  ): { readonly appended: boolean; readonly turnId: string };
  listChatTurns(taskId: string): readonly ChatTurnRecordV1[];

  // Engine job checkpoints (restart/recovery, criterion 2).
  upsertJob(job: EngineJobRecordV1): void;
  readJob(jobId: string): EngineJobRecordV1 | undefined;
  listJobsByStatus(status: EngineJobStatusV1): readonly EngineJobRecordV1[];

  // Key custody records (envelopes only; material never stored plaintext).
  writeKeyRecord(record: ControlPlaneKeyRecordV1): void;
  readKeyRecord(ownerUserId: string, keyKind: string): ControlPlaneKeyRecordV1 | undefined;
  deleteKeyRecord(ownerUserId: string, keyKind: string): boolean;
  listKeyRecordsForOwner(ownerUserId: string): readonly ControlPlaneKeyRecordV1[];
}

export interface CreateControlPlaneStoreOptionsV1 {
  readonly persistence?: ControlPlanePersistenceV1;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export function createControlPlaneStoreV1(
  options?: CreateControlPlaneStoreOptionsV1
): ControlPlaneStoreV1 {
  const persistence = options?.persistence ?? createInMemoryControlPlanePersistenceV1();
  const now = options?.now ?? ((): Date => new Date());

  const loaded = persistence.load();
  const document: ControlPlaneDocumentV1 =
    loaded === undefined
      ? emptyDocument()
      : { ...emptyDocument(), ...(JSON.parse(loaded) as ControlPlaneDocumentV1) };

  /** Durable save BEFORE the mutation's promise resolves. */
  function persist(): void {
    persistence.save(JSON.stringify(document));
  }

  const gates: EngineGateStoreV1 = {
    create(input: CreateEngineGateInputV1): Promise<EngineGateRecordV1> {
      const gateId = input.gateId ?? allocateHex128IdV1();
      if (document.gates[gateId] !== undefined) {
        return Promise.reject(new Error(`a gate already exists with id ${gateId}`));
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
      document.gates[gateId] = record;
      persist();
      return Promise.resolve(record);
    },

    read(gateId: string): Promise<EngineGateRecordV1 | undefined> {
      return Promise.resolve(document.gates[gateId]);
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
      const record = document.gates[command.gateId];
      if (record === undefined || record.ownerId !== ownerId) {
        // Ownership mismatch deliberately reads identically to absence.
        return Promise.resolve({
          kind: "error",
          code: "gateNotFound",
          reason: "no such gate for the authenticated owner",
        });
      }
      const fingerprint = computeGateDecisionFingerprintV1(command);
      if (record.decision !== undefined) {
        if (record.decision.idempotencyKey === command.idempotencyKey) {
          if (record.decision.requestFingerprint === fingerprint) {
            return Promise.resolve({ kind: "replayed", record });
          }
          return Promise.resolve({
            kind: "error",
            code: "gateDecisionPayloadMismatch",
            reason: "this idempotency key was already used with a different decision payload",
          });
        }
        return Promise.resolve({
          kind: "error",
          code: "gateAlreadyDecided",
          reason: `the gate is already ${record.state}`,
        });
      }
      if (record.state !== "pending") {
        return Promise.resolve({
          kind: "error",
          code: "gateAlreadyDecided",
          reason: `the gate is already ${record.state}`,
        });
      }
      // The atomic CAS `pending → approved|rejected` plus the (owner, gate,
      // idempotency key) uniqueness, written and persisted as one step.
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
      document.gates[record.gateId] = next;
      persist();
      return Promise.resolve({ kind: "decided", record: next });
    },

    markResumed(
      gateId: string
    ): Promise<{ readonly consumed: boolean; readonly record: EngineGateRecordV1 | undefined }> {
      const record = document.gates[gateId];
      if (record === undefined) {
        return Promise.resolve({ consumed: false, record: undefined });
      }
      if (record.resumedAt !== undefined) {
        return Promise.resolve({ consumed: false, record });
      }
      const next: EngineGateRecordV1 = { ...record, resumedAt: now().toISOString() };
      document.gates[gateId] = next;
      persist();
      return Promise.resolve({ consumed: true, record: next });
    },

    listForTask(taskId: string): Promise<readonly EngineGateRecordV1[]> {
      return Promise.resolve(
        Object.values(document.gates).filter((record) => record.taskId === taskId)
      );
    },
  };

  function terminalAttempt(
    attemptKey: string,
    state: "succeeded" | "failed" | "indeterminate",
    outcomeCode?: string
  ): Promise<ExecutionAttemptRecordV1> {
    const record = document.attempts[attemptKey];
    if (record === undefined) {
      return Promise.reject(new Error(`no execution attempt exists for key ${attemptKey}`));
    }
    if (record.state !== "pending") {
      // First terminal state wins; repeats are idempotent no-ops.
      return Promise.resolve(record);
    }
    const next: ExecutionAttemptRecordV1 = {
      ...record,
      state,
      completedAt: now().toISOString(),
      ...(outcomeCode !== undefined ? { outcomeCode } : {}),
    };
    document.attempts[attemptKey] = next;
    persist();
    return Promise.resolve(next);
  }

  const attempts: EngineExecutionAttemptStoreV1 = {
    begin(
      input: BeginExecutionAttemptInputV1
    ): Promise<{ readonly created: boolean; readonly record: ExecutionAttemptRecordV1 }> {
      const existing = document.attempts[input.attemptKey];
      if (existing !== undefined) {
        return Promise.resolve({ created: false, record: existing });
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
      document.attempts[input.attemptKey] = record;
      persist();
      return Promise.resolve({ created: true, record });
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
      return Promise.resolve(document.attempts[attemptKey]);
    },

    listForGate(gateId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      return Promise.resolve(
        Object.values(document.attempts)
          .filter((record) => record.gateId === gateId)
          .sort((a, b) => a.lineage - b.lineage)
      );
    },

    listOpenForTask(taskId: string): Promise<readonly ExecutionAttemptRecordV1[]> {
      return Promise.resolve(
        Object.values(document.attempts)
          .filter((record) => record.taskId === taskId && record.state === "pending")
          .sort((a, b) => a.lineage - b.lineage)
      );
    },
  };

  const transactionTextEncoder = new TextEncoder();
  const transactionTextDecoder = new TextDecoder();

  /**
   * The engine transaction store's storage seam over this document: every
   * mutation persists before it returns, and the invocation-once claim is
   * one synchronous check-and-set on the persisted claim registry.
   */
  const engineTransactions: EngineTransactionStoreBackendV1 = {
    readRecordBytes(operationId: string): Uint8Array | undefined {
      const text = document.engineTransactions[operationId];
      return text === undefined ? undefined : transactionTextEncoder.encode(text);
    },
    writeRecordBytes(operationId: string, bytes: Uint8Array): void {
      document.engineTransactions[operationId] = transactionTextDecoder.decode(bytes);
      persist();
    },
    deleteRecord(operationId: string): void {
      if (document.engineTransactions[operationId] !== undefined) {
        delete document.engineTransactions[operationId];
        persist();
      }
    },
    listOperationIds(): readonly string[] {
      return Object.keys(document.engineTransactions);
    },
    claim(operationId: string, claimedAt: string): boolean {
      if (document.engineTransactionClaims[operationId] !== undefined) {
        return false;
      }
      document.engineTransactionClaims[operationId] = claimedAt;
      persist();
      return true;
    },
    hasClaim(operationId: string): boolean {
      return document.engineTransactionClaims[operationId] !== undefined;
    },
  };

  const leases: EngineLeaseStoreV1 = {
    acquire(jobId: string, workerId: string, ttlMs: number): Promise<EngineLeaseAcquireResultV1> {
      const nowMs = now().getTime();
      const lease = document.leases[jobId];
      if (lease !== undefined && lease.workerId !== workerId && lease.expiresAtMs > nowMs) {
        return Promise.resolve({ acquired: false, holderWorkerId: lease.workerId });
      }
      document.leases[jobId] = { workerId, expiresAtMs: nowMs + ttlMs };
      persist();
      return Promise.resolve({ acquired: true });
    },

    heartbeat(jobId: string, workerId: string, ttlMs: number): Promise<boolean> {
      const nowMs = now().getTime();
      const lease = document.leases[jobId];
      if (lease === undefined || lease.workerId !== workerId || lease.expiresAtMs <= nowMs) {
        return Promise.resolve(false);
      }
      document.leases[jobId] = { workerId, expiresAtMs: nowMs + ttlMs };
      persist();
      return Promise.resolve(true);
    },

    release(jobId: string, workerId: string): Promise<void> {
      const lease = document.leases[jobId];
      if (lease !== undefined && lease.workerId === workerId) {
        delete document.leases[jobId];
        persist();
      }
      return Promise.resolve();
    },
  };

  return {
    gates,
    attempts,
    leases,
    engineTransactions,

    upsertUserByIdentity(provider: string, providerSubjectId: string): ControlPlaneUserRecordV1 {
      const key = identityKey(provider, providerSubjectId);
      const existingId = document.usersByIdentity[key];
      if (existingId !== undefined) {
        const existing = document.users[existingId];
        if (existing !== undefined) {
          return existing;
        }
      }
      const record: ControlPlaneUserRecordV1 = {
        userId: allocateHex128IdV1(),
        identityProvider: provider,
        providerSubjectId,
        createdAt: now().toISOString(),
      };
      document.users[record.userId] = record;
      document.usersByIdentity[key] = record.userId;
      persist();
      return record;
    },

    readUser(userId: string): ControlPlaneUserRecordV1 | undefined {
      return document.users[userId];
    },

    createSessionFamily(
      family: RefreshFamilyRecordV1,
      refresh: RefreshTokenRecordV1,
      access: AccessTokenRecordV1
    ): void {
      document.families[family.familyId] = family;
      document.refreshTokens[refresh.tokenHash] = refresh;
      document.accessTokens[access.tokenHash] = access;
      persist();
    },

    findRefreshTokenByHash(tokenHash: string): RefreshTokenRecordV1 | undefined {
      return document.refreshTokens[tokenHash];
    },

    findAccessTokenByHash(tokenHash: string): AccessTokenRecordV1 | undefined {
      return document.accessTokens[tokenHash];
    },

    readFamily(familyId: string): RefreshFamilyRecordV1 | undefined {
      return document.families[familyId];
    },

    rotateRefreshToken(
      oldTokenHash: string,
      next: RefreshTokenRecordV1,
      access: AccessTokenRecordV1
    ): void {
      const old = document.refreshTokens[oldTokenHash];
      if (old === undefined || old.status !== "active") {
        throw new Error("only an active refresh token can rotate");
      }
      document.refreshTokens[oldTokenHash] = { ...old, status: "rotated" };
      document.refreshTokens[next.tokenHash] = next;
      document.accessTokens[access.tokenHash] = access;
      persist();
    },

    revokeSessionFamily(familyId: string, revokedAt: string): void {
      const family = document.families[familyId];
      if (family === undefined) {
        return;
      }
      document.families[familyId] = { ...family, revokedAt };
      for (const [hash, token] of Object.entries(document.refreshTokens)) {
        if (token.familyId === familyId && token.status !== "revoked") {
          document.refreshTokens[hash] = { ...token, status: "revoked" };
        }
      }
      for (const [hash, token] of Object.entries(document.accessTokens)) {
        if (token.familyId === familyId && token.revokedAt === undefined) {
          document.accessTokens[hash] = { ...token, revokedAt };
        }
      }
      persist();
    },

    createTask(record: ControlPlaneTaskRecordV1): void {
      if (document.tasks[record.taskId] !== undefined) {
        throw new Error(`a task already exists with id ${record.taskId}`);
      }
      document.tasks[record.taskId] = record;
      persist();
    },

    readTask(taskId: string): ControlPlaneTaskRecordV1 | undefined {
      return document.tasks[taskId];
    },

    listTasksForOwner(ownerUserId: string): readonly ControlPlaneTaskRecordV1[] {
      return Object.values(document.tasks).filter(
        (record) => record.ownerUserId === ownerUserId
      );
    },

    updateTaskProgress(taskId: string, progress: PersistedTaskProgressV1): void {
      const record = document.tasks[taskId];
      if (record === undefined) {
        throw new Error(`no task exists with id ${taskId}`);
      }
      document.tasks[taskId] = { ...record, progress };
      persist();
    },

    appendTaskRound(taskId: string, round: TaskRoundRecordV1): void {
      const record = document.tasks[taskId];
      if (record === undefined) {
        throw new Error(`no task exists with id ${taskId}`);
      }
      document.tasks[taskId] = { ...record, rounds: [...record.rounds, round] };
      persist();
    },

    appendChatTurn(
      taskId: string,
      turn: ChatTurnRecordV1,
      answerIdempotencyId?: string
    ): { readonly appended: boolean; readonly turnId: string } {
      if (answerIdempotencyId !== undefined) {
        const dedupeKey = `${taskId}\n${answerIdempotencyId}`;
        const existingTurnId = document.chatAnswerIdempotency[dedupeKey];
        if (existingTurnId !== undefined) {
          return { appended: false, turnId: existingTurnId };
        }
        document.chatAnswerIdempotency[dedupeKey] = turn.turnId;
      }
      const turns = document.chat[taskId] ?? [];
      turns.push(turn);
      document.chat[taskId] = turns;
      persist();
      return { appended: true, turnId: turn.turnId };
    },

    listChatTurns(taskId: string): readonly ChatTurnRecordV1[] {
      return document.chat[taskId] ?? [];
    },

    upsertJob(job: EngineJobRecordV1): void {
      document.jobs[job.jobId] = job;
      persist();
    },

    readJob(jobId: string): EngineJobRecordV1 | undefined {
      return document.jobs[jobId];
    },

    listJobsByStatus(status: EngineJobStatusV1): readonly EngineJobRecordV1[] {
      return Object.values(document.jobs).filter((job) => job.status === status);
    },

    writeKeyRecord(record: ControlPlaneKeyRecordV1): void {
      document.keys[keyRecordKey(record.ownerUserId, record.keyKind)] = record;
      persist();
    },

    readKeyRecord(ownerUserId: string, keyKind: string): ControlPlaneKeyRecordV1 | undefined {
      return document.keys[keyRecordKey(ownerUserId, keyKind)];
    },

    deleteKeyRecord(ownerUserId: string, keyKind: string): boolean {
      const key = keyRecordKey(ownerUserId, keyKind);
      if (document.keys[key] === undefined) {
        return false;
      }
      delete document.keys[key];
      persist();
      return true;
    },

    listKeyRecordsForOwner(ownerUserId: string): readonly ControlPlaneKeyRecordV1[] {
      return Object.values(document.keys).filter(
        (record) => record.ownerUserId === ownerUserId
      );
    },
  };
}
