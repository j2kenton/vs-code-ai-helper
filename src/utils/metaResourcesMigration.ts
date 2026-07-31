import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { TaskInventory } from "../state/taskInventory";
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
import { TaskProgress } from "../types/taskProgress";
import { readTaskProgress, writeTaskProgress } from "./taskProgressUtils";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const DECLINED_KEY = "ensemble.metaMigration.declined";
const LEGACY_ACTIVE_ROOT_KEY = "ensemble.metaMigration.legacyActiveRoot";
const LEGACY_ROOTS = [".helper/plans", "plans"];
/**
 * Phase-one provenance journal for a legacy meta-root move (see
 * repairLegacyOwnership): written before the atomic root rename and removed
 * only after every ownership record is rewritten, so it can survive a crash
 * inside any migrated root. The privacy classifier
 * (services/workflowPrivacyClassifierV1.ts) keeps a literal copy of this name
 * in its workflow-control set (this module imports the VS Code API, which the
 * classifier must stay free of); its unit test pins that copy against this
 * export so the two cannot drift silently.
 */
export const MIGRATION_JOURNAL_FILENAME = ".ensemble-migration.json";

interface MigrationJournal { from: string; to: string; at: string; }

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isUnder(child: string, parent: string): boolean {
  const normalizedChild = path.resolve(child);
  const normalizedParent = path.resolve(parent);
  const left = process.platform === "win32" ? normalizedChild.toLowerCase() : normalizedChild;
  const right = process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent;
  return left === right || left.startsWith(right + path.sep);
}

function readJournal(root: string): MigrationJournal | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, MIGRATION_JOURNAL_FILENAME), "utf8")) as Partial<MigrationJournal>;
    return typeof parsed.from === "string" && typeof parsed.to === "string" && typeof parsed.at === "string"
      ? { from: parsed.from, to: parsed.to, at: parsed.at }
      : undefined;
  } catch (error) {
    // A journal is the authorization record for custom-root repairs. Do not
    // treat corruption as proof, but leave an actionable diagnostic instead
    // of making it indistinguishable from an absent journal.
    if (fs.existsSync(path.join(root, MIGRATION_JOURNAL_FILENAME))) {
      console.warn(`Could not read Ensemble migration journal in ${root}; ownership will not be repaired automatically.`, error);
    }
    return undefined;
  }
}

/**
 * Repair only provenance-backed ownership after a legacy root was moved.
 *
 * The migration journal is phase-one evidence: it is written before the
 * atomic root rename and travels with that rename. Phase two rewrites every
 * applicable task ownership record and removes the journal only after a pass
 * with no failures. Therefore a crash before the rename leaves no moved
 * state, while a crash after it leaves deterministic, on-disk authorization
 * for this lazy repair. A missing old root alone is never authorization.
 */
export async function repairLegacyOwnership(
  taskFolderPath: string,
  progress: TaskProgress,
  resolvedTaskRootPath: string
): Promise<{ repaired: boolean; progress: TaskProgress }> {
  const ownership = progress.ownership;
  if (!ownership?.metaRoot) return { repaired: false, progress };
  const oldRoot = path.resolve(ownership.metaRoot);
  const newRoot = path.resolve(resolvedTaskRootPath);
  // A repair is specifically for a task that moved from its recorded root
  // into the currently resolved root. Do not bless a task which is still in
  // its old location, or an arbitrary direct child passed by a caller.
  if (isUnder(taskFolderPath, oldRoot) || !isUnder(taskFolderPath, newRoot)) {
    return { repaired: false, progress };
  }
  const legacyByLocation = LEGACY_ROOTS.some((legacy) =>
    samePath(ownership.metaRoot, path.join(ownership.projectRoot ?? ownership.workspaceRoot ?? "", legacy))
  );
  const journal = readJournal(resolvedTaskRootPath);
  const journalMatches = !!journal && samePath(journal.from, ownership.metaRoot) && samePath(journal.to, resolvedTaskRootPath);
  if (!legacyByLocation && !journalMatches) return { repaired: false, progress };
  // The root candidate can have different casing from a task URI on
  // Windows. This is the same direct-parent check used to make nested roots
  // unambiguous, so it must follow the platform-aware comparison rule too.
  if (!samePath(path.dirname(path.resolve(taskFolderPath)), newRoot)) {
    return { repaired: false, progress };
  }
  const rewriteRootedPath = (value: string | undefined): string | undefined =>
    value && isUnder(value, oldRoot) ? path.join(resolvedTaskRootPath, path.relative(oldRoot, value)) : value;
  const repaired: TaskProgress = {
    ...progress,
    ownership: {
      ...ownership,
      metaRoot: resolvedTaskRootPath,
      projectRoot: rewriteRootedPath(ownership.projectRoot) ?? ownership.projectRoot,
      workspaceRoot: rewriteRootedPath(ownership.workspaceRoot),
    },
  };
  await writeTaskProgress(vscode.Uri.file(taskFolderPath), repaired);
  await removeJournalIfOwnershipRewriteIsComplete(resolvedTaskRootPath);
  return { repaired: true, progress: repaired };
}

/**
 * A lazy repair can be the final phase-two rewrite after a crash or a failed
 * pass. Remove the provenance journal only when every direct task folder now
 * has a readable progress record rooted at this metadata directory.
 */
async function removeJournalIfOwnershipRewriteIsComplete(target: string): Promise<void> {
  if (!fs.existsSync(path.join(target, MIGRATION_JOURNAL_FILENAME))) return;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const progress = await readTaskProgress(vscode.Uri.file(path.join(target, entry.name)));
      if (!progress || !samePath(progress.ownership?.metaRoot ?? "", target)) return;
    }
    fs.unlinkSync(path.join(target, MIGRATION_JOURNAL_FILENAME));
  } catch (error) {
    // Preserve recovery evidence if the completeness check itself cannot
    // finish. A later migration or lazy repair retries the same safe check.
    console.error(`Could not finalize Ensemble ownership migration in ${target}`, error);
  }
}

/**
 * Phase two of the journal-backed move. The journal is removed only after
 * every task whose recorded root is stale has been repaired; tasks already
 * rooted at `target` are not rewrites and do not keep recovery state alive.
 */
export async function finishMigrationOwnershipRewrite(target: string): Promise<boolean> {
  let completed = true;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskFolder = path.join(target, entry.name);
    const progress = await readTaskProgress(vscode.Uri.file(taskFolder));
    if (!progress) {
      completed = false;
      console.error(`Could not read moved task ownership for ${taskFolder}`);
      continue;
    }
    try {
      const result = await repairLegacyOwnership(taskFolder, progress, target);
      if (!result.repaired && progress.ownership?.metaRoot && !samePath(progress.ownership.metaRoot, target)) {
        completed = false;
        console.error(`Could not verify moved task ownership for ${taskFolder}`);
      }
    } catch (error) {
      completed = false;
      console.error(`Could not repair moved task ownership for ${taskFolder}`, error);
    }
  }
  if (completed) {
    try { fs.unlinkSync(path.join(target, MIGRATION_JOURNAL_FILENAME)); } catch { /* no journal */ }
  }
  return completed;
}

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
  // Activation-order barrier (plan §1.4): the migration reads and can
  // rewrite task-progress ownership across the meta root, so it must never
  // run while the startup creating-folder classification pass is still
  // running. The activation-time offer already chains on startupGateReady;
  // this covers the explicit "Move Ensemble Resources" command route.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    if (force) {
      NotificationRouter.showWarning("Open a workspace folder first.");
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
        NotificationRouter.showError(
          `Could not move Ensemble resources: "${DEFAULT_TASK_ROOT}" already exists with content. ` +
            "The legacy location remains in use; resolve the conflict manually and run " +
            '"Ensemble: Move Ensemble Resources to .ensemble" again.'
        );
        await keepLegacyRootActive(context, workspaceRoot, legacyRoot);
        return;
      }
      fs.rmdirSync(target);
    }
    // The journal moves with the directory, allowing a later activation to
    // prove ownership before repairing a crash-interrupted phase two.
    fs.writeFileSync(path.join(legacyRoot, MIGRATION_JOURNAL_FILENAME), JSON.stringify({
      from: path.resolve(legacyRoot), to: path.resolve(target), at: new Date().toISOString(),
    }));
    // Atomic on the same volume: either the whole tree moves or nothing does.
    fs.renameSync(legacyRoot, target);
  } catch (error) {
    NotificationRouter.showError(
      `Could not move Ensemble resources to "${DEFAULT_TASK_ROOT}": ${
        error instanceof Error ? error.message : String(error)
      }. The legacy location remains in use.`
    );
    await keepLegacyRootActive(context, workspaceRoot, legacyRoot);
    return;
  }

  await finishMigrationOwnershipRewrite(target);

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
