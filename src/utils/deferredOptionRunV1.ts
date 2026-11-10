/**
 * bugs4 item 26 (plan item 44): a decision the owner answers while a round is still running is
 * not lost and not run into the round. Its effect is held and carried out when the task is free,
 * if the task is still where it was; otherwise the chat says so and the card is offered again.
 *
 * Pure of VS Code: the busy check, the "task may be free" signal and the effect itself are
 * injected, so the timing rules are testable without a window.
 */

export type DeferredRunOutcomeV1 =
  | { readonly kind: "done" }
  | { readonly kind: "notCarriedOut"; readonly reason: string }
  | { readonly kind: "expired" };

export interface DeferredOptionRunInputV1 {
  /** Stable key (decision id + option id): arming the same answer twice keeps one waiter. */
  readonly key: string;
  readonly isTaskBusy: () => boolean;
  /** Called whenever the task may have become free (an operation ended). */
  readonly subscribeToTaskFree: (listener: () => void) => { dispose(): void };
  /** Re-checks the card's premise and runs the effect. Must not throw. */
  readonly carryOut: () => Promise<DeferredRunOutcomeV1>;
  /** Tells the owner what happened, in chat. Must not throw. */
  readonly report: (outcome: DeferredRunOutcomeV1) => Promise<void>;
  /** Fallback poll for operations that never emit an end event (mirrored from another window). */
  readonly pollMs?: number;
  /** A stuck round must not hold an answer forever. */
  readonly maxWaitMs?: number;
  /** The waiter table this window arms in; defaults to the process-wide one. */
  readonly registry?: DeferredRunRegistryV1;
}

/** One window's table of armed waiters. Two windows each have their own; nothing is shared between them. */
export type DeferredRunRegistryV1 = Map<string, { cancel(): void }>;

export function createDeferredRunRegistryV1(): DeferredRunRegistryV1 {
  return new Map();
}

const defaultRegistryV1 = createDeferredRunRegistryV1();

/**
 * review2 Step 13: the answers this window has already carried out and reported as run, per table.
 * A held answer's "has now run" line is written once, when it runs: a second arming of the same
 * answer (an activation re-arm, a second signal) neither runs nor reports it again.
 */
const reportedRunKeysV1 = new WeakMap<DeferredRunRegistryV1, Set<string>>();

function reportedRunKeysForV1(registry: DeferredRunRegistryV1): Set<string> {
  let keys = reportedRunKeysV1.get(registry);
  if (!keys) {
    keys = new Set<string>();
    reportedRunKeysV1.set(registry, keys);
  }
  return keys;
}

/** True when this window already carried out and reported the answer under `key`. */
export function hasDeferredOptionRunReportedV1(key: string, registry: DeferredRunRegistryV1 = defaultRegistryV1): boolean {
  return reportedRunKeysForV1(registry).has(key);
}

export const DEFERRED_OPTION_POLL_MS_V1 = 3_000;
export const DEFERRED_OPTION_MAX_WAIT_MS_V1 = 6 * 60 * 60 * 1000;

export function isDeferredOptionRunArmedV1(key: string, registry: DeferredRunRegistryV1 = defaultRegistryV1): boolean {
  return registry.has(key);
}

/** Returns false when this answer is already waiting (nothing new is armed). */
export function armDeferredOptionRunV1(input: DeferredOptionRunInputV1): boolean {
  const armed = input.registry ?? defaultRegistryV1;
  if (armed.has(input.key) || reportedRunKeysForV1(armed).has(input.key)) {
    return false;
  }
  let settled = false;
  const startedAt = Date.now();
  const maxWaitMs = input.maxWaitMs ?? DEFERRED_OPTION_MAX_WAIT_MS_V1;
  const subscription = input.subscribeToTaskFree(() => attempt());
  const timer = setInterval(() => attempt(), input.pollMs ?? DEFERRED_OPTION_POLL_MS_V1);
  timer.unref?.();

  const finish = (outcome: DeferredRunOutcomeV1 | undefined): void => {
    settled = true;
    clearInterval(timer);
    subscription.dispose();
    armed.delete(input.key);
    if (outcome) {
      void input.report(outcome);
    }
  };

  function attempt(): void {
    if (settled) {
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      finish({ kind: "expired" });
      return;
    }
    if (input.isTaskBusy()) {
      return;
    }
    // Claim the single run before awaiting so a second signal cannot start another.
    settled = true;
    clearInterval(timer);
    subscription.dispose();
    void input
      .carryOut()
      .catch((error): DeferredRunOutcomeV1 => ({
        kind: "notCarriedOut",
        reason: error instanceof Error ? error.message : String(error),
      }))
      .then((outcome) => {
        armed.delete(input.key);
        if (outcome.kind === "done") {
          reportedRunKeysForV1(armed).add(input.key);
        }
        return input.report(outcome);
      });
  }

  armed.set(input.key, {
    cancel: () => {
      if (!settled) {
        finish(undefined);
      }
    },
  });
  return true;
}

export function cancelDeferredOptionRunV1(key: string, registry: DeferredRunRegistryV1 = defaultRegistryV1): void {
  registry.get(key)?.cancel();
}

/** The one chat sentence for what happened to a held answer. */
export function describeDeferredOptionOutcomeV1(optionLabel: string, outcome: DeferredRunOutcomeV1): string {
  switch (outcome.kind) {
    case "done":
      return `Your earlier choice "${optionLabel}" has now run, because the round that was running has ended.`;
    case "expired":
      return (
        `Your earlier choice "${optionLabel}" was not run: the round that was running did not end in time. ` +
        "The card is back; choose it again when the task is idle."
      );
    case "notCarriedOut":
      return (
        `Your earlier choice "${optionLabel}" could not be carried out now that the round has ended: ${outcome.reason} ` +
        "The card is back; choose it again if you still want it."
      );
  }
}

export function describeDeferredOptionHeldV1(liveOperationDescription: string, optionLabel: string): string {
  return (
    `${liveOperationDescription} is still running for this task, so "${optionLabel}" has not run yet. ` +
    "Your choice is kept: it runs when that ends, if the task is still where it is now. " +
    "If it cannot run, this chat says so and offers the choice again."
  );
}
