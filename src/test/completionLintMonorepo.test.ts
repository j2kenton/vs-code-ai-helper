/**
 * Coverage for step 21 of the workflow-resilience backlog: `runCompletionChecks`
 * (collectCompletionLint) used to resolve Verified Checks commands from the
 * ROOT package.json only, which means a monorepo's real per-package suites
 * (packages/*, apps/*) were invisible to review even when actually failing —
 * a root `verify`/`lint`/`test` command frequently never touches them at all.
 * This file covers:
 *  - monorepo detection (workspaces field, pnpm-workspace.yaml, and absence)
 *  - resolving workspace glob patterns to actual member package folders
 *  - the recursive pass itself: additive to the root commands, per-package
 *    results surfaced separately, `--if-present`-style skip of missing
 *    scripts, and explicit commands still winning with the pass suppressed.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import {
  buildVerifiedChecksSection,
  collectCompletionLint,
  discoverWorkspaceMemberFolders,
  isMonorepoWorkspace,
  parsePnpmWorkspacePackages,
} from "../utils/completionLint";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-monorepo-test-"));
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  nodeFs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

/** A package.json whose scripts always succeed (or, when `failScript` is
 * given, fail for exactly that one script name). */
function memberScripts(scriptNames: readonly string[], failScript?: string): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const name of scriptNames) {
    scripts[name] = name === failScript ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"';
  }
  return scripts;
}

// ---------------------------------------------------------------------------
// isMonorepoWorkspace / parsePnpmWorkspacePackages — detection primitives
// ---------------------------------------------------------------------------

void describe("isMonorepoWorkspace", () => {
  void it("detects a monorepo via a root package.json `workspaces` array", () => {
    const dir = nodePath.join(TEST_ROOT, "detect-workspaces-array");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: ["packages/*"] });
    assert.equal(isMonorepoWorkspace(dir), true);
  });

  void it("detects a monorepo via a root package.json `workspaces.packages` object form", () => {
    const dir = nodePath.join(TEST_ROOT, "detect-workspaces-object");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: { packages: ["packages/*"] } });
    assert.equal(isMonorepoWorkspace(dir), true);
  });

  void it("detects a monorepo via a pnpm-workspace.yaml file with no `workspaces` field at all", () => {
    const dir = nodePath.join(TEST_ROOT, "detect-pnpm-yaml");
    writeJson(nodePath.join(dir, "package.json"), { name: "root" });
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8");
    assert.equal(isMonorepoWorkspace(dir), true);
  });

  void it("does not treat a plain single-package workspace as a monorepo", () => {
    const dir = nodePath.join(TEST_ROOT, "detect-none");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", scripts: { test: "echo ok" } });
    assert.equal(isMonorepoWorkspace(dir), false);
  });

  void it("does not treat an empty `workspaces` array as a monorepo", () => {
    const dir = nodePath.join(TEST_ROOT, "detect-empty-workspaces");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: [] });
    assert.equal(isMonorepoWorkspace(dir), false);
  });
});

void describe("parsePnpmWorkspacePackages", () => {
  void it("parses a simple flat `packages:` list", () => {
    const dir = nodePath.join(TEST_ROOT, "parse-simple");
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n\nallowBuilds:\n  esbuild: true\n",
      "utf8"
    );
    assert.deepStrictEqual(parsePnpmWorkspacePackages(dir), ["apps/*", "packages/*"]);
  });

  void it("returns an empty array when the file is absent", () => {
    const dir = nodePath.join(TEST_ROOT, "parse-absent");
    nodeFs.mkdirSync(dir, { recursive: true });
    assert.deepStrictEqual(parsePnpmWorkspacePackages(dir), []);
  });
});

// ---------------------------------------------------------------------------
// discoverWorkspaceMemberFolders — glob pattern -> actual folder resolution
// ---------------------------------------------------------------------------

void describe("discoverWorkspaceMemberFolders", () => {
  void it("resolves `packages/*`/`apps/*` globs to member folders that contain their own package.json", () => {
    const dir = nodePath.join(TEST_ROOT, "discover-basic");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: ["packages/*", "apps/*"] });
    writeJson(nodePath.join(dir, "packages", "a", "package.json"), { name: "a" });
    writeJson(nodePath.join(dir, "packages", "b", "package.json"), { name: "b" });
    writeJson(nodePath.join(dir, "apps", "web", "package.json"), { name: "web" });
    // A directory matching the glob shape but with no package.json must not
    // be treated as a member package.
    nodeFs.mkdirSync(nodePath.join(dir, "packages", "not-a-package"), { recursive: true });

    const found = discoverWorkspaceMemberFolders(dir).map((p) => nodePath.relative(dir, p).replace(/\\/g, "/")).sort();
    assert.deepStrictEqual(found, ["apps/web", "packages/a", "packages/b"]);
  });

  void it("returns an empty array when the workspace has no configured member patterns", () => {
    const dir = nodePath.join(TEST_ROOT, "discover-none");
    writeJson(nodePath.join(dir, "package.json"), { name: "root" });
    assert.deepStrictEqual(discoverWorkspaceMemberFolders(dir), []);
  });

  void it("honors `!` exclude patterns", () => {
    const dir = nodePath.join(TEST_ROOT, "discover-exclude");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      workspaces: ["packages/*", "!packages/excluded"],
    });
    writeJson(nodePath.join(dir, "packages", "kept", "package.json"), { name: "kept" });
    writeJson(nodePath.join(dir, "packages", "excluded", "package.json"), { name: "excluded" });

    const found = discoverWorkspaceMemberFolders(dir).map((p) => nodePath.relative(dir, p).replace(/\\/g, "/"));
    assert.deepStrictEqual(found, ["packages/kept"]);
  });
});

// ---------------------------------------------------------------------------
// collectCompletionLint — the recursive pass end to end (real spawns, matching
// the sibling completionLint*.test.ts files' established pattern).
// ---------------------------------------------------------------------------

void describe("collectCompletionLint — monorepo recursive pass", () => {
  void it("runs conventional scripts per member package additively alongside the root commands, and surfaces each package's result separately", async () => {
    const dir = nodePath.join(TEST_ROOT, "e2e-additive");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      workspaces: ["packages/*"],
      scripts: { lint: 'node -e "process.exit(0)"' },
    });
    writeJson(nodePath.join(dir, "packages", "good", "package.json"), {
      name: "good",
      scripts: memberScripts(["lint", "test"]),
    });
    writeJson(nodePath.join(dir, "packages", "bad", "package.json"), {
      name: "bad",
      scripts: memberScripts(["lint", "test"], "test"),
    });

    const result = await collectCompletionLint(dir, []);

    assert.equal(result.monorepoDetected, true, "a workspaces-field root must be detected as a monorepo");

    // The root's own `lint` still ran (additive, not replaced).
    assert.ok(result.commandsRun?.some((c) => c === `npm run lint`), "root command must still run");

    // Each member package's result is a separate entry, not folded into one
    // aggregate pass/fail.
    const goodEntries = (result.monorepoChecks ?? []).filter((c) => c.packageDir === "packages/good");
    const badEntries = (result.monorepoChecks ?? []).filter((c) => c.packageDir === "packages/bad");
    assert.equal(goodEntries.length, 2, "packages/good ran both lint and test");
    assert.ok(goodEntries.every((c) => c.passed), "packages/good's checks passed");
    assert.equal(badEntries.length, 2, "packages/bad ran both lint and test");
    const badTest = badEntries.find((c) => c.command.includes("test"));
    assert.ok(badTest && !badTest.passed, "packages/bad's failing test must be reported as failed");
    const badLint = badEntries.find((c) => c.command.includes("lint"));
    assert.ok(badLint && badLint.passed, "packages/bad's passing lint must be reported as passed");

    // The failing member command shows up in failedChecks (the same
    // mechanism used for root failures) with an attributable, package-
    // prefixed command string.
    const failedMemberCheck = result.failedChecks.find((c) => c.command.includes("packages/bad"));
    assert.ok(failedMemberCheck, "the failing member package check must appear in failedChecks");
    assert.match(failedMemberCheck.command, /packages\/bad.*test/);

    // commandsRun states explicitly which commands (root + per-package)
    // actually executed.
    assert.ok(result.commandsRun?.some((c) => c.includes("packages/good") && c.includes("test")));
    assert.ok(result.commandsRun?.some((c) => c.includes("packages/bad") && c.includes("test")));

    // A monorepo run can never be misreported as "passed" while a member
    // package is red.
    assert.equal(result.passed, false);
  });

  void it("skips a member package's script that isn't configured (--if-present equivalent) without failing the whole pass", async () => {
    const dir = nodePath.join(TEST_ROOT, "e2e-if-present");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: ["packages/*"] });
    writeJson(nodePath.join(dir, "packages", "only-lint", "package.json"), {
      name: "only-lint",
      scripts: memberScripts(["lint"]),
    });

    const result = await collectCompletionLint(dir, []);

    const entries = (result.monorepoChecks ?? []).filter((c) => c.packageDir === "packages/only-lint");
    assert.equal(entries.length, 1, "only the configured `lint` script should have run for this package");
    assert.ok(entries[0]?.command.includes("lint"));
    assert.ok(!entries.some((c) => c.command.includes("test")), "an unconfigured `test` script must not run");
  });

  void it("does not run the recursive pass when explicit verification commands are configured, but still reports monorepoDetected", async () => {
    const dir = nodePath.join(TEST_ROOT, "e2e-explicit-wins");
    writeJson(nodePath.join(dir, "package.json"), { name: "root", workspaces: ["packages/*"] });
    writeJson(nodePath.join(dir, "packages", "member", "package.json"), {
      name: "member",
      // If the recursive pass ran despite explicit commands being configured,
      // this failing test would show up in the result — asserted against below.
      scripts: memberScripts(["test"], "test"),
    });

    const result = await collectCompletionLint(dir, [], {
      explicitCommands: ['node -e "process.exit(0)"'],
    });

    assert.equal(result.monorepoDetected, true, "detection is independent of whether the pass actually ran");
    assert.equal(
      (result.monorepoChecks ?? []).length,
      0,
      "the recursive pass must not run when explicit commands are configured"
    );
    assert.ok(
      !result.failedChecks.some((c) => c.command.includes("packages/member")),
      "the member package's failing script must never have been invoked"
    );
    assert.equal(result.passed, true, "only the explicit command's own (passing) result should count");
  });

  void it("leaves a non-monorepo workspace's result completely unaffected", async () => {
    const dir = nodePath.join(TEST_ROOT, "e2e-not-monorepo");
    writeJson(nodePath.join(dir, "package.json"), {
      name: "root",
      scripts: { lint: 'node -e "process.exit(0)"' },
    });

    const result = await collectCompletionLint(dir, []);

    assert.equal(result.monorepoDetected, false);
    assert.equal(result.monorepoChecks, undefined);
  });
});

// ---------------------------------------------------------------------------
// Rendering — the Verified Checks block states explicitly which commands ran
// and surfaces per-package results, per fixtures (no real spawns needed here).
// ---------------------------------------------------------------------------

void describe("buildVerifiedChecksSection — monorepo rendering", () => {
  void it("lists commandsRun and each monorepoChecks entry separately", () => {
    const section = buildVerifiedChecksSection({
      runAt: "2026-01-01T00:00:00.000Z",
      passed: false,
      summary: "1 completion check(s) failed.",
      issueCount: 1,
      failedChecks: [{ command: "[packages/bad] pnpm run test", exitCode: 1, output: "boom" }],
      missingScripts: [],
      commandsRun: ["pnpm run lint", "[packages/good] pnpm run test", "[packages/bad] pnpm run test"],
      monorepoDetected: true,
      monorepoChecks: [
        { packageDir: "packages/good", command: "[packages/good] pnpm run test", exitCode: 0, passed: true },
        { packageDir: "packages/bad", command: "[packages/bad] pnpm run test", exitCode: 1, passed: false },
      ],
    });

    assert.match(section, /### Commands that ran/);
    assert.match(section, /pnpm run lint/);
    assert.match(section, /### Monorepo packages checked/);
    assert.match(section, /packages\/good.*passed/);
    assert.match(section, /packages\/bad.*FAILED/);
  });

  void it("explains a monorepo with zero recursive-pass commands rather than rendering an empty section", () => {
    const section = buildVerifiedChecksSection({
      runAt: "2026-01-01T00:00:00.000Z",
      passed: true,
      summary: "No linting issues found.",
      issueCount: 0,
      failedChecks: [],
      missingScripts: [],
      monorepoDetected: true,
      monorepoChecks: [],
    });
    assert.match(section, /### Monorepo packages checked/);
    assert.match(section, /no commands this time|no member package/);
  });

  void it("renders nothing monorepo-specific for a non-monorepo result", () => {
    const section = buildVerifiedChecksSection({
      runAt: "2026-01-01T00:00:00.000Z",
      passed: true,
      summary: "No linting issues found.",
      issueCount: 0,
      failedChecks: [],
      missingScripts: [],
    });
    assert.doesNotMatch(section, /Monorepo packages checked/);
  });
});
