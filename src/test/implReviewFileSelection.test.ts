import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyContentCaps,
  applyContentCapsWithPagingV1,
  applyContentCapsWithRegionsV1,
  buildChangedRegionsStanzaV1,
  buildOversizedFilePagingStanzaV1,
  extractLineRangesExcerptV1,
  IMPL_REVIEW_MAX_TOTAL_CHARS,
  IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS,
  isMachineMaintainedArtifactPathV1,
  mapSourceToTestPath,
  mergeAndExpandLineRangesV1,
  parseUnifiedDiffHunkRangesV1,
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
  // Raised 115_000 -> 155_000 (2026-08-25). The old figure was measured on the
  // 2026-08-06 task that first hit this wall, and this guard then PASSED while
  // workflow 10's review was rejected twice for exceeding the same limit — the
  // assumption, not the inequality, was what went stale.
  //
  // Derived from that rejection rather than re-measured by hand: the
  // transaction exceeded the cap with IMPL_REVIEW_MAX_TOTAL_CHARS=100000 in
  // force, so
  //   non_content x ESCAPE_OVERHEAD > MAX - (100000 x ESCAPE_OVERHEAD)
  //   non_content                   > 150,855
  // 155_000 is the nearest round figure above that floor. Raise it again if a
  // rejection ever proves it low — a guard whose constant is optimistic is
  // worse than no guard, because it reports safety it has not checked.
  //
  // Raised 155_000 -> 195_000 (2026-08-26). A rejection did prove it low: this
  // guard passed while workflow 11's own impl-high review (run 027) was
  // rejected for exceeding the same limit — the third time this has happened
  // and the second time this constant was the stale part. Derived the same
  // way, from a rejection with IMPL_REVIEW_MAX_TOTAL_CHARS=60000 in force:
  //   non_content x ESCAPE_OVERHEAD > MAX - (60000 x ESCAPE_OVERHEAD)
  //   non_content                   > 190,855
  //
  // Read this as a floor that keeps rising, not as a measurement that keeps
  // being refined. Each raise has been inferred from a failure rather than
  // observed, because the assembled prompt is not retained anywhere — so the
  // true worst case has never been known, only bounded from below. That is the
  // argument for item 9 of workflow 11 replacing both sides of this inequality
  // with a pre-dispatch measurement; when it does, delete this test with the
  // constant it guards.
  const WORST_OBSERVED_NON_CONTENT_BYTES = 195_000;
  const ESCAPE_OVERHEAD = 1.045;
  assert.ok(
    (IMPL_REVIEW_MAX_TOTAL_CHARS + WORST_OBSERVED_NON_CONTENT_BYTES) * ESCAPE_OVERHEAD <
      MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1,
    `IMPL_REVIEW_MAX_TOTAL_CHARS=${IMPL_REVIEW_MAX_TOTAL_CHARS} no longer fits inside the ` +
      `${MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1}-byte transaction cap with the observed fixed overhead`
  );
});

// ---------------------------------------------------------------------------
// applyContentCapsWithPagingV1 — workflow findings round 8, item 1: replaces
// the flat 8 KB head-sample. This legacy entry point always supplies no
// changed-region baseline, so every over-threshold file gets a deterministic
// paging-window stanza rather than a misleading "changed regions" label or,
// as before this round, a raised-cap head-slice. See the
// applyContentCapsWithRegionsV1 section below for the changed-region-excerpt
// path exercised when a real git diff baseline IS available.
// ---------------------------------------------------------------------------

void test("small tier: a file within the truncated-file cap is inlined whole, untruncated", () => {
  const content = "x".repeat(500);
  const [result] = applyContentCapsWithPagingV1([{ relPath: "small.ts", content }]);
  assert.equal(result!.content, content);
  assert.equal(result!.truncated, false);
  assert.equal(result!.isOversizedStanza, false);
});

void test("medium tier with no baseline: a file just over the inline-whole cap is never head-sliced — it gets a stanza", () => {
  // Workflow findings round 8 implementation review flagged the previous
  // behavior here (a raised-cap head-slice) as still a head-sample. With no
  // changedRanges supplied (applyContentCapsWithPagingV1's legacy no-baseline
  // path), even a file only modestly over the cap must get an honest stanza,
  // never a partial slice of its real text.
  const content = "y".repeat(IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS + 5000);
  const [result] = applyContentCapsWithPagingV1([{ relPath: "medium.ts", content }]);
  assert.equal(result!.isOversizedStanza, true);
  assert.ok(result!.content, "must still get stanza content, not omission");
  assert.ok(
    !result!.content.includes("y".repeat(100)),
    "must never contain a slice of the file's real text"
  );
  assert.equal(result!.truncated, false, "a stanza is not a 'truncated' excerpt");
});

void test("oversized tier: a file over the inline-whole cap never appears as a head-sample", () => {
  const content = "z".repeat(IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS * 3);
  const [result] = applyContentCapsWithPagingV1([{ relPath: "huge.ts", content }]);
  assert.equal(result!.isOversizedStanza, true);
  assert.ok(result!.content, "an oversized file must still get stanza content, not omission");
  assert.ok(
    !result!.content.includes("z".repeat(100)),
    "the stanza must never contain a slice of the file's real text"
  );
  assert.ok(
    result!.content.length < IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS,
    "a stanza must cost far less budget than even the inline-whole cap"
  );
});

void test("oversized tier stanza names deterministic paging windows, never 'changed regions'", () => {
  // 4000 lines at ~10 chars each — comfortably over the oversized threshold.
  const content = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const stanza = buildOversizedFilePagingStanzaV1("big.ts", content);
  assert.ok(stanza.includes("lines 1-400"), "must name deterministic line-range windows");
  assert.ok(!/changed region/i.test(stanza), "must never claim these are diff-derived changed regions");
  assert.ok(stanza.includes("big.ts"));
  assert.ok(/\d[\d,]* bytes/.test(stanza), "must report the file's real byte size");
});

void test("oversized stanza covers every window up to the listed cap without gaps", () => {
  const content = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const stanza = buildOversizedFilePagingStanzaV1("mid.ts", content);
  assert.ok(stanza.includes("lines 1-400"));
  assert.ok(stanza.includes("lines 401-800"));
  assert.ok(stanza.includes("lines 1601-2000"), "the final partial window must reach the true last line");
});

void test("aggregate size: several oversized files stay well under the total budget", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    relPath: `pkg/big-${i}.ts`,
    content: "w".repeat(IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS + 50000),
  }));
  const results = applyContentCapsWithPagingV1(files);
  const totalChars = results.reduce((sum, r) => sum + (typeof r.content === "string" ? r.content.length : 0), 0);
  assert.ok(
    totalChars < IMPL_REVIEW_MAX_TOTAL_CHARS,
    "ten oversized files' stanzas together must still fit comfortably under the total pack budget"
  );
  assert.ok(
    results.every((r) => r.isOversizedStanza),
    "every file here was constructed oversized and must be stanza-represented, not omitted"
  );
});

void test("acceptance: a ~163 KB file (cliAgentRunner.ts scale) gets a bounded paging stanza covering it fully", () => {
  // Mirrors the field capture: a real 162,855-byte file the reviewer could
  // only see 5% of. ~4200 lines at ~39 chars/line ≈ 163 KB.
  const lineText = "  const someIdentifier = someExpression(argumentOne, argumentTwo);";
  const totalLines = 4200;
  const content = Array.from({ length: totalLines }, () => lineText).join("\n");
  assert.ok(Buffer.byteLength(content, "utf8") > 160_000, "fixture must be ~163 KB to mirror the field capture");

  const [result] = applyContentCapsWithPagingV1([{ relPath: "src/runners/cliAgentRunner.ts", content }]);
  assert.equal(result!.isOversizedStanza, true, "a 163 KB file must never be shown as a partial head-sample");
  const stanza = result!.content as string;
  // The last listed (or noted) window must reach the file's true final line
  // — the reviewer's paging plan must cover the whole file, not just the
  // first IMPL_REVIEW_MAX_PAGING_WINDOWS_LISTED windows' worth.
  assert.ok(
    stanza.includes(String(totalLines)) || /\+\d+ more window/.test(stanza),
    "the stanza must either name the final window or explicitly note more windows remain"
  );
  assert.ok(
    stanza.length < 2000,
    "the stanza itself must be tiny relative to the 163 KB file it stands in for"
  );
});

// ---------------------------------------------------------------------------
// parseUnifiedDiffHunkRangesV1 / mergeAndExpandLineRangesV1 /
// extractLineRangesExcerptV1 / buildChangedRegionsStanzaV1 —
// applyContentCapsWithRegionsV1's changed-region-excerpt path (implementation
// review blocker: the previous round unconditionally substituted the
// no-baseline stanza instead of implementing the mandatory changed-region
// excerpt design).
// ---------------------------------------------------------------------------

void test("parseUnifiedDiffHunkRangesV1 extracts the new-side range from each hunk header", () => {
  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "index 111..222 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -10,0 +10,3 @@",
    "+added line 1",
    "+added line 2",
    "+added line 3",
    "@@ -50,5 +52,1 @@",
    "-removed",
    "+kept",
  ].join("\n");
  const ranges = parseUnifiedDiffHunkRangesV1(diff);
  assert.deepEqual(ranges, [
    { start: 10, end: 12 },
    { start: 52, end: 52 },
  ]);
});

void test("parseUnifiedDiffHunkRangesV1 anchors a pure-deletion hunk (count 0) to a single line", () => {
  const diff = "@@ -20,3 +19,0 @@\n-a\n-b\n-c\n";
  const ranges = parseUnifiedDiffHunkRangesV1(diff);
  assert.deepEqual(ranges, [{ start: 19, end: 19 }]);
});

void test("parseUnifiedDiffHunkRangesV1 returns no ranges for diff text with no hunks", () => {
  assert.deepEqual(parseUnifiedDiffHunkRangesV1(""), []);
  assert.deepEqual(parseUnifiedDiffHunkRangesV1("no hunks here"), []);
});

void test("mergeAndExpandLineRangesV1 expands by context and merges touching ranges", () => {
  const ranges = mergeAndExpandLineRangesV1(
    [{ start: 100, end: 100 }, { start: 130, end: 132 }],
    20,
    1000
  );
  // First range expands to [80,120]; second expands to [110,152] — these
  // overlap (110 <= 120) and must merge into one contiguous range.
  assert.deepEqual(ranges, [{ start: 80, end: 152 }]);
});

void test("mergeAndExpandLineRangesV1 clamps expansion to the file's real line bounds", () => {
  const ranges = mergeAndExpandLineRangesV1([{ start: 2, end: 3 }], 20, 10);
  assert.deepEqual(ranges, [{ start: 1, end: 10 }]);
});

void test("extractLineRangesExcerptV1 pulls the real text at each range with a line-range header", () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const { excerpt, usedRanges, truncated } = extractLineRangesExcerptV1(
    content,
    [{ start: 5, end: 8 }],
    10000
  );
  assert.equal(truncated, false);
  assert.deepEqual(usedRanges, [{ start: 5, end: 8 }]);
  assert.ok(excerpt.includes("--- lines 5-8 ---"));
  assert.ok(excerpt.includes("line 5"));
  assert.ok(excerpt.includes("line 8"));
  assert.ok(!excerpt.includes("line 30"), "must not include content outside the requested range");
});

void test("extractLineRangesExcerptV1 reports truncated when a region doesn't fit the budget", () => {
  const content = "x".repeat(100);
  const { truncated, usedRanges } = extractLineRangesExcerptV1(
    content,
    [{ start: 1, end: 1 }],
    5 // smaller than even the header text
  );
  assert.equal(truncated, true);
  assert.deepEqual(usedRanges, []);
});

void test("buildChangedRegionsStanzaV1 names the real changed-region ranges and says 'changed regions'", () => {
  const content = "x".repeat(5000);
  const stanza = buildChangedRegionsStanzaV1("src/big.ts", content, [
    { start: 40, end: 60 },
    { start: 900, end: 920 },
  ]);
  assert.ok(/changed regions?/i.test(stanza), "must claim these ARE diff-derived changed regions");
  assert.ok(stanza.includes("lines 40-60"));
  assert.ok(stanza.includes("lines 900-920"));
  assert.ok(stanza.includes("src/big.ts"));
});

void test("applyContentCapsWithRegionsV1: a large file with a small changed region gets a real excerpt, not a stanza", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} unchanged filler text here`);
  lines[999] = "line 1000 THIS ONE CHANGED";
  const content = lines.join("\n");
  assert.ok(content.length > IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS, "fixture must exceed the inline-whole cap");

  const [result] = applyContentCapsWithRegionsV1([
    { relPath: "src/big.ts", content, changedRanges: [{ start: 1000, end: 1000 }] },
  ]);
  assert.equal(result!.contentKind, "changed-regions-excerpt");
  assert.equal(result!.isOversizedStanza, false);
  assert.ok(result!.content!.includes("THIS ONE CHANGED"), "the real changed line must appear in the excerpt");
  assert.ok(
    !result!.content!.includes("line 4999"),
    "content far from the changed region must not be pulled in"
  );
});

void test("applyContentCapsWithRegionsV1: changed regions that still exceed the per-file budget fall back to the ranges-bearing stanza", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} padding text to add some length here`);
  const content = lines.join("\n");
  // Scattered ranges every 100 lines: with the default 20-line context on
  // each side, each expands to a 41-line window, together covering most of
  // the file — well past a deliberately tiny per-file budget.
  const changedRanges = Array.from({ length: 40 }, (_, i) => ({
    start: i * 100 + 1,
    end: i * 100 + 1,
  }));
  const [result] = applyContentCapsWithRegionsV1(
    [{ relPath: "src/huge.ts", content, changedRanges }],
    { maxTotalChars: 4000 }
  );
  assert.equal(result!.contentKind, "changed-regions-stanza");
  assert.equal(result!.isOversizedStanza, true);
  assert.ok(/changed regions?/i.test(result!.content as string));
});

void test("applyContentCapsWithRegionsV1: a file with no changedRanges falls back to the no-baseline stanza", () => {
  const content = "q".repeat(IMPL_REVIEW_TRUNCATED_FILE_MAX_CHARS * 2);
  const [result] = applyContentCapsWithRegionsV1([{ relPath: "src/unbaselined.ts", content }]);
  assert.equal(result!.contentKind, "no-baseline-stanza");
  assert.equal(result!.isOversizedStanza, true);
  assert.ok(!/changed regions?/i.test(result!.content as string), "must never mislabel paging windows as changed regions");
});

void test("applyContentCapsWithRegionsV1: a file at or under the inline-whole cap is always inlined whole, even with changedRanges supplied", () => {
  const content = "small file content";
  const [result] = applyContentCapsWithRegionsV1([
    { relPath: "src/small.ts", content, changedRanges: [{ start: 1, end: 1 }] },
  ]);
  assert.equal(result!.contentKind, "whole");
  assert.equal(result!.content, content);
});
