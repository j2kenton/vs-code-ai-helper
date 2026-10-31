/**
 * bugs3 Step 6: a scoped revert for edits a provider made after it never
 * received its prompt.
 *
 * Those edits are not work anyone asked for, so they are reported apart from
 * the round's ordinary edits and the owner is offered a revert. The revert is
 * deliberately narrow:
 *
 *  - only paths that were CLEAN before the round are offered (a path that was
 *    already dirty may hold the owner's own work, which `git checkout HEAD`
 *    would discard with the round's);
 *  - each offered path carries a content fingerprint taken when the card was
 *    posted, and a path that differs when the owner accepts is left alone;
 *  - a tracked path is restored from HEAD, a path HEAD does not know is
 *    removed, and a git failure (a lock, say) never falls through to a
 *    delete.
 *
 * The offer is also written to the task folder (`undelivered-prompt-edits-v1.json`)
 * with the HEAD it was made against, so it survives a reload, is never offered
 * twice, and a revert is refused once HEAD has moved (the "clean before the
 * round" judgement belongs to one baseline). Nothing runs until the owner
 * chooses the revert option.
 */
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface UndeliveredEditScopeV1 {
  /** The folder the round ran in. */
  readonly cwd: string;
  /** Changed paths that were clean before the round: safe to offer for revert. */
  readonly revertable: readonly string[];
  /** Changed paths that were already dirty before the round: reported, never reverted here. */
  readonly keptApart: readonly string[];
  /**
   * HEAD at the round boundary (before the provider ran), so "clean before the
   * round" and the revert's "from HEAD" name one commit. Absent when git could not say.
   */
  readonly baselineHead?: string;
  /**
   * The revertable paths with their content and index state read as the round
   * ended, before any card was posted. Absent when the runner could not read them.
   */
  readonly targets?: readonly UndeliveredRevertTargetV1[];
}

/** One path offered for revert, with the content it had when the offer was made. */
export interface UndeliveredRevertTargetV1 {
  readonly path: string;
  readonly fingerprint: string;
  /**
   * The path's index entry (mode, object, stage) when the offer was made, or
   * "absent". A restore from HEAD rewrites the index too, so staged content the owner
   * changed afterwards would be lost: a differing entry leaves the path alone. Absent
   * on records written before this field existed, which instead require the index to
   * still match HEAD.
   */
  readonly indexState?: string;
}

export interface UndeliveredRevertOutcomeV1 {
  readonly restored: readonly string[];
  readonly deleted: readonly string[];
  /** Paths whose content differs from the offer, left alone. */
  readonly changedSince: readonly string[];
  /** Paths refused as unsafe, or whose git step failed. */
  readonly failed: readonly string[];
  /** Set when HEAD moved since the offer, so nothing was touched. */
  readonly baselineMoved?: boolean;
}

/** Split a round's changed paths by whether they were dirty before it began. */
export function scopeUndeliveredPromptEditsV1(input: {
  readonly cwd: string;
  readonly filesChanged: readonly string[];
  readonly dirtyBefore: ReadonlySet<string>;
}): UndeliveredEditScopeV1 {
  const revertable: string[] = [];
  const keptApart: string[] = [];
  for (const file of input.filesChanged) {
    if (input.dirtyBefore.has(file)) {
      keptApart.push(file);
    } else {
      revertable.push(file);
    }
  }
  return { cwd: input.cwd, revertable, keptApart };
}

/** A repository-relative path that stays inside the repository and outside `.git`. */
export function isSafeRevertPathV1(relPath: string): boolean {
  if (relPath.length === 0 || relPath.includes("\0") || path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    return false;
  }
  const parts = relPath.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".")) {
    return false;
  }
  return parts[0]!.toLowerCase() !== ".git";
}

export interface UndeliveredRevertIoV1 {
  /** The repository root containing `cwd`, or undefined when git cannot say. */
  gitRoot(cwd: string): Promise<string | undefined>;
  /** Content fingerprint of `rel` under `root`; "absent" when it does not exist. */
  fingerprint(root: string, rel: string): Promise<string>;
  /** The commit HEAD names under `root`; undefined when git cannot say. */
  head?(root: string): Promise<string | undefined>;
  /** The index entry for `rel` ("absent" when not staged); undefined when git could not answer. */
  indexState(root: string, rel: string): Promise<string | undefined>;
  /** Whether the index entry for `rel` differs from HEAD; undefined when git could not answer. */
  indexDiffersFromHead(root: string, rel: string): Promise<boolean | undefined>;
  /** Whether HEAD contains `rel`. */
  inHead(root: string, rel: string): Promise<boolean>;
  /** Whether the index tracks `rel`; undefined when git could not answer. */
  inIndex(root: string, rel: string): Promise<boolean | undefined>;
  /** Restore `rel` (index and working tree) from HEAD. */
  restoreFromHead(root: string, rel: string): Promise<boolean>;
  /** Drop `rel` from the index without touching the file. */
  unstage(root: string, rel: string): Promise<boolean>;
  /** Delete `rel` from the working tree. */
  remove(root: string, rel: string): Promise<boolean>;
}

function execGitCode(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    cp.execFile("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (!error) {
        resolve({ code: 0, stdout: String(stdout) });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/** Whether `target`'s real parent stays inside `root` (no symlinked directory escape). */
function parentStaysInside(root: string, rel: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const parent = fs.realpathSync(path.dirname(path.join(root, rel)));
    const relative = path.relative(realRoot, parent);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export const realUndeliveredRevertIoV1: UndeliveredRevertIoV1 = {
  async gitRoot(cwd) {
    const result = await execGitCode(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return result.code === 0 && root.length > 0 ? path.resolve(root) : undefined;
  },
  fingerprint(root, rel) {
    const full = path.join(root, rel);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        return Promise.resolve(`link:${fs.readlinkSync(full)}`);
      }
      if (!stat.isFile()) {
        return Promise.resolve("other");
      }
      return Promise.resolve(`sha256:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    } catch {
      return Promise.resolve("absent");
    }
  },
  async head(root) {
    const result = await execGitCode(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const sha = result.stdout.trim();
    return result.code === 0 && sha.length > 0 ? sha : undefined;
  },
  async indexState(root, rel) {
    const result = await execGitCode(root, ["ls-files", "--stage", "--", rel]);
    if (result.code !== 0) {
      return undefined;
    }
    const entry = result.stdout.trim();
    return entry.length === 0 ? "absent" : entry;
  },
  async indexDiffersFromHead(root, rel) {
    const result = await execGitCode(root, ["diff", "--cached", "--quiet", "HEAD", "--", rel]);
    return result.code === 0 ? false : result.code === 1 ? true : undefined;
  },
  async inHead(root, rel) {
    return (await execGitCode(root, ["cat-file", "-e", `HEAD:${rel.replace(/\\/g, "/")}`])).code === 0;
  },
  async inIndex(root, rel) {
    const result = await execGitCode(root, ["ls-files", "--error-unmatch", "--", rel]);
    if (result.code === 0) {
      return true;
    }
    return result.code === 1 ? false : undefined;
  },
  async restoreFromHead(root, rel) {
    return (await execGitCode(root, ["checkout", "HEAD", "--", rel])).code === 0;
  },
  async unstage(root, rel) {
    return (await execGitCode(root, ["rm", "--cached", "-q", "-f", "--", rel])).code === 0;
  },
  remove(root, rel) {
    if (!parentStaysInside(root, rel)) {
      return Promise.resolve(false);
    }
    try {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  },
};

/** Fingerprint each offered path now, so the revert can tell if it moved later. */
export async function fingerprintRevertTargetsV1(
  cwd: string,
  paths: readonly string[],
  io: UndeliveredRevertIoV1 = realUndeliveredRevertIoV1
): Promise<UndeliveredRevertTargetV1[]> {
  const root = (await io.gitRoot(cwd)) ?? cwd;
  const targets: UndeliveredRevertTargetV1[] = [];
  for (const relPath of paths) {
    if (isSafeRevertPathV1(relPath)) {
      const indexState = await io.indexState(root, relPath);
      targets.push({
        path: relPath,
        fingerprint: await io.fingerprint(root, relPath),
        ...(indexState !== undefined ? { indexState } : {}),
      });
    }
  }
  return targets;
}

/** The commit the offer is made against, for `baselineHead`. */
export async function captureRevertBaselineHeadV1(
  cwd: string,
  io: UndeliveredRevertIoV1 = realUndeliveredRevertIoV1
): Promise<string | undefined> {
  const root = await io.gitRoot(cwd);
  return root === undefined || io.head === undefined ? undefined : io.head(root);
}

/**
 * Revert the offered paths that still match what was offered. With a
 * `baselineHead`, nothing is touched once HEAD has moved: restoring "from HEAD"
 * would then mean a different commit than the one the paths were judged clean
 * against.
 */
export async function revertUndeliveredPromptEditsV1(
  cwd: string,
  targets: readonly UndeliveredRevertTargetV1[],
  io: UndeliveredRevertIoV1 = realUndeliveredRevertIoV1,
  baselineHead?: string
): Promise<UndeliveredRevertOutcomeV1> {
  const restored: string[] = [];
  const deleted: string[] = [];
  const changedSince: string[] = [];
  const failed: string[] = [];
  const root = await io.gitRoot(cwd);
  if (root === undefined) {
    return { restored, deleted, changedSince, failed: targets.map((target) => target.path) };
  }
  if (baselineHead !== undefined && io.head !== undefined) {
    const now = await io.head(root);
    if (now !== baselineHead) {
      return { restored, deleted, changedSince: targets.map((target) => target.path), failed, baselineMoved: true };
    }
  }
  for (const target of targets) {
    if (!isSafeRevertPathV1(target.path)) {
      failed.push(target.path);
      continue;
    }
    if ((await io.fingerprint(root, target.path)) !== target.fingerprint) {
      changedSince.push(target.path);
      continue;
    }
    // Restoring from HEAD rewrites the index as well as the file, so staged
    // content the owner changed since the offer must stop the revert. A target
    // without a recorded index entry (an older record) can only be judged against
    // HEAD: anything staged then is left alone. An index that cannot be read is
    // not assumed clean.
    if (target.indexState !== undefined) {
      if ((await io.indexState(root, target.path)) !== target.indexState) {
        changedSince.push(target.path);
        continue;
      }
    } else if ((await io.indexDiffersFromHead(root, target.path)) !== false) {
      changedSince.push(target.path);
      continue;
    }
    if (await io.inHead(root, target.path)) {
      if (await io.restoreFromHead(root, target.path)) {
        restored.push(target.path);
      } else {
        failed.push(target.path);
      }
      continue;
    }
    // HEAD does not know this path: the round created it. Remove it from the
    // index first so no staged ghost is left, and never delete after a git failure.
    const indexed = await io.inIndex(root, target.path);
    if (indexed === undefined || (indexed && !(await io.unstage(root, target.path)))) {
      failed.push(target.path);
      continue;
    }
    if (await io.remove(root, target.path)) {
      deleted.push(target.path);
    } else {
      failed.push(target.path);
    }
  }
  return { restored, deleted, changedSince, failed };
}

/** The chat sentence for a finished revert. */
export function describeUndeliveredRevertOutcomeV1(outcome: UndeliveredRevertOutcomeV1): string {
  const parts: string[] = [];
  const done = outcome.restored.length + outcome.deleted.length;
  if (outcome.baselineMoved === true) {
    return (
      "Nothing was reverted: the repository's HEAD moved after the offer was made, so \"restore from your last commit\" would no longer " +
      "mean the commit these files were judged against. Revert the files by hand if you still want them gone."
    );
  }
  parts.push(
    done === 0
      ? "Nothing was reverted."
      : `Reverted ${done} file(s): ${outcome.restored.length} restored from your last commit, ${outcome.deleted.length} removed because the round created them.`
  );
  if (outcome.changedSince.length > 0) {
    parts.push(
      `Left alone because they changed after the offer was made: ${outcome.changedSince.join(", ")}.`
    );
  }
  if (outcome.failed.length > 0) {
    parts.push(`Could not revert: ${outcome.failed.join(", ")}. Nothing else was touched; revert these by hand.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Durable record of an undelivered-prompt offer
// ---------------------------------------------------------------------------

export const UNDELIVERED_PROMPT_EDITS_RECORD_FILE_V1 = "undelivered-prompt-edits-v1.json";

export type UndeliveredEditsRecordStatusV1 = "open" | "reverted" | "kept" | "superseded";

/** One round's undelivered-prompt edits, as offered. */
export interface UndeliveredEditsRecordV1 {
  readonly id: string;
  readonly at: string;
  readonly providerLabel: string;
  readonly cwd: string;
  /** HEAD when the offer was made; a revert is refused once it moves. */
  readonly baselineHead?: string;
  readonly revertable: readonly UndeliveredRevertTargetV1[];
  /** Paths that were already modified before the round: reported, never offered. */
  readonly keptApart: readonly string[];
  readonly status: UndeliveredEditsRecordStatusV1;
  readonly settledAt?: string;
}

interface UndeliveredEditsFileV1 {
  readonly version: 1;
  readonly records: readonly UndeliveredEditsRecordV1[];
}

const RECORD_STATUSES_V1: readonly string[] = ["open", "reverted", "kept", "superseded"];

function isRecordV1(value: unknown): value is UndeliveredEditsRecordV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.at === "string" &&
    typeof c.providerLabel === "string" &&
    typeof c.cwd === "string" &&
    typeof c.status === "string" &&
    RECORD_STATUSES_V1.includes(c.status) &&
    Array.isArray(c.keptApart) &&
    c.keptApart.every((entry) => typeof entry === "string") &&
    Array.isArray(c.revertable) &&
    c.revertable.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { fingerprint?: unknown }).fingerprint === "string" &&
        ((entry as { indexState?: unknown }).indexState === undefined ||
          typeof (entry as { indexState?: unknown }).indexState === "string")
    )
  );
}

/** Every well-formed record in the task folder; a missing or damaged file reads as none. */
export function readUndeliveredPromptEditsRecordsV1(taskFolderPath: string): UndeliveredEditsRecordV1[] {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(taskFolderPath, UNDELIVERED_PROMPT_EDITS_RECORD_FILE_V1), "utf8")
    ) as Partial<UndeliveredEditsFileV1>;
    return Array.isArray(parsed.records) ? parsed.records.filter(isRecordV1) : [];
  } catch {
    return [];
  }
}

function writeRecordsV1(taskFolderPath: string, records: readonly UndeliveredEditsRecordV1[]): void {
  const file = path.join(taskFolderPath, UNDELIVERED_PROMPT_EDITS_RECORD_FILE_V1);
  const temp = `${file}.${process.pid}.tmp`;
  const body: UndeliveredEditsFileV1 = { version: 1, records };
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/**
 * Record a new open offer. An earlier open record for the same folder is marked
 * superseded: only the newest round's offer is live.
 */
export function recordUndeliveredPromptEditsV1(
  taskFolderPath: string,
  input: Omit<UndeliveredEditsRecordV1, "id" | "status" | "settledAt">
): UndeliveredEditsRecordV1 {
  const id = crypto
    .createHash("sha256")
    .update(`${input.at}\0${input.cwd}\0${input.revertable.map((target) => target.path).join("\0")}`)
    .digest("hex")
    .slice(0, 16);
  const record: UndeliveredEditsRecordV1 = { ...input, id, status: "open" };
  const existing = readUndeliveredPromptEditsRecordsV1(taskFolderPath).map((entry) =>
    entry.status === "open" ? { ...entry, status: "superseded" as const, settledAt: input.at } : entry
  );
  writeRecordsV1(taskFolderPath, [...existing, record]);
  return record;
}

/** Close a record. Returns whether an open record with that id was found. */
export function settleUndeliveredPromptEditsRecordV1(
  taskFolderPath: string,
  id: string,
  status: Exclude<UndeliveredEditsRecordStatusV1, "open">,
  at: string = new Date().toISOString()
): boolean {
  let found = false;
  const next = readUndeliveredPromptEditsRecordsV1(taskFolderPath).map((entry) => {
    if (entry.id === id && entry.status === "open") {
      found = true;
      return { ...entry, status, settledAt: at };
    }
    return entry;
  });
  if (found) {
    writeRecordsV1(taskFolderPath, next);
  }
  return found;
}

/** The record the owner can still act on, if any. */
export function findOpenUndeliveredPromptEditsRecordV1(taskFolderPath: string): UndeliveredEditsRecordV1 | undefined {
  return readUndeliveredPromptEditsRecordsV1(taskFolderPath).find((entry) => entry.status === "open");
}
