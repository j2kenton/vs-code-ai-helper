/**
 * Shared fixture for tests that exercise the strict task-folder root
 * contract (workflowRuntimeServicesV1.ts, plan §3.9): a folder only earns a
 * trusted task-folder mutation root when its `task-progress.json` exists,
 * strictly decodes for that folder, carries a validated `ownership` record
 * whose binding derives, and sits beneath a recognized location. These
 * helpers build exactly that shape:
 *
 *  - `ownership.metaRoot`/`projectRoot` are the folder's own parent
 *    directory, so the STRICT containment check passes with no workspace
 *    open (the folder is always beneath its own metaRoot);
 *  - `ownership.workspaceRoot` is omitted, so no open-workspace match is
 *    required either;
 *  - `taskFolder` self-names the folder's basename, as the strict decode
 *    requires.
 *
 * Tests for the Global Assistant conversation must NOT use this fixture —
 * its dedicated folder is non-task storage and must stay progress-free
 * (see `ensureWorkflowNonTaskStorageRootV1`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { PersistedTaskOwnershipV1, computeTaskBindingIdV1 } from "../types/taskBindingV1";

/** Fixed `boundAt` for fixture ownership records (any parseable timestamp works). */
export const OWNED_FIXTURE_BOUND_AT = "2026-07-01T09:00:00.000Z";

export interface OwnedTaskFolderFixtureV1 {
  readonly folder: string;
  readonly ownership: PersistedTaskOwnershipV1;
  /**
   * `computeTaskBindingIdV1(ownership, path.basename(folder))` — the exact
   * binding the strict task-folder registration derives from this folder,
   * for tests that must supply a matching caller-supplied binding.
   */
  readonly bindingId: string;
}

/** The exact ownership record this fixture writes (or would write) for `folder`. */
export function fixtureOwnershipFor(folder: string): PersistedTaskOwnershipV1 {
  return {
    metaRoot: path.dirname(folder),
    projectRoot: path.dirname(folder),
    boundAt: OWNED_FIXTURE_BOUND_AT,
    state: "resolved",
  };
}

/**
 * The binding id the strict registration derives for an owned fixture
 * folder — recomputed deterministically, so tests can supply it as a
 * caller-supplied binding without having kept the fixture object around.
 */
export function bindingIdForOwnedFolder(folder: string): string {
  return computeTaskBindingIdV1(fixtureOwnershipFor(folder), path.basename(folder));
}

/** Write a minimal, strictly-decodable, ownership-backed `task-progress.json` into `folder`. */
export function writeOwnershipBackedTaskProgress(folder: string): PersistedTaskOwnershipV1 {
  const ownership = fixtureOwnershipFor(folder);
  const progress = {
    taskFolder: path.basename(folder),
    currentStage: "impl",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    ownership,
  };
  fs.writeFileSync(path.join(folder, TASK_PROGRESS_FILENAME), JSON.stringify(progress, null, 2));
  return ownership;
}

/** `mkdtemp` plus an ownership-backed `task-progress.json` — a folder the strict registration accepts. */
export function makeOwnedTaskFolder(prefix: string): OwnedTaskFolderFixtureV1 {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const ownership = writeOwnershipBackedTaskProgress(folder);
  return { folder, ownership, bindingId: computeTaskBindingIdV1(ownership, path.basename(folder)) };
}
