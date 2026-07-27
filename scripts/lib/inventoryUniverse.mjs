/**
 * Shared production-source-universe loader for the route and path-consumer
 * inventory generators (plan §1.1: "Route generation consumes this
 * source-universe file and cannot independently expand or filter it").
 *
 * The universe is the checked-in output of the §1.1 resolver
 * (workflow-production-source-baseline-v1.json for the live scans;
 * workflow-production-source-pregate-v1.json for the immutable pre-gate
 * scans). Downstream inventories read the exact TypeScript file list from
 * that JSON — never a filesystem walk — so a module the shipping bundle does
 * not reach (e.g. dead utilities under src/) can never enter a route or
 * path-consumer inventory, and a reachable module can never be skipped.
 *
 * PROVENANCE DIGEST PORTABILITY: `universeSha256` — recorded into every
 * downstream inventory as `sourceUniverseSha256` — is the CANONICAL
 * (line-ending-independent) digest of the universe JSON, computed through
 * the same `canonicalContentSha256` rule production-file evidence uses
 * (scripts/lib/productionSourceScan.mjs). Hashing the raw checkout bytes
 * would make the same committed JSON produce different provenance on LF vs
 * CRLF checkouts (this repository has no .gitattributes EOL policy), which
 * is exactly the non-reproducibility plan §1.1 forbids. The two immutable
 * pre-gate inventory snapshots (workflow-route-pregate-v1.json,
 * workflow-path-consumer-pregate-v1.json) predate canonical digesting and
 * recorded the raw checkout-byte digest of the frozen universe JSON; they
 * are never rewritten, so any comparison against their recorded
 * `sourceUniverseSha256` must go through the tolerant
 * `contentMatchesRecordedSha256` matcher (see
 * verifyRecordedUniverseProvenance below), never a strict equality.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { canonicalContentSha256, fileMatchesRecordedSha256 } from "./productionSourceScan.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const EOL_FIXTURE_PATH = path.join(
  repoRoot,
  "test-fixtures",
  "workflow-production-sources",
  "eol-digest-fixture-v1.json"
);

/**
 * Parses raw universe JSON bytes into the TypeScript source file list plus
 * provenance. Split out from readUniverseTsFiles so the digest-portability
 * self-check can drive the EXACT production parse/digest path with in-memory
 * LF/CRLF fixture vectors. Throws on an invalid universe — callers surface
 * that as a fail-closed verification error.
 */
export function parseUniverseTsFiles(rawBytes, universeLabel) {
  const universe = JSON.parse(rawBytes.toString("utf8"));
  const files = (universe.files || [])
    .map((f) => f.path)
    .filter((p) => typeof p === "string" && p.startsWith("src/") && p.endsWith(".ts"));
  if (files.length === 0) {
    throw new Error(`Production source universe ${universeLabel} lists no src/**/*.ts files — refusing to scan nothing.`);
  }
  return {
    files: files.sort((a, b) => a.localeCompare(b)),
    universeSha256: canonicalContentSha256(rawBytes),
    fileDigests: new Map((universe.files || []).map((f) => [f.path, f.sha256])),
  };
}

/**
 * Reads a production-source-universe JSON and returns its TypeScript source
 * file list plus provenance. Throws on a missing/invalid universe file —
 * callers surface that as a fail-closed verification error.
 */
export function readUniverseTsFiles(universeJsonPath) {
  if (!fs.existsSync(universeJsonPath)) {
    throw new Error(
      `Production source universe ${universeJsonPath} does not exist — run the §1.1 resolver first ` +
        `(pnpm run verify:workflow-production-sources / --generate).`
    );
  }
  return parseUniverseTsFiles(fs.readFileSync(universeJsonPath), universeJsonPath);
}

/**
 * Digest-portability self-check for the source-universe provenance hash
 * (implementation-review fixture, `universe` section of
 * eol-digest-fixture-v1.json): proves on every route/path-consumer run —
 * from checked-in base64 vectors git EOL settings cannot rewrite — that the
 * LF and CRLF serializations of the SAME universe JSON flow through
 * parseUniverseTsFiles to the identical `universeSha256` and identical file
 * list, and that genuinely different universe content does not. If
 * `universeSha256` ever regresses to hashing raw checkout bytes, this fails
 * closed before any inventory evidence is written or compared.
 */
export function verifyUniverseDigestPortabilityFixture(record) {
  if (!fs.existsSync(EOL_FIXTURE_PATH)) {
    record(
      `Missing digest-portability fixture test-fixtures/workflow-production-sources/eol-digest-fixture-v1.json — ` +
        `it proves sourceUniverseSha256 provenance is line-ending-independent and must exist for route/path-consumer ` +
        `evidence to be trusted.`
    );
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(EOL_FIXTURE_PATH, "utf8"));
  const vectors = fixture.universe;
  if (
    !vectors ||
    [vectors.lfBase64, vectors.crlfBase64, vectors.mutatedBase64, vectors.canonicalSha256].some(
      (v) => typeof v !== "string" || v.length === 0
    )
  ) {
    record(
      `eol-digest-fixture-v1.json carries no complete "universe" vector block (lfBase64/crlfBase64/mutatedBase64/` +
        `canonicalSha256) — the sourceUniverseSha256 portability guarantee cannot be proven.`
    );
    return;
  }
  let lf, crlf, mutated;
  try {
    lf = parseUniverseTsFiles(Buffer.from(vectors.lfBase64, "base64"), "eol-digest fixture universe (LF form)");
    crlf = parseUniverseTsFiles(Buffer.from(vectors.crlfBase64, "base64"), "eol-digest fixture universe (CRLF form)");
    mutated = parseUniverseTsFiles(Buffer.from(vectors.mutatedBase64, "base64"), "eol-digest fixture universe (mutated form)");
  } catch (e) {
    record(`Universe EOL fixture vectors failed to parse through parseUniverseTsFiles: ${String(e?.message ?? e)}`);
    return;
  }
  if (lf.universeSha256 !== vectors.canonicalSha256) {
    record(`Universe EOL fixture: universeSha256 of the LF serialization does not match the recorded canonicalSha256.`);
  }
  if (crlf.universeSha256 !== vectors.canonicalSha256) {
    record(
      `Universe EOL fixture: universeSha256 of the CRLF serialization does not match the LF serialization — ` +
        `sourceUniverseSha256 provenance has regressed to checkout-line-ending-dependent hashing.`
    );
  }
  if (JSON.stringify(lf.files) !== JSON.stringify(crlf.files)) {
    record(`Universe EOL fixture: the LF and CRLF serializations resolved different file lists.`);
  }
  if (mutated.universeSha256 === vectors.canonicalSha256) {
    record(
      `Universe EOL fixture: a genuinely different universe unexpectedly matches the canonical digest — ` +
        `universeSha256 is not content-sensitive.`
    );
  }
}

/**
 * Verifies a recorded `sourceUniverse` + `sourceUniverseSha256` provenance
 * pair (as carried by the immutable pre-gate route/path-consumer snapshots)
 * against the referenced universe file's current on-disk content. The
 * immutable snapshots recorded RAW checkout-byte digests (pre-canonical era)
 * and are never rewritten, so the comparison uses the tolerant
 * line-ending-projection matcher: any single-EOL representation of the same
 * text matches; a genuine content change to the frozen universe file fails.
 */
export function verifyRecordedUniverseProvenance({ rootDir, sourceUniverse, sourceUniverseSha256, label, record }) {
  if (typeof sourceUniverse !== "string" || sourceUniverse.length === 0) {
    record(`${label} records no sourceUniverse reference — its scan provenance is unverifiable.`);
    return;
  }
  if (typeof sourceUniverseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceUniverseSha256)) {
    record(`${label} records no valid sourceUniverseSha256 — its scan provenance is unverifiable.`);
    return;
  }
  const universeAbs = path.join(rootDir, ...sourceUniverse.split("/"));
  if (!fs.existsSync(universeAbs)) {
    record(`${label} references source universe ${sourceUniverse}, which does not exist on disk.`);
    return;
  }
  if (!fileMatchesRecordedSha256(universeAbs, sourceUniverseSha256)) {
    record(
      `${label} was scanned from ${sourceUniverse} with recorded digest ${sourceUniverseSha256}, but no line-ending ` +
        `projection of that file's current content matches — the referenced universe has genuinely changed since the ` +
        `snapshot was generated, so the two no longer describe the same tree.`
    );
  }
}

/**
 * Resolves the universe's relative file list against a root directory,
 * failing (via `record`) for any listed file missing on disk instead of
 * silently narrowing the scan.
 */
export function resolveUniverseFiles(rootDir, relFiles, record) {
  const resolved = [];
  for (const rel of relFiles) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      record(
        `Source-universe file ${rel} does not exist under ${rootDir} — the universe and the tree have drifted; ` +
          `re-run the §1.1 resolver before regenerating downstream inventories.`
      );
      continue;
    }
    resolved.push(abs);
  }
  return resolved;
}
