/**
 * Shared production-source scanning logic used by both
 * `scripts/resolveProductionSourceUniverse.mjs` (the regularly re-run
 * live/baseline resolver) and `scripts/generatePregateProductionSourceBaseline.mjs`
 * (the one-time immutable pre-gate snapshot generator, plan §1.1 Phase 0).
 *
 * Factored out so the two scripts cannot independently drift in what counts
 * as "production source" — the pre-gate snapshot and every later live run
 * must apply identical inclusion/classification rules; only the tree they
 * scan (current working tree vs. a historical checkout) differs.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * CANONICAL CONTENT DIGESTS (digest portability).
 *
 * Production-source evidence must be reproducible across operating systems
 * and git EOL checkout profiles (plan §1.1 reproducible baselines; the
 * §1.7 Windows/Linux/macOS host matrix consumes the same checked-in
 * evidence). Hashing raw checkout bytes is NOT reproducible: this repository
 * has no .gitattributes EOL policy, so the same committed text materializes
 * as LF bytes on a clean Linux/macOS checkout and as CRLF bytes on a
 * Windows checkout with core.autocrlf=true — two different raw digests for
 * identical content. Canonical digests therefore normalize CRLF -> LF
 * before hashing for text content, and hash verbatim bytes for binary
 * content (git never rewrites binary blobs at checkout, so raw bytes are
 * already portable there). Binary detection mirrors git's own heuristic: a
 * NUL byte within the first 8000 bytes.
 *
 * The immutable pre-gate snapshot predates canonical digesting and recorded
 * raw checkout-byte digests (a mix of CRLF-form and LF-form rows, per the
 * generating machine's checkout profile). It is never rewritten; comparisons
 * against it go through contentMatchesRecordedSha256 below instead.
 */
const BINARY_SNIFF_LIMIT = 8000;

function rawSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function isBinaryContent(buffer) {
  const limit = Math.min(buffer.length, BINARY_SNIFF_LIMIT);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Byte-level CRLF -> LF. Never decodes text, so only exact 0x0D0A pairs change; a lone CR is preserved (matching git's text conversion). */
export function normalizeContentToLf(buffer) {
  if (!buffer.includes(0x0d)) {
    return buffer;
  }
  const out = Buffer.allocUnsafe(buffer.length);
  let n = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
      continue;
    }
    out[n++] = buffer[i];
  }
  return out.subarray(0, n);
}

/** The all-CRLF projection of already-LF-normalized bytes (used only to compare against historical raw digests). */
function projectLfToCrlf(lfBuffer) {
  let newlineCount = 0;
  for (let i = 0; i < lfBuffer.length; i++) {
    if (lfBuffer[i] === 0x0a) {
      newlineCount++;
    }
  }
  if (newlineCount === 0) {
    return lfBuffer;
  }
  const out = Buffer.allocUnsafe(lfBuffer.length + newlineCount);
  let n = 0;
  for (let i = 0; i < lfBuffer.length; i++) {
    if (lfBuffer[i] === 0x0a) {
      out[n++] = 0x0d;
    }
    out[n++] = lfBuffer[i];
  }
  return out;
}

/** Canonical (line-ending-independent) digest: LF-normalized bytes for text, verbatim bytes for binary. */
export function canonicalContentSha256(buffer) {
  return rawSha256(isBinaryContent(buffer) ? buffer : normalizeContentToLf(buffer));
}

export function sha256OfFile(absPath) {
  return canonicalContentSha256(fs.readFileSync(absPath));
}

/**
 * Matches content against a digest recorded BEFORE canonical digesting
 * existed (the immutable pre-gate snapshot): those digests hashed raw
 * checkout bytes, so the recorded value may be the CRLF form or the LF form
 * of the same text. The comparison accepts the recorded digest if it
 * matches the live content's raw bytes, its LF projection, or its CRLF
 * projection — the same text under any single-EOL representation matches;
 * content that differs in more than line endings matches none of the three.
 * Binary content is compared raw only.
 */
export function contentMatchesRecordedSha256(buffer, recordedSha256) {
  if (typeof recordedSha256 !== "string" || recordedSha256.length === 0) {
    return false;
  }
  if (rawSha256(buffer) === recordedSha256) {
    return true;
  }
  if (isBinaryContent(buffer)) {
    return false;
  }
  const lf = normalizeContentToLf(buffer);
  if (rawSha256(lf) === recordedSha256) {
    return true;
  }
  return rawSha256(projectLfToCrlf(lf)) === recordedSha256;
}

export function fileMatchesRecordedSha256(absPath, recordedSha256) {
  return contentMatchesRecordedSha256(fs.readFileSync(absPath), recordedSha256);
}

export function sha256OfText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export const TEST_LIKE_PATTERNS = [
  /(^|\/)src\/test\//i,
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /(^|\/)test-stubs\//i,
  /(^|\/)test-fixtures\//i,
];

/** package.json fields/keys whose string values are asset paths, not commands/copy. */
const ASSET_LIKE_EXTENSION_RE = /\.(png|svg|jpg|jpeg|gif|ico|webp)$/i;

/**
 * Walk an arbitrary JSON value (package.json's `contributes` tree plus the
 * top-level `icon` field) and collect every string that looks like a
 * relative image asset path. VS Code contribution points that carry asset
 * paths (`icon`, per-command `icon`, view container `icon`, theme icons,
 * etc.) are all plain strings ending in an image extension, and codicon
 * references (`$(name)`) never match the extension pattern, so a blanket
 * string scan is precise enough without hand-maintaining a list of
 * contribution-point property names that would silently go stale as
 * `package.json` grows new contribution kinds.
 */
export function collectContributionAssetPaths(packageJson) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (ASSET_LIKE_EXTENSION_RE.test(value) && !value.includes("://")) {
        found.add(value.replace(/^\.\//, ""));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        visit(value[key]);
      }
    }
  };
  visit(packageJson.icon);
  visit(packageJson.contributes);
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * README.md is packaged as the marketplace listing body (not excluded by
 * .vscodeignore) and embeds `images/screenshots/*.png` via plain Markdown
 * image syntax (`![alt](images/...)`), which — unlike package.json's
 * contribution tree — is prose, not structured data, so it needs its own
 * narrow extraction rule rather than reusing collectContributionAssetPaths.
 */
export function collectReadmeReferencedAssetPaths(sourceRoot) {
  const readmePath = path.join(sourceRoot, "README.md");
  if (!fs.existsSync(readmePath)) {
    return [];
  }
  const text = fs.readFileSync(readmePath, "utf8");
  const found = new Set();
  const imageRefRe = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let match;
  while ((match = imageRefRe.exec(text)) !== null) {
    const ref = match[1];
    if (ASSET_LIKE_EXTENSION_RE.test(ref) && !ref.includes("://")) {
      found.add(ref.replace(/^\.\//, ""));
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * A same-basename `.svg` sitting next to a contribution-referenced `.png` is
 * treated as that icon's vector source, not an unrelated unreferenced file
 * (e.g. `images/icon.svg` alongside the `images/icon.png` used as
 * package.json's `icon`). Scoped to exactly that pairing so it cannot
 * silently absorb an unrelated SVG dropped into the same directory.
 */
export function collectVectorSourceCompanionPaths(sourceRoot, contributionAssetPaths) {
  const found = new Set();
  for (const relPath of contributionAssetPaths) {
    if (!relPath.toLowerCase().endsWith(".png")) {
      continue;
    }
    const companion = relPath.slice(0, -4) + ".svg";
    if (fs.existsSync(path.join(sourceRoot, companion))) {
      found.add(companion);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * `resources/prompts/**\/*.md` are not statically importable — they are read
 * at runtime via `vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri,
 * "resources", "prompts", ...))` (src/utils/promptTemplates.ts), so esbuild's
 * static dependency graph can never see them. Plan §1.1 point 6 allows exactly
 * this shape: inclusion "by an exact checked-in production copy/package rule".
 * This is that rule, scoped as narrowly as the actual runtime reader.
 */
export function collectRuntimeResourceCopyPaths(repoRoot) {
  const dir = path.join(repoRoot, "resources", "prompts");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `resources/prompts/${name}`)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Runs the pinned bundler (via the shared `esbuild.config.js` factory) in
 * no-write/metafile mode against `sourceRoot`, and returns the sorted list of
 * first-party (non-`node_modules`) TS/JS inputs actually reachable from the
 * production entrypoint, plus diagnostics needed by callers to fail closed.
 *
 * `toolingRoot` is where `esbuild`/`typescript`/`esbuild.config.js` resolve
 * from (always the real repo checkout — a historical `sourceRoot` snapshot
 * used for the pre-gate baseline has no `node_modules` of its own).
 *
 * `plugins`, when passed, must be the SAME plugin instances (from the same
 * `esbuild.config.js` factory) `esbuild.js` installs on the shipping build —
 * AC-BASE-03 requires the two builds share every option, plugins included,
 * not just the scalar entries. The plugin itself never touches the metafile
 * input graph, but this call must not be the one place that quietly drops it.
 */
export async function scanBundledSources({ sourceRoot, toolingRoot, esbuild, createProductionBuildOptions, plugins = [] }) {
  const buildOptions = createProductionBuildOptions({ production: true });

  const result = await esbuild.build({
    ...buildOptions,
    absWorkingDir: sourceRoot,
    plugins,
    write: false,
    metafile: true,
  });

  const allInputs = Object.keys(result.metafile.inputs);
  const firstPartyInputs = allInputs
    .map((p) => p.split(path.sep).join("/"))
    .filter((p) => !p.startsWith("node_modules/"))
    .filter((p) => !path.isAbsolute(p));

  return { buildOptions, firstPartyInputs: [...new Set(firstPartyInputs)].sort((a, b) => a.localeCompare(b)) };
}

/** Recursively lists every file under `relDir` (POSIX-separated, relative to `sourceRoot`). */
function listFilesRecursive(sourceRoot, relDir) {
  const absDir = path.join(sourceRoot, relDir);
  if (!fs.existsSync(absDir)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(sourceRoot, relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Full scan: classified non-bundled shipped assets (contribution-referenced
 * images under `images/`, runtime resource-template copies under
 * `resources/prompts/`), each with a SHA-256 digest computed from
 * `sourceRoot`. Fails closed both ways:
 *  - a contribution/copy-rule reference to a path missing on disk;
 *  - a file physically present under `images/**` or `resources/**` that no
 *    contribution reference or copy rule accounts for (so a new unreferenced
 *    asset dropped into either directory cannot silently ship unclassified).
 * Returns problems in `missing`/`unaccounted` rather than throwing — callers
 * decide how to report failures alongside the rest of their diagnostics.
 */
export function classifyNonBundledAssets({ sourceRoot, packageJson }) {
  const contributionAssetPaths = collectContributionAssetPaths(packageJson);
  const runtimeResourceCopyPaths = collectRuntimeResourceCopyPaths(sourceRoot);
  const readmeReferencedAssetPaths = collectReadmeReferencedAssetPaths(sourceRoot);
  const vectorSourceCompanionPaths = collectVectorSourceCompanionPaths(sourceRoot, contributionAssetPaths);

  const rulesByCategory = [
    ["contributionAsset", contributionAssetPaths, "contribution-referenced asset"],
    ["runtimeResourceCopy", runtimeResourceCopyPaths, "runtime resource-copy path"],
    ["readmeReferencedAsset", readmeReferencedAssetPaths, "README-referenced asset"],
    ["vectorSourceCompanion", vectorSourceCompanionPaths, "vector-source companion asset"],
  ];

  const missing = [];
  const assets = [];
  const classifiedPaths = new Set();

  for (const [category, relPaths, label] of rulesByCategory) {
    for (const relPath of relPaths) {
      classifiedPaths.add(relPath);
      const absPath = path.join(sourceRoot, relPath);
      if (!fs.existsSync(absPath)) {
        missing.push(`${label} not found on disk: ${relPath}`);
        continue;
      }
      assets.push({ path: relPath, sha256: sha256OfFile(absPath), category });
    }
  }

  const onDiskUnderImages = listFilesRecursive(sourceRoot, "images");
  const onDiskUnderResources = listFilesRecursive(sourceRoot, "resources");
  const unaccounted = [...onDiskUnderImages, ...onDiskUnderResources]
    .filter((relPath) => !classifiedPaths.has(relPath))
    .sort((a, b) => a.localeCompare(b));

  assets.sort((a, b) => a.path.localeCompare(b.path));
  return { assets, missing, unaccounted };
}
