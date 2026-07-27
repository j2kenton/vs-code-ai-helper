import * as cp from "child_process";
import { killProcessTree, sanitizedCliEnv } from "./cliProcessUtils";

export interface DiscoveredCliModel {
  model: string;
  name: string;
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
  parse: (output: string) => DiscoveredCliModel[]
): Promise<DiscoveredCliModel[]> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let overflowed = false;

    const finish = (result: readonly DiscoveredCliModel[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve([...result]);
    };

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(command, args as string[], {
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
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish([]);
    }, timeoutMs);

    child.on("error", () => {
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
    child.stderr?.on("data", () => {
      // Draining only; content is not used by any discovery caller today.
    });

    child.on("close", (code) => {
      if (overflowed) {
        return;
      }
      const parsed = parse(stdout);
      if (parsed.length > 0) {
        finish(parsed);
        return;
      }
      if (code !== 0) {
        finish([]);
        return;
      }
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

export async function discoverOpencodeModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverOpencodeModelsWithTimeout(command, 30_000);
}

export async function discoverOpencodeModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
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
    const displayName =
      value &&
      typeof value === "object" &&
      typeof (value as { displayName?: unknown }).displayName === "string" &&
      (value as { displayName: string }).displayName.trim().length > 0
        ? (value as { displayName: string }).displayName.trim()
        : id;
    result.push({ model: id, name: displayName });
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
