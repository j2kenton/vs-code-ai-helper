import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";

/**
 * Accepted argument shapes for chatWithStage.
 * - Tree-view stage node passes { task: IncompleteTask, stage: TaskStage }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath?, stage? }
 */
type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage };

/**
 * Normalize a command argument into the shape resolveTaskContext expects,
 * plus the requested stage.
 */
function normalizeArg(node: ChatWithStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined;
} {
  if (!node) {
    return { resolverArg: undefined, stage: undefined };
  }

  if ("task" in node && node.task) {
    return {
      resolverArg: { taskFolderPath: node.task.folderUri.fsPath },
      stage: node.stage,
    };
  }

  const n = node as {
    canonicalId?: string;
    taskFolderPath?: string;
    stage?: TaskStage;
  };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return {
    resolverArg: hasExplicit
      ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
      : undefined,
    stage: n.stage,
  };
}

/**
 * Open a chat interface to communicate with the AI model assigned to a specific stage.
 * This allows users to provide feedback, ask questions, or request modifications
 * to the current stage's output without re-running the entire stage.
 */
export async function chatWithStage(
  inventory: TaskInventory,
  explicitArg?: ChatWithStageArg
): Promise<void> {
  const { resolverArg, stage } = normalizeArg(explicitArg);

  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No task found. Please select a task first."
    );
    return;
  }

  const stageName = STAGE_DISPLAY_NAMES[stage ?? resolvedTask.progress.currentStage];

  // Get the message from the user
  const message = await vscode.window.showInputBox({
    prompt: `Chat with ${stageName} AI`,
    placeHolder: "Type your message to the AI...",
    ignoreFocusOut: true,
  });

  if (!message) {
    return;
  }

  void vscode.window.showInformationMessage(
    `Chat with stage feature is coming soon. Your message: "${message}"`
  );

  // TODO: Implement actual chat functionality
  // This would involve:
  // 1. Loading the stage's assigned model
  // 2. Loading the stage's current context (artifact, task description, etc.)
  // 3. Sending the user's message to the model
  // 4. Displaying the response
  // 5. Optionally updating the stage's artifact based on the conversation
}

/**
 * Register the chatWithStage command.
 */
export function registerChatWithStageCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage",
    (arg?: ChatWithStageArg) =>
      chatWithStage(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
