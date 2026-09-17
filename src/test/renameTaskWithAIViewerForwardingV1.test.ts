/**
 * Rename Task with AI in a viewer runs on the runner, not here.
 *
 * Pinned at the REGISTRATION level on purpose: the defect this covers was
 * that the command was registered without the viewer wrapper, so the naming
 * run was refused by the host gate while the operation still reported
 * "completed" and the name never changed (seen live 2026-09-17). Calling
 * `renameTaskWithAI` directly — as the other rename tests do — can never
 * catch that.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { registerRenameTaskCommands } from "../commands/renameTask";
import { configureEnsembleHostRoleForTestV1 } from "../state/hostRoleV1";
import { configureViewerCommandForwarderV1 } from "../services/viewerForwardingV1";
import { TaskInventory } from "../state/taskInventory";

const commandsForTest = vscode.commands as unknown as {
  _handlers: Map<string, (...args: unknown[]) => unknown>;
};

void describe("renameTaskWithAI in a viewer", () => {
  afterEach(() => {
    configureEnsembleHostRoleForTestV1(undefined);
    configureViewerCommandForwarderV1(undefined);
    commandsForTest._handlers.delete("vs-code-ai-helper.renameTaskWithAI");
    commandsForTest._handlers.delete("vs-code-ai-helper.renameTask");
  });

  void it("forwards the registered command to the runner, with the task it was invoked for", async () => {
    configureEnsembleHostRoleForTestV1("viewer");
    const forwarded: Array<[string, string | undefined]> = [];
    configureViewerCommandForwarderV1((commandId, taskFolderPath) => {
      forwarded.push([commandId, taskFolderPath]);
      return Promise.resolve(true);
    });
    const context = { subscriptions: [] as { dispose(): void }[] } as unknown as vscode.ExtensionContext;
    registerRenameTaskCommands(context, new TaskInventory());

    const handler = commandsForTest._handlers.get("vs-code-ai-helper.renameTaskWithAI");
    assert.ok(handler, "the command must be registered");
    // A tree row's argument shape, which is how the button invokes it.
    await handler({ task: { folderUri: { fsPath: "/w/.ensemble/2026-09-17_task_1" } } });

    assert.deepEqual(forwarded, [
      ["vs-code-ai-helper.renameTaskWithAI", "/w/.ensemble/2026-09-17_task_1"],
    ]);
  });
});
