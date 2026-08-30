import * as vscode from "vscode";
// plan-final.md's constant is (confusingly) named IMPLEMENTATION_FILENAME —
// PLAN_FILENAME is plan.md, the pre-review draft. See taskProgress.ts's doc
// comment on IMPLEMENTATION_FILENAME.
import { IMPLEMENTATION_FILENAME as PLAN_FINAL_FILENAME } from "../types/taskProgress";
import { readTextIfExists, safeOpenTextDocument } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";

const ACCEPTED_NON_GOALS_HEADING_RE = /^##\s+Accepted Non-Goals\s*$/m;

export interface OpenPlanNonGoalsArg {
  readonly taskFolderPath: string;
}

/**
 * The `reconsiderRequirement` escalation option's effect (see
 * `buildEscalationDecisionV1` in reviewEscalation.ts): open `plan-final.md`
 * and reveal its `## Accepted Non-Goals` section when one exists, instead of
 * leaving the user to find it themselves after being told to "review the
 * plan's non-goals and prior decisions".
 */
export async function openPlanNonGoalsV1(arg?: OpenPlanNonGoalsArg): Promise<void> {
  if (!arg?.taskFolderPath) {
    return;
  }
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const planUri = vscode.Uri.joinPath(folderUri, PLAN_FINAL_FILENAME);
  const content = await readTextIfExists(planUri);
  if (content === undefined) {
    NotificationRouter.showInformation(`${PLAN_FINAL_FILENAME} does not exist yet for this task.`);
    return;
  }
  const opened = await safeOpenTextDocument(planUri, PLAN_FINAL_FILENAME);
  if (!opened) {
    return;
  }
  const match = ACCEPTED_NON_GOALS_HEADING_RE.exec(content);
  if (!match) {
    NotificationRouter.showInformation(
      `${PLAN_FINAL_FILENAME} has no "## Accepted Non-Goals" section yet — showing the top of the file.`
    );
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== planUri.toString()) {
    return;
  }
  const position = editor.document.positionAt(match.index);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
}

/**
 * The `handleMyself` escalation option's effect (see
 * `buildEscalationDecisionV1` in reviewEscalation.ts): open `plan-final.md`
 * plainly, without jumping to any particular section — distinct from
 * `openPlanNonGoalsV1`, which reveals the `## Accepted Non-Goals` heading.
 * Keeping the two separate keeps "Leave it paused — I'll fix it" (review the
 * whole plan, make whatever change is needed) and "Change the plan instead"
 * (jump straight to the non-goals the plan already recorded) distinguishable
 * rather than two buttons that land on the same view.
 */
export async function openPlanFinalV1(arg?: OpenPlanNonGoalsArg): Promise<void> {
  if (!arg?.taskFolderPath) {
    return;
  }
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const planUri = vscode.Uri.joinPath(folderUri, PLAN_FINAL_FILENAME);
  const content = await readTextIfExists(planUri);
  if (content === undefined) {
    NotificationRouter.showInformation(`${PLAN_FINAL_FILENAME} does not exist yet for this task.`);
    return;
  }
  await safeOpenTextDocument(planUri, PLAN_FINAL_FILENAME);
}

export function registerOpenPlanNonGoalsCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.openPlanNonGoals",
    (arg?: OpenPlanNonGoalsArg) => openPlanNonGoalsV1(arg)
  );
  context.subscriptions.push(disposable);
  const disposablePlanFinal = vscode.commands.registerCommand(
    "vs-code-ai-helper.openPlanFinal",
    (arg?: OpenPlanNonGoalsArg) => openPlanFinalV1(arg)
  );
  context.subscriptions.push(disposablePlanFinal);
}
