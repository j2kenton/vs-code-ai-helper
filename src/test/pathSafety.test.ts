import * as assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeRelativePath } from "../utils/pathSafety";

// ---------------------------------------------------------------------------
// Valid paths
// ---------------------------------------------------------------------------

void test("accepts a simple relative path", () => {
  assert.equal(sanitizeRelativePath("src/foo.ts"), "src/foo.ts");
});

void test("accepts a nested relative path", () => {
  assert.equal(
    sanitizeRelativePath("src/utils/helper.ts"),
    "src/utils/helper.ts"
  );
});

void test("accepts a root-level filename", () => {
  assert.equal(sanitizeRelativePath("README.md"), "README.md");
});

void test("normalises backslashes to forward slashes", () => {
  assert.equal(
    sanitizeRelativePath("src\\windows\\path.ts"),
    "src/windows/path.ts"
  );
});

void test("strips a leading './' prefix", () => {
  assert.equal(sanitizeRelativePath("./src/foo.ts"), "src/foo.ts");
});

void test("strips repeated leading './' prefixes", () => {
  assert.equal(sanitizeRelativePath("././src/foo.ts"), "src/foo.ts");
});

void test("strips a single leading slash", () => {
  assert.equal(sanitizeRelativePath("/src/foo.ts"), "src/foo.ts");
});

void test("strips multiple leading slashes", () => {
  assert.equal(sanitizeRelativePath("///src/foo.ts"), "src/foo.ts");
});

// ---------------------------------------------------------------------------
// Workspace root
// ---------------------------------------------------------------------------

void test("bare '.' maps to workspace root ('')", () => {
  assert.equal(sanitizeRelativePath("."), "");
});

void test("only-slashes string maps to workspace root ('')", () => {
  assert.equal(sanitizeRelativePath("///"), "");
});

// ---------------------------------------------------------------------------
// Path traversal — must be rejected (undefined)
// ---------------------------------------------------------------------------

void test("rejects a leading '..' segment", () => {
  assert.equal(sanitizeRelativePath("../etc/passwd"), undefined);
});

void test("rejects '..' in the middle", () => {
  assert.equal(sanitizeRelativePath("foo/../etc/passwd"), undefined);
});

void test("rejects double '..' escape", () => {
  assert.equal(sanitizeRelativePath("../../etc/passwd"), undefined);
});

void test("rejects '.' as a mid-path segment", () => {
  assert.equal(sanitizeRelativePath("foo/./bar"), undefined);
});

void test("rejects a trailing '..' segment", () => {
  assert.equal(sanitizeRelativePath("foo/.."), undefined);
});

void test("rejects backslash-encoded traversal after normalisation", () => {
  // After backslash normalisation this becomes "foo/../bar"
  assert.equal(sanitizeRelativePath("foo\\..\\bar"), undefined);
});

// ---------------------------------------------------------------------------
// Non-string and empty inputs
// ---------------------------------------------------------------------------

void test("rejects an empty string", () => {
  assert.equal(sanitizeRelativePath(""), undefined);
});

void test("rejects null", () => {
  assert.equal(sanitizeRelativePath(null), undefined);
});

void test("rejects undefined", () => {
  assert.equal(sanitizeRelativePath(undefined), undefined);
});

void test("rejects a number", () => {
  assert.equal(sanitizeRelativePath(42), undefined);
});

void test("rejects an object", () => {
  assert.equal(sanitizeRelativePath({ path: "foo" }), undefined);
});
