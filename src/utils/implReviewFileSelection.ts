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
