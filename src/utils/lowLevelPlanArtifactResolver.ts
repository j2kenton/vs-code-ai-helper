/**
 * Centralizes the canonical low-level plan artifact path (plan-low.md).
 * All reads, writes, and open paths for the Low-Level Plan stage must use
 * this resolver.
 */
import * as vscode from "vscode";
import { LOW_LEVEL_PLAN_FILENAME } from "../types/taskProgress";

/**
 * Returns the canonical low-level plan artifact URI for a task folder.
 */
export function getLowLevelPlanUri(taskFolderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, LOW_LEVEL_PLAN_FILENAME);
}
