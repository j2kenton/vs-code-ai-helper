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
