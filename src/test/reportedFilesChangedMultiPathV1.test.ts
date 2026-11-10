/**
 * review2 Step 21 (moved bugs6 item 2, the 2026-11-06 linkedin-linker occurrence): every backticked path in a
 * "Files Changed" bullet counts as reported, including paths joined by "and", commas, slashes, "&" or "+".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReportedFilesChangedV1 } from "../utils/implementationArtifactResolver";

const summary = (...bullets: string[]): string =>
  ["Done.", "", "## Files Changed", "", ...bullets, "", "## Verification", "", "- `pnpm test`", ""].join("\n");

void describe("a Files Changed bullet naming several files (review2 Step 21)", () => {
  void it("reads both paths of '`a` and `b`' (the linkedin-linker report)", () => {
    const parsed = parseReportedFilesChangedV1(
      summary(
        "- `src/popup.ts` and `src/popup.store.ts` — shared search wiring",
        "- `popup.html` and `popup.store.html` — markup for both popups"
      )
    );
    assert.deepEqual(parsed?.paths, ["src/popup.ts", "src/popup.store.ts", "popup.html", "popup.store.html"]);
    assert.equal(parsed?.entryCount, 2, "two bullets, however many paths each names");
    assert.deepEqual(parsed?.rejected, []);
  });

  void it("reads commas, 'and', slashes, ampersands and plus signs between backticked paths", () => {
    const parsed = parseReportedFilesChangedV1(
      summary(
        "- `a.ts`, `b.ts`, and `c.ts` — three files",
        "- `d.ts` / `e.ts` — a pair",
        "- `f.ts` & `g.ts`: both",
        "- `h.ts` + `i.ts` — both"
      )
    );
    assert.deepEqual(parsed?.paths, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts"]);
  });

  void it("does not take a path mentioned in the description for a changed file", () => {
    const parsed = parseReportedFilesChangedV1(
      summary("- `src/a.ts` — rewrote the callers of `helper.ts` and `other.ts`", "- `src/b.ts` and `src/c.ts` — wired in `d.ts`")
    );
    assert.deepEqual(parsed?.paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  void it("a single path per bullet reads exactly as before", () => {
    const parsed = parseReportedFilesChangedV1(summary("- `src/only.ts` — one", "- src/plain.ts — no backticks"));
    assert.deepEqual(parsed?.paths, ["src/only.ts", "src/plain.ts"]);
    assert.equal(parsed?.entryCount, 2);
  });

  void it("a joined path that is not a repository-relative file is rejected by name, and the first still counts", () => {
    const parsed = parseReportedFilesChangedV1(summary("- `src/a.ts` and `../outside.ts` — mixed"));
    assert.deepEqual(parsed?.paths, ["src/a.ts"]);
    assert.equal(parsed?.rejected.length, 1);
    assert.equal(parsed?.rejected[0]?.entry, "../outside.ts");
  });
});
