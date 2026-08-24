/**
 * Coverage for the two "genuine automation-surfaced decisions" the Part 11
 * notification audit (task "Actionable Hand-offs") identified as sites #20
 * (`copilotImplementationRunner.ts`'s round-limit gate) and #23
 * (`quota.ts`'s `handleQuotaFailure`): both `await` their answer and branch
 * on it, so both were migrated onto `awaitWorkflowDecisionAnswerV1` rather
 * than the fire-and-forget `postWorkflowDecisionV1` the two advisory
 * `reviewActions.ts` dialogs use.
 *
 * These read the real source text rather than executing the modules
 * directly, matching `reviewRouting.test.ts`'s technique for
 * `reviewActions.ts`'s migrated dialogs: the property under test — which
 * dispatch function is reached, and what the raw-modal fallback is gated on
 * — is a source-level fact, not runtime behavior. `awaitWorkflowDecisionAnswerV1`
 * itself has full runtime coverage in `workflowDecisionAwaitAnswerV1.test.ts`.
 */
import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";

async function readSrc(relativePath: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../..", relativePath), "utf8");
}

void describe("copilotImplementationRunner.ts's round-limit gate (Part 11 site #20)", () => {
  void it("awaits the decision through awaitWorkflowDecisionAnswerV1 when a task is available, falling back to the raw modal otherwise", async () => {
    const source = await readSrc("src/runners/copilotImplementationRunner.ts");
    const marker = 'decisionKey: "implementationRoundLimitReached"';
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in copilotImplementationRunner.ts`);
    const before = source.slice(Math.max(0, index - 800), index);
    assert.match(
      before,
      /awaitWorkflowDecisionAnswerV1/,
      "implementationRoundLimitReached must be awaited through awaitWorkflowDecisionAnswerV1"
    );
    assert.match(
      before,
      /if\s*\(taskFolderUri\s*&&\s*stage\)/,
      "the migrated path must be gated on taskFolderUri and stage both being available"
    );
    const after = source.slice(index, index + 2500);
    assert.match(
      after,
      /showWarningMessage\(/,
      "expected the raw-modal fallback to remain for callers with no taskFolderUri/stage"
    );
  });

  void it("threads taskFolderUri and stage into runImplementationWithCopilot from its production caller", async () => {
    const source = await readSrc("src/runners/runnerRegistry.ts");
    const marker = "runImplementationWithCopilot({";
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in runnerRegistry.ts`);
    const call = source.slice(index, index + 400);
    assert.match(call, /taskFolderUri:\s*options\.taskFolderUri/, "runnerRegistry.ts must thread taskFolderUri through");
    assert.match(call, /stage:\s*options\.stage/, "runnerRegistry.ts must thread stage through");
  });
});

void describe("quota.ts's handleQuotaFailure (Part 11 site #23)", () => {
  void it("awaits the decision through awaitWorkflowDecisionAnswerV1 instead of a raw showWarningMessage", async () => {
    const source = await readSrc("src/utils/quota.ts");
    const marker = 'decisionKey: "quotaExhaustedDuringRun"';
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `expected to find ${marker} in quota.ts`);
    const before = source.slice(Math.max(0, index - 400), index);
    assert.match(
      before,
      /awaitWorkflowDecisionAnswerV1/,
      "quotaExhaustedDuringRun must be awaited through awaitWorkflowDecisionAnswerV1"
    );
    // The function itself no longer branches control flow off a raw modal
    // return value — `vscode.window.showWarningMessage` should not appear
    // inside handleQuotaFailure's body at all any more.
    const functionStart = source.indexOf("export async function handleQuotaFailure");
    assert.ok(functionStart >= 0);
    const functionEnd = source.indexOf("\nexport", functionStart + 1);
    assert.ok(functionEnd > functionStart, "expected another export to bound handleQuotaFailure's body");
    const body = source.slice(functionStart, functionEnd);
    assert.doesNotMatch(
      body,
      /vscode\.window\.showWarningMessage\(/,
      "handleQuotaFailure must not call vscode.window.showWarningMessage directly any more"
    );
  });
});
