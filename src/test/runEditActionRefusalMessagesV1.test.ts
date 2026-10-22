/**
 * Post-1.0 fixes, Step 5: only a real stale preflight says the workspace
 * changed; an execution that never finished names its state.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeModelUnavailableForStageV1,
  describeStalePreflightRefusalV1,
  describeUnfinishedExecutionV1,
} from "../commands/runEditActionV1";

void describe("model availability warning wording", () => {
  void it("names the task, the stage and the configured model with its provider", () => {
    const message = describeModelUnavailableForStageV1({
      taskLabel: "V1 README",
      stage: "impl",
      modelId: "copilot:claude-sonnet-5.5",
      reason: "No Copilot language models are available. Sign in to GitHub Copilot in VS Code.",
    });
    assert.match(message, /^V1 README — /);
    assert.match(message, /Implementation: its configured model, claude-sonnet-5\.5 \(GitHub Copilot\), is unavailable/);
    assert.match(message, /No Copilot language models are available/);
  });
});

void describe("edit action refusal messages", () => {
  void it("a stale-preflight refusal reports only what the broker proves and samples target paths", () => {
    const message = describeStalePreflightRefusalV1(["a.ts", "b.ts", "c.ts", "d.ts", "a.ts"]);
    assert.match(message, /stale-preflight validation/);
    assert.doesNotMatch(message, /workspace changed|another process edited files/);
    assert.match(message, /a\.ts, b\.ts, c\.ts, and 1 more/);
  });

  void it("an unfinished execution names its state and does not claim the workspace changed", () => {
    for (const state of ["executing", "sealed"] as const) {
      const message = describeUnfinishedExecutionV1(state);
      assert.match(message, new RegExp(`state: ${state}`));
      assert.doesNotMatch(message, /workspace changed/);
    }
  });
});
