/**
 * The composition root: the one place the control plane is assembled from its
 * parts and actually listens on a port.
 *
 * Everything else in this package is a factory that takes its collaborators as
 * arguments — deliberately, since that is what makes the store, the session
 * service, the hub and the sandbox layer independently testable. The cost of
 * that design is that nothing in the package ever COMPOSES them outside the
 * test files, so until this module existed the server could be exercised by a
 * test and could not be started by a person. This closes that gap and nothing
 * more: no new behaviour, no new endpoints.
 *
 * Configuration comes from the environment, because the values are secrets
 * (OAuth client secrets, the KEK boot secret) and secrets do not belong in a
 * committed file. Nothing is defaulted silently that would be dangerous to get
 * wrong: a missing KEK secret is a hard failure rather than a generated
 * throwaway, since a generated one would decrypt nothing on the next boot and
 * would look like data loss.
 *
 * THE ENGINE RUN HOST (`runs`) IS WIRED, with two distinct halves:
 *
 *  - Provider dispatch (the "thinking" half — producing plans, summaries and
 *    questions via a real model) is fully composed: `createEngineRunHostV1`
 *    over `createEngineProviderRunnerV1`, real Anthropic/OpenAI/Google
 *    adapters, and per-task model-key custody. A created task now actually
 *    runs rounds, exactly as `tests/engineRunHost.test.ts`'s "Part 9 round
 *    trip" proves end to end through this same handler shape.
 *  - Sandbox source acquisition and teardown (`acquireTaskSourceV1` /
 *    `teardownTaskSandboxV1`) are wired too, around `start`/`submitAnswers`,
 *    so `task-owned-ephemeral` bindings are acquired and reclaimed rather
 *    than orphaned.
 *
 * STILL MISSING, DELIBERATELY: nothing here turns a completed round's
 * `summaryMarkdown` into actual file changes or sandbox commands — that
 * bridge (provider output → `EngineFileChangeV1[]` → the gate machinery)
 * does not exist anywhere in this repo yet, is a real design decision, and
 * is intentionally out of scope for this composition. A hosted task today
 * will converse, plan, and ask/answer structured questions through a real
 * model, and its sandbox will be acquired and torn down — but no code gets
 * written and no command gets run. Do not describe this deployment as able
 * to "do" the work; it can only "think" about it, so far.
 *
 * `task-owned-ephemeral` bindings are therefore now ACCEPTED (the
 * `runs === undefined` refusal in controlPlaneServerV1.ts no longer fires),
 * and that is only safe because acquisition/teardown are wired in the same
 * change that lifts it — see the money-danger paragraph this replaced in
 * git history if that stops being true. Tracked in
 * docs/verification/known-gaps.md.
 *
 * Usage:
 *   ENSEMBLE_KEK_SECRET=... ENSEMBLE_GITHUB_CLIENT_ID=... \
 *   ENSEMBLE_GITHUB_CLIENT_SECRET=... pnpm --filter @ensemble/control-plane serve
 */
import { randomUUID } from "node:crypto";

import type { SandboxExecutionContextV1 } from "../../ensemble-engine/src/sandboxExecutionV1";
import { createRedactingLogSinkV1 } from "../../ensemble-engine/src/logRedactionV1";
import { createDefaultEngineAdaptersV1 } from "../../ensemble-engine/src/providerAdaptersV1";
import { ENGINE_PROVIDERS_V1, type EngineProviderIdV1 } from "../../ensemble-engine/src/providerCatalogV1";
import { createEngineProviderRunnerV1 } from "../../ensemble-engine/src/providerDispatchV1";
import { createControlPlaneHandlerV1, createControlPlaneNodeServerV1 } from "./controlPlaneServerV1";
import { createEngineJobSupervisorV1 } from "./engineJobsV1";
import { createEngineRunHostV1, type EngineRunHostV1, type EngineRunOutcomeV1 } from "./engineRunHostV1";
import {
  createGitHubIdentityValidatorV1,
  createOidcIdentityValidatorV1,
  type IdentityValidatorV1,
} from "./identityValidatorsV1";
import { createBootSecretKekProviderV1, decryptKeyMaterialV1, KeyCustodyUnavailableErrorV1 } from "./keyCustodyV1";
import {
  acquireTaskSourceV1,
  createSdkSandboxClientFactoryV1,
  teardownTaskSandboxV1,
  type SandboxClientFactoryV1,
} from "./sandboxLifecycleV1";
import { createSessionServiceV1 } from "./sessionServiceV1";
import { createSqliteControlPlaneStoreV1 } from "./sqliteStoreV1";
import { taskModelSettingsV1 } from "./taskModelSettingsV1";
import type { ControlPlaneStoreV1, ControlPlaneTaskRecordV1 } from "./storeV1";
import { createWsHubV1, type WsHubV1 } from "./wsHubV1";
import type { EngineLogSinkV1 } from "../../ensemble-engine/src/logRedactionV1";

/** Google's published OIDC endpoints — fixed values, not configuration. */
const GOOGLE_TOKEN_ENDPOINT_V1 = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI_V1 = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER_V1 = "https://accounts.google.com";

const DEFAULT_PORT_V1 = 8787;
const DEFAULT_DATABASE_PATH_V1 = "control-plane.sqlite";
/** Where the Expo web target serves from during development. */
const DEFAULT_CORS_ORIGIN_V1 = "http://localhost:8081";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} is required. The control plane will not start without it — see serveV1.ts for the full list.`
    );
  }
  return value;
}

/** Both halves of an OAuth credential or neither; one alone is a misconfiguration. */
function optionalPair(
  idName: string,
  secretName: string
): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const clientId = process.env[idName];
  const clientSecret = process.env[secretName];
  if (clientId === undefined && clientSecret === undefined) {
    return undefined;
  }
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(`${idName} and ${secretName} must be set together, or neither.`);
  }
  return { clientId, clientSecret };
}

export function buildIdentityValidatorsV1(): readonly IdentityValidatorV1[] {
  const validators: IdentityValidatorV1[] = [];

  const github = optionalPair("ENSEMBLE_GITHUB_CLIENT_ID", "ENSEMBLE_GITHUB_CLIENT_SECRET");
  if (github) {
    validators.push(
      createGitHubIdentityValidatorV1({
        fetch: globalThis.fetch,
        clientId: github.clientId,
        clientSecret: github.clientSecret,
      })
    );
  }

  const google = optionalPair("ENSEMBLE_GOOGLE_CLIENT_ID", "ENSEMBLE_GOOGLE_CLIENT_SECRET");
  if (google) {
    validators.push(
      createOidcIdentityValidatorV1({
        provider: "google",
        fetch: globalThis.fetch,
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT_V1,
        jwksUri: GOOGLE_JWKS_URI_V1,
        issuer: GOOGLE_ISSUER_V1,
      })
    );
  }

  if (validators.length === 0) {
    throw new Error(
      "No identity provider is configured. Set ENSEMBLE_GITHUB_CLIENT_ID/SECRET or " +
        "ENSEMBLE_GOOGLE_CLIENT_ID/SECRET — with none, nobody can sign in and the server is useless."
    );
  }
  return validators;
}

export interface CreateProductionRunHostOptionsV1 {
  readonly realHost: EngineRunHostV1;
  readonly store: ControlPlaneStoreV1;
  readonly hub: WsHubV1;
  readonly kekProvider: Parameters<typeof decryptKeyMaterialV1>[0];
  readonly sandboxFactory: SandboxClientFactoryV1;
  /** Shared with `providerRunnerFor`'s closure — see that function's comment. */
  readonly modelKeyCache: Map<string, ReadonlyMap<EngineProviderIdV1, string>>;
  /** Stable identity of this control-plane worker (gate/attempt lease holder). */
  readonly workerId: string;
  readonly log?: EngineLogSinkV1;
}

/**
 * Wrap a real run host with the two pieces of glue its composition needs but
 * doesn't provide itself:
 *
 *  - Model-key prefetch: `providerRunnerFor`'s `getProviderApiKey` must
 *    return synchronously, but key custody's decrypt is async, so each task's
 *    keys are decrypted and cached here, BEFORE the entry points that trigger
 *    a fresh `providerRunnerFor(task)` call (`start`, and `submitAnswers`
 *    when it rehydrates a restart-recovered run).
 *  - Sandbox source acquisition/teardown: `acquireTaskSourceV1` runs before
 *    handing off to the real host, so a task-owned-ephemeral binding's source
 *    exists before any round runs against it; `teardownTaskSandboxV1` runs
 *    after any run leg settles into a TERMINAL outcome (`completed`/`failed`
 *    — a `questionsPaused` leg is not done, so nothing is torn down yet).
 *    Both route through `EngineGateMachineryV1` (attempt-recorded, crash-safe)
 *    via a fresh `EngineJobSupervisorV1.machineryFor` per call — cheap, since
 *    the machinery is a stateless factory over the durable store.
 */
function createProductionRunHostV1(options: CreateProductionRunHostOptionsV1): EngineRunHostV1 {
  const { realHost, store, hub, kekProvider, sandboxFactory, modelKeyCache: cache, workerId, log } = options;
  const jobSupervisor = createEngineJobSupervisorV1({ store, hub, workerId });

  async function prefetchModelKeys(task: ControlPlaneTaskRecordV1): Promise<void> {
    const keys = new Map<EngineProviderIdV1, string>();
    for (const provider of ENGINE_PROVIDERS_V1) {
      const record = store.readKeyRecord(task.ownerUserId, `model:${provider.id}`);
      if (record === undefined) {
        continue;
      }
      try {
        keys.set(provider.id, await decryptKeyMaterialV1(kekProvider, record.envelope));
      } catch (error) {
        // Fail-closed per provider, not per task: a KEK outage makes that
        // one provider unavailable for this run, matching the synchronous
        // "no key" case `getProviderApiKey` already has to handle.
        if (!(error instanceof KeyCustodyUnavailableErrorV1)) {
          throw error;
        }
      }
    }
    cache.set(task.taskId, keys);
  }

  async function sandboxContextFor(
    task: ControlPlaneTaskRecordV1
  ): Promise<SandboxExecutionContextV1 | undefined> {
    const keyRecord = store.readKeyRecord(task.ownerUserId, `sandbox:${task.binding.provider}`);
    if (keyRecord === undefined) {
      return undefined;
    }
    try {
      const apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      return { binding: task.binding, client: sandboxFactory.clientFor(task.binding.provider, apiKey) };
    } catch (error) {
      if (error instanceof KeyCustodyUnavailableErrorV1) {
        return undefined;
      }
      throw error;
    }
  }

  function markFailed(task: ControlPlaneTaskRecordV1, code: string): EngineRunOutcomeV1 {
    store.upsertJob({
      jobId: task.taskId,
      taskId: task.taskId,
      ownerUserId: task.ownerUserId,
      status: "failed",
      updatedAt: new Date().toISOString(),
    });
    return { kind: "failed", code };
  }

  /** Returns a terminal outcome when acquisition itself fails; undefined to proceed. */
  async function acquireSource(task: ControlPlaneTaskRecordV1): Promise<EngineRunOutcomeV1 | undefined> {
    const context = await sandboxContextFor(task);
    if (context === undefined) {
      log?.("engine run host: source acquisition skipped, no sandbox key — task failed");
      return markFailed(task, "sandboxProviderKeyMissing");
    }
    const machinery = jobSupervisor.machineryFor(task.taskId, task.ownerUserId);
    const result = await acquireTaskSourceV1(machinery, context);
    if (!result.acquired) {
      log?.("engine run host: source acquisition failed — task failed");
      return markFailed(task, "sourceAcquisitionFailed");
    }
    return undefined;
  }

  async function teardownIfTerminal(
    task: ControlPlaneTaskRecordV1,
    outcome: EngineRunOutcomeV1
  ): Promise<void> {
    if (outcome.kind !== "completed" && outcome.kind !== "failed") {
      return;
    }
    const context = await sandboxContextFor(task);
    if (context === undefined) {
      // No key to tear down with — the same key was needed to acquire the
      // source in the first place, so this only happens if it was revoked
      // mid-run. Leaves the sandbox for manual cleanup; nothing else to do.
      return;
    }
    const machinery = jobSupervisor.machineryFor(task.taskId, task.ownerUserId);
    await teardownTaskSandboxV1(machinery, context);
  }

  return {
    async start(task) {
      await prefetchModelKeys(task);
      const acquisitionFailure = await acquireSource(task);
      if (acquisitionFailure !== undefined) {
        return acquisitionFailure;
      }
      const outcome = await realHost.start(task);
      await teardownIfTerminal(task, outcome);
      return outcome;
    },
    async submitAnswers(taskId, interactionId, rawAnswers, answerIdempotencyId) {
      // A running (non-rehydrated) task already has its keys cached from
      // `start`; re-fetching here only matters for restart recovery, and
      // doing it unconditionally keeps this wrapper ignorant of the real
      // host's internal rehydrate-vs-resume distinction.
      const task = store.readTask(taskId);
      if (task !== undefined) {
        await prefetchModelKeys(task);
      }
      const result = await realHost.submitAnswers(taskId, interactionId, rawAnswers, answerIdempotencyId);
      if (result.ok && task !== undefined) {
        const capturedTask = task;
        void result.settled.then((outcome) => teardownIfTerminal(capturedTask, outcome));
      }
      return result;
    },
    pendingInteractionId: realHost.pendingInteractionId,
    settled: realHost.settled,
  };
}

export function startControlPlaneV1(): { readonly port: number; readonly close: () => void } {
  const port = Number(process.env["ENSEMBLE_PORT"] ?? DEFAULT_PORT_V1);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ENSEMBLE_PORT must be a valid port number; got ${String(process.env["ENSEMBLE_PORT"])}`);
  }
  const databasePath = process.env["ENSEMBLE_DATABASE_PATH"] ?? DEFAULT_DATABASE_PATH_V1;
  const corsOrigins = (process.env["ENSEMBLE_CORS_ORIGINS"] ?? DEFAULT_CORS_ORIGIN_V1)
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Fail closed and fail loudly: an absent boot secret must not be replaced by
  // a generated one, because every key sealed under a generated KEK becomes
  // unreadable the moment the process restarts.
  const kekProvider = createBootSecretKekProviderV1({
    kekId: process.env["ENSEMBLE_KEK_ID"] ?? "boot-dev",
    bootSecret: required("ENSEMBLE_KEK_SECRET"),
  });

  const store = createSqliteControlPlaneStoreV1({ databasePath });
  const sessions = createSessionServiceV1({ store, validators: buildIdentityValidatorsV1() });
  const hub = createWsHubV1({ sessions, store });

  // Every line is redacted before it reaches stdout — the sanctioned route for
  // handing a sink to the control plane.
  const log = createRedactingLogSinkV1((line: string) => {
    process.stdout.write(`${line}\n`);
  });

  // Per-task decrypted model keys, populated by createProductionRunHostV1
  // before each providerRunnerFor(task) call — see that function's own comment.
  const modelKeysByTask = new Map<string, ReadonlyMap<EngineProviderIdV1, string>>();
  const engineAdapters = createDefaultEngineAdaptersV1({ fetch: globalThis.fetch });
  const sandboxFactory = createSdkSandboxClientFactoryV1();

  function providerRunnerFor(task: ControlPlaneTaskRecordV1): ReturnType<typeof createEngineProviderRunnerV1> {
    return createEngineProviderRunnerV1({
      getModelSettings: () => taskModelSettingsV1(task),
      // No per-user enabled-providers store exists yet; nothing is disabled.
      getEnabledProviders: () => undefined,
      getProviderApiKey: (provider) => modelKeysByTask.get(task.taskId)?.get(provider),
      adapters: engineAdapters,
    });
  }

  const runs = createProductionRunHostV1({
    realHost: createEngineRunHostV1({ store, hub, providerRunnerFor }),
    store,
    hub,
    kekProvider,
    sandboxFactory,
    modelKeyCache: modelKeysByTask,
    workerId: process.env["ENSEMBLE_WORKER_ID"] ?? randomUUID(),
    log,
  });

  // Opt-in to creating sandboxes this composition cannot drive or tear down.
  // Moot now that `runs` is always set — the `runs === undefined` refusal in
  // controlPlaneServerV1.ts never fires here — kept only so an operator's
  // existing env var doesn't silently change meaning.
  const allowEphemeralSandboxWithoutRunHost =
    process.env["ENSEMBLE_ALLOW_UNMANAGED_SANDBOXES"] === "1";

  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub,
    kekProvider,
    sandboxFactory,
    allowEphemeralSandboxWithoutRunHost,
    runs,
    engineAdapters,
    log,
  });

  const server = createControlPlaneNodeServerV1(handler, { hub, corsOrigins });
  server.listen(port);
  log(`control plane listening on http://127.0.0.1:${port}`);
  log(`  database: ${databasePath}`);
  log(`  cors origins: ${corsOrigins.join(", ")}`);
  log("  engine run host: active — provider dispatch and sandbox source acquisition/teardown wired.");
  log("    (tasks can think and converse; nothing yet turns a round into file changes/commands.)");
  return { port, close: (): void => void server.close() };
}

// Only run when executed directly, so importing this module (a test, or a
// future supervisor) never starts a listener as a side effect.
if (require.main === module) {
  startControlPlaneV1();
}
