/**
 * Shared workflow runtime services (plan §2.1, Privacy/Chat cohorts).
 *
 * The extension host's SINGLE `WorkflowPathRegistryV1` +
 * `WorkflowFileStoreV1` authority. Before this module existed, the task-local
 * Chat store built its own module-local registry and marked every
 * caller-supplied absolute task folder as a trusted mutation root — a second,
 * uncoordinated path authority that bypassed the plan's "one path registry"
 * boundary (plan §2.1). Every V1 workflow consumer now shares this one
 * registry: task-folder roots are registered through the strict,
 * ownership-backed `ensureWorkflowTaskFolderRootV1` (mutation authority
 * derives from validated persisted `ownership` + `taskFolder`, plan §3.9,
 * optionally pinned to a caller-supplied exact binding), dedicated non-task
 * storage (the Global Assistant's own folder) registers through the separate
 * `ensureWorkflowNonTaskStorageRootV1`, the private-storage root is
 * configured exactly once at activation from `context.globalStorageUri`
 * (`configureWorkflowPrivateStorageRootV1`), and the file store is always
 * derived from this registry's live root list.
 *
 * Root ids are stable SHA-256 digests of the canonical absolute path, so
 * registration is idempotent across consumers and the same folder always
 * resolves to the same root id within the host.
 *
 * This module also holds the activation-wired durable Chat interaction
 * transaction store (`setChatInteractionTransactionStoreV1`, called from
 * `extension.ts`). The task-local Chat store consults it to reconcile its
 * display mirror against the durable transaction records (AC-CHAT-TX-03) and
 * to settle counterpart transactions on Chat Reset (plan §5.1/§5.5) — without
 * a utils → actions import cycle.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ChatInteractionTransactionStoreV1 } from "./chatInteractionTransactionStoreV1";
import { BoundedResultStoreV1, createBoundedResultStoreV1 } from "./boundedResultStoreV1";
import { createEditPlanBrokerV1, EditPlanBrokerV1 } from "./editBrokerToolSessionHandlerV1";
import { createWorkflowLeaseStoreV1, WorkflowLeaseStoreV1 } from "./workflowLeaseStoreV1";
import { decodeTaskProgressTextV1 } from "./taskProgressDecoderV1";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";
import { resolveTaskRootCandidates } from "../utils/taskRoot";
import {
  createWorkflowFileStoreV1,
  WorkflowFileStoreV1,
} from "./workflowFileStoreV1";
import {
  createWorkflowPathRegistryV1,
  WorkflowAllocatedPathV1,
  WorkflowPathRegistryV1,
} from "./workflowPathRegistryV1";
import {
  classifyWorkflowRootV1,
  resolveWorkflowFsPathV1,
  WorkflowRootV1,
} from "./workflowPathSafetyV1";

let registry: WorkflowPathRegistryV1 = createWorkflowPathRegistryV1();
let fileStore: WorkflowFileStoreV1 = createWorkflowFileStoreV1(registry.registeredRoots());
let privateRootId: string | undefined;
let transactionStore: ChatInteractionTransactionStoreV1 | undefined;
let editPlanBroker: EditPlanBrokerV1 | undefined;
let providerResultSpoolStore: BoundedResultStoreV1 | undefined;
/**
 * The one shared task-operation lease store (plan §1.8/§3.9) the action
 * coordinator acquires against for every provider/lifecycle row — a runtime,
 * in-memory-only concern, never persisted (see workflowLeaseStoreV1.ts's
 * module header). A fresh coordinator instance may be constructed per
 * invocation (it is a stateless factory over its injected deps), but every
 * instance must share THIS lease store so a duplicate invocation against the
 * same task binding is actually caught.
 */
let leaseStore: WorkflowLeaseStoreV1 = createWorkflowLeaseStoreV1();
/**
 * Root ids that passed the strict, ownership-backed task-folder verification
 * (see ensureWorkflowTaskFolderRootV1) — every successfully registered
 * `taskFolder` root, by construction. A later re-verification FAILURE
 * removes the id again even though registration itself is one-time.
 */
let verifiedTaskFolderRootIds = new Set<string>();
/**
 * The ownership-derived `TaskBindingV1.bindingId` for every verified root —
 * a real digest of the folder's persisted `ownership` + `taskFolder`, not a
 * path/canonicalId stand-in. Always present for a verified root (the strict
 * contract refuses ownership-free progress). See `getVerifiedTaskBindingIdV1`.
 */
let verifiedTaskFolderBindingIds = new Map<string, string>();

/**
 * Stable, path-derived root id (idempotent registration across consumers).
 * Task-folder and non-task-storage roots deliberately share the
 * `"taskfolder"` id space, so the SAME path always maps to one root id and a
 * cross-kind re-registration attempt is caught by the kind guard in each
 * ensure function rather than silently producing two roots for one folder.
 * Meta roots use their own `"meta"` id space, since a meta root's PARENT
 * directory relationship to its task folders (a meta root always CONTAINS
 * its tasks) must never collide with the task-folder/non-task-storage id
 * space above.
 */
function rootIdFor(kind: "taskfolder" | "private" | "meta" | "workspace", fsPath: string): string {
  return `${kind}:${createHash("sha256").update(fsPath, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Case-insensitive-on-Windows path comparison, matching
 * `resolveTaskContext.ts`'s own `normalizeForCompare` (duplicated rather than
 * imported: that module pulls in `TaskInventory`/`CurrentTaskStore`, a
 * command-layer dependency this low-level services module must not take on).
 */
function normalizeForCompareV1(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** `child` is exactly `root`, or a descendant of it (path-separator-bounded, case-insensitive-on-Windows). */
function isSameOrUnderV1(child: string, root: string): boolean {
  const c = normalizeForCompareV1(child);
  const r = normalizeForCompareV1(root);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Containment check mirroring `resolveTaskContext.ts`'s command-layer policy
 * (duplicated rather than imported, for the same reason as
 * `normalizeForCompareV1` above), used by the NON-TASK storage tier
 * (`ensureWorkflowNonTaskStorageRootV1`): the folder must sit beneath a
 * recognized location — a configured task-root candidate (the Global
 * Assistant's own folder is a direct child of one) or any currently open
 * workspace folder. Exactly like `resolveTaskContext.ts`, this check is
 * SKIPPED (permissive) when no workspace is open at all — there is nothing
 * to contain against yet. Task-folder roots use the STRICT variant below
 * instead: their mutation authority requires validated persisted ownership,
 * and with ownership guaranteed there is always an `ownership.metaRoot` to
 * contain against, so no workspace-less bypass is needed (or permitted)
 * there.
 */
function isContainedInRecognizedLocationV1(fsPath: string, ownershipMetaRoot: string | undefined): boolean {
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.resolve(folder.uri.fsPath)
  );
  if (workspaceRoots.length === 0) {
    return true;
  }
  const resolvedFsPath = path.resolve(fsPath);
  if (ownershipMetaRoot !== undefined && isSameOrUnderV1(resolvedFsPath, path.resolve(ownershipMetaRoot))) {
    return true;
  }
  const insideConfiguredTaskRoot = resolveTaskRootCandidates().some(
    (candidate) => normalizeForCompareV1(path.dirname(resolvedFsPath)) === normalizeForCompareV1(path.resolve(candidate.absolutePath))
  );
  if (insideConfiguredTaskRoot) {
    return true;
  }
  return workspaceRoots.some((root) => isSameOrUnderV1(resolvedFsPath, root));
}

/**
 * The STRICT containment rule for task-folder roots (plan §3.9): unlike
 * `isContainedInRecognizedLocationV1`, there is NO "skip when no workspace is
 * open" escape — a task folder's mutation authority must never rest on an
 * unchecked physical location. The folder must sit beneath its own validated
 * `ownership.metaRoot`, beneath a configured task-root candidate, or beneath
 * a currently open workspace folder. Because the strict task contract
 * guarantees a validated `ownership.metaRoot` before this runs, there is
 * always at least one recognized location to contain against, workspace or
 * no workspace.
 */
function isContainedInRecognizedLocationStrictV1(fsPath: string, ownershipMetaRoot: string): boolean {
  const resolvedFsPath = path.resolve(fsPath);
  if (isSameOrUnderV1(resolvedFsPath, path.resolve(ownershipMetaRoot))) {
    return true;
  }
  const insideConfiguredTaskRoot = resolveTaskRootCandidates().some(
    (candidate) => normalizeForCompareV1(path.dirname(resolvedFsPath)) === normalizeForCompareV1(path.resolve(candidate.absolutePath))
  );
  if (insideConfiguredTaskRoot) {
    return true;
  }
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.resolve(folder.uri.fsPath)
  );
  return workspaceRoots.some((root) => isSameOrUnderV1(resolvedFsPath, root));
}

function rebuildFileStore(): void {
  fileStore = createWorkflowFileStoreV1(registry.registeredRoots());
}

/** The one shared path registry (plan §2.1's single allocation authority). */
export function getWorkflowPathRegistryV1(): WorkflowPathRegistryV1 {
  return registry;
}

/** The file store derived from the shared registry's CURRENT root list. */
export function getWorkflowFileStoreV1(): WorkflowFileStoreV1 {
  return fileStore;
}

/**
 * Validate and register a task folder as a trusted mutation root, once and
 * idempotently, returning its stable root id. Throws when the path fails the
 * §1.8 root shape rules — an unsupported folder surfaces through the typed
 * store outcomes, never through silent ad hoc path joins.
 *
 * TRUST (the full plan §3.9 contract — the implementation review's
 * mutation-authority blocker, now closed): task-folder mutation authority
 * derives from VALIDATED PERSISTED OWNERSHIP plus `taskFolder`, never from
 * path shape or workspace containment alone. A folder earns a trusted
 * `taskFolder` root ONLY when ALL of the following hold:
 *
 *  1. Its `task-progress.json` EXISTS and is readable as a regular file.
 *     Missing progress is not a task folder (every real one has progress
 *     from the moment `startNewTask.ts` creates it); dedicated non-task
 *     storage (the Global Assistant's own folder) registers through
 *     `ensureWorkflowNonTaskStorageRootV1` instead. Progress that exists
 *     but cannot be read as a regular file (permission denied, a directory
 *     at that path, a symlink cycle, any other I/O error) refuses
 *     registration — it is never folded into "absent".
 *  2. The progress STRICTLY DECODES for this folder: the decode passes
 *     `expectedTaskFolder` (the folder's own basename), so a copy of a
 *     DIFFERENT task's progress file dropped into (or left over in) this
 *     folder is refused rather than silently trusted.
 *  3. The decoded progress CARRIES a persisted `ownership` record whose
 *     `TaskBindingV1` derives via `deriveTaskBindingV1` (e.g. `ownership`
 *     recorded as unresolved is refused — the same fail-closed rule
 *     `resolveTaskContext.ts` applies at the command layer). Ownership-free
 *     progress — a task predating the ownership field — gets NO mutation
 *     trust: it must be rebound through the strict progress
 *     migration/recovery path (plan §3.10-§3.12) first.
 *  4. When `ownership.workspaceRoot` is present, it matches one of the
 *     currently open `vscode.workspace.workspaceFolders` — mirroring
 *     `resolveTaskContext.ts`'s own live-ownership check — so a task whose
 *     recorded owner is not (or no longer) an open workspace cannot earn a
 *     trusted mutation root purely because its progress file self-decodes.
 *  5. STRICT CONTAINMENT: the folder physically sits somewhere recognized —
 *     its own validated `ownership.metaRoot`, a configured task-root
 *     candidate, or an open workspace folder — with NO
 *     skip-when-no-workspace-is-open escape
 *     (`isContainedInRecognizedLocationStrictV1`). A successfully decoded
 *     folder sitting at an unrelated absolute path is refused.
 *  6. CALLER-SUPPLIED BINDING: when the caller passes
 *     `expected.bindingId` — a coordinator-derived `TaskBindingV1.bindingId`
 *     (plan §3.1/§3.9) or the authoritative binding a task-local Chat
 *     document already records — it must EQUAL the binding freshly derived
 *     from the folder's current persisted ownership. A mismatch (stale,
 *     foreign, or rebound binding) refuses registration.
 *
 * A successfully derived, live-matching binding is recorded and exposed via
 * `getVerifiedTaskBindingIdV1` (always defined for a registered task-folder
 * root), and `isWorkflowTaskFolderRootVerifiedV1` reports the current
 * verification state.
 *
 * REVALIDATED ON EVERY CALL (not only the first): the underlying
 * `WorkflowPathRegistryV1.registerRoot` call is genuinely one-time (it
 * throws on a duplicate root id), but the verification above it is NOT
 * cached — every call re-reads and re-decodes `task-progress.json` and
 * re-runs the ownership/live-workspace/containment/exact-binding checks, so
 * a folder whose progress becomes corrupt, loses its ownership record, gets
 * repointed at a workspace that is no longer open, or no longer matches the
 * caller-supplied binding AFTER its first successful registration is refused
 * on every later call too, not just the first.
 */
export interface WorkflowTaskFolderRootExpectationV1 {
  /**
   * A caller-supplied task binding (typically a coordinator-derived
   * `TaskBindingV1.bindingId`, plan §3.1/§3.9, or the authoritative binding a
   * task-local Chat document already records) that MUST equal the binding
   * freshly derived from this folder's current persisted ownership. A
   * mismatch refuses registration: the claimed binding is stale, belongs to
   * a different task, or the folder's ownership was rebound since the claim
   * was issued — all fail-closed conditions, never silently re-anchored.
   */
  readonly bindingId?: string;
}

export function ensureWorkflowTaskFolderRootV1(
  fsPath: string,
  expected?: WorkflowTaskFolderRootExpectationV1
): string {
  const classification = classifyWorkflowRootV1(fsPath);
  if (!classification.ok) {
    throw new Error(`Unsupported task folder root: ${classification.reason}`);
  }
  const rootId = rootIdFor("taskfolder", fsPath);
  const registeredKind = registry.rootKind(rootId);
  if (registeredKind !== undefined && registeredKind !== "taskFolder") {
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: this path is already registered as a ` +
        `${registeredKind} root — a task folder and dedicated non-task storage can never share one path.`
    );
  }

  // On ANY failure below, this round's verification has definitively failed
  // — clear whatever an EARLIER successful call may have recorded before
  // throwing, so a caller checking `isWorkflowTaskFolderRootVerifiedV1` /
  // `getVerifiedTaskBindingIdV1` after a failed re-verification observes the
  // current truth (not-verified) rather than a stale "still verified" from
  // before the folder's progress broke.
  let derived: { bindingId: string; ownershipMetaRoot: string };
  try {
    derived = verifyTaskFolderOwnershipBindingV1(fsPath);
    // CALLER-SUPPLIED BINDING (plan §3.9's exact-binding contract): when the
    // caller carries a binding identity it believes belongs to this folder,
    // it must equal the folder's own, freshly derived ownership binding —
    // mutation authority then derives from an EXACT, independently supplied
    // task binding, not merely from whatever the folder happens to claim
    // about itself.
    if (expected?.bindingId !== undefined && expected.bindingId !== derived.bindingId) {
      throw new Error(
        `Refused to register task folder root ${JSON.stringify(fsPath)}: its freshly derived ownership binding ` +
          `does not match the caller-supplied task binding — the claimed binding is stale, belongs to a ` +
          `different task, or the folder's persisted ownership was rebound since the claim was issued.`
      );
    }
  } catch (error) {
    verifiedTaskFolderRootIds.delete(rootId);
    verifiedTaskFolderBindingIds.delete(rootId);
    throw error;
  }

  if (registeredKind === undefined) {
    // `isCurrentlyTrustedForMutation` closes the window between registration
    // (one-time) and re-verification (re-run on every call): the file store
    // consults this at mutation time, so a consumer holding an older
    // captured locator cannot mutate through this root once a later
    // `ensureWorkflowTaskFolderRootV1` call withdraws trust (e.g. the
    // folder's progress becomes corrupt or its ownership no longer
    // validates).
    registry.registerRoot({
      rootId,
      fsPath,
      kind: "taskFolder",
      trustedForMutation: true,
      isCurrentlyTrustedForMutation: () => isWorkflowTaskFolderRootVerifiedV1(rootId),
    });
    rebuildFileStore();
  }
  // Every successfully (re)verified task-folder root is ownership-backed by
  // construction — the strict contract above refuses anything else.
  verifiedTaskFolderRootIds.add(rootId);
  verifiedTaskFolderBindingIds.set(rootId, derived.bindingId);
  return rootId;
}

/**
 * The full strict verification pass behind `ensureWorkflowTaskFolderRootV1`,
 * re-run on EVERY call (never cached): readable progress, strict decode,
 * REQUIRED ownership, derivable binding, live-workspace owner match, and
 * strict containment. Returns the freshly derived ownership binding id.
 */
function verifyTaskFolderOwnershipBindingV1(fsPath: string): { bindingId: string; ownershipMetaRoot: string } {
  let progressText: string;
  try {
    progressText = fs.readFileSync(path.join(fsPath, TASK_PROGRESS_FILENAME), "utf8");
  } catch (readError) {
    const code = (readError as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // MISSING PROGRESS IS NOT A TASK FOLDER. Every real task folder
      // carries task-progress.json from the moment `startNewTask.ts` creates
      // it (with `ownership` from the same first write — before task.md,
      // before any chat interaction is possible), so the ONLY folder that
      // legitimately reaches the runtime with no progress file is dedicated
      // non-task storage (the Global Assistant's own folder) — and that must
      // register through `ensureWorkflowNonTaskStorageRootV1` instead.
      throw new Error(
        `Refused to register task folder root ${JSON.stringify(fsPath)}: it has no ${TASK_PROGRESS_FILENAME}. ` +
          `Task-folder mutation authority requires validated persisted ownership (plan §3.9), which only task ` +
          `progress can carry — a folder with no task progress is not a task folder. Dedicated non-task storage ` +
          `(the Global Assistant's own folder) must register through ensureWorkflowNonTaskStorageRootV1.`
      );
    }
    // Present but not readable as an ordinary file — permission denied,
    // a directory sitting at that path, a symlink cycle, or any other
    // I/O anomaly. This is NOT the same as genuine absence and must not
    // silently fall back to any weaker trust tier.
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: its ${TASK_PROGRESS_FILENAME} exists ` +
        `at that path but could not be read as a regular file (${code ?? "unknown error"}).`
    );
  }
  const decoded = decodeTaskProgressTextV1(progressText, { expectedTaskFolder: path.basename(fsPath) });
  if (!decoded.ok) {
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: its ${TASK_PROGRESS_FILENAME} exists ` +
        `but does not decode as valid task progress for this folder (${decoded.code}: ${decoded.reason}).`
    );
  }
  const { ownership, taskFolder } = decoded.decoded.progress;
  if (ownership === undefined) {
    // NO OWNERSHIP, NO MUTATION TRUST (plan §3.9): task-folder mutation
    // authority derives from validated persisted ownership plus taskFolder.
    // A task whose progress predates the ownership field must be rebound
    // through the strict progress migration/recovery path (plan §3.10-§3.12)
    // before Chat or any other workflow mutation touches it — never trusted
    // on self-consistency or path shape alone.
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: its ${TASK_PROGRESS_FILENAME} carries no ` +
        `ownership binding. Task-folder mutation authority derives from validated persisted ownership plus ` +
        `taskFolder (plan §3.9); a task whose progress predates the ownership field must be rebound through ` +
        `the strict progress migration/recovery path before any workflow mutation, not trusted on ` +
        `self-consistency alone.`
    );
  }
  const bindingResult = deriveTaskBindingV1({ ownership, taskFolder });
  if (!bindingResult.ok) {
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: its persisted ownership binding ` +
        `could not be validated (${bindingResult.reason}).`
    );
  }
  if (ownership.workspaceRoot !== undefined) {
    const openRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      path.resolve(folder.uri.fsPath)
    );
    const resolvedOwner = normalizeForCompareV1(path.resolve(ownership.workspaceRoot));
    if (!openRoots.some((root) => normalizeForCompareV1(root) === resolvedOwner)) {
      throw new Error(
        `Refused to register task folder root ${JSON.stringify(fsPath)}: its persisted ` +
          `ownership.workspaceRoot does not match any currently open workspace folder.`
      );
    }
  }
  // STRICT CONTAINMENT: the folder must physically sit somewhere recognized —
  // its own (already-validated) ownership.metaRoot, a configured task-root
  // candidate, or an open workspace folder — with NO no-workspace bypass
  // (see isContainedInRecognizedLocationStrictV1).
  if (!isContainedInRecognizedLocationStrictV1(fsPath, ownership.metaRoot)) {
    throw new Error(
      `Refused to register task folder root ${JSON.stringify(fsPath)}: it is not contained within its ` +
        `persisted ownership.metaRoot, a configured task root, or any currently open workspace folder.`
    );
  }
  return { bindingId: bindingResult.binding.bindingId, ownershipMetaRoot: ownership.metaRoot };
}

/**
 * Validate and register a DEDICATED NON-TASK STORAGE folder (today: exactly
 * the Global Assistant's own chat folder) as a trusted mutation root, once
 * and idempotently, returning its stable root id. This is the deliberate
 * counterpart to `ensureWorkflowTaskFolderRootV1` — the implementation
 * review's "separate the Global Assistant's non-task storage registration
 * from task-folder registration" contract:
 *
 *  - NOT A TASK FOLDER: the folder must NOT carry a `task-progress.json` — a
 *    folder with task progress is a task folder and must go through the
 *    strict, ownership-backed task path instead, so the weaker tier below
 *    can never be used to bypass it. Progress that exists but cannot be read
 *    as a regular file fails closed exactly as in the task path.
 *  - TRUST TIER: shape (§1.8 root rules) plus containment beneath a
 *    configured task-root candidate (the Global Assistant's folder is a
 *    direct child of one) or an open workspace folder — the same
 *    permissive-when-no-workspace-is-open policy `resolveTaskContext.ts`
 *    applies at the command layer (`isContainedInRecognizedLocationV1`). No
 *    ownership binding is required because there is none to require: this
 *    folder is not a task.
 *  - KIND-SEPARATED: the root registers under the distinct `nonTaskStorage`
 *    kind, so it can never allocate task-only families (the creation
 *    sentinel) and a path already registered as a task folder can never be
 *    silently re-registered here (and vice versa).
 *
 * Revalidated on EVERY call (progress-absence and containment re-run), not
 * only the first.
 */
export function ensureWorkflowNonTaskStorageRootV1(fsPath: string): string {
  const classification = classifyWorkflowRootV1(fsPath);
  if (!classification.ok) {
    throw new Error(`Unsupported non-task storage root: ${classification.reason}`);
  }
  const rootId = rootIdFor("taskfolder", fsPath);
  const registeredKind = registry.rootKind(rootId);
  if (registeredKind !== undefined && registeredKind !== "nonTaskStorage") {
    throw new Error(
      `Refused to register non-task storage root ${JSON.stringify(fsPath)}: this path is already registered ` +
        `as a ${registeredKind} root — a task folder and dedicated non-task storage can never share one path.`
    );
  }

  let progressPresent = false;
  try {
    fs.readFileSync(path.join(fsPath, TASK_PROGRESS_FILENAME), "utf8");
    progressPresent = true;
  } catch (readError) {
    const code = (readError as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      throw new Error(
        `Refused to register non-task storage root ${JSON.stringify(fsPath)}: ${TASK_PROGRESS_FILENAME} exists ` +
          `at that path but could not be read as a regular file (${code ?? "unknown error"}).`
      );
    }
  }
  if (progressPresent) {
    throw new Error(
      `Refused to register non-task storage root ${JSON.stringify(fsPath)}: it carries ${TASK_PROGRESS_FILENAME}, ` +
        `which makes it a task folder — register it through ensureWorkflowTaskFolderRootV1 so its mutation ` +
        `authority derives from its validated persisted ownership binding (plan §3.9).`
    );
  }
  if (!isContainedInRecognizedLocationV1(fsPath, undefined)) {
    throw new Error(
      `Refused to register non-task storage root ${JSON.stringify(fsPath)}: it is not contained within a ` +
        `configured task root or any currently open workspace folder.`
    );
  }

  if (registeredKind === undefined) {
    registry.registerRoot({ rootId, fsPath, kind: "nonTaskStorage", trustedForMutation: true });
    rebuildFileStore();
  }
  return rootId;
}

/**
 * True when this task-folder root's registration passed the strict,
 * ownership-backed verification in `ensureWorkflowTaskFolderRootV1` — which
 * is every successfully registered task-folder root by construction (the
 * strict contract refuses anything weaker). False for unregistered root ids,
 * for `nonTaskStorage` roots (which never claim task verification), and for
 * a root whose latest re-verification attempt FAILED (the failure clears the
 * recorded state even though an earlier call succeeded).
 */
export function isWorkflowTaskFolderRootVerifiedV1(rootId: string): boolean {
  return verifiedTaskFolderRootIds.has(rootId);
}

/**
 * The ownership-derived `TaskBindingV1.bindingId` for a verified task-folder
 * root (see `ensureWorkflowTaskFolderRootV1`). Always defined for a
 * successfully verified task-folder root — the strict contract refuses
 * ownership-free progress — and `undefined` for unregistered, non-task, or
 * failed-reverification root ids. Callers that want a real, ownership-backed
 * task identity instead of a path/canonicalId digest stand-in should prefer
 * this over synthesizing their own.
 */
export function getVerifiedTaskBindingIdV1(rootId: string): string | undefined {
  return verifiedTaskFolderBindingIds.get(rootId);
}

/**
 * Validate and register a META ROOT (plan §4.2: `<meta-root>/creation-intents-v1/`)
 * as a trusted mutation root, once and idempotently, returning its stable
 * root id. Meta roots have no `task-progress.json` of their own to derive
 * ownership from — trust is shape (§1.8 root rules) plus an EXACT match
 * against a currently resolvable task-root candidate
 * (`resolveTaskRootCandidates()`, the same configured/legacy-discovery list
 * `startNewTask.ts`'s own `resolveTaskRootForCreation` resolves against): an
 * arbitrary absolute path can never be registered as a meta root merely
 * because a caller claims it is one.
 *
 * Revalidated on EVERY call (the candidate-membership check re-runs), not
 * only the first — matching the other `ensure*` functions in this module.
 */
export function ensureWorkflowMetaRootV1(fsPath: string): string {
  const classification = classifyWorkflowRootV1(fsPath);
  if (!classification.ok) {
    throw new Error(`Unsupported meta root: ${classification.reason}`);
  }
  const rootId = rootIdFor("meta", fsPath);
  const registeredKind = registry.rootKind(rootId);
  if (registeredKind !== undefined && registeredKind !== "metaRoot") {
    throw new Error(
      `Refused to register meta root ${JSON.stringify(fsPath)}: this path is already registered as a ` +
        `${registeredKind} root.`
    );
  }
  const resolvedFsPath = path.resolve(fsPath);
  const isKnownCandidate = resolveTaskRootCandidates().some(
    (candidate) => normalizeForCompareV1(path.resolve(candidate.absolutePath)) === normalizeForCompareV1(resolvedFsPath)
  );
  if (!isKnownCandidate) {
    throw new Error(
      `Refused to register meta root ${JSON.stringify(fsPath)}: it does not match a currently resolvable ` +
        `configured or legacy task-root candidate.`
    );
  }
  if (registeredKind === undefined) {
    registry.registerRoot({ rootId, fsPath, kind: "metaRoot", trustedForMutation: true });
    rebuildFileStore();
  }
  return rootId;
}

/**
 * Register one open workspace folder as a §7 preflight/edit root (plan
 * §7.5's workspace-root gate). Shape rules via `classifyWorkflowRootV1`;
 * mutation trust is LIVE `vscode.workspace.isTrusted` — an untrusted (or
 * later-untrusted) workspace can still be read by preflight but never
 * mutated by the edit broker. Idempotent per path. Throws with the §7.5
 * failure kind in the message when the folder cannot be registered:
 * callers map that to `workspaceRootUnsupported`/`workspacePathUnsafe`.
 */
export function ensureWorkflowWorkspaceRootV1(fsPath: string): string {
  const classification = classifyWorkflowRootV1(fsPath);
  if (!classification.ok) {
    throw new Error(`workspacePathUnsafe: ${classification.reason}`);
  }
  const isOpenWorkspaceFolder = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => normalizeForCompareV1(path.resolve(folder.uri.fsPath)) === normalizeForCompareV1(path.resolve(fsPath))
  );
  if (!isOpenWorkspaceFolder) {
    throw new Error("workspaceRootUnsupported: the path is not a currently open workspace folder");
  }
  const rootId = rootIdFor("workspace", fsPath);
  const registeredKind = registry.rootKind(rootId);
  if (registeredKind !== undefined && registeredKind !== "workspaceFolder") {
    throw new Error(
      `workspaceRootUnsupported: this path is already registered as a ${registeredKind} root`
    );
  }
  if (registeredKind === undefined) {
    registry.registerRoot({
      rootId,
      fsPath,
      kind: "workspaceFolder",
      trustedForMutation: true,
      // Live: Workspace Trust can be revoked while a sealed plan is waiting
      // to execute — the file store consults this before every mutation.
      isCurrentlyTrustedForMutation: () => vscode.workspace.isTrusted !== false,
    });
    rebuildFileStore();
  }
  return rootId;
}

/**
 * The §7.3 `rootBindingId`: a digest binding a preflight plan to the exact
 * root registration (id + absolute path) its observations were made under.
 */
export function computeWorkspaceRootBindingIdV1(rootId: string, fsPath: string): string {
  return createHash("sha256")
    .update(`ensemble-workspace-root-binding-v1\n${JSON.stringify({ fsPath, rootId })}`, "utf8")
    .digest("hex");
}

/**
 * Resolve a registry-allocated locator to an absolute filesystem path.
 *
 * For consumers that need an allocated path as a raw fsPath/URI (directory
 * staging via `vscode.workspace.fs`, for example) rather than through the
 * file store's own operations. Throws on an unregistered root or a locator
 * that fails path-safety resolution — both are programmer errors for a
 * registry-vended `WorkflowAllocatedPathV1`, never runtime conditions
 * (plan §2.1: the registry is the sole allocator; a locator it produced
 * must resolve under the root it named).
 */
export function resolveWorkflowAllocatedFsPathV1(allocated: WorkflowAllocatedPathV1): string {
  const root = registry
    .registeredRoots()
    .find((candidate) => candidate.rootId === allocated.locator.rootId);
  if (!root) {
    throw new Error(
      `Cannot resolve allocated workflow path ${JSON.stringify(allocated.locator.relativePath)}: ` +
        `root ${JSON.stringify(allocated.locator.rootId)} is not registered.`
    );
  }
  const resolution = resolveWorkflowFsPathV1(root, allocated.locator.relativePath);
  if (!resolution.ok) {
    throw new Error(
      `Cannot resolve allocated workflow path ${JSON.stringify(allocated.locator.relativePath)} ` +
        `under root ${JSON.stringify(allocated.locator.rootId)}: ${resolution.reason}.`
    );
  }
  return resolution.fsPath;
}

/**
 * Configure the one private-storage root (plan §2.1: `<context.storageUri>`
 * holds `workflow-runtime-v1`). Idempotent for the same path; switching to a
 * different path re-registers and re-derives (activation calls this exactly
 * once; tests may reconfigure). Returns the private root id.
 */
export function configureWorkflowPrivateStorageRootV1(fsPath: string): string {
  const classification = classifyWorkflowRootV1(fsPath);
  if (!classification.ok) {
    throw new Error(`Unsupported workflow private-storage root: ${classification.reason}`);
  }
  const rootId = rootIdFor("private", fsPath);
  if (registry.rootKind(rootId) === undefined) {
    registry.registerRoot({ rootId, fsPath, kind: "privateStorage", trustedForMutation: true });
    rebuildFileStore();
  }
  privateRootId = rootId;
  return rootId;
}

/** The configured private-storage root id, or undefined before activation wiring. */
export function getWorkflowPrivateStorageRootIdV1(): string | undefined {
  return privateRootId;
}

/** Activation wiring: the durable Chat interaction transaction store (plan §5.5). */
export function setChatInteractionTransactionStoreV1(store: ChatInteractionTransactionStoreV1): void {
  transactionStore = store;
}

/** The activation-wired transaction store, or undefined when not wired (tests, pre-activation). */
export function getChatInteractionTransactionStoreV1(): ChatInteractionTransactionStoreV1 | undefined {
  return transactionStore;
}

/** The one shared runtime task-operation lease store (see the field's own doc comment above). */
export function getWorkflowLeaseStoreV1(): WorkflowLeaseStoreV1 {
  return leaseStore;
}

/**
 * The one shared edit plan broker (plan §7.4/§7.6). Requires the private-
 * storage root (sealed plans/receipts persist under
 * `workflow-runtime-v1/edit-runs/`) — activation configures it before any
 * edit action can run, so an unconfigured call is a programmer error.
 */
export function getEditPlanBrokerV1(): EditPlanBrokerV1 {
  const boundPrivateRootId = privateRootId;
  if (boundPrivateRootId === undefined) {
    throw new Error(
      "The workflow private-storage root is not configured — edit plans cannot be sealed (configureWorkflowPrivateStorageRootV1 runs at activation)."
    );
  }
  if (!editPlanBroker) {
    editPlanBroker = createEditPlanBrokerV1({
      getFileStore: () => fileStore,
      privateRootId: boundPrivateRootId,
    });
  }
  return editPlanBroker;
}

/**
 * The one shared provider-result spool store (plan §3.2): large sealed
 * responses above the execution broker's spool threshold, and (2026-08-06)
 * the best-effort recovery copy of a response rejected as `malformedResult`
 * — see `taskActionCoordinatorV1.ts`'s `preserveRejectedResultForRecoveryV1`
 * — read back by the "Recover Last AI Response" command.
 *
 * Unlike `getEditPlanBrokerV1` above, an unconfigured private-storage root
 * returns `undefined` here rather than throwing: every consumer of this
 * store already treats it as optional (the broker seals to memory instead of
 * spooling; the recovery write is best-effort and silent on failure), so
 * there is no caller for whom a missing root is a programmer error worth
 * crashing over.
 */
export function getProviderResultSpoolStoreV1(): BoundedResultStoreV1 | undefined {
  if (providerResultSpoolStore) {
    return providerResultSpoolStore;
  }
  const rootDir = getProviderResultSpoolStoreRootDirV1();
  if (rootDir === undefined) {
    return undefined;
  }
  providerResultSpoolStore = createBoundedResultStoreV1({ rootDir });
  return providerResultSpoolStore;
}

/**
 * Absolute fs path to the provider-results family directory the store above
 * uses — for a recovery command's own READ-ONLY enumeration of what a
 * rejected result left behind. Writes always go through the store's own
 * `writeSpool` API, never direct fs access against this path; this exists so
 * a caller that only needs to list/read existing spools (find the most
 * recent one, walk its tree) does not have to duplicate the registry/root-id
 * resolution `getProviderResultSpoolStoreV1` already does.
 */
export function getProviderResultSpoolStoreRootDirV1(): string | undefined {
  if (privateRootId === undefined) {
    return undefined;
  }
  return resolveWorkflowAllocatedFsPathV1(registry.providerResultsFamilyDir(privateRootId));
}

/** Test isolation: restore the pristine, unconfigured state. Production never calls this. */
export function resetWorkflowRuntimeServicesForTestV1(): void {
  registry = createWorkflowPathRegistryV1();
  fileStore = createWorkflowFileStoreV1(registry.registeredRoots());
  privateRootId = undefined;
  transactionStore = undefined;
  editPlanBroker = undefined;
  providerResultSpoolStore = undefined;
  leaseStore = createWorkflowLeaseStoreV1();
  verifiedTaskFolderRootIds = new Set<string>();
  verifiedTaskFolderBindingIds = new Map<string, string>();
}

/** Re-export so consumers never need a second import of the safety layer's root type. */
export type { WorkflowRootV1 };
