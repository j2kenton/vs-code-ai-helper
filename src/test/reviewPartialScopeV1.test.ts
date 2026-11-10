/**
 * bugs5 Step 27 (item 15): a review whose scope is known to miss changed files names the gap in its verdict, and
 * the owner's acceptance covers exactly that gap.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVIEW_PARTIAL_SCOPE_MARKER_RE,
  hashMissingFilesV1,
  isPartialScopeAcceptedV1,
  parsePartialScopeAcceptanceV1,
  partialScopeFromVariablesV1,
  partialScopeVariablesV1,
  qualifyReviewForPartialScopeV1,
} from "../utils/reviewPartialScopeV1";
import { buildPartialScopeDecisionInputV1 } from "../commands/partialScopeDecisionV1";

const SUMMARY = "Reviewed 40 of 88 changed files (25 of 88 production files)";
const MISSING = Array.from({ length: 63 }, (_, i) => `src/utils/file${i}.ts`);

void describe("partial review scope", () => {
  void it("travels through the variables and comes back for an implementation review only", () => {
    const variables = partialScopeVariablesV1(MISSING, SUMMARY);
    const scope = partialScopeFromVariablesV1(variables, "impl-high-review");
    assert.equal(scope?.missingCount, 63);
    assert.equal(scope?.summary, SUMMARY);
    assert.deepEqual(scope?.files, MISSING);
    assert.equal(partialScopeFromVariablesV1(variables, "plan-high-review"), undefined);
    assert.equal(partialScopeFromVariablesV1({}, "impl-high-review"), undefined);
  });

  void it("names the gap in the verdict once, and says whether the owner accepted it", () => {
    const scope = partialScopeFromVariablesV1(partialScopeVariablesV1(MISSING, SUMMARY), "impl-low-review");
    assert.ok(scope);
    const held = qualifyReviewForPartialScopeV1("Readiness: 8/10\n", scope, false);
    assert.match(held, /Review scope:\*\* partial\. Reviewed 40 of 88 changed files/);
    assert.match(held, /does not clear the stage/);
    assert.ok(REVIEW_PARTIAL_SCOPE_MARKER_RE.test(held));
    assert.equal(qualifyReviewForPartialScopeV1(held, scope, false), held);
    assert.match(qualifyReviewForPartialScopeV1("Readiness: 8/10\n", scope, true), /owner accepted this partial scope/);
  });

  void it("an acceptance covers only the stage and the exact set of files the owner saw", () => {
    const hash = hashMissingFilesV1(MISSING);
    const acceptance = parsePartialScopeAcceptanceV1({
      stage: "impl-high-review",
      hash,
      missingCount: 63,
      acceptedAt: "2026-11-02T10:00:00.000Z",
    });
    assert.ok(acceptance);
    assert.equal(isPartialScopeAcceptedV1(acceptance, "impl-high-review", hash), true);
    assert.equal(isPartialScopeAcceptedV1(acceptance, "impl-low-review", hash), false);
    assert.equal(isPartialScopeAcceptedV1(acceptance, "impl-high-review", hashMissingFilesV1(MISSING.slice(1))), false);
    assert.equal(isPartialScopeAcceptedV1(undefined, "impl-high-review", hash), false);
    assert.equal(parsePartialScopeAcceptanceV1({ stage: 1 }), undefined);
    assert.equal(hashMissingFilesV1(MISSING), hashMissingFilesV1([...MISSING].reverse()));
  });

  void it("the card offers add-and-review-again (recommended), accept, and not now, each naming the count", () => {
    const scope = partialScopeFromVariablesV1(partialScopeVariablesV1(MISSING, SUMMARY), "impl-high-review");
    assert.ok(scope);
    const input = buildPartialScopeDecisionInputV1({
      taskFolderPath: "/ws/.ensemble/t",
      stage: "impl-high-review",
      scope,
      score: 8,
      threshold: 8,
    });
    assert.deepEqual(
      input.options.map((o) => o.label),
      [
        "Add the 63 missing files and review again",
        "Accept the partial scope (63 files not reviewed)",
        "Not now",
      ]
    );
    assert.equal(input.recommendation?.kind === "option" ? input.recommendation.optionId : undefined, "addAndRereview");
    assert.match(input.whatHappened, /Reviewed 40 of 88 changed files/);
    assert.match(input.whatHappened, /not advanced/);
    assert.ok(input.decisionKey.includes(scope.hash));
  });
});
