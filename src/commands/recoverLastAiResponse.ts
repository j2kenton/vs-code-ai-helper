import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { NotificationRouter } from "../utils/notificationRouter";
import { forwardInViewerV1 } from "../services/viewerForwardingV1";
import { SPOOL_BIN_NAME_V1, SPOOL_META_NAME_V1 } from "../services/boundedResultStoreV1";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getProviderResultSpoolStoreRootDirV1,
  getProviderResultSpoolStoreV1,
} from "../services/workflowRuntimeServicesV1";

/**
 * `spool-meta-v1.json`'s on-disk shape (boundedResultStoreV1.ts's
 * `SpoolMetaV1`) — read directly here rather than importing that type, since
 * this command deliberately never goes through the store's own claim-once
 * API (see `findMostRecentSpool`'s own doc comment for why).
 */
interface RecoveredSpoolMetaV1 {
  readonly taskBindingId?: string;
  readonly actionKey?: string;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly reservationId?: string;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly purpose?: string;
  readonly providerLabel?: string;
  readonly storedModelId?: string;
}

interface RecoveredSpoolV1 {
  readonly binPath: string;
  readonly meta: RecoveredSpoolMetaV1;
}

/**
 * Walks the provider-results family directory for the most recently created
 * RECOVERY spool (by `spool-meta-v1.json`'s `createdAt`) and returns its
 * metadata and the absolute path to its `result-v1.bin`.
 *
 * The same store and directory tree also holds ordinary broker spools for
 * large in-flight or already-settled responses (`agentExecutionBrokerV1.ts`'s
 * `sealCompletedResponse`) — those never carry `purpose: "recovery"` (see
 * `preserveRejectedResultForRecoveryV1`'s own doc comment), so this only
 * considers metas where it is set; otherwise a perfectly normal response
 * could surface here under a "rejected" banner it doesn't deserve. Also
 * skips anything past its own `expiresAt` — nothing sweeps expired spools on
 * a schedule (only this command's own best-effort call at the bottom does),
 * so filtering on read is what actually keeps the 24h retention promise true
 * rather than merely stated.
 *
 * Reads the meta/bin files directly from disk rather than through
 * `BoundedResultStoreV1.claimSpoolOnce`: claiming is a durable, exactly-once
 * operation that REMOVES the spool's single claim marker and (via the
 * coordinator's own post-claim cleanup) the spool itself — this command must
 * be safely re-runnable (the user may want to re-open the same recovered
 * response more than once) and must never consume anything a live in-flight
 * settlement still needs. A malformed/unreadable meta file is skipped rather
 * than failing the whole scan — one corrupt entry must not hide every other
 * recoverable response.
 */
/** @internal exported for testing */
export function findMostRecentSpool(rootDir: string, taskBindingId?: string): RecoveredSpoolV1 | undefined {
  let best: RecoveredSpoolV1 | undefined;
  const nowIso = new Date().toISOString();

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== SPOOL_META_NAME_V1) {
        continue;
      }
      let meta: RecoveredSpoolMetaV1;
      try {
        meta = JSON.parse(fs.readFileSync(full, "utf8")) as RecoveredSpoolMetaV1;
      } catch {
        continue;
      }
      if (typeof meta.createdAt !== "string" || meta.purpose !== "recovery") {
        continue;
      }
      if (taskBindingId !== undefined && meta.taskBindingId !== taskBindingId) {
        continue;
      }
      if (typeof meta.expiresAt === "string" && meta.expiresAt < nowIso) {
        continue;
      }
      if (!best || meta.createdAt > (best.meta.createdAt ?? "")) {
        best = { binPath: path.join(dir, SPOOL_BIN_NAME_V1), meta };
      }
    }
  }

  walk(rootDir);
  return best;
}

/**
 * "Recover Last AI Response" (Ctrl+Shift+Alt+C): opens the most recently
 * preserved rejected-response recovery copy — see
 * `taskActionCoordinatorV1.ts`'s `preserveRejectedResultForRecoveryV1` for
 * what writes these and why — as a clearly-labeled unsaved (untitled)
 * document. Never a real workspace file: this is transient provider data
 * (plan §2.2), so it is shown to the user directly rather than written into
 * anything tracked or persisted beyond the store's own expiring copy.
 *
 * A viewer supplies its current task, and the runner filters the private
 * store by that task's existing binding id. A bare command-palette invocation
 * on the runner remains host-wide because it has no task context. The
 * preserved copy is durable on disk under the extension's private storage
 * and outlives any single VS Code session (until its own 24h expiry).
 */
export async function recoverLastAiResponse(arg?: { readonly taskFolderPath?: string }): Promise<void> {
  const rootDir = getProviderResultSpoolStoreRootDirV1();
  let taskBindingId: string | undefined;
  if (arg?.taskFolderPath) {
    try {
      const rootId = ensureWorkflowTaskFolderRootV1(arg.taskFolderPath);
      taskBindingId = getVerifiedTaskBindingIdV1(rootId);
    } catch {
      taskBindingId = undefined;
    }
  }
  if (rootDir === undefined) {
    NotificationRouter.showInformation(
      "This window's private provider-results store is unavailable, so it could not be searched. Rejected responses are retained for 24 hours; no claim is made about copies in other stores."
    );
    return;
  }

  if (arg?.taskFolderPath && taskBindingId === undefined) {
    NotificationRouter.showInformation(
      `Could not verify the current task, so this window's private provider-results store at ${rootDir} was not searched. Rejected responses are retained for 24 hours.`
    );
    return;
  }

  const found = findMostRecentSpool(rootDir, taskBindingId);
  if (!found) {
    NotificationRouter.showInformation(
      `Searched this window's private provider-results store${taskBindingId ? " for the current task" : ""} at ${rootDir}; rejected responses are retained for 24 hours. No copy was found in that search.`
    );
    return;
  }

  let text: string;
  try {
    text = fs.readFileSync(found.binPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showWarning(`Could not read the recovered response: ${message}`);
    return;
  }

  const { meta } = found;
  const banner = [
    "<!--",
    "  RECOVERED AI RESPONSE — unsaved scratch buffer, not verified, not applied.",
    "  Editing this buffer does not change the preserved copy on disk.",
    "",
    `  Preserved at:  ${meta.createdAt ?? "(unknown)"}`,
    `  Expires at:    ${meta.expiresAt ?? "(unknown)"} (24h retention)`,
    meta.actionKey ? `  Action:        ${meta.actionKey}` : undefined,
    meta.operationId ? `  Operation id:  ${meta.operationId}` : undefined,
    meta.providerLabel
      ? `  Provider:      ${meta.providerLabel}${meta.storedModelId ? ` (${meta.storedModelId})` : ""}`
      : undefined,
    meta.byteLength !== undefined ? `  Byte length:   ${meta.byteLength}` : undefined,
    meta.sha256 ? `  SHA-256:       ${meta.sha256}` : undefined,
    "",
    "  This is exactly what the model returned before Ensemble rejected it",
    "  (missing/invalid output frame, schema mismatch, or a similar contract",
    "  violation) — the underlying work may still be correct. Nothing here",
    "  has been applied to your workspace; copy anything you want to keep.",
    "-->",
    "",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  try {
    const doc = await vscode.workspace.openTextDocument({
      content: banner + text,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showWarning(`Could not open the recovered response: ${message}`);
    return;
  }

  // Best-effort housekeeping: nothing in production currently sweeps expired
  // spools on a schedule, so a manual recovery is a reasonable, low-cost
  // moment to also clear anything past its 24h retention. Never blocks or
  // fails the command the user actually asked for.
  const store = getProviderResultSpoolStoreV1();
  if (store) {
    void store.expireStaleSpools().catch(() => {
      // Best-effort only.
    });
  }
}

/** Register the "Recover Last AI Response" command (Ctrl+Shift+Alt+C). */
export function registerRecoverLastAiResponseCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.recoverLastAiResponse",
    forwardInViewerV1("vs-code-ai-helper.recoverLastAiResponse", (arg?: { readonly taskFolderPath?: string }) =>
      recoverLastAiResponse(arg)
    )
  );
  context.subscriptions.push(disposable);
}
