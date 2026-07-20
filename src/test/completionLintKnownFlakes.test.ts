/**
 * Coverage for the known-flaky-check allowlist and the {{verifiedChecks}}
 * evidence block injected into review prompts (reviewRouting work). The
 * motivating scenario is task 1.4's actual stall: a pre-existing Windows
 * EPERM temp-dir cleanup race in one test made "all tests pass" permanently
 * unreachable, and the reviewer had no way to tell that apart from a real
 * regression. classifyKnownFlakeFailures must quarantine exactly that kind
 * of failure — and nothing else — without ever touching the raw `passed`
 * verdict.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { buildVerifiedChecksSection, classifyKnownFlakeFailures, collectCompletionLint, CompletionLintResult } from "../utils/completionLint";
import { KnownFlakyCheck } from "../config/settings";

const EPERM_FLAKE: KnownFlakyCheck = {
  match: "npm run test",
  failureSignature: "EPERM",
  reason: "pre-existing Windows temp-dir cleanup race, not a regression",
};

function baseResult(overrides: Partial<CompletionLintResult> = {}): CompletionLintResult {
  return {
    runAt: "2026-01-01T00:00:00.000Z",
    passed: true,
    summary: "No linting issues found.",
    issueCount: 0,
    failedChecks: [],
    missingScripts: [],
    ...overrides,
  };
}

void describe("classifyKnownFlakeFailures", () => {
  void it("quarantines a failure matching both command and failure-signature substrings", () => {
    const failures = [{ command: "npm run test", code: 1, output: "Error: EPERM: operation not permitted, rmdir 'C:\\tmp\\x'" }];
    const result = classifyKnownFlakeFailures(failures, [EPERM_FLAKE]);
    assert.deepStrictEqual(result, [{ command: "npm run test", exitCode: 1, reason: EPERM_FLAKE.reason }]);
  });

  void it("does not quarantine a failure that matches the command but not the failure signature", () => {
    const failures = [{ command: "npm run test", code: 1, output: "AssertionError: expected 1 to equal 2" }];
    assert.deepStrictEqual(classifyKnownFlakeFailures(failures, [EPERM_FLAKE]), []);
  });

  void it("does not quarantine a failure that matches the signature but not the command", () => {
    const failures = [{ command: "npm run lint", code: 1, output: "EPERM somewhere unrelated" }];
    assert.deepStrictEqual(classifyKnownFlakeFailures(failures, [EPERM_FLAKE]), []);
  });

  void it("returns an empty array when no allowlist is configured", () => {
    const failures = [{ command: "npm run test", code: 1, output: "EPERM: operation not permitted" }];
    assert.deepStrictEqual(classifyKnownFlakeFailures(failures, []), []);
  });

  void it("only quarantines the matching failure among several", () => {
    const failures = [
      { command: "npm run lint", code: 1, output: "12 problems" },
      { command: "npm run test", code: 1, output: "EPERM: cleanup race" },
    ];
    const result = classifyKnownFlakeFailures(failures, [EPERM_FLAKE]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.command, "npm run test");
  });
});

// ---------------------------------------------------------------------------
// collectCompletionLint — real end-to-end coverage of passedModuloKnownFlakes.
// The classifyKnownFlakeFailures unit tests above and the
// buildVerifiedChecksSection tests below both construct CompletionLintResult
// fixtures by hand, which means neither exercises collectCompletionLint's own
// `commandFailures.length - knownFlakeFailures.length` subtraction — a
// mutation there (e.g. inverting the operands) would pass every other test
// in this file. Spawn a real failing script and a real known-flake allowlist
// match, exactly as completionLintPublishChecks.test.ts does, so the actual
// production computation is what's being asserted on.
// ---------------------------------------------------------------------------

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-known-flake-test-"));
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeWorkspace(name: string, testScript: string): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "x",
        // A missing `lint`/`test` script is reported in missingScripts and
        // makes passedModuloKnownFlakes false regardless of quarantine
        // (correctly — an unconfigured toolchain is a different gap than a
        // known flake). Configure all three conventional scripts so this
        // fixture's only real failure is the `test` script under test.
        scripts: {
          lint: 'node -e "process.exit(0)"',
          "check-types": 'node -e "process.exit(0)"',
          test: testScript,
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

function stubKnownFlakyChecks(checks: KnownFlakyCheck[]): () => void {
  const wsRecord = vscode.workspace as unknown as Record<string, unknown>;
  const original = wsRecord.getConfiguration;
  wsRecord.getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "knownFlakyChecks" ? checks : defaultValue,
    inspect: (): undefined => undefined,
  });
  return () => {
    wsRecord.getConfiguration = original;
  };
}

void describe("collectCompletionLint — passedModuloKnownFlakes (real command execution)", () => {
  void it("is true when every real failure is quarantined by the configured allowlist", async () => {
    const dir = makeWorkspace(
      "all-quarantined",
      'node -e "console.error(\'Error: EPERM: operation not permitted, rmdir\'); process.exit(1)"'
    );
    const restore = stubKnownFlakyChecks([
      { match: "npm run test", failureSignature: "EPERM", reason: "known cleanup race" },
    ]);
    try {
      const result = await collectCompletionLint(dir, []);
      assert.strictEqual(result.failedChecks.length, 1, "the test script must actually fail");
      assert.strictEqual(result.knownFlakeFailures?.length, 1, "the failure must be quarantined");
      assert.strictEqual(result.passed, false, "the raw verdict must never be adjusted for a known flake");
      assert.strictEqual(
        result.passedModuloKnownFlakes,
        true,
        "with every failure quarantined, passedModuloKnownFlakes must be true"
      );
    } finally {
      restore();
    }
  });

  void it("is false when a real failure does NOT match the allowlist", async () => {
    const dir = makeWorkspace(
      "not-quarantined",
      'node -e "console.error(\'AssertionError: expected 1 to equal 2\'); process.exit(1)"'
    );
    const restore = stubKnownFlakyChecks([
      { match: "npm run test", failureSignature: "EPERM", reason: "known cleanup race" },
    ]);
    try {
      const result = await collectCompletionLint(dir, []);
      assert.strictEqual(result.failedChecks.length, 1);
      assert.strictEqual(result.knownFlakeFailures?.length, 0, "an unmatched failure must not be quarantined");
      assert.strictEqual(result.passed, false);
      assert.strictEqual(
        result.passedModuloKnownFlakes,
        false,
        "a real, unquarantined failure must keep passedModuloKnownFlakes false"
      );
    } finally {
      restore();
    }
  });
});

void describe("buildVerifiedChecksSection", () => {
  void it("reports ground-truth passing evidence when everything passed", () => {
    const section = buildVerifiedChecksSection(baseResult({ passed: true, verifiedFolder: "C:\\proj" }));
    assert.match(section, /## Verified Checks \(ground truth\)/);
    assert.match(section, /Overall: All checks passed\./);
    assert.match(section, /Verified against: C:\\proj/);
    assert.match(section, /ground truth/i);
  });

  void it("tells the reviewer not to raise a review-confidence blocker for an unreproducible run", () => {
    const section = buildVerifiedChecksSection(baseResult());
    assert.match(section, /do not (lower the score|raise a review-confidence)/i);
  });

  void it("reports a real (non-quarantined) failure as a genuine blocker", () => {
    const result = baseResult({
      passed: false,
      passedModuloKnownFlakes: false,
      issueCount: 1,
      failedChecks: [{ command: "npm run lint", exitCode: 1, output: "12 errors" }],
      knownFlakeFailures: [],
    });
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /One or more checks failed\./);
    assert.match(section, /npm run lint.*exit 1 \(FAILED\)/);
    assert.doesNotMatch(section, /quarantined known flake/);
  });

  void it("labels a quarantined known-flake failure and excludes it from the overall verdict — the actual task 1.4 fix", () => {
    const result = baseResult({
      passed: false,
      passedModuloKnownFlakes: true,
      issueCount: 1,
      failedChecks: [{ command: "npm run test", exitCode: 1, output: "EPERM: rmdir race" }],
      knownFlakeFailures: [{ command: "npm run test", exitCode: 1, reason: EPERM_FLAKE.reason }],
    });
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /All checks passed except quarantined known flakes/);
    assert.match(section, /quarantined known flake.*pre-existing Windows temp-dir cleanup race/);
    assert.match(section, /do not treat it as an outstanding blocker/);
    // The raw failure's full command-result code block must not also render
    // for a quarantined failure — it's summarized inline instead.
    assert.doesNotMatch(section, /exit 1 \(FAILED\)/);
  });

  void it("degrades gracefully when knownFlakeFailures/passedModuloKnownFlakes are absent (older/mocked result)", () => {
    // CompletionLintResult's new fields are optional precisely so existing
    // fallback/mocked results without them still render sensibly.
    const result: CompletionLintResult = {
      runAt: "2026-01-01T00:00:00.000Z",
      passed: false,
      summary: "1 completion check(s) failed.",
      issueCount: 1,
      failedChecks: [{ command: "npm run test", exitCode: 1, output: "boom" }],
      missingScripts: [],
    };
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /One or more checks failed\./);
    assert.match(section, /npm run test.*exit 1 \(FAILED\)/);
  });

  void it("reports missing/inconclusive scripts distinctly from failures", () => {
    const result = baseResult({ passed: false, missingScripts: ["test"] });
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /Not configured \(inconclusive, not passed\): test/);
  });
});
