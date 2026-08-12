/**
 * Binding-root-relative path navigation for the read-only file browser
 * (plan Part 10).
 *
 * The server is the authority on confinement (canonicalization, `..` and
 * absolute-path rejection, provider resolve-then-check for symlinks); the
 * client never needs to send anything but clean relative paths, so these
 * helpers make escapes UNREPRESENTABLE in the UI rather than merely
 * rejected: navigation composes only validated entry names onto the current
 * path, and `.` names the binding root.
 */

/** The binding root as a request path (the server resolves `.` to the root). */
export const ROOT_PATH_V1 = '.';

/** A single directory-entry name safe to compose onto a path. */
export function isSafeEntryNameV1(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/** Descend into `name` from `current`; null when the name is not composable. */
export function childPathV1(current: string, name: string): string | null {
  if (!isSafeEntryNameV1(name)) {
    return null;
  }
  return current === ROOT_PATH_V1 ? name : `${current}/${name}`;
}

/** Ascend one level; the root's parent is the root. */
export function parentPathV1(current: string): string {
  if (current === ROOT_PATH_V1) {
    return ROOT_PATH_V1;
  }
  const separator = current.lastIndexOf('/');
  return separator === -1 ? ROOT_PATH_V1 : current.slice(0, separator);
}

/** Breadcrumb segments for display: the root marker plus each path segment. */
export function breadcrumbSegmentsV1(current: string): string[] {
  if (current === ROOT_PATH_V1) {
    return ['/'];
  }
  return ['/', ...current.split('/')];
}
