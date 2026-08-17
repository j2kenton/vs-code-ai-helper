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

import { reconcilePlanChecklist } from "../commands/reconcilePlanChecklist";
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

/** Run the command with every ambient stub installed, then tear them down. */
async function run(
  name: string,
  taskOptions: { latched: boolean; plan?: string },
  windowOptions: { answer?: string; onModal?: (folder: string) => void },
  arg?: unknown
): Promise<{ captured: Captured[]; folder: string; refreshes: number }> {
  const { folder, progress } = makeTask(name, taskOptions);
  const canonicalId = `canonical-${name}`;
  const { inventory, refreshCount } = makeInventory(canonicalId, folder, progress);
  const workspace = installWorkspaceFolders();
  const fs = installRealFs();
  const win = installWindowStub({
    answer: windowOptions.answer,
    onModal: windowOptions.onModal ? (): void => windowOptions.onModal!(folder) : undefined,
  });
  try {
    await reconcilePlanChecklist(
      inventory,
      makeStore(canonicalId),
      (arg ?? { canonicalId, taskFolderPath: folder }) as never
    );
  } finally {
    win.restore();
    fs.restore();
    workspace.restore();
  }
  return { captured: win.captured, folder, refreshes: refreshCount() };
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
      { answer: "Mark Reconciled" },
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
      { answer: "Mark Reconciled" },
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
    const result = await run("unlatched", { latched: false }, { answer: "Mark Reconciled" });
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
      { answer: "Mark Reconciled" }
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

  void it("leaves the latch set when the confirmation is dismissed", async () => {
    const result = await run("cancelled", { latched: true }, { answer: undefined });
    assert.equal(
      result.captured.some((m) => m.method === "modal"),
      true,
      "the confirmation should have been raised"
    );
    assert.equal(readProgress(result.folder).checklistProgressUnreliable, true);
    assert.equal(result.refreshes, 0, "a dismissed confirmation must not refresh");
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — confirmation", () => {
  void it("clears the latch, refreshes, and reports the counts it acted on", async () => {
    const result = await run("happy", { latched: true }, { answer: "Mark Reconciled" });
    const modal = result.captured.find((m) => m.method === "modal")?.message ?? "";
    assert.match(
      modal,
      /reads 1\/2 items complete/,
      "the confirmation must state the counts the user is approving"
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
// 4. The two race windows the modal opens
// ---------------------------------------------------------------------------

void describe("reconcilePlanChecklist — races around the confirmation", () => {
  void it("aborts when plan-final.md changes while the confirmation is open", async () => {
    // The user approved a specific snapshot of the checkboxes. If the file
    // moved under them, that approval no longer describes what is on disk.
    const result = await run(
      "race-plan-edited",
      { latched: true },
      {
        answer: "Mark Reconciled",
        onModal: (folder): void => {
          nodeFs.writeFileSync(
            nodePath.join(folder, "plan-final.md"),
            CHECKLIST_PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"),
            "utf8"
          );
        },
      }
    );
    assert.match(
      result.captured.find((m) => m.method === "warning")?.message ?? "",
      /changed while the confirmation was open/
    );
    assert.equal(
      readProgress(result.folder).checklistProgressUnreliable,
      true,
      "an aborted reconciliation must leave the latch set"
    );
    assert.equal(result.refreshes, 0);
  });

  void it("aborts when a round lands while the confirmation is open", async () => {
    // A round finishing inside the modal may have latched the flag for work the
    // user never saw. The freshness check lives INSIDE the patch callback, so
    // the write aborts atomically rather than racing the lock.
    const result = await run(
      "race-round-landed",
      { latched: true },
      {
        answer: "Mark Reconciled",
        onModal: (folder): void => {
          const current = readProgress(folder);
          writeProgress(folder, {
            ...current,
            updatedAt: "2026-08-11T12:00:00.000Z",
          });
        },
      }
    );
    assert.match(
      result.captured.find((m) => m.method === "warning")?.message ?? "",
      /changed while the confirmation was open/
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
