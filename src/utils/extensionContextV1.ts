import * as vscode from "vscode";

/**
 * A process-wide accessor for the activating `ExtensionContext`, set exactly
 * once by `activate()` in `extension.ts`.
 *
 * This exists specifically so `src/utils/quota.ts`'s cross-restart provider-
 * outage ledger (Part 5 step 3 — `getQuotaLedgerEntry`/`recordQuotaObservation`'s
 * optional `context` parameter) can actually be read from and written to by
 * `src/runners/runnerRegistry.ts`'s production quota-observation call sites.
 * Those call sites sit many layers deep in the V1 action-coordinator/execution-
 * broker call graph (the sealed implementation dispatcher in
 * `runnerRegistry.ts` → `withQuotaObservation`, reached from
 * `runEditActionV1.ts`/`reviewActions.ts`/the action coordinator, none of
 * which thread an `ExtensionContext` today).
 * Threading an explicit parameter through that entire graph would be a large,
 * unrelated refactor touching signatures across a dozen files; every other
 * call site that already has natural access to a real `ExtensionContext`
 * (e.g. `savePendingResume`) keeps passing it explicitly exactly as before —
 * this singleton is consulted only as a fallback for call sites that have no
 * such access, not a replacement for explicit threading where it already
 * exists.
 */
let activatingExtensionContext: vscode.ExtensionContext | undefined;

export function setExtensionContextV1(context: vscode.ExtensionContext): void {
  activatingExtensionContext = context;
}

export function getExtensionContextV1(): vscode.ExtensionContext | undefined {
  return activatingExtensionContext;
}

export const __extensionContextV1TestOnly = {
  reset(): void {
    activatingExtensionContext = undefined;
  },
  set(context: vscode.ExtensionContext | undefined): void {
    activatingExtensionContext = context;
  },
};
