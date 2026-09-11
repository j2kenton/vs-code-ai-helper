/**
 * The reference control-plane server for the Part 3 contract (plan Part 5).
 *
 * A PURE request handler (transport-independent, contract-tested directly)
 * plus a thin node:http adapter. Normative rules enforced here, per the
 * OpenAPI spec:
 *
 * - the ONLY security scheme is the control-plane session credential: every
 *   non-auth route resolves the bearer access token through the Part 6
 *   session service, and NOTHING accepts provider OAuth tokens or
 *   client-asserted identity;
 * - every resource carries an owner and every request is authorized against
 *   ownership; access by identifier guessing reads as 404, identically to
 *   absence;
 * - task creation validates the SandboxBinding (shape via the contract
 *   validator, provider-key presence via custody, reachability via the
 *   provider client) and fails with the typed binding errors — there is no
 *   unbound execution path;
 * - file/diff retrieval is read-only and confined to the binding root under
 *   the full Part 3 rule (lexical + provider resolve-then-check, via the
 *   engine's `resolveConfinedSandboxPathV1`); no write or exec endpoint
 *   exists anywhere on this surface;
 * - gate decisions run the store's atomic CAS under the (owner, gate,
 *   idempotency key) contract: replay → 200 with `replayed: true`,
 *   same-key/different-payload → 422 mismatch, conflict → 409, absence or
 *   foreign ownership → 404;
 * - key records are write/rotate/delete only with masked metadata reads —
 *   no response anywhere carries stored key material, and custody failures
 *   are fail-closed (503, never plaintext).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { allocateHex128IdV1, isHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import {
  isWellFormedAbsoluteRootV1,
  SandboxBindingV1,
  SandboxProviderV1,
  validateSandboxBindingRequestV1,
} from "../../ensemble-contract/src/sandboxBindingV1";
import {
  parseEngineModelSelectionV1,
  toEngineQualifiedModelIdV1,
  type EngineProviderIdV1,
} from "../../ensemble-engine/src/providerCatalogV1";
import type { EngineModelProviderAdapterV1 } from "../../ensemble-engine/src/providerAdaptersV1";
import type { CliLoginServiceV1 } from "./cliLoginSessionsV1";
import {
  resolveConfinedSandboxPathV1,
  SandboxExecutionContextV1,
} from "../../ensemble-engine/src/sandboxExecutionV1";
import { createRedactingLogSinkV1, EngineLogSinkV1 } from "../../ensemble-engine/src/logRedactionV1";
import type { SandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import { highlightTokenSpansV1 } from "../../ensemble-engine/src/syntaxHighlightV1";
import { decryptKeyMaterialV1, KekProviderV1, KeyCustodyUnavailableErrorV1, maskKeyHintV1, encryptKeyMaterialV1 } from "./keyCustodyV1";
import type { SessionServiceV1, SessionTokensV1 } from "./sessionServiceV1";
import type { AuthExchangeRequestV1, IdentityProviderNameV1 } from "./identityValidatorsV1";
import {
  isWebPlatformRequestV1,
  readWebRefreshCookieV1,
  serializeClearedWebRefreshCookieV1,
  serializeWebRefreshCookieV1,
} from "./webSessionCookieV1";
import type { SandboxClientFactoryV1 } from "./sandboxLifecycleV1";
import { ensureUserSandboxV1, validateBindingReachabilityV1 } from "./sandboxLifecycleV1";
import type {
  ChatTurnRecordV1,
  ControlPlaneStoreV1,
  ControlPlaneTaskRecordV1,
  EngineJobRecordV1,
} from "./storeV1";
import type { EngineRunHostV1 } from "./engineRunHostV1";
import type { WsHubV1 } from "./wsHubV1";
import { attachWsEventsTransportV1 } from "./wsTransportV1";

export interface ControlPlaneHttpRequestV1 {
  readonly method: string;
  /** Path only, no query string (e.g. `/v1/tasks/abc/file`). */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface ControlPlaneHttpResponseV1 {
  readonly status: number;
  readonly body?: unknown;
  /** Extra response headers (currently only the web refresh-cookie Set-Cookie). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ControlPlaneHandlerV1 {
  handle(request: ControlPlaneHttpRequestV1): Promise<ControlPlaneHttpResponseV1>;
}

export interface CreateControlPlaneHandlerOptionsV1 {
  readonly store: ControlPlaneStoreV1;
  readonly sessions: SessionServiceV1;
  readonly hub: WsHubV1;
  readonly kekProvider: KekProviderV1;
  readonly sandboxFactory: SandboxClientFactoryV1;
  /**
   * When present, task creation starts a hosted engine run and structured
   * answers route into the paused run (Part 5 hosting); absent, the handler
   * is store-only (contract tests, thin deployments fronting a separate
   * engine worker).
   */
  readonly runs?: EngineRunHostV1;
  /**
   * Permit `task-owned-ephemeral` bindings even with no `runs` host.
   *
   * Default false, and deliberately so: a task-owned binding ALLOCATES a
   * sandbox at the user's provider, and with no run host nothing ever drives
   * that task — source is never acquired, the task never leaves `creating`,
   * and `teardownTaskSandboxV1` (which honours `destroy-on-completion`) has no
   * caller. The sandbox simply runs, and bills, until the user finds it in a
   * provider dashboard. Allocating a paid resource that provably cannot be
   * used is not a defensible default, so a store-only handler refuses it.
   *
   * `user-managed-persistent` is unaffected: it allocates nothing, and the
   * user already owns the workspace.
   *
   * Set true only for a deployment that knowingly accepts manual sandbox
   * cleanup (integration smokes exercising binding custody and reachability).
   */
  readonly allowEphemeralSandboxWithoutRunHost?: boolean;
  /**
   * Single-shot direct-API model dispatch (`POST /v1/provider-calls`), for a
   * CLIENT-DRIVEN caller that wants ONE provider call made from this server
   * rather than from wherever the client itself runs — e.g. a VS Code
   * extension's own per-stage orchestration loop, unchanged, delegating just
   * the network hop for one round to this deployment instead of calling the
   * provider directly. Distinct from `runs`: this makes no task, opens no
   * gate, persists nothing — it is a stateless proxy over the same key
   * custody and adapters a hosted run already uses. Absent, the route 404s.
   */
  readonly engineAdapters?: ReadonlyMap<EngineProviderIdV1, EngineModelProviderAdapterV1>;
  /**
   * CLI subscription login inside the caller's `user-owned-managed`
   * sandbox (`POST /v1/user-sandbox/login` + `.../code`). Absent, both
   * routes 404 — a deployment with no interactive-session-capable sandbox
   * provider configured has nothing for them to drive.
   */
  readonly cliLogin?: CliLoginServiceV1;
  readonly now?: () => Date;
  /**
   * Diagnostic log sink (plan Part 11). Every line is passed through
   * `redactSecretsV1` before it reaches this sink — token/key redaction is
   * applied here, not left to the caller — and the handler itself only ever
   * logs method/path/status, never headers, bodies, or key material.
   */
  readonly log?: EngineLogSinkV1;
}

const KEY_KIND_PATTERN_V1 = /^(sandbox|model):[A-Za-z0-9._-]{1,64}$/;
/** Mirrors the contract's own (package-private) provider set. */
const SANDBOX_PROVIDERS_V1: ReadonlySet<string> = new Set(["e2b", "daytona", "docker"]);
/** Server-side defense in depth; the caller's own bounded writer enforces the real cap. */
const MAX_PROVIDER_CALL_PROMPT_CHARS_V1 = 2 * 1024 * 1024;
/**
 * Hard cap on any request body, enforced while streaming (413): above the
 * largest legitimate body (a provider-call prompt, JSON-escaped) with room
 * to spare, and far below anything that could pressure the heap.
 */
const MAX_REQUEST_BODY_BYTES_V1 = 8 * 1024 * 1024;
/** The only routes reachable before sign-in; their bodies are a few hundred bytes. */
const PRE_AUTH_ROUTES_V1: ReadonlySet<string> = new Set(["/v1/auth/exchange", "/v1/auth/refresh", "/v1/auth/revoke"]);
const MAX_PRE_AUTH_BODY_BYTES_V1 = 16 * 1024;
/** How much of a refused body is read and discarded (never stored) so the 413 reaches the client. */
const MAX_REJECTED_BODY_DRAIN_BYTES_V1 = 32 * 1024 * 1024;

const LANGUAGE_BY_EXTENSION_V1: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  css: "css",
  html: "html",
};

function typed(status: number, code: string, message: string): ControlPlaneHttpResponseV1 {
  return { status, body: { code, message } };
}

/**
 * The SessionTokens response, split by platform per the Part 6 web policy:
 * native gets `refreshToken` in the body (unchanged); web gets it ONLY as an
 * HttpOnly Set-Cookie, never in a JS-reachable body field.
 */
function sessionTokensResponseV1(tokens: SessionTokensV1, isWeb: boolean): ControlPlaneHttpResponseV1 {
  if (!isWeb) {
    return { status: 200, body: tokens };
  }
  const { refreshToken, ...body } = tokens;
  return {
    status: 200,
    body,
    headers: { "set-cookie": serializeWebRefreshCookieV1(refreshToken) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(request: ControlPlaneHttpRequestV1): string | undefined {
  const header = request.headers["authorization"];
  if (header === undefined || !header.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * DTO per the contract's Task schema. `latestRound` carries the most recent
 * round record (if any) so the task list can show `N/M` progress without an
 * N+1 `getTaskHistory` fetch per task; `getTaskHistory` remains the source
 * for the full per-round history shown on the task detail screen.
 */
/**
 * `run` is the hosted run's own state, distinct from the task's core
 * `progress.status`: the core vocabulary has no "failed" (a task whose run
 * stopped is still an active task that can be retried), so without this a
 * failed run reads as "active" forever with nothing to say why.
 */
function taskDto(record: ControlPlaneTaskRecordV1, job: EngineJobRecordV1 | undefined): Record<string, unknown> {
  const latestRound = record.rounds[record.rounds.length - 1];
  return {
    taskId: record.taskId,
    ownerUserId: record.ownerUserId,
    bindingId: record.binding.bindingId,
    progress: record.progress,
    ...(latestRound !== undefined ? { latestRound } : {}),
    ...(job !== undefined
      ? {
          run: {
            status: job.status,
            ...(job.failureCode !== undefined ? { failureCode: job.failureCode } : {}),
          },
        }
      : {}),
  };
}

function chatTurnDto(turn: ChatTurnRecordV1): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    role: turn.role,
    at: turn.at,
    ...(turn.text !== undefined ? { text: turn.text } : {}),
    ...(turn.interactionId !== undefined ? { interactionId: turn.interactionId } : {}),
  };
}

export function createControlPlaneHandlerV1(
  options: CreateControlPlaneHandlerOptionsV1
): ControlPlaneHandlerV1 {
  const { store, sessions, hub, kekProvider, sandboxFactory, runs, engineAdapters, cliLogin } = options;
  const allowEphemeralSandboxWithoutRunHost = options.allowEphemeralSandboxWithoutRunHost === true;
  const now = options.now ?? ((): Date => new Date());
  const log = options.log === undefined ? undefined : createRedactingLogSinkV1(options.log);

  /** Resolve the task's sandbox client via custody (fail-closed). */
  async function sandboxContextFor(
    task: ControlPlaneTaskRecordV1
  ): Promise<
    | { readonly ok: true; readonly context: SandboxExecutionContextV1 }
    | { readonly ok: false; readonly response: ControlPlaneHttpResponseV1 }
  > {
    const keyRecord = store.readKeyRecord(task.ownerUserId, `sandbox:${task.binding.provider}`);
    if (keyRecord === undefined) {
      return {
        ok: false,
        response: typed(422, "sandboxProviderKeyMissing", "no stored key for the binding's provider"),
      };
    }
    let apiKey: string;
    try {
      apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
    } catch (error) {
      if (error instanceof KeyCustodyUnavailableErrorV1) {
        // Fail-closed: KEK unavailable → key-dependent operations refuse.
        return { ok: false, response: typed(503, error.code, error.message) };
      }
      throw error;
    }
    const client: SandboxClientV1 = sandboxFactory.clientFor(task.binding.provider, apiKey);
    return { ok: true, context: { binding: task.binding, client } };
  }

  async function handleAuthRoute(
    request: ControlPlaneHttpRequestV1
  ): Promise<ControlPlaneHttpResponseV1 | undefined> {
    if (request.method === "POST" && request.path === "/v1/auth/exchange") {
      const body = request.body;
      if (
        !isRecord(body) ||
        typeof body.provider !== "string" ||
        !["github", "google", "apple"].includes(body.provider) ||
        typeof body.authorizationCode !== "string" ||
        typeof body.codeVerifier !== "string" ||
        typeof body.redirectUri !== "string" ||
        (body.nonce !== undefined && typeof body.nonce !== "string")
      ) {
        return typed(401, "identityValidationFailed", "malformed exchange request");
      }
      const exchangeRequest: AuthExchangeRequestV1 = {
        provider: body.provider as IdentityProviderNameV1,
        authorizationCode: body.authorizationCode,
        codeVerifier: body.codeVerifier,
        redirectUri: body.redirectUri,
        ...(typeof body.nonce === "string" ? { nonce: body.nonce } : {}),
      };
      const result = await sessions.exchange(exchangeRequest);
      if (!result.ok) {
        return typed(401, result.code, result.reason);
      }
      return sessionTokensResponseV1(result.tokens, isWebPlatformRequestV1(request.headers));
    }
    if (request.method === "POST" && request.path === "/v1/auth/refresh") {
      const isWeb = isWebPlatformRequestV1(request.headers);
      const body = request.body;
      // Web relies on the HttpOnly cookie, never a body field; native still
      // presents the refresh token it was issued in the exchange/refresh body.
      const refreshToken = isWeb
        ? readWebRefreshCookieV1(request.headers)
        : isRecord(body) && typeof body.refreshToken === "string"
          ? body.refreshToken
          : undefined;
      if (refreshToken === undefined) {
        return typed(
          401,
          "refreshTokenInvalid",
          isWeb ? "missing refresh cookie" : "malformed refresh request"
        );
      }
      const result = await sessions.refresh(refreshToken);
      if (!result.ok) {
        const response = typed(401, result.code, result.reason);
        // Reuse detection or an invalid token revoked/rejected the family:
        // clear the now-dead web cookie too, so the client doesn't retry it.
        return isWeb
          ? { ...response, headers: { "set-cookie": serializeClearedWebRefreshCookieV1() } }
          : response;
      }
      return sessionTokensResponseV1(result.tokens, isWeb);
    }
    return undefined;
  }

  async function handleAuthorized(
    request: ControlPlaneHttpRequestV1,
    userId: string
  ): Promise<ControlPlaneHttpResponseV1> {
    const { method, path } = request;

    if (method === "POST" && path === "/v1/auth/revoke") {
      const token = bearerToken(request);
      if (token !== undefined) {
        await sessions.revokeByAccessToken(token);
      }
      return isWebPlatformRequestV1(request.headers)
        ? { status: 204, headers: { "set-cookie": serializeClearedWebRefreshCookieV1() } }
        : { status: 204 };
    }

    if (method === "GET" && path === "/v1/tasks") {
      return {
        status: 200,
        body: store.listTasksForOwner(userId).map((task) => taskDto(task, store.readJob(task.taskId))),
      };
    }

    if (method === "POST" && path === "/v1/tasks") {
      const body = request.body;
      if (!isRecord(body) || typeof body.request !== "string" || body.request.length === 0) {
        return typed(422, "taskRequestInvalid", "task creation requires a request text");
      }
      const validated = validateSandboxBindingRequestV1(body.sandboxBinding);
      if (!validated.ok) {
        const status = validated.code === "sandboxBindingMissing" ? 400 : 422;
        return typed(status, validated.code, validated.reason);
      }
      // Part 9 model selection: validated against the engine's provider
      // catalog at creation, stored normalized (aliases resolved) so the
      // hosted run's dispatch and later comparisons agree on one id.
      let modelId: string | undefined;
      if (body.model !== undefined) {
        if (typeof body.model !== "string") {
          return typed(422, "modelSelectionInvalid", "the model selection must be a string");
        }
        const parsedModel = parseEngineModelSelectionV1(body.model);
        if (!parsedModel.ok) {
          return typed(422, "modelSelectionInvalid", parsedModel.reason);
        }
        modelId = toEngineQualifiedModelIdV1(
          parsedModel.selection.provider.id,
          parsedModel.selection.model
        );
      }
      // Refuse to allocate a sandbox nothing can ever drive. Checked BEFORE
      // key custody and provider contact so the failure costs nothing: with no
      // run host this request would create a billable sandbox, leave the task
      // at `creating` forever, and never reach teardown.
      if (
        validated.binding.lifecycle === "task-owned-ephemeral" &&
        runs === undefined &&
        !allowEphemeralSandboxWithoutRunHost
      ) {
        return typed(
          422,
          "sandboxBindingInvalid",
          "this deployment has no engine run host, so a task-owned sandbox would be " +
            "created, billed, and never used or torn down. Attach a sandbox you " +
            "manage, or run a control plane with a run host configured."
        );
      }
      if (validated.binding.provider === "docker" && validated.binding.lifecycle === "user-managed-persistent") {
        // "Attach mine" means "a sandbox at MY provider account, named by
        // me" — and for E2B/Daytona the caller's own API key scopes that to
        // their account. Docker has no account: every caller's client talks
        // to the same host daemon, so a caller-named id would be ANY
        // container on the host, anyone's (review finding, confirmed live
        // 2026-09-11). The persistent sandbox for Docker is
        // `user-owned-managed`, whose id comes from this server's own record.
        return typed(
          422,
          "sandboxBindingInvalid",
          'Docker sandboxes cannot be attached by id; use the "user-owned-managed" lifecycle (your persistent sandbox) instead'
        );
      }
      const keyRecord = store.readKeyRecord(userId, `sandbox:${validated.binding.provider}`);
      if (keyRecord === undefined) {
        return typed(422, "sandboxProviderKeyMissing", "no stored key for the binding's provider");
      }
      let apiKey: string;
      try {
        apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      } catch (error) {
        if (error instanceof KeyCustodyUnavailableErrorV1) {
          return typed(503, error.code, error.message);
        }
        throw error;
      }
      const client = sandboxFactory.clientFor(validated.binding.provider, apiKey);
      // A task-owned ephemeral binding names no sandbox because none exists
      // yet — creating it here is what makes the default mode usable at all.
      // Providers like E2B have no dashboard where a user could pre-create
      // one; sandboxes are created on demand by the SDK and torn down after,
      // so the id is only knowable after this call.
      let sandboxId: string;
      // Set only when THIS request created the sandbox, so a later failure can
      // destroy it. A user-managed sandbox is never destroyed here — it is not
      // ours to reclaim. A user-owned-managed sandbox is deliberately treated
      // the same way EVEN on first creation: it is meant to survive across
      // tasks, so a failure later in THIS request must not tear it down —
      // only task-owned-ephemeral's throwaway sandbox gets that treatment.
      let createdSandboxId: string | undefined;
      if (validated.binding.lifecycle === "user-managed-persistent") {
        sandboxId = validated.binding.sandboxId;
      } else if (validated.binding.lifecycle === "user-owned-managed") {
        try {
          sandboxId = (
            await ensureUserSandboxV1(
              store,
              client,
              userId,
              validated.binding.provider,
              validated.binding.workingDirectoryRoot,
              now
            )
          ).sandboxId;
        } catch {
          return typed(
            422,
            "sandboxUnreachable",
            "the sandbox provider could not create or resolve this user's sandbox"
          );
        }
      } else {
        try {
          sandboxId = (await client.createSandbox()).sandboxId;
          createdSandboxId = sandboxId;
        } catch {
          return typed(
            422,
            "sandboxUnreachable",
            "the sandbox provider could not create a sandbox for this task"
          );
        }
      }
      /**
       * Give up the sandbox this request created before returning a failure.
       * Creation happens BEFORE the task record exists, so a sandbox left
       * running after an early return is unreachable from every later code
       * path — no task, no binding, no id persisted anywhere — and the user
       * is billed for it until they find it in a provider dashboard. Teardown
       * is best-effort: a failure to destroy must not mask the real error.
       */
      const releaseCreatedSandbox = async (): Promise<void> => {
        if (createdSandboxId === undefined) {
          return;
        }
        try {
          await client.destroySandbox(createdSandboxId);
        } catch {
          // Nothing better is available here; the typed failure below stands.
        }
      };
      const binding: SandboxBindingV1 = {
        ...validated.binding,
        sandboxId,
        bindingId: allocateHex128IdV1(),
        ownerUserId: userId,
      };
      const reachable = await validateBindingReachabilityV1(client, binding);
      if (!reachable.ok) {
        await releaseCreatedSandbox();
        return typed(422, reachable.code, reachable.reason);
      }
      const at = now().toISOString();
      const taskId = allocateHex128IdV1();
      const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
      const progress: PersistedTaskProgressV1 = {
        ensembleProgressVersion: 1,
        taskFolder: taskId,
        ...(displayName !== undefined ? { displayName } : {}),
        currentStage: "desc",
        status: "creating",
        createdAt: at,
        updatedAt: at,
      };
      const record: ControlPlaneTaskRecordV1 = {
        taskId,
        ownerUserId: userId,
        ...(displayName !== undefined ? { displayName } : {}),
        request: body.request,
        ...(modelId !== undefined ? { modelId } : {}),
        binding,
        progress,
        rounds: [],
        createdAt: at,
      };
      try {
        store.createTask(record);
      } catch (error) {
        // Until the record is durable, the sandbox id exists ONLY in this
        // closure: a failed insert means no task, no binding, and no way for
        // any later code path to find what was allocated. Release it before
        // the error escapes, then rethrow untouched — a persistence fault is
        // not a binding fault and must not be reported as one.
        await releaseCreatedSandbox();
        throw error;
      }
      if (runs !== undefined) {
        // The hosted engine run drives in the background; its settlement is
        // observable through the store (progress, rounds, job checkpoints)
        // and the WS feed, never awaited by task creation. A throw from the
        // background run must never become an unhandled rejection — Node
        // would terminate the whole control plane for it.
        runs.start(record).catch((error: unknown) => {
          log?.(`engine run for a task threw: ${error instanceof Error ? error.name : "unknown error"}`);
        });
      }
      return { status: 201, body: taskDto(record, store.readJob(record.taskId)) };
    }

    const taskMatch = /^\/v1\/tasks\/([^/]+)(?:\/(history|chat|gates|files|file|diff))?$/.exec(path);
    if (taskMatch !== null) {
      const taskId = taskMatch[1] as string;
      const sub = taskMatch[2];
      const task = store.readTask(taskId);
      if (task === undefined || task.ownerUserId !== userId) {
        // Ownership mismatch reads identically to absence.
        return typed(404, "taskNotFound", "no such task for the authenticated user");
      }

      if (sub === undefined && method === "GET") {
        return { status: 200, body: taskDto(task, store.readJob(task.taskId)) };
      }
      if (sub === "history" && method === "GET") {
        return { status: 200, body: task.rounds };
      }
      if (sub === "chat" && method === "GET") {
        return { status: 200, body: store.listChatTurns(taskId).map(chatTurnDto) };
      }
      if (sub === "chat" && method === "POST") {
        const body = request.body;
        if (isRecord(body) && body.kind === "message" && typeof body.text === "string" && body.text.length > 0) {
          store.appendChatTurn(taskId, {
            turnId: allocateHex128IdV1(),
            role: "user",
            at: now().toISOString(),
            text: body.text,
          });
          return { status: 202 };
        }
        if (
          isRecord(body) &&
          body.kind === "structuredAnswers" &&
          typeof body.interactionId === "string" &&
          Array.isArray(body.answers) &&
          typeof body.answerIdempotencyId === "string" &&
          isHex128IdV1(body.answerIdempotencyId)
        ) {
          if (runs !== undefined) {
            // Route into the hosted engine run: the answers validate against
            // the posted questions and the resumed invocation runs exactly
            // once under the engine's idempotency rules. `noActiveRun` falls
            // through to the store-only path (task hosted elsewhere).
            const forwarded = await runs.submitAnswers(
              taskId,
              body.interactionId,
              body.answers,
              body.answerIdempotencyId
            );
            if (!forwarded.ok && forwarded.code === "unknownInteraction") {
              return typed(404, "interactionNotFound", "no pending interaction with that id");
            }
            if (!forwarded.ok && forwarded.code === "answersRejected") {
              return typed(
                422,
                "structuredAnswersRejected",
                forwarded.reason ?? "the answers failed validation"
              );
            }
          }
          // Replaying an identical submission is a no-op returning the
          // original acknowledgement (the Part 2 idempotency contract).
          store.appendChatTurn(
            taskId,
            {
              turnId: allocateHex128IdV1(),
              role: "user",
              at: now().toISOString(),
              interactionId: body.interactionId,
            },
            body.answerIdempotencyId
          );
          return { status: 202 };
        }
        return typed(422, "chatTurnInvalid", "unrecognized chat turn shape");
      }
      if (sub === "gates" && method === "GET") {
        const gates = await store.gates.listForTask(taskId);
        return {
          status: 200,
          body: gates.map((gate) => ({
            gateId: gate.gateId,
            taskId: gate.taskId,
            state: gate.state,
            summary: gate.summary,
            requestedAt: gate.createdAt,
            ...(gate.decision !== undefined ? { decidedAt: gate.decision.decidedAt } : {}),
          })),
        };
      }

      if ((sub === "files" || sub === "file") && method === "GET") {
        const relativePath = request.query["path"];
        if (relativePath === undefined) {
          return typed(400, "pathOutsideBindingRoot", "the path query parameter is required");
        }
        const contextResult = await sandboxContextFor(task);
        if (!contextResult.ok) {
          return contextResult.response;
        }
        const client = contextResult.context.client;
        let realAbsolutePath: string;
        if (relativePath === ".") {
          // `.` names the binding root itself (the browser's starting
          // directory). The root is authorized by definition but still
          // provider-resolved, fail-closed when absent.
          const realRoot = await client.resolveRealPath(
            task.binding.sandboxId,
            task.binding.workingDirectoryRoot
          );
          if (realRoot === undefined) {
            return typed(
              400,
              "pathOutsideBindingRoot",
              "the binding root does not exist in the sandbox (fail-closed)"
            );
          }
          realAbsolutePath = realRoot;
        } else {
          const confined = await resolveConfinedSandboxPathV1(contextResult.context, relativePath);
          if (!confined.ok) {
            return typed(400, confined.code, confined.reason);
          }
          realAbsolutePath = confined.realAbsolutePath;
        }
        if (sub === "files") {
          const entries = await client.listDirectory(task.binding.sandboxId, realAbsolutePath);
          if (entries === undefined) {
            return typed(404, "directoryNotFound", "the path is not a listable directory");
          }
          return { status: 200, body: entries };
        }
        const text = await client.readFileUtf8(task.binding.sandboxId, realAbsolutePath);
        if (text === undefined) {
          return typed(404, "fileNotFound", "the path is not a readable file");
        }
        const extension = relativePath.includes(".")
          ? relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase()
          : "";
        const language = LANGUAGE_BY_EXTENSION_V1[extension];
        return {
          status: 200,
          body: {
            path: relativePath,
            text,
            ...(language !== undefined
              ? {
                  language,
                  // Server-side highlighting (Part 10): pre-tokenized spans
                  // in the shared schema, rendered by the native client.
                  tokenSpans: highlightTokenSpansV1(text, language),
                }
              : {}),
          },
        };
      }

      if (sub === "diff" && method === "GET") {
        const gates = await store.gates.listForTask(taskId);
        const gateId = request.query["gateId"];
        const gate =
          gateId !== undefined
            ? gates.find((candidate) => candidate.gateId === gateId)
            : [...gates].reverse().find((candidate) => candidate.state === "pending");
        if (gateId !== undefined && gate === undefined) {
          return typed(404, "gateNotFound", "no such gate for the authenticated user");
        }
        return {
          status: 200,
          body: { unifiedDiff: gate?.diffUnified ?? "" },
        };
      }
    }

    const gateMatch = /^\/v1\/gates\/([^/]+)(\/decision)?$/.exec(path);
    if (gateMatch !== null) {
      const gateId = gateMatch[1] as string;
      const isDecision = gateMatch[2] !== undefined;
      const gate = await store.gates.read(gateId);
      if (gate === undefined || gate.ownerId !== userId) {
        return typed(404, "gateNotFound", "no such gate for the authenticated user");
      }
      if (!isDecision && method === "GET") {
        return {
          status: 200,
          body: {
            gateId: gate.gateId,
            taskId: gate.taskId,
            state: gate.state,
            summary: gate.summary,
            requestedAt: gate.createdAt,
            ...(gate.decision !== undefined ? { decidedAt: gate.decision.decidedAt } : {}),
          },
        };
      }
      if (isDecision && method === "POST") {
        const body = request.body;
        if (
          !isRecord(body) ||
          (body.decision !== "approve" && body.decision !== "reject") ||
          typeof body.idempotencyKey !== "string" ||
          (body.comment !== undefined && typeof body.comment !== "string")
        ) {
          return typed(400, "gateDecisionInvalid", "malformed gate decision");
        }
        const result = await store.gates.decide(userId, {
          gateId,
          decision: body.decision,
          idempotencyKey: body.idempotencyKey,
          ...(body.comment !== undefined ? { comment: body.comment } : {}),
        });
        if (result.kind === "rejected") {
          return typed(400, "gateDecisionInvalid", result.reason);
        }
        if (result.kind === "error") {
          if (result.code === "gateNotFound") {
            return typed(404, result.code, result.reason);
          }
          if (result.code === "gateAlreadyDecided") {
            return typed(409, result.code, result.reason);
          }
          return typed(422, result.code, result.reason);
        }
        if (result.kind === "decided") {
          // Exactly once per real transition; replays emit nothing.
          await hub.publishToOwner(userId, {
            type: "gateStateChanged",
            taskId: result.record.taskId,
            gateId: result.record.gateId,
            state: result.record.state,
          });
        }
        const decision = result.record.decision;
        return {
          status: 200,
          body: {
            gateId: result.record.gateId,
            state: result.record.state,
            decidedAt: decision?.decidedAt ?? now().toISOString(),
            replayed: result.kind === "replayed",
          },
        };
      }
    }

    if (method === "POST" && path === "/v1/provider-calls") {
      if (engineAdapters === undefined) {
        return typed(404, "notFound", "this deployment does not accept direct provider calls");
      }
      const body = request.body;
      if (
        !isRecord(body) ||
        typeof body.provider !== "string" ||
        typeof body.prompt !== "string" ||
        body.prompt.length === 0 ||
        (body.model !== undefined && typeof body.model !== "string")
      ) {
        return typed(422, "providerCallInvalid", "provider and prompt are required");
      }
      if (body.prompt.length > MAX_PROVIDER_CALL_PROMPT_CHARS_V1) {
        return typed(422, "providerCallPromptTooLarge", "prompt exceeds the size this endpoint accepts");
      }
      const provider = body.provider as EngineProviderIdV1;
      const adapter = engineAdapters.get(provider);
      if (adapter === undefined) {
        return typed(422, "providerCallProviderUnknown", `no adapter for provider "${provider}"`);
      }
      const keyRecord = store.readKeyRecord(userId, `model:${provider}`);
      if (keyRecord === undefined) {
        return typed(422, "providerCallKeyMissing", `no stored key for provider "${provider}"`);
      }
      let apiKey: string;
      try {
        apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      } catch (error) {
        if (error instanceof KeyCustodyUnavailableErrorV1) {
          return typed(503, error.code, error.message);
        }
        throw error;
      }
      const result = await adapter.invokeText({
        prompt: body.prompt,
        model: body.model,
        apiKey,
      });
      if (result.status === "failed") {
        return typed(
          result.authFailure === true ? 401 : 502,
          result.authFailure === true ? "providerCallAuthFailed" : "providerCallFailed",
          result.errorMessage
        );
      }
      return { status: 200, body: { text: result.text } };
    }

    if (method === "POST" && path === "/v1/user-sandbox/login") {
      if (cliLogin === undefined) {
        return typed(404, "notFound", "this deployment does not support in-sandbox CLI login");
      }
      const body = request.body;
      if (!isRecord(body) || typeof body.provider !== "string" || !SANDBOX_PROVIDERS_V1.has(body.provider)) {
        return typed(422, "userSandboxLoginInvalid", 'provider must be "e2b", "daytona", or "docker"');
      }
      if (body.workingDirectoryRoot !== undefined && !isWellFormedAbsoluteRootV1(body.workingDirectoryRoot)) {
        return typed(
          422,
          "userSandboxLoginInvalid",
          "workingDirectoryRoot must be a canonical absolute path when present"
        );
      }
      const provider = body.provider as SandboxProviderV1;
      const workingDirectoryRoot =
        typeof body.workingDirectoryRoot === "string" ? body.workingDirectoryRoot : "/";
      const keyRecord = store.readKeyRecord(userId, `sandbox:${provider}`);
      if (keyRecord === undefined) {
        return typed(422, "sandboxProviderKeyMissing", "no stored key for the requested provider");
      }
      let apiKey: string;
      try {
        apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      } catch (error) {
        if (error instanceof KeyCustodyUnavailableErrorV1) {
          return typed(503, error.code, error.message);
        }
        throw error;
      }
      const client = sandboxFactory.clientFor(provider, apiKey);
      // Checked BEFORE provisioning: for a provider that cannot run an
      // interactive session, ensureUserSandboxV1 used to create (and bill)
      // a persistent sandbox for a sign-in that could never start (final review).
      if (client.createInteractiveSession === undefined) {
        return typed(
          422,
          "userSandboxLoginUnsupported",
          `provider "${provider}" does not support interactive sandbox sessions`
        );
      }
      let userSandbox;
      try {
        userSandbox = await ensureUserSandboxV1(store, client, userId, provider, workingDirectoryRoot, now);
      } catch {
        return typed(422, "sandboxUnreachable", "could not create or resolve this user's sandbox");
      }
      const started = await cliLogin.startLogin({
        ownerUserId: userId,
        client,
        sandboxId: userSandbox.sandboxId,
        workingDirectoryRoot: userSandbox.workingDirectoryRoot,
      });
      if (!started.ok) {
        if (started.code === "tooManyLoginSessions") {
          return typed(429, started.code, "too many sign-ins are in progress; try again in a few minutes");
        }
        if (started.code === "loginSessionStartFailed") {
          return typed(422, started.code, "the sign-in could not be started inside the sandbox");
        }
        return typed(
          422,
          "userSandboxLoginUnsupported",
          `provider "${provider}" does not support interactive sandbox sessions`
        );
      }
      return {
        status: 201,
        body: { loginSessionId: started.loginSessionId, promptOutput: started.promptOutput },
      };
    }

    const loginCodeMatch = /^\/v1\/user-sandbox\/login\/([^/]+)\/code$/.exec(path);
    if (loginCodeMatch !== null && method === "POST") {
      if (cliLogin === undefined) {
        return typed(404, "notFound", "this deployment does not support in-sandbox CLI login");
      }
      const loginSessionId = loginCodeMatch[1] as string;
      const body = request.body;
      if (!isRecord(body) || typeof body.code !== "string" || body.code.length === 0) {
        return typed(422, "userSandboxLoginCodeInvalid", "code is required");
      }
      const result = await cliLogin.submitCode(userId, loginSessionId, body.code);
      if (!result.ok) {
        // Absent and foreign-owned read identically — no confirmation that a
        // login session with this id exists for someone else.
        return typed(404, result.code, "no such login session");
      }
      return result.completed
        ? { status: 200, body: { completed: true, success: result.success } }
        : { status: 200, body: { completed: false } };
    }

    /**
     * Reset the caller's persistent (`user-owned-managed`) sandbox for a
     * provider: destroy it and forget it, so the next task or CLI sign-in
     * creates a fresh one (the way to pick up a new sandbox image, or to
     * start over after a bad login). Destroy-then-forget, never the
     * reverse: a record that outlives its sandbox merely 422s on next use,
     * but a sandbox that outlives its record is unreachable from every code
     * path and — at a BYOS provider — bills until someone finds it.
     */
    const resetMatch = /^\/v1\/user-sandbox\/([^/]+)$/.exec(path);
    if (resetMatch !== null && method === "DELETE") {
      const provider = resetMatch[1] as string;
      if (!SANDBOX_PROVIDERS_V1.has(provider)) {
        return typed(422, "userSandboxResetInvalid", 'provider must be "e2b", "daytona", or "docker"');
      }
      const record = store.readUserSandbox(userId, provider as SandboxProviderV1);
      if (record === undefined) {
        return typed(404, "userSandboxNotFound", "no persistent sandbox exists for this provider");
      }
      const keyRecord = store.readKeyRecord(userId, `sandbox:${provider}`);
      if (keyRecord === undefined) {
        return typed(422, "sandboxProviderKeyMissing", "no stored key for the requested provider");
      }
      let apiKey: string;
      try {
        apiKey = await decryptKeyMaterialV1(kekProvider, keyRecord.envelope);
      } catch (error) {
        if (error instanceof KeyCustodyUnavailableErrorV1) {
          return typed(503, error.code, error.message);
        }
        throw error;
      }
      // A sign-in in progress inside this sandbox dies with it; end it first
      // so nothing is left waiting to time out against a missing container.
      await cliLogin?.cancelForSandbox(userId, record.sandboxId);
      try {
        await sandboxFactory.clientFor(provider as SandboxProviderV1, apiKey).destroySandbox(record.sandboxId);
      } catch {
        return typed(422, "sandboxUnreachable", "the sandbox could not be destroyed; it was kept");
      }
      store.deleteUserSandbox(userId, provider as SandboxProviderV1);
      return { status: 204 };
    }

    if (method === "GET" && path === "/v1/keys") {
      return {
        status: 200,
        body: store.listKeyRecordsForOwner(userId).map((record) => ({
          keyKind: record.keyKind,
          maskedHint: record.maskedHint,
          updatedAt: record.updatedAt,
        })),
      };
    }

    const keyMatch = /^\/v1\/keys\/(.+)$/.exec(path);
    if (keyMatch !== null) {
      const keyKind = decodeURIComponent(keyMatch[1] as string);
      if (!KEY_KIND_PATTERN_V1.test(keyKind)) {
        return typed(422, "keyKindInvalid", "unrecognized key kind");
      }
      if (method === "PUT") {
        const body = request.body;
        if (!isRecord(body) || typeof body.key !== "string" || body.key.length === 0) {
          return typed(422, "keyMaterialInvalid", "key material is required");
        }
        let envelope;
        try {
          envelope = await encryptKeyMaterialV1(kekProvider, body.key);
        } catch (error) {
          if (error instanceof KeyCustodyUnavailableErrorV1) {
            // Fail-closed: no KEK → the key is NOT stored (never plaintext).
            return typed(503, error.code, error.message);
          }
          throw error;
        }
        store.writeKeyRecord({
          keyKind,
          ownerUserId: userId,
          envelope,
          maskedHint: maskKeyHintV1(body.key),
          updatedAt: now().toISOString(),
        });
        // 204 with no body: nothing ever echoes the material back.
        return { status: 204 };
      }
      if (method === "DELETE") {
        return store.deleteKeyRecord(userId, keyKind)
          ? { status: 204 }
          : typed(404, "keyNotFound", "no such key record for the authenticated user");
      }
    }

    if (method === "GET" && path === "/v1/events") {
      // The WS upgrade lives at the transport layer (wsTransportV1 carries
      // the wire; wsHubV1 the subscription semantics); plain HTTP GET
      // cannot carry the stream.
      return typed(426, "upgradeRequired", "this endpoint requires a WebSocket upgrade");
    }

    return typed(404, "notFound", "no such route");
  }

  async function dispatch(request: ControlPlaneHttpRequestV1): Promise<ControlPlaneHttpResponseV1> {
    const authRoute = await handleAuthRoute(request);
    if (authRoute !== undefined) {
      return authRoute;
    }
    const token = bearerToken(request);
    const identity = token === undefined ? undefined : await sessions.authenticate(token);
    if (identity === undefined) {
      return typed(401, "unauthorized", "a valid control-plane access token is required");
    }
    return handleAuthorized(request, identity.userId);
  }

  return {
    async handle(request: ControlPlaneHttpRequestV1): Promise<ControlPlaneHttpResponseV1> {
      if (log === undefined) {
        return dispatch(request);
      }
      // Only method/path/status ever reach the log line; the redacting sink
      // is defense in depth on top of that, not the primary control.
      try {
        const response = await dispatch(request);
        log(`${request.method} ${request.path} -> ${response.status}`);
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${request.method} ${request.path} -> exception: ${message}`);
        throw error;
      }
    },
  };
}

const CORS_ALLOWED_METHODS_V1 = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS_V1 = "content-type, authorization, x-ensemble-platform";

/**
 * CORS response headers for a request from `origin`, IF `origin` exactly
 * matches an entry in `allowedOrigins` — never a wildcard reflection. The
 * web cookie flow (`webSessionCookieV1.ts`) sends `credentials: 'include'`,
 * and per the Fetch/CORS spec a credentialed response MUST echo a specific
 * origin (not `*`); reflecting an arbitrary Origin here would let any site
 * ride the browser's cookie jar, defeating the cookie's own
 * `SameSite=Strict` protection. Absent config or a non-allowlisted origin:
 * no headers, so the browser's default same-origin policy applies unchanged.
 */
function corsHeadersFor(
  origin: string | undefined,
  allowedOrigins: readonly string[]
): Record<string, string> | undefined {
  if (origin === undefined || !allowedOrigins.includes(origin)) {
    return undefined;
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

/**
 * Thin node:http adapter around the pure handler. With a hub, the RFC6455
 * transport (`wsTransportV1.ts`) serves `/v1/events` upgrades; the plain
 * HTTP route keeps answering 426 for non-upgrade requests.
 */
export function createControlPlaneNodeServerV1(
  handler: ControlPlaneHandlerV1,
  options?: {
    readonly hub?: WsHubV1;
    /** Browser origins allowed to make credentialed cross-origin requests. */
    readonly corsOrigins?: readonly string[];
    /**
     * Checks a bearer token BEFORE any request body is read (everything but
     * the sign-in routes). Absent, bodies are read first and the handler
     * authenticates as before — the production composition always sets it.
     */
    readonly authenticateBearer?: (accessToken: string) => Promise<boolean>;
  }
): Server {
  const allowedOrigins = options?.corsOrigins ?? [];
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const origin = incoming.headers.origin;
    const cors = corsHeadersFor(typeof origin === "string" ? origin : undefined, allowedOrigins);
    if (incoming.method === "OPTIONS" && cors !== undefined) {
      // Preflight: answered directly, never reaches the pure handler.
      outgoing.writeHead(204, {
        ...cors,
        "access-control-allow-methods": CORS_ALLOWED_METHODS_V1,
        "access-control-allow-headers": CORS_ALLOWED_HEADERS_V1,
        "access-control-max-age": "600",
      });
      outgoing.end();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    const respond = (status: number, body: unknown, extra?: Readonly<Record<string, string>>): void => {
      if (outgoing.headersSent) {
        outgoing.end();
        return;
      }
      outgoing.writeHead(status, { "content-type": "application/json", ...cors, ...extra });
      outgoing.end(body === undefined ? "" : JSON.stringify(body));
    };
    /**
     * Refuse the request now and DRAIN (not store) what the client is still
     * sending: closing a socket with unread data makes the OS send a reset
     * that discards the response already on its way (observed on Windows).
     * For the same reason there is no `connection: close`: Node closes right
     * after the response, and a 401 sent before any of the body was read
     * never arrived (final review). Past the drain ceiling the sender is not a client waiting for an
     * answer, and the connection is cut.
     */
    const refuse = (status: number, body: unknown): void => {
      rejected = true;
      chunks.length = 0;
      incoming.resume();
      respond(status, body);
    };

    let requestPath: string | undefined;
    try {
      requestPath = new URL(incoming.url ?? "/", "http://localhost").pathname;
    } catch {
      requestPath = undefined;
    }
    // Before sign-in, only these routes take a body — small ones. Every
    // other route's token is checked BEFORE its body is read, so an
    // anonymous client can no longer make the process buffer and parse
    // 8 MB (≈190 MB of heap and ~0.8 s of blocked event loop per request,
    // measured in the final review) just by sending it.
    const preAuthRoute = requestPath !== undefined && PRE_AUTH_ROUTES_V1.has(requestPath);
    const bodyLimit =
      preAuthRoute || requestPath === undefined ? MAX_PRE_AUTH_BODY_BYTES_V1 : MAX_REQUEST_BODY_BYTES_V1;

    incoming.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (rejected) {
        if (received > bodyLimit + MAX_REJECTED_BODY_DRAIN_BYTES_V1) {
          incoming.destroy();
        }
        return;
      }
      if (received > bodyLimit) {
        // Refused while streaming, before the body is ever held in full.
        refuse(413, { code: "requestBodyTooLarge", message: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    if (requestPath === undefined) {
      // Refused only AFTER the data listener exists, so the drain ceiling
      // applies to this body too (second final review).
      refuse(400, { code: "badRequest", message: "malformed request target" });
      return;
    }
    // Reading starts only once the request is allowed to have its body read.
    incoming.pause();
    /**
     * The gate, kept as a promise: a request with NO body (a GET, a
     * `DELETE`, `Content-Length: 0`) has already ended, so 'end' fires even
     * while paused — it must wait for this verdict, or a body-less mutation
     * could run while the client is told 401 (second final review).
     */
    const admitted = (async (): Promise<boolean> => {
      if (!preAuthRoute && options?.authenticateBearer !== undefined) {
        const header = incoming.headers.authorization;
        // Same parsing as the handler's bearerToken(), so the two never disagree.
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        let allowed: boolean;
        try {
          allowed = token.length > 0 && (await options.authenticateBearer(token));
        } catch {
          // A store failure (e.g. SQLITE_BUSY) is not "signed out": a 401
          // would send the client through a pointless re-authentication.
          refuse(503, { code: "temporarilyUnavailable", message: "the request could not be checked; retry shortly" });
          return false;
        }
        if (!allowed) {
          refuse(401, { code: "unauthorized", message: "a valid control-plane access token is required" });
          return false;
        }
      }
      incoming.resume();
      return true;
    })();
    incoming.on("end", () => {
      void admitted.then((ok) => {
        if (ok && !rejected) {
          handleEnded();
        }
      });
    });
    const handleEnded = (): void => {
      // EVERY failure in here ends as a 500 on this one request. Before this
      // catch existed, a throw anywhere in any route became an unhandled
      // rejection — which terminates the whole Node process by default, so
      // one bad request took down every run in flight (review finding,
      // 2026-09-11). The message is not echoed: it can carry internals.
      void (async (): Promise<void> => {
        const url = new URL(incoming.url ?? "/", "http://localhost");
        const query: Record<string, string> = {};
        for (const [name, value] of url.searchParams) {
          query[name] = value;
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") {
            headers[name.toLowerCase()] = value;
          }
        }
        let body: unknown;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            body = undefined;
          }
        }
        const response = await handler.handle({
          method: incoming.method ?? "GET",
          path: url.pathname,
          query,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        respond(response.status, response.body, response.headers);
      })().catch(() => {
        respond(500, { code: "internalError", message: "the request could not be completed" });
      });
    };
  });
  if (options?.hub !== undefined) {
    attachWsEventsTransportV1(server, { hub: options.hub });
  }
  return server;
}
