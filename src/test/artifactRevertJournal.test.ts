/**
 * Coverage for the journal-backed revert swap (artifactRevertJournal.ts):
 * the swap exchanges artifact and backup contents, leaves no journal behind,
 * rolls the journal back when the artifact write fails, and recovery
 * re-applies an interrupted swap's recorded targets (idempotently) while
 * quarantining unparseable journals by deletion.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  performJournaledRevertSwap,
  recoverRevertJournal,
  revertJournalUri,
  parseRevertJournal,
  sha256Hex,
  RevertArtifactMutatedError,
  type RevertJournalFs,
  type RevertRecoveryPrompt,
} from "../utils/artifactRevertJournal";

interface MemoryFs extends RevertJournalFs {
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
      return bytes
        ? Promise.resolve(bytes)
        : Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
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

const text = (fs: MemoryFs, fsPath: string): string | undefined => {
  const bytes = fs.files.get(vscode.Uri.file(fsPath).fsPath);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
};

const ARTIFACT = "/task/plan-final.md";
const BACKUP = "/task/plan-final_prev.md";

void test("swap exchanges artifact and backup contents and removes the journal", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  await performJournaledRevertSwap(
    artifact,
    vscode.Uri.file(BACKUP),
    new TextEncoder().encode("current"),
    new TextEncoder().encode("previous"),
    (content) => {
      fs.files.set(artifact.fsPath, content);
      return Promise.resolve();
    },
    fs
  );
  assert.equal(text(fs, ARTIFACT), "previous");
  assert.equal(text(fs, BACKUP), "current");
  assert.equal(fs.files.has(revertJournalUri(artifact).fsPath), false);
});

void test("a failed artifact write rolls the journal back and changes nothing", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  await assert.rejects(
    performJournaledRevertSwap(
      artifact,
      vscode.Uri.file(BACKUP),
      new TextEncoder().encode("current"),
      new TextEncoder().encode("previous"),
      () => Promise.reject(new Error("editor refused the edit")),
      fs
    ),
    /editor refused/
  );
  assert.equal(text(fs, ARTIFACT), "current");
  assert.equal(text(fs, BACKUP), "previous");
  assert.equal(fs.files.has(revertJournalUri(artifact).fsPath), false);
});

void test("recovery re-applies an interrupted swap's targets and deletes the journal", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  // Simulate a crash after the artifact write but before the backup write:
  // journal present, artifact already swapped, backup still stale.
  const record = {
    version: 1 as const,
    artifactPath: artifact.fsPath,
    backupPath: vscode.Uri.file(BACKUP).fsPath,
    artifactContent: Buffer.from("previous").toString("base64"),
    backupContent: Buffer.from("current").toString("base64"),
  };
  const journal = revertJournalUri(artifact);
  fs.files.set(journal.fsPath, new TextEncoder().encode(JSON.stringify(record)));
  fs.files.set(artifact.fsPath, new TextEncoder().encode("previous"));

  assert.equal(await recoverRevertJournal(journal, fs), true);
  assert.equal(text(fs, ARTIFACT), "previous");
  assert.equal(text(fs, BACKUP), "current");
  assert.equal(fs.files.has(journal.fsPath), false);

  // Idempotent: recovering again (journal gone) is a clean no-op.
  assert.equal(await recoverRevertJournal(journal, fs), false);
});

void test("an unparseable journal is quarantined by deletion without touching files", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const journal = revertJournalUri(vscode.Uri.file(ARTIFACT));
  fs.files.set(journal.fsPath, new TextEncoder().encode("{not json"));

  assert.equal(await recoverRevertJournal(journal, fs), false);
  assert.equal(text(fs, ARTIFACT), "current");
  assert.equal(text(fs, BACKUP), "previous");
  assert.equal(fs.files.has(journal.fsPath), false);
});

function makeJournal(fs: MemoryFs): vscode.Uri {
  const artifact = vscode.Uri.file(ARTIFACT);
  const record = {
    version: 1 as const,
    artifactPath: artifact.fsPath,
    backupPath: vscode.Uri.file(BACKUP).fsPath,
    artifactContent: Buffer.from("previous").toString("base64"),
    backupContent: Buffer.from("current").toString("base64"),
  };
  const journal = revertJournalUri(artifact);
  fs.files.set(journal.fsPath, new TextEncoder().encode(JSON.stringify(record)));
  return journal;
}

void test("a mutated-artifact write failure KEEPS the journal for recovery", async () => {
  // The clean-open-document save-failure case: the editor buffer already
  // shows the reverted content but persisting it failed. Deleting the
  // journal here would let a later manual save converge both files on the
  // same content — the journal must survive so recovery finishes the swap.
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  await assert.rejects(
    performJournaledRevertSwap(
      artifact,
      vscode.Uri.file(BACKUP),
      new TextEncoder().encode("current"),
      new TextEncoder().encode("previous"),
      () => Promise.reject(new RevertArtifactMutatedError("buffer mutated, save failed")),
      fs
    ),
    RevertArtifactMutatedError
  );
  const journal = revertJournalUri(artifact);
  assert.equal(fs.files.has(journal.fsPath), true, "journal must be kept");
  // Recovery then completes the interrupted swap.
  assert.equal(await recoverRevertJournal(journal, fs), true);
  assert.equal(text(fs, ARTIFACT), "previous");
  assert.equal(text(fs, BACKUP), "current");
  assert.equal(fs.files.has(journal.fsPath), false);
});

void test("recovery of an unapplied swap consults decide; 'keep' drops the journal untouched", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  const prompts: RevertRecoveryPrompt[] = [];
  const recovered = await recoverRevertJournal(journal, fs, (prompt) => {
    prompts.push(prompt);
    return Promise.resolve("keep");
  });
  assert.equal(recovered, false);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.artifactDiverged, false, "pre-swap content is not diverged");
  assert.equal(text(fs, ARTIFACT), "current", "keep must not touch the artifact");
  assert.equal(text(fs, BACKUP), "previous", "keep must not touch the backup");
  assert.equal(fs.files.has(journal.fsPath), false, "keep discards the journal");
});

void test("recovery 'defer' leaves the journal for a later activation", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  const recovered = await recoverRevertJournal(journal, fs, () =>
    Promise.resolve("defer")
  );
  assert.equal(recovered, false);
  assert.equal(fs.files.has(journal.fsPath), true, "defer retains the journal");
  assert.equal(text(fs, ARTIFACT), "current");
});

void test("recovery flags a diverged artifact and never overwrites it silently", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "user edited this later", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  const prompts: RevertRecoveryPrompt[] = [];
  const recovered = await recoverRevertJournal(journal, fs, (prompt) => {
    prompts.push(prompt);
    return Promise.resolve("keep");
  });
  assert.equal(recovered, false);
  assert.equal(prompts.length, 1, "diverged content must be surfaced, not auto-applied");
  assert.equal(prompts[0]!.artifactDiverged, true);
  assert.equal(text(fs, ARTIFACT), "user edited this later");
});

void test("recovery completes a half-applied swap silently (no decide prompt)", async () => {
  // Artifact already carries the post-swap content; only the backup write is
  // outstanding. NOT finishing it would leave the same content in both files.
  const fs = makeMemoryFs({ [ARTIFACT]: "previous", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  let prompted = false;
  const recovered = await recoverRevertJournal(journal, fs, () => {
    prompted = true;
    return Promise.resolve("keep");
  });
  assert.equal(recovered, true);
  assert.equal(prompted, false, "completing the recorded intent needs no prompt");
  assert.equal(text(fs, ARTIFACT), "previous");
  assert.equal(text(fs, BACKUP), "current");
  assert.equal(fs.files.has(journal.fsPath), false);
});

void test("the written journal carries a timestamp and content hashes", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const journal = revertJournalUri(artifact);
  let observed: Uint8Array | undefined;
  await performJournaledRevertSwap(
    artifact,
    vscode.Uri.file(BACKUP),
    new TextEncoder().encode("current"),
    new TextEncoder().encode("previous"),
    (content) => {
      // Capture the journal while it exists (it is deleted after the swap).
      observed = fs.files.get(journal.fsPath);
      fs.files.set(artifact.fsPath, content);
      return Promise.resolve();
    },
    fs
  );
  assert.ok(observed, "journal must exist during the swap");
  const record = parseRevertJournal(observed);
  assert.ok(record);
  assert.equal(record.artifactSha256, sha256Hex(new TextEncoder().encode("previous")));
  assert.equal(record.backupSha256, sha256Hex(new TextEncoder().encode("current")));
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)), "createdAt must be a timestamp");
});

void test("a journal whose content does not match its recorded hashes is quarantined", async () => {
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const artifact = vscode.Uri.file(ARTIFACT);
  const journal = revertJournalUri(artifact);
  const record = {
    version: 1 as const,
    artifactPath: artifact.fsPath,
    backupPath: vscode.Uri.file(BACKUP).fsPath,
    artifactContent: Buffer.from("previous").toString("base64"),
    backupContent: Buffer.from("current").toString("base64"),
    createdAt: new Date().toISOString(),
    artifactSha256: "0".repeat(64), // corrupt: does not match artifactContent
    backupSha256: sha256Hex(new TextEncoder().encode("current")),
  };
  fs.files.set(journal.fsPath, new TextEncoder().encode(JSON.stringify(record)));
  assert.equal(await recoverRevertJournal(journal, fs), false);
  assert.equal(text(fs, ARTIFACT), "current", "a corrupt journal must not touch files");
  assert.equal(text(fs, BACKUP), "previous");
  assert.equal(fs.files.has(journal.fsPath), false, "corrupt journal is quarantined by deletion");
});

void test("recovery flags a diverged backup instead of silently overwriting it", async () => {
  // Artifact already carries the post-swap content, but the backup was
  // changed after the interruption — completing silently would overwrite
  // backup content the journal never saw, so decide must be consulted.
  const fs = makeMemoryFs({ [ARTIFACT]: "previous", [BACKUP]: "someone rewrote the backup" });
  const journal = makeJournal(fs);
  const prompts: RevertRecoveryPrompt[] = [];
  const recovered = await recoverRevertJournal(journal, fs, (prompt) => {
    prompts.push(prompt);
    return Promise.resolve("keep");
  });
  assert.equal(recovered, false);
  assert.equal(prompts.length, 1, "backup divergence must be surfaced, not auto-applied");
  assert.equal(prompts[0]!.backupDiverged, true);
  assert.equal(text(fs, BACKUP), "someone rewrote the backup", "keep must not touch the backup");
});

void test("recovery defers untouched while the artifact is open in a dirty editor", async () => {
  // Writing to disk beneath a dirty editor would let the user's next save
  // restore stale buffer content over the recovered version — recovery must
  // defer (journal retained, nothing written, no prompt) until the buffer
  // is saved or closed.
  const fs = makeMemoryFs({ [ARTIFACT]: "current", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  let prompted = false;
  const recovered = await recoverRevertJournal(
    journal,
    fs,
    () => {
      prompted = true;
      return Promise.resolve("restore");
    },
    (target) => target.fsPath === vscode.Uri.file(ARTIFACT).fsPath
  );
  assert.equal(recovered, false);
  assert.equal(prompted, false, "a dirty target defers without prompting");
  assert.equal(text(fs, ARTIFACT), "current", "nothing may be written");
  assert.equal(text(fs, BACKUP), "previous");
  assert.equal(fs.files.has(journal.fsPath), true, "the journal is retained for a later activation");
});

void test("recovery defers a half-applied swap while the backup is open dirty", async () => {
  // Even the silent backup-completion write is a disk write beneath an open
  // dirty editor when the BACKUP file is the dirty one — defer it too.
  const fs = makeMemoryFs({ [ARTIFACT]: "previous", [BACKUP]: "previous" });
  const journal = makeJournal(fs);
  const recovered = await recoverRevertJournal(
    journal,
    fs,
    undefined,
    (target) => target.fsPath === vscode.Uri.file(BACKUP).fsPath
  );
  assert.equal(recovered, false);
  assert.equal(text(fs, BACKUP), "previous", "the backup write is deferred");
  assert.equal(fs.files.has(journal.fsPath), true, "the journal is retained");
});

void test("parseRevertJournal rejects wrong versions and missing fields", () => {
  const encode = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));
  assert.equal(parseRevertJournal(encode({ version: 2 })), undefined);
  assert.equal(
    parseRevertJournal(encode({ version: 1, artifactPath: "/a" })),
    undefined
  );
  assert.notEqual(
    parseRevertJournal(
      encode({
        version: 1,
        artifactPath: "/a",
        backupPath: "/b",
        artifactContent: "",
        backupContent: "",
      })
    ),
    undefined
  );
});
