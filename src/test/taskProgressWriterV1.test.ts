/**
 * Coverage for the §3.10 strict writer / splice-based migrator: canonical V1
 * emission, byte-identical ordered opaque preservation, idempotent
 * migration, and stable round-trips. Byte-exact expectations are in-code
 * string literals (LF-only) so checkout line-ending profiles cannot skew
 * them; structural fixture documents live under test-fixtures/task-progress.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import {
  createTaskProgressV1,
  encodeTaskProgressV1,
  migrateTaskProgressTextV1,
  patchTaskProgressStrictV1,
} from "../services/taskProgressWriterV1";
import { withMetaRootLock } from "../state/taskStateStore";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures", "task-progress");

void describe("taskProgressWriterV1", () => {
  void it("encodes a fresh minimal V1 document with the version marker first", () => {
    const text = encodeTaskProgressV1({
      ensembleProgressVersion: 1,
      taskFolder: "2026-07-01_task_1",
      currentStage: "desc",
      status: "creating",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    assert.equal(
      text,
      `{\n` +
        `  "ensembleProgressVersion": 1,\n` +
        `  "taskFolder": "2026-07-01_task_1",\n` +
        `  "currentStage": "desc",\n` +
        `  "status": "creating",\n` +
        `  "createdAt": "2026-07-01T10:00:00.000Z",\n` +
        `  "updatedAt": "2026-07-01T10:00:00.000Z"\n` +
        `}`
    );
  });

  void it("splices opaque properties through migration byte-identically and in order", () => {
    const legacy =
      `{"taskFolder":"2026-07-01_task_1",` +
      `"zeta":  {"nested": [1, 2,   3]},` +
      `"currentStage":"plan-final",` +
      `"alpha":"u\\u00e9nicode",` +
      `"createdAt":"2026-07-01T10:00:00.000Z",` +
      `"updatedAt":"2026-07-02T11:30:00.000Z"}`;
    const migration = migrateTaskProgressTextV1(legacy);
    assert.equal(migration.ok, true);
    if (!migration.ok) {
      return;
    }
    assert.equal(migration.changed, true);
    assert.equal(
      migration.text,
      `{\n` +
        `  "ensembleProgressVersion": 1,\n` +
        `  "taskFolder": "2026-07-01_task_1",\n` +
        `  "zeta": {"nested": [1, 2,   3]},\n` +
        `  "currentStage": "impl",\n` +
        `  "alpha": "u\\u00e9nicode",\n` +
        `  "createdAt": "2026-07-01T10:00:00.000Z",\n` +
        `  "updatedAt": "2026-07-02T11:30:00.000Z",\n` +
        `  "status": "active"\n` +
        `}`
    );

    // Migrating the migrated text again is a no-op (idempotent splice).
    const again = migrateTaskProgressTextV1(migration.text);
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.changed, false);
      assert.equal(again.text, migration.text);
    }
  });

  void it("flattens the historical envelope while preserving inner opaque spans", () => {
    const wrapped =
      `{"schemaVersion": 1, "data": {"taskFolder":"2026-07-01_task_1",` +
      `"legacyNote": "keep me",` +
      `"currentStage":"impl","createdAt":"2026-07-01T10:00:00.000Z",` +
      `"updatedAt":"2026-07-02T11:30:00.000Z"}}`;
    const migration = migrateTaskProgressTextV1(wrapped);
    assert.equal(migration.ok, true);
    if (migration.ok) {
      const reparsed = JSON.parse(migration.text) as Record<string, unknown>;
      assert.equal(reparsed["schemaVersion"], undefined);
      assert.equal(reparsed["data"], undefined);
      assert.equal(reparsed["legacyNote"], "keep me");
      assert.equal(reparsed["ensembleProgressVersion"], 1);
    }
  });

  void it("omits cleared product fields and appends newly set ones in declaration order", () => {
    const source = decodeTaskProgressTextV1(
      JSON.stringify({
        taskFolder: "2026-07-01_task_1",
        currentStage: "impl",
        status: "active",
        reviewAttemptId: "attempt-1",
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-02T11:30:00.000Z",
        custom: "opaque",
      })
    );
    assert.equal(source.ok, true);
    if (!source.ok) {
      return;
    }
    const updated = {
      ...source.decoded.progress,
      reviewAttemptId: undefined,
      completedAt: "2026-07-03T12:00:00.000Z",
      status: "completed" as const,
    };
    const text = encodeTaskProgressV1(updated, source.decoded.entries);
    const reparsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(reparsed["reviewAttemptId"], undefined);
    assert.equal(reparsed["completedAt"], "2026-07-03T12:00:00.000Z");
    assert.equal(reparsed["custom"], "opaque");
    const keys = Object.keys(reparsed);
    assert.equal(keys[0], "ensembleProgressVersion");
    assert.ok(keys.indexOf("custom") < keys.indexOf("completedAt"));
  });

  void it("round-trips every valid fixture stably (encode∘decode is identity on V1 text)", () => {
    for (const family of ["legacy", "v1"]) {
      const dir = path.join(FIXTURE_ROOT, family);
      for (const file of fs.readdirSync(dir).sort()) {
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        const first = migrateTaskProgressTextV1(text);
        assert.equal(first.ok, true, `${family}/${file} should migrate`);
        if (!first.ok) {
          continue;
        }
        const second = migrateTaskProgressTextV1(first.text);
        assert.equal(second.ok, true, `${family}/${file} migrated output should re-decode`);
        if (second.ok) {
          assert.equal(second.changed, false, `${family}/${file} migration must be idempotent`);
          assert.equal(second.text, first.text);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// patchTaskProgressStrictV1 write-side parity (plan §3.12 cutover
// prerequisites): finalization journaling, byte-identical no-op skip,
// beforeWrite ordering, skipLock composition, and the strict creator.
// These semantics were ported from the legacy patchTaskProgress and the
// permissive consumers cannot migrate until they hold.
// ---------------------------------------------------------------------------

void describe("taskProgressWriterV1 — patchTaskProgressStrictV1 parity", () => {
  const TASK_FOLDER_NAME = "2026-07-01_task_9";

  function installReadFileBridge(): { restore: () => void } {
    const workspaceFs = (vscode.workspace as unknown as { fs: Record<string, unknown> }).fs;
    const original = workspaceFs.readFile;
    workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
    return {
      restore: (): void => {
        workspaceFs.readFile = original;
      },
    };
  }

  interface Harness {
    root: string;
    folder: string;
    folderUri: vscode.Uri;
    progressPath: string;
    journalPath: string;
    restore: () => void;
  }

  function installHarness(): Harness {
    // Two levels below the mkdtemp container so the session/meta lock paths
    // withTaskLock derives stay private to this test (see the matching
    // comment on makeOwnedTaskFolder in taskFolderFixture.ts).
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-strict-writer-"));
    const root = path.join(container, "tasks");
    const folder = path.join(root, TASK_FOLDER_NAME);
    fs.mkdirSync(folder, { recursive: true });
    const bridge = installReadFileBridge();
    const initial = encodeTaskProgressV1({
      ensembleProgressVersion: 1,
      taskFolder: TASK_FOLDER_NAME,
      currentStage: "desc",
      status: "active",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    fs.writeFileSync(path.join(folder, "task-progress.json"), initial);
    return {
      root,
      folder,
      folderUri: vscode.Uri.file(folder),
      progressPath: path.join(folder, "task-progress.json"),
      journalPath: path.join(folder, "finalization-journal.json"),
      restore: (): void => {
        bridge.restore();
        try {
          fs.chmodSync(path.join(folder, "task-progress.json"), 0o666);
        } catch {
          /* file may not exist */
        }
        fs.rmSync(container, { recursive: true, force: true });
      },
    };
  }

  void it("applies a real change canonically and clears the finalization journal on success", async () => {
    const h = installHarness();
    try {
      const patched = await patchTaskProgressStrictV1(h.folderUri, (current) => ({
        ...current,
        currentStage: "plan",
        updatedAt: "2026-07-02T11:00:00.000Z",
      }));
      assert.equal(patched?.currentStage, "plan");
      const onDisk = fs.readFileSync(h.progressPath, "utf8");
      assert.match(onDisk, /"ensembleProgressVersion": 1/);
      assert.match(onDisk, /"currentStage": "plan"/);
      // finishFinalization ran: the intent journal must not linger after a
      // successful mutation.
      assert.equal(fs.existsSync(h.journalPath), false);
      // The write is strict-decodable round-trip.
      const decoded = decodeTaskProgressTextV1(onDisk, { expectedTaskFolder: TASK_FOLDER_NAME });
      assert.equal(decoded.ok, true);
    } finally {
      h.restore();
    }
  });

  void it("skips the write entirely for a byte-identical patch, but still runs beforeWrite (CAS-decline parity)", async () => {
    const h = installHarness();
    try {
      const before = fs.readFileSync(h.progressPath, "utf8");
      const statBefore = fs.statSync(h.progressPath);
      // A read-only target makes any attempted replace fail loudly on
      // Windows — the no-op path must never reach the filesystem.
      fs.chmodSync(h.progressPath, 0o444);
      let beforeWriteRan = 0;
      const result = await patchTaskProgressStrictV1(
        h.folderUri,
        (current) => ({ ...current }),
        {
          beforeWrite: (): Promise<void> => {
            beforeWriteRan += 1;
            return Promise.resolve();
          },
        }
      );
      assert.equal(beforeWriteRan, 1, "beforeWrite must run even for a validated no-op CAS");
      assert.equal(result?.currentStage, "desc");
      fs.chmodSync(h.progressPath, 0o666);
      assert.equal(fs.readFileSync(h.progressPath, "utf8"), before);
      assert.equal(fs.statSync(h.progressPath).mtimeMs, statBefore.mtimeMs);
      assert.equal(fs.existsSync(h.journalPath), false, "a skipped write must not journal");
    } finally {
      h.restore();
    }
  });

  void it("declines via an undefined update result without writing", async () => {
    const h = installHarness();
    try {
      const before = fs.readFileSync(h.progressPath, "utf8");
      const result = await patchTaskProgressStrictV1(h.folderUri, () => undefined);
      assert.equal(result?.currentStage, "desc");
      assert.equal(fs.readFileSync(h.progressPath, "utf8"), before);
    } finally {
      h.restore();
    }
  });

  void it("leaves the finalization journal in place when the target write fails (crash-recovery evidence)", async () => {
    const h = installHarness();
    try {
      await assert.rejects(
        patchTaskProgressStrictV1(
          h.folderUri,
          (current) => ({ ...current, currentStage: "plan", updatedAt: "2026-07-02T11:00:00.000Z" }),
          {
            beforeWrite: (): Promise<void> => {
              // Sabotage the target so the atomic write's rename cannot land:
              // a directory now occupies the progress-file path.
              fs.rmSync(h.progressPath, { force: true });
              fs.mkdirSync(h.progressPath);
              return Promise.resolve();
            },
          }
        )
      );
      assert.equal(fs.existsSync(h.journalPath), true, "the intent journal must survive a failed write");
      const journal = JSON.parse(fs.readFileSync(h.journalPath, "utf8")) as { operation: string };
      assert.equal(journal.operation, "task-progress mutation");
      fs.rmdirSync(h.progressPath);
    } finally {
      h.restore();
    }
  });

  void it("honors skipLock under a held covering meta-root lock (no self-deadlock)", async () => {
    const h = installHarness();
    try {
      const patched = await withMetaRootLock(h.root, async () =>
        patchTaskProgressStrictV1(
          h.folderUri,
          (current) => ({ ...current, currentStage: "impl", updatedAt: "2026-07-03T09:00:00.000Z" }),
          { skipLock: true }
        )
      );
      assert.equal(patched?.currentStage, "impl");
    } finally {
      h.restore();
    }
  });

  void it("createTaskProgressV1 emits a strict, version-marked creating sentinel", () => {
    const created = createTaskProgressV1(TASK_FOLDER_NAME);
    assert.equal(created.ensembleProgressVersion, 1);
    assert.equal(created.status, "creating");
    assert.equal(created.currentStage, "desc");
    assert.equal(created.taskFolder, TASK_FOLDER_NAME);
    assert.equal(created.createdAt, created.updatedAt);
    const decoded = decodeTaskProgressTextV1(encodeTaskProgressV1(created), {
      expectedTaskFolder: TASK_FOLDER_NAME,
    });
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.decoded.progress.status, "creating");
    }
  });
});
