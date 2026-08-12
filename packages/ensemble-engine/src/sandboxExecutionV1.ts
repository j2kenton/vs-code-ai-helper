/**
 * Sandbox execution integration (plan Part 4d).
 *
 * Generated code executes EXCLUSIVELY through the sandbox provider APIs
 * (`SandboxClientV1`) against the task's SandboxBinding:
 *
 * - **Source acquisition per the binding's mode** — `gitClone` clones the
 *   repo + checks out the ref inside the sandbox; `attachExisting` verifies
 *   the user-managed path exists and contains the binding root. Both are
 *   expressed as Part 4c `EngineExternalEffectV1`s, so they run under the
 *   execution-attempt protocol (attempt record persisted BEFORE the command,
 *   deterministic key threaded as the command marker, reconciliation against
 *   observable sandbox state — the clone probe checks for the created
 *   `.git` — and the indeterminate re-offer where nothing can be proven).
 * - **Path confinement under the Part 3 symlink rule** — every path is first
 *   confined lexically (`confinePathToBindingRootV1`), then resolved to its
 *   REAL target via the provider filesystem API, and the RESOLVED target is
 *   authorized against the RESOLVED binding root: followed-then-checked,
 *   never trusted as given, fail-closed when the provider cannot resolve.
 * - **Teardown per the cleanup policy** — only a `task-owned-ephemeral`
 *   binding with `destroy-on-completion` is ever destroyed; a user-managed
 *   persistent workspace is never destroyed regardless of policy.
 * - **The engine never executes untrusted output itself** — commands are
 *   argv vectors strictly quoted by `buildMarkedSandboxCommandV1` and sent
 *   over the provider API; nothing in this package evals, spawns, or shells
 *   out locally (scanned by tests/sandboxExecution.test.ts).
 */
import {
  confinePathToBindingRootV1,
  SandboxBindingErrorCodeV1,
  SandboxBindingV1,
} from "../../ensemble-contract/src/sandboxBindingV1";
import {
  EngineEffectOutcomeV1,
  EngineExternalEffectV1,
  EngineGateMachineryV1,
  EngineUngatedEffectResultV1,
} from "./gateMachineryV1";
import { SandboxClientV1 } from "./sandboxClientV1";
import { EngineFileChangeV1 } from "./unifiedDiffV1";

/** Binding + client: everything sandbox execution is allowed to touch. */
export interface SandboxExecutionContextV1 {
  readonly binding: SandboxBindingV1;
  readonly client: SandboxClientV1;
}

export type SandboxPathConfinementErrorCodeV1 = Extract<
  SandboxBindingErrorCodeV1,
  "pathOutsideBindingRoot" | "symlinkEscapesBindingRoot"
>;

export type ConfinedSandboxPathResultV1 =
  | { readonly ok: true; readonly realAbsolutePath: string }
  | {
      readonly ok: false;
      readonly code: SandboxPathConfinementErrorCodeV1;
      readonly reason: string;
    };

function isWithinRoot(realRoot: string, realPath: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot === "/" ? "/" : `${realRoot}/`);
}

function parentOf(absolutePath: string): string {
  const cut = absolutePath.lastIndexOf("/");
  return cut <= 0 ? "/" : absolutePath.slice(0, cut);
}

/**
 * The full Part 3 confinement rule for one binding-root-relative path:
 * lexical canonicalization/rejection first, then provider-API resolution of
 * BOTH the binding root and the requested path to their real targets, and
 * authorization of the resolved target against the resolved root.
 *
 * `allowMissingLeaf` supports writes of new files: the leaf may not exist
 * yet, but its PARENT directory must exist and resolve inside the root.
 * Everything else is fail-closed: a path the provider cannot resolve is
 * rejected, never trusted as given.
 */
export async function resolveConfinedSandboxPathV1(
  context: SandboxExecutionContextV1,
  relativePath: string,
  options?: { readonly allowMissingLeaf?: boolean }
): Promise<ConfinedSandboxPathResultV1> {
  const { binding, client } = context;
  const lexical = confinePathToBindingRootV1(binding.workingDirectoryRoot, relativePath);
  if (!lexical.ok) {
    return { ok: false, code: lexical.code, reason: lexical.reason };
  }
  const realRoot = await client.resolveRealPath(binding.sandboxId, binding.workingDirectoryRoot);
  if (realRoot === undefined) {
    return {
      ok: false,
      code: "pathOutsideBindingRoot",
      reason: "the binding root does not exist in the sandbox (fail-closed)",
    };
  }
  const real = await client.resolveRealPath(binding.sandboxId, lexical.absolutePath);
  if (real !== undefined) {
    if (!isWithinRoot(realRoot, real)) {
      return {
        ok: false,
        code: "symlinkEscapesBindingRoot",
        reason: "the path's resolved real target lies outside the binding root",
      };
    }
    return { ok: true, realAbsolutePath: real };
  }
  if (options?.allowMissingLeaf !== true) {
    return {
      ok: false,
      code: "pathOutsideBindingRoot",
      reason: "the path does not exist in the sandbox (fail-closed)",
    };
  }
  // Only the LEAF may be missing: the immediate parent must exist and its
  // resolved target must lie inside the root. Skipping deeper (a
  // nearest-existing-ancestor walk) would be unsound — a DANGLING escaping
  // symlink in between is indistinguishable from a missing directory through
  // `resolveRealPath`, and a provider write would follow it out of the root.
  // Callers creating nested files must materialize the directories first
  // (via a confined command), each level then provably resolving inside.
  const leaf = lexical.absolutePath.slice(lexical.absolutePath.lastIndexOf("/") + 1);
  const realParent = await client.resolveRealPath(
    binding.sandboxId,
    parentOf(lexical.absolutePath)
  );
  if (realParent === undefined) {
    return {
      ok: false,
      code: "pathOutsideBindingRoot",
      reason: "the new path's parent directory does not exist in the sandbox (fail-closed)",
    };
  }
  if (!isWithinRoot(realRoot, realParent)) {
    return {
      ok: false,
      code: "symlinkEscapesBindingRoot",
      reason: "the new path's parent resolves outside the binding root",
    };
  }
  return {
    ok: true,
    realAbsolutePath: realParent === "/" ? `/${leaf}` : `${realParent}/${leaf}`,
  };
}

/** One gated sandbox execution: approved file changes + a command to run. */
export interface SandboxCommandSpecV1 {
  /**
   * Structured argv (never a shell string). Empty = apply-changes-only —
   * a gate whose approval materializes the reviewed diff without running
   * anything.
   */
  readonly argv: readonly string[];
  /** Working directory relative to the binding root; default = the root. */
  readonly cwdRelative?: string;
  /** Reviewed file changes to apply inside the root before the command. */
  readonly applyChanges?: readonly EngineFileChangeV1[];
}

function confinementFailure(code: SandboxPathConfinementErrorCodeV1): EngineEffectOutcomeV1 {
  return { status: "failed", code };
}

async function applyChanges(
  context: SandboxExecutionContextV1,
  changes: readonly EngineFileChangeV1[]
): Promise<EngineEffectOutcomeV1 | undefined> {
  for (const change of changes) {
    const confined = await resolveConfinedSandboxPathV1(context, change.path, {
      allowMissingLeaf: true,
    });
    if (!confined.ok) {
      return confinementFailure(confined.code);
    }
    if (change.newText === null) {
      await context.client.deleteFile(context.binding.sandboxId, confined.realAbsolutePath);
    } else {
      await context.client.writeFile(
        context.binding.sandboxId,
        confined.realAbsolutePath,
        change.newText
      );
    }
  }
  return undefined;
}

/**
 * Build the Part 4c external effect for one gated sandbox execution. Plugs
 * directly into `EngineGateMachineryV1.resumeApproved`: the attempt record
 * persists before anything reaches the sandbox, the deterministic key rides
 * every command as its marker, and reconciliation reads the provider's
 * command/audit state for that marker. Sandbox platforms offer no native
 * idempotency keys, so `supportsIdempotentReplay` is `false` — recovery goes
 * through reconcile-or-re-offer, never blind replay.
 */
export function createSandboxCommandEffectV1(
  context: SandboxExecutionContextV1,
  spec: SandboxCommandSpecV1
): EngineExternalEffectV1 {
  const { binding, client } = context;
  return {
    effectKind: "sandboxCommand",
    supportsIdempotentReplay: false,

    async execute(attemptKey: string): Promise<EngineEffectOutcomeV1> {
      const cwd =
        spec.cwdRelative === undefined
          ? await resolveRootItself(context)
          : await resolveConfinedSandboxPathV1(context, spec.cwdRelative);
      if (!cwd.ok) {
        // Refused before anything reached the sandbox — a failed outcome,
        // not an exception: the refusal is deterministic and final.
        return confinementFailure(cwd.code);
      }
      if (spec.applyChanges !== undefined) {
        const refused = await applyChanges(context, spec.applyChanges);
        if (refused !== undefined) {
          return refused;
        }
      }
      if (spec.argv.length === 0) {
        return { status: "succeeded", code: "appliedChangesOnly" };
      }
      const result = await client.runCommand({
        sandboxId: binding.sandboxId,
        argv: spec.argv,
        cwd: cwd.realAbsolutePath,
        attemptKey,
      });
      return result.exitCode === 0
        ? { status: "succeeded", code: "exit0" }
        : { status: "failed", code: `exit${result.exitCode}` };
    },

    reconcile(attemptKey: string) {
      return client.findCommandByAttemptKey(binding.sandboxId, attemptKey);
    },
  };
}

async function resolveRootItself(
  context: SandboxExecutionContextV1
): Promise<ConfinedSandboxPathResultV1> {
  const realRoot = await context.client.resolveRealPath(
    context.binding.sandboxId,
    context.binding.workingDirectoryRoot
  );
  if (realRoot === undefined) {
    return {
      ok: false,
      code: "pathOutsideBindingRoot",
      reason: "the binding root does not exist in the sandbox (fail-closed)",
    };
  }
  return { ok: true, realAbsolutePath: realRoot };
}

/**
 * Build the COMPOSITE source-acquisition effect for the binding's mode
 * (plan Part 4d).
 *
 * - `gitClone`: `git clone <url> <root>` then `git -C <root> checkout
 *   --detach <ref>` inside the sandbox — both commands marked with the same
 *   attempt key. Reconciliation asks the provider's command audit first and
 *   falls back to observable state: a resolvable `<root>/.git` proves the
 *   clone ran; a missing root proves it did not.
 * - `attachExisting`: side-effect-free verification that the user-managed
 *   path exists and contains the binding root (both provider-resolved), so
 *   it declares `supportsIdempotentReplay: true` — re-running a verification
 *   is always a safe replay.
 *
 * KNOWN RECONCILE-STRENGTH WRINKLE of the composite gitClone shape: both
 * commands ride one attempt record, so a positive reconcile (marker match or
 * `.git` probe) proves the CLONE ran but not that the CHECKOUT completed — a
 * crash landing between the two commands, followed by recovery, adopts the
 * attempt with the sandbox possibly still on the default branch. Never a
 * duplicate execution, but possibly the wrong ref. The Part 5 composition
 * therefore uses `acquireSourcePerBindingV1` below, which splits clone and
 * checkout into SEPARATE attempt lineages so each is independently
 * reconciled; prefer that path for new callers.
 */
export function createSourceAcquisitionEffectV1(
  context: SandboxExecutionContextV1
): EngineExternalEffectV1 {
  const { binding, client } = context;
  const source = binding.source;

  if (source.kind === "attachExisting") {
    return {
      effectKind: "sandboxCommand",
      supportsIdempotentReplay: true,
      async execute(): Promise<EngineEffectOutcomeV1> {
        const realAttach = await client.resolveRealPath(binding.sandboxId, source.path);
        if (realAttach === undefined) {
          return { status: "failed", code: "attachTargetMissing" };
        }
        const realRoot = await client.resolveRealPath(
          binding.sandboxId,
          binding.workingDirectoryRoot
        );
        if (realRoot === undefined || !isWithinRoot(realAttach, realRoot)) {
          return { status: "failed", code: "rootOutsideAttachedPath" };
        }
        return { status: "succeeded", code: "attachedExisting" };
      },
    };
  }

  return {
    effectKind: "sandboxCommand",
    supportsIdempotentReplay: false,
    async execute(attemptKey: string): Promise<EngineEffectOutcomeV1> {
      const clone = await client.runCommand({
        sandboxId: binding.sandboxId,
        argv: ["git", "clone", "--", source.repoUrl, binding.workingDirectoryRoot],
        cwd: "/",
        attemptKey,
      });
      if (clone.exitCode !== 0) {
        return { status: "failed", code: `gitCloneExit${clone.exitCode}` };
      }
      const checkout = await client.runCommand({
        sandboxId: binding.sandboxId,
        argv: [
          "git",
          "-C",
          binding.workingDirectoryRoot,
          "checkout",
          "--detach",
          source.ref,
        ],
        cwd: "/",
        attemptKey,
      });
      if (checkout.exitCode !== 0) {
        return { status: "failed", code: `gitCheckoutExit${checkout.exitCode}` };
      }
      return { status: "succeeded", code: "sourceAcquired" };
    },
    async reconcile(attemptKey: string) {
      const byMarker = await client.findCommandByAttemptKey(binding.sandboxId, attemptKey);
      if (byMarker !== "unknown") {
        return byMarker;
      }
      // Observable-state probe: the clone's own artifact.
      const gitDir = await client.resolveRealPath(
        binding.sandboxId,
        binding.workingDirectoryRoot === "/"
          ? "/.git"
          : `${binding.workingDirectoryRoot}/.git`
      );
      if (gitDir !== undefined) {
        return "executed";
      }
      const root = await client.resolveRealPath(binding.sandboxId, binding.workingDirectoryRoot);
      return root === undefined ? "notExecuted" : "unknown";
    },
  };
}

/** Stable step ids for the split-lineage source-acquisition path (Part 5). */
export const SOURCE_ACQUISITION_CLONE_STEP_ID_V1 = "source-acquisition/clone";
export const SOURCE_ACQUISITION_CHECKOUT_STEP_ID_V1 = "source-acquisition/checkout";
export const SOURCE_ACQUISITION_ATTACH_STEP_ID_V1 = "source-acquisition/attach";

const GIT_COMMIT_SHA_V1 = /^[0-9a-f]{40}$/;

/**
 * The CLONE half of gitClone source acquisition as its own effect, for the
 * split-lineage path. Reconciliation is sound for the clone alone: a marker
 * match or a resolvable `<root>/.git` proves this step ran; a missing root
 * proves it did not.
 */
export function createGitCloneEffectV1(context: SandboxExecutionContextV1): EngineExternalEffectV1 {
  const { binding, client } = context;
  const source = binding.source;
  if (source.kind !== "gitClone") {
    throw new Error("createGitCloneEffectV1 requires a gitClone source binding");
  }
  return {
    effectKind: "sandboxCommand",
    supportsIdempotentReplay: false,
    async execute(attemptKey: string): Promise<EngineEffectOutcomeV1> {
      const clone = await client.runCommand({
        sandboxId: binding.sandboxId,
        argv: ["git", "clone", "--", source.repoUrl, binding.workingDirectoryRoot],
        cwd: "/",
        attemptKey,
      });
      return clone.exitCode === 0
        ? { status: "succeeded", code: "cloned" }
        : { status: "failed", code: `gitCloneExit${clone.exitCode}` };
    },
    async reconcile(attemptKey: string) {
      const byMarker = await client.findCommandByAttemptKey(binding.sandboxId, attemptKey);
      if (byMarker !== "unknown") {
        return byMarker;
      }
      const gitDir = await client.resolveRealPath(
        binding.sandboxId,
        binding.workingDirectoryRoot === "/"
          ? "/.git"
          : `${binding.workingDirectoryRoot}/.git`
      );
      if (gitDir !== undefined) {
        return "executed";
      }
      const root = await client.resolveRealPath(binding.sandboxId, binding.workingDirectoryRoot);
      return root === undefined ? "notExecuted" : "unknown";
    },
  };
}

/**
 * The CHECKOUT half of gitClone source acquisition as its own effect, for
 * the split-lineage path. With its own attempt key, the marker ledger is a
 * sound per-step verdict; the observable-state fallback reads `.git/HEAD`
 * and compares it against the pinned ref when the ref is a full commit sha
 * (a detached checkout writes exactly that sha into HEAD). A branch/tag ref
 * that the marker cannot prove stays `unknown` — the indeterminate re-offer,
 * never a silently adopted wrong ref.
 */
export function createGitCheckoutEffectV1(
  context: SandboxExecutionContextV1
): EngineExternalEffectV1 {
  const { binding, client } = context;
  const source = binding.source;
  if (source.kind !== "gitClone") {
    throw new Error("createGitCheckoutEffectV1 requires a gitClone source binding");
  }
  const headPath =
    binding.workingDirectoryRoot === "/"
      ? "/.git/HEAD"
      : `${binding.workingDirectoryRoot}/.git/HEAD`;
  return {
    effectKind: "sandboxCommand",
    supportsIdempotentReplay: false,
    async execute(attemptKey: string): Promise<EngineEffectOutcomeV1> {
      const checkout = await client.runCommand({
        sandboxId: binding.sandboxId,
        argv: ["git", "-C", binding.workingDirectoryRoot, "checkout", "--detach", source.ref],
        cwd: "/",
        attemptKey,
      });
      return checkout.exitCode === 0
        ? { status: "succeeded", code: "checkedOut" }
        : { status: "failed", code: `gitCheckoutExit${checkout.exitCode}` };
    },
    async reconcile(attemptKey: string) {
      const byMarker = await client.findCommandByAttemptKey(binding.sandboxId, attemptKey);
      if (byMarker !== "unknown") {
        return byMarker;
      }
      if (GIT_COMMIT_SHA_V1.test(source.ref)) {
        const head = await client.readFileUtf8(binding.sandboxId, headPath);
        if (head !== undefined) {
          return head.trim() === source.ref ? "executed" : "notExecuted";
        }
      }
      return "unknown";
    },
  };
}

/** Combined outcome of the split-lineage source-acquisition run. */
export interface AcquireSourceResultV1 {
  /** Per-step results in execution order (attach, or clone then checkout). */
  readonly steps: readonly EngineUngatedEffectResultV1[];
  /** True when every step ended executed/recovered/alreadyExecuted with success. */
  readonly acquired: boolean;
}

function stepSucceeded(result: EngineUngatedEffectResultV1): boolean {
  if (result.kind === "executed" || result.kind === "recovered") {
    return result.outcome.status === "succeeded";
  }
  return result.kind === "alreadyExecuted" && result.attemptState === "succeeded";
}

/**
 * Acquire the task's source per the binding's mode under the crash-safe
 * attempt protocol, with clone and checkout as SEPARATE attempt lineages so
 * each is independently reconciled (the split-lineage fix for the composite
 * effect's reconcile-strength wrinkle). Each step runs via
 * `runUngatedEffect` with a stable step id; a step that fails, goes
 * indeterminate, or loses the lease stops the sequence.
 */
export async function acquireSourcePerBindingV1(
  machinery: EngineGateMachineryV1,
  context: SandboxExecutionContextV1
): Promise<AcquireSourceResultV1> {
  if (context.binding.source.kind === "attachExisting") {
    const attach = await machinery.runUngatedEffect(
      SOURCE_ACQUISITION_ATTACH_STEP_ID_V1,
      createSourceAcquisitionEffectV1(context)
    );
    return { steps: [attach], acquired: stepSucceeded(attach) };
  }
  const clone = await machinery.runUngatedEffect(
    SOURCE_ACQUISITION_CLONE_STEP_ID_V1,
    createGitCloneEffectV1(context)
  );
  if (!stepSucceeded(clone)) {
    return { steps: [clone], acquired: false };
  }
  const checkout = await machinery.runUngatedEffect(
    SOURCE_ACQUISITION_CHECKOUT_STEP_ID_V1,
    createGitCheckoutEffectV1(context)
  );
  return { steps: [clone, checkout], acquired: stepSucceeded(checkout) };
}

export type SandboxTeardownResultV1 =
  | { readonly destroyed: true }
  | { readonly destroyed: false; readonly reason: string };

/**
 * Tear the sandbox down per the binding's cleanup policy: only a task-owned
 * ephemeral sandbox with `destroy-on-completion` is ever destroyed. A
 * user-managed persistent workspace is NEVER destroyed here, whatever the
 * policy field says — that guard is deliberate defense in depth on top of
 * the contract-level validation that already forbids the combination.
 */
export async function teardownSandboxPerPolicyV1(
  context: SandboxExecutionContextV1
): Promise<SandboxTeardownResultV1> {
  const { binding, client } = context;
  if (binding.lifecycle !== "task-owned-ephemeral") {
    return {
      destroyed: false,
      reason: "user-managed persistent workspaces are never destroyed by the engine",
    };
  }
  if (binding.cleanup !== "destroy-on-completion") {
    return { destroyed: false, reason: "the binding's cleanup policy retains the sandbox" };
  }
  await client.destroySandbox(binding.sandboxId);
  return { destroyed: true };
}
