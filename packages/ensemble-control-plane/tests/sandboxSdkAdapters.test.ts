/**
 * SDK-backed E2B / Daytona sandbox adapter tests (plan Part 5's remaining
 * integration item).
 *
 * These inject fakes through the `factory` DI seam (`E2bSandboxFactoryV1` /
 * `DaytonaSandboxFactoryV1`) so no real network call is made, and pin the
 * SAME outcome discipline the fetch-based reference adapters already prove:
 * the attempt-key marker rides both the command line and request metadata,
 * a `CommandExitError` (E2B) or a non-zero `executeCommand` exit (Daytona) is
 * a valid result — never a thrown transport failure — an unrecognized
 * transport error still propagates (leaving the attempt open for 4c
 * recovery), symlink/real-path resolution is fail-closed, and reconciliation
 * returns `"unknown"` rather than fabricating a verdict when provider state
 * cannot prove either way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SANDBOX_ATTEMPT_KEY_MARKER_V1 } from "../../ensemble-engine/src/sandboxClientV1";
import {
  createDaytonaSdkSandboxClientV1,
  createE2bSdkSandboxClientV1,
  DaytonaSandboxFactoryV1,
  DaytonaSandboxHandleV1,
  E2bSandboxFactoryV1,
  E2bSandboxHandleV1,
  runE2bCommandCatchingExitV1,
} from "../src/sandboxSdkAdaptersV1";

const API_KEY = "sk-sandbox-secret-0001";
const ATTEMPT_KEY = "ab".repeat(32);
const SANDBOX_ID = "sbx-1";

// ─── E2B fakes ──────────────────────────────────────────────────────────

interface FakeE2bFileV1 {
  type: "file" | "dir" | "symlink";
  symlinkTarget?: string;
}

function makeFakeE2bFactoryV1(): {
  readonly factory: E2bSandboxFactoryV1;
  readonly files: Map<string, FakeE2bFileV1>;
  readonly killed: string[];
  runResult: { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | Error;
  runCalls: Array<{ readonly cmd: string; readonly cwd: string; readonly envs: Record<string, string> }>;
  processes: Array<{ readonly tag?: string; readonly envs?: Record<string, string> }>;
} {
  const files = new Map<string, FakeE2bFileV1>();
  const killed: string[] = [];
  const runCalls: Array<{ cmd: string; cwd: string; envs: Record<string, string> }> = [];
  const state = {
    files,
    killed,
    runResult: { exitCode: 0, stdout: "ok", stderr: "" } as
      | { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
      | Error,
    runCalls,
    processes: [] as Array<{ tag?: string; envs?: Record<string, string> }>,
  };

  function handleFor(sandboxId: string): E2bSandboxHandleV1 {
    return {
      sandboxId,
      files: {
        async write(path, data) {
          files.set(path, { type: "file" });
          void data;
        },
        async remove(path) {
          files.delete(path);
        },
        async read(path) {
          if (!files.has(path)) {
            throw new Error("not found");
          }
          return "content";
        },
        async list() {
          return [...files.entries()].map(([name, entry]) => ({ name, type: entry.type }));
        },
        async getInfo(path) {
          const entry = files.get(path);
          if (entry === undefined) {
            const { NotFoundError } = await import("e2b");
            throw new NotFoundError("not found");
          }
          return { path, type: entry.type, symlinkTarget: entry.symlinkTarget };
        },
      },
      commands: {
        async run(cmd, opts) {
          runCalls.push({ cmd, cwd: opts.cwd, envs: { ...opts.envs } });
          if (state.runResult instanceof Error) {
            throw state.runResult;
          }
          return state.runResult;
        },
        async list() {
          return state.processes;
        },
      },
    };
  }

  const factory: E2bSandboxFactoryV1 = {
    async create(templateId, apiKey) {
      void templateId;
      void apiKey;
      return handleFor(SANDBOX_ID);
    },
    async connect(sandboxId) {
      return handleFor(sandboxId);
    },
    async kill(sandboxId) {
      killed.push(sandboxId);
      return true;
    },
  };

  // `runResult` must write THROUGH to `state`, which is what the fake command
  // handler reads. Returning `state.runResult` handed back a snapshot of the
  // default instead, so every `fake.runResult = ...` assignment landed on a
  // dead property and the fake kept replying with its success default —
  // silently disabling the exit-code and transport-error tests below.
  return {
    factory,
    files,
    killed,
    runCalls,
    processes: state.processes,
    get runResult() {
      return state.runResult;
    },
    set runResult(next) {
      state.runResult = next;
    },
  };
}

test("E2B SDK adapter: runCommand marks the command line and envs, and tails output", async () => {
  const fake = makeFakeE2bFactoryV1();
  const client = createE2bSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  const result = await client.runCommand({
    sandboxId: SANDBOX_ID,
    argv: ["git", "status"],
    cwd: "/workspace/repo",
    attemptKey: ATTEMPT_KEY,
  });

  assert.deepEqual(result, { exitCode: 0, stdoutTail: "ok", stderrTail: "" });
  assert.equal(fake.runCalls.length, 1);
  const call = fake.runCalls[0]!;
  assert.ok(call.cmd.startsWith(`${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${ATTEMPT_KEY}'`));
  assert.ok(call.cmd.endsWith("'git' 'status'"));
  assert.equal(call.cwd, "/workspace/repo");
  assert.equal(call.envs[SANDBOX_ATTEMPT_KEY_MARKER_V1], ATTEMPT_KEY);
});

// Exercised as a function rather than through the client, because the
// translation sits BELOW the `factory` seam: a fake factory hands back an
// already-translated handle, so a client-level assertion would test the fake's
// imitation of E2B rather than the adapter. Asserting through the client here
// is what made this test fail unconditionally — `runCommand` does not catch,
// and never needed to, since `wrapE2bSandbox` already had.
test("E2B SDK adapter: a CommandExitError is a valid result, not a thrown transport failure", async () => {
  const { CommandExitError } = await import("e2b");
  const result = await runE2bCommandCatchingExitV1(() => {
    throw new CommandExitError({ exitCode: 7, stdout: "partial", stderr: "boom", error: "boom" });
  });
  assert.deepEqual(result, { exitCode: 7, stdout: "partial", stderr: "boom" });
});

test("E2B SDK adapter: a non-exit error is NOT translated into a result", async () => {
  await assert.rejects(
    runE2bCommandCatchingExitV1(() => {
      throw new Error("socket hang up");
    }),
    /socket hang up/
  );
});

test("E2B SDK adapter: a non-exit transport error propagates (leaves the attempt open)", async () => {
  const fake = makeFakeE2bFactoryV1();
  fake.runResult = new Error("socket hang up");
  const client = createE2bSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  await assert.rejects(
    client.runCommand({
      sandboxId: SANDBOX_ID,
      argv: ["true"],
      cwd: "/workspace",
      attemptKey: ATTEMPT_KEY,
    }),
    /socket hang up/
  );
});

test("E2B SDK adapter: resolveRealPath follows a symlink chain and fails closed on a missing path", async () => {
  const fake = makeFakeE2bFactoryV1();
  fake.files.set("/workspace/link", { type: "symlink", symlinkTarget: "real" });
  fake.files.set("/workspace/real", { type: "file" });
  const client = createE2bSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  assert.equal(await client.resolveRealPath(SANDBOX_ID, "/workspace/link"), "/workspace/real");
  assert.equal(await client.resolveRealPath(SANDBOX_ID, "/workspace/missing"), undefined);
});

test("E2B SDK adapter: findCommandByAttemptKey matches on tag or env marker, else unknown", async () => {
  const fake = makeFakeE2bFactoryV1();
  const client = createE2bSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  assert.equal(await client.findCommandByAttemptKey(SANDBOX_ID, ATTEMPT_KEY), "unknown");

  fake.processes.push({ envs: { [SANDBOX_ATTEMPT_KEY_MARKER_V1]: ATTEMPT_KEY } });
  assert.equal(await client.findCommandByAttemptKey(SANDBOX_ID, ATTEMPT_KEY), "executed");
});

test("E2B SDK adapter: destroySandbox kills through the factory", async () => {
  const fake = makeFakeE2bFactoryV1();
  const client = createE2bSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });
  await client.destroySandbox(SANDBOX_ID);
  assert.deepEqual(fake.killed, [SANDBOX_ID]);
});

// ─── Daytona fakes ──────────────────────────────────────────────────────

function makeFakeDaytonaFactoryV1(): {
  readonly factory: DaytonaSandboxFactoryV1;
  readonly files: Map<string, { readonly isDir: boolean; readonly size: number; content?: string }>;
  readonly destroyed: string[];
  execResult: { readonly exitCode: number; readonly result: string } | Error;
  execCalls: Array<{ readonly command: string; readonly cwd?: string; readonly env?: Record<string, string> }>;
  sessions: Array<{ commands?: Array<{ command?: string }> }>;
} {
  const files = new Map<string, { isDir: boolean; size: number; content?: string }>();
  const destroyed: string[] = [];
  const execCalls: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
  const state = {
    execResult: { exitCode: 0, result: "ok" } as { readonly exitCode: number; readonly result: string } | Error,
    sessions: [] as Array<{ commands?: Array<{ command?: string }> }>,
  };

  function handleFor(sandboxId: string): DaytonaSandboxHandleV1 {
    return {
      id: sandboxId,
      fs: {
        async uploadFile(file, remotePath) {
          files.set(remotePath, { isDir: false, size: file.length, content: file.toString("utf8") });
        },
        async deleteFile(path) {
          files.delete(path);
        },
        async downloadFile(remotePath) {
          const entry = files.get(remotePath);
          if (entry === undefined || entry.content === undefined) {
            throw new Error("not found");
          }
          return Buffer.from(entry.content, "utf8");
        },
        async listFiles(path) {
          void path;
          return [...files.entries()].map(([name, entry]) => ({
            name,
            isDir: entry.isDir,
            size: entry.size,
          }));
        },
      },
      process: {
        async executeCommand(command, cwd, env) {
          execCalls.push({ command, cwd, env: env === undefined ? undefined : { ...env } });
          if (state.execResult instanceof Error) {
            throw state.execResult;
          }
          return state.execResult;
        },
        async listSessions() {
          return state.sessions;
        },
      },
    };
  }

  const factory: DaytonaSandboxFactoryV1 = {
    async create(apiKey) {
      void apiKey;
      return handleFor(SANDBOX_ID);
    },
    async attach(apiKey, sandboxId) {
      void apiKey;
      return handleFor(sandboxId);
    },
    async destroy(apiKey, sandboxId) {
      void apiKey;
      destroyed.push(sandboxId);
    },
  };

  // Same write-through requirement as the E2B fake above.
  return {
    factory,
    files,
    destroyed,
    execCalls,
    sessions: state.sessions,
    get execResult() {
      return state.execResult;
    },
    set execResult(next) {
      state.execResult = next;
    },
  };
}

test("Daytona SDK adapter: runCommand marks the command line and env, and reports the exit code", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  const result = await client.runCommand({
    sandboxId: SANDBOX_ID,
    argv: ["npm", "test"],
    cwd: "/workspace/repo",
    attemptKey: ATTEMPT_KEY,
  });
  assert.deepEqual(result, { exitCode: 0, stdoutTail: "ok", stderrTail: "" });
  assert.equal(fake.execCalls.length, 1);
  const call = fake.execCalls[0]!;
  assert.ok(call.command.startsWith(`${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${ATTEMPT_KEY}'`));
  assert.ok(call.command.endsWith("'npm' 'test'"));
  assert.equal(call.cwd, "/workspace/repo");
  assert.equal(call.env?.[SANDBOX_ATTEMPT_KEY_MARKER_V1], ATTEMPT_KEY);
});

test("Daytona SDK adapter: a non-zero exit is a valid result, not a thrown failure", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  fake.execResult = { exitCode: 3, result: "failed output" };
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  const result = await client.runCommand({
    sandboxId: SANDBOX_ID,
    argv: ["false"],
    cwd: "/workspace",
    attemptKey: ATTEMPT_KEY,
  });
  assert.deepEqual(result, { exitCode: 3, stdoutTail: "failed output", stderrTail: "" });
});

test("Daytona SDK adapter: a transport error propagates (leaves the attempt open)", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  fake.execResult = new Error("connection reset");
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });

  await assert.rejects(
    client.runCommand({
      sandboxId: SANDBOX_ID,
      argv: ["true"],
      cwd: "/workspace",
      attemptKey: ATTEMPT_KEY,
    }),
    /connection reset/
  );
});

test("Daytona SDK adapter: resolveRealPath trusts only a 0-exit absolute readlink result", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  fake.execResult = { exitCode: 0, result: "/workspace/real\n" };
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });
  assert.equal(await client.resolveRealPath(SANDBOX_ID, "/workspace/link"), "/workspace/real");

  fake.execResult = { exitCode: 1, result: "" };
  assert.equal(await client.resolveRealPath(SANDBOX_ID, "/workspace/missing"), undefined);
});

test("Daytona SDK adapter: readFileUtf8 and listDirectory fail closed on transport error", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });
  assert.equal(await client.readFileUtf8(SANDBOX_ID, "/nope"), undefined);

  fake.files.set("/workspace/a.txt", { isDir: false, size: 3, content: "abc" });
  const listed = await client.listDirectory(SANDBOX_ID, "/workspace");
  assert.deepEqual(listed, [{ name: "/workspace/a.txt", kind: "file", sizeBytes: 3 }]);
});

test("Daytona SDK adapter: findCommandByAttemptKey matches session command text, else unknown", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });
  assert.equal(await client.findCommandByAttemptKey(SANDBOX_ID, ATTEMPT_KEY), "unknown");

  fake.sessions.push({ commands: [{ command: `${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${ATTEMPT_KEY}' echo hi` }] });
  assert.equal(await client.findCommandByAttemptKey(SANDBOX_ID, ATTEMPT_KEY), "executed");
});

test("Daytona SDK adapter: destroySandbox destroys through the factory", async () => {
  const fake = makeFakeDaytonaFactoryV1();
  const client = createDaytonaSdkSandboxClientV1({ apiKey: API_KEY, factory: fake.factory });
  await client.destroySandbox(SANDBOX_ID);
  assert.deepEqual(fake.destroyed, [SANDBOX_ID]);
});
