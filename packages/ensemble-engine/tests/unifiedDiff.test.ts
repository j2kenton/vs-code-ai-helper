/**
 * Unified-diff generation tests (plan Part 4c): the review artifact a
 * pending gate carries must be standard unified diff text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUnifiedDiffV1 } from "../src/unifiedDiffV1";

test("modified file: hunks carry 3 lines of context with correct headers", () => {
  const oldText = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";
  const newText =
    ["l1", "l2", "l3", "l4", "CHANGED", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";
  const diff = buildUnifiedDiffV1([{ path: "src/a.ts", oldText, newText }]);
  assert.equal(
    diff,
    [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2,7 +2,7 @@",
      " l2",
      " l3",
      " l4",
      "-l5",
      "+CHANGED",
      " l6",
      " l7",
      " l8",
      "",
    ].join("\n")
  );
});

test("added and deleted files diff from/to /dev/null", () => {
  const diff = buildUnifiedDiffV1([
    { path: "src/new.ts", oldText: null, newText: "alpha\nbeta\n" },
    { path: "src/old.ts", oldText: "gone\n", newText: null },
  ]);
  assert.equal(
    diff,
    [
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
      "",
    ].join("\n")
  );
});

test("nearby change runs merge into one hunk; distant runs split", () => {
  const oldLines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
  const newLines = [...oldLines];
  newLines[4] = "edit-early";
  newLines[24] = "edit-late";
  const diff = buildUnifiedDiffV1([
    { path: "f.txt", oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" },
  ]);
  const hunkHeaders = diff.split("\n").filter((line) => line.startsWith("@@"));
  assert.equal(hunkHeaders.length, 2, `expected two hunks, got: ${diff}`);
  assert.equal(hunkHeaders[0], "@@ -2,7 +2,7 @@");
  assert.equal(hunkHeaders[1], "@@ -22,7 +22,7 @@");
});

test("a trailing-newline-only change is a real change with the no-newline marker", () => {
  const diff = buildUnifiedDiffV1([{ path: "f.txt", oldText: "a\nb", newText: "a\nb\n" }]);
  assert.equal(
    diff,
    [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
      "",
    ].join("\n")
  );
});

test("unchanged files are omitted entirely", () => {
  const diff = buildUnifiedDiffV1([
    { path: "same.txt", oldText: "x\n", newText: "x\n" },
    { path: "changed.txt", oldText: "1\n", newText: "2\n" },
  ]);
  assert.ok(!diff.includes("same.txt"));
  assert.ok(diff.includes("changed.txt"));
});
