import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME } from "../types/taskProgress";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
export const DEFAULT_TASK_ROOT = ".ensemble";
const LEGACY_DEFAULT_TASK_ROOT = ".helper/plans";
const LEGACY_TASK_ROOT = "plans";
const LEGACY_TASK_ROOTS = [LEGACY_DEFAULT_TASK_ROOT, LEGACY_TASK_ROOT];

/**
 * Represents a discovered task root candidate for scanning
 */
export interface TaskRootCandidate {
  /** Absolute path to the root directory */
  absolutePath: string;
  /** Whether this root is explicitly configured vs defaulted */
  isExplicit: boolean;
  /** Source workspace folder URI, if applicable */
  workspaceFolder?: vscode.Uri;
  /** Source scope key for duplicate suppression */
  sourceScopeKey: string;
}

/**
 * Represents a valid discovered task folder
 */
export interface DiscoveredTask {
  /** Absolute path to the task folder */
  taskFolderPath: string;
  /** Task folder name (e.g., "2026-07-06_task_1") */
  folderName: string;
  /** Canonical identity key (normalized absolute path) */
  canonicalId: string;
  /** Source scope key for duplicate suppression */
  sourceScopeKey: string;
  /** Owning workspace folder, if applicable */
  workspaceFolder?: vscode.Uri;
}

/**
 * Determine whether the meta resources path setting is explicitly configured.
 * Returns true only when workspaceFolderValue, workspaceValue, or globalValue
 * is present.
 */
export function isTaskRootExplicitlyConfigured(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspection = config.inspect<string>(META_RESOURCES_PATH_KEY);
  if (!inspection) {
    return false;
  }
  return !!(
    inspection.workspaceFolderValue !== undefined ||
    inspection.workspaceValue !== undefined ||
    inspection.globalValue !== undefined
  );
}

/**
 * The legacy resource root that stays *active* (not just discoverable) while
 * the workspace remains unmigrated: set by metaResourcesMigration.ts when the
 * user declines the move to `.ensemble` (or the move aborts), cleared once
 * the migration succeeds. While set, task creation and every direct-root
 * consumer keep using the legacy location, so declining never splits the
 * workspace between two roots. Session-scoped; re-established on activation
 * from the persisted migration state.
 */
let activeLegacyTaskRoot: string | undefined;

export function setActiveLegacyTaskRoot(root: string | undefined): void {
  const trimmed = root?.trim();
  activeLegacyTaskRoot = trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getActiveLegacyTaskRoot(): string | undefined {
  return activeLegacyTaskRoot;
}

/**
 * The active task-root path. Fixed at `.ensemble` for every new workspace;
 * a leftover legacy `metaResourcesPath` value is honored read-only, and a
 * declined/aborted migration keeps its legacy root active (see
 * setActiveLegacyTaskRoot above), so an unmigrated workspace keeps using
 * its tasks' existing location until the one-time migration to `.ensemble`
 * runs (metaResourcesMigration.ts). The setting is no longer contributed,
 * surfaced in any UI, or written anywhere — this compatibility read is the
 * only remaining reference.
 */
export function getConfiguredTaskRoot(): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const value = config.get<string>(META_RESOURCES_PATH_KEY, "");

  if (value && value.trim().length > 0) {
    return value.trim();
  }

  if (activeLegacyTaskRoot) {
    return activeLegacyTaskRoot;
  }

  return DEFAULT_TASK_ROOT;
}

/**
 * Normalize a path for comparison: resolve to absolute, normalize separators,
 * and on Windows, lowercase for case-insensitive comparison.
 *
 * This is the canonical task identity rule. `taskOperations.taskKey` delegates
 * here so operation lookups can never drift from `canonicalId`.
 */
export function normalizePath(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve task root candidates from the current workspace configuration.
 * Returns absolute paths to scan for task folders.
 */
export function resolveTaskRootCandidates(): TaskRootCandidate[] {
  const candidates: TaskRootCandidate[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders || [];

  if (workspaceFolders.length === 0) {
    return candidates;
  }

  const configuredRoot = getConfiguredTaskRoot();
  const isExplicit = isTaskRootExplicitlyConfigured();
  const isAbsolute = path.isAbsolute(configuredRoot);

  if (isAbsolute) {
    // Absolute configured root: use as-is, single candidate
    candidates.push({
      absolutePath: normalizePath(configuredRoot),
      isExplicit,
      sourceScopeKey: normalizePath(configuredRoot),
    });
  } else {
    // Relative configured root: resolve against each workspace folder
    for (const ws of workspaceFolders) {
      const wsPath = ws.uri.fsPath;
      const resolved = path.join(wsPath, configuredRoot);
      candidates.push({
        absolutePath: normalizePath(resolved),
        isExplicit,
        workspaceFolder: ws.uri,
        sourceScopeKey: normalizePath(wsPath),
      });
    }
  }

  // Always discover historical implicit roots as compatibility fallbacks.
  // New task creation defaults to `.ensemble`, but older workspaces may have
  // tasks under `.helper/plans` or the first-generation `plans` root.
  for (const ws of workspaceFolders) {
    const wsPath = ws.uri.fsPath;
    for (const legacyRoot of LEGACY_TASK_ROOTS) {
      const legacyPath = path.join(wsPath, legacyRoot);
      const legacyNormalized = normalizePath(legacyPath);

      // Only add if different from configured candidate
      const alreadyIncluded = candidates.some(
        (c) => c.absolutePath === legacyNormalized
      );
      if (!alreadyIncluded) {
        candidates.push({
          absolutePath: legacyNormalized,
          isExplicit: false,
          workspaceFolder: ws.uri,
          sourceScopeKey: normalizePath(wsPath),
        });
      }
    }
  }

  return candidates;
}

/**
 * Discover all valid task folders under a single root candidate.
 * A folder is valid if it is a direct child and contains task.md.
 */
async function discoverTasksInRoot(
  candidate: TaskRootCandidate
): Promise<DiscoveredTask[]> {
  const tasks: DiscoveredTask[] = [];

  try {
    const rootUri = vscode.Uri.file(candidate.absolutePath);
    const entries = await vscode.workspace.fs.readDirectory(rootUri);

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }

      const taskFolderPath = path.join(candidate.absolutePath, name);
      const taskMdPath = path.join(taskFolderPath, TASK_FILENAME);

      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(taskMdPath));
        // task.md exists, this is a valid task
        tasks.push({
          taskFolderPath: normalizePath(taskFolderPath),
          folderName: name,
          canonicalId: normalizePath(taskFolderPath),
          sourceScopeKey: candidate.sourceScopeKey,
          workspaceFolder: candidate.workspaceFolder,
        });
      } catch {
        // No task.md, skip this folder
      }
    }
  } catch {
    // Root doesn't exist, return empty
  }

  return tasks;
}

/**
 * Discover all valid tasks across all root candidates, applying duplicate
 * suppression rules.
 */
export async function discoverAllTasks(): Promise<DiscoveredTask[]> {
  const candidates = resolveTaskRootCandidates();
  const allDiscovered: DiscoveredTask[] = [];

  for (const candidate of candidates) {
    const tasks = await discoverTasksInRoot(candidate);
    allDiscovered.push(...tasks);
  }

  // Duplicate suppression: merge by sourceScopeKey + folderName
  const mergeKeyMap = new Map<string, DiscoveredTask>();

  for (const task of allDiscovered) {
    const mergeKey = `${task.sourceScopeKey}:${task.folderName}`;
    const existing = mergeKeyMap.get(mergeKey);

    if (!existing) {
      mergeKeyMap.set(mergeKey, task);
      continue;
    }

    // Prefer explicit root, then the current default, then lexically smaller path.
    const existingIsExplicit = candidates.find(c =>
      existing.taskFolderPath.startsWith(c.absolutePath)
    )?.isExplicit ?? false;

    const taskIsExplicit = candidates.find(c =>
      task.taskFolderPath.startsWith(c.absolutePath)
    )?.isExplicit ?? false;

    if (taskIsExplicit && !existingIsExplicit) {
      mergeKeyMap.set(mergeKey, task);
    } else if (!taskIsExplicit && existingIsExplicit) {
      // Keep existing
    } else {
      // Both same explicit-ness, prefer the current default over legacy roots.
      const existingIsDefault = existing.taskFolderPath.includes(DEFAULT_TASK_ROOT);
      const taskIsDefault = task.taskFolderPath.includes(DEFAULT_TASK_ROOT);

      if (taskIsDefault && !existingIsDefault) {
        mergeKeyMap.set(mergeKey, task);
      } else if (!taskIsDefault && existingIsDefault) {
        // Keep existing
      } else {
        // Lexical tiebreak
        if (task.canonicalId < existing.canonicalId) {
          mergeKeyMap.set(mergeKey, task);
        }
      }
    }
  }

  // Sort by folder name descending
  const visible = Array.from(mergeKeyMap.values());
  visible.sort((a, b) => b.folderName.localeCompare(a.folderName));

  return visible;
}

/**
 * Resolve the task root path for task creation. Returns the absolute path
 * to the root directory, creating it if necessary.
 */
export async function resolveTaskRootForCreation(
  targetWorkspaceFolder?: vscode.WorkspaceFolder
): Promise<string> {
  const configuredRoot = getConfiguredTaskRoot();
  const isAbsolute = path.isAbsolute(configuredRoot);

  let resolvedRoot: string;

  if (isAbsolute) {
    resolvedRoot = configuredRoot;
  } else {
    const ws = targetWorkspaceFolder || vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      throw new Error(
        "Cannot create task with relative root: no workspace folder available."
      );
    }
    resolvedRoot = path.join(ws.uri.fsPath, configuredRoot);
  }

  // Create the root directory if it doesn't exist
  const rootUri = vscode.Uri.file(resolvedRoot);
  try {
    await vscode.workspace.fs.createDirectory(rootUri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create task root directory: ${message}`);
  }

  return resolvedRoot;
}
