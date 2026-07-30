/**
 * Coverage for `toSanitizedWriteFailureCodeV1` (plan §3.7 stable outcome
 * codes): the lifecycle rows' shared helper that turns an unexpected
 * `patchTaskProgressStrictV1` write failure into a bounded, path-free
 * `outcome.code` before it reaches the sanitized audit log
 * (`taskActionCoordinatorV1.ts`) or a user-facing toast (`markTaskDone.ts`).
 *
 * `writeAtomic` (`src/state/writeAtomic.ts`) wraps its underlying Node `fs`
 * error in a fresh `Error` whose own `message` embeds the absolute temp/target
 * path, and whose `cause` is the original errno-bearing error. These fixtures
 * mirror that exact shape rather than a same-object `.code`, so the test
 * pins the actual production wrapping, not a simplified stand-in for it.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toSanitizedWriteFailureCodeV1 } from "../actions/rows/lifecyclePolicyRejection";

function writeAtomicStyleError(rawCode: string | undefined, absolutePath: string): Error {
  const raw = new Error(
    `${rawCode ?? "EUNKNOWN"}: permission denied, open '${absolutePath}'`
  ) as NodeJS.ErrnoException;
  if (rawCode !== undefined) {
    raw.code = rawCode;
  }
  const wrapped = new Error(`Failed to write temp file: ${raw.message}`) as Error & { cause?: unknown };
  wrapped.cause = raw;
  return wrapped;
}

void describe("toSanitizedWriteFailureCodeV1", () => {
  void it("returns the bare prefix code when the error carries no errno code anywhere", () => {
    const error = new Error("Failed to write temp file: something went wrong");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", error), "nextStage.writeFailed");
  });

  void it("extracts an errno code from writeAtomic's wrapping (cause.code), never the message", () => {
    const error = writeAtomicStyleError("EACCES", "C:\\Users\\someone\\tasks\\my task\\task-progress.json_temp_abc.tmp.json");
    const code = toSanitizedWriteFailureCodeV1("nextStage", error);
    assert.equal(code, "nextStage.writeFailed.EACCES");
    assert.equal(code.includes("C:\\"), false);
    assert.equal(code.includes("my task"), false);
  });

  void it("extracts an errno code from a directly-attached error.code", () => {
    const error = new Error("boom") as NodeJS.ErrnoException;
    error.code = "EBUSY";
    assert.equal(toSanitizedWriteFailureCodeV1("markTaskDone", error), "markTaskDone.writeFailed.EBUSY");
  });

  void it("ignores a malformed or oversized code instead of leaking it", () => {
    const error = writeAtomicStyleError("not-an-errno-code!", "/tmp/x");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", error), "nextStage.writeFailed");
  });

  void it("ignores a lowercase code (does not match the errno shape)", () => {
    const error = writeAtomicStyleError("eacces", "/tmp/x");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", error), "nextStage.writeFailed");
  });

  void it("never reads error.message even when it looks like a code", () => {
    const error = new Error("EACCES");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", error), "nextStage.writeFailed");
  });

  void it("handles a non-Error thrown value without throwing", () => {
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", "just a string"), "nextStage.writeFailed");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", null), "nextStage.writeFailed");
    assert.equal(toSanitizedWriteFailureCodeV1("nextStage", undefined), "nextStage.writeFailed");
  });
});
