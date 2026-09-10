/**
 * CLI subscription login, in-sandbox (plan continuation, 2026-09-10):
 * bridges the two pieces built earlier today — interactive sandbox sessions
 * (`SandboxClientV1.createInteractiveSession`) and the per-user persistent
 * sandbox (`user-owned-managed`) — into an actual two-step HTTP flow: start
 * the CLI's own login command inside the user's persistent sandbox, relay
 * the printed authorization URL, accept the code the user pastes back after
 * completing it in their own browser, and report whether it succeeded.
 *
 * Confirmed live against the real `claude setup-token` command on the real
 * box: with a TTY (`createInteractiveSession`'s own fix), it prints a real
 * OAuth URL and a "paste code here" prompt; the resulting long-lived token
 * is what makes the CLI usable non-interactively afterward.
 *
 * SECURITY: `claude setup-token`'s whole purpose is to PRINT that token to
 * the terminal — meaning output captured after the code is submitted may
 * contain the secret material itself. `startLogin`'s output (a URL and a
 * prompt) is safe to return; `submitCode` deliberately returns NOTHING from
 * the captured output — only a structured completed/success verdict — so
 * the token never reaches an HTTP response body, a log line, or a client
 * that might display or store it verbatim. What the sandboxed CLI does with
 * the token after printing it (persist it into its own config, export it
 * for the calling shell) is between the CLI and that sandbox; this module
 * never reads, stores, or transmits it.
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

/** The one CLI login command this module knows how to drive. */
const CLAUDE_SETUP_TOKEN_ARGV_V1 = ["claude", "setup-token"] as const;

/** How long to watch output before answering — tuned to real observed latency, not a guess. */
const DEFAULT_CAPTURE_WINDOW_MS_V1 = 4000;
/** How long a started-but-abandoned login session is kept alive before being killed and forgotten. */
const DEFAULT_SESSION_TTL_MS_V1 = 5 * 60 * 1000;

interface CliLoginSessionRecordV1 {
  readonly loginSessionId: string;
  readonly ownerUserId: string;
  handle: InteractiveSessionHandleV1;
  output: string;
  settled: boolean;
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
  | { readonly ok: false; readonly code: "interactiveSessionsUnsupported" };

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
}

export interface CreateCliLoginServiceOptionsV1 {
  readonly captureWindowMs?: number;
  readonly sessionTtlMs?: number;
}

export function createCliLoginServiceV1(options?: CreateCliLoginServiceOptionsV1): CliLoginServiceV1 {
  const captureWindowMs = options?.captureWindowMs ?? DEFAULT_CAPTURE_WINDOW_MS_V1;
  const sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS_V1;
  const sessions = new Map<string, CliLoginSessionRecordV1>();

  function forget(loginSessionId: string): void {
    const record = sessions.get(loginSessionId);
    if (record === undefined) {
      return;
    }
    clearTimeout(record.ttlTimer);
    sessions.delete(loginSessionId);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    async startLogin(input: StartCliLoginInputV1): Promise<StartCliLoginResultV1> {
      if (input.client.createInteractiveSession === undefined) {
        return { ok: false, code: "interactiveSessionsUnsupported" };
      }
      const loginSessionId = allocateHex128IdV1();
      const record: CliLoginSessionRecordV1 = {
        loginSessionId,
        ownerUserId: input.ownerUserId,
        // Real handle assigned immediately below; TypeScript needs a value
        // now, and this record is never read before that assignment lands.
        handle: undefined as unknown as InteractiveSessionHandleV1,
        output: "",
        settled: false,
        ttlTimer: setTimeout(() => {
          const stillPending = sessions.get(loginSessionId);
          if (stillPending !== undefined && !stillPending.settled) {
            void stillPending.handle.kill();
            forget(loginSessionId);
          }
        }, sessionTtlMs),
      };
      record.ttlTimer.unref?.();
      sessions.set(loginSessionId, record);

      record.handle = await input.client.createInteractiveSession({
        sandboxId: input.sandboxId,
        argv: [...CLAUDE_SETUP_TOKEN_ARGV_V1],
        cwd: input.workingDirectoryRoot,
        onOutput: (chunk) => {
          record.output += chunk;
        },
      });
      await sleep(captureWindowMs);
      return { ok: true, loginSessionId, promptOutput: record.output };
    },

    async submitCode(
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
      await record.handle.sendInput(`${code}\n`);
      const exited = await Promise.race([
        record.handle.wait().then((result) => ({ exited: true as const, exitCode: result.exitCode })),
        sleep(captureWindowMs).then(() => ({ exited: false as const })),
      ]);
      if (!exited.exited) {
        return { ok: true, completed: false };
      }
      record.settled = true;
      forget(loginSessionId);
      return { ok: true, completed: true, success: exited.exitCode === 0 };
    },
  };
}
