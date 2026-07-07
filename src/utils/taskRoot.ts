import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME } from "../types/taskProgress";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const DEFAULT_TASK_ROOT = ".helper/plans";
const LEGACY_TASK_ROOT = "plans";

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
 * Get the configured task root. Returns the explicit value if configured,
 * otherwise returns the default `.helper/plans`.
 */
export function getConfiguredTaskRoot(): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const value = config.get<string>(META_RESOURCES_PATH_KEY, "");

  if (value && value.trim().length > 0) {
    return value.trim();
  }

  return DEFAULT_TASK_ROOT;
}

/**
 * Normalize a path for comparison: resolve to absolute, normalize separators,
 * and on Windows, lowercase for case-insensitive comparison.
 */
function normalizePath(p: string): string {
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

  // If root is unset/defaulted, also discover legacy plans/
  if (!isExplicit) {
    for (const ws of workspaceFolders) {
      const wsPath = ws.uri.fsPath;
      const legacyPath = path.join(wsPath, LEGACY_TASK_ROOT);
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
  } else {
    // If root is explicitly configured, still check legacy if different
    for (const ws of workspaceFolders) {
      const wsPath = ws.uri.fsPath;
      const legacyPath = path.join(wsPath, LEGACY_TASK_ROOT);
      const legacyNormalized = normalizePath(legacyPath);

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

    // Prefer explicit root, then .helper/plans, then lexically smaller path
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
      // Both same explicit-ness, prefer .helper/plans over plans/
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
    throw new Error(`Failed to create task root directory: ${error}`);
  }

  return resolvedRoot;
}
