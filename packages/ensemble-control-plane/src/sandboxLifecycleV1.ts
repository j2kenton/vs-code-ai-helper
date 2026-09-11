/**
 * Sandbox lifecycle composition (plan Part 5): E2B/Daytona client
 * integration for create/attach per SandboxBinding and cleanup per its
 * policy, composed over the engine's Part 4d execution surface.
 *
 * The factory hands out `SandboxClientV1` instances per (provider, api key).
 * Two factories are exported behind the SAME interface:
 * `createFetchSandboxClientFactoryV1` (the engine's fetch-based reference
 * transports — dependency-free, used by this package's own tests) and
 * `createSdkSandboxClientFactoryV1` (the real `e2b`/`@daytona/sdk` vendor
 * SDKs, `sandboxSdkAdaptersV1.ts` — the deployment default). Swapping between
 * them touches nothing upstream; the recorded Part 5 item to validate the
 * SDK-backed clients against the LIVE provider SDKs (not just their locally
 * installed type surface) remains open here and only here.
 *
 * Source acquisition uses the engine's SPLIT-LINEAGE path
 * (`acquireSourcePerBindingV1`): clone and checkout are separate attempt
 * lineages, each independently reconciled — the fix for the composite
 * effect's reconcile-strength wrinkle.
 *
 * Teardown routes the destroy THROUGH `runUngatedEffect` so it is
 * attempt-recorded like source acquisition (composition hygiene): the
 * policy gate (only task-owned-ephemeral + destroy-on-completion; a
 * user-managed workspace is NEVER destroyed) is checked BEFORE any attempt
 * record is written, and the destroy declares `supportsIdempotentReplay`
 * because destroying an already-destroyed sandbox is provider-side
 * idempotent.
 */
import type { SandboxBindingV1, SandboxProviderV1 } from "../../ensemble-contract/src/sandboxBindingV1";
import type { FetchLikeV1 } from "../../ensemble-engine/src/providerAdaptersV1";
import type { SandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import {
  createDaytonaSandboxClientV1,
  createE2bSandboxClientV1,
} from "../../ensemble-engine/src/sandboxProviderAdaptersV1";
import { createLocalDockerSandboxClientV1 } from "./localDockerSandboxClientV1";
import {
  createDaytonaSdkSandboxClientV1,
  createE2bSdkSandboxClientV1,
} from "./sandboxSdkAdaptersV1";
import type {
  EngineGateMachineryV1,
  EngineUngatedEffectResultV1,
} from "../../ensemble-engine/src/gateMachineryV1";
import {
  AcquireSourceResultV1,
  acquireSourcePerBindingV1,
  SandboxExecutionContextV1,
} from "../../ensemble-engine/src/sandboxExecutionV1";
import type { ControlPlaneUserSandboxRecordV1 } from "./storeV1";

/** Hands out provider clients; keys arrive already decrypted (custody). */
export interface SandboxClientFactoryV1 {
  clientFor(provider: SandboxProviderV1, apiKey: string): SandboxClientV1;
}

/**
 * Fetch-based reference-transport factory (dependency-free; used by this
 * package's tests). `docker` has no fetch-based reference transport — it
 * routes to the same local-daemon client the SDK factory uses, since there's
 * only one way to talk to a local Docker daemon, not a "reference vs. SDK"
 * choice the way E2B/Daytona have a plain-HTTP vs. vendor-SDK distinction.
 */
export function createFetchSandboxClientFactoryV1(fetchImpl: FetchLikeV1): SandboxClientFactoryV1 {
  return {
    clientFor(provider: SandboxProviderV1, apiKey: string): SandboxClientV1 {
      if (provider === "e2b") {
        return createE2bSandboxClientV1({ fetch: fetchImpl, apiKey });
      }
      if (provider === "daytona") {
        return createDaytonaSandboxClientV1({ fetch: fetchImpl, apiKey });
      }
      return createLocalDockerSandboxClientV1({ apiKey });
    },
  };
}

export interface CreateSdkSandboxClientFactoryOptionsV1 {
  /**
   * Image for `docker` sandboxes. The deployment should point this at the
   * provisioned image (`docker/sandbox.Dockerfile`: Claude Code CLI baked
   * in) — the client's own default is a bare `node` image in which no
   * `claude-cli` round can run.
   */
  readonly dockerImage?: string;
  /** See `CreateLocalDockerSandboxClientOptionsV1.legacyUnlabelledSandboxIds`. */
  readonly dockerLegacySandboxIds?: readonly string[];
}

/**
 * SDK-backed factory over the real `e2b` / `@daytona/sdk` vendor SDKs plus
 * the local Docker daemon — the deployment default (plan Part 5's E2B/Daytona
 * SDK integration item, plus the self-hosted `docker` provider).
 */
export function createSdkSandboxClientFactoryV1(
  options?: CreateSdkSandboxClientFactoryOptionsV1
): SandboxClientFactoryV1 {
  return {
    clientFor(provider: SandboxProviderV1, apiKey: string): SandboxClientV1 {
      if (provider === "e2b") {
        return createE2bSdkSandboxClientV1({ apiKey });
      }
      if (provider === "daytona") {
        return createDaytonaSdkSandboxClientV1({ apiKey });
      }
      return createLocalDockerSandboxClientV1({
        apiKey,
        ...(options?.dockerImage !== undefined ? { image: options.dockerImage } : {}),
        ...(options?.dockerLegacySandboxIds !== undefined
          ? { legacyUnlabelledSandboxIds: options.dockerLegacySandboxIds }
          : {}),
      });
    },
  };
}

export type ServerBindingValidationResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "sandboxUnreachable";
      readonly reason: string;
    };

/**
 * The server-side half of binding validation (the shape half is the
 * contract's `validateSandboxBindingRequestV1`; the key-presence half is the
 * server handler's store lookup): is the bound sandbox actually reachable
 * through the provider API? Fail-closed — an unreachable or erroring
 * provider reads as `sandboxUnreachable`.
 */
export async function validateBindingReachabilityV1(
  client: SandboxClientV1,
  binding: SandboxBindingV1
): Promise<ServerBindingValidationResultV1> {
  try {
    const root = await client.resolveRealPath(binding.sandboxId, "/");
    if (root === undefined) {
      return {
        ok: false,
        code: "sandboxUnreachable",
        reason: "the sandbox did not resolve its filesystem root",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: "sandboxUnreachable",
      reason: "the sandbox provider API did not respond",
    };
  }
}

export interface UserSandboxStoreV1 {
  readUserSandbox(
    ownerUserId: string,
    provider: SandboxProviderV1
  ): ControlPlaneUserSandboxRecordV1 | undefined;
  writeUserSandbox(record: ControlPlaneUserSandboxRecordV1): void;
}

/**
 * In-flight provisioning per (user, provider). Without it two concurrent
 * first-use requests both saw "no record", both created a sandbox, and the
 * later write won — the other sandbox kept running with no record pointing
 * at it, unreachable by reset or teardown (review finding, 2026-09-11).
 * In-process is sufficient because one control-plane process owns its
 * store; a multi-worker deployment would need this as a durable
 * reservation instead.
 */
const provisioningV1 = new Map<string, Promise<ControlPlaneUserSandboxRecordV1>>();

/**
 * Resolve the caller's `user-owned-managed` sandbox for (user, provider) —
 * create it ONCE, on first use, and reuse the same one for every later call.
 * The record's `workingDirectoryRoot` is informational (the root it was
 * first created for). Each TASK confines to its own binding root inside the
 * shared sandbox — that is what lets one persistent sandbox hold several
 * projects side by side (/workspace/a, /workspace/b); callers use only the
 * returned `sandboxId`.
 */
export async function ensureUserSandboxV1(
  store: UserSandboxStoreV1,
  client: SandboxClientV1,
  ownerUserId: string,
  provider: SandboxProviderV1,
  workingDirectoryRoot: string,
  now: () => Date = () => new Date()
): Promise<ControlPlaneUserSandboxRecordV1> {
  const existing = store.readUserSandbox(ownerUserId, provider);
  if (existing !== undefined) {
    const touched: ControlPlaneUserSandboxRecordV1 = { ...existing, lastUsedAt: now().toISOString() };
    store.writeUserSandbox(touched);
    return touched;
  }
  const key = JSON.stringify([ownerUserId, provider]);
  const inFlight = provisioningV1.get(key);
  if (inFlight !== undefined) {
    return inFlight;
  }
  const provisioning = (async (): Promise<ControlPlaneUserSandboxRecordV1> => {
    const created = await client.createSandbox();
    const at = now().toISOString();
    const record: ControlPlaneUserSandboxRecordV1 = {
      ownerUserId,
      provider,
      sandboxId: created.sandboxId,
      workingDirectoryRoot,
      createdAt: at,
      lastUsedAt: at,
    };
    try {
      store.writeUserSandbox(record);
    } catch (error) {
      // Not recorded means unreachable forever: give the sandbox back now,
      // retrying a transient provider failure. If every attempt fails, the
      // id goes into the thrown error's message — the only place it still
      // exists — rather than being dropped silently (second-round review).
      let destroyed = false;
      for (let attempt = 0; attempt < 3 && !destroyed; attempt += 1) {
        try {
          await client.destroySandbox(created.sandboxId);
          destroyed = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (!destroyed) {
        throw new Error(
          `the ${provider} sandbox ${created.sandboxId} was created but could neither be recorded nor destroyed; ` +
            "remove it at the provider manually"
        );
      }
      throw error;
    }
    return record;
  })();
  provisioningV1.set(key, provisioning);
  try {
    return await provisioning;
  } finally {
    provisioningV1.delete(key);
  }
}

/** Stable step id for the attempt-recorded teardown effect. */
export const SANDBOX_TEARDOWN_STEP_ID_V1 = "sandbox-teardown";

export type SandboxTeardownRunResultV1 =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "ran"; readonly result: EngineUngatedEffectResultV1 };

/**
 * Acquire the task's source per its binding mode under the crash-safe
 * attempt protocol (split clone/checkout lineages).
 */
export function acquireTaskSourceV1(
  machinery: EngineGateMachineryV1,
  context: SandboxExecutionContextV1
): Promise<AcquireSourceResultV1> {
  return acquireSourcePerBindingV1(machinery, context);
}

/**
 * Tear the task's sandbox down per its cleanup policy, with the destroy
 * running as an attempt-recorded ungated effect. Policy guards mirror the
 * engine's `teardownSandboxPerPolicyV1` (defense in depth on top of the
 * contract validation): a user-managed persistent workspace is NEVER
 * destroyed, and a retain policy skips before any attempt record exists.
 */
export async function teardownTaskSandboxV1(
  machinery: EngineGateMachineryV1,
  context: SandboxExecutionContextV1
): Promise<SandboxTeardownRunResultV1> {
  const { binding, client } = context;
  if (binding.lifecycle !== "task-owned-ephemeral") {
    return {
      kind: "skipped",
      reason: "user-managed persistent workspaces are never destroyed by the control plane",
    };
  }
  if (binding.cleanup !== "destroy-on-completion") {
    return { kind: "skipped", reason: "the binding's cleanup policy retains the sandbox" };
  }
  const result = await machinery.runUngatedEffect(SANDBOX_TEARDOWN_STEP_ID_V1, {
    effectKind: "sandboxCommand",
    // Destroying an already-destroyed sandbox is idempotent at the provider,
    // so post-crash re-issue with the same key is a safe replay.
    supportsIdempotentReplay: true,
    async execute() {
      await client.destroySandbox(binding.sandboxId);
      return { status: "succeeded" as const, code: "sandboxDestroyed" };
    },
  });
  return { kind: "ran", result };
}
