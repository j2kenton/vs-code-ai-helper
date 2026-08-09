/**
 * Strict task-creation footprint classifier and activation-order barrier
 * (plan §4.1/§4.3).
 *
 * This is the first slice of the plan §4 creation-recovery system: it
 * classifies `status: "creating"` task folders into the four conservative
 * classes from §4.3 (`reconstructible`, `pristine`, `preservable`,
 * `inspectionOnly`), using the strict progress decoder rather than the
 * permissive reader (this file is fenced from importing
 * `utils/taskProgressUtils`/`utils/legacyTaskProgressV0`).
 *
 * This module now IS the activation-order barrier: `extension.ts`,
 * `startNewTask.ts`, `taskInventory.ts`, and every other lifecycle command
 * that used to await the retired `LegacyCreatingStartupGateV0` now await
 * `waitUntilReady()` here instead (that module and its dedicated test were
 * deleted once this cutover landed — see
 * `taskCreationStartupReconcilerWiring.test.ts` for the call-site wiring
 * proof). Each footprint's `retryWithoutAdoptionEligible` flag (plan §4.5's
 * "verified V1 journal" branch of Retry) and `deletionPending` flag (plan
 * §4.6/§4.7) are consumed by `commands/taskCreationRecovery.ts`'s
 * Open/Retry/Adopt-and-Retry/Safe Delete commands and the Tasks tree's
 * per-class `ensemble.task.creationRecovery.*` context tokens
 * (`taskTreeProvider.ts`/`contextTokens.ts`). Adopt-and-Retry and Safe Delete
 * are wired up only for `preservable` and the verified-journal
 * (`retryWithoutAdoptionEligible`) case respectively this round — the
 * `reconstructible`/`pristine` "Retry with adoption" and "Safe Delete after
 * adoption" paths (plan §4.3's table, non-journal branch) remain
 * unimplemented; those classes still get Open only.
 *
 * Like the gate it replaced, this NEVER rewrites task-progress.json, never
 * adopts ownership, never invokes a provider, and never treats the presence
 * of `task.md` as proof a creation finished.
 */
import * as vscode from "vscode";
import { createHash } from "crypto";
import { TASK_FILENAME, TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { matchCreationSeedV1 } from "../services/taskCreationSeedHistoryV1";
import { loadTaskCreationJournalV1 } from "../services/taskCreationIntentStoreV1";
import { loadTaskDeletionJournalV1 } from "../services/taskDeletionIntentStoreV1";
import { CREATION_SENTINEL_FILENAME_V1 } from "../services/workflowPrivacyClassifierV1";
import { normalizePath } from "../utils/taskRoot";
import { TaskCreationIntentEntryV1 } from "../types/taskCreationIntentV1";
import { ClassifiedCreatingFootprintV1, TaskCreationFootprintClassV1 } from "../types/taskCreationRecoveryV1";

/**
 * Reduces a caught fs/VS-Code-API error to its stable error `code` only
 * (e.g. `ENOENT`, `EISDIR`, `FileSystemError` codes like `NoPermissions`).
 * `inspectionReason` is diagnostics/UI copy (see
 * `ClassifiedCreatingFootprintV1.inspectionReason`), so it must never carry
 * `error.message` — on Node and VS Code alike that message routinely embeds
 * the full absolute host filesystem path, which is workflow-control/private
 * detail (plan §2.2 sanitized-diagnostics: correlation ids, codes, byte
 * counts, digests only — never raw paths).
 */
function sanitizedFsErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "unknown";
}

/**
 * Classifies one candidate task folder already known to hold
 * `status: "creating"` progress. `otherEntryNames` is every directory entry
 * name in the folder EXCEPT `task-progress.json` and `task.md`;
 * `hasTaskMd`/`taskMdIsRegularFile` describe `task.md`'s presence/type.
 */
async function classifyCreatingCandidate(
  extensionUri: vscode.Uri,
  taskFolderUri: vscode.Uri,
  hasTaskMd: boolean,
  taskMdIsRegularFile: boolean,
  otherEntryNames: readonly string[]
): Promise<{ footprintClass: TaskCreationFootprintClassV1; matchedSeed?: { seedId: string; version: "v0" | "v1" }; inspectionReason?: string }> {
  if (otherEntryNames.length > 0) {
    return {
      footprintClass: "inspectionOnly",
      inspectionReason: `folder contains ${otherEntryNames.length} unexpected additional ${otherEntryNames.length === 1 ? "entry" : "entries"}`,
    };
  }
  if (hasTaskMd && !taskMdIsRegularFile) {
    return { footprintClass: "inspectionOnly", inspectionReason: `${TASK_FILENAME} exists but is not a regular file` };
  }
  if (!hasTaskMd) {
    return { footprintClass: "reconstructible" };
  }

  let taskMdText: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME));
    taskMdText = new TextDecoder().decode(bytes);
  } catch (error) {
    return {
      footprintClass: "inspectionOnly",
      inspectionReason: `${TASK_FILENAME} could not be read (${sanitizedFsErrorCode(error)})`,
    };
  }

  const matched = await matchCreationSeedV1(extensionUri, taskMdText);
  if (matched) {
    return { footprintClass: "pristine", matchedSeed: matched };
  }
  return { footprintClass: "preservable" };
}

/** States at/after which the journal claims task.md/task-progress.json actually exist on disk. */
const CREATION_STATES_WITH_CLAIMED_FILES_V1 = new Set(["finalFolderClaimed", "sentinelCommitted", "progressCommitted"]);
/** States at/after which the commit-sentinel file itself is expected to exist alongside those two. */
const CREATION_STATES_WITH_SENTINEL_V1 = new Set(["sentinelCommitted", "progressCommitted"]);

/**
 * Confirms `relativePath` both has a `kind: "file"` entry in `entries` and
 * that the entry's recorded `contentSha256` matches the file's ACTUAL current
 * bytes on disk — not merely that a path of the right name exists. This is
 * what lets the journal distinguish "the extension wrote this and it is
 * unchanged" from "a file with this name now exists, possibly user-edited
 * since" (the latter must fall back to the legacy classifier's `pristine`/
 * `preservable` seed comparison, never silently read as `reconstructible`).
 */
async function verifyJournalFileEntryV1(
  taskFolderUri: vscode.Uri,
  relativePath: string,
  entries: readonly TaskCreationIntentEntryV1[]
): Promise<boolean> {
  const entry = entries.find((candidate) => candidate.relativePath === relativePath);
  if (!entry || entry.kind !== "file" || !entry.contentSha256) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(taskFolderUri, relativePath));
  } catch {
    return false;
  }
  return createHash("sha256").update(bytes).digest("hex") === entry.contentSha256;
}

/**
 * Prefer a verified §4.2 V1 journal over the conservative §4.3 classifier
 * (plan §4.1's "Recover verified V1 creation and adoption journals" startup
 * step, ahead of "strictly classify remaining legacy `creating` folders").
 *
 * A journal this store wrote records ONLY entries its own writer
 * (`startNewTask.ts`) created (`createdV1` — never `adoptedLegacy`/
 * `preservedUser`, which no production writer emits yet). That is strictly
 * stronger evidence than the legacy classifier's seed-text matching PROVIDED
 * this function actually re-verifies the journal's claims against live disk
 * content rather than trusting the journal's mere presence:
 *
 *  - Before `finalFolderClaimed`, the journal has not yet claimed task.md/
 *    task-progress.json exist. If either is nevertheless present on disk,
 *    something outside this journal's own record produced them (a crash
 *    between writing the files and journaling the transition, a swallowed
 *    best-effort journal write, or unrelated content), and this journal
 *    cannot vouch for it — fall back.
 *  - At/after `finalFolderClaimed`, both task.md and task-progress.json must
 *    be present, and EACH must have a `kind: "file"` journal entry whose
 *    recorded `contentSha256` matches the file's current bytes exactly
 *    (`verifyJournalFileEntryV1`). A user who edited `task.md` after creation
 *    changes its bytes, so the recorded hash stops matching and this
 *    classifier correctly declines to vouch for it, falling back to the
 *    legacy classifier's `preservable` (protected, not silently
 *    reconstructible) classification.
 *
 * Returns `undefined` to fall back to the legacy classifier whenever the
 * journal is missing, unreadable, corrupt, resolved (a resolved journal
 * co-existing with an on-disk `status: "creating"` folder is an anomaly, not
 * a trustworthy signal), the folder holds anything beyond what the journal +
 * sentinel account for, or live content verification fails.
 */
async function classifyFromVerifiedJournalV1(
  metaFolderPath: string,
  taskFolderUri: vscode.Uri,
  hasTaskMd: boolean,
  taskMdIsRegularFile: boolean,
  otherEntryNames: readonly string[]
): Promise<{ footprintClass: TaskCreationFootprintClassV1 } | undefined> {
  const journalResult = await loadTaskCreationJournalV1(metaFolderPath, taskFolderUri.fsPath);
  if (journalResult.kind !== "ok") {
    return undefined;
  }
  const { journal } = journalResult;
  if (journal.state === "resolved") {
    return undefined;
  }
  const allowedExtra = new Set<string>();
  if (CREATION_STATES_WITH_SENTINEL_V1.has(journal.state)) {
    allowedExtra.add(CREATION_SENTINEL_FILENAME_V1);
  }
  const hasUnexpectedEntry = otherEntryNames.some((entryName) => !allowedExtra.has(entryName));
  if (hasUnexpectedEntry) {
    return undefined;
  }

  if (!CREATION_STATES_WITH_CLAIMED_FILES_V1.has(journal.state)) {
    // Nothing claimed to exist yet; disk must genuinely be empty of task.md
    // (task-progress.json is guaranteed present -- it's what put this folder
    // in `creating` scope at all -- so it is not re-checked here).
    return hasTaskMd ? undefined : { footprintClass: "reconstructible" };
  }

  if (!hasTaskMd || !taskMdIsRegularFile) {
    return undefined;
  }
  const taskMdVerified = await verifyJournalFileEntryV1(taskFolderUri, TASK_FILENAME, journal.entries);
  if (!taskMdVerified) {
    return undefined;
  }
  const progressVerified = await verifyJournalFileEntryV1(taskFolderUri, TASK_PROGRESS_FILENAME, journal.entries);
  if (!progressVerified) {
    return undefined;
  }
  return { footprintClass: "reconstructible" };
}

/**
 * True when a Safe Delete journal exists for this folder and has not yet
 * reached `externalStateResolved` (plan §4.6/§4.7). `missing`/
 * `recoveryRequired`/`unavailable` all read as "no live deletion" — an
 * undecodable or absent journal must never itself block the normal
 * Open/Retry surface; only a genuinely in-flight one does.
 */
async function hasLiveDeletionJournalV1(metaFolderPath: string, taskFolderPath: string): Promise<boolean> {
  const result = await loadTaskDeletionJournalV1(metaFolderPath, taskFolderPath);
  return result.kind === "ok" && result.journal.state !== "externalStateResolved";
}

async function classifyMetaRoot(
  metaFolderPath: string,
  extensionUri: vscode.Uri
): Promise<readonly ClassifiedCreatingFootprintV1[]> {
  const root = vscode.Uri.file(metaFolderPath);
  let rootEntries: [string, vscode.FileType][];
  try {
    rootEntries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return [];
  }

  const footprints: ClassifiedCreatingFootprintV1[] = [];
  for (const [name, type] of rootEntries) {
    if (type !== vscode.FileType.Directory) {
      continue;
    }
    const taskFolderUri = vscode.Uri.joinPath(root, name);
    // Plan §4.1 startup order step 1: a live Safe Delete journal takes
    // precedence over every other classification for this folder — the tree
    // must never offer Open/Retry/Adopt-and-Retry/Safe Delete again while a
    // deletion is already in flight for it (plan §4.7's `deletionPending`).
    const deletionPending = await hasLiveDeletionJournalV1(metaFolderPath, taskFolderUri.fsPath);

    const decodeResult = await readTaskProgressStrictV1(taskFolderUri, { expectedTaskFolder: name });

    let folderEntries: [string, vscode.FileType][];
    try {
      folderEntries = await vscode.workspace.fs.readDirectory(taskFolderUri);
    } catch (error) {
      if (decodeResult.ok && decodeResult.decoded.progress.status === "creating") {
        footprints.push({
          metaFolderPath,
          taskFolderPath: taskFolderUri.fsPath,
          taskFolderName: name,
          hasTaskMd: false,
          footprintClass: "inspectionOnly",
          inspectionReason: `folder contents could not be scanned (${sanitizedFsErrorCode(error)})`,
          retryWithoutAdoptionEligible: false,
          deletionPending,
        });
      }
      continue;
    }

    const taskMdEntry = folderEntries.find(([entryName]) => entryName === TASK_FILENAME);
    const hasTaskMd = taskMdEntry !== undefined;
    const taskMdIsRegularFile = taskMdEntry?.[1] === vscode.FileType.File;
    const otherEntryNames = folderEntries
      .map(([entryName]) => entryName)
      .filter((entryName) => entryName !== TASK_PROGRESS_FILENAME && entryName !== TASK_FILENAME);

    if (decodeResult.ok) {
      if (decodeResult.decoded.progress.status !== "creating") {
        continue; // Not a stuck creation; out of scope for this classifier.
      }
      const verifiedJournalClassification = await classifyFromVerifiedJournalV1(
        metaFolderPath,
        taskFolderUri,
        hasTaskMd,
        taskMdIsRegularFile,
        otherEntryNames
      );
      const classification =
        verifiedJournalClassification ??
        (await classifyCreatingCandidate(extensionUri, taskFolderUri, hasTaskMd, taskMdIsRegularFile, otherEntryNames));
      footprints.push({
        metaFolderPath,
        taskFolderPath: taskFolderUri.fsPath,
        taskFolderName: name,
        hasTaskMd,
        ...classification,
        // Only the verified-own-journal path (never the legacy seed-matching
        // fallback) proves every byte in the folder is extension-written —
        // see ClassifiedCreatingFootprintV1.retryWithoutAdoptionEligible.
        retryWithoutAdoptionEligible: verifiedJournalClassification !== undefined,
        deletionPending,
      });
      continue;
    }

    if (decodeResult.code === "missing") {
      // readTaskProgressStrictV1 collapses "no file" and "file present but
      // unreadable" into the same `missing` code. `folderEntries` was just
      // read from the same directory, so checking it directly (no extra fs
      // call) tells the two apart: a genuinely absent progress file is out
      // of scope, but an existing-and-unreadable one is exactly the
      // "incomplete scan" case plan §4.3 assigns to inspectionOnly rather
      // than letting it silently vanish from classification.
      const progressFileExists = folderEntries.some(([entryName]) => entryName === TASK_PROGRESS_FILENAME);
      if (!progressFileExists) {
        continue; // No progress file at all; not this classifier's concern.
      }
      // Same guard as the failed-strict-decoding branch below: a folder that
      // otherwise looks like a real, already-in-use task (plan.md, runs/,
      // etc. alongside an unreadable progress file — e.g. a transient lock)
      // must not be surfaced as a false "stuck creation" recovery node.
      if (otherEntryNames.length > 0) {
        continue;
      }
      footprints.push({
        metaFolderPath,
        taskFolderPath: taskFolderUri.fsPath,
        taskFolderName: name,
        hasTaskMd,
        footprintClass: "inspectionOnly",
        inspectionReason: "task-progress.json exists but could not be read as a file",
        retryWithoutAdoptionEligible: false,
        deletionPending,
      });
      continue;
    }

    // task-progress.json exists but fails strict decoding. Only treat this
    // as a stuck-creation candidate when the folder otherwise looks like an
    // interrupted creation (nothing beyond task-progress.json/task.md) —
    // otherwise it is far more likely a real, already-in-use task whose
    // progress format simply predates strict decoding, and it must not be
    // surfaced as a false "stuck creation" recovery node.
    if (otherEntryNames.length > 0) {
      continue;
    }
    footprints.push({
      metaFolderPath,
      taskFolderPath: taskFolderUri.fsPath,
      taskFolderName: name,
      hasTaskMd,
      footprintClass: "inspectionOnly",
      inspectionReason: `task-progress.json failed strict decoding (${decodeResult.code}): ${decodeResult.reason}`,
      retryWithoutAdoptionEligible: false,
      deletionPending,
    });
  }
  return footprints;
}

class TaskCreationStartupReconcilerV1Impl {
  /**
   * Republished on every classification pass (see `classifyOnce`).
   * `getClassifiedFootprints` always re-scans rather than serving this cache
   * (see that method's doc comment for why a stale answer would be unsafe
   * for a command about to mutate a folder) — but `getLastKnownFootprint`
   * DOES serve it directly, for the recovery-node tree UI (plan §4.7):
   * `TaskNode`'s constructor is synchronous, so it cannot await a fresh scan
   * on every tree refresh, and rendering one refresh cycle behind a change is
   * an accepted, `onDidChange`-bounded staleness window for a context-token
   * choice (Retry vs. Open vs. deletionPending), never for a mutation
   * decision — every recovery command re-derives its own fresh classification
   * before touching disk, exactly as before this field had a public reader.
   */
  private snapshots = new Map<string, readonly ClassifiedCreatingFootprintV1[]>();
  private inFlight = new Map<string, Promise<readonly ClassifiedCreatingFootprintV1[]>>();
  private barrier: Promise<void> = Promise.resolve();
  private readonly _onDidChange = new vscode.EventEmitter<void>();

  /** Fires after every published classification snapshot update. */
  readonly onDidChange = this._onDidChange.event;

  /**
   * Starts the classification pass for exactly these roots and publishes a
   * new barrier. Returns the barrier promise so a caller can await ordering
   * directly.
   */
  beginClassification(metaFolderPaths: readonly string[], extensionUri: vscode.Uri): Promise<void> {
    this.barrier = Promise.all(
      metaFolderPaths.map((metaFolderPath) => this.classifyOnce(metaFolderPath, extensionUri))
    ).then(() => undefined);
    return this.barrier;
  }

  /** Resolves once the most recently started classification pass has published. */
  waitUntilReady(): Promise<void> {
    return this.barrier;
  }

  /**
   * Read-only classification for one meta root: awaits the current barrier,
   * then always re-scans rather than serving a permanent cache. A folder can
   * enter `creating` at any point during a long-running window (e.g. this
   * window's own extension host getting interrupted mid-creation later in
   * the session), so a stale "no footprints" answer from the activation-time
   * scan would hide a real, currently-stuck folder from a later call.
   */
  async getClassifiedFootprints(
    metaFolderPath: string,
    extensionUri: vscode.Uri
  ): Promise<readonly ClassifiedCreatingFootprintV1[]> {
    await this.barrier;
    return this.classifyOnce(metaFolderPath, extensionUri);
  }

  /**
   * Synchronous last-known classification for one task folder — see the
   * `snapshots` field's doc comment for why this may be stale by up to one
   * `onDidChange` cycle, and why that is acceptable here but nowhere a
   * mutation is decided. Returns `undefined` before the first classification
   * pass publishes (or for a folder no pass has ever seen), which callers
   * must treat as "not known to be a stuck creation" — never as
   * `inspectionOnly`.
   */
  getLastKnownFootprint(metaFolderPath: string, taskFolderPath: string): ClassifiedCreatingFootprintV1 | undefined {
    const footprints = this.snapshots.get(normalizePath(metaFolderPath));
    if (!footprints) {
      return undefined;
    }
    const target = normalizePath(taskFolderPath);
    return footprints.find((footprint) => normalizePath(footprint.taskFolderPath) === target);
  }

  private classifyOnce(
    metaFolderPath: string,
    extensionUri: vscode.Uri
  ): Promise<readonly ClassifiedCreatingFootprintV1[]> {
    const key = normalizePath(metaFolderPath);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = classifyMetaRoot(metaFolderPath, extensionUri).then((footprints) => {
      this.snapshots.set(key, footprints);
      this._onDidChange.fire();
      return footprints;
    });
    this.inFlight.set(key, promise);
    void promise.finally(() => {
      this.inFlight.delete(key);
    });
    return promise;
  }

  /** Test-only: discard all published state so cases don't leak into each other. */
  resetForTests(): void {
    this.snapshots.clear();
    this.inFlight.clear();
    this.barrier = Promise.resolve();
  }
}

export const TaskCreationStartupReconcilerV1 = new TaskCreationStartupReconcilerV1Impl();
