/**
 * Coverage for the one-time `.ensemble` meta-resources migration
 * (src/utils/metaResourcesMigration.ts) against a REAL on-disk legacy
 * workspace — including the accept path, which physically moves user task
 * state with fs.renameSync:
 *
 *  1. Accept: the legacy folder (with task state) moves atomically to
 *     `.ensemble`, the decline record is cleared, the gitignore maintenance
 *     re-runs against the new root, and the inventory refreshes.
 *  2. Decline: nothing moves, the decline is recorded internally, the
 *     non-forced offer is never repeated, and the legacy root stays the
 *     ACTIVE resource root (persisted, and restored in later sessions).
 *  3. Force (the "Move Ensemble Resources to .ensemble" command): re-offers
 *     even after a decline.
 *  4. Conflict: an existing non-empty `.ensemble` aborts the move and leaves
 *     BOTH locations untouched.
 *  5. No legacy folder: the forced run reports there is nothing to move.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { maybeOfferMetaResourcesMigration } from "../utils/metaResourcesMigration";
import {
  DEFAULT_TASK_ROOT,
  getConfiguredTaskRoot,
  setActiveLegacyTaskRoot,
} from "../utils/taskRoot";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { initNotificationRouter } from "../utils/notificationRouter";

// toggleMetaResourcesGitIgnore is required (not `import`ed) so its exported
// ensureAutomaticMetaGitIgnore can be replaced with a recorder — the real
// implementation needs a git repository and command contexts that are out of
// scope for these migration tests. Same monkey-patch pattern as
// chatHistoryStore.test.ts's writeAtomic patching.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gitIgnoreModule = require("../commands/toggleMetaResourcesGitIgnore") as {
  ensureAutomaticMetaGitIgnore: (...args: unknown[]) => Promise<void>;
};

const routedNotifications: Array<{ message: string; level: string }> = [];
initNotificationRouter({
  addEntry(message, level) {
    routedNotifications.push({ message, level });
  },
});

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-meta-migration-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  routedNotifications.length = 0;
  setActiveLegacyTaskRoot(undefined);
});

function makeWorkspace(name: string): string {
  const root = path.join(TEST_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** A legacy `plans/` root holding real task state (a folder with task.md). */
function seedLegacyPlans(root: string, taskName = "2026-01-01_task_1"): string {
  const legacy = path.join(root, "plans");
  const taskFolder = path.join(legacy, taskName);
  fs.mkdirSync(taskFolder, { recursive: true });
  fs.writeFileSync(path.join(taskFolder, "task.md"), "# Task\n", "utf8");
  fs.writeFileSync(path.join(taskFolder, "task-progress.json"), "{}", "utf8");
  return legacy;
}

function installWorkspaceFoldersStub(root: string): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = [{ uri: vscode.Uri.file(root), name: path.basename(root), index: 0 }];
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

function makeContext(): { context: vscode.ExtensionContext; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  const workspaceState = {
    get: <T>(key: string, defaultValue?: T): T =>
      (state.has(key) ? (state.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...state.keys()],
  };
  return {
    context: { workspaceState, subscriptions: [] } as unknown as vscode.ExtensionContext,
    state,
  };
}

function makeInventoryStub(): { inventory: TaskInventory; refreshes: () => number } {
  let refreshCount = 0;
  const inventory = {
    refresh: (): Promise<void> => {
      refreshCount += 1;
      return Promise.resolve();
    },
  } as unknown as TaskInventory;
  return { inventory, refreshes: (): number => refreshCount };
}

const currentTaskStoreStub = {} as unknown as CurrentTaskStore;

interface PromptControl {
  prompts: string[];
  errors: string[];
  restore: () => void;
}

/** Answer the migration offer with `answer`, capturing prompts and errors. */
function installPrompts(answer: string | undefined): PromptControl {
  const win = vscode.window as unknown as Record<string, unknown>;
  const origInfo = win.showInformationMessage;
  const origErr = win.showErrorMessage;
  const origWarn = win.showWarningMessage;
  const prompts: string[] = [];
  const errors: string[] = [];
  win.showInformationMessage = (message: string): Promise<string | undefined> => {
    prompts.push(message);
    return Promise.resolve(answer);
  };
  win.showErrorMessage = (message: string): Promise<undefined> => {
    errors.push(message);
    return Promise.resolve(undefined);
  };
  win.showWarningMessage = (message: string): Promise<undefined> => {
    errors.push(message);
    return Promise.resolve(undefined);
  };
  return {
    prompts,
    errors,
    restore: (): void => {
      win.showInformationMessage = origInfo;
      win.showErrorMessage = origErr;
      win.showWarningMessage = origWarn;
    },
  };
}

function installGitIgnoreRecorder(): { calls: () => number; restore: () => void } {
  const original = gitIgnoreModule.ensureAutomaticMetaGitIgnore;
  let count = 0;
  gitIgnoreModule.ensureAutomaticMetaGitIgnore = (): Promise<void> => {
    count += 1;
    return Promise.resolve();
  };
  return {
    calls: (): number => count,
    restore: (): void => {
      gitIgnoreModule.ensureAutomaticMetaGitIgnore = original;
    },
  };
}

const DECLINED_KEY = "ensemble.metaMigration.declined";
const LEGACY_ACTIVE_ROOT_KEY = "ensemble.metaMigration.legacyActiveRoot";

void describe("maybeOfferMetaResourcesMigration", () => {
  void it("accept path: moves the legacy folder to .ensemble with all task state intact", async () => {
    const root = makeWorkspace("accept");
    seedLegacyPlans(root);
    const ws = installWorkspaceFoldersStub(root);
    const prompts = installPrompts("Move");
    const gitIgnore = installGitIgnoreRecorder();
    const { context, state } = makeContext();
    const { inventory, refreshes } = makeInventoryStub();
    // A previously recorded gitignore application must be invalidated so the
    // managed block is rebuilt against the new root.
    state.set("ensemble.autoGitIgnoreApplied", "plans");

    try {
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub);

      assert.equal(prompts.prompts.length, 1, "exactly one move offer must be shown");
      assert.match(prompts.prompts[0]!, /plans/);
      assert.match(prompts.prompts[0]!, /\.ensemble/);

      const migratedTask = path.join(root, ".ensemble", "2026-01-01_task_1");
      assert.ok(fs.existsSync(path.join(migratedTask, "task.md")), "task state must arrive under .ensemble");
      assert.ok(fs.existsSync(path.join(migratedTask, "task-progress.json")));
      assert.equal(fs.existsSync(path.join(root, "plans")), false, "the legacy folder must be gone after the move");

      assert.equal(state.get(DECLINED_KEY), undefined, "a successful move clears any decline record");
      assert.equal(state.get("ensemble.autoGitIgnoreApplied"), undefined, "the stale gitignore record must be invalidated");
      assert.equal(gitIgnore.calls(), 1, "gitignore maintenance must re-run against the new root");
      assert.equal(refreshes(), 1, "the inventory must refresh so the moved tasks reappear");
      assert.ok(
        routedNotifications.some((entry) => entry.level === "info" && /moved to/.test(entry.message)),
        "the success notice goes through the notification router"
      );
      assert.deepEqual(prompts.errors, []);
    } finally {
      gitIgnore.restore();
      prompts.restore();
      ws.restore();
    }
  });

  void it("decline path: records the decline internally, moves nothing, and never re-prompts un-forced", async () => {
    const root = makeWorkspace("decline");
    seedLegacyPlans(root);
    const ws = installWorkspaceFoldersStub(root);
    const prompts = installPrompts("Not Now");
    const gitIgnore = installGitIgnoreRecorder();
    const { context, state } = makeContext();
    const { inventory } = makeInventoryStub();

    try {
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub);

      assert.equal(prompts.prompts.length, 1);
      assert.ok(fs.existsSync(path.join(root, "plans", "2026-01-01_task_1", "task.md")), "declining must move nothing");
      assert.equal(fs.existsSync(path.join(root, ".ensemble")), false);
      assert.equal(state.get(DECLINED_KEY), true, "the decline is remembered internally");
      assert.equal(
        getConfiguredTaskRoot(),
        "plans",
        "declining must keep the legacy location as the ACTIVE resource root, not just discoverable"
      );
      assert.equal(state.get(LEGACY_ACTIVE_ROOT_KEY), "plans", "the active legacy root is persisted");

      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub);
      assert.equal(prompts.prompts.length, 1, "a recorded decline must suppress later automatic offers");

      // A new session starts with no in-memory override — the declined offer
      // path must restore the persisted legacy root as active.
      setActiveLegacyTaskRoot(undefined);
      assert.equal(getConfiguredTaskRoot(), DEFAULT_TASK_ROOT);
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub);
      assert.equal(prompts.prompts.length, 1, "still no re-prompt");
      assert.equal(
        getConfiguredTaskRoot(),
        "plans",
        "the persisted legacy root becomes active again on the next activation"
      );
    } finally {
      gitIgnore.restore();
      prompts.restore();
      ws.restore();
    }
  });

  void it("the explicit command (force) re-offers after a decline", async () => {
    const root = makeWorkspace("force-reoffer");
    seedLegacyPlans(root);
    const ws = installWorkspaceFoldersStub(root);
    const prompts = installPrompts("Move");
    const gitIgnore = installGitIgnoreRecorder();
    const { context, state } = makeContext();
    const { inventory } = makeInventoryStub();
    state.set(DECLINED_KEY, true);
    state.set(LEGACY_ACTIVE_ROOT_KEY, "plans");
    setActiveLegacyTaskRoot("plans");

    try {
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub, true);

      assert.equal(prompts.prompts.length, 1, "force must bypass the decline record");
      assert.ok(fs.existsSync(path.join(root, ".ensemble", "2026-01-01_task_1", "task.md")));
      assert.equal(state.get(DECLINED_KEY), undefined);
      assert.equal(state.get(LEGACY_ACTIVE_ROOT_KEY), undefined, "a successful move clears the active legacy root");
      assert.equal(
        getConfiguredTaskRoot(),
        DEFAULT_TASK_ROOT,
        "after the move, .ensemble is the active root again"
      );
    } finally {
      gitIgnore.restore();
      prompts.restore();
      ws.restore();
    }
  });

  void it("aborts on a conflicting non-empty .ensemble, leaving both locations untouched", async () => {
    const root = makeWorkspace("conflict");
    seedLegacyPlans(root);
    const existing = path.join(root, ".ensemble", "2026-02-02_task_9");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "task.md"), "# Existing\n", "utf8");
    const ws = installWorkspaceFoldersStub(root);
    const prompts = installPrompts("Move");
    const gitIgnore = installGitIgnoreRecorder();
    const { context, state } = makeContext();
    const { inventory, refreshes } = makeInventoryStub();

    try {
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub);

      assert.ok(
        prompts.errors.some((message) => /already exists with content/.test(message)),
        "the conflict must be surfaced as an error"
      );
      assert.ok(fs.existsSync(path.join(root, "plans", "2026-01-01_task_1", "task.md")), "the legacy folder must remain in use");
      assert.ok(fs.existsSync(path.join(existing, "task.md")), "the existing .ensemble content must be untouched");
      assert.equal(gitIgnore.calls(), 0);
      assert.equal(refreshes(), 0);
      assert.equal(state.get(DECLINED_KEY), undefined, "a conflict abort is not a decline");
      assert.equal(
        getConfiguredTaskRoot(),
        "plans",
        "an aborted move keeps the legacy location as the active root"
      );
    } finally {
      gitIgnore.restore();
      prompts.restore();
      ws.restore();
    }
  });

  void it("forced run with no legacy folder reports there is nothing to move", async () => {
    const root = makeWorkspace("nothing-to-move");
    const ws = installWorkspaceFoldersStub(root);
    const prompts = installPrompts("Move");
    const gitIgnore = installGitIgnoreRecorder();
    const { context } = makeContext();
    const { inventory } = makeInventoryStub();

    try {
      await maybeOfferMetaResourcesMigration(context, inventory, currentTaskStoreStub, true);

      assert.equal(prompts.prompts.length, 0, "no move offer without a legacy folder");
      assert.ok(
        routedNotifications.some((entry) => /No legacy Ensemble resource folder/.test(entry.message)),
        "the forced run must explain that nothing needed moving"
      );
    } finally {
      gitIgnore.restore();
      prompts.restore();
      ws.restore();
    }
  });
});
