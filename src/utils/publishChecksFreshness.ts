import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { parseReadiness } from "./reviewReadiness";

/**
 * Freshness stamp for `publish-review.md` (plan PART 2, step 6; plan item 17,
 * step 20 for the artifact-unification rename from the legacy
 * `publish-checks.md`): proves the completion lint and Publish Scope Check
 * that produced the rest of the document ran back-to-back against one
 * unchanged commit. The stamp does NOT assert the checks passed — a
 * completed run with red results still gets a valid stamp — only that they
 * ran, together, against `verifiedCommitSha`.
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

// ---------------------------------------------------------------------------
// "## Verification (ground truth)" wrapper heading. The Completion Checks
// and Scope Check sections each render their own `###` heading (`### Completion
// Checks`, `### Scope Check`) — one level below this wrapper so they nest as
// its children in the rendered document, rather than reading as two more
// top-level sections indistinguishable from the AI reviewer's own prose,
// which is exactly the "mistaken for the review" failure the artifact
// unification exists to fix. This heading is inserted once, ahead of both,
// framing everything beneath it as deterministic input rather than verdict.
// ---------------------------------------------------------------------------

export const VERIFICATION_HEADING_START = "<!-- verification-heading:start -->";
export const VERIFICATION_HEADING_END = "<!-- verification-heading:end -->";

/** @internal exported for testing */
export function renderVerificationHeading(): string {
  return [
    VERIFICATION_HEADING_START,
    "## Verification (ground truth)",
    "",
    "Deterministic results from actually running this project's checks — input to your review, " +
      "not a verdict on its own.",
    VERIFICATION_HEADING_END,
  ].join("\n");
}

function extractMarkedSection(content: string, start: string, end: string): string | undefined {
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return undefined;
  }
  return content.slice(startIdx, endIdx + end.length);
}

/** @internal exported for testing and reuse by reviewRowV1.ts */
export function extractVerificationHeadingSectionV1(content: string): string | undefined {
  return extractMarkedSection(content, VERIFICATION_HEADING_START, VERIFICATION_HEADING_END);
}

/** @internal exported for testing and reuse by reviewRowV1.ts */
export function mergeVerificationHeadingSection(existing: string, section: string): string {
  const startIdx = existing.indexOf(VERIFICATION_HEADING_START);
  const endIdx = existing.indexOf(VERIFICATION_HEADING_END);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
    ? existing.slice(0, startIdx) + section + existing.slice(endIdx + VERIFICATION_HEADING_END.length)
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
}

/**
 * Ensure `existing` carries the "## Verification (ground truth)" wrapper
 * heading, inserting the default rendering (appended at the end, ahead of
 * whatever managed section is about to be merged in next) when absent.
 * Idempotent — a no-op once the heading is present, whatever its content.
 *
 * @internal exported for testing and reuse by reviewRowV1.ts
 */
export function ensureVerificationHeadingV1(existing: string): string {
  if (existing.indexOf(VERIFICATION_HEADING_START) !== -1) {
    return existing;
  }
  return mergeVerificationHeadingSection(existing, renderVerificationHeading());
}

// ---------------------------------------------------------------------------
// Publish-stage status line (1.0.0 gate C1): the one line at the top of
// publish-review.md telling a user what to do next. Before this, the file was
// seeded once with a static "Not yet reviewed. Run Publish Checks..." stub
// (renderUnreviewedPublishStub, below) and NOTHING ever updated it — every
// later Completion Checks / Scope Check run merged its own managed section in
// underneath, but the original instruction sat above the passing results
// verbatim, unchanged. Observed live (jester, 2026-08-29): a user ran Publish
// Checks, saw thirteen green commands, and read "Not yet reviewed. Run
// Publish Checks" directly above them — reasonably reading it as "that
// failed, try again." Wrapping the line in its own managed markers lets every
// checks run replace it with the truth instead of leaving the first-ever
// message frozen in place.
// ---------------------------------------------------------------------------

export const PUBLISH_STATUS_LINE_START = "<!-- publish-status-line:start -->";
export const PUBLISH_STATUS_LINE_END = "<!-- publish-status-line:end -->";

/** The exact prose {@link renderUnreviewedPublishStub} wrote before this line
 * carried its own markers — recognized so a task whose publish-review.md
 * predates this fix still gets it replaced by the next checks run, instead of
 * being left frozen forever alongside every other task's already-migrated
 * line. @internal exported for testing */
export const LEGACY_UNMARKED_STATUS_LINE_V1 =
  "**Not yet reviewed.** Run Publish Checks, then request a Publish review.";

/** @internal exported for testing */
export function renderPublishStatusLineV1(text: string): string {
  return [PUBLISH_STATUS_LINE_START, text, PUBLISH_STATUS_LINE_END].join("\n");
}

/**
 * The status text a Completion Checks run should show, computed from the
 * SAME pass/fail verdict the Completion Checks section and reviewer both use
 * (`passedModuloKnownFlakes`, falling back to `passed` — a quarantined known
 * flake is not a reason to tell the user their checks failed).
 * @internal exported for testing
 */
export function computePublishStatusLineTextV1(result: {
  readonly passed: boolean;
  readonly passedModuloKnownFlakes?: boolean;
  readonly failedChecks: ReadonlyArray<{ readonly command: string; readonly exitCode: number }>;
  readonly knownFlakeFailures?: ReadonlyArray<{ readonly command: string; readonly exitCode: number }>;
}): string {
  const effectivelyPassed = result.passedModuloKnownFlakes ?? result.passed;
  if (effectivelyPassed) {
    return "**Publish Checks passed.** Request a Publish review to finish.";
  }
  const unquarantinedFailureCount = result.failedChecks.filter(
    (check) =>
      !(result.knownFlakeFailures ?? []).some(
        (flake) => flake.command === check.command && flake.exitCode === check.exitCode
      )
  ).length;
  const noun = unquarantinedFailureCount === 1 ? "check" : "checks";
  return (
    `**Publish Checks failed** (${unquarantinedFailureCount} ${noun} red). ` +
    "Fix the failures, then run Publish Checks again."
  );
}

/** True once a real AI Publish review has been written to `content` — that
 * review's own prose (starting with `Readiness: N/10`) is the authoritative
 * status from that point on, and this module's pre-review status line must
 * never be inserted into, or update, a file in that state. */
function publishReviewHasLandedV1(content: string): boolean {
  return parseReadiness(content).score !== null;
}

/**
 * Upsert the managed status-line section, replacing whichever prior form is
 * present (its own markers, or the pre-fix unmarked legacy line) in place, or
 * inserting it right after the `# Publish Review` title when neither is
 * found yet. A no-op once a real AI review has landed (see
 * {@link publishReviewHasLandedV1}) — the review's own verdict speaks for
 * itself and this line must never be grafted into it.
 * @internal exported for testing
 */
export function mergePublishStatusLineSection(existing: string, text: string): string {
  if (publishReviewHasLandedV1(existing)) {
    return existing;
  }
  const section = renderPublishStatusLineV1(text);
  const startIdx = existing.indexOf(PUBLISH_STATUS_LINE_START);
  const endIdx = existing.indexOf(PUBLISH_STATUS_LINE_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return (
      existing.slice(0, startIdx) + section + existing.slice(endIdx + PUBLISH_STATUS_LINE_END.length)
    );
  }
  const legacyIdx = existing.indexOf(LEGACY_UNMARKED_STATUS_LINE_V1);
  if (legacyIdx !== -1) {
    return (
      existing.slice(0, legacyIdx) +
      section +
      existing.slice(legacyIdx + LEGACY_UNMARKED_STATUS_LINE_V1.length)
    );
  }
  const lines = existing.split("\n");
  const titleIdx = lines.findIndex((line) => line.trim() === "# Publish Review");
  if (titleIdx === -1) {
    return existing.trim().length > 0 ? `${section}\n\n${existing.trim()}\n` : `${section}\n`;
  }
  let insertAt = titleIdx + 1;
  while (insertAt < lines.length && lines[insertAt]!.trim() === "") {
    insertAt++;
  }
  lines.splice(insertAt, 0, section, "");
  return lines.join("\n");
}

function readStampField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<!--\\s*${name}:\\s*([^>]*?)\\s*-->`));
  return match?.[1]?.trim() || undefined;
}

/**
 * Parse the managed freshness block out of `publish-review.md` content.
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
 * Merge a rendered freshness block into existing `publish-review.md`
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
 * Extract the managed freshness stamp block (markers included) from existing
 * `publish-review.md` content, if present. Mirrors
 * `extractCompletionChecksSectionV1`/`extractScopeCheckSectionV1` — used by
 * `reviewRowV1.ts` to re-inject the stamp after an AI review write.
 *
 * @internal exported for testing and reuse by reviewRowV1.ts
 */
export function extractPublishChecksFreshnessStampSectionV1(content: string): string | undefined {
  const startIdx = content.indexOf(PUBLISH_CHECKS_STAMP_START);
  const endIdx = content.indexOf(PUBLISH_CHECKS_STAMP_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return undefined;
  }
  return content.slice(startIdx, endIdx + PUBLISH_CHECKS_STAMP_END.length);
}

/**
 * Strictly subtractive: remove a previous freshness stamp from
 * `publish-review.md` content, if present. Used to invalidate the stamp
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
// Disk I/O helpers. Uses plain node:fs against publish-review.md (the single
// Publish-stage artifact — see the module doc comment on the split reversal
// below), matching completionLint.ts/publishScopeCheck.ts (always a plain
// file inside the task folder, never a virtual FS scheme).
// ---------------------------------------------------------------------------

/**
 * publish-review.md — the SINGLE Publish-stage artifact. Until this round,
 * the deterministic checks (Completion Checks, Scope Check, this freshness
 * stamp) lived in a separate `publish-checks.md`, split off from the AI
 * reviewer's verdict so the two writers could not clobber each other. That
 * split is what caused a user to receive a 49 KB `publish-checks.md` with a
 * `Status:`/pass-fail verdict shape, mistake it for their Publish review, and
 * conclude — reasonably — that the real one had been deleted when
 * `publish-review.md` reported "not created yet." The two artifacts are
 * unified back into one: checks are spliced into managed, marker-delimited
 * sections of `publish-review.md` (mergeCompletionChecksSection etc.,
 * unchanged), and re-injected after every AI review write
 * (`reviewRowV1.ts`'s `promoteReviewContentV1`) so the reviewer's prose can
 * never overwrite the ground-truth section beneath it. See
 * `importLegacyPublishChecksIfAbsentV1` below for the one-time migration path
 * for tasks that still only have the legacy `publish-checks.md` on disk.
 */
function publishChecksPath(taskFolderUri: vscode.Uri): string {
  const filename = STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME;
  return path.join(taskFolderUri.fsPath, filename);
}

function legacyPublishChecksPath(taskFolderUri: vscode.Uri): string {
  return path.join(taskFolderUri.fsPath, PUBLISH_CHECKS_FILENAME);
}

async function readPublishChecksFile(taskFolderUri: vscode.Uri): Promise<string> {
  try {
    return await fs.promises.readFile(publishChecksPath(taskFolderUri), "utf8");
  } catch {
    return "";
  }
}

/** The bounded set of managed sections a legacy `publish-checks.md` can carry
 * — the only content `importLegacyPublishChecksIfAbsentV1` is permitted to
 * bring across. Anything else in the legacy file (its own headings, stray
 * prose, an obsolete instruction block) is deliberately left behind. */
const LEGACY_MANAGED_SECTION_MARKERS: ReadonlyArray<{ start: string; end: string }> = [
  { start: "<!-- completion-checks:start -->", end: "<!-- completion-checks:end -->" },
  { start: "<!-- scope-check:start -->", end: "<!-- scope-check:end -->" },
  { start: PUBLISH_CHECKS_STAMP_START, end: PUBLISH_CHECKS_STAMP_END },
];

/**
 * Durable "already imported from legacy" sentinel — deliberately NOT the
 * freshness stamp. `upsertCompletionChecksReportV1` invalidates (removes)
 * the freshness stamp on every run that doesn't also run the Scope Check
 * (see its own doc comment), so using the stamp's presence as the import
 * sentinel made the import fire again on the very next upsert call once the
 * stamp it had just imported was stripped — duplicating the provenance note,
 * the verification heading, and every managed section it had just written.
 *
 * Embedded inside the "## Verification (ground truth)" heading block itself
 * (`renderVerificationHeadingWithLegacyImportMarkerV1` below), not appended
 * as bare text alongside it: `reviewRowV1.ts`'s `reinjectPublishGroundTruthSectionsV1`
 * re-splices a review write by extracting and re-merging only the known
 * marker-delimited sections (heading, completion checks, scope check,
 * freshness stamp) — anything written outside those markers is dropped from
 * the file a review write produces. A marker living outside all of them
 * would silently vanish on the very next review write, making the "done"
 * sentinel disappear and the import fire again on every subsequent review.
 * Riding inside the heading section, which every re-splice path already
 * preserves, makes the marker survive for the lifetime of the file.
 */
const LEGACY_IMPORT_DONE_MARKER = "<!-- publish-checks-legacy-import:v1 -->";

/**
 * Same rendering as `renderVerificationHeading`, with the durable
 * legacy-import-done marker AND the human-readable provenance note both
 * folded into the same marker-delimited block, so both survive every future
 * re-splice (see `LEGACY_IMPORT_DONE_MARKER`'s doc comment). This matters
 * because `reviewRowV1.ts`'s `reinjectPublishGroundTruthSectionsV1` re-injects
 * a review write by extracting and re-merging only the known marker-delimited
 * sections (this heading, completion checks, scope check, freshness stamp) —
 * plain text living between those markers, as the provenance note used to,
 * is dropped on the very next AI review write. Used only by the import
 * path — the heading `ensureVerificationHeadingV1` inserts for a task with no
 * legacy content to import stays provenance-free.
 */
function renderVerificationHeadingWithLegacyImportMarkerV1(): string {
  return [
    VERIFICATION_HEADING_START,
    "## Verification (ground truth)",
    "",
    LEGACY_IMPORT_DONE_MARKER,
    "Deterministic results from actually running this project's checks — input to your review, " +
      "not a verdict on its own.",
    "",
    "_Imported once from the legacy `publish-checks.md`, which predated the Publish artifact " +
      "unification, on first access after the upgrade. Only its managed checks sections were " +
      "imported (not its heading or prose) — `publish-checks.md` itself was left untouched on disk._",
    VERIFICATION_HEADING_END,
  ].join("\n");
}

/**
 * Legacy `publish-checks.md` rendered its own two section headings one level
 * shallower (`## Completion Checks`, `## Scope Check`) than the current
 * build does, because it was a standalone top-level document rather than
 * content nested under this file's `## Verification (ground truth)` wrapper.
 * Imported verbatim, those headings would read as siblings of the wrapper
 * instead of children of it — the same "mistaken for the review" shape the
 * artifact unification exists to fix (see the module doc comment above).
 * Bounded to exactly the two known legacy heading strings; nothing else in
 * an imported section is rewritten. A section whose heading is already at
 * the current (already-demoted) level is left untouched.
 *
 * @internal exported for testing
 */
export function normalizeLegacyHeadingLevelV1(section: string): string {
  return section
    .replace(/^## Completion Checks$/m, "### Completion Checks")
    .replace(/^## Scope Check$/m, "### Scope Check");
}

/**
 * One-time bounded import (plan item 17, steps 20(b)/20(c)): when
 * `publish-review.md` does not yet carry the durable `LEGACY_IMPORT_DONE_MARKER`
 * sentinel but a legacy `publish-checks.md` does have known sections, extract
 * ONLY the legacy file's known delimited sections (Completion Checks, Scope
 * Check, freshness stamp — whichever it has; never its heading, prose, or
 * any other content) and splice them into `existing`, under the
 * "## Verification (ground truth)" wrapper heading and preceded by a
 * provenance note. A no-op (returns `existing` unchanged) once the marker is
 * already present, or when the legacy file has none of the three known
 * sections — this is the "no proactive migration sweep" rule: import happens
 * lazily, at most once, the first time something upserts into or reads the
 * new artifact for a task that predates the unification (a checks run via
 * `completionLint.ts`/`publishScopeCheck.ts`, artifact creation via
 * `ensurePublishReviewArtifactExistsV1`, or a review write via
 * `reviewRowV1.ts`'s `reinjectPublishGroundTruthSectionsV1`), never as a
 * background sweep over every task folder. The legacy file itself is never
 * modified or deleted.
 *
 * @internal exported for testing
 */
export async function importLegacyPublishChecksIfAbsentV1(
  taskFolderUri: vscode.Uri,
  existing: string
): Promise<string> {
  if (existing.indexOf(LEGACY_IMPORT_DONE_MARKER) !== -1) {
    return existing;
  }
  let legacy: string;
  try {
    legacy = await fs.promises.readFile(legacyPublishChecksPath(taskFolderUri), "utf8");
  } catch {
    return existing;
  }
  const importedSections = LEGACY_MANAGED_SECTION_MARKERS.map(({ start, end }) =>
    extractMarkedSection(legacy, start, end)
  )
    .filter((section): section is string => section !== undefined)
    .map(normalizeLegacyHeadingLevelV1);
  if (importedSections.length === 0) {
    return existing;
  }
  // The marker-carrying heading is merged via mergeVerificationHeadingSection
  // (replace-in-place if a heading is already there, append if not) rather
  // than blindly appended — guards against ever producing two
  // `verification-heading` marker pairs in the same file, which would make
  // extraction (first-start/first-end) silently drop the second one. The
  // provenance note now lives INSIDE that heading block (see
  // renderVerificationHeadingWithLegacyImportMarkerV1's doc comment) rather
  // than as plain text alongside the imported sections, so it survives a
  // subsequent AI review write's re-splice.
  const withHeading = mergeVerificationHeadingSection(existing, renderVerificationHeadingWithLegacyImportMarkerV1());
  const body = importedSections.join("\n\n");
  return withHeading.trim().length > 0
    ? `${withHeading.trimEnd()}\n\n${body}\n`
    : `${body}\n`;
}

/**
 * Entry-gate variant of the lazy import (plan item 17, step 20(c) — "next
 * touch of either surface"): when `publish-review.md` already exists but has
 * not yet had legacy sections imported into it (e.g. an older build's stub,
 * or a task where only `publish-checks.md` ever carried a valid stamp), pull
 * them in and persist the result to disk BEFORE any freshness check reads
 * the file. Without this, `requirePublishChecksFreshnessOrWarnV1` (plan PART
 * 2, step 7) reads `publish-review.md`'s (absent) stamp, classifies it
 * `"missing"`, and refuses the review before `reviewRowV1.ts`'s
 * promotion-time import — reachable only on an actual review write — ever
 * runs. A no-op once the durable import marker is present, or when there is
 * no legacy `publish-checks.md` to import from.
 */
export async function ensurePublishReviewLegacySectionsImportedV1(
  taskFolderUri: vscode.Uri
): Promise<void> {
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    const existing = await readPublishChecksFile(taskFolderUri);
    const imported = await importLegacyPublishChecksIfAbsentV1(taskFolderUri, existing);
    if (imported === existing) {
      return;
    }
    await writeFileAtomicV1(publishChecksPath(taskFolderUri), imported);
  });
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
 * read-modify-write cycle against a given `publish-review.md` so two calls
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
 * Remove any previous freshness stamp from `publish-review.md` on disk. A
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

/** Write a valid freshness stamp into `publish-review.md` on disk. */
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

/** Placeholder body for a Publish stage that has no review yet and no legacy
 * checks to import — makes "not created yet" unreachable (plan item 17, step
 * 20(a)) without asserting anything about readiness. Its status line carries
 * this module's own markers from the moment the file is created, so the very
 * first Completion Checks run can find and replace it (see
 * `mergePublishStatusLineSection`) instead of leaving it frozen. */
function renderUnreviewedPublishStub(): string {
  return [
    "# Publish Review",
    "",
    renderPublishStatusLineV1(
      "**Not yet reviewed.** Run Publish Checks, then request a Publish review."
    ),
    "",
  ].join("\n");
}

/**
 * Ensure `publish-review.md` exists for a task that has reached the Publish
 * stage (plan item 17, step 20(a)/20(b)) — call this on Publish stage entry
 * and from any path that would otherwise report the artifact as missing.
 * Idempotent and safe to call repeatedly: a no-op once the file exists,
 * whatever its content.
 *
 * When the file must be created and a legacy `publish-checks.md` already
 * carries this module's freshness stamp, the new file is seeded from it
 * (import + provenance note, `importLegacyPublishChecksIfAbsentV1`) rather
 * than created empty — a task that upgraded mid-Publish keeps its most
 * recent check results visible instead of appearing to have lost them.
 * Otherwise the file is created with a plain "not yet reviewed" stub.
 *
 * Uses `createFileExclusive`-shaped semantics via a plain exclusive-flag
 * write so a concurrent caller racing this same check-then-create can never
 * clobber content the other one just wrote — the loser's write fails and is
 * silently ignored, since either outcome (stub or legacy-seeded) is a valid
 * starting point for the same task.
 */
export async function ensurePublishReviewArtifactExistsV1(
  taskFolderUri: vscode.Uri
): Promise<void> {
  const targetPath = publishChecksPath(taskFolderUri);
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    try {
      await fs.promises.access(targetPath);
      return;
    } catch {
      // Absent — fall through to create it.
    }
    const seeded = await importLegacyPublishChecksIfAbsentV1(taskFolderUri, "");
    const content = seeded.trim().length > 0 ? seeded : renderUnreviewedPublishStub();
    try {
      await fs.promises.writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Another caller created it first — its content stands.
    }
  });
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
