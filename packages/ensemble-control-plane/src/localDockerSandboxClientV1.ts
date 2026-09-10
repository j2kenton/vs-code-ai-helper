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
  SandboxClientV1,
  SandboxCommandRequestV1,
  SandboxCommandResultV1,
  SandboxDirEntryV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
} from "../../ensemble-engine/src/sandboxClientV1";

const MAX_TAIL_CHARS_V1 = 4000;
/** `dirname`/coreutils/findutils base — Debian, not Alpine, for glibc-linked tools. */
const DEFAULT_IMAGE_V1 = "node:24-bookworm";

function tail(text: string): string {
  return text.length > MAX_TAIL_CHARS_V1 ? text.slice(-MAX_TAIL_CHARS_V1) : text;
}

/** Run a shell command inside a container via `exec`, collecting full (untruncated) output. */
async function execCaptureV1(
  docker: Docker,
  containerId: string,
  shellCommand: string,
  cwd?: string
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", shellCommand],
    ...(cwd !== undefined ? { WorkingDir: cwd } : {}),
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough();
  stdoutSink.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrSink.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutSink, stderrSink);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const inspected = await exec.inspect();
  return {
    exitCode: inspected.ExitCode ?? -1,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

export interface CreateLocalDockerSandboxClientOptionsV1 {
  /** Ignored — no credential exists for a local daemon; see this file's header comment. */
  readonly apiKey?: string;
  /** Image for created sandboxes; default `node:24-bookworm`. */
  readonly image?: string;
  /** DI seam for tests — production callers never override it. */
  readonly docker?: Docker;
}

/** Self-hosted `SandboxClientV1` over the local Docker daemon. */
export function createLocalDockerSandboxClientV1(
  options?: CreateLocalDockerSandboxClientOptionsV1
): SandboxClientV1 {
  const docker = options?.docker ?? new Docker();
  const image = options?.image ?? DEFAULT_IMAGE_V1;

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
        HostConfig: { AutoRemove: false },
      });
      await container.start();
      return { sandboxId: container.id };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      await docker.getContainer(sandboxId).remove({ force: true });
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const result = await execCaptureV1(docker, request.sandboxId, commandText, request.cwd);
      return {
        exitCode: result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const quoted = quotePosixShellArgV1(absolutePath);
      const result = await execCaptureV1(
        docker,
        sandboxId,
        `test -e ${quoted} && readlink -f ${quoted}`
      );
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
      const result = await execCaptureV1(
        docker,
        sandboxId,
        `mkdir -p "$(dirname ${quotedPath})" && printf '%s' ${quotedEncoded} | base64 -d > ${quotedPath}`
      );
      if (result.exitCode !== 0) {
        throw new Error(`writeFile failed (exit ${result.exitCode}): ${tail(result.stderr)}`);
      }
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      const quoted = quotePosixShellArgV1(absolutePath);
      const result = await execCaptureV1(docker, sandboxId, `rm -f ${quoted}`);
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
      const result = await execCaptureV1(
        docker,
        sandboxId,
        `test -f ${quoted} && base64 ${quoted}`
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
      const result = await execCaptureV1(
        docker,
        sandboxId,
        `test -d ${quoted} && find ${quoted} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n'`
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
  };
}
