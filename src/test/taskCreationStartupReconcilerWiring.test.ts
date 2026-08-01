/**
 * Static wiring proof that the activation-order barrier
 * (TaskCreationStartupReconcilerV1, plan §1.4/§4.1) is actually consulted at
 * every site that can publish task inventory or read task state during/after
 * activation — not just the first `inventory.refresh()` call.
 *
 * This supersedes legacyCreatingStartupGateWiring.test.ts, which proved the
 * same call sites against the now-deleted `LegacyCreatingStartupGateV0`. That
 * module and its dedicated test were removed once every one of its callers
 * (below) was migrated onto `TaskCreationStartupReconcilerV1` in the same
 * change (plan §4.1's "wiring cutover" — see that module's own header
 * comment). The two bypasses an earlier implementation review found — the
 * file-system watcher and configuration-change inventory refreshes in
 * extension.ts calling `inventory.refresh()` directly, and `resumeTask.ts`
 * beginning task resolution without waiting on the barrier at all — remain
 * fixed by gating on `startupGateReady` / `TaskCreationStartupReconcilerV1.
 * waitUntilReady()` before the first read; this test proves the gating
 * call's source position precedes the read it guards — mirroring the
 * source-order approach in legacyAiActionSafetyGateWiring.test.ts, since
 * constructing the full ExtensionContext/TaskInventory graph to prove this at
 * runtime is out of scope for this check.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

void describe("TaskCreationStartupReconcilerV1 activation-barrier wiring", () => {
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

    assert.ok(
      content.includes('from "./state/taskCreationStartupReconcilerV1"'),
      "extension.ts derives startupGateReady from TaskCreationStartupReconcilerV1 but does not import it"
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

  void it("extension.ts assigns startupGateReady from TaskCreationStartupReconcilerV1.beginClassification", () => {
    const content = readRepoFile("src/extension.ts");
    assert.ok(
      content.includes("TaskCreationStartupReconcilerV1.beginClassification("),
      "extension.ts must derive startupGateReady from TaskCreationStartupReconcilerV1.beginClassification"
    );
  });

  void it("extension.ts runs the stranded-deletion sweep inside startupGateReady, before beginClassification", () => {
    // Plan §4.1 startup order: step 1 (resume Safe Delete journals) must
    // complete before step 4 (classification), and AC-CREATE-STARTUP-03
    // forbids fire-and-forget reconciliation anywhere in activation — the
    // sweep clears the current-task checkpoint and refreshes inventory, so
    // it must be awaited by the same barrier everything else waits on.
    const content = readRepoFile("src/extension.ts");

    assert.ok(
      content.includes('resumeStrandedTaskDeletionsV1 } from "./commands/taskCreationRecovery"') ||
        content.includes('resumeStrandedTaskDeletionsV1,'),
      "extension.ts must import resumeStrandedTaskDeletionsV1 from taskCreationRecovery"
    );

    const sweepCallIndex = content.indexOf("resumeStrandedTaskDeletionsV1(");
    assert.ok(sweepCallIndex >= 0, "could not find the resumeStrandedTaskDeletionsV1 call in extension.ts");

    const chainIndex = content.indexOf("startupGateReady = Promise.all([");
    assert.ok(
      chainIndex >= 0,
      "startupGateReady must be assigned from Promise.all([...]).then(...) — startup reconciliation is " +
        "awaited by the barrier, never detached"
    );
    // AC-CREATE-STARTUP-03: ALL startup reconciliation runs inside the
    // barrier — the stranded-deletion sweeps AND the finalization-journal /
    // activation-checkpoint recoveries (previously fire-and-forget).
    const barrierStatementEnd = content.indexOf(";", chainIndex);
    const barrierStatement = content.slice(chainIndex, barrierStatementEnd);
    for (const member of [
      "...strandedDeletionSweeps",
      "...finalizationRecoveries",
      "...checkpointRecoveries",
    ]) {
      assert.ok(
        barrierStatement.includes(member),
        `the startupGateReady barrier must await ${member} before classification`
      );
    }
    assert.ok(
      !content.includes("void recoverFinalizationTree") &&
        !content.includes("void recoverActivationCheckpoint"),
      "finalization/checkpoint recovery must never run detached (fire-and-forget) during activation"
    );

    const classificationIndex = content.indexOf("TaskCreationStartupReconcilerV1.beginClassification(");
    assert.ok(classificationIndex >= 0, "could not find beginClassification in extension.ts");

    assert.ok(
      sweepCallIndex < classificationIndex,
      "the stranded-deletion sweep must precede beginClassification " +
        `(sweep at ${sweepCallIndex}, classification at ${classificationIndex})`
    );
    assert.ok(
      chainIndex < classificationIndex,
      "beginClassification must be chained AFTER the sweeps inside the startupGateReady assignment " +
        `(chain at ${chainIndex}, classification at ${classificationIndex})`
    );

    const statementEnd = content.indexOf(";", chainIndex);
    assert.ok(
      classificationIndex > chainIndex && classificationIndex < statementEnd,
      "beginClassification must sit inside the startupGateReady = Promise.all(...).then(...) statement, " +
        "so classification cannot begin until every sweep settles"
    );
  });

  void it("startNewTask.ts allocates the work-<digest> staging directory through the path registry (plan §2.1/§4.2)", () => {
    // The registry is the sole allocator under `creation-intents-v1/`
    // (plan §2.1); `creationWorkDir` is its staging locator. A raw
    // `work-${...}` template outside the registry would silently fork the
    // path contract the §4.2 crash-recovery scanners rely on.
    const content = readRepoFile("src/commands/startNewTask.ts");

    assert.ok(
      content.includes(".creationWorkDir("),
      "startNewTask.ts must allocate the staging directory via WorkflowPathRegistryV1.creationWorkDir"
    );
    assert.ok(
      content.includes("ensureWorkflowMetaRootV1("),
      "startNewTask.ts must register the meta root before allocating the staging directory"
    );

    function walkProduction(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test" || entry.name === "test-host") {
            continue;
          }
          walkProduction(full, out);
        } else if (entry.isFile() && full.endsWith(".ts")) {
          out.push(full);
        }
      }
      return out;
    }

    for (const filePath of walkProduction(path.join(REPO_ROOT, "src"))) {
      if (path.basename(filePath) === "workflowPathRegistryV1.ts") {
        continue; // the registry itself is the one legitimate template site.
      }
      const fileContent = fs.readFileSync(filePath, "utf8");
      assert.ok(
        !fileContent.includes("`work-${"),
        `${path.relative(REPO_ROOT, filePath)} hand-builds a work-<digest> staging path — allocation belongs to ` +
          "WorkflowPathRegistryV1.creationWorkDir alone (plan §2.1)"
      );
    }
  });

  void it("taskInventory.ts self-gates refresh() on waitUntilReady() before its first discovery read", () => {
    // Defense-in-depth beyond the extension.ts call-site chains asserted
    // above: TaskInventory.refresh() awaits the barrier internally, so a
    // future refresh() caller that forgets to chain on startupGateReady
    // still cannot publish inventory ahead of the classification pass.
    const content = readRepoFile("src/state/taskInventory.ts");

    const fnIndex = content.indexOf("async refresh(): Promise<void> {");
    assert.ok(fnIndex >= 0, "could not find refresh() in taskInventory.ts");

    const gateIndex = content.indexOf("TaskCreationStartupReconcilerV1.waitUntilReady()", fnIndex);
    assert.ok(gateIndex > fnIndex, "refresh() must await TaskCreationStartupReconcilerV1.waitUntilReady()");

    const readIndex = content.indexOf("discoverAllTasks()", fnIndex);
    assert.ok(readIndex > fnIndex, "could not find discoverAllTasks() in refresh()");

    assert.ok(
      gateIndex < readIndex,
      "TaskCreationStartupReconcilerV1.waitUntilReady() must precede discoverAllTasks() in refresh() " +
        `(gate at ${gateIndex}, read at ${readIndex})`
    );

    assert.ok(
      content.includes('from "./taskCreationStartupReconcilerV1"'),
      "taskInventory.ts calls TaskCreationStartupReconcilerV1.waitUntilReady() but does not import TaskCreationStartupReconcilerV1"
    );
  });

  void it("resumeTask.ts awaits TaskCreationStartupReconcilerV1.waitUntilReady() before its first task-state read", () => {
    const content = readRepoFile("src/commands/resumeTask.ts");

    const fnIndex = content.indexOf("export async function resumePausedTask(");
    assert.ok(fnIndex >= 0, "could not find resumePausedTask in resumeTask.ts");

    const gateIndex = content.indexOf("TaskCreationStartupReconcilerV1.waitUntilReady()", fnIndex);
    assert.ok(gateIndex > fnIndex, "resumePausedTask must await TaskCreationStartupReconcilerV1.waitUntilReady()");

    const readIndex = content.indexOf("resolveTaskContext(", fnIndex);
    assert.ok(readIndex > fnIndex, "could not find resolveTaskContext( in resumePausedTask");

    assert.ok(
      gateIndex < readIndex,
      "TaskCreationStartupReconcilerV1.waitUntilReady() must precede resolveTaskContext( in resumePausedTask " +
        `(gate at ${gateIndex}, read at ${readIndex})`
    );

    assert.ok(
      content.includes('from "../state/taskCreationStartupReconcilerV1"'),
      "resumeTask.ts calls TaskCreationStartupReconcilerV1.waitUntilReady() but does not import TaskCreationStartupReconcilerV1"
    );
  });

  void it("startNewTask.ts awaits TaskCreationStartupReconcilerV1.waitUntilReady() before its first workspace read", () => {
    const content = readRepoFile("src/commands/startNewTask.ts");

    const fnIndex = content.indexOf("export async function startNewTask(");
    assert.ok(fnIndex >= 0, "could not find startNewTask in startNewTask.ts");

    const gateIndex = content.indexOf("TaskCreationStartupReconcilerV1.waitUntilReady()", fnIndex);
    assert.ok(gateIndex > fnIndex, "startNewTask must await TaskCreationStartupReconcilerV1.waitUntilReady()");

    const readIndex = content.indexOf("vscode.workspace.workspaceFolders", fnIndex);
    assert.ok(readIndex > fnIndex, "could not find the workspaceFolders read in startNewTask");

    assert.ok(
      gateIndex < readIndex,
      "TaskCreationStartupReconcilerV1.waitUntilReady() must precede the workspaceFolders read in startNewTask " +
        `(gate at ${gateIndex}, read at ${readIndex})`
    );

    assert.ok(
      content.includes('from "../state/taskCreationStartupReconcilerV1"'),
      "startNewTask.ts calls TaskCreationStartupReconcilerV1.waitUntilReady() but does not import TaskCreationStartupReconcilerV1"
    );
    assert.ok(
      content.includes("TaskCreationStartupReconcilerV1.getClassifiedFootprints("),
      "startNewTask.ts must surface legacy `creating` footprints via TaskCreationStartupReconcilerV1.getClassifiedFootprints"
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

      const gateIndex = content.indexOf("TaskCreationStartupReconcilerV1.waitUntilReady()", fnIndex);
      assert.ok(
        gateIndex > fnIndex,
        `${testCase.fn} must await TaskCreationStartupReconcilerV1.waitUntilReady()`
      );

      const readIndex = content.indexOf(testCase.firstRead, fnIndex);
      assert.ok(readIndex > fnIndex, `could not find ${testCase.firstRead} in ${testCase.fn}`);

      assert.ok(
        gateIndex < readIndex,
        `TaskCreationStartupReconcilerV1.waitUntilReady() must precede ${testCase.firstRead} in ${testCase.fn} ` +
          `(gate at ${gateIndex}, read at ${readIndex})`
      );

      assert.ok(
        content.includes('from "../state/taskCreationStartupReconcilerV1"'),
        `${testCase.file} calls TaskCreationStartupReconcilerV1.waitUntilReady() but does not import TaskCreationStartupReconcilerV1`
      );
    });
  }

  void it("LegacyCreatingStartupGateV0 no longer exists anywhere in the production source tree", () => {
    // Proves the retirement is complete, not just "unused" — a stray import
    // left behind would silently keep the old, un-triggered barrier alive
    // for any caller that still referenced it.
    const legacyModulePath = path.join(REPO_ROOT, "src", "state", "legacyCreatingStartupGateV0.ts");
    assert.equal(fs.existsSync(legacyModulePath), false, "legacyCreatingStartupGateV0.ts must be deleted");

    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, out);
        } else if (entry.isFile() && full.endsWith(".ts")) {
          out.push(full);
        }
      }
      return out;
    }

    // Checks for the retired module's import specifier (its lowercase file
    // path), not the exported class-name text: a handful of files' prose
    // legitimately explains what replaced it and why (this file's own
    // header/assertions above, and taskCreationStartupReconcilerV1.ts's own
    // header comment) — that history is useful, not a bypass. An actual
    // import naming the deleted module would fail to compile in the first
    // place, but this also catches a stray require()/dynamic-import string.
    for (const file of walk(path.join(REPO_ROOT, "src"))) {
      if (path.basename(file) === "taskCreationStartupReconcilerWiring.test.ts") {
        continue; // this file's own assertions above name the retired path.
      }
      const content = fs.readFileSync(file, "utf8");
      assert.ok(
        !content.includes("legacyCreatingStartupGateV0"),
        `${path.relative(REPO_ROOT, file)} still references the retired module path legacyCreatingStartupGateV0`
      );
    }
  });
});
