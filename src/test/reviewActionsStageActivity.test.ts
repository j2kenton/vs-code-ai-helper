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
});
