/**
 * Pure, VS-Code-free helpers for selecting and capping file contents for
 * implementation reviews. Isolated so they can be unit-tested without a
 * VS Code host environment.
 */

/** Per-file and total content caps applied when embedding files in an
 * implementation-review context pack.
 *
 * IMPL_REVIEW_MAX_TOTAL_CHARS is the only size guard on the automated
 * implementation-review prompt (reviewActions.ts does not additionally run
 * it through checkAndConfirmPromptSize), so it can't grow unbounded — but at
 * 60000 a task touching two dozen files reliably drops most of them (each
 * omitted file is still listed by name, never silently dropped, but a
 * reviewer working from the pack alone still misses their content). Raised
 * to 150000 chars (~35-40k tokens), comfortably inside modern model context
 * windows, to make that the uncommon case rather than the common one.
 *
 * Lowered to 100000 (2026-08-06, live dogfooding failure): the model context
 * window is NOT the binding constraint — the chat-transaction store is.
 * Every coordinator-driven action's validated input (which embeds the fully
 * rendered prompt) must persist inside
 * MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 = 262,144 bytes
 * (types/chatInteractionTransactionV1.ts) or the whole run dies BEFORE any
 * provider is reached, as an opaque-looking
 * `chatTransaction.chatTransactionRejected` failure. Measured composition of
 * a real impl-high re-review prompt that hit this: review template + scoring
 * rubric ≈ 11K, plan ≈ 29K, plan-final ≈ 20K, previous review ≈ 10K, the
 * pack's non-content sections (task description etc.) ≈ 45K, JSON-string
 * escaping overhead ≈ 4.5% — leaving roughly 120-135K for embedded file
 * contents before the cap. At 150000 this section alone could bust it;
 * 100000 (~25k tokens) keeps the worst observed composition ≈ 20K+ under
 * the limit while still embedding a dozen files' capped contents. */
export const IMPL_REVIEW_MAX_CHARS_PER_FILE = 8000;
export const IMPL_REVIEW_MAX_TOTAL_CHARS = 100000;

/**
 * Workflow findings round 8, item 1 (fixes 1 and 5): the flat 8 KB
 * `IMPL_REVIEW_MAX_CHARS_PER_FILE` head-sample treats a 400-line file and a
 * 3,500-line file identically. At 163 KB (a real field capture:
 * `cliAgentRunner.ts`), that 8 KB excerpt is 5% of the file — not a summary,
 * a sample the reviewer was explicitly told not to trust, and the only
 * correct action (open the file natively) then hit its own per-read ceiling
 * on the same round.
 *
 * Measured 2026-08-21 rather than assumed: a single-file review scope of
 * 183 KB was read and comprehended cleanly by both `kimi-code/k3@max` and
 * `gpt-5.6-sol@high` — verified by checking the round's output against the
 * source, not by trusting its score. So the per-read ceiling is NOT the
 * binding constraint and no read-budget allowance change is justified; the
 * excerpt quality fixed here is. The 2026-08-20 failure that prompted this
 * had a ten-file, ~670 KB scope, so aggregate scope remains the untested
 * candidate. (A first probe asking for an export list proved nothing — the
 * reviewer answered it by grepping. A pattern-matchable question does not
 * measure reading.)
 *
 * A file at or under this many characters is inlined whole. Any file over it
 * never gets a head-slice (raised from the old flat 8000 only made the
 * head-slice bigger, not honest — see the round-8 implementation review that
 * flagged the raised-cap head-slice itself as the defect): it instead goes
 * through `applyContentCapsWithRegionsV1`, which tries a git-diff-derived
 * changed-region excerpt first (see `computeChangedLineRangesForFileV1` in
 * contextPack.ts) and falls back to `buildOversizedFilePagingStanzaV1`'s
 * deterministic paging-window stanza only when no diff baseline exists at
 * all (not a git repo, brand-new untracked file, git unavailable).
 */
export const IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS = 16000;

/** Deterministic paging-window granularity for an oversized file's stanza. */
export const IMPL_REVIEW_PAGING_WINDOW_LINES = 400;

/** Lines of surrounding context added on each side of a git-diff-derived
 * changed line range before it is excerpted, so the reviewer sees the
 * function/block a change sits in rather than a bare, disconnected hunk. */
export const IMPL_REVIEW_CHANGED_REGION_CONTEXT_LINES = 20;

/** Floor on the per-file budget a changed-region excerpt is allocated, even
 * when many oversized files share one review round — an excerpt below this
 * is not worth showing over the ranges-bearing stanza naming the same
 * regions for native reading. */
export const IMPL_REVIEW_MIN_CHANGED_REGION_EXCERPT_CHARS = 3000;

/** Cap on how many individual windows a stanza lists by name before
 * collapsing the rest into a single "+N more" note — keeps a pathological
 * multi-megabyte file's stanza itself bounded. */
export const IMPL_REVIEW_MAX_PAGING_WINDOWS_LISTED = 25;

/**
 * Machine-maintained artifacts whose CONTENTS are never embedded in a review
 * context pack (they stay listed by name, explicitly labeled as omitted).
 *
 * Two reasons, both from a live dogfooding failure (2026-08-06): (1) budget —
 * implReviewFiles is written verbatim from an implementation run's changed
 * files, and a run that regenerates this repo's workflow-safety inventories
 * adds up to ~10 large generated JSON files, each burning
 * IMPL_REVIEW_MAX_CHARS_PER_FILE of the total budget on an unreadable 8K
 * head-slice of a 50-400KB machine-written file, crowding out (or, before
 * the total cap above was anchored to the transaction limit, overflowing)
 * the actual source changes; (2) authority — these files are verified by
 * their own generators/verifiers (`pnpm run package`'s workflow-safety
 * chain, lockfile integrity checks), not by AI review, so a reviewer filing
 * blockers against a truncated fragment of one is noise by construction.
 *
 * `workflow-inventories/` is this extension's own dogfooding convention
 * (generated baseline/live/route/consumer JSON); the lockfile and
 * minified/sourcemap patterns are universal.
 */
const MACHINE_MAINTAINED_ARTIFACT_PATTERNS_V1: readonly RegExp[] = [
  /^workflow-inventories\//,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum)$/,
  /\.(min\.js|min\.css|js\.map|css\.map)$/,
];

/** Whether a workspace-relative path is a machine-maintained artifact whose
 * contents should be omitted (not a reviewable source file). Accepts either
 * slash style. */
export function isMachineMaintainedArtifactPathV1(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return MACHINE_MAINTAINED_ARTIFACT_PATTERNS_V1.some((pattern) => pattern.test(normalized));
}

/**
 * Deterministically map a changed source file to its associated test file,
 * per this repo's convention: every test lives flat in `src/test/`, named
 * after the source file's basename regardless of which subdirectory under
 * `src/` the source file lives in (e.g. `src/commands/chatWithStage.ts` and
 * `src/utils/chatWithStage.ts` would both map to `src/test/chatWithStage.test.ts`).
 * Returns `undefined` for paths outside `src/`, paths already inside
 * `src/test/`, and non-TypeScript files — callers should only pull in the
 * mapped path if it exists on disk and isn't already tracked.
 */
export function mapSourceToTestPath(relPath: string): string | undefined {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized.startsWith("src/") || normalized.startsWith("src/test/")) {
    return undefined;
  }
  const match = /\/([^/]+)\.tsx?$/.exec(`/${normalized}`);
  if (!match) return undefined;
  return `src/test/${match[1]}.test.ts`;
}

export interface ImplReviewFileResult {
  relPath: string;
  /**
   * Capped file content.
   * - `string`    — content present (possibly truncated).
   * - `undefined` — file is missing on disk and was not open in an editor.
   * - `null`      — file was omitted because the total char budget was
   *                 already exhausted before this file was reached.
   */
  content: string | undefined | null;
  /** true when the content was trimmed to respect the per-file or total cap. */
  truncated: boolean;
}

/**
 * Apply per-file and total size caps to a list of pre-read file inputs.
 *
 * Files whose content is `undefined` (missing on disk) are always included
 * in the output with `content: undefined` and do not consume any of the
 * total budget. A file that doesn't fully fit inside the *remaining* total
 * budget (after the per-file cap is applied) is omitted whole — `content:
 * null` — rather than showing a partial, silently-cut slice. This keeps
 * "not present" (omitted, listed by name) and "not shown" (per-file cap
 * truncation, clearly labeled) distinguishable to a reader working from the
 * pack alone; a mid-file cut that just stops before the part a reviewer
 * needed (e.g. a function defined later in the file) would otherwise look
 * like a complete-but-short file instead of a known gap.
 */
export function applyContentCaps(
  files: ReadonlyArray<{ relPath: string; content: string | undefined }>,
  maxCharsPerFile = IMPL_REVIEW_MAX_CHARS_PER_FILE,
  maxTotalChars = IMPL_REVIEW_MAX_TOTAL_CHARS
): ImplReviewFileResult[] {
  const results: ImplReviewFileResult[] = [];
  let totalChars = 0;
  let capReached = false;

  for (const { relPath, content } of files) {
    if (content === undefined) {
      // Missing on disk — always report, never consumes the total budget.
      results.push({ relPath, content: undefined, truncated: false });
      continue;
    }

    if (capReached) {
      // Total budget already exhausted — mark as omitted.
      results.push({ relPath, content: null, truncated: false });
      continue;
    }

    let text = content;
    let truncated = false;

    if (text.length > maxCharsPerFile) {
      text = text.slice(0, maxCharsPerFile);
      truncated = true;
    }

    const remaining = maxTotalChars - totalChars;
    if (text.length > remaining) {
      // Doesn't fully fit in what's left of the total budget — drop the
      // whole file (explicit omission) instead of cutting its tail.
      results.push({ relPath, content: null, truncated: false });
      capReached = true;
      continue;
    }

    totalChars += text.length;
    if (totalChars >= maxTotalChars) {
      capReached = true;
    }

    results.push({ relPath, content: text, truncated });
  }

  return results;
}

/**
 * Result shape for `applyContentCapsWithPagingV1`. Extends
 * {@link ImplReviewFileResult} with a flag distinguishing a real (possibly
 * truncated) file excerpt from a paging-window stanza standing in for one —
 * a caller must never render `isOversizedStanza: true` content inside a
 * "here is the file" code block, since it never contains a single byte of
 * the file itself.
 */
export interface ImplReviewFileResultV2 extends ImplReviewFileResult {
  /** true when `content` is a paging-window stanza (see
   * `buildOversizedFilePagingStanzaV1`), not the file's real text. */
  isOversizedStanza: boolean;
}

/**
 * Deterministic "read this file yourself, in these windows" stanza for a
 * file too large to usefully excerpt (workflow findings round 8, item 1, fix
 * 5). Used only when no diff baseline exists to compute changed regions from
 * (see `ImplReviewContentKind`'s "no-baseline-stanza" case), so this always
 * names line-range windows rather than mislabeling them "changed regions" —
 * the distinction the finding calls out explicitly.
 */
export function buildOversizedFilePagingStanzaV1(relPath: string, content: string): string {
  const byteSize = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  const windowCount = Math.max(1, Math.ceil(totalLines / IMPL_REVIEW_PAGING_WINDOW_LINES));
  const listedCount = Math.min(windowCount, IMPL_REVIEW_MAX_PAGING_WINDOWS_LISTED);
  const windows: string[] = [];
  for (let i = 0; i < listedCount; i++) {
    const start = i * IMPL_REVIEW_PAGING_WINDOW_LINES + 1;
    const end = Math.min(totalLines, (i + 1) * IMPL_REVIEW_PAGING_WINDOW_LINES);
    windows.push(`lines ${start}-${end}`);
  }
  const remainingWindows = windowCount - listedCount;
  const remainingNote =
    remainingWindows > 0
      ? ` (+${remainingWindows} more window(s) of ~${IMPL_REVIEW_PAGING_WINDOW_LINES} lines each, continuing past line ${
          listedCount * IMPL_REVIEW_PAGING_WINDOW_LINES
        })`
      : "";
  return (
    `${relPath} is ${byteSize.toLocaleString("en-US")} bytes (${totalLines} lines) — too large to usefully ` +
    "excerpt here, and no commit-diff baseline is available for this round to target specific line ranges " +
    `from. The windows below are deterministic paging windows, not a diff-derived excerpt — read the file ` +
    `natively in these windows instead: ${windows.join(", ")}${remainingNote}. Paging through a large file ` +
    "across several reads is expected and budgeted for on this stage."
  );
}

/** A 1-indexed, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Parse a unified diff's hunk headers (`@@ -a,b +c,d @@`) into the new-side
 * (post-change) line ranges they cover. Pure — takes diff text, not a git
 * invocation, so it is testable without a repository. A pure deletion hunk
 * (`d` is `0`, nothing added on the new side) still yields a single-line
 * marker at the insertion point so the surrounding context expansion in
 * `mergeAndExpandLineRangesV1` has something to anchor to — a deletion is
 * still a change a reviewer needs to see the context of.
 */
export function parseUnifiedDiffHunkRangesV1(diffText: string): LineRange[] {
  const ranges: LineRange[] = [];
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkHeaderRe.exec(diffText)) !== null) {
    const start = Number.parseInt(match[1]!, 10);
    const lineCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
    if (lineCount === 0) {
      const anchor = Math.max(1, start);
      ranges.push({ start: anchor, end: anchor });
      continue;
    }
    ranges.push({ start, end: start + lineCount - 1 });
  }
  return ranges;
}

/**
 * Expand each range by `contextLines` on both sides (clamped to
 * `[1, totalLines]`), then merge any that now overlap or touch. Sorted by
 * start line. Pure.
 */
export function mergeAndExpandLineRangesV1(
  ranges: ReadonlyArray<LineRange>,
  contextLines: number,
  totalLines: number
): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const expanded = ranges
    .map((r) => ({
      start: Math.max(1, r.start - contextLines),
      end: Math.min(Math.max(totalLines, 1), r.end + contextLines),
    }))
    .sort((a, b) => a.start - b.start);

  const merged: LineRange[] = [];
  for (const r of expanded) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Extract the given (already expanded/merged) line ranges from `content` as
 * a bounded excerpt, each region preceded by a `--- lines N-M ---` header so
 * the reviewer knows exactly which part of the file they're looking at.
 * Regions are added in order until `maxChars` would be exceeded; if a region
 * doesn't fit, extraction stops there and `truncated` is `true` — callers
 * must treat a truncated result as "doesn't fit the budget" and fall back to
 * a stanza rather than showing a partial excerpt that silently drops later
 * changed regions.
 */
export function extractLineRangesExcerptV1(
  content: string,
  ranges: ReadonlyArray<LineRange>,
  maxChars: number
): { excerpt: string; usedRanges: LineRange[]; truncated: boolean } {
  const lines = content.split("\n");
  const parts: string[] = [];
  const usedRanges: LineRange[] = [];
  let total = 0;
  let truncated = false;

  for (const range of ranges) {
    const header = `--- lines ${range.start}-${range.end} ---`;
    const body = lines.slice(range.start - 1, range.end).join("\n");
    const block = `${header}\n${body}\n`;
    if (total + block.length > maxChars) {
      truncated = true;
      break;
    }
    parts.push(block);
    usedRanges.push(range);
    total += block.length;
  }

  return { excerpt: parts.join("\n"), usedRanges, truncated };
}

/**
 * Ranges-bearing stanza for a file whose changed regions (from a real git
 * diff baseline) were computed but still don't fit the per-file excerpt
 * budget — plan Part 2's "emit an oversized-file stanza (path, byte size,
 * changed-region line ranges) when a file's changed regions still exceed its
 * budget". Unlike `buildOversizedFilePagingStanzaV1`, the ranges named here
 * ARE the real diff-derived changed regions, so this is the only stanza
 * allowed to use the words "changed regions".
 */
export function buildChangedRegionsStanzaV1(
  relPath: string,
  content: string,
  ranges: ReadonlyArray<LineRange>
): string {
  const byteSize = Buffer.byteLength(content, "utf8");
  const rangeList = ranges.map((r) => `lines ${r.start}-${r.end}`).join(", ");
  return (
    `${relPath} is ${byteSize.toLocaleString("en-US")} bytes; its changed regions (computed from a git diff ` +
    `baseline) are too large to embed within this review's per-file budget. Read the file natively, focusing ` +
    `on these changed regions: ${rangeList}. Paging through a large file across several reads is expected and ` +
    "budgeted for on this stage."
  );
}

/** Every way `applyContentCapsWithRegionsV1` can represent a file's content:
 *  - `whole`                    — the file's real, complete text.
 *  - `changed-regions-excerpt`  — a real excerpt: the file's actual text at
 *    the diff-derived changed line ranges (plus context), fits the budget.
 *  - `changed-regions-stanza`   — changed regions were computed but don't fit
 *    the budget even as an excerpt; a stanza names the real ranges instead.
 *  - `no-baseline-stanza`       — no diff baseline was available at all; a
 *    stanza names deterministic paging windows instead.
 */
export type ImplReviewContentKind =
  | "whole"
  | "changed-regions-excerpt"
  | "changed-regions-stanza"
  | "no-baseline-stanza";

/**
 * Result shape for `applyContentCapsWithRegionsV1`. Extends
 * {@link ImplReviewFileResult} with `contentKind` and the legacy
 * `isOversizedStanza` flag (true for either stanza kind — both carry zero
 * bytes of the file's real text, so a caller must never render one inside a
 * "here is the file" code block the way it would `whole` or
 * `changed-regions-excerpt` content).
 */
export interface ImplReviewFileResultV2 extends ImplReviewFileResult {
  isOversizedStanza: boolean;
}

export interface ImplReviewFileResultV3 extends ImplReviewFileResultV2 {
  contentKind: ImplReviewContentKind;
}

/** Input to `applyContentCapsWithRegionsV1`: a file's content plus, when a
 * git diff baseline was available for it (see `computeChangedLineRangesForFileV1`
 * in contextPack.ts), the raw (unexpanded) 1-indexed changed line ranges. */
export interface ImplReviewFileInputV3 {
  relPath: string;
  content: string | undefined;
  changedRanges?: LineRange[];
}

/**
 * `applyContentCaps`, extended with git-diff-derived changed-region excerpts
 * and paging stanzas (workflow findings round 8, item 1, fixes 1/2/5). A
 * file at or under `inlineWholeMaxChars` is inlined whole. A file over it:
 *  - with changed ranges available, gets those ranges (expanded with
 *    surrounding context, merged) excerpted, sized against a per-file budget
 *    shared dynamically across every over-budget file in this call so the
 *    total still respects `maxTotalChars`; if the excerpt still doesn't fit,
 *    a stanza names the real changed-region ranges instead;
 *  - with no changed ranges available (no git baseline), falls back to
 *    `buildOversizedFilePagingStanzaV1`'s deterministic paging-window stanza.
 * No file over the threshold is ever shown as a head-slice — every over-
 * threshold file is either a real changed-region excerpt or an honest stanza
 * directing a native read, never a silent truncation mislabeled as content.
 */
export function applyContentCapsWithRegionsV1(
  files: ReadonlyArray<ImplReviewFileInputV3>,
  options?: {
    inlineWholeMaxChars?: number;
    maxTotalChars?: number;
    contextLines?: number;
  }
): ImplReviewFileResultV3[] {
  const inlineWholeMaxChars = options?.inlineWholeMaxChars ?? IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS;
  const maxTotalChars = options?.maxTotalChars ?? IMPL_REVIEW_MAX_TOTAL_CHARS;
  const contextLines = options?.contextLines ?? IMPL_REVIEW_CHANGED_REGION_CONTEXT_LINES;

  const overBudgetCount = files.filter(
    (f) => f.content !== undefined && f.content.length > inlineWholeMaxChars
  ).length;
  const perFileExcerptBudget = Math.max(
    IMPL_REVIEW_MIN_CHANGED_REGION_EXCERPT_CHARS,
    Math.floor(maxTotalChars / Math.max(1, overBudgetCount))
  );

  const kinds: ImplReviewContentKind[] = [];
  const substituted = files.map((f) => {
    if (f.content === undefined || f.content.length <= inlineWholeMaxChars) {
      kinds.push("whole");
      return { relPath: f.relPath, content: f.content };
    }

    if (f.changedRanges && f.changedRanges.length > 0) {
      const totalLines = f.content.split("\n").length;
      const expanded = mergeAndExpandLineRangesV1(f.changedRanges, contextLines, totalLines);
      const { excerpt, truncated } = extractLineRangesExcerptV1(f.content, expanded, perFileExcerptBudget);
      if (!truncated && excerpt.length > 0) {
        kinds.push("changed-regions-excerpt");
        return { relPath: f.relPath, content: excerpt };
      }
      kinds.push("changed-regions-stanza");
      return { relPath: f.relPath, content: buildChangedRegionsStanzaV1(f.relPath, f.content, expanded) };
    }

    kinds.push("no-baseline-stanza");
    return { relPath: f.relPath, content: buildOversizedFilePagingStanzaV1(f.relPath, f.content) };
  });

  const capped = applyContentCaps(substituted, Number.MAX_SAFE_INTEGER, maxTotalChars);
  return capped.map((r, i) => ({
    ...r,
    contentKind: kinds[i]!,
    isOversizedStanza: kinds[i] === "changed-regions-stanza" || kinds[i] === "no-baseline-stanza",
  }));
}

/**
 * @deprecated Legacy entry point kept for callers with no diff baseline to
 * offer (equivalent to calling `applyContentCapsWithRegionsV1` with
 * `changedRanges: undefined` for every file — every over-threshold file
 * takes the `no-baseline-stanza` path). `contextPack.ts` calls
 * `applyContentCapsWithRegionsV1` directly with real changed ranges where a
 * git baseline is available.
 */
export function applyContentCapsWithPagingV1(
  files: ReadonlyArray<{ relPath: string; content: string | undefined }>,
  options?: {
    truncatedFileMaxChars?: number;
    maxTotalChars?: number;
  }
): ImplReviewFileResultV2[] {
  return applyContentCapsWithRegionsV1(
    files.map((f) => ({ relPath: f.relPath, content: f.content })),
    {
      inlineWholeMaxChars: options?.truncatedFileMaxChars,
      maxTotalChars: options?.maxTotalChars,
    }
  );
}
