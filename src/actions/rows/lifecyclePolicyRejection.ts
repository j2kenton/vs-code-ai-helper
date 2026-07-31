/**
 * Shared rejection error shapes for lifecycle rows' locked read-modify-write
 * blocks (`nextStageRowV1.ts`, `markTaskDoneRowV1.ts`). Both rows throw one
 * of these from inside `patchTaskProgressStrictV1`'s callback to carry a
 * typed rejection reason back out to their `execute()` catch block.
 */

/**
 * Thrown when the freshly re-read stage under the task lock no longer
 * matches what the row's eligibility/CAS check expected — e.g. a delayed
 * auto-advance or a second concurrent click already moved the task.
 */
export class LifecycleStageMismatchError extends Error {}

/**
 * Thrown when a row was invoked with an `expectedReviewAttemptId` CAS and the
 * freshly re-read progress's `reviewAttemptId` no longer matches — e.g. a
 * newer review attempt already claimed (and possibly auto-advanced) this
 * task while an older attempt's follow-up transition was still in flight.
 */
export class LifecycleReviewAttemptMismatchError extends Error {}

/** Thrown to carry a `taskProgressFieldPolicyV1` rejection code out of the locked callback. */
export class LifecyclePolicyFailureError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const ERRNO_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;

/** Best-effort extraction of a POSIX/Windows errno-style code (e.g. `EACCES`), never a message. */
function extractErrnoCode(error: unknown): string | undefined {
  const candidates = [error, error instanceof Error ? (error as { cause?: unknown }).cause : undefined];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null || !("code" in candidate)) {
      continue;
    }
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string" && ERRNO_CODE_PATTERN.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Build a stable, sanitized `outcome.code` for an unexpected write failure
 * (plan §2.2 / §3.1 / §3.7): raw `Error#message` text can carry absolute
 * filesystem paths (e.g. `writeAtomic`'s `EACCES: permission denied, open
 * 'C:\...\task-progress.json_temp_....tmp'`), which must never reach the
 * sanitized audit log or a user-facing toast. This always returns a fixed
 * `<prefix>.writeFailed` code, optionally suffixed with a bare errno code
 * (`EACCES`, `EBUSY`, ...) extracted from the error's own `code` field or its
 * `cause`'s `code` field — never from the free-text message.
 */
export function toSanitizedWriteFailureCodeV1(prefix: string, error: unknown): string {
  const errno = extractErrnoCode(error);
  return errno ? `${prefix}.writeFailed.${errno}` : `${prefix}.writeFailed`;
}
