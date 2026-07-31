/**
 * The task-with-progress shape shared by every render/command surface.
 *
 * Extracted from `utils/taskProgressUtils.ts` (plan §3.12 step 3's cohort
 * cutover): the type itself is pure data with no reader/writer behavior, so
 * type-only consumers must not have to import the permissive legacy
 * progress module (and stay on its fence roster) just to name this shape.
 */
import * as vscode from "vscode";
import { TaskProgress } from "./taskProgress";

/**
 * Represents an incomplete task with its folder URI and progress.
 *
 * `canonicalId` is the normalized absolute path produced by `taskRoot.ts`
 * (lowercased on Windows). It is the identity key used by `CurrentTaskStore`
 * and `TaskInventory`. When a `TaskWithProgress` is adapted into this shape
 * via `toIncompleteTask`, the canonical ID is preserved so that every render
 * surface (tree nodes, status bar) can match against the stored ID without
 * relying on `folderUri.fsPath` alone. If absent (e.g. tasks constructed
 * directly from URIs in legacy paths), `folderUri.fsPath` is used as the
 * fallback identity.
 */
export interface IncompleteTask {
  folderUri: vscode.Uri;
  folderName: string;
  progress: TaskProgress;
  /** Canonical identity key (normalized absolute path). Present when the task
   *  was sourced from TaskInventory via toIncompleteTask(); may be absent for
   *  legacy in-memory task objects constructed outside the inventory path. */
  canonicalId?: string;
}
