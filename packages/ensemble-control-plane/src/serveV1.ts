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
 * WHAT ACTUALLY DOES WORK depends on the task's model selection:
 *
 *  - A direct-API selection (`anthropic:…`, `openai:…`, `google:…`) only
 *    "thinks": nothing turns a completed round's `summaryMarkdown` into file
 *    changes or sandbox commands — that bridge (provider output →
 *    `EngineFileChangeV1[]` → the gate machinery) does not exist in this
 *    repo, is a real design decision, and is deliberately out of scope here.
 *  - A `claude-cli:…` selection runs the REAL Claude Code CLI inside the
 *    task's sandbox for every round (`createSandboxCliProviderRunnerV1`,
 *    wired through dispatch's `cliRunnerFor`): implementation rounds run in
 *    the CLI's edit mode and actually write files and run commands there,
 *    every other stage runs read-only — the same shape as the extension
 *    running locally, with the CLI's own subscription login inside the
 *    sandbox (`cliLoginSessionsV1.ts`) paying for it. The runner is bound to
 *    the task's sandbox context, which is only knowable after key custody
 *    and source acquisition, so it is resolved per call from a cache this
 *    wrapper fills (`sandboxContextCache`) — the same shape as model keys.
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
import { createSandboxCliProviderRunnerV1 } from "../../ensemble-engine/src/sandboxCliRunnerV1";
import { createControlPlaneHandlerV1, createControlPlaneNodeServerV1 } from "./controlPlaneServerV1";
import { createCliLoginServiceV1 } from "./cliLoginSessionsV1";
import { createEngineJobSupervisorV1, type EngineJobSupervisorV1 } from "./engineJobsV1";
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
import { createWsHubV1 } from "./wsHubV1";
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

/**
 * `ENSEMBLE_ALLOWED_IDENTITIES`: comma-separated `<provider>:<subjectId>`
 * (GitHub's numeric user id, e.g. `github:9324248` — `gh api user --jq .id`).
 * Required: a self-hosted control plane belongs to one person, and without
 * a list every GitHub/Google account on earth can sign in and start
 * containers on that person's host. `ENSEMBLE_OPEN_SIGNUP=1` is the only
 * way to run without one, and it has to be typed on purpose.
 */
export function buildAllowedIdentitiesV1(): ReadonlySet<string> | undefined {
  const raw = process.env["ENSEMBLE_ALLOWED_IDENTITIES"];
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    if (process.env["ENSEMBLE_OPEN_SIGNUP"] === "1") {
      return undefined;
    }
    throw new Error(
      "ENSEMBLE_ALLOWED_IDENTITIES is required (e.g. github:9324248 — your numeric GitHub id). " +
        "Without it anyone with a GitHub or Google account could sign in and run containers on this host. " +
        "Set ENSEMBLE_OPEN_SIGNUP=1 only if open sign-up is really what you want."
    );
  }
  for (const entry of entries) {
    if (!/^(github|google|apple):[^\s:]+$/.test(entry)) {
      throw new Error(`ENSEMBLE_ALLOWED_IDENTITIES entry ${JSON.stringify(entry)} is not "<provider>:<subjectId>".`);
    }
  }
  return new Set(entries);
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
  readonly kekProvider: Parameters<typeof decryptKeyMaterialV1>[0];
  readonly sandboxFactory: SandboxClientFactoryV1;
  /** Shared with `providerRunnerFor`'s closure — see that function's comment. */
  readonly modelKeyCache: Map<string, ReadonlyMap<EngineProviderIdV1, string>>;
  /**
   * Also shared with `providerRunnerFor`: the task's resolved sandbox
   * context (binding + provider client), filled here before any round runs
   * and cleared once the run settles, so a `claude-cli` selection can bind
   * its runner to the sandbox synchronously from inside dispatch.
   */
  readonly sandboxContextCache: Map<string, SandboxExecutionContextV1>;
  /** The gate/attempt machinery source, shared with the CLI runner's per-round effects. */
  readonly jobSupervisor: EngineJobSupervisorV1;
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
  const {
    realHost,
    store,
    kekProvider,
    sandboxFactory,
    modelKeyCache: cache,
    sandboxContextCache,
    jobSupervisor,
    log,
  } = options;

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
    const cached = sandboxContextCache.get(task.taskId);
    if (cached !== undefined) {
      return cached;
    }
    const keyRecord = store.readKeyRecord(task.ownerUserId, `sandbox:${task.binding.provider}`);
    if (keyRecord === undefined) {
      return undefined;
    }
    try {
      const apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      const context: SandboxExecutionContextV1 = {
        binding: task.binding,
        client: sandboxFactory.clientFor(task.binding.provider, apiKey),
      };
      sandboxContextCache.set(task.taskId, context);
      return context;
    } catch (error) {
      if (error instanceof KeyCustodyUnavailableErrorV1) {
        return undefined;
      }
      throw error;
    }
  }

  function markFailed(task: ControlPlaneTaskRecordV1, code: string): EngineRunOutcomeV1 {
    const at = new Date().toISOString();
    // Same durable shape as the run host's own `fail`: the code on the job
    // AND a terminal round record, so a task that never got a round still
    // shows WHY in the history a client already renders.
    store.appendTaskRound(task.taskId, {
      roundId: randomUUID().replace(/-/g, ""),
      stage: task.progress.currentStage,
      startedAt: at,
      completedAt: at,
      summary: `failed: ${code}`,
    });
    store.upsertJob({
      jobId: task.taskId,
      taskId: task.taskId,
      ownerUserId: task.ownerUserId,
      status: "failed",
      failureCode: code,
      updatedAt: at,
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

  /** Drop every decrypted credential this task's run was holding. */
  function evictCredentials(taskId: string): void {
    cache.delete(taskId);
    sandboxContextCache.delete(taskId);
  }

  /**
   * Tear down on a terminal outcome and ALWAYS evict the task's cached
   * credentials when the run is over — the model keys too, which used to
   * stay decrypted in memory for the life of the process. Never throws: it
   * runs from background continuations, where an escaped rejection would
   * terminate the whole control plane.
   */
  async function teardownIfTerminal(
    task: ControlPlaneTaskRecordV1,
    outcome: EngineRunOutcomeV1
  ): Promise<void> {
    if (outcome.kind !== "completed" && outcome.kind !== "failed") {
      return;
    }
    try {
      const context = await sandboxContextFor(task);
      evictCredentials(task.taskId);
      if (context === undefined) {
        // No key to tear down with — the same key was needed to acquire the
        // source in the first place, so this only happens if it was revoked
        // mid-run. Leaves the sandbox for manual cleanup; nothing else to do.
        return;
      }
      const machinery = jobSupervisor.machineryFor(task.taskId, task.ownerUserId);
      await teardownTaskSandboxV1(machinery, context);
    } catch {
      log?.("engine run host: sandbox teardown failed — the sandbox may need manual cleanup");
    } finally {
      evictCredentials(task.taskId);
    }
  }

  return {
    async start(task) {
      let outcome: EngineRunOutcomeV1;
      try {
        await prefetchModelKeys(task);
        // An acquisition failure is as terminal as any other: it goes
        // through the same teardown, so a bad repo URL no longer leaves a
        // destroy-on-completion sandbox running forever.
        outcome = (await acquireSource(task)) ?? (await realHost.start(task));
      } catch {
        outcome = markFailed(task, "engineRunThrew");
      }
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
        // Same restart-recovery reasoning for the sandbox context: a
        // rehydrated run's `claude-cli` rounds need it, and the cache was
        // lost with the previous process.
        await sandboxContextFor(task);
      }
      const result = await realHost.submitAnswers(taskId, interactionId, rawAnswers, answerIdempotencyId);
      if (result.ok && task !== undefined) {
        const capturedTask = task;
        result.settled.then(
          (outcome) => teardownIfTerminal(capturedTask, outcome),
          () => teardownIfTerminal(capturedTask, { kind: "failed", code: "engineRunThrew" })
        );
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
  const allowedIdentities = buildAllowedIdentitiesV1();
  const sessions = createSessionServiceV1({
    store,
    validators: buildIdentityValidatorsV1(),
    ...(allowedIdentities !== undefined ? { allowedIdentities } : {}),
  });
  const hub = createWsHubV1({ sessions, store });

  // Every line is redacted before it reaches stdout — the sanctioned route for
  // handing a sink to the control plane.
  const log = createRedactingLogSinkV1((line: string) => {
    process.stdout.write(`${line}\n`);
  });

  // Per-task decrypted model keys, populated by createProductionRunHostV1
  // before each providerRunnerFor(task) call — see that function's own comment.
  const modelKeysByTask = new Map<string, ReadonlyMap<EngineProviderIdV1, string>>();
  // Per-task sandbox context, same lifecycle and reason — see
  // CreateProductionRunHostOptionsV1.sandboxContextCache.
  const sandboxContextsByTask = new Map<string, SandboxExecutionContextV1>();
  const engineAdapters = createDefaultEngineAdaptersV1({ fetch: globalThis.fetch });
  // The provisioned sandbox image (docker/sandbox.Dockerfile). Unset means
  // the Docker client's bare default image, which has no Claude Code CLI:
  // fine for API-keyed models, useless for `claude-cli:*` selections — so
  // an operator who wants the subscription path must build and name it.
  const dockerSandboxImage = process.env["ENSEMBLE_DOCKER_SANDBOX_IMAGE"];
  const sandboxFactory = createSdkSandboxClientFactoryV1({
    ...(dockerSandboxImage !== undefined && dockerSandboxImage.length > 0
      ? { dockerImage: dockerSandboxImage }
      : {}),
  });
  const jobSupervisor = createEngineJobSupervisorV1({
    store,
    hub,
    workerId: process.env["ENSEMBLE_WORKER_ID"] ?? randomUUID(),
  });

  function providerRunnerFor(task: ControlPlaneTaskRecordV1): ReturnType<typeof createEngineProviderRunnerV1> {
    return createEngineProviderRunnerV1({
      getModelSettings: () => taskModelSettingsV1(task),
      // No per-user enabled-providers store exists yet; nothing is disabled.
      getEnabledProviders: () => undefined,
      getProviderApiKey: (provider) => modelKeysByTask.get(task.taskId)?.get(provider),
      adapters: engineAdapters,
      // The real Claude Code CLI, inside this task's sandbox. No env is
      // handed in on purpose: the CLI authenticates with the login it
      // persisted in that sandbox, never with a stored API key — a
      // subscription selection must never silently bill an API key.
      cliRunnerFor: (provider) => {
        const context = sandboxContextsByTask.get(task.taskId);
        if (provider !== "claude-cli" || context === undefined) {
          return undefined;
        }
        return createSandboxCliProviderRunnerV1({
          client: context.client,
          sandboxId: context.binding.sandboxId,
          workingDirectoryRoot: context.binding.workingDirectoryRoot,
          machinery: jobSupervisor.machineryFor(task.taskId, task.ownerUserId),
        });
      },
    });
  }

  const runs = createProductionRunHostV1({
    realHost: createEngineRunHostV1({ store, hub, providerRunnerFor }),
    store,
    kekProvider,
    sandboxFactory,
    modelKeyCache: modelKeysByTask,
    sandboxContextCache: sandboxContextsByTask,
    jobSupervisor,
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
    cliLogin: createCliLoginServiceV1(),
    log,
  });

  const server = createControlPlaneNodeServerV1(handler, { hub, corsOrigins });
  server.listen(port);
  log(`control plane listening on http://127.0.0.1:${port}`);
  log(`  database: ${databasePath}`);
  log(`  cors origins: ${corsOrigins.join(", ")}`);
  log(
    allowedIdentities === undefined
      ? "  sign-in: OPEN (ENSEMBLE_OPEN_SIGNUP=1) — any identity-provider account can sign in"
      : `  sign-in: restricted to ${allowedIdentities.size} identit${allowedIdentities.size === 1 ? "y" : "ies"}`
  );
  log("  engine run host: active — provider dispatch and sandbox source acquisition/teardown wired.");
  log("    claude-cli:* selections run the real Claude Code CLI inside the task's sandbox (edits + commands);");
  log("    direct-API selections only think — nothing turns their rounds into file changes/commands.");
  return { port, close: (): void => void server.close() };
}

// Only run when executed directly, so importing this module (a test, or a
// future supervisor) never starts a listener as a side effect.
if (require.main === module) {
  startControlPlaneV1();
}
