import * as cp from "child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
  DEVPASS_DEFAULT_MAJOR_V1,
  DEVPASS_SUPPORTED_MAJORS_V1,
  decideCliMajorV1,
  devpassUnsupportedMajorMessageV1,
  getCliMajorVersionV1,
} from "./cliMajorVersionV1";
import { killProcessTree, sanitizedCliEnv } from "./cliProcessUtils";

export interface DiscoveredCliModel {
  model: string;
  name: string;
  /** OpenCode 2 pricing label; absent when the catalog has no usable cost. */
  priceTierV1?: "Free" | "Paid";
}

function uniqueByModel(
  models: readonly DiscoveredCliModel[]
): DiscoveredCliModel[] {
  const seen = new Set<string>();
  const result: DiscoveredCliModel[] = [];
  for (const model of models) {
    if (seen.has(model.model)) {
      continue;
    }
    seen.add(model.model);
    result.push(model);
  }
  return result;
}

function parseJsonModels(value: unknown): DiscoveredCliModel[] {
  if (Array.isArray(value)) {
    return uniqueByModel(
      value.flatMap((entry) => parseJsonModels(entry))
    );
  }
  if (typeof value === "string") {
    const model = value.trim();
    return model ? [{ model, name: model }] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  for (const key of ["models", "data", "items"]) {
    const nestedModels = parseJsonModels(record[key]);
    if (nestedModels.length > 0) {
      return uniqueByModel(nestedModels);
    }
  }

  const modelValue =
    typeof record.id === "string"
      ? record.id
      : typeof record.model === "string"
        ? record.model
        : typeof record.name === "string"
          ? record.name
          : undefined;
  if (!modelValue) {
    return [];
  }

  const labelValue =
    typeof record.displayName === "string" &&
    record.displayName.trim().length > 0
      ? record.displayName.trim()
      : typeof record.label === "string" && record.label.trim().length > 0
        ? record.label.trim()
        : typeof record.name === "string" && record.name.trim().length > 0
          ? record.name.trim()
          : modelValue.trim();
  return [{ model: modelValue.trim(), name: labelValue }];
}

function parseModelListOutput(output: string): DiscoveredCliModel[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const fromJson = parseJsonModels(parsed).filter(
      (entry) => entry.model.length > 0
    );
    if (fromJson.length > 0) {
      return uniqueByModel(fromJson);
    }
  } catch {
    // Fall back to line-based parsing.
  }

  const result: DiscoveredCliModel[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line.length === 0 ||
      /^available models:?$/i.test(line) ||
      /^models:?$/i.test(line) ||
      /^model(\s+name)?$/i.test(line) ||
      /^[-=]{3,}$/.test(line)
    ) {
      continue;
    }

    const bulletStripped = line.replace(/^[*•-]\s*/, "");
    // A genuine tabular layout (id column, description trailing) separates
    // columns with 2+ spaces or a tab; a run of single spaces just means the
    // entry itself is a multi-word name — e.g. Antigravity's `agy models`
    // prints whole display names like "Gemini 3.5 Flash (Medium)" with no id
    // column at all. Only split into columns when that stronger separator is
    // actually present, otherwise keep the whole line — splitting on any
    // whitespace here would truncate such a name down to just "Gemini".
    const columnSplit = bulletStripped.split(/\s{2,}|\t+/).filter(Boolean);
    const candidate = (
      columnSplit.length > 1 ? columnSplit[0]! : bulletStripped
    ).trim();
    if (/^(model|models|id|name)$/i.test(candidate)) {
      continue;
    }
    if (!candidate || !/^[A-Za-z0-9][A-Za-z0-9 ._:()/-]*$/.test(candidate)) {
      continue;
    }
    result.push({ model: candidate, name: candidate });
  }

  return uniqueByModel(result);
}

export function parseAgyModelsOutput(output: string): DiscoveredCliModel[] {
  return parseModelListOutput(output);
}

export function parseKiroModelsOutput(output: string): DiscoveredCliModel[] {
  return parseModelListOutput(output);
}

const DISCOVERY_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DISCOVERY_STDERR_HEAD_CHARS = 2000;
const DISCOVERY_STDERR_LOG_LINES = 5;

/** Why a model-discovery call left the picker without a live list. */
export type CliDiscoveryFailureReasonV1 =
  | "spawn"
  | "timeout"
  | "exit"
  | "overflow"
  | "outputFile"
  /** The installed CLI's major is one Ensemble does not support; `stderrHead` carries the remedy. */
  | "unsupportedVersion"
  /** Exit 0, but nothing parseable — a truncated response or a changed format. */
  | "noModels"
  /**
   * Exit 0 and a well-formed listing that holds no models (blank output, or an
   * empty JSON list): the CLI answered, there is just nothing in the catalog — a
   * signed-out or empty account — which is not a malformed or failed response.
   */
  | "emptyCatalog";

/**
 * Whether an exit-0 listing that yielded no models was an empty answer rather
 * than output Ensemble could not read: blank output, or JSON that is an empty
 * list (or an object whose `data`, `models` or `items` list is empty).
 */
export function isEmptyCliCatalogOutputV1(stdout: string): boolean {
  const text = stdout.trim();
  if (text.length === 0) {
    return true;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    if (typeof value === "object" && value !== null) {
      for (const key of ["data", "models", "items"]) {
        const list = (value as Record<string, unknown>)[key];
        if (Array.isArray(list)) {
          return list.length === 0;
        }
      }
    }
  } catch {
    // Not JSON: a text listing that parsed to nothing is unreadable, not empty.
  }
  return false;
}

/** One failed discovery, shaped for the diagnostic log (no stdout, redacted stderr). */
export interface CliDiscoveryFailureV1 {
  readonly provider: string;
  readonly command: string;
  readonly reason: CliDiscoveryFailureReasonV1;
  readonly exitCode?: number;
  readonly stderrHead: string;
}

let discoveryFailureSink: ((failure: CliDiscoveryFailureV1) => void) | undefined;

/** Installs the diagnostic sink (the extension's output channel); pass undefined to remove it. */
export function setCliDiscoveryFailureSinkV1(sink: ((failure: CliDiscoveryFailureV1) => void) | undefined): void {
  discoveryFailureSink = sink;
}

/** The newest failure per provider name, so the picker can say why it shows the built-in list. */
const latestDiscoveryFailureByProvider = new Map<string, { readonly at: number; readonly failure: CliDiscoveryFailureV1 }>();

/**
 * The failure a provider's discovery reported at or after `sinceMs`, if any.
 * `command` is the CLI executable (a path or a bare name); failures are keyed
 * by its file name without extension, as `runCliModelDiscovery` reports them.
 */
export function latestCliDiscoveryFailureV1(command: string, sinceMs: number): CliDiscoveryFailureV1 | undefined {
  const entry = latestDiscoveryFailureByProvider.get(nodePath.basename(command).replace(/\.(cmd|exe|bat)$/i, ""));
  return entry !== undefined && entry.at >= sinceMs ? entry.failure : undefined;
}

/** Forget remembered failures; for tests. */
export function clearCliDiscoveryFailuresV1(): void {
  latestDiscoveryFailureByProvider.clear();
}

/** The reason a discovery left the built-in list in place, in a few plain words. */
export function describeCliDiscoveryFailureReasonV1(failure: CliDiscoveryFailureV1): string {
  switch (failure.reason) {
    case "timeout":
      return "the model listing timed out";
    case "exit":
      return `the model listing exited with code ${failure.exitCode ?? "unknown"}`;
    case "spawn":
      return "the CLI could not be started";
    case "overflow":
      return "the model listing produced more output than the discovery limit";
    case "outputFile":
      return "the model listing could not use its temporary output file";
    case "unsupportedVersion":
      return failure.stderrHead.length > 0 ? failure.stderrHead : "this CLI version is not supported";
    case "emptyCatalog":
      return "the CLI answered with an empty model list (is it signed in?)";
    default:
      return "the model listing returned nothing Ensemble could read";
  }
}

function reportCliDiscoveryFailureV1(failure: CliDiscoveryFailureV1): void {
  latestDiscoveryFailureByProvider.set(failure.provider, { at: Date.now(), failure });
  try {
    discoveryFailureSink?.(failure);
  } catch {
    // A logging fault must never turn into a discovery fault.
  }
}

/** The first few stderr lines, with secret-looking values masked. */
export function boundDiscoveryStderrV1(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, DISCOVERY_STDERR_LOG_LINES)
    .map((line) =>
      line
        .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
        .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+/gi, "$1***")
        .replace(/\b(?:sk|llmg|ghp|gho)[-_][A-Za-z0-9_-]{10,}/g, "***")
        .slice(0, 300)
    )
    .join("\n");
}

/** One line for the log: provider, command, exit code or timeout, and the stderr head. */
export function formatCliDiscoveryFailureV1(failure: CliDiscoveryFailureV1): string {
  const how =
    failure.reason === "timeout"
      ? "timed out"
      : failure.reason === "exit"
        ? `exited with code ${failure.exitCode ?? "unknown"}`
        : failure.reason === "spawn"
          ? "could not be started"
          : failure.reason === "overflow"
            ? "produced more output than the discovery limit"
            : failure.reason === "outputFile"
              ? "could not use its temporary output file"
              : failure.reason === "unsupportedVersion"
                ? "was not run because this CLI version is not supported"
                : failure.reason === "emptyCatalog"
                  ? "answered successfully with an empty model list"
                  : "exited 0 but returned no models Ensemble could read";
  const stderr = failure.stderrHead.length > 0 ? `\n  stderr: ${failure.stderrHead.replace(/\n/g, "\n          ")}` : "";
  return `Model discovery for ${failure.provider} failed — \`${failure.command}\` ${how}; showing the built-in list.${stderr}`;
}

/**
 * Runs a model-discovery CLI call and resolves with whatever the parser can
 * extract, defaulting to an empty list on any failure (timeout, non-zero
 * exit, unparseable output) — discovery failing must never surface as an
 * error to the caller, only as "no models found" (the seeded fallback list
 * still applies).
 *
 * Uses cp.spawn with a manual timeout + killProcessTree instead of
 * cp.execFile's built-in `timeout` option: on Windows with shell:true (see
 * below), execFile's timeout only terminates the interposed cmd.exe — the
 * actual CLI process (and anything it forks) is a grandchild and is left
 * running orphaned. Verified directly: spawning `cmd.exe /c ping ...` and
 * letting execFile's timeout fire left the grandchild ping.exe process
 * alive afterward. killProcessTree's `taskkill /T` walks the whole PID tree
 * instead, matching how execCliAgent (cliAgentRunner.ts) already handles
 * its own run timeouts.
 */
function runCliModelDiscovery(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  parse: (output: string) => DiscoveredCliModel[],
  options: { readonly stdoutToFile?: boolean } = {}
): Promise<DiscoveredCliModel[]> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let overflowed = false;
    let stderrHead = "";

    const reportFailure = (reason: CliDiscoveryFailureReasonV1, exitCode?: number | null): void => {
      reportCliDiscoveryFailureV1({
        provider: nodePath.basename(command).replace(/\.(cmd|exe|bat)$/i, ""),
        command: [command, ...args].join(" "),
        reason,
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        stderrHead: boundDiscoveryStderrV1(stderrHead),
      });
    };

    // bugs3 Step 14: devpass-code 2.x's `api model.list` loses output past
    // 262,144 bytes when stdout is a pipe (exit 0, truncated JSON; observed
    // 2026-10-28 — the complete response is ~359 KB). Giving the child a
    // regular file as stdout delivers all of it, so the answer is read back
    // from that file once the process has exited.
    let outputFile: string | undefined;
    let outputFd: number | undefined;
    const closeOutputFile = (): void => {
      if (outputFd !== undefined) {
        try {
          nodeFs.closeSync(outputFd);
        } catch {
          // Already closed.
        }
        outputFd = undefined;
      }
    };
    const removeOutputFile = (): void => {
      closeOutputFile();
      if (outputFile !== undefined) {
        try {
          nodeFs.unlinkSync(outputFile);
        } catch {
          // Best-effort cleanup.
        }
        outputFile = undefined;
      }
    };

    const finish = (result: readonly DiscoveredCliModel[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeOutputFile();
      resolve([...result]);
    };

    if (options.stdoutToFile === true) {
      try {
        outputFile = nodePath.join(
          nodeOs.tmpdir(),
          `ensemble-discovery-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`
        );
        outputFd = nodeFs.openSync(outputFile, "w+", 0o600);
      } catch {
        removeOutputFile();
        reportFailure("outputFile");
        resolve([]);
        return;
      }
    }

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(command, args as string[], {
        ...(outputFd !== undefined ? { stdio: ["ignore", outputFd, "pipe"] as cp.StdioOptions } : {}),
        windowsHide: true,
        env: sanitizedCliEnv(),
        // Windows-only: without a shell, spawn calls CreateProcess directly,
        // which cannot launch a .cmd shim (only a real .exe/.bat launched
        // via cmd.exe can) — verified live that this silently fails with
        // "spawn opencode ENOENT" for opencode's npm-installed opencode.cmd
        // shim, which this function previously swallowed into an empty (not
        // erroring) model list. agy and kiro-cli happened to never hit this
        // because both install as native .exe binaries; any future
        // npm-shim-installed CLI added here would hit the same silent
        // failure without this flag. No effect on POSIX, where a shell is
        // never required to exec a script with a shebang.
        shell: process.platform === "win32",
        // POSIX only, mirroring execCliAgent: makes the shell (and anything
        // it execs/forks) its own process group so killProcessTree's
        // negated-PID signal reaches the whole group, not just the shell.
        detached: process.platform !== "win32",
      });
    } catch {
      removeOutputFile();
      reportFailure("spawn");
      resolve([]);
      return;
    }

    // The child holds its own copy of the descriptor now.
    closeOutputFile();

    const timer = setTimeout(() => {
      if (!settled) {
        reportFailure("timeout");
      }
      killProcessTree(child);
      finish([]);
    }, timeoutMs);

    child.on("error", () => {
      if (!settled) {
        reportFailure("spawn");
      }
      finish([]);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflowed) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > DISCOVERY_MAX_BUFFER_BYTES) {
        // Mirror execFile's maxBuffer behavior: stop accumulating and treat
        // as a failure (empty result) rather than parsing a truncated
        // mid-object buffer, which could silently return a partial catalog.
        overflowed = true;
        reportFailure("overflow");
        killProcessTree(child);
        finish([]);
        return;
      }
      stdout += chunk.toString("utf8");
    });

    // Must be drained even though its content is unused here: an unpiped
    // stderr data listener leaves the OS pipe unread, and once the CLI
    // writes more than the pipe's buffer (~64KB on both Windows and POSIX)
    // its write() call blocks forever waiting for a reader that never comes
    // — reproduced directly (a child writing 200KB to stderr with only
    // stdout drained never closed). That hang would silently eat the whole
    // discovery timeout instead of returning quickly. No overflow guard is
    // needed on this side since bytes are discarded immediately rather than
    // accumulated.
    child.stderr?.on("data", (chunk: Buffer) => {
      // Drained; only the first bytes are kept, for the failure diagnostic.
      if (stderrHead.length < DISCOVERY_STDERR_HEAD_CHARS) {
        stderrHead += chunk.toString("utf8").slice(0, DISCOVERY_STDERR_HEAD_CHARS - stderrHead.length);
      }
    });

    child.on("close", (code) => {
      if (overflowed || settled) {
        return;
      }
      if (outputFile !== undefined) {
        try {
          if (nodeFs.statSync(outputFile).size > DISCOVERY_MAX_BUFFER_BYTES) {
            reportFailure("overflow", code);
            finish([]);
            return;
          }
          stdout = nodeFs.readFileSync(outputFile, "utf8");
        } catch {
          reportFailure("outputFile", code);
          finish([]);
          return;
        }
      }
      // A CLI that exited non-zero may have printed only part of its catalog before
      // failing, so its output is not accepted as a live list even when it parses:
      // the failure is logged and the picker keeps the earlier or built-in list.
      if (code !== null && code !== 0) {
        reportFailure("exit", code);
        finish([]);
        return;
      }
      const parsed = parse(stdout);
      if (parsed.length > 0) {
        finish(parsed);
        return;
      }
      // Exit 0 with nothing parseable is the truncated/changed-format case; a
      // non-zero exit is the CLI refusing the command. Both leave the picker on
      // its built-in list, so both are logged.
      reportFailure(code !== 0 ? "exit" : isEmptyCliCatalogOutputV1(stdout) ? "emptyCatalog" : "noModels", code);
      finish(parsed);
    });
  });
}

export async function discoverAgyModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverAgyModelsWithTimeout(command, 30_000);
}

export async function discoverAgyModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  return runCliModelDiscovery(command, ["models"], timeoutMs, parseAgyModelsOutput);
}

export async function discoverKiroModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverKiroModelsWithTimeout(command, 30_000);
}

export async function discoverKiroModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  return runCliModelDiscovery(
    command,
    ["chat", "--no-interactive", "--list-models", "--format", "json"],
    timeoutMs,
    parseKiroModelsOutput
  );
}

/**
 * `opencode models --verbose` output shape (verified live against opencode
 * 1.18.4): repeating `<providerID>/<id>\n<pretty-printed JSON object>\n`
 * blocks — not a JSON array or JSON-lines stream, so this walks the text
 * tracking brace depth to find each object's extent, then parses it. There
 * is no `--format json` for this subcommand.
 *
 * Scans the WHOLE text character-by-character (not per-line) and tracks
 * whether the scan is currently inside a JSON string literal (honoring `\"`
 * escapes), ignoring any `{`/`}` seen there — a model whose name/description
 * field contains a literal brace character is real input a free-text model
 * name can contain, and counting braces naively either truncates that
 * block's JSON.parse input mid-string (throws, model silently dropped) or,
 * worse, merges it with the next block and drops both. Reproduced directly
 * against the real pretty-printed multi-line shape opencode emits: a name
 * of `"Weird } Stray Brace"` caused the model to vanish entirely with no
 * error, while the following block still parsed. This scan also fixes a
 * related bug in a per-line-only depth check: a block whose braces happen
 * to net-zero only at the very end of a line (not really the object's true
 * end) could still slip past a check that only ran once per line — scanning
 * per character removes that gap too.
 *
 * The seeded catalog in modelSelection.ts is generated as compact
 * single-line JSON per block (to keep the compiled extension's bundle size
 * down) while the live CLI always pretty-prints (opening brace alone on its
 * own line) — both shapes parse identically here since detection no longer
 * depends on a brace's position within a line at all.
 */
interface OpencodeVerboseModel {
  id: string;
  providerID: string;
  name?: string;
  variants?: Record<string, unknown>;
}

function parseOpencodeVerboseModels(output: string): OpencodeVerboseModel[] {
  const results: OpencodeVerboseModel[] = [];
  let depth = 0;
  let inJson = false;
  let inString = false;
  let escapeNext = false;
  let bufferStart = -1;

  for (let i = 0; i < output.length; i++) {
    const ch = output[i]!;

    if (!inJson) {
      if (ch === "{") {
        inJson = true;
        depth = 0;
        inString = false;
        escapeNext = false;
        bufferStart = i;
        // Fall through to process this same character below.
      } else {
        continue;
      }
    }

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth <= 0) {
        inJson = false;
        tryPushOpencodeVerboseModel(
          results,
          output.slice(bufferStart, i + 1)
        );
      }
    }
  }
  return results;
}

function tryPushOpencodeVerboseModel(
  results: OpencodeVerboseModel[],
  block: string
): void {
  try {
    const parsed = JSON.parse(block) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      typeof (parsed as { providerID?: unknown }).providerID === "string"
    ) {
      results.push(parsed as OpencodeVerboseModel);
    }
  } catch {
    // Malformed/unrecognized block — skip it and keep parsing the rest.
  }
}

/**
 * Expands each model into a base entry plus one entry per reasoning-effort
 * variant it declares (e.g. "opencode/deepseek-v4-flash" has "high" and
 * "max" variants; "opencode/north-mini-code-free" has "none" and "high" —
 * the available set differs per model, verified live, so this cannot be a
 * single hardcoded ladder the way Codex's reasoning efforts are). Variant
 * entries use the "<provider>/<model>@<variant>" qualified form that
 * parseOpencodeModelSelection (providers.ts) parses back apart, mirroring
 * how Codex/Claude encode reasoning effort in the stored model ID.
 */
export function parseOpencodeModelsOutput(output: string): DiscoveredCliModel[] {
  const verboseModels = parseOpencodeVerboseModels(output);
  if (verboseModels.length === 0) {
    // --verbose output didn't parse (unexpected shape from a future
    // opencode version) — fall back to the plain "provider/model" line
    // parser so discovery still surfaces bare model IDs instead of nothing.
    return parseModelListOutput(output);
  }

  const result: DiscoveredCliModel[] = [];
  for (const model of verboseModels) {
    const fullId = `${model.providerID}/${model.id}`;
    const displayName = model.name?.trim() || fullId;
    result.push({ model: fullId, name: displayName });

    // parseOpencodeVerboseModels only validates id/providerID before
    // accepting a block — a future opencode version could ship a
    // "variants" value that isn't a plain object (an array, a string, a
    // number). Object.keys() on those still returns something (numeric
    // index keys for an array/string) without throwing, which would
    // silently produce bogus "@0"/"@1"-suffixed entries instead of no
    // variants at all, so this guards the shape explicitly.
    const variantsValue: unknown = model.variants;
    const variantKeys =
      variantsValue &&
      typeof variantsValue === "object" &&
      !Array.isArray(variantsValue)
        ? Object.keys(variantsValue)
        : [];
    for (const variant of variantKeys) {
      result.push({
        model: `${fullId}@${variant}`,
        name: `${displayName} (${variant})`,
      });
    }
  }
  return uniqueByModel(result);
}

/**
 * OpenCode 2's model catalog, from `opencode api --standalone model.list`
 * (verified live against opencode 2.0.32, 2026-10-20): one JSON object whose
 * `data` array holds every model, each with `id`, `providerID`, `name` and a
 * `variants` ARRAY of `{ id, settings }` (OpenCode 1's `models --verbose`
 * used a variants OBJECT keyed by name; v2 dropped `--verbose` entirely).
 * Emits the same "<provider>/<model>" and "<provider>/<model>@<variant>"
 * entries parseOpencodeModelsOutput does, so storage and
 * parseOpencodeModelSelection are unchanged. Anything that is not that shape
 * yields no models.
 */
export function parseOpencodeApiModelListOutput(
  output: string,
  options: { readonly providerID?: string; readonly priceTier?: boolean } = {}
): DiscoveredCliModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const result: DiscoveredCliModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const model = entry as { id?: unknown; providerID?: unknown; name?: unknown; variants?: unknown; cost?: unknown };
    if (typeof model.id !== "string" || !model.id || typeof model.providerID !== "string" || !model.providerID) {
      continue;
    }
    if (options.providerID !== undefined && model.providerID !== options.providerID) {
      continue;
    }
    const fullId = `${model.providerID}/${model.id}`;
    const displayName = (typeof model.name === "string" && model.name.trim()) || fullId;
    const priceTierV1 = options.priceTier === false ? undefined : parseOpenCodePriceTierV1(model.cost);
    result.push({ model: fullId, name: displayName, ...(priceTierV1 ? { priceTierV1 } : {}) });
    if (!Array.isArray(model.variants)) {
      continue;
    }
    for (const variant of model.variants) {
      const variantId = (variant as { id?: unknown } | null)?.id;
      if (typeof variantId !== "string" || !variantId) {
        continue;
      }
      result.push({
        model: `${fullId}@${variantId}`,
        name: `${displayName} (${variantId})`,
        ...(priceTierV1 ? { priceTierV1 } : {}),
      });
    }
  }
  return uniqueByModel(result);
}

function parseOpenCodePriceTierV1(cost: unknown): "Free" | "Paid" | undefined {
  if (!Array.isArray(cost) || cost.length === 0) {
    return undefined;
  }
  const rawPrices = cost as unknown[];
  if (rawPrices.some((price) => !price || typeof price !== "object" ||
      typeof (price as { input?: unknown }).input !== "number" || !Number.isFinite((price as { input: number }).input) ||
      typeof (price as { output?: unknown }).output !== "number" || !Number.isFinite((price as { output: number }).output))) {
    return undefined;
  }
  const prices = rawPrices as Array<{ input: number; output: number }>;
  if (prices.every((price) => price.input === 0 && price.output === 0)) {
    return "Free";
  }
  if (prices.some((price) => price.input > 0 || price.output > 0)) {
    return "Paid";
  }
  return undefined;
}

export async function discoverOpencodeModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverOpencodeModelsWithTimeout(command, 30_000);
}

export async function discoverOpencodeModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  // `--standalone` runs a private server for this one request and exits with
  // it, instead of starting (and leaving running) OpenCode 2's shared
  // background service.
  return runCliModelDiscovery(
    command,
    ["api", "--standalone", "model.list"],
    timeoutMs,
    parseOpencodeApiModelListOutput
  );
}

const CODEX_EFFORT_LABELS_V1: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

function codexEffortLabelV1(effort: string): string {
  return CODEX_EFFORT_LABELS_V1[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Codex's own model list, from `codex debug models` (verified against codex
 * 0.159.0): `{ "models": [ { "slug", "display_name", "visibility",
 * "supported_reasoning_levels": [ { "effort", ... } ],
 * "additional_speed_tiers": ["fast", ...], ... } ] }`. Only `visibility:
 * "list"` entries are offered (hidden/internal models are not). Emits the same
 * "<slug>@<effort>" and "<slug>@<effort>+fast" entries the seeded Codex
 * catalog uses, so storage and `parseCodexModelSelection` are unchanged.
 * A top-level array is accepted too. Anything else yields no models, which
 * leaves the seeded fixed list in place.
 */
export function parseCodexDebugModelsOutput(output: string): DiscoveredCliModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) {
    return [];
  }
  const result: DiscoveredCliModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const model = entry as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
      supported_reasoning_levels?: unknown;
      additional_speed_tiers?: unknown;
    };
    if (model.visibility !== "list" || typeof model.slug !== "string" || !model.slug) {
      continue;
    }
    const label = (typeof model.display_name === "string" && model.display_name.trim()) || model.slug;
    const supportsFast =
      Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes("fast");
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    for (const level of levels) {
      const effort = (level as { effort?: unknown } | null)?.effort;
      if (typeof effort !== "string" || !effort) {
        continue;
      }
      const effortLabel = codexEffortLabelV1(effort);
      result.push({ model: `${model.slug}@${effort}`, name: `${label} (${effortLabel})` });
      if (supportsFast) {
        result.push({ model: `${model.slug}@${effort}+fast`, name: `${label} (${effortLabel}, Fast)` });
      }
    }
  }
  return uniqueByModel(result);
}

export async function discoverCodexModels(command: string): Promise<DiscoveredCliModel[]> {
  return discoverCodexModelsWithTimeout(command, 30_000);
}

export async function discoverCodexModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  return runCliModelDiscovery(command, ["debug", "models"], timeoutMs, parseCodexDebugModelsOutput);
}

/**
 * devpass-code is a rebrand/fork of OpenCode (verified live, v1.17.13): its
 * `models --verbose` output is byte-for-byte the same repeating
 * "<provider>/<id>\n{json}" shape opencode emits, so this reuses
 * parseOpencodeModelsOutput rather than a dedicated parser.
 */
export async function discoverDevpassModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverDevpassModelsWithTimeout(command, 30_000);
}

/** The provider alias devpass-code's own catalog and account key use. */
export const DEVPASS_PROVIDER_ID_V1 = "llmgateway-devpass";

export async function discoverDevpassModelsWithTimeout(
  command: string,
  timeoutMs: number,
  probeMajor: (command: string) => Promise<number | undefined> = getCliMajorVersionV1
): Promise<DiscoveredCliModel[]> {
  // The same decision the run path makes (resolveVersionedContractV1): an
  // unreadable version assumes the default major, an unsupported one is
  // refused with the supported-version remedy instead of guessing a contract.
  const decision = decideCliMajorV1(
    await probeMajor(command),
    DEVPASS_SUPPORTED_MAJORS_V1,
    DEVPASS_DEFAULT_MAJOR_V1
  );
  if ("unsupportedMajor" in decision) {
    reportCliDiscoveryFailureV1({
      provider: "devpass-code",
      command: `${command} --version`,
      reason: "unsupportedVersion",
      stderrHead: devpassUnsupportedMajorMessageV1(decision.unsupportedMajor),
    });
    return [];
  }
  if (decision.major >= 2) {
    // 2.x dropped `models --verbose`; its catalog is `api --standalone
    // model.list` (verified against 2.0.29, 2026-10-28), a `{ location, data }`
    // envelope whose models carry array-valued `variants`. It lists the same
    // models under two provider aliases, so only `llmgateway-devpass` — the
    // one the 1.x catalog and the account key use — is offered. stdout goes to
    // a file because a pipe capture truncates the ~359 KB response.
    return runCliModelDiscovery(
      command,
      ["api", "--standalone", "model.list"],
      timeoutMs,
      (output) => parseOpencodeApiModelListOutput(output, { providerID: DEVPASS_PROVIDER_ID_V1, priceTier: false }),
      { stdoutToFile: true }
    );
  }
  return runCliModelDiscovery(
    command,
    ["models", "--verbose"],
    timeoutMs,
    parseOpencodeModelsOutput
  );
}

/**
 * `kimi provider list --json`'s shape (verified live against kimi-code
 * 0.29.2): a single JSON object with a "models" map keyed by the full
 * "<provider>/<alias>" id, each value carrying a "displayName" field (e.g.
 * `{"models":{"kimi-code/k3":{"displayName":"K3",...}}}`) — not an array
 * and not opencode's repeating-text-block shape, so this is a dedicated
 * parser rather than a reuse of parseModelListOutput/parseOpencodeVerboseModels.
 */
/**
 * The recognized Kimi reasoning-effort ladder, and the SINGLE source of it.
 *
 * Discovery (below) and `parseKimiModelSelection` (providers.ts, which
 * imports this) must agree exactly, because they are two halves of one round
 * trip: discovery attaches an `@<effort>` suffix to a model id, and the
 * parser splits that suffix back off before `-m` ever sees it. If discovery
 * publishes an effort the parser does not recognize, the parser treats the
 * whole `kimi-code/k3@medium` string as the model name and passes it to `-m`
 * verbatim — which Kimi rejects outright ("Model ... is not configured in
 * config.toml"), turning a picker entry into an unrunnable model. Keeping
 * one constant (rather than two "kept in sync" copies) makes that class of
 * drift impossible.
 *
 * Values verified live against kimi-code 0.29.2 (`kimi provider list
 * --json`): only K3/K3-256k carry `supportEfforts`, each exactly
 * ["low","high","max"]; K2.7 Coding / K2.7 Coding Highspeed are
 * `always_thinking` with no ladder at all, so they get no variant entries.
 * A future CLI version adding an effort must be added HERE — until it is,
 * discovery deliberately drops it rather than publishing a model that
 * cannot run.
 */
export const KIMI_REASONING_EFFORTS_V1: ReadonlySet<string> = new Set([
  "low",
  "high",
  "max",
]);
export function parseKimiModelsOutput(output: string): DiscoveredCliModel[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const models = (parsed as { models?: unknown }).models;
  if (!models || typeof models !== "object") {
    return [];
  }

  const result: DiscoveredCliModel[] = [];
  for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
    if (!id) {
      continue;
    }
    const record =
      value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const displayName =
      record &&
      typeof record.displayName === "string" &&
      record.displayName.trim().length > 0
        ? record.displayName.trim()
        : id;
    result.push({ model: id, name: displayName });

    // A future response shape could carry a non-array supportEfforts (or
    // non-string entries) without warning — guard both explicitly rather
    // than let a malformed value silently produce "@[object Object]"-style
    // variant ids or throw mid-loop. Unrecognized effort NAMES are dropped
    // for a sharper reason: see KIMI_REASONING_EFFORTS_V1 — publishing one
    // the parser cannot split back off yields a picker entry whose id is
    // passed to `-m` whole and rejected by the CLI.
    const supportEfforts = record?.supportEfforts;
    if (Array.isArray(supportEfforts)) {
      for (const effort of supportEfforts) {
        if (typeof effort !== "string") {
          continue;
        }
        const trimmedEffort = effort.trim();
        if (!KIMI_REASONING_EFFORTS_V1.has(trimmedEffort)) {
          continue;
        }
        result.push({
          model: `${id}@${trimmedEffort}`,
          name: `${displayName} (${trimmedEffort[0]!.toUpperCase()}${trimmedEffort.slice(1)})`,
        });
      }
    }
  }
  return uniqueByModel(result);
}

export async function discoverKimiModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverKimiModelsWithTimeout(command, 30_000);
}

export async function discoverKimiModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  return runCliModelDiscovery(
    command,
    ["provider", "list", "--json"],
    timeoutMs,
    parseKimiModelsOutput
  );
}
