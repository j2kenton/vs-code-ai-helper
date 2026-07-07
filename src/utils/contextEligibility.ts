/**
 * Context-pack eligibility rules, size constants, and the secret-filename
 * denylist. Consumed by contextPack.ts and implReviewFileSelection.ts so
 * the rules are expressed once and cannot drift between pack builders.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIZE CONSTANTS
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Maximum bytes rendered into the pack for a single file (≈ 100 KB). */
export const CONTEXT_PER_FILE_MAX_BYTES = 100_000;

/** Maximum number of open-editor files included per pack. */
export const CONTEXT_MAX_FILES = 20;

/** Maximum total rendered bytes across all files in a pack (≈ 400 KB). */
export const CONTEXT_TOTAL_MAX_BYTES = 400_000;

/**
 * Prompt-byte threshold above which a one-off confirmation is shown before
 * the run. Measured on the full final prompt string, not just the pack
 * fragment.
 */
export const CONTEXT_CONFIRM_THRESHOLD_BYTES = 150_000;

/**
 * Absolute ceiling on the full final-prompt string. A prompt above this
 * aborts with no confirm override — prevents accidental massive requests.
 */
export const PROMPT_TOTAL_MAX_BYTES = 600_000;

/**
 * Shared token-count approximation helper. 1 token ≈ 4 UTF-8 bytes for
 * typical code/prose. Used by UI labels and tests; not a billing estimate.
 */
export function estimateTokensFromUtf8Bytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * SECRET-FILENAME DENYLIST
 * ─────────────────────────────────────────────────────────────────────────
 *
 * IMPORTANT: This is a BEST-EFFORT courtesy filter based on well-known
 * filename conventions. It does NOT detect secrets pasted into a file with
 * an innocuous name (e.g. notes.txt). It is not secret detection.
 *
 * A file whose basename matches one of these patterns is excluded from
 * provider-bound context packs regardless of location.
 */
const DENYLIST_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,         // .env.local, .env.production, etc.
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,             // id_rsa, id_rsa.pub, id_rsa.whatever
  /^id_ed25519/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials\.json$/i,
  /^credentials$/i,       // AWS-style extensionless credentials file
  /\.keystore$/i,
  /\.jks$/i,
  /^\.htpasswd$/i,
  /\.tfstate$/i,          // Terraform state (embeds secrets)
  /\.tfstate\.backup$/i,
];

/**
 * Returns true when the filename (basename only, case-insensitive) matches
 * any entry in the secret-filename denylist.
 *
 * Callers must also apply this to the resolved target basename when the
 * document path involves a symlink.
 */
export function isDenylisted(basename: string): boolean {
  return DENYLIST_PATTERNS.some((re) => re.test(basename));
}
