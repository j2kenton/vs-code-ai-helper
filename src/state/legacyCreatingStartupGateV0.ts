import * as vscode from "vscode";
import { TASK_FILENAME } from "../types/taskProgress";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { normalizePath } from "../utils/taskRoot";

/**
 * A `status: "creating"` task folder found under a meta root at startup.
 * Recorded read-only — `hasTaskMd` is informational only and must never be
 * treated as proof that the creation actually finished (a user may simply
 * have started editing task.md themselves while the extension host was
 * killed mid-creation).
 */
export interface LegacyCreatingFootprintV0 {
  readonly metaFolderPath: string;
  readonly taskFolderPath: string;
  readonly taskFolderName: string;
  readonly hasTaskMd: boolean;
}

async function classifyMetaRoot(metaFolderPath: string): Promise<readonly LegacyCreatingFootprintV0[]> {
  const root = vscode.Uri.file(metaFolderPath);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return [];
  }

  const footprints: LegacyCreatingFootprintV0[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) {
      continue;
    }
    const folder = vscode.Uri.joinPath(root, name);
    let progress;
    try {
      progress = await readTaskProgress(folder);
    } catch {
      continue;
    }
    if (progress?.status !== "creating") {
      continue;
    }

    let hasTaskMd = false;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, TASK_FILENAME));
      hasTaskMd = true;
    } catch {
      hasTaskMd = false;
    }
    footprints.push({
      metaFolderPath,
      taskFolderPath: folder.fsPath,
      taskFolderName: name,
      hasTaskMd,
    });
  }
  return footprints;
}

/**
 * Read-only replacement for the old implicit `creating` -> `paused`
 * promotion that used to live in startNewTask.ts as
 * `recoverCompletedTaskCreations`. This gate only classifies `status:
 * "creating"` folders and publishes a snapshot for other code to consult —
 * it never rewrites task-progress.json, never adopts ownership, never
 * invokes a provider, and never treats the presence of task.md as proof a
 * creation finished. Until the full creation-recovery UX (retry/adopt/safe
 * delete) lands, a caller that finds a footprint here may only surface a
 * read-only "Open" affordance for it.
 *
 * `beginClassification` is called once, synchronously, near the top of
 * `activate()` in extension.ts — before the task inventory is first
 * populated. Every command body that touches task-creation state (currently:
 * `startNewTask`) must await `waitUntilReady()`, or call `getFootprints`
 * (which awaits it internally), before its first read, so it cannot race
 * this startup classification pass. There is no fire-and-forget
 * reconciliation left in activation for `creating` folders — activation
 * awaits the same promise this class hands to callers.
 *
 * `TaskInventory.refresh()` additionally awaits `waitUntilReady()` itself,
 * before its first task discovery read, so inventory publication respects
 * the barrier even if a future refresh trigger forgets to chain on
 * extension.ts's `startupGateReady` (the extension.ts chains remain as the
 * explicit, test-asserted ordering documentation).
 */
class LegacyCreatingStartupGateV0Impl {
  private snapshots = new Map<string, readonly LegacyCreatingFootprintV0[]>();
  private inFlight = new Map<string, Promise<readonly LegacyCreatingFootprintV0[]>>();
  private barrier: Promise<void> = Promise.resolve();

  /**
   * Starts the classification pass for exactly these roots and publishes a
   * new barrier. Returns the barrier promise so activation can await
   * ordering directly without a separate `waitUntilReady()` call.
   */
  beginClassification(metaFolderPaths: readonly string[]): Promise<void> {
    this.barrier = Promise.all(
      metaFolderPaths.map((metaFolderPath) => this.classifyOnce(metaFolderPath))
    ).then(() => undefined);
    return this.barrier;
  }

  /**
   * Resolves once the most recently started classification pass has
   * published its snapshot for every root it covered. Safe to call even if
   * `beginClassification` was never called (resolves immediately, with an
   * empty snapshot map — `getFootprints` then classifies on demand).
   */
  waitUntilReady(): Promise<void> {
    return this.barrier;
  }

  /**
   * Read-only classification for one meta root. Awaits the current barrier
   * first (so a fresh call can never observe a state older than the last
   * published activation-time snapshot), then ALWAYS re-scans the root —
   * this is deliberately not served from a permanent cache. A folder can
   * enter `creating` at any point during a long-running window (e.g. this
   * window's own extension host getting interrupted mid-creation later in
   * the session), so a stale "no footprints" answer from the activation-time
   * scan would hide a real, currently-stuck folder from a later call. The
   * republished result also keeps the snapshot map (intended for a future
   * recovery-node UI) current for this root.
   */
  async getFootprints(metaFolderPath: string): Promise<readonly LegacyCreatingFootprintV0[]> {
    await this.barrier;
    return this.classifyOnce(metaFolderPath);
  }

  /** Runs (or joins an already-running) classification pass for one root and republishes its snapshot. */
  private classifyOnce(metaFolderPath: string): Promise<readonly LegacyCreatingFootprintV0[]> {
    const key = normalizePath(metaFolderPath);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = classifyMetaRoot(metaFolderPath).then((footprints) => {
      this.snapshots.set(key, footprints);
      return footprints;
    });
    this.inFlight.set(key, promise);
    void promise.finally(() => {
      this.inFlight.delete(key);
    });
    return promise;
  }

  /** Test-only: discard all published state so cases don't leak into each other. */
  resetForTests(): void {
    this.snapshots.clear();
    this.inFlight.clear();
    this.barrier = Promise.resolve();
  }
}

export const LegacyCreatingStartupGateV0 = new LegacyCreatingStartupGateV0Impl();
