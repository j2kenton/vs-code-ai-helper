/**
 * bugs4 Step 32 (item 31): "Enable <model> and rerun the fix". The Publish fix-round card offers
 * this when the chain ran out of quota or payment and a configured backup is only switched off.
 * It flips that one row flag (the owner's own configured model, nothing new), then reruns the fix.
 * It never edits a permission file or a provider account, and a model it cannot switch on from
 * here ends in a chat card naming the reason, not a pop-up.
 */
import * as vscode from "vscode";
import { getModelSettings, setModelSettings } from "../config/settings";
import { enableChainModelV1, ENABLE_PUBLISH_BACKUP_AND_RERUN_FIX_COMMAND_V1 } from "../utils/enableChainModelV1";
import { chainModelReadinessProbeV1 } from "../utils/chainModelReadinessV1";
import { offerLintFixRecoveryInChatV1 } from "./runLintingFixes";

export interface EnablePublishBackupArgV1 {
  readonly taskFolderPath?: string;
  readonly modelLabel?: string;
  readonly taskLabel?: string;
}

export async function enablePublishBackupAndRerunFixV1(arg?: EnablePublishBackupArgV1): Promise<void> {
  const taskFolderPath = arg?.taskFolderPath;
  const modelLabel = arg?.modelLabel?.trim();
  if (taskFolderPath === undefined || taskFolderPath === "" || modelLabel === undefined || modelLabel === "") return;
  const taskLabel = arg?.taskLabel ?? "This task";
  const settings = getModelSettings();
  const result = enableChainModelV1(settings.publish, modelLabel);
  if (result.kind !== "enabled") {
    const why =
      result.kind === "already-enabled"
        ? `${modelLabel} is already switched on in the Publish chain, so something outside that row keeps it out (for example Provider Selection, or its sign-in).`
        : `${modelLabel} is not in the Publish chain any more.`;
    await offerLintFixRecoveryInChatV1(
      taskFolderPath,
      taskLabel,
      `Nothing was changed and no fix was started: ${why} Open AI Models to choose a Publish model.`,
      false,
      { chainBlock: "quota" }
    );
    return;
  }
  // The card only offers a backup whose provider could run, but sign-in can lapse before the click.
  // Check again so a model that would fail the same way is never switched on.
  const readiness = await chainModelReadinessProbeV1()(result.modelId).catch((error: unknown) => ({
    ready: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (!readiness.ready) {
    await offerLintFixRecoveryInChatV1(
      taskFolderPath,
      taskLabel,
      `Nothing was changed and no fix was started: ${modelLabel} would not run yet (${readiness.reason ?? "its provider is not available or not signed in"}). ` +
        "Sign in to that provider or choose another Publish model in AI Models.",
      false,
      { chainBlock: "auth" }
    );
    return;
  }
  await setModelSettings({ ...settings, publish: result.setting });
  await vscode.commands.executeCommand("vs-code-ai-helper.runLintingFixes", { taskFolderPath });
}

export function registerEnablePublishBackupCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_PUBLISH_BACKUP_AND_RERUN_FIX_COMMAND_V1, (arg?: EnablePublishBackupArgV1) =>
      enablePublishBackupAndRerunFixV1(arg)
    )
  );
}
