/**
 * Typed fetch client for the Part 3 control-plane contract (plan Part 6+).
 *
 * Every method mirrors one contract operation and returns a typed result —
 * never a thrown transport error — so screens can surface the contract's
 * typed error codes (binding validation, gate idempotency mismatch/conflict,
 * custody unavailability) directly. Authentication is the control-plane
 * session credential ONLY: the bearer access token supplied by the injected
 * `getAccessToken` (the Part 6 session manager). No method ever carries a
 * provider OAuth token or any client-asserted identity, and no write/exec
 * file operation exists on this surface (read-only viewer contract).
 *
 * Gate decisions are idempotent by contract: callers generate the
 * idempotency key ONCE per decision and retry with the SAME key and an
 * IDENTICAL payload, so a flaky connection can never double-approve; a
 * payload mismatch surfaces the contract's typed `gateDecisionPayloadMismatch`.
 */

export type ApiResultV1<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/**
 * The contract's SessionTokens body (Part 6 session credential).
 * `refreshToken` is present for native clients; on the web target it is
 * absent here because the server delivers it ONLY as an HttpOnly cookie
 * (see `platform: 'web'` on `createControlPlaneClientV1`).
 */
export interface SessionTokensV1 {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken?: string;
}

export interface AuthExchangeRequestV1 {
  readonly provider: 'github' | 'google' | 'apple';
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly nonce?: string;
}

export type SandboxProviderV1 = 'e2b' | 'daytona';

export type SandboxSourceAcquisitionV1 =
  | { readonly kind: 'gitClone'; readonly repoUrl: string; readonly ref: string }
  | { readonly kind: 'attachExisting'; readonly path: string };

/**
 * The SandboxBinding request shape (Part 3): validated server-side.
 *
 * `sandboxId` is conditional on lifecycle, mirroring the contract. A
 * task-owned sandbox does not exist when the binding is submitted — the
 * control plane creates it and assigns the id — so sending one is rejected;
 * only an attached, user-managed workspace has an id to name.
 *
 * NOTE: this duplicates `@ensemble/contract`'s type rather than importing it.
 * The app declares no dependency on the contract package, so the two shapes
 * are kept in step by hand — a divergence here surfaces as a server-side
 * `sandboxBindingInvalid` rather than a compile error.
 */
export type SandboxBindingRequestV1 =
  | {
      readonly provider: SandboxProviderV1;
      readonly source: SandboxSourceAcquisitionV1;
      readonly workingDirectoryRoot: string;
      readonly lifecycle: 'task-owned-ephemeral';
      readonly cleanup: 'destroy-on-completion' | 'retain';
      readonly sandboxId?: undefined;
    }
  | {
      readonly provider: SandboxProviderV1;
      readonly sandboxId: string;
      readonly source: SandboxSourceAcquisitionV1;
      readonly workingDirectoryRoot: string;
      readonly lifecycle: 'user-managed-persistent';
      readonly cleanup: 'destroy-on-completion' | 'retain';
    };

export interface TaskDtoV1 {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly bindingId: string;
  readonly progress: {
    readonly taskFolder: string;
    readonly displayName?: string;
    readonly currentStage: string;
    /** Missing means active (the core schema's backward-compat rule). */
    readonly status?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  /**
   * The task's most recent round, when one exists — lets the task list
   * derive `N/M` progress without fetching full per-task history. The
   * `history` endpoint remains the source for the complete per-round list.
   */
  readonly latestRound?: TaskRoundDtoV1;
}

export interface TaskRoundDtoV1 {
  readonly roundId: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly summary?: string;
}

export interface ChatTurnDtoV1 {
  readonly turnId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly at: string;
  readonly text?: string;
  readonly interactionId?: string;
}

export interface GateDtoV1 {
  readonly gateId: string;
  readonly taskId: string;
  readonly state: 'pending' | 'approved' | 'rejected';
  readonly summary: string;
  readonly requestedAt: string;
  readonly decidedAt?: string;
}

export interface GateDecisionDtoV1 {
  readonly gateId: string;
  readonly state: 'approved' | 'rejected';
  readonly decidedAt: string;
  readonly replayed: boolean;
}

/** Masked key metadata: the contract never reads material back. */
export interface KeyRecordDtoV1 {
  readonly keyKind: string;
  readonly maskedHint: string;
  readonly updatedAt: string;
}

/** A directory entry from the read-only listing endpoint. */
export interface FileEntryDtoV1 {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes?: number;
}

/**
 * One server-tokenized highlight span (the Part 10 shared token-span
 * schema): UTF-16 offsets into the served text, start inclusive, end
 * exclusive. `scope` is typed open (string) on the client: an unknown scope
 * renders as unstyled text, never an error.
 */
export interface TokenSpanDtoV1 {
  readonly start: number;
  readonly end: number;
  readonly scope: string;
}

export interface FileContentDtoV1 {
  readonly path: string;
  readonly text: string;
  readonly language?: string;
  /** Server-side highlighting; absent for unknown languages. */
  readonly tokenSpans?: readonly TokenSpanDtoV1[];
}

export interface CreateControlPlaneClientOptionsV1 {
  readonly baseUrl: string;
  /** Current access token, or null when signed out (session manager seam). */
  readonly getAccessToken: () => Promise<string | null>;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Default 'native': refreshToken travels in the auth response body, as
   * everywhere else. 'web' sends `x-ensemble-platform: web` and
   * `credentials: 'include'` on the three auth routes only, so the server
   * omits refreshToken from the body and delivers it solely as an HttpOnly
   * cookie (Part 6's web policy — secure-store's web fallback is not secure
   * storage, so the refresh token must never be JS-reachable on web).
   */
  readonly platform?: 'native' | 'web';
}

export interface ControlPlaneClientV1 {
  exchange(request: AuthExchangeRequestV1): Promise<ApiResultV1<SessionTokensV1>>;
  /** Ignored on the web target: the refresh token travels via cookie instead. */
  refresh(refreshToken?: string): Promise<ApiResultV1<SessionTokensV1>>;
  revoke(): Promise<ApiResultV1<undefined>>;

  listTasks(): Promise<ApiResultV1<readonly TaskDtoV1[]>>;
  createTask(request: {
    readonly request: string;
    readonly displayName?: string;
    readonly sandboxBinding: SandboxBindingRequestV1;
    /**
     * Optional provider-qualified model id ("<provider>:<model>") the
     * engine's rounds run with (Part 9); server-validated with the typed
     * error modelSelectionInvalid.
     */
    readonly model?: string;
  }): Promise<ApiResultV1<TaskDtoV1>>;
  getTask(taskId: string): Promise<ApiResultV1<TaskDtoV1>>;
  getTaskHistory(taskId: string): Promise<ApiResultV1<readonly TaskRoundDtoV1[]>>;

  listChatTurns(taskId: string): Promise<ApiResultV1<readonly ChatTurnDtoV1[]>>;
  sendChatMessage(taskId: string, text: string): Promise<ApiResultV1<undefined>>;
  submitStructuredAnswers(
    taskId: string,
    submission: {
      readonly interactionId: string;
      readonly answers: readonly unknown[];
      /** Generate once per submission; reuse verbatim on retry. */
      readonly answerIdempotencyId: string;
    }
  ): Promise<ApiResultV1<undefined>>;

  listGates(taskId: string): Promise<ApiResultV1<readonly GateDtoV1[]>>;
  getGate(gateId: string): Promise<ApiResultV1<GateDtoV1>>;
  decideGate(
    gateId: string,
    decision: {
      readonly decision: 'approve' | 'reject';
      /** Generate once per decision; retries MUST reuse it with an identical payload. */
      readonly idempotencyKey: string;
      readonly comment?: string;
    }
  ): Promise<ApiResultV1<GateDecisionDtoV1>>;

  listKeys(): Promise<ApiResultV1<readonly KeyRecordDtoV1[]>>;
  /** Submit key material over TLS; it is never echoed back (204). */
  putKey(keyKind: string, key: string): Promise<ApiResultV1<undefined>>;
  deleteKey(keyKind: string): Promise<ApiResultV1<undefined>>;

  listFiles(taskId: string, path: string): Promise<ApiResultV1<readonly FileEntryDtoV1[]>>;
  getFile(taskId: string, path: string): Promise<ApiResultV1<FileContentDtoV1>>;
  getDiff(taskId: string, gateId?: string): Promise<ApiResultV1<{ readonly unifiedDiff: string }>>;
}

export function createControlPlaneClientV1(
  options: CreateControlPlaneClientOptionsV1
): ControlPlaneClientV1 {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  async function call<T>(
    method: string,
    path: string,
    init?: {
      readonly body?: unknown;
      readonly authorized?: boolean;
      /** The three auth routes only: carries the web HttpOnly refresh cookie. */
      readonly webCookieAuth?: boolean;
    }
  ): Promise<ApiResultV1<T>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init?.authorized !== false) {
      const token = await options.getAccessToken();
      if (token === null) {
        return { ok: false, status: 401, code: 'unauthorized', message: 'not signed in' };
      }
      headers['authorization'] = `Bearer ${token}`;
    }
    const isWeb = options.platform === 'web';
    if (init?.webCookieAuth === true && isWeb) {
      headers['x-ensemble-platform'] = 'web';
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        // Cross-origin cookie round-trip for the HttpOnly refresh cookie;
        // irrelevant (and harmless) on native, which has no cookie jar.
        ...(init?.webCookieAuth === true && isWeb ? { credentials: 'include' as const } : {}),
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: 'networkUnavailable',
        message: error instanceof Error ? error.message : 'network request failed',
      };
    }
    let body: unknown;
    try {
      const text = await response.text();
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, body: body as T };
    }
    const typedError =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as { code?: unknown; message?: unknown })
        : {};
    return {
      ok: false,
      status: response.status,
      code: typeof typedError.code === 'string' ? typedError.code : 'requestFailed',
      message:
        typeof typedError.message === 'string'
          ? typedError.message
          : `request failed with status ${response.status}`,
    };
  }

  const encodePath = (value: string): string => encodeURIComponent(value);

  return {
    exchange: (request) =>
      call('POST', '/v1/auth/exchange', { body: request, authorized: false, webCookieAuth: true }),
    refresh: (refreshToken) =>
      call('POST', '/v1/auth/refresh', {
        body: { refreshToken },
        authorized: false,
        webCookieAuth: true,
      }),
    revoke: () => call('POST', '/v1/auth/revoke', { webCookieAuth: true }),

    listTasks: () => call('GET', '/v1/tasks'),
    createTask: (request) => call('POST', '/v1/tasks', { body: request }),
    getTask: (taskId) => call('GET', `/v1/tasks/${encodePath(taskId)}`),
    getTaskHistory: (taskId) => call('GET', `/v1/tasks/${encodePath(taskId)}/history`),

    listChatTurns: (taskId) => call('GET', `/v1/tasks/${encodePath(taskId)}/chat`),
    sendChatMessage: (taskId, text) =>
      call('POST', `/v1/tasks/${encodePath(taskId)}/chat`, {
        body: { kind: 'message', text },
      }),
    submitStructuredAnswers: (taskId, submission) =>
      call('POST', `/v1/tasks/${encodePath(taskId)}/chat`, {
        body: { kind: 'structuredAnswers', ...submission },
      }),

    listGates: (taskId) => call('GET', `/v1/tasks/${encodePath(taskId)}/gates`),
    getGate: (gateId) => call('GET', `/v1/gates/${encodePath(gateId)}`),
    decideGate: (gateId, decision) =>
      call('POST', `/v1/gates/${encodePath(gateId)}/decision`, { body: decision }),

    listKeys: () => call('GET', '/v1/keys'),
    putKey: (keyKind, key) =>
      call('PUT', `/v1/keys/${encodePath(keyKind)}`, { body: { key } }),
    deleteKey: (keyKind) => call('DELETE', `/v1/keys/${encodePath(keyKind)}`),

    listFiles: (taskId, path) =>
      call('GET', `/v1/tasks/${encodePath(taskId)}/files?path=${encodePath(path)}`),
    getFile: (taskId, path) =>
      call('GET', `/v1/tasks/${encodePath(taskId)}/file?path=${encodePath(path)}`),
    getDiff: (taskId, gateId) =>
      call(
        'GET',
        gateId !== undefined
          ? `/v1/tasks/${encodePath(taskId)}/diff?gateId=${encodePath(gateId)}`
          : `/v1/tasks/${encodePath(taskId)}/diff`
      ),
  };
}
