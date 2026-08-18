import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PUBLISH_CHECKS_FILENAME } from "../types/taskProgress";

/**
 * Freshness stamp for `publish-checks.md` (plan PART 2, step 6): proves the
 * completion lint and Publish Scope Check that produced the rest of the
 * document ran back-to-back against one unchanged commit. The stamp does
 * NOT assert the checks passed — a completed run with red results still
 * gets a valid stamp — only that they ran, together, against `verifiedCommitSha`.
 *
 * `scopeId` is a hash of the absolute verification-scope folder rather than
 * the raw path itself, so the stamp never embeds a private absolute
 * filesystem path in a document that may be shared or reviewed.
 */
export interface PublishChecksFreshnessStampV1 {
  formatVersion: 1;
  runId: string;
  verifiedCommitSha: string;
  completedAt: string;
  scopeId: string;
}

export const PUBLISH_CHECKS_STAMP_FORMAT_VERSION = 1 as const;

export const PUBLISH_CHECKS_STAMP_START = "<!-- publish-checks-freshness:start -->";
export const PUBLISH_CHECKS_STAMP_END = "<!-- publish-checks-freshness:end -->";

/** Safe, non-reversible identifier for a verification-scope folder — never the raw path. */
export function computePublishScopeId(scopeFolderAbsolutePath: string): string {
  return crypto.createHash("sha256").update(scopeFolderAbsolutePath).digest("hex").slice(0, 16);
}

/**
 * Render the managed freshness block. Deliberately HTML-comment-only (like
 * the section markers elsewhere in this file) so it reads as metadata, not
 * document content, when a human opens the report.
 *
 * @internal exported for testing
 */
export function renderPublishChecksFreshnessStamp(stamp: PublishChecksFreshnessStampV1): string {
  return [
    PUBLISH_CHECKS_STAMP_START,
    "<!-- Machine-readable freshness stamp — do not edit by hand. -->",
    `<!-- format-version: ${stamp.formatVersion} -->`,
    `<!-- run-id: ${stamp.runId} -->`,
    `<!-- verified-commit: ${stamp.verifiedCommitSha} -->`,
    `<!-- completed-at: ${stamp.completedAt} -->`,
    `<!-- scope-id: ${stamp.scopeId} -->`,
    PUBLISH_CHECKS_STAMP_END,
  ].join("\n");
}

function readStampField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<!--\\s*${name}:\\s*([^>]*?)\\s*-->`));
  return match?.[1]?.trim() || undefined;
}

/**
 * Parse the managed freshness block out of `publish-checks.md` content.
 * Returns undefined when the block is absent, truncated, or missing any
 * required field — callers must treat that identically to "no stamp".
 *
 * @internal exported for testing
 */
export function parsePublishChecksFreshnessStamp(
  content: string
): PublishChecksFreshnessStampV1 | undefined {
  const startIdx = content.indexOf(PUBLISH_CHECKS_STAMP_START);
  const endIdx = content.indexOf(PUBLISH_CHECKS_STAMP_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return undefined;
  }
  const block = content.slice(startIdx, endIdx + PUBLISH_CHECKS_STAMP_END.length);
  const formatVersionRaw = readStampField(block, "format-version");
  const runId = readStampField(block, "run-id");
  const verifiedCommitSha = readStampField(block, "verified-commit");
  const completedAt = readStampField(block, "completed-at");
  const scopeId = readStampField(block, "scope-id");
  if (
    formatVersionRaw !== String(PUBLISH_CHECKS_STAMP_FORMAT_VERSION) ||
    !runId ||
    !verifiedCommitSha ||
    !completedAt ||
    !scopeId
  ) {
    return undefined;
  }
  return {
    formatVersion: PUBLISH_CHECKS_STAMP_FORMAT_VERSION,
    runId,
    verifiedCommitSha,
    completedAt,
    scopeId,
  };
}

/**
 * Merge a rendered freshness block into existing `publish-checks.md`
 * content, replacing a previous stamp in place. Mirrors
 * `mergeCompletionChecksSection`/`mergeScopeCheckSection`'s upsert pattern.
 *
 * @internal exported for testing
 */
export function mergePublishChecksFreshnessStamp(existing: string, section: string): string {
  const startIdx = existing.indexOf(PUBLISH_CHECKS_STAMP_START);
  const endIdx = existing.indexOf(PUBLISH_CHECKS_STAMP_END);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
    ? existing.slice(0, startIdx) + section + existing.slice(endIdx + PUBLISH_CHECKS_STAMP_END.length)
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
}

/**
 * Strictly subtractive: remove a previous freshness stamp from
 * `publish-checks.md` content, if present. Used to invalidate the stamp
 * before a new Publish Checks run starts, so a reader can never observe a
 * stamp whose commit predates in-flight check output.
 *
 * @internal exported for testing
 */
export function invalidatePublishChecksFreshnessStamp(existing: string): string {
  const startIdx = existing.indexOf(PUBLISH_CHECKS_STAMP_START);
  const endIdx = existing.indexOf(PUBLISH_CHECKS_STAMP_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return existing;
  }
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + PUBLISH_CHECKS_STAMP_END.length).trimStart();
  const stripped = after.length > 0 ? `${before}\n${after}` : before;
  return stripped.length > 0 ? `${stripped.trimEnd()}\n` : "";
}

// ---------------------------------------------------------------------------
// Disk I/O helpers. Uses plain node:fs against publish-checks.md, matching
// completionLint.ts/publishScopeCheck.ts (always a plain file inside the task
// folder, never a virtual FS scheme).
// ---------------------------------------------------------------------------

function publishChecksPath(taskFolderUri: vscode.Uri): string {
  return path.join(taskFolderUri.fsPath, PUBLISH_CHECKS_FILENAME);
}

async function readPublishChecksFile(taskFolderUri: vscode.Uri): Promise<string> {
  try {
    return await fs.promises.readFile(publishChecksPath(taskFolderUri), "utf8");
  } catch {
    return "";
  }
}

/**
 * Write `content` to `targetPath` via a same-directory temp file + rename, so
 * a reader never observes a partially-written `publish-checks.md` (a crash or
 * concurrent read mid-write on a plain `writeFile` can otherwise expose a
 * truncated file). `rename` is atomic on both NTFS and POSIX filesystems
 * within the same volume, which the temp file guarantees by living beside
 * its target.
 *
 * @internal exported for testing and reuse by completionLint.ts/publishScopeCheck.ts
 */
export async function writeFileAtomicV1(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${crypto.randomUUID()}`);
  await fs.promises.writeFile(tmpPath, content, "utf8");
  // Windows can transiently deny a rename onto an existing target (EPERM/
  // EBUSY) when another handle — a virus scanner, a file watcher, or (in
  // tests) a second rename racing for the same destination — briefly holds
  // it open. POSIX rename doesn't have this failure mode, but retrying is
  // harmless there. A handful of short retries covers the transient case
  // without masking a real, persistent failure.
  const RENAME_RETRIES = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(tmpPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) {
        await fs.promises.unlink(tmpPath).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/**
 * Per-report async mutex (plan PART 2, step 6): serializes every
 * read-modify-write cycle against a given `publish-checks.md` so two calls
 * that resolve to the same file — from any call site, present or future —
 * can never interleave their read and write, which is what would otherwise
 * let one call's write clobber a section the other just wrote. Task-level
 * commands are already mutually exclusive via `runTrackedOperation`'s
 * per-task lock (see `runPublishChecks.ts`), so in practice this queues
 * rather than contends; it exists as the report-level guarantee the plan
 * asks for, independent of which higher-level lock happens to be held.
 *
 * @internal exported for testing
 */
const publishChecksReportLocks = new Map<string, Promise<unknown>>();

export function withPublishChecksReportLockV1<T>(
  taskFolderUri: vscode.Uri,
  fn: () => Promise<T>
): Promise<T> {
  const key = publishChecksPath(taskFolderUri);
  const previous = publishChecksReportLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  publishChecksReportLocks.set(key, run.catch(() => undefined));
  return run;
}

/**
 * Remove any previous freshness stamp from `publish-checks.md` on disk. A
 * no-op (no write) when no stamp is present, so calling this on every
 * Publish Checks run never touches the file's mtime unnecessarily.
 */
export async function invalidatePublishChecksFreshnessStampOnDiskV1(
  taskFolderUri: vscode.Uri
): Promise<void> {
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    const existing = await readPublishChecksFile(taskFolderUri);
    if (existing.indexOf(PUBLISH_CHECKS_STAMP_START) === -1) {
      return;
    }
    await writeFileAtomicV1(
      publishChecksPath(taskFolderUri),
      invalidatePublishChecksFreshnessStamp(existing)
    );
  });
}

/** Write a valid freshness stamp into `publish-checks.md` on disk. */
export async function writePublishChecksFreshnessStampV1(
  taskFolderUri: vscode.Uri,
  stamp: PublishChecksFreshnessStampV1
): Promise<void> {
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    const existing = await readPublishChecksFile(taskFolderUri);
    const section = renderPublishChecksFreshnessStamp(stamp);
    await writeFileAtomicV1(
      publishChecksPath(taskFolderUri),
      mergePublishChecksFreshnessStamp(existing, section)
    );
  });
}

/** Read and parse the freshness stamp currently on disk, if any. */
export async function readPublishChecksFreshnessStampV1(
  taskFolderUri: vscode.Uri
): Promise<PublishChecksFreshnessStampV1 | undefined> {
  return parsePublishChecksFreshnessStamp(await readPublishChecksFile(taskFolderUri));
}

/**
 * Result of comparing the on-disk freshness stamp against the current
 * verification scope and `HEAD` (plan PART 2, step 7). Every Publish review
 * entry point — direct review, Fast Forward, automatic review, and resumed
 * review — must reach `"valid"` before it is allowed to build a Publish
 * review prompt; every other status is a refusal, never a downgrade to a
 * model-visible warning.
 */
export type PublishChecksFreshnessCheckV1 =
  | { status: "valid"; stamp: PublishChecksFreshnessStampV1 }
  | { status: "missing" }
  | { status: "unreadableHead" }
  | { status: "staleCommit"; stamp: PublishChecksFreshnessStampV1; currentCommitSha: string }
  | { status: "scopeMismatch"; stamp: PublishChecksFreshnessStampV1 };

/**
 * Compare the freshness stamp currently on disk against `currentScopeFolder`
 * and its resolved `HEAD`. Pure comparison — callers resolve the scope
 * folder and read the stamp; this only classifies the result so the
 * classification itself (and its exhaustive status set) can be unit tested
 * without touching disk or spawning git.
 *
 * @internal exported for testing
 */
export function classifyPublishChecksFreshnessV1(
  stamp: PublishChecksFreshnessStampV1 | undefined,
  currentScopeFolder: string,
  currentCommitSha: string | undefined
): PublishChecksFreshnessCheckV1 {
  if (!stamp) {
    return { status: "missing" };
  }
  if (!currentCommitSha) {
    return { status: "unreadableHead" };
  }
  if (stamp.scopeId !== computePublishScopeId(currentScopeFolder)) {
    return { status: "scopeMismatch", stamp };
  }
  if (stamp.verifiedCommitSha !== currentCommitSha) {
    return { status: "staleCommit", stamp, currentCommitSha };
  }
  return { status: "valid", stamp };
}

/**
 * Read the on-disk stamp and classify it against the current scope/`HEAD` in
 * one call — the shape every review entry-point gate actually needs.
 */
export async function checkPublishChecksFreshnessV1(
  taskFolderUri: vscode.Uri,
  currentScopeFolder: string,
  currentCommitSha: string | undefined
): Promise<PublishChecksFreshnessCheckV1> {
  const stamp = await readPublishChecksFreshnessStampV1(taskFolderUri);
  return classifyPublishChecksFreshnessV1(stamp, currentScopeFolder, currentCommitSha);
}

/**
 * Human-readable refusal message for a non-`"valid"` freshness check,
 * consistent across every Publish review entry point (plan PART 2, step 7).
 * Always names the remedy — run Publish Checks — rather than only the
 * problem.
 */
export function describePublishChecksFreshnessFailureV1(
  check: Exclude<PublishChecksFreshnessCheckV1, { status: "valid" }>
): string {
  switch (check.status) {
    case "missing":
      return (
        "Publish Checks have not been run yet for this task. Run Publish Checks before requesting " +
        "a Publish review."
      );
    case "unreadableHead":
      return (
        "The current commit could not be resolved for this task's Publish verification scope, so " +
        "Publish Checks freshness cannot be confirmed. Run Publish Checks again once the workspace " +
        "is a readable git repository."
      );
    case "staleCommit":
      return (
        `Publish Checks were last verified against commit ${check.stamp.verifiedCommitSha.slice(0, 12)}, ` +
        `but the current commit is ${check.currentCommitSha.slice(0, 12)}. Run Publish Checks again ` +
        "before requesting a Publish review."
      );
    case "scopeMismatch":
      return (
        "Publish Checks were last verified against a different verification scope than the one this " +
        "review would use. Run Publish Checks again for the current scope before requesting a Publish review."
      );
  }
}
