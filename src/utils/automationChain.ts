import * as vscode from "vscode";
import { taskOperations, TaskOperationHandle } from "./taskOperations";

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

/** Chains currently pending or running, keyed by `${taskKey}::${chainId}`. */
const activeChainKeys = new Set<string>();

function chainGuardKey(taskKey: string, chainId: string): string {
  return `${taskKey}::${chainId}`;
}

/** True when a chain with this (taskKey, chainId) is pending or running. */
export function isAutomationChainActive(
  taskKey: string,
  chainId: string
): boolean {
  return activeChainKeys.has(chainGuardKey(taskKey, chainId));
}

/** Test-only: clear guard state between unit tests. */
export function resetAutomationChainGuards(): void {
  activeChainKeys.clear();
}

/**
 * Claim the (taskKey, chainId) guard slot. Returns a release function, or
 * undefined when an identical chain is already pending/running (duplicate —
 * caller must drop the new chain).
 */
function claimChainGuard(
  taskKey: string | undefined,
  chainId: string
): (() => void) | undefined {
  if (!taskKey) {
    return () => undefined; // Unscoped chains are not guarded.
  }
  const key = chainGuardKey(taskKey, chainId);
  if (activeChainKeys.has(key)) {
    return undefined;
  }
  activeChainKeys.add(key);
  return () => activeChainKeys.delete(key);
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
  const rootOperationId = rootOperation?.id;
  if (!rootOperationId) {
    return Promise.resolve(deps.execute(dispatch.command, dispatch.arg)).then(
      () => {
        release();
        return true;
      },
      (error) => {
        release();
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
        // Fire-and-forget: the root operation has already ended, so nothing
        // is awaiting this chain — surface failures through the command's
        // own error handling. The guard slot is held until the command
        // settles so a duplicate cannot start while it runs.
        Promise.resolve(deps.execute(dispatch.command, dispatch.arg)).then(
          () => release(),
          () => release()
        );
        resolve(true);
      } else {
        release();
        resolve(false);
      }
    });
  });
}
