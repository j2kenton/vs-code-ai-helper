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
  postReconcilePlanChecklistDecisionV1,
  reconcilePlanChecklist,
  reconcilePlanChecklistConfirmedV1,
} from "../commands/reconcilePlanChecklist";
import {
  UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1,
  buildSiblingReviewDisagreementVariable,
  buildStayingOnStageNoticeV1,
  describeOutstandingChecklistItemsV1,
  readPlanChecklistProgressV1,
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
      /reads 1\/2 items complete/,
      "the decision must state the counts the user is approving"
    );
    assert.match(modal, /1 outstanding/);
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, undefined);
    assert.equal(result.refreshes, 1);
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
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
      "\n- Wire the completeness gate\n- Add the retry button"
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
      "\n- item one\n- item two\n…and 1 more."
    );
  });
});
