/**
 * Coverage for `checkSet: "fast"` (1.0 plan item 1 / f3 Part 5): an
 * implementation review round runs only `lint` and `check-types`, never
 * `verify`/`test`/`build`, including for monorepo member packages, and the
 * `{{verifiedChecks}}` block says so plainly so a reviewer never reads a
 * fast pass as having exercised the test suite.
 *
 * Uses the same real-spawn-against-a-temp-dir pattern as the sibling
 * completionLint*.test.ts files (see completionLintMonorepo.test.ts) rather
 * than mocking `spawn`.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import { buildVerifiedChecksSection, collectCompletionLint, CompletionLintResult } from "../utils/completionLint";
import { safeRemoveDir } from "./testFsUtils";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-completionlint-fast-test-"));
after(() => {
  safeRemoveDir(TEST_ROOT);
});

function writeJson(filePath: string, value: unknown): void {
  nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  nodeFs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function okScript(): string {
  return 'node -e "process.exit(0)"';
}

void describe("collectCompletionLint — checkSet: \"fast\"", () => {
  void it("runs only lint and check-types, never test/build, even when all four are configured", async () => {
    const dir = nodePath.join(TEST_ROOT, "root-fast");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: okScript(), "check-types": okScript(), test: okScript(), build: okScript() },
    });

    const result = await collectCompletionLint(dir, [], { checkSet: "fast" });

    assert.deepStrictEqual(
      (result.commandsRun ?? []).slice().sort(),
      ["npm run check-types", "npm run lint"],
      "fast must run exactly lint and check-types"
    );
    assert.equal(result.checkSet, "fast");
  });

  void it("never substitutes a configured aggregate `verify` script for a fast pass", async () => {
    const dir = nodePath.join(TEST_ROOT, "root-fast-verify");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { verify: okScript(), lint: okScript(), "check-types": okScript() },
    });

    const result = await collectCompletionLint(dir, [], { checkSet: "fast" });

    assert.ok(
      !(result.commandsRun ?? []).some((c) => c.includes("run verify")),
      "a fast pass must never run the aggregate verify script, which commonly runs the full suite/build"
    );
    assert.deepStrictEqual((result.commandsRun ?? []).slice().sort(), ["npm run check-types", "npm run lint"]);
  });

  void it("ignores explicitCommands for a fast pass rather than risk running an unnamed verify/test/build command", async () => {
    const dir = nodePath.join(TEST_ROOT, "root-fast-explicit");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: okScript(), "check-types": okScript() },
    });

    const result = await collectCompletionLint(dir, [], {
      checkSet: "fast",
      explicitCommands: ['node -e "process.exit(1)"'],
    });

    assert.deepStrictEqual((result.commandsRun ?? []).slice().sort(), ["npm run check-types", "npm run lint"]);
    assert.equal(result.passed, true, "the explicit failing command must never have run under a fast pass");
  });

  void it("restricts the monorepo recursive pass to lint/check-types per member package", async () => {
    const dir = nodePath.join(TEST_ROOT, "monorepo-fast");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: ["packages/*"] });
    writeJson(nodePath.join(dir, "packages", "member", "package.json"), {
      name: "member",
      scripts: { lint: okScript(), "check-types": okScript(), test: okScript(), build: okScript() },
    });

    const result = await collectCompletionLint(dir, [], { checkSet: "fast" });

    const memberCommands = (result.monorepoChecks ?? []).map((c) => c.command);
    assert.ok(memberCommands.some((c) => c.includes("lint")));
    assert.ok(memberCommands.some((c) => c.includes("check-types")));
    assert.ok(!memberCommands.some((c) => c.includes("test")), "fast must not run a member package's test script");
    assert.ok(!memberCommands.some((c) => c.includes("build")), "fast must not run a member package's build script");
  });

  void it("defaults to the full check set when checkSet is omitted", async () => {
    const dir = nodePath.join(TEST_ROOT, "root-full-default");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: okScript(), "check-types": okScript(), test: okScript() },
    });

    const result = await collectCompletionLint(dir, []);

    assert.ok((result.commandsRun ?? []).some((c) => c.includes("run test")), "full must still run test");
    assert.equal(result.checkSet, "full");
  });
});

void describe("buildVerifiedChecksSection — fast-checks disclaimer", () => {
  function fakeResult(overrides: Partial<CompletionLintResult> = {}): CompletionLintResult {
    return {
      runAt: new Date().toISOString(),
      passed: true,
      summary: "ok",
      issueCount: 0,
      failedChecks: [],
      missingScripts: [],
      ...overrides,
    };
  }

  void it("opens with the fast-checks disclaimer when checkSet is \"fast\"", () => {
    const section = buildVerifiedChecksSection(fakeResult({ checkSet: "fast" }));
    const bodyStart = section.indexOf("## Verified Checks");
    assert.ok(bodyStart === 0);
    assert.match(
      section,
      /^## Verified Checks \(ground truth\)\n\nFast checks: lint, type-check — the test suite and build were NOT run for this review\./,
      "the fast-checks line must open the section, immediately after the heading"
    );
  });

  void it("omits the fast-checks disclaimer for a full check set", () => {
    const section = buildVerifiedChecksSection(fakeResult({ checkSet: "full" }));
    assert.ok(!section.includes("Fast checks: lint, type-check"));
  });

  void it("omits the fast-checks disclaimer when checkSet is absent (treated as full)", () => {
    const section = buildVerifiedChecksSection(fakeResult());
    assert.ok(!section.includes("Fast checks: lint, type-check"));
  });
});
