import * as vscode from "vscode";
import { taskOperations, TaskOperationHandle } from "./taskOperations";
import {
  announceAutoStartBestEffortV1,
  recordRunningIntentBestEffortV1,
  recordScheduledIntentBestEffortV1,
  recordTerminalIntentBestEffortV1,
  SchedulingIntentMetadataV1,
} from "../state/schedulingIntentV1";

/**
 * Lock-safe guarded dispatch for automation chains (auto-review,
 * auto-advance, fast-forward). Several settings let one completed operation
 * automatically start the next command in the workflow, but the follow-up
 * command claims the same task's exclusive operation lock — dispatching it
 * inline while a root operation still holds that lock makes the follow-up
 * refuse against its own chain and silently never run.
 *
 * `scheduleAutomationChain` is the single dispatch point for those chains —
 * follow-ups are always dispatched as commands, never run inline inside a
 * live root operation. A chain is dispatched immediately when no root
 * operation is given (nothing holds the lock), or deferred until the root
 * operation ends successfully (a failed or cancelled root must not fire its
 * tail). The module also enforces a per-task duplicate-chain guard: at most
 * one chain with the same (taskKey, chainId) may be pending or running at a
 * time — a second schedule while the first is still outstanding is dropped,
 * not queued.
 */

export interface AutomationDispatch {
  command: string;
  arg?: unknown;
  /**
   * Duplicate-guard scope, normally the task folder path. When present, a
   * second chain with the same (taskKey, chainId) while this one is still
   * pending or running is dropped.
   */
  taskKey?: string;
  /**
   * Duplicate-guard identity within the task; defaults to `command`. Chains
   * that must never run concurrently even though they dispatch different
   * commands (e.g. a single review pass vs. the review-and-fix loop) share
   * an explicit chainId such as "auto-review".
   */
  chainId?: string;
  /**
   * Fire-time re-check for automatic chains: evaluated immediately before
   * the command is executed (both the immediate and the deferred dispatch
   * paths). When it returns false the chain is dropped — the guard slot is
   * released and the schedule promise resolves false without dispatching.
   *
   * Automatic schedulers attach a closure over their settings gate (e.g.
   * `() => resolveAutoRunMode(kind) !== "off"`), so a chain queued while an
   * automation option was on is dropped at fire time if the user has since
   * turned the option off. Manual invocations never route through this
   * module and are unaffected.
   */
  stillEnabled?: () => boolean;
  /**
   * Hand-off metadata for the scheduling-intent ledger (task: "Actionable
   * Hand-offs", PART 6) — what caused this dispatch, the `ensemble.*`
   * setting (if any) that controls it, roughly when it is expected, and
   * whether it will retry on its own. Omitted at most of the 12 call sites
   * today; those get a generic entry derived from `command` instead (see
   * `recordScheduledIntentBestEffortV1`), so the ledger is complete from day
   * one and enriched per site incrementally.
   */
  intent?: SchedulingIntentMetadataV1;
}

/** Snapshot shape scheduleAutomationChain needs from an ended operation. */
export interface AutomationChainEndSnapshot {
  readonly id: string;
  readonly state: string;
}

/** Injectable seams so the scheduling policy is unit-testable without a host. */
export interface AutomationChainDeps {
  onDidEnd(
    listener: (snapshot: AutomationChainEndSnapshot) => void
  ): { dispose(): void };
  execute(command: string, arg: unknown): Thenable<unknown>;
}

function defaultDeps(): AutomationChainDeps {
  return {
    onDidEnd: (listener) => taskOperations.onDidEnd(listener),
    execute: (command, arg) => vscode.commands.executeCommand(command, arg),
  };
}

/**
 * Chains currently pending or running, keyed by `${taskKey}::${chainId}`,
 * each mapped to a unique token identifying the specific claim plus that
 * claim's expiry. The token lets a superseded claim's own (delayed) release
 * become a safe no-op instead of deleting a different, later claim that has
 * since taken the same key — see releaseAutomationChain below. The expiry is
 * the fix for workflow-6 Item 1: this map is in-memory and this module's
 * `release` closures are the only thing that ever clears an entry, so a
 * dispatch whose owning process crashes, is cancelled, or otherwise never
 * reaches its `release()` call (any error path around `scheduleAutomationChain`
 * that does not go through its own release plumbing) leaves the entry behind
 * for the life of the extension host. `isAutomationChainActive` is consulted
 * by `scheduleTaskResume.ts`'s recovery reclaimer to decide whether a pending
 * continuation is safe to re-dispatch — an unbounded guard therefore does not
 * just leak a map entry, it can suppress recovery of a stranded task forever
 * (observed 2026-08-17: a completed run's rejected continuation sat idle for
 * ~2.5 hours because nothing ever cleared the guard). A live process renews
 * nothing here; the expiry is a ceiling on how long any one claim may block a
 * reclaim, not a lease that needs refreshing.
 */
interface ChainGuardEntryV1 {
  readonly token: symbol;
  readonly expiresAt: number;
}

const activeChainKeys = new Map<string, ChainGuardEntryV1>();

/**
 * How long a claimed guard slot may block a duplicate dispatch (or a
 * recovery reclaim) before it is treated as abandoned. Generous relative to
 * any legitimate chain observed in this codebase: a chain deferred until a
 * root operation ends can span a full CLI run (`cliRunTimeout` is 60
 * minutes — see cliAgentRunner.ts) plus review/finalize overhead on top, and
 * `scheduleTaskResume.ts`'s own `STALE_DISPATCH_GRACE_MS` uses 90 minutes as
 * its "clearly dead" threshold for the same class of stranded state. Two
 * hours keeps this guard clearly outside that range so it never
 * false-positives on a slow-but-live chain, while still guaranteeing it
 * cannot block recovery "forever" the way the unbounded version did.
 */
export const DEFAULT_CHAIN_GUARD_TTL_MS = 2 * 60 * 60 * 1000;

function chainGuardKey(taskKey: string, chainId: string): string {
  return `${taskKey}::${chainId}`;
}

/**
 * Drop `key`'s entry if it has expired. Called from both the read side
 * (`isAutomationChainActive`) and the write side (`claimChainGuard`) so an
 * expired guard is self-healing: the very next check or claim after
 * expiry clears it, with no separate sweep needed.
 */
function pruneIfExpiredV1(key: string, now: number): void {
  const entry = activeChainKeys.get(key);
  if (entry && entry.expiresAt <= now) {
    activeChainKeys.delete(key);
  }
}

/**
 * True when a chain with this (taskKey, chainId) is pending or running AND
 * its guard has not expired. An expired guard is pruned as a side effect and
 * reported inactive — see the module doc comment above.
 */
export function isAutomationChainActive(
  taskKey: string,
  chainId: string,
  now: number = Date.now()
): boolean {
  const key = chainGuardKey(taskKey, chainId);
  pruneIfExpiredV1(key, now);
  return activeChainKeys.has(key);
}

/** Test-only: clear guard state between unit tests. */
export function resetAutomationChainGuards(): void {
  activeChainKeys.clear();
}

/**
 * Test-only: install a guard entry with an explicit expiry, bypassing the
 * normal claim path. Lets a test simulate a claim that never reached its own
 * `release()` (a crashed/cancelled dispatch) and then assert on what happens
 * once that entry's expiry has passed, without needing a real clock or a
 * dispatch that actually hangs.
 */
export function __setAutomationChainGuardForTestV1(
  taskKey: string,
  chainId: string,
  expiresAt: number
): void {
  activeChainKeys.set(chainGuardKey(taskKey, chainId), { token: Symbol(chainId), expiresAt });
}

/**
 * Release a (taskKey, chainId) guard slot early, before the dispatch that
 * currently holds it has settled.
 *
 * Needed specifically for a review that auto-advances directly into the
 * *next* review stage and re-dispatches under the same "auto-review"
 * chainId (e.g. plan-high-review scoring above threshold and starting
 * plan-low-review): that follow-up call happens synchronously inside the
 * still-running command this very chain slot was claimed for, so without
 * releasing first, claimChainGuard sees its own not-yet-settled outer
 * dispatch as a "duplicate" and silently drops the follow-up — the task is
 * left sitting on the new review stage with nothing running. The caller
 * must only call this when it is actually handing off to a successor link
 * in the same logical chain, immediately before the next scheduleAutomationChain
 * call (synchronously, so no unrelated trigger can claim the slot in between).
 */
export function releaseAutomationChain(
  taskKey: string | undefined,
  chainId: string
): void {
  if (!taskKey) {
    return;
  }
  activeChainKeys.delete(chainGuardKey(taskKey, chainId));
}

/**
 * Claim the (taskKey, chainId) guard slot. Returns a release function, or
 * undefined when an identical chain is already pending/running (duplicate —
 * caller must drop the new chain).
 *
 * The returned release only clears the slot while it still holds THIS
 * claim's token — if releaseAutomationChain (or a later claim) has already
 * superseded it, release() is a safe no-op rather than deleting whatever
 * newer claim now owns the key.
 */
function claimChainGuard(
  taskKey: string | undefined,
  chainId: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_CHAIN_GUARD_TTL_MS
): (() => void) | undefined {
  if (!taskKey) {
    return () => undefined; // Unscoped chains are not guarded.
  }
  const key = chainGuardKey(taskKey, chainId);
  pruneIfExpiredV1(key, now);
  if (activeChainKeys.has(key)) {
    return undefined;
  }
  const token = Symbol(key);
  activeChainKeys.set(key, { token, expiresAt: now + ttlMs });
  return () => {
    if (activeChainKeys.get(key)?.token === token) {
      activeChainKeys.delete(key);
    }
  };
}

/**
 * Dispatch `dispatch.command` once it is lock-safe to do so.
 *
 * - Without a `rootOperation`, the command runs immediately and the returned
 *   promise settles with its completion.
 * - With a `rootOperation`, dispatch is deferred until that operation ends;
 *   the command runs only when the root ended in `succeeded`.
 *
 * Resolves `true` when the command was dispatched, `false` when the chain
 * was dropped — because the root operation failed/was cancelled, or because
 * an identical (taskKey, command) chain was already pending or running.
 */
export function scheduleAutomationChain(
  dispatch: AutomationDispatch,
  rootOperation?: Pick<TaskOperationHandle, "id">,
  deps: AutomationChainDeps = defaultDeps()
): Promise<boolean> {
  const release = claimChainGuard(dispatch.taskKey, dispatch.chainId ?? dispatch.command);
  if (!release) {
    return Promise.resolve(false); // Duplicate chain for this task — dropped.
  }
  // Best-effort scheduling-intent ledger instrumentation (PART 6). The
  // SCHEDULED write races the caller freely (nothing below awaits it before
  // proceeding, so a slow or failing ledger write cannot delay or break the
  // actual dispatch). The RUNNING write and the auto-start announcement are
  // different: review-flagged (2026-08-23) twice over — rendering a task as
  // "scheduled" while its automatic command is already executing is exactly
  // the invisible-auto-start defect this ledger exists to fix, and
  // "announce before acting" is not actually true if the announcement's
  // write is still in flight (or hasn't even started) when the command
  // begins. Both dispatch paths below now await the announcement AND the
  // running transition, in that order, before invoking `deps.execute` —
  // never the reverse. Both writes are still best-effort (they swallow their
  // own failure and never throw), so this only adds a short, bounded delay
  // ahead of a dispatch that was already asynchronous, never a new failure
  // mode.
  const intentIdPromise = recordScheduledIntentBestEffortV1({
    taskKey: dispatch.taskKey,
    command: dispatch.command,
    chainId: dispatch.chainId ?? dispatch.command,
    intent: dispatch.intent,
  });
  const rootOperationId = rootOperation?.id;
  if (!rootOperationId) {
    if (dispatch.stillEnabled && !dispatch.stillEnabled()) {
      release();
      void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "cancelled"));
      return Promise.resolve(false); // Automation disabled since scheduling — dropped.
    }
    return intentIdPromise
      .then(async (id) => {
        await announceAutoStartBestEffortV1({ taskKey: dispatch.taskKey, command: dispatch.command, intent: dispatch.intent });
        await recordRunningIntentBestEffortV1(id);
      })
      .then(() => deps.execute(dispatch.command, dispatch.arg))
      .then(
        () => {
          release();
          void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "completed"));
          return true;
        },
        (error) => {
          release();
          void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "completed"));
          throw error;
        }
      );
  }
  return new Promise<boolean>((resolve) => {
    const endSub = deps.onDidEnd((snapshot) => {
      if (snapshot.id !== rootOperationId) {
        return;
      }
      endSub.dispose();
      if (snapshot.state === "succeeded") {
        if (dispatch.stillEnabled && !dispatch.stillEnabled()) {
          // Automation disabled between scheduling and the root operation
          // ending — drop the chain at fire time.
          release();
          void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "cancelled"));
          resolve(false);
          return;
        }
        // The announcement and the running transition are both awaited
        // BEFORE `deps.execute` is called, so the auto-start explanation is
        // durably persisted and a reader can never observe this task as
        // "scheduled" once its command has actually started. `resolve(true)`
        // still fires in the same tick as the `execute` call itself (not its
        // settlement) — the dispatch beyond that point is fire-and-forget
        // exactly as before (the root operation has already ended, so
        // nothing awaits this chain further; failures surface through the
        // command's own error handling). The guard slot is held until the
        // command settles so a duplicate cannot start while it runs.
        void intentIdPromise
          .then(async (id) => {
            await announceAutoStartBestEffortV1({ taskKey: dispatch.taskKey, command: dispatch.command, intent: dispatch.intent });
            await recordRunningIntentBestEffortV1(id);
          })
          .then(() => {
            Promise.resolve(deps.execute(dispatch.command, dispatch.arg)).then(
              () => {
                release();
                void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "completed"));
              },
              () => {
                release();
                void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "completed"));
              }
            );
            resolve(true);
          });
      } else {
        release();
        void intentIdPromise.then((id) => recordTerminalIntentBestEffortV1(id, "cancelled"));
        resolve(false);
      }
    });
  });
}
