/**
 * The viewer → runner file relay (hostRelayV1.ts): a request written by one
 * side is claimed and answered exactly once by the other, over a shared
 * directory, with no VS Code involved.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createHostRelayV1, HostRelayRequestV1 } from "../services/hostRelayV1";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ensemble-relay-"));
}

/**
 * `send` writes its request asynchronously; a fixed 20 ms wait let the
 * runner-side drain run before the file existed under a loaded full test
 * run (nothing to claim → no answer → the viewer's 2-minute timeout).
 */
async function waitForRequestFile(dir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    if (entries.some((name) => name.startsWith("req-") && name.endsWith(".json"))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("the request file never appeared");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void describe("hostRelayV1", () => {
  void it("a command request round-trips: the runner's drain claims it, runs the handler, and the viewer gets the answer", async () => {
    const dir = await tempDir();
    try {
      const viewer = createHostRelayV1({ dir });
      const runner = createHostRelayV1({ dir });
      const seen: HostRelayRequestV1[] = [];
      const pending = viewer.send(
        { kind: "command", command: "vs-code-ai-helper.nextStage", taskFolderPath: "/w/.ensemble/t1" },
        { pollMs: 10 }
      );
      // Give the request file a moment to land, then drain as the runner would.
      await waitForRequestFile(dir);
      const handled = await runner.drain((request) => {
        seen.push(request);
        return Promise.resolve({ started: true });
      });
      assert.equal(handled, 1);
      const response = await pending;
      assert.equal(response.ok, true);
      assert.deepEqual(response.result, { started: true });
      assert.equal(seen[0]?.kind, "command");
      assert.ok(seen[0]?.kind === "command" && seen[0].command === "vs-code-ai-helper.nextStage");
      // Nothing left behind: no request, claimed or response files.
      assert.deepEqual(await fs.readdir(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a request is executed exactly once even when two sweeps race", async () => {
    const dir = await tempDir();
    try {
      const viewer = createHostRelayV1({ dir });
      const runner = createHostRelayV1({ dir });
      let executions = 0;
      const pending = viewer.send({ kind: "command", command: "x" }, { pollMs: 10 });
      // Awaited below; the handler keeps a failed assertion from leaving it dangling.
      pending.catch(() => undefined);
      await waitForRequestFile(dir);
      const handler = async (): Promise<unknown> => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return undefined;
      };
      const [a, b] = await Promise.all([runner.drain(handler), runner.drain(handler)]);
      assert.equal(a + b, 1, "only one sweep may claim the request");
      assert.equal(executions, 1);
      assert.equal((await pending).ok, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a long request does not block the one behind it: claimed requests run concurrently", async () => {
    // Review of the runner/viewer split: a serial drain let a 30-minute
    // implementation round hold an answer to a question until it "expired".
    const dir = await tempDir();
    try {
      const relay = createHostRelayV1({ dir });
      let releaseSlow: () => void = () => undefined;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const slow = relay.send({ kind: "command", command: "slow" }, { pollMs: 10 });
      const fast = relay.send({ kind: "command", command: "fast" }, { pollMs: 10 });
      slow.catch(() => undefined);
      fast.catch(() => undefined);
      await waitForRequestFile(dir);
      await new Promise((resolve) => setTimeout(resolve, 50)); // both files present
      const draining = relay.drain(async (request) => {
        if (request.kind === "command" && request.command === "slow") {
          await slowGate;
        }
        return request.kind === "command" ? request.command : undefined;
      });
      assert.equal((await fast).result, "fast", "the fast request is answered while the slow one still runs");
      releaseSlow();
      assert.equal((await slow).result, "slow");
      assert.equal(await draining, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("expiry follows the viewer's own wait when the request states one", async () => {
    const dir = await tempDir();
    try {
      let clock = new Date("2026-09-17T10:00:00Z");
      const relay = createHostRelayV1({ dir, now: () => clock, maxAgeMs: 60_000 });
      // The viewer waits 30 minutes: 12 minutes later the request is still live,
      // even though it is far past the default age limit.
      const pending = relay.send({ kind: "command", command: "x" }, { pollMs: 10, timeoutMs: 30 * 60 * 1000 });
      pending.catch(() => undefined);
      await waitForRequestFile(dir);
      clock = new Date("2026-09-17T10:12:00Z");
      let executed = false;
      await relay.drain(() => {
        executed = true;
        return Promise.resolve("ran");
      });
      assert.equal(executed, true);
      assert.equal((await pending).result, "ran");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("answers nobody collected are garbage-collected on a later drain", async () => {
    const dir = await tempDir();
    try {
      let clock = new Date("2026-09-17T10:00:00Z");
      const relay = createHostRelayV1({ dir, now: () => clock });
      const orphan = path.join(dir, "res-0123456789abcdef0123456789abcdef.json");
      await fs.writeFile(orphan, "{}");
      const old = new Date("2026-09-17T08:00:00Z");
      await fs.utimes(orphan, old, old);
      clock = new Date("2026-09-17T10:00:00Z");
      await relay.drain(() => Promise.resolve(undefined));
      await assert.rejects(fs.stat(orphan), /ENOENT/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a handler that throws becomes a failed response, never an unhandled rejection", async () => {
    const dir = await tempDir();
    try {
      const relay = createHostRelayV1({ dir });
      const pending = relay.send({ kind: "command", command: "x" }, { pollMs: 10 });
      await waitForRequestFile(dir);
      await relay.drain(() => Promise.reject(new Error("the runner refused")));
      const response = await pending;
      assert.equal(response.ok, false);
      assert.equal(response.reason, "the runner refused");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a stale request (the viewer gave up long ago) is answered expired, not executed", async () => {
    const dir = await tempDir();
    try {
      let clock = new Date("2026-09-17T10:00:00Z");
      const relay = createHostRelayV1({ dir, now: () => clock, maxAgeMs: 60_000 });
      const pending = relay.send({ kind: "command", command: "x" }, { pollMs: 10 });
      await waitForRequestFile(dir);
      clock = new Date("2026-09-17T10:05:00Z");
      let executed = false;
      await relay.drain(() => {
        executed = true;
        return Promise.resolve(undefined);
      });
      const response = await pending;
      assert.equal(executed, false);
      assert.equal(response.ok, false);
      assert.equal(response.reason, "expired");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("a viewer that times out withdraws its request so a late runner never runs it", async () => {
    const dir = await tempDir();
    try {
      const relay = createHostRelayV1({ dir });
      await assert.rejects(
        relay.send({ kind: "command", command: "x" }, { timeoutMs: 30, pollMs: 5 }),
        /did not answer in time/
      );
      let executed = false;
      const handled = await relay.drain(() => {
        executed = true;
        return Promise.resolve(undefined);
      });
      assert.equal(handled, 0);
      assert.equal(executed, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("an interaction request carries the full serializable ref and answers", async () => {
    const dir = await tempDir();
    try {
      const relay = createHostRelayV1({ dir });
      const ref = { operationId: "o", interactionId: "i", taskBindingId: "b", chatDocumentId: "d", sourceAttemptId: "a" };
      const pending = relay.send(
        { kind: "interaction", op: "submitAnswers", ref, rawAnswers: [{ questionId: "q", value: "yes" }], idempotencyId: "k" },
        { pollMs: 10 }
      );
      await waitForRequestFile(dir);
      await relay.drain((request) => {
        assert.ok(request.kind === "interaction");
        assert.deepEqual(request.ref, ref);
        assert.deepEqual(request.rawAnswers, [{ questionId: "q", value: "yes" }]);
        return Promise.resolve({ ok: true });
      });
      assert.deepEqual((await pending).result, { ok: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
