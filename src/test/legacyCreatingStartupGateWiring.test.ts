/**
 * Static wiring proof that the activation-order barrier
 * (LegacyCreatingStartupGateV0, plan §1.4) is actually consulted at every
 * site that can publish task inventory or read task state during/after
 * activation — not just the first `inventory.refresh()` call.
 *
 * An earlier implementation review found two bypasses: the file-system
 * watcher and configuration-change inventory refreshes in extension.ts
 * called `inventory.refresh()` directly (no `startupGateReady` await), and
 * `resumeTask.ts`'s lifecycle command began task resolution without waiting
 * on the barrier at all. Both are fixed by gating on `startupGateReady` /
 * `LegacyCreatingStartupGateV0.waitUntilReady()` before the first read, and
 * this test proves the gating call's source position precedes the read it
 * guards — mirroring the source-order approach in
 * legacyAiActionSafetyGateWiring.test.ts, since constructing the full
 * ExtensionContext/TaskInventory graph to prove this at runtime is out of
 * scope for this check.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

void describe("LegacyCreatingStartupGateV0 activation-barrier wiring", () => {
  void it("extension.ts gates the progress-watcher refresh callback on startupGateReady before inventory.refresh()", () => {
    const content = readRepoFile("src/extension.ts");

    const callbackIndex = content.indexOf("const onProgressChange = (): void => {");
    assert.ok(callbackIndex >= 0, "could not find onProgressChange in extension.ts");

    const gateIndex = content.indexOf("startupGateReady.then(", callbackIndex);
    assert.ok(gateIndex > callbackIndex, "onProgressChange must await startupGateReady");

    const refreshIndex = content.indexOf("inventory.refresh()", callbackIndex);
    assert.ok(refreshIndex > callbackIndex, "could not find inventory.refresh() in onProgressChange");

    assert.ok(
      gateIndex < refreshIndex,
      "startupGateReady.then(...) must precede inventory.refresh() in onProgressChange " +
        `(gate at ${gateIndex}, refresh at ${refreshIndex})`
    );
  });

  void it("extension.ts gates the configuration-change refresh callback on startupGateReady before inventory.refresh()", () => {
    const content = readRepoFile("src/extension.ts");

    const callbackIndex = content.indexOf(
      'const configListener = vscode.workspace.onDidChangeConfiguration((event) => {'
    );
    assert.ok(callbackIndex >= 0, "could not find configListener in extension.ts");

    const gateIndex = content.indexOf("startupGateReady.then(", callbackIndex);
    assert.ok(gateIndex > callbackIndex, "configListener must await startupGateReady");

    const refreshIndex = content.indexOf("inventory.refresh()", callbackIndex);
    assert.ok(refreshIndex > callbackIndex, "could not find inventory.refresh() in configListener");

    assert.ok(
      gateIndex < refreshIndex,
      "startupGateReady.then(...) must precede inventory.refresh() in configListener " +
        `(gate at ${gateIndex}, refresh at ${refreshIndex})`
    );
  });

  void it("taskInventory.ts self-gates refresh() on waitUntilReady() before its first discovery read", () => {
    // Defense-in-depth beyond the extension.ts call-site chains asserted
    // above: TaskInventory.refresh() awaits the barrier internally, so a
    // future refresh() caller that forgets to chain on startupGateReady
    // still cannot publish inventory ahead of the classification pass.
    const content = readRepoFile("src/state/taskInventory.ts");

    const fnIndex = content.indexOf("async refresh(): Promise<void> {");
    assert.ok(fnIndex >= 0, "could not find refresh() in taskInventory.ts");

    const gateIndex = content.indexOf("LegacyCreatingStartupGateV0.waitUntilReady()", fnIndex);
    assert.ok(gateIndex > fnIndex, "refresh() must await LegacyCreatingStartupGateV0.waitUntilReady()");

    const readIndex = content.indexOf("discoverAllTasks()", fnIndex);
    assert.ok(readIndex > fnIndex, "could not find discoverAllTasks() in refresh()");

    assert.ok(
      gateIndex < readIndex,
      "LegacyCreatingStartupGateV0.waitUntilReady() must precede discoverAllTasks() in refresh() " +
        `(gate at ${gateIndex}, read at ${readIndex})`
    );

    assert.ok(
      content.includes('from "./legacyCreatingStartupGateV0"'),
      "taskInventory.ts calls LegacyCreatingStartupGateV0.waitUntilReady() but does not import LegacyCreatingStartupGateV0"
    );
  });

  void it("resumeTask.ts awaits LegacyCreatingStartupGateV0.waitUntilReady() before its first task-state read", () => {
    const content = readRepoFile("src/commands/resumeTask.ts");

    const fnIndex = content.indexOf("export async function resumePausedTask(");
    assert.ok(fnIndex >= 0, "could not find resumePausedTask in resumeTask.ts");

    const gateIndex = content.indexOf("LegacyCreatingStartupGateV0.waitUntilReady()", fnIndex);
    assert.ok(gateIndex > fnIndex, "resumePausedTask must await LegacyCreatingStartupGateV0.waitUntilReady()");

    const readIndex = content.indexOf("resolveTaskContext(", fnIndex);
    assert.ok(readIndex > fnIndex, "could not find resolveTaskContext( in resumePausedTask");

    assert.ok(
      gateIndex < readIndex,
      "LegacyCreatingStartupGateV0.waitUntilReady() must precede resolveTaskContext( in resumePausedTask " +
        `(gate at ${gateIndex}, read at ${readIndex})`
    );

    assert.ok(
      content.includes('from "../state/legacyCreatingStartupGateV0"'),
      "resumeTask.ts calls LegacyCreatingStartupGateV0.waitUntilReady() but does not import LegacyCreatingStartupGateV0"
    );
  });

  // Every remaining lifecycle command that reads or mutates task state must
  // await the same barrier before its first task-state read (plan §1.4 —
  // "every registered callback that touches creation state awaits the
  // barrier"; an implementation review extended the verified set beyond
  // Start/Resume to Pause, Mark Done, Set Stage, and the other lifecycle
  // routes below). Each case asserts, by source position, that the
  // waitUntilReady() call inside the named function precedes that function's
  // first task-state read.
  const LIFECYCLE_BARRIER_CASES: ReadonlyArray<{
    file: string;
    fn: string;
    firstRead: string;
  }> = [
    { file: "src/commands/pauseTask.ts", fn: "export async function pauseTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/markTaskDone.ts", fn: "export async function markTaskDone(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/setTaskStage.ts", fn: "export async function setTaskStage(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/archiveTask.ts", fn: "export async function archiveTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/archiveTask.ts", fn: "export async function resumeArchivedTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/choosePublishScope.ts", fn: "export async function choosePublishScope(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/scheduleTaskResume.ts", fn: "export async function scheduleTaskResume(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/scheduleTaskResume.ts", fn: "export async function cancelScheduledTaskAction(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/renameTask.ts", fn: "export async function renameTask(", firstRead: "await resolve(inventory, arg)" },
    { file: "src/commands/renameTask.ts", fn: "export async function renameTaskWithAI(", firstRead: "await resolve(inventory, arg)" },
    { file: "src/commands/applyCurrentStageAction.ts", fn: "export async function applyCurrentStageAction(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/commitAndPushTask.ts", fn: "export async function commitAndPushTask(", firstRead: "commitAndPushTaskCore(" },
    { file: "src/commands/commitAndPushTask.ts", fn: "export async function completeCommitAndPushTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/pinTask.ts", fn: "export async function pinTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/pinTask.ts", fn: "export async function unpinTask(", firstRead: "resolveTaskContext(" },
    { file: "src/commands/runPublishChecks.ts", fn: "export async function runPublishChecks(", firstRead: "resolveTaskContext(" },
    { file: "src/utils/metaResourcesMigration.ts", fn: "export async function maybeOfferMetaResourcesMigration(", firstRead: "findLegacyResourceRoot(" },
  ];

  for (const testCase of LIFECYCLE_BARRIER_CASES) {
    void it(`${testCase.file} awaits the barrier in ${testCase.fn.replace("export async function ", "").replace("(", "")} before its first task-state read`, () => {
      const content = readRepoFile(testCase.file);

      const fnIndex = content.indexOf(testCase.fn);
      assert.ok(fnIndex >= 0, `could not find ${testCase.fn} in ${testCase.file}`);

      const gateIndex = content.indexOf("LegacyCreatingStartupGateV0.waitUntilReady()", fnIndex);
      assert.ok(
        gateIndex > fnIndex,
        `${testCase.fn} must await LegacyCreatingStartupGateV0.waitUntilReady()`
      );

      const readIndex = content.indexOf(testCase.firstRead, fnIndex);
      assert.ok(readIndex > fnIndex, `could not find ${testCase.firstRead} in ${testCase.fn}`);

      assert.ok(
        gateIndex < readIndex,
        `LegacyCreatingStartupGateV0.waitUntilReady() must precede ${testCase.firstRead} in ${testCase.fn} ` +
          `(gate at ${gateIndex}, read at ${readIndex})`
      );

      assert.ok(
        content.includes('from "../state/legacyCreatingStartupGateV0"'),
        `${testCase.file} calls LegacyCreatingStartupGateV0.waitUntilReady() but does not import LegacyCreatingStartupGateV0`
      );
    });
  }
});
