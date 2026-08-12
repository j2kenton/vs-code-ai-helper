/**
 * Task-to-sandbox workspace binding (plan Part 3).
 *
 * Every task references a SandboxBinding at creation, and the durable model
 * (Part 5) persists it. Without a valid binding, task creation fails with a
 * typed error — there is no unbound execution path. All read-only file and
 * diff endpoints resolve paths strictly relative to the binding's allowed
 * root with canonicalization and rejection of escapes; symlinks are resolved
 * to their real targets via the sandbox provider's filesystem APIs BEFORE
 * authorization, and any resolved target outside the root is rejected.
 */

/** Supported sandbox execution platforms (BYOS). */
export type SandboxProviderV1 = "e2b" | "daytona";

/** How the task's source tree gets into the sandbox. */
export type SandboxSourceAcquisitionV1 =
  | {
      /** Clone a git URL + ref into the sandbox. */
      readonly kind: "gitClone";
      readonly repoUrl: string;
      /** Branch, tag, or commit to check out. */
      readonly ref: string;
    }
  | {
      /** Attach to an existing path in a user-managed sandbox. */
      readonly kind: "attachExisting";
      /** Absolute path inside the sandbox; becomes/contains the binding root. */
      readonly path: string;
    };

/** Who owns the sandbox lifecycle. */
export type SandboxLifecycleOwnershipV1 =
  /** Created for this task; the control plane tears it down per cleanup policy. */
  | "task-owned-ephemeral"
  /** Pre-existing user-managed workspace; never destroyed by the control plane. */
  | "user-managed-persistent";

/** What happens to a task-owned sandbox when the task settles. */
export type SandboxCleanupPolicyV1 = "destroy-on-completion" | "retain";

/**
 * The SandboxBinding resource. `bindingId` and `ownerUserId` are
 * server-assigned; clients submit the remaining fields at task creation.
 */
export interface SandboxBindingV1 {
  readonly bindingId: string;
  /** Owning user (server-established identity; never client-asserted). */
  readonly ownerUserId: string;
  readonly provider: SandboxProviderV1;
  /** Provider-side sandbox/workspace identifier. */
  readonly sandboxId: string;
  readonly source: SandboxSourceAcquisitionV1;
  /**
   * The allowed working-directory root (absolute path inside the sandbox).
   * Every file/diff path resolves strictly relative to this root.
   */
  readonly workingDirectoryRoot: string;
  readonly lifecycle: SandboxLifecycleOwnershipV1;
  readonly cleanup: SandboxCleanupPolicyV1;
}

/**
 * The client-submitted portion of a binding (task creation request).
 *
 * `sandboxId` is conditional on lifecycle, and the union encodes why. A
 * `task-owned-ephemeral` binding names a sandbox the control plane has not
 * created yet — its id is a RESULT of creation, not an input to it — so
 * requiring one made the default mode impossible to submit: the client had
 * nothing truthful to put there, and providers like E2B have no dashboard
 * where a user could go and make one first (sandboxes are created on demand
 * by the SDK and destroyed after use). Only `user-managed-persistent`, which
 * attaches to a workspace the user already owns and keeps, has an id to give.
 */
export type SandboxBindingRequestV1 =
  | (Omit<SandboxBindingV1, "bindingId" | "ownerUserId" | "sandboxId" | "lifecycle"> & {
      readonly lifecycle: "task-owned-ephemeral";
      /** Never submitted: the control plane creates the sandbox and assigns this. */
      readonly sandboxId?: undefined;
    })
  | (Omit<SandboxBindingV1, "bindingId" | "ownerUserId" | "lifecycle"> & {
      readonly lifecycle: "user-managed-persistent";
    });

/**
 * Typed error codes for binding validation and path confinement (plan
 * Part 3). Task creation and file/diff retrieval return these; the UI
 * (Part 7) surfaces them on the creation form.
 */
export type SandboxBindingErrorCodeV1 =
  /** Task creation without a binding — no unbound execution path exists. */
  | "sandboxBindingMissing"
  /** Shape-level validation failed (see validateSandboxBindingRequestV1). */
  | "sandboxBindingInvalid"
  /** No stored provider key for the binding's provider. */
  | "sandboxProviderKeyMissing"
  /** The named sandbox is not reachable or creatable. */
  | "sandboxUnreachable"
  /** The allowed root is not a well-formed absolute path. */
  | "workingDirectoryRootInvalid"
  /** A requested file/diff path escapes the binding root (`..`, absolute). */
  | "pathOutsideBindingRoot"
  /** A path's provider-resolved real target lies outside the binding root. */
  | "symlinkEscapesBindingRoot";

const PROVIDERS_V1: ReadonlySet<string> = new Set(["e2b", "daytona"]);
const LIFECYCLES_V1: ReadonlySet<string> = new Set([
  "task-owned-ephemeral",
  "user-managed-persistent",
]);
const CLEANUPS_V1: ReadonlySet<string> = new Set(["destroy-on-completion", "retain"]);

const MAX_BINDING_STRING_LENGTH = 2048;

function isBoundedNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_BINDING_STRING_LENGTH
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a well-formed absolute POSIX path with no `.`/`..` segments. */
export function isWellFormedAbsoluteRootV1(value: unknown): value is string {
  if (!isBoundedNonEmptyString(value) || !value.startsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment, index) => {
    if (index === 0) {
      return segment === "";
    }
    // A single trailing empty segment ("/root/") is tolerated nowhere: roots
    // are stored canonical, without a trailing slash (except the root "/").
    return segment !== "" && segment !== "." && segment !== "..";
  }) || value === "/";
}

export type SandboxBindingValidationResultV1 =
  | { readonly ok: true; readonly binding: SandboxBindingRequestV1 }
  | {
      readonly ok: false;
      readonly code: Extract<
        SandboxBindingErrorCodeV1,
        "sandboxBindingMissing" | "sandboxBindingInvalid" | "workingDirectoryRootInvalid"
      >;
      readonly reason: string;
    };

/**
 * Shape-level validation of a client-submitted binding. Reachability and
 * provider-key checks are server-side (Part 5) and return their own typed
 * codes; this validates everything checkable from the value alone,
 * fail-closed on unknown fields.
 */
export function validateSandboxBindingRequestV1(raw: unknown): SandboxBindingValidationResultV1 {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "sandboxBindingMissing", reason: "task creation requires a sandboxBinding" };
  }
  if (!isPlainRecord(raw)) {
    return { ok: false, code: "sandboxBindingInvalid", reason: "sandboxBinding is not an object" };
  }
  const allowed = new Set(["provider", "sandboxId", "source", "workingDirectoryRoot", "lifecycle", "cleanup"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { ok: false, code: "sandboxBindingInvalid", reason: `sandboxBinding has an unknown field: ${key}` };
    }
  }
  if (typeof raw.provider !== "string" || !PROVIDERS_V1.has(raw.provider)) {
    return { ok: false, code: "sandboxBindingInvalid", reason: 'provider must be "e2b" or "daytona"' };
  }
  if (typeof raw.lifecycle !== "string" || !LIFECYCLES_V1.has(raw.lifecycle)) {
    return { ok: false, code: "sandboxBindingInvalid", reason: "lifecycle must be a recognized ownership mode" };
  }
  // Checked against lifecycle rather than unconditionally: an ephemeral
  // sandbox does not exist when the binding is submitted, so accepting an id
  // there would be accepting a claim about something the client cannot know.
  if (raw.lifecycle === "user-managed-persistent") {
    if (!isBoundedNonEmptyString(raw.sandboxId)) {
      return {
        ok: false,
        code: "sandboxBindingInvalid",
        reason: "a user-managed persistent workspace requires the sandboxId it attaches to",
      };
    }
  } else if (raw.sandboxId !== undefined) {
    return {
      ok: false,
      code: "sandboxBindingInvalid",
      reason:
        "sandboxId must be omitted for a task-owned ephemeral sandbox — the control plane creates it and assigns the id",
    };
  }
  if (typeof raw.cleanup !== "string" || !CLEANUPS_V1.has(raw.cleanup)) {
    return { ok: false, code: "sandboxBindingInvalid", reason: "cleanup must be a recognized cleanup policy" };
  }
  if (raw.lifecycle === "user-managed-persistent" && raw.cleanup !== "retain") {
    return {
      ok: false,
      code: "sandboxBindingInvalid",
      reason: "a user-managed persistent workspace can only carry the retain cleanup policy",
    };
  }
  if (!isWellFormedAbsoluteRootV1(raw.workingDirectoryRoot)) {
    return {
      ok: false,
      code: "workingDirectoryRootInvalid",
      reason: "workingDirectoryRoot must be a canonical absolute path with no . or .. segments",
    };
  }
  const source = raw.source;
  if (!isPlainRecord(source)) {
    return { ok: false, code: "sandboxBindingInvalid", reason: "source is not an object" };
  }
  let decodedSource: SandboxSourceAcquisitionV1;
  if (source.kind === "gitClone") {
    for (const key of Object.keys(source)) {
      if (!["kind", "repoUrl", "ref"].includes(key)) {
        return { ok: false, code: "sandboxBindingInvalid", reason: `gitClone source has an unknown field: ${key}` };
      }
    }
    if (!isBoundedNonEmptyString(source.repoUrl) || !isBoundedNonEmptyString(source.ref)) {
      return { ok: false, code: "sandboxBindingInvalid", reason: "gitClone source requires repoUrl and ref" };
    }
    decodedSource = { kind: "gitClone", repoUrl: source.repoUrl, ref: source.ref };
  } else if (source.kind === "attachExisting") {
    for (const key of Object.keys(source)) {
      if (!["kind", "path"].includes(key)) {
        return { ok: false, code: "sandboxBindingInvalid", reason: `attachExisting source has an unknown field: ${key}` };
      }
    }
    if (!isWellFormedAbsoluteRootV1(source.path)) {
      return { ok: false, code: "sandboxBindingInvalid", reason: "attachExisting source requires a canonical absolute path" };
    }
    decodedSource = { kind: "attachExisting", path: source.path };
  } else {
    return { ok: false, code: "sandboxBindingInvalid", reason: `source has an unrecognized kind: ${JSON.stringify(source.kind)}` };
  }
  // Built per branch so the returned value matches the union member its
  // lifecycle selects, rather than carrying a `string | undefined` sandboxId
  // that neither member accepts.
  const common = {
    provider: raw.provider as SandboxProviderV1,
    source: decodedSource,
    workingDirectoryRoot: raw.workingDirectoryRoot as string,
    cleanup: raw.cleanup as SandboxCleanupPolicyV1,
  };
  return {
    ok: true,
    binding:
      raw.lifecycle === "user-managed-persistent"
        ? { ...common, lifecycle: "user-managed-persistent", sandboxId: raw.sandboxId as string }
        : { ...common, lifecycle: "task-owned-ephemeral" },
  };
}

export type ConfinedPathResultV1 =
  | { readonly ok: true; readonly absolutePath: string }
  | {
      readonly ok: false;
      readonly code: Extract<SandboxBindingErrorCodeV1, "pathOutsideBindingRoot">;
      readonly reason: string;
    };

/**
 * Resolve a client-requested file/diff path strictly relative to the binding
 * root: relative POSIX paths only, canonicalized, with `..` and absolute
 * paths rejected. This is the LEXICAL half of the Part 3 confinement rule.
 * The server must additionally resolve the returned path to its real target
 * via the sandbox provider's filesystem APIs BEFORE authorization and reject
 * it with `symlinkEscapesBindingRoot` when the resolved target lies outside
 * the root — symlinks are followed-then-checked, never trusted as given.
 */
export function confinePathToBindingRootV1(
  workingDirectoryRoot: string,
  requestedPath: string
): ConfinedPathResultV1 {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > MAX_BINDING_STRING_LENGTH) {
    return { ok: false, code: "pathOutsideBindingRoot", reason: "path must be a bounded non-empty string" };
  }
  if (requestedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(requestedPath) || requestedPath.startsWith("\\")) {
    return { ok: false, code: "pathOutsideBindingRoot", reason: "absolute paths are rejected; paths are binding-root-relative" };
  }
  if (requestedPath.includes("\\")) {
    return { ok: false, code: "pathOutsideBindingRoot", reason: "backslash separators are rejected; use POSIX separators" };
  }
  if (requestedPath.includes("\0")) {
    return { ok: false, code: "pathOutsideBindingRoot", reason: "NUL bytes are rejected" };
  }
  const segments: string[] = [];
  for (const segment of requestedPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return { ok: false, code: "pathOutsideBindingRoot", reason: '".." segments are rejected' };
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return { ok: false, code: "pathOutsideBindingRoot", reason: "path resolves to the root itself" };
  }
  const rootPrefix = workingDirectoryRoot === "/" ? "" : workingDirectoryRoot;
  return { ok: true, absolutePath: `${rootPrefix}/${segments.join("/")}` };
}
