/**
 * bugs3 Step 5: how much of a prompt file Kimi's Read tool returns in one go.
 *
 * The 66,000-byte ceiling in `KNOWN_PROVIDER_READ_CEILING_BYTES_V1` was measured
 * on kimi-code 0.29.2. kimi-code 2.x reads up to `[read] default_max_chars`
 * characters per call (100,000 by default, configurable up to 500,000), and
 * numbers every line it returns. This module turns the installed version and
 * the user's config into one capacity descriptor, and holds the pure TOML
 * helpers for the consented config change. Pure except for `loadKimiReadCapacityV1`,
 * whose I/O is injected.
 */

/** The measured legacy ceiling, in bytes (kimi-code 0.x / 1.x). */
export const KIMI_LEGACY_READ_CEILING_BYTES_V1 = 66000;
/** kimi-code 2.x's default `[read] default_max_chars`. */
export const KIMI_DEFAULT_MAX_CHARS_V1 = 100_000;
/** The largest `[read] default_max_chars` kimi-code 2.x accepts. */
export const KIMI_MAX_CHARS_LIMIT_V1 = 500_000;
/** The value Ensemble offers to set. */
export const KIMI_OFFERED_MAX_CHARS_V1 = 500_000;
/**
 * Characters the Read tool adds per returned line for its line-number prefix
 * (`%6d` plus a tab), with a little slack for wider numbers.
 */
export const KIMI_LINE_PREFIX_CHARS_V1 = 8;

export type KimiReadCapacitySourceV1 =
  /** kimi-code older than 2.x: the measured byte ceiling. */
  | "legacy"
  /** 2.x with no configured value: the 100,000-character default. */
  | "default"
  /** 2.x with the user's `[read] default_max_chars`. */
  | "config"
  /** Version unknown: the conservative legacy byte ceiling. */
  | "unknown";

export type KimiReadCapacityV1 =
  | {
      readonly unit: "bytes";
      readonly limit: number;
      readonly source: "legacy" | "unknown";
    }
  | {
      readonly unit: "chars";
      readonly limit: number;
      readonly source: "default" | "config";
    };

/** The measured facts about one prompt that decide whether it fits. */
export interface KimiPromptSizeV1 {
  readonly bytes: number;
  readonly chars: number;
  readonly lines: number;
}

export function measureKimiPromptV1(prompt: string): KimiPromptSizeV1 {
  let lines = 1;
  for (let i = 0; i < prompt.length; i++) {
    if (prompt.charCodeAt(i) === 10) {
      lines++;
    }
  }
  return { bytes: Buffer.byteLength(prompt, "utf8"), chars: prompt.length, lines };
}

/** The major version in `kimi --version` output ("kimi, version 2.3.2", "2.3.2"), or undefined. */
export function parseKimiMajorVersionV1(versionOutput: string | undefined): number | undefined {
  if (versionOutput === undefined) {
    return undefined;
  }
  const match = /(\d{1,3})\.\d{1,3}(?:\.\d{1,4})?/.exec(versionOutput);
  return match ? Number(match[1]) : undefined;
}

export type KimiReadConfigV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "set"; readonly defaultMaxChars: number }
  /** A `[read] default_max_chars` entry whose value is not a positive integer. */
  | { readonly kind: "malformed" };

const READ_HEADER_RE = /^\s*\[read\]\s*(?:#.*)?$/;
const ANY_HEADER_RE = /^\s*\[{1,2}[^\]]+\]{1,2}\s*(?:#.*)?$/;
const DEFAULT_MAX_CHARS_KEY_RE = /^(\s*)default_max_chars\s*=\s*(.*?)\s*(?:#.*)?$/;

/** Read `[read] default_max_chars` from a Kimi config.toml's text. */
export function parseKimiReadConfigV1(toml: string | undefined): KimiReadConfigV1 {
  if (toml === undefined) {
    return { kind: "absent" };
  }
  let inRead = false;
  for (const line of toml.split(/\r?\n/)) {
    if (ANY_HEADER_RE.test(line)) {
      inRead = READ_HEADER_RE.test(line);
      continue;
    }
    if (!inRead) {
      continue;
    }
    const match = DEFAULT_MAX_CHARS_KEY_RE.exec(line);
    if (!match) {
      continue;
    }
    const raw = match[2]!.replace(/_/g, "");
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return { kind: "malformed" };
    }
    return { kind: "set", defaultMaxChars: Math.min(Number(raw), KIMI_MAX_CHARS_LIMIT_V1) };
  }
  return { kind: "absent" };
}

/**
 * The effective capacity for an installed Kimi. An unknown version keeps the
 * conservative legacy ceiling, and so does a configuration that cannot be
 * established: a config file that exists but cannot be read
 * (`configUnreadable`) or whose `default_max_chars` is malformed may be hiding a
 * limit below the 2.x default. Only a config that is confirmed absent
 * (`configToml` undefined, `configUnreadable` unset) or has no setting yields the
 * 100,000-character default.
 */
export function resolveKimiReadCapacityV1(input: {
  readonly versionOutput?: string;
  /** The config file's text; undefined when the file does not exist. */
  readonly configToml?: string;
  /** The config file exists (or may exist) but could not be read. */
  readonly configUnreadable?: boolean;
}): KimiReadCapacityV1 {
  const major = parseKimiMajorVersionV1(input.versionOutput);
  if (major === undefined) {
    return { unit: "bytes", limit: KIMI_LEGACY_READ_CEILING_BYTES_V1, source: "unknown" };
  }
  if (major < 2) {
    return { unit: "bytes", limit: KIMI_LEGACY_READ_CEILING_BYTES_V1, source: "legacy" };
  }
  if (input.configUnreadable === true) {
    return { unit: "bytes", limit: KIMI_LEGACY_READ_CEILING_BYTES_V1, source: "unknown" };
  }
  const config = parseKimiReadConfigV1(input.configToml);
  if (config.kind === "malformed") {
    return { unit: "bytes", limit: KIMI_LEGACY_READ_CEILING_BYTES_V1, source: "unknown" };
  }
  if (config.kind === "set") {
    return { unit: "chars", limit: config.defaultMaxChars, source: "config" };
  }
  return { unit: "chars", limit: KIMI_DEFAULT_MAX_CHARS_V1, source: "default" };
}

/**
 * True when the prompt may not come back whole from one read. Characters (not
 * bytes) are compared for 2.x, with the line-number prefixes counted against
 * the limit; the legacy ceiling stays a byte comparison.
 */
export function kimiPromptExceedsCapacityV1(capacity: KimiReadCapacityV1, prompt: KimiPromptSizeV1): boolean {
  if (capacity.unit === "bytes") {
    return prompt.bytes > capacity.limit;
  }
  return prompt.chars + prompt.lines * KIMI_LINE_PREFIX_CHARS_V1 > capacity.limit;
}

/** The capacity as a human phrase for advisories ("100,000 characters per read"). */
export function describeKimiReadCapacityV1(capacity: KimiReadCapacityV1): string {
  const amount = capacity.limit.toLocaleString("en-US");
  if (capacity.unit === "bytes") {
    return capacity.source === "unknown"
      ? `~${amount} bytes per read (Kimi's version or config could not be established, so the older measured limit is assumed)`
      : `~${amount} bytes per read (measured on older Kimi versions)`;
  }
  return capacity.source === "config"
    ? `${amount} characters per read (your Kimi config's [read] default_max_chars)`
    : `${amount} characters per read (Kimi's default)`;
}

/**
 * Whether raising `[read] default_max_chars` could let this prompt through: only
 * on a 2.x install (it ignores the key on older ones, and an unestablished
 * version or config is not something to write over) whose limit is below the
 * offered value and below what the prompt needs.
 */
export function shouldOfferKimiReadConfigV1(capacity: KimiReadCapacityV1, prompt: KimiPromptSizeV1): boolean {
  if (capacity.unit !== "chars" || capacity.limit >= KIMI_OFFERED_MAX_CHARS_V1) {
    return false;
  }
  if (!kimiPromptExceedsCapacityV1(capacity, prompt)) {
    return false;
  }
  return !kimiPromptExceedsCapacityV1({ unit: "chars", limit: KIMI_OFFERED_MAX_CHARS_V1, source: "config" }, prompt);
}

/** The consent card's wording, kept pure so the all-sessions and token-cost warning is testable. */
export function describeKimiReadConfigOfferV1(
  capacity: KimiReadCapacityV1,
  prompt: KimiPromptSizeV1
): { readonly whatHappened: string; readonly consequence: string; readonly declineConsequence: string } {
  return {
    whatHappened:
      `This round's prompt (${prompt.chars.toLocaleString("en-US")} characters) is larger than Kimi can read in one go ` +
      `(${describeKimiReadCapacityV1(capacity)}), so Ensemble used another model for it. Kimi can read all of it at ` +
      `once if its config sets [read] default_max_chars = ${KIMI_OFFERED_MAX_CHARS_V1.toLocaleString("en-US")}.`,
    consequence:
      `Adds default_max_chars = ${KIMI_OFFERED_MAX_CHARS_V1} under [read] in your Kimi config (~/.kimi-code/config.toml); nothing else ` +
      "in it changes. The setting applies to all of your Kimi sessions, not only Ensemble's: Kimi will return larger " +
      "single reads, so it can use more tokens when it reads big files interactively. You can set it back by hand at any time.",
    declineConsequence:
      "Changes nothing. Oversized prompts keep being sent to another model in the stage's chain; this is not offered again until the window reloads.",
  };
}

export type SetKimiReadMaxCharsResultV1 =
  | { readonly ok: true; readonly toml: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Return `toml` with `[read] default_max_chars = value`, leaving every other
 * line (comments, other sections, line endings) untouched. Updates an existing
 * key in place, adds the key to an existing `[read]` section, or appends a new
 * section. Refuses a config whose `[read]` section is declared twice, since
 * which one Kimi honours would be a guess.
 */
export function setKimiReadDefaultMaxCharsV1(
  toml: string,
  value: number = KIMI_OFFERED_MAX_CHARS_V1
): SetKimiReadMaxCharsResultV1 {
  if (!Number.isInteger(value) || value <= 0 || value > KIMI_MAX_CHARS_LIMIT_V1) {
    return { ok: false, reason: `default_max_chars must be a whole number between 1 and ${KIMI_MAX_CHARS_LIMIT_V1}.` };
  }
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const lines = toml.length === 0 ? [] : toml.split(/\r?\n/);
  const headers: number[] = [];
  lines.forEach((line, i) => {
    if (READ_HEADER_RE.test(line)) {
      headers.push(i);
    }
  });
  if (headers.length > 1) {
    return { ok: false, reason: "The config declares a [read] section more than once; edit it by hand." };
  }
  const entry = `default_max_chars = ${value}`;
  if (headers.length === 0) {
    const body = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    const next = [...body, ...(body.length > 0 ? [""] : []), "[read]", entry, ""].join(eol);
    return { ok: true, toml: next, changed: true };
  }
  const start = headers[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADER_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i++) {
    const match = DEFAULT_MAX_CHARS_KEY_RE.exec(lines[i]!);
    if (match) {
      const current = parseKimiReadConfigV1(lines.slice(start, end).join("\n"));
      if (current.kind === "set" && current.defaultMaxChars === value) {
        return { ok: true, toml, changed: false };
      }
      const next = [...lines];
      next[i] = `${match[1]}${entry}`;
      return { ok: true, toml: next.join(eol), changed: true };
    }
  }
  const next = [...lines];
  next.splice(start + 1, 0, entry);
  return { ok: true, toml: next.join(eol), changed: true };
}

/** I/O the loader needs, injected so tests and non-Node hosts can supply fakes. */
export interface KimiReadCapacityDepsV1 {
  readonly readVersionOutput: () => Promise<string | undefined>;
  /** The config text; undefined when the file does not exist; rejects when it exists but cannot be read. */
  readonly readConfigToml: () => Promise<string | undefined>;
}

/**
 * Resolve the capacity from live version output and config; any failure keeps
 * the conservative answer. A missing config file is a confirmed absence, a read
 * failure is not.
 */
export async function loadKimiReadCapacityV1(deps: KimiReadCapacityDepsV1): Promise<KimiReadCapacityV1> {
  let configUnreadable = false;
  const [versionOutput, configToml] = await Promise.all([
    deps.readVersionOutput().catch(() => undefined),
    deps.readConfigToml().catch(() => {
      configUnreadable = true;
      return undefined;
    }),
  ]);
  return resolveKimiReadCapacityV1({
    ...(versionOutput !== undefined ? { versionOutput } : {}),
    ...(configToml !== undefined ? { configToml } : {}),
    ...(configUnreadable ? { configUnreadable: true } : {}),
  });
}
