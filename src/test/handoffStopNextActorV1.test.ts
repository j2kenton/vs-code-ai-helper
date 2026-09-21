/**
 * v1 fixes 2, Wave I chokepoint: Fast Forward's hand-off-only stop hands the
 * task back to the human, so it reads "waiting for you" rather than stalled.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { recordHandoffOnlyStopV1 } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";

void describe("hand-off stop records nextActor: human", () => {
  let restoreFs: (() => void) | undefined;
  beforeEach(() => {
    initNotificationRouter({ addEntry: () => undefined } as unknown as Parameters<typeof initNotificationRouter>[0]);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = { ...fsObj };
    fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsObj.createDirectory = (): Promise<void> => Promise.resolve();
    restoreFs = (): void => {
      Object.assign(fsObj, orig);
    };
  });
  afterEach(() => {
    restoreFs?.();
    deactivateNotificationRouter();
  });

  void it("hands the task back to the human and leaves the stage untouched", async () => {
    // Nested two levels deep so the shared session lock stays inside this root.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-actor-"));
    const folder = path.join(root, "tasks", "t");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: "t",
        currentStage: "impl-high-review",
        status: "active",
        nextActor: "automation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    );
    try {
      await recordHandoffOnlyStopV1(vscode.Uri.file(folder), "T", "impl-high-review", {
        reason: "Only hand-off checks remain.",
        checks: ["Click through the card in a live window"],
      });
      const after = JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as {
        nextActor?: string;
        currentStage?: string;
      };
      assert.equal(after.nextActor, "human");
      assert.equal(after.currentStage, "impl-high-review");
    } finally {
      safeRemoveDir(root);
    }
  });
});
