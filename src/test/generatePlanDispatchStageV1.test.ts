/**
 * RC12 item 1: Generate Plan dispatches with the stage on disk, not the
 * inventory cache, so a question is filed under the stage the task is on.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { readCurrentStageForDispatchV1 } from "../commands/generatePlanWithAI";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function setStage(folder: string, stage: string): void {
  const file = path.join(folder, TASK_PROGRESS_FILENAME);
  const progress = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  progress.currentStage = stage;
  fs.writeFileSync(file, JSON.stringify(progress, null, 2));
}

void describe("readCurrentStageForDispatchV1", () => {
  const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = fsTarget.readFile;

  before(() => {
    fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  });
  after(() => {
    fsTarget.readFile = originalReadFile;
  });

  void it("returns the stage on disk when the cache still says desc", async () => {
    const fixture = makeOwnedTaskFolder("rc12-stage-");
    try {
      setStage(fixture.folder, "plan");
      assert.equal(await readCurrentStageForDispatchV1(vscode.Uri.file(fixture.folder), "desc"), "plan");
    } finally {
      safeRemoveDir(path.dirname(path.dirname(fixture.folder)));
    }
  });

  void it("falls back to the cached stage when the progress file cannot be read", async () => {
    const fixture = makeOwnedTaskFolder("rc12-stage-");
    try {
      fs.rmSync(path.join(fixture.folder, TASK_PROGRESS_FILENAME));
      assert.equal(await readCurrentStageForDispatchV1(vscode.Uri.file(fixture.folder), "desc"), "desc");
    } finally {
      safeRemoveDir(path.dirname(path.dirname(fixture.folder)));
    }
  });
});
