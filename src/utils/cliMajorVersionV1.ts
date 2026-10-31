/**
 * bugs3 Step 14: which major version of a CLI is installed, for providers whose
 * argument and discovery contract changed between majors (devpass-code 1.x vs
 * 2.x). `parseCliMajorVersionV1` is pure; `getCliMajorVersionV1` runs
 * `<command> --version` once and caches the answer briefly so a burst of
 * dispatches and a catalog refresh probe the CLI once.
 */
import * as cp from "node:child_process";

const CACHE_TTL_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * The major version in `--version` output ("1.18.11", "devpass-code v2.0.29"),
 * or undefined when no `N.N.N` appears.
 */
export function parseCliMajorVersionV1(output: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

/** devpass-code majors Ensemble can drive (1.x verified 1.18.11, 2.x verified 2.0.29). */
export const DEVPASS_SUPPORTED_MAJORS_V1: readonly number[] = [1, 2];
/** The major assumed when `--version` is unreadable: what `npm i -g devpass-code` installs. */
export const DEVPASS_DEFAULT_MAJOR_V1 = 2;

/**
 * The one decision both running and model discovery make from a probed
 * version, so they can never pick different contracts: a readable supported
 * major is used; an unreadable one falls back to `defaultMajor`; a readable
 * unsupported major is refused (`unsupportedMajor`).
 */
export function decideCliMajorV1(
  detected: number | undefined,
  supportedMajors: readonly number[],
  defaultMajor: number
): { readonly major: number } | { readonly unsupportedMajor: number } {
  if (detected === undefined) {
    return { major: defaultMajor };
  }
  return supportedMajors.includes(detected) ? { major: detected } : { unsupportedMajor: detected };
}

/** The refusal shown (run) or logged (discovery) for an unsupported devpass-code major. */
export function devpassUnsupportedMajorMessageV1(detectedMajor: number): string {
  return (
    `This devpass-code is ${detectedMajor}.x; Ensemble supports devpass-code 1.x (verified 1.18.11) and 2.x ` +
    "(verified 2.0.29). Install a supported version (for example `npm i -g devpass-code@2.0.29`) and try again."
  );
}

/**
 * Where the last readable major of each CLI is kept between windows. A probe
 * that fails (a slow start, a timeout while every CLI is probed at once) then
 * resolves to the version this machine last reported instead of to the default
 * contract, so running and discovery keep agreeing with the installed CLI.
 */
export interface CliMajorPersistenceV1 {
  load(command: string): number | undefined;
  save(command: string, major: number): void;
}

let persistence: CliMajorPersistenceV1 | undefined;

/** Install (or with undefined, remove) the store the last readable major is kept in. */
export function setCliMajorPersistenceV1(store: CliMajorPersistenceV1 | undefined): void {
  persistence = store;
}

/** The major last read from `command`'s `--version` on this machine, if one was kept. */
export function lastKnownCliMajorV1(command: string): number | undefined {
  try {
    const stored = persistence?.load(command);
    return typeof stored === "number" && Number.isSafeInteger(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function rememberCliMajorV1(command: string, major: number): void {
  try {
    if (persistence !== undefined && persistence.load(command) !== major) {
      persistence.save(command, major);
    }
  } catch {
    // A store that cannot be written only loses the fallback.
  }
}

const cache = new Map<string, { readonly at: number; readonly major: number | undefined }>();

/** Drops cached answers; for tests and for a catalog refresh after an upgrade. */
export function clearCliMajorVersionCacheV1(): void {
  cache.clear();
}

export function getCliMajorVersionV1(command: string, now: number = Date.now()): Promise<number | undefined> {
  const cached = cache.get(command);
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.major);
  }
  return new Promise((resolve) => {
    cp.execFile(
      command,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const major = error ? undefined : parseCliMajorVersionV1(`${stdout}\n${stderr}`);
        // A failed probe is not cached: the next dispatch tries again. Until it
        // succeeds, the major this machine last reported stands in for it.
        if (major !== undefined) {
          cache.set(command, { at: now, major });
          rememberCliMajorV1(command, major);
          resolve(major);
          return;
        }
        resolve(lastKnownCliMajorV1(command));
      }
    );
  });
}
