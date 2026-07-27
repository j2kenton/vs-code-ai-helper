/**
 * Workflow path safety (plan §1.8).
 *
 * Decides whether a registered root and a root-relative locator are safe to
 * touch at all. Mutation is supported only for trusted local roots whose
 * canonical resolved paths remain under the registered root and contain no
 * symlink/junction/reparse-point component. These are COOPERATIVE checks
 * against accidental concurrency and misconfiguration inside the extension
 * host — not an adversarial cross-process security guarantee (plan: product
 * decisions / risks).
 *
 * Locators are always forward-slash relative paths (plan §2.1: "registered
 * root-relative locators"); absolute paths, drive letters, traversal, and
 * platform-reserved names are rejected before any filesystem access.
 */
import * as fs from "fs";
import * as path from "path";

export interface WorkflowRootV1 {
  readonly rootId: string;
  /** Absolute local filesystem path of the registered root. */
  readonly fsPath: string;
  /** False for roots that may be read but never mutated (e.g. untrusted workspaces). */
  readonly trustedForMutation: boolean;
  /**
   * Optional LIVE mutation-trust check, re-consulted by the file store
   * immediately before every mutation attempt, in addition to the one-time
   * `trustedForMutation` flag recorded at registration. Registration is
   * one-time (a root id cannot be re-registered), but some root kinds —
   * task-folder roots in particular — re-verify their trust on every
   * `ensure*` call and must be able to withdraw it later without a
   * re-registration. Omit for root kinds whose trust never changes after
   * registration.
   */
  readonly isCurrentlyTrustedForMutation?: () => boolean;
}

export type WorkflowRootClassificationV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type WorkflowRelativePathValidationV1 =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const MAX_RELATIVE_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
/** Written via fromCharCode so no literal control byte sits in this source file. */
const NUL_CHAR = String.fromCharCode(0);
/** Windows device names that alias console/printer/serial handles in any directory. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A root is supported when it is an absolute, local (non-UNC) filesystem
 * path. Remote schemes never reach this layer — callers hand over `fsPath`s
 * only for `file` roots — so the residual checks are shape checks.
 */
export function classifyWorkflowRootV1(rootFsPath: string): WorkflowRootClassificationV1 {
  if (typeof rootFsPath !== "string" || rootFsPath.length === 0) {
    return { ok: false, reason: "root path is empty" };
  }
  if (rootFsPath.includes(NUL_CHAR)) {
    return { ok: false, reason: "root path contains a NUL byte" };
  }
  if (!path.isAbsolute(rootFsPath)) {
    return { ok: false, reason: "root path is not absolute" };
  }
  if (rootFsPath.startsWith("\\\\") || rootFsPath.startsWith("//")) {
    return { ok: false, reason: "UNC/network roots are not supported for workflow storage" };
  }
  return { ok: true };
}

/**
 * Validate a root-relative locator without touching the filesystem. Returns
 * the individual segments so resolution can join them platform-natively.
 */
export function validateWorkflowRelativePathV1(relativePath: string): WorkflowRelativePathValidationV1 {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, reason: "relative path is empty" };
  }
  if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    return { ok: false, reason: `relative path exceeds ${MAX_RELATIVE_PATH_LENGTH} characters` };
  }
  if (relativePath.includes(NUL_CHAR)) {
    return { ok: false, reason: "relative path contains a NUL byte" };
  }
  if (relativePath.includes("\\")) {
    return { ok: false, reason: "relative path must use forward slashes" };
  }
  if (relativePath.includes(":")) {
    return { ok: false, reason: "relative path must not contain a drive or stream separator" };
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: "relative path has an empty segment (leading, trailing, or doubled slash)" };
    }
    if (segment === "." || segment === "..") {
      return { ok: false, reason: "relative path must not contain '.' or '..' segments" };
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      return { ok: false, reason: `a path segment exceeds ${MAX_SEGMENT_LENGTH} characters` };
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return { ok: false, reason: "a path segment ends with a dot or space (unrepresentable on Windows)" };
    }
    const baseName = segment.split(".", 1)[0] ?? segment;
    if (WINDOWS_RESERVED_NAMES.test(baseName)) {
      return { ok: false, reason: `a path segment uses the reserved device name ${JSON.stringify(segment)}` };
    }
  }
  return { ok: true, segments };
}

export type WorkflowPathResolutionV1 =
  | { readonly ok: true; readonly fsPath: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a validated locator against a classified root and prove the result
 * is still contained under the root (belt-and-suspenders after the segment
 * validation above — containment must hold even if a future validator bug
 * lets something odd through).
 */
export function resolveWorkflowFsPathV1(
  root: WorkflowRootV1,
  relativePath: string
): WorkflowPathResolutionV1 {
  const validated = validateWorkflowRelativePathV1(relativePath);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const resolved = path.resolve(root.fsPath, ...validated.segments);
  const relation = path.relative(path.resolve(root.fsPath), resolved);
  if (relation.length === 0 || relation.startsWith("..") || path.isAbsolute(relation)) {
    return { ok: false, reason: "resolved path escapes the registered root" };
  }
  return { ok: true, fsPath: resolved, segments: validated.segments };
}

export type WorkflowReparseCheckV1 =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Walk every component from the registered root down to the target and
 * reject the path if any existing component is a symlink, junction, or
 * other link-like reparse point (Node reports Windows junctions and symlinks
 * alike via lstat's isSymbolicLink). A missing tail is safe — creation
 * targets legitimately do not exist yet — but nothing below a missing
 * component can exist, so the walk stops there.
 *
 * Call this immediately before every mutation (plan §1.8: "Revalidate
 * immediately before mutation"): a check from an earlier tick can be stale.
 */
export async function checkNoReparseComponentsV1(
  root: WorkflowRootV1,
  segments: readonly string[]
): Promise<WorkflowReparseCheckV1> {
  let current = path.resolve(root.fsPath);
  const components = [current, ...segments.map((segment) => (current = path.join(current, segment)))];
  for (const component of components) {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { safe: true };
      }
      return { safe: false, reason: `lstat failed with ${(error as NodeJS.ErrnoException).code ?? "an unknown error"}` };
    }
    if (stats.isSymbolicLink()) {
      return { safe: false, reason: "a path component is a symlink, junction, or reparse point" };
    }
  }
  return { safe: true };
}
