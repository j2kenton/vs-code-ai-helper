/**
 * CLI stdout result capture (plan §3.2).
 *
 * V1 CLI runners stream framed stdout into the broker-owned bounded writer
 * and receive no artifact or result path. This module is the thin capture
 * layer a CLI transport attaches to its child process:
 *
 *  - stdout bytes pass straight into the broker's `BoundedResultWriterV1`
 *    (the broker owns the limit, sealing, and hashing);
 *  - stderr is bounded to 64 KiB of retained/hashed bytes and is exposed
 *    only as a sanitized summary — size, digest, truncation — never as
 *    content, matching plan §2.2's "logs may contain only correlation IDs,
 *    timestamps, statuses, codes, byte counts, and digests".
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
  /** Account a stderr chunk (digest/size only — content is never retained beyond the bound). */
  handleStderr(chunk: Uint8Array | string): void;
  /** Mirrors the underlying writer's overflow state. */
  readonly stdoutOverflowed: boolean;
  /** Sanitized stderr diagnostics — safe to log. */
  stderrSummary(): CliStderrSummaryV1;
}

export function createCliStdoutResultCaptureV1(
  output: BoundedResultWriterV1
): CliStdoutResultCaptureV1 {
  let stderrTotalBytes = 0;
  let stderrRetainedBytes = 0;
  const stderrHash: Hash = createHash("sha256");

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
  };
}
