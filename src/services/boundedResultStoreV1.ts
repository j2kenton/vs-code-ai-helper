/**
 * Coordinator-owned provider result spool store (plan §3.2).
 *
 * Spools hold large sealed provider responses privately until the
 * coordinator settles them. They are:
 *  - correlation-bound: metadata carries the complete correlation tuple plus
 *    the reservation id, and a claim must present the identical tuple;
 *  - integrity-checked: raw bytes are length- and SHA-256-verified on claim;
 *  - claim-once: a durable exclusive marker makes a second claim fail;
 *  - removed after settlement and expired within 24 hours.
 *
 * Layout under the injected private root (allocated by the workflow path
 * registry's provider-results family — workflowPathRegistryV1, plan §2.1;
 * the Runner V1 spool store adopts registry-vended locators when its
 * consuming cohort wires the two together):
 *
 *   <rootDir>/<operationId>/<attemptId>/<reservationId>/result-v1.bin
 *   <rootDir>/<operationId>/<attemptId>/<reservationId>/spool-meta-v1.json
 *   <rootDir>/<operationId>/<attemptId>/<reservationId>/claimed-v1.marker
 *
 * Spool content is transient provider data (plan §2.2): it must never be
 * surfaced in logs or artifacts — callers log only correlation ids, byte
 * counts, and digests.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  ActionCorrelationV1,
  correlationMatchesV1,
  isHex128IdV1,
  ReservationIdV1,
} from "../types/actionCorrelationV1";
import { ResultSpoolRefV1 } from "../types/agentExecutionV1";

/** Spools expire 24 hours after creation (plan §3.2). */
export const RESULT_SPOOL_EXPIRY_MS_V1 = 24 * 60 * 60 * 1000;

const SPOOL_BIN_NAME_V1 = "result-v1.bin";
const SPOOL_META_NAME_V1 = "spool-meta-v1.json";
const SPOOL_CLAIM_MARKER_NAME_V1 = "claimed-v1.marker";

export class BoundedResultStoreErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedResultStoreErrorV1";
  }
}

export type SpoolClaimFailureCodeV1 =
  | "spoolMissing"
  | "spoolAlreadyClaimed"
  | "spoolCorrelationMismatch"
  | "spoolIntegrityMismatch"
  | "spoolExpired";

export type SpoolClaimResultV1 =
  | { readonly ok: true; readonly utf8Text: string; readonly ref: ResultSpoolRefV1 }
  | { readonly ok: false; readonly code: SpoolClaimFailureCodeV1 };

export interface BoundedResultStoreV1 {
  readonly storeId: string;
  /** Seal raw response bytes into a new spool for the given correlation/reservation. */
  writeSpool(
    correlation: ActionCorrelationV1,
    reservationId: ReservationIdV1,
    rawBytes: Buffer
  ): Promise<ResultSpoolRefV1>;
  /**
   * Claim a spool exactly once. Verifies the caller's correlation tuple,
   * expiry, and the raw bytes' length/hash before returning the decoded
   * UTF-8 text. Any failure returns a stable code; only a successful claim
   * consumes the spool's single claim.
   */
  claimSpoolOnce(
    ref: ResultSpoolRefV1,
    expectedCorrelation: ActionCorrelationV1
  ): Promise<SpoolClaimResultV1>;
  /** Remove a settled spool (exact known files, then empty directories). */
  removeSpool(ref: ResultSpoolRefV1): Promise<void>;
  /** Sweep expired spools; returns how many were removed. */
  expireStaleSpools(): Promise<number>;
}

interface SpoolMetaV1 extends ResultSpoolRefV1 {
  readonly schemaVersion: 1;
}

function spoolDir(rootDir: string, ref: {
  readonly operationId: string;
  readonly attemptId: string;
  readonly reservationId: string;
}): string {
  return path.join(rootDir, ref.operationId, ref.attemptId, ref.reservationId);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** rmdir that tolerates "not empty"/"already gone" — used to fold up per-spool directory chains. */
async function removeDirIfEmpty(dirPath: string): Promise<void> {
  try {
    await fs.promises.rmdir(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM") {
      throw error;
    }
  }
}

function decodeSpoolMeta(rawJson: string): SpoolMetaV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const m = parsed as Record<string, unknown>;
  if (
    m.schemaVersion !== 1 ||
    typeof m.actionKey !== "string" || m.actionKey.length === 0 ||
    !isHex128IdV1(m.operationId) ||
    !isHex128IdV1(m.attemptId) ||
    !isHex128IdV1(m.reservationId) ||
    typeof m.taskBindingId !== "string" || m.taskBindingId.length === 0 ||
    typeof m.chatDocumentId !== "string" || m.chatDocumentId.length === 0 ||
    typeof m.storeId !== "string" || m.storeId.length === 0 ||
    typeof m.byteLength !== "number" || !Number.isInteger(m.byteLength) || m.byteLength < 0 ||
    typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) ||
    typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt)) ||
    typeof m.expiresAt !== "string" || Number.isNaN(Date.parse(m.expiresAt))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    actionKey: m.actionKey,
    operationId: m.operationId,
    attemptId: m.attemptId,
    taskBindingId: m.taskBindingId,
    chatDocumentId: m.chatDocumentId,
    reservationId: m.reservationId,
    storeId: m.storeId,
    byteLength: m.byteLength,
    sha256: m.sha256,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
  };
}

export function createBoundedResultStoreV1(options: {
  readonly rootDir: string;
  readonly storeId?: string;
  /** Injectable clock for deterministic expiry tests. */
  readonly now?: () => Date;
}): BoundedResultStoreV1 {
  const rootDir = options.rootDir;
  const storeId = options.storeId ?? "provider-results-v1";
  const now = options.now ?? ((): Date => new Date());

  async function removeSpoolInternal(ref: {
    readonly operationId: string;
    readonly attemptId: string;
    readonly reservationId: string;
  }): Promise<void> {
    const dir = spoolDir(rootDir, ref);
    await removeFileIfPresent(path.join(dir, SPOOL_BIN_NAME_V1));
    await removeFileIfPresent(path.join(dir, SPOOL_META_NAME_V1));
    await removeFileIfPresent(path.join(dir, SPOOL_CLAIM_MARKER_NAME_V1));
    await removeDirIfEmpty(dir);
    await removeDirIfEmpty(path.dirname(dir));
    await removeDirIfEmpty(path.dirname(path.dirname(dir)));
  }

  return {
    storeId,

    async writeSpool(
      correlation: ActionCorrelationV1,
      reservationId: ReservationIdV1,
      rawBytes: Buffer
    ): Promise<ResultSpoolRefV1> {
      if (
        !isHex128IdV1(correlation.operationId) ||
        !isHex128IdV1(correlation.attemptId) ||
        !isHex128IdV1(reservationId) ||
        typeof correlation.actionKey !== "string" || correlation.actionKey.length === 0 ||
        typeof correlation.taskBindingId !== "string" || correlation.taskBindingId.length === 0 ||
        typeof correlation.chatDocumentId !== "string" || correlation.chatDocumentId.length === 0
      ) {
        throw new BoundedResultStoreErrorV1(
          "Refused to write a result spool without a complete, well-formed correlation tuple and reservation id."
        );
      }
      const createdAt = now();
      const ref: ResultSpoolRefV1 = {
        actionKey: correlation.actionKey,
        operationId: correlation.operationId,
        attemptId: correlation.attemptId,
        taskBindingId: correlation.taskBindingId,
        chatDocumentId: correlation.chatDocumentId,
        reservationId,
        storeId,
        byteLength: rawBytes.length,
        sha256: sha256Hex(rawBytes),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + RESULT_SPOOL_EXPIRY_MS_V1).toISOString(),
      };
      const dir = spoolDir(rootDir, ref);
      await fs.promises.mkdir(dir, { recursive: true });
      const meta: SpoolMetaV1 = { schemaVersion: 1, ...ref };
      // Exclusive creation: a reservation is invocation-once, so a second
      // spool write for the same reservation is always a protocol violation.
      // A spool becomes durable only once BOTH files exist; a failure after
      // the binary write must not leave unsealed provider bytes behind until
      // a later sweep, so exactly the files this call created are removed
      // immediately before the failure propagates.
      const written: string[] = [];
      try {
        const binPath = path.join(dir, SPOOL_BIN_NAME_V1);
        await fs.promises.writeFile(binPath, rawBytes, { flag: "wx" });
        written.push(binPath);
        const metaPath = path.join(dir, SPOOL_META_NAME_V1);
        await fs.promises.writeFile(metaPath, JSON.stringify(meta), {
          flag: "wx",
          encoding: "utf8",
        });
        written.push(metaPath);
      } catch (error) {
        try {
          for (const partialPath of written) {
            await removeFileIfPresent(partialPath);
          }
          await removeDirIfEmpty(dir);
          await removeDirIfEmpty(path.dirname(dir));
          await removeDirIfEmpty(path.dirname(path.dirname(dir)));
        } catch {
          // The write failure below is the authoritative error; a cleanup
          // failure here leaves at most files the expiry sweep removes.
        }
        throw error;
      }
      return ref;
    },

    async claimSpoolOnce(
      ref: ResultSpoolRefV1,
      expectedCorrelation: ActionCorrelationV1
    ): Promise<SpoolClaimResultV1> {
      const dir = spoolDir(rootDir, ref);
      let metaRaw: string;
      try {
        metaRaw = await fs.promises.readFile(path.join(dir, SPOOL_META_NAME_V1), "utf8");
      } catch {
        return { ok: false, code: "spoolMissing" };
      }
      const meta = decodeSpoolMeta(metaRaw);
      if (!meta) {
        return { ok: false, code: "spoolIntegrityMismatch" };
      }
      // Correlation is checked before any content processing (plan §3.1).
      if (
        !correlationMatchesV1(expectedCorrelation, meta) ||
        meta.reservationId !== ref.reservationId ||
        meta.storeId !== storeId
      ) {
        return { ok: false, code: "spoolCorrelationMismatch" };
      }
      if (now().getTime() > Date.parse(meta.expiresAt)) {
        await removeSpoolInternal(ref);
        return { ok: false, code: "spoolExpired" };
      }
      // A fast-path check so an already-claimed spool fails before any byte
      // read; the exclusive marker write below remains the authoritative
      // claim-once decision under concurrency.
      try {
        await fs.promises.access(path.join(dir, SPOOL_CLAIM_MARKER_NAME_V1));
        return { ok: false, code: "spoolAlreadyClaimed" };
      } catch {
        // No marker yet — proceed toward claiming.
      }
      // Integrity is verified BEFORE the claim marker is created: only a
      // successful claim may consume the spool's single claim, so a
      // corrupt/truncated spool must fail without a marker ever existing.
      let rawBytes: Buffer;
      try {
        rawBytes = await fs.promises.readFile(path.join(dir, SPOOL_BIN_NAME_V1));
      } catch {
        return { ok: false, code: "spoolMissing" };
      }
      const utf8Text = rawBytes.toString("utf8");
      if (
        rawBytes.length !== meta.byteLength ||
        sha256Hex(rawBytes) !== meta.sha256 ||
        !Buffer.from(utf8Text, "utf8").equals(rawBytes)
      ) {
        // A spool that fails integrity can never be claimed by anyone;
        // remove it immediately rather than leaving corrupt provider bytes
        // behind until the expiry sweep.
        await removeSpoolInternal(ref);
        return { ok: false, code: "spoolIntegrityMismatch" };
      }
      // Claim-once: durable exclusive marker, written only after the
      // correlation check and integrity verification succeed, so neither a
      // mismatched nor a corrupt claim consumes the spool.
      try {
        await fs.promises.writeFile(path.join(dir, SPOOL_CLAIM_MARKER_NAME_V1), meta.sha256, {
          flag: "wx",
          encoding: "utf8",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { ok: false, code: "spoolAlreadyClaimed" };
        }
        throw error;
      }
      return { ok: true, utf8Text, ref: { ...meta } };
    },

    async removeSpool(ref: ResultSpoolRefV1): Promise<void> {
      await removeSpoolInternal(ref);
    },

    async expireStaleSpools(): Promise<number> {
      let removed = 0;
      let operationDirs: fs.Dirent[];
      try {
        operationDirs = await fs.promises.readdir(rootDir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const operationDir of operationDirs) {
        if (!operationDir.isDirectory()) {
          continue;
        }
        const operationPath = path.join(rootDir, operationDir.name);
        for (const attemptDir of await fs.promises.readdir(operationPath, { withFileTypes: true })) {
          if (!attemptDir.isDirectory()) {
            continue;
          }
          const attemptPath = path.join(operationPath, attemptDir.name);
          for (const reservationDir of await fs.promises.readdir(attemptPath, { withFileTypes: true })) {
            if (!reservationDir.isDirectory()) {
              continue;
            }
            const identity = {
              operationId: operationDir.name,
              attemptId: attemptDir.name,
              reservationId: reservationDir.name,
            };
            let metaRaw: string | undefined;
            try {
              metaRaw = await fs.promises.readFile(
                path.join(spoolDir(rootDir, identity), SPOOL_META_NAME_V1),
                "utf8"
              );
            } catch {
              metaRaw = undefined;
            }
            const meta = metaRaw === undefined ? undefined : decodeSpoolMeta(metaRaw);
            // An unreadable/undecodable spool is treated as expired: it can
            // never be claimed (integrity would fail), so it is swept.
            if (!meta || now().getTime() > Date.parse(meta.expiresAt)) {
              await removeSpoolInternal(identity);
              removed++;
            }
          }
        }
      }
      return removed;
    },
  };
}
