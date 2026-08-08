/**
 * Coverage for `synthesizeMechanicalBlockers` (reviewReadiness.ts fail-closed
 * work, step 4): a Verified Check that already failed with a non-zero exit
 * code before any reviewer saw it must file its own blocker directly,
 * instead of depending on a reviewer's prose description of that failure
 * round-tripping through `BLOCKER_LINE_RE` cleanly. See the 2026-08-07
 * incident in reviewReadiness.ts's `BLOCKER_LINE_RE` doc comment.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompletionLintResult, synthesizeMechanicalBlockers } from "../utils/completionLint";

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

void describe("synthesizeMechanicalBlockers", () => {
  void it("returns no blockers when nothing failed", () => {
    assert.deepStrictEqual(synthesizeMechanicalBlockers(baseResult()), []);
  });

  void it("emits one task-fixable/completion blocker per failed check", () => {
    const result = baseResult({
      failedChecks: [
        { command: "npm run verify:workflow-production-sources", exitCode: 1, output: "baseline drifted" },
      ],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.deepStrictEqual(blockers, [
      {
        category: "completion",
        resolver: "task-fixable",
        description:
          "`npm run verify:workflow-production-sources` failed (exit 1) — generated mechanically from Verified Checks",
      },
    ]);
  });

  void it("emits one blocker per distinct failed check, preserving order", () => {
    const result = baseResult({
      failedChecks: [
        { command: "npm run lint", exitCode: 1, output: "lint error" },
        { command: "npm run test", exitCode: 2, output: "test failure" },
      ],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.strictEqual(blockers.length, 2);
    assert.strictEqual(blockers[0]?.description.startsWith("`npm run lint`"), true);
    assert.strictEqual(blockers[1]?.description.startsWith("`npm run test`"), true);
  });

  void it("excludes a failure quarantined as a known flake", () => {
    const result = baseResult({
      failedChecks: [{ command: "npm run test", exitCode: 1, output: "EPERM" }],
      knownFlakeFailures: [
        { command: "npm run test", exitCode: 1, reason: "pre-existing Windows temp-dir cleanup race" },
      ],
    });
    assert.deepStrictEqual(synthesizeMechanicalBlockers(result), []);
  });

  void it("still emits a blocker for an unquarantined failure alongside a quarantined one", () => {
    const result = baseResult({
      failedChecks: [
        { command: "npm run test", exitCode: 1, output: "EPERM" },
        { command: "npm run lint", exitCode: 1, output: "lint error" },
      ],
      knownFlakeFailures: [
        { command: "npm run test", exitCode: 1, reason: "pre-existing Windows temp-dir cleanup race" },
      ],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.strictEqual(blockers.length, 1);
    assert.strictEqual(blockers[0]?.description.startsWith("`npm run lint`"), true);
  });
});
