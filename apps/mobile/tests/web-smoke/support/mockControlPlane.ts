import type { Page, Route } from '@playwright/test';

/**
 * Support helpers for the signed-in Parts 7-10 smoke specs: seed a real
 * session through the `__ensembleE2E__` test hook (installed only when
 * `EXPO_PUBLIC_E2E_TEST_HOOKS=1`, see `src/testing/e2eHooksV1.ts`), then
 * stub the Part 3 contract's `/v1/*` endpoints with `page.route` so the real
 * screens render against known data instead of a live control plane.
 */

export const MOCK_CONTROL_PLANE_URL = 'https://control-plane.invalid';

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Installs a signed-in session via the real session manager (no network). */
export async function seedSignedInSession(page: Page, accessToken = 'e2e-access-token'): Promise<void> {
  await page.waitForFunction(() => window.__ensembleE2E__ !== undefined);
  await page.evaluate(
    async ([controlPlaneUrl, token]) => {
      const hooks = window.__ensembleE2E__;
      if (hooks === undefined) {
        throw new Error('__ensembleE2E__ test hooks are not installed');
      }
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await hooks.seedSignedInSession(controlPlaneUrl, token, expiresAt);
    },
    [MOCK_CONTROL_PLANE_URL, accessToken] as const
  );
}

export async function setActiveTaskId(page: Page, taskId: string | null): Promise<void> {
  await page.evaluate((id) => window.__ensembleE2E__?.setActiveTaskId(id), taskId);
}

/** Installs the Part 6 fake system-browser driver for the redirect-flow smoke. */
export async function installFakeAuthBrowserDriver(page: Page, fixedCode = 'e2e-auth-code'): Promise<void> {
  await page.waitForFunction(() => window.__ensembleE2E__ !== undefined);
  await page.evaluate((code) => {
    const hooks = window.__ensembleE2E__;
    if (hooks === undefined) {
      throw new Error('__ensembleE2E__ test hooks are not installed');
    }
    hooks.installFakeAuthBrowserDriver(code);
  }, fixedCode);
}

/**
 * POST /v1/auth/exchange (Part 6): asserts only the fixed authorization code
 * from the fake browser driver is ever forwarded — never a provider token —
 * and that web requests omit `refreshToken` (the contract's web fallback:
 * the server delivers it only via an HttpOnly cookie, never in the JSON body).
 */
export async function mockAuthExchange(
  page: Page,
  options: { readonly expectedCode: string; readonly accessToken?: string }
): Promise<void> {
  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/auth/exchange`, async (route) => {
    const body = route.request().postDataJSON() as {
      provider: string;
      authorizationCode: string;
      codeVerifier: string;
      redirectUri: string;
    };
    if (body.authorizationCode !== options.expectedCode) {
      await json(route, 400, { code: 'invalidCode', message: 'unexpected authorization code' });
      return;
    }
    await json(route, 200, {
      accessToken: options.accessToken ?? 'e2e-exchanged-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      // No `refreshToken`: the web target's session credential is delivered
      // only as an HttpOnly cookie (Part 6), never in the JSON body.
    });
  });
}

export interface MockTaskFixture {
  readonly taskId: string;
  readonly displayName?: string;
  readonly currentStage: string;
  readonly status?: string;
}

function taskDto(task: MockTaskFixture): unknown {
  const now = new Date().toISOString();
  return {
    taskId: task.taskId,
    ownerUserId: 'e2e-owner',
    bindingId: `${task.taskId}-binding`,
    progress: {
      taskFolder: task.taskId,
      ...(task.displayName !== undefined ? { displayName: task.displayName } : {}),
      currentStage: task.currentStage,
      ...(task.status !== undefined ? { status: task.status } : {}),
      createdAt: now,
      updatedAt: now,
    },
    latestRound: {
      roundId: `${task.taskId}-round-1`,
      stage: task.currentStage,
      startedAt: now,
      completedAt: now,
      summary: '2/3',
    },
  };
}

/**
 * GET/POST /v1/tasks — the Part 7 task list and creation form. POST honors
 * the SandboxBinding request shape by validating `sandboxId` is non-empty
 * (mirroring the contract's typed `sandboxBindingInvalid`), then appends the
 * created task so a subsequent GET/list-refresh reflects it.
 */
export async function mockListTasks(page: Page, initialTasks: readonly MockTaskFixture[]): Promise<void> {
  const tasks = [...initialTasks];
  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/tasks`, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await json(route, 200, tasks.map(taskDto));
      return;
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON() as {
        request: string;
        displayName?: string;
        sandboxBinding: { sandboxId: string };
      };
      // The form's "Create task" button is disabled while sandboxId is
      // blank (client-side validation), so a dedicated sentinel value is
      // used here to reach the CONTRACT's server-side typed rejection path
      // (e.g. a sandbox id the control plane cannot reach/create).
      if (body.sandboxBinding.sandboxId.trim() === 'reject-me') {
        await json(route, 422, {
          code: 'sandboxBindingInvalid',
          message: 'sandbox unreachable',
        });
        return;
      }
      const created: MockTaskFixture = {
        taskId: `e2e-task-${tasks.length + 1}`,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        currentStage: 'planning',
      };
      tasks.push(created);
      await json(route, 200, taskDto(created));
      return;
    }
    await route.fallback();
  });

  // GET /v1/tasks/:id and .../history — the Part 7 task detail screen. Only
  // handles exactly those two shapes; anything else (`/chat`, `/gates`,
  // `/files`, ...) falls back so it composes with the other mock* helpers
  // registered for the same taskId in a single test.
  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/tasks/**`, async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const isTask = segments.length === 3;
    const isHistory = segments.length === 4 && segments[3] === 'history';
    if (!isTask && !isHistory) {
      await route.fallback();
      return;
    }
    const taskId = decodeURIComponent(segments[2] ?? '');
    const task = tasks.find((t) => t.taskId === taskId);
    if (task === undefined) {
      await json(route, 404, { code: 'notFound', message: `no such task: ${taskId}` });
      return;
    }
    if (isHistory) {
      await json(route, 200, [
        {
          roundId: `${taskId}-round-1`,
          stage: task.currentStage,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          summary: '2/3',
        },
      ]);
      return;
    }
    await json(route, 200, taskDto(task));
  });
}

/** POST /v1/tasks/:id/chat and GET .../gates — the Part 9 chat + gate flow. */
export async function mockChatAndGates(
  page: Page,
  taskId: string,
  fixtures: {
    readonly turns: readonly {
      readonly turnId: string;
      readonly role: 'user' | 'assistant' | 'system';
      readonly text?: string;
    }[];
    readonly gates: readonly { readonly gateId: string; readonly state: 'pending' | 'approved' | 'rejected'; readonly summary: string }[];
  }
): Promise<void> {
  const now = new Date().toISOString();

  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/tasks/${encodeURIComponent(taskId)}/chat`, async (route) => {
    if (route.request().method() === 'GET') {
      await json(
        route,
        200,
        fixtures.turns.map((turn) => ({ ...turn, at: now }))
      );
      return;
    }
    await json(route, 200, undefined);
  });

  const gateStates = new Map(fixtures.gates.map((gate) => [gate.gateId, gate.state]));
  // Idempotency: replaying the same key returns the same stored outcome,
  // exercising the same contract guarantee the client relies on (Part 9).
  const decisionsByKey = new Map<string, { readonly state: 'approved' | 'rejected'; readonly decidedAt: string }>();

  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/tasks/${encodeURIComponent(taskId)}/gates`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await json(
      route,
      200,
      fixtures.gates.map((gate) => ({
        gateId: gate.gateId,
        taskId,
        state: gateStates.get(gate.gateId) ?? gate.state,
        summary: gate.summary,
        requestedAt: now,
        ...(gateStates.get(gate.gateId) !== 'pending' ? { decidedAt: now } : {}),
      }))
    );
  });

  await page.route(`${MOCK_CONTROL_PLANE_URL}/v1/gates/*/decision`, async (route) => {
    const url = new URL(route.request().url());
    const gateId = decodeURIComponent(url.pathname.split('/').slice(-2)[0] ?? '');
    const body = route.request().postDataJSON() as { decision: 'approve' | 'reject'; idempotencyKey: string };
    const existing = decisionsByKey.get(body.idempotencyKey);
    if (existing !== undefined) {
      await json(route, 200, { gateId, state: existing.state, decidedAt: existing.decidedAt, replayed: true });
      return;
    }
    const state = body.decision === 'approve' ? 'approved' : 'rejected';
    const decidedAt = new Date().toISOString();
    decisionsByKey.set(body.idempotencyKey, { state, decidedAt });
    gateStates.set(gateId, state);
    await json(route, 200, { gateId, state, decidedAt, replayed: false });
  });
}

export interface MockFileFixture {
  readonly path: string;
  readonly text: string;
  readonly language?: string;
}

/**
 * GET .../files, .../file, .../diff — the Part 10 read-only viewer.
 *
 * Dispatches on the exact pathname suffix (not three separate glob routes):
 * a glob route for `.../file*` also matches `.../files?path=...` (the `*`
 * swallows the trailing `s?path=...`), which silently misrouted the file
 * listing into the single-file handler — one route with an exact-pathname
 * switch avoids that overlap entirely.
 */
export async function mockFilesAndDiff(
  page: Page,
  taskId: string,
  fixtures: { readonly root: readonly { readonly name: string; readonly kind: 'file' | 'directory' }[]; readonly files: readonly MockFileFixture[]; readonly diff: string }
): Promise<void> {
  const base = `/v1/tasks/${encodeURIComponent(taskId)}`;

  await page.route(`${MOCK_CONTROL_PLANE_URL}${base}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `${base}/files`) {
      await json(route, 200, fixtures.root);
      return;
    }
    if (url.pathname === `${base}/file`) {
      const path = url.searchParams.get('path') ?? '';
      const file = fixtures.files.find((f) => f.path === path);
      if (file === undefined) {
        await json(route, 404, { code: 'notFound', message: `no such file: ${path}` });
        return;
      }
      await json(route, 200, {
        path: file.path,
        text: file.text,
        ...(file.language !== undefined ? { language: file.language } : {}),
      });
      return;
    }
    if (url.pathname === `${base}/diff`) {
      await json(route, 200, { unifiedDiff: fixtures.diff });
      return;
    }
    await route.fallback();
  });
}
