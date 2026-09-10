/**
 * Coverage for `createLocalDockerSandboxClientV1`'s `createInteractiveSession`
 * — the login-flow-shaped capability (print something, wait for input, react)
 * that `runCommand` (blocks to completion, bounded result) cannot express —
 * and for `createSandbox`'s default non-root container user.
 *
 * Fakes dockerode's `container.exec`/`exec.start`/`exec.inspect` surface with
 * a real Duplex stream so sendInput/onOutput/wait exercise real stream
 * semantics, not just mocked call assertions. `createInteractiveSession`
 * reads the exec stream directly (Tty mode, confirmed live against a real
 * CLI as required for any isatty()-gated output — see the adapter's own
 * comment); `docker.modem.demuxStream` is faked here only because
 * `execCaptureV1` (the non-interactive `runCommand` path) still uses it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Duplex } from "node:stream";
import { createLocalDockerSandboxClientV1 } from "../src/localDockerSandboxClientV1";

/**
 * A scriptable fake exec stream: `_write` (the container's "stdin") is
 * inspected by `onWrite`, which can push a scripted response onto the
 * stream's own readable side (the container's "stdout") and/or end it —
 * mirroring how a real interactive process reacts to input.
 */
function makeFakeExecStream(onWrite: (this: FakeStreamSelf, data: string) => void): Duplex {
  const stream = new Duplex({
    write(chunk, _encoding, callback) {
      onWrite.call(stream as unknown as FakeStreamSelf, chunk.toString("utf8"));
      callback();
    },
    read() {
      // Pushes happen explicitly via onWrite/emitOutput; nothing to do here.
    },
  }) as unknown as FakeStreamSelf & Duplex;
  return stream;
}

interface FakeStreamSelf {
  push(chunk: string | null): void;
}

interface FakeExecHandle {
  inspect(): Promise<{ ExitCode: number | null; Running: boolean; Pid: number }>;
  start(): Promise<Duplex>;
}

function makeFakeDocker(options: {
  readonly onWrite: (self: FakeStreamSelf, data: string) => void;
  readonly killedPids: number[];
}): { docker: unknown; execCalls: Array<{ Cmd: readonly string[]; WorkingDir: string }> } {
  const execCalls: Array<{ Cmd: readonly string[]; WorkingDir: string }> = [];
  let exitCode: number | null = null;
  let running = true;
  const PID = 4242;

  const exec: FakeExecHandle = {
    inspect: () => Promise.resolve({ ExitCode: exitCode, Running: running, Pid: PID }),
    start: () => {
      const stream = makeFakeExecStream(function (this: FakeStreamSelf, data: string) {
        options.onWrite(this, data);
      });
      return Promise.resolve(stream);
    },
  };

  const docker = {
    modem: {
      // Real dockerode demuxes multiplexed frames; the fake just treats
      // everything as one combined stream, matching what onOutput receives.
      demuxStream: (stream: Duplex, stdout: Duplex) => {
        stream.on("data", (chunk: Buffer) => stdout.write(chunk));
        stream.on("end", () => stdout.end());
      },
    },
    getContainer: () => ({
      exec: (opts: { Cmd: readonly string[]; WorkingDir: string }) => {
        execCalls.push(opts);
        return Promise.resolve(exec);
      },
    }),
  };

  // Test hooks to end the fake process (exposed via closures below).
  (docker as unknown as { _finish: (code: number) => void })._finish = (code: number) => {
    exitCode = code;
    running = false;
  };
  (docker as unknown as { _recordKill: (pid: number) => void })._recordKill = (pid: number) => {
    options.killedPids.push(pid);
  };

  return { docker, execCalls };
}

test("createInteractiveSession: sendInput reaches the running process, streamed output is captured, wait() reports the real exit code", async () => {
  let streamSelf: FakeStreamSelf | undefined;
  const { docker } = makeFakeDocker({
    onWrite: (self, data) => {
      streamSelf = self;
      if (data.includes("secret-123")) {
        self.push("GOT_CODE:secret-123\n");
      }
    },
    killedPids: [],
  });

  const client = createLocalDockerSandboxClientV1({ docker: docker as never });
  assert.ok(client.createInteractiveSession);

  const chunks: string[] = [];
  const sessionPromise = client.createInteractiveSession({
    sandboxId: "sbx-1",
    argv: ["sh", "-c", "read code; echo GOT_CODE:$code"],
    cwd: "/",
    onOutput: (chunk) => chunks.push(chunk),
  });
  const session = await sessionPromise;

  await session.sendInput("secret-123\n");
  // Let the fake stream's data event propagate through demuxStream → onOutput.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(chunks.join(""), "GOT_CODE:secret-123\n");

  // Simulate the process exiting after producing its output, then end the stream.
  (docker as unknown as { _finish: (code: number) => void })._finish(0);
  streamSelf?.push(null);

  const result = await session.wait();
  assert.deepEqual(result, { exitCode: 0 });
});

test("createInteractiveSession: kill() signals the process's real HOST pid via process.kill, never a nested container exec", async () => {
  // ExecInspectInfo.Pid is the HOST-namespace pid — a `kill` run through
  // ANOTHER `docker exec` executes inside the CONTAINER's pid namespace and
  // cannot see that number at all (confirmed live against the real daemon:
  // it reports "no such process" for a pid `docker top` shows as running).
  // This adapter runs on the SAME host as the daemon (its own documented
  // premise), so the only correct signal path is this process's own
  // `process.kill` — regression test for exactly that bug.
  const { docker } = makeFakeDocker({ onWrite: () => undefined, killedPids: [] });
  const originalKill = process.kill;
  const killedPids: Array<{ pid: number; signal?: string | number }> = [];
  (process as unknown as { kill: typeof process.kill }).kill = ((
    pid: number,
    signal?: string | number
  ) => {
    killedPids.push({ pid, signal });
    return true;
  }) as typeof process.kill;

  const client = createLocalDockerSandboxClientV1({ docker: docker as never });
  const session = await client.createInteractiveSession!({
    sandboxId: "sbx-1",
    argv: ["sleep", "99"],
    cwd: "/",
    onOutput: () => undefined,
  });

  try {
    await session.kill();
    assert.deepEqual(killedPids, [{ pid: 4242, signal: "SIGTERM" }]);
  } finally {
    (process as unknown as { kill: typeof process.kill }).kill = originalKill;
  }
});

test("createSandbox: defaults to this process's own uid:gid, never root — required for kill() to have permission at all", async () => {
  const createContainerCalls: Array<{ User?: string }> = [];
  const fakeDocker = {
    createContainer: (opts: { User?: string }) => {
      createContainerCalls.push(opts);
      return Promise.resolve({ id: "sbx-created", start: () => Promise.resolve() });
    },
  };

  const client = createLocalDockerSandboxClientV1({ docker: fakeDocker as never });
  await client.createSandbox();

  assert.equal(createContainerCalls.length, 1);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (uid !== undefined && gid !== undefined) {
    assert.equal(createContainerCalls[0]?.User, `${uid}:${gid}`);
  }
});

test("createSandbox: an explicit empty user override falls back to the image's own default (e.g. root)", async () => {
  const createContainerCalls: Array<{ User?: string }> = [];
  const fakeDocker = {
    createContainer: (opts: { User?: string }) => {
      createContainerCalls.push(opts);
      return Promise.resolve({ id: "sbx-created", start: () => Promise.resolve() });
    },
  };

  const client = createLocalDockerSandboxClientV1({ docker: fakeDocker as never, user: "" });
  await client.createSandbox();

  assert.equal(createContainerCalls[0]?.User, undefined);
});
