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
import { CompletionLintResult, isQuarantinedCheckV1, synthesizeMechanicalBlockers } from "../utils/completionLint";
import { resolveZeroFixableEvidenceV1 } from "../commands/reviewActions";

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
          "`npm run verify:workflow-production-sources` failed (exit 1) — generated mechanically from Verified Checks" +
          " — output:\n```\nbaseline drifted\n```",
        origin: "mechanical",
      },
    ]);
  });

  // 1.0.0 gate, Part 4 / Step 14 (B4), review finding 2026-09-06: the
  // description must carry the check's own output (file/assertion/failure
  // detail), not just command+exit code, so a downstream card that only has
  // `ReviewBlocker.description` to work with can still show real evidence.
  void it("appends a bounded excerpt of the check's own output as evidence", () => {
    const result = baseResult({
      failedChecks: [
        { command: "npm run test", exitCode: 1, output: "AssertionError: expected 1 to equal 2\n  at foo.test.ts:42" },
      ],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.strictEqual(blockers.length, 1);
    assert.ok(blockers[0]!.description.includes("AssertionError: expected 1 to equal 2"));
    assert.ok(blockers[0]!.description.includes("foo.test.ts:42"));
  });

  void it("omits the output suffix entirely when the check produced no output", () => {
    const result = baseResult({
      failedChecks: [{ command: "npm run lint", exitCode: 1, output: "" }],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.strictEqual(
      blockers[0]!.description,
      "`npm run lint` failed (exit 1) — generated mechanically from Verified Checks"
    );
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

  void it("excludes a failure quarantined as a known flake (stamped, per collectCompletionLint)", () => {
    const result = baseResult({
      failedChecks: [
        {
          command: "npm run test",
          exitCode: 1,
          output: "EPERM",
          quarantine: { reason: "pre-existing Windows temp-dir cleanup race", ruleMatch: "npm run test" },
        },
      ],
      knownFlakeFailures: [
        { command: "npm run test", exitCode: 1, reason: "pre-existing Windows temp-dir cleanup race" },
      ],
    });
    assert.deepStrictEqual(synthesizeMechanicalBlockers(result), []);
  });

  void it("still emits a blocker for an unquarantined failure alongside a quarantined one", () => {
    const result = baseResult({
      failedChecks: [
        {
          command: "npm run test",
          exitCode: 1,
          output: "EPERM",
          quarantine: { reason: "pre-existing Windows temp-dir cleanup race", ruleMatch: "npm run test" },
        },
        { command: "npm run lint", exitCode: 1, output: "lint error" },
      ],
      knownFlakeFailures: [
        { command: "npm run test", exitCode: 1, reason: "pre-existing Windows temp-dir cleanup race" },
      ],
    });
    const blockers = synthesizeMechanicalBlockers(result);
    assert.strictEqual(blockers.length, 1);
    assert.strictEqual(blockers[0]?.description.startsWith("`npm run lint`"), true);
    assert.strictEqual(blockers[0]?.origin, "mechanical");
  });

  // wf10 continuation item 12: a review that reported zero blockers must
  // never end up with mechanical blockers in reviewScoreHistory — this is
  // the regression that let a 10/10 clean round record as 9/10 with three
  // phantom task-fixable blockers. Every failedChecks entry carries a
  // quarantine stamp (as collectCompletionLint always produces for a real
  // known-flake match), so no failure escapes as unquarantined.
  void it("an all-quarantined result yields zero mechanical blockers", () => {
    const stamp = { reason: "Vite optimizer collection race", ruleMatch: "npm run test" };
    const result = baseResult({
      failedChecks: [
        { command: "npm run test", exitCode: 1, output: "boom", quarantine: stamp },
        { command: "[apps/dashboard] npm run test", exitCode: 1, output: "boom", quarantine: stamp },
        { command: "[apps/server] npm run test", exitCode: 1, output: "boom", quarantine: stamp },
        { command: "[apps/web] npm run test", exitCode: 1, output: "boom", quarantine: stamp },
      ],
    });
    assert.deepStrictEqual(synthesizeMechanicalBlockers(result), []);
  });
});

void describe("isQuarantinedCheckV1", () => {
  void it("is false when no quarantine stamp and no legacy match is present", () => {
    assert.strictEqual(
      isQuarantinedCheckV1({}, { command: "npm run test", exitCode: 1 }),
      false
    );
  });

  void it("is true when a quarantine stamp is present", () => {
    assert.strictEqual(
      isQuarantinedCheckV1(
        {},
        { command: "npm run test", exitCode: 1, quarantine: { reason: "flaky", ruleMatch: "npm run test" } }
      ),
      true
    );
  });

  // A persisted lintPayload written before the per-check stamp existed only
  // carries the legacy flat `knownFlakeFailures` list — without this
  // fallback, a strict re-read of that older payload would treat its known
  // flakes as unquarantined again (wf10 continuation item 12).
  void it("falls back to matching the legacy knownFlakeFailures list by command+exitCode when no stamp is present", () => {
    const result = {
      knownFlakeFailures: [{ command: "npm run test", exitCode: 1, reason: "pre-existing cleanup race" }],
    };
    assert.strictEqual(
      isQuarantinedCheckV1(result, { command: "npm run test", exitCode: 1 }),
      true
    );
    assert.strictEqual(
      isQuarantinedCheckV1(result, { command: "npm run lint", exitCode: 1 }),
      false,
      "a different command must not match"
    );
  });
});

// Part 1, step 4: the same "clean round" veto used by both the Fast Forward
// pre-loop baseline and its in-loop review() callback (reviewActions.ts) —
// a fully-quarantined completion-lint run must leave the reviewer's own
// zero-fixable evidence untouched, since synthesizeMechanicalBlockers has
// already filtered every quarantined failure out of the mechanical-blocker
// list this function receives.
void describe("resolveZeroFixableEvidenceV1", () => {
  void it("defers to the reviewer's own evidence when the completion-lint run is fully quarantined", () => {
    const result = baseResult({
      failedChecks: [
        { command: "[apps/server] npm run test", exitCode: 1, output: "flaky" },
      ],
    });
    const mechanicalBlockers = synthesizeMechanicalBlockers({
      ...result,
      failedChecks: result.failedChecks.map((check) => ({
        ...check,
        quarantine: { reason: "known flake", ruleMatch: "npm run test" },
      })),
    });
    assert.deepStrictEqual(mechanicalBlockers, []);
    assert.strictEqual(
      resolveZeroFixableEvidenceV1(mechanicalBlockers, "Readiness: 10/10\n\nNo blockers remain."),
      true
    );
  });

  void it("vetoes zero-fixable evidence to false when an unquarantined check failure produced a mechanical blocker", () => {
    const mechanicalBlockers = synthesizeMechanicalBlockers(
      baseResult({
        failedChecks: [{ command: "npm run test", exitCode: 1, output: "real failure" }],
      })
    );
    assert.strictEqual(mechanicalBlockers.length, 1);
    assert.strictEqual(
      resolveZeroFixableEvidenceV1(mechanicalBlockers, "Readiness: 10/10\n\nNo blockers remain."),
      false,
      "a reviewer saying 'no blockers' must not override a still-failing Verified Check"
    );
  });

  void it("falls through to the reviewer's own evidence when there are no mechanical blockers at all", () => {
    assert.strictEqual(resolveZeroFixableEvidenceV1([], "Readiness: 6/10\n\nBlockers:\n- ..."), false);
    assert.strictEqual(resolveZeroFixableEvidenceV1([], "Readiness: 10/10\n\nNo blockers remain."), true);
  });
});
