/**
 * bugs5 Step 11: retry a state operation that failed because another session held the state lease.
 *
 * Reported 2026-10-31 (jester): after VS Code's auto-update restarted the extension host, the new
 * host's activation checkpoint recovery failed once with "Another Ensemble session is currently
 * updating task state" (the old host's lease had not expired yet) and gave up. A lease lasts 30 s,
 * so the retry window has to outlast it.
 */
import { PrimarySessionLockHeldError } from "./primarySessionLock";

/** Six attempts, 5 + 10 + 15 + 20 + 40 s apart: about 90 s, longer than the lock's 30 s lease. */
export const STATE_LOCK_RETRY_DELAYS_MS_V1: readonly number[] = [5_000, 10_000, 15_000, 20_000, 40_000];

export function isStateLockHeldErrorV1(error: unknown): boolean {
  return error instanceof PrimarySessionLockHeldError;
}

export async function retryWhileStateLockHeldV1<T>(
  operation: () => Promise<T>,
  options: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
    /** Told before each wait, so a caller can log that it is retrying. */
    readonly onRetry?: (attempt: number, delayMs: number) => void;
  } = {}
): Promise<T> {
  const delays = options.delaysMs ?? STATE_LOCK_RETRY_DELAYS_MS_V1;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (!isStateLockHeldErrorV1(error) || delay === undefined) {
        throw error;
      }
      options.onRetry?.(attempt + 1, delay);
      await sleep(delay);
    }
  }
}
