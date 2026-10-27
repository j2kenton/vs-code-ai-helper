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
  const normalizedCurrent = normalizePath(currentTaskFolderPath);

  for (const change of changes) {
    const destPath = path.join(normalizedCurrent, change.artifactName);
    const foreignPath = change.absolutePath;

    // Check ambiguous ownership or concurrent foreign-task update
    if (options?.isConcurrentForeignUpdate) {
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: "Concurrent foreign-task update detected; preserving both files to avoid data loss.",
      });
      chatNotices.push(
        `Notice: '${change.artifactName}' changed in foreign task folder '${change.foreignFolderPath}' while that task was active. Both copies were preserved; choose whether to copy the foreign version into '${destPath}' after comparing them, or keep the copies separate.`
      );
      continue;
    }

    if (!options?.isTaskOwned || change.content === undefined) {
      actions.push({
        artifactName: change.artifactName,
        foreignPath,
        destPath,
        outcome: "preserved-ambiguous",
        reason: "Artifact ownership was not established; preserving both files.",
      });
      chatNotices.push(
        `Notice: '${change.artifactName}' changed in foreign task folder '${change.foreignFolderPath}', but ownership was not established. Both copies were preserved; compare '${foreignPath}' with '${destPath}' and choose which copy belongs to this task before moving or merging either.`
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
          reason: "Artifact content does not attribute ownership to the current task; preserving both files.",
        });
      chatNotices.push(
        `Notice: '${change.artifactName}' was written into foreign task folder '${change.foreignFolderPath}', but ownership is ambiguous. Both copies were preserved; compare '${foreignPath}' with '${destPath}' and choose which copy belongs to this task before moving or merging either.`
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
