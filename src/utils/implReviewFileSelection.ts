/**
 * Pure, VS-Code-free helpers for selecting and capping file contents for
 * implementation reviews. Isolated so they can be unit-tested without a
 * VS Code host environment.
 */

/** Per-file and total content caps applied when embedding files in an
 * implementation-review context pack. */
export const IMPL_REVIEW_MAX_CHARS_PER_FILE = 8000;
export const IMPL_REVIEW_MAX_TOTAL_CHARS = 60000;

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
 * total budget. Files that fall beyond the total budget are included with
 * `content: null` so callers can report them as omitted rather than
 * silently dropping them.
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
      text = text.slice(0, remaining);
      truncated = true;
    }

    totalChars += text.length;
    if (totalChars >= maxTotalChars) {
      capReached = true;
    }

    results.push({ relPath, content: text, truncated });
  }

  return results;
}
