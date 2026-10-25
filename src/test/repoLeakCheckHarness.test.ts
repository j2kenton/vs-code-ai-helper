/**
 * Post-1.0 fixes, item 11: the unit-test harness names any file a test leaves
 * in the repository outside `out/`. This fixture proves the detection without
 * touching the real repository: it runs the harness's before/after walk over a
 * throwaway folder under `os.tmpdir()`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

interface RepoLeakCheckModuleV1 {
  runWithLeakCheck<T>(root: string, run: () => T): { result: T; leaked: string[]; report: string | undefined };
  exitStatusWithLeak(childStatus: number | null, report: string | undefined): number;
  snapshotRepoPaths(root: string): Set<string>;
}

const leakCheck = createRequire(__filename)("../../test-stubs/repoLeakCheck.js") as RepoLeakCheckModuleV1;

void describe("unit-test harness repository leak check", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-leak-check-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "existing.ts"), "export {};\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  void it("names a file a Windows-style relative fixture path wrote under the root", () => {
    const { leaked, report } = leakCheck.runWithLeakCheck(root, () => {
      const runs = path.join(root, "c:", "tmp", "global-assistant", "runs");
      fs.mkdirSync(runs, { recursive: true });
      fs.writeFileSync(path.join(runs, "027-global-assistant-desc.md"), "# audit\n");
      return 0;
    });

    assert.ok(leaked.includes("c:/tmp/global-assistant/runs/027-global-assistant-desc.md"));
    assert.ok(report);
    assert.match(report, /c:\/tmp\/global-assistant\/runs\/027-global-assistant-desc\.md/);
    // The folders above the leaked file are not reported separately.
    assert.doesNotMatch(report, /^ {2}- c:\/$/m);
    assert.doesNotMatch(report, /^ {2}- c:\/tmp\/$/m);
    assert.match(report, /os\.tmpdir\(\)/);
  });

  void it("names an empty leaked folder and an empty leaked file", () => {
    const { report } = leakCheck.runWithLeakCheck(root, () => {
      fs.mkdirSync(path.join(root, "C:"));
      fs.writeFileSync(path.join(root, "C:\\tasks\\task"), "");
    });

    assert.ok(report);
    assert.match(report, /^ {2}- C:\/$/m);
    assert.match(report, /^ {2}- C:\\tasks\\task$/m);
  });

  void it("detects files leaked into .ensemble, .scratch, or dist", () => {
    const { leaked, report } = leakCheck.runWithLeakCheck(root, () => {
      fs.mkdirSync(path.join(root, ".ensemble", "leak-task"), { recursive: true });
      fs.writeFileSync(path.join(root, ".ensemble", "leak-task", "leaked.json"), "{}");
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "dist", "leak.bundle.js"), "");
    });
    assert.ok(leaked.includes(".ensemble/leak-task/leaked.json"));
    assert.ok(leaked.includes("dist/leak.bundle.js"));
    assert.ok(report);
    assert.match(report, /\.ensemble\/leak-task\/leaked\.json/);
    assert.match(report, /dist\/leak\.bundle\.js/);
  });

  void it("reports nothing for a run that only writes to out/ or leaves existing files untouched", () => {
    const { leaked, report } = leakCheck.runWithLeakCheck(root, () => {
      fs.mkdirSync(path.join(root, "out", "test"), { recursive: true });
      fs.writeFileSync(path.join(root, "out", "test", "a.test.js"), "");
      fs.writeFileSync(path.join(root, "src", "existing.ts"), "export const changed = true;\n");
    });

    assert.deepEqual(leaked, []);
    assert.equal(report, undefined);
  });

  void it("does not report files that were already present before the run", () => {
    fs.mkdirSync(path.join(root, "c:"));
    fs.writeFileSync(path.join(root, "c:", "old.md"), "left by an earlier run\n");

    const { leaked } = leakCheck.runWithLeakCheck(root, () => undefined);

    assert.deepEqual(leaked, []);
  });

  void it("preserves the child suite's exit status and fails a passing run that leaked", () => {
    assert.equal(leakCheck.exitStatusWithLeak(0, undefined), 0);
    assert.equal(leakCheck.exitStatusWithLeak(1, undefined), 1);
    assert.equal(leakCheck.exitStatusWithLeak(7, "leaked"), 7);
    assert.equal(leakCheck.exitStatusWithLeak(0, "leaked"), 1);
    assert.equal(leakCheck.exitStatusWithLeak(null, undefined), 1);
  });
});
