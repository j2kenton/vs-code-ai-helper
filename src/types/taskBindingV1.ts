/**
 * Task binding model (plan §3.9).
 *
 * `ownership` and `taskFolder` are the PERSISTED project/meta-root binding
 * recorded in task-progress.json. They are never treated as an operation
 * lease (that is workflowLeaseStoreV1's runtime-only job) and are never
 * cleared by stage transitions, completion, or reopen. The binding id is a
 * digest so correlation records, spools, and logs can carry a stable task
 * identity without ever logging raw filesystem paths (plan §2.2).
 */
import { createHash } from "crypto";
import { TaskProgress } from "./taskProgress";

/** The persisted ownership shape, exactly as `TaskProgress` declares it today. */
export type PersistedTaskOwnershipV1 = NonNullable<TaskProgress["ownership"]>;

export interface TaskBindingV1 {
  readonly ownership: PersistedTaskOwnershipV1;
  readonly taskFolder: TaskProgress["taskFolder"];
  /** SHA-256 (lowercase hex) of the canonical ownership + taskFolder binding. */
  readonly bindingId: string;
}

export type TaskBindingDeriveResultV1 =
  | { readonly ok: true; readonly binding: TaskBindingV1 }
  | { readonly ok: false; readonly reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Canonical preimage: version tag + JSON with a FIXED key order and absent
 * optional fields omitted entirely, so the digest is deterministic across
 * writers regardless of the property order a JSON file happened to persist.
 * Values are used exactly as persisted — the binding identifies the persisted
 * record, not a normalized filesystem path.
 */
function canonicalBindingPreimage(
  ownership: PersistedTaskOwnershipV1,
  taskFolder: string
): string {
  const canonical: Record<string, string> = {
    boundAt: ownership.boundAt,
    metaRoot: ownership.metaRoot,
    projectRoot: ownership.projectRoot,
    taskFolder,
  };
  if (ownership.state !== undefined) {
    canonical.state = ownership.state;
  }
  if (ownership.workspaceRoot !== undefined) {
    canonical.workspaceRoot = ownership.workspaceRoot;
  }
  return "ensemble-task-binding-v1\n" + JSON.stringify(canonical);
}

export function computeTaskBindingIdV1(
  ownership: PersistedTaskOwnershipV1,
  taskFolder: string
): string {
  return createHash("sha256")
    .update(canonicalBindingPreimage(ownership, taskFolder), "utf8")
    .digest("hex");
}

/**
 * Derive the task binding from validated persisted progress fields. Any
 * shape that cannot produce an unambiguous binding — missing or unresolved
 * ownership, empty roots, an unparseable boundAt — is a derivation failure
 * the caller must surface as `taskProgressRecoveryRequired`, never guess
 * around.
 */
export function deriveTaskBindingV1(
  progress: Pick<TaskProgress, "ownership" | "taskFolder">
): TaskBindingDeriveResultV1 {
  if (!isNonEmptyString(progress.taskFolder)) {
    return { ok: false, reason: "taskFolder is missing or empty" };
  }
  const ownership = progress.ownership;
  if (ownership === undefined) {
    return { ok: false, reason: "ownership binding is missing" };
  }
  if (!isNonEmptyString(ownership.metaRoot)) {
    return { ok: false, reason: "ownership.metaRoot is missing or empty" };
  }
  if (!isNonEmptyString(ownership.projectRoot)) {
    return { ok: false, reason: "ownership.projectRoot is missing or empty" };
  }
  if (!isNonEmptyString(ownership.boundAt) || !Number.isFinite(Date.parse(ownership.boundAt))) {
    return { ok: false, reason: "ownership.boundAt is not a parseable timestamp" };
  }
  if (ownership.workspaceRoot !== undefined && !isNonEmptyString(ownership.workspaceRoot)) {
    return { ok: false, reason: "ownership.workspaceRoot is present but empty" };
  }
  if (ownership.state !== undefined && ownership.state !== "resolved" && ownership.state !== "ownership-unresolved") {
    return { ok: false, reason: "ownership.state is not a recognized value" };
  }
  if (ownership.state === "ownership-unresolved") {
    return { ok: false, reason: "ownership is recorded as unresolved — no stable binding exists" };
  }
  return {
    ok: true,
    binding: {
      ownership,
      taskFolder: progress.taskFolder,
      bindingId: computeTaskBindingIdV1(ownership, progress.taskFolder),
    },
  };
}
