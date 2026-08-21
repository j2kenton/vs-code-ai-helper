/**
 * Item 1 (workflow findings round 8), fixes 2-3: a review round whose reply
 * has no parseable `Readiness: N/10` line is degenerate output wearing a
 * review's clothes (a provider error, truncation, or narration like "The
 * file is too large for a single read..."). The V1 coordinator's own
 * candidate-scoped content-contract check (taskActionCoordinatorV1.ts,
 * "Candidate-scoped content-contract check") calls `review.v1`'s
 * `validateCompletedContent` BEFORE `promoteCompletedContent` ever runs
 * (settleEnvelope only reaches promotion for content that already passed
 * validation) — so a degenerate reply is rejected before the single write
 * path (`promoteReviewContentV1`) is ever invoked, and any prior stage
 * artifact is left byte-identical. This test pins that ordering directly at
 * the row level, independent of the coordinator's own control flow.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { createReviewRowV1, ReviewActionInputV1, validateReviewInputV1 } from "../actions/rows/reviewRowV1";
import { TaskActionExecutionContextV1 } from "../actions/taskActionRegistryV1";
import {
  configureWorkflowPrivateStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  resetWorkflowRuntimeServicesForTestV1,
} from "../services/workflowRuntimeServicesV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-degenerate-guard-"));
let privateStorageDir: string;

before(() => {
  resetWorkflowRuntimeServicesForTestV1();
  privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-degenerate-guard-private-"));
  configureWorkflowPrivateStorageRootV1(privateStorageDir);
});

after(() => {
  resetWorkflowRuntimeServicesForTestV1();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(privateStorageDir, { recursive: true, force: true });
});

function makeTaskFolder(name: string): string {
  const folder = path.join(ROOT, "plans", name);
  fs.mkdirSync(folder, { recursive: true });
  const ownership = fixtureOwnershipFor(folder);
  fs.writeFileSync(
    path.join(folder, TASK_PROGRESS_FILENAME),
    JSON.stringify(
      {
        taskFolder: name,
        currentStage: "impl-low-review",
        status: "active",
        displayName: name,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ownership,
      },
      null,
      2
    ),
    "utf8"
  );
  return folder;
}

void describe("review.v1 — degenerate content is rejected before the artifact write path runs", () => {
  void it("rejects a reply with no parseable Readiness line via validateCompletedContent", () => {
    const row = createReviewRowV1();
    const context: TaskActionExecutionContextV1 = {
      correlation: {
        taskBindingId: allocateHex128IdV1(),
        chatDocumentId: allocateHex128IdV1(),
        actionKey: "review.v1",
        operationId: allocateHex128IdV1(),
        attemptId: allocateHex128IdV1(),
      },
      stage: "impl-low-review",
      validatedInput: undefined,
    };
    const degenerate = {
      contentType: "markdown-artifact.v1" as const,
      schemaVersion: 1 as const,
      markdown: "The file is too large for a single read. Let me page through it in smaller chunks.",
    };
    assert.ok(row.validateCompletedContent, "review.v1 must declare validateCompletedContent");
    const result = row.validateCompletedContent(degenerate, context);
    assert.equal(result.ok, false);
  });

  void it("leaves a pre-existing impl-low-review.md byte-identical when the round never promotes", async () => {
    const folder = makeTaskFolder("degenerate-guard");
    const rootId = ensureWorkflowTaskFolderRootV1(folder);
    const relativePath = "impl-low-review.md";
    const priorContent = "Readiness: 8/10\n\nA genuine prior review.\n";
    fs.writeFileSync(path.join(folder, relativePath), priorContent, "utf8");

    const row = createReviewRowV1();
    const rawInput: Record<string, unknown> = {
      prompt: "review this",
      targetLocator: { rootId, relativePath },
    };
    const validation = validateReviewInputV1(rawInput);
    assert.equal(validation.ok, true, "constructed input must validate");
    const validatedInput = (validation as { ok: true; input: unknown }).input as ReviewActionInputV1;
    const context: TaskActionExecutionContextV1 = {
      correlation: {
        taskBindingId: allocateHex128IdV1(),
        chatDocumentId: allocateHex128IdV1(),
        actionKey: "review.v1",
        operationId: allocateHex128IdV1(),
        attemptId: allocateHex128IdV1(),
      },
      stage: "impl-low-review",
      validatedInput,
    };
    const degenerate = {
      contentType: "markdown-artifact.v1" as const,
      schemaVersion: 1 as const,
      markdown: "(Kimi Code CLI completed the run without returning any text reply.)",
    };

    // Mirrors the coordinator's own control flow (taskActionCoordinatorV1.ts,
    // "Candidate-scoped content-contract check"): validate BEFORE promote,
    // and never call promote when validation rejects.
    const validationResult = row.validateCompletedContent!(degenerate, context);
    assert.equal(validationResult.ok, false);
    if (validationResult.ok) {
      await row.promoteCompletedContent(degenerate, context);
    }

    const onDisk = fs.readFileSync(path.join(folder, relativePath), "utf8");
    assert.equal(onDisk, priorContent, "a degenerate round must never overwrite a prior stage artifact");
  });
});
