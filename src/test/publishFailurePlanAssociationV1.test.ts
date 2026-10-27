import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlanItemEvidenceV1 } from "../types/taskProgress";
import { associatePublishFailuresWithPlanItemsV1, formatPublishFailurePlanAssociationsV1, ownerHandOffCoverageFromTaskMdV1 } from "../utils/publishFailurePlanAssociationV1";

void describe("Publish failure to checklist association", () => {
  const evidence: PlanItemEvidenceV1[] = [
    {
      planRevision: "plan-1",
      itemKey: "step alpha",
      itemText: "Step alpha: add retry handling",
      claims: [{ source: "implementation", at: "2026-10-26T00:00:00.000Z", roundId: "impl-1" }],
      testReports: [{
        at: "2026-10-26T00:01:00.000Z",
        roundId: "impl-1",
        testIdentity: "src/test/retry.test.ts",
        command: "node out/test/retry.test.js",
        workingDirectory: "/repo",
        passed: 4,
        failed: 0,
        sourceState: "post-edit",
        sourceFiles: ["src/retry.ts"],
      }],
    },
    {
      planRevision: "plan-1",
      itemKey: "step beta",
      itemText: "Step beta: add visible recovery",
      claims: [{ source: "retroactive", at: "2026-10-26T00:00:00.000Z", roundId: "impl-0" }],
      testReports: [{
        at: "2026-10-26T00:01:00.000Z",
        roundId: "impl-0",
        testIdentity: "src/test/retry.test.ts",
        command: "node out/test/retry.test.js",
        workingDirectory: "/repo",
        passed: 4,
        failed: 0,
        sourceState: "post-edit",
        sourceFiles: ["src/retry.ts"],
      }],
    },
  ];

  void it("labels an exact failing acceptance-test identity as contradicted and excludes unchecked items", () => {
    const result = associatePublishFailuresWithPlanItemsV1({
      checkedItems: ["Step alpha: add retry handling", "unchecked item"],
      evidence: [evidence[0]!],
      failures: [{ command: "pnpm test", output: "FAIL src/test/retry.test.ts:18 expected true" }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.disposition, "contradicted");
    assert.equal(result[0]?.itemText, "Step alpha: add retry handling");
    assert.match(formatPublishFailurePlanAssociationsV1(result), /contradicted by the failure evidence/);
  });

  void it("maps real compiled Node spec and TAP failures to source acceptance-test provenance", () => {
    const outputs = [
      [
        "✖ failing tests:",
        "test at out/test/retry.test.js:18:5",
        "✖ resumes after retry",
        "  AssertionError: expected true",
        "ℹ fail 1",
      ].join("\n"),
      [
        "TAP version 13",
        "not ok 1 - resumes after retry",
        "  ---",
        "  location: 'out/test/retry.test.js:18:5'",
        "  failureType: 'testCodeFailure'",
        "  ...",
        "# fail 1",
      ].join("\n"),
      "Failing tests (1): every failing test named in the complete run output\n- out/test/retry.test.js: resumes after retry\n--- raw output (truncated; the list above was extracted from the complete output) ---",
    ];
    for (const output of outputs) {
      const result = associatePublishFailuresWithPlanItemsV1({
        checkedItems: [evidence[0]!.itemText],
        evidence: [evidence[0]!],
        failures: [{ command: "node test-stubs/run-unit-tests.js", output }],
      });
      assert.equal(result[0]?.disposition, "contradicted", output);
      assert.ok(result[0]?.paths.includes("out/test/retry.test.js"));
      assert.ok(result[0]?.paths.includes("src/test/retry.test.ts"));
    }
  });

  void it("maps absolute compiled output paths to absolute or relative source-test provenance", () => {
    const output = [
      "✖ failing tests:",
      "test at /workspace/vs-code-ai-helper/out/test/retry.test.js:18:5",
      "✖ resumes after retry",
      "  AssertionError: expected true",
      "ℹ fail 1",
    ].join("\n");
    for (const testIdentity of [
      "src/test/retry.test.ts",
      "/workspace/vs-code-ai-helper/src/test/retry.test.ts",
    ]) {
      const report = { ...evidence[0]!, testReports: evidence[0]!.testReports?.map((row) => ({ ...row, testIdentity })) };
      const result = associatePublishFailuresWithPlanItemsV1({
        checkedItems: [evidence[0]!.itemText],
        evidence: [report],
        failures: [{ command: "pnpm run verify", output }],
      });
      assert.equal(result[0]?.disposition, "contradicted", testIdentity);
      assert.ok(result[0]?.paths.includes("src/test/retry.test.ts"));
    }
  });

  void it("labels shared evidence as a candidate and ignores failures without file identities", () => {
    const result = associatePublishFailuresWithPlanItemsV1({
      checkedItems: evidence.map((item) => item.itemText),
      evidence,
      failures: [
        { command: "pnpm test", output: "FAIL src/retry.ts:18" },
        { command: "pnpm test", output: "2 tests failed" },
      ],
    });
    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.disposition === "candidate"));
    assert.deepEqual(result[0]?.paths, ["src/retry.ts"]);
    assert.equal(associatePublishFailuresWithPlanItemsV1({
      checkedItems: evidence.map((item) => item.itemText),
      evidence,
      failures: [{ command: "pnpm test", output: "2 tests failed" }],
    }).length, 0);
  });

  void it("does not turn a passing path or source-file coincidence into a contradiction", () => {
    const result = associatePublishFailuresWithPlanItemsV1({
      checkedItems: evidence.map((item) => item.itemText),
      evidence,
      failures: [{
        command: "pnpm test",
        output: "PASS src/test/retry.test.ts\nFAIL src/retry.ts AssertionError",
      }],
    });
    assert.equal(result.length, 2);
    assert.ok(result.every((item) => item.disposition === "candidate"));
    assert.ok(result.every((item) => item.paths.includes("src/retry.ts")));
    assert.ok(result.every((item) => !item.paths.includes("src/test/retry.test.ts")));
  });

  void it("uses explicit owner hand-off Covers annotations as candidate provenance", () => {
    const checkedItems = ["Step 4: Retry safely", "Step 5: Preserve recovery" ];
    const coverage = ownerHandOffCoverageFromTaskMdV1(
      "## Owner evidence\n\n- **Retry smoke.** Run `node src/test/retry-owner.test.ts`. Covers: Step 4.\n\n- **Other smoke.** Covers: Step 5.\n",
      checkedItems
    );
    const result = associatePublishFailuresWithPlanItemsV1({
      checkedItems,
      evidence: [],
      ownerHandOffCoverage: coverage,
      failures: [{ command: "pnpm test", output: "FAIL src/test/retry-owner.test.ts:9 expected true" }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.itemText, "Step 4: Retry safely");
    assert.equal(result[0]?.disposition, "candidate", "the hand-off links the scope, but does not replace reviewer judgment");
  });
});
