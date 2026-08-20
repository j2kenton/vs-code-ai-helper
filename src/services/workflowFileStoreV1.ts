/**
 * Workflow file store (plan §1.8).
 *
 * The one mutation surface V1 workflow code uses for files under registered
 * roots. Every operation is exact and nonrecursive:
 *
 *  - exclusive creation (same-directory temp file, then `link()`ed into
 *    place — atomic, and `link` itself never clobbers an existing target);
 *  - same-directory temp-then-rename replacement guarded by an exact
 *    revision check;
 *  - bounded reads (a size ceiling checked against the open handle's stat,
 *    not a racy pre-stat);
 *  - bounded, nonrecursive directory listing (read-only; an entry-count
 *    ceiling, never a filesystem walk);
 *  - exact-file unlink guarded by an exact revision check;
 *  - empty-directory-only rmdir;
 *  - nonrecursive mkdir (a missing parent is a failure, not an implicit
 *    mkdir -p).
 *
 * Path safety (workflowPathSafetyV1) is revalidated immediately before every
 * mutation and each mutation is verified afterward. Unsupported roots and
 * unsafe paths return the stable `unavailable` coordinator outcome codes
 * (`workspaceRootUnsupported` / `workspacePathUnsafe`); untrusted roots stay
 * readable but reject mutation. Failure results carry codes and at most an
 * errno — never raw paths — per the privacy contract (plan §2.2).
 *
 * These are cooperative safeguards within the extension host, not an
 * adversarial cross-process guarantee (plan risks).
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { unavailableV1, WorkflowUnavailableV1 } from "../types/workflowAvailabilityV1";
import {
  checkNoReparseComponentsV1,
  classifyWorkflowRootV1,
  resolveWorkflowFsPathV1,
  WorkflowRootV1,
} from "./workflowPathSafetyV1";

export interface WorkflowFileLocatorV1 {
  readonly rootId: string;
  /** Forward-slash root-relative locator (workflowPathSafetyV1 rules). */
  readonly relativePath: string;
}

/** Opaque exact-revision token: size, mtime (ns), and inode of one observation. */
export type WorkflowFileRevisionV1 = string;

export type WorkflowFileStoreFailureCodeV1 =
  | "targetMissing"
  | "targetExists"
  | "revisionMismatch"
  | "notAFile"
  | "notADirectory"
  | "directoryNotEmpty"
  | "parentMissing"
  | "readLimitExceeded"
  | "verificationFailed"
  | "ioError";

export type WorkflowFileStoreResultV1<T> =
  | { readonly kind: "ok"; readonly value: T }
  | WorkflowUnavailableV1
  | {
      readonly kind: "failed";
      readonly code: WorkflowFileStoreFailureCodeV1;
      /** Sanitized errno string (e.g. "EACCES") when an ioError has one. */
      readonly errno?: string;
    };

export interface WorkflowFileStatV1 {
  readonly kind: "missing" | "file" | "directory";
  /** Present only for kind "file". */
  readonly revision?: WorkflowFileRevisionV1;
}

export interface WorkflowFileReadV1 {
  readonly bytes: Buffer;
  readonly revision: WorkflowFileRevisionV1;
  readonly sha256: string;
}

export interface WorkflowFileWriteV1 {
  readonly revision: WorkflowFileRevisionV1;
  readonly sha256: string;
}

export interface WorkflowDirectoryEntryV1 {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface WorkflowFileStoreV1 {
  stat(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<WorkflowFileStatV1>>;
  readFileBounded(
    locator: WorkflowFileLocatorV1,
    maxBytes: number
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileReadV1>>;
  /**
   * Read-only, nonrecursive listing of one exact directory. Fails with
   * `readLimitExceeded` when the directory holds more than `maxEntries`
   * entries rather than returning a truncated view.
   */
  listDirectoryBounded(
    locator: WorkflowFileLocatorV1,
    maxEntries: number
  ): Promise<WorkflowFileStoreResultV1<readonly WorkflowDirectoryEntryV1[]>>;
  createFileExclusive(
    locator: WorkflowFileLocatorV1,
    bytes: Buffer
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileWriteV1>>;
  replaceFileExact(
    locator: WorkflowFileLocatorV1,
    bytes: Buffer,
    expectedRevision: WorkflowFileRevisionV1
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileWriteV1>>;
  deleteFileExact(
    locator: WorkflowFileLocatorV1,
    expectedRevision: WorkflowFileRevisionV1
  ): Promise<WorkflowFileStoreResultV1<void>>;
  createDirectory(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<void>>;
  deleteEmptyDirectory(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<void>>;
}

function revisionOfStats(stats: fs.BigIntStats): WorkflowFileRevisionV1 {
  return `v1:${stats.size}:${stats.mtimeNs}:${stats.ino}`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ioFailure(error: unknown): { kind: "failed"; code: "ioError"; errno?: string } {
  const errno = (error as NodeJS.ErrnoException).code;
  return { kind: "failed", code: "ioError", ...(typeof errno === "string" ? { errno } : {}) };
}

type ResolvedTarget =
  | { readonly ok: true; readonly fsPath: string; readonly segments: readonly string[]; readonly root: WorkflowRootV1 }
  | { readonly ok: false; readonly outcome: WorkflowUnavailableV1 };

class WorkflowFileStoreImplV1 implements WorkflowFileStoreV1 {
  private readonly rootsById: ReadonlyMap<string, WorkflowRootV1>;

  constructor(roots: readonly WorkflowRootV1[]) {
    const byId = new Map<string, WorkflowRootV1>();
    for (const root of roots) {
      if (byId.has(root.rootId)) {
        throw new Error(`duplicate workflow root id: ${root.rootId}`);
      }
      byId.set(root.rootId, root);
    }
    this.rootsById = byId;
  }

  /**
   * Shared entry check: known root, supported root shape, safe contained
   * locator, and (for mutation) a trusted root. The reparse walk is NOT done
   * here — mutations re-run it immediately before touching the filesystem,
   * and reads run it once on their own.
   */
  private resolve(locator: WorkflowFileLocatorV1, forMutation: boolean): ResolvedTarget {
    const root = this.rootsById.get(locator.rootId);
    if (!root) {
      return { ok: false, outcome: unavailableV1("workspaceRootUnsupported") };
    }
    const classification = classifyWorkflowRootV1(root.fsPath);
    if (!classification.ok) {
      return { ok: false, outcome: unavailableV1("workspaceRootUnsupported") };
    }
    if (forMutation && !root.trustedForMutation) {
      return { ok: false, outcome: unavailableV1("workspaceRootUnsupported") };
    }
    // Re-consult the root's LIVE trust, not just the one-time flag recorded
    // at registration: a root kind that re-verifies on every `ensure*` call
    // (task-folder roots) can withdraw trust after registration, and a
    // consumer holding an older captured locator must not be able to mutate
    // through it once that happens.
    if (forMutation && root.isCurrentlyTrustedForMutation && !root.isCurrentlyTrustedForMutation()) {
      return { ok: false, outcome: unavailableV1("workspaceRootUnsupported") };
    }
    // READ-ONLY root self-locator: `"."` addresses the registered root
    // itself — the §7.2 read session must be able to list a root's own
    // top-level entries (and seed discovery walks) even though the path-
    // safety rules reject `.` segments inside deeper locators. Mutations
    // never accept it: the safety resolution below rejects it as before,
    // so the root directory itself can never be a mutation target.
    if (!forMutation && locator.relativePath === ".") {
      return { ok: true, fsPath: path.resolve(root.fsPath), segments: [], root };
    }
    const resolution = resolveWorkflowFsPathV1(root, locator.relativePath);
    if (!resolution.ok) {
      return { ok: false, outcome: unavailableV1("workspacePathUnsafe") };
    }
    return { ok: true, fsPath: resolution.fsPath, segments: resolution.segments, root };
  }

  private async revalidateReparse(target: {
    readonly root: WorkflowRootV1;
    readonly segments: readonly string[];
  }): Promise<WorkflowUnavailableV1 | undefined> {
    const check = await checkNoReparseComponentsV1(target.root, target.segments);
    return check.safe ? undefined : unavailableV1("workspacePathUnsafe");
  }

  async stat(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<WorkflowFileStatV1>> {
    const target = this.resolve(locator, false);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let stats: fs.BigIntStats;
    try {
      stats = await fs.promises.lstat(target.fsPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: { kind: "missing" } };
      }
      return ioFailure(error);
    }
    if (stats.isDirectory()) {
      return { kind: "ok", value: { kind: "directory" } };
    }
    if (stats.isFile()) {
      return { kind: "ok", value: { kind: "file", revision: revisionOfStats(stats) } };
    }
    return { kind: "failed", code: "notAFile" };
  }

  async readFileBounded(
    locator: WorkflowFileLocatorV1,
    maxBytes: number
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileReadV1>> {
    const target = this.resolve(locator, false);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(target.fsPath, "r");
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) {
        return { kind: "failed", code: "notAFile" };
      }
      if (stats.size > BigInt(maxBytes)) {
        return { kind: "failed", code: "readLimitExceeded" };
      }
      const bytes = Buffer.alloc(Number(stats.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) {
        return { kind: "failed", code: "verificationFailed" };
      }
      return {
        kind: "ok",
        value: { bytes, revision: revisionOfStats(stats), sha256: sha256Hex(bytes) },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      if ((error as NodeJS.ErrnoException).code === "EISDIR") {
        return { kind: "failed", code: "notAFile" };
      }
      return ioFailure(error);
    } finally {
      await handle?.close();
    }
  }

  async listDirectoryBounded(
    locator: WorkflowFileLocatorV1,
    maxEntries: number
  ): Promise<WorkflowFileStoreResultV1<readonly WorkflowDirectoryEntryV1[]>> {
    const target = this.resolve(locator, false);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(target.fsPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      if (code === "ENOTDIR") {
        return { kind: "failed", code: "notADirectory" };
      }
      return ioFailure(error);
    }
    if (entries.length > maxEntries) {
      return { kind: "failed", code: "readLimitExceeded" };
    }
    return {
      kind: "ok",
      value: entries
        .map(
          (entry): WorkflowDirectoryEntryV1 => ({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          })
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  /** Post-mutation verification: re-read and require the exact bytes just written. */
  private async verifyWrittenFile(
    fsPath: string,
    expectedSha256: string,
    expectedLength: number
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileWriteV1>> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(fsPath, "r");
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || stats.size !== BigInt(expectedLength)) {
        return { kind: "failed", code: "verificationFailed" };
      }
      const bytes = Buffer.alloc(expectedLength);
      const { bytesRead } = await handle.read(bytes, 0, expectedLength, 0);
      if (bytesRead !== expectedLength || sha256Hex(bytes) !== expectedSha256) {
        return { kind: "failed", code: "verificationFailed" };
      }
      return { kind: "ok", value: { revision: revisionOfStats(stats), sha256: expectedSha256 } };
    } catch {
      return { kind: "failed", code: "verificationFailed" };
    } finally {
      await handle?.close();
    }
  }

  async createFileExclusive(
    locator: WorkflowFileLocatorV1,
    bytes: Buffer
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileWriteV1>> {
    const target = this.resolve(locator, true);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    // Item 10 (2026-08-17..19 workflow-defects batch): a direct `wx` write to
    // the target path is exclusive (never clobbers an existing file) but not
    // ATOMIC — a crash, kill, or thrown error partway through the write can
    // leave a truncated (in the worst case 0-byte) file sitting at the final
    // path, permanently: `verifyWrittenFile` below catches the corruption and
    // reports it, but nothing removes the bad file, and every future attempt
    // then fails `targetExists` against it forever. Write to a same-directory
    // temp file (still `wx`, so a colliding temp name still fails loudly),
    // then `link()` it into place: `link` fails with EEXIST if the target
    // already exists — so exclusivity is preserved — and otherwise makes the
    // complete, already-fully-written bytes visible under the final name in
    // one filesystem operation, exactly like `replaceFileExact`'s temp+rename.
    const tempPath = path.join(
      path.dirname(target.fsPath),
      `.ensemble-create-${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      await fs.promises.writeFile(tempPath, bytes, { flag: "wx" });
      await fs.promises.link(tempPath, target.fsPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Temp cleanup is best-effort.
      }
      if (code === "EEXIST") {
        return { kind: "failed", code: "targetExists" };
      }
      if (code === "ENOENT") {
        return { kind: "failed", code: "parentMissing" };
      }
      return ioFailure(error);
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // The target already holds the complete bytes (link succeeded); the
      // temp directory entry is now a harmless extra name for the same
      // data and its removal is best-effort only.
    }
    return this.verifyWrittenFile(target.fsPath, sha256Hex(bytes), bytes.length);
  }

  async replaceFileExact(
    locator: WorkflowFileLocatorV1,
    bytes: Buffer,
    expectedRevision: WorkflowFileRevisionV1
  ): Promise<WorkflowFileStoreResultV1<WorkflowFileWriteV1>> {
    const target = this.resolve(locator, true);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let stats: fs.BigIntStats;
    try {
      stats = await fs.promises.lstat(target.fsPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      return ioFailure(error);
    }
    if (!stats.isFile()) {
      return { kind: "failed", code: "notAFile" };
    }
    if (revisionOfStats(stats) !== expectedRevision) {
      return { kind: "failed", code: "revisionMismatch" };
    }
    // Same-directory temp so the final rename never crosses a directory (or
    // device) boundary. Exclusive flag: a colliding temp name must fail, not
    // silently reuse another writer's file.
    const tempPath = path.join(
      path.dirname(target.fsPath),
      `.ensemble-replace-${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      await fs.promises.writeFile(tempPath, bytes, { flag: "wx" });
      await fs.promises.rename(tempPath, target.fsPath);
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Temp cleanup is best-effort; the original file is untouched.
      }
      return ioFailure(error);
    }
    return this.verifyWrittenFile(target.fsPath, sha256Hex(bytes), bytes.length);
  }

  async deleteFileExact(
    locator: WorkflowFileLocatorV1,
    expectedRevision: WorkflowFileRevisionV1
  ): Promise<WorkflowFileStoreResultV1<void>> {
    const target = this.resolve(locator, true);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let stats: fs.BigIntStats;
    try {
      stats = await fs.promises.lstat(target.fsPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      return ioFailure(error);
    }
    if (!stats.isFile()) {
      return { kind: "failed", code: "notAFile" };
    }
    if (revisionOfStats(stats) !== expectedRevision) {
      return { kind: "failed", code: "revisionMismatch" };
    }
    try {
      await fs.promises.unlink(target.fsPath);
    } catch (error) {
      return ioFailure(error);
    }
    try {
      await fs.promises.lstat(target.fsPath);
      return { kind: "failed", code: "verificationFailed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: undefined };
      }
      return { kind: "failed", code: "verificationFailed" };
    }
  }

  async createDirectory(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<void>> {
    const target = this.resolve(locator, true);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    try {
      await fs.promises.mkdir(target.fsPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { kind: "failed", code: "targetExists" };
      }
      if (code === "ENOENT") {
        return { kind: "failed", code: "parentMissing" };
      }
      return ioFailure(error);
    }
    try {
      const stats = await fs.promises.lstat(target.fsPath);
      if (!stats.isDirectory()) {
        return { kind: "failed", code: "verificationFailed" };
      }
    } catch {
      return { kind: "failed", code: "verificationFailed" };
    }
    return { kind: "ok", value: undefined };
  }

  async deleteEmptyDirectory(locator: WorkflowFileLocatorV1): Promise<WorkflowFileStoreResultV1<void>> {
    const target = this.resolve(locator, true);
    if (!target.ok) {
      return target.outcome;
    }
    const unsafe = await this.revalidateReparse(target);
    if (unsafe) {
      return unsafe;
    }
    let stats: fs.BigIntStats;
    try {
      stats = await fs.promises.lstat(target.fsPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      return ioFailure(error);
    }
    if (!stats.isDirectory()) {
      return { kind: "failed", code: "notADirectory" };
    }
    try {
      await fs.promises.rmdir(target.fsPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows reports a non-empty rmdir as ENOTEMPTY or (older) EEXIST/EPERM.
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") {
        return { kind: "failed", code: "directoryNotEmpty" };
      }
      if (code === "ENOENT") {
        return { kind: "failed", code: "targetMissing" };
      }
      return ioFailure(error);
    }
    try {
      await fs.promises.lstat(target.fsPath);
      return { kind: "failed", code: "verificationFailed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: undefined };
      }
      return { kind: "failed", code: "verificationFailed" };
    }
  }
}

export function createWorkflowFileStoreV1(roots: readonly WorkflowRootV1[]): WorkflowFileStoreV1 {
  return new WorkflowFileStoreImplV1(roots);
}
