/**
 * Coverage for two Step 20 wording fixes in runLintingFixes.ts:
 *
 *  - the stage gate (line ~135) checks `currentStage !== "publish"` but used
 *    to say "Linting fixes are only available for completed tasks." — fixed
 *    to describe the actual Publish-stage requirement;
 *  - the "no lintPayload" fallback (line ~150) used to flatly say "No
 *    Publish report found" even when a publish-checks.md report is visibly
 *    present on disk (e.g. from an older task, before Publish-stage reviews
 *    started persisting lintPayload themselves) — it now distinguishes that
 *    case from the genuine "checks have never run" case.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { runLintingFixes } from "../commands/runLintingFixes";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import {
  acquireWorkAdmissionV1,
  hasLiveWorkAdmissionBestEffortV1,
} from "../state/workAdmissionV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-lint-fixes-gate-"));

function makeTaskFolder(name: string): string {
  const dir = path.join(REAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProgress(folderPath: string, progress: TaskProgress): void {
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
}

function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 },
  ];
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig; } };
}

function makeInventory(taskFolderPath: string, progress: TaskProgress): TaskInventory {
  const item = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? item : undefined),
    getTaskByPath: (p: string) => (p === taskFolderPath ? item : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [item],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function fixtureProgress(taskFolderPath: string, currentStage: TaskProgress["currentStage"]): TaskProgress {
  return {
    taskFolder: path.basename(taskFolderPath),
    currentStage,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(taskFolderPath),
  };
}

void describe("runLintingFixes gate and fallback messages", () => {
  void it("describes the Publish-stage requirement (not \"completed tasks\") when the task isn't at Publish", async () => {
    const taskFolderPath = makeTaskFolder("gate-not-publish");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "impl"));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "impl"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(surface.entries[0]?.message ?? "", /publish stage/i);
      assert.doesNotMatch(
        surface.entries[0]?.message ?? "",
        /completed tasks/i,
        "must no longer claim this action is gated on task completion"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("says checks have not yet been run when no lintPayload and no publish-checks.md exist", async () => {
    const taskFolderPath = makeTaskFolder("no-report-at-all");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(surface.entries[0]?.message ?? "", /have not been run/i);
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not flatly claim 'no report found' when a legacy publish-checks.md is present but lintPayload is missing", async () => {
    // Legacy shape (pre-unification, plan item 17 step 20): an old task may
    // still carry a checks report ONLY in the separate publish-checks.md,
    // never written to fresh by any current code path.
    const taskFolderPath = makeTaskFolder("stale-report-on-disk");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
    fs.writeFileSync(
      path.join(taskFolderPath, "publish-checks.md"),
      "## Completion Checks\n\n- Overall: All checks passed.\n",
      "utf8"
    );

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      const message = surface.entries[0]?.message ?? "";
      assert.match(message, /publish-checks\.md/i);
      assert.doesNotMatch(
        message,
        /^No Publish report found/i,
        "must not flatly assert no report exists when a Publish report is visibly present on disk"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does not flatly claim 'no report found' when publish-review.md carries a Completion Checks section but lintPayload is missing", async () => {
    // Unified shape (plan item 17 step 20): the report now lives inside
    // publish-review.md itself, spliced in as a managed section.
    const taskFolderPath = makeTaskFolder("stale-report-unified");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
    fs.writeFileSync(
      path.join(taskFolderPath, "publish-review.md"),
      "<!-- completion-checks:start -->\n## Completion Checks\n\n- Overall: All checks passed.\n<!-- completion-checks:end -->\n",
      "utf8"
    );

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      const message = surface.entries[0]?.message ?? "";
      assert.match(message, /publish-review\.md/i);
      assert.doesNotMatch(
        message,
        /^No Publish report found/i,
        "must not flatly assert no report exists when a Publish report is visibly present on disk"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});

/**
 * Work-admission wiring for runLintingFixes (v1 fixes item 1, Part 1a — the
 * remaining Part 1a route-inventory item for this command). Uses the same
 * real-fs `REAL_ROOT` fixture and `installReadFileBridge`/
 * `installWorkspaceFoldersStub` helpers as the gate-message tests above,
 * since `acquireWorkAdmissionV1` itself always does real `fs` I/O regardless
 * of how `vscode.workspace.fs` is bridged.
 */
void describe("runLintingFixes work admission (v1 fixes item 1, Part 1a)", () => {
  void it("refuses with the busy diagnostic, naming the other owner, when durable admission is already held for the task — and never reaches the stage gate", async () => {
    const taskFolderPath = makeTaskFolder("admission-busy");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    const held = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "someOtherConcurrentCommand",
    });
    assert.equal(held.outcome, "acquired");

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "publish"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(surface.entries.length, 1);
      assert.equal(surface.entries[0]?.level, "warning");
      assert.match(
        surface.entries[0]?.message ?? "",
        /someOtherConcurrentCommand/,
        "must name the actual blocking owner, not a generic 'task is busy' message"
      );
      assert.doesNotMatch(
        surface.entries[0]?.message ?? "",
        /publish stage/i,
        "must refuse on admission BEFORE reaching the stage gate — the stage check is part of the setup this exists to protect"
      );
    } finally {
      if (held.outcome === "acquired") {
        await held.handle.release();
      }
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });

  void it("releases its own admission once the command finishes, even on the fast \"wrong stage\" exit path", async () => {
    const taskFolderPath = makeTaskFolder("admission-released-on-exit");
    writeProgress(taskFolderPath, fixtureProgress(taskFolderPath, "impl"));

    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const ws = installWorkspaceFoldersStub();
    const rf = installReadFileBridge();

    try {
      const inventory = makeInventory(taskFolderPath, fixtureProgress(taskFolderPath, "impl"));
      await runLintingFixes(inventory, vscode.Uri.file(REAL_ROOT), { taskFolderPath });

      assert.equal(
        hasLiveWorkAdmissionBestEffortV1(taskFolderPath),
        false,
        "admission acquired at command entry must be released in `finally`, not left held after an early return"
      );
    } finally {
      rf.restore();
      ws.restore();
      deactivateNotificationRouter();
    }
  });
});
