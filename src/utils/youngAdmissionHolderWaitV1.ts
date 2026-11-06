/**
 * review1 Step 41: an action refused only because the same task's own chain started an operation seconds
 * earlier waits for that operation, then runs. Before this the refusal became a busy card, and the action the
 * owner asked for (the re-review after submitting owner evidence) was dropped.
 *
 * Only a young holder is waited for. A hold that has been running for minutes is a real, separate action and is
 * still refused with the busy card.
 */
import type { WorkAdmissionBusyV1, WorkAdmissionResultV1 } from "../state/workAdmissionV1";

/** A holder that started within this window is the chain's own just-started operation. */
export const YOUNG_ADMISSION_HOLDER_MAX_AGE_MS_V1 = 60_000;
/** How long a refused action waits for that holder before it gives up and shows the busy card. */
export const YOUNG_ADMISSION_HOLDER_MAX_WAIT_MS_V1 = 60_000;
const POLL_INTERVAL_MS_V1 = 1_000;

/** True when the claim that refused us started within `YOUNG_ADMISSION_HOLDER_MAX_AGE_MS_V1`. */
export function isYoungAdmissionHolderV1(outcome: WorkAdmissionBusyV1, now: number = Date.now()): boolean {
  // An action the owner clicked is a deliberate, separate action: the refusal stands. Only the chain's own
  // (automatic or unclassified) operation is waited for.
  if (outcome.owner === undefined || outcome.owner.origin === "owner") {
    return false;
  }
  const startedAtMs = Date.parse(outcome.owner.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }
  const age = now - startedAtMs;
  return age >= 0 && age <= YOUNG_ADMISSION_HOLDER_MAX_AGE_MS_V1;
}

export interface YoungHolderWaitDepsV1 {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const REAL_DEPS_V1: YoungHolderWaitDepsV1 = {
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Runs `acquire`; when it is refused because of a young holder, retries once a second until it is admitted, the
 * holder is no longer young-and-live, or the bounded wait ends. Returns the last result either way, so the caller
 * handles a still-busy outcome exactly as before.
 */
export async function acquireWaitingForYoungHolderV1(
  acquire: () => Promise<WorkAdmissionResultV1>,
  deps: YoungHolderWaitDepsV1 = REAL_DEPS_V1
): Promise<WorkAdmissionResultV1> {
  let result = await acquire();
  if (result.outcome !== "busy" || !isYoungAdmissionHolderV1(result, deps.now())) {
    return result;
  }
  const deadline = deps.now() + YOUNG_ADMISSION_HOLDER_MAX_WAIT_MS_V1;
  // Re-checked on every retry: if a different, older or owner-started holder now blocks us, stop waiting at once.
  while (result.outcome === "busy" && isYoungAdmissionHolderV1(result, deps.now()) && deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS_V1);
    result = await acquire();
  }
  return result;
}
