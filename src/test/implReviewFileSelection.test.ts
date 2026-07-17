import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyContentCaps, mapSourceToTestPath } from "../utils/implReviewFileSelection";

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
