/**
 * review1 Step 36 / item 1's replay: a clean 8/10 review with 0 blockers whose only open items are provisional
 * test items. Fast Forward's hook runs the checks ONCE (never a model round), records the items whose test files
 * the passing output names, and raises one card for the rest; a failing or refused run stops at once; and the
 * `runEvidenceGapChecksV1` wrapper passes Step 24's gate before running anything.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  closeEvidenceGapWithPublishChecksV1,
  runEvidenceGapChecksV1,
  type EvidenceGapChecksRunV1,
} from "../commands/evidenceGapChecksV1";
import {
  getPlanRevisionV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { recordPublishChecksPassedFilesV1, takePublishChecksPassedFilesV1 } from "../utils/publishChecksPassedFilesV1";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const STEP7 = "Step 7: Write the tests for Part 1 in `src/test/churnCeilingBugs4ReplayV1.test.ts`";
const STEP17 = "Step 17: Write the tests for Part 3 in src/test/testEvidenceReportsV1.test.ts";
const STEP22 = "Step 22: Write the tests for Part 4";

const PLAN = ["# Final Plan", "", "<!-- ensemble:implementation-checklist -->", "", `- [x] ${STEP7}`, `- [x] ${STEP17}`, `- [x] ${STEP22}`, ""].join(
  "\n"
);
const REVIEW = "Readiness: 8/10\n\n## Blockers\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";

const roots: string[] = [];

// The vscode test stub has no `workspace.fs.readFile`; back it (and writeFile) with the real filesystem for this file.
const stubFs = vscode.workspace.fs as unknown as Record<string, unknown>;
const originalFs = { readFile: stubFs["readFile"], writeFile: stubFs["writeFile"] };
stubFs["readFile"] = async (uri: vscode.Uri): Promise<Uint8Array> =>
  new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
stubFs["writeFile"] = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
  await fs.promises.writeFile(uri.fsPath, Buffer.from(data));
};

after(() => {
  stubFs["readFile"] = originalFs.readFile;
  stubFs["writeFile"] = originalFs.writeFile;
  for (const root of roots) safeRemoveDir(root);
});

function makeTask(): { folder: string; folderUri: vscode.Uri } {
  const fixture = makeOwnedTaskFolder("evidence-gap-live-");
  roots.push(path.dirname(path.dirname(fixture.folder)));
  const revision = getPlanRevisionV1(PLAN);
  const file = path.join(fixture.folder, "task-progress.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  json["currentStage"] = "impl-high-review";
  json["planItemEvidence"] = [STEP7, STEP17, STEP22].map((text) => ({
    planRevision: revision,
    itemKey: normalizeChecklistItemTextV1(text),
    itemText: text,
    claims: [{ source: "implementation", at: "2026-11-03T06:00:00.000Z", roundId: "r1" }],
  }));
  fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(path.join(fixture.folder, "plan-final.md"), PLAN, "utf8");
  fs.writeFileSync(path.join(fixture.folder, "impl-high-review.md"), REVIEW, "utf8");
  return { folder: fixture.folder, folderUri: vscode.Uri.file(fixture.folder) };
}

function hook(folder: string, run: () => Promise<EvidenceGapChecksRunV1>, score = 8) {
  const folderUri = vscode.Uri.file(folder);
  return closeEvidenceGapWithPublishChecksV1({
    folderUri,
    workspaceRootFsPath: path.dirname(folder),
    stage: "impl-high-review",
    displayName: "chat1",
    score,
    stopLevel: 8,
    runChecks: run,
  });
}

void describe("review1 item 1 replay: the evidence-only gap is closed by Ensemble, once (Step 34/36)", () => {
  void it("a passing run records the items whose test files the output names and stops with one card for the rest", async () => {
    const { folder, folderUri } = makeTask();
    let runs = 0;
    const outcome = await hook(folder, () => {
      runs += 1;
      recordPublishChecksPassedFilesV1(folder, {
        runAt: "2026-11-03T07:00:00.000Z",
        passed: true,
        testFiles: ["out/test/churnCeilingBugs4ReplayV1.test.js", "out/test/testEvidenceReportsV1.test.js"],
      });
      return Promise.resolve({ ran: true });
    });
    assert.equal(runs, 1, "the checks ran once");
    assert.equal(outcome.kind, "stopped", "Step 22 names no test file, so one item has no passing run on record");
    // A recorded report only unlocks verification (a reviewer's, or the owner's tick on the card), so every listed
    // item still waits; the card shows which of them now have a passing run.
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /2 items recorded from their output and 3 still wait/);
    const progress = await readTaskProgressForTest(folderUri);
    const recorded = (progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((row) => row.testReports?.every((report) => report.source === "publishChecks" && report.failed === 0)));
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined, "one run's files are read once");
  });

  void it("a failing run records nothing and stops at once", async () => {
    const { folder, folderUri } = makeTask();
    const outcome = await hook(folder, () => {
      recordPublishChecksPassedFilesV1(folder, { runAt: "2026-11-03T07:00:00.000Z", passed: false, testFiles: ["a.test.js"] });
      return Promise.resolve({ ran: true });
    });
    assert.equal(outcome.kind, "stopped");
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /did not pass, so 3 built items still wait/);
    const progress = await readTaskProgressForTest(folderUri);
    assert.equal((progress?.planItemEvidence ?? []).filter((row) => (row.testReports ?? []).length > 0).length, 0);
  });

  void it("a run that could not start (refused, or the gate holds the task) stops at once and says so", async () => {
    const { folder } = makeTask();
    const outcome = await hook(folder, () => Promise.resolve({ ran: false, detail: "the checks were refused" }));
    assert.equal(outcome.kind, "stopped");
    assert.match(outcome.kind === "stopped" ? outcome.detail : "", /could not run \(the checks were refused\)/);
  });

  void it("below the stop level, with blockers, or with a non-test item open, the hook leaves the older path alone and never runs the checks", async () => {
    const { folder } = makeTask();
    let runs = 0;
    const outcome = await hook(
      folder,
      () => {
        runs += 1;
        return Promise.resolve({ ran: true });
      },
      7
    );
    assert.equal(outcome.kind, "not-applicable");
    assert.equal(runs, 0);
  });
});

void describe("the gap's one checks run passes Step 24's gate first (Step 34)", () => {
  void it("a held gate means the checks are not started", async () => {
    const { folderUri } = makeTask();
    let ran = false;
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: ((arg: { kind: string }) => {
        assert.equal(arg.kind, "fast-forward-publish-checks");
        return Promise.resolve({ admitted: false, reason: "failed", cardPosted: true });
      }) as never,
      runPreview: (() => {
        ran = true;
        return Promise.reject(new Error("must not run"));
      }) as never,
    });
    assert.equal(result.ran, false);
    assert.equal(ran, false);
  });

  void it("an admitted run uses the deterministic checks only and leaves the passing test files for the hook", async () => {
    const { folder, folderUri } = makeTask();
    let options: Record<string, unknown> | undefined;
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: (() => Promise.resolve({ admitted: true })) as never,
      runPreview: ((_uri: vscode.Uri, _files: unknown, opts: Record<string, unknown>) => {
        options = opts;
        return Promise.resolve({ runAt: "2026-11-03T07:00:00.000Z", passed: true, passedTestFiles: ["a.test.js"] });
      }) as never,
    });
    assert.equal(result.ran, true);
    assert.equal(options?.["includeAiPlanVerification"], false, "no model call for the gap");
    assert.equal(options?.["allowScopePrompt"], false, "no picker from an automatic run");
    assert.deepEqual(takePublishChecksPassedFilesV1(folder)?.testFiles, ["a.test.js"]);
  });

  void it("a run that throws is reported as could-not-run, not as a pass", async () => {
    const { folder, folderUri } = makeTask();
    const result = await runEvidenceGapChecksV1({
      folderUri,
      stage: "impl-high-review",
      gate: (() => Promise.resolve({ admitted: true })) as never,
      runPreview: (() => Promise.reject(new Error("no valid scope"))) as never,
    });
    assert.deepEqual(result, { ran: false, detail: "no valid scope" });
    assert.equal(takePublishChecksPassedFilesV1(folder), undefined);
  });
});
