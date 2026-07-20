import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import { getConfiguredTaskRoot } from "../utils/taskRoot";
import { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME } from "../utils/chatHistoryConstants";

const MANAGED_BEGIN = "# BEGIN Ensemble managed meta resources";
const MANAGED_END = "# END Ensemble managed meta resources";
const MANAGED_NOTE = "# Managed by Ensemble. Do not edit this block manually.";
const LEGACY_COMMENT = "# Ensemble meta resources";
const LEGACY_DEFAULT_TASK_ROOT = ".helper/plans";
const LEGACY_TASK_ROOT = "plans";
const ARTIFACTS_ROOT = "artifacts/helper";

type Eol = "\n" | "\r\n";

interface ManagedBlock {
  start: number;
  end: number;
  lines: string[];
}

interface CurrentMetaGitIgnoreTarget {
  repoRoot: string;
  gitignoreUri: vscode.Uri;
  patterns: string[];
  legacyRootPatterns: string[];
  /** Chat-transcript ignore patterns (Option A staging policy) that must
   * survive "Show Meta Files" — see ApplyManagedMetaGitIgnoreOptions.persistentPatterns. */
  persistentPatterns: string[];
}

interface ApplyManagedMetaGitIgnoreOptions {
  legacyRootPatterns?: readonly string[];
  /**
   * Patterns that must remain in the managed block even when `hidden` is
   * false. Used for chat-transcript basenames (chat-v1.json,
   * chat-v1.corrupt.json): the transcript staging policy (Option A) commits
   * to never staging a transcript regardless of whether task-root folders
   * are otherwise visible in git, so "Show Meta Files" replaces the managed
   * block with a transcripts-only block instead of removing it outright.
   */
  persistentPatterns?: readonly string[];
}

function detectEol(content: string): Eol {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split(/\r?\n/);
}

function stripSingleTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function toGitignorePattern(repoRoot: string, absolutePath: string): string | undefined {
  const relative = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return `/${relative.replace(/\/+$/, "")}/`;
}

function resolveConfiguredTaskRootPath(repoRoot: string): string | undefined {
  const configured = getConfiguredTaskRoot();
  if (!configured || configured.trim().length === 0) {
    return undefined;
  }
  return path.isAbsolute(configured)
    ? configured
    : path.join(repoRoot, configured);
}

/** @deprecated Legacy per-task migration helper. New managed blocks use only workspace roots. */
export function buildManagedIgnorePatterns(
  repoRoot: string,
  taskFolderPath: string,
  configuredTaskRootPath: string | undefined
): string[] {
  const patterns = new Set<string>();
  const actual = toGitignorePattern(repoRoot, taskFolderPath);
  if (actual) {
    patterns.add(actual);
  }

  const folderName = path.basename(taskFolderPath);
  if (configuredTaskRootPath) {
    const configuredPattern = toGitignorePattern(
      repoRoot,
      path.join(configuredTaskRootPath, folderName)
    );
    if (configuredPattern) {
      patterns.add(configuredPattern);
    }
  }

  const legacyPattern = toGitignorePattern(
    repoRoot,
    path.join(repoRoot, LEGACY_TASK_ROOT, folderName)
  );
  if (legacyPattern) {
    patterns.add(legacyPattern);
  }

  const legacyDefaultPattern = toGitignorePattern(
    repoRoot,
    path.join(repoRoot, LEGACY_DEFAULT_TASK_ROOT, folderName)
  );
  if (legacyDefaultPattern) {
    patterns.add(legacyDefaultPattern);
  }

  return [...patterns].sort();
}

function toLegacyRootPatternVariants(
  repoRoot: string,
  absolutePath: string
): string[] {
  const relative = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return [];
  }

  const withoutTrailingSlash = `/${relative.replace(/\/+$/, "")}`;
  return [withoutTrailingSlash, `${withoutTrailingSlash}/`];
}

export function buildLegacyMetaRootIgnorePatterns(
  repoRoot: string,
  configuredTaskRootPath: string | undefined
): string[] {
  const patterns = new Set<string>();
  const roots = [
    configuredTaskRootPath,
    path.join(repoRoot, LEGACY_DEFAULT_TASK_ROOT),
    path.join(repoRoot, LEGACY_TASK_ROOT),
    path.join(repoRoot, ARTIFACTS_ROOT),
  ].filter((root): root is string => !!root);

  for (const root of roots) {
    for (const pattern of toLegacyRootPatternVariants(repoRoot, root)) {
      patterns.add(pattern);
    }
  }

  return [...patterns].sort();
}

function findManagedBlocks(lines: string[]): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() !== MANAGED_BEGIN) {
      index++;
      continue;
    }

    const start = index;
    let end = index + 1;
    while (end < lines.length && lines[end]?.trim() !== MANAGED_END) {
      end++;
    }

    if (end >= lines.length) {
      index = start + 1;
      continue;
    }

    blocks.push({ start, end, lines: lines.slice(start, end + 1) });
    index = end + 1;
  }

  return blocks;
}

function removeManagedBlocksFromLines(lines: string[]): string[] {
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() !== MANAGED_BEGIN) {
      output.push(lines[index] ?? "");
      index++;
      continue;
    }

    const start = index;
    let end = index + 1;
    while (end < lines.length && lines[end]?.trim() !== MANAGED_END) {
      end++;
    }

    if (end >= lines.length) {
      output.push(lines[index] ?? "");
      index = start + 1;
      continue;
    }

    if (output.length > 0 && output[output.length - 1]?.trim() === "") {
      output.pop();
    }

    index = end + 1;

    if (
      index < lines.length &&
      lines[index]?.trim() === "" &&
      output.length > 0 &&
      output[output.length - 1]?.trim() === ""
    ) {
      index++;
    }
  }

  while (output.length > 0 && output[output.length - 1]?.trim() === "") {
    output.pop();
  }

  return output;
}

function hasLegacyMetaResourcesEntry(
  lines: readonly string[],
  legacyRootPatterns: readonly string[]
): boolean {
  const legacyPatterns = new Set(legacyRootPatterns.map((line) => line.trim()));
  if (legacyPatterns.size === 0) {
    return false;
  }

  for (let index = 0; index < lines.length - 1; index++) {
    if (
      lines[index]?.trim() === LEGACY_COMMENT &&
      legacyPatterns.has(lines[index + 1]?.trim() ?? "")
    ) {
      return true;
    }
  }

  return false;
}

function removeLegacyMetaResourcesEntriesFromLines(
  lines: string[],
  legacyRootPatterns: readonly string[]
): string[] {
  const legacyPatterns = new Set(legacyRootPatterns.map((line) => line.trim()));
  if (legacyPatterns.size === 0) {
    return lines;
  }

  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (
      lines[index]?.trim() !== LEGACY_COMMENT ||
      !legacyPatterns.has(lines[index + 1]?.trim() ?? "")
    ) {
      output.push(lines[index] ?? "");
      index++;
      continue;
    }

    if (output.length > 0 && output[output.length - 1]?.trim() === "") {
      output.pop();
    }

    index++;
    while (index < lines.length && legacyPatterns.has(lines[index]?.trim() ?? "")) {
      index++;
    }
  }

  while (output.length > 0 && output[output.length - 1]?.trim() === "") {
    output.pop();
  }

  return output;
}

function renderManagedBlock(patterns: readonly string[]): string[] {
  return [MANAGED_BEGIN, MANAGED_NOTE, ...patterns, MANAGED_END];
}

/**
 * True when `pattern` is already ignored by one of `rootPatterns` — i.e. some
 * root pattern is a directory ignore (`/foo/`) and `pattern` falls under it.
 * Used to drop the transcript-specific persistent patterns
 * (`/.ensemble/star-star/chat-v1.json`) when the task-root pattern itself
 * (`/.ensemble/`) is already in the block: a nested pattern under an already
 * fully-ignored directory adds nothing and is confusing clutter.
 */
function isCoveredByIgnoredRoot(
  pattern: string,
  rootPatterns: readonly string[]
): boolean {
  return rootPatterns.some(
    (root) => root.endsWith("/") && pattern.startsWith(root)
  );
}

export function applyManagedMetaGitIgnoreBlock(
  content: string,
  patterns: readonly string[],
  hidden: boolean,
  options: ApplyManagedMetaGitIgnoreOptions = {}
): string {
  const eol = detectEol(content);
  const lines = splitLines(content);
  const hasManagedBlock =
    findManagedBlocks(stripSingleTrailingEmptyLine(lines)).length > 0;
  const hasLegacyBlock = hasLegacyMetaResourcesEntry(
    lines,
    options.legacyRootPatterns ?? []
  );
  const persistentPatterns = options.persistentPatterns ?? [];

  if (!hidden && !hasManagedBlock && !hasLegacyBlock) {
    return content;
  }

  const withoutLegacy = removeLegacyMetaResourcesEntriesFromLines(
    lines,
    options.legacyRootPatterns ?? []
  );
  const withoutManaged = removeManagedBlocksFromLines(withoutLegacy);

  if (!hidden) {
    if (persistentPatterns.length === 0) {
      return withoutManaged.length > 0 ? `${withoutManaged.join(eol)}${eol}` : "";
    }
    // "Show Meta Files" would otherwise remove the block outright, exposing
    // the task-root folders (and everything transitively ignored under
    // them, transcripts included) to git. Patterns that must survive
    // regardless of visibility state replace the block instead of removing
    // it — isManagedMetaGitIgnoreHidden still reports "not hidden" here
    // because it keys on the root `patterns`, not these.
    const nextLines = [...withoutManaged];
    if (nextLines.length > 0) {
      nextLines.push("");
    }
    nextLines.push(...renderManagedBlock(persistentPatterns));
    return `${nextLines.join(eol)}${eol}`;
  }

  // A persistent pattern already covered by one of the root `patterns`
  // (e.g. /.ensemble/**/chat-v1.json under /.ensemble/) is redundant here —
  // the root pattern already ignores everything beneath it. It only earns
  // its keep in the "Show Meta Files" branch above, where the root pattern
  // is removed but the transcript files must still stay ignored.
  const nonRedundantPersistent = persistentPatterns.filter(
    (pattern) => !isCoveredByIgnoredRoot(pattern, patterns)
  );
  const nextLines = [...withoutManaged];
  if (nextLines.length > 0) {
    nextLines.push("");
  }
  nextLines.push(...renderManagedBlock([...new Set([...patterns, ...nonRedundantPersistent])]));
  return `${nextLines.join(eol)}${eol}`;
}

export function isManagedMetaGitIgnoreHidden(
  content: string,
  patterns: readonly string[],
  options: ApplyManagedMetaGitIgnoreOptions = {}
): boolean {
  const required = new Set(patterns);
  const lines = stripSingleTrailingEmptyLine(splitLines(content));
  for (const block of findManagedBlocks(lines)) {
    const blockPatterns = new Set(
      block.lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/"))
    );
    let hasAll = true;
    for (const pattern of required) {
      if (!blockPatterns.has(pattern)) {
        hasAll = false;
        break;
      }
    }
    if (hasAll) {
      return true;
    }
  }

  return hasLegacyMetaResourcesEntry(lines, options.legacyRootPatterns ?? []);
}

async function readTextIfExists(uri: vscode.Uri): Promise<string> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return "";
  }
}

/**
 * Ignore patterns for chat-transcript files under the task root, built from
 * the same resolved root pattern already used for the task-root entry (so
 * relocating the task root via settings relocates these too). Scoped to the
 * task root only — not a bare `**\/chat-v1.json` — so an unrelated file
 * sharing a transcript's basename elsewhere in the repo is never matched.
 */
function buildTranscriptIgnorePatterns(taskRootPattern: string): string[] {
  const base = taskRootPattern.replace(/\/+$/, "");
  return [
    `${base}/**/${CHAT_HISTORY_FILENAME}`,
    `${base}/**/${CHAT_HISTORY_CORRUPT_FILENAME}`,
  ];
}

async function resolveGitRepoRoot(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, windowsHide: true },
      (error, stdout) => {
        resolve(error ? undefined : stdout.trim());
      }
    );
  });
}

async function resolveTarget(
  workspace: vscode.WorkspaceFolder | undefined
): Promise<CurrentMetaGitIgnoreTarget | undefined> {
  // Meta visibility is a repository property, not a task property, so the
  // target is the git repository of the workspace folder that owns the
  // `.ensemble` resources being hidden. In a multi-root workspace each
  // folder may be its own repository, so callers that know which folder a
  // task was created in must pass it; only folder-agnostic callers (startup
  // maintenance) fall back to the first folder.
  if (!workspace) {
    return undefined;
  }

  const repoRoot = await resolveGitRepoRoot(workspace.uri.fsPath);
  if (!repoRoot) {
    return undefined;
  }

  const configuredTaskRootPath = resolveConfiguredTaskRootPath(repoRoot);
  // The task-root setting is workspace-wide.  Ignore that actual configured
  // location rather than always writing the legacy /plans/ path.
  const configuredPattern = configuredTaskRootPath
    ? toGitignorePattern(repoRoot, configuredTaskRootPath)
    : undefined;
  // Both entries describe workspace-level roots. Task plans may be relocated
  // through settings, while artifacts always remain under /artifacts/helper/.
  // Neither pattern is task-specific. Dedupe: if the configured task root
  // resolves to the same path as the artifacts root, the two entries above
  // collapse to one pattern — without this, the managed block would render
  // that pattern twice (renderManagedBlock does not dedupe its input).
  const patterns = [...new Set(["/artifacts/helper/", configuredPattern ?? "/plans/"])];
  const taskRootPattern = configuredPattern ?? "/plans/";

  return {
    repoRoot,
    gitignoreUri: vscode.Uri.file(path.join(repoRoot, ".gitignore")),
    patterns,
    persistentPatterns: buildTranscriptIgnorePatterns(taskRootPattern),
    legacyRootPatterns: buildLegacyMetaRootIgnorePatterns(
      repoRoot,
      configuredTaskRootPath
    ),
  };
}

/** Apply the managed hide block silently. Returns whether a target git
 * repository was found (the write itself is skipped when already current). */
async function applyAutomaticMetaGitIgnore(
  workspace: vscode.WorkspaceFolder | undefined
): Promise<boolean> {
  const target = await resolveTarget(workspace);
  if (!target) {
    return false;
  }

  const current = await readTextIfExists(target.gitignoreUri);
  const next = applyManagedMetaGitIgnoreBlock(current, target.patterns, true, {
    legacyRootPatterns: target.legacyRootPatterns,
    persistentPatterns: target.persistentPatterns,
  });

  if (current !== next) {
    await vscode.workspace.fs.writeFile(
      target.gitignoreUri,
      new TextEncoder().encode(next)
    );
  }
  return true;
}

/**
 * Automatic Git-ignore maintenance: Ensemble resources are hidden from git
 * unconditionally, without configuration UI, following standard extension
 * conventions. This is the only pathway that writes the managed block —
 * the former hide/show/toggle commands and the `metaFilesHidden` setting
 * mirror are gone. Applied silently once per workspace/root, so a user who
 * deliberately hand-edits the block afterwards is not fought on every
 * activation. Also cleans up a stale block after a resource-folder move,
 * because the managed block is always rebuilt from the currently active
 * task-root path.
 */
/** Normalize a workspace path for use as a gate key (mirrors taskRoot.ts:
 * normalized separators, lowercased on Windows). */
function toGateKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function ensureAutomaticMetaGitIgnore(
  context: vscode.ExtensionContext,
  workspace?: vscode.WorkspaceFolder
): Promise<void> {
  const APPLIED_KEY = "ensemble.autoGitIgnoreApplied";
  const targetWorkspace = workspace ?? vscode.workspace.workspaceFolders?.[0];
  if (!targetWorkspace) {
    return;
  }

  // The once-per-root gate is scoped per workspace folder: in a multi-root
  // workspace each folder can be an independent repository, and applying the
  // block in one must not suppress it in another. Older versions stored a
  // bare string; that format only ever targeted the first folder, so it is
  // migrated to that folder's entry.
  const stored = context.workspaceState.get<string | Record<string, string>>(
    APPLIED_KEY
  );
  let appliedByFolder: Record<string, string>;
  if (typeof stored === "string") {
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    appliedByFolder = firstFolder
      ? { [toGateKey(firstFolder.uri.fsPath)]: stored }
      : {};
  } else {
    appliedByFolder = { ...(stored ?? {}) };
  }

  const gateKey = toGateKey(targetWorkspace.uri.fsPath);
  const activeRoot = getConfiguredTaskRoot();
  if (appliedByFolder[gateKey] === activeRoot) {
    return;
  }
  const applied = await applyAutomaticMetaGitIgnore(targetWorkspace);
  if (applied) {
    appliedByFolder[gateKey] = activeRoot;
    await context.workspaceState.update(APPLIED_KEY, appliedByFolder);
  }
}
