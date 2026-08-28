/**
 * Unit tests for the `reconcilePlanChecklist` command.
 *
 * This command is the ONLY way out of the `checklistProgressUnreliable` latch.
 * The latch is deliberately one-way in the automatic direction — no round can
 * clear it, because no round knows what an unrecorded round did — so if this
 * command is broken, a latched task has no recovery path at all and the
 * completeness gate stays down for the rest of that task's life. The utils
 * beneath it are covered by implementationSummaryArtifact.test.ts; the command
 * body (argument shapes, the refusals, and the two race windows around the
 * modal) had no coverage until this file.
 *
 * Covered here:
 *   1. Argument normalization — including the synthetic dispatcher shape
 *      `{ canonicalId, taskFolderPath, task: { progress } }` that carries a
 *      `task` with no `folderUri`. Reading `arg.task.folderUri.fsPath`
 *      unguarded on that shape is the live `Ctrl+Shift+Alt+I` TypeError; this
 *      command's normalizer is written not to, and this pins it.
 *   2. Refusals that must NOT clear the latch — no latch set, and a
 *      plan-final.md with no checklist to reconcile against.
 *   3. The happy path — latch cleared, inventory refreshed.
 *   4. Cancelling the modal.
 *   5. Both race windows the modal opens: plan-final.md edited while it was
 *      open, and a round landing (bumping `updatedAt`) while it was open.
 *      Each must warn and leave the latch set.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  applyReconciliationReviewVerifiedTicksConfirmedV1,
  applyReconciliationReviewVerifiedTicksV1,
  linkManualChecksToBlockerConfirmedV1,
  postReconcilePlanChecklistDecisionV1,
  reconcilePlanChecklist,
  reconcilePlanChecklistConfirmedV1,
} from "../commands/reconcilePlanChecklist";
import {
  UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1,
  UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1,
  buildSiblingReviewDisagreementVariable,
  buildStayingOnStageNoticeV1,
  describeOutstandingChecklistItemsV1,
  readPlanChecklistProgressV1,
  resolveChecklistCountQualifierV1,
} from "../commands/reviewActions";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import {
  StatusSurface,
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { writeTextFileIfUnchangedV1, registerConditionalWriteSaveGuardV1, withPlanFileWriteLockV1 } from "../utils/fileUtils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-reconcile-test-")
);
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const CHECKLIST_PLAN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Split the artifacts",
  "- [ ] Wire the completeness gate",
  "",
].join("\n");

const PLAN_WITHOUT_CHECKLIST = ["# Final Plan", "", "Prose only, no checklist.", ""].join("\n");

const FULLY_CHECKED_PLAN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Split the artifacts",
  "- [x] Wire the completeness gate",
  "",
].join("\n");

const BASE_UPDATED_AT = "2026-08-11T00:00:00.000Z";

function writeProgress(folder: string, progress: TaskProgress): void {
  nodeFs.writeFileSync(
    nodePath.join(folder, "task-progress.json"),
    JSON.stringify(progress, undefined, 2),
    "utf8"
  );
}

function readProgress(folder: string): TaskProgress {
  return JSON.parse(
    nodeFs.readFileSync(nodePath.join(folder, "task-progress.json"), "utf8")
  ) as TaskProgress;
}

/**
 * Create a real task folder. resolveTaskContext refuses a folder that does not
 * exist on disk, and patchTaskProgressStrictV1 takes filesystem leases from the
 * path's ancestry, so this has to be a genuine nested directory rather than a
 * synthetic path.
 */
function makeTask(
  name: string,
  options: { latched: boolean; plan?: string }
): { folder: string; progress: TaskProgress } {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  const plan = options.plan ?? CHECKLIST_PLAN;
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: BASE_UPDATED_AT,
    updatedAt: BASE_UPDATED_AT,
    ...(options.latched ? { checklistProgressUnreliable: true } : {}),
  } as TaskProgress;
  writeProgress(folder, progress);
  return { folder, progress };
}

function makeInventory(
  canonicalId: string,
  folder: string,
  progress: TaskProgress
): { inventory: TaskInventory; refreshCount: () => number } {
  let refreshes = 0;
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const task = {
    canonicalId,
    taskFolderPath: folder,
    folderName: nodePath.basename(folder),
    sourceScopeKey: canonicalId,
    progress,
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[canonicalId, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = (): Promise<void> => {
    refreshes++;
    return Promise.resolve();
  };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined =>
    id === canonicalId ? task : undefined;
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === folder ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return { inventory: inv, refreshCount: (): number => refreshes };
}

function makeStore(persistedId?: string): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => persistedId;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

type Captured = { method: string; message: string };

/**
 * Capture notifications and drive the modal.
 *
 * Two channels, deliberately kept apart: routine notices go through
 * NotificationRouter to the status surface, while the confirmation is a real
 * blocking dialog and so calls vscode.window.showWarningMessage directly (rule
 * 2 in the router's own routing contract). A test that stubbed only one of them
 * would either miss every refusal message or never answer the modal.
 *
 * `onModal` runs while the confirmation is notionally open, which is where both
 * race-window tests inject their interference.
 */
function installWindowStub(options: {
  answer?: string;
  onModal?: () => void;
}): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const surface: StatusSurface = {
    addEntry: (message: string, level: "info" | "warning" | "error"): void => {
      captured.push({ method: level === "info" ? "info" : level, message });
    },
  };
  initNotificationRouter(surface);

  const win = vscode.window as unknown as Record<string, unknown>;
  const origWarn = win.showWarningMessage;

  win.showWarningMessage = (
    msg: string,
    ...rest: unknown[]
  ): Promise<string | undefined> => {
    const isModal =
      typeof rest[0] === "object" &&
      rest[0] !== null &&
      (rest[0] as { modal?: boolean }).modal === true;
    if (!isModal) {
      captured.push({ method: "warning", message: msg });
      return Promise.resolve(undefined);
    }
    captured.push({ method: "modal", message: msg });
    options.onModal?.();
    return Promise.resolve(options.answer);
  };

  return {
    captured,
    restore: (): void => {
      win.showWarningMessage = origWarn;
      deactivateNotificationRouter();
    },
  };
}

function installWorkspaceFolders(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(ROOT), name: "reconcile-root", index: 0 },
  ];
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig;
    },
  };
}

/** Back workspace.fs with the real disk so the command sees its own writes. */
function installRealFs(): { restore: () => void } {
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    createDirectory: fs.createDirectory,
  };
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  fs.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
  };
  fs.createDirectory = async (uri: vscode.Uri): Promise<void> => {
    await nodeFs.promises.mkdir(uri.fsPath, { recursive: true });
  };
  return {
    restore: (): void => {
      fs.readFile = orig.readFile;
      fs.writeFile = orig.writeFile;
      fs.createDirectory = orig.createDirectory;
    },
  };
}

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Run the command with every ambient stub installed, then tear them down.
 *
 * `reconcilePlanChecklist` no longer confirms via a modal — it posts a
 * `WorkflowDecisionV1` (case 4, reconcilePlanChecklist.ts's doc comment) to
 * Chat With AI and returns. This driver wires the process-wide extension
 * context so the decision store actually persists, captures whatever
 * decision was posted for `reconcilePlanChecklist`, optionally injects
 * `interference` between posting and confirming (the race-window tests), and
 * when `confirm` is true resolves the "reconcile" option and runs
 * `reconcilePlanChecklistConfirmedV1` — exactly what choosing "Mark
 * reconciled" in Chat With AI would dispatch.
 */
async function run(
  name: string,
  taskOptions: { latched: boolean; plan?: string },
  confirmOptions: { confirm?: boolean; interference?: (folder: string) => void },
  arg?: unknown
): Promise<{ captured: Captured[]; folder: string; refreshes: number; decision?: WorkflowDecisionV1 }> {
  const { folder, progress } = makeTask(name, taskOptions);
  const canonicalId = `canonical-${name}`;
  const { inventory, refreshCount } = makeInventory(canonicalId, folder, progress);
  const workspace = installWorkspaceFolders();
  const fs = installRealFs();
  const win = installWindowStub({});
  const context = makeExtensionContext();
  __extensionContextV1TestOnly.set(context);
  try {
    await reconcilePlanChecklist(
      inventory,
      makeStore(canonicalId),
      (arg ?? { canonicalId, taskFolderPath: folder }) as never
    );
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const decision = store
      .listPending(canonicalId)
      .find((d) => d.decisionKey === "reconcilePlanChecklist");
    if (decision) {
      win.captured.push({ method: "modal", message: decision.whatHappened });
    }
    if (confirmOptions.interference) {
      // Guarantees the interference write's mtime strictly exceeds the
      // decision's `createdAt` (both would otherwise land in the same
      // millisecond within a single synchronous test tick), so the
      // mtime-vs-createdAt freshness guard deterministically engages.
      await new Promise((resolve) => setTimeout(resolve, 5));
      confirmOptions.interference(folder);
    }
    if (confirmOptions.confirm && decision) {
      const resolved = await store.resolve(decision.decisionId, "reconcile");
      if (resolved.kind === "resolved") {
        await reconcilePlanChecklistConfirmedV1(inventory, makeStore(canonicalId), {
          canonicalId,
          taskFolderPath: folder,
          decisionId: decision.decisionId,
        });
      }
    }
    return { captured: win.captured, folder, refreshes: refreshCount(), decision };
  } finally {
    win.restore();
    fs.restore();
    workspace.restore();
    __extensionContextV1TestOnly.reset();
  }
}

// ---------------------------------------------------------------------------
// 1. Argument normalization
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — argument normalization", () => {
  void it("accepts the synthetic dispatcher shape whose `task` has no folderUri", async () => {
    // applyCurrentStageAction dispatches { canonicalId, taskFolderPath,
    // task: { progress } }. An unguarded `arg.task.folderUri.fsPath` throws on
    // exactly this shape — the live Ctrl+Shift+Alt+I crash. Resolving must
    // prefer the explicit ids and never touch folderUri.
    const name = "argshape-synthetic";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const result = await run(
      name,
      { latched: true },
      { confirm: true },
      {
        canonicalId: `canonical-${name}`,
        taskFolderPath: folder,
        task: { progress: { currentStage: "impl" } },
      }
    );
    assert.equal(
      result.captured.some((m) => m.method === "error"),
      false,
      "the synthetic dispatcher shape must resolve, not error"
    );
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, undefined);
  });

  void it("accepts a tree-node shape carrying folderUri", async () => {
    const name = "argshape-treenode";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const result = await run(
      name,
      { latched: true },
      { confirm: true },
      { task: { folderUri: vscode.Uri.file(folder), folderName: name, progress: {} } }
    );
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, undefined);
  });

  void it("errors rather than silently retargeting when the arg resolves to nothing", async () => {
    const name = "argshape-unresolvable";
    const { folder, progress } = makeTask(name, { latched: true });
    const { inventory } = makeInventory(`canonical-${name}`, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({ answer: "Mark Reconciled" });
    try {
      // No persisted current task and an unknown folder: nothing to fall back
      // on. Clearing some OTHER task's latch here would be the worst outcome.
      await reconcilePlanChecklist(
        inventory,
        makeStore(undefined),
        { taskFolderPath: nodePath.join(ROOT, ".ensemble", "does-not-exist") } as never
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
    }
    assert.match(
      win.captured.find((m) => m.method === "error")?.message ?? "",
      /could not be found/,
      "must take the explicit not-found path, not pass vacuously"
    );
    assert.equal(
      readProgress(folder).checklistProgressUnreliable,
      true,
      "the real task's latch must be untouched"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Refusals that must not clear the latch
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — refusals", () => {
  void it("reports an unlatched task as already reconciled and writes nothing", async () => {
    const result = await run("unlatched", { latched: false }, { confirm: true });
    assert.equal(
      result.captured.some((m) => m.method === "modal"),
      false,
      "no confirmation should be raised for a task that is not latched"
    );
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
      /already treated as a complete record/
    );
  });

  void it("refuses when plan-final.md has no checklist, leaving the latch set", async () => {
    // Clearing here would announce that completeness gating is restored while
    // readPlanOfRecordV1 keeps returning no counts and the gate stays down —
    // telling the user a safety net is back when it is not.
    const result = await run(
      "no-checklist",
      { latched: true, plan: PLAN_WITHOUT_CHECKLIST },
      { confirm: true }
    );
    assert.equal(
      result.captured.some((m) => m.method === "modal"),
      false,
      "the confirmation must not be raised when there is nothing to reconcile"
    );
    assert.match(
      result.captured.find((m) => m.method === "warning")?.message ?? "",
      /no implementation checklist to reconcile/
    );
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, true);
  });

  void it("leaves the latch set when the decision is left unresolved", async () => {
    const result = await run("cancelled", { latched: true }, { confirm: false });
    assert.ok(result.decision, "the reconcile decision should have been posted");
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, true);
    assert.equal(result.refreshes, 0, "an unconfirmed decision must not refresh");
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — confirmation", () => {
  void it("clears the latch, refreshes, and reports the counts it acted on", async () => {
    const result = await run("happy", { latched: true }, { confirm: true });
    const modal = result.captured.find((m) => m.method === "modal")?.message ?? "";
    assert.match(
      modal,
      /reads 1\/2 items settled/,
      "the decision must state the counts the user is approving"
    );
    assert.match(modal, /1 outstanding/);
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, undefined);
    assert.equal(result.refreshes, 1);
    // The last "info" entry, not the first: posting the reconcile decision
    // itself now also notifies at "info" level (its gating is non-blocking —
    // item 13, headline/severity must reflect `gating`), so the first "info"
    // entry can be that announcement rather than this command's own
    // completion message.
    assert.match(
      result.captured.filter((m) => m.method === "info").pop()?.message ?? "",
      /completeness now gates advancement again/
    );
  });
});

// ---------------------------------------------------------------------------
// 3a. applyReconciliationReviewVerifiedTicksConfirmedV1 (plan Part 4, NINTH
//     review round): review-verified evidence a synthetic round's automatic
//     reconciliation pass finds is a CANDIDATE, never an automatic tick.
//     This command is the only way to promote it — presents nothing on its
//     own (the "Apply N Reviewer-Verified Tick(s)" option in the reconcile
//     decision is the presentation surface, covered above); this covers the
//     command's own effect: it ticks exactly the review-verified items,
//     never more, and never touches the checklistProgressUnreliable latch by
//     itself.
// ---------------------------------------------------------------------------

const REVIEW_NAMING_VERIFIED_ITEM = [
  "Readiness: 9/10",
  "",
  "<!-- verified-complete:start -->",
  "- Wire the completeness gate",
  "<!-- verified-complete:end -->",
  "",
].join("\n");

void describe("applyReconciliationReviewVerifiedTicksV1 / applyReconciliationReviewVerifiedTicksConfirmedV1", () => {
  void it("does nothing and reports noCandidates when no review names an unticked item verified complete", async () => {
    const { folder } = makeTask("apply-recon-none", { latched: true });
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    try {
      const result = await applyReconciliationReviewVerifiedTicksV1(vscode.Uri.file(folder));
      assert.equal(result.kind, "noCandidates");
      assert.equal(
        nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"),
        CHECKLIST_PLAN,
        "nothing is written when there is nothing to apply"
      );
    } finally {
      fs.restore();
      workspace.restore();
    }
  });

  void it("ticks exactly the review-verified item and leaves the latch untouched — a synthetic round's candidate is not applied until this explicit selection", async () => {
    const { folder } = makeTask("apply-recon-candidate", { latched: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      REVIEW_NAMING_VERIFIED_ITEM,
      "utf8"
    );
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    try {
      // Before selection: the item stays unticked (this is exactly the
      // "candidatesFound" shape `runAutomaticChecklistReconciliationV1`
      // reports — presented, never applied on its own).
      const before = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
      assert.match(before, /- \[ \] Wire the completeness gate/);

      const result = await applyReconciliationReviewVerifiedTicksV1(vscode.Uri.file(folder));
      assert.deepEqual(result, { kind: "applied", count: 1 });

      const after = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
      assert.match(after, /- \[x\] Wire the completeness gate/);

      // Applying ticks is a separate act from attesting the checklist is a
      // complete record — the latch stays set until an explicit "Mark
      // reconciled" (plan Part 4: "the explicit human confirmation is
      // deliberate and correct").
      assert.equal(
        readProgress(folder).checklistProgressUnreliable,
        true,
        "applying candidate ticks must not by itself clear checklistProgressUnreliable"
      );
    } finally {
      fs.restore();
      workspace.restore();
    }
  });

  // -------------------------------------------------------------------------
  // wf10 review fix (2026-08-25, task-fixable blocker `739cfbbb-…-1`, seventh
  // narrowing): this was one of two remaining production writers of
  // plan-final.md that still called unconditional `writeTextFile`, bypassing
  // writeTextFileIfUnchangedV1's revision check entirely. Two real concurrent
  // calls both read the same original (unticked) plan and both compute the
  // same merge; without the fix both would silently overwrite each other via
  // separate unconditional writes with no way to detect the collision. With
  // the fix, the loser's write is refused (`changedUnderneath`) instead.
  // -------------------------------------------------------------------------
  void it("refuses the losing call with changedUnderneath when two callers race, rather than silently double-writing", async () => {
    const { folder } = makeTask("apply-recon-race", { latched: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      REVIEW_NAMING_VERIFIED_ITEM,
      "utf8"
    );
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    try {
      const folderUri = vscode.Uri.file(folder);
      const [resultA, resultB] = await Promise.all([
        applyReconciliationReviewVerifiedTicksV1(folderUri),
        applyReconciliationReviewVerifiedTicksV1(folderUri),
      ]);

      const kinds = [resultA.kind, resultB.kind].sort();
      assert.deepEqual(
        kinds,
        ["applied", "changedUnderneath"],
        "exactly one caller must win and apply the tick; the other must be refused, not silently overwrite"
      );

      const after = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
      assert.match(after, /- \[x\] Wire the completeness gate/);
      // Only the winner's write landed — the file holds exactly one applied
      // merge, not a doubled or corrupted result from two interleaved writes.
      assert.equal(
        (after.match(/- \[x\] Wire the completeness gate/g) ?? []).length,
        1,
        "the item must be ticked exactly once, not duplicated by a lost-refusal race"
      );
    } finally {
      fs.restore();
      workspace.restore();
    }
  });

  void it("the confirmed command wrapper applies the same tick and refreshes the inventory", async () => {
    const name = "apply-recon-command";
    const { folder, progress } = makeTask(name, { latched: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      REVIEW_NAMING_VERIFIED_ITEM,
      "utf8"
    );
    const canonicalId = `canonical-${name}`;
    const { inventory, refreshCount } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    try {
      await applyReconciliationReviewVerifiedTicksConfirmedV1(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const after = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
      assert.match(after, /- \[x\] Wire the completeness gate/);
      assert.equal(refreshCount(), 1);
      assert.match(
        win.captured.find((m) => m.method === "info")?.message ?? "",
        /Applied 1 reviewer-verified tick/
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Evidence surfaced for the case-4 judgement (task: "Replace hidden
//     notification decision buttons with explained, selectable decisions",
//     PART 4) — the decision must show, alongside the raw counts, the
//     unchecked-item list, pendingImplReviewFiles, and every implementation
//     review stage's own verdict against those unchecked items.
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — evidence for the case-4 judgement", () => {
  void it("includes unchecked items, pendingImplReviewFiles, and each review stage's verdict", async () => {
    const name = "evidence-full";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), CHECKLIST_PLAN, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
      pendingImplReviewFiles: ["src/foo.ts", "src/bar.ts"],
    } as TaskProgress;
    writeProgress(folder, progress);
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- verified-complete:start -->",
        "- Wire the completeness gate",
        "<!-- verified-complete:end -->",
        "",
        "<!-- blockers:start -->",
        "<!-- blockers:end -->",
      ].join("\n"),
      "utf8"
    );

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const labels = (decision.evidence ?? []).map((e) => e.label);
      assert.ok(labels.includes("Unchecked plan items"), labels.join(", "));
      assert.ok(labels.includes("pendingImplReviewFiles"), labels.join(", "));
      assert.ok(labels.includes("High-Level Code Review verdict"), labels.join(", "));
      assert.ok(labels.includes("Low-Level Code Review verdict"), labels.join(", "));

      const unchecked = decision.evidence!.find((e) => e.label === "Unchecked plan items")!;
      assert.match(unchecked.detail, /Wire the completeness gate/);

      const pendingFiles = decision.evidence!.find((e) => e.label === "pendingImplReviewFiles")!;
      assert.match(pendingFiles.detail, /src\/foo\.ts/);
      assert.match(pendingFiles.detail, /src\/bar\.ts/);

      const highVerdict = decision.evidence!.find((e) => e.label === "High-Level Code Review verdict")!;
      assert.match(highVerdict.detail, /Readiness: 9\/10/);
      assert.match(highVerdict.detail, /Names 1 of the unticked/);

      const lowVerdict = decision.evidence!.find((e) => e.label === "Low-Level Code Review verdict")!;
      assert.match(lowVerdict.detail, /No review artifact found/);

      // The command path (task-tree/palette invocation) has no triggering
      // round in scope, so the row must say so honestly rather than omitting
      // it or fabricating a claim — same honesty rule as the mtime omission.
      const roundClaim = decision.evidence!.find((e) => e.label === "Round-summary checklist claims")!;
      assert.match(roundClaim.detail, /Not available for this invocation/);

      // Every unchecked item is named verified complete by a review, but
      // (2026-08-21 NINTH review round) that is a CANDIDATE for explicit
      // selection, not an automatic tick — the recommendation must favor
      // applying those ticks (monotonic, text-matched, reuses
      // applyReviewerVerifiedTicks's own merge primitives), not "Mark
      // reconciled" directly, which would clear the flag while leaving the
      // verified-complete item sitting unticked.
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "applyVerifiedTicks");
      }
      const applyOption = decision.options.find((o) => o.optionId === "applyVerifiedTicks");
      assert.ok(applyOption, "an Apply Reviewer-Verified Tick(s) option must be offered");
      assert.match(applyOption.label, /Apply 1 Reviewer-Verified Tick/);
      assert.equal(applyOption.effect.kind, "command");
      if (applyOption.effect.kind === "command") {
        assert.equal(
          applyOption.effect.command,
          "vs-code-ai-helper.applyReconciliationReviewVerifiedTicksConfirmed"
        );
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("recommends no basis when at least one unticked item is not named by any review", async () => {
    const name = "evidence-partial";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), CHECKLIST_PLAN, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);
    // No review artifacts at all — nothing names the unticked item.

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "none");
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 item 19: a blocker a human already resolved via this task's own
  // stage chat (recorded in `TaskProgress.blockerSupersessions` the moment
  // the confirmable plan.md edit lands) must stop reading as outstanding —
  // this is the sibling of the test immediately below, with a matching
  // supersession recorded for the SAME blocker text and stage. The narrow
  // "do the HIGH checks named by this blocker" guidance must NOT fire,
  // because it would otherwise quote a blocker the record shows is already
  // resolved; the decision falls back to the generic evidence-based route.
  void it("does not narrate a stale blocker once a matching supersession is recorded for its stage", async () => {
    const name = "evidence-superseded-sole-blocker";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
      ].join("\n"),
      "utf8"
    );
    const reviewPath = nodePath.join(folder, "impl-high-review.md");
    nodeFs.writeFileSync(
      reviewPath,
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    // wf10 review fix (2026-08-25, new architectural blocker): filtering now
    // requires the review artifact to PREDATE the supersession (a stale
    // artifact a fresher review hasn't yet superseded) — see
    // `filterSupersededBlockersV1`'s doc comment. Real `writeFileSync` stamps
    // "now" as the mtime, which postdates `BASE_UPDATED_AT` (a fixed past
    // timestamp), so this backdates the artifact to before it — otherwise the
    // artifact would (correctly, per the fix) read as a FRESH review
    // reasserting the blocker, which must never be suppressed.
    const staleMtime = new Date("2026-08-01T00:00:00.000Z");
    nodeFs.utimesSync(reviewPath, staleMtime, staleMtime);
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
      blockerSupersessions: [
        {
          stage: "impl-high-review",
          blockerDescription: "The five live-AWS acceptance checks remain unexecuted",
          supersededAt: BASE_UPDATED_AT,
          planRelPath: "plan.md",
        },
      ],
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      // The specific sole-blocker guidance (which quotes the blocker's own
      // text) must not fire once that exact blocker is recorded as
      // superseded — it would otherwise instruct the user around a blocker
      // the record shows is already resolved.
      if (decision.recommendation.kind === "option") {
        assert.notEqual(decision.recommendation.optionId, "notYet");
        assert.doesNotMatch(decision.recommendation.reasoning, /live-AWS acceptance checks remain unexecuted/);
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, new architectural blocker): the sibling of
  // the test immediately above, but with the review artifact WRITTEN AFTER
  // the recorded supersession (a fresh review independently re-finding the
  // identically-worded blocker) rather than before it. A supersession only
  // stands in for a stale artifact a fresher review hasn't yet superseded —
  // it must never mask a review that postdates it, since that would let a
  // genuinely still-live blocker read as resolved forever. The sole-blocker
  // guidance must narrate this blocker exactly as it would with no
  // supersession recorded at all.
  void it("does not mask a fresh review's blocker even when an older supersession recorded identical text", async () => {
    const name = "evidence-fresh-review-postdates-supersession";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
      ].join("\n"),
      "utf8"
    );
    const reviewPath = nodePath.join(folder, "impl-high-review.md");
    nodeFs.writeFileSync(
      reviewPath,
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    // Real writeFileSync stamps "now" as the mtime, which already postdates
    // BASE_UPDATED_AT (a fixed past timestamp) — no backdating here, unlike
    // the sibling test above, is the point: this artifact is fresher than the
    // supersession.
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
      blockerSupersessions: [
        {
          stage: "impl-high-review",
          blockerDescription: "The five live-AWS acceptance checks remain unexecuted",
          supersededAt: BASE_UPDATED_AT,
          planRelPath: "plan.md",
        },
      ],
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "notYet");
        assert.match(decision.recommendation.reasoning, /live-AWS acceptance checks remain unexecuted/);
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, task-fixable blocker `a96160ec-…-2`): a
  // supersession recorded against a PLAN-review stage (the only stage family
  // `detectBlockerSupersessionCandidateV1` ever records one for) previously
  // had exactly one production consumer — `readStageArtifactsForChat`, which
  // only feeds a chat model's transient prompt context. This proves the
  // reconcile decision panel — a real, on-screen, non-chat surface — now also
  // surfaces it, via `computePlanReviewBlockerSupersessionEvidenceV1`.
  void it("surfaces a plan-review blocker's supersession status as durable evidence in the reconcile panel", async () => {
    const name = "evidence-plan-review-supersession";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] Some unrelated outstanding item",
        "",
      ].join("\n"),
      "utf8"
    );
    const planReviewPath = nodePath.join(folder, "plan-high-review.md");
    nodeFs.writeFileSync(
      planReviewPath,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    // As in the impl-stage sibling tests above: backdate the artifact so it
    // reads as a STALE review a later supersession legitimately stands in
    // for, not a fresh one that would (correctly) never be masked.
    const staleMtime = new Date("2026-08-01T00:00:00.000Z");
    nodeFs.utimesSync(planReviewPath, staleMtime, staleMtime);
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
      blockerSupersessions: [
        {
          stage: "plan-high-review",
          blockerDescription: "the owner must approve a complete tie policy",
          supersededAt: BASE_UPDATED_AT,
          planRelPath: "plan.md",
        },
      ],
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const blockerStatus = decision.evidence?.find((e) => e.label === "High-Level Review (Plan) blocker status");
      assert.ok(blockerStatus, "the plan-review blocker's supersession status must appear as its own evidence entry");
      assert.match(blockerStatus.detail, /1 of 1 recorded blocker\(s\)/);
      assert.match(blockerStatus.detail, /marked resolved via this task's own stage chat/);
      assert.match(blockerStatus.detail, /0 blocker\(s\) remain outstanding/);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 item 18: when the sole outstanding item coincides with the sole
  // remaining blocker on the relevant review, and that blocker is
  // `environmental`, the decline must narrow into a specific recommendation
  // (do the HIGH checks, tick, mark reconciled) instead of the generic "no
  // basis" wording — see buildSoleBlockerReconcileGuidanceV1.
  void it("recommends a specific action when the sole unticked item matches the sole environmental blocker", async () => {
    const name = "evidence-sole-environmental-blocker";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        // Review-narrowed blocker 57e9485f-…-0: the recommended option must
        // NOT be the immediately-executable "reconcile" — that would let
        // clicking the recommendation itself skip the prerequisite human
        // checks named in the reasoning below. "notYet" performs no action.
        assert.equal(decision.recommendation.optionId, "notYet");
        assert.match(decision.recommendation.reasoning, /live-AWS acceptance checks remain unexecuted/);
        assert.match(decision.recommendation.reasoning, /HIGH-priority check/);
        assert.match(decision.recommendation.reasoning, /Bastion stops after linger expires/);
        assert.match(decision.recommendation.reasoning, /Do that action first/);
      }
      // "Mark reconciled" must still be OFFERED (just not recommended) —
      // once the human has actually done the checks and ticked the item,
      // clicking it is still the correct next step.
      assert.ok(
        decision.options.some((o) => o.optionId === "reconcile" && o.label === "Mark reconciled"),
        "Mark reconciled must remain available as a non-recommended option"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review-narrowed blocker 57e9485f-…-0: when exactly ONE
  // manual-verification item remains unchecked in the whole plan, pooling
  // "every outstanding manual item" and pooling "the item(s) behind this
  // blocker" provably coincide (no other candidate exists) — the reasoning
  // must say so plainly instead of always hedging with "cannot confirm which
  // checks apply", which the review flagged as never resolving to true.
  void it("confirms manual-item scope and drops the hedge when exactly one manual check remains", async () => {
    const name = "evidence-sole-manual-item";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "notYet");
        assert.match(decision.recommendation.reasoning, /confirmed to be the ones this blocker names/);
        assert.doesNotMatch(decision.recommendation.reasoning, /cannot confirm which recorded manual checks/);
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (Step 26, 2026-08-25, THIRD narrowing, task-fixable
  // blocker `57e9485f-…-0`): a stated count in the blocker's own text used to
  // be accepted as scope corroboration when it numerically matched the
  // outstanding manual-item count. The review's own counterexample: a blocker
  // can genuinely overlap with the sole unticked item in one clause (so the
  // top-level `sharesSignificantOverlapV1` check at the caller still passes)
  // while separately naming an unrelated count in another clause — if the
  // plan happens to have exactly five outstanding manual items for entirely
  // unrelated reasons, the prior code pooled and labelled all five as this
  // blocker's checks anyway. Stated-count matching was removed entirely
  // (buildSoleBlockerReconcileGuidanceV1's doc comment); this reproduces the
  // exact adversarial shape and asserts the recommendation now falls back to
  // the honest, unconfirmed phrasing rather than asserting a link the
  // evidence does not establish.
  void it("does not confirm manual-item scope from a stated count that coincides with an unrelated clause", async () => {
    const name = "evidence-stated-count-manual-items";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Idle bastion is reclaimed after the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The live-AWS acceptance checks remain unexecuted; five unrelated regression tests also failed in CI",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "notYet");
        // The blocker text names an unrelated "five ... tests" count that
        // happens to equal the outstanding manual-item count (5) — that
        // coincidence must never be trusted as scope corroboration.
        assert.doesNotMatch(decision.recommendation.reasoning, /confirmed to be the ones this blocker names/);
        assert.match(decision.recommendation.reasoning, /cannot confirm which recorded manual checks/);
        assert.match(decision.recommendation.reasoning, /2 outstanding HIGH-priority check/);
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, narrowed task-fixable blocker
  // 57e9485f-…-0): the sibling of the test immediately above, but the
  // blocker's number is INCIDENTAL — it describes a retry limit, not a count
  // of checks — and happens to equal the outstanding manual-item count by
  // coincidence. Stated-count matching was removed entirely (see
  // buildSoleBlockerReconcileGuidanceV1's doc comment), so no number in a
  // blocker's text, incidental or not, is ever trusted as scope
  // corroboration and the
  // recommendation must fall back to the generic hedge.
  void it("does not treat an incidental, unrelated number as scope corroboration even when it numerically matches the outstanding count", async () => {
    const name = "evidence-incidental-count-match";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Idle bastion is reclaimed after the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The live-AWS acceptance suite still fails after five retries",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      if (decision.recommendation.kind === "option") {
        assert.doesNotMatch(
          decision.recommendation.reasoning,
          /confirmed to be the ones this blocker names/,
          "an incidental number near no count noun must never be trusted as scope corroboration"
        );
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, narrowed task-fixable blocker
  // 57e9485f-…-0, second pass, since fully superseded by the third pass
  // above which removed stated-count matching entirely): the review's own
  // worked counterexample for THIS narrowing was "five deployment steps" —
  // this codebase's own review artifacts routinely say things like "6 of 6
  // ordered implementation steps are complete," a plan-progress count that
  // has nothing to do with the outstanding manual-verification count it
  // would otherwise coincidentally match. Kept as a regression guard: no
  // stated count, "steps" or otherwise, is ever scope corroboration now.
  void it("does not treat a stated 'steps' count as scope corroboration, even when it numerically matches the outstanding count", async () => {
    const name = "evidence-steps-count-not-corroboration";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Idle bastion is reclaimed after the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The rollout still needs five deployment steps",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      if (decision.recommendation.kind === "option") {
        assert.doesNotMatch(
          decision.recommendation.reasoning,
          /confirmed to be the ones this blocker names/,
          "a stated 'steps' count must never be trusted as scope corroboration for manual-verification checks"
        );
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, FOURTH round on task-fixable blocker
  // `57e9485f-…-0`): every purely textual signal for confirming pooled-manual-
  // item scope has now been tried and disproven (the three tests immediately
  // above). Rather than a fifth heuristic, the unconfirmed pooled case must
  // offer a one-click way to RECORD the human's own confirmed link — the
  // "linkManualChecks" option — and running it must write real `Covers:
  // Step N` annotations that a subsequent reconcile invocation then reads as
  // confirmed (closing the loop this decision panel promises in its own
  // consequence text).
  void it("offers a Link Outstanding Checks option that records Covers: annotations and yields a confirmed recommendation next time", async () => {
    const name = "evidence-link-manual-checks";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    nodeFs.writeFileSync(
      planPath,
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] 25. Split the artifacts",
        "- [ ] 26. The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Idle bastion is reclaimed after the linger window — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const linkOption = decision.options.find((o) => o.optionId === "linkManualChecks");
      assert.ok(linkOption, "a Link Outstanding Checks option must be offered for the unconfirmed pooled case");
      assert.match(linkOption.label, /Link 5 Outstanding Checks To This Blocker/);
      assert.equal(linkOption.effect.kind, "command");
      if (linkOption.effect.kind !== "command") {
        throw new Error("unreachable — asserted above");
      }
      assert.equal(linkOption.effect.command, "vs-code-ai-helper.linkManualChecksToBlockerConfirmed");
      const args = linkOption.effect.args?.[0] as {
        taskFolderPath: string;
        canonicalId: string;
        stepNumber: number;
        itemTexts: string[];
      };
      assert.equal(args.stepNumber, 26);
      assert.equal(args.itemTexts.length, 5);

      // Executing the option must write real Covers: annotations...
      await linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args);
      const updatedPlan = nodeFs.readFileSync(planPath, "utf8");
      assert.match(updatedPlan, /Bastion stops after linger expires with no borrowers.*Covers: Step 26/);
      assert.match(updatedPlan, /Idle bastion is reclaimed after the linger window.*Covers: Step 26/);

      // ...and a subsequent reconcile invocation must now read it as a
      // confirmed, not pooled, recommendation. `post` supersedes the prior
      // pending decision for this same key, so `listPending` returns only
      // the fresh one below.
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const decision2 = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision2, "a second decision must be posted");
      if (decision2.recommendation.kind === "option") {
        assert.match(
          decision2.recommendation.reasoning,
          /confirmed to be the ones this blocker names/,
          "once linked, the same plan must read as confirmed rather than pooled"
        );
      }
      assert.ok(
        !decision2.options.find((o) => o.optionId === "linkManualChecks"),
        "the link option must not be offered once scope is already confirmed"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, new task-fixable blocker on
  // linkManualChecksToBlockerConfirmedV1): a decision can sit for a while
  // before the human clicks it. Guard 1 in that function's own doc comment —
  // refuse when plan-final.md's on-disk mtime is newer than the decision's
  // `createdAt` — must actually engage and must leave the plan byte-for-byte
  // unchanged, exactly like the sibling "Mark reconciled" freshness guard
  // this reuses the pattern from (see the race-window describe block below).
  void it("linkManualChecksToBlockerConfirmedV1 refuses stale decision data — plan-final.md changed since the decision was posted", async () => {
    const name = "evidence-link-manual-checks-stale-decision";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    const planContent = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 25. Split the artifacts",
      "- [ ] 26. The five live-AWS acceptance checks pass",
      "",
      "## Manual verification",
      "",
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
      "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
      "- [ ] Idle bastion is reclaimed after the linger window — Priority: LOW <!-- ensemble:excluded -->",
      "",
    ].join("\n");
    nodeFs.writeFileSync(planPath, planContent, "utf8");
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const linkOption = decision.options.find((o) => o.optionId === "linkManualChecks");
      assert.ok(linkOption, "a Link Outstanding Checks option must be offered");
      assert.equal(linkOption.effect.kind, "command");
      if (linkOption.effect.kind !== "command") {
        throw new Error("unreachable — asserted above");
      }
      const args = linkOption.effect.args?.[0] as {
        taskFolderPath: string;
        canonicalId: string;
        decisionId: string;
        stepNumber: number;
        itemTexts: string[];
      };
      assert.ok(args.decisionId, "the option's args must now carry a decisionId for the freshness guard");

      // Deterministically guarantees the interference write's mtime strictly
      // exceeds the decision's `createdAt` (both would otherwise land in the
      // same millisecond within a single synchronous test tick) — same
      // technique the race-window describe block below uses for the sibling
      // "Mark reconciled" freshness guard.
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Rewriting identical bytes still bumps the on-disk mtime, which is all
      // this guard inspects — it does not require the content to actually
      // differ to prove a round could have landed work in the interim.
      nodeFs.writeFileSync(planPath, planContent, "utf8");

      await linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args);

      assert.equal(
        win.captured.some(
          (m) => m.method === "warning" && /changed since this decision was posted/.test(m.message)
        ),
        true,
        "a staleness warning must be shown"
      );
      const planAfter = nodeFs.readFileSync(planPath, "utf8");
      assert.equal(planAfter, planContent, "a stale decision must never write a Covers: annotation");
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, same blocker as above): Guard 2 is the
  // defense-in-depth check for when `decisionId` is absent (an older in-
  // flight decision, or one evicted from the store) — the plan's CURRENT sole
  // outstanding step is re-derived fresh and compared against the confirmed
  // `stepNumber` regardless of whether a decisionId was available to check.
  void it("linkManualChecksToBlockerConfirmedV1 refuses when the plan's sole outstanding step no longer matches, even with no decisionId to compare", async () => {
    const name = "evidence-link-manual-checks-step-mismatch";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    const originalPlan = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 25. Split the artifacts",
      "- [ ] 26. The five live-AWS acceptance checks pass",
      "",
      "## Manual verification",
      "",
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "",
    ].join("\n");
    nodeFs.writeFileSync(planPath, originalPlan, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      // Args as they would have been baked in when step 26 WAS the sole
      // outstanding item, but with no decisionId — simulating a decision the
      // store no longer holds (or an older args shape).
      const args = {
        taskFolderPath: folder,
        canonicalId,
        stepNumber: 26,
        itemTexts: [
          "Bastion stops after linger expires with no borrowers — Priority: HIGH",
          "Ctrl+C during linger stops the bastion — Priority: HIGH",
        ],
      };

      // The plan has since moved on: step 26 is now done, and a NEW step 27
      // is the sole outstanding item — so annotating "Covers: Step 26" now
      // would record a false association.
      nodeFs.writeFileSync(
        planPath,
        originalPlan
          .replace("- [ ] 26. The five live-AWS acceptance checks pass", "- [x] 26. The five live-AWS acceptance checks pass")
          + "- [ ] 27. A brand-new unrelated step\n",
        "utf8"
      );

      await linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args as never);

      assert.equal(
        win.captured.some(
          (m) => m.method === "warning" && /no longer has Step 26 as its sole outstanding item/.test(m.message)
        ),
        true,
        "a step-mismatch warning must be shown"
      );
      const planAfter = nodeFs.readFileSync(planPath, "utf8");
      assert.doesNotMatch(planAfter, /Covers: Step 26/, "a stale step association must never be recorded");
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, Guard 2b, narrowed task-fixable blocker
  // `739cfbbb-…-1`): Guard 2 alone only proves the STEP is still sole
  // outstanding — it says nothing about whether the review's blocker driving
  // the recommendation is still there. This reproduces exactly the review's
  // named gap: the review artifact changes (the blocker's own text is
  // replaced) between decision-build and execution, while the plan and step
  // remain untouched, and asserts the write is refused rather than recording
  // a link against a blocker that no longer exists.
  void it("linkManualChecksToBlockerConfirmedV1 refuses when the review no longer names the confirmed blocker, even though the plan and step are unchanged", async () => {
    const name = "evidence-link-manual-checks-blocker-changed";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    const planContent = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 25. Split the artifacts",
      "- [ ] 26. The five live-AWS acceptance checks pass",
      "",
      "## Manual verification",
      "",
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "",
    ].join("\n");
    nodeFs.writeFileSync(planPath, planContent, "utf8");
    const reviewPath = nodePath.join(folder, "impl-high-review.md");
    nodeFs.writeFileSync(
      reviewPath,
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const linkOption = decision.options.find((o) => o.optionId === "linkManualChecks");
      assert.ok(linkOption, "a Link Outstanding Checks option must be offered");
      assert.equal(linkOption.effect.kind, "command");
      if (linkOption.effect.kind !== "command") {
        throw new Error("unreachable — asserted above");
      }
      const args = linkOption.effect.args?.[0] as {
        taskFolderPath: string;
        canonicalId: string;
        decisionId: string;
        stepNumber: number;
        itemTexts: string[];
        blockerStage: string;
        blockerDescription: string;
      };
      assert.ok(args.blockerStage && args.blockerDescription, "args must carry the confirmed blocker to revalidate");

      // A fresh review round replaces the blocker entirely — the plan and its
      // sole outstanding step are untouched, so Guard 2 alone would pass.
      nodeFs.writeFileSync(
        reviewPath,
        [
          "Readiness: 9/10",
          "",
          "<!-- blockers:start -->",
          "- [architectural] [task-fixable] An unrelated defect was found in the retry loop",
          "<!-- blockers:end -->",
          "",
        ].join("\n"),
        "utf8"
      );

      await linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args as never);

      assert.equal(
        win.captured.some(
          (m) => m.method === "warning" && /no longer names the blocker this link was confirmed against/.test(m.message)
        ),
        true,
        "a blocker-changed warning must be shown"
      );
      const planAfter = nodeFs.readFileSync(planPath, "utf8");
      assert.equal(planAfter, planContent, "a changed blocker must never result in a recorded Covers: annotation");
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, same Guard 2b): the blocker's raw text can
  // still be present in the review artifact yet no longer ACTIVE — the stage
  // chat supersession flow (item 19) records `blockerSupersessions` for
  // exactly this. Confirms the guard also refuses in that case rather than
  // only checking for literal text absence.
  void it("linkManualChecksToBlockerConfirmedV1 refuses when the confirmed blocker has since been superseded, even though its text is still on the review artifact", async () => {
    const name = "evidence-link-manual-checks-blocker-superseded";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    const planContent = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 25. Split the artifacts",
      "- [ ] 26. The five live-AWS acceptance checks pass",
      "",
      "## Manual verification",
      "",
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "",
    ].join("\n");
    nodeFs.writeFileSync(planPath, planContent, "utf8");
    const reviewPath = nodePath.join(folder, "impl-high-review.md");
    nodeFs.writeFileSync(
      reviewPath,
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const linkOption = decision.options.find((o) => o.optionId === "linkManualChecks");
      assert.ok(linkOption, "a Link Outstanding Checks option must be offered");
      assert.equal(linkOption.effect.kind, "command");
      if (linkOption.effect.kind !== "command") {
        throw new Error("unreachable — asserted above");
      }
      const args = linkOption.effect.args?.[0] as {
        taskFolderPath: string;
        canonicalId: string;
        decisionId: string;
        stepNumber: number;
        itemTexts: string[];
        blockerStage: string;
        blockerDescription: string;
      };

      // Stage chat has since recorded this exact blocker as superseded — its
      // text is still on the review artifact (a fresh review has not run),
      // but it is no longer an active blocker. Mutated in place (rather than
      // replaced) so the inventory stub's closed-over `task.progress`
      // reference — the same object `resolveTaskContext` reads back — sees
      // the update; `writeProgress` keeps the on-disk copy consistent too.
      (progress as { blockerSupersessions?: unknown }).blockerSupersessions = [
        {
          stage: "impl-high-review",
          blockerDescription: args.blockerDescription,
          supersededAt: new Date().toISOString(),
          planRelPath: "plan.md",
        },
      ];
      writeProgress(folder, progress);

      await linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args as never);

      assert.equal(
        win.captured.some(
          (m) => m.method === "warning" && /no longer names the blocker this link was confirmed against/.test(m.message)
        ),
        true,
        "a superseded-blocker warning must be shown"
      );
      const planAfter = nodeFs.readFileSync(planPath, "utf8");
      assert.equal(planAfter, planContent, "a superseded blocker must never result in a recorded Covers: annotation");
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 review fix (2026-08-25, third narrowing of task-fixable blocker
  // `57e9485f-…-0`, resolved by a structural link rather than another lexical
  // heuristic): with FIVE outstanding manual items (so the pigeonhole case
  // does not apply), only the two carrying an explicit `Covers: Step 26`
  // annotation matching the sole unticked item's own step number are used —
  // not the whole five-item pool, and `manualItemsScopeConfirmed` is true
  // despite the count being > 1, because the association is now sound rather
  // than pooled.
  void it("uses only the manual items whose own 'Covers: Step N' annotation matches the sole unticked item, not the whole pool", async () => {
    const name = "evidence-covers-annotation-scoped";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] 25. Split the artifacts",
        "- [ ] 26. The five live-AWS acceptance checks pass",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH — Covers: Step 26 <!-- ensemble:excluded -->",
        "- [ ] Ctrl+C during linger stops the bastion — Priority: LOW — Covers: Step 26 <!-- ensemble:excluded -->",
        "- [ ] Unrelated dashboard smoke test — Priority: HIGH <!-- ensemble:excluded -->",
        "- [ ] Another unrelated check — Priority: LOW <!-- ensemble:excluded -->",
        "- [ ] Yet another unrelated check — Priority: LOW <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "notYet");
        assert.match(
          decision.recommendation.reasoning,
          /confirmed to be the ones this blocker names/,
          "an explicit Covers: annotation must confirm scope even with 5 manual items outstanding"
        );
        assert.match(decision.recommendation.reasoning, /1 outstanding HIGH-priority check/);
        assert.match(decision.recommendation.reasoning, /Bastion stops after linger expires with no borrowers/);
        assert.doesNotMatch(
          decision.recommendation.reasoning,
          /Unrelated dashboard smoke test/,
          "an item covering a different step must never be pooled into this recommendation"
        );
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // Regression for the review-confirmed defect in the ABOVE test's original
  // implementation: it treated "exactly one unticked item plus exactly one
  // environmental blocker" as proof the two coincide, with no check that they
  // are actually about the same thing. Here the sole unticked item and the
  // sole environmental blocker are about completely unrelated subjects — the
  // guidance must decline (fall back to "no basis"), not fabricate a
  // recommendation naming a blocker unrelated to the item being reconciled.
  void it("does not recommend a specific action when the sole unticked item and sole environmental blocker are unrelated", async () => {
    const name = "evidence-unrelated-blocker";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] Verify the settings panel renders in light theme",
        "",
        "## Manual verification",
        "",
        "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "none");
      if (decision.recommendation.kind === "none") {
        assert.match(decision.recommendation.reasoning, /no basis to recommend/);
        assert.doesNotMatch(decision.recommendation.reasoning, /live-AWS acceptance checks/);
      }
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf10 item 6c: `coveredItemsCount === 0` is two unrelated situations — no
  // review vouches for an outstanding item (tested above), or there is no
  // outstanding item AT ALL. Observed live 2026-08-21 on jester task 3: the
  // panel simultaneously said "0 outstanding" and "at least one unticked
  // item is not named as verified complete" — self-contradictory. This is
  // exactly the case where "Mark reconciled" is unambiguously safe (nothing
  // outstanding to accidentally advance), and it must be recommended instead
  // of "no basis".
  void it("recommends Mark reconciled, not 'no basis', when zero checklist items are unticked", async () => {
    const name = "evidence-fully-ticked";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [x] Wire the completeness gate",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);
    // No review artifacts — irrelevant here, since nothing is outstanding
    // for a review to vouch for in the first place.

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "reconcile");
        assert.match(decision.recommendation.reasoning, /0 outstanding/);
        assert.doesNotMatch(decision.recommendation.reasoning, /no basis/);
      }
      // The "Not yet" option must never instruct ticking items that do not
      // exist (the second half of the same jester defect).
      const notYet = decision.options.find((o) => o.optionId === "notYet");
      assert.ok(notYet, "a Not yet option must still be offered");
      assert.doesNotMatch(
        notYet.consequence,
        /tick the missed items in plan-final\.md/,
        "there are no missed items to tick when the checklist already reads 0 outstanding"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // wf "make the stage chat a record of work" item 16: reproduces wf10's own
  // plan-final.md shape observed live — 33 ticked, 4 unticked, all 4 carrying
  // `<!-- ensemble:excluded -->`. The panel used to read the RAW count (33/37,
  // "4 outstanding"), withhold the recommendation, and instruct ticking items
  // excluded by design. Under the fixed-denominator count every excluded item
  // settles as `closedWithoutDoing`, so this must read 37/37 settled, 0
  // outstanding, and recommend "Mark reconciled" — exactly like the
  // all-checked case above, reached through a different item mix.
  void it("recommends Mark reconciled and reads 37/37 settled when the only unticked items are excluded (wf10 regression)", async () => {
    const name = "evidence-all-excluded-remainder";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const checkedItems = Array.from(
      { length: 33 },
      (_, i) => `- [x] Step ${i + 1} — completed work item`
    );
    const excludedItems = [
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Concurrent borrow extends the linger window — Priority: LOW <!-- ensemble:excluded -->",
      "- [ ] Bastion survives a host reboot mid-linger — Priority: LOW <!-- ensemble:excluded -->",
    ];
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      ["# Final Plan", "", "<!-- ensemble:implementation-checklist -->", "", ...checkedItems, ...excludedItems, ""].join(
        "\n"
      ),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "reconcile");
        assert.match(decision.recommendation.reasoning, /37\/37 items settled/);
        assert.match(decision.recommendation.reasoning, /33 completed/);
        assert.match(decision.recommendation.reasoning, /4 closed without doing/);
        assert.match(decision.recommendation.reasoning, /0 outstanding/);
        assert.doesNotMatch(decision.recommendation.reasoning, /no basis/);
      }
      const notYet = decision.options.find((o) => o.optionId === "notYet");
      assert.ok(notYet, "a Not yet option must still be offered");
      assert.doesNotMatch(
        notYet.consequence,
        /tick the missed items in plan-final\.md/,
        "the 4 unticked items are excluded by design, not missed work to tick"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  // Task "Actionable Hand-offs" PART 5: the reconciliation decision must cite
  // the recorded reason the checklist was flagged unreliable — the stronger
  // discriminating fact — not only the weaker unticked-item count, and must
  // state plainly that answering it does not itself resume the task (the
  // worked example: it was answered while an unrelated escalation, not this
  // latch, was what held the task paused).
  void it("cites the recorded checklistProgressUnreliableReason in whyUserNeeded when present", async () => {
    const name = "reason-present";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), CHECKLIST_PLAN, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
      checklistProgressUnreliableReason:
        "This round changed no files and landed no checklist ticks, but the most recent review already scored " +
        "the work above the auto-advance threshold with zero blockers.",
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.match(
        decision.whyUserNeeded,
        /most recent review already scored the work above the auto-advance threshold/
      );
      assert.doesNotMatch(decision.whyUserNeeded, /not recorded \(older record\)/i);
      assert.equal(decision.gating?.holdsTaskPaused, false);
      assert.equal(decision.gating?.unblocksProgress, false);
      assert.match(decision.gating?.detail ?? "", /does not resume the task/i);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("cites an explicit 'not recorded' statement when checklistProgressUnreliableReason is absent", async () => {
    const name = "reason-absent";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), CHECKLIST_PLAN, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      assert.match(decision.whyUserNeeded, /not recorded \(older record\)/i);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("surfaces the triggering round's own checklist claim when the caller has one in scope", async () => {
    // The two reviewActions.ts call sites (round-completion write path) pass
    // their already-computed `mergeChecklistProgressV1` result in — this is
    // the round-summary-claims evidence row the plan step 9 lists alongside
    // pendingImplReviewFiles and the review verdicts.
    const name = "evidence-round-claim";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), CHECKLIST_PLAN, "utf8");
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const result = await postReconcilePlanChecklistDecisionV1(
        vscode.Uri.file(folder),
        canonicalId,
        folder,
        progress,
        { kind: "no-match", unmatchedSample: ["Wire the completness gate (typo)"] }
      );
      assert.equal(result.kind, "posted");
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const roundClaim = decision.evidence!.find((e) => e.label === "Round-summary checklist claims")!;
      assert.match(roundClaim.detail, /matched no plan item/);
      assert.match(roundClaim.detail, /Wire the completness gate \(typo\)/);
    } finally {
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The two race windows the modal opens
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — races around confirming a long-lived decision", () => {
  void it("aborts when plan-final.md changes after the decision was posted but before it is confirmed", async () => {
    // The user's confirmation approves the evidence a decision showed when
    // POSTED. If plan-final.md moved under it before the user actually
    // clicked "Mark reconciled" in Chat With AI — which, unlike the old
    // modal, can be hours later — that evidence is stale. Guarded by
    // comparing plan-final.md's on-disk mtime against the decision's own
    // `createdAt`, re-derived at write time (never a cached snapshot).
    const result = await run(
      "race-plan-edited",
      { latched: true },
      {
        confirm: true,
        interference: (folder): void => {
          nodeFs.writeFileSync(
            nodePath.join(folder, "plan-final.md"),
            CHECKLIST_PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"),
            "utf8"
          );
        },
      }
    );
    assert.equal(
      result.captured.some((m) => m.method === "warning" && /changed since this decision was posted/.test(m.message)),
      true,
      "a warning naming the staleness must be shown, alongside the decision-posted announcement"
    );
    assert.equal(
      readProgress(result.folder).checklistProgressUnreliable,
      true,
      "an aborted reconciliation must leave the latch set"
    );
    assert.equal(result.refreshes, 0);
  });

  void it("aborts when a round lands (bumping updatedAt) while the decision is pending", async () => {
    // The at-write `updatedAt` CAS guard, unchanged from the pre-decision
    // design: `resolveTaskContext` resolves against the task inventory's
    // record of the task, so a round that landed and updated it since this
    // flow's own resolve is caught here, atomically inside the patch.
    const result = await run(
      "race-round-landed",
      { latched: true },
      {
        confirm: true,
        interference: (folder): void => {
          const current = readProgress(folder);
          writeProgress(folder, {
            ...current,
            updatedAt: "2026-08-11T12:00:00.000Z",
          });
        },
      }
    );
    assert.equal(
      readProgress(result.folder).checklistProgressUnreliable,
      true,
      "an aborted reconciliation must leave the latch set"
    );
    assert.equal(result.refreshes, 0);
  });

  // -------------------------------------------------------------------------
  // wf10 item 8 / plan step 23: progressVersion is authoritative once BOTH
  // sides carry it, specifically so a race can be caught even when updatedAt
  // itself does not move (or a coincidental collision leaves it unchanged) —
  // the exact gap a token dedicated to CAS, rather than doubling updatedAt,
  // exists to close.
  // -------------------------------------------------------------------------
  void it("catches a race via progressVersion even when updatedAt is unchanged", async () => {
    const { folder, progress } = makeTask("race-version-only", { latched: true });
    const versioned: TaskProgress = { ...progress, progressVersion: 3 };
    writeProgress(folder, versioned);
    const canonicalId = "canonical-race-version-only";
    const { inventory, refreshCount } = makeInventory(canonicalId, folder, versioned);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(inventory, makeStore(canonicalId), { canonicalId, taskFolderPath: folder } as never);
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store.listPending(canonicalId).find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted for a latched task");
      // Interference: a round lands via a real bump, moving the token to 4
      // while leaving `updatedAt` exactly as it was — the same-millisecond
      // shape a real patchTaskProgressStrictV1 write can produce, and exactly
      // what a comparison against `updatedAt` alone could miss.
      writeProgress(folder, { ...versioned, progressVersion: 4 });
      if (decision) {
        const resolved = await store.resolve(decision.decisionId, "reconcile");
        assert.equal(resolved.kind, "resolved");
        await reconcilePlanChecklistConfirmedV1(inventory, makeStore(canonicalId), {
          canonicalId,
          taskFolderPath: folder,
          decisionId: decision.decisionId,
        });
      }
      assert.equal(
        readProgress(folder).checklistProgressUnreliable,
        true,
        "a version-only race must still abort and leave the latch set"
      );
      assert.equal(refreshCount(), 0);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("succeeds and increments progressVersion when no race occurs on a versioned record", async () => {
    const { folder, progress } = makeTask("version-happy-path", { latched: true });
    writeProgress(folder, { ...progress, progressVersion: 5 });
    const canonicalId = "canonical-version-happy-path";
    const { inventory, refreshCount } = makeInventory(canonicalId, folder, { ...progress, progressVersion: 5 });
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(inventory, makeStore(canonicalId), { canonicalId, taskFolderPath: folder } as never);
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store.listPending(canonicalId).find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted for a latched task");
      if (decision) {
        const resolved = await store.resolve(decision.decisionId, "reconcile");
        assert.equal(resolved.kind, "resolved");
        await reconcilePlanChecklistConfirmedV1(inventory, makeStore(canonicalId), {
          canonicalId,
          taskFolderPath: folder,
          decisionId: decision.decisionId,
        });
      }
      const after = readProgress(folder);
      assert.equal(after.checklistProgressUnreliable, undefined, "the latch must clear");
      assert.equal(after.progressVersion, 6, "patchTaskProgressStrictV1 must increment the token by exactly 1");
      assert.notEqual(after.updatedAt, progress.updatedAt, "updatedAt must bump so the change is visible in the Tasks tree");
      assert.equal(refreshCount(), 1);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// wf10 review fix (2026-08-25, task-fixable blocker `739cfbbb-…-1`, narrowed
// repeatedly): the write path for "Link Outstanding Checks" used to stat
// plan-final.md, then write unconditionally — a write landing in that window
// could be silently replaced. writeTextFileIfUnchangedV1 (src/utils/fileUtils.ts)
// closes it: concurrent writers to the same uri serialize behind each other
// and the write only lands if the file still matches the expected content at
// that moment. The fourth review pass named a vector no amount of extra
// reads could close — a manual editor save for the same uri landing after
// the primitive's own final read — which registerConditionalWriteSaveGuardV1
// now defers via `onWillSaveTextDocument`; see the "editor-save guard"
// block below.
// ---------------------------------------------------------------------------

void describe("writeTextFileIfUnchangedV1 — revision-conditional write", () => {
  void it("refuses and preserves an edit that landed after the expected content was captured", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "toctou-primitive-direct");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    try {
      const uri = vscode.Uri.file(filePath);
      // Simulate an edit landing after `original` was captured as the "last
      // validated read" but before the conditional write below runs.
      const concurrentEdit = "an edit that landed concurrently\n";
      nodeFs.writeFileSync(filePath, concurrentEdit, "utf8");

      const wrote = await writeTextFileIfUnchangedV1(uri, original, "the losing write\n");

      assert.equal(wrote, false, "a write against stale expected content must be refused");
      assert.equal(
        nodeFs.readFileSync(filePath, "utf8"),
        concurrentEdit,
        "the concurrent edit must be preserved, not silently overwritten"
      );
    } finally {
      fs.restore();
    }
  });

  void it("refuses and preserves an edit that lands mid-flight, after the primitive's own final validated read but before the write reaches disk", async () => {
    // This is the exact window the third review pass named: an earlier round
    // fired `testOnlyBeforeWrite` before the primitive's *last* re-read, so
    // that re-read simply observed the injected edit and refused — proving
    // nothing about the window that actually matters. `testOnlyBeforeWrite`
    // now fires after every other read, immediately before the primitive's
    // one truly final read, so this test lands the race in the latest
    // possible position and still expects it to be caught. Real race timing
    // cannot be relied on to reproduce this every run, hence the seam.
    const folder = nodePath.join(ROOT, ".ensemble", "toctou-primitive-midflight");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    try {
      const uri = vscode.Uri.file(filePath);
      const midFlightEdit = "an editor save that landed mid-flight\n";

      const wrote = await writeTextFileIfUnchangedV1(uri, original, "the losing write\n", {
        testOnlyBeforeWrite: () => {
          nodeFs.writeFileSync(filePath, midFlightEdit, "utf8");
        },
      });

      assert.equal(
        wrote,
        false,
        "a write must be refused once an edit has landed after the primitive's own last validated read"
      );
      assert.equal(
        nodeFs.readFileSync(filePath, "utf8"),
        midFlightEdit,
        "the mid-flight edit must be preserved, not silently overwritten by the queued write"
      );
    } finally {
      fs.restore();
    }
  });

  void it("serializes two genuinely concurrent writers so the loser is refused rather than corrupting the file", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "toctou-primitive-concurrent");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    try {
      const uri = vscode.Uri.file(filePath);
      const [resultA, resultB] = await Promise.all([
        writeTextFileIfUnchangedV1(uri, original, "writer A\n"),
        writeTextFileIfUnchangedV1(uri, original, "writer B\n"),
      ]);

      assert.equal(
        [resultA, resultB].filter((r) => r === true).length,
        1,
        "exactly one concurrent writer must win"
      );
      assert.equal(
        [resultA, resultB].filter((r) => r === false).length,
        1,
        "the other must be refused rather than both silently applying"
      );
      const finalContent = nodeFs.readFileSync(filePath, "utf8");
      const winnerContent = resultA ? "writer A\n" : "writer B\n";
      assert.equal(finalContent, winnerContent, "the file must hold exactly the winner's content, not a mix");
    } finally {
      fs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// wf10 review fix (2026-08-25, task-fixable blocker `739cfbbb-…-1`, fourth
// narrowing): the concrete vector the review named was a manual editor save
// for the SAME uri landing after writeTextFileIfUnchangedV1's own final
// read — which no in-process re-read could ever catch, because the save
// does not go through this primitive at all.
// registerConditionalWriteSaveGuardV1 closes it by deferring any editor save
// for a uri that currently has an in-flight conditional write, via
// `vscode.workspace.onWillSaveTextDocument`'s `event.waitUntil`.
// ---------------------------------------------------------------------------

void describe("registerConditionalWriteSaveGuardV1 — editor-save vs in-flight conditional write", () => {
  void it("defers an editor save for the same uri until the in-flight conditional write resolves", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "save-guard-in-flight");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    const guard = registerConditionalWriteSaveGuardV1();
    try {
      const uri = vscode.Uri.file(filePath);
      const order: string[] = [];
      let releaseWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });

      // Started but not awaited: pendingConditionalWrites gets its entry for
      // this uri synchronously before this call returns, so the guard below
      // is guaranteed to see it as in-flight.
      const writePromise = writeTextFileIfUnchangedV1(uri, original, "background write\n", {
        testOnlyBeforeWrite: () => writeGate,
      }).then((result) => {
        order.push("write-resolved");
        return result;
      });

      const saveDoc = { uri, getText: (): string => original, isDirty: false };
      const savePromise = (
        vscode.workspace as unknown as {
          _fireWillSave: (document: unknown) => Promise<void>;
        }
      )._fireWillSave(saveDoc).then(() => {
        order.push("save-resolved");
      });

      // Give the in-flight write a moment to actually reach the gate (real
      // backup + fs reads happen first) before asserting neither resolved.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, [], "neither the write nor the deferred save should have resolved yet");

      releaseWrite();
      await Promise.all([writePromise, savePromise]);

      assert.deepEqual(
        order,
        ["write-resolved", "save-resolved"],
        "the save must resolve strictly after the in-flight conditional write, never before or interleaved"
      );
      assert.equal(
        nodeFs.readFileSync(filePath, "utf8"),
        "background write\n",
        "the conditional write must have landed"
      );
    } finally {
      guard.dispose();
      fs.restore();
    }
  });

  void it("does not delay a save for a uri with no in-flight conditional write", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "save-guard-no-op");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "untouched.md");
    nodeFs.writeFileSync(filePath, "content\n", "utf8");

    const guard = registerConditionalWriteSaveGuardV1();
    try {
      const uri = vscode.Uri.file(filePath);
      const saveDoc = { uri, getText: (): string => "content\n", isDirty: false };
      let resolved = false;
      const savePromise = (
        vscode.workspace as unknown as {
          _fireWillSave: (document: unknown) => Promise<void>;
        }
      )._fireWillSave(saveDoc).then(() => {
        resolved = true;
      });
      await savePromise;
      assert.equal(resolved, true, "a save with nothing in flight for its uri must not be blocked");
    } finally {
      guard.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // wf10 review fix (2026-08-25, NEW architectural blocker on the fifth
  // pass): the two tests above simulate an editor save with a synthetic
  // `saveDoc` object, entirely separate from any real in-flight write — they
  // never exercise the actual open-editor branch of writeTextFileIfUnchangedV1
  // itself, so they could not have caught the real bug: that branch calls
  // writeTextFile, which calls `document.save()`, which fires
  // onWillSaveTextDocument for the SAME uri the guard is watching. The guard
  // used to look that uri up in pendingConditionalWrites, find the very write
  // it was nested inside of, and `event.waitUntil()` that write's own
  // promise — which cannot resolve until this same `save()` resolves. An
  // immediate, permanent deadlock. This test drives the real open-editor path
  // (a document tracked in `vscode.workspace.textDocuments`, a real
  // `WorkspaceEdit` + `applyEdit`, a real `.save()` that fires the real
  // guarded event) and asserts it resolves rather than hanging.
  // -------------------------------------------------------------------------
  void it("does not deadlock when the open-editor write's own save fires the very guard watching it", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "save-guard-self-write");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";

    const guard = registerConditionalWriteSaveGuardV1();
    try {
      const uri = vscode.Uri.file(filePath);
      let content = original;
      const openDoc = {
        uri,
        getText: (): string => content,
        positionAt: (offset: number): number => offset,
        isDirty: false,
        _setContent: (text: string): void => {
          content = text;
        },
        save: async (): Promise<boolean> => {
          await (
            vscode.workspace as unknown as {
              _fireWillSave: (document: unknown) => Promise<void>;
            }
          )._fireWillSave(openDoc);
          return true;
        },
      };
      (vscode.workspace.textDocuments as unknown[]).push(openDoc);

      const writePromise = writeTextFileIfUnchangedV1(uri, original, "self-save write\n");
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1000)
      );

      const outcome = await Promise.race([writePromise.then(() => "resolved" as const), timeout]);

      assert.equal(
        outcome,
        "resolved",
        "the write must resolve — if this times out, the guard is deadlocking on its own write's save"
      );
      assert.equal(await writePromise, true, "the write must succeed");
      assert.equal(content, "self-save write\n", "the open document's content must reflect the write");
    } finally {
      guard.dispose();
      const docs = vscode.workspace.textDocuments as unknown[];
      const index = docs.findIndex((d) => (d as { uri: vscode.Uri }).uri.toString() === vscode.Uri.file(filePath).toString());
      if (index !== -1) {
        docs.splice(index, 1);
      }
    }
  });

  // -------------------------------------------------------------------------
  // wf10 review fix (2026-08-25, "New architectural blockers" on the sixth
  // pass): the fifth pass's fix above closed the deadlock, but did so by
  // marking the uri "own save in flight" for the ENTIRE open-editor branch —
  // including the `applyEdit` await that precedes `.save()` — so a foreign
  // will-save for the same uri arriving during THAT window was also waved
  // through untouched instead of being deferred, even though it is not the
  // conditional write's own save. The marker now only covers the window from
  // immediately before `.save()` onward (set via `writeTextFile`'s
  // `onBeforeSave` hook). This drives a real open-editor write whose
  // `applyEdit` is held open, fires a genuinely separate will-save for the
  // same uri during that hold, and asserts it is deferred (does not resolve
  // until the conditional write itself resolves) rather than exempted.
  // -------------------------------------------------------------------------
  void it("defers a foreign will-save that fires during the open-editor write's own applyEdit window, before the write's save has started", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "save-guard-applyedit-window");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";

    const guard = registerConditionalWriteSaveGuardV1();
    const realApplyEdit = vscode.workspace.applyEdit;
    try {
      const uri = vscode.Uri.file(filePath);
      let content = original;
      const openDoc = {
        uri,
        getText: (): string => content,
        positionAt: (offset: number): number => offset,
        isDirty: false,
        _setContent: (text: string): void => {
          content = text;
        },
        save: async (): Promise<boolean> => {
          await (
            vscode.workspace as unknown as {
              _fireWillSave: (document: unknown) => Promise<void>;
            }
          )._fireWillSave(openDoc);
          return true;
        },
      };
      (vscode.workspace.textDocuments as unknown[]).push(openDoc);

      let releaseApplyEdit: () => void = () => {};
      const applyEditGate = new Promise<void>((resolve) => {
        releaseApplyEdit = resolve;
      });
      (vscode.workspace as unknown as { applyEdit: typeof realApplyEdit }).applyEdit = async (
        edit: Parameters<typeof realApplyEdit>[0]
      ): Promise<boolean> => {
        await applyEditGate;
        return realApplyEdit(edit);
      };

      const writePromise = writeTextFileIfUnchangedV1(uri, original, "self-save write\n");

      // Give the write a moment to reach and block on the held applyEdit —
      // at this point conditionalWriteOwnSaveInFlight must NOT yet contain
      // this uri, since onBeforeSave has not fired.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const order: string[] = [];
      const foreignDoc = { uri, getText: (): string => content, isDirty: false };
      const foreignSavePromise = (
        vscode.workspace as unknown as {
          _fireWillSave: (document: unknown) => Promise<void>;
        }
      )._fireWillSave(foreignDoc).then(() => {
        order.push("foreign-save-resolved");
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        order,
        [],
        "a foreign will-save arriving before onBeforeSave has fired must be deferred, not exempted"
      );

      releaseApplyEdit();
      await Promise.all([writePromise, foreignSavePromise]);

      assert.deepEqual(
        order,
        ["foreign-save-resolved"],
        "the foreign save must resolve strictly after the conditional write, never exempted from the guard"
      );
    } finally {
      guard.dispose();
      (vscode.workspace as unknown as { applyEdit: typeof realApplyEdit }).applyEdit = realApplyEdit;
      const docs = vscode.workspace.textDocuments as unknown[];
      const index = docs.findIndex((d) => (d as { uri: vscode.Uri }).uri.toString() === vscode.Uri.file(filePath).toString());
      if (index !== -1) {
        docs.splice(index, 1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// wf10 review fix (2026-08-26, completion blocker `739cfbbb-…-1`, narrowed
// further — "the open-document branch performs an unversioned full-buffer
// replacement after its last validation… a user edit arriving before that
// replacement lands can still be overwritten"): writeTextFile's open-editor
// branch now accepts a `guardVersion` (writeTextFileIfUnchangedV1 passes the
// document's version at its own last validated read). If the document's
// version has advanced by more than this write's own edit accounts for by
// the time applyEdit resolves, a concurrent edit landed during that await —
// the write throws ConcurrentEditDuringApplyError before ever calling
// `.save()`, and writeTextFileIfUnchangedV1 turns that into a `false`
// refusal, so nothing is silently persisted over the concurrent edit.
// ---------------------------------------------------------------------------

void describe("writeTextFileIfUnchangedV1 — version guard on the open-editor applyEdit window", () => {
  void it("refuses (does not save) when the document version advances more than this write's own edit accounts for during applyEdit", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "version-guard-applyedit-race");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";

    const realApplyEdit = vscode.workspace.applyEdit;
    let saveCalls = 0;
    try {
      const uri = vscode.Uri.file(filePath);
      let content = original;
      const openDoc = {
        uri,
        version: 1,
        getText: (): string => content,
        positionAt: (offset: number): number => offset,
        isDirty: false,
        _setContent: (text: string): void => {
          content = text;
        },
        save: (): Promise<boolean> => {
          saveCalls += 1;
          return Promise.resolve(true);
        },
      };
      (vscode.workspace.textDocuments as unknown[]).push(openDoc);

      let releaseApplyEdit: () => void = () => {};
      const applyEditGate = new Promise<void>((resolve) => {
        releaseApplyEdit = resolve;
      });
      (vscode.workspace as unknown as { applyEdit: typeof realApplyEdit }).applyEdit = async (
        edit: Parameters<typeof realApplyEdit>[0]
      ): Promise<boolean> => {
        await applyEditGate;
        return realApplyEdit(edit);
      };

      const writePromise = writeTextFileIfUnchangedV1(uri, original, "the write that must be refused\n");

      // Give the write a moment to reach and block on the held applyEdit —
      // guardVersion was already captured (openDoc.version === 1) before this.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Simulate a concurrent edit (e.g. a keystroke) landing in the buffer
      // during the applyEdit IPC round-trip, the same window the review named.
      (openDoc as unknown as { _setContent: (t: string) => void })._setContent("a keystroke that landed concurrently\n");
      openDoc.version += 1;

      releaseApplyEdit();
      const wrote = await writePromise;

      assert.equal(
        wrote,
        false,
        "a write must be refused once a concurrent edit's version bump is observed after applyEdit"
      );
      assert.equal(
        saveCalls,
        0,
        "document.save() must never be called once the race is detected — nothing may reach disk"
      );
    } finally {
      (vscode.workspace as unknown as { applyEdit: typeof realApplyEdit }).applyEdit = realApplyEdit;
      const docs = vscode.workspace.textDocuments as unknown[];
      const index = docs.findIndex((d) => (d as { uri: vscode.Uri }).uri.toString() === vscode.Uri.file(filePath).toString());
      if (index !== -1) {
        docs.splice(index, 1);
      }
    }
  });

  void it("still succeeds when no concurrent edit lands — the version guard does not false-positive on an ordinary write", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "version-guard-no-race");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";

    let saveCalls = 0;
    try {
      const uri = vscode.Uri.file(filePath);
      let content = original;
      const openDoc = {
        uri,
        version: 1,
        getText: (): string => content,
        positionAt: (offset: number): number => offset,
        isDirty: false,
        _setContent: (text: string): void => {
          content = text;
        },
        save: (): Promise<boolean> => {
          saveCalls += 1;
          return Promise.resolve(true);
        },
      };
      (vscode.workspace.textDocuments as unknown[]).push(openDoc);

      const wrote = await writeTextFileIfUnchangedV1(uri, original, "an ordinary uncontested write\n");

      assert.equal(wrote, true, "an ordinary write with no concurrent edit must still succeed");
      assert.equal(saveCalls, 1, "document.save() must be called exactly once for a successful write");
      assert.equal(content, "an ordinary uncontested write\n");
    } finally {
      const docs = vscode.workspace.textDocuments as unknown[];
      const index = docs.findIndex((d) => (d as { uri: vscode.Uri }).uri.toString() === vscode.Uri.file(filePath).toString());
      if (index !== -1) {
        docs.splice(index, 1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// wf10 review fix (2026-08-26, architectural blocker `e18b7796-…-1`,
// "unresolved" per the review — "conditionalWriteOwnSaveInFlight remains a
// URI-keyed set… does not distinguish the writer's nested save from an
// unrelated save during the asynchronous document.save()… No regression test
// covers that residual window"). fileUtils.ts's own doc comment on that set
// argues this is safe because both a genuinely separate save and the
// conditional write's own save persist the SAME already-applied buffer
// content — there is only one buffer, so there is nothing for the unrelated
// save to lose. This test exercises exactly that scenario end to end: a
// second, genuinely unrelated will-save for the same uri fires WHILE the
// marker is set (nested inside the conditional write's own `.save()` call),
// and asserts neither deadlocks and the final content is exactly what the
// conditional write intended.
// ---------------------------------------------------------------------------

void describe("conditionalWriteOwnSaveInFlight — unrelated save racing the tightly-bracketed own-save window", () => {
  void it("does not deadlock and does not lose content when a genuinely separate will-save for the same uri fires during the write's own save() call", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "own-save-exemption-foreign-race");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "target.md");
    const original = "original content\n";

    const guard = registerConditionalWriteSaveGuardV1();
    try {
      const uri = vscode.Uri.file(filePath);
      let content = original;
      const openDoc = {
        uri,
        version: 1,
        getText: (): string => content,
        positionAt: (offset: number): number => offset,
        isDirty: false,
        _setContent: (text: string): void => {
          content = text;
        },
        save: async (): Promise<boolean> => {
          // The conditional write's own save fires onWillSave for this uri
          // (correctly exempted by the marker), and — nested inside that same
          // save — a genuinely separate, unrelated save request for the same
          // uri also fires onWillSave. Per the doc comment, both observe the
          // exemption (there is only one buffer, so there is no distinct
          // "unrelated" content to lose), so neither should deadlock.
          const foreignSave = (
            vscode.workspace as unknown as {
              _fireWillSave: (document: unknown) => Promise<void>;
            }
          )._fireWillSave({ uri, getText: (): string => content, isDirty: false });
          await (
            vscode.workspace as unknown as {
              _fireWillSave: (document: unknown) => Promise<void>;
            }
          )._fireWillSave(openDoc);
          await foreignSave;
          return true;
        },
      };
      (vscode.workspace.textDocuments as unknown[]).push(openDoc);

      const writePromise = writeTextFileIfUnchangedV1(uri, original, "self-save write with a foreign save nested inside\n");
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1000)
      );

      const outcome = await Promise.race([writePromise.then(() => "resolved" as const), timeout]);

      assert.equal(
        outcome,
        "resolved",
        "must not deadlock when a genuinely separate will-save for the same uri fires during the tightly-bracketed own-save window"
      );
      assert.equal(await writePromise, true, "the write must succeed");
      assert.equal(
        content,
        "self-save write with a foreign save nested inside\n",
        "content must reflect the conditional write, undisturbed by the foreign will-save being waved through"
      );
    } finally {
      guard.dispose();
      const docs = vscode.workspace.textDocuments as unknown[];
      const index = docs.findIndex((d) => (d as { uri: vscode.Uri }).uri.toString() === vscode.Uri.file(filePath).toString());
      if (index !== -1) {
        docs.splice(index, 1);
      }
    }
  });
});

void describe("linkManualChecksToBlockerConfirmedV1 — write races", () => {
  void it("refuses a second concurrent link call once the first has already written, preserving the first's annotation", async () => {
    const name = "link-manual-checks-concurrent-write";
    const folder = nodePath.join(ROOT, ".ensemble", name);
    const canonicalId = `canonical-${name}`;
    nodeFs.mkdirSync(folder, { recursive: true });
    const planPath = nodePath.join(folder, "plan-final.md");
    const planContent = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 25. Split the artifacts",
      "- [ ] 26. The five live-AWS acceptance checks pass",
      "",
      "## Manual verification",
      "",
      "- [ ] Bastion stops after linger expires with no borrowers — Priority: HIGH <!-- ensemble:excluded -->",
      "- [ ] Ctrl+C during linger stops the bastion — Priority: HIGH <!-- ensemble:excluded -->",
      "",
    ].join("\n");
    nodeFs.writeFileSync(planPath, planContent, "utf8");
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "- [review-confidence] [environmental] The five live-AWS acceptance checks remain unexecuted",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    const progress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: BASE_UPDATED_AT,
      updatedAt: BASE_UPDATED_AT,
      checklistProgressUnreliable: true,
    } as TaskProgress;
    writeProgress(folder, progress);

    const { inventory } = makeInventory(canonicalId, folder, progress);
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await reconcilePlanChecklist(
        inventory,
        makeStore(canonicalId),
        { canonicalId, taskFolderPath: folder } as never
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(canonicalId)
        .find((d) => d.decisionKey === "reconcilePlanChecklist");
      assert.ok(decision, "a decision must be posted");
      const linkOption = decision.options.find((o) => o.optionId === "linkManualChecks");
      assert.ok(linkOption, "a Link Outstanding Checks option must be offered");
      assert.equal(linkOption.effect.kind, "command");
      if (linkOption.effect.kind !== "command") {
        throw new Error("unreachable — asserted above");
      }
      const args = linkOption.effect.args?.[0];

      // Two genuinely concurrent invocations of the SAME link action — both
      // read the same pre-write plan content, so without serialization both
      // would pass their own Guard checks and race to write.
      const [resultA, resultB] = await Promise.allSettled([
        linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args as never),
        linkManualChecksToBlockerConfirmedV1(inventory, makeStore(canonicalId), args as never),
      ]);
      assert.equal(resultA.status, "fulfilled");
      assert.equal(resultB.status, "fulfilled");

      const successCount = win.captured.filter(
        (m) => m.method === "info" && /Linked \d+ outstanding check\(s\)/.test(m.message)
      ).length;
      const refusedCount = win.captured.filter(
        (m) => m.method === "warning" && /changed while this link was being applied/.test(m.message)
      ).length;
      assert.equal(successCount, 1, "exactly one concurrent call must succeed in writing");
      assert.equal(refusedCount, 1, "the other must be refused with the TOCTOU warning, not silently no-op");

      const updatedPlan = nodeFs.readFileSync(planPath, "utf8");
      const coversMatches = updatedPlan.match(/Covers: Step 26/g) ?? [];
      assert.equal(
        coversMatches.length,
        2,
        "the winning write's two Covers: annotations must be present exactly once each, not duplicated or lost"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
      __extensionContextV1TestOnly.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Finding 3 — while the latch is set, count-dependent gating stays stood
//    down and every "N of M" reporting surface carries the unverified
//    qualifier. The latch's ONE exit stays reconcilePlanChecklist (above).
// ---------------------------------------------------------------------------

void describe("checklistProgressUnreliable — gating and reporting surfaces", () => {
  void it("readPlanChecklistProgressV1 stands down while latched, and returns counts once cleared", async () => {
    const { folder } = makeTask("gating-stood-down", { latched: true });
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    try {
      const folderUri = vscode.Uri.file(folder);
      assert.equal(
        await readPlanChecklistProgressV1(folderUri),
        undefined,
        "a latched task's checklist counts must not feed count-dependent gating"
      );

      writeProgress(folder, {
        ...readProgress(folder),
        checklistProgressUnreliable: undefined,
      });
      const counts = await readPlanChecklistProgressV1(folderUri);
      assert.ok(counts, "clearing the latch restores the checklist as authoritative");
      assert.equal(counts.total, 2);
      assert.equal(counts.checked, 1);
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
    }
  });

  void it("the staying-on-stage notice carries the unverified qualifier only while latched", () => {
    const qualified = buildStayingOnStageNoticeV1(8, { complete: 3, total: 5 }, "", true);
    assert.ok(qualified.includes("3 of 5"), "the count itself still renders");
    assert.ok(
      qualified.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1),
      "a latched task's count must say it is unverified"
    );
    assert.match(qualified, /needs reconciliation/);

    const plain = buildStayingOnStageNoticeV1(8, { complete: 3, total: 5 }, "", false);
    assert.equal(
      plain.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1),
      false,
      "an unlatched task's count renders unqualified"
    );
  });

  void it("the staying-on-stage notice uses the nothing-outstanding qualifier when the checklist has nothing left to tick", () => {
    // wf10 item 11 continued: latched but the checklist itself is fully
    // ticked (jester task 3's 75/75 shape) — the reader must not be told to
    // go tick "missed items" that do not exist.
    const nothingOutstanding = buildStayingOnStageNoticeV1(
      8,
      { complete: 3, total: 5 },
      "",
      true,
      false
    );
    assert.ok(
      nothingOutstanding.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1),
      "nothing-outstanding must use the nothing-outstanding qualifier text"
    );
    assert.equal(
      nothingOutstanding.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1) &&
        !nothingOutstanding.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1),
      false,
      "must not render the 'tick the missed items' qualifier when nothing is outstanding"
    );
    assert.doesNotMatch(
      nothingOutstanding,
      /once the missed items are ticked/,
      "must never instruct ticking items that do not exist"
    );
    // The trailing sentence must agree with the qualifier just rendered —
    // this is the exact assembled-output contradiction the review flagged:
    // "shows nothing outstanding" followed by "Staying on this stage to
    // build the rest" tells the reader two incompatible things in one notice.
    assert.doesNotMatch(
      nothingOutstanding,
      /build the rest/,
      "must not tell the reader there is more to build when nothing is outstanding"
    );
    assert.match(
      nothingOutstanding,
      /Staying on this stage until that is reconciled/,
      "the closing instruction must point at reconciliation, not at unbuilt work"
    );

    // The default (outstanding items present) case must be unchanged.
    const stillOutstanding = buildStayingOnStageNoticeV1(8, { complete: 3, total: 5 }, "", true, true);
    assert.match(
      stillOutstanding,
      /Staying on this stage to build the rest/,
      "when items are genuinely outstanding the original closing instruction still applies"
    );
  });

  void it("resolveChecklistCountQualifierV1 picks the qualifier from the raw checklist, not the latch alone", async () => {
    const { folder: unticked } = makeTask("qualifier-resolve-unticked", { latched: true });
    const { folder: fullyTicked } = makeTask("qualifier-resolve-fully-ticked", {
      latched: true,
      plan: FULLY_CHECKED_PLAN,
    });
    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    try {
      const unreliable = await resolveChecklistCountQualifierV1(vscode.Uri.file(unticked), true);
      assert.equal(unreliable, UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1);

      const nothingLeft = await resolveChecklistCountQualifierV1(vscode.Uri.file(fullyTicked), true);
      assert.equal(nothingLeft, UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1);

      const notLatched = await resolveChecklistCountQualifierV1(vscode.Uri.file(unticked), false);
      assert.equal(notLatched, "");
    } finally {
      fs.restore();
      workspace.restore();
    }
  });

  void it("the sibling-disagreement block qualifies the ordered-steps count only while latched", async () => {
    const { folder } = makeTask("sibling-qualifier", { latched: true });
    const sha = "abcdef1";
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "# Implementation Review",
        "",
        `<!-- reviewed-commit: ${sha} -->`,
        "<!-- progress: 4/4 -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-low-review.md"),
      [
        "# Implementation Review",
        "",
        `<!-- reviewed-commit: ${sha} -->`,
        "<!-- blockers:start -->",
        "- [completion] [task-fixable] the resolver from plan step 2 does not exist",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    try {
      const folderUri = vscode.Uri.file(folder);
      const latched = await buildSiblingReviewDisagreementVariable(folderUri, sha);
      assert.match(latched, /4 of 4 ordered steps/);
      assert.ok(
        latched.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1),
        "the Publish reviewer must not be handed the count as authoritative while latched"
      );

      writeProgress(folder, {
        ...readProgress(folder),
        checklistProgressUnreliable: undefined,
      });
      const cleared = await buildSiblingReviewDisagreementVariable(folderUri, sha);
      assert.match(cleared, /4 of 4 ordered steps/);
      assert.equal(
        cleared.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1),
        false,
        "once reconciled the count renders unqualified again"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
    }
  });

  void it("the sibling-disagreement block uses the nothing-outstanding qualifier when the checklist is fully ticked but still latched", async () => {
    // wf10 item 11 continued: same 75/75-but-latched shape as item 6c, this
    // time for the Publish-facing sibling-disagreement variable rather than
    // the reconcile decision's own text.
    const { folder } = makeTask("sibling-qualifier-fully-ticked", {
      latched: true,
      plan: FULLY_CHECKED_PLAN,
    });
    const sha = "abcdef2";
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-high-review.md"),
      [
        "# Implementation Review",
        "",
        `<!-- reviewed-commit: ${sha} -->`,
        "<!-- progress: 4/4 -->",
        "",
      ].join("\n"),
      "utf8"
    );
    nodeFs.writeFileSync(
      nodePath.join(folder, "impl-low-review.md"),
      [
        "# Implementation Review",
        "",
        `<!-- reviewed-commit: ${sha} -->`,
        "<!-- blockers:start -->",
        "- [completion] [task-fixable] the resolver from plan step 2 does not exist",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const workspace = installWorkspaceFolders();
    const fs = installRealFs();
    const win = installWindowStub({});
    try {
      const folderUri = vscode.Uri.file(folder);
      const rendered = await buildSiblingReviewDisagreementVariable(folderUri, sha);
      assert.match(rendered, /4 of 4 ordered steps/);
      assert.ok(
        rendered.includes(UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1),
        "a fully-ticked-but-latched checklist must use the nothing-outstanding qualifier"
      );
      assert.doesNotMatch(
        rendered,
        /once the missed items are ticked/,
        "must never instruct ticking items that do not exist"
      );
    } finally {
      win.restore();
      fs.restore();
      workspace.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 5 (workflow 3 continuation) — describeOutstandingChecklistItemsV1, the
// formatter shared by the latch-trip note, the reconciliation-needed note,
// and the no-progress breaker escalation, so every "tick the missed items"
// surface names the exact items instead of leaving the reader to search the
// plan for them.
// ---------------------------------------------------------------------------
void describe("describeOutstandingChecklistItemsV1", () => {
  void it("returns '' for an undefined plan (no checklist to name items from)", () => {
    assert.equal(describeOutstandingChecklistItemsV1(undefined), "");
  });

  void it("returns '' when the plan has a checklist but nothing is outstanding", () => {
    const allDone = CHECKLIST_PLAN.replace(
      "- [ ] Wire the completeness gate",
      "- [x] Wire the completeness gate"
    );
    assert.equal(describeOutstandingChecklistItemsV1(allDone), "");
  });

  void it("names each outstanding item as its own bullet", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Wire the completeness gate",
      "- [ ] Add the retry button",
    ].join("\n");
    assert.equal(
      describeOutstandingChecklistItemsV1(plan),
      "\n- ☐ Wire the completeness gate\n- ☐ Add the retry button"
    );
  });

  void it("bounds the list and reports how many more exist", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] item one",
      "- [ ] item two",
      "- [ ] item three",
    ].join("\n");
    assert.equal(
      describeOutstandingChecklistItemsV1(plan, 2),
      "\n- ☐ item one\n- ☐ item two\n…and 1 more."
    );
  });
});

// ---------------------------------------------------------------------------
// wf10 review fix (2026-08-26, task-fixable blocker `739cfbbb-…-1`,
// seventh narrowing): the review's "Required" was comprehensive serialization
// of every production mutation of the plan of record, and named a concrete
// gap this pass had not touched — the stage Revert/Redo swap
// (viewStageChanges.ts) mutates plan-final.md entirely outside
// pendingConditionalWrites. withPlanFileWriteLockV1 lets a writer with its
// own mutation strategy (Revert/Redo's version-recheck swap; the
// create-if-missing materialize/publish paths in
// implementationArtifactResolver.ts) queue on the SAME per-uri FIFO
// writeTextFileIfUnchangedV1 uses, so the two families of writer can no
// longer interleave their own read-then-write against the same uri. These
// tests exercise the shared primitive directly (the command-level Revert/Redo
// integration in redoCommandIntegration.test.ts already covers the swap's own
// correctness; this proves the two writer families now share one queue).
// ---------------------------------------------------------------------------
void describe("withPlanFileWriteLockV1 — shares one FIFO with writeTextFileIfUnchangedV1", () => {
  void it("queues a withPlanFileWriteLockV1 operation strictly after an in-flight writeTextFileIfUnchangedV1 call for the same uri", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "plan-file-lock-order-1");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "plan-final.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    try {
      const uri = vscode.Uri.file(filePath);
      const order: string[] = [];
      let releaseWrite: () => void = () => {};
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });

      // Started but not awaited: pendingConditionalWrites gets its entry for
      // this uri synchronously before this call returns (no await precedes
      // the map.set inside writeTextFileIfUnchangedV1), so the queued
      // operation below is guaranteed to see it as already in flight.
      const writePromise = writeTextFileIfUnchangedV1(uri, original, "conditional write\n", {
        testOnlyBeforeWrite: () => writeGate,
      }).then((result) => {
        order.push("conditional-write-resolved");
        return result;
      });

      const lockedPromise = withPlanFileWriteLockV1(uri, () => {
        order.push("locked-op-ran");
        return Promise.resolve(nodeFs.readFileSync(filePath, "utf8"));
      });

      // Give the in-flight conditional write a moment to actually reach its
      // gate (real backup + fs reads happen first) before asserting the
      // queued operation has not run yet.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, [], "neither the conditional write nor the queued lock operation should have run yet");

      releaseWrite();
      const [writeResult, lockedResult] = await Promise.all([writePromise, lockedPromise]);

      assert.equal(writeResult, true, "the conditional write must succeed (content still matched)");
      assert.deepEqual(
        order,
        ["conditional-write-resolved", "locked-op-ran"],
        "the queued lock operation must run strictly after the conditional write, never before or interleaved"
      );
      assert.equal(
        lockedResult,
        "conditional write\n",
        "the queued operation must observe the conditional write's content, proving it ran after the write landed"
      );
    } finally {
      fs.restore();
    }
  });

  void it("queues a writeTextFileIfUnchangedV1 call strictly after an in-flight withPlanFileWriteLockV1 operation for the same uri", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "plan-file-lock-order-2");
    nodeFs.mkdirSync(folder, { recursive: true });
    const filePath = nodePath.join(folder, "plan-final.md");
    const original = "original content\n";
    nodeFs.writeFileSync(filePath, original, "utf8");

    const fs = installRealFs();
    try {
      const uri = vscode.Uri.file(filePath);
      const order: string[] = [];
      let releaseLock: () => void = () => {};
      const lockGate = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      // Simulates the Revert/Redo swap: its own writer, holding the queue
      // slot for this uri, with its own mutation (not going through
      // writeTextFileIfUnchangedV1 at all).
      const lockedPromise = withPlanFileWriteLockV1(uri, async () => {
        await lockGate;
        nodeFs.writeFileSync(filePath, "reverted content\n", "utf8");
        order.push("locked-op-resolved");
      });

      // A conditional write racing in while the lock-holder above is still
      // mid-flight, with the content it expects being the ORIGINAL bytes —
      // exactly the stale expectation a caller would have if it read before
      // the swap started. If this ran concurrently with the swap instead of
      // being queued behind it, its own internal freshness reads (which look
      // at the real file) could observe a torn intermediate state, or it
      // could silently win a race the swap should have serialized against.
      const writePromise = writeTextFileIfUnchangedV1(uri, original, "conditional write\n").then((result) => {
        order.push("conditional-write-resolved");
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, [], "neither operation should have run yet");

      releaseLock();
      const [lockedResult, writeResult] = await Promise.all([lockedPromise, writePromise]);
      void lockedResult;

      assert.deepEqual(
        order,
        ["locked-op-resolved", "conditional-write-resolved"],
        "the conditional write must run strictly after the lock-holder, never before or interleaved"
      );
      // The lock-holder changed the on-disk content away from `original`
      // before releasing the queue; the queued conditional write's freshness
      // check must observe that change and refuse, not silently overwrite it.
      assert.equal(
        writeResult,
        false,
        "the conditional write must be refused once it observes the swap's content, not the stale `original` it expected"
      );
      assert.equal(
        nodeFs.readFileSync(filePath, "utf8"),
        "reverted content\n",
        "the swap's content must survive untouched by the refused conditional write"
      );
    } finally {
      fs.restore();
    }
  });
});
