/**
 * Provider-neutral sandbox client surface (plan Part 4d).
 *
 * The ONLY path by which the engine ever executes generated code: a
 * `SandboxClientV1` speaks a sandbox provider's own API (E2B or Daytona —
 * `sandboxProviderAdaptersV1.ts` holds the fetch-based reference transports;
 * Part 5 may substitute SDK-backed clients implementing this same interface).
 * The engine process itself never evals, spawns, or shells out anything —
 * commands are structured argv vectors serialized with strict POSIX quoting
 * and sent over the provider API to run INSIDE the user's sandbox
 * (tests/sandboxExecution.test.ts scans this package's sources for
 * child-process/eval/Function-constructor usage to keep that true).
 *
 * Every command carries its Part 4c deterministic attempt key twice — as an
 * environment-variable marker prefixed onto the command line and as request
 * metadata where the provider supports tagging — so post-crash reconciliation
 * (`findCommandByAttemptKey`) can identify whether a given attempt already
 * ran even though neither platform offers native idempotency keys.
 *
 * `resolveRealPath` is the provider-filesystem-API half of the Part 3
 * symlink rule: it resolves a path to its REAL target (symlinks followed) or
 * reports absence, and the executor (`sandboxExecutionV1.ts`) authorizes the
 * RESOLVED target against the binding root — followed-then-checked, never
 * trusted as given.
 */
import type { SandboxProviderV1 } from "../../ensemble-contract/src/sandboxBindingV1";
import type { EngineEffectReconcileVerdictV1 } from "./gateMachineryV1";

/**
 * The environment-variable marker carrying the deterministic attempt key on
 * every sandbox command line (the platforms lack native idempotency keys, so
 * the marker is what reconciliation greps provider process/audit state for).
 */
export const SANDBOX_ATTEMPT_KEY_MARKER_V1 = "ENSEMBLE_ATTEMPT_KEY_V1";

const ATTEMPT_KEY_SHAPE_V1 = /^[0-9a-f]{16,128}$/;

/**
 * Strict POSIX single-quoting: the argument is data, never shell syntax.
 * NUL bytes are rejected outright (no POSIX quoting can carry them).
 */
export function quotePosixShellArgV1(arg: string): string {
  if (arg.includes("\0")) {
    throw new Error("sandbox command arguments must not contain NUL bytes");
  }
  return `'${arg.split("'").join("'\\''")}'`;
}

/**
 * Serialize an argv vector into the single command string the provider APIs
 * accept, prefixed with the attempt-key marker assignment. Every element is
 * strictly quoted — untrusted text (model output, repo URLs, refs) can never
 * become shell syntax; it only ever reaches the sandbox as argument data.
 */
export function buildMarkedSandboxCommandV1(
  argv: readonly string[],
  attemptKey: string
): string {
  if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
    throw new Error("a sandbox command requires a non-empty argv vector");
  }
  if (!ATTEMPT_KEY_SHAPE_V1.test(attemptKey)) {
    throw new Error("attempt keys are lowercase-hex identifiers (deriveExecutionAttemptKeyV1)");
  }
  const quoted = argv.map((arg) => quotePosixShellArgV1(arg)).join(" ");
  return `${SANDBOX_ATTEMPT_KEY_MARKER_V1}=${quotePosixShellArgV1(attemptKey)} ${quoted}`;
}

/** One command execution request against a sandbox. */
export interface SandboxCommandRequestV1 {
  readonly sandboxId: string;
  /** Structured argv — element 0 is the program; nothing is shell syntax. */
  readonly argv: readonly string[];
  /** Absolute working directory INSIDE the sandbox (already confined). */
  readonly cwd: string;
  /** The Part 4c deterministic attempt key threaded as marker/metadata. */
  readonly attemptKey: string;
}

/** Bounded command outcome (tails only — never unbounded payloads). */
export interface SandboxCommandResultV1 {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface CreateSandboxResultV1 {
  readonly sandboxId: string;
}

/** One entry of a read-only directory listing (Part 5 file endpoints). */
export interface SandboxDirEntryV1 {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes?: number;
}

/**
 * The sandbox provider API surface the engine executes through — exclusively.
 * A method that cannot determine its outcome THROWS (leaving the open attempt
 * record for 4c recovery) or fails closed (`resolveRealPath` → `undefined`,
 * `findCommandByAttemptKey` → `"unknown"`); nothing here ever fabricates
 * success.
 */
export interface SandboxClientV1 {
  readonly provider: SandboxProviderV1;
  /** Create a task-owned ephemeral sandbox (lifecycle per the binding). */
  createSandbox(): Promise<CreateSandboxResultV1>;
  /** Destroy a sandbox (the executor gates this on the cleanup policy). */
  destroySandbox(sandboxId: string): Promise<void>;
  /** Run one marked command inside the sandbox via the provider API. */
  runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1>;
  /**
   * Resolve a path to its REAL target via the provider's filesystem API
   * (symlinks followed). `undefined` = the path does not exist or the
   * provider cannot report a resolved target (fail-closed — the executor
   * rejects the path rather than trusting it as given).
   */
  resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined>;
  /** Write a UTF-8 file via the provider filesystem API (path pre-confined). */
  writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void>;
  /** Delete a file via the provider filesystem API (path pre-confined). */
  deleteFile(sandboxId: string, absolutePath: string): Promise<void>;
  /**
   * Read a UTF-8 file via the provider filesystem API (path pre-confined by
   * the Part 3 resolve-then-check rule). `undefined` = not readable as a
   * file — fail-closed, never a fabricated empty result.
   */
  readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined>;
  /**
   * List a directory via the provider filesystem API (path pre-confined).
   * `undefined` = not listable as a directory — fail-closed.
   */
  listDirectory(
    sandboxId: string,
    absolutePath: string
  ): Promise<readonly SandboxDirEntryV1[] | undefined>;
  /**
   * Reconciliation query (plan Part 4c/4d): did a command carrying this
   * attempt-key marker observably run? `"unknown"` when provider state
   * cannot prove it either way — recovery then re-offers, never re-runs.
   */
  findCommandByAttemptKey(
    sandboxId: string,
    attemptKey: string
  ): Promise<EngineEffectReconcileVerdictV1>;
}

/** One recorded execution in the in-memory client's audit ledger. */
export interface RecordedSandboxCommandV1 {
  readonly sandboxId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly attemptKey: string;
  /** The exact marked command line a real provider would have received. */
  readonly commandText: string;
  readonly exitCode: number;
}

export interface InMemorySandboxClientOptionsV1 {
  readonly provider?: SandboxProviderV1;
  /**
   * `"definitive"` (default): the ledger is complete history, so a missing
   * marker proves non-execution. `"unavailable"`: marker queries return
   * `"unknown"` — models a provider whose audit state cannot be read.
   */
  readonly commandLookup?: "definitive" | "unavailable";
  /** Optional command simulation (mutate the fake fs, choose exit codes). */
  readonly onCommand?: (
    request: SandboxCommandRequestV1,
    client: InMemorySandboxClientV1
  ) => SandboxCommandResultV1 | undefined;
}

/** The in-memory reference client (tests / single-process dev). */
export interface InMemorySandboxClientV1 extends SandboxClientV1 {
  addDirectory(sandboxId: string, absolutePath: string): void;
  addFile(sandboxId: string, absolutePath: string, contentUtf8: string): void;
  /** Register a symlink: `linkPath` resolves to `targetAbsolutePath`. */
  addSymlink(sandboxId: string, linkPath: string, targetAbsolutePath: string): void;
  readFile(sandboxId: string, absolutePath: string): string | undefined;
  readonly executedCommands: readonly RecordedSandboxCommandV1[];
  readonly destroyedSandboxIds: readonly string[];
}

interface SandboxFsStateV1 {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly symlinks: Map<string, string>;
}

const MAX_SYMLINK_HOPS_V1 = 64;

/**
 * In-memory sandbox provider: a fake filesystem with symlinks plus a complete
 * command audit ledger keyed by attempt-key marker — the reference for how a
 * real provider's process/audit state backs 4c reconciliation.
 */
export function createInMemorySandboxClientV1(
  options?: InMemorySandboxClientOptionsV1
): InMemorySandboxClientV1 {
  const provider = options?.provider ?? "e2b";
  const lookup = options?.commandLookup ?? "definitive";
  const sandboxes = new Map<string, SandboxFsStateV1>();
  const executedCommands: RecordedSandboxCommandV1[] = [];
  const destroyedSandboxIds: string[] = [];
  let nextSandbox = 0;

  function stateFor(sandboxId: string): SandboxFsStateV1 {
    let state = sandboxes.get(sandboxId);
    if (state === undefined) {
      state = { files: new Map(), dirs: new Set(), symlinks: new Map() };
      sandboxes.set(sandboxId, state);
    }
    return state;
  }

  function addAncestorDirs(state: SandboxFsStateV1, absolutePath: string): void {
    const segments = absolutePath.split("/").filter((segment) => segment.length > 0);
    let prefix = "";
    for (const segment of segments.slice(0, -1)) {
      prefix += `/${segment}`;
      state.dirs.add(prefix);
    }
  }

  function substituteSymlinkPrefix(state: SandboxFsStateV1, path: string): string | undefined {
    let best: { readonly link: string; readonly target: string } | undefined;
    for (const [link, target] of state.symlinks) {
      if (path === link || path.startsWith(`${link}/`)) {
        if (best === undefined || link.length > best.link.length) {
          best = { link, target };
        }
      }
    }
    return best === undefined ? undefined : best.target + path.slice(best.link.length);
  }

  function exists(state: SandboxFsStateV1, path: string): boolean {
    if (path === "/" || state.files.has(path) || state.dirs.has(path)) {
      return true;
    }
    const asPrefix = `${path}/`;
    for (const file of state.files.keys()) {
      if (file.startsWith(asPrefix)) {
        return true;
      }
    }
    for (const dir of state.dirs) {
      if (dir.startsWith(asPrefix)) {
        return true;
      }
    }
    return false;
  }

  const client: InMemorySandboxClientV1 = {
    provider,
    executedCommands,
    destroyedSandboxIds,

    addDirectory(sandboxId: string, absolutePath: string): void {
      const state = stateFor(sandboxId);
      state.dirs.add(absolutePath);
      addAncestorDirs(state, absolutePath);
    },

    addFile(sandboxId: string, absolutePath: string, contentUtf8: string): void {
      const state = stateFor(sandboxId);
      state.files.set(absolutePath, contentUtf8);
      addAncestorDirs(state, absolutePath);
    },

    addSymlink(sandboxId: string, linkPath: string, targetAbsolutePath: string): void {
      const state = stateFor(sandboxId);
      state.symlinks.set(linkPath, targetAbsolutePath);
      addAncestorDirs(state, linkPath);
    },

    readFile(sandboxId: string, absolutePath: string): string | undefined {
      return stateFor(sandboxId).files.get(absolutePath);
    },

    createSandbox(): Promise<CreateSandboxResultV1> {
      const sandboxId = `sbx-${nextSandbox++}`;
      stateFor(sandboxId);
      return Promise.resolve({ sandboxId });
    },

    destroySandbox(sandboxId: string): Promise<void> {
      destroyedSandboxIds.push(sandboxId);
      sandboxes.delete(sandboxId);
      return Promise.resolve();
    },

    runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      // Serializing up front enforces the quoting/marker invariants even in
      // the fake — malformed argv or attempt keys throw exactly as a real
      // transport would refuse to send them.
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const simulated = options?.onCommand?.(request, client);
      const result = simulated ?? { exitCode: 0, stdoutTail: "", stderrTail: "" };
      executedCommands.push({
        sandboxId: request.sandboxId,
        argv: request.argv,
        cwd: request.cwd,
        attemptKey: request.attemptKey,
        commandText,
        exitCode: result.exitCode,
      });
      return Promise.resolve(result);
    },

    resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const state = stateFor(sandboxId);
      let path = absolutePath;
      for (let hop = 0; hop < MAX_SYMLINK_HOPS_V1; hop++) {
        const substituted = substituteSymlinkPrefix(state, path);
        if (substituted === undefined) {
          return Promise.resolve(exists(state, path) ? path : undefined);
        }
        path = substituted;
      }
      // A symlink cycle never resolves to a real target: fail closed.
      return Promise.resolve(undefined);
    },

    writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      client.addFile(sandboxId, absolutePath, contentUtf8);
      return Promise.resolve();
    },

    deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      stateFor(sandboxId).files.delete(absolutePath);
      return Promise.resolve();
    },

    readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      return Promise.resolve(stateFor(sandboxId).files.get(absolutePath));
    },

    listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      const state = stateFor(sandboxId);
      if (absolutePath !== "/" && !state.dirs.has(absolutePath) && !exists(state, absolutePath)) {
        return Promise.resolve(undefined);
      }
      if (state.files.has(absolutePath)) {
        // A file is not listable as a directory.
        return Promise.resolve(undefined);
      }
      const prefix = absolutePath === "/" ? "/" : `${absolutePath}/`;
      const entries = new Map<string, SandboxDirEntryV1>();
      for (const [file, content] of state.files) {
        if (!file.startsWith(prefix)) {
          continue;
        }
        const rest = file.slice(prefix.length);
        const cut = rest.indexOf("/");
        if (cut === -1) {
          entries.set(rest, { name: rest, kind: "file", sizeBytes: content.length });
        } else {
          const child = rest.slice(0, cut);
          entries.set(child, { name: child, kind: "directory" });
        }
      }
      for (const dir of state.dirs) {
        if (!dir.startsWith(prefix)) {
          continue;
        }
        const rest = dir.slice(prefix.length);
        const child = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
        if (child.length > 0 && !entries.has(child)) {
          entries.set(child, { name: child, kind: "directory" });
        }
      }
      return Promise.resolve(
        [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
      );
    },

    findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      if (lookup === "unavailable") {
        return Promise.resolve("unknown");
      }
      const ran = executedCommands.some(
        (record) => record.sandboxId === sandboxId && record.attemptKey === attemptKey
      );
      return Promise.resolve(ran ? "executed" : "notExecuted");
    },
  };

  return client;
}
