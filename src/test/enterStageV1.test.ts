/**
 * Boundary tests for the Part 1 stage-entry primitive (register: "pre-1.0.0
 * fixes register (post v1 f2)", Part 1, item 15's fix):
 * `prepareStageEntryV1` / `enterStageV1` / the `advanceStageLocked` runtime
 * backstop, all in `src/utils/stageTransition.ts`.
 *
 * These are additive, not-yet-wired primitives (no production caller yet —
 * see each new `TransitionKind` member's doc comment for the intended future
 * caller), so this file is currently the only coverage for their behavior.
 *
 * Reuses the real-fs bridge pattern from `planRevisionV1.test.ts` so
 * `preparePlanPromotion`'s actual plan.md -> plan-final.md promotion runs
 * for real, rather than re-stubbing it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  advanceStage,
  enterStageV1,
  prepareStageEntryV1,
  runStageEntryPostCommitV1,
} from "../utils/stageTransition";
import { sha256HexV1 } from "../utils/stageEntryJournalV1";
import { materializeCanonicalIfNeeded } from "../utils/implementationArtifactResolver";
import type { ChecklistChangeProposalV1, TaskProgress } from "../types/taskProgress";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { withTaskLock } from "../state/taskStateStore";
import { safeRemoveDir } from "./testFsUtils";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-enter-stage-test-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-enter-stage-test-private-"));
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
  const name = `enter-stage-${counter}`;
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

function readProgress(folderPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
}

const SIMPLE_PLAN = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Do the thing", ""].join("\n");

void describe("prepareStageEntryV1", () => {
  void it("reports nothing-to-do for a non-impl destination without reading plan.md", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder();
      const result = await prepareStageEntryV1(folderUri, "plan-high-review");
      assert.deepEqual(result, { ready: true });
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("is not ready for impl with no plan.md to promote", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder();
      const result = await prepareStageEntryV1(folderUri, "impl");
      assert.equal(result.ready, false);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("is ready with a publish closure for impl when plan.md exists and no canonical artifact yet", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");
      const result = await prepareStageEntryV1(folderUri, "impl");
      assert.equal(result.ready, true);
      assert.ok(result.ready && result.publish, "expected a publish() closure");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-22, completion blocker): `requireExistingArtifact`
  // (used by `enterStageV1` for the "reopen" kind) must refuse — never
  // promote from a leftover plan.md — when plan-final.md is not already
  // canonical.
  void it("with requireExistingArtifact, is not ready for impl even when plan.md exists but plan-final.md does not", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");
      const result = await prepareStageEntryV1(folderUri, "impl", { requireExistingArtifact: true });
      assert.deepEqual(result, { ready: false });
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("with requireExistingArtifact, is ready with no publish closure when plan-final.md already exists", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder();
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), SIMPLE_PLAN, "utf8");
      const result = await prepareStageEntryV1(folderUri, "impl", { requireExistingArtifact: true });
      assert.deepEqual(result, { ready: true });
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });
});

void describe("enterStageV1", () => {
  void it("refuses before writing anything when there is no plan to promote", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const before = readProgress(folderPath);

      const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

      assert.deepEqual(result, { ready: false, reason: "there is no plan to promote — generate the plan first" });
      assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
      assert.equal(fs.existsSync(path.join(folderPath, "plan-final.md")), false);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("commits the stage move and promotes plan.md -> plan-final.md when work is needed", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

      const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

      assert.equal(result.ready, true);
      assert.ok(result.ready && result.transition.persisted);
      assert.equal(readProgress(folderPath).currentStage, "impl");
      assert.match(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), /Do the thing/);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Part 2 (item 15 hardening): the promotion write itself (plan.md ->
  // plan-final.md) is now atomic (temp file + rename via `writeAtomic`)
  // rather than a direct `writeFile` — so a crash mid-write can never leave
  // plan-final.md partially written. This pins that no atomic-temp file is
  // left behind after a normal, successful promotion, and that the durable
  // content is exactly what was promoted.
  void it("promotes plan.md -> plan-final.md atomically, leaving no temp file behind", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

      const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

      assert.equal(result.ready, true);
      const entries = fs.readdirSync(folderPath);
      assert.ok(entries.includes("plan-final.md"));
      assert.ok(!entries.some((name) => name.includes("_temp_")), "no leftover atomic-write temp file");
      assert.match(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), /Do the thing/);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-22, completion blocker): a "reopen" transition into
  // "impl" must refuse with its own distinguishing reason and never promote
  // from a leftover plan.md — the artifact must already be canonical.
  void it("refuses a 'reopen' transition into impl with a leftover plan.md but no plan-final.md, with the reopen-specific reason", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "publish" });
      fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");
      const before = readProgress(folderPath);

      const result = await enterStageV1(folderUri, "publish", "impl", false, "reopen");

      assert.deepEqual(result, {
        ready: false,
        reason:
          "this task has no plan-final.md to reopen at Implementation — its plan may need to be regenerated first",
      });
      assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
      assert.equal(
        fs.existsSync(path.join(folderPath, "plan-final.md")),
        false,
        "must not regenerate plan-final.md from the leftover plan.md"
      );
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("commits with no publish closure (plan-final.md untouched) when the artifact is already canonical", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl-low-review" });
      const existingFinal = "<!-- ensemble:implementation-checklist -->\n\n- [x] Already done\n";
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), existingFinal, "utf8");
      const finalStatBefore = fs.statSync(path.join(folderPath, "plan-final.md"));

      const result = await enterStageV1(folderUri, "impl-low-review", "impl", false, "jump");

      assert.equal(result.ready, true);
      assert.ok(result.ready && result.transition.persisted);
      assert.equal(readProgress(folderPath).currentStage, "impl");
      const finalStatAfter = fs.statSync(path.join(folderPath, "plan-final.md"));
      assert.equal(finalStatAfter.mtimeMs, finalStatBefore.mtimeMs, "plan-final.md must not be rewritten");
      assert.equal(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), existingFinal);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("runs the caller's transform (and precondition) inside the same locked update", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-high-review" });

      const result = await enterStageV1(folderUri, "plan-high-review", "plan-low-review", false, "jump", {
        precondition: (current) => (current.currentStage === "plan-high-review" ? true : "stale"),
        transform: (current) => ({ ...current, currentStage: "plan-low-review" }),
      });

      assert.equal(result.ready, true);
      assert.equal(readProgress(folderPath).currentStage, "plan-low-review");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-22, completion blocker): a same-stage transition
  // (sourceStage === destinationStage, e.g. a "Generate Plan" re-run that
  // lands back on "plan" when review mode is off) used to take a separate
  // early-return path in advanceStageLocked that skipped `precondition` and
  // `transform` entirely. It must run through the exact same locked
  // CAS/precondition/transform/publish sequence as every other transition.
  void it("runs the caller's precondition and transform for a same-stage transition, not just a different-stage one", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan", nextActor: "human" });

      const result = await enterStageV1(folderUri, "plan", "plan", false, "jump", {
        precondition: (current) => (current.currentStage === "plan" ? true : "stale"),
        transform: (current) => ({ ...current, nextActor: "automation" }),
      });

      assert.equal(result.ready, true);
      assert.equal(readProgress(folderPath).currentStage, "plan");
      assert.equal(
        readProgress(folderPath).nextActor,
        "automation",
        "the caller's transform must run even though the stage itself did not change"
      );
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("refuses a same-stage transition with the precondition's reason and writes nothing when the precondition fails", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan" });
      const before = readProgress(folderPath);

      const result = await enterStageV1(folderUri, "plan", "plan", false, "jump", {
        precondition: () => "a custom precondition refused this same-stage transition",
      });

      assert.equal(result.ready, false);
      if (!result.ready) {
        assert.equal(result.reason, "a custom precondition refused this same-stage transition");
        // Review fix (2026-09-22, architectural blocker, fourth narrowing):
        // `cause` preserves the original thrown error so a caller rerouted
        // onto `enterStageV1` (e.g. `nextStageRowV1.ts`) can recover its
        // exact typed error class instead of parsing `reason`'s free text.
        assert.ok(result.cause instanceof Error);
      }
      assert.deepEqual(readProgress(folderPath), before);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });


  void it("refuses with the precondition's reason and writes nothing when the precondition fails", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-high-review" });
      const before = readProgress(folderPath);

      const result = await enterStageV1(folderUri, "plan-high-review", "plan-low-review", false, "jump", {
        precondition: () => "a custom precondition refused this transition",
      });

      assert.equal(result.ready, false);
      if (!result.ready) {
        assert.equal(result.reason, "a custom precondition refused this transition");
        assert.ok(result.cause instanceof Error);
      }
      assert.deepEqual(readProgress(folderPath), before);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("refuses when the source stage has already moved on (lost compare-and-set)", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      // Destination is non-impl so prepareStageEntryV1 has nothing to
      // prepare and the CAS check inside advanceStage is what refuses this.
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const before = readProgress(folderPath);

      const result = await enterStageV1(folderUri, "plan-high-review", "plan-low-review", false, "jump");

      assert.equal(result.ready, false);
      assert.ok(result.ready === false && /Task changed before transition/.test(result.reason));
      assert.deepEqual(readProgress(folderPath), before);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it(
    "defers a plan-revision's durable adoption write until runStageEntryPostCommitV1 runs after the lock releases",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const proposal: ChecklistChangeProposalV1 = {
          at: "2026-09-20T00:00:00.000Z",
          roundId: "round-1",
          stage: "impl",
          kind: "added",
          proposedItems: ["Add a new step"],
          removedItems: [],
          status: "revising",
        };
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "plan-low-review",
          checklistChangeProposals: [proposal],
          planRevision: {
            proposalAt: proposal.at,
            startedAt: "2026-09-20T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        });
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n", "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, true);
        assert.ok(result.ready && result.deferredPlanRevisionAdoption, "expected a deferred adoption record");
        // Not yet written: the proposal must still read "revising" right
        // after enterStageV1 returns, before the post-commit step runs.
        assert.equal(readProgress(folderPath).checklistChangeProposals?.[0]?.status, "revising");

        await runStageEntryPostCommitV1(folderUri, result);

        assert.equal(readProgress(folderPath).checklistChangeProposals?.[0]?.status, "adopted");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  // Part 1 boundary test: "the task lock is not held while
  // runStageEntryPostCommitV1 runs". `withTaskLock` (`state/taskStateStore.ts`)
  // serializes same-tasksRoot callers through an in-process promise chain
  // (`withLocalMutationQueue`) before ever touching the on-disk lease: a
  // SECOND `withTaskLock` call issued for the same task folder while the
  // FIRST call's own `operation()` is still executing can never resolve —
  // it queues behind the first call's own release, which can only fire once
  // that first call returns. So if `enterStageV1` mistakenly still held its
  // lock while `runStageEntryPostCommitV1` (or a concurrent caller) ran, a
  // concurrent `withTaskLock` acquisition issued at that moment would hang
  // forever rather than fail fast. Racing it against a bounded timeout turns
  // that hang into a deterministic, non-hanging test failure instead of
  // making the suite itself hang.
  void it(
    "the task lock is not held while runStageEntryPostCommitV1 runs",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const proposal: ChecklistChangeProposalV1 = {
          at: "2026-09-20T00:00:00.000Z",
          roundId: "round-1",
          stage: "impl",
          kind: "added",
          proposedItems: ["Add a new step"],
          removedItems: [],
          status: "revising",
        };
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "plan-low-review",
          checklistChangeProposals: [proposal],
          planRevision: {
            proposalAt: proposal.at,
            startedAt: "2026-09-20T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        });
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n", "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");
        assert.equal(result.ready, true);

        let concurrentAcquired = false;
        const concurrentProbe = withTaskLock(folderPath, () => {
          concurrentAcquired = true;
          return Promise.resolve();
        });
        const postCommit = runStageEntryPostCommitV1(folderUri, result);
        const both = Promise.all([concurrentProbe, postCommit]).then(() => "done" as const);
        const timedOut = new Promise<"timedOut">((resolve) => {
          const timer = setTimeout(() => resolve("timedOut"), 5000);
          timer.unref?.();
        });

        const outcome = await Promise.race([both, timedOut]);

        assert.equal(
          outcome,
          "done",
          "a concurrent withTaskLock acquisition never resolved — enterStageV1's lock is still held " +
            "while runStageEntryPostCommitV1 runs"
        );
        assert.equal(concurrentAcquired, true);
        assert.equal(readProgress(folderPath).checklistChangeProposals?.[0]?.status, "adopted");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  // Part 1, in-process failure recovery: `publish` lands bytes at
  // plan-final.md as `advanceStage`'s `beforeWrite`, still inside the task
  // lock; if the strict progress write that follows fails anyway (e.g. an
  // I/O error), `enterStageV1` must undo the just-published artifact rather
  // than leave entry work committed with no stage move.
  // `writeTaskProgressV1`/`patchTaskProgressStrictV1` persist via
  // `writeAtomic` (`src/state/writeAtomic.ts`), which writes a temp file with
  // real `fs.promises.writeFile` and lands it with `fs.promises.rename` —
  // NEITHER goes through the `vscode.workspace.fs` bridge these tests
  // otherwise use, so the progress write's own failure must be simulated by
  // patching `fs.promises.rename` directly (the step that runs after
  // `publish` has already landed bytes at plan-final.md via the bridge).
  function installProgressRenameFailureV1(): { restore: () => void } {
    const original = fs.promises.rename;
    (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = ((
      source: fs.PathLike,
      dest: fs.PathLike
    ) => {
      if (String(dest).endsWith("task-progress.json")) {
        return Promise.reject(new Error("simulated disk failure renaming task-progress.json"));
      }
      return original(source, dest);
    }) as typeof fs.promises.rename;
    return {
      restore: (): void => {
        (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = original;
      },
    };
  }

  void it(
    "deletes a freshly-seeded plan-final.md when the progress write fails after publish (first seed)",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const renameFailure = installProgressRenameFailureV1();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.ok(result.ready === false && /simulated disk failure/.test(result.reason));
        assert.equal(
          fs.existsSync(path.join(folderPath, "plan-final.md")),
          false,
          "a first-seed publish must be undone when the stage move fails"
        );
        assert.equal(readProgress(folderPath).currentStage, "plan-low-review", "stage must not have moved");
      } finally {
        renameFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it(
    "restores plan-final.md's prior bytes when the progress write fails after a revision re-finalization publish",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const renameFailure = installProgressRenameFailureV1();
      try {
        const proposal: ChecklistChangeProposalV1 = {
          at: "2026-09-20T00:00:00.000Z",
          roundId: "round-1",
          stage: "impl",
          kind: "added",
          proposedItems: ["Add a new step"],
          removedItems: [],
          status: "revising",
        };
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "plan-low-review",
          checklistChangeProposals: [proposal],
          planRevision: {
            proposalAt: proposal.at,
            startedAt: "2026-09-20T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        });
        const priorFinal = "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n";
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), priorFinal, "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.equal(
          fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"),
          priorFinal,
          "the pre-publish bytes must be restored when the stage move fails"
        );
        assert.equal(readProgress(folderPath).currentStage, "plan-low-review", "stage must not have moved");
      } finally {
        renameFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  /**
   * `writeAtomic` (`src/state/writeAtomic.ts`) re-reads and validates the
   * target file AFTER its rename has already landed (`durableTargetUnchanged:
   * false` on that specific failure path) — using raw `fs.promises.readFile`
   * with an explicit `"utf8"` encoding, distinct from the Buffer-returning,
   * no-encoding `fs.promises.readFile(uri.fsPath)` the vscode-fs bridge above
   * uses for every other read in this test file. Failing only that call lets
   * this test simulate "the rename durably landed, but writeAtomic still
   * rejected" without disturbing any other read.
   */
  function installPostRenameValidationFailureV1(): { restore: () => void } {
    const original = fs.promises.readFile;
    (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = ((
      filePath: fs.PathLike,
      options?: unknown
    ) => {
      if (typeof filePath === "string" && filePath.endsWith("plan-final.md") && options === "utf8") {
        return Promise.reject(new Error("simulated post-rename readback validation failure"));
      }
      return (original as (...args: unknown[]) => unknown)(filePath, options);
    }) as typeof fs.promises.readFile;
    return {
      restore: (): void => {
        (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = original;
      },
    };
  }

  // Review fix (2026-09-23, architectural blocker): `writeAtomic` can THROW
  // after its rename has already replaced plan-final.md on disk
  // (`durableTargetUnchanged: false`, from its own post-rename readback
  // validation) — a real, durably-landed write followed by a rejection, not a
  // "nothing happened" failure. `publish()`'s promise therefore REJECTS
  // rather than resolving. The bug this pins: `published` used to be derived
  // from a local flag copied across only AFTER `await publish(...)` returned,
  // so this exact rejection skipped that assignment and the byte-guarded
  // rollback in `onCommitFailure` never ran — the durably-written artifact was
  // left on disk with its journal deleted and no record it was ever
  // provisional. `published` is now set the moment `onBeforeWrite` fires
  // (before the write it precedes), so this failure mode must still roll the
  // artifact back exactly like every other publish failure.
  void it(
    "rolls back a first-seed plan-final.md when writeAtomic rejects AFTER its rename already landed the bytes",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const validationFailure = installPostRenameValidationFailureV1();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.ok(
          result.ready === false && /simulated post-rename readback validation failure/.test(result.reason)
        );
        assert.equal(
          fs.existsSync(path.join(folderPath, "plan-final.md")),
          false,
          "the durably-renamed first-seed artifact must be rolled back even though writeAtomic rejected AFTER the rename"
        );
        assert.equal(readProgress(folderPath).currentStage, "plan-low-review", "stage must not have moved");
        assert.equal(
          fs.existsSync(path.join(folderPath, "stage-entry-journal.json")),
          false,
          "the journal must still be cleaned up after this failure mode"
        );
      } finally {
        validationFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it(
    "restores plan-final.md's prior bytes when writeAtomic rejects AFTER its rename already landed a revision re-finalization",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const validationFailure = installPostRenameValidationFailureV1();
      try {
        const proposal: ChecklistChangeProposalV1 = {
          at: "2026-09-20T00:00:00.000Z",
          roundId: "round-1",
          stage: "impl",
          kind: "added",
          proposedItems: ["Add a new step"],
          removedItems: [],
          status: "revising",
        };
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "plan-low-review",
          checklistChangeProposals: [proposal],
          planRevision: {
            proposalAt: proposal.at,
            startedAt: "2026-09-20T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        });
        const priorFinal = "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n";
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), priorFinal, "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.equal(
          fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"),
          priorFinal,
          "the pre-publish bytes must be restored even though writeAtomic rejected AFTER the rename"
        );
        assert.equal(readProgress(folderPath).currentStage, "plan-low-review", "stage must not have moved");
      } finally {
        validationFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  /**
   * Intercepts the FIRST real read of `planFinalPath` and, as a side effect
   * of that read, lands `newContent` on disk before returning — simulating a
   * legitimate writer's content landing between an early observation of
   * `plan-final.md` (this transition's own artifact-resolution check) and
   * whatever this transition's `publish()` actually overwrites.
   */
  function installConcurrentWriterAheadOfPromotionV1(
    planFinalPath: string,
    newContent: string
  ): { restore: () => void } {
    const original = fs.promises.readFile;
    let intercepted = false;
    (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = (async (
      filePath: fs.PathLike,
      options?: unknown
    ) => {
      if (!intercepted && typeof filePath === "string" && filePath === planFinalPath) {
        intercepted = true;
        const result = await (original as (...args: unknown[]) => unknown)(filePath, options);
        fs.writeFileSync(planFinalPath, newContent, "utf8");
        return result;
      }
      return (original as (...args: unknown[]) => unknown)(filePath, options);
    }) as typeof fs.promises.readFile;
    return {
      restore: (): void => {
        (fs.promises as unknown as { readFile: typeof fs.promises.readFile }).readFile = original;
      },
    };
  }

  // Review fix (2026-09-23, completion blocker, third narrowing): pins the
  // race this round's fix closes. `priorArtifact` used to be hashed by
  // reading `plan-final.md` before `publish()` was even called — a snapshot
  // that a legitimate writer landing shortly afterward (but still before
  // `publish()`'s own per-uri lock is acquired) could invalidate, leaving the
  // journal holding proof against bytes that were never actually on disk when
  // this transition's write replaced them. Here, a writer lands `concurrent`
  // content immediately after this transition's own artifact-resolution check
  // first observes the original `priorFinal` bytes — before `publish()` (and
  // its lock) ever runs. A subsequent progress-write failure must roll back
  // to `concurrent` (what this transition's write actually replaced), never to
  // `priorFinal` (the stale value seen before the concurrent writer landed).
  void it(
    "rolls back to the bytes actually replaced, not a stale pre-publish snapshot, when a writer lands ahead of publish()",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const renameFailure = installProgressRenameFailureV1();
      let concurrentWriter: { restore: () => void } | undefined;
      try {
        const proposal: ChecklistChangeProposalV1 = {
          at: "2026-09-20T00:00:00.000Z",
          roundId: "round-1",
          stage: "impl",
          kind: "added",
          proposedItems: ["Add a new step"],
          removedItems: [],
          status: "revising",
        };
        const { folderPath, folderUri } = makeTaskFolder({
          currentStage: "plan-low-review",
          checklistChangeProposals: [proposal],
          planRevision: {
            proposalAt: proposal.at,
            startedAt: "2026-09-20T00:01:00.000Z",
            stage: "impl",
            discardedItems: [],
            removedItems: [],
            reason: "discovered work",
          },
        });
        const planFinalPath = path.join(folderPath, "plan-final.md");
        const priorFinal = "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n";
        const concurrent = "<!-- ensemble:implementation-checklist -->\n\n- [x] Old\n- [x] Landed concurrently\n";
        fs.writeFileSync(planFinalPath, priorFinal, "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");
        concurrentWriter = installConcurrentWriterAheadOfPromotionV1(planFinalPath, concurrent);

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.equal(
          fs.readFileSync(planFinalPath, "utf8"),
          concurrent,
          "rollback must restore the bytes this transition's write actually replaced, not an earlier snapshot"
        );
        assert.equal(readProgress(folderPath).currentStage, "plan-low-review", "stage must not have moved");
      } finally {
        concurrentWriter?.restore();
        renameFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  // Part 2 (item 15 hardening): `enterStageV1`'s `publishArtifact` closure now
  // begins a stage-entry journal before calling `publish()` and advances it
  // through "publishing" -> "published" as the write actually lands. This
  // pins the write-side of that wiring (still best-effort, no recovery call
  // site wired yet — see `stageEntryJournalV1.ts`'s module doc comment): the
  // journal is on disk in `"published"` phase once the transition has
  // committed but before `runStageEntryPostCommitV1` (Phase C) has run, and
  // is gone once it has.
  void it(
    "writes a 'published' stage-entry journal on a successful promotion, then deletes it once runStageEntryPostCommitV1 (Phase C) runs",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, true);
        const journalPath = path.join(folderPath, "stage-entry-journal.json");
        assert.ok(fs.existsSync(journalPath), "journal must exist right after commit, before Phase C runs");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          phase: string;
          from: string;
          to: string;
          expectedSha256?: string;
        };
        assert.equal(journal.phase, "published");
        assert.equal(journal.from, "plan-low-review");
        assert.equal(journal.to, "impl");
        assert.equal(typeof journal.expectedSha256, "string");
        assert.ok(result.ready && typeof result.journalTransitionId === "string");

        await runStageEntryPostCommitV1(folderUri, result);

        assert.equal(fs.existsSync(journalPath), false, "Phase C must delete the journal once post-commit work runs");
        // The artifact itself must be unaffected by the journal's own cleanup.
        assert.match(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), /Do the thing/);
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  // A transition that finds the artifact already canonical never begins a
  // journal at all (Step 1A: "Skip journal writing for transitions with no
  // publish") — there is nothing to journal.
  void it("writes no stage-entry journal when the artifact is already canonical (no publish closure)", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), SIMPLE_PLAN, "utf8");

      const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

      assert.equal(result.ready, true);
      assert.ok(result.ready && result.journalTransitionId === undefined);
      assert.equal(fs.existsSync(path.join(folderPath, "stage-entry-journal.json")), false);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Part 2 (item 15 hardening): a failed transition must not leave a
  // dangling journal behind for a future recovery call site to trip over —
  // `enterStageV1`'s own failure path cleans it up, the same as the
  // already-tested in-process artifact rollback above.
  void it(
    "cleans up the stage-entry journal (does not leave it behind) when the progress write fails after publish",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      const renameFailure = installProgressRenameFailureV1();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");

        assert.equal(result.ready, false);
        assert.equal(
          fs.existsSync(path.join(folderPath, "stage-entry-journal.json")),
          false,
          "a failed transition must not leave its journal behind"
        );
      } finally {
        renameFailure.restore();
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  // Review fix (2026-09-23, architectural blocker): a stale, un-recovered
  // journal from a PRIOR (different) transition already on disk used to be
  // silently skipped — `beginStageEntryJournalV1`'s collision was caught and
  // the real publish proceeded anyway with no journal at all, exactly the
  // "fails open" shape the commit protocol forbids. `enterStageV1`'s outer
  // wrapper must instead recover the stale journal (Phase A) and retry the
  // WHOLE transition once, succeeding transparently to the caller.
  void it(
    "fails closed on a stale journal from a prior transition: recovers it (Phase A) and retries once, succeeding",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

        // Simulate a crash from an unrelated, EARLIER transition that never
        // reached a write (`phase: "intent"`) and was never cleaned up — the
        // exact shape `rollbackJournaledArtifactV1`'s "intent" branch exists
        // for: nothing to undo, just an orphaned journal file blocking the
        // next transition's `beginStageEntryJournalV1` call.
        const stalePath = path.join(folderPath, "stage-entry-journal.json");
        fs.writeFileSync(
          stalePath,
          // `to` is deliberately NOT the task's current stage ("plan-low-review")
          // — `recoverStageEntryJournalV1`'s Phase A treats `currentStage ===
          // journal.to` as proof the journal's transition already committed,
          // and (correctly) leaves a "committed" journal in place rather than
          // rolling it back, since Phase C (its own cleanup) is not this
          // journal's business. This journal must read as genuinely
          // un-committed so Phase A actually rolls it back and deletes it.
          JSON.stringify({
            transitionId: "stale-prior-transition",
            from: "desc",
            to: "plan-high-review",
            startedAt: "2020-01-01T00:00:00.000Z",
            artifact: "plan-final.md",
            priorArtifact: "absent",
            phase: "intent",
          }),
          "utf8"
        );

        const result = await enterStageV1(folderUri, "plan-low-review", "impl", false, "generate-implementation");
        assert.equal(result.ready, true, "must recover the stale journal and retry, not refuse or fail open");
        assert.equal(readProgress(folderPath).currentStage, "impl");
        assert.match(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), /Do the thing/);
        // The stale journal is gone (recovered) and THIS transition's own
        // journal (published, awaiting Phase C) is on disk in its place —
        // never the original stale one, and never silently absent.
        assert.ok(fs.existsSync(stalePath), "this transition's own journal must exist, awaiting Phase C");
        const journal = JSON.parse(fs.readFileSync(stalePath, "utf8")) as { transitionId: string; phase: string };
        assert.notEqual(journal.transitionId, "stale-prior-transition");
        assert.equal(journal.phase, "published");

        if (result.ready) {
          await runStageEntryPostCommitV1(folderUri, result);
        }
        assert.equal(fs.existsSync(stalePath), false, "Phase C must delete this transition's own journal too");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );
});

void describe("prepareStageEntryV1 proactive recovery (Part 2, item 15 hardening)", () => {
  void it(
    "recovers a stale un-committed journal before trusting plan-final.md, instead of treating an " +
      "orphaned first-seed left by a crash as already canonical",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        // Simulate a crash: a prior "impl" transition wrote a first-seed
        // plan-final.md and journaled it as "published", but the stage move
        // never committed (currentStage is still "plan-low-review", never
        // reached "impl") and nothing has recovered it since.
        const orphanedBytes = "orphaned first-seed content\n";
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), orphanedBytes, "utf8");
        const journalPath = path.join(folderPath, "stage-entry-journal.json");
        fs.writeFileSync(
          journalPath,
          JSON.stringify({
            transitionId: "stale-crash-transition",
            from: "plan-low-review",
            to: "impl",
            startedAt: "2020-01-01T00:00:00.000Z",
            artifact: "plan-final.md",
            priorArtifact: "absent",
            phase: "published",
            expectedSha256: sha256HexV1(new TextEncoder().encode(orphanedBytes)),
          }),
          "utf8"
        );

        // Without proactive recovery, `resolveImplementationArtifact` would
        // see plan-final.md present and report `{ ready: true }` — trusting
        // bytes a crashed transition never actually committed the stage
        // move for. This is the "reopen" shape (`requireExistingArtifact`)
        // precisely because that branch never calls `preparePlanPromotion`
        // at all, so it could not otherwise ever observe the journal.
        const promotion = await prepareStageEntryV1(folderUri, "impl", { requireExistingArtifact: true });
        assert.equal(promotion.ready, false, "must not trust the orphaned first-seed as canonical");
        assert.equal(
          fs.existsSync(path.join(folderPath, "plan-final.md")),
          false,
          "the orphaned first-seed must be rolled back (deleted) by proactive recovery"
        );
        assert.equal(fs.existsSync(journalPath), false, "the recovered journal must be deleted");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it(
    "recovers a stale journal even when the destination stage is NOT impl (review fix, 2026-09-23, " +
      "completion blocker: a journal from a prior impl entry must not survive un-recovered into a " +
      "later, unrelated transition, where a stale currentStage-vs-journal.to mismatch could misread a " +
      "transition that actually committed as one that never did, and roll back plan-final.md)",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl" });
        // Simulate a crash immediately after an "impl" entry's progress write
        // committed but before Phase C deleted the journal: currentStage is
        // "impl" (matches journal.to), so Phase A would find it "committed"
        // and clean up correctly — the point of this test is that recovery
        // actually RUNS here at all, for a transition whose destination is a
        // later stage ("impl-high-review"), not that Phase A's own decision
        // logic is exercised differently.
        const publishedBytes = "committed plan-final.md content\n";
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), publishedBytes, "utf8");
        const journalPath = path.join(folderPath, "stage-entry-journal.json");
        fs.writeFileSync(
          journalPath,
          JSON.stringify({
            transitionId: "stale-committed-transition",
            from: "plan-low-review",
            to: "impl",
            startedAt: "2020-01-01T00:00:00.000Z",
            artifact: "plan-final.md",
            priorArtifact: "absent",
            phase: "published",
            expectedSha256: sha256HexV1(new TextEncoder().encode(publishedBytes)),
          }),
          "utf8"
        );

        const result = await prepareStageEntryV1(folderUri, "impl-high-review");
        assert.deepEqual(result, { ready: true }, "a non-impl destination still has nothing to prepare");
        assert.equal(
          fs.existsSync(journalPath),
          false,
          "the stale journal must be recovered (and cleaned up) even though this transition's own " +
            "destination is not impl"
        );
        assert.equal(
          fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"),
          publishedBytes,
          "a journal Phase A finds already committed must leave the canonical artifact untouched"
        );
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it(
    "skipProactiveRecovery never acquires withTaskLock, even when a stale journal is present " +
      "(the Reopen row's callerHoldsCoveringLock escape hatch — proves no self-deadlock risk)",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        fs.writeFileSync(
          path.join(folderPath, "stage-entry-journal.json"),
          JSON.stringify({
            transitionId: "stale-crash-transition",
            from: "plan-low-review",
            to: "impl",
            startedAt: "2020-01-01T00:00:00.000Z",
            artifact: "plan-final.md",
            priorArtifact: "absent",
            phase: "intent",
          }),
          "utf8"
        );

        // Hold withTaskLock open for the whole call below. If
        // `skipProactiveRecovery` failed to skip the recovery call,
        // `recoverStageEntryJournalV1` would try to acquire this SAME lock
        // and hang for as long as it is held — exactly the self-deadlock
        // shape `callerHoldsCoveringLock` exists to prevent (the real
        // production hazard uses `withMetaRootLock`, which shares the same
        // per-tasksRoot local queue; `withTaskLock` alone is enough to prove
        // "did this call try to take a covering lock at all").
        let releaseOuterLock: (() => void) | undefined;
        const outerLockHeld = new Promise<void>((resolve) => {
          releaseOuterLock = resolve;
        });
        const outerLockPromise = withTaskLock(folderPath, () => outerLockHeld);
        try {
          const raced = await Promise.race([
            prepareStageEntryV1(folderUri, "impl", {
              requireExistingArtifact: true,
              skipProactiveRecovery: true,
            }).then(() => "resolved" as const),
            new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
          ]);
          assert.equal(
            raced,
            "resolved",
            "skipProactiveRecovery must never attempt to acquire withTaskLock, so this must resolve promptly " +
              "even while an external withTaskLock hold on the same task is still open"
          );
        } finally {
          releaseOuterLock?.();
          await outerLockPromise;
        }
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );
});

void describe("materializeCanonicalIfNeeded proactive recovery (Part 2, item 15 hardening)", () => {
  void it(
    "recovers a stale un-committed journal before deciding whether plan-final.md is already canonical",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
        const orphanedBytes = "orphaned first-seed content\n";
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), orphanedBytes, "utf8");
        const journalPath = path.join(folderPath, "stage-entry-journal.json");
        fs.writeFileSync(
          journalPath,
          JSON.stringify({
            transitionId: "stale-crash-transition",
            from: "plan-low-review",
            to: "impl",
            startedAt: "2020-01-01T00:00:00.000Z",
            artifact: "plan-final.md",
            priorArtifact: "absent",
            phase: "published",
            expectedSha256: sha256HexV1(new TextEncoder().encode(orphanedBytes)),
          }),
          "utf8"
        );
        // No legacy implementation.md either, so if recovery correctly
        // deletes the orphaned first seed, materializing throws (nothing left
        // to materialize from) instead of returning the untrustworthy file.
        await assert.rejects(() => materializeCanonicalIfNeeded(folderUri));
        assert.equal(
          fs.existsSync(path.join(folderPath, "plan-final.md")),
          false,
          "the orphaned first-seed must be rolled back before this function decides anything"
        );
        assert.equal(fs.existsSync(journalPath), false, "the recovered journal must be deleted");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );
});

void describe("advanceStageLocked runtime backstop (Part 1, item 24)", () => {
  void it("refuses a forward transition into impl with no publishArtifact and no implementation artifact present", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      const before = readProgress(folderPath);

      await assert.rejects(
        () => advanceStage(folderUri, "plan-low-review", "impl", false, "jump"),
        /Refusing to enter Implementation/
      );
      assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("allows a forward transition into impl when an implementation artifact already exists", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), SIMPLE_PLAN, "utf8");

      const result = await advanceStage(folderUri, "plan-low-review", "impl", false, "jump");

      assert.ok(result?.persisted);
      assert.equal(readProgress(folderPath).currentStage, "impl");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-22, completion blocker): the backstop used to gate
  // on STAGE_ORDER direction, so a backward jump into "impl" (e.g. a Reopen
  // or Set Task Stage selecting "impl" from "publish") with no artifact and
  // no entry work silently produced an unusable stage. It must now refuse
  // backward entry exactly like forward entry.
  void it("refuses a backward jump into impl with no publishArtifact and no implementation artifact present", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "publish" });
      const before = readProgress(folderPath);

      await assert.rejects(
        () => advanceStage(folderUri, "publish", "impl", false, "jump"),
        /Refusing to enter Implementation/
      );
      assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("allows a backward jump into impl when an implementation artifact already exists", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "publish" });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), SIMPLE_PLAN, "utf8");

      const result = await advanceStage(folderUri, "publish", "impl", false, "jump");

      assert.ok(result?.persisted, "a backward jump with an existing artifact must not be refused");
      assert.equal(readProgress(folderPath).currentStage, "impl");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("does not apply the backstop to a same-stage re-entry (impl -> impl)", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl" });

      const result = await advanceStage(folderUri, "impl", "impl", false, "jump");

      assert.ok(result?.persisted, "a same-stage re-entry never needs fresh entry work");
      assert.equal(readProgress(folderPath).currentStage, "impl");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("allows a forward transition into impl when the caller supplies its own publishArtifact", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder({ currentStage: "plan-low-review" });
      let published = false;

      const result = await advanceStage(
        folderUri,
        "plan-low-review",
        "impl",
        false,
        "jump",
        true,
        undefined,
        () => {
          published = true;
          return Promise.resolve();
        }
      );

      assert.ok(result?.persisted);
      assert.ok(published, "the caller's own publishArtifact must still run");
      assert.equal(readProgress(folderPath).currentStage, "impl");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-22, completion blocker): the old same-stage
  // early-return branch called `publishArtifact()` directly and unlocked
  // whenever `expectedReviewAttemptId` was omitted, with no compare-and-set
  // and no way for a caller-supplied `precondition` to stop it. A same-stage
  // transition must now run `publishArtifact` only inside the same locked
  // CAS as every other transition, so a failed precondition prevents it from
  // running at all.
  void it(
    "refuses a same-stage transition's precondition and never runs publishArtifact outside (or ahead of) the lock",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl" });
        const before = readProgress(folderPath);
        let published = false;

        await assert.rejects(
          () =>
            advanceStage(
              folderUri,
              "impl",
              "impl",
              false,
              "jump",
              true,
              undefined,
              () => {
                published = true;
                return Promise.resolve();
              },
              undefined,
              () => "refused before publish"
            ),
          /refused before publish/
        );

        assert.equal(published, false, "publishArtifact must not run when the precondition refuses");
        assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it(
    "runs a same-stage transition's publishArtifact inside the lock once the precondition passes",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder({ currentStage: "impl" });
        let published = false;

        const result = await advanceStage(
          folderUri,
          "impl",
          "impl",
          false,
          "jump",
          true,
          undefined,
          () => {
            published = true;
            return Promise.resolve();
          },
          undefined,
          () => true
        );

        assert.ok(result?.persisted);
        assert.ok(published, "publishArtifact must run once the precondition passes");
        assert.equal(readProgress(folderPath).currentStage, "impl");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );
});
