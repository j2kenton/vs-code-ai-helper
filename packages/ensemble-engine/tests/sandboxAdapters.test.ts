/**
 * E2B / Daytona sandbox adapter tests (plan Part 4d).
 *
 * The transports are injected, so these pin the ENGINE's request contract:
 * keys travel only in headers, every command line carries the attempt-key
 * marker with strictly quoted argv, outcomes are never fabricated (no exit
 * code → throw), resolution and reconciliation fail closed, and error text
 * scrubs the API key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FetchLikeV1 } from "../src/providerAdaptersV1";
import { SANDBOX_ATTEMPT_KEY_MARKER_V1 } from "../src/sandboxClientV1";
import {
  createDaytonaSandboxClientV1,
  createE2bSandboxClientV1,
} from "../src/sandboxProviderAdaptersV1";

const API_KEY = "sk-sandbox-secret-0001";
const ATTEMPT_KEY = "ab".repeat(32);

interface RecordedRequestV1 {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function fakeFetch(
  respond: (url: string, method: string) => { readonly status: number; readonly body: string }
): { readonly fetch: FetchLikeV1; readonly requests: RecordedRequestV1[] } {
  const requests: RecordedRequestV1[] = [];
  const fetch: FetchLikeV1 = (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    const response = respond(url, init.method);
    return Promise.resolve({
      status: response.status,
      text: () => Promise.resolve(response.body),
    });
  };
  return { fetch, requests };
}

test("E2B: commands go to envd with the marker in the command line, envs, and tag; the key rides only headers", async () => {
  const { fetch, requests } = fakeFetch(() => ({
    status: 200,
    body: JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "" }),
  }));
  const client = createE2bSandboxClientV1({ fetch, apiKey: API_KEY });

  const result = await client.runCommand({
    sandboxId: "sbx-1",
    argv: ["git", "status"],
    cwd: "/workspace/repo",
    attemptKey: ATTEMPT_KEY,
  });
  assert.deepEqual(result, { exitCode: 0, stdoutTail: "ok", stderrTail: "" });

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://49983-sbx-1.e2b.app/process.Process/Start");
  assert.equal(request.headers["x-api-key"], API_KEY);
  const payload = JSON.parse(request.body) as {
    process: { cmd: string; args: string[]; cwd: string; envs: Record<string, string>; tag: string };
  };
  assert.equal(payload.process.cmd, "/bin/sh");
  assert.equal(payload.process.args[0], "-c");
  assert.ok(payload.process.args[1]!.startsWith(`${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${ATTEMPT_KEY}'`));
  assert.ok(payload.process.args[1]!.endsWith("'git' 'status'"));
  assert.equal(payload.process.cwd, "/workspace/repo");
  assert.equal(payload.process.envs[SANDBOX_ATTEMPT_KEY_MARKER_V1], ATTEMPT_KEY);
  assert.equal(payload.process.tag, ATTEMPT_KEY);
  assert.ok(!request.body.includes(API_KEY), "the key must never enter a request body");
});

test("E2B: a missing exit code throws (leaving the open attempt for recovery) and errors scrub the key", async () => {
  const noExit = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({ status: 200, body: "{}" })).fetch,
    apiKey: API_KEY,
  });
  await assert.rejects(
    () =>
      noExit.runCommand({ sandboxId: "s", argv: ["true"], cwd: "/", attemptKey: ATTEMPT_KEY }),
    /did not report an exit code/
  );

  const failing = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({ status: 500, body: `boom key=${API_KEY} leaked` })).fetch,
    apiKey: API_KEY,
  });
  await assert.rejects(
    () => failing.runCommand({ sandboxId: "s", argv: ["true"], cwd: "/", attemptKey: ATTEMPT_KEY }),
    (error: Error) => {
      assert.ok(!error.message.includes(API_KEY));
      assert.ok(error.message.includes("[redacted]"));
      return true;
    }
  );
});

test("E2B: real-path resolution and marker reconciliation fail closed", async () => {
  const missing = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({ status: 404, body: "" })).fetch,
    apiKey: API_KEY,
  });
  assert.equal(await missing.resolveRealPath("s", "/gone"), undefined);

  const unresolved = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({ status: 200, body: JSON.stringify({ entry: { name: "x" } }) })).fetch,
    apiKey: API_KEY,
  });
  // No resolved-target field: never trust the path as given.
  assert.equal(await unresolved.resolveRealPath("s", "/maybe-symlink"), undefined);

  const resolved = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ entry: { resolvedPath: "/data/real/file.txt" } }),
    })).fetch,
    apiKey: API_KEY,
  });
  assert.equal(await resolved.resolveRealPath("s", "/link"), "/data/real/file.txt");

  const tagged = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ processes: [{ tag: ATTEMPT_KEY }] }),
    })).fetch,
    apiKey: API_KEY,
  });
  assert.equal(await tagged.findCommandByAttemptKey("s", ATTEMPT_KEY), "executed");

  const absent = createE2bSandboxClientV1({
    fetch: fakeFetch(() => ({ status: 200, body: JSON.stringify({ processes: [] }) })).fetch,
    apiKey: API_KEY,
  });
  // Only running processes are visible: absence proves nothing.
  assert.equal(await absent.findCommandByAttemptKey("s", ATTEMPT_KEY), "unknown");

  const unreachable = createE2bSandboxClientV1({
    fetch: () => Promise.reject(new Error("network down")),
    apiKey: API_KEY,
  });
  assert.equal(await unreachable.findCommandByAttemptKey("s", ATTEMPT_KEY), "unknown");
});

test("Daytona: lifecycle, marked execution, resolution, and reconciliation ride the toolbox API", async () => {
  const { fetch, requests } = fakeFetch((url, method) => {
    if (method === "POST" && url.endsWith("/api/sandbox")) {
      return { status: 200, body: JSON.stringify({ id: "dtn-1" }) };
    }
    if (method === "DELETE" && url.endsWith("/api/sandbox/dtn-1")) {
      return { status: 200, body: "{}" };
    }
    if (url.includes("/process/execute")) {
      return { status: 200, body: JSON.stringify({ exitCode: 1, result: "boom" }) };
    }
    if (url.includes("/files/info")) {
      return { status: 200, body: JSON.stringify({ resolvedTarget: "/home/user/real" }) };
    }
    if (url.includes("/process/session")) {
      return {
        status: 200,
        body: JSON.stringify([{ commands: [{ command: `X=1 ${ATTEMPT_KEY} 'git'` }] }]),
      };
    }
    return { status: 404, body: "" };
  });
  const client = createDaytonaSandboxClientV1({ fetch, apiKey: API_KEY });

  const created = await client.createSandbox();
  assert.deepEqual(created, { sandboxId: "dtn-1" });

  const run = await client.runCommand({
    sandboxId: "dtn-1",
    argv: ["npm", "test"],
    cwd: "/workspace/repo",
    attemptKey: ATTEMPT_KEY,
  });
  assert.deepEqual(run, { exitCode: 1, stdoutTail: "boom", stderrTail: "" });
  const execute = requests.find((request) => request.url.includes("/process/execute"))!;
  assert.equal(execute.headers.authorization, `Bearer ${API_KEY}`);
  const body = JSON.parse(execute.body) as { command: string; cwd: string };
  assert.ok(body.command.startsWith(`${SANDBOX_ATTEMPT_KEY_MARKER_V1}='${ATTEMPT_KEY}'`));
  assert.ok(body.command.endsWith("'npm' 'test'"));
  assert.equal(body.cwd, "/workspace/repo");

  assert.equal(await client.resolveRealPath("dtn-1", "/link"), "/home/user/real");
  assert.equal(await client.findCommandByAttemptKey("dtn-1", ATTEMPT_KEY), "executed");
  assert.equal(await client.findCommandByAttemptKey("dtn-1", "ff".repeat(32)), "unknown");

  await client.destroySandbox("dtn-1");
  const destroy = requests.find((request) => request.method === "DELETE")!;
  assert.ok(destroy.url.endsWith("/api/sandbox/dtn-1"));
});

test("Daytona: unparseable outcomes throw and resolution without a resolved target fails closed", async () => {
  const client = createDaytonaSandboxClientV1({
    fetch: fakeFetch((url) =>
      url.includes("/files/info")
        ? { status: 200, body: JSON.stringify({ name: "f", isDir: false }) }
        : { status: 200, body: JSON.stringify({ result: "no exit code here" }) }
    ).fetch,
    apiKey: API_KEY,
  });
  await assert.rejects(
    () => client.runCommand({ sandboxId: "s", argv: ["true"], cwd: "/", attemptKey: ATTEMPT_KEY }),
    /did not report an exit code/
  );
  assert.equal(await client.resolveRealPath("s", "/maybe-symlink"), undefined);
});
