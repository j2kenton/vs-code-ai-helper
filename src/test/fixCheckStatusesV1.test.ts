import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { classifyFixCheckStatusesV1, fixHasUnresolvedChecksV1 } from "../utils/fixChecksReportV1";
import { createPublishFixReleaseCoordinatorV1 } from "../commands/runLintingFixes";

void describe("Fix Check Statuses (Step 28 / Defect 13)", () => {
  void it("reports all checks passing when rerun passed and all prior failures cleared", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [
        { command: "pnpm run test:unit" },
        { command: "pnpm run check-types" },
      ],
      rerunFailedChecks: [],
      rerunExecuted: true,
    });

    assert.strictEqual(result.allPassed, true);
    assert.strictEqual(result.hasUnrun, false);
    assert.strictEqual(result.hasDenied, false);
    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.items[0]?.status, "passing");
    assert.strictEqual(result.items[1]?.status, "passing");
    assert.ok(result.summary.includes("All previously failing checks are now passing"));
  });

  void it("reports omitted prior checks as unrun when not present in rerunCommandsRun", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [
        { command: "pnpm run test:unit" },
        { command: "pnpm run check-types" },
      ],
      rerunFailedChecks: [],
      rerunCommandsRun: ["pnpm run test:unit"],
      rerunExecuted: true,
    });

    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.hasUnrun, true);
    const passing = result.items.find((i) => i.command === "pnpm run test:unit");
    const unrun = result.items.find((i) => i.command === "pnpm run check-types");
    assert.strictEqual(passing?.status, "passing");
    assert.strictEqual(unrun?.status, "unrun");
    assert.strictEqual(unrun?.detail, "omitted from rerun");
    assert.ok(result.summary.includes("unrun/untested: pnpm run check-types"));
    assert.ok(result.summary.includes("passing: pnpm run test:unit"));
  });

  void it("reports still-failing checks accurately", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [
        { command: "pnpm run test:unit" },
        { command: "pnpm run check-types" },
      ],
      rerunFailedChecks: [{ command: "pnpm run test:unit" }],
      rerunExecuted: true,
    });

    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.hasUnrun, false);
    assert.strictEqual(result.hasDenied, false);
    const passing = result.items.find((i) => i.command === "pnpm run check-types");
    const failing = result.items.find((i) => i.command === "pnpm run test:unit");
    assert.strictEqual(passing?.status, "passing");
    assert.strictEqual(failing?.status, "still failing");
    assert.ok(result.summary.includes("still failing: pnpm run test:unit"));
    assert.ok(result.summary.includes("passing: pnpm run check-types"));
  });

  void it("reports unrun/untested checks when rerun was not executed", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [
        { command: "pnpm run test:unit" },
        { command: "pnpm run check-types" },
      ],
      rerunExecuted: false,
    });

    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.hasUnrun, true);
    assert.strictEqual(result.items.every((i) => i.status === "unrun"), true);
    assert.ok(result.summary.includes("unrun/untested"));
  });

  void it("reports denied checks when sandbox restriction occurred", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [{ command: "pnpm run test:unit" }],
      rerunFailedChecks: [],
      rerunExecuted: true,
      deniedCommands: ["pnpm run test:unit"],
    });

    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.hasDenied, true);
    const item = result.items[0];
    assert.strictEqual(item?.status, "denied");
    assert.ok(result.summary.includes("denied: pnpm run test:unit"));
  });

  void it("handles empty prior failed checks cleanly", () => {
    const result = classifyFixCheckStatusesV1({
      priorFailedChecks: [],
      rerunExecuted: true,
    });

    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.items.length, 0);
    assert.strictEqual(result.summary, "No previously failing checks were recorded.");
  });

  void it("unresolved unrun prior failure prevents fix success and prevents scheduling Publish review", async () => {
    // When prior checks failed, and rerun omitted one of them:
    const classification = classifyFixCheckStatusesV1({
      priorFailedChecks: [
        { command: "pnpm run test:unit" },
        { command: "pnpm run test:e2e" },
      ],
      rerunFailedChecks: [],
      rerunCommandsRun: ["pnpm run test:unit"],
      rerunExecuted: true,
    });
    assert.strictEqual(classification.hasUnrun, true);
    assert.strictEqual(classification.allPassed, false);

    // The rerun itself passed (the omitted check simply never ran), yet the
    // fix must still be treated as unresolved by runLintingFixes.
    assert.strictEqual(
      fixHasUnresolvedChecksV1({ rerunPassed: true, classification, priorFailedCount: 2 }),
      true
    );
    const cleared = classifyFixCheckStatusesV1({
      priorFailedChecks: [{ command: "pnpm run test:unit" }],
      rerunFailedChecks: [],
      rerunCommandsRun: ["pnpm run test:unit"],
      rerunExecuted: true,
    });
    assert.strictEqual(
      fixHasUnresolvedChecksV1({ rerunPassed: true, classification: cleared, priorFailedCount: 1 }),
      false
    );
    assert.strictEqual(
      fixHasUnresolvedChecksV1({ rerunPassed: false, classification: cleared, priorFailedCount: 1 }),
      true
    );

    // Verify coordinator integration: when fixSucceeded is false due to unresolved checks,
    // finishPublishFix must NOT owe or schedule a Publish review.
    let reviewScheduled = false;
    let fixNoteWritten: string | undefined;
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/test/task"),
      getLockKey: () => "/test/task",
      getHandle: () => undefined,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: { released: true, releaseRequested: false, releaseHeldWarned: false },
      getFinalChecks: () => ({
        passed: false,
        failedChecks: classification.items.filter((i) => i.status !== "passing").map((i) => ({ command: i.command })),
      }),
      getFixSucceeded: () => false,
      scheduleChain: () => {
        reviewScheduled = true;
        return Promise.resolve(true);
      },
      writeNote: (_uri, note) => {
        fixNoteWritten = note;
        return Promise.resolve(true);
      },
      showInformation: () => undefined,
      showWarning: () => undefined,
    });

    await coordinator.finishPublishFix();
    assert.strictEqual(coordinator.isPublishReviewOwed(), false);
    assert.strictEqual(reviewScheduled, false);
    assert.ok(fixNoteWritten?.includes("pnpm run test:e2e"));
  });
});
