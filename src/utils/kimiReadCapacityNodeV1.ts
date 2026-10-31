/**
 * bugs3 Step 5: the real-machine source for `loadKimiReadCapacityV1` — runs
 * `kimi --version` and reads `~/.kimi-code/config.toml`. Both are best-effort
 * (any failure other than an absent config file keeps the conservative legacy ceiling) and the answer is cached
 * briefly so a burst of review dispatches probes the CLI once.
 */
import * as cp from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
  loadKimiReadCapacityV1,
  setKimiReadDefaultMaxCharsV1,
  type KimiReadCapacityV1,
} from "./kimiReadCapacityV1";

const CACHE_TTL_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;

let cached: { readonly at: number; readonly capacity: KimiReadCapacityV1 } | undefined;

/** Where Kimi 2.x keeps its config. */
export function kimiConfigPathV1(home: string = nodeOs.homedir()): string {
  return nodePath.join(home, ".kimi-code", "config.toml");
}

function readVersionOutput(): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile(
      "kimi",
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout, stderr) => resolve(error ? undefined : `${stdout}\n${stderr}`)
    );
  });
}

/** The config text; undefined only when the file does not exist. Any other failure rejects so the limit stays conservative. */
async function readConfigToml(): Promise<string | undefined> {
  try {
    return await nodeFs.promises.readFile(kimiConfigPathV1(), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** The installed Kimi's effective read capacity, cached for a minute. */
export async function getKimiReadCapacityV1(now: number = Date.now()): Promise<KimiReadCapacityV1> {
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    return cached.capacity;
  }
  const capacity = await loadKimiReadCapacityV1({ readVersionOutput, readConfigToml });
  cached = { at: now, capacity };
  return capacity;
}

/** File operations the consented config write needs, injectable for tests. */
export interface KimiConfigFileOpsV1 {
  /** The file's text; undefined when it does not exist; rejects on any other failure. */
  readonly read: (path: string) => Promise<string | undefined>;
  /** Write `text` so a reader never sees a half-written file, creating the folder when needed. */
  readonly writeAtomic: (path: string, text: string) => Promise<void>;
}

export const defaultKimiConfigFileOpsV1: KimiConfigFileOpsV1 = {
  read: async (path) => {
    try {
      return await nodeFs.promises.readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return undefined;
      }
      throw error;
    }
  },
  writeAtomic: async (path, text) => {
    await nodeFs.promises.mkdir(nodePath.dirname(path), { recursive: true });
    const temp = `${path}.ensemble-${process.pid}-${Date.now()}.tmp`;
    // The config can hold credentials-adjacent settings: the replacement keeps
    // the original's permission bits (or is owner-only for a new file) and is
    // never readable by anyone else, not even briefly, whatever the umask.
    let mode = 0o600;
    try {
      mode = (await nodeFs.promises.stat(path)).mode & 0o777;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    try {
      await nodeFs.promises.writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await nodeFs.promises.chmod(temp, mode);
      await nodeFs.promises.rename(temp, path);
    } catch (error) {
      await nodeFs.promises.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  },
};

export type KimiReadConfigWriteResultV1 =
  | { readonly ok: true; readonly changed: boolean; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly path: string };

/**
 * The consented change: set `[read] default_max_chars = 500000` in the user's
 * Kimi config. Only ever called after the owner chose the option in chat. It
 * edits just that key, refuses rather than guesses when the file cannot be read
 * or the edit is ambiguous, and writes nothing when the file changed since it
 * was read (the owner or Kimi edited it meanwhile).
 */
export async function applyKimiReadMaxCharsConsentV1(
  ops: KimiConfigFileOpsV1 = defaultKimiConfigFileOpsV1,
  path: string = kimiConfigPathV1()
): Promise<KimiReadConfigWriteResultV1> {
  const refuse = (reason: string): KimiReadConfigWriteResultV1 => ({ ok: false, reason, path });
  let before: string | undefined;
  try {
    before = await ops.read(path);
  } catch (error) {
    return refuse(`${path} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was changed.`);
  }
  const edited = setKimiReadDefaultMaxCharsV1(before ?? "");
  if (!edited.ok) {
    return refuse(`${edited.reason} Nothing was changed.`);
  }
  if (!edited.changed) {
    return { ok: true, changed: false, path };
  }
  let again: string | undefined;
  try {
    again = await ops.read(path);
  } catch (error) {
    return refuse(`${path} could not be re-read before writing (${error instanceof Error ? error.message : String(error)}); nothing was changed.`);
  }
  if (again !== before) {
    return refuse(`${path} changed while the edit was being prepared; nothing was written. Choose the option again to retry.`);
  }
  try {
    await ops.writeAtomic(path, edited.toml);
  } catch (error) {
    return refuse(`${path} could not be written (${error instanceof Error ? error.message : String(error)}); nothing was changed.`);
  }
  resetKimiReadCapacityCacheV1();
  return { ok: true, changed: true, path };
}

/** Forget the cached answer (after the config was changed, or in tests). */
export function resetKimiReadCapacityCacheV1(): void {
  cached = undefined;
}
