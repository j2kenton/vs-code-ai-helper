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

  void it("reports 'starting' before dispatching a High-Level Code Review round, and 'running' right before the coordinator await", () => {
    const startingCalls = indexOfAll("reportStageStartingV1(options.operation");
    const runningCalls = indexOfAll("reportStageRunningV1(options.operation");
    assert.ok(startingCalls.length >= 1, "runReviewForFolder must report a starting activity");
    assert.ok(runningCalls.length >= 1, "runReviewForFolder must report a running activity");

    const executeActionCalls = indexOfAll("coordinator.executeAction({");
    // The review-round coordinator call (not the Apply Review one at a
    // different call site) is the nearest one after the running report.
    const startingIdx = startingCalls[0]!;
    const runningIdx = runningCalls[0]!;
    const nextExecuteAction = executeActionCalls.find((idx) => idx > runningIdx);
    assert.ok(nextExecuteAction !== undefined, "expected a coordinator.executeAction call after the running report");
    assert.ok(
      startingIdx < runningIdx && runningIdx < nextExecuteAction,
      "expected order: reportStageStartingV1 -> reportStageRunningV1 -> coordinator.executeAction"
    );

    // The starting report must be paired with resolving dispatchModelId
    // (the ceiling-preferred candidate, not just the stage's raw configured
    // model), so setModel reflects what actually gets dispatched.
    const dispatchModelIdDecl = source.indexOf("const dispatchModelId = ceilingPreferredModelId ?? modelId;");
    assert.ok(dispatchModelIdDecl >= 0 && dispatchModelIdDecl < startingIdx);
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
