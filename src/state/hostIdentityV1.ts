import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { hostname } from "os";

/**
 * Race-safe per-install host identity (v1 fixes item 1, Part 1a — completion
 * blocker: "no per-install race-safe host identity").
 *
 * `os.hostname()` alone is not a safe cross-process OWNER identity for work
 * admission: two installs, two VS Code profiles, or two containers that
 * happen to report the same hostname must never be treated as "the same
 * owner" once 1c's conservative liveness probing starts comparing a marker's
 * recorded `hostId` against "am I that host". A bare hostname read is also
 * not exclusive-create-safe against a racing first run — nothing stops two
 * extension hosts activating simultaneously on a fresh install from each
 * minting their own notion of identity if the mechanism were just "read
 * `os.hostname()`".
 *
 * This module mints a UUID once, persists it via the same exclusive-create
 * primitive `workAdmissionV1.ts` and `primarySessionLock.ts` already use
 * (`{ flag: "wx" }`), and every later reader — including concurrent racing
 * first runs — converges on whichever UUID actually won the create.
 *
 * `configureHostIdentityRootV1` is wired once at activation from
 * `context.globalStorageUri.fsPath` (the same per-install, per-profile
 * directory `configureWorkflowPrivateStorageRootV1` uses) — genuinely
 * per-install, unlike anything task-scoped. Until configured (workAdmissionV1's
 * own unit tests run outside any extension host, with no durable global
 * storage to write to), `resolveHostIdentityV1` fails open to a process-local
 * ephemeral id rather than throwing — consistent with this whole subsystem's
 * fail-open philosophy: an admission caller must always be able to proceed.
 */

const HOST_IDENTITY_FILENAME_V1 = "host-identity-v1.json";

interface HostIdentityRecordV1 {
  readonly hostId: string;
  readonly hostname: string;
  readonly createdAt: string;
}

let configuredRootDir: string | undefined;
let cachedHostId: string | undefined;
/** Serializes concurrent in-process resolutions so two racing callers in the
 * SAME process both await one filesystem round trip instead of each
 * attempting their own exclusive create. */
let inFlight: Promise<string> | undefined;

/** Activation wiring: call once with `context.globalStorageUri.fsPath`. */
export function configureHostIdentityRootV1(rootDir: string): void {
  configuredRootDir = rootDir;
  cachedHostId = undefined;
  inFlight = undefined;
}

function isRecord(value: unknown): value is Partial<HostIdentityRecordV1> {
  return typeof value === "object" && value !== null;
}

function readValidHostIdentitySyncV1(filePath: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (isRecord(raw) && typeof raw.hostId === "string" && raw.hostId.length > 0) {
      return raw.hostId;
    }
  } catch {
    // Corrupt or unreadable.
  }
  return undefined;
}

function sleepV1(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A handful of short, bounded retries — enough to ride out a transient
 * read glitch (e.g. antivirus/indexer locking on Windows, a filesystem
 * hiccup) without turning a real "nothing durable exists yet" miss into a
 * long stall. */
const HOST_IDENTITY_READ_RETRY_COUNT_V1 = 3;
const HOST_IDENTITY_READ_RETRY_DELAY_MS_V1 = 20;

/**
 * 2026-09-08 review (blocker `…-1`, narrowed): every failure branch below
 * used to fall back to `readValidHostIdentitySyncV1` — a single, synchronous,
 * best-effort read — or straight to a fresh `ephemeral-${randomUUID()}`
 * without even that. A transient read glitch (the winning file momentarily
 * locked by an indexer/antivirus scan, a slow filesystem) then looked
 * identical to "nothing durable exists", and two racing hosts that each hit
 * a transient glitch at slightly different moments would each mint their own
 * independent ephemeral id instead of converging once the glitch passed.
 * This retries the read a few times, with a short delay between attempts,
 * before conceding — used everywhere this module is about to give up and
 * fail open, so any failure path checks for an already-durable winner first.
 */
async function readValidHostIdentityWithRetryV1(filePath: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < HOST_IDENTITY_READ_RETRY_COUNT_V1; attempt++) {
    const value = readValidHostIdentitySyncV1(filePath);
    if (value) {
      return value;
    }
    if (attempt < HOST_IDENTITY_READ_RETRY_COUNT_V1 - 1) {
      await sleepV1(HOST_IDENTITY_READ_RETRY_DELAY_MS_V1);
    }
  }
  return undefined;
}

/**
 * Test-only deterministic failure injection for the `link()` publish step —
 * otherwise as impractical to force reliably and cross-platform as the
 * equivalent seam in `workAdmissionV1.ts` (see that module's own doc comment
 * for why). Set only from tests; `undefined` (the default) means production
 * behavior is unchanged.
 */
export interface HostIdentityFsFailureInjectionV1 {
  readonly onBeforeLink?: () => Error | undefined;
}
let fsFailureInjectionV1: HostIdentityFsFailureInjectionV1 | undefined;
export function setHostIdentityFsFailureInjectionForTestV1(injection: HostIdentityFsFailureInjectionV1 | undefined): void {
  fsFailureInjectionV1 = injection;
}

/**
 * The actual exclusive-create-then-read-fallback race, with no in-process
 * short-circuit. Exported (only) so tests can drive genuine concurrent
 * filesystem-level races directly — `resolveHostIdentityV1` below normally
 * shields concurrent in-process callers from ever reaching this more than
 * once via its `inFlight` promise, which is correct for production but would
 * hide a regression in the exclusive-create race itself from a same-process
 * test.
 *
 * Completion blocker fix (2026-09-08 review): the prior implementation wrote
 * the candidate record directly to the SHARED final path with `{ flag: "wx" }`.
 * `fs.promises.writeFile` is not a single atomic syscall — it opens the file
 * (which is when the create-exclusive check happens and the file becomes
 * discoverable at that path) and THEN writes the buffer. A concurrent racer
 * that lost the create race but reads the file in that window can observe a
 * truncated/partial record, fail to parse it, and fall open to an independent
 * ephemeral id — the exact way racing hosts could fail to converge. Fixed by
 * writing the COMPLETE record to a private, per-attempt temp path first, then
 * publishing it with `fs.promises.link` — which creates a new directory entry
 * pointing at the already-fully-written temp file's data and fails with
 * `EEXIST` if the final path already exists, rather than overwriting it. So
 * the final path only ever transitions from "absent" to "one complete record,
 * forever" — there is no partial-content state a reader can observe, and no
 * second writer can ever silently replace the first winner's content.
 */
export async function resolveDurableHostIdentityV1(rootDir: string): Promise<string> {
  const filePath = path.join(rootDir, HOST_IDENTITY_FILENAME_V1);
  try {
    await fs.promises.mkdir(rootDir, { recursive: true });
  } catch {
    // Best-effort; the exclusive-create below will surface a real failure.
  }

  // Fast path: a complete record may already be published — avoids an
  // unnecessary temp-file write/link round trip on every call after the
  // first (this module's own in-process cache already short-circuits most
  // callers, but a fresh process with no cache still benefits).
  const existing = readValidHostIdentitySyncV1(filePath);
  if (existing) {
    return existing;
  }

  const record: HostIdentityRecordV1 = { hostId: randomUUID(), hostname: hostname(), createdAt: new Date().toISOString() };
  const tempPath = path.join(rootDir, `${HOST_IDENTITY_FILENAME_V1}.tmp-${process.pid.toString(36)}-${randomUUID()}`);
  try {
    // Exclusive-create the temp path too (its name is already unique per
    // attempt, so this can only fail for a real filesystem reason, never
    // contention) and write the COMPLETE record before it is ever linked
    // into the shared final path.
    await fs.promises.writeFile(tempPath, JSON.stringify(record), { flag: "wx" });
  } catch {
    // Cannot even create our own private, uniquely-named temp file —
    // genuinely a storage/permission problem, not contention. Before
    // conceding to a private ephemeral id, check (with retry) whether a
    // durable record already exists — a concurrent racer may have published
    // one moments ago even though nothing about that publication caused our
    // own failure. Only fail open when there is truly nothing to converge on.
    return (await readValidHostIdentityWithRetryV1(filePath)) ?? `ephemeral-${randomUUID()}`;
  }
  try {
    const injected = fsFailureInjectionV1?.onBeforeLink?.();
    if (injected) {
      throw injected;
    }
    await fs.promises.link(tempPath, filePath);
    return record.hostId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      // A non-EEXIST link failure (EPERM, a transient handle/locking issue,
      // ...) does not by itself prove no one else has published — check
      // (with retry) before failing open to our own independent ephemeral id.
      return (await readValidHostIdentityWithRetryV1(filePath)) ?? `ephemeral-${randomUUID()}`;
    }
    // Someone else published first. Their temp file was necessarily complete
    // BEFORE their link() could succeed (link only ever exposes fully-written
    // content — see doc comment above), so the final path holds a complete
    // record as soon as it is readable at all; retry a transient read glitch
    // (e.g. a momentary lock from an indexer/antivirus scan) rather than
    // treating it as "nothing published" on the first miss.
    return (await readValidHostIdentityWithRetryV1(filePath)) ?? `ephemeral-${randomUUID()}`;
  } finally {
    // Always remove our own private temp file — it played no further role
    // once link() has either published it or failed.
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

/** Resolve (and cache) this install's race-safe host identity. See module doc comment. */
export async function resolveHostIdentityV1(): Promise<string> {
  if (cachedHostId) {
    return cachedHostId;
  }
  if (!configuredRootDir) {
    cachedHostId = `ephemeral-${randomUUID()}`;
    return cachedHostId;
  }
  if (!inFlight) {
    inFlight = resolveDurableHostIdentityV1(configuredRootDir).finally(() => {
      inFlight = undefined;
    });
  }
  const resolved = await inFlight;
  cachedHostId = resolved;
  return resolved;
}

/** Test isolation: restore the pristine, unconfigured state. Production never calls this. */
export function resetHostIdentityForTestV1(): void {
  configuredRootDir = undefined;
  cachedHostId = undefined;
  inFlight = undefined;
}
