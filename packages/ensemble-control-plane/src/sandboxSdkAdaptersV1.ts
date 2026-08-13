/**
 * SDK-backed E2B and Daytona sandbox clients (plan Part 5's remaining
 * integration item, tracked as a non-blocking suggestion by the last two
 * implementation reviews).
 *
 * Behind the identical `SandboxClientV1` interface the fetch-based reference
 * adapters implement (`sandboxProviderAdaptersV1.ts` in
 * `packages/ensemble-engine/src`), this file calls the vendor SDKs
 * (`e2b`, `@daytona/sdk`) directly. Those packages are dependencies of
 * `@ensemble/control-plane` ONLY — the engine package depends on nothing but
 * Node plus the Part 2/3 workspace packages — so this is the ONLY file in the
 * repo that imports either vendor SDK; `sandboxLifecycleV1.ts`'s factory, the
 * executor, and the gate machinery all still depend only on `SandboxClientV1`.
 *
 * Each vendor's real class is wrapped by a small `*FactoryV1` seam
 * (`E2bSandboxFactoryV1`, `DaytonaSandboxFactoryV1`) so tests can inject a
 * fake without a network call; production callers never override it — the
 * defaults construct the real SDK clients.
 *
 * Outcome discipline mirrors the fetch adapters exactly (this is what 4c
 * recovery relies on):
 * - `runCommand` never fabricates a result. E2B's `commands.run` THROWS
 *   `CommandExitError` on a non-zero exit; that error itself carries a real
 *   exit code, so it is caught and treated as a valid result, not a
 *   transport failure. Daytona's `executeCommand` returns its exit code
 *   directly, non-zero included. Any OTHER thrown error propagates,
 *   leaving the open attempt record for 4c recovery — nothing here
 *   fabricates success.
 * - `resolveRealPath` is fail-closed: `undefined` unless the SDK proves a
 *   resolved real target. E2B exposes `getInfo().symlinkTarget` directly, so
 *   symlink chains are followed hop-by-hop via the filesystem API. Daytona's
 *   SDK exposes no symlink-target field on `FileInfo`, so real-path
 *   resolution instead runs `readlink -f` THROUGH the provider's own process
 *   API (`process.executeCommand`, an RPC to the sandbox — never a local
 *   child process) and trusts only a `0`-exit, absolute-path result.
 * - `findCommandByAttemptKey` returns `"executed"` only on a positive marker
 *   match against the SDK's live process/session listing, else `"unknown"`
 *   (neither platform's SDK exposes complete command history, so absence
 *   proves nothing).
 */
import { Buffer } from "node:buffer";
import {
  CommandExitError,
  FileType,
  NotFoundError,
  Sandbox as E2bSandbox,
} from "e2b";
import { Daytona } from "@daytona/sdk";
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
const MAX_SYMLINK_HOPS_V1 = 40;

function tail(text: string): string {
  return text.length > MAX_TAIL_CHARS_V1 ? text.slice(-MAX_TAIL_CHARS_V1) : text;
}

/** Resolve `target` (from a symlink at `fromPath`) against its containing directory. */
function resolveRelativeToV1(fromPath: string, target: string): string {
  if (target.startsWith("/")) {
    return target;
  }
  const lastSlash = fromPath.lastIndexOf("/");
  const baseDir = lastSlash > 0 ? fromPath.slice(0, lastSlash) : "/";
  const segments: string[] = [];
  for (const part of `${baseDir}/${target}`.split("/")) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join("/")}`;
}

// ─── E2B ─────────────────────────────────────────────────────────────────

/** One filesystem entry as reported by the E2B SDK, narrowed to what this file uses. */
export interface E2bFileEntryV1 {
  readonly path: string;
  readonly type?: string;
  readonly symlinkTarget?: string;
}

export interface E2bDirEntryV1 {
  readonly name: string;
  readonly type?: string;
}

export interface E2bProcessInfoV1 {
  readonly tag?: string;
  readonly envs?: Readonly<Record<string, string>>;
}

/** The subset of a connected E2B `Sandbox` instance this file calls. */
export interface E2bSandboxHandleV1 {
  readonly sandboxId: string;
  readonly files: {
    write(path: string, data: string): Promise<unknown>;
    remove(path: string): Promise<void>;
    read(path: string): Promise<string>;
    list(path: string): Promise<readonly E2bDirEntryV1[]>;
    getInfo(path: string): Promise<E2bFileEntryV1>;
  };
  readonly commands: {
    run(
      cmd: string,
      opts: { readonly cwd: string; readonly envs: Readonly<Record<string, string>> }
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
    list(): Promise<readonly E2bProcessInfoV1[]>;
  };
}

/** DI seam over the real `e2b` SDK — production callers never override it. */
export interface E2bSandboxFactoryV1 {
  create(templateId: string, apiKey: string): Promise<E2bSandboxHandleV1>;
  connect(sandboxId: string, apiKey: string): Promise<E2bSandboxHandleV1>;
  kill(sandboxId: string, apiKey: string): Promise<boolean>;
}

/**
 * E2B's `commands.run` THROWS `CommandExitError` on a non-zero exit; that error
 * carries a real exit code, so it is a valid RESULT, not a transport failure.
 * Any other error propagates, leaving the attempt record open for 4c recovery.
 *
 * Extracted and exported because this translation is the whole outcome
 * discipline for E2B, and it lives BELOW the `E2bSandboxFactoryV1` DI seam —
 * a test that injects a fake factory returns an already-translated handle and
 * so cannot reach this code at all. Testing it as a function is the only way
 * to test the code production actually runs.
 */
export async function runE2bCommandCatchingExitV1(
  run: () => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommandExitError) {
      return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

function wrapE2bSandbox(sandbox: E2bSandbox): E2bSandboxHandleV1 {
  return {
    sandboxId: sandbox.sandboxId,
    files: {
      async write(path, data) {
        return sandbox.files.write(path, data);
      },
      async remove(path) {
        await sandbox.files.remove(path);
      },
      async read(path) {
        return sandbox.files.read(path);
      },
      async list(path) {
        const entries = await sandbox.files.list(path);
        return entries.map((entry) => ({ name: entry.name, type: entry.type }));
      },
      async getInfo(path) {
        const entry = await sandbox.files.getInfo(path);
        return { path: entry.path, type: entry.type, symlinkTarget: entry.symlinkTarget };
      },
    },
    commands: {
      async run(cmd, opts) {
        return runE2bCommandCatchingExitV1(async () => {
          const result = await sandbox.commands.run(cmd, {
            cwd: opts.cwd,
            envs: opts.envs,
            background: false,
          });
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        });
      },
      async list() {
        const processes = await sandbox.commands.list();
        return processes.map((entry) => ({ tag: entry.tag, envs: entry.envs }));
      },
    },
  };
}

function defaultE2bSandboxFactoryV1(): E2bSandboxFactoryV1 {
  return {
    async create(templateId, apiKey) {
      const sandbox = await E2bSandbox.create(templateId, { apiKey });
      return wrapE2bSandbox(sandbox);
    },
    async connect(sandboxId, apiKey) {
      const sandbox = await E2bSandbox.connect(sandboxId, { apiKey });
      return wrapE2bSandbox(sandbox);
    },
    async kill(sandboxId, apiKey) {
      return E2bSandbox.kill(sandboxId, { apiKey });
    },
  };
}

async function resolveE2bRealPathV1(
  handle: E2bSandboxHandleV1,
  absolutePath: string
): Promise<string | undefined> {
  let current = absolutePath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS_V1; hop++) {
    let entry: E2bFileEntryV1;
    try {
      entry = await handle.files.getInfo(current);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
    if (entry.type !== FileType.SYMLINK || entry.symlinkTarget === undefined) {
      return entry.path;
    }
    current = resolveRelativeToV1(entry.path, entry.symlinkTarget);
  }
  // A symlink chain that never bottoms out within the hop budget: fail closed.
  return undefined;
}

export interface CreateE2bSdkSandboxClientOptionsV1 {
  /** The user's E2B API key (Part 5 custody; decrypted in engine-run memory). */
  readonly apiKey: string;
  /** Template for created sandboxes; default `base`. */
  readonly templateId?: string;
  /** DI seam for tests — production callers never override it. */
  readonly factory?: E2bSandboxFactoryV1;
}

/** SDK-backed E2B `SandboxClientV1`. */
export function createE2bSdkSandboxClientV1(
  options: CreateE2bSdkSandboxClientOptionsV1
): SandboxClientV1 {
  const factory = options.factory ?? defaultE2bSandboxFactoryV1();
  const apiKey = options.apiKey;
  const templateId = options.templateId ?? "base";

  function connect(sandboxId: string): Promise<E2bSandboxHandleV1> {
    return factory.connect(sandboxId, apiKey);
  }

  return {
    provider: "e2b",

    async createSandbox(): Promise<CreateSandboxResultV1> {
      const handle = await factory.create(templateId, apiKey);
      return { sandboxId: handle.sandboxId };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      await factory.kill(sandboxId, apiKey);
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const handle = await connect(request.sandboxId);
      const result = await handle.commands.run(commandText, {
        cwd: request.cwd,
        envs: { [SANDBOX_ATTEMPT_KEY_MARKER_V1]: request.attemptKey },
      });
      return {
        exitCode: result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const handle = await connect(sandboxId);
      return resolveE2bRealPathV1(handle, absolutePath);
    },

    async writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      const handle = await connect(sandboxId);
      await handle.files.write(absolutePath, contentUtf8);
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      const handle = await connect(sandboxId);
      await handle.files.remove(absolutePath);
    },

    async readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      try {
        const handle = await connect(sandboxId);
        return await handle.files.read(absolutePath);
      } catch {
        return undefined;
      }
    },

    async listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      try {
        const handle = await connect(sandboxId);
        const entries = await handle.files.list(absolutePath);
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.type === FileType.DIR ? "directory" : "file",
        }));
      } catch {
        return undefined;
      }
    },

    async findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      try {
        const handle = await connect(sandboxId);
        const processes = await handle.commands.list();
        for (const entry of processes) {
          if (
            entry.tag === attemptKey ||
            entry.envs?.[SANDBOX_ATTEMPT_KEY_MARKER_V1] === attemptKey
          ) {
            return "executed";
          }
        }
        // Only running processes are listed; absence proves nothing.
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}

// ─── Daytona ────────────────────────────────────────────────────────────

export interface DaytonaFileEntryV1 {
  readonly name: string;
  readonly isDir: boolean;
  readonly size: number;
}

export interface DaytonaCommandResultV1 {
  readonly exitCode: number;
  readonly result: string;
}

export interface DaytonaSessionCommandV1 {
  readonly command?: string;
}

export interface DaytonaSessionV1 {
  readonly commands?: readonly DaytonaSessionCommandV1[];
}

/** The subset of a resolved Daytona `Sandbox` instance this file calls. */
export interface DaytonaSandboxHandleV1 {
  readonly id: string;
  readonly fs: {
    uploadFile(file: Buffer, remotePath: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
    listFiles(path: string): Promise<readonly DaytonaFileEntryV1[]>;
  };
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Readonly<Record<string, string>>
    ): Promise<DaytonaCommandResultV1>;
    listSessions(): Promise<readonly DaytonaSessionV1[]>;
  };
}

/** DI seam over the real `@daytona/sdk` SDK — production callers never override it. */
export interface DaytonaSandboxFactoryV1 {
  create(apiKey: string): Promise<DaytonaSandboxHandleV1>;
  attach(apiKey: string, sandboxId: string): Promise<DaytonaSandboxHandleV1>;
  destroy(apiKey: string, sandboxId: string): Promise<void>;
}

type DaytonaSandboxV1 = Awaited<ReturnType<Daytona["get"]>>;

function wrapDaytonaSandbox(sandbox: DaytonaSandboxV1): DaytonaSandboxHandleV1 {
  return {
    id: sandbox.id,
    fs: {
      async uploadFile(file, remotePath) {
        await sandbox.fs.uploadFile(file, remotePath);
      },
      async deleteFile(path) {
        await sandbox.fs.deleteFile(path);
      },
      async downloadFile(remotePath) {
        return sandbox.fs.downloadFile(remotePath);
      },
      async listFiles(path) {
        const entries = await sandbox.fs.listFiles(path);
        return entries.map((entry) => ({ name: entry.name, isDir: entry.isDir, size: entry.size }));
      },
    },
    process: {
      async executeCommand(command, cwd, env) {
        const response = await sandbox.process.executeCommand(command, cwd, env);
        return { exitCode: response.exitCode, result: response.result };
      },
      async listSessions() {
        const sessions = await sandbox.process.listSessions();
        return sessions.map((session) => ({
          commands: session.commands?.map((command) => ({ command: command.command })),
        }));
      },
    },
  };
}

function defaultDaytonaSandboxFactoryV1(): DaytonaSandboxFactoryV1 {
  return {
    async create(apiKey) {
      const daytona = new Daytona({ apiKey });
      const sandbox = await daytona.create({});
      return wrapDaytonaSandbox(sandbox);
    },
    async attach(apiKey, sandboxId) {
      const daytona = new Daytona({ apiKey });
      const sandbox = await daytona.get(sandboxId);
      return wrapDaytonaSandbox(sandbox);
    },
    async destroy(apiKey, sandboxId) {
      const daytona = new Daytona({ apiKey });
      const sandbox = await daytona.get(sandboxId);
      await daytona.delete(sandbox);
    },
  };
}

/**
 * Resolve a path to its real target through the sandbox's OWN process API
 * (`readlink -f`, run via `executeCommand` — an RPC to the sandbox, never a
 * local child process): the Daytona SDK's `FileInfo` carries no symlink
 * target field, so this is the only way to prove a resolved real path.
 * Fail-closed: any non-zero exit or a non-absolute result reads as
 * unresolved.
 */
async function resolveDaytonaRealPathV1(
  handle: DaytonaSandboxHandleV1,
  absolutePath: string
): Promise<string | undefined> {
  const quoted = quotePosixShellArgV1(absolutePath);
  const response = await handle.process.executeCommand(`test -e ${quoted} && readlink -f ${quoted}`);
  if (response.exitCode !== 0) {
    return undefined;
  }
  const resolved = response.result.trim();
  return resolved.startsWith("/") ? resolved : undefined;
}

export interface CreateDaytonaSdkSandboxClientOptionsV1 {
  /** The user's Daytona API key (Part 5 custody; decrypted in engine-run memory). */
  readonly apiKey: string;
  /** DI seam for tests — production callers never override it. */
  readonly factory?: DaytonaSandboxFactoryV1;
}

/** SDK-backed Daytona `SandboxClientV1`. */
export function createDaytonaSdkSandboxClientV1(
  options: CreateDaytonaSdkSandboxClientOptionsV1
): SandboxClientV1 {
  const factory = options.factory ?? defaultDaytonaSandboxFactoryV1();
  const apiKey = options.apiKey;

  function attach(sandboxId: string): Promise<DaytonaSandboxHandleV1> {
    return factory.attach(apiKey, sandboxId);
  }

  return {
    provider: "daytona",

    async createSandbox(): Promise<CreateSandboxResultV1> {
      const handle = await factory.create(apiKey);
      return { sandboxId: handle.id };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      await factory.destroy(apiKey, sandboxId);
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const handle = await attach(request.sandboxId);
      const response = await handle.process.executeCommand(commandText, request.cwd, {
        [SANDBOX_ATTEMPT_KEY_MARKER_V1]: request.attemptKey,
      });
      return {
        exitCode: response.exitCode,
        stdoutTail: tail(response.result),
        // Daytona's executeCommand reports combined output only — no
        // separate stderr stream is exposed by this endpoint.
        stderrTail: "",
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const handle = await attach(sandboxId);
      return resolveDaytonaRealPathV1(handle, absolutePath);
    },

    async writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      const handle = await attach(sandboxId);
      await handle.fs.uploadFile(Buffer.from(contentUtf8, "utf8"), absolutePath);
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      const handle = await attach(sandboxId);
      await handle.fs.deleteFile(absolutePath);
    },

    async readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      try {
        const handle = await attach(sandboxId);
        const buffer = await handle.fs.downloadFile(absolutePath);
        return buffer.toString("utf8");
      } catch {
        return undefined;
      }
    },

    async listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      try {
        const handle = await attach(sandboxId);
        const entries = await handle.fs.listFiles(absolutePath);
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.isDir ? "directory" : "file",
          ...(Number.isInteger(entry.size) && entry.size >= 0 ? { sizeBytes: entry.size } : {}),
        }));
      } catch {
        return undefined;
      }
    },

    async findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      try {
        const handle = await attach(sandboxId);
        const sessions = await handle.process.listSessions();
        for (const session of sessions) {
          for (const command of session.commands ?? []) {
            if (command.command !== undefined && command.command.includes(attemptKey)) {
              return "executed";
            }
          }
        }
        // executeCommand calls are not session-recorded; absence proves nothing.
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
