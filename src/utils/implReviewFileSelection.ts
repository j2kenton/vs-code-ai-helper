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
 * windows, to make that the uncommon case rather than the common one. */
export const IMPL_REVIEW_MAX_CHARS_PER_FILE = 8000;
export const IMPL_REVIEW_MAX_TOTAL_CHARS = 150000;

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
