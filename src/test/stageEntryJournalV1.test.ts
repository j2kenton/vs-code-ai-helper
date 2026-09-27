/**
 * Boundary tests for the Part 2 (item 15 hardening) stage-entry journal
 * primitives and Phase A recovery (`src/utils/stageEntryJournalV1.ts`).
 *
 * This module has no production writer yet (see its own doc comment) — these
 * tests exercise it directly, the same "additive, not-yet-wired primitive"
 * pattern `enterStageV1.test.ts` used for Part 1's primitives before they
 * were wired into production call sites.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  beginStageEntryJournalV1,
  deleteStageEntryJournalV1,
  getStageEntryJournalUri,
  readStageEntryJournalV1,
  recoverStageEntryJournalIfPresentV1,
  recoverStageEntryJournalV1,
  sha256HexV1,
  StageEntryJournalUnreadableErrorV1,
  StageEntryRecoveryPendingErrorV1,
  writeStageEntryJournalV1,
  type StageEntryJournalV1,
} from "../utils/stageEntryJournalV1";
import type { TaskProgress } from "../types/taskProgress";
import { getCanonicalImplementationUri, getPlanRevisionJournalUri } from "../utils/implementationArtifactResolver";
import { previousVersionUri } from "../utils/artifactBackups";
import { withPlanFileWriteLockV1 } from "../utils/fileUtils";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { withTaskLock } from "../state/taskStateStore";
import { safeRemoveDir } from "./testFsUtils";
// Namespace import, so the "transition-owned journal cleanup across
// interleaved transitions" test below can reassign this SAME module
// object's property — the exact reference `stageEntryJournalV1.ts`'s own
// `require("./stageTransition")` dereferences at call time (see that
// module's compiled output) — to park and later release the real production
// Phase B/C entry point, `runStageEntryPostCommitV1`.
import * as stageTransition from "../utils/stageTransition";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stage-entry-journal-test-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stage-entry-journal-test-private-"));
configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
after(() => {
  safeRemoveDir(REAL_ROOT);
});

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

let counter = 0;

function makeTaskFolder(overrides: Partial<TaskProgress> = {}): { folderPath: string; folderUri: vscode.Uri } {
  counter += 1;
  const name = `stage-entry-journal-${counter}`;
  const folderPath = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage: "plan-low-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "tasks"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

function baseJournal(overrides: Partial<StageEntryJournalV1> = {}): StageEntryJournalV1 {
  return {
    transitionId: "t-1",
    from: "plan-low-review",
    to: "impl",
    startedAt: "2026-01-01T00:00:00.000Z",
    artifact: "plan-final.md",
    priorArtifact: "absent",
    phase: "intent",
    ...overrides,
  };
}

async function withHarness<T>(fn: () => Promise<T>): Promise<T> {
  const fsBridge = installFsBridge();
  const ws = installWorkspaceFoldersStub();
  try {
    return await fn();
  } finally {
    ws.restore();
    fsBridge.restore();
  }
}

void describe("stage-entry journal ownership rules", () => {
  void it("round-trips a written journal through read", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal());
      const read = await readStageEntryJournalV1(folderUri);
      assert.deepEqual(read, baseJournal());
    });
  });

  void it("returns undefined when no journal exists", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("readStageEntryJournalV1 (the tolerant reader) returns undefined for a corrupt journal file", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "stage-entry-journal.json"), "{ not json", "utf8");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("beginStageEntryJournalV1 refuses — and does NOT silently overwrite — a corrupt journal file", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "stage-entry-journal.json"), "{ not json", "utf8");
      await assert.rejects(
        () => beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-2" })),
        StageEntryJournalUnreadableErrorV1
      );
      // The corrupt file is left exactly as it was — never discarded by a
      // write-ownership guard. Only recoverStageEntryJournalV1 may do that.
      assert.equal(fs.readFileSync(path.join(folderPath, "stage-entry-journal.json"), "utf8"), "{ not json");
    });
  });

  void it("writeStageEntryJournalV1 refuses — and does NOT silently overwrite — a corrupt journal file", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "stage-entry-journal.json"), "not even an object", "utf8");
      await assert.rejects(
        () => writeStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-2" })),
        StageEntryJournalUnreadableErrorV1
      );
      assert.equal(fs.readFileSync(path.join(folderPath, "stage-entry-journal.json"), "utf8"), "not even an object");
    });
  });

  void it("beginStageEntryJournalV1 refuses when a journal already exists, whatever transition it belongs to", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-1" }));
      await assert.rejects(
        () => beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-2" })),
        StageEntryRecoveryPendingErrorV1
      );
      // The original journal is untouched.
      assert.equal((await readStageEntryJournalV1(folderUri))?.transitionId, "t-1");
    });
  });

  void it("writeStageEntryJournalV1 advances the SAME transition's phase in place", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-1" }));
      await writeStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-1", phase: "publishing", expectedSha256: "abc" }));
      const read = await readStageEntryJournalV1(folderUri);
      assert.equal(read?.phase, "publishing");
      assert.equal(read?.expectedSha256, "abc");
    });
  });

  void it("writeStageEntryJournalV1 refuses to replace a DIFFERENT transition's journal", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-1" }));
      await assert.rejects(
        () => writeStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-2" })),
        StageEntryRecoveryPendingErrorV1
      );
      assert.equal((await readStageEntryJournalV1(folderUri))?.transitionId, "t-1");
    });
  });

  void it("deleteStageEntryJournalV1 deletes only when the on-disk transitionId matches", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-1" }));

      // A caller with a stale transitionId (e.g. it read an earlier journal
      // that has since been superseded) must not delete a newer one.
      await deleteStageEntryJournalV1(folderUri, "some-other-transition");
      assert.notEqual(await readStageEntryJournalV1(folderUri), undefined);

      await deleteStageEntryJournalV1(folderUri, "t-1");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("deleteStageEntryJournalV1 is a no-op when no journal exists", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      await deleteStageEntryJournalV1(folderUri, "anything");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("the journal write is atomic (no temp file left behind, real bytes on disk)", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder();
      await beginStageEntryJournalV1(folderUri, baseJournal());
      const entries = fs.readdirSync(folderPath);
      assert.ok(entries.includes("stage-entry-journal.json"));
      assert.ok(!entries.some((name) => name.includes("_temp_")), "no leftover atomic-write temp file");
    });
  });
});

void describe("recoverStageEntryJournalV1 (Phase A: decide + rollback)", () => {
  void it("reports nothing-to-do when there is no journal", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      const outcome = await recoverStageEntryJournalV1(folderUri);
      assert.deepEqual(outcome, { kind: "nothing-to-do" });
    });
  });

  void it("discards an unreadable journal, leaves the artifact untouched (no proof available), and logs it", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(path.join(folderPath, "stage-entry-journal.json"), "{ this is not valid json", "utf8");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), "whatever was there before", "utf8");

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "unreadable-journal-discarded" });
      assert.equal(
        fs.existsSync(path.join(folderPath, "stage-entry-journal.json")),
        false,
        "the corrupt journal is discarded so it cannot block every future transition forever"
      );
      assert.equal(
        fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"),
        "whatever was there before",
        "the artifact is never touched without proof, and a corrupt journal carries no provable hash"
      );
      const runsDir = path.join(folderPath, "runs");
      assert.ok(fs.existsSync(runsDir));
      assert.ok(fs.readdirSync(runsDir).some((name) => name.includes("stage-entry-recovery")));
    });
  });

  void it("after a corrupt journal is recovered, a new transition can begin normally", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder();
      fs.writeFileSync(getStageEntryJournalUri(folderUri).fsPath, "{ garbage", "utf8");

      await recoverStageEntryJournalV1(folderUri);
      await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-new" }));

      assert.equal((await readStageEntryJournalV1(folderUri))?.transitionId, "t-new");
    });
  });

  void it("reports committed, replays Phase B (no-op, no deferredAdoption) and deletes the journal (Phase C) when currentStage already equals the journal's destination", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "impl" });
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.equal(outcome.kind, "committed");
      const journal = await readStageEntryJournalV1(folderUri);
      assert.equal(journal, undefined, "Phase C must delete a committed journal with no deferred payload to replay");
    });
  });

  void it("rolls forward an already-committed journal: Phase C deletes it", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "publish" });
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "published" }));
      await writeStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "committed" }));

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.equal(outcome.kind, "committed");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined, "a committed journal always rolls forward and is cleaned up");
    });
  });

  void it(
    "replays a committed journal's deferredAdoption (Phase B) via applyDeferredPlanRevisionAdoptionV1 before deleting the journal (Phase C)",
    async () => {
      await withHarness(async () => {
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "impl",
          checklistChangeProposals: [
            {
              at: "2026-01-01T00:00:00.000Z",
              roundId: "round-1",
              stage: "impl",
              kind: "added",
              proposedItems: ["Add a new step"],
              removedItems: [],
              status: "revising",
            },
          ],
          planRevision: {
            proposalAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        } as Partial<TaskProgress>);
        fs.writeFileSync(
          path.join(folderPath, "plan-final.md"),
          "<!-- ensemble:implementation-checklist -->\n\n- [x] Revised\n",
          "utf8"
        );
        await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));
        await writeStageEntryJournalV1(
          folderUri,
          baseJournal({
            to: "impl",
            phase: "published",
            deferredAdoption: { proposalAt: "2026-01-01T00:00:00.000Z", stage: "impl", oldTotal: 1, newTotal: 1 },
          })
        );

        const outcome = await recoverStageEntryJournalV1(folderUri);

        assert.equal(outcome.kind, "committed");
        assert.equal(await readStageEntryJournalV1(folderUri), undefined, "Phase C must still delete the journal after replay");
        const progressRaw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as {
          checklistChangeProposals?: Array<{ status?: string }>;
        };
        assert.equal(
          progressRaw.checklistChangeProposals?.[0]?.status,
          "adopted",
          "Phase B must have applied the deferred plan-revision adoption, exactly as the non-crash post-commit path does"
        );
      });
    }
  );

  void it("phase 'intent': leaves any plan-final.md untouched (not this transition's) and deletes the journal", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      // A human-created file that happens to be here — must survive.
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), "human content", "utf8");
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "rolled-back", transitionId: "t-1", action: "left-untouched-no-write-attempted" });
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), "human content");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("phase 'published', first seed: bytes on disk match expectedSha256 -> deletes the first-seed file", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const bytes = new TextEncoder().encode("freshly promoted content");
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, bytes);
      await beginStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: "absent" })
      );
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: "absent", phase: "published", expectedSha256: sha256HexV1(bytes) })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "rolled-back", transitionId: "t-1", action: "deleted-first-seed" });
      assert.equal(fs.existsSync(getCanonicalImplementationUri(folderUri).fsPath), false);
      assert.equal(await readStageEntryJournalV1(folderUri), undefined);
    });
  });

  void it("phase 'published', revision case: restores prior content from the frozen snapshot when its hash matches", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan" });
      const priorBytes = new TextEncoder().encode("pre-revision plan-final content");
      const newBytes = new TextEncoder().encode("post-revision plan-final content");
      fs.writeFileSync(getPlanRevisionJournalUri(folderUri).fsPath, priorBytes);
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, newBytes);
      await beginStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: { sha256: sha256HexV1(priorBytes) } })
      );
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({
          to: "impl",
          priorArtifact: { sha256: sha256HexV1(priorBytes) },
          phase: "published",
          expectedSha256: sha256HexV1(newBytes),
        })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "rolled-back", transitionId: "t-1", action: "restored-prior-content" });
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), "pre-revision plan-final content");
    });
  });

  void it("phase 'published', revision case: falls back to the _prev backup when the frozen snapshot is missing but the backup hash matches", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan" });
      const priorBytes = new TextEncoder().encode("backup-sourced prior content");
      const newBytes = new TextEncoder().encode("post-revision content");
      fs.writeFileSync(previousVersionUri(getCanonicalImplementationUri(folderUri)).fsPath, priorBytes);
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, newBytes);
      await beginStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: { sha256: sha256HexV1(priorBytes) } })
      );
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({
          to: "impl",
          priorArtifact: { sha256: sha256HexV1(priorBytes) },
          phase: "published",
          expectedSha256: sha256HexV1(newBytes),
        })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "rolled-back", transitionId: "t-1", action: "restored-prior-content" });
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), "backup-sourced prior content");
    });
  });

  void it("restores prior content byte-for-byte, preserving a leading BOM that a text decode/encode round trip would strip", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan" });
      // TextDecoder().decode() strips a leading UTF-8 BOM by default; a
      // restore that goes through decode-then-re-encode (the defect this
      // test pins) would silently drop it. Writing the verified bytes
      // directly must not.
      const priorBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("pre-revision content")]);
      const newBytes = new TextEncoder().encode("post-revision content");
      fs.writeFileSync(getPlanRevisionJournalUri(folderUri).fsPath, priorBytes);
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, newBytes);
      await beginStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: { sha256: sha256HexV1(priorBytes) } })
      );
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({
          to: "impl",
          priorArtifact: { sha256: sha256HexV1(priorBytes) },
          phase: "published",
          expectedSha256: sha256HexV1(newBytes),
        })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, { kind: "rolled-back", transitionId: "t-1", action: "restored-prior-content" });
      const restoredOnDisk = new Uint8Array(fs.readFileSync(path.join(folderPath, "plan-final.md")));
      assert.deepEqual(Array.from(restoredOnDisk), Array.from(priorBytes), "restored bytes must match exactly, BOM included");
    });
  });

  void it("rollback's hash-check-and-mutate is serialized against a concurrent writer of plan-final.md via withPlanFileWriteLockV1", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const bytesA = new TextEncoder().encode("this transition's bytes");
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, bytesA);
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", priorArtifact: "absent" }));
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: "absent", phase: "published", expectedSha256: sha256HexV1(bytesA) })
      );

      // Occupy the SAME per-uri queue rollback uses, holding it while
      // swapping the file's content out from under the hash proof — exactly
      // the race the review flagged: "a checklist merge or human edit using
      // the plan-file lock can land after the hash check and then be deleted
      // or overwritten".
      let releaseHold: (() => void) | undefined;
      const holdReleased = new Promise<void>((resolve) => { releaseHold = resolve; });
      let holdStarted = false;
      const holding = withPlanFileWriteLockV1(getCanonicalImplementationUri(folderUri), async () => {
        holdStarted = true;
        await holdReleased;
        fs.writeFileSync(
          getCanonicalImplementationUri(folderUri).fsPath,
          "a legitimate concurrent writer's content",
          "utf8"
        );
      });

      while (!holdStarted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const recovery = recoverStageEntryJournalV1(folderUri);
      // Give recovery a moment to reach (and queue behind) the same lock.
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseHold?.();
      await holding;

      const outcome = await recovery;

      // Recovery's hash check could only run AFTER the concurrent writer's
      // content landed (it was forced to wait for the same queue), so it
      // correctly sees bytes that no longer match expectedSha256 and leaves
      // them alone — it must NOT delete the concurrent writer's content
      // based on a stale pre-queue read.
      assert.deepEqual(outcome, {
        kind: "rolled-back",
        transitionId: "t-1",
        action: "left-untouched-unrecognized-content",
      });
      assert.equal(
        fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"),
        "a legitimate concurrent writer's content"
      );
    });
  });

  void it("phase 'published', revision case: leaves the file in place when no restore source verifies against the recorded hash", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan" });
      const newBytes = new TextEncoder().encode("post-revision content, no verified prior source");
      const unverifiablePriorHash = "0".repeat(64);
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, newBytes);
      await beginStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: { sha256: unverifiablePriorHash } })
      );
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({
          to: "impl",
          priorArtifact: { sha256: unverifiablePriorHash },
          phase: "published",
          expectedSha256: sha256HexV1(newBytes),
        })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, {
        kind: "rolled-back",
        transitionId: "t-1",
        action: "left-untouched-unrecognized-content",
      });
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), new TextDecoder().decode(newBytes));
    });
  });

  void it("phase 'publishing' before bytes landed: current bytes equal priorArtifact (or are absent) -> nothing to undo", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      // No file was ever written — the crash happened before the write.
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", priorArtifact: "absent" }));
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: "absent", phase: "publishing", expectedSha256: "some-hash-that-never-landed" })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, {
        kind: "rolled-back",
        transitionId: "t-1",
        action: "nothing-to-undo-write-never-landed",
      });
      assert.equal(fs.existsSync(getCanonicalImplementationUri(folderUri).fsPath), false);
    });
  });

  void it("a file matching neither expectedSha256 nor priorArtifact's hash is left in place and logged (someone else touched it)", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(getCanonicalImplementationUri(folderUri).fsPath, "a third party's content", "utf8");
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", priorArtifact: "absent" }));
      await writeStageEntryJournalV1(
        folderUri,
        baseJournal({ to: "impl", priorArtifact: "absent", phase: "published", expectedSha256: "not-a-real-hash" })
      );

      const outcome = await recoverStageEntryJournalV1(folderUri);

      assert.deepEqual(outcome, {
        kind: "rolled-back",
        transitionId: "t-1",
        action: "left-untouched-unrecognized-content",
      });
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), "a third party's content");
      assert.equal(await readStageEntryJournalV1(folderUri), undefined, "journal is still cleaned up even when the file is left alone");
    });
  });

  void it("writes a run-log line describing the rollback", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));

      await recoverStageEntryJournalV1(folderUri);

      const runsDir = path.join(folderPath, "runs");
      assert.ok(fs.existsSync(runsDir), "runs/ directory created");
      const entries = fs.readdirSync(runsDir);
      assert.ok(entries.some((name) => name.includes("stage-entry-recovery")), "a stage-entry-recovery run log was written");
    });
  });

  void it("is idempotent: recovering an already-recovered (journal gone) task a second time is a no-op", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));
      await recoverStageEntryJournalV1(folderUri);

      const second = await recoverStageEntryJournalV1(folderUri);
      assert.deepEqual(second, { kind: "nothing-to-do" });
    });
  });

  void it("the task lock is released before the run-log line is written (a concurrent withTaskLock acquisition is not blocked for the whole call)", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));

      const recovery = recoverStageEntryJournalV1(folderUri);
      let concurrentAcquired = false;
      const concurrentProbe = withTaskLock(folderPath, () => {
        concurrentAcquired = true;
        return Promise.resolve();
      });

      const both = Promise.all([recovery, concurrentProbe]).then(() => "done" as const);
      const timedOut = new Promise<"timedOut">((resolve) => {
        const timer = setTimeout(() => resolve("timedOut"), 5000);
        void both.finally(() => clearTimeout(timer));
      });
      const raceResult = await Promise.race([both, timedOut]);

      assert.equal(raceResult, "done", "a concurrent withTaskLock acquisition must not be blocked by the whole recovery call");
      assert.equal(concurrentAcquired, true);
    });
  });
});

void describe("transition-owned journal cleanup across interleaved transitions (Part 2 boundary)", () => {
  // Plan (Part 2, 7B): "transition A commits and is parked before Phase C.
  // Process B recovers A's journal, then starts transition B and writes its
  // own journal. A resumes Phase C. A's cleanup does not remove B's journal,
  // and B completes normally."
  //
  // Review fix (2026-09-23, completion blocker): the previous version of
  // this test reduced the scenario to sequential calls of the low-level
  // `deleteStageEntryJournalV1` guard, and called the lock-requiring journal
  // primitives (`beginStageEntryJournalV1`/`writeStageEntryJournalV1`)
  // outside `withTaskLock`, contrary to those primitives' own caller
  // contract. It would have passed even if `recoverAndReplayCommittedJournalV1`
  // / `runStageEntryPostCommitV1` propagated the wrong transition identity,
  // because nothing in it ever called them.
  //
  // This version drives the REAL production path instead: A's own call to
  // the exported `recoverStageEntryJournalV1` runs its real Phase A (decide
  // "committed", under `withTaskLock`, exactly as `recoverStageEntryJournalPhaseAV1`
  // does in production) and then reaches the real `runStageEntryPostCommitV1`
  // (`stageTransition.ts`) — the SAME function `recoverAndReplayCommittedJournalV1`
  // calls for Phase B/C. That call is "parked" via a seam on the shared
  // CommonJS module object (`stageTransition_1.runStageEntryPostCommitV1`,
  // the exact reference `stageEntryJournalV1.ts`'s own `require("./stageTransition")`
  // dereferences at call time — see that file's compiled output) so A is
  // suspended AFTER its own Phase A has decided "committed" and released the
  // lock, but BEFORE its Phase C actually deletes anything — never by
  // substituting a hand-rolled stand-in for either phase. Only A's first
  // (recovery) call is parked; every later invocation of the real function
  // (B's own recovery, and B's own completion) runs immediately and for
  // real. B's own journal writes go through the same lock-requiring
  // primitives under an explicit `withTaskLock`, matching their contract.
  void it(
    "A's delayed real Phase C (runStageEntryPostCommitV1, parked then released) does not delete B's journal, and B completes through the production cleanup path too",
    async () => {
      await withHarness(async () => {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl" });

        // Transition A commits: its journal is on disk, already in
        // "published" phase, and currentStage === journal.to, so a Phase A
        // read of it (by anyone) will find it committed. Written through the
        // lock-requiring primitives under `withTaskLock`, as their own doc
        // comments require.
        await withTaskLock(folderPath, async () => {
          await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-A", to: "impl", phase: "intent" }));
          await writeStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-A", to: "impl", phase: "published" }));
        });

        // The park/release seam: reassign the property `stageEntryJournalV1.ts`
        // actually calls through (its own `require("./stageTransition")`
        // result — the same cached module object this import resolves to).
        // Only the FIRST invocation parks; it awaits `releaseA` and then
        // still calls straight through to the real, original implementation
        // — so what eventually runs for A is exactly production's
        // `runStageEntryPostCommitV1`, merely delayed.
        const stageTransitionModule = stageTransition as unknown as Record<string, unknown>;
        const originalPostCommit = stageTransitionModule.runStageEntryPostCommitV1 as typeof stageTransition.runStageEntryPostCommitV1;
        let parkedOnce = false;
        let releaseA: (() => void) | undefined;
        const aReachedParkPoint = new Promise<void>((resolveReached) => {
          stageTransitionModule.runStageEntryPostCommitV1 = async (
            taskFolderUri: vscode.Uri,
            result: Parameters<typeof stageTransition.runStageEntryPostCommitV1>[1]
          ): Promise<void> => {
            if (!parkedOnce) {
              parkedOnce = true;
              resolveReached();
              await new Promise<void>((resolve) => {
                releaseA = resolve;
              });
            }
            return originalPostCommit(taskFolderUri, result);
          };
        });

        try {
          // A's own recovery call: real Phase A decides "committed"
          // (capturing transitionId "t-A" from the on-disk journal, lock
          // released once Phase A returns) and then reaches the now-parked
          // `runStageEntryPostCommitV1` — suspending A right before its real
          // Phase C would run.
          const aRecovery = recoverStageEntryJournalV1(folderUri);
          await aReachedParkPoint;

          // A's journal is still on disk: Phase A never deletes a
          // "committed" journal itself — only Phase C does, and A's Phase C
          // has not run yet.
          const stillAJournal = await readStageEntryJournalV1(folderUri);
          assert.equal(
            stillAJournal?.transitionId,
            "t-A",
            "A's journal must still be present while A is parked before its real Phase C"
          );

          // Process B independently recovers the SAME still-present
          // journal. Its own Phase A also finds it committed (same
          // transitionId "t-A"), and its Phase B/C — an UNPARKED call into
          // the real runStageEntryPostCommitV1 — actually deletes it.
          const bRecoveryOutcome = await recoverStageEntryJournalV1(folderUri);
          assert.equal(bRecoveryOutcome.kind, "committed");
          assert.equal(bRecoveryOutcome.kind === "committed" ? bRecoveryOutcome.transitionId : undefined, "t-A");
          assert.equal(
            await readStageEntryJournalV1(folderUri),
            undefined,
            "B's own recovery must have actually deleted t-A's journal through the real Phase C"
          );

          // Process B then starts (and commits) its OWN, brand new
          // transition, writing a fresh journal under its own transitionId
          // — through the same lock-requiring primitives production code
          // uses — reusing the exact file A's (now-deleted) journal
          // occupied.
          await withTaskLock(folderPath, async () => {
            await beginStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-B", to: "impl", phase: "intent" }));
            await writeStageEntryJournalV1(folderUri, baseJournal({ transitionId: "t-B", to: "impl", phase: "published" }));
          });

          // A now finally resumes: its parked call to the real
          // runStageEntryPostCommitV1 proceeds, using only the payload A's
          // OWN Phase A captured ("t-A") — never B's. This runs A's actual
          // production Phase C (`deleteStageEntryJournalV1` under
          // `withTaskLock`), not a hand-rolled substitute for it.
          releaseA?.();
          await aRecovery;

          // B's journal must survive A's belated real Phase C completely
          // untouched.
          const survivor = await readStageEntryJournalV1(folderUri);
          assert.equal(survivor?.transitionId, "t-B", "A's delayed real Phase C must not delete B's journal");

          // B completes normally too, through the SAME production cleanup
          // path (the real, unparked runStageEntryPostCommitV1), not the
          // raw `deleteStageEntryJournalV1` primitive directly.
          await originalPostCommit(folderUri, { journalTransitionId: "t-B" });
          assert.equal(
            await readStageEntryJournalV1(folderUri),
            undefined,
            "B's own cleanup, through the production path, must still succeed"
          );
        } finally {
          stageTransitionModule.runStageEntryPostCommitV1 = originalPostCommit;
        }
      });
    }
  );
});

void describe("recoverStageEntryJournalIfPresentV1 (Part 2, proactive-recovery call sites)", () => {
  void it("never acquires withTaskLock when no journal exists (cheap existence probe only)", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });

      // Hold withTaskLock open for the whole call. If the cheap existence
      // probe were skipped and this unconditionally called the full
      // recovery, it would try to acquire this same lock and hang for as
      // long as it is held.
      let releaseOuterLock: (() => void) | undefined;
      const outerLockHeld = new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      });
      const outerLockPromise = withTaskLock(folderPath, () => outerLockHeld);
      try {
        const raced = await Promise.race([
          recoverStageEntryJournalIfPresentV1(folderUri).then(() => "resolved" as const),
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
        ]);
        assert.equal(
          raced,
          "resolved",
          "the cheap existence probe must resolve 'absent' without ever taking withTaskLock"
        );
      } finally {
        releaseOuterLock?.();
        await outerLockPromise;
      }
    });
  });

  void it("returns undefined and touches nothing when no journal exists", async () => {
    await withHarness(async () => {
      const { folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const outcome = await recoverStageEntryJournalIfPresentV1(folderUri);
      assert.equal(outcome, undefined);
    });
  });

  void it("delegates to the full three-phase recovery when a journal is present", async () => {
    await withHarness(async () => {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      // A journal whose destination differs from the current stage, and
      // whose phase never advanced past "intent" — Phase A's "did nothing,
      // nothing to undo" case, so the only observable effect of a real
      // recovery run is that the journal itself is deleted.
      await beginStageEntryJournalV1(folderUri, baseJournal({ to: "impl", phase: "intent" }));
      assert.ok(fs.existsSync(path.join(folderPath, "stage-entry-journal.json")));

      const outcome = await recoverStageEntryJournalIfPresentV1(folderUri);
      assert.equal(outcome?.kind, "rolled-back");
      assert.equal(fs.existsSync(path.join(folderPath, "stage-entry-journal.json")), false);
    });
  });
});

void describe("getStageEntryJournalUri", () => {
  void it("points at stage-entry-journal.json directly under the task folder", () => {
    const folderUri = vscode.Uri.file(path.join(REAL_ROOT, "tasks", "some-task"));
    const journalUri = getStageEntryJournalUri(folderUri);
    assert.equal(journalUri.fsPath, path.join(folderUri.fsPath, "stage-entry-journal.json"));
  });
});
