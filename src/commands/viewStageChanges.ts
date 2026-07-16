import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { StageNode } from "../views/taskTreeProvider";
import { STAGE_ARTIFACT_FILENAMES, TaskStage } from "../types/taskProgress";
import { previousVersionUri, hasPreviousVersion } from "../utils/artifactBackups";
import { resolveCurrentPlanUri } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";

async function artifactFor(node: StageNode): Promise<vscode.Uri | undefined> {
  if (node.stage === "plan") return resolveCurrentPlanUri(node.task.folderUri);
  const filename = STAGE_ARTIFACT_FILENAMES[node.stage as TaskStage];
  return filename ? vscode.Uri.joinPath(node.task.folderUri, filename) : undefined;
}

export function registerViewStageChangesCommands(context: vscode.ExtensionContext, _inventory: TaskInventory): void {
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.viewStageChanges", async (node?: StageNode) => {
    if (!node) return;
    const artifact = await artifactFor(node);
    if (!artifact || !(await hasPreviousVersion(artifact))) {
      NotificationRouter.showInformation(
        "No previous version is available for this stage yet.",
        artifact?.fsPath
      );
      return;
    }
    await vscode.commands.executeCommand("vscode.diff", previousVersionUri(artifact), artifact, `${artifact.path.split("/").pop()} — previous ↔ current`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("vs-code-ai-helper.deleteStageBackup", async (node?: StageNode) => {
    if (!node) return;
    const artifact = await artifactFor(node);
    if (!artifact || !(await hasPreviousVersion(artifact))) {
      NotificationRouter.showInformation("No previous version is available to delete.", artifact?.fsPath);
      return;
    }
    await vscode.workspace.fs.delete(previousVersionUri(artifact), { useTrash: true });
    NotificationRouter.showInformation("Previous version deleted.", artifact.fsPath);
  }));
}
