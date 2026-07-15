import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { getConfiguredTaskRoot } from "../utils/taskRoot";
import { NotificationRouter } from "../utils/notificationRouter";
import { setMetaFilesHidden } from "../config/settings";

const MANAGED_BEGIN = "# BEGIN Ensemble managed meta resources";
const MANAGED_END = "# END Ensemble managed meta resources";
const MANAGED_NOTE = "# Managed by Ensemble. Do not edit this block manually.";
const LEGACY_COMMENT = "# Ensemble meta resources";
const LEGACY_DEFAULT_TASK_ROOT = ".helper/plans";
const LEGACY_TASK_ROOT = "plans";
const ARTIFACTS_ROOT = "artifacts/helper";

const META_ELIGIBLE_CONTEXT = "vs-code-ai-helper.metaGitIgnoreEligible";
const META_HIDDEN_CONTEXT = "vs-code-ai-helper.currentTaskMetaHidden";

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
}

interface ApplyManagedMetaGitIgnoreOptions {
  legacyRootPatterns?: readonly string[];
}

let metaVisibilityContextVersion = 0;

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

  if (!hidden && !hasManagedBlock && !hasLegacyBlock) {
    return content;
  }

  const withoutLegacy = removeLegacyMetaResourcesEntriesFromLines(
    lines,
    options.legacyRootPatterns ?? []
  );
  const withoutManaged = removeManagedBlocksFromLines(withoutLegacy);

  if (!hidden) {
    return withoutManaged.length > 0 ? `${withoutManaged.join(eol)}${eol}` : "";
  }

  const nextLines = [...withoutManaged];
  if (nextLines.length > 0) {
    nextLines.push("");
  }
  nextLines.push(...renderManagedBlock(patterns));
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
  _inventory: TaskInventory,
  _currentTaskStore: CurrentTaskStore,
  showMessages: boolean
): Promise<CurrentMetaGitIgnoreTarget | undefined> {
  // Meta visibility is a repository setting, not a task setting.  Using the
  // workspace avoids the former "select current task" prompt entirely.
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    if (showMessages) {
      void vscode.window.showWarningMessage(
        "Open a workspace folder before changing meta-file git visibility."
      );
    }
    return undefined;
  }

  const repoRoot = await resolveGitRepoRoot(workspace.uri.fsPath);
  if (!repoRoot) {
    if (showMessages) {
      void vscode.window.showWarningMessage(
        "Could not find a git repository for the current workspace."
      );
    }
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

  return {
    repoRoot,
    gitignoreUri: vscode.Uri.file(path.join(repoRoot, ".gitignore")),
    patterns,
    legacyRootPatterns: buildLegacyMetaRootIgnorePatterns(
      repoRoot,
      configuredTaskRootPath
    ),
  };
}

async function setMetaVisibilityContexts(
  eligible: boolean,
  hidden: boolean,
  contextVersion: number
): Promise<void> {
  if (contextVersion !== metaVisibilityContextVersion) {
    return;
  }

  await vscode.commands.executeCommand(
    "setContext",
    META_ELIGIBLE_CONTEXT,
    eligible
  );

  if (contextVersion !== metaVisibilityContextVersion) {
    return;
  }

  await vscode.commands.executeCommand(
    "setContext",
    META_HIDDEN_CONTEXT,
    hidden
  );
}

export async function refreshMetaResourcesGitIgnoreContext(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<void> {
  const contextVersion = ++metaVisibilityContextVersion;
  const target = await resolveTarget(inventory, currentTaskStore, false);
  if (!target) {
    await setMetaVisibilityContexts(false, false, contextVersion);
    return;
  }

  const content = await readTextIfExists(target.gitignoreUri);
  if (contextVersion !== metaVisibilityContextVersion) {
    return;
  }

  await setMetaVisibilityContexts(
    true,
    isManagedMetaGitIgnoreHidden(content, target.patterns, {
      legacyRootPatterns: target.legacyRootPatterns,
    }),
    contextVersion
  );
}

/** Line-level diff between two `.gitignore` contents, used to render an exact
 * confirmation preview. This only needs to be correct for the managed-block
 * add/remove edits `applyManagedMetaGitIgnoreBlock` produces, not arbitrary
 * text — those never reorder a caller's own unrelated lines. */
export function diffGitignoreLines(
  current: string,
  next: string
): { added: string[]; removed: string[] } {
  const currentLines = splitLines(current);
  const nextLines = splitLines(next);
  const currentSet = new Set(currentLines);
  const nextSet = new Set(nextLines);
  return {
    added: nextLines.filter((line) => !currentSet.has(line)),
    removed: currentLines.filter((line) => !nextSet.has(line)),
  };
}

/** Every `.gitignore` write goes through this confirmation, no matter which
 * command triggers it (hide/show/toggle, or a Settings save). Declining
 * leaves the file and the `metaFilesHidden` setting untouched. */
async function confirmGitignoreWrite(
  current: string,
  next: string,
  hidden: boolean
): Promise<boolean> {
  if (current === next) {
    return true;
  }

  const { added, removed } = diffGitignoreLines(current, next);
  const detailLines: string[] = [];
  if (added.length > 0) {
    detailLines.push(...added.map((line) => `+ ${line}`));
  }
  if (removed.length > 0) {
    detailLines.push(...removed.map((line) => `- ${line}`));
  }

  const actionLabel = hidden ? "Hide Meta Files" : "Show Meta Files";
  const confirm = await vscode.window.showWarningMessage(
    hidden
      ? "Ensemble wants to add a managed block to .gitignore to hide its meta files from git."
      : "Ensemble wants to remove its managed block from .gitignore, making its meta files visible in git.",
    { modal: true, detail: detailLines.join("\n") },
    actionLabel
  );
  return confirm === actionLabel;
}

/** Returns whether the write was applied (`false` if the user declined the
 * confirmation, or if there was no eligible git repository/target). */
async function setCurrentTaskMetaGitVisibility(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  hidden: boolean
): Promise<boolean> {
  const contextVersion = ++metaVisibilityContextVersion;
  const target = await resolveTarget(inventory, currentTaskStore, true);
  if (!target) {
    await setMetaVisibilityContexts(false, false, contextVersion);
    return false;
  }

  const current = await readTextIfExists(target.gitignoreUri);
  const next = applyManagedMetaGitIgnoreBlock(current, target.patterns, hidden, {
    legacyRootPatterns: target.legacyRootPatterns,
  });

  if (!(await confirmGitignoreWrite(current, next, hidden))) {
    return false;
  }

  if (current !== next) {
    await vscode.workspace.fs.writeFile(
      target.gitignoreUri,
      new TextEncoder().encode(next)
    );
  }
  await setMetaFilesHidden(hidden);

  await setMetaVisibilityContexts(true, hidden, contextVersion);
  NotificationRouter.showInformation(
    hidden
      ? "Workspace meta files are now hidden from git."
      : "Workspace meta files are now visible in git."
  );
  return true;
}

export async function hideMetaResourcesInGitIgnore(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<boolean> {
  return setCurrentTaskMetaGitVisibility(inventory, currentTaskStore, true);
}

export async function showMetaResourcesInGitIgnore(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<boolean> {
  return setCurrentTaskMetaGitVisibility(inventory, currentTaskStore, false);
}

export async function toggleMetaResourcesGitIgnore(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): Promise<boolean> {
  const target = await resolveTarget(inventory, currentTaskStore, true);
  if (!target) {
    const contextVersion = ++metaVisibilityContextVersion;
    await setMetaVisibilityContexts(false, false, contextVersion);
    return false;
  }

  const content = await readTextIfExists(target.gitignoreUri);
  // The managed .gitignore block is the single source of truth.  The setting
  // is retained only as a UI preference mirror; otherwise manually removing
  // the block leaves the command inverted.
  const hidden = isManagedMetaGitIgnoreHidden(content, target.patterns, {
    legacyRootPatterns: target.legacyRootPatterns,
  });
  return setCurrentTaskMetaGitVisibility(inventory, currentTaskStore, !hidden);
}

export function registerToggleMetaResourcesGitIgnoreCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.hideMetaResourcesInGitIgnore",
      () => hideMetaResourcesInGitIgnore(inventory, currentTaskStore)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.showMetaResourcesInGitIgnore",
      () => showMetaResourcesInGitIgnore(inventory, currentTaskStore)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.toggleMetaResourcesGitIgnore",
      () => toggleMetaResourcesGitIgnore(inventory, currentTaskStore)
    )
  );
}
