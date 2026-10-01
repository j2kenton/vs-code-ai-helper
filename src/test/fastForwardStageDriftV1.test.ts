/**
 * RC5 items 1 and 2: a Fast Forward run classifies where the task sits
 * relative to the review it works on, so a stage refusal is reported as a
 * refusal and an auto-advance hands over instead of stalling.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { classifyFastForwardStageV1 } from "../utils/fastForwardStageDriftV1";
import { extractParentOperationV1 } from "../commands/runPublishChecks";

const read = (...parts: string[]): string => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

void describe("classifyFastForwardStageV1", () => {
  void it("is atTarget when the task sits at the review's own stage", () => {
    assert.equal(classifyFastForwardStageV1("impl-low-review", "impl-low-review", "impl-low-review"), "atTarget");
    assert.equal(classifyFastForwardStageV1("impl", "impl-high-review", "impl-high-review"), "atTarget");
  });

  void it("is notEntered when the task is still at the stage the run started from, short of the review", () => {
    assert.equal(classifyFastForwardStageV1("impl", "impl-high-review", "impl"), "notEntered");
  });

  void it("is movedOn when the task left the review's stage (auto-advance into Publish)", () => {
    assert.equal(classifyFastForwardStageV1("impl-low-review", "impl-low-review", "publish"), "movedOn");
    assert.equal(classifyFastForwardStageV1("impl", "impl-high-review", "publish"), "movedOn");
  });
});

void describe("RC5 source wiring", () => {
  const reviewActions = read("src", "commands", "reviewActions.ts");
  const runPublishChecks = read("src", "commands", "runPublishChecks.ts");
  const resumeTask = read("src", "commands", "resumeTask.ts");

  void it("passes the Fast Forward root as parentOperation to runPublishChecks", () => {
    assert.match(reviewActions, /admissionHandoffTokenV1: publishChecksHandoffToken,[\s\S]{0,200}parentOperation: op,/);
  });

  void it("forwards the extracted parent from the registered runPublishChecks command", () => {
    assert.match(runPublishChecks, /runPublishChecks\(inventory, arg, extractParentOperationV1\(arg\), currentTaskStore\)/);
    assert.doesNotMatch(runPublishChecks, /runPublishChecks\(inventory, arg, undefined, currentTaskStore\)/);
  });

  void it("extracts the parent only from the explicit shape", () => {
    const parent = { id: "op-1" } as never;
    assert.equal(extractParentOperationV1({ taskFolderPath: "/t", parentOperation: parent }), parent);
    assert.equal(extractParentOperationV1({ task: {} as never }), undefined);
    assert.equal(extractParentOperationV1(undefined), undefined);
  });

  void it("returns before the stalled branch once the stage has left", () => {
    const left = reviewActions.indexOf("if (ffStageLeftForV1) {");
    const stalled = reviewActions.indexOf("outcome.stalled &&");
    assert.ok(left > 0 && stalled > left, "the stage-left hand-over must precede the stalled branch");
  });

  void it("starts an Implementation round, not Fast Forward Review, when resuming into impl", () => {
    assert.match(resumeTask, /if \(resumeFastForward && stage === "impl"\) \{[\s\S]{0,800}runImplementationWithAI/);
  });

  void it("does not read the void Implementation dispatch result as a refusal", () => {
    assert.match(resumeTask, /await vscode\.commands\.executeCommand\("vs-code-ai-helper\.runImplementationWithAI"[\s\S]{0,200}return true;/);
    assert.doesNotMatch(resumeTask, /implResult === true/);
  });

  void it("runs the Publish Checks gate before the existing-review check, and requires the checks to have passed", () => {
    const fn = reviewActions.slice(reviewActions.indexOf("export async function fastForwardReviewWithAI"));
    const gate = fn.indexOf('if (targetStage === "publish") {\n    const publishScopeFolder');
    const noReview = fn.indexOf("  if (!initialContent) {\n    // No review has been run yet at this stage");
    assert.ok(gate > 0 && noReview > gate, "the Publish gate must not sit inside the no-existing-review branch");
    assert.match(fn.slice(gate, noReview), /savedChecksPassed/);
    assert.match(fn.slice(gate, noReview), /if \(!savedChecksPassed\) \{/);
  });

  void it("checks the saved result on the valid-freshness path too, not only after running the checks", () => {
    const fn = reviewActions.slice(reviewActions.indexOf("export async function fastForwardReviewWithAI"));
    const gate = fn.indexOf('if (targetStage === "publish") {\n    const publishScopeFolder');
    const noReview = fn.indexOf("  if (!initialContent) {\n    // No review has been run yet at this stage");
    const slice = fn.slice(gate, noReview);
    const ranBranchStart = slice.indexOf('if (freshnessBeforeChecks.status !== "valid") {');
    const savedRead = slice.indexOf("const savedChecksPayload");
    const passCheck = slice.indexOf("if (!savedChecksPassed)");
    assert.ok(ranBranchStart >= 0 && savedRead > ranBranchStart, "the saved-result read follows the run branch");
    assert.ok(passCheck > savedRead, "the pass check follows the saved-result read");
    // The run branch's closing brace precedes the saved-result read, so the
    // read is reached whether or not the checks were run here.
    assert.match(slice.slice(ranBranchStart, savedRead), /return false;\n {6}\}\n {4}\}\n/);
    assert.match(slice, /Publish Checks have not passed/);
  });

  void it("reads the persisted effective verdict, so a missing script is never rebuilt into a pass", () => {
    const fn = reviewActions.slice(reviewActions.indexOf("export async function fastForwardReviewWithAI"));
    const slice = fn.slice(fn.indexOf("const savedChecksPayload"), fn.indexOf("if (!savedChecksPassed)"));
    assert.match(slice, /savedChecksPayload\.passedModuloKnownFlakes \?\? savedChecksPayload\.passed/);
    assert.doesNotMatch(slice, /quarantine|issueCount/);
  });

  void it("persists the effective verdict from both writers of the saved checks result", () => {
    assert.match(read("src", "utils", "completionLint.ts"), /passedModuloKnownFlakes: result\.passedModuloKnownFlakes,\n\s+summary: result\.summary,[\s\S]{0,120}source: "publish"/);
    assert.match(reviewActions, /passedModuloKnownFlakes: result\.passedModuloKnownFlakes,\n\s+summary: result\.summary,[\s\S]{0,120}source: "review"/);
    assert.match(read("src", "services", "taskProgressDecoderV1.ts"), /"source", "passedModuloKnownFlakes"\]/);
  });
});
