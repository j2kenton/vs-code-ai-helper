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
  SandboxBindingV1,
  validateSandboxBindingRequestV1,
} from "../../ensemble-contract/src/sandboxBindingV1";
import {
  parseEngineModelSelectionV1,
  toEngineQualifiedModelIdV1,
} from "../../ensemble-engine/src/providerCatalogV1";
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
import { validateBindingReachabilityV1 } from "./sandboxLifecycleV1";
import type { ChatTurnRecordV1, ControlPlaneStoreV1, ControlPlaneTaskRecordV1 } from "./storeV1";
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
function taskDto(record: ControlPlaneTaskRecordV1): Record<string, unknown> {
  const latestRound = record.rounds[record.rounds.length - 1];
  return {
    taskId: record.taskId,
    ownerUserId: record.ownerUserId,
    bindingId: record.binding.bindingId,
    progress: record.progress,
    ...(latestRound !== undefined ? { latestRound } : {}),
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
  const { store, sessions, hub, kekProvider, sandboxFactory, runs } = options;
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
      return { status: 200, body: store.listTasksForOwner(userId).map(taskDto) };
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
      // ours to reclaim.
      let createdSandboxId: string | undefined;
      if (validated.binding.lifecycle === "user-managed-persistent") {
        sandboxId = validated.binding.sandboxId;
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
        // and the WS feed, never awaited by task creation.
        void runs.start(record);
      }
      return { status: 201, body: taskDto(record) };
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
        return { status: 200, body: taskDto(task) };
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
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
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
        const payload = response.body === undefined ? "" : JSON.stringify(response.body);
        outgoing.writeHead(response.status, {
          "content-type": "application/json",
          ...cors,
          ...response.headers,
        });
        outgoing.end(payload);
      })();
    });
  });
  if (options?.hub !== undefined) {
    attachWsEventsTransportV1(server, { hub: options.hub });
  }
  return server;
}
