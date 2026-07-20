/**
 * Contract coverage for the revert-availability surface: the stage context
 * value carries has-backup plus a mutually-exclusive revert-available /
 * redo-available direction token (kept before the trailing modelable token
 * so /-modelable$/ menu clauses keep matching), and the package.json menu
 * entries for Revert Changes / Redo Changes / Delete Previous Version are
 * gated on them.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildStageContextValue } from "../utils/contextTokens";
import {
  isRedoAvailableFromRecord,
  isRevertAvailableFromRecord,
  readRedoSidecar,
  writeRedoSidecar,
  RedoSidecarFs,
} from "../utils/redoSidecar";

function makeMemoryFs(): RedoSidecarFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    readFile(uri) {
      const bytes = files.get(uri.toString());
      if (!bytes) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(bytes);
    },
    writeFile(uri, content) {
      files.set(uri.toString(), content);
      return Promise.resolve();
    },
    delete(uri) {
      files.delete(uri.toString());
      return Promise.resolve();
    },
  };
}

void test("has-backup token appears before the trailing modelable token", () => {
  const withBackup = buildStageContextValue({
    stage: "plan",
    status: "current",
    hasBackup: true,
  });
  assert.match(withBackup, /-has-backup/);
  assert.match(withBackup, /-modelable$/);

  const withoutBackup = buildStageContextValue({
    stage: "plan",
    status: "current",
  });
  assert.doesNotMatch(withoutBackup, /-has-backup/);
});

void test("revert and delete-backup menu entries require the expected direction tokens", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as {
    contributes?: {
      menus?: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const contextMenus = packageJson.contributes?.menus?.["view/item/context"] ?? [];

  const deleteEntries = contextMenus.filter(
    (entry) => entry.command === "vs-code-ai-helper.deleteStageBackup"
  );
  assert.ok(deleteEntries.length > 0, "Expected menu entries for deleteStageBackup");
  for (const entry of deleteEntries) {
    assert.ok(
      (entry.when ?? "").includes("viewItem =~ /-has-backup/"),
      `deleteStageBackup menu entry must be gated on the has-backup token: ${entry.when}`
    );
  }

  const revertEntries = contextMenus.filter(
    (entry) => entry.command === "vs-code-ai-helper.revertStageChanges"
  );
  assert.ok(revertEntries.length > 0, "Expected menu entries for revertStageChanges");
  for (const entry of revertEntries) {
    assert.ok(
      (entry.when ?? "").includes("viewItem =~ /-revert-available/"),
      `revertStageChanges menu entry must be gated on the revert-available token: ${entry.when}`
    );
  }
});

/**
 * Coverage for F17 "Redo changes": redoStageChanges reuses the same journaled
 * swap as revertStageChanges (artifactRevertJournal.performJournaledRevertSwap
 * is symmetric), so the only new surface is the redo-available context token,
 * which is derived from the durable, crash-recoverable sidecar in
 * utils/redoSidecar.ts (not session-scoped state).
 */
void test("redo-available token appears only with hasBackup and after the sidecar marks it reverted", async () => {
  const artifact = vscode.Uri.file("/dev/task_1/plan.md");
  const fsSeam = makeMemoryFs();

  const beforeRevert = buildStageContextValue({
    stage: "plan",
    status: "current",
    hasBackup: true,
    redoAvailable: isRedoAvailableFromRecord(await readRedoSidecar(artifact, fsSeam)),
  });
  assert.doesNotMatch(beforeRevert, /-redo-available/);
  assert.match(beforeRevert, /-revert-available/);

  await writeRedoSidecar(
    artifact,
    { version: 1, direction: "reverted", artifactFingerprint: "a", backupFingerprint: "b" },
    fsSeam
  );
  const afterRevert = buildStageContextValue({
    stage: "plan",
    status: "current",
    hasBackup: true,
    redoAvailable: isRedoAvailableFromRecord(await readRedoSidecar(artifact, fsSeam)),
  });
  assert.match(afterRevert, /-redo-available/);
  assert.doesNotMatch(afterRevert, /-revert-available/);
  assert.match(afterRevert, /-modelable$/);

  // redoAvailable is ignored without hasBackup — never true without a backup.
  const withoutBackup = buildStageContextValue({
    stage: "plan",
    status: "current",
    hasBackup: false,
    redoAvailable: true,
  });
  assert.doesNotMatch(withoutBackup, /-redo-available/);
  assert.doesNotMatch(withoutBackup, /-revert-available/);
});

void test("redoStageChanges menu entries require the redo-available token", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as {
    contributes?: {
      menus?: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const contextMenus = packageJson.contributes?.menus?.["view/item/context"] ?? [];
  const entries = contextMenus.filter((entry) => entry.command === "vs-code-ai-helper.redoStageChanges");
  assert.ok(entries.length > 0, "Expected menu entries for vs-code-ai-helper.redoStageChanges");
  for (const entry of entries) {
    assert.ok(
      (entry.when ?? "").includes("viewItem =~ /-redo-available/"),
      `redoStageChanges menu entry must be gated on the redo-available token: ${entry.when}`
    );
  }
});

void test("redo sidecar survives round-trip through the memory fs seam, keyed independently per artifact", async () => {
  const fsSeam = makeMemoryFs();
  const artifactA = vscode.Uri.file("/dev/task_a/plan.md");
  const artifactB = vscode.Uri.file("/dev/task_b/plan.md");

  await writeRedoSidecar(
    artifactA,
    { version: 1, direction: "reverted", artifactFingerprint: "a1", backupFingerprint: "a2" },
    fsSeam
  );
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifactA, fsSeam)), true);
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifactB, fsSeam)), false);

  await writeRedoSidecar(
    artifactA,
    { version: 1, direction: "applied", artifactFingerprint: "a1", backupFingerprint: "a2" },
    fsSeam
  );
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifactA, fsSeam)), false);
});

/**
 * `isRevertAvailableFromRecord` is the symmetric counterpart consumed by
 * viewStageChanges.ts's Revert Changes guard: without it, Revert could run
 * again while the artifact is already on the reverted side (e.g. a stale
 * context-menu token in a second window), silently performing a redo under
 * the "Revert" label instead of refusing.
 */
void test("isRevertAvailableFromRecord is the mirror image of isRedoAvailableFromRecord", async () => {
  const fsSeam = makeMemoryFs();
  const artifact = vscode.Uri.file("/dev/task_1/plan.md");

  // No sidecar yet (never reverted) — revert is available, redo is not.
  assert.equal(isRevertAvailableFromRecord(await readRedoSidecar(artifact, fsSeam)), true);
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifact, fsSeam)), false);

  await writeRedoSidecar(
    artifact,
    { version: 1, direction: "reverted", artifactFingerprint: "a", backupFingerprint: "b" },
    fsSeam
  );
  // After a revert: redo is available, revert is not (exactly one is true).
  const afterRevert = await readRedoSidecar(artifact, fsSeam);
  assert.equal(isRedoAvailableFromRecord(afterRevert), true);
  assert.equal(isRevertAvailableFromRecord(afterRevert), false);

  await writeRedoSidecar(
    artifact,
    { version: 1, direction: "applied", artifactFingerprint: "a", backupFingerprint: "b" },
    fsSeam
  );
  // After redoing back: revert is available again, redo is not.
  const afterRedo = await readRedoSidecar(artifact, fsSeam);
  assert.equal(isRevertAvailableFromRecord(afterRedo), true);
  assert.equal(isRedoAvailableFromRecord(afterRedo), false);
});
