import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyContentCaps,
  IMPL_REVIEW_MAX_TOTAL_CHARS,
  isMachineMaintainedArtifactPathV1,
  mapSourceToTestPath,
} from "../utils/implReviewFileSelection";
import { MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 } from "../types/chatInteractionTransactionV1";

// ---------------------------------------------------------------------------
// Basic inclusion
// ---------------------------------------------------------------------------

void test("includes a file within both caps unchanged", () => {
  const results = applyContentCaps(
    [{ relPath: "foo.ts", content: "hello" }],
    100,
    1000
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]!.relPath, "foo.ts");
  assert.equal(results[0]!.content, "hello");
  assert.equal(results[0]!.truncated, false);
});

void test("handles an empty file list", () => {
  assert.deepEqual(applyContentCaps([], 100, 1000), []);
});

// ---------------------------------------------------------------------------
// Per-file cap
// ---------------------------------------------------------------------------

void test("truncates a file exceeding the per-file cap", () => {
  const content = "a".repeat(200);
  const results = applyContentCaps(
    [{ relPath: "big.ts", content }],
    100,
    10000
  );
  assert.equal(results[0]!.content, "a".repeat(100));
  assert.equal(results[0]!.truncated, true);
});

// ---------------------------------------------------------------------------
// Total cap
// ---------------------------------------------------------------------------

void test("omits a file whole when it doesn't fully fit the remaining total cap", () => {
  const files = [
    { relPath: "a.ts", content: "a".repeat(60) },
    { relPath: "b.ts", content: "b".repeat(60) },
  ];
  const results = applyContentCaps(files, 100, 80);
  assert.equal(results[0]!.content, "a".repeat(60));
  assert.equal(results[0]!.truncated, false);
  // b.ts only has 20 chars of budget left but is 60 chars — omitted whole
  // rather than shown as a silently-cut 20-char slice.
  assert.equal(results[1]!.content, null);
  assert.equal(results[1]!.truncated, false);
});

void test("marks files after total cap as omitted (content: null)", () => {
  const files = [
    { relPath: "a.ts", content: "a".repeat(100) },
    { relPath: "b.ts", content: "b".repeat(1) },
  ];
  const results = applyContentCaps(files, 200, 100);
  // a.ts fills the budget exactly
  assert.equal(results[0]!.content, "a".repeat(100));
  assert.equal(results[0]!.truncated, false);
  // b.ts is omitted (budget exhausted)
  assert.equal(results[1]!.content, null);
  assert.equal(results[1]!.truncated, false);
});

void test("last file is omitted whole rather than partially shown when it doesn't fully fit", () => {
  const files = [
    { relPath: "a.ts", content: "a".repeat(75) },
    { relPath: "b.ts", content: "b".repeat(10) },
  ];
  // Total cap = 80; after a.ts (75 chars), remaining = 5, but b.ts is 10 chars.
  const results = applyContentCaps(files, 100, 80);
  assert.equal(results[0]!.content, "a".repeat(75));
  assert.equal(results[0]!.truncated, false);
  assert.equal(results[1]!.content, null);
  assert.equal(results[1]!.truncated, false);
});

void test("a file that exactly fits the remaining total cap is included in full", () => {
  const files = [
    { relPath: "a.ts", content: "a".repeat(75) },
    { relPath: "b.ts", content: "b".repeat(5) },
  ];
  // Total cap = 80; after a.ts (75 chars), remaining = 5, b.ts is exactly 5.
  const results = applyContentCaps(files, 100, 80);
  assert.equal(results[1]!.content, "b".repeat(5));
  assert.equal(results[1]!.truncated, false);
});

// ---------------------------------------------------------------------------
// Missing-on-disk files (content: undefined)
// ---------------------------------------------------------------------------

void test("reports missing-on-disk files with content undefined", () => {
  const results = applyContentCaps(
    [{ relPath: "gone.ts", content: undefined }],
    100,
    1000
  );
  assert.equal(results[0]!.content, undefined);
  assert.equal(results[0]!.truncated, false);
});

void test("missing files do not consume the total budget", () => {
  const files = [
    { relPath: "a.ts", content: undefined },
    { relPath: "b.ts", content: "b".repeat(50) },
  ];
  const results = applyContentCaps(files, 100, 100);
  // a.ts is missing — budget is still 100 for b.ts
  assert.equal(results[0]!.content, undefined);
  assert.equal(results[1]!.content, "b".repeat(50));
  assert.equal(results[1]!.truncated, false);
});

void test("missing files are included even after total cap is reached", () => {
  const files = [
    { relPath: "a.ts", content: "a".repeat(100) },
    { relPath: "b.ts", content: undefined },
  ];
  const results = applyContentCaps(files, 200, 100);
  // a.ts exhausts the budget; b.ts is missing so it's still reported
  assert.equal(results[0]!.content, "a".repeat(100));
  assert.equal(results[1]!.content, undefined);
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

void test("mixed: missing then normal then omitted", () => {
  const files = [
    { relPath: "missing.ts", content: undefined },
    { relPath: "normal.ts", content: "x".repeat(10) },
    { relPath: "omitted.ts", content: "y".repeat(10) },
  ];
  // Total cap of 10 means normal.ts fills it, omitted.ts is omitted
  const results = applyContentCaps(files, 100, 10);
  assert.equal(results[0]!.content, undefined);    // missing
  assert.equal(results[1]!.content, "x".repeat(10)); // included
  assert.equal(results[2]!.content, null);           // omitted
});

// ---------------------------------------------------------------------------
// mapSourceToTestPath: src/**/x.ts -> src/test/x.test.ts convention
// ---------------------------------------------------------------------------

void test("maps a top-level src file to src/test/<name>.test.ts", () => {
  assert.equal(mapSourceToTestPath("src/extension.ts"), "src/test/extension.test.ts");
});

void test("maps a nested src file by basename, ignoring its subdirectory", () => {
  assert.equal(
    mapSourceToTestPath("src/commands/chatWithStage.ts"),
    "src/test/chatWithStage.test.ts"
  );
  assert.equal(
    mapSourceToTestPath("src/utils/contextPack.ts"),
    "src/test/contextPack.test.ts"
  );
});

void test("maps a .tsx source file to src/test/<name>.test.ts", () => {
  assert.equal(mapSourceToTestPath("src/views/chatView.tsx"), "src/test/chatView.test.ts");
});

void test("normalizes backslashes before mapping", () => {
  assert.equal(
    mapSourceToTestPath("src\\commands\\chatWithStage.ts"),
    "src/test/chatWithStage.test.ts"
  );
});

void test("returns undefined for paths outside src/", () => {
  assert.equal(mapSourceToTestPath("package.json"), undefined);
  assert.equal(mapSourceToTestPath("docs/notes.ts"), undefined);
});

void test("returns undefined for paths already inside src/test/", () => {
  assert.equal(mapSourceToTestPath("src/test/contextPack.test.ts"), undefined);
});

void test("returns undefined for non-TypeScript files", () => {
  assert.equal(mapSourceToTestPath("src/media/icon.svg"), undefined);
  assert.equal(mapSourceToTestPath("src/commands/README.md"), undefined);
});

// ---------------------------------------------------------------------------
// Machine-maintained artifact classification (2026-08-06 dogfooding fix: an
// implementation run that regenerates the workflow-safety inventories writes
// them all into implReviewFiles verbatim, and embedding their 8K head-slices
// bloated the review prompt past the chat-transaction store's 262,144-byte
// canonical input snapshot cap — every review then died pre-provider as
// chatTransaction.chatTransactionRejected).
// ---------------------------------------------------------------------------

void test("classifies generated workflow inventories as machine-maintained", () => {
  assert.equal(
    isMachineMaintainedArtifactPathV1("workflow-inventories/workflow-route-baseline-v1.json"),
    true
  );
  assert.equal(
    isMachineMaintainedArtifactPathV1("workflow-inventories\\workflow-production-source-annotations-v1.json"),
    true,
    "backslash-separated tracked paths must classify identically"
  );
});

void test("classifies lockfiles and minified bundles as machine-maintained anywhere in the tree", () => {
  assert.equal(isMachineMaintainedArtifactPathV1("pnpm-lock.yaml"), true);
  assert.equal(isMachineMaintainedArtifactPathV1("nested/dir/package-lock.json"), true);
  assert.equal(isMachineMaintainedArtifactPathV1("dist/bundle.min.js"), true);
  assert.equal(isMachineMaintainedArtifactPathV1("dist/extension.js.map"), true);
});

void test("does not classify ordinary source, config, or manifest files as machine-maintained", () => {
  assert.equal(isMachineMaintainedArtifactPathV1("src/commands/reviewActions.ts"), false);
  assert.equal(isMachineMaintainedArtifactPathV1("package.json"), false);
  assert.equal(
    isMachineMaintainedArtifactPathV1("src/workflow-inventories-helper.ts"),
    false,
    "only the workflow-inventories DIRECTORY is excluded, not names containing the words"
  );
  assert.equal(isMachineMaintainedArtifactPathV1("docs/locks.md"), false);
});

void test("total embed cap stays anchored under the chat-transaction input snapshot limit", () => {
  // The binding constraint on the automated review prompt is
  // MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 (262,144 bytes), not model context:
  // template+rubric+plan+implementation+previous review+non-content pack
  // sections measured ≈ 115K on the real task that hit this, plus ~4.5%
  // JSON-escape overhead. This guard fails if someone raises the cap back
  // above what that composition can absorb — see the constant's doc comment
  // before touching either side of the inequality.
  const WORST_OBSERVED_NON_CONTENT_BYTES = 115_000;
  const ESCAPE_OVERHEAD = 1.045;
  assert.ok(
    (IMPL_REVIEW_MAX_TOTAL_CHARS + WORST_OBSERVED_NON_CONTENT_BYTES) * ESCAPE_OVERHEAD <
      MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1,
    `IMPL_REVIEW_MAX_TOTAL_CHARS=${IMPL_REVIEW_MAX_TOTAL_CHARS} no longer fits inside the ` +
      `${MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1}-byte transaction cap with the observed fixed overhead`
  );
});
