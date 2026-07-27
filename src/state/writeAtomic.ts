import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { validatePersistedTaskProgress } from "./persistedSchema";

// Unique session ID for this extension activation
const sessionId = `${process.pid}_${Math.random().toString(36).substring(2, 10)}`;

/**
 * Atomic-write temporary-file naming convention:
 * `<base>_temp_<sessionId>_<time>_<rand>.tmp<ext>`. A crash between the temp
 * write and the rename leaves these records on disk next to the file they
 * were meant to replace, so the privacy classifier
 * (services/workflowPrivacyClassifierV1.ts) treats any basename matching this
 * convention as a workflow-control record. The classifier keeps a literal
 * copy of the pattern (this module imports the VS Code API, which it must
 * stay free of); its unit test builds its fixtures through
 * `formatAtomicTempBasename` below — the same function every production temp
 * name comes from — so no change to this layout can land without a matching
 * classifier update.
 */
export const ATOMIC_TEMP_INFIX = "_temp_";
export const ATOMIC_TEMP_SUFFIX = ".tmp";

/**
 * The single owner definition of the complete atomic-temp filename layout.
 * `writeAtomic` builds every production temp name through this function and
 * the privacy-classifier drift test builds its fixtures through it too, so
 * the two can never describe different shapes: reordering or extending the
 * layout here changes real temp names and test fixtures identically, and the
 * classifier test fails until the classifier's pattern matches the new shape.
 */
export function formatAtomicTempBasename(targetBasename: string, uniqueTag: string): string {
  const ext = path.extname(targetBasename);
  const base = path.basename(targetBasename, ext);
  return `${base}${ATOMIC_TEMP_INFIX}${uniqueTag}${ATOMIC_TEMP_SUFFIX}${ext}`;
}

export interface AtomicWriteError extends Error {
  operation: string;
  targetPath: string;
  tempPath?: string;
  cause?: unknown;
  retryable: boolean;
  durableTargetUnchanged: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Perform an atomic file write by writing to a temp file and renaming it.
 * On Windows, handles EBUSY/EPERM/EACCES rename failures with exponential backoff.
 */
export async function writeAtomic(targetUri: vscode.Uri, content: string): Promise<void> {
  const targetPath = targetUri.fsPath;
  const dir = path.dirname(targetPath);

  // Validate the real persisted task document, not just an envelope type that
  // callers could accidentally bypass. Other atomic artifacts remain opaque.
  if (path.basename(targetPath) === "task-progress.json") {
    try { validatePersistedTaskProgress(JSON.parse(content)); }
    catch (error) {
      const failure = new Error(`Invalid task-progress.json: ${getErrorMessage(error)}`) as AtomicWriteError;
      failure.operation = "validate-input"; failure.targetPath = targetPath;
      failure.cause = error; failure.retryable = false; failure.durableTargetUnchanged = true;
      throw failure;
    }
  }
  
  // Create directories if they don't exist
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const tempFilename = formatAtomicTempBasename(
    path.basename(targetPath),
    `${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  const tempPath = path.join(dir, tempFilename);
  if (path.dirname(tempPath) !== dir || !path.resolve(tempPath).startsWith(`${path.resolve(dir)}${path.sep}`)) {
    throw new Error("Atomic write temporary path escaped its target directory.");
  }

  // Write to temporary file
  try {
    await fs.promises.writeFile(tempPath, content, "utf8");
    // Flush the temporary file before rename so a successful response means
    // the new bytes reached the filesystem, not only the process cache.
    const tempHandle = await fs.promises.open(tempPath, "r+");
    try { await tempHandle.sync(); } finally { await tempHandle.close(); }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch { /* best-effort temp cleanup */ }
    const error = new Error(`Failed to write temp file: ${getErrorMessage(err)}`) as AtomicWriteError;
    error.operation = "writeTemp";
    error.targetPath = targetPath;
    error.tempPath = tempPath;
    error.cause = err;
    error.retryable = false;
    error.durableTargetUnchanged = true;
    throw error;
  }

  // Rename temp file to target
  let renameSuccess = false;
  let lastError: unknown;

  if (process.platform === "win32") {
    const delays = [20, 60, 120, 240, 480]; // sum = 920ms
    for (let i = 0; i <= delays.length; i++) {
      try {
        await fs.promises.rename(tempPath, targetPath);
        renameSuccess = true;
        break;
      } catch (err) {
        lastError = err;
        const code = getErrorCode(err);
        const isTransient = code === "EBUSY" || code === "EPERM" || code === "EACCES";
        if (isTransient && i < delays.length) {
          await new Promise((resolve) => setTimeout(resolve, delays[i]));
        } else {
          break;
        }
      }
    }
  } else {
    try {
      await fs.promises.rename(tempPath, targetPath);
      renameSuccess = true;
    } catch (err) {
      lastError = err;
    }
  }

  if (!renameSuccess) {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch { /* best-effort temp cleanup */ }
    const error = new Error(`Failed to rename temp file to target: ${getErrorMessage(lastError)}`) as AtomicWriteError;
    error.operation = "rename";
    error.targetPath = targetPath;
    error.tempPath = tempPath;
    error.cause = lastError;
    error.retryable = true;
    error.durableTargetUnchanged = true;
    throw error;
  }

  // Flush the containing directory where supported. This closes the usual
  // rename-without-directory-durability window after a crash.
  try {
    const dirHandle = await fs.promises.open(dir, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch { /* Windows does not permit opening directories this way. */ }

  // Re-read and validate target
  try {
    const readBack = await fs.promises.readFile(targetPath, "utf8");
    if (readBack !== content) {
      throw new Error("Content mismatch after write");
    }
  } catch (err) {
    const error = new Error(`Failed to validate target file after write: ${getErrorMessage(err)}`) as AtomicWriteError;
    error.operation = "validate";
    error.targetPath = targetPath;
    error.cause = err;
    error.retryable = false;
    error.durableTargetUnchanged = false;
    throw error;
  }
}

/**
 * Startup cleanup utility that scans the meta/task directories and safely deletes
 * orphaned temporary files older than one hour. A shorter window matters for
 * crash recovery: stale session temp files should not survive long enough to
 * be mistaken for current work.
 */
export async function cleanupOrphanedTempFiles(taskRootDirs: string[]): Promise<void> {
  const now = Date.now();
  const staleTempAge = 24 * 60 * 60 * 1000;

  for (const rootDir of taskRootDirs) {
    try {
      if (!fs.existsSync(rootDir)) {
        continue;
      }
      const files = await fs.promises.readdir(rootDir, { withFileTypes: true });
      for (const entry of files) {
        if (entry.isDirectory()) {
          const taskDirPath = path.join(rootDir, entry.name);
          const taskFiles = await fs.promises.readdir(taskDirPath, { withFileTypes: true });
          for (const taskFile of taskFiles) {
            if (taskFile.isFile() && taskFile.name.includes(ATOMIC_TEMP_INFIX) && taskFile.name.endsWith(`${ATOMIC_TEMP_SUFFIX}.json`)) {
              const filePath = path.join(taskDirPath, taskFile.name);
              const stat = await fs.promises.stat(filePath);
              const age = now - stat.mtimeMs;
              // Never remove a recent artifact, or one owned by a live task
              // lease. A stale mtime alone is not proof of orphaning.
              const leasePath = path.join(taskDirPath, ".ensemble-task.lock");
              let liveLease = false;
              try { liveLease = (JSON.parse(await fs.promises.readFile(leasePath, "utf8")) as { expiresAt?: number }).expiresAt! > now; } catch { /* missing or invalid leases are not live */ }
              if (age > staleTempAge && !liveLease) {
                try {
                  await fs.promises.unlink(filePath);
                } catch { /* best-effort temp cleanup */ }
              }
            }
          }
        } else if (entry.isFile() && entry.name.includes(ATOMIC_TEMP_INFIX) && entry.name.endsWith(`${ATOMIC_TEMP_SUFFIX}.json`)) {
          const filePath = path.join(rootDir, entry.name);
          const stat = await fs.promises.stat(filePath);
          const age = now - stat.mtimeMs;
          if (age > staleTempAge) {
            try {
              await fs.promises.unlink(filePath);
            } catch { /* best-effort temp cleanup */ }
          }
        }
      }
    } catch {
      // Ignore errors during startup cleanup
    }
  }
}
