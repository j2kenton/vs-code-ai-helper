/**
 * Notifications in-flight visibility (Part II): Implementation and
 * High-Level Code Review must report a "starting" activity (with the
 * resolved model, via `reportStageStartingV1`) before dispatch preparation,
 * and a "running" activity (via `reportStageRunningV1`) immediately before
 * the long-running provider await, so a live Notifications row can show
 * stage/model/elapsed instead of going silent for the run's duration.
 *
 * These assertions inspect source ordering rather than driving the full
 * dispatch (which needs the coordinator, CLI runner, workspace fs, and
 * git — all mocked elsewhere in this suite at high cost) because the
 * property under test IS the ordering: that the report call is reachable
 * before, not after, the await it is meant to describe.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "src", "commands", "reviewActions.ts"),
  "utf8"
);

function indexOfAll(needle: string): number[] {
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) {break;}
    indices.push(at);
    from = at + needle.length;
  }
  return indices;
}

void describe("reviewActions.ts stage-activity instrumentation", () => {
  void it("defines reportStageStartingV1 and reportStageRunningV1 as thin reportActivity wrappers", () => {
    assert.match(
      source,
      /function reportStageStartingV1\(op: TaskOperationHandle \| undefined, modelId: string \| undefined\): void \{\s*op\?\.setModel\?\.\(modelId\);\s*op\?\.reportActivity\("starting", \{ resetElapsedOrigin: true \}\);/,
      "reportStageStartingV1 must set the model and reset the elapsed origin on every stage start"
    );
    assert.match(
      source,
      /function reportStageRunningV1\(op: TaskOperationHandle \| undefined\): void \{\s*op\?\.reportActivity\("running"\);/,
      "reportStageRunningV1 must report a bare 'running' activity, preserving the origin reportStageStartingV1 set"
    );
  });

  void it("reports 'starting' at the top of runReviewForFolder (before its first await), resolves the model once known, and reports 'running' right before the coordinator await", () => {
    const fnStart = source.indexOf("export async function runReviewForFolder(");
    assert.ok(fnStart >= 0, "runReviewForFolder must exist");
    const fnBodyStart = source.indexOf("): Promise<void> {", fnStart);
    assert.ok(fnBodyStart >= 0);

    const startingCall = source.indexOf('options.operation?.reportActivity("starting", { resetElapsedOrigin: true });', fnBodyStart);
    assert.ok(startingCall >= 0, "runReviewForFolder must report a starting activity");

    // Nothing between the function body's opening brace and the starting
    // report may await — it must run before ANY awaited setup (context
    // reads, freshness gates, prompt rendering), not once dispatchModelId
    // happens to be known ~600 lines down (the defect this guards against).
    const admissionSlice = source.slice(fnBodyStart, startingCall);
    assert.ok(
      !admissionSlice.includes("await "),
      "the starting report must be reachable before any await in runReviewForFolder"
    );

    // Once dispatchModelId is actually resolved, only the model identity is
    // new information — activity/origin were already reported above, so
    // this call must not re-report 'starting' or reset the origin again.
    const dispatchModelIdDecl = source.indexOf("const dispatchModelId = ceilingPreferredModelId ?? modelId;", startingCall);
    assert.ok(dispatchModelIdDecl >= 0 && dispatchModelIdDecl > startingCall);
    const setModelCall = source.indexOf("options.operation?.setModel?.(dispatchModelId);", dispatchModelIdDecl);
    assert.ok(setModelCall >= 0, "expected setModel to be called once dispatchModelId is resolved");

    const runningCall = source.indexOf("reportStageRunningV1(options.operation);", setModelCall);
    assert.ok(runningCall >= 0, "runReviewForFolder must report a running activity");

    const executeActionCalls = indexOfAll("coordinator.executeAction({");
    const nextExecuteAction = executeActionCalls.find((idx) => idx > runningCall);
    assert.ok(nextExecuteAction !== undefined, "expected a coordinator.executeAction call after the running report");
    assert.ok(
      startingCall < setModelCall && setModelCall < runningCall && runningCall < nextExecuteAction,
      "expected order: starting report (pre-await) -> setModel(dispatchModelId) -> reportStageRunningV1 -> coordinator.executeAction"
    );
  });

  void it("reports 'starting' at the top of the Run Implementation operation, and 'running' right before executeImplementationRun", () => {
    const runImplLabel = source.indexOf('{ label: "Run Implementation", stage: "impl"');
    assert.ok(runImplLabel >= 0, "expected the Run Implementation runTrackedOperation call");

    const startingIdx = source.indexOf("reportStageStartingV1(op, model.modelId);", runImplLabel);
    assert.ok(startingIdx >= 0, "Run Implementation must report a starting activity with the resolved model");

    const runningIdx = source.indexOf("reportStageRunningV1(op);", startingIdx);
    assert.ok(runningIdx >= 0, "Run Implementation must report a running activity before dispatch");

    const executeRunIdx = source.indexOf("await executeImplementationRun(", runningIdx);
    assert.ok(executeRunIdx >= 0, "expected executeImplementationRun to be called after the running report");
    assert.ok(
      runningIdx < executeRunIdx,
      "expected order: reportStageRunningV1 -> executeImplementationRun"
    );

    // Nothing that itself awaits a model-backed provider (checklist
    // generation, the routing dialog) should sit between the running report
    // and the actual implementation dispatch — otherwise the "running"
    // label would describe the wrong thing for a stretch of real time.
    const between = source.slice(runningIdx, executeRunIdx);
    assert.ok(
      !between.includes("runTrackedOperation("),
      "no nested tracked operation should start between the running report and the implementation dispatch"
    );
  });

  void it("reports the changed-file count only at the existing post-dispatch boundary where it is known, without resetting the elapsed origin", () => {
    const resultGuardMatch = /if \(!result\) \{\s*return false;\s*\}/.exec(source);
    assert.ok(resultGuardMatch, "expected the executeImplementationRun result-known guard");
    const resultGuard = resultGuardMatch.index;
    const countReport = source.indexOf("options.parentOperation?.reportActivity(", resultGuard);
    assert.ok(countReport >= 0, "expected a changed-file-count reportActivity call after result is known");
    assert.ok(countReport - resultGuard < 800, "the count report must sit at the result boundary, not deep in later logic");

    const guardedBlock = source.slice(resultGuard, countReport + 400);
    assert.match(
      guardedBlock,
      /if \(!result\.filesChangedUnknown && result\.filesChanged\.length > 0\)/,
      "the count report must be guarded so an unknown or zero count never overwrites the row"
    );

    const countReportCallEnd = source.indexOf(");", countReport);
    const countReportCall = source.slice(countReport, countReportCallEnd);
    assert.ok(
      !countReportCall.includes("resetElapsedOrigin"),
      "the changed-file-count report must not reset the stage's elapsed origin"
    );
  });

  void it("reports the checklist-generation sub-phase (coarse label, model, running) through the root operation, not the invisible checklist child operation", () => {
    // Review blocker 6392c9ff…-1 (narrowed): the checklist-generation
    // provider call has its own resolved model and can run for real time,
    // but only root operations render a Notifications row (StatusTreeProvider
    // reads `getRootOperations()`) and `setModel` does not bubble to the
    // root the way `reportActivity`/`report` do — so the checklist phase
    // must address `op` (the root), never `checklistOp` (its child).
    const needsChecklistIdx = source.indexOf("if (needsChecklist) {");
    assert.ok(needsChecklistIdx >= 0, "expected the needsChecklist branch");

    const coarseLabelIdx = source.indexOf('op.reportActivity("generating implementation checklist");', needsChecklistIdx);
    assert.ok(coarseLabelIdx >= 0, "expected a coarse-label activity report at the top of the checklist branch");

    const checklistOpCallbackIdx = source.indexOf("async (checklistOp) => {", coarseLabelIdx);
    assert.ok(checklistOpCallbackIdx >= 0, "expected the checklist runTrackedOperation callback");
    assert.ok(coarseLabelIdx < checklistOpCallbackIdx, "the coarse label must be reported before the checklist child operation begins");

    const setModelIdx = source.indexOf("op.setModel?.(checklistModelId);", checklistOpCallbackIdx);
    assert.ok(setModelIdx >= 0, "expected the checklist model to be reported via the root operation handle");
    const runningIdx = source.indexOf('op.reportActivity("running");', setModelIdx);
    assert.ok(runningIdx >= 0, "expected a running activity report once the checklist model is known");

    const invokeIdx = source.indexOf("await invokeGenerateImplementationActionV1({", runningIdx);
    assert.ok(invokeIdx >= 0, "expected the checklist provider dispatch");
    assert.ok(
      setModelIdx < runningIdx && runningIdx < invokeIdx,
      "expected order: setModel(checklistModelId) -> reportActivity('running') -> invokeGenerateImplementationActionV1"
    );

    // Both calls must address `op` (the root), never `checklistOp` — a
    // child operation's setModel/reportActivity would be invisible, since
    // only root operations render a row.
    const setModelLine = source.slice(setModelIdx, source.indexOf("\n", setModelIdx));
    const runningLine = source.slice(runningIdx, source.indexOf("\n", runningIdx));
    assert.ok(!setModelLine.includes("checklistOp."), "setModel must be called on op, not checklistOp");
    assert.ok(!runningLine.includes("checklistOp."), "reportActivity('running') must be called on op, not checklistOp");
  });

  void it("reports 'starting'/'running' for the plan-review Apply Review dispatch (applyReviewWithAI's runApply)", () => {
    // Step 5 audit gap: this path resolves its own "plan" stage model and
    // dispatches through coordinator.executeAction, but previously never
    // reported it — the row carried whatever a prior stage last set.
    const runApplyIdx = source.indexOf("const runApply = async (op: TaskOperationHandle): Promise<void> => {");
    assert.ok(runApplyIdx >= 0, "expected applyReviewWithAI's runApply closure");

    const modelIdDecl = source.indexOf('await resolveFreshModelForStage(resolved.folderUri, "plan");', runApplyIdx);
    assert.ok(modelIdDecl >= 0, "expected the plan-stage model resolution");

    const startingIdx = source.indexOf("reportStageStartingV1(op, modelId);", modelIdDecl);
    assert.ok(startingIdx >= 0, "expected a starting report once the plan-stage model is resolved");

    const runningIdx = source.indexOf("reportStageRunningV1(op);", startingIdx);
    assert.ok(runningIdx >= 0, "expected a running report before dispatch");

    const executeActionIdx = source.indexOf("await coordinator.executeAction({", runningIdx);
    assert.ok(executeActionIdx >= 0, "expected the coordinator dispatch after the running report");
    assert.ok(
      startingIdx < runningIdx && runningIdx < executeActionIdx,
      "expected order: reportStageStartingV1(op, modelId) -> reportStageRunningV1(op) -> coordinator.executeAction"
    );
  });

  void it("reports 'starting'/'running' for the standalone Generate Implementation command", () => {
    // Step 5 audit gap: generateImplementationWithAI resolves its own model
    // and dispatches via invokeGenerateImplementationActionV1, but previously
    // never reported it, leaving the row blank for the whole provider call.
    const fnStart = source.indexOf("export async function generateImplementationWithAI(");
    assert.ok(fnStart >= 0, "expected generateImplementationWithAI");

    const modelDecl = source.indexOf('const model = await resolveFreshModelForStage(resolved.folderUri, "impl");', fnStart);
    assert.ok(modelDecl >= 0, "expected the impl-stage model resolution");

    const startingIdx = source.indexOf("reportStageStartingV1(op, model.modelId);", modelDecl);
    assert.ok(startingIdx >= 0, "expected a starting report once the model is resolved");

    const runningIdx = source.indexOf("reportStageRunningV1(op);", startingIdx);
    assert.ok(runningIdx >= 0, "expected a running report before dispatch");

    const invokeIdx = source.indexOf("await invokeGenerateImplementationActionV1({", runningIdx);
    assert.ok(invokeIdx >= 0, "expected the checklist provider dispatch after the running report");
    assert.ok(
      startingIdx < runningIdx && runningIdx < invokeIdx,
      "expected order: reportStageStartingV1(op, model.modelId) -> reportStageRunningV1(op) -> invokeGenerateImplementationActionV1"
    );
  });

  void it("reports 'starting' at the top of applyImplementationReviewWithAI (Apply Review Edit / Fast Forward's impl-review dispatch)", () => {
    // Step 5 audit gap: this shared dispatch (reached from both
    // applyReviewEditWithAI's own root and Fast Forward's composite root)
    // never reported its stage/model, unlike the sibling plan-review path.
    const fnStart = source.indexOf("async function applyImplementationReviewWithAI(");
    assert.ok(fnStart >= 0, "expected applyImplementationReviewWithAI");

    const availabilityCheckIdx = source.indexOf(
      "await checkImplementationAvailabilityForModel(model.modelId, \"impl\");",
      fnStart
    );
    assert.ok(availabilityCheckIdx >= 0, "expected the re-check-liveness-only availability guard");

    const startingIdx = source.indexOf(
      "reportStageStartingV1(options.parentOperation, model.modelId);",
      availabilityCheckIdx
    );
    assert.ok(startingIdx >= 0, "expected a starting report addressed to options.parentOperation");

    const contextPackIdx = source.indexOf(
      "const contextPackContent = await generateContextPack(folderUri, workspaceRoot.uri);",
      startingIdx
    );
    assert.ok(contextPackIdx >= 0, "expected the context pack assembly to follow");
    assert.ok(startingIdx < contextPackIdx, "the starting report must precede prompt assembly");
  });

  void it("reports 'running' once inside executeImplementationRun, covering every caller uniformly", () => {
    // Both executeImplementationRun callers (runImplementationWithAI's direct
    // call, and applyImplementationReviewWithAI's Apply Review Edit path)
    // funnel through this one dispatch boundary — reporting "running" here
    // once means neither caller has to remember to do it individually, and a
    // future caller gets it for free.
    const fnStart = source.indexOf("async function executeImplementationRun(");
    assert.ok(fnStart >= 0, "expected executeImplementationRun");

    const tryIdx = source.indexOf("try {", fnStart);
    assert.ok(tryIdx >= 0, "expected the dispatch try block inside withProgress");

    const runningIdx = source.indexOf("reportStageRunningV1(options.parentOperation);", tryIdx);
    assert.ok(runningIdx >= 0, "expected a running report addressed to options.parentOperation");

    const dispatchIdx = source.indexOf("result = await runImplementationOrSealedV1({", runningIdx);
    assert.ok(dispatchIdx >= 0, "expected the implementation dispatch after the running report");
    assert.ok(runningIdx < dispatchIdx, "the running report must precede the dispatch");

    // Nothing between the try block's opening and the running report may
    // await — it must run before any of the branch-selection logic
    // (summary-only continuation vs. sealed/direct dispatch), not deep
    // inside one specific branch.
    const preRunningSlice = source.slice(tryIdx, runningIdx);
    assert.ok(
      !preRunningSlice.includes("await "),
      "the running report must be reachable before any await inside the dispatch try block"
    );
  });
});
