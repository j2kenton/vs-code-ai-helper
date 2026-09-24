/**
 * Regression coverage for routing `setTaskStage` (src/commands/setTaskStage.ts)
 * through the Part 1 stage-entry primitive `enterStageV1`
 * (pre-1.0.0 fixes register, "Part 1 — Stage-entry primitive (item 15)").
 *
 * Before this reroute, `setTaskStage` called `advanceStage` directly with no
 * `publishArtifact`, so a manual jump onto "impl" relied entirely on
 * `advanceStageLocked`'s runtime backstop: it refused unless an
 * implementation artifact already existed on disk, even when `plan.md`
 * existed and could have been promoted. Routing through `enterStageV1`
 * resolves the destination's entry work (promoting plan.md -> plan-final.md)
 * atomically with the stage move, so this command can now actually complete
 * the transition instead of only ever refusing or requiring the artifact to
 * already be in place.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { setTaskStage } from "../commands/setTaskStage";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { taskOperations, type CancelRunningOperationsResultV1 } from "../utils/taskOperations";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import type { TaskProgress, TaskStage } from "../types/taskProgress";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-set-stage-enter-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-set-stage-enter-private-"));
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

function makeTaskFolder(currentStage: TaskStage): { folderPath: string } {
  counter += 1;
  const name = `set-stage-enter-${counter}`;
  const folderPath = path.join(REAL_ROOT, "tasks", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(folderPath),
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folderPath };
}

function readProgress(folderPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
}

function makeInventoryStub(taskFolderPath: string, currentStage: TaskStage): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const folderName = path.basename(taskFolderPath);
  const task = {
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName,
    sourceScopeKey: taskFolderPath,
    progress: {
      taskFolder: folderName,
      currentStage,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(taskFolderPath),
    },
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[taskFolderPath, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === taskFolderPath ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === taskFolderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function makeCurrentTaskStoreStub(): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => undefined;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

const SIMPLE_PLAN = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Do the thing", ""].join("\n");

void describe("setTaskStage routed through enterStageV1 (Part 1, item 15 reroute)", () => {
  void it("jumping onto impl promotes plan.md -> plan-final.md instead of only ever refusing", async () => {
    const { folderPath } = makeTaskFolder("plan-low-review");
    fs.writeFileSync(path.join(folderPath, "plan.md"), SIMPLE_PLAN, "utf8");

    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const inv = makeInventoryStub(folderPath, "plan-low-review");
    const currentStore = makeCurrentTaskStoreStub();
    try {
      await setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "impl" }, "jump");

      assert.equal(readProgress(folderPath).currentStage, "impl");
      assert.match(fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8"), /Do the thing/);
    } finally {
      provider.dispose();
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("jumping onto impl with no plan.md is refused and leaves the stage unchanged", async () => {
    const { folderPath } = makeTaskFolder("plan-low-review");

    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const inv = makeInventoryStub(folderPath, "plan-low-review");
    const currentStore = makeCurrentTaskStoreStub();
    const before = readProgress(folderPath);
    try {
      await setTaskStage(inv, currentStore, { taskFolderPath: folderPath, stage: "impl" }, "jump");

      assert.deepEqual(readProgress(folderPath), before, "no field may change on refusal");
      assert.equal(fs.existsSync(path.join(folderPath, "plan-final.md")), false);
      const warning = provider
        .getEntries()
        .find((entry) => /Could not set stage/.test(entry.message ?? ""));
      assert.ok(warning, "a refusal warning should be posted");
      assert.match(warning?.message ?? "", /there is no plan to promote/);
    } finally {
      provider.dispose();
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-23, narrowed completion blocker
  // 906d1f21-e807-48d3-9468-62856cdc7e7a-0, revised after a follow-up review
  // found an earlier attempt architecturally unsafe): a still-earlier version
  // of this test pinned cancellation firing from INSIDE `enterStageV1`'s
  // locked `beforeWrite`, strictly before the write landed — but that means
  // an irreversible cancellation (it may stop, or force-end, genuinely
  // unrelated running work) would fire even if the write then failed and the
  // stage never actually changed. `setTaskStage` now requests cancellation
  // only via the post-commit `cancelRunningOperationsForTask` call, which
  // runs immediately once `enterStageV1` has confirmed the write landed —
  // this proves that ordering directly, by reading task-progress.json from
  // inside the cancellation-token listener itself and asserting it already
  // shows the NEW stage at that instant.
  void it("requests cancellation of the outgoing stage's operation only after the new stage is committed to disk", async () => {
    const { folderPath } = makeTaskFolder("plan-low-review");

    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const inv = makeInventoryStub(folderPath, "plan-low-review");
    const currentStore = makeCurrentTaskStoreStub();

    const handle = taskOperations.begin(folderPath, {
      label: "Fake outgoing-stage round",
      stage: "plan-low-review",
      cancellable: true,
      exclusive: true,
    });
    assert.ok(handle, "the fake operation must be admitted");
    assert.ok(handle.token, "the fake operation must be cancellable");

    let stageAtCancellationTime: TaskStage | undefined;
    let cancellationObserved = false;
    const subscription = handle.token.onCancellationRequested(() => {
      cancellationObserved = true;
      stageAtCancellationTime = readProgress(folderPath).currentStage;
      // Simulate the operation actually noticing the token and stopping
      // immediately, so the post-commit confirm/poll below does not have to
      // wait out its real timeout in this test.
      taskOperations.end(handle, "cancelled");
    });

    try {
      const moved = await setTaskStage(
        inv,
        currentStore,
        { taskFolderPath: folderPath, stage: "plan-high-review" },
        "jump"
      );

      assert.equal(moved, true);
      assert.equal(cancellationObserved, true, "the outgoing operation must have been asked to stop");
      assert.equal(
        stageAtCancellationTime,
        "plan-high-review",
        "cancellation must be requested only once the new stage is durably committed, never before " +
          "(an earlier commit-then-fail could otherwise cancel unrelated running work for a transition " +
          "that never actually happened)"
      );
      assert.equal(readProgress(folderPath).currentStage, "plan-high-review");
    } finally {
      subscription.dispose();
      provider.dispose();
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // Review fix (2026-09-23, closing the missing-evidence half of narrowed
  // completion blocker 906d1f21-e807-48d3-9468-62856cdc7e7a-0): the test
  // above proves cancellation is requested only after commit, but it ends the
  // fake operation the instant it observes the token — it never exercises the
  // OTHER branch `cancelRunningOperationsForTask` has to take when the
  // outgoing operation ignores cancellation altogether: a real
  // `forceEndSubtreeV1` force-end. The `resumeAndSetTaskStageV1`-level test in
  // commandArgNormalization.test.ts ("does not dispatch further automated
  // work when the deposited cancelResult reports an unsafe...") only ever
  // INJECTS a fake `{ forcedEnd: true }` result through a stubbed
  // `setTaskStage`; it never drives a real forced removal either. This test
  // drives the real path end to end, then pins the exact, honest boundary of
  // what this narrowed fix protects: the stage commits, the forced end is
  // reported as unsafe, and the user is warned — but a write arriving from the
  // force-ended operation's body (which may still be running — that is
  // precisely what `forcedEnd: true` means) is NOT rejected today. Full
  // write-prevention needs the Part 6 stale-writer fence
  // (`revokeWorkAdmissionClaimV1`), which this task's own explicit part
  // ordering has not built yet. This last assertion is expected to flip (the
  // late write becoming a refusal) once Part 6 lands.
  void it(
    "a real force-ended (ignored-cancellation) outgoing operation still lets the stage commit and reports an " +
      "unsafe cancelResult, but does not yet reject a late write from it",
    async () => {
      const { folderPath } = makeTaskFolder("plan-low-review");

      const fsBridge = installFsBridge();
      const wsStub = installWorkspaceFoldersStub();
      const provider = new StatusTreeProvider();
      initNotificationRouter(provider);
      const inv = makeInventoryStub(folderPath, "plan-low-review");
      const currentStore = makeCurrentTaskStoreStub();

      const handle = taskOperations.begin(folderPath, {
        label: "Fake stuck outgoing-stage round",
        stage: "plan-low-review",
        cancellable: true,
        exclusive: true,
      });
      assert.ok(handle, "the fake operation must be admitted");

      const realDateNow = Date.now;
      const baseTime = realDateNow();
      let mockedNow = baseTime;
      Date.now = (): number => mockedNow;

      try {
        // Simulate an EARLIER, unrelated Stop click that the operation
        // ignored — exactly the precondition `cancelOperation`'s own comment
        // names for a force-end to fire on the operation's NEXT
        // `cancelOperation` call.
        const firstRequestOk = taskOperations.cancelOperation(handle.id);
        assert.equal(firstRequestOk, true, "the first Stop click only requests cancellation");
        assert.equal(
          taskOperations.getLocalTaskOperations(folderPath).length,
          1,
          "the operation must still be registered after only being asked to stop"
        );

        // Over a minute passes with the operation never noticing its token.
        mockedNow = baseTime + 61_000;

        const cancelResultOutV1: { current?: CancelRunningOperationsResultV1 } = {};
        const moved = await setTaskStage(
          inv,
          currentStore,
          { taskFolderPath: folderPath, stage: "plan-high-review", cancelResultOutV1 },
          "jump"
        );

        assert.equal(moved, true, "the transition must commit even though cancellation cannot be confirmed");
        assert.equal(readProgress(folderPath).currentStage, "plan-high-review");
        assert.equal(
          taskOperations.getLocalTaskOperations(folderPath).length,
          0,
          "the ignored operation's row must be force-removed"
        );
        assert.equal(cancelResultOutV1.current?.ok, false, "a forced end must never report as a safe stop");
        assert.equal(cancelResultOutV1.current?.forcedEnd, true);
        assert.match(cancelResultOutV1.current?.reason ?? "", /force-removed/);

        const warning = provider
          .getEntries()
          .find((entry) => /could not be stopped/.test(entry.message ?? ""));
        assert.ok(warning, "the user must be warned that the outgoing operation could not be confirmed stopped");

        // The still-open half of the blocker: nothing here rejects a write
        // arriving from the force-ended operation's body. This is NOT the
        // desired end state — it is the documented, narrowed scope of what
        // this fix protects today: only NEW automated dispatch is gated on
        // `cancelResult.ok` (proved separately in
        // commandArgNormalization.test.ts); the write path itself stays
        // unguarded until the Part 6 stale-writer fence exists.
        const taskFolderUri = vscode.Uri.file(folderPath);
        const lateWriteResult = await patchTaskProgressStrictV1(taskFolderUri, (current) => ({
          ...current,
          currentStage: "plan-low-review",
        }));
        assert.ok(lateWriteResult, "a late write from the force-ended operation is not rejected today");
        assert.equal(
          readProgress(folderPath).currentStage,
          "plan-low-review",
          "documents the still-open gap: nothing yet stops a late writer from reverting the committed stage — " +
            "closing this needs the Part 6 stale-writer fence, which this task builds later, in order"
        );
      } finally {
        Date.now = realDateNow;
        provider.dispose();
        deactivateNotificationRouter();
        wsStub.restore();
        fsBridge.restore();
      }
    }
  );
});
