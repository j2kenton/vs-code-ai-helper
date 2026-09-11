/**
 * The node:http adapter must survive anything a single request does. Before
 * these fixes (review, 2026-09-11) a throw anywhere in a route handler
 * became an unhandled rejection — which terminates the whole Node process
 * by default, killing every run in flight — and a request body was buffered
 * in full with no ceiling. Exercised against a live server, like
 * `cors.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import type { Server } from "node:http";
import { createControlPlaneNodeServerV1, type ControlPlaneHandlerV1 } from "../src/controlPlaneServerV1";

async function listen(
  handler: ControlPlaneHandlerV1,
  options?: { readonly authenticateBearer?: (accessToken: string) => Promise<boolean> }
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createControlPlaneNodeServerV1(handler, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    port: address.port,
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
}

function send(
  port: number,
  path: string,
  body?: Buffer,
  accessToken?: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: body === undefined ? "GET" : "POST",
        path,
        headers: {
          "content-type": "application/json",
          ...(accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settled = true;
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    // The server stops reading an oversized upload and closes after its 413,
    // so the rest of our write can fail — expected once the response is in.
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (!settled && error.code !== "ECONNRESET" && error.code !== "EPIPE") {
        reject(error);
      }
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

test("a handler that throws answers 500 on that request — the process survives and keeps serving", async () => {
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  let calls = 0;
  const server = await listen({
    handle: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("docker: connect ENOENT /var/run/docker.sock (internal detail)"))
        : Promise.resolve({ status: 200, body: { ok: true } });
    },
  });
  try {
    const failed = await send(server.port, "/v1/anything");
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.text), { code: "internalError", message: "the request could not be completed" });
    assert.equal(failed.text.includes("docker.sock"), false, "internal error text must not reach the client");

    const next = await send(server.port, "/v1/anything");
    assert.equal(next.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(escaped, [], "the throw must not escape as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
    await server.close();
  }
});

test("an oversized request body is refused with 413 while streaming, and never reaches the handler", async () => {
  let reached = false;
  const server = await listen({
    handle: () => {
      reached = true;
      return Promise.resolve({ status: 200 });
    },
  });
  try {
    const response = await send(server.port, "/v1/tasks", Buffer.alloc(9 * 1024 * 1024, 0x20));
    assert.equal(response.status, 413);
    assert.equal(reached, false);
  } finally {
    await server.close();
  }
});

test("with authenticateBearer, a request without a valid token is refused 401 before its body is read", async () => {
  let reached = false;
  const checked: string[] = [];
  const server = await listen(
    {
      handle: () => {
        reached = true;
        return Promise.resolve({ status: 200 });
      },
    },
    {
      authenticateBearer: (token) => {
        checked.push(token);
        return Promise.resolve(token === "good");
      },
    }
  );
  try {
    // 4 MB is under the 8 MB authenticated cap: only the token check stops it.
    const anonymous = await send(server.port, "/v1/tasks", Buffer.alloc(4 * 1024 * 1024, 0x20));
    assert.equal(anonymous.status, 401);
    const wrong = await send(server.port, "/v1/tasks", Buffer.from("{}"), "bad");
    assert.equal(wrong.status, 401);
    assert.equal(reached, false);

    const allowed = await send(server.port, "/v1/tasks", Buffer.from("{}"), "good");
    assert.equal(allowed.status, 200);
    assert.equal(reached, true);
    assert.deepEqual(checked, ["bad", "good"], "an absent header is refused without a lookup");
  } finally {
    await server.close();
  }
});

test("a request with NO body waits for the token verdict too — the handler never runs beside a 401", async () => {
  // Second final review: a GET/DELETE has already ended, so 'end' fired while
  // the check was still pending and the handler ran anyway.
  let reached = 0;
  const server = await listen(
    {
      handle: () => {
        reached += 1;
        return Promise.resolve({ status: 204 });
      },
    },
    { authenticateBearer: () => new Promise((resolve) => setTimeout(() => resolve(false), 30)) }
  );
  try {
    assert.equal((await send(server.port, "/v1/tasks", undefined, "bad")).status, 401);
    assert.equal(reached, 0);
  } finally {
    await server.close();
  }
});

test("a token check that FAILS (store error) answers 503, not a misleading 401", async () => {
  let reached = false;
  const server = await listen(
    {
      handle: () => {
        reached = true;
        return Promise.resolve({ status: 200 });
      },
    },
    { authenticateBearer: () => Promise.reject(new Error("SQLITE_BUSY")) }
  );
  try {
    assert.equal((await send(server.port, "/v1/tasks", Buffer.from("{}"), "any")).status, 503);
    assert.equal(reached, false);
  } finally {
    await server.close();
  }
});

test("a malformed request target is answered 400 and never reaches the handler", async () => {
  let reached = false;
  const server = await listen({
    handle: () => {
      reached = true;
      return Promise.resolve({ status: 200 });
    },
  });
  try {
    assert.equal((await send(server.port, "//a:99999", Buffer.from("{}"))).status, 400);
    assert.equal(reached, false);
  } finally {
    await server.close();
  }
});

test("the sign-in routes skip the token check but their bodies are capped at 16 KB", async () => {
  const bodies: unknown[] = [];
  const server = await listen(
    {
      handle: (request) => {
        bodies.push(request.body);
        return Promise.resolve({ status: 200 });
      },
    },
    { authenticateBearer: () => Promise.resolve(false) }
  );
  try {
    const small = await send(server.port, "/v1/auth/exchange", Buffer.from(JSON.stringify({ provider: "github" })));
    assert.equal(small.status, 200);
    const big = await send(server.port, "/v1/auth/exchange", Buffer.alloc(17 * 1024, 0x20));
    assert.equal(big.status, 413);
    assert.deepEqual(bodies, [{ provider: "github" }]);
  } finally {
    await server.close();
  }
});
