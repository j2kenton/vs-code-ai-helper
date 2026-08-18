/**
 * Coverage for the review.v1 row's promotion-time Publish Checks freshness
 * revalidation (plan PART 2, step 7's "immediately before promotion,
 * re-read the stamp and current HEAD" requirement).
 *
 * The entry-point gate (`requirePublishChecksFreshnessOrWarnV1` in
 * reviewActions.ts, covered by publishChecksFreshness.test.ts and
 * publishOwnershipMatrix.test.ts) only proves freshness at dispatch time.
 * These tests exercise the SECOND check — `promoteReviewContentV1`'s call
 * to `revalidatePublishFreshnessOrThrowV1` — directly at the row level, so a
 * Publish Checks re-run or a new commit landing while the model was
 * executing is provably still caught right before the artifact write.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createReviewRowV1,
  PublishReviewFreshnessGuardV1,
  ReviewActionInputV1,
  validateReviewInputV1,
} from "../actions/rows/reviewRowV1";
import { TaskActionExecutionContextV1 } from "../actions/taskActionRegistryV1";
import {
  configureWorkflowPrivateStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  resetWorkflowRuntimeServicesForTestV1,
} from "../services/workflowRuntimeServicesV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import {
  computePublishScopeId,
  renderPublishChecksFreshnessStamp,
} from "../utils/publishChecksFreshness";
import { PUBLISH_CHECKS_FILENAME } from "../types/taskProgress";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-freshness-guard-"));
cp.execSync("git init", { cwd: ROOT, stdio: "ignore" });
cp.execSync(
  'git -c user.email=test@example.invalid -c user.name=test commit --allow-empty -m "init"',
  { cwd: ROOT, stdio: "ignore" }
);
const HEAD_SHA = cp.execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function writeStamp(taskFolder: string, scopeFolder: string, runId: string, commitSha: string): void {
  const section = renderPublishChecksFreshnessStamp({
    formatVersion: 1,
    runId,
    verifiedCommitSha: commitSha,
    completedAt: "2026-01-01T00:00:00.000Z",
    scopeId: computePublishScopeId(scopeFolder),
  });
  fs.writeFileSync(path.join(taskFolder, PUBLISH_CHECKS_FILENAME), `${section}\n`, "utf8");
}

let privateStorageDir: string;

before(() => {
  resetWorkflowRuntimeServicesForTestV1();
  privateStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-freshness-guard-private-"));
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
        currentStage: "publish",
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

async function promote(
  taskFolder: string,
  guard: PublishReviewFreshnessGuardV1 | undefined,
  relativePath: string
): Promise<void> {
  const row = createReviewRowV1();
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolder);
  const rawInput: Record<string, unknown> = {
    prompt: "review this",
    targetLocator: { rootId, relativePath },
    ...(guard !== undefined ? { publishFreshnessGuard: guard } : {}),
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
    stage: "publish",
    validatedInput,
  };
  await row.promoteCompletedContent(
    { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "Readiness: 8/10\n\nLooks good." },
    context
  );
}

void describe("review.v1 promotion-time Publish Checks freshness guard (plan PART 2, step 7)", () => {
  void it("promotes when the guard's runId and commit still match the on-disk stamp", async () => {
    const folder = makeTaskFolder("still-fresh");
    const scopeFolder = path.dirname(folder);
    writeStamp(folder, scopeFolder, RUN_ID, HEAD_SHA);
    const guard: PublishReviewFreshnessGuardV1 = {
      taskFolderPath: folder,
      scopeFolderPath: scopeFolder,
      runId: RUN_ID,
      verifiedCommitSha: HEAD_SHA,
    };
    await promote(folder, guard, "publish-review.md");
    const written = fs.readFileSync(path.join(folder, "publish-review.md"), "utf8");
    assert.match(written, /Readiness: 8\/10/);
  });

  void it("refuses promotion when a NEW Publish Checks run landed against the same commit", async () => {
    const folder = makeTaskFolder("rerun-same-commit");
    const scopeFolder = path.dirname(folder);
    // The guard was captured against RUN_ID at dispatch time...
    const guard: PublishReviewFreshnessGuardV1 = {
      taskFolderPath: folder,
      scopeFolderPath: scopeFolder,
      runId: RUN_ID,
      verifiedCommitSha: HEAD_SHA,
    };
    // ...but a second Publish Checks run completed (same commit, new runId)
    // while the review's provider call was still in flight.
    writeStamp(folder, scopeFolder, "00000000-0000-4000-8000-000000000002", HEAD_SHA);
    await assert.rejects(
      () => promote(folder, guard, "publish-review.md"),
      /Publish Checks changed/
    );
    assert.equal(fs.existsSync(path.join(folder, "publish-review.md")), false);
  });

  void it("refuses promotion when the commit moved on while the review was running", async () => {
    const folder = makeTaskFolder("commit-moved");
    const scopeFolder = path.dirname(folder);
    const guard: PublishReviewFreshnessGuardV1 = {
      taskFolderPath: folder,
      scopeFolderPath: scopeFolder,
      runId: RUN_ID,
      verifiedCommitSha: "0000000000000000000000000000000000dead",
    };
    // Stamp is valid for the ACTUAL current HEAD, but the guard was captured
    // against a commit that no longer matches (or the stamp itself still
    // names the pre-commit SHA) — either way, a mismatch must refuse.
    writeStamp(folder, scopeFolder, RUN_ID, HEAD_SHA);
    await assert.rejects(
      () => promote(folder, guard, "publish-review.md"),
      /Publish Checks changed/
    );
  });

  void it("refuses promotion when publish-checks.md has no stamp at all anymore", async () => {
    const folder = makeTaskFolder("stamp-removed");
    const scopeFolder = path.dirname(folder);
    const guard: PublishReviewFreshnessGuardV1 = {
      taskFolderPath: folder,
      scopeFolderPath: scopeFolder,
      runId: RUN_ID,
      verifiedCommitSha: HEAD_SHA,
    };
    // No writeStamp call: publish-checks.md is absent entirely.
    await assert.rejects(
      () => promote(folder, guard, "publish-review.md"),
      /Publish Checks changed/
    );
  });

  void it("refuses promotion for a publish-stage review with no guard at all", async () => {
    const folder = makeTaskFolder("no-guard");
    const scopeFolder = path.dirname(folder);
    writeStamp(folder, scopeFolder, RUN_ID, HEAD_SHA);
    await assert.rejects(
      () => promote(folder, undefined, "publish-review.md"),
      /missing its freshness guard/
    );
  });

  void it("never enforces the guard for a non-publish review stage", () => {
    const folder = makeTaskFolder("plan-stage-unrelated");
    // No publish-checks.md stamp at all, and this test's `promote` helper
    // hardcodes context.stage: "publish" — so this instead directly proves
    // the row-level validator accepts an input with no guard when built for
    // a non-publish targetStage, mirroring how runReviewForFolder only ever
    // populates publishFreshnessGuard when targetStage === "publish".
    const rootId = ensureWorkflowTaskFolderRootV1(folder);
    const validation = validateReviewInputV1({
      prompt: "review this",
      targetLocator: { rootId, relativePath: "plan-high-review.md" },
    });
    assert.equal(validation.ok, true);
  });
});

void describe("validateReviewInputV1 publishFreshnessGuard shape", () => {
  void it("accepts a well-formed guard", () => {
    const result = validateReviewInputV1({
      prompt: "review this",
      targetLocator: { rootId: "root", relativePath: "publish-review.md" },
      publishFreshnessGuard: {
        taskFolderPath: "/tmp/task",
        scopeFolderPath: "/tmp",
        runId: "run-1",
        verifiedCommitSha: "abc123",
      },
    });
    assert.equal(result.ok, true);
  });

  void it("rejects a guard missing a required field", () => {
    const result = validateReviewInputV1({
      prompt: "review this",
      targetLocator: { rootId: "root", relativePath: "publish-review.md" },
      publishFreshnessGuard: {
        taskFolderPath: "/tmp/task",
        scopeFolderPath: "/tmp",
        runId: "run-1",
        // verifiedCommitSha missing
      },
    });
    assert.equal(result.ok, false);
  });

  void it("rejects a non-object guard", () => {
    const result = validateReviewInputV1({
      prompt: "review this",
      targetLocator: { rootId: "root", relativePath: "publish-review.md" },
      publishFreshnessGuard: "not-an-object",
    });
    assert.equal(result.ok, false);
  });
});
