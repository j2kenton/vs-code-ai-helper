/**
 * Inventory/conformance coverage for `WorkflowDecisionV1.gating` (task
 * "Actionable Hand-offs: one contract, nine surfaces", PART 5).
 *
 * `gating` is optional on `CreateWorkflowDecisionInputV1` at the TYPE level
 * (see `workflowDecisionV1.ts`'s doc comment) only so tests can exercise
 * `createWorkflowDecisionV1`'s other shape-validation rules independent of
 * gating — every production creation site supplies it.
 * `reviewActions.ts`'s `providerChainExhausted` decision was the sole
 * tracked exception while "workflow 8" (a concurrent task owning that file)
 * was open; that task's branch (`workflow-8-findings`) is now merged to
 * `main`, so this file's earlier "deferred" case was closed by populating
 * `gating` at that call site.
 *
 * The actual runtime enforcement — the guard that stops a BRAND-NEW call
 * site from silently omitting `gating` — is `assertGatingRequirementV1`
 * (`src/utils/workflowDecisionDispatchV1.ts`), invoked by the single
 * dispatch chokepoint `postWorkflowDecisionV1` before any decision is
 * persisted; see `workflowDecisionDispatchGatingV1.test.ts` for its unit
 * coverage. This file is a complementary, human-legible inventory: it greps
 * the real source of every known production `postWorkflowDecisionV1` call
 * site and asserts each one supplies `gating` in source.
 *
 * `createWorkflowDecisionV1` (`workflowDecisionV1.test.ts`) covers the
 * runtime shape validation once `gating` IS supplied; this file covers WHICH
 * call sites currently supply it at all, which is the "test over all
 * creation sites" PART 5 asks for.
 */
import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as path from "node:path";

// Reads real TypeScript SOURCE (not compiled output) — this test enforces a
// property of the source text itself, and must keep working when run from
// the compiled `out/test/` directory the way `handoffGuidancePromptContract
// .test.ts` reads `resources/prompts` from there: two levels up from
// `out/test/` is the repo root, then into `src/`.
async function readSrc(relativePath: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../../src", relativePath), "utf8");
}

/**
 * Returns the source slice from `decisionKey: "<key>"` through the next
 * top-level `postWorkflowDecisionV1(...)` call's closing — approximated as
 * the next 4000 characters, generous enough to cover every known decision
 * object literal in this repo (the largest, `reconcilePlanChecklist`'s, is
 * under 2500) without accidentally spilling into an unrelated later call.
 */
function sliceAroundDecisionKey(source: string, decisionKey: string): string {
  const marker = `decisionKey: "${decisionKey}"`;
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `expected to find ${marker} in source`);
  return source.slice(index, index + 4000);
}

void describe("WorkflowDecisionV1 creation-site inventory — gating field", () => {
  void it("applyReviewerVerifiedTicks.ts supplies gating for its decision", async () => {
    const source = await readSrc("commands/applyReviewerVerifiedTicks.ts");
    const slice = sliceAroundDecisionKey(source, "applyReviewerVerifiedTicks");
    assert.match(slice, /gating:\s*\{/, "the applyReviewerVerifiedTicks decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*false/);
    assert.match(slice, /unblocksProgress:\s*false/);
  });

  void it("implementationRecoveryV1.ts supplies gating for its decision", async () => {
    const source = await readSrc("commands/implementationRecoveryV1.ts");
    const slice = sliceAroundDecisionKey(source, "restoreRejectedImplementationRound");
    assert.match(slice, /gating:\s*\{/, "the restoreRejectedImplementationRound decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*false/);
  });

  void it("reconcilePlanChecklist.ts supplies gating for its decision", async () => {
    const source = await readSrc("commands/reconcilePlanChecklist.ts");
    const slice = sliceAroundDecisionKey(source, "reconcilePlanChecklist");
    assert.match(slice, /gating:\s*\{/, "the reconcilePlanChecklist decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*false/);
    assert.match(slice, /unblocksProgress:\s*false/);
  });

  // Previously the tracked, deliberate exception while reviewActions.ts was a
  // workflow-8 file this task's plan deferred editing on (plan.md, "Batch C
  // ... GATE: workflow 8 closed"). That task's branch is merged to main, so
  // this call site now supplies gating like every other production creator.
  // It is genuinely gating: the task is paused by pauseTaskWithReason and
  // "retry"/"wait" directly control whether it stays paused.
  void it("reviewActions.ts's providerChainExhausted decision supplies gating", async () => {
    const source = await readSrc("commands/reviewActions.ts");
    const slice = sliceAroundDecisionKey(source, "providerChainExhausted");
    assert.match(slice, /gating:\s*\{/, "the providerChainExhausted decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*true/);
    assert.match(slice, /unblocksProgress:\s*true/);
  });

  // PART 9 (routing correctness, dialog migration): the pre-Implementation
  // and no-files-changed dialogs, both migrated off raw
  // `vscode.window.showWarningMessage` (see reviewRouting.ts's
  // `decidePostReviewActionV1` doc comment, "The worse case").
  void it("reviewActions.ts's preImplementationRouting decision supplies gating", async () => {
    const source = await readSrc("commands/reviewActions.ts");
    const slice = sliceAroundDecisionKey(source, "preImplementationRouting");
    assert.match(slice, /gating:\s*\{/, "the preImplementationRouting decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*false/);
    assert.match(slice, /unblocksProgress:\s*false/);
  });

  void it("reviewActions.ts's sterileRoundRouting decision supplies gating", async () => {
    const source = await readSrc("commands/reviewActions.ts");
    const slice = sliceAroundDecisionKey(source, "sterileRoundRouting");
    assert.match(slice, /gating:\s*\{/, "the sterileRoundRouting decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*false/);
    assert.match(slice, /unblocksProgress:\s*false/);
  });

  // Part 11 notification audit sites #20/#23: the two genuine
  // automation-surfaced decisions, migrated onto `awaitWorkflowDecisionAnswerV1`
  // (not `postWorkflowDecisionV1` — but the same creation-time gating
  // requirement applies to both dispatch functions, see
  // `assertGatingRequirementV1`).
  void it("copilotImplementationRunner.ts's implementationRoundLimitReached decision supplies gating", async () => {
    const source = await readSrc("runners/copilotImplementationRunner.ts");
    const slice = sliceAroundDecisionKey(source, "implementationRoundLimitReached");
    assert.match(slice, /gating:\s*\{/, "the implementationRoundLimitReached decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*true/);
    assert.match(slice, /unblocksProgress:\s*true/);
  });

  void it("quota.ts's quotaExhaustedDuringRun decision supplies gating", async () => {
    const source = await readSrc("utils/quota.ts");
    const slice = sliceAroundDecisionKey(source, "quotaExhaustedDuringRun");
    assert.match(slice, /gating:\s*\{/, "the quotaExhaustedDuringRun decision must supply gating");
    assert.match(slice, /holdsTaskPaused:\s*true/);
    assert.match(slice, /unblocksProgress:\s*true/);
  });
});
