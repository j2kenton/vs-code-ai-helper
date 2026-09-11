/**
 * Coverage for `createCliLoginServiceV1`: the two-step "start the CLI's own
 * login inside the sandbox, relay the prompt, accept the pasted code, report
 * completion" flow. The one property enforced hardest here is the security
 * one documented on the module itself: `submitCode`'s result NEVER carries
 * captured output text — whatever the CLI prints after the code goes in
 * (account details today; the literal token under the `setup-token`
 * command this was first built on) must never reach a response body.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCliLoginServiceV1 } from "../src/cliLoginSessionsV1";
import type {
  InteractiveSessionHandleV1,
  InteractiveSessionRequestV1,
  InteractiveSessionResultV1,
  SandboxClientV1,
} from "../../ensemble-engine/src/sandboxClientV1";

/** A scriptable fake interactive session: reacts to sendInput, resolves wait() on demand. */
function makeFakeClient(options: {
  readonly promptText: string;
  /** Called with the submitted code; returns what to do next. */
  readonly onCode?: (code: string) => { readonly output?: string; readonly exit?: number };
  /** If true, the client has no interactive-session support at all. */
  readonly unsupported?: boolean;
}): { client: SandboxClientV1; sentInputs: string[] } {
  const sentInputs: string[] = [];
  let exitResolvers: ((result: InteractiveSessionResultV1) => void) | undefined;
  const exited = new Promise<InteractiveSessionResultV1>((resolve) => {
    exitResolvers = resolve;
  });

  const client: SandboxClientV1 = {
    provider: "docker",
    createSandbox: () => Promise.resolve({ sandboxId: "sbx-1" }),
    destroySandbox: () => Promise.resolve(),
    runCommand: () => Promise.reject(new Error("not used in this test")),
    resolveRealPath: () => Promise.resolve(undefined),
    writeFile: () => Promise.resolve(),
    deleteFile: () => Promise.resolve(),
    readFileUtf8: () => Promise.resolve(undefined),
    listDirectory: () => Promise.resolve(undefined),
    findCommandByAttemptKey: () => Promise.resolve("unknown"),
    ...(options.unsupported === true
      ? {}
      : {
          createInteractiveSession: (
            request: InteractiveSessionRequestV1
          ): Promise<InteractiveSessionHandleV1> => {
            request.onOutput(options.promptText);
            const handle: InteractiveSessionHandleV1 = {
              sendInput: (data: string) => {
                sentInputs.push(data);
                const code = data.trimEnd();
                const reaction = options.onCode?.(code) ?? {};
                if (reaction.output !== undefined) {
                  request.onOutput(reaction.output);
                }
                if (reaction.exit !== undefined) {
                  exitResolvers?.({ exitCode: reaction.exit });
                }
                return Promise.resolve();
              },
              wait: () => exited,
              kill: () => Promise.resolve(),
            };
            return Promise.resolve(handle);
          },
        }),
  };
  return { client, sentInputs };
}

test("startLogin returns the captured prompt (URL + instructions) and a session id", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 10 });
  const { client } = makeFakeClient({ promptText: "Visit https://example.com/authorize and paste the code" });

  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });

  assert.ok(started.ok);
  assert.ok(started.ok && started.loginSessionId.length > 0);
  assert.ok(started.ok && started.promptOutput.includes("https://example.com/authorize"));
});

test("startLogin reports interactiveSessionsUnsupported for a client without the capability, rather than throwing", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 10 });
  const { client } = makeFakeClient({ promptText: "", unsupported: true });

  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });

  assert.deepEqual(started, { ok: false, code: "interactiveSessionsUnsupported" });
});

test("submitCode: a successful completion reports completed+success with NO captured output in the result", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 30 });
  const { client, sentInputs } = makeFakeClient({
    promptText: "paste code:",
    onCode: (code) =>
      code === "the-real-secret-token-xyz"
        ? { output: "Token: the-real-secret-token-xyz\nLogin successful", exit: 0 }
        : { exit: 1 },
  });
  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });
  assert.ok(started.ok);

  const result = await service.submitCode(
    "user-a",
    started.ok ? started.loginSessionId : "",
    "the-real-secret-token-xyz"
  );

  assert.deepEqual(result, { ok: true, completed: true, success: true });
  // The security property: nowhere in the result does the captured
  // post-code output (which may itself BE the secret token) appear.
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.deepEqual(sentInputs, ["the-real-secret-token-xyz\n"]);
});

test("submitCode: a non-zero exit reports completed but success:false, still no output leaked", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 30 });
  const { client } = makeFakeClient({
    promptText: "paste code:",
    onCode: () => ({ output: "Error: invalid code", exit: 1 }),
  });
  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });
  assert.ok(started.ok);

  const result = await service.submitCode("user-a", started.ok ? started.loginSessionId : "", "wrong-code");
  assert.deepEqual(result, { ok: true, completed: true, success: false });
});

test("submitCode: still running after the capture window reports completed:false, not an error", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 20 });
  const { client } = makeFakeClient({ promptText: "paste code:" }); // onCode never resolves exit
  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });
  assert.ok(started.ok);

  const result = await service.submitCode("user-a", started.ok ? started.loginSessionId : "", "some-code");
  assert.deepEqual(result, { ok: true, completed: false });
});

test("submitCode: an unknown or foreign-owned session id reads identically as not found", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 10 });
  const { client } = makeFakeClient({ promptText: "paste code:", onCode: () => ({ exit: 0 }) });
  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });
  assert.ok(started.ok);
  const loginSessionId = started.ok ? started.loginSessionId : "";

  const unknown = await service.submitCode("user-a", "not-a-real-id", "code");
  assert.deepEqual(unknown, { ok: false, code: "loginSessionNotFound" });

  const foreignUser = await service.submitCode("user-b", loginSessionId, "code");
  assert.deepEqual(foreignUser, { ok: false, code: "loginSessionNotFound" });
});

/** A client whose interactive sessions are scripted per test; records what was killed. */
function makeScriptedClient(options: {
  readonly failStart?: boolean;
  readonly killRejects?: boolean;
}): { client: SandboxClientV1; killedSandboxes: string[]; started: number } {
  const state = { killedSandboxes: [] as string[], started: 0 };
  const client: SandboxClientV1 = {
    provider: "docker",
    createSandbox: () => Promise.resolve({ sandboxId: "sbx-1" }),
    destroySandbox: () => Promise.resolve(),
    runCommand: () => Promise.reject(new Error("not used")),
    resolveRealPath: () => Promise.resolve(undefined),
    writeFile: () => Promise.resolve(),
    deleteFile: () => Promise.resolve(),
    readFileUtf8: () => Promise.resolve(undefined),
    listDirectory: () => Promise.resolve(undefined),
    findCommandByAttemptKey: () => Promise.resolve("unknown"),
    createInteractiveSession: (request: InteractiveSessionRequestV1) => {
      if (options.failStart === true) {
        return Promise.reject(new Error("OCI runtime exec failed: chdir: no such file or directory"));
      }
      state.started += 1;
      request.onOutput("paste code:");
      const handle: InteractiveSessionHandleV1 = {
        sendInput: () => Promise.resolve(),
        wait: () => new Promise(() => undefined),
        kill: () => {
          state.killedSandboxes.push(request.sandboxId);
          return options.killRejects === true
            ? Promise.reject(new Error("no such container"))
            : Promise.resolve();
        },
      };
      return Promise.resolve(handle);
    },
  };
  return {
    client,
    get killedSandboxes() {
      return state.killedSandboxes;
    },
    get started() {
      return state.started;
    },
  };
}

/** Run `body` and fail if it (or anything it leaves behind) produces an unhandled rejection. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(escaped, [], "an unhandled rejection would terminate the control plane");
}

test("a failed start returns a typed error and leaves no session or timer behind (it used to crash the process at TTL)", async () => {
  await withoutUnhandledRejections(async () => {
    const service = createCliLoginServiceV1({ captureWindowMs: 5, sessionTtlMs: 15 });
    const { client } = makeScriptedClient({ failStart: true });
    const started = await service.startLogin({ ownerUserId: "user-a", client, sandboxId: "sbx-1", workingDirectoryRoot: "/nope" });
    assert.deepEqual(started, { ok: false, code: "loginSessionStartFailed" });
    // Past the TTL: before the fix, the orphaned timer called .kill() on undefined here.
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

test("a TTL kill that rejects (container already gone) is contained, never an unhandled rejection", async () => {
  await withoutUnhandledRejections(async () => {
    const service = createCliLoginServiceV1({ captureWindowMs: 5, sessionTtlMs: 15 });
    const scripted = makeScriptedClient({ killRejects: true });
    const started = await service.startLogin({ ownerUserId: "user-a", client: scripted.client, sandboxId: "sbx-1", workingDirectoryRoot: "/" });
    assert.ok(started.ok);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(scripted.killedSandboxes, ["sbx-1"]);
    const late = await service.submitCode("user-a", started.ok ? started.loginSessionId : "", "code");
    assert.deepEqual(late, { ok: false, code: "loginSessionNotFound" });
  });
});

test("one sign-in per user: a new start stops the earlier one; a global cap bounds live processes", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 1, sessionTtlMs: 60_000, maxConcurrentSessions: 2 });
  const scripted = makeScriptedClient({});
  const input = (ownerUserId: string, sandboxId: string) => ({
    ownerUserId,
    client: scripted.client,
    sandboxId,
    workingDirectoryRoot: "/",
  });

  const first = await service.startLogin(input("user-a", "sbx-a"));
  const second = await service.startLogin(input("user-a", "sbx-a"));
  assert.ok(first.ok && second.ok);
  assert.deepEqual(scripted.killedSandboxes, ["sbx-a"], "the superseded sign-in's process was stopped");
  const stale = await service.submitCode("user-a", first.ok ? first.loginSessionId : "", "code");
  assert.deepEqual(stale, { ok: false, code: "loginSessionNotFound" });

  const otherUser = await service.startLogin(input("user-b", "sbx-b"));
  assert.ok(otherUser.ok);
  const overCap = await service.startLogin(input("user-c", "sbx-c"));
  assert.deepEqual(overCap, { ok: false, code: "tooManyLoginSessions" });
  assert.equal(scripted.started, 3, "the refused start never created a process");

  // Resetting a sandbox ends the sign-ins inside it.
  await service.cancelForSandbox("user-b", "sbx-b");
  assert.deepEqual(scripted.killedSandboxes, ["sbx-a", "sbx-b"]);
  assert.ok((await service.startLogin(input("user-c", "sbx-c"))).ok, "the freed slot is usable");
});

test("two CONCURRENT starts from one user cannot both get through (one-per-user holds across the slow create)", async () => {
  const service = createCliLoginServiceV1({ captureWindowMs: 1, sessionTtlMs: 60_000 });
  const scripted = makeScriptedClient({});
  const input = { ownerUserId: "user-a", client: scripted.client, sandboxId: "sbx-a", workingDirectoryRoot: "/" };

  const [first, second] = await Promise.all([service.startLogin(input), service.startLogin(input)]);

  assert.equal([first, second].filter((result) => result.ok).length, 1, "exactly one start wins");
  assert.deepEqual([first, second].find((result) => !result.ok), { ok: false, code: "tooManyLoginSessions" });
  assert.equal(scripted.started, 1, "only one sign-in process was created");
});

test("an abandoned session is killed and forgotten after its TTL, so a late code submission reads as not found", async () => {
  let killed = false;
  const client: SandboxClientV1 = {
    provider: "docker",
    createSandbox: () => Promise.resolve({ sandboxId: "sbx-1" }),
    destroySandbox: () => Promise.resolve(),
    runCommand: () => Promise.reject(new Error("not used")),
    resolveRealPath: () => Promise.resolve(undefined),
    writeFile: () => Promise.resolve(),
    deleteFile: () => Promise.resolve(),
    readFileUtf8: () => Promise.resolve(undefined),
    listDirectory: () => Promise.resolve(undefined),
    findCommandByAttemptKey: () => Promise.resolve("unknown"),
    createInteractiveSession: (request: InteractiveSessionRequestV1) => {
      request.onOutput("paste code:");
      const handle: InteractiveSessionHandleV1 = {
        sendInput: () => Promise.resolve(),
        wait: () => new Promise(() => undefined), // never resolves
        kill: () => {
          killed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(handle);
    },
  };

  const service = createCliLoginServiceV1({ captureWindowMs: 5, sessionTtlMs: 15 });
  const started = await service.startLogin({
    ownerUserId: "user-a",
    client,
    sandboxId: "sbx-1",
    workingDirectoryRoot: "/",
  });
  assert.ok(started.ok);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(killed, true);

  const late = await service.submitCode("user-a", started.ok ? started.loginSessionId : "", "too-late");
  assert.deepEqual(late, { ok: false, code: "loginSessionNotFound" });
});
