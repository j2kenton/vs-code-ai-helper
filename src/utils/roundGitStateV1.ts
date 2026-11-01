import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  captureGitIndexLockSnapshotV1,
  resolveGitIndexLockPathV1,
  settleRoundGitIndexLockV1,
  describeIndexLockSettlementV1,
  type GitIndexLockHolderInspectorV1,
  type GitIndexLockSettlementV1,
  type GitIndexLockSnapshotV1,
} from "./gitIndexLockV1";

const execFileAsync = promisify(execFile);

export interface RoundGitIndexEntryV1 {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}

export interface RoundGitStashEntryV1 {
  readonly objectId: string;
  readonly selector: string;
  readonly subject: string;
}

export interface RoundGitStateSnapshotV1 {
  readonly repositoryRoot: string;
  readonly taskFolderPath: string;
  readonly roundId: string;
  readonly operationId?: string;
  readonly observedAt: string;
  readonly indexEntries: readonly RoundGitIndexEntryV1[];
  readonly stashEntries: readonly RoundGitStashEntryV1[];
  readonly indexLock?: GitIndexLockSnapshotV1;
}

export interface RoundGitStateDeltaV1 {
  readonly newUnmergedPaths: readonly string[];
  readonly resolvedUnmergedPaths: readonly string[];
  readonly changedIndexEntries: readonly string[];
  readonly addedStashes: readonly RoundGitStashEntryV1[];
  readonly removedStashes: readonly RoundGitStashEntryV1[];
  /** Timing establishes observation only; another actor may have made it. */
  readonly attribution: "observed-unattributed";
}

export interface RoundGitObservationRecordV1 {
  readonly version: 1;
  readonly roundId: string;
  readonly operationId: string;
  readonly taskFolderPath: string;
  readonly repositoryRoot?: string;
  readonly before?: RoundGitStateSnapshotV1;
  /**
   * The lock observed before the round, captured on its own so a failure of
   * the broader index/stash capture cannot hide a leftover lock from settlement.
   */
  readonly indexLockBefore?: GitIndexLockSnapshotV1;
  readonly after?: RoundGitStateSnapshotV1;
  readonly delta?: RoundGitStateDeltaV1;
  readonly indexLockSettlement?: GitIndexLockSettlementV1;
  readonly unavailableReason?: string;
}

export interface RoundGitInterferenceV1 {
  readonly unmergedPaths: readonly string[];
  readonly stashOperationIds: readonly string[];
  readonly stashObservations?: readonly RoundGitStashObservationV1[];
  /**
   * Index-lock outcomes found while recovering rounds the host never finished
   * (killed before their `finally`): a removed or preserved lock, with age and
   * what the owner can do. Informational; never holds a task.
   */
  readonly indexLockNotices?: readonly string[];
}

export interface RoundGitStashObservationV1 {
  readonly operationId: string;
  readonly attribution: "observed-unattributed";
  readonly observedFrom?: string;
  readonly observedUntil?: string;
  readonly added: readonly RoundGitStashEntryV1[];
  readonly removed: readonly RoundGitStashEntryV1[];
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.toString("utf8");
}

async function resolveRepositoryRoot(taskFolderPath: string): Promise<string> {
  return (await gitOutput(path.resolve(taskFolderPath), ["rev-parse", "--show-toplevel"])).trim();
}

/** Observe the repository's index lock; a failure to resolve or read it is recorded as an unknown state, never as absence. */
async function observeGitIndexLockV1(repositoryRoot: string, now?: Date): Promise<GitIndexLockSnapshotV1> {
  try {
    return await captureGitIndexLockSnapshotV1(await resolveGitIndexLockPathV1(repositoryRoot), now);
  } catch (error) {
    return {
      state: "unknown",
      observedAt: (now ?? new Date()).toISOString(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A round that has started but has no after-round observation yet (running, or killed before its `finally`). */
function isPendingRoundObservationV1(record: RoundGitObservationRecordV1): boolean {
  return !record.after && Boolean(record.before || record.indexLockBefore);
}

/** Capture the index (including unmerged stages) and stash list without changing Git state. */
export async function captureRoundGitStateV1(input: {
  readonly repositoryRoot: string;
  readonly taskFolderPath: string;
  readonly roundId: string;
  readonly operationId?: string;
  readonly now?: Date;
  /** An index-lock observation already taken for this capture; it is used instead of observing again. */
  readonly indexLock?: GitIndexLockSnapshotV1;
}): Promise<RoundGitStateSnapshotV1> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const taskFolderPath = path.resolve(input.taskFolderPath);
  const [indexRaw, stashRaw] = await Promise.all([
    gitOutput(repositoryRoot, ["ls-files", "--stage", "-z"]),
    gitOutput(repositoryRoot, ["stash", "list", "--format=%H%x00%gd%x00%gs%x00"]),
  ]);
  const indexEntries = indexRaw.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const [mode, objectId, stageText] = record.slice(0, tab).split(" ");
    const stage = Number(stageText);
    if (!mode || !objectId || !Number.isInteger(stage)) return [];
    return [{ path: record.slice(tab + 1), mode, objectId, stage }];
  });
  const stashParts = stashRaw.split("\0").filter(Boolean);
  const stashEntries: RoundGitStashEntryV1[] = [];
  for (let i = 0; i + 2 < stashParts.length; i += 3) {
    const [objectId, selector, subject] = stashParts.slice(i, i + 3);
    if (objectId && selector && subject !== undefined) stashEntries.push({ objectId, selector, subject });
  }
  const indexLock = input.indexLock ?? await observeGitIndexLockV1(repositoryRoot, input.now);
  return {
    repositoryRoot,
    taskFolderPath,
    roundId: input.roundId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    observedAt: (input.now ?? new Date()).toISOString(),
    indexEntries,
    stashEntries,
    ...(indexLock ? { indexLock } : {}),
  };
}

function indexKey(entry: RoundGitIndexEntryV1): string {
  return `${entry.path}\0${entry.stage}\0${entry.mode}\0${entry.objectId}`;
}

/** Compare two observations; do not imply that timing proves who made a change. */
export function compareRoundGitStateV1(
  before: RoundGitStateSnapshotV1,
  after: RoundGitStateSnapshotV1
): RoundGitStateDeltaV1 {
  const beforeIndex = new Set(before.indexEntries.map(indexKey));
  const afterIndex = new Set(after.indexEntries.map(indexKey));
  const beforeUnmerged = new Set(before.indexEntries.filter((entry) => entry.stage !== 0).map((entry) => entry.path));
  const afterUnmerged = new Set(after.indexEntries.filter((entry) => entry.stage !== 0).map((entry) => entry.path));
  const beforeStashes = new Map(before.stashEntries.map((entry) => [entry.objectId, entry]));
  const afterStashes = new Map(after.stashEntries.map((entry) => [entry.objectId, entry]));
  return {
    newUnmergedPaths: [...afterUnmerged].filter((file) => !beforeUnmerged.has(file)).sort(),
    resolvedUnmergedPaths: [...beforeUnmerged].filter((file) => !afterUnmerged.has(file)).sort(),
    changedIndexEntries: [...new Set([
      ...before.indexEntries.filter((entry) => !afterIndex.has(indexKey(entry))).map((entry) => entry.path),
      ...after.indexEntries.filter((entry) => !beforeIndex.has(indexKey(entry))).map((entry) => entry.path),
    ])].sort(),
    addedStashes: [...afterStashes].filter(([id]) => !beforeStashes.has(id)).map(([, entry]) => entry),
    removedStashes: [...beforeStashes].filter(([id]) => !afterStashes.has(id)).map(([, entry]) => entry),
    attribution: "observed-unattributed",
  };
}

function decodeObservationRecord(value: unknown): RoundGitObservationRecordV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row["version"] !== 1 || typeof row["operationId"] !== "string" || typeof row["taskFolderPath"] !== "string") return undefined;
  return row as unknown as RoundGitObservationRecordV1;
}

/** Find observed interference that still needs explicit owner handling. */
export async function inspectRoundGitInterferenceV1(
  taskFolderPath: string,
  options: {
    readonly liveOperationIds?: ReadonlySet<string>;
    readonly inspectLiveGitHolder?: GitIndexLockHolderInspectorV1;
  } = {}
): Promise<RoundGitInterferenceV1> {
  const folder = path.resolve(taskFolderPath);
  const evidenceFolder = path.join(folder, "round-git-state-v1");
  let names: string[];
  try {
    names = await fs.readdir(evidenceFolder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { unmergedPaths: [], stashOperationIds: [] };
    throw error;
  }
  const records: RoundGitObservationRecordV1[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const decoded = decodeObservationRecord(JSON.parse(await fs.readFile(path.join(evidenceFolder, name), "utf8")) as unknown);
      if (decoded && path.resolve(decoded.taskFolderPath) === folder) records.push(decoded);
    } catch {
      // An unreadable observation cannot establish that the working tree is safe.
      throw new Error(`Git interference evidence is unreadable: ${path.join(evidenceFolder, name)}`);
    }
  }
  if (records.length === 0) return { unmergedPaths: [], stashOperationIds: [] };
  // The observation wrapper is also used for non-Git workspaces. Its explicit
  // inability to resolve a repository means there is no Git state to hold;
  // genuine repository snapshot failures still carry a repositoryRoot and
  // remain conservatively inspectable.
  if (!records.some((record) => record.before || record.repositoryRoot)) return { unmergedPaths: [], stashOperationIds: [] };
  const current = records.find((record) => record.repositoryRoot)?.repositoryRoot ?? await resolveRepositoryRoot(folder);
  const snapshot = await captureRoundGitStateV1({ repositoryRoot: current, taskFolderPath: folder, roundId: "interference-check" });
  const currentUnmerged = new Set(snapshot.indexEntries.filter((entry) => entry.stage !== 0).map((entry) => entry.path));
  const unmergedPaths = new Set<string>();
  const stashOperationIds = new Set<string>();
  const stashObservations: RoundGitStashObservationV1[] = [];
  const indexLockNotices: string[] = [];
  // Another unfinished round in this task that is still running can own a lock
  // that appeared since its snapshot; an interrupted round's lock is then not
  // attributable and must be preserved.
  const anotherRoundStillRunning = (operationId: string): boolean =>
    records.some((other) => other.operationId !== operationId && isPendingRoundObservationV1(other) && options.liveOperationIds?.has(other.operationId));
  for (const record of records) {
    let delta = record.delta;
    if (isPendingRoundObservationV1(record) && !options.liveOperationIds?.has(record.operationId)) {
      // A process may have died before its finally path. Reconstruct an
      // observation now, clearly retaining the actual observation time and
      // unattributed status rather than losing the durable before snapshot.
      if (record.before) delta = compareRoundGitStateV1(record.before, snapshot);
      // The killed round may also have left its index lock behind. Settle it
      // with the same rules as a normal ending, against the persisted
      // before-round lock observation. A round that already settled its lock
      // before the after-round capture failed is not settled (or reported) twice.
      let indexLockSettlement = record.indexLockSettlement;
      if (!indexLockSettlement) {
        try {
          const lockRepositoryRoot = record.repositoryRoot ?? current;
          const indexLockPath = await resolveGitIndexLockPathV1(lockRepositoryRoot);
          indexLockSettlement = anotherRoundStillRunning(record.operationId)
            ? {
                outcome: "preserved",
                reason: "uncertain",
                detail: "another round in this task is still running and may own it",
                ageMs: snapshot.indexLock?.ageMs,
                lockPath: indexLockPath,
              }
            : await settleRoundGitIndexLockV1({
                repositoryRoot: lockRepositoryRoot,
                indexLockPath,
                before: record.indexLockBefore ?? record.before?.indexLock,
                after: snapshot.indexLock,
                ...(options.inspectLiveGitHolder ? { inspectLiveGitHolder: options.inspectLiveGitHolder } : {}),
              });
        } catch (error) {
          indexLockSettlement = {
            outcome: "unobserved",
            detail: `could not settle the index lock: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const lockNotice = describeIndexLockSettlementV1(indexLockSettlement);
        if (lockNotice) indexLockNotices.push(`Round ${record.operationId} was interrupted: ${lockNotice}`);
      }
      const recovered: RoundGitObservationRecordV1 = { ...record, after: snapshot, ...(delta ? { delta } : {}), indexLockSettlement };
      const evidencePath = path.join(evidenceFolder, `${record.operationId}.json`);
      const temporaryPath = `${evidencePath}.recovered.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(recovered, null, 2)}\n`);
      await fs.rename(temporaryPath, evidencePath);
    }
    // A before-only row can belong to a still-running operation. Keep it
    // pending until its owner disappears; otherwise a concurrent inspection
    // could persist a terminal snapshot and hide Git changes made later by
    // that live round.
    if (isPendingRoundObservationV1(record) && options.liveOperationIds?.has(record.operationId)) continue;
    for (const file of delta?.newUnmergedPaths ?? []) if (currentUnmerged.has(file)) unmergedPaths.add(file);
    const stashChanged = (delta?.addedStashes.length ?? 0) > 0 || (delta?.removedStashes.length ?? 0) > 0;
    if (stashChanged) {
      try {
        await fs.access(path.join(evidenceFolder, `${record.operationId}.stash-acknowledged`));
      } catch {
        stashOperationIds.add(record.operationId);
        stashObservations.push({
          operationId: record.operationId,
          attribution: "observed-unattributed",
          ...(record.before ? { observedFrom: record.before.observedAt } : {}),
          ...(record.after ? { observedUntil: record.after.observedAt } : {}),
          added: delta?.addedStashes ?? [],
          removed: delta?.removedStashes ?? [],
        });
      }
    }
  }
  return {
    unmergedPaths: [...unmergedPaths].sort(),
    stashOperationIds: [...stashOperationIds].sort(),
    ...(stashObservations.length ? { stashObservations } : {}),
    ...(indexLockNotices.length ? { indexLockNotices } : {}),
  };
}

/** True when `value` contains an ASCII control character (U+0000–U+001F). */
export function hasControlCharacterV1(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) {
      return true;
    }
  }
  return false;
}

/**
 * The one repository-relative path identity used for change tracking: forward
 * slashes, no leading `./`, no empty or `.` segments. Returns `undefined` for
 * anything that is not a safe repository-relative path (empty, absolute,
 * drive-letter, UNC, containing a `..` segment or a control character) —
 * callers must treat that as "not adoptable", never repair it.
 */
export function normalizeRepositoryRelativePathV1(candidate: string): string | undefined {
  if (typeof candidate !== "string" || hasControlCharacterV1(candidate)) {
    return undefined;
  }
  const slashed = candidate.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:(\/|$)/.test(slashed)) {
    return undefined;
  }
  const segments = slashed.split("/").filter((part) => part !== "" && part !== ".");
  if (segments.length === 0 || segments.some((part) => part === "..")) {
    return undefined;
  }
  return segments.join("/");
}

/** Stage only the selected conflict path, preserving all unrelated index entries. */
export async function keepWorkingTreeVersionForUnmergedPathV1(taskFolderPath: string, relativePath: string): Promise<void> {
  const folder = path.resolve(taskFolderPath);
  const normalized = normalizeRepositoryRelativePathV1(relativePath);
  if (!normalized) {
    throw new Error("The selected conflict path is not a safe repository-relative path.");
  }
  const repositoryRoot = await resolveRepositoryRoot(folder);
  const before = await captureRoundGitStateV1({ repositoryRoot, taskFolderPath: folder, roundId: "manual-git-resolution" });
  if (!before.indexEntries.some((entry) => entry.path === normalized && entry.stage !== 0)) {
    throw new Error(`${normalized} is no longer an unmerged path.`);
  }
  await execFileAsync("git", ["add", "--", normalized], { cwd: repositoryRoot, windowsHide: true });
  const after = await captureRoundGitStateV1({ repositoryRoot, taskFolderPath: folder, roundId: "manual-git-resolution" });
  if (after.indexEntries.some((entry) => entry.path === normalized && entry.stage !== 0)) {
    throw new Error(`Git still reports ${normalized} as unmerged after staging the working-tree version.`);
  }
}

/** Record the owner's explicit acknowledgement of a stash change; never alter stash contents. */
export async function acknowledgeRoundGitStashInterferenceV1(taskFolderPath: string, operationId: string): Promise<void> {
  const evidenceFolder = path.join(path.resolve(taskFolderPath), "round-git-state-v1");
  const evidencePath = path.join(evidenceFolder, `${operationId}.json`);
  const record = decodeObservationRecord(JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown);
  if (!record || record.operationId !== operationId || path.resolve(record.taskFolderPath) !== path.resolve(taskFolderPath)) {
    throw new Error("The selected stash observation does not belong to this task.");
  }
  if (!(record.delta?.addedStashes.length || record.delta?.removedStashes.length)) throw new Error("The selected observation contains no stash changes to acknowledge.");
  await fs.writeFile(path.join(evidenceFolder, `${operationId}.stash-acknowledged`), `${new Date().toISOString()}\n`, { flag: "wx" }).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
}

/**
 * Capture and persist Git state around a round callback, including callbacks
 * that fail or are cancelled. Evidence is one file per operation so concurrent
 * rounds cannot overwrite each other's observations.
 */
export async function withRoundGitStateObservationV1<T>(input: {
  readonly taskFolderPath: string;
  readonly roundId: string;
  readonly operationId: string;
  /** Injectable live-writer inspection for the index-lock settlement (tests). */
  readonly inspectLiveGitHolder?: GitIndexLockHolderInspectorV1;
  /** Pause between re-inspections of a circumstantial live-process finding (tests pass 0). */
  readonly lockRetryDelayMs?: number;
}, run: () => Promise<T>, onObserved?: (record: RoundGitObservationRecordV1) => void): Promise<{ readonly result: T; readonly record: RoundGitObservationRecordV1 }> {
  const taskFolderPath = path.resolve(input.taskFolderPath);
  let before: RoundGitStateSnapshotV1 | undefined;
  let after: RoundGitStateSnapshotV1 | undefined;
  let repositoryRoot: string | undefined;
  let indexLockBefore: GitIndexLockSnapshotV1 | undefined;
  let unavailableReason: string | undefined;
  let result!: T;
  let thrown: unknown;
  let didThrow = false;
  try {
    repositoryRoot = await resolveRepositoryRoot(taskFolderPath);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
  }
  if (repositoryRoot) {
    // The lock is observed on its own, before the broader index/stash capture,
    // so a failure of that capture cannot leave a leftover lock unreported.
    indexLockBefore = await observeGitIndexLockV1(repositoryRoot);
    try {
      before = await captureRoundGitStateV1({ ...input, taskFolderPath, repositoryRoot, indexLock: indexLockBefore });
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  const evidenceFolder = path.join(taskFolderPath, "round-git-state-v1");
  const evidencePath = path.join(evidenceFolder, `${input.operationId}.json`);
  if (repositoryRoot) {
    try {
      await fs.mkdir(evidenceFolder, { recursive: true });
      const initial: RoundGitObservationRecordV1 = {
        version: 1,
        roundId: input.roundId,
        operationId: input.operationId,
        taskFolderPath,
        repositoryRoot,
        ...(before ? { before } : {}),
        ...(indexLockBefore ? { indexLockBefore } : {}),
      };
      await fs.writeFile(evidencePath, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      unavailableReason = `could not persist before-round Git state evidence: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  try {
    result = await run();
  } catch (error) {
    thrown = error;
    didThrow = true;
  }
  let delta: RoundGitStateDeltaV1 | undefined;
  if (before && repositoryRoot) {
    try {
      after = await captureRoundGitStateV1({ ...input, taskFolderPath, repositoryRoot });
      delta = compareRoundGitStateV1(before, after);
    } catch (error) {
      unavailableReason = `could not capture the after-round Git state: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // Settle a newly appearing index lock once the round has run, failed or been
  // cancelled. The before snapshot's own lock observation decides ownership:
  // only a lock that was absent before the round and is still present and
  // unchanged afterward, with no live git writer, is removed.
  let indexLockSettlement: GitIndexLockSettlementV1 | undefined;
  if (repositoryRoot) {
    try {
      const indexLockPath = await resolveGitIndexLockPathV1(repositoryRoot);
      // `after` can be missing when the whole after-round capture failed (or
      // never ran); the lock is then observed directly so a leftover lock is
      // still reported with its age and recovery guidance.
      const afterLock = after?.indexLock ?? await captureGitIndexLockSnapshotV1(indexLockPath);
      indexLockSettlement = await settleRoundGitIndexLockV1({
        repositoryRoot,
        indexLockPath,
        before: indexLockBefore ?? before?.indexLock,
        after: afterLock,
        ...(input.inspectLiveGitHolder ? { inspectLiveGitHolder: input.inspectLiveGitHolder } : {}),
        ...(input.lockRetryDelayMs !== undefined ? { retryDelayMs: input.lockRetryDelayMs } : {}),
      });
    } catch (error) {
      indexLockSettlement = {
        outcome: "unobserved",
        detail: `could not settle the index lock: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const record: RoundGitObservationRecordV1 = {
    version: 1,
    roundId: input.roundId,
    operationId: input.operationId,
    taskFolderPath,
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(before ? { before } : {}),
    ...(indexLockBefore ? { indexLockBefore } : {}),
    ...(after ? { after } : {}),
    ...(delta ? { delta } : {}),
    ...(indexLockSettlement ? { indexLockSettlement } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  try {
    await fs.mkdir(evidenceFolder, { recursive: true });
    const temporaryPath = `${evidencePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(temporaryPath, evidencePath);
  } catch (error) {
    // Preserve the operation's real outcome. A failed evidence write must be
    // visible in the returned record to the caller, but must not mask it.
    if (!unavailableReason) {
      unavailableReason = `could not persist Git state evidence: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const finalRecord = unavailableReason && !record.unavailableReason ? { ...record, unavailableReason } : record;
  try {
    onObserved?.(finalRecord);
  } catch {
    // Observation reporting must not replace the operation's actual outcome.
  }
  if (didThrow) throw thrown;
  return { result, record: finalRecord };
}
