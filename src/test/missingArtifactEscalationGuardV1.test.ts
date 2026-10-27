import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { after, before, describe, it } from "node:test";
import {
  diagnoseMissingArtifactBlockerV1,
  handleMissingArtifactBlockerBeforeEscalationV1,
  missingArtifactCorrectionAttemptedFromInputSnapshotV1,
  retryMissingArtifactReviewOnceV1,
} from "../utils/missingArtifactEscalationGuardV1";

void describe("missing task artifact escalation guard (Step 12)", () => {
  let root: string;
  let taskFolder: string;
  let otherTask: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-artifact-guard-"));
    taskFolder = path.join(root, ".ensemble", "2026-10-21_task_1");
    otherTask = path.join(root, ".ensemble", "2026-10-22_task_1");
    fs.mkdirSync(taskFolder, { recursive: true });
    fs.mkdirSync(otherTask, { recursive: true });
    fs.writeFileSync(path.join(taskFolder, "plan-final.md"), "# Bound task plan\n", "utf8");
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  void it("recognizes a foreign cited plan path while confirming the bound task's canonical plan is readable", async () => {
    const blocker = {
      description: `The on-disk plan checklist is unavailable at '.ensemble/2026-10-22_task_1/plan-final.md'.`,
      resolver: "unverifiable",
    };
    const diagnosis = await diagnoseMissingArtifactBlockerV1(vscode.Uri.file(taskFolder), "impl-high-review", blocker);
    assert.equal(diagnosis.kind, "wrong-task");
    assert.equal(diagnosis.canonicalPath, path.join(taskFolder, "plan-final.md"));

    const resolution = await handleMissingArtifactBlockerBeforeEscalationV1(vscode.Uri.file(taskFolder), "impl-high-review", blocker);
    assert.equal(resolution.action, "correct-and-retry");
    assert.ok(resolution.correctedContext?.includes(path.join(taskFolder, "plan-final.md")));
  });

  void it("dispatches exactly one corrected review using the bound task's canonical absolute path", async () => {
    const blocker = {
      description: `The on-disk plan checklist is unavailable at '${path.join(otherTask, "plan-final.md")}'.`,
      resolver: "unverifiable",
    };
    let attempts = 0;
    let correction = "";
    const result = await retryMissingArtifactReviewOnceV1(
      vscode.Uri.file(taskFolder),
      "impl-high-review",
      [blocker],
      (context) => {
        attempts += 1;
        correction = context;
        return Promise.resolve(true);
      }
    );
    assert.equal(result.attempted, true);
    assert.equal(result.dispatched, true);
    assert.equal(attempts, 1);
    assert.ok(correction.includes(path.join(taskFolder, "plan-final.md")));
    assert.ok(!correction.includes(otherTask));
  });

  void it("recovers the one-shot correction marker after question/resume from the persisted prompt", () => {
    assert.equal(missingArtifactCorrectionAttemptedFromInputSnapshotV1(JSON.stringify({
      prompt: "Review this task.\n\n## Canonical Task Artifact Correction\n\nUse /task/plan-final.md",
    })), true);
    assert.equal(missingArtifactCorrectionAttemptedFromInputSnapshotV1(JSON.stringify({ prompt: "ordinary review" })), false);
    assert.equal(missingArtifactCorrectionAttemptedFromInputSnapshotV1("{"), false);
  });

  void it("does not request a corrected review when the canonical artifact is absent", async () => {
    fs.rmSync(path.join(taskFolder, "plan-final.md"), { force: true });
    let attempts = 0;
    const result = await retryMissingArtifactReviewOnceV1(
      vscode.Uri.file(taskFolder),
      "impl-high-review",
      [{ description: "The on-disk plan checklist is unavailable." }],
      () => { attempts += 1; return Promise.resolve(true); }
    );
    assert.equal(result.attempted, false);
    assert.equal(attempts, 0);
  });

  void it("reports the canonical-path disagreement after the single correction was already attempted", async () => {
    fs.writeFileSync(path.join(taskFolder, "plan-final.md"), "# Bound task plan\n", "utf8");
    const resolution = await handleMissingArtifactBlockerBeforeEscalationV1(
      vscode.Uri.file(taskFolder),
      "impl-high-review",
      { description: "The on-disk plan checklist is unavailable." },
      1
    );
    assert.equal(resolution.action, "report-disagreement");
    assert.ok(resolution.disagreementMessage?.includes(path.join(taskFolder, "plan-final.md")));
    assert.ok(resolution.disagreementMessage?.includes("readable on disk"));
  });

  void it("distinguishes a genuinely absent canonical artifact from a foreign path citation", async () => {
    fs.rmSync(path.join(taskFolder, "plan-final.md"), { force: true });
    const resolution = await handleMissingArtifactBlockerBeforeEscalationV1(
      vscode.Uri.file(taskFolder),
      "impl-high-review",
      { description: `Could not find plan-final.md at '${path.join(otherTask, "plan-final.md")}'.` }
    );
    assert.equal(resolution.action, "escalate");
    assert.equal(resolution.diagnosis.kind, "absent");
    assert.equal(resolution.diagnosis.isOutsideAutomationControl, true);
  });

  void it("reports a canonical whitespace-only plan as empty rather than absent", async () => {
    fs.writeFileSync(path.join(taskFolder, "plan-final.md"), "  \n", "utf8");
    const diagnosis = await diagnoseMissingArtifactBlockerV1(
      vscode.Uri.file(taskFolder),
      "impl-high-review",
      { description: "plan-final.md is missing" }
    );
    assert.equal(diagnosis.kind, "empty");
    assert.equal(diagnosis.isOutsideAutomationControl, true);
  });
});
