import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Observation of a repository's `.git/index.lock` marker file.
 *
 * Git's index lock is a marker file, not proof of a live OS-held lock: its
 * existence only means a writer created it, and its age, `pgrep` alone and
 * timing relative to a round do not establish who still owns it. A snapshot
 * therefore records what was observed (existence, a stable identity, and a
 * timestamp) and leaves ownership to a separate, platform-appropriate
 * inspection step.
 */
export interface GitIndexLockSnapshotV1 {
  readonly state: "present" | "absent" | "unknown";
  readonly observedAt: string;
  /** Stable identity: size + mtime + content hash. Two snapshots agree only for the same file contents and modification time. */
  readonly identity?: string;
  readonly sizeBytes?: number;
  readonly modifiedAtMs?: number;
  readonly createdAtMs?: number;
  /** Millisecond age of the lock file at observation time, when the filesystem reports a creation time. */
  readonly ageMs?: number;
  /** Why the state is unknown, when it is. */
  readonly reason?: string;
}

/** Result of inspecting whether a live git process can still own the lock. */
export interface GitIndexLockHolderInspectionV1 {
  /** False means the platform could not determine liveness; treat as "preserve". */
  readonly known: boolean;
  /** Only meaningful when `known` is true. */
  readonly live: boolean;
  /** The finding rests on a process merely running in or naming the repository (not on an open lock file), so it may be transient. */
  readonly circumstantial?: boolean;
  readonly detail?: string;
}

export type GitIndexLockSettlementV1 =
  | { readonly outcome: "none-observed" }
  | {
      readonly outcome: "preserved";
      readonly reason: "pre-existing" | "baseline-unknown" | "uncertain" | "live-holder" | "replaced" | "removal-failed";
      readonly detail?: string;
      readonly ageMs?: number;
      readonly lockPath?: string;
    }
  /** The lock's state could not be read, so neither "no lock" nor "a lock" is claimed. */
  | { readonly outcome: "unobserved"; readonly detail?: string; readonly lockPath?: string }
  | { readonly outcome: "removed"; readonly ageMs?: number; readonly detail?: string; readonly lockPath?: string };

/** Injectable live-writer inspection (tests, and platforms with their own mechanism). */
export type GitIndexLockHolderInspectorV1 = (
  repositoryRoot: string,
  indexLockPath: string
) => Promise<GitIndexLockHolderInspectionV1>;

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.toString("utf8");
}

/**
 * Resolve the actual index-lock path through Git, including linked worktrees
 * where `.git` is a file pointing at a per-worktree git directory.
 */
export async function resolveGitIndexLockPathV1(repositoryRoot: string): Promise<string> {
  const relative = (await gitOutput(path.resolve(repositoryRoot), ["rev-parse", "--git-path", "index.lock"])).trim();
  if (!relative) throw new Error("git rev-parse returned no index.lock path");
  return path.isAbsolute(relative) ? relative : path.resolve(repositoryRoot, relative);
}

/** Capture the lock's existence, identity and timestamps without changing it. */
export async function captureGitIndexLockSnapshotV1(
  indexLockPath: string,
  now?: Date
): Promise<GitIndexLockSnapshotV1> {
  const observedAt = (now ?? new Date()).toISOString();
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(indexLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", observedAt };
    return { state: "unknown", observedAt, reason: error instanceof Error ? error.message : String(error) };
  }
  let content: Buffer;
  try {
    content = await fs.readFile(indexLockPath);
  } catch (error) {
    return { state: "unknown", observedAt, reason: error instanceof Error ? error.message : String(error) };
  }
  const modifiedAtMs = stat.mtimeMs;
  // Filesystems without a creation time report 0; fall back to the modification
  // time. The older of the two is the lock's age as far as anyone can tell: a
  // lock rewritten or restored with an earlier mtime is at least that old.
  const createdAtMs = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, modifiedAtMs) : modifiedAtMs;
  const sizeBytes = stat.size;
  const identity = createHash("sha256")
    .update(`${sizeBytes}\0${modifiedAtMs}\0`)
    .update(content)
    .digest("hex");
  return {
    state: "present",
    observedAt,
    identity,
    sizeBytes,
    modifiedAtMs,
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    ...(createdAtMs !== undefined ? { ageMs: Math.max(0, Date.parse(observedAt) - createdAtMs) } : {}),
  };
}

/** Human, age-aware description of how long a lock has existed. */
export function describeIndexLockAgeV1(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "an unknown age";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds} second(s) old`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute(s) old`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour(s) old`;
  const days = Math.round(hours / 24);
  return `${days} day(s) old`;
}

/** One line describing a lock settlement for the round outcome; undefined when there is nothing to say. */
export function describeIndexLockSettlementV1(settlement: GitIndexLockSettlementV1): string | undefined {
  const ageText = (ageMs?: number): string => (ageMs !== undefined ? describeIndexLockAgeV1(ageMs) : "an unknown age");
  const where = (lockPath?: string): string => lockPath ?? "<repository>/.git/index.lock";
  const clearIt = (lockPath?: string): string =>
    `If git reports the lock and no git command is running in this repository (for example, nothing shows in \`pgrep -a git\`), delete ${where(lockPath)}`;
  switch (settlement.outcome) {
    case "none-observed":
      return undefined;
    case "removed":
      return `removed an abandoned index lock (${ageText(settlement.ageMs)}) that appeared during the round; no live git process was found holding it`;
    case "unobserved":
      return `could not check whether the round left an index lock${settlement.detail ? ` (${settlement.detail})` : ""}. ${clearIt(settlement.lockPath)}.`;
    case "preserved": {
      const detail = settlement.detail ? ` — ${settlement.detail}` : "";
      const age = ageText(settlement.ageMs);
      switch (settlement.reason) {
        case "pre-existing":
          return `left an index lock (${age}) in place because it was already present before the round and may belong to you${detail}. ${clearIt(settlement.lockPath)}.`;
        case "baseline-unknown":
          return `left an index lock (${age}) in place because it could not be established whether it was there before the round${detail}. ${clearIt(settlement.lockPath)}.`;
        case "live-holder":
          return `left an index lock (${age}) in place because a live git process may still hold it${detail}. Wait for that git command to finish; if it never does, stop it, then delete ${where(settlement.lockPath)}.`;
        case "replaced":
          return `left an index lock (${age}) in place because it changed before it could be removed${detail}. ${clearIt(settlement.lockPath)}.`;
        case "uncertain":
          return `left an index lock (${age}) in place because its owner could not be determined${detail}. ${clearIt(settlement.lockPath)}.`;
        case "removal-failed":
          return `could not remove an index lock (${age})${detail}. ${clearIt(settlement.lockPath)}.`;
      }
    }
  }
}
/** Options for tests and platforms that expose process information somewhere other than `/proc`. */
export interface GitIndexLockProcessScanOptionsV1 {
  readonly procRoot?: string;
  readonly platform?: NodeJS.Platform;
  /** The user this process runs as; defaults to `process.getuid()`. */
  readonly currentUid?: number;
  /** Mount table used to recognise shared filesystems; defaults to `/proc/self/mountinfo`. */
  readonly mountInfoPath?: string;
}

const PROCESS_GONE_CODES_V1 = new Set(["ENOENT", "ESRCH", "ENOTDIR"]);

function isProcessGoneErrorV1(error: unknown): boolean {
  return PROCESS_GONE_CODES_V1.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

/** Filesystems other hosts or sandboxes can mount at the same time, whose writers this machine cannot see. */
const SHARED_FILESYSTEM_TYPES_V1 = /^(nfs\d*|cifs|smb3?|smbfs|9p|ceph|glusterfs|lustre|afs|ncpfs|virtiofs|vboxsf|vmhgfs|prl_fs|fuse(\..*)?)$/;

function unescapeMountPathV1(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

interface MountPlacementV1 {
  readonly type: string;
  /** Path inside the source filesystem that is mounted here; anything other than `/` is a bind mount or volume subtree. */
  readonly root: string;
}

/** The mount containing `target`, or undefined when the mount table cannot place it. */
async function mountPlacementOfV1(target: string, mountInfoPath: string): Promise<MountPlacementV1 | undefined> {
  let table: string;
  try {
    table = await fs.readFile(mountInfoPath, "utf8");
  } catch {
    return undefined;
  }
  let best: { length: number; type: string; root: string } | undefined;
  for (const line of table.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(" ");
    const tail = line.slice(separator + 3).split(" ");
    const mountPoint = head[4] === undefined ? undefined : unescapeMountPathV1(head[4]);
    const type = tail[0];
    if (!mountPoint || !type) continue;
    const root = head[3] === undefined ? "/" : unescapeMountPathV1(head[3]);
    const covers = mountPoint === "/" || target === mountPoint || target.startsWith(mountPoint + path.sep);
    if (covers && (!best || mountPoint.length >= best.length)) best = { length: mountPoint.length, type, root };
  }
  return best ? { type: best.type, root: best.root } : undefined;
}

/**
 * Default live-writer inspection. The lock file carries no owner, so the only
 * evidence of a live writer is circumstantial and the scan must be complete to
 * be trusted. "No live writer" (`known: true, live: false`) is reported only
 * when ALL of these hold:
 *
 *   - the platform exposes `/proc` (not Windows or macOS);
 *   - this process can see every process of the lock file's owner (it runs as
 *     that user or as root), and the repository is not on a filesystem other
 *     hosts or sandboxes can mount, nor on a bind mount or container volume
 *     (mount root other than `/`), where their writers would be invisible;
 *   - every process owned by the lock's user was read completely: a failure to
 *     read its status, open files, working directory, command line or
 *     environment (other than the process having exited) makes the result
 *     `known: false`, because incomplete visibility is never evidence of absence.
 *
 * A live holder is any process with the lock file open, or a `git`/`git-*`
 * process running in the repository or naming it on its command line. A git
 * process that could be redirected at the repository from elsewhere (`-C`,
 * `--git-dir`, `--work-tree`, `GIT_DIR`, ...) is treated as unreadable.
 */
export async function findLiveGitHolderV1(
  repositoryRoot: string,
  indexLockPath?: string,
  options: GitIndexLockProcessScanOptionsV1 = {}
): Promise<GitIndexLockHolderInspectionV1> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return { known: false, live: false, detail: `process inspection is not implemented on ${platform === "win32" ? "Windows" : platform}` };
  }
  if (!indexLockPath) {
    return { known: false, live: false, detail: "no lock file was given to inspect" };
  }
  const procRoot = options.procRoot ?? "/proc";
  const realRoot = await fs.realpath(repositoryRoot).catch(() => path.resolve(repositoryRoot));
  const lockDir = await fs.realpath(path.dirname(indexLockPath)).catch(() => path.dirname(indexLockPath));
  const realLock = path.join(lockDir, path.basename(indexLockPath));
  let lockUid: number;
  try {
    lockUid = (await fs.stat(indexLockPath)).uid;
  } catch (error) {
    return { known: false, live: false, detail: `the lock file's owner could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const currentUid = options.currentUid ?? process.getuid?.();
  if (currentUid === undefined || (currentUid !== 0 && currentUid !== lockUid)) {
    return { known: false, live: false, detail: "the lock file belongs to another user, whose processes cannot all be inspected from here" };
  }
  const placement = await mountPlacementOfV1(realLock, options.mountInfoPath ?? "/proc/self/mountinfo");
  if (placement === undefined) {
    return { known: false, live: false, detail: "the filesystem holding the repository could not be identified" };
  }
  if (SHARED_FILESYSTEM_TYPES_V1.test(placement.type)) {
    return { known: false, live: false, detail: `the repository is on a shared filesystem (${placement.type}), where git processes on other machines or sandboxes cannot be seen` };
  }
  // A bind mount or volume subtree (mount root other than `/`) is how containers
  // share a folder with the host or with sibling containers. Their git processes
  // live in another PID namespace and are invisible to this scan.
  if (placement.root !== "/") {
    return { known: false, live: false, detail: `the repository is on a mounted volume or bind mount (${placement.root}), which the host or other containers may also use, so their git processes cannot be seen from here` };
  }
  let entries: string[];
  try {
    entries = await fs.readdir(procRoot);
  } catch (error) {
    return { known: false, live: false, detail: `process inspection is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let unreadable = 0;
  let holder: GitIndexLockHolderInspectionV1 | undefined;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pidDir = path.join(procRoot, entry);
    // Whose process is it? `status` is readable for every process, unlike the
    // directory owner (root for non-dumpable processes).
    let owned: boolean;
    try {
      const status = await fs.readFile(path.join(pidDir, "status"), "utf8");
      const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
      if (!match) {
        unreadable += 1;
        continue;
      }
      owned = Number(match[1]) === lockUid || Number(match[2]) === lockUid;
    } catch (error) {
      if (!isProcessGoneErrorV1(error)) unreadable += 1; // exited while scanning, otherwise unreadable
      continue;
    }
    if (!owned) continue;
    let inspectable = true;
    let comm = "";
    try {
      comm = (await fs.readFile(path.join(pidDir, "comm"), "utf8")).trim();
    } catch (error) {
      if (isProcessGoneErrorV1(error)) continue;
      inspectable = false;
    }
    // Any process with the lock file open is a live writer, whatever it is called.
    try {
      for (const fd of await fs.readdir(path.join(pidDir, "fd"))) {
        try {
          const target = await fs.readlink(path.join(pidDir, "fd", fd));
          if (target === realLock || target === `${realLock} (deleted)`) {
            return { known: true, live: true, detail: `process ${entry}${comm ? ` (${comm})` : ""} has the lock file open` };
          }
        } catch (error) {
          if (!isProcessGoneErrorV1(error)) inspectable = false; // a descriptor closing mid-scan is not an access failure
        }
      }
    } catch (error) {
      if (isProcessGoneErrorV1(error)) continue;
      inspectable = false;
    }
    if (comm === "" || /^git($|-)/.test(comm)) {
      let cwd: string | undefined;
      try {
        cwd = await fs.readlink(path.join(pidDir, "cwd"));
      } catch (error) {
        if (isProcessGoneErrorV1(error)) continue;
        inspectable = false;
      }
      let commandLine: string | undefined;
      try {
        commandLine = await fs.readFile(path.join(pidDir, "cmdline"), "utf8");
      } catch (error) {
        if (isProcessGoneErrorV1(error)) continue;
        inspectable = false;
      }
      let environment: string | undefined;
      try {
        environment = await fs.readFile(path.join(pidDir, "environ"), "utf8");
      } catch (error) {
        if (isProcessGoneErrorV1(error)) continue;
        inspectable = false;
      }
      if (cwd !== undefined) {
        const realCwd = await fs.realpath(cwd).catch(() => cwd);
        if (realCwd === realRoot || realCwd.startsWith(realRoot + path.sep)) {
          holder ??= { known: true, live: true, circumstantial: true, detail: `git process ${entry} is running in this repository` };
          continue;
        }
      }
      if (commandLine !== undefined && comm !== "" && commandLine.includes(realRoot)) {
        holder ??= { known: true, live: true, circumstantial: true, detail: `git process ${entry} names this repository on its command line` };
        continue;
      }
      const args = (commandLine ?? "").split("\0");
      const redirected =
        args.some((arg) => arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) ||
        /(^|\0)GIT_(DIR|WORK_TREE|INDEX_FILE)=/.test(environment ?? "");
      if (redirected) inspectable = false; // it may be operating on this repository from elsewhere
    }
    if (!inspectable) unreadable += 1;
  }
  if (holder) return holder;
  if (unreadable > 0) {
    return {
      known: false,
      live: false,
      detail: `${unreadable} process(es) owned by the lock's user could not be fully inspected, so a live writer cannot be ruled out`,
    };
  }
  return { known: true, live: false };
}

/**
 * Decide what to do with an index lock observed around a round, and remove it
 * only when it appeared during the round, is unchanged, and inspection found no
 * live writer after examining every candidate process. Pre-existing, replaced,
 * externally held, unobserved and uncertain locks are always preserved and
 * reported with the lock's age and what the owner can do.
 */
export async function settleRoundGitIndexLockV1(input: {
  readonly repositoryRoot: string;
  readonly indexLockPath: string;
  readonly before?: GitIndexLockSnapshotV1;
  readonly after?: GitIndexLockSnapshotV1;
  readonly now?: Date;
  readonly inspectLiveGitHolder?: GitIndexLockHolderInspectorV1;
  /** Pause between re-inspections of a circumstantial live-process finding; tests pass 0. */
  readonly retryDelayMs?: number;
}): Promise<GitIndexLockSettlementV1> {
  const now = input.now ?? new Date();
  const lockPath = input.indexLockPath;
  const { before, after } = input;
  if (!after) {
    return { outcome: "unobserved", detail: "the lock state after the round was not captured", lockPath };
  }
  if (after.state === "absent") return { outcome: "none-observed" };
  if (after.state === "unknown") {
    return { outcome: "unobserved", detail: after.reason ?? "the lock could not be read", lockPath };
  }
  const ageMs = after.ageMs;
  // A lock that was already present before the round is never attributed to
  // the round, even if its contents changed meanwhile.
  if (before?.state === "present") {
    return {
      outcome: "preserved",
      reason: "pre-existing",
      ageMs,
      lockPath,
      ...(before.identity !== after.identity ? { detail: "its contents changed during the round" } : {}),
    };
  }
  // No trustworthy "absent" baseline: it cannot be shown that the round, rather
  // than someone else, created this lock.
  if (before?.state !== "absent") {
    return {
      outcome: "preserved",
      reason: "baseline-unknown",
      ageMs,
      lockPath,
      ...(before?.reason ? { detail: before.reason } : {}),
    };
  }
  const inspect: GitIndexLockHolderInspectorV1 =
    input.inspectLiveGitHolder ?? ((root, lock): Promise<GitIndexLockHolderInspectionV1> => findLiveGitHolderV1(root, lock));
  let holder: GitIndexLockHolderInspectionV1 = { known: false, live: false };
  // A git command that merely runs in the repository (a status refresh) is
  // usually short-lived; look again before concluding the lock is held. A
  // process with the lock file open is definitive and is not retried.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      holder = await inspect(input.repositoryRoot, lockPath);
    } catch (error) {
      holder = { known: false, live: false, detail: `process inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!(holder.known && holder.live && holder.circumstantial) || attempt === 2) break;
    await new Promise<void>((resolve) => setTimeout(resolve, input.retryDelayMs ?? 300));
  }
  if (!holder.known) {
    return { outcome: "preserved", reason: "uncertain", detail: holder.detail, ageMs, lockPath };
  }
  if (holder.live) {
    return { outcome: "preserved", reason: "live-holder", detail: holder.detail, ageMs, lockPath };
  }
  // Recheck identity immediately before removal: a lock that changed between
  // the after-observation and now may belong to a new writer and is preserved.
  const recheck = await captureGitIndexLockSnapshotV1(lockPath, now);
  if (recheck.state !== "present") {
    return { outcome: "preserved", reason: "replaced", detail: "the lock disappeared before removal", ageMs, lockPath };
  }
  if (recheck.identity !== after.identity) {
    return { outcome: "preserved", reason: "replaced", detail: "the lock's identity changed between observation and removal", ageMs, lockPath };
  }
  try {
    await fs.unlink(lockPath);
    return { outcome: "removed", ageMs, lockPath };
  } catch (error) {
    return { outcome: "preserved", reason: "removal-failed", detail: error instanceof Error ? error.message : String(error), ageMs, lockPath };
  }
}

/** Does a git failure message describe a stale index lock? */
export function isStaleIndexLockFailureV1(stderr: string): boolean {
  return /index\.lock/.test(stderr) && /(File exists|Unable to create|another git process|index\.lock.*exists)/i.test(stderr);
}

/**
 * Age-aware diagnosis for an Ensemble-owned Git failure that mentions the index
 * lock, replacing git's own "another git process seems to be running" with the
 * lock's age and concrete recovery guidance.
 */
export async function buildIndexLockFailureDiagnosisV1(input: {
  readonly repositoryRoot: string;
  readonly stderr: string;
  readonly now?: Date;
}): Promise<string> {
  let lockPath: string | undefined;
  try {
    lockPath = await resolveGitIndexLockPathV1(input.repositoryRoot);
  } catch {
    lockPath = undefined;
  }
  let ageText = "an unknown age";
  if (lockPath) {
    const snapshot = await captureGitIndexLockSnapshotV1(lockPath, input.now);
    if (snapshot.state === "present" && snapshot.ageMs !== undefined) {
      ageText = describeIndexLockAgeV1(snapshot.ageMs);
    }
  }
  const where = lockPath ?? "<repository>/.git/index.lock";
  return (
    `A git operation failed because an index lock is present (${ageText}). ` +
    `If no git process is actually running in this repository, remove ${where} and retry. ` +
    `Do not delete the lock while a git command (a commit, a check, or a change scan) is still running.`
  );
}
