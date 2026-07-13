import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import { STAGE_ARTIFACT_FILENAMES, TaskStage } from "../types/taskProgress";

export interface StageResponseScope {
  workspaceUri: vscode.Uri;
  artifactWorkspacePath: string;
  /**
   * Path basis used for partitioning, dirty snapshots, and git restore.
   * Git reports porcelain paths relative to the repository root, not
   * necessarily the open VS Code workspace folder.
   */
  artifactScopePath: string;
  gitRootFsPath: string | undefined;
  workspacePrefix: string;
}

export type StageResponseSnapshot = Map<string, string>;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function joinRelativePath(prefix: string, relPath: string): string {
  const normalized = normalizeRelativePath(relPath);
  if (!prefix) {
    return normalized;
  }
  return normalized ? `${prefix}/${normalized}` : prefix;
}

function execGit(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout)
    );
  });
}

async function resolveGitRoot(workspaceUri: vscode.Uri): Promise<string | undefined> {
  const output = await execGit(workspaceUri.fsPath, ["rev-parse", "--show-toplevel"]);
  return output?.trim() || undefined;
}

/**
 * The single workspace-relative path (forward-slash normalized) that
 * "Respond to AI" is allowed to touch for a given stage.
 */
export function resolveStageResponseScopePath(
  workspaceUri: vscode.Uri,
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): string {
  const filename = STAGE_ARTIFACT_FILENAMES[stage];
  if (!filename) {
    throw new Error(`No artifact file is defined for stage "${stage}".`);
  }
  return normalizeRelativePath(
    nodePath.relative(workspaceUri.fsPath, nodePath.join(taskFolderUri.fsPath, filename))
  );
}

export async function resolveStageResponseScope(
  workspaceUri: vscode.Uri,
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<StageResponseScope> {
  const artifactWorkspacePath = resolveStageResponseScopePath(
    workspaceUri,
    taskFolderUri,
    stage
  );
  const gitRootFsPath = await resolveGitRoot(workspaceUri);
  const workspacePrefix = gitRootFsPath
    ? normalizeRelativePath(nodePath.relative(gitRootFsPath, workspaceUri.fsPath))
    : "";
  return {
    workspaceUri,
    artifactWorkspacePath,
    artifactScopePath: joinRelativePath(workspacePrefix, artifactWorkspacePath),
    gitRootFsPath,
    workspacePrefix,
  };
}

export function scopePathToWorkspacePath(
  scope: StageResponseScope,
  scopePath: string
): string {
  const normalized = normalizeRelativePath(scopePath);
  if (!scope.workspacePrefix) {
    return normalized;
  }
  if (normalized === scope.workspacePrefix) {
    return "";
  }
  const prefix = `${scope.workspacePrefix}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

export function scopePathsToWorkspacePaths(
  scope: StageResponseScope,
  scopePaths: readonly string[]
): string[] {
  return scopePaths.map((file) => scopePathToWorkspacePath(scope, file));
}

/**
 * Copilot tracks changed files relative to the VS Code workspace. CLI runners
 * detect changes through git status, whose porcelain paths are repo-root
 * relative. Convert both to the scope basis before partitioning/reverting.
 */
export function normalizeStageResponseChangedFiles(
  filesChanged: readonly string[],
  scope: StageResponseScope,
  runnerId: string
): string[] {
  const fromWorkspace = runnerId === "copilot-lm";
  return filesChanged.map((file) =>
    fromWorkspace
      ? joinRelativePath(scope.workspacePrefix, file)
      : normalizeRelativePath(file)
  );
}

/** Splits changed scope-relative paths into the allowed one and the rest. */
export function partitionScopedFiles(
  filesChanged: readonly string[],
  allowedPath: string
): { kept: string[]; outOfScope: string[] } {
  const kept: string[] = [];
  const outOfScope: string[] = [];
  for (const file of filesChanged) {
    (file === allowedPath ? kept : outOfScope).push(file);
  }
  return { kept, outOfScope };
}

interface PorcelainEntry {
  status: string;
  path: string;
}

function parsePorcelainZEntries(statusOutput: string): PorcelainEntry[] {
  const parsed: PorcelainEntry[] = [];
  const entries = statusOutput.split("\0");
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    index++;
    if (entry.length < 4) {
      continue;
    }

    const status = entry.substring(0, 2);
    const filePath = normalizeRelativePath(entry.substring(3));
    if (filePath) {
      parsed.push({ status, path: filePath });
    }

    if (
      (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") &&
      entries[index]
    ) {
      parsed.push({ status, path: normalizeRelativePath(entries[index]!) });
      index++;
    }
  }
  return parsed;
}

/**
 * Fingerprinted git dirty/untracked state. This is intentionally scoped to
 * paths git already reports as changed; clean tracked files do not need a
 * fingerprint because they will appear in the post-run snapshot if a run
 * changes them.
 */
export async function snapshotStageResponseState(
  scope: StageResponseScope
): Promise<StageResponseSnapshot | undefined> {
  const gitRootFsPath = scope.gitRootFsPath;
  if (!gitRootFsPath) {
    return undefined;
  }
  const output = await execGit(gitRootFsPath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (output === undefined) {
    return undefined;
  }

  const entries = parsePorcelainZEntries(output);
  const snapshot: StageResponseSnapshot = new Map();
  const hashResults = await Promise.all(
    entries.map((entry) =>
      execGit(gitRootFsPath, ["hash-object", "--", entry.path])
    )
  );
  entries.forEach((entry, index) => {
    const hash = hashResults[index]?.trim();
    snapshot.set(entry.path, hash ? `${entry.status}:${hash}` : entry.status);
  });
  return snapshot;
}

export function changedStageResponsePathsSince(
  before: StageResponseSnapshot,
  after: StageResponseSnapshot
): string[] {
  const paths = new Set<string>();
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) {
      paths.add(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/**
 * Scope-relative paths that already had uncommitted changes (or were already
 * untracked) before a run. Undefined when git is unavailable.
 */
export async function snapshotDirtyPaths(
  scope: StageResponseScope
): Promise<Set<string> | undefined> {
  const snapshot = await snapshotStageResponseState(scope);
  return snapshot ? new Set(snapshot.keys()) : undefined;
}

function gitCheckoutFromHead(cwd: string, relPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["checkout", "HEAD", "--", relPath],
      { cwd, windowsHide: true },
      (error) => resolve(!error)
    );
  });
}

/**
 * Best-effort revert of files a "Respond to AI" run touched outside its
 * allowed artifact. Callers must first exclude any path snapshotDirtyPaths
 * found already dirty before the run.
 */
export async function revertOutOfScopeFiles(
  scope: StageResponseScope,
  outOfScope: readonly string[]
): Promise<{ restored: string[]; deleted: string[]; failed: string[] }> {
  const cwd = scope.gitRootFsPath ?? scope.workspaceUri.fsPath;
  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const relPath of outOfScope) {
    if (!relPath || relPath === ".") {
      failed.push(relPath);
      continue;
    }
    if (await gitCheckoutFromHead(cwd, relPath)) {
      restored.push(relPath);
      continue;
    }
    try {
      nodeFs.rmSync(nodePath.join(cwd, relPath), { recursive: true, force: true });
      deleted.push(relPath);
    } catch {
      failed.push(relPath);
    }
  }
  return { restored, deleted, failed };
}
