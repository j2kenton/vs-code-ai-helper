/**
 * Table-driven checklist over the settled C1 operation taxonomy: every
 * category carries the tracked/notification policy the user's answers fixed,
 * and every concrete operation kind maps into exactly one category. This is
 * a checklist over the data table, not an enforcement framework — correcting
 * a row later is a one-line change here and in the table.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPERATION_CATEGORY_POLICIES,
  OPERATION_KINDS,
  OperationCategory,
  OperationKind,
  policyForKind,
} from "../utils/operationTaxonomy";

void describe("operationTaxonomy", () => {
  void it("encodes the settled five-category policy table", () => {
    assert.deepEqual(OPERATION_CATEGORY_POLICIES["instant-mutation"], {
      tracked: true,
      notification: "terminal-always",
    });
    assert.deepEqual(OPERATION_CATEGORY_POLICIES["long-running"], {
      tracked: true,
      notification: "in-progress-then-terminal",
    });
    assert.deepEqual(OPERATION_CATEGORY_POLICIES["chat-response"], {
      tracked: true,
      notification: "terminal-on-failure-only",
    });
    assert.deepEqual(OPERATION_CATEGORY_POLICIES["informational"], {
      tracked: false,
      notification: "entry-only",
    });
    // Settings Reset to Default is an unsaved form change: no operation, no entry.
    assert.deepEqual(OPERATION_CATEGORY_POLICIES["view-only"], {
      tracked: false,
      notification: "none",
    });
  });

  void it("classifies every concrete operation kind into its settled category", () => {
    const expected: Record<OperationKind, OperationCategory> = {
      "create-task": "instant-mutation",
      "rename-task": "instant-mutation",
      "pause-task": "instant-mutation",
      "resume-task": "instant-mutation",
      "complete-task": "instant-mutation",
      "settings-save": "instant-mutation",
      "draft-task": "long-running",
      "generate-plan": "long-running",
      "review": "long-running",
      "apply-review": "long-running",
      "fast-forward": "long-running",
      "generate-implementation": "long-running",
      "run-implementation": "long-running",
      "lint-fixes": "long-running",
      "completion-checks": "long-running",
      "commit-push": "long-running",
      "complete-commit-push": "long-running",
      "release": "long-running",
      "chat-send": "chat-response",
    };

    for (const [kind, category] of Object.entries(expected) as [OperationKind, OperationCategory][]) {
      assert.equal(
        OPERATION_KINDS[kind].category,
        category,
        `kind "${kind}" must be classified as ${category}`
      );
      assert.ok(OPERATION_KINDS[kind].label.length > 0, `kind "${kind}" must carry a label`);
      assert.deepEqual(policyForKind(kind), OPERATION_CATEGORY_POLICIES[category]);
    }

    assert.deepEqual(
      Object.keys(OPERATION_KINDS).sort(),
      Object.keys(expected).sort(),
      "the kind table and this checklist must enumerate exactly the same kinds"
    );
  });

  void it("every tracked category is a category whose operations register with the registry", () => {
    for (const policy of Object.values(OPERATION_CATEGORY_POLICIES)) {
      if (!policy.tracked) {
        assert.notEqual(
          policy.notification,
          "in-progress-then-terminal",
          "untracked events can never show an in-progress row"
        );
      }
    }
  });
});
