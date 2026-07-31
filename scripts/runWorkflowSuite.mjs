/**
 * Shared runner for every named §11 runtime suite (scripts/workflowSuites.mjs).
 *
 *   node scripts/runWorkflowSuite.mjs <suite> [--skip-build]
 *   node scripts/runWorkflowSuite.mjs --self-test
 *
 * Behavior (§11.2 "required suites fail if they discover zero tests"):
 *  - unknown suite name → fail;
 *  - a named compiled test file missing from out/test → fail (a renamed or
 *    deleted test must break its suite, never silently shrink it);
 *  - the run executing zero tests (TAP totals pass+fail === 0) → fail;
 *  - otherwise the node:test exit code decides.
 *
 * Unless --skip-build is given, the test tsconfig is compiled first, so a
 * standalone invocation is self-sufficient (the same inline step every
 * hand-rolled test:workflow:* script performed before this runner).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { SUITES } from "./workflowSuites.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT_TEST = path.join(repoRoot, "out", "test");

class SuiteError extends Error {}

function buildTests() {
  const result = spawnSync(
    process.execPath,
    ["./node_modules/typescript/bin/tsc", "--project", "tsconfig.test.json"],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new SuiteError("tsc --project tsconfig.test.json failed");
  }
}

function resolveSuiteFiles(suiteName, suites = SUITES) {
  const suite = suites[suiteName];
  if (!suite) {
    throw new SuiteError(
      `unknown suite "${suiteName}" — known suites: ${Object.keys(suites).sort().join(", ")}`
    );
  }
  if (suite.discover) {
    const { discoverUnitTests } = require("../test-stubs/run-unit-tests.js");
    const files = discoverUnitTests();
    if (files.length === 0) {
      throw new SuiteError("full-unit discovery found zero compiled test files under out/test");
    }
    return files;
  }
  const files = suite.files.map((name) => path.join(OUT_TEST, name));
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new SuiteError(
      `suite "${suiteName}" names compiled test file(s) that do not exist: ` +
        missing.map((file) => path.relative(repoRoot, file)).join(", ") +
        " — a renamed/deleted test must be re-pointed here, never silently dropped."
    );
  }
  return files;
}

function parseTapTotals(tap) {
  const passMatch = /^# pass (\d+)$/m.exec(tap);
  const failMatch = /^# fail (\d+)$/m.exec(tap);
  return {
    passed: passMatch ? Number.parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? Number.parseInt(failMatch[1], 10) : 0,
  };
}

function runSuite(suiteName, files) {
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      "./test-stubs/register.js",
      "--test-timeout=20000",
      "--test-reporter=tap",
      "--test",
      ...files,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  const { passed, failed } = parseTapTotals(result.stdout ?? "");
  if (passed + failed === 0) {
    throw new SuiteError(
      `suite "${suiteName}" executed zero tests (§11.2: required suites fail on empty discovery)`
    );
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`✓ workflowSuite "${suiteName}": ${passed} test(s) passed across ${files.length} file(s).`);
}

/** Prove each guard fails without touching the real suites. */
function selfTest() {
  const assert = (condition, label) => {
    if (!condition) {
      throw new SuiteError(`self-test failed: ${label}`);
    }
  };

  const unknown = spawnSync(
    process.execPath,
    [url.fileURLToPath(import.meta.url), "not-a-suite", "--skip-build"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert(unknown.status !== 0, "an unknown suite name must exit non-zero");

  let missingThrew = false;
  try {
    resolveSuiteFiles("bogus", { bogus: { files: ["definitely-not-a-real-file.test.js"] } });
  } catch (error) {
    missingThrew = error instanceof SuiteError;
  }
  assert(missingThrew, "a suite naming a nonexistent compiled file must fail resolution");

  const empty = parseTapTotals("TAP version 13\n# pass 0\n# fail 0\n");
  assert(empty.passed + empty.failed === 0, "zero-test TAP totals must parse as zero");
  const nonEmpty = parseTapTotals("TAP version 13\n# pass 12\n# fail 1\n");
  assert(nonEmpty.passed === 12 && nonEmpty.failed === 1, "TAP totals must parse pass/fail counts");

  assert(SUITES.unit?.discover === true, "the 'unit' suite must remain full-discovery");
  for (const [name, suite] of Object.entries(SUITES)) {
    assert(
      suite.discover === true || (Array.isArray(suite.files) && suite.files.length > 0),
      `suite "${name}" must list at least one file or be discovery-based`
    );
  }

  console.log("✓ workflowSuite self-test passed (unknown-suite, missing-file, and zero-test guards).");
}

const args = process.argv.slice(2);
try {
  if (args.includes("--self-test")) {
    selfTest();
  } else {
    const suiteName = args.find((arg) => !arg.startsWith("--"));
    if (!suiteName) {
      throw new SuiteError("usage: node scripts/runWorkflowSuite.mjs <suite> [--skip-build] | --self-test");
    }
    if (!args.includes("--skip-build")) {
      buildTests();
    }
    runSuite(suiteName, resolveSuiteFiles(suiteName));
  }
} catch (error) {
  if (error instanceof SuiteError) {
    console.error(`✘ [workflowSuite] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
