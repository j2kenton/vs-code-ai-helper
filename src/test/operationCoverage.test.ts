import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Guards the one invariant the ongoing-operation indicators rest on: any module
 * that kicks off a long-running AI run must also register it with
 * `taskOperations`, or the run happens with no spinner, no live Notifications
 * row and no view progress bar.
 *
 * This test reads the TypeScript SOURCES, not the compiled output. It runs from
 * `out/test/`, so the repo root is two levels up — resolving relative to
 * `__dirname` alone would point at `out/`, which holds only `.js` files, and the
 * guard would silently scan nothing and always pass.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/** Modules that define the run helpers themselves, rather than invoking them. */
const EXEMPT = new Set([
  "taskOperations.ts",
  "runnerRegistry.ts",
  // The two-phase sealed edit driver (§7.8) always executes UNDER its
  // callers' tracked operations (executeImplementationRun in
  // reviewActions.ts and runLintingFixes.ts both wrap it) — it starts no
  // run of its own.
  "runEditActionV1.ts",
  // Doc comments name runImplementationForModel/resolveRunnerForModel as the
  // boundary it guards (plan §1.3) without invoking either — it is called
  // FROM inside those functions, not the other way around.
  "legacyAiActionSafetyGateV0.ts",
]);

const STARTS_A_RUN = /runAiToFile|runImplementationForModel/;
const REGISTERS_OPERATION = /taskOperations/;

function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests exercise the helpers without owning an operation.
      if (entry.name === "test") continue;
      collectSourceFiles(filePath, fileList);
    } else if (entry.name.endsWith(".ts")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

void describe("operationCoverage regression guard", () => {
  void it("scans the real TypeScript sources", () => {
    // Without this, a bad path silently reduces the guard below to a no-op.
    assert.ok(fs.existsSync(SRC_DIR), `Expected source directory at ${SRC_DIR}`);
    assert.ok(
      collectSourceFiles(SRC_DIR).length > 20,
      "Expected to discover the extension's source files; the scan root is wrong."
    );
  });

  void it("detects a module that starts a run without registering an operation", () => {
    // Self-test: proves the matcher below can actually fail.
    const offending = "import { runAiToFile } from './x';\nawait runAiToFile();\n";
    assert.ok(STARTS_A_RUN.test(offending) && !REGISTERS_OPERATION.test(offending));
  });

  void it("requires every module that starts a run to register a task operation", () => {
    const violations = collectSourceFiles(SRC_DIR)
      .filter(file => !EXEMPT.has(path.basename(file)))
      .filter(file => {
        const content = fs.readFileSync(file, "utf8");
        return STARTS_A_RUN.test(content) && !REGISTERS_OPERATION.test(content);
      })
      .map(file => path.relative(REPO_ROOT, file));

    assert.deepStrictEqual(
      violations,
      [],
      `These modules start a long-running AI run but never register it with taskOperations, ` +
        `so it would run with no spinner and no live Notifications row: ${violations.join(", ")}`
    );
  });
});
