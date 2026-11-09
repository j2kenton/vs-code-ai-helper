/**
 * Step 11 / Finding 3: Detect and contain task artifacts written into another task.
 *
 * Snapshots relevant task-artifact identities before dispatch and compares after
 * every terminal round path. Detects newly created or changed round-progress.md
 * and other known task artifacts under a different task folder, without attributing
 * pre-existing foreign files to this round. Reports affected absolute paths in chat.
 * Moves content only when ownership and a safe destination are established;
 * otherwise preserves both files and offers a concrete recovery choice.
 * Excludes incorrect foreign-task artifact links from authoritative context in
 * later prompts while retaining useful code references.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveTaskRootCandidates } from "./taskRoot";
import { wasExtensionTaskArtifactWriteV1 } from "./extensionTaskWriteRegistryV1";
import { loadTaskCreationJournalV1 } from "../services/taskCreationIntentStoreV1";

export const KNOWN_TASK_ARTIFACT_NAMES = Object.freeze([
  "round-progress.md",
  "plan-final.md",
  "plan.md",
  "impl-summary.md",
  "task-progress.json",
  "task.md",
]);

export interface TaskArtifactFileFingerprintV1 {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export interface ForeignTaskArtifactSnapshotV1 {
  readonly capturedAt: string;
  readonly currentTaskFolderPath: string;
  /** Map of foreign task folder path -> Map of artifact name -> fingerprint (or undefined if absent) */
  readonly foreignArtifacts: ReadonlyMap<string, ReadonlyMap<string, TaskArtifactFileFingerprintV1>>;
}

export interface ForeignTaskArtifactChangeV1 {
  readonly foreignFolderPath: string;
  readonly artifactName: string;
  readonly absolutePath: string;
  readonly kind: "created" | "modified";
  readonly fingerprint: TaskArtifactFileFingerprintV1;
  readonly content?: string;
}

export interface ContainmentActionV1 {
  readonly artifactName: string;
  readonly foreignPath: string;
  readonly destPath: string;
  readonly outcome: "moved" | "preserved-occupied" | "preserved-ambiguous";
  readonly reason: string;
}

export interface ForeignTaskArtifactContainmentResultV1 {
  readonly detectedChanges: readonly ForeignTaskArtifactChangeV1[];
  readonly actions: readonly ContainmentActionV1[];
  readonly chatNotices: readonly string[];
  /**
   * bugs4 item 8: changes that are another task's own update or the extension's
   * own write. They produce no notice and no action; recorded for diagnostics.
   */
  readonly ignoredChanges?: readonly {
    readonly change: ForeignTaskArtifactChangeV1;
    readonly why: "extension-write" | "own-task-update" | "ensemble-created-task" | "already-noted";
  }[];
  /**
   * run1 Step 25: the other-task `task.md` edits this call put a one-line note on, so the caller can
   * record them and later end lines skip them (once per task and content).
   */
  readonly notedEdits?: readonly { readonly taskFolderPath: string; readonly sha256: string }[];
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

function computeFileSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Discovers task folders in standard locations (.ensemble, .helper/plans, plans).
 */
export function discoverTaskFoldersV1(workspaceRoot: string): string[] {
  const folders: string[] = [];
  const roots = [
    path.join(workspaceRoot, ".ensemble"),
    path.join(workspaceRoot, ".helper", "plans"),
    path.join(workspaceRoot, "plans"),
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(root, entry.name);
          // A task folder usually contains task-progress.json, task.md, plan.md, or .ensemble-creation-sentinel-v1.json
          if (
            fs.existsSync(path.join(fullPath, "task-progress.json")) ||
            fs.existsSync(path.join(fullPath, "task.md")) ||
            fs.existsSync(path.join(fullPath, "plan.md")) ||
            fs.existsSync(path.join(fullPath, "plan-final.md")) ||
            fs.existsSync(path.join(fullPath, ".ensemble-creation-sentinel-v1.json"))
          ) {
            folders.push(normalizePath(fullPath));
          }
        }
      }
    } catch {
      // Best-effort directory scan
    }
  }

  return folders;
}

/**
 * Discover task folders from the same configured, legacy and external roots
 * used by the task inventory. The workspace-ancestor scan above remains a
 * fallback for standalone callers and old metadata layouts, but production
 * callers must not infer a task root from the task folder's ancestry.
 */
export function discoverTaskFoldersFromConfiguredRootsV1(): string[] {
  return discoverTaskFoldersFromRootPathsV1(resolveTaskRootCandidates().map((candidate) => candidate.absolutePath));
}

/** Discover direct task children from explicit authoritative root candidates. */
export function discoverTaskFoldersFromRootPathsV1(rootPaths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const rootPath of rootPaths) {
    try {
      for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(rootPath, entry.name);
        if (KNOWN_TASK_ARTIFACT_NAMES.some((name) => fs.existsSync(path.join(fullPath, name))) ||
            fs.existsSync(path.join(fullPath, ".ensemble-creation-sentinel-v1.json"))) {
          folders.add(normalizePath(fullPath));
        }
      }
    } catch {
      // A missing or unreadable candidate root contributes no folders.
    }
  }
  return [...folders];
}

/**
 * Snapshots relevant task-artifact identities across foreign task folders before round dispatch.
 */
export async function captureForeignTaskArtifactSnapshotV1(
  currentTaskFolderPath: string,
  candidateForeignFolders?: readonly string[]
): Promise<ForeignTaskArtifactSnapshotV1> {
  const normalizedCurrent = normalizePath(currentTaskFolderPath);
  const foreignFolders = candidateForeignFolders
    ? candidateForeignFolders.map(normalizePath).filter((f) => f !== normalizedCurrent)
    : [...new Set([
        ...discoverTaskFoldersFromConfiguredRootsV1(),
        ...discoverTaskFoldersV1(path.resolve(currentTaskFolderPath, "..", "..")),
      ])].filter(
        (f) => f !== normalizedCurrent
      );

  const foreignArtifacts = new Map<string, Map<string, TaskArtifactFileFingerprintV1>>();

  for (const folder of foreignFolders) {
    const artifactMap = new Map<string, TaskArtifactFileFingerprintV1>();
    for (const name of KNOWN_TASK_ARTIFACT_NAMES) {
      const filePath = path.join(folder, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          const content = await fs.promises.readFile(filePath);
          artifactMap.set(name, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            sha256: computeFileSha256(content),
          });
        }
      } catch {
        // File absent or unreadable before dispatch
      }
    }
    foreignArtifacts.set(folder, artifactMap);
  }

  return {
    capturedAt: new Date().toISOString(),
    currentTaskFolderPath: normalizedCurrent,
    foreignArtifacts,
  };
}

/**
 * Detects newly created or changed task artifacts under foreign task folders
 * by comparing current state against pre-dispatch snapshot.
 * Pre-existing unchanged files are excluded.
 */
export async function detectForeignTaskArtifactChangesV1(
  snapshot: ForeignTaskArtifactSnapshotV1,
  candidateForeignFolders?: readonly string[]
): Promise<ForeignTaskArtifactChangeV1[]> {
  const changes: ForeignTaskArtifactChangeV1[] = [];
  const foldersToCheck = candidateForeignFolders
    ? candidateForeignFolders
        .map(normalizePath)
        .filter((f) => f !== snapshot.currentTaskFolderPath)
    : [...new Set([
        ...snapshot.foreignArtifacts.keys(),
        ...discoverTaskFoldersFromConfiguredRootsV1()
          .map(normalizePath)
          .filter((folder) => folder !== snapshot.currentTaskFolderPath),
        ...discoverTaskFoldersV1(path.resolve(snapshot.currentTaskFolderPath, "..", ".."))
          .map(normalizePath)
          .filter((folder) => folder !== snapshot.currentTaskFolderPath),
      ])];

  for (const folder of foldersToCheck) {
    const priorArtifacts: ReadonlyMap<string, TaskArtifactFileFingerprintV1> =
      snapshot.foreignArtifacts.get(folder) ?? new Map<string, TaskArtifactFileFingerprintV1>();
    for (const name of KNOWN_TASK_ARTIFACT_NAMES) {
      const filePath = path.join(folder, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
          continue;
        }
        const content = await fs.promises.readFile(filePath);
        const currentFingerprint: TaskArtifactFileFingerprintV1 = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          sha256: computeFileSha256(content),
        };

        const prior = priorArtifacts.get(name);
        if (!prior) {
          // File was absent before dispatch, now exists -> newly created
          changes.push({
            foreignFolderPath: folder,
            artifactName: name,
            absolutePath: filePath,
            kind: "created",
            fingerprint: currentFingerprint,
            content: content.toString("utf8"),
          });
        } else if (
          prior.sha256 !== currentFingerprint.sha256 ||
          prior.size !== currentFingerprint.size
        ) {
          // File was modified during this round
          changes.push({
            foreignFolderPath: folder,
            artifactName: name,
            absolutePath: filePath,
            kind: "modified",
            fingerprint: currentFingerprint,
            content: content.toString("utf8"),
          });
        }
        // If sha256 and size match prior, it is pre-existing and unchanged -> ignored
      } catch {
        // File does not exist post-round
      }
    }
  }

  return changes;
}

export interface ContainmentOptionsV1 {
  /** Optional verification that the foreign file content belongs to current task (e.g. contains task name/id) */
  readonly isTaskOwned?: (artifactName: string, content: string) => boolean;
  /** Whether foreign task is known to be running concurrently */
  readonly isConcurrentForeignUpdate?: boolean;
  /**
   * bugs4 item 8: true when `sha256` is bytes the extension itself wrote to
   * `absolutePath` (pin, unpin, rename, archive, watchdog, Tasks-pane edits).
   * Defaults to the shared extension-write registry.
   */
  readonly isExtensionWrite?: (absolutePath: string, sha256: string) => boolean;
  /**
   * run1 Step 25: true when Ensemble's own New Task made this folder (it has a creation sentinel, or
   * a matching creation intent). Every artifact of such a folder is Ensemble's own: no note, and
   * never advice to move it into the running task. Defaults to {@link isEnsembleCreatedTaskFolderV1}
   * limited to folders created inside `roundWindow`, so an established task keeps normal handling.
   */
  readonly isEnsembleCreatedFolder?: (taskFolderPath: string) => boolean | Promise<boolean>;
  /** run1 Step 25: true while a round is running in that other task (its writes are that round's own). */
  readonly isRoundRunningInTask?: (taskFolderPath: string) => boolean;
  /** run1 Step 25: true when this exact task.md content was already noted for that task (once per task and content). */
  readonly isEditAlreadyNoted?: (taskFolderPath: string, sha256: string) => boolean;
  /**
   * run1 Step 25: this round's process window. "Move it into this task" is offered only for a change
   * whose modified time falls inside it AND whose content names this task (see `currentTaskNames`).
   */
  readonly roundWindow?: { readonly startMs: number; readonly endMs: number };
  /**
   * run1 Step 25: how long ago a task folder may have been created by New Task and still count as Ensemble's own
   * ("created during this round"): the round's whole span, preparation and bookkeeping included. Defaults to
   * `roundWindow`, which is the narrower process window.
   */
  readonly createdWithinWindow?: { readonly startMs: number; readonly endMs: number };
  /** The running task's folder name and display name, for "its content names this task". */
  readonly currentTaskNames?: readonly string[];
}

/** The creation sentinel Ensemble's New Task leaves in every task folder it makes. */
export const CREATION_SENTINEL_FILE_NAME_V1 = ".ensemble-creation-sentinel-v1.json";

/**
 * run1 Step 25: a task folder Ensemble itself created through New Task. The creation sentinel is the
 * sure sign; failing that, a creation journal and intent record for the folder (found beside it in
 * the same `.ensemble` meta root) say the same. Any failure to read them means "not known to be
 * Ensemble's own", never a throw.
 */
export async function isEnsembleCreatedTaskFolderV1(
  taskFolderPath: string,
  createdWithin?: { readonly startMs: number; readonly endMs: number }
): Promise<boolean> {
  // When a round window is given, only a folder created INSIDE it is exempt: an established task
  // that merely has a creation sentinel keeps its normal handling (owner-edit note, containment).
  const insideWindow = (createdAt: unknown): boolean => {
    if (createdWithin === undefined) {
      return true;
    }
    const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    return Number.isFinite(at) && at >= createdWithin.startMs && at <= createdWithin.endMs;
  };
  try {
    const raw = await fs.promises.readFile(path.join(taskFolderPath, CREATION_SENTINEL_FILE_NAME_V1), "utf8");
    if (createdWithin === undefined) {
      return true;
    }
    try {
      return insideWindow((JSON.parse(raw) as { createdAt?: unknown }).createdAt);
    } catch {
      return false;
    }
  } catch {
    // No sentinel: look for a matching creation intent.
  }
  try {
    const loaded = await loadTaskCreationJournalV1(path.dirname(taskFolderPath), taskFolderPath);
    return loaded.kind === "ok" && insideWindow(loaded.intent.createdAt);
  } catch {
    return false;
  }
}

/** Whether move advice may be offered: inside this round's process window, and naming this task. */
function moveAdvicePermittedV1(change: ForeignTaskArtifactChangeV1, options: ContainmentOptionsV1 | undefined): boolean {
  const window = options?.roundWindow;
  if (window === undefined || change.content === undefined) {
    return false;
  }
  if (change.fingerprint.mtimeMs < window.startMs || change.fingerprint.mtimeMs > window.endMs) {
    return false;
  }
  const content = change.content;
  return (options?.currentTaskNames ?? []).some((name) => name.length > 0 && content.includes(name));
}

/**
 * bugs4 item 8: why a changed foreign-folder file is NOT this round's
 * misplaced artifact, or undefined when it still needs the ownership checks.
 *
 * - `extension-write`: its bytes are exactly what the extension last wrote.
 * - `own-task-update`: a `task-progress.json` whose own `taskFolder` names the
 *   folder it sits in. Content that positively names a different task belongs
 *   to that task; it is never "ambiguous".
 */
export function classifyForeignChangeAsNotMisplacedV1(
  change: ForeignTaskArtifactChangeV1,
  isExtensionWrite: (absolutePath: string, sha256: string) => boolean = wasExtensionTaskArtifactWriteV1
): "extension-write" | "own-task-update" | undefined {
  if (isExtensionWrite(change.absolutePath, change.fingerprint.sha256)) {
    return "extension-write";
  }
  if (change.artifactName === "task-progress.json" && change.content !== undefined) {
    try {
      const parsed = JSON.parse(change.content) as { taskFolder?: unknown };
      if (
        typeof parsed.taskFolder === "string" &&
        parsed.taskFolder === path.basename(change.foreignFolderPath)
      ) {
        return "own-task-update";
      }
    } catch {
      // Unparseable content attributes nothing; fall through to the ownership checks.
    }
  }
  return undefined;
}

function describeChangeTimeV1(change: ForeignTaskArtifactChangeV1): string {
  const at = new Date(change.fingerprint.mtimeMs);
  return Number.isNaN(at.getTime()) ? "during this round" : `at ${at.toISOString()}`;
}

/**
 * Moves foreign-written artifacts to current task when safe and ownership is established.
 * If destination is occupied, or ownership is ambiguous, preserves both files and reports recovery choice.
 */
export async function containForeignTaskArtifactChangesV1(
  changes: readonly ForeignTaskArtifactChangeV1[],
  currentTaskFolderPath: string,
  options?: ContainmentOptionsV1
): Promise<ForeignTaskArtifactContainmentResultV1> {
  const actions: ContainmentActionV1[] = [];
  const chatNotices: string[] = [];
  const ignoredChanges: {
    change: ForeignTaskArtifactChangeV1;
    why: "extension-write" | "own-task-update" | "ensemble-created-task" | "already-noted";
  }[] = [];
  const notedEdits: { taskFolderPath: string; sha256: string }[] = [];
  const normalizedCurrent = normalizePath(currentTaskFolderPath);
  const createdFolderCache = new Map<string, boolean>();

  for (const change of changes) {
    const destPath = path.join(normalizedCurrent, change.artifactName);
    const foreignPath = change.absolutePath;

    // run1 Step 25: a task folder Ensemble's New Task made is Ensemble's own, whatever its files hold.
    // Never reported, and never "move it into this task".
    let ensembleCreated = createdFolderCache.get(change.foreignFolderPath);
    if (ensembleCreated === undefined) {
      ensembleCreated = options?.isEnsembleCreatedFolder
        ? await options.isEnsembleCreatedFolder(change.foreignFolderPath)
        : await isEnsembleCreatedTaskFolderV1(change.foreignFolderPath, options?.createdWithinWindow ?? options?.roundWindow);
      createdFolderCache.set(change.foreignFolderPath, ensembleCreated);
    }
    if (ensembleCreated) {
      ignoredChanges.push({ change, why: "ensemble-created-task" });
      continue;
    }

    // bugs4 item 8: an extension-originated write (pin, archive, rename,
    // watchdog, Tasks-pane edit), or a file whose own content names the task
    // folder it sits in, is that task's own update. No notice, no action.
    const notMisplaced = classifyForeignChangeAsNotMisplacedV1(
      change,
      options?.isExtensionWrite ?? wasExtensionTaskArtifactWriteV1
    );
    if (notMisplaced !== undefined) {
      ignoredChanges.push({ change, why: notMisplaced });
      continue;
    }

    // Nothing here is ever copied: a "preserved" file is simply left where it
    // is, and the note names the one file and when it changed. The round's own
    // outcome is never altered by a note.
    const where = `'${change.artifactName}' in another task's folder ('${foreignPath}') changed ${describeChangeTimeV1(change)}`;

    // An existing task.md edited in another task's folder by something other
    // than this round (the owner, an editor, another session) is a note at most.
    if (change.artifactName === "task.md" && change.kind === "modified") {
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: "An existing task.md in another task's folder changed; left in place.",
      });
      // run1 Step 25: with no round running in that task, an owner edit gets one short line, once per
      // task and content, and the caller records it so later end lines skip it.
      if (options?.isRoundRunningInTask?.(change.foreignFolderPath) !== true) {
        if (options?.isEditAlreadyNoted?.(change.foreignFolderPath, change.fingerprint.sha256) === true) {
          ignoredChanges.push({ change, why: "already-noted" });
          continue;
        }
        notedEdits.push({ taskFolderPath: change.foreignFolderPath, sha256: change.fingerprint.sha256 });
        chatNotices.push(`${path.basename(change.foreignFolderPath)} was edited outside this round; nothing needs doing.`);
        continue;
      }
      chatNotices.push(
        `Note: ${where}. If this round did not write it (an owner edit, an editor, another session or another task's round), nothing needs doing; this round's outcome is unaffected.`
      );
      continue;
    }

    // run1 Step 25: "move it into this task" only when the change fell inside this round's process
    // window and its content names this task. Without that evidence the note carries no advice.
    const moveAdvice = moveAdvicePermittedV1(change, options)
      ? ` if this round's provider wrote it, move it into '${destPath}'.`
      : " Nothing was copied, and nothing needs doing unless you know this round wrote it.";

    // Check ambiguous ownership or concurrent foreign-task update
    if (options?.isConcurrentForeignUpdate) {
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: "Concurrent foreign-task update detected; left in place.",
      });
      chatNotices.push(
        `Note: ${where} while that task was active. It was left in place and no copy was made;${moveAdvice}`
      );
      continue;
    }

    if (!options?.isTaskOwned || change.content === undefined) {
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: "Artifact ownership was not established; left in place.",
      });
      chatNotices.push(
        `Note: ${where}, but ownership was not established. It was left in place and no copy was made;${moveAdvice}`
      );
      continue;
    }

    {
      const owned = options.isTaskOwned(change.artifactName, change.content);
      if (!owned) {
        actions.push({
          artifactName: change.artifactName,
          foreignPath,
          destPath,
          outcome: "preserved-ambiguous",
          reason: "Artifact content does not attribute ownership to the current task; left in place.",
        });
        chatNotices.push(
          `Note: ${where}, and its content does not attribute it to this task, so ownership is ambiguous. It was left in place and no copy was made;${moveAdvice}`
        );
        continue;
      }
    }

    // Check if destination in current task is occupied
    let destExists = false;
    try {
      const destStat = await fs.promises.stat(destPath);
      if (destStat.isFile()) {
        destExists = true;
      }
    } catch {
      destExists = false;
    }

    if (destExists) {
      // Occupied destination: preserve both files and offer concrete choice
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-occupied",
        reason: `Destination '${destPath}' is already occupied; preserving both files.`,
      });
      chatNotices.push(
        `Notice: '${change.artifactName}' was written into foreign task folder '${change.foreignFolderPath}', but destination '${destPath}' already exists. Both copies were preserved; choose which contents to keep before replacing or merging either file.`
      );
      continue;
    }

    // Safe destination and ownership established: move content
    try {
      // Exclusive copy avoids clobbering a destination created after the
      // earlier existence check. Keep the source until the destination is
      // fully written; if removal fails, both copies remain available.
      await fs.promises.copyFile(foreignPath, destPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.unlink(foreignPath);

      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "moved",
        reason: `Moved misplaced task artifact from '${foreignPath}' to canonical location '${destPath}'.`,
      });
      chatNotices.push(
        `Misplaced artifact contained: '${foreignPath}' was moved to canonical task location '${destPath}'.`
      );
    } catch (error) {
      const errStr = error instanceof Error ? error.message : String(error);
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: `Failed to move file (${errStr}); preserved both files.`,
      });
      chatNotices.push(
        `Notice: Failed to move '${change.artifactName}' from '${foreignPath}' to '${destPath}': ${errStr}. Preserved both files.`
      );
    }
  }

  return {
    detectedChanges: changes,
    actions,
    chatNotices,
    ignoredChanges,
    notedEdits,
  };
}

/**
 * Excludes incorrect foreign-task artifact links from authoritative context in later prompts
 * while retaining useful code references.
 */
export function sanitizeAuthoritativePromptContextV1(
  text: string,
  currentTaskFolderPath: string,
  foreignTaskFolderPaths: readonly string[]
): string {
  if (!text || foreignTaskFolderPaths.length === 0) {
    return text;
  }

  let result = text;
  const normalizedCurrent = normalizePath(currentTaskFolderPath);

  for (const foreignFolder of foreignTaskFolderPaths) {
    const normalizedForeign = normalizePath(foreignFolder);
    if (normalizedForeign === normalizedCurrent) {
      continue;
    }

    for (const artifactName of KNOWN_TASK_ARTIFACT_NAMES) {
      const foreignArtifactPath = path.join(normalizedForeign, artifactName);

      // Foreign task artifacts are not authoritative for this prompt. Remove
      // their links rather than rewriting them to a different file that may
      // have unrelated contents.
      const linkRegex = new RegExp(
        `\\[([^\\]]+)\\]\\(${escapeRegex(foreignArtifactPath)}\\)`,
        "g"
      );
      result = result.replace(linkRegex, "[foreign task artifact omitted]");

      // Plain paths: /path/to/foreign/artifactName -> /path/to/current/artifactName
      const pathRegex = new RegExp(escapeRegex(foreignArtifactPath), "g");
      result = result.replace(pathRegex, "[foreign task artifact omitted]");
    }
  }

  return result;
}

/**
 * Applies foreign-task artifact filtering to implementation text immediately
 * before review prompt assembly. Using the bound task folder as the anchor
 * prevents stale summary links from selecting a neighboring task's artifacts.
 */
export function sanitizeImplementationReviewContentV1(text: string, currentTaskFolderPath: string): string {
  const workspaceRoot = path.resolve(currentTaskFolderPath, "..", "..");
  return sanitizeAuthoritativePromptContextV1(
    text,
    currentTaskFolderPath,
    [...new Set([
      ...discoverTaskFoldersFromConfiguredRootsV1(),
      ...discoverTaskFoldersV1(workspaceRoot),
    ])]
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
