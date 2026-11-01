import * as vscode from "vscode";
import { NotificationRouter } from "../utils/notificationRouter";
import { isAutoImplementConfirmedV1, recordAutoImplementConfirmedV1 } from "../config/settings";

/**
 * One switch for how much Ensemble runs on its own. Out of the box every
 * automation setting is off, so each review, advance and implementation is a
 * click. Turning them on one by one means finding five settings; this command
 * sets them together, and "Supervised" sets them back to their defaults.
 *
 * Unattended makes code changes without asking (Fast Forward applies review
 * fixes, and Implementation starts by itself), so the user must accept that
 * warning BEFORE anything is written; declining changes nothing. The
 * acceptance is the same per-machine acknowledgement the "Automatically
 * implement" setting asks for, so that setting's own warning does not ask
 * again.
 *
 * Both levels are written as explicit values in user settings, and any
 * workspace or workspace-folder value for the same keys in the OPEN
 * workspace is removed: a workspace override would otherwise win, and a
 * cleared user value would let an old `vs-code-ai-helper.*` value come back.
 * Another project's own workspace settings cannot be reached from here, so
 * the notice says the level applies to user settings and this workspace.
 * The effective values are read back afterwards, and the notice says if any
 * did not take.
 */
export const UNATTENDED_SETTINGS_V1: ReadonlyArray<readonly [string, string]> = [
  ["autoReviewAfterPlan", "auto-fast-forward"],
  ["autoReviewAfterImplementation", "auto-fast-forward"],
  ["autoAdvanceEnabled", "auto-fast-forward"],
  ["completeAndMoveOnTriggersAI", "auto-fast-forward"],
  ["autoImplementAfterReview", "auto"],
];

/** The shipped defaults for the same keys (package.json). */
export const SUPERVISED_SETTINGS_V1: ReadonlyArray<readonly [string, string]> = [
  ["autoReviewAfterPlan", "off"],
  ["autoReviewAfterImplementation", "off"],
  ["autoAdvanceEnabled", "off"],
  ["completeAndMoveOnTriggersAI", "auto"],
  ["autoImplementAfterReview", "off"],
];

type AutomationLevelV1 = "unattended" | "supervised";

const SECTION = "ensemble";

/** One setting value at one scope, as it was before this command wrote anything. */
interface PriorValueV1 {
  readonly key: string;
  readonly target: vscode.ConfigurationTarget;
  readonly folder?: vscode.Uri;
  readonly value: unknown;
}

/**
 * Write `values` as user settings, remove workspace and folder overrides of
 * the same keys, and return the keys whose effective value still differs
 * (with where), plus how many overrides were removed.
 *
 * All or nothing: if any write fails, every value already written is put
 * back as it was and `failed` carries the error, so a half-applied level
 * (for example Supervised with Fast Forward still on) can never be left
 * behind.
 */
export async function applyAutomationSettingsV1(
  values: ReadonlyArray<readonly [string, string]>
): Promise<{ removedOverrides: number; notApplied: string[]; failed?: string; notRestored?: string[] }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const prior: PriorValueV1[] = [];
  for (const [key] of values) {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect(key);
    prior.push({ key, target: vscode.ConfigurationTarget.Global, value: inspected?.globalValue });
    prior.push({ key, target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue });
    for (const folder of folders) {
      const folderValue = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect(key)?.workspaceFolderValue;
      prior.push({ key, target: vscode.ConfigurationTarget.WorkspaceFolder, folder: folder.uri, value: folderValue });
    }
  }

  let removedOverrides = 0;
  try {
    for (const [key, value] of values) {
      const root = vscode.workspace.getConfiguration(SECTION);
      if (root.inspect(key)?.workspaceValue !== undefined) {
        await root.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        removedOverrides++;
      }
      for (const folder of folders) {
        const scoped = vscode.workspace.getConfiguration(SECTION, folder.uri);
        if (scoped.inspect(key)?.workspaceFolderValue !== undefined) {
          await scoped.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
          removedOverrides++;
        }
      }
      await root.update(key, value, vscode.ConfigurationTarget.Global);
    }
  } catch (error) {
    for (const entry of prior) {
      try {
        await vscode.workspace.getConfiguration(SECTION, entry.folder).update(entry.key, entry.value, entry.target);
      } catch {
        // Keep restoring the rest; the read-back below reports what stuck.
      }
    }
    // Read every scope back: a restore can fail too, and the notice must
    // never claim settings were left alone when one of them was not.
    const notRestored: string[] = [];
    for (const entry of prior) {
      const inspected = vscode.workspace.getConfiguration(SECTION, entry.folder).inspect(entry.key);
      const now =
        entry.target === vscode.ConfigurationTarget.Global
          ? inspected?.globalValue
          : entry.target === vscode.ConfigurationTarget.Workspace
            ? inspected?.workspaceValue
            : inspected?.workspaceFolderValue;
      if (JSON.stringify(now) !== JSON.stringify(entry.value)) {
        const where =
          entry.target === vscode.ConfigurationTarget.Global
            ? "user settings"
            : entry.target === vscode.ConfigurationTarget.Workspace
              ? "workspace settings"
              : `folder ${vscode.workspace.getWorkspaceFolder(entry.folder!)?.name ?? entry.folder!.fsPath}`;
        notRestored.push(`ensemble.${entry.key} in ${where} is now ${JSON.stringify(now) ?? "unset"}, was ${JSON.stringify(entry.value) ?? "unset"}`);
      }
    }
    return {
      removedOverrides: 0,
      notApplied: [],
      failed: error instanceof Error ? error.message : String(error),
      ...(notRestored.length > 0 ? { notRestored } : {}),
    };
  }
  const notApplied: string[] = [];
  for (const [key, value] of values) {
    const scopes = folders.length > 0 ? folders.map((folder) => folder.uri) : [undefined];
    for (const scope of scopes) {
      if (vscode.workspace.getConfiguration(SECTION, scope).get(key) !== value) {
        notApplied.push(scope ? `${key} (${vscode.workspace.getWorkspaceFolder(scope)?.name ?? scope.fsPath})` : key);
      }
    }
  }
  return { removedOverrides, notApplied };
}

export async function chooseAutomationLevelV1(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Supervised",
        description: "default",
        detail: "Each review, stage advance and implementation round starts when you click it.",
        level: "supervised" as const,
      },
      {
        label: "Unattended",
        detail:
          "Reviews follow plans and implementations, passing reviews move the task on, Fast Forward applies review " +
          "fixes until the stop level, and Implementation starts by itself.",
        level: "unattended" as const,
      },
    ],
    { title: "How much should Ensemble run on its own?", placeHolder: "Choose an automation level" }
  );
  if (!picked) {
    return;
  }
  const level: AutomationLevelV1 = picked.level;

  if (level === "unattended" && !isAutoImplementConfirmedV1(context)) {
    const choice = await vscode.window.showWarningMessage(
      "Unattended mode makes real code and file changes without asking: Fast Forward applies review fixes and " +
        "Implementation rounds start by themselves. Use it only with continuous human supervision.",
      { modal: true },
      "Enable Unattended Mode"
    );
    if (choice !== "Enable Unattended Mode") {
      return;
    }
    await recordAutoImplementConfirmedV1(context);
  }

  const { removedOverrides, notApplied, failed, notRestored } = await applyAutomationSettingsV1(
    level === "unattended" ? UNATTENDED_SETTINGS_V1 : SUPERVISED_SETTINGS_V1
  );
  if (failed !== undefined) {
    NotificationRouter.showWarning(
      notRestored === undefined
        ? `Ensemble could not change the automation level, so it left every setting as it was: ${failed}`
        : `Ensemble could not change the automation level (${failed}), and could not put these settings back: ` +
            `${notRestored.join("; ")}. Fix them in Settings (search "ensemble.") before relying on the automation level.`
    );
    return;
  }
  if (notApplied.length > 0) {
    NotificationRouter.showWarning(
      `Ensemble could not set the automation level everywhere; these settings still have another value: ` +
        `${notApplied.join(", ")}. Check them in Settings (search "ensemble.").`
    );
    return;
  }
  const overrides =
    removedOverrides > 0
      ? ` Removed ${removedOverrides} workspace setting override${removedOverrides === 1 ? "" : "s"} that would have kept the old behaviour.`
      : "";
  const elsewhere =
    " This applies to your user settings and this workspace. Another project with its own Ensemble " +
    "automation settings keeps them until you run this command there too.";
  NotificationRouter.showInformation(
    level === "unattended"
      ? `Ensemble is set to run unattended.${overrides}${elsewhere} Choose "Supervised" with the same command to turn it off.`
      : `Ensemble is set to supervised: nothing starts until you click it.${overrides}${elsewhere}`
  );
}

export function registerChooseAutomationLevelCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.chooseAutomationLevel", () => chooseAutomationLevelV1(context))
  );
}
