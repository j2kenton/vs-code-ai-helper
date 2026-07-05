/**
 * Sanitize and validate a workspace-relative path received from user or
 * model input.
 *
 * The returned string uses forward slashes, has no leading slash, and
 * contains no "." or ".." segments. An empty return value ("") represents
 * the workspace root (equivalent to ".").
 *
 * Returns undefined when:
 * - the value is not a non-empty string
 * - any path segment is ".." (traversal) or "." (ambiguous mid-path reference)
 *
 * The caller is responsible for the final workspace-boundary check using
 * the resolved URI's fsPath (defence in depth against encoded traversal).
 */
export function sanitizeRelativePath(relativePath: unknown): string | undefined {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return undefined;
  }

  // Normalise separators, strip leading slashes and leading "./" prefixes
  const cleaned = relativePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");

  // A bare "." means workspace root; normalise to "" the same as empty-after-clean
  const normalized = cleaned === "." ? "" : cleaned;

  // Reject any ".." (traversal) or "." (ambiguous mid-path) segment
  if (normalized !== "" && normalized.split("/").some((s) => s === ".." || s === ".")) {
    return undefined;
  }

  return normalized;
}
