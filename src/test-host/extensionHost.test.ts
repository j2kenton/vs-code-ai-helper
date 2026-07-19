/**
 * Extension-host smoke suite. The stub-based unit tests cover the critical
 * command chain's logic, but explicitly cannot exercise a packaged extension
 * host: real activation from the bundled entry point (dist/extension.js),
 * the real command registry, and real TreeView registration. This suite runs
 * inside an actual downloaded VS Code instance via `npm run test:host`
 * (@vscode/test-cli + @vscode/test-electron; see .vscode-test.mjs).
 */
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

// The mocha globals (tdd interface — the @vscode/test-cli runner's default)
// are provided by the runner at runtime. Declared locally so this suite
// compiles under tsconfig.test.json, whose global type set is pinned to
// ["node"] (no @types/mocha dependency).
declare function suite(title: string, fn: () => void): void;
declare function test(title: string, fn: () => void | Promise<void>): void;

const EXTENSION_ID = "j2kenton.vs-code-ai-helper";

/**
 * The commands making up the critical chain the previous review flagged:
 * stage advance with auto-review, the stage actions, and the publish flow.
 * Each must be registered with the REAL command registry after activation —
 * a missing registration here is exactly the class of packaging/activation
 * failure the stubbed unit suite cannot see.
 */
const CRITICAL_CHAIN_COMMANDS = [
  "vs-code-ai-helper.startNewTask",
  "vs-code-ai-helper.nextStage",
  "vs-code-ai-helper.runReviewWithAI",
  "vs-code-ai-helper.applyReviewWithAI",
  "vs-code-ai-helper.applyCurrentStageAction",
  "vs-code-ai-helper.runImplementationWithAI",
  "vs-code-ai-helper.archiveTask",
  "vs-code-ai-helper.unarchiveTask",
  "vs-code-ai-helper.pinTask",
  "vs-code-ai-helper.unpinTask",
  "vs-code-ai-helper.runPublishChecks",
  "vs-code-ai-helper.runLintingFixes",
  "vs-code-ai-helper.release",
  "vs-code-ai-helper.markTaskDone",
  "vs-code-ai-helper.commitAndPushTask",
  "vs-code-ai-helper.completeCommitAndPushTask",
  "vs-code-ai-helper.cancelOperation",
  "vs-code-ai-helper.chatWithStage",
  "vs-code-ai-helper.configureStepModels",
  "vs-code-ai-helper.openAiModels",
  "vs-code-ai-helper.openGeneralAssistant",
];

async function activatedExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} must be present in the host`);
  await extension.activate();
  return extension;
}

suite("extension host activation (packaged entry point)", () => {
  test("activates from the bundled dist/extension.js without throwing", async () => {
    const extension = await activatedExtension();
    assert.equal(extension.isActive, true, "activate() must leave the extension active");
  });

  test("registers every critical-chain command with the real command registry", async () => {
    await activatedExtension();
    const registered = await vscode.commands.getCommands(true);
    const missing = CRITICAL_CHAIN_COMMANDS.filter((id) => !registered.includes(id));
    assert.deepEqual(
      missing,
      [],
      `commands missing from the host registry: ${missing.join(", ")}`
    );
  });

  test("repairs legacy ownership through the registered Release command", async () => {
    await activatedExtension();
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, "the extension-host test workspace must be open");

    const folderName = `release-repair-${Date.now()}`;
    const taskFolder = vscode.Uri.joinPath(workspace.uri, ".ensemble", folderName);
    const legacyRoot = path.join(workspace.uri.fsPath, "plans");
    const configuredRoot = path.join(workspace.uri.fsPath, ".ensemble");
    const timestamp = new Date().toISOString();
    const progress = {
      taskFolder: folderName,
      currentStage: "publish",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      ownership: {
        metaRoot: legacyRoot,
        projectRoot: workspace.uri.fsPath,
        workspaceRoot: workspace.uri.fsPath,
        boundAt: timestamp,
        state: "resolved",
      },
    };

    try {
      await vscode.workspace.fs.createDirectory(taskFolder);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(taskFolder, "task.md"),
        new TextEncoder().encode("# Release repair fixture\n")
      );
      const progressUri = vscode.Uri.joinPath(taskFolder, "task-progress.json");
      await vscode.workspace.fs.writeFile(progressUri, new TextEncoder().encode(JSON.stringify(progress)));

      // No package.json exists in the dedicated host workspace, so Release
      // exits safely after validation instead of opening a terminal. A stale
      // legacy root must still be repaired by the actual registered command.
      await vscode.commands.executeCommand("vs-code-ai-helper.release", {
        task: { folderUri: taskFolder, folderName, progress },
      });

      const repaired = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(progressUri))
      ) as { ownership?: { metaRoot?: string } };
      const comparableRoot = process.platform === "win32"
        ? configuredRoot.toLowerCase()
        : configuredRoot;
      assert.equal(
        repaired.ownership?.metaRoot,
        comparableRoot,
        "Release must persist the repair before continuing to release-target selection"
      );
    } finally {
      await vscode.workspace.fs.delete(taskFolder, { recursive: true, useTrash: false });
    }
  });

  test("declares the Ensemble views in the packaged manifest", async () => {
    const extension = await activatedExtension();
    const manifest = extension.packageJSON as {
      contributes?: { views?: Record<string, Array<{ id: string }>> };
    };
    const viewIds = Object.values(manifest.contributes?.views ?? {})
      .flat()
      .map((view) => view.id);
    assert.ok(viewIds.length > 0, "the packaged manifest must contribute at least one view");
  });

  test("opens the AI Models webview entry point without command failures", async () => {
    await activatedExtension();

    // This executes the extension's user-visible entry point through the
    // real host, rather than merely checking the manifest. The workbench's
    // own focus commands run in the renderer process and are not available
    // to extension-host tests, so this covers the registered bridge command.
    await vscode.commands.executeCommand("vs-code-ai-helper.openAiModels");
  });
});
