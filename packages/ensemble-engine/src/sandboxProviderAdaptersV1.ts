/**
 * E2B and Daytona sandbox client adapters (plan Part 4d).
 *
 * Fetch-based reference transports implementing `SandboxClientV1` against
 * the providers' public HTTP surfaces, mirroring the Part 4b model-provider
 * adapters: the transport is injected (so the engine stays dependency-free
 * and tests pin the request contract), the user's sandbox API key travels
 * ONLY in request headers, and every error message scrubs the key and bounds
 * the response-body snippet. Endpoint paths follow the providers' published
 * HTTP APIs at the time of writing; a Part 5 host may substitute SDK-backed
 * clients implementing the same interface (the deployment default) without
 * touching anything upstream — the executor and gate machinery depend only
 * on `SandboxClientV1`.
 *
 * Outcome discipline (what 4c recovery relies on):
 * - `runCommand` THROWS when it cannot prove an exit code (non-2xx,
 *   unparseable body) — the open attempt record is exactly what recovery
 *   expects to find; nothing fabricates success.
 * - `resolveRealPath` returns `undefined` unless the provider reports a
 *   resolved real target — fail-closed, a symlink is never trusted as given.
 * - `findCommandByAttemptKey` returns `"executed"` only on a positive marker
 *   match and otherwise `"unknown"` (neither platform exposes complete
 *   command history through these endpoints, so absence proves nothing);
 *   effect-specific probes (e.g. the git-clone `.git` check) provide the
 *   stronger verdicts.
 */
import { FetchLikeV1, FetchResponseLikeV1 } from "./providerAdaptersV1";
import type { EngineEffectReconcileVerdictV1 } from "./gateMachineryV1";
import {
  buildMarkedSandboxCommandV1,
  CreateSandboxResultV1,
  SandboxClientV1,
  SandboxCommandRequestV1,
  SandboxCommandResultV1,
  SandboxDirEntryV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
} from "./sandboxClientV1";

const MAX_SNIPPET_CHARS_V1 = 400;
const MAX_TAIL_CHARS_V1 = 4000;

function scrub(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[redacted]") : text;
}

function snippet(body: string, apiKey: string): string {
  const flattened = scrub(body, apiKey).replace(/\s+/g, " ").trim();
  return flattened.length > MAX_SNIPPET_CHARS_V1
    ? `${flattened.slice(0, MAX_SNIPPET_CHARS_V1)}…`
    : flattened;
}

function tail(text: unknown): string {
  if (typeof text !== "string") {
    return "";
  }
  return text.length > MAX_TAIL_CHARS_V1 ? text.slice(-MAX_TAIL_CHARS_V1) : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireOk(
  label: string,
  response: FetchResponseLikeV1,
  apiKey: string
): Promise<string> {
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    const detail = snippet(body, apiKey);
    throw new Error(
      `${label} failed (HTTP ${response.status}).${detail.length > 0 ? ` ${detail}` : ""}`
    );
  }
  return body;
}

/** Decode a provider directory-listing payload into SandboxDirEntryV1 rows. */
function dirEntriesFrom(parsed: unknown): readonly SandboxDirEntryV1[] | undefined {
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : isRecord(parsed) && Array.isArray(parsed.files)
        ? parsed.files
        : undefined;
  if (list === undefined) {
    return undefined;
  }
  const entries: SandboxDirEntryV1[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) {
      return undefined;
    }
    const isDir = raw.isDir === true || raw.type === "directory" || raw.kind === "directory";
    const size = raw.size ?? raw.sizeBytes;
    entries.push({
      name: raw.name,
      kind: isDir ? "directory" : "file",
      ...(typeof size === "number" && Number.isInteger(size) && size >= 0
        ? { sizeBytes: size }
        : {}),
    });
  }
  return entries;
}

function exitCodeFrom(parsed: unknown): number | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const candidate = parsed.exitCode ?? parsed.exit_code ?? parsed.code;
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : undefined;
}

/** A string field that plausibly names a resolved real path. */
function resolvedPathFrom(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const candidate = parsed.resolvedPath ?? parsed.realPath ?? parsed.resolvedTarget;
  return typeof candidate === "string" && candidate.startsWith("/") ? candidate : undefined;
}

export interface CreateE2bSandboxClientOptionsV1 {
  readonly fetch: FetchLikeV1;
  /** The user's E2B API key (Part 5 custody; decrypted in engine-run memory). */
  readonly apiKey: string;
  /** Control API base; default `https://api.e2b.dev`. */
  readonly apiBaseUrl?: string;
  /** Per-sandbox envd base; default `https://49983-{sandboxId}.e2b.app`. */
  readonly envdBaseUrl?: (sandboxId: string) => string;
  /** Template for created sandboxes; default `base`. */
  readonly templateId?: string;
}

/** E2B: control plane at `api.e2b.dev`, execution/filesystem via envd. */
export function createE2bSandboxClientV1(
  options: CreateE2bSandboxClientOptionsV1
): SandboxClientV1 {
  const apiBase = (options.apiBaseUrl ?? "https://api.e2b.dev").replace(/\/$/, "");
  const envdBase =
    options.envdBaseUrl ?? ((sandboxId: string): string => `https://49983-${sandboxId}.e2b.app`);
  const headers = {
    "content-type": "application/json",
    "x-api-key": options.apiKey,
  } as const;
  const key = options.apiKey;

  async function envdPost(sandboxId: string, path: string, payload: unknown): Promise<string> {
    const response = await options.fetch(`${envdBase(sandboxId).replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return requireOk(`E2B sandbox call ${path}`, response, key);
  }

  return {
    provider: "e2b",

    async createSandbox(): Promise<CreateSandboxResultV1> {
      const response = await options.fetch(`${apiBase}/sandboxes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ templateID: options.templateId ?? "base" }),
      });
      const body = await requireOk("E2B sandbox creation", response, key);
      const parsed = parseJson(body);
      const sandboxId = isRecord(parsed) ? parsed.sandboxID ?? parsed.sandboxId : undefined;
      if (typeof sandboxId !== "string" || sandboxId.length === 0) {
        throw new Error("E2B sandbox creation returned no sandbox id.");
      }
      return { sandboxId };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      const response = await options.fetch(`${apiBase}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: "DELETE",
        headers,
        body: "",
      });
      await requireOk("E2B sandbox deletion", response, key);
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const body = await envdPost(request.sandboxId, "/process.Process/Start", {
        process: {
          cmd: "/bin/sh",
          args: ["-c", commandText],
          cwd: request.cwd,
          envs: { [SANDBOX_ATTEMPT_KEY_MARKER_V1]: request.attemptKey },
          tag: request.attemptKey,
        },
      });
      const parsed = parseJson(body);
      const exitCode = exitCodeFrom(parsed);
      if (exitCode === undefined) {
        // No provable exit code: throw, leaving the open attempt record for
        // 4c recovery — never fabricate an outcome.
        throw new Error("E2B command execution did not report an exit code.");
      }
      return {
        exitCode,
        stdoutTail: tail(isRecord(parsed) ? parsed.stdout : undefined),
        stderrTail: tail(isRecord(parsed) ? parsed.stderr : undefined),
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const response = await options.fetch(
        `${envdBase(sandboxId).replace(/\/$/, "")}/filesystem.Filesystem/Stat`,
        { method: "POST", headers, body: JSON.stringify({ path: absolutePath }) }
      );
      if (response.status === 404) {
        await response.text();
        return undefined;
      }
      const body = await requireOk("E2B filesystem stat", response, key);
      const parsed = parseJson(body);
      const entry = isRecord(parsed) && isRecord(parsed.entry) ? parsed.entry : parsed;
      return resolvedPathFrom(entry);
    },

    async writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      await envdPost(sandboxId, "/filesystem.Filesystem/Write", {
        path: absolutePath,
        content: contentUtf8,
      });
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      await envdPost(sandboxId, "/filesystem.Filesystem/Remove", { path: absolutePath });
    },

    async readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      // Fail-closed read: any transport or shape failure reads as "not
      // readable", never as fabricated content.
      try {
        const body = await envdPost(sandboxId, "/filesystem.Filesystem/Read", {
          path: absolutePath,
        });
        const parsed = parseJson(body);
        const content = isRecord(parsed) ? parsed.content ?? parsed.data : undefined;
        return typeof content === "string" ? content : undefined;
      } catch {
        return undefined;
      }
    },

    async listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      try {
        const body = await envdPost(sandboxId, "/filesystem.Filesystem/List", {
          path: absolutePath,
        });
        return dirEntriesFrom(parseJson(body));
      } catch {
        return undefined;
      }
    },

    async findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      let body: string;
      try {
        body = await envdPost(sandboxId, "/process.Process/List", {});
      } catch {
        return "unknown";
      }
      const parsed = parseJson(body);
      const processes = isRecord(parsed) && Array.isArray(parsed.processes) ? parsed.processes : [];
      for (const entry of processes) {
        if (!isRecord(entry)) {
          continue;
        }
        const envs = isRecord(entry.envs) ? entry.envs : undefined;
        if (
          entry.tag === attemptKey ||
          (envs !== undefined && envs[SANDBOX_ATTEMPT_KEY_MARKER_V1] === attemptKey)
        ) {
          return "executed";
        }
      }
      // Only running processes are listed; absence proves nothing.
      return "unknown";
    },
  };
}

export interface CreateDaytonaSandboxClientOptionsV1 {
  readonly fetch: FetchLikeV1;
  /** The user's Daytona API key (Part 5 custody; decrypted in engine-run memory). */
  readonly apiKey: string;
  /** API base; default `https://app.daytona.io/api`. */
  readonly apiBaseUrl?: string;
}

/** Daytona: sandbox lifecycle + toolbox process/filesystem endpoints. */
export function createDaytonaSandboxClientV1(
  options: CreateDaytonaSandboxClientOptionsV1
): SandboxClientV1 {
  const base = (options.apiBaseUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  } as const;
  const key = options.apiKey;

  function toolbox(sandboxId: string, path: string): string {
    return `${base}/toolbox/${encodeURIComponent(sandboxId)}/toolbox${path}`;
  }

  return {
    provider: "daytona",

    async createSandbox(): Promise<CreateSandboxResultV1> {
      const response = await options.fetch(`${base}/sandbox`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const body = await requireOk("Daytona sandbox creation", response, key);
      const parsed = parseJson(body);
      const sandboxId = isRecord(parsed) ? parsed.id ?? parsed.sandboxId : undefined;
      if (typeof sandboxId !== "string" || sandboxId.length === 0) {
        throw new Error("Daytona sandbox creation returned no sandbox id.");
      }
      return { sandboxId };
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      const response = await options.fetch(`${base}/sandbox/${encodeURIComponent(sandboxId)}`, {
        method: "DELETE",
        headers,
        body: "",
      });
      await requireOk("Daytona sandbox deletion", response, key);
    },

    async runCommand(request: SandboxCommandRequestV1): Promise<SandboxCommandResultV1> {
      const commandText = buildMarkedSandboxCommandV1(request.argv, request.attemptKey);
      const response = await options.fetch(toolbox(request.sandboxId, "/process/execute"), {
        method: "POST",
        headers,
        body: JSON.stringify({ command: commandText, cwd: request.cwd }),
      });
      const body = await requireOk("Daytona command execution", response, key);
      const parsed = parseJson(body);
      const exitCode = exitCodeFrom(parsed);
      if (exitCode === undefined) {
        throw new Error("Daytona command execution did not report an exit code.");
      }
      return {
        exitCode,
        stdoutTail: tail(isRecord(parsed) ? parsed.result ?? parsed.stdout : undefined),
        stderrTail: tail(isRecord(parsed) ? parsed.stderr : undefined),
      };
    },

    async resolveRealPath(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      const response = await options.fetch(
        `${toolbox(sandboxId, "/files/info")}?path=${encodeURIComponent(absolutePath)}`,
        { method: "GET", headers, body: "" }
      );
      if (response.status === 404) {
        await response.text();
        return undefined;
      }
      const body = await requireOk("Daytona file info", response, key);
      return resolvedPathFrom(parseJson(body));
    },

    async writeFile(sandboxId: string, absolutePath: string, contentUtf8: string): Promise<void> {
      const response = await options.fetch(
        `${toolbox(sandboxId, "/files/upload")}?path=${encodeURIComponent(absolutePath)}`,
        { method: "POST", headers, body: contentUtf8 }
      );
      await requireOk("Daytona file write", response, key);
    },

    async deleteFile(sandboxId: string, absolutePath: string): Promise<void> {
      const response = await options.fetch(
        `${toolbox(sandboxId, "/files")}?path=${encodeURIComponent(absolutePath)}`,
        { method: "DELETE", headers, body: "" }
      );
      await requireOk("Daytona file delete", response, key);
    },

    async readFileUtf8(sandboxId: string, absolutePath: string): Promise<string | undefined> {
      // Fail-closed read: any transport failure reads as "not readable".
      try {
        const response = await options.fetch(
          `${toolbox(sandboxId, "/files/download")}?path=${encodeURIComponent(absolutePath)}`,
          { method: "GET", headers, body: "" }
        );
        if (response.status < 200 || response.status >= 300) {
          await response.text();
          return undefined;
        }
        return await response.text();
      } catch {
        return undefined;
      }
    },

    async listDirectory(
      sandboxId: string,
      absolutePath: string
    ): Promise<readonly SandboxDirEntryV1[] | undefined> {
      try {
        const response = await options.fetch(
          `${toolbox(sandboxId, "/files")}?path=${encodeURIComponent(absolutePath)}`,
          { method: "GET", headers, body: "" }
        );
        if (response.status < 200 || response.status >= 300) {
          await response.text();
          return undefined;
        }
        return dirEntriesFrom(parseJson(await response.text()));
      } catch {
        return undefined;
      }
    },

    async findCommandByAttemptKey(
      sandboxId: string,
      attemptKey: string
    ): Promise<EngineEffectReconcileVerdictV1> {
      let body: string;
      try {
        const response = await options.fetch(toolbox(sandboxId, "/process/session"), {
          method: "GET",
          headers,
          body: "",
        });
        body = await requireOk("Daytona session listing", response, key);
      } catch {
        return "unknown";
      }
      const parsed = parseJson(body);
      const sessions = Array.isArray(parsed) ? parsed : [];
      for (const session of sessions) {
        if (!isRecord(session) || !Array.isArray(session.commands)) {
          continue;
        }
        for (const command of session.commands) {
          if (isRecord(command) && typeof command.command === "string" && command.command.includes(attemptKey)) {
            return "executed";
          }
        }
      }
      // The execute endpoint's commands are not session-recorded; absence
      // proves nothing.
      return "unknown";
    },
  };
}
