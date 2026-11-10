/**
 * review2 Step 10 (bugs6 item 25): a test report is "truncated" only when a file the test itself depends on was not
 * captured, never merely because the task's scope holds more than 100 files.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderSourceFilesForReportsV1, reportSourceFilesTruncatedV1 } from "../utils/testReportSourceScopeV1";

const scoped = (n: number): string[] => Array.from({ length: n }, (_, i) => `src/file${i}.ts`);

void describe("test report source scope (review2 Step 10)", () => {
  void it("a report whose own files are captured is not truncated although 150 files are scoped", () => {
    const own = ["src/test/a.test.ts", "src/a.ts", "package.json"];
    const ordered = orderSourceFilesForReportsV1([own], scoped(150));
    const captured = new Set(ordered.slice(0, 100));
    assert.equal(ordered.length, 153);
    assert.deepEqual(ordered.slice(0, 3), own, "own files come first, so the cap never cuts one");
    assert.equal(
      reportSourceFilesTruncatedV1({ ownFiles: own, scopedFileCount: ordered.length, capturedPaths: captured, cap: 100 }),
      false
    );
  });

  void it("a report with an own file that was not captured is truncated", () => {
    const own = ["src/test/a.test.ts", "src/a.ts"];
    const captured = new Set(["src/test/a.test.ts"]);
    assert.equal(
      reportSourceFilesTruncatedV1({ ownFiles: own, scopedFileCount: 10, capturedPaths: captured, cap: 100 }),
      true
    );
  });

  void it("a command whose own files are unknown keeps the conservative rule", () => {
    const base = { ownFiles: [] as string[], cap: 100 };
    assert.equal(
      reportSourceFilesTruncatedV1({ ...base, scopedFileCount: 150, capturedPaths: new Set(scoped(100)) }),
      true,
      "more than the cap: nothing says which files it exercised"
    );
    assert.equal(reportSourceFilesTruncatedV1({ ...base, scopedFileCount: 0, capturedPaths: new Set() }), true);
    assert.equal(reportSourceFilesTruncatedV1({ ...base, scopedFileCount: 5, capturedPaths: new Set(scoped(4)) }), true);
    assert.equal(reportSourceFilesTruncatedV1({ ...base, scopedFileCount: 5, capturedPaths: new Set(scoped(5)) }), false);
  });

  void it("orders own files of every report first, without duplicates, with forward slashes", () => {
    assert.deepEqual(
      orderSourceFilesForReportsV1([["a\\b.ts"], ["c.ts", "a/b.ts"]], ["d.ts", "c.ts"]),
      ["a/b.ts", "c.ts", "d.ts"]
    );
  });
});
