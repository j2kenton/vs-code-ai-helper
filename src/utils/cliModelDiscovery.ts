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
    typeof record.name === "string" && record.name.trim().length > 0
      ? record.name.trim()
      : modelValue.trim();
  return [{ model: modelValue.trim(), name: labelValue }];
}

export function parseAgyModelsOutput(output: string): DiscoveredCliModel[] {
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
      /^[\-=]{3,}$/.test(line)
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

export async function discoverAgyModels(command: string): Promise<
  DiscoveredCliModel[]
> {
  return discoverAgyModelsWithTimeout(command, 10_000);
}

export async function discoverAgyModelsWithTimeout(
  command: string,
  timeoutMs: number
): Promise<DiscoveredCliModel[]> {
  return new Promise((resolve) => {
    cp.execFile(
      command,
      ["models"],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(parseAgyModelsOutput(stdout));
      }
    );
  });
}
