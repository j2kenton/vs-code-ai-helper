import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deterministicFixOutcomeV1 } from "../utils/deterministicFixOutcomeV1";

void describe("deterministic Fix Linting outcome", () => {
  void it("hands back when completion lint fails without command identities", () => {
    const outcome = deterministicFixOutcomeV1({ passed: false, fixedCount: 1, failedCommands: [] });
    assert.equal(outcome.kind, "failure");
    assert.match(outcome.handback ?? "", /Completion lint still fails, but reported no failing command identity/);
    assert.match(outcome.handback ?? "", /fix the remaining issues, then run Publish Checks/);
  });

  void it("treats failed checks without edits or command identities as a failure", () => {
    const outcome = deterministicFixOutcomeV1({ passed: false, fixedCount: 0, failedCommands: [] });
    assert.equal(outcome.kind, "failure");
    assert.match(outcome.handback ?? "", /Completion lint still fails/);
    assert.match(outcome.handback ?? "", /No automatic fixes were available/);
    assert.match(outcome.handback ?? "", /run Publish Checks/);
  });

  void it("treats passing checks as success and no edits as no-fix", () => {
    assert.deepEqual(deterministicFixOutcomeV1({ passed: true, fixedCount: 1, failedCommands: [] }), { kind: "success" });
    assert.deepEqual(deterministicFixOutcomeV1({ passed: true, fixedCount: 0, failedCommands: [] }), { kind: "no-fix" });
  });
});
