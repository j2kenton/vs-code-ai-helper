/**
 * Coverage for `createLocalDockerSandboxClientV1`'s `createInteractiveSession`
 * — the login-flow-shaped capability (print something, wait for input, react)
 * that `runCommand` (blocks to completion, bounded result) cannot express.
 * Fakes dockerode's `container.exec`/`exec.start`/`exec.inspect` surface with
 * a real Duplex stream so sendInput/onOutput/wait exercise real stream
 * semantics, not just mocked call assertions — `docker.modem.demuxStream` is
 * faked as a plain pipe (dockerode's own frame-demuxing correctness is that
 * package's concern, not this adapter's).
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

test("createInteractiveSession: kill() signals the process's real PID rather than fabricating success", async () => {
  const killCommands: string[] = [];
  const { docker } = makeFakeDocker({ onWrite: () => undefined, killedPids: [] });
  // Intercept the kill's own exec call (separate from the interactive session's exec).
  const baseGetContainer = (docker as { getContainer: () => { exec: (opts: unknown) => Promise<unknown> } })
    .getContainer;
  (docker as { getContainer: () => unknown }).getContainer = () => {
    const inner = baseGetContainer();
    return {
      exec: (opts: { Cmd?: readonly string[] }) => {
        if (opts.Cmd?.[0] === "/bin/sh") {
          killCommands.push((opts.Cmd as readonly string[])[2] ?? "");
          return Promise.resolve({
            start: () => {
              const s = makeFakeExecStream(() => undefined);
              queueMicrotask(() => (s as unknown as FakeStreamSelf).push(null));
              return Promise.resolve(s);
            },
            inspect: () => Promise.resolve({ ExitCode: 0, Running: false, Pid: 0 }),
          });
        }
        return inner.exec(opts);
      },
    };
  };

  const client = createLocalDockerSandboxClientV1({ docker: docker as never });
  const session = await client.createInteractiveSession!({
    sandboxId: "sbx-1",
    argv: ["sleep", "99"],
    cwd: "/",
    onOutput: () => undefined,
  });

  await session.kill();

  assert.equal(killCommands.length, 1);
  assert.match(killCommands[0] as string, /^kill -TERM 4242\b/);
});
