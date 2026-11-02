/**
 * bugs5 Step 11 (optional part of item 2): VS Code's extension auto-update restarts the extension host
 * and kills a long run. When a run that usually takes over five minutes starts and auto-update is
 * not switched off, say so once per window session and say how to prevent it. Ensemble reads the
 * setting only; it never changes it.
 */
import * as vscode from "vscode";
import { appendChatMessageV1 } from "./chatHistoryStore";

export const LONG_RUN_AUTO_UPDATE_THRESHOLD_MINUTES_V1 = 5;

export const AUTO_UPDATE_WARNING_TEXT_V1 =
  "VS Code may update Ensemble during this run, which stops it. To prevent that, turn off Auto Update for Ensemble in the Extensions view.";

let warnedThisSessionV1 = false;

/** Test hook: forget that the warning was already posted in this window session. */
export function resetAutoUpdateWarningSessionV1(): void {
  warnedThisSessionV1 = false;
}

/** The setting says updates may be applied automatically unless it is exactly `false`. */
export function autoUpdateMayRestartExtensionsV1(settingValue: unknown): boolean {
  return settingValue !== false;
}

/** Whether the warning is due now: a long run, auto-update not off, not already shown this session. */
export function shouldWarnAboutAutoUpdateV1(input: {
  readonly expectedMinutes: number | undefined;
  readonly autoUpdateSetting: unknown;
  readonly alreadyWarned: boolean;
}): boolean {
  return (
    !input.alreadyWarned &&
    (input.expectedMinutes ?? 0) > LONG_RUN_AUTO_UPDATE_THRESHOLD_MINUTES_V1 &&
    autoUpdateMayRestartExtensionsV1(input.autoUpdateSetting)
  );
}

/** Post the warning to the task's chat when it is due. Returns whether a line was posted. */
export async function maybeWarnAboutAutoUpdateV1(input: {
  readonly taskFolderPath: string;
  readonly expectedMinutes: number | undefined;
  readonly stage?: "publish" | "impl" | "plan" | "desc";
  readonly now?: () => Date;
}): Promise<boolean> {
  let setting: unknown;
  try {
    setting = vscode.workspace.getConfiguration("extensions").get("autoUpdate");
  } catch {
    return false;
  }
  if (!shouldWarnAboutAutoUpdateV1({ expectedMinutes: input.expectedMinutes, autoUpdateSetting: setting, alreadyWarned: warnedThisSessionV1 })) {
    return false;
  }
  warnedThisSessionV1 = true;
  try {
    await appendChatMessageV1(
      input.taskFolderPath,
      {
        role: "assistant",
        text: AUTO_UPDATE_WARNING_TEXT_V1,
        stage: input.stage ?? "publish",
        at: (input.now ?? ((): Date => new Date()))().toISOString(),
      },
      input.taskFolderPath
    );
    return true;
  } catch (error) {
    console.warn("[autoUpdateWarning] Could not post the warning", error);
    return false;
  }
}
