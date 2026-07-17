/**
 * Extension-host smoke suite. The stub-based unit tests cover the critical
 * command chain's logic, but explicitly cannot exercise a packaged extension
 * host: real activation from the bundled entry point (dist/extension.js),
 * the real command registry, and real TreeView registration. This suite runs
 * inside an actual downloaded VS Code instance via `npm run test:host`
 * (@vscode/test-cli + @vscode/test-electron; see .vscode-test.mjs).
 */
import * as assert from "assert";
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
  "vs-code-ai-helper.markTaskDone",
  "vs-code-ai-helper.commitAndPushTask",
  "vs-code-ai-helper.completeCommitAndPushTask",
  "vs-code-ai-helper.cancelOperation",
  "vs-code-ai-helper.chatWithStage",
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
});
