/**
 * CLI subscription login, in-sandbox (plan continuation, 2026-09-10):
 * bridges the two pieces built earlier today — interactive sandbox sessions
 * (`SandboxClientV1.createInteractiveSession`) and the per-user persistent
 * sandbox (`user-owned-managed`) — into an actual two-step HTTP flow: start
 * the CLI's own login command inside the user's persistent sandbox, relay
 * the printed authorization URL, accept the code the user pastes back after
 * completing it in their own browser, and report whether it succeeded.
 *
 * The command is `claude auth login` (Claude Code 2.1.267, confirmed live on
 * the real box 2026-09-10): with a TTY (`createInteractiveSession`'s own
 * fix) it prints a real OAuth URL and a "Paste code here if prompted >"
 * prompt, and on success PERSISTS the login in the sandbox's own
 * `~/.claude` — which is the whole point, since that is what a later
 * `claude -p` round (`sandboxCliRunnerV1.ts`) authenticates with. It was
 * first built on `claude setup-token`, which has the same URL+code shape
 * but persists NOTHING: it only prints a long-lived token meant for a
 * `CLAUDE_CODE_OAUTH_TOKEN` env var, so a sandbox "logged in" that way
 * still reported `Not logged in · Please run /login` afterwards.
 *
 * SECURITY: output captured after the code is submitted is treated as if it
 * may contain secret material (`setup-token` literally printed the token;
 * `auth login` prints account details). `startLogin`'s output (a URL and a
 * prompt) is safe to return; `submitCode` deliberately returns NOTHING from
 * the captured output — only a structured completed/success verdict — so
 * nothing the CLI prints reaches an HTTP response body, a log line, or a
 * client that might display or store it verbatim. What the CLI persists
 * stays inside that user's sandbox; this module never reads, stores, or
 * transmits it.
 *
 * NOT under the Part 4c attempt-record protocol, matching
 * `createInteractiveSession`'s own documented scope decision: a login
 * depends on a human completing something in the real world within an
 * open-ended window. State here is in-memory and per-process — a restart
 * during a login simply means the user starts over, an acceptable loss for
 * an interactive flow with no durable side effect yet (nothing is written
 * to the store until/unless a future step needs to record login status).
 */
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type {
  InteractiveSessionHandleV1,
  SandboxClientV1,
} from "../../ensemble-engine/src/sandboxClientV1";

/** The one CLI login command this module knows how to drive — the persisting one (see the header). */
const CLAUDE_AUTH_LOGIN_ARGV_V1 = ["claude", "auth", "login"] as const;

/** How long to watch output before answering — tuned to real observed latency, not a guess. */
const DEFAULT_CAPTURE_WINDOW_MS_V1 = 4000;
/**
 * How long a started-but-abandoned login session is kept alive before being
 * killed and forgotten. 15 minutes, not 5: the first live run (2026-09-10)
 * lost a real login because the human round-trip — open the URL, sign in,
 * copy the code, paste it into a client — took longer than 5 minutes, and
 * the code is bound to that session's PKCE challenge, so a late code is
 * unusable rather than merely slow. OAuth authorization codes themselves
 * are typically good for ~10 minutes, so anything shorter than that just
 * throws away logins the provider would still have accepted.
 */
const DEFAULT_SESSION_TTL_MS_V1 = 15 * 60 * 1000;

/** Relayed prompt output past this is dropped: the prompt is a URL and one line, never megabytes. */
const MAX_CAPTURED_OUTPUT_CHARS_V1 = 64 * 1024;
/** Concurrent sign-ins across ALL users — each one is a live process on the host. */
const DEFAULT_MAX_CONCURRENT_SESSIONS_V1 = 8;

interface CliLoginSessionRecordV1 {
  readonly loginSessionId: string;
  readonly ownerUserId: string;
  readonly sandboxId: string;
  readonly handle: InteractiveSessionHandleV1;
  output: string;
  ttlTimer: ReturnType<typeof setTimeout>;
}

export interface StartCliLoginInputV1 {
  readonly ownerUserId: string;
  readonly client: SandboxClientV1;
  readonly sandboxId: string;
  readonly workingDirectoryRoot: string;
}

export type StartCliLoginResultV1 =
  | { readonly ok: true; readonly loginSessionId: string; readonly promptOutput: string }
  | {
      readonly ok: false;
      readonly code: "interactiveSessionsUnsupported" | "loginSessionStartFailed" | "tooManyLoginSessions";
    };

export type SubmitCliLoginCodeResultV1 =
  | { readonly ok: true; readonly completed: false }
  | { readonly ok: true; readonly completed: true; readonly success: boolean }
  | { readonly ok: false; readonly code: "loginSessionNotFound" };

export interface CliLoginServiceV1 {
  startLogin(input: StartCliLoginInputV1): Promise<StartCliLoginResultV1>;
  submitCode(
    ownerUserId: string,
    loginSessionId: string,
    code: string
  ): Promise<SubmitCliLoginCodeResultV1>;
  /**
   * End every login session this user has in `sandboxId` (the sandbox is
   * about to be destroyed): their processes go with it, so nothing may be
   * left to time out against a container that no longer exists.
   */
  cancelForSandbox(ownerUserId: string, sandboxId: string): Promise<void>;
}

export interface CreateCliLoginServiceOptionsV1 {
  readonly captureWindowMs?: number;
  readonly sessionTtlMs?: number;
  readonly maxConcurrentSessions?: number;
}

export function createCliLoginServiceV1(options?: CreateCliLoginServiceOptionsV1): CliLoginServiceV1 {
  const captureWindowMs = options?.captureWindowMs ?? DEFAULT_CAPTURE_WINDOW_MS_V1;
  const sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS_V1;
  const maxConcurrent = options?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS_V1;
  const sessions = new Map<string, CliLoginSessionRecordV1>();
  /** Starts in flight, counted against the global cap before they have a record. */
  let starting = 0;
  /**
   * Users with a start in flight. "One sign-in per user" was only checked
   * BEFORE the slow session creation, so two concurrent starts from one
   * user both passed it (review lead, 2026-09-11). A second start while one
   * is being created is refused; once created, a later start supersedes it
   * as before.
   */
  const startingUsers = new Set<string>();

  function forget(loginSessionId: string): void {
    const record = sessions.get(loginSessionId);
    if (record === undefined) {
      return;
    }
    clearTimeout(record.ttlTimer);
    sessions.delete(loginSessionId);
  }

  /**
   * Stop and forget one session. Never throws and never leaves a rejected
   * promise behind: this runs from timers and from other requests, where
   * an escaped rejection would terminate the whole process (review
   * finding, 2026-09-11 — the TTL timer used to fire-and-forget `kill()`).
   */
  async function end(record: CliLoginSessionRecordV1): Promise<void> {
    forget(record.loginSessionId);
    try {
      await record.handle.kill();
    } catch {
      // The process or its container is already gone: nothing left to stop.
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    async startLogin(input: StartCliLoginInputV1): Promise<StartCliLoginResultV1> {
      const createSession = input.client.createInteractiveSession;
      if (createSession === undefined) {
        return { ok: false, code: "interactiveSessionsUnsupported" };
      }
      if (startingUsers.has(input.ownerUserId)) {
        return { ok: false, code: "tooManyLoginSessions" };
      }
      // Claimed synchronously, before the first await, so a concurrent start
      // from the same user sees it.
      startingUsers.add(input.ownerUserId);
      try {
        // One sign-in per user at a time: a new start supersedes any earlier
        // one, whose process is stopped rather than left for its TTL.
        for (const existing of [...sessions.values()]) {
          if (existing.ownerUserId === input.ownerUserId) {
            await end(existing);
          }
        }
        if (sessions.size + starting >= maxConcurrent) {
          return { ok: false, code: "tooManyLoginSessions" };
        }
        return await startFresh(input, createSession);
      } finally {
        startingUsers.delete(input.ownerUserId);
      }
    },

    async submitCode(
      ownerUserId: string,
      loginSessionId: string,
      code: string
    ): Promise<SubmitCliLoginCodeResultV1> {
      return submit(ownerUserId, loginSessionId, code);
    },

    async cancelForSandbox(ownerUserId: string, sandboxId: string): Promise<void> {
      for (const record of [...sessions.values()]) {
        if (record.ownerUserId === ownerUserId && record.sandboxId === sandboxId) {
          await end(record);
        }
      }
    },
  };

  async function startFresh(
    input: StartCliLoginInputV1,
    createSession: NonNullable<SandboxClientV1["createInteractiveSession"]>
  ): Promise<StartCliLoginResultV1> {
    const loginSessionId = allocateHex128IdV1();
    let output = "";
    let handle: InteractiveSessionHandleV1;
    starting += 1;
    try {
      // The handle exists BEFORE anything is published or timed: a failed
      // start leaves no record and no timer (the old order registered both
      // first, and a failed start armed a timer that later called
      // `.kill()` on `undefined`, crashing the process).
      handle = await createSession.call(input.client, {
        sandboxId: input.sandboxId,
        argv: [...CLAUDE_AUTH_LOGIN_ARGV_V1],
        cwd: input.workingDirectoryRoot,
        onOutput: (chunk) => {
          const record = sessions.get(loginSessionId);
          if (record !== undefined) {
            if (record.output.length < MAX_CAPTURED_OUTPUT_CHARS_V1) {
              record.output = (record.output + chunk).slice(0, MAX_CAPTURED_OUTPUT_CHARS_V1);
            }
          } else if (output.length < MAX_CAPTURED_OUTPUT_CHARS_V1) {
            output = (output + chunk).slice(0, MAX_CAPTURED_OUTPUT_CHARS_V1);
          }
        },
      });
    } catch {
      return { ok: false, code: "loginSessionStartFailed" };
    } finally {
      starting -= 1;
    }

    const record: CliLoginSessionRecordV1 = {
      loginSessionId,
      ownerUserId: input.ownerUserId,
      sandboxId: input.sandboxId,
      handle,
      output,
      ttlTimer: setTimeout(() => {
        const stillPending = sessions.get(loginSessionId);
        if (stillPending !== undefined) {
          void end(stillPending);
        }
      }, sessionTtlMs),
    };
    record.ttlTimer.unref?.();
    sessions.set(loginSessionId, record);
    // The exit promise is observed from the start: a stream error rejects
    // it, and a rejection nobody is awaiting yet (the user has not
    // submitted a code) would otherwise be unhandled — fatal to Node.
    handle.wait().catch(() => void end(record));

    await sleep(captureWindowMs);
    return { ok: true, loginSessionId, promptOutput: sessions.get(loginSessionId)?.output ?? record.output };
  }

  async function submit(
    ownerUserId: string,
    loginSessionId: string,
    code: string
  ): Promise<SubmitCliLoginCodeResultV1> {
    const record = sessions.get(loginSessionId);
    if (record === undefined || record.ownerUserId !== ownerUserId) {
      // Ownership failure reads identically to absence — no confirmation
      // that a login session with this id exists for a different user.
      return { ok: false, code: "loginSessionNotFound" };
    }
    try {
      await record.handle.sendInput(`${code}\n`);
    } catch {
      // The process is gone (its container too, possibly): the session is dead.
      await end(record);
      return { ok: false, code: "loginSessionNotFound" };
    }
    const exited = await Promise.race([
      record.handle.wait().then(
        (result) => ({ exited: true as const, exitCode: result.exitCode }),
        () => ({ exited: true as const, exitCode: -1 })
      ),
      sleep(captureWindowMs).then(() => ({ exited: false as const })),
    ]);
    if (!exited.exited) {
      return { ok: true, completed: false };
    }
    forget(loginSessionId);
    return { ok: true, completed: true, success: exited.exitCode === 0 };
  }
}
