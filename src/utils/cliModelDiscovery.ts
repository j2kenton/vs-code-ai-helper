import * as cp from "child_process";

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
    const columnSplit = bulletStripped.split(/\s{2,}|\t+/).filter(Boolean);
    const candidateSource = columnSplit[0] ?? bulletStripped;
    const token = candidateSource.trim().split(/\s+/)[0]?.trim();
    if (
      token &&
      /^(model|models|id|name)$/i.test(token) &&
      (columnSplit.length > 1 || /\s+/.test(bulletStripped))
    ) {
      continue;
    }
    if (!token || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(token)) {
      continue;
    }
    result.push({ model: token, name: token });
  }

  return uniqueByModel(result);
}

export function parseAgyModelsOutput(output: string): DiscoveredCliModel[] {
  return parseModelListOutput(output);
}

export function parseKiroModelsOutput(output: string): DiscoveredCliModel[] {
  return parseModelListOutput(output);
}

function runCliModelDiscovery(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  parse: (output: string) => DiscoveredCliModel[]
): Promise<DiscoveredCliModel[]> {
  return new Promise((resolve) => {
    cp.execFile(
      command,
      args as string[],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout) => {
        const parsed = parse(stdout);
        if (parsed.length > 0) {
          resolve(parsed);
          return;
        }
        if (error) {
          resolve([]);
          return;
        }
        resolve(parsed);
      }
    );
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
