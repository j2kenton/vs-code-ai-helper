/**
 * Self-hosted Docker `SandboxClientV1` (companion to `sandboxSdkAdaptersV1.ts`'s
 * E2B/Daytona clients): sandboxes are containers on the SAME Docker daemon the
 * control plane itself runs next to — free, unmetered, bounded only by that
 * host's own resources. This is the default for routine use; `docker`
 * complements `e2b`/`daytona` as a `SandboxProviderV1`, it doesn't replace
 * them — a task that wants real microVM isolation still binds to E2B/Daytona.
 *
 * Like the vendor SDK adapters, this file lives in `@ensemble/control-plane`
 * (not `ensemble-engine`) specifically because the engine package's own
 * source-scan test forbids child-process/exec usage in ITS sources — the
 * engine only ever executes through the `SandboxClientV1` interface, never
 * directly. `dockerode` talks to the Docker daemon over its HTTP API (a unix
 * socket by default), the same shape of "provider API call" `e2b`/
 * `@daytona/sdk` make over the network — never a local child process.
 *
 * Outcome discipline mirrors the vendor adapters:
 * - `runCommand` never fabricates a result: any exit code from a real `exec`
 *   is a valid result; only a Docker daemon/transport failure throws, leaving
 *   the open attempt record for 4c recovery.
 * - `resolveRealPath` is fail-closed (`readlink -f` through the exec API,
 *   mirroring Daytona's approach — trusts only a 0-exit absolute result).
 * - `findCommandByAttemptKey` uses `container.top()` (the daemon's OWN
 *   process introspection via `/proc`, not an in-container binary) to check
 *   for a currently-running process whose command line carries the marker.
 *   Like E2B/Daytona, only LIVE processes are visible this way, so absence
 *   proves nothing — `"unknown"`, never `"notExecuted"`.
 *
 * Trust boundary: the adapter operates ONLY on containers it created
 * (`DOCKER_SANDBOX_LABEL_V1`, full-id match — see `assertManaged`), and
 * creates them with host-protection limits (`DockerSandboxLimitsV1`), a
 * non-root user, no capabilities, and no privilege escalation. Every exec
 * is bounded in output and time. Which USER owns which sandbox is the
 * control plane's record, not the adapter's.
 *
 * No API key exists for a local daemon, but the control plane's sandbox-key
 * gate (`store.readKeyRecord(owner, "sandbox:docker")`) currently applies
 * uniformly to every provider — so a `docker` binding still needs SOME value
 * stored under that key kind today (its content is ignored here). Loosening
 * that gate specifically for `docker` is a follow-up, not done in this pass.
 */
import Docker from "dockerode";
import { PassThrough } from "node:stream";

import type { EngineEffectReconcileVerdictV1 } from "../../ensemble-engine/src/gateMachineryV1";
import {
  buildMarkedSandboxCommandV1,
  quotePosixShellArgV1,
  CreateSandboxResultV1,
  InteractiveSessionHandleV1,
  InteractiveSessionRequestV1,
  InteractiveSessionResultV1,
  SandboxClientV1,
  SandboxCommandRequestV1,
  SandboxCommandResultV1,
  SandboxDirEntryV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
} from "../../ensemble-engine/src/sandboxClientV1";

const MAX_TAIL_CHARS_V1 = 4000;
/** `dirname`/coreutils/findutils base — Debian, not Alpine, for glibc-linked tools. */
const DEFAULT_IMAGE_V1 = "node:24-bookworm";

/**
 * The label every container this adapter creates carries, and the ONLY
 * thing that makes a container operable through it. Before this existed,
 * any container id — or a two-character id PREFIX, or a container name,
 * which the Docker API resolves just as happily — could be passed in as a
 * `sandboxId` and read, exec'd into, or destroyed: another user's sandbox,
 * or an unrelated service on the host (review finding, confirmed live
 * 2026-09-11: `b7` resolved to a real sandbox).
 */
export const DOCKER_SANDBOX_LABEL_V1 = "com.ensembleworkflow.sandbox";

/** Output past this is not collected (the exec is killed): a bound on control-plane memory, per command. */
const DEFAULT_MAX_CAPTURE_BYTES_V1 = 16 * 1024 * 1024;
/** Deadline for the adapter's own small housekeeping execs (stat, readlink, write, list). */
const DEFAULT_HOUSEKEEPING_TIMEOUT_MS_V1 = 2 * 60 * 1000;
/** Deadline for `runCommand` — a whole CLI round. Generous, but never unbounded. */
const DEFAULT_COMMAND_TIMEOUT_MS_V1 = 60 * 60 * 1000;
/** Files larger than this are not read back through `readFileUtf8` at all. */
const DEFAULT_MAX_READ_FILE_BYTES_V1 = 8 * 1024 * 1024;

/** The exit code reported for a command the adapter itself stopped (the shell convention for a timeout). */
export const DOCKER_EXEC_STOPPED_EXIT_CODE_V1 = 124;

function tail(text: string): string {
  return text.length > MAX_TAIL_CHARS_V1 ? text.slice(-MAX_TAIL_CHARS_V1) : text;
}

/** Signal an exec's process by its HOST pid (see `createInteractiveSession`'s kill for why not a nested exec). */
async function killExecV1(exec: Docker.Exec): Promise<void> {
  try {
    const inspected = await exec.inspect();
    if (inspected.Running && inspected.Pid > 0) {
      process.kill(inspected.Pid, "SIGKILL");
    }
  } catch {
    // Already gone, or the daemon no longer knows it: nothing left to stop.
  }
}

interface ExecCaptureOptionsV1 {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/**
 * Run a shell command inside a container via `exec`, collecting its output
 * up to `maxBytes` (stdout + stderr together) within `timeoutMs`. Either
 * limit stops the command — killed, its stream torn down — and reports
 * `DOCKER_EXEC_STOPPED_EXIT_CODE_V1` with the reason appended to stderr, so a
 * runaway or hostile command can neither pin control-plane memory nor hold
 * a request open forever.
 */
async function execCaptureV1(
  docker: Docker,
  containerId: string,
  shellCommand: string,
  options: ExecCaptureOptionsV1
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", shellCommand],
    ...(options.cwd !== undefined ? { WorkingDir: options.cwd } : {}),
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let collected = 0;
  let stoppedReason: string | undefined;
  const stop = (reason: string): void => {
    if (stoppedReason !== undefined) {
      return;
    }
    stoppedReason = reason;
    void killExecV1(exec).finally(() => stream.destroy());
  };
  const collect = (into: Buffer[]) => (chunk: Buffer): void => {
    if (stoppedReason !== undefined) {
      return;
    }
    collected += chunk.length;
    if (collected > options.maxBytes) {
      stop(`output exceeded ${options.maxBytes} bytes`);
      return;
    }
    into.push(chunk);
  };
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough();
  stdoutSink.on("data", collect(stdoutChunks));
  stderrSink.on("data", collect(stderrChunks));
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);
  const timer = setTimeout(() => stop(`timed out after ${options.timeoutMs} ms`), options.timeoutMs);
  timer.unref?.();
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", (error: unknown) => (stoppedReason !== undefined ? resolve() : reject(error)));
    });
  } finally {
    clearTimeout(timer);
  }
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (stoppedReason !== undefined) {
    return {
      exitCode: DOCKER_EXEC_STOPPED_EXIT_CODE_V1,
      stdout,
      stderr: `${stderr}\n[ensemble] command stopped: ${stoppedReason}`,
    };
  }
  const inspected = await exec.inspect();
  return { exitCode: inspected.ExitCode ?? -1, stdout, stderr };
}

/** True for Docker's "no such container" (HTTP 404), which destroy treats as already done. */
function isDockerNotFoundV1(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

/**
 * The id is deliberately NOT in the message: it can reach a log line, and a
 * probing caller should learn nothing about which ids exist on the host.
 */
export class DockerSandboxNotManagedErrorV1 extends Error {
  constructor() {
    super("the requested sandbox is not one this control plane created");
    this.name = "DockerSandboxNotManagedErrorV1";
  }
}

/**
 * `uid:gid` this process itself runs as, when Node can report it (POSIX
 * only — `undefined` on Windows, where this whole adapter is moot anyway
 * since it targets a local Docker daemon meant for the deployment host).
 * Sandboxes default to running AS this same user rather than the image's
 * default (commonly root): `createInteractiveSession`'s `kill()` signals
 * the sandboxed process via this control-plane process's own `process.kill`
 * — a non-root process cannot signal a root-owned one (confirmed live:
 * EPERM), so containers must run as us, not as root, for that to work at
 * all. Least-privilege is also just the correct default regardless.
 */
/**
 * A root control plane must not hand its uid to sandboxes: they would run
 * as root on the host kernel. `nobody` instead — it can still be signalled
 * by a root control plane, which is the reason the default mirrors this
 * process at all.
 */
const DEFAULT_CONTAINER_USER_V1: string | undefined =
  typeof process.getuid === "function" && typeof process.getgid === "function"
    ? process.getuid() === 0
      ? "65534:65534"
      : `${process.getuid()}:${process.getgid()}`
    : undefined;

/**
 * Host-protection limits applied to every created sandbox. A sandbox runs
 * AI-generated code on the SAME kernel as the control plane; without these
 * one fork bomb or runaway allocation takes the control plane (and every
 * other sandbox) down with it. Network egress is NOT restricted here — that
 * needs host-level rules or a separate sandbox host, recorded as an open
 * item rather than half-done in a container flag.
 */
export interface DockerSandboxLimitsV1 {
  /** Hard memory cap in bytes (swap disabled at the same value). */
  readonly memoryBytes: number;
  /** CPU quota in whole-or-fractional CPUs. */
  readonly cpus: number;
  /** Maximum processes/threads inside the container. */
  readonly pids: number;
}

export const DEFAULT_DOCKER_SANDBOX_LIMITS_V1: DockerSandboxLimitsV1 = {
  memoryBytes: 4 * 1024 * 1024 * 1024,
  cpus: 2,
  pids: 1024,
};

export interface CreateLocalDockerSandboxClientOptionsV1 {
  /** Ignored — no credential exists for a local daemon; see this file's header comment. */
  readonly apiKey?: string;
  /** Image for created sandboxes; default `node:24-bookworm`. */
  readonly image?: string;
  /**
   * `uid:gid` sandboxes run as; default matches THIS process (see
   * `DEFAULT_CONTAINER_USER_V1`'s comment). Pass `""` to keep the image's
   * own default user (root, typically) instead — e.g. for an image whose
   * setup genuinely needs it.
   */
  readonly user?: string;
  readonly limits?: DockerSandboxLimitsV1;
  /**
   * Images whose containers predate `DOCKER_SANDBOX_LABEL_V1` and are
   * still accepted as sandboxes (labels cannot be added to an existing
   * container, and replacing a signed-in sandbox costs its owner a fresh
   * CLI login). Default: the configured `image` only — never a general
   * image like `node:*` that unrelated containers could also run.
   */
  readonly legacyUnlabelledImages?: readonly string[];
  /** Command deadline for `runCommand`; default one hour. */
  readonly commandTimeoutMs?: number;
  /** DI seam for tests — production callers never override it. */
  readonly docker?: Docker;
}

/** Self-hosted `SandboxClientV1` over the local Docker daemon. */
export function createLocalDockerSandboxClientV1(
  options?: CreateLocalDockerSandboxClientOptionsV1
): SandboxClientV1 {
  const docker = options?.docker ?? new Docker();
  const image = options?.image ?? DEFAULT_IMAGE_V1;
  const containerUser = options?.user ?? DEFAULT_CONTAINER_USER_V1;
  const limits = options?.limits ?? DEFAULT_DOCKER_SANDBOX_LIMITS_V1;
  const commandTimeoutMs = options?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS_V1;
  // A legacy grace for the configured sandbox image only, and only when it
  // is not the generic default (a bare `node:*` container is not evidence
  // of anything).
  const legacyImages = new Set(
    options?.legacyUnlabelledImages ?? (options?.image !== undefined ? [options.image] : [])
  );
  const verified = new Set<string>();

  /**
   * Refuse anything but a container this adapter created, addressed by its
   * FULL id. Exact-id matching closes Docker's prefix and name resolution;
   * the label (or, for pre-label sandboxes, the dedicated image) closes
   * attaching to unrelated host containers. Verified ids are remembered
   * for the life of this client; a destroyed one is forgotten.
   */
  async function assertManaged(sandboxId: string): Promise<void> {
    if (verified.has(sandboxId)) {
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(sandboxId)) {
      throw new DockerSandboxNotManagedErrorV1();
    }
    let inspected: Docker.ContainerInspectInfo;
    try {
      inspected = await docker.getContainer(sandboxId).inspect();
    } catch {
      throw new DockerSandboxNotManagedErrorV1();
    }
    const labelled = inspected.Config?.Labels?.[DOCKER_SANDBOX_LABEL_V1] === "1";
    const legacy = legacyImages.has(inspected.Config?.Image ?? "");
    if (inspected.Id !== sandboxId || !(labelled || legacy)) {
      throw new DockerSandboxNotManagedErrorV1();
    }
    verified.add(sandboxId);
  }

  async function capture(
    sandboxId: string,
    shellCommand: string,
    captureOptions?: Partial<ExecCaptureOptionsV1>
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    await assertManaged(sandboxId);
    return execCaptureV1(docker, sandboxId, shellCommand, {
      timeoutMs: DEFAULT_HOUSEKEEPING_TIMEOUT_MS_V1,
      maxBytes: DEFAULT_MAX_CAPTURE_BYTES_V1,
      ...captureOptions,
    });
  }

  return {
    provider: "docker",

    async createSandbox(): Promise<CreateSandboxResultV1> {
      const container = await docker.createContainer({
        Image: image,
        // Keeps the container alive with nothing to supervise; every real
        // unit of work arrives as a separate `exec`, same shape as a real
        // remote sandbox's "already running, attach and run commands" model.
        Cmd: ["sleep", "infinity"],
        Tty: false,
        Labels: { [DOCKER_SANDBOX_LABEL_V1]: "1" },
        HostConfig: {
          AutoRemove: false,
          Memory: limits.memoryBytes,
          MemorySwap: limits.memoryBytes,
          NanoCpus: Math.round(limits.cpus * 1e9),
          PidsLimit: limits.pids,
          // Nothing a sandbox legitimately does needs a capability or a
          // setuid escalation; both only widen what escaped code can reach.
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
        ...(containerUser !== undefined && containerUser.length > 0 ? { User: containerUser } : {}),
      });
      await container.start();
      verified.add(container.id);
      return { sandboxId: container.id };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      try {
        await assertManaged(sandboxId);
      } catch (error) {
        // An id that no longer resolves at all is already destroyed — the
        // replay-safe answer crash recovery and reset both need. A container
        // that exists but is NOT ours is still refused.
        const exists = await docker
          .getContainer(sandboxId)
          .inspect()
          .then(() => true)
          .catch((inspectError: unknown) => !isDockerNotFoundV1(inspectError));
        if (!exists && /^[0-9a-f]{64}$/.test(sandboxId)) {
          return;
        }
        throw error;
      }
      try {
        await docker.getContainer(sandboxId).remove({ force: true });
      } catch (error) {
        if (!isDockerNotFoundV1(error)) {
          throw error;
        }
      } finally {
        verified.delete(sandboxId);
      }
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const result = await capture(request.sandboxId, commandText, {
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        timeoutMs: commandTimeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const quoted = quotePosixShellArgV1(absolutePath);
      const result = await capture(sandboxId, `test -e ${quoted} && readlink -f ${quoted}`);
      if (result.exitCode !== 0) {
        return undefined;
      }
      const resolved = result.stdout.trim();
      return resolved.startsWith("/") ? resolved : undefined;
    },

    async writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      const quotedPath = quotePosixShellArgV1(absolutePath);
      // Base64 carries no shell-special characters, so the content is safe to
      // embed directly in single quotes without further escaping — the same
      // reason envelope encryption elsewhere in this codebase base64s ciphertext.
      const encoded = Buffer.from(contentUtf8, "utf8").toString("base64");
      const quotedEncoded = quotePosixShellArgV1(encoded);
      const result = await capture(
        sandboxId,
        `mkdir -p "$(dirname ${quotedPath})" && printf '%s' ${quotedEncoded} | base64 -d > ${quotedPath}`
      );
      if (result.exitCode !== 0) {
        throw new Error(`writeFile failed (exit ${result.exitCode}): ${tail(result.stderr)}`);
      }
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      const quoted = quotePosixShellArgV1(absolutePath);
      const result = await capture(sandboxId, `rm -f ${quoted}`);
      if (result.exitCode !== 0) {
        throw new Error(`deleteFile failed (exit ${result.exitCode}): ${tail(result.stderr)}`);
      }
    },

    async readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const quoted = quotePosixShellArgV1(absolutePath);
      // Base64-out through the pipe rather than raw cat: exec output otherwise
      // passes through Docker's text framing, which is not binary-safe for
      // arbitrary bytes. The content is UTF-8 text by contract, but round-tripping
      // through base64 costs nothing and avoids relying on that framing at all.
      // The size test runs FIRST, inside the sandbox: a multi-gigabyte file
      // must be refused before any of it is streamed to the control plane.
      const result = await capture(
        sandboxId,
        `test -f ${quoted} && [ "$(stat -c %s ${quoted})" -le ${DEFAULT_MAX_READ_FILE_BYTES_V1} ] && base64 ${quoted}`
      );
      if (result.exitCode !== 0) {
        return undefined;
      }
      try {
        return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
      } catch {
        return undefined;
      }
    },

    async listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      const quoted = quotePosixShellArgV1(absolutePath);
      // %y = file-type char (d/f/l/...), %s = size, %f = basename. GNU
      // findutils (present on the Debian-based default image); -mindepth 1
      // excludes the directory itself.
      const result = await capture(
        sandboxId,
        `test -d ${quoted} && find ${quoted} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n' | head -n 10000`
      );
      if (result.exitCode !== 0) {
        return undefined;
      }
      const entries: SandboxDirEntryV1[] = [];
      for (const line of result.stdout.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        const [type, size, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");
        if (type === undefined || size === undefined || name.length === 0) {
          continue;
        }
        const sizeBytes = Number.parseInt(size, 10);
        entries.push({
          name,
          kind: type === "d" ? "directory" : "file",
          ...(Number.isInteger(sizeBytes) && sizeBytes >= 0 ? { sizeBytes } : {}),
        });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },

    async findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      try {
        await assertManaged(sandboxId);
        const top = await docker.getContainer(sandboxId).top({ ps_args: "aux" });
        const marker = `${SANDBOX_ATTEMPT_KEY_MARKER_V1}=${attemptKey}`;
        for (const row of (top.Processes ?? []) as readonly string[][]) {
          if (row.some((field: string) => field.includes(marker) || field.includes(attemptKey))) {
            return "executed";
          }
        }
        // Only currently-running processes are visible this way (the same
        // limitation the E2B/Daytona adapters accept): absence proves nothing.
        return "unknown";
      } catch {
        return "unknown";
      }
    },

    async createInteractiveSession(
      request: InteractiveSessionRequestV1
    ): Promise<InteractiveSessionHandleV1> {
      await assertManaged(request.sandboxId);
      const container = docker.getContainer(request.sandboxId);
      // Tty: true is not cosmetic here — confirmed live against a real CLI
      // (Claude Code's own login flow): without a real terminal attached, a
      // program that checks isatty() before printing its interactive prompt
      // produces NO output at all, even though it is genuinely running. Tty
      // mode also changes the wire format: output is raw bytes, not the
      // stdout/stderr-multiplexed frames a non-Tty exec produces, so this
      // reads the stream directly rather than through `demuxStream`.
      const exec = await container.exec({
        Cmd: [...request.argv],
        WorkingDir: request.cwd,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
      stream.on("data", (chunk: Buffer) => request.onOutput(chunk.toString("utf8")));

      let settle: {
        resolve: (result: InteractiveSessionResultV1) => void;
        reject: (error: unknown) => void;
      };
      const exited = new Promise<InteractiveSessionResultV1>((resolve, reject) => {
        settle = { resolve, reject };
      });
      stream.on("end", () => {
        exec
          .inspect()
          .then((inspected) => settle.resolve({ exitCode: inspected.ExitCode ?? -1 }))
          .catch((error: unknown) => settle.reject(error));
      });
      stream.on("error", (error: unknown) => settle.reject(error));

      return {
        sendInput(data: string): Promise<void> {
          return new Promise<void>((resolve, reject) => {
            stream.write(data, "utf8", (error) => (error ? reject(error) : resolve()));
          });
        },
        wait(): Promise<InteractiveSessionResultV1> {
          return exited;
        },
        async kill(): Promise<void> {
          try {
            const inspected = await exec.inspect();
            if (inspected.Running && inspected.Pid > 0) {
              // `ExecInspectInfo.Pid` is the HOST-namespace pid, not the
              // container's own — a `kill` run through ANOTHER `docker exec`
              // runs inside the container's PID namespace and cannot see
              // this number at all (confirmed live: it reports "no such
              // process" for a pid `docker top`/this inspect both show as
              // very much running). This adapter's own header states the
              // control plane runs on the SAME host as the Docker daemon,
              // so the correct — and only correct — way to signal it is
              // this process's own `process.kill`, not another exec.
              try {
                process.kill(inspected.Pid, "SIGTERM");
              } catch {
                // Already exited between the inspect and the kill: fine.
              }
            }
          } finally {
            stream.end();
          }
        },
      };
    },
  };
}
