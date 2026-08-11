/**
 * Historical `task.md` creation-seed matcher (plan §4.3).
 *
 * `TaskCreationStartupReconcilerV1` needs to tell a `pristine` legacy
 * `creating` folder (whose `task.md` is byte-exact to a seed the extension
 * itself emitted at creation time — safe to treat as not-yet-user-edited)
 * apart from a `preservable` one (whose `task.md` diverges from every known
 * seed, so it may hold real user-authored content that must never be
 * silently discarded).
 *
 * The seed corpus mirrors `test-fixtures/creation-seeds/` (see that
 * directory's README for provenance), but production code cannot read
 * `test-fixtures/**` — that directory is excluded from the packaged
 * extension (.vscodeignore). The three legacy seeds therefore ship as their
 * own bundled copies under `resources/prompts/creation-seed-legacy-*.md`
 * (byte-identical copies, loaded at runtime exactly like
 * `resources/prompts/task-template.md` via `promptTemplates.ts`). The
 * current (v1) seed is not
 * duplicated: it is `resources/prompts/task-template.md` itself, already
 * loaded elsewhere, so this module reads that same file rather than keeping
 * a second copy that could drift.
 */
import * as vscode from "vscode";

export type CreationSeedVersionV1 = "v0" | "v1";

export interface CreationSeedDescriptorV1 {
  readonly seedId: string;
  readonly resourceFileName: string;
  readonly version: CreationSeedVersionV1;
}

export interface MatchedCreationSeedV1 {
  readonly seedId: string;
  readonly version: CreationSeedVersionV1;
}

/**
 * Every historical seed the extension has emitted at task-creation time,
 * oldest first. Adding a future template revision means appending one row
 * here (and, if it is a legacy/no-longer-emitted seed, a matching resource
 * file) — never rewriting or removing an existing row, since past `creating`
 * folders may still be sitting on disk with that exact content.
 *
 * Every row below is pinned to an exact `resources/prompts/task-template.md`
 * git revision by digest (full detail: test-fixtures/creation-seeds/README.md,
 * which this must stay consistent with), so a `pristine` match against any of
 * them is a verified-authentic match — this corpus intentionally holds no
 * reconstructed/representative entries: plan §4.3 requires "an exact recorded
 * historical seed" for `pristine`, and a `pristine` folder becomes Safe-Delete
 * eligible once that recovery slice lands, so an unverifiable seed must never
 * be able to produce that classification. (An earlier revision of this corpus
 * briefly carried a `legacy-pre-draft-cutover-v0` row reconstructing the
 * pre-`draft.v1` format; an exhaustive search of every commit that touched
 * `resources/prompts/task-template.md` or the `startNewTask.ts` inline
 * fallback found no real historical blob matching its content — only four
 * `task.md` seed shapes were ever actually emitted, and all four are the
 * rows below plus the current `v1-canonical` — so that row was dropped
 * rather than left unverifiable.) At every one of the four revisions
 * `task-template.md` has ever had, `startNewTask.ts`'s inline fallback string
 * was kept byte-identical to it — not a one-off coincidence for the oldest
 * row alone — so `legacy-early-inline-fallback-v0`'s name is accurate, and
 * each of the other three rows below (plus the current `v1-canonical` seed)
 * is equally an exact match to its era's inline fallback, even though only
 * this one is named for that fact.
 */
const LEGACY_SEED_DESCRIPTORS: readonly CreationSeedDescriptorV1[] = [
  {
    seedId: "legacy-instructions-user-description-v0",
    resourceFileName: "creation-seed-legacy-instructions-user-description.md",
    version: "v0",
  },
  {
    seedId: "legacy-single-body-task-v0",
    resourceFileName: "creation-seed-legacy-single-body-task.md",
    version: "v0",
  },
  {
    seedId: "legacy-early-inline-fallback-v0",
    resourceFileName: "creation-seed-legacy-early-inline-fallback.md",
    version: "v0",
  },
  {
    // The bare V1 canonical seed (# Task / ## Task Description / ## Draft
    // with AI, no gap or hint) emitted from the draft.v1 cutover until the
    // template gained the empty-description typing gap and the Draft with AI
    // hint. `creating` folders seeded from it may still sit on disk.
    seedId: "legacy-v1-bare",
    resourceFileName: "creation-seed-legacy-v1-bare.md",
    version: "v1",
  },
];

const V1_CANONICAL_SEED_ID = "v1-canonical";

let cachedSeeds: ReadonlyMap<string, string> | undefined;
let cachedExtensionUriKey: string | undefined;

async function loadSeedText(extensionUri: vscode.Uri, relativeSegments: string[]): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, ...relativeSegments));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Loads (and caches, per `extensionUri`) every historical seed's exact text,
 * keyed by `seedId`. Re-loads if called with a different `extensionUri` than
 * the cached one (matters only for tests, which use fake extension roots).
 */
async function getSeedTextsV1(extensionUri: vscode.Uri): Promise<ReadonlyMap<string, string>> {
  const key = extensionUri.toString();
  if (cachedSeeds && cachedExtensionUriKey === key) {
    return cachedSeeds;
  }

  const seeds = new Map<string, string>();
  for (const descriptor of LEGACY_SEED_DESCRIPTORS) {
    const text = await loadSeedText(extensionUri, ["resources", "prompts", descriptor.resourceFileName]);
    if (text !== undefined) {
      seeds.set(descriptor.seedId, text);
    }
  }
  const v1Text = await loadSeedText(extensionUri, ["resources", "prompts", "task-template.md"]);
  if (v1Text !== undefined) {
    seeds.set(V1_CANONICAL_SEED_ID, v1Text);
  }

  cachedSeeds = seeds;
  cachedExtensionUriKey = key;
  return seeds;
}

/**
 * Returns the matching seed descriptor when `taskMdText` is byte-exact to a
 * known historical (or current) creation seed, otherwise `undefined`. Exact
 * match only — no trimming, no normalization — a single edited character
 * must fall through to `preservable`, never `pristine`.
 */
export async function matchCreationSeedV1(
  extensionUri: vscode.Uri,
  taskMdText: string
): Promise<MatchedCreationSeedV1 | undefined> {
  const seeds = await getSeedTextsV1(extensionUri);
  for (const descriptor of LEGACY_SEED_DESCRIPTORS) {
    if (seeds.get(descriptor.seedId) === taskMdText) {
      return { seedId: descriptor.seedId, version: descriptor.version };
    }
  }
  const v1Text = seeds.get(V1_CANONICAL_SEED_ID);
  if (v1Text === taskMdText) {
    return { seedId: V1_CANONICAL_SEED_ID, version: "v1" };
  }
  return undefined;
}

/** Test-only: discard the cached seed corpus so fake extension roots don't leak between cases. */
export function resetCreationSeedHistoryCacheForTests(): void {
  cachedSeeds = undefined;
  cachedExtensionUriKey = undefined;
}
