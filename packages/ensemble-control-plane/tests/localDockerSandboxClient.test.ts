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
import {
  createLocalDockerSandboxClientV1,
  DEFAULT_DOCKER_SANDBOX_LIMITS_V1,
  DOCKER_SANDBOX_LABEL_V1,
  DockerExecNotStoppedErrorV1,
  DockerSandboxNotManagedErrorV1,
} from "../src/localDockerSandboxClientV1";

/** A real-shaped full container id (the only form the adapter accepts). */
const SANDBOX_ID = "a".repeat(64);
const MANAGED_INSPECT = {
  Id: SANDBOX_ID,
  Config: { Image: "ensemble-sandbox:latest", Labels: { [DOCKER_SANDBOX_LABEL_V1]: "1" } },
};

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
      inspect: () => Promise.resolve(MANAGED_INSPECT),
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
    sandboxId: SANDBOX_ID,
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
    sandboxId: SANDBOX_ID,
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

/**
 * A fake daemon holding a set of containers by FULL id, resolving lookups
 * the way the real Docker API does: an exact id, any unique id prefix, or a
 * container name. That resolution is the attack surface — confirmed live
 * (2026-09-11): `b7` resolved to a real sandbox on the box.
 */
interface FakeContainerV1 {
  readonly name: string;
  readonly image: string;
  readonly labelled: boolean;
  /** Defaults: a non-root, memory- and pid-limited container (today's profile). */
  readonly user?: string;
  readonly memory?: number;
  readonly pids?: number;
}

function makeDaemon(
  containers: Record<string, FakeContainerV1>
): { docker: unknown; removed: string[]; execsOn: string[] } {
  const removed: string[] = [];
  const execsOn: string[] = [];
  const resolve = (ref: string): string | undefined => {
    const ids = Object.keys(containers);
    if (ids.includes(ref)) {
      return ref;
    }
    const byName = ids.find((id) => containers[id]?.name === ref);
    if (byName !== undefined) {
      return byName;
    }
    const byPrefix = ids.filter((id) => id.startsWith(ref));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  };
  const notFound = (): Error & { statusCode: number } =>
    Object.assign(new Error("no such container"), { statusCode: 404 });
  const docker = {
    modem: { demuxStream: () => undefined },
    getContainer: (ref: string) => ({
      inspect: () => {
        const id = resolve(ref);
        const found = id === undefined ? undefined : containers[id];
        return id === undefined || found === undefined
          ? Promise.reject(notFound())
          : Promise.resolve({
              Id: id,
              Config: {
                Image: found.image,
                User: found.user ?? "1001:1001",
                Labels: found.labelled ? { [DOCKER_SANDBOX_LABEL_V1]: "1" } : {},
              },
              HostConfig: { Memory: found.memory ?? 4 * 1024 ** 3, PidsLimit: found.pids ?? 1024 },
            });
      },
      exec: () => {
        execsOn.push(ref);
        return Promise.reject(new Error("exec reached — the guard did not stop this"));
      },
      remove: () => {
        const id = resolve(ref);
        if (id === undefined) {
          return Promise.reject(notFound());
        }
        removed.push(id);
        delete containers[id];
        return Promise.resolve();
      },
      top: () => Promise.resolve({ Processes: [] }),
    }),
  };
  return { docker, removed, execsOn };
}

const MINE = "b7".padEnd(64, "1");
const SERVICE = "c3".padEnd(64, "2");

test("ownership guard: prefixes, names, and unlabelled host containers are refused before any exec", async () => {
  const { docker, execsOn, removed } = makeDaemon({
    [MINE]: { name: "sad_turing", image: "ensemble-sandbox:latest", labelled: true },
    [SERVICE]: { name: "postgres", image: "postgres:17", labelled: false },
  });
  const client = createLocalDockerSandboxClientV1({ docker: docker as never, image: "ensemble-sandbox:latest" });

  for (const ref of ["b7", "sad_turing", SERVICE, "postgres", "../etc", ""]) {
    await assert.rejects(client.readFileUtf8(ref, "/etc/passwd"), DockerSandboxNotManagedErrorV1, ref);
    await assert.rejects(
      client.runCommand({ sandboxId: ref, argv: ["id"], cwd: "/", attemptKey: "abc123abc123abc1" }),
      DockerSandboxNotManagedErrorV1,
      ref
    );
    await assert.rejects(client.destroySandbox(ref), DockerSandboxNotManagedErrorV1, ref);
    assert.equal(await client.findCommandByAttemptKey(ref, "k"), "unknown");
  }
  assert.deepEqual(execsOn, [], "no exec may reach a container that failed the guard");
  assert.deepEqual(removed, [], "no container that failed the guard may be destroyed");

  // The real sandbox, by its full id, passes the guard (the exec itself is faked to fail after it).
  await assert.rejects(client.readFileUtf8(MINE, "/x"), /exec reached/);
  assert.deepEqual(execsOn, [MINE]);
});

test("ownership guard: a pre-label sandbox is accepted only by exact listed id AND today's security profile — never by image", async () => {
  const legacy = "d4".padEnd(64, "3");
  const sameImageStranger = "e5".padEnd(64, "4");
  const legacyAsRoot = "f6".padEnd(64, "5");
  const legacyUnlimited = "a7".padEnd(64, "6");
  const { docker } = makeDaemon({
    [legacy]: { name: "old", image: "ensemble-sandbox:latest", labelled: false },
    // Same image, not listed: an image match proves nothing about who created it.
    [sameImageStranger]: { name: "other", image: "ensemble-sandbox:latest", labelled: false },
    [legacyAsRoot]: { name: "root", image: "ensemble-sandbox:latest", labelled: false, user: "" },
    [legacyUnlimited]: { name: "nolimit", image: "ensemble-sandbox:latest", labelled: false, memory: 0 },
  });
  const client = createLocalDockerSandboxClientV1({
    docker: docker as never,
    image: "ensemble-sandbox:latest",
    legacyUnlabelledSandboxIds: [legacy, legacyAsRoot, legacyUnlimited],
  });
  await assert.rejects(client.readFileUtf8(legacy, "/x"), /exec reached/);
  await assert.rejects(client.readFileUtf8(sameImageStranger, "/x"), DockerSandboxNotManagedErrorV1);
  await assert.rejects(client.readFileUtf8(legacyAsRoot, "/x"), DockerSandboxNotManagedErrorV1, "root fails the profile");
  await assert.rejects(client.readFileUtf8(legacyUnlimited, "/x"), DockerSandboxNotManagedErrorV1, "no memory limit fails the profile");

  // No list configured: no legacy grace at all, whatever the image.
  const unconfigured = createLocalDockerSandboxClientV1({ docker: docker as never, image: "ensemble-sandbox:latest" });
  await assert.rejects(unconfigured.readFileUtf8(legacy, "/x"), DockerSandboxNotManagedErrorV1);
});

test("destroy is replay-safe: an already-removed sandbox reads as destroyed, not as a permanent failure", async () => {
  const { docker, removed } = makeDaemon({
    [MINE]: { name: "mine", image: "ensemble-sandbox:latest", labelled: true },
  });
  const client = createLocalDockerSandboxClientV1({ docker: docker as never, image: "ensemble-sandbox:latest" });
  await client.destroySandbox(MINE);
  assert.deepEqual(removed, [MINE]);
  // Crash recovery (or a reset after a manual `docker rm`) re-issues it:
  await client.destroySandbox(MINE);
  assert.deepEqual(removed, [MINE]);
});

test("createSandbox: labelled, resource-limited, no capabilities, no privilege escalation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeDocker = {
    createContainer: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return Promise.resolve({ id: SANDBOX_ID, start: () => Promise.resolve() });
    },
  };
  const client = createLocalDockerSandboxClientV1({ docker: fakeDocker as never });
  await client.createSandbox();

  const opts = calls[0] as {
    Labels: Record<string, string>;
    HostConfig: Record<string, unknown>;
  };
  assert.equal(opts.Labels[DOCKER_SANDBOX_LABEL_V1], "1");
  assert.equal(opts.HostConfig["Memory"], DEFAULT_DOCKER_SANDBOX_LIMITS_V1.memoryBytes);
  assert.equal(opts.HostConfig["MemorySwap"], DEFAULT_DOCKER_SANDBOX_LIMITS_V1.memoryBytes);
  assert.equal(opts.HostConfig["NanoCpus"], DEFAULT_DOCKER_SANDBOX_LIMITS_V1.cpus * 1e9);
  assert.equal(opts.HostConfig["PidsLimit"], DEFAULT_DOCKER_SANDBOX_LIMITS_V1.pids);
  assert.deepEqual(opts.HostConfig["CapDrop"], ["ALL"]);
  assert.deepEqual(opts.HostConfig["SecurityOpt"], ["no-new-privileges"]);
});

/**
 * A daemon whose one managed container runs a scripted exec (`produce`
 * writes to its output stream), with `process.kill` captured so the
 * adapter's host-pid kill is observable. Call `restore` when done.
 */
function makeExecDaemon(
  produce: (stream: Duplex) => void,
  options?: {
    /** Processes still carrying the marker after the tree kill (a kill that did not take). */
    readonly survivorsAfterKill?: number;
  }
): {
  readonly docker: unknown;
  readonly killed: number[];
  /** Marker scans the adapter ran (each one kills whatever carries the marker). */
  readonly markerScans: string[];
  restore(): void;
} {
  const killed: number[] = [];
  const markerScans: string[] = [];
  let running = true;
  const newStream = (): Duplex =>
    new Duplex({
      read() {
        // Output is pushed explicitly.
      },
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  const docker = {
    modem: {
      demuxStream: (stream: Duplex, stdout: Duplex) => {
        stream.on("data", (chunk: Buffer) => stdout.write(chunk));
        stream.on("end", () => stdout.end());
      },
    },
    getContainer: () => ({
      inspect: () => Promise.resolve(MANAGED_INSPECT),
      exec: (opts: { Cmd: readonly string[] }) => {
        const script = opts.Cmd[2] ?? "";
        if (script.includes("/proc/[0-9]*")) {
          // The adapter's tree kill: first scan finds the tree, second
          // verifies it is gone (or, if scripted, that some survived).
          markerScans.push(script);
          const found = markerScans.length % 2 === 1 ? 2 : (options?.survivorsAfterKill ?? 0);
          return Promise.resolve({
            start: () => {
              const stream = newStream();
              setImmediate(() => {
                stream.push(`${found}\n`);
                stream.push(null);
              });
              return Promise.resolve(stream);
            },
            inspect: () => Promise.resolve({ ExitCode: 0, Running: false, Pid: 0 }),
          });
        }
        return Promise.resolve({
          start: () => {
            const stream = newStream();
            setImmediate(() => produce(stream));
            return Promise.resolve(stream);
          },
          inspect: () => Promise.resolve({ ExitCode: 0, Running: running, Pid: 777 }),
        });
      },
    }),
  };
  const originalKill = process.kill;
  (process as unknown as { kill: typeof process.kill }).kill = ((pid: number) => {
    killed.push(pid);
    running = false;
    return true;
  }) as typeof process.kill;
  return {
    docker,
    killed,
    markerScans,
    restore(): void {
      (process as unknown as { kill: typeof process.kill }).kill = originalKill;
    },
  };
}

test("exec capture: a command that floods output is killed at the byte cap instead of filling the control plane's heap", async () => {
  const daemon = makeExecDaemon((stream) => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 40; i++) {
      stream.push(chunk);
    }
  });
  try {
    const client = createLocalDockerSandboxClientV1({ docker: daemon.docker as never });
    const result = await client.runCommand({ sandboxId: SANDBOX_ID, argv: ["yes"], cwd: "/", attemptKey: "abc123abc123abc1" });
    assert.equal(result.exitCode, 124);
    assert.match(result.stderrTail, /command stopped: output exceeded/);
    assert.deepEqual(daemon.killed, [777]);
  } finally {
    daemon.restore();
  }
});

test("exec capture: a command that never exits is killed at its deadline", async () => {
  const daemon = makeExecDaemon(() => undefined);
  try {
    const client = createLocalDockerSandboxClientV1({ docker: daemon.docker as never, commandTimeoutMs: 50 });
    const result = await client.runCommand({
      sandboxId: SANDBOX_ID,
      argv: ["sleep", "infinity"],
      cwd: "/",
      attemptKey: "abc123abc123abc1",
    });
    assert.equal(result.exitCode, 124);
    assert.match(result.stderrTail, /command stopped: timed out/);
    assert.deepEqual(daemon.killed, [777]);
    // The whole tree is killed by the attempt marker, then verified gone.
    assert.equal(daemon.markerScans.length, 2);
    assert.ok(daemon.markerScans[0]?.includes("'ENSEMBLE_ATTEMPT_KEY_V1=abc123abc123abc1'"));
  } finally {
    daemon.restore();
  }
});

test("exec capture: a stop that cannot be PROVEN (marked processes survive) throws, never a terminal exit code", async () => {
  // Returning 124 while children kept running is how a 'stopped' round kept
  // editing files. An unprovable stop leaves the attempt open for recovery.
  const daemon = makeExecDaemon(() => undefined, { survivorsAfterKill: 1 });
  try {
    const client = createLocalDockerSandboxClientV1({ docker: daemon.docker as never, commandTimeoutMs: 50 });
    await assert.rejects(
      client.runCommand({ sandboxId: SANDBOX_ID, argv: ["sleep", "infinity"], cwd: "/", attemptKey: "abc123abc123abc1" }),
      DockerExecNotStoppedErrorV1
    );
  } finally {
    daemon.restore();
  }
});
