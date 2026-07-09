import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  updateImplReviewFiles,
  clearImplReviewFiles,
  patchTaskProgress,
} from "../utils/taskProgressUtils";
import type { TaskProgress } from "../types/taskProgress";

function makeProgress(implReviewFiles?: string[]): TaskProgress {
  return {
    taskFolder: "2026-07-07_task_1",
    currentStage: "implementation",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...(implReviewFiles !== undefined ? { implReviewFiles } : {}),
  };
}

// ---------------------------------------------------------------------------
// updateImplReviewFiles: union across runs, not overwrite
// ---------------------------------------------------------------------------

void test("first run with no prior tracked files records exactly its own files", () => {
  const progress = makeProgress(undefined);
  const updated = updateImplReviewFiles(progress, ["a.ts", "b.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts"]);
});

void test("a later run's new files are unioned with the previously tracked set", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
});

void test(
  "a later run whose own snapshot diff is empty does not erase the task's " +
    "previously tracked files (regression for the multi-run bug)",
  () => {
    const progress = makeProgress(["a.ts", "b.ts", "c.ts"]);
    const updated = updateImplReviewFiles(progress, []);
    assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
  }
);

void test("duplicate paths across runs are not repeated in the union", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts", "c.ts"]);
  assert.deepEqual(updated.implReviewFiles, ["a.ts", "b.ts", "c.ts"]);
});

void test("updateImplReviewFiles bumps updatedAt", () => {
  const progress = makeProgress(["a.ts"]);
  const updated = updateImplReviewFiles(progress, ["b.ts"]);
  assert.notEqual(updated.updatedAt, progress.updatedAt);
});

void test(
  "the union is sorted alphabetically regardless of insertion order across runs",
  () => {
    const progress = makeProgress(["z.ts", "m.ts"]);
    const updated = updateImplReviewFiles(progress, ["a.ts", "q.ts"]);
    assert.deepEqual(updated.implReviewFiles, ["a.ts", "m.ts", "q.ts", "z.ts"]);
  }
);

// ---------------------------------------------------------------------------
// clearImplReviewFiles: the only intended way to discard the tracked set
// ---------------------------------------------------------------------------

void test("clearImplReviewFiles removes the tracked set entirely", () => {
  const progress = makeProgress(["a.ts", "b.ts"]);
  const cleared = clearImplReviewFiles(progress);
  assert.equal(cleared.implReviewFiles, undefined);
  assert.ok(!("implReviewFiles" in cleared));
});

// ---------------------------------------------------------------------------
// patchTaskProgress: safe partial-update helper
// ---------------------------------------------------------------------------

// Fake vscode workspace.fs backed by an in-memory store
import * as vscode from "vscode";

type MemStore = Map<string, string>;

function makeMemStore(): MemStore {
  return new Map();
}

function installMemStore(store: MemStore): void {
  // Monkey-patch the vscode stub's workspace.fs for this test suite
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = async (
    uri: vscode.Uri
  ): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return new TextEncoder().encode(content);
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = async (
    uri: vscode.Uri,
    data: Uint8Array
  ): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
  };
}

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(`/fake-workspace/${name}`);
}

async function seedProgress(
  store: MemStore,
  folderUri: vscode.Uri,
  progress: TaskProgress
): Promise<void> {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  store.set(uri.toString(), JSON.stringify(progress, null, 2));
}

async function readStoredProgress(
  store: MemStore,
  folderUri: vscode.Uri
): Promise<TaskProgress | undefined> {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  const raw = store.get(uri.toString());
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as TaskProgress;
}

void test("patchTaskProgress returns undefined when no progress file exists", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("no-progress-task");
  const result = await patchTaskProgress(folderUri, { currentStage: "plan" });
  assert.equal(result, undefined);
});

void test("patchTaskProgress applies a partial object update", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("patch-partial");
  const initial = makeProgress();
  await seedProgress(store, folderUri, initial);

  const result = await patchTaskProgress(folderUri, { currentStage: "plan" });
  assert.ok(result !== undefined);
  assert.equal(result!.currentStage, "plan");
  // Other fields preserved
  assert.equal(result!.taskFolder, initial.taskFolder);
  assert.equal(result!.createdAt, initial.createdAt);
});

void test("patchTaskProgress applies a callback update", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("patch-callback");
  const initial = makeProgress(["a.ts"]);
  await seedProgress(store, folderUri, initial);

  const result = await patchTaskProgress(folderUri, (current) =>
    updateImplReviewFiles(current, ["b.ts"])
  );
  assert.ok(result !== undefined);
  assert.deepEqual(result!.implReviewFiles, ["a.ts", "b.ts"]);
});

void test("patchTaskProgress persists changes to disk", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("patch-persist");
  const initial = makeProgress();
  await seedProgress(store, folderUri, initial);

  await patchTaskProgress(folderUri, { currentStage: "plan" });

  const stored = await readStoredProgress(store, folderUri);
  assert.ok(stored !== undefined);
  assert.equal(stored!.currentStage, "plan");
});

void test("patchTaskProgress preserves implReviewFiles when updating stage", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("patch-preserve-impl-files");
  const initial: TaskProgress = {
    ...makeProgress(["a.ts", "b.ts"]),
    currentStage: "implementation",
  };
  await seedProgress(store, folderUri, initial);

  const result = await patchTaskProgress(folderUri, { currentStage: "impl-high-review" });
  assert.ok(result !== undefined);
  assert.equal(result!.currentStage, "impl-high-review");
  // implReviewFiles must not be erased by a stage-only patch
  assert.deepEqual(result!.implReviewFiles, ["a.ts", "b.ts"]);
});

void test("patchTaskProgress normalizes invalid currentStage values", async () => {
  const store = makeMemStore();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("patch-normalize-stage");
  const initial = makeProgress();
  await seedProgress(store, folderUri, initial);

  // Force an invalid stage via callback to test normalization
  const result = await patchTaskProgress(folderUri, (current) => ({
    ...current,
    currentStage: "totally-invalid-stage" as TaskProgress["currentStage"],
  }));
  assert.ok(result !== undefined);
  // Should normalize to task-description (the migrateStage fallback)
  assert.equal(result!.currentStage, "task-description");
});
