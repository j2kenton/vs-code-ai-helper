/**
 * Route-completeness invariant, temporal half (v1 fixes 2, Part 1a plan step
 * 10 — "route-completeness invariant: every route in step 3's inventory
 * registers admission before its first awaited setup step"; also the review's
 * outstanding gap on `workAdmissionRouteInventoryV1.test.ts`: that file only
 * proves the inventory's MEMBERSHIP matches `package.json` and that
 * `delegatesTo` chains resolve — it says nothing about ORDERING. Individual
 * dedicated tests (`chatWithStageWorkAdmission.test.ts`,
 * `draftTaskWithAIWorkAdmission.test.ts`, `renameTaskWithAIWorkAdmission.test.ts`,
 * `generatePlanWithAIWorkAdmission.test.ts`, `runPublishChecksAdmission.test.ts`,
 * `runLintingFixesGateMessages.test.ts`, `scheduleTaskResume.test.ts`) prove
 * this BEHAVIORALLY, one route at a time, via the busy-refusal-before-any-
 * other-effect pattern — but that proof was never aggregated across the full
 * `admissionWired` set, and five routes (`runReviewWithAI`,
 * `applyReviewWithAI`, `applyReviewEditWithAI`, `fastForwardReviewWithAI`,
 * `runImplementationWithAI`) plus `resumeTask`/`completeCommitAndPushTask` had
 * no dedicated admission-ordering test of either kind at all.
 *
 * This file closes that gap the same way
 * `taskCreationStartupReconcilerWiring.test.ts` proves the activation-order
 * barrier: by SOURCE POSITION. For every command classified `admissionWired`
 * in `WORK_ADMISSION_ROUTE_INVENTORY_V1`, it asserts the route's admission
 * acquisition call appears, by source offset within that route's own
 * function body, strictly before the first awaited setup step (a consent
 * gate, a provider-path probe, a task-status read, or an unrelated write)
 * that a watchdog sweep landing in between could otherwise race — mirroring
 * the exact ordering each behavioral test already exercises at runtime, but
 * enforced mechanically for every route in the derived table rather than only
 * the ones with a dedicated harness. A route is not exempt from this file
 * just because it also has a behavioral test elsewhere; this is the
 * aggregated, table-wide check the review found missing.
 *
 * A meta-assertion below also fails this suite the moment a NEW command is
 * classified `admissionWired` in the inventory without a matching case being
 * added here — so this table cannot silently drift out of sync with the
 * inventory the way the plan's original hand-traced audit did.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { WORK_ADMISSION_ROUTE_INVENTORY_V1 } from "../state/workAdmissionRouteInventoryV1";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

interface RouteTimingCaseV1 {
  /** The `admissionWired` key in `WORK_ADMISSION_ROUTE_INVENTORY_V1` this case proves. */
  readonly routeId: string;
  readonly file: string;
  /** Literal source text marking the start of this route's own function body. */
  readonly fn: string;
  /** Literal source text of this route's admission-acquisition call. */
  readonly admissionCall: string;
  /** Literal source text of the first awaited setup step admission must precede. */
  readonly firstUnprotectedStep: string;
}

// Every `admissionWired` route in the derived inventory, with its own
// admission-call and first-unprotected-step markers. See each route's own
// "Early work admission" comment block (or, for resumeTask/scheduleTaskResume,
// the comment at their admission call site) for why these two markers are the
// correct pair to order-check.
const ROUTE_TIMING_CASES_V1: readonly RouteTimingCaseV1[] = [
  {
    routeId: "resumeTask",
    file: "src/commands/resumeTask.ts",
    fn: "export async function resumePausedTask(",
    admissionCall: "acquireWorkAdmissionV1({",
    firstUnprotectedStep: "activateTask(",
  },
  {
    routeId: "draftTaskWithAI",
    file: "src/commands/draftTaskWithAI.ts",
    fn: "export async function draftTaskWithAI(",
    admissionCall: "beginTargetResolutionV1(taskRootCandidatePathsV1)",
    firstUnprotectedStep: "resolveTaskContext(inventory, normalizeDraftTaskArg(explicitArg)",
  },
  {
    routeId: "generatePlanWithAI",
    file: "src/commands/generatePlanWithAI.ts",
    fn: "export async function generatePlanWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: "ensureAiConsent(context)",
  },
  {
    routeId: "runReviewWithAI",
    file: "src/commands/reviewActions.ts",
    fn: "export async function runReviewWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: "ensureAiConsent(context)",
  },
  {
    routeId: "applyReviewWithAI",
    file: "src/commands/reviewActions.ts",
    fn: "export async function applyReviewWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: "readTaskProgressStrictV1(taskFolderUri",
  },
  {
    routeId: "fastForwardReviewWithAI",
    file: "src/commands/reviewActions.ts",
    fn: "export async function fastForwardReviewWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: 'checkEditActionProviderPathGateV1("impl")',
  },
  {
    routeId: "runImplementationWithAI",
    file: "src/commands/reviewActions.ts",
    fn: "export async function runImplementationWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: 'checkEditActionProviderPathGateV1("impl")',
  },
  {
    routeId: "applyReviewEditWithAI",
    file: "src/commands/reviewActions.ts",
    fn: "export async function applyReviewEditWithAI(",
    admissionCall: "acquireOrAdoptWorkAdmissionV1({",
    firstUnprotectedStep: 'checkEditActionProviderPathGateV1("impl")',
  },
  {
    routeId: "commitAndPushTask",
    file: "src/commands/commitAndPushTask.ts",
    fn: "export async function commitAndPushTask(",
    admissionCall: "beginTargetResolutionV1(",
    firstUnprotectedStep: "resolveCommitPushTargetTaskV1(",
  },
  {
    routeId: "completeCommitAndPushTask",
    file: "src/commands/commitAndPushTask.ts",
    fn: "export async function completeCommitAndPushTask(",
    admissionCall: "beginTargetResolutionV1(",
    firstUnprotectedStep: "resolveTaskContext(inventory, resolverArg",
  },
  {
    routeId: "chatWithStage",
    file: "src/commands/chatWithStage.ts",
    fn: "export async function chatWithStage(",
    admissionCall: "beginTargetResolutionV1(taskRootCandidatePathsV1)",
    firstUnprotectedStep: "validateChatSendV1(inventory, resolverArg, stage)",
  },
  {
    routeId: "runPublishChecks",
    file: "src/commands/runPublishChecks.ts",
    fn: "export async function runPublishChecks(",
    admissionCall: "beginTargetResolutionV1(",
    firstUnprotectedStep: "resolveTaskContext(inventory, resolverArg",
  },
  {
    routeId: "runLintingFixes",
    file: "src/commands/runLintingFixes.ts",
    fn: "export async function runLintingFixes(",
    admissionCall: "acquireWorkAdmissionV1({",
    firstUnprotectedStep: "resolveTaskContext(inventory, resolverArg",
  },
  {
    routeId: "scheduleTaskResume",
    file: "src/commands/scheduleTaskResume.ts",
    fn: "private async fire(",
    admissionCall: "withWorkAdmissionV1(",
    firstUnprotectedStep: "this.store.patch(",
  },
  {
    routeId: "renameTaskWithAI",
    file: "src/commands/renameTask.ts",
    fn: "export async function renameTaskWithAI(",
    admissionCall: "beginTargetResolutionV1(taskRootCandidatePathsV1)",
    firstUnprotectedStep: "await resolve(inventory, arg,",
  },
];

void describe("work admission route timing (v1 fixes 2, Part 1a route-completeness invariant, step 10)", () => {
  void it("every `admissionWired` inventory entry has a timing case in this file", () => {
    const admissionWiredRouteIds = Object.entries(WORK_ADMISSION_ROUTE_INVENTORY_V1)
      .filter(([, classification]) => classification.kind === "admissionWired")
      .map(([id]) => id);
    const covered = new Set(ROUTE_TIMING_CASES_V1.map((c) => c.routeId));

    const missing = admissionWiredRouteIds.filter((id) => !covered.has(id));
    assert.deepEqual(
      missing,
      [],
      `every 'admissionWired' route in WORK_ADMISSION_ROUTE_INVENTORY_V1 must have a matching case in ` +
        `ROUTE_TIMING_CASES_V1 above; missing: ${missing.join(", ")}`
    );

    const stale = ROUTE_TIMING_CASES_V1.map((c) => c.routeId).filter((id) => !admissionWiredRouteIds.includes(id));
    assert.deepEqual(
      stale,
      [],
      `every case in ROUTE_TIMING_CASES_V1 must name a route still classified 'admissionWired' in the inventory; ` +
        `stale: ${stale.join(", ")}`
    );
  });

  for (const testCase of ROUTE_TIMING_CASES_V1) {
    void it(`${testCase.routeId}: admission is acquired before its first unprotected setup step`, () => {
      const content = readRepoFile(testCase.file);

      const fnIndex = content.indexOf(testCase.fn);
      assert.ok(fnIndex >= 0, `could not find ${testCase.fn} in ${testCase.file}`);

      const admissionIndex = content.indexOf(testCase.admissionCall, fnIndex);
      assert.ok(
        admissionIndex > fnIndex,
        `could not find admission call ${JSON.stringify(testCase.admissionCall)} in ${testCase.fn}`
      );

      const setupIndex = content.indexOf(testCase.firstUnprotectedStep, fnIndex);
      assert.ok(
        setupIndex > fnIndex,
        `could not find first-unprotected-step marker ${JSON.stringify(testCase.firstUnprotectedStep)} in ${testCase.fn}`
      );

      assert.ok(
        admissionIndex < setupIndex,
        `admission call ${JSON.stringify(testCase.admissionCall)} (at ${admissionIndex}) must precede ` +
          `${JSON.stringify(testCase.firstUnprotectedStep)} (at ${setupIndex}) in ${testCase.fn}`
      );
    });
  }
});
