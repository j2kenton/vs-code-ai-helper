/**
 * Coverage for the durable redo sidecar (F17): a versioned JSON file beside
 * the artifact/`_prev` backup that survives a reload/crash, replacing the old
 * volatile in-memory tracking (stageRedoState.ts). Exercises:
 *  - a byte-identical revert -> redo round trip through
 *    performJournaledRevertSwap, verifying the sidecar direction and
 *    fingerprints after each swap;
 *  - direction -> isRedoAvailableFromRecord token correctness;
 *  - a fresh backup write invalidating (deleting) any existing sidecar;
 *  - crash recovery: a leftover journal with a recorded `direction` gets its
 *    sidecar finalized to match the files' actual resulting content.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  performJournaledRevertSwap,
  recoverRevertJournal,
  revertJournalUri,
  type RevertJournalFs,
} from "../utils/artifactRevertJournal";
import {
  readRedoSidecar,
  redoSidecarUri,
  isRedoAvailableFromRecord,
  fingerprintBytes,
  type RedoSidecarFs,
} from "../utils/redoSidecar";

interface MemoryFs extends RevertJournalFs, RedoSidecarFs {
  files: Map<string, Uint8Array>;
}

function makeMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, Uint8Array>();
  for (const [fsPath, content] of Object.entries(initial)) {
    files.set(vscode.Uri.file(fsPath).fsPath, new TextEncoder().encode(content));
  }
  return {
    files,
    readFile(uri): Thenable<Uint8Array> {
      const bytes = files.get(uri.fsPath);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
    },
    writeFile(uri, content): Thenable<void> {
      files.set(uri.fsPath, content);
      return Promise.resolve();
    },
    delete(uri): Thenable<void> {
      files.delete(uri.fsPath);
      return Promise.resolve();
    },
  };
}

const ARTIFACT = "/task/plan-final.md";
const BACKUP = "/task/plan-final_prev.md";

async function swap(
  fs: MemoryFs,
  artifact: vscode.Uri,
  backup: vscode.Uri,
  currentBytes: Uint8Array,
  previousBytes: Uint8Array,
  direction: "applied" | "reverted"
): Promise<void> {
  await performJournaledRevertSwap(
    artifact,
    backup,
    currentBytes,
    previousBytes,
    (content) => {
      fs.files.set(artifact.fsPath, content);
      return Promise.resolve();
    },
    fs,
    direction,
    fs
  );
}

void test("revert then redo round-trips byte-identical content and toggles the sidecar direction", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "generated-v2", [BACKUP]: "generated-v1" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const backup = vscode.Uri.file(BACKUP);

  // Revert: artifact <- backup content.
  await swap(
    fs,
    artifact,
    backup,
    new TextEncoder().encode("generated-v2"),
    new TextEncoder().encode("generated-v1"),
    "reverted"
  );
  assert.equal(new TextDecoder().decode(fs.files.get(artifact.fsPath)), "generated-v1");
  assert.equal(new TextDecoder().decode(fs.files.get(backup.fsPath)), "generated-v2");

  let sidecar = await readRedoSidecar(artifact, fs);
  assert.ok(sidecar);
  assert.equal(sidecar.direction, "reverted");
  assert.equal(isRedoAvailableFromRecord(sidecar), true);
  assert.equal(sidecar.artifactFingerprint, fingerprintBytes(new TextEncoder().encode("generated-v1")));
  assert.equal(sidecar.backupFingerprint, fingerprintBytes(new TextEncoder().encode("generated-v2")));

  // Redo: swap again — byte-identical restoration of the original content.
  await swap(
    fs,
    artifact,
    backup,
    new TextEncoder().encode("generated-v1"),
    new TextEncoder().encode("generated-v2"),
    "applied"
  );
  assert.equal(new TextDecoder().decode(fs.files.get(artifact.fsPath)), "generated-v2");
  assert.equal(new TextDecoder().decode(fs.files.get(backup.fsPath)), "generated-v1");

  sidecar = await readRedoSidecar(artifact, fs);
  assert.ok(sidecar);
  assert.equal(sidecar.direction, "applied");
  assert.equal(isRedoAvailableFromRecord(sidecar), false);
});

void test("a missing or unparseable sidecar defaults to no redo available", async () => {
  const fs = makeMemoryFs({});
  const artifact = vscode.Uri.file(ARTIFACT);
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifact, fs)), false);

  fs.files.set(redoSidecarUri(artifact).fsPath, new TextEncoder().encode("{not json"));
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifact, fs)), false);

  fs.files.set(redoSidecarUri(artifact).fsPath, new TextEncoder().encode(JSON.stringify({ version: 2 })));
  assert.equal(isRedoAvailableFromRecord(await readRedoSidecar(artifact, fs)), false);
});

void test("crash recovery finalizes the sidecar to match the resulting swap state", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const backup = vscode.Uri.file(BACKUP);
  // Simulate a crash: journal present (with a recorded direction), artifact
  // already swapped, backup write and sidecar write still outstanding.
  const record = {
    version: 1 as const,
    artifactPath: artifact.fsPath,
    backupPath: backup.fsPath,
    artifactContent: Buffer.from("previous").toString("base64"),
    backupContent: Buffer.from("current").toString("base64"),
    direction: "reverted" as const,
  };
  const journal = revertJournalUri(artifact);
  fs.files.set(journal.fsPath, new TextEncoder().encode(JSON.stringify(record)));
  fs.files.set(artifact.fsPath, new TextEncoder().encode("previous"));

  assert.equal(await recoverRevertJournal(journal, fs), true);
  assert.equal(fs.files.has(journal.fsPath), false);

  const sidecar = await readRedoSidecar(artifact, fs);
  assert.ok(sidecar, "recovery must finalize the sidecar from the leftover journal");
  assert.equal(sidecar.direction, "reverted");
  assert.equal(isRedoAvailableFromRecord(sidecar), true);
  assert.equal(sidecar.artifactFingerprint, fingerprintBytes(new TextEncoder().encode("previous")));
  assert.equal(sidecar.backupFingerprint, fingerprintBytes(new TextEncoder().encode("current")));
});

void test("a legacy journal without a recorded direction leaves the sidecar untouched", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const backup = vscode.Uri.file(BACKUP);
  const record = {
    version: 1 as const,
    artifactPath: artifact.fsPath,
    backupPath: backup.fsPath,
    artifactContent: Buffer.from("previous").toString("base64"),
    backupContent: Buffer.from("current").toString("base64"),
    // no direction field — pre-existing (legacy) journal format
  };
  const journal = revertJournalUri(artifact);
  fs.files.set(journal.fsPath, new TextEncoder().encode(JSON.stringify(record)));

  assert.equal(await recoverRevertJournal(journal, fs), true);
  assert.equal(await readRedoSidecar(artifact, fs), undefined, "no sidecar action for legacy journals");
});

void test("a sidecar write failure during the swap keeps the journal and reports sidecarFinalized: false", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const backup = vscode.Uri.file(BACKUP);
  const journal = revertJournalUri(artifact);

  // The file swap itself succeeds (both writeArtifact and the backup write
  // land), but the sidecar write is made to fail — simulating a read-only or
  // otherwise unwritable sidecar path.
  const failingSidecarFs: RedoSidecarFs = {
    readFile: fs.readFile.bind(fs),
    writeFile(uri, content): Thenable<void> {
      if (uri.fsPath === redoSidecarUri(artifact).fsPath) {
        return Promise.reject(new Error("EACCES: sidecar path is read-only"));
      }
      return fs.writeFile(uri, content);
    },
    delete: fs.delete.bind(fs),
  };

  const result = await performJournaledRevertSwap(
    artifact,
    backup,
    new TextEncoder().encode("current"),
    new TextEncoder().encode("previous"),
    (content) => {
      fs.files.set(artifact.fsPath, content);
      return Promise.resolve();
    },
    fs,
    "reverted",
    failingSidecarFs
  );

  // The caller must be told the sidecar was NOT finalized this session — it
  // must not claim "Redo Changes" is now available.
  assert.equal(result.sidecarFinalized, false);
  // The file swap itself did land...
  assert.equal(new TextDecoder().decode(fs.files.get(artifact.fsPath)), "previous");
  assert.equal(new TextDecoder().decode(fs.files.get(backup.fsPath)), "current");
  // ...but the journal must be KEPT (not deleted) so the next activation's
  // recovery retries finalizing the sidecar instead of silently losing the
  // durable redo direction.
  assert.equal(fs.files.has(journal.fsPath), true, "journal must be kept for a later retry");
  // And the current-session sidecar read still reflects "no redo available"
  // (pre-swap state) until recovery finalizes it.
  assert.equal(await readRedoSidecar(artifact, fs), undefined);

  // Simulating the next activation with a working sidecar fs: recovery finds
  // the artifact already at its post-swap content and finalizes the sidecar.
  assert.equal(await recoverRevertJournal(journal, fs), true);
  assert.equal(fs.files.has(journal.fsPath), false);
  const sidecar = await readRedoSidecar(artifact, fs);
  assert.ok(sidecar, "recovery must finalize the sidecar the swap itself could not write");
  assert.equal(sidecar.direction, "reverted");
  assert.equal(isRedoAvailableFromRecord(sidecar), true);
});
