/**
 * Coverage for the CLI stdout capture layer (plan §3.2):
 *  - CLI results are captured only from bounded stdout (AC-RUNNER-02) — the
 *    capture streams into the broker-owned writer and receives no path;
 *  - `stderrSummary()` is bounded to 64 KiB and remains the ONLY stderr
 *    surface safe to log or persist — size/digest/truncation, never content,
 *    per the plan's sanitized-diagnostics rule;
 *  - `stderrDiagnosisTail()` (2026-09-15 post-freeze findings, item 4) is a
 *    second, narrower surface returning the same bounded bytes as text, for
 *    one-shot in-process failure diagnosis only (feeding `toFriendlyError`
 *    the way the legacy transport does). It does not weaken the rule above:
 *    nothing here logs or persists its raw return value.
 */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createBoundedResultWriterV1 } from "../services/agentExecutionBrokerV1";
import {
  createCliStdoutResultCaptureV1,
  MAX_CLI_STDERR_RETAINED_BYTES_V1,
} from "../services/cliStdoutResultCaptureV1";

void describe("cliStdoutResultCaptureV1", () => {
  void it("streams stdout chunks into the broker-owned bounded writer", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);
    capture.handleStdout("frame ");
    capture.handleStdout(Buffer.from("bytes", "utf8"));
    assert.equal(writer.bytesWritten, Buffer.byteLength("frame bytes", "utf8"));
    assert.equal(capture.stdoutOverflowed, false);
  });

  void it("mirrors the writer's overflow state once the stdout bound is exceeded", () => {
    const writer = createBoundedResultWriterV1(4);
    const capture = createCliStdoutResultCaptureV1(writer);
    capture.handleStdout("12345");
    assert.equal(capture.stdoutOverflowed, true);
  });

  void it("bounds stderr to 64 KiB of retained bytes and exposes only a sanitized summary", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);

    const first = Buffer.alloc(MAX_CLI_STDERR_RETAINED_BYTES_V1 - 10, 0x61);
    const second = Buffer.alloc(1000, 0x62);
    capture.handleStderr(first);
    capture.handleStderr(second);

    const summary = capture.stderrSummary();
    assert.equal(summary.totalByteLength, first.length + second.length);
    assert.equal(summary.retainedByteLength, MAX_CLI_STDERR_RETAINED_BYTES_V1);
    assert.equal(summary.truncated, true);

    const retained = Buffer.concat([first, second.subarray(0, 10)]);
    assert.equal(summary.sha256, createHash("sha256").update(retained).digest("hex"));

    // The summary is the ONLY surface: exactly size/digest/truncation
    // fields, no property carrying stderr content.
    assert.deepEqual(Object.keys(summary).sort(), [
      "retainedByteLength",
      "sha256",
      "totalByteLength",
      "truncated",
    ]);
  });

  void it("reports an exact digest for small stderr without truncation", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);
    capture.handleStderr("warning: something");
    const summary = capture.stderrSummary();
    assert.equal(summary.totalByteLength, Buffer.byteLength("warning: something", "utf8"));
    assert.equal(summary.retainedByteLength, summary.totalByteLength);
    assert.equal(summary.truncated, false);
    assert.equal(
      summary.sha256,
      createHash("sha256").update("warning: something", "utf8").digest("hex")
    );
  });

  void it("stderrDiagnosisTail returns the same bytes the summary was hashed from", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);
    capture.handleStderr("You've hit your usage limit. ");
    capture.handleStderr("Try again at 4:12 PM.");
    assert.equal(capture.stderrDiagnosisTail(), "You've hit your usage limit. Try again at 4:12 PM.");
  });

  void it("bounds stderrDiagnosisTail to the same 64 KiB retained by the summary", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);
    const first = Buffer.alloc(MAX_CLI_STDERR_RETAINED_BYTES_V1 - 10, 0x61);
    const second = Buffer.alloc(1000, 0x62);
    capture.handleStderr(first);
    capture.handleStderr(second);
    const tail = capture.stderrDiagnosisTail();
    assert.equal(Buffer.byteLength(tail, "utf8"), MAX_CLI_STDERR_RETAINED_BYTES_V1);
    assert.equal(
      capture.stderrSummary().sha256,
      createHash("sha256").update(tail, "utf8").digest("hex")
    );
  });

  void it("stderrDiagnosisTail is empty when no stderr was ever emitted", () => {
    const writer = createBoundedResultWriterV1(1024);
    const capture = createCliStdoutResultCaptureV1(writer);
    assert.equal(capture.stderrDiagnosisTail(), "");
  });
});
