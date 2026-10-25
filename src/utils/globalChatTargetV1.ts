/**
 * Resolve the Global Assistant chat target without importing the view layer
 * or the assistant's send command (both would make a command → util → view
 * import cycle for the pre-task pickers Part 2 converts to global chat).
 *
 * Mirrors `resolveGlobalAssistantTarget` in openGeneralAssistant.ts; the
 * folder lives under the task root beside the per-task folders.
 */
import * as vscode from "vscode";
import { GLOBAL_ASSISTANT_CANONICAL_ID } from "./chatHistoryConstants";
import { resolveTaskRootForCreation } from "./taskRoot";

const GLOBAL_ASSISTANT_DIRNAME = "global-assistant";

export interface GlobalChatTargetV1 {
  canonicalId: string;
  taskFolderPath: string;
  stage: "desc";
  taskName: string;
  kind: "global";
}

export async function resolveGlobalChatTargetV1(): Promise<GlobalChatTargetV1 | undefined> {
  try {
    const root = await resolveTaskRootForCreation();
    const folder = vscode.Uri.joinPath(vscode.Uri.file(root), GLOBAL_ASSISTANT_DIRNAME);
    return {
      canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      taskFolderPath: folder.fsPath,
      stage: "desc",
      taskName: "Global Assistant",
      kind: "global",
    };
  } catch {
    return undefined;
  }
}

export async function resolveGlobalChatTargetOrDefaultV1(
  baseFolderPath?: string
): Promise<GlobalChatTargetV1> {
  if (baseFolderPath) {
    return {
      canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      taskFolderPath: vscode.Uri.joinPath(vscode.Uri.file(baseFolderPath), GLOBAL_ASSISTANT_DIRNAME).fsPath,
      stage: "desc",
      taskName: "Global Assistant",
      kind: "global",
    };
  }
  return (
    (await resolveGlobalChatTargetV1()) ?? {
      canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      taskFolderPath: GLOBAL_ASSISTANT_DIRNAME,
      stage: "desc",
      taskName: "Global Assistant",
      kind: "global",
    }
  );
}
