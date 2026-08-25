import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classifyZeroFileImplRoundV1 } from "../utils/roundOutcomeClassificationV1";

// ---------------------------------------------------------------------------
// classifyZeroFileImplRoundV1 (wf10 item 4 / Part 4)
// ---------------------------------------------------------------------------

void test("a zero-file round flagged as a warning classifies as provider-failure-empty", () => {
  assert.equal(
    classifyZeroFileImplRoundV1({ checklistAdvanced: false, warnedAsZeroFileFailure: true }),
    "provider-failure-empty"
  );
});

void test("a zero-file round NOT flagged as a warning classifies as genuine-no-op", () => {
  assert.equal(
    classifyZeroFileImplRoundV1({ checklistAdvanced: false, warnedAsZeroFileFailure: false }),
    "genuine-no-op"
  );
});

void test(
  "checklistAdvanced wins regardless of the warning flag — landing real checklist ticks is durable progress, not a provider failure",
  () => {
    assert.equal(
      classifyZeroFileImplRoundV1({ checklistAdvanced: true, warnedAsZeroFileFailure: true }),
      "edits-produced"
    );
    assert.equal(
      classifyZeroFileImplRoundV1({ checklistAdvanced: true, warnedAsZeroFileFailure: false }),
      "edits-produced"
    );
  }
);
