/**
 * CLI stdout result capture (plan §3.2).
 *
 * V1 CLI runners stream framed stdout into the broker-owned bounded writer
 * and receive no artifact or result path. This module is the thin capture
 * layer a CLI transport attaches to its child process:
 *
 *  - stdout bytes pass straight into the broker's `BoundedResultWriterV1`
 *    (the broker owns the limit, sealing, and hashing);
 *  - stderr is bounded to 64 KiB. `stderrSummary()` remains the ONLY surface
 *    safe to log or persist — size, digest, truncation — matching plan
 *    §2.2's "logs may contain only correlation IDs, timestamps, statuses,
 *    codes, byte counts, and digests". `stderrDiagnosisTail()` is a second,
 *    narrower surface added for 2026-09-15 post-freeze findings item 4: it
 *    returns the same bounded bytes as UTF-8 text, held only in this
 *    in-memory instance, for the sole purpose of one-shot failure diagnosis
 *    (`toFriendlyError`) at the moment a run fails. Its caller must never
 *    log or persist the raw string it returns — only the redacted,
 *    noise-stripped diagnostic text `toFriendlyError` derives from it may
 *    reach a run log or user-facing surface. This does not weaken §2.2: no
 *    new code path writes raw stderr to disk, a log, or a notification: the
 *    only place this tail is read is the same trusted process that already
 *    held every byte in a stdin buffer during `handleStderr`.
 */
import { createHash, Hash } from "crypto";
import { BoundedResultWriterV1 } from "../types/agentExecutionV1";

/** At most this much stderr participates in the diagnostic digest; the rest is dropped. */
export const MAX_CLI_STDERR_RETAINED_BYTES_V1 = 64 * 1024;

export interface CliStderrSummaryV1 {
  /** Total stderr bytes the process emitted (counted, not retained). */
  readonly totalByteLength: number;
  /** Bytes that participated in the digest (capped at 64 KiB). */
  readonly retainedByteLength: number;
  /** SHA-256 over the retained (first 64 KiB of) stderr bytes. */
  readonly sha256: string;
  /** True when stderr exceeded the retention bound. */
  readonly truncated: boolean;
}

export interface CliStdoutResultCaptureV1 {
  /** Stream a stdout chunk into the broker-owned bounded writer. */
  handleStdout(chunk: Uint8Array | string): void;
  /** Account a stderr chunk (digest/size, plus a bounded in-memory tail for diagnosis only). */
  handleStderr(chunk: Uint8Array | string): void;
  /** Mirrors the underlying writer's overflow state. */
  readonly stdoutOverflowed: boolean;
  /** Sanitized stderr diagnostics — safe to log. */
  stderrSummary(): CliStderrSummaryV1;
  /**
   * The retained (first 64 KiB of) stderr bytes as UTF-8 text, for one-shot
   * failure diagnosis only (e.g. feeding `toFriendlyError`). Never log or
   * persist this value directly — only its redacted derivative may reach a
   * log, run record, or notification.
   */
  stderrDiagnosisTail(): string;
}

export function createCliStdoutResultCaptureV1(
  output: BoundedResultWriterV1
): CliStdoutResultCaptureV1 {
  let stderrTotalBytes = 0;
  let stderrRetainedBytes = 0;
  const stderrHash: Hash = createHash("sha256");
  const stderrRetainedChunks: Buffer[] = [];

  return {
    handleStdout(chunk: Uint8Array | string): void {
      output.write(chunk);
    },

    handleStderr(chunk: Uint8Array | string): void {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      stderrTotalBytes += bytes.length;
      const room = MAX_CLI_STDERR_RETAINED_BYTES_V1 - stderrRetainedBytes;
      if (room > 0) {
        const retained = bytes.length <= room ? bytes : bytes.subarray(0, room);
        stderrHash.update(retained);
        stderrRetainedBytes += retained.length;
        stderrRetainedChunks.push(Buffer.from(retained));
      }
    },

    get stdoutOverflowed(): boolean {
      return output.overflowed;
    },

    stderrSummary(): CliStderrSummaryV1 {
      return {
        totalByteLength: stderrTotalBytes,
        retainedByteLength: stderrRetainedBytes,
        sha256: stderrHash.copy().digest("hex"),
        truncated: stderrTotalBytes > MAX_CLI_STDERR_RETAINED_BYTES_V1,
      };
    },

    stderrDiagnosisTail(): string {
      return Buffer.concat(stderrRetainedChunks).toString("utf8");
    },
  };
}
