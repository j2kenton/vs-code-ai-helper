import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  DEFAULT_TASK_ROOT,
  getActiveLegacyTaskRoot,
  getConfiguredTaskRoot,
  isTaskRootExplicitlyConfigured,
  setActiveLegacyTaskRoot,
} from "./taskRoot";
import { NotificationRouter } from "./notificationRouter";
import { ensureAutomaticMetaGitIgnore } from "../commands/toggleMetaResourcesGitIgnore";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const DECLINED_KEY = "ensemble.metaMigration.declined";
const LEGACY_ACTIVE_ROOT_KEY = "ensemble.metaMigration.legacyActiveRoot";
const LEGACY_ROOTS = [".helper/plans", "plans"];

/** A folder counts as holding task state when any direct child has task.md. */
function hasTaskState(root: string): boolean {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(root, entry.name, "task.md"))
      );
  } catch {
    return false;
  }
}

/**
 * Locate the legacy resource folder that should be offered for migration:
 * an explicitly configured non-default `metaResourcesPath`, or one of the
 * historical implicit roots, provided it actually contains task state.
 * `.ensemble` itself is never a migration source.
 */
export function findLegacyResourceRoot(workspaceRoot: string): string | undefined {
  const configured = getConfiguredTaskRoot();
  const activeLegacy = getActiveLegacyTaskRoot();
  if (
    (isTaskRootExplicitlyConfigured() || activeLegacy !== undefined) &&
    configured !== DEFAULT_TASK_ROOT
  ) {
    const absolute = path.isAbsolute(configured)
      ? configured
      : path.join(workspaceRoot, configured);
    if (
      path.resolve(absolute) !== path.resolve(workspaceRoot, DEFAULT_TASK_ROOT) &&
      hasTaskState(absolute)
    ) {
      return absolute;
    }
  }
  for (const legacy of LEGACY_ROOTS) {
    const absolute = path.join(workspaceRoot, legacy);
    if (hasTaskState(absolute)) {
      return absolute;
    }
  }
  return undefined;
}

/**
 * Keep an unmigrated legacy root *active* (not merely discoverable): persist
 * it and route `getConfiguredTaskRoot()` to it so task creation and every
 * direct-root consumer stay on the legacy location instead of splitting the
 * workspace between it and `.ensemble`. Stored workspace-relative when the
 * root lives inside the workspace so the record survives a workspace move.
 */
async function keepLegacyRootActive(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  legacyRoot: string
): Promise<void> {
  const relative = path.relative(workspaceRoot, legacyRoot);
  const stored =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : legacyRoot;
  await context.workspaceState.update(LEGACY_ACTIVE_ROOT_KEY, stored);
  setActiveLegacyTaskRoot(stored);
}

async function clearActiveLegacyRoot(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.workspaceState.update(LEGACY_ACTIVE_ROOT_KEY, undefined);
  setActiveLegacyTaskRoot(undefined);
}

/**
 * Re-establish the persisted "declined migration keeps the legacy location"
 * state for this session. Runs on the activation-time (non-forced) offer
 * path: an earlier decline that recorded a legacy root makes that root the
 * active one again, and a decline recorded before the root was persisted is
 * healed by re-detecting it. A root that no longer holds task state is
 * dropped so the workspace falls back to `.ensemble` cleanly.
 */
async function restoreActiveLegacyRoot(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const stored = context.workspaceState.get<string>(LEGACY_ACTIVE_ROOT_KEY);
  if (stored) {
    const absolute = path.isAbsolute(stored)
      ? stored
      : path.join(workspaceRoot, stored);
    if (hasTaskState(absolute)) {
      setActiveLegacyTaskRoot(stored);
      return;
    }
    await clearActiveLegacyRoot(context);
    return;
  }
  const detected = findLegacyResourceRoot(workspaceRoot);
  if (detected) {
    await keepLegacyRootActive(context, workspaceRoot, detected);
  }
}

async function clearMetaResourcesPathSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  for (const target of [
    vscode.ConfigurationTarget.WorkspaceFolder,
    vscode.ConfigurationTarget.Workspace,
    vscode.ConfigurationTarget.Global,
  ]) {
    try {
      await config.update(META_RESOURCES_PATH_KEY, undefined, target);
    } catch {
      // A target that isn't applicable (e.g. no multi-root workspace) throws;
      // the remaining targets are still cleared.
    }
  }
}

/**
 * Offer to move a legacy Ensemble resource folder to the fixed `.ensemble`
 * location. The move is atomic (fs.rename): it aborts — and the legacy
 * location stays the *active* resource root — when `.ensemble` already
 * exists with content or the rename fails. Declining is recorded internally
 * (and likewise keeps the legacy root active, so creation and reads never
 * split across two roots) and the prompt is never repeated; the "Move
 * Ensemble Resources to .ensemble" command re-offers explicitly.
 */
export async function maybeOfferMetaResourcesMigration(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  // Retained for call-site stability; the automatic .gitignore maintenance
  // this migration triggers no longer needs the task-selection store.
  _currentTaskStore: CurrentTaskStore,
  force = false
): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    if (force) {
      void vscode.window.showWarningMessage("Open a workspace folder first.");
    }
    return;
  }
  if (!force && context.workspaceState.get<boolean>(DECLINED_KEY) === true) {
    // A declined migration means "keep using the legacy location" — make the
    // recorded legacy root the active one for this session, not just a
    // discovery fallback.
    await restoreActiveLegacyRoot(context, workspace.uri.fsPath);
    return;
  }

  const workspaceRoot = workspace.uri.fsPath;
  const legacyRoot = findLegacyResourceRoot(workspaceRoot);
  if (!legacyRoot) {
    await clearActiveLegacyRoot(context);
    if (force) {
      NotificationRouter.showInformation(
        "No legacy Ensemble resource folder with task state was found; resources already live in .ensemble."
      );
    }
    return;
  }

  const target = path.join(workspaceRoot, DEFAULT_TASK_ROOT);
  const choice = await vscode.window.showInformationMessage(
    `Move Ensemble resources from "${path.relative(workspaceRoot, legacyRoot) || legacyRoot}" to "${DEFAULT_TASK_ROOT}"? ` +
      "Task state and artifacts move with the folder.",
    "Move",
    "Not Now"
  );
  if (choice !== "Move") {
    // Internal compatibility record only — no configuration UI. Re-offered
    // exclusively via the migrateMetaResources command. Declining means
    // "keep using the legacy location": the legacy root stays the active
    // resource root for creation and all direct-root consumers.
    await context.workspaceState.update(DECLINED_KEY, true);
    await keepLegacyRootActive(context, workspaceRoot, legacyRoot);
    return;
  }

  try {
    if (fs.existsSync(target)) {
      const conflicting = fs.readdirSync(target).length > 0;
      if (conflicting) {
        void vscode.window.showErrorMessage(
          `Could not move Ensemble resources: "${DEFAULT_TASK_ROOT}" already exists with content. ` +
            "The legacy location remains in use; resolve the conflict manually and run " +
            '"Ensemble: Move Ensemble Resources to .ensemble" again.'
        );
        await keepLegacyRootActive(context, workspaceRoot, legacyRoot);
        return;
      }
      fs.rmdirSync(target);
    }
    // Atomic on the same volume: either the whole tree moves or nothing does.
    fs.renameSync(legacyRoot, target);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not move Ensemble resources to "${DEFAULT_TASK_ROOT}": ${
        error instanceof Error ? error.message : String(error)
      }. The legacy location remains in use.`
    );
    await keepLegacyRootActive(context, workspaceRoot, legacyRoot);
    return;
  }

  await clearMetaResourcesPathSetting();
  await context.workspaceState.update(DECLINED_KEY, undefined);
  await clearActiveLegacyRoot(context);
  // Rebuild the managed .gitignore block against the new folder so the old
  // path's block does not linger.
  await context.workspaceState.update("ensemble.autoGitIgnoreApplied", undefined);
  await ensureAutomaticMetaGitIgnore(context);
  await inventory.refresh();
  NotificationRouter.showInformation(
    `Ensemble resources moved to "${DEFAULT_TASK_ROOT}".`
  );
}

export function registerMetaResourcesMigrationCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.migrateMetaResources", () =>
      maybeOfferMetaResourcesMigration(context, inventory, currentTaskStore, true)
    )
  );
}
