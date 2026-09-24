import * as vscode from "vscode";
import { STAGE_ARTIFACT_FILENAMES, STAGE_DISPLAY_NAMES, TaskProgress, TaskStage } from "../types/taskProgress";
import { resolveHeadCommitSha } from "./gitRepoInfo";
import { previousVersionUri } from "./artifactBackups";
import {
  describeUnusableSummaryRemedyV1,
  firstUnmetStageActionRequirementV1,
  firstUnmetStagePrerequisiteV1,
  getImplementationSummaryUri,
  isUnusableImplementationSummaryV1,
  readImplementationReviewContent,
  readPlanOfRecordV1,
} from "./implementationArtifactResolver";
import { stageActionForReviewV1, type StageActionIdV1 } from "./stageArtifactRequirementsV1";
import { resolveModelForStage } from "./modelSelection";
import {
  computeReviewFreshness,
  isReviewPassCurrentV1,
  isStaleReviewArtifactV1,
  parseReviewBlockers,
  reviewPredatesLatestImplementationRoundV1,
  REVIEWED_COMMIT_STAGES,
} from "./reviewReadiness";
import { resolveEffectiveProvider } from "../runners/runnerRegistry";
import { checkPublishChecksFreshnessV1 } from "./publishChecksFreshness";
import { resolvePublishScopeFolder } from "./completionLint";
import { PUBLISH_STAGE_ACTIONS_V1, publishNextStepFromActionsV1, type PublishStepV1 } from "./publishStageActionsV1";

/**
 * What a "Resume and ..." button should do for a paused task, decided from the
 * same preconditions the dispatched command would itself enforce (v1 fixes 2,
 * items 14 + 25). Resume used to dispatch the stage's default action without
 * asking whether it could succeed: a stale review got Apply Review, which
 * refuses ("The review is stale"), and every button said "re-run this stage"
 * whatever it would actually run.
 *
 * - `resume-only`: the next step is the human's; flip the status, dispatch nothing.
 * - `run-review`: the stage's review is missing or stale, so Review is the
 *   action that clears the obstacle.
 * - `apply-review`: a current review exists; Apply Review acts on its blockers.
 * - `stage-default`: the stage's own action (Draft, Plan, Implementation, ...).
 * - `blocked`: no valid action exists; stay paused and say which precondition failed.
 */
export type ResumeActionPlanV1 =
  | { readonly kind: "resume-only"; readonly reason: string }
  | { readonly kind: "run-review"; readonly label: string }
  | { readonly kind: "apply-review"; readonly label: string }
  | { readonly kind: "stage-default"; readonly label: string }
  | {
      readonly kind: "blocked";
      readonly precondition: string;
      /** The refusal can be cleared by restoring the last usable `impl-summary.md`; the caller offers that action. */
      readonly restoreSummary?: boolean;
    };

export interface ResumeActionFactsV1 {
  readonly stage: TaskStage;
  readonly nextActor: TaskProgress["nextActor"];
  /** Content of the current stage's review artifact; absent when there is none or it is empty. */
  readonly reviewContent: string | undefined;
  readonly headSha: string | undefined;
  /**
   * Whether the review artifact belongs to the stage's current review pass
   * (v1 fixes 2, item 32). `false` — no pass marker, or one behind the latest
   * reservation — makes the review a leftover from an earlier visit, which is
   * stale however recent its commit stamp; Review, not Apply Review, is the
   * action that clears it. `undefined` means the fact was not established.
   */
  readonly reviewPassCurrent?: boolean;
  /**
   * `missingMessage` of the first unmet prerequisite, per candidate action. A
   * review stage's Review and Apply Review need different artifacts (Apply
   * Review needs `plan-final.md`, Review does not), so each candidate is judged
   * only on its own requirements — an Apply-only gap must never block Review.
   */
  readonly unmet: {
    readonly review?: string;
    readonly apply?: string;
    readonly stage?: string;
  };
  /**
   * Set when the implementation notes a Review would be built from carry the
   * unusable-round stamp — Review refuses that deterministically
   * (`runReviewForFolder`), so arranging it would resume the task into a
   * refusal. `remedy` is the shared refusal wording; `canRestore` says the
   * previous summary is itself usable.
   */
  readonly unusableSummary?: { readonly remedy: string; readonly canRestore: boolean };
  /**
   * At Publish: the checks' freshness stamp is valid for the current commit
   * and scope. Fresh checks are never re-run by a resume (v1 fixes 2, item 33)
   * — the next missing step is what gets arranged. `undefined` means the fact
   * was not established, and the stage default applies.
   */
  readonly publishChecksFresh?: boolean;
  /** Publish's stage-action table; defaults to the real one. Injected by tests. */
  readonly publishActions?: readonly PublishStepV1[];
  /**
   * Candidate actions whose stage has no usable model configured. The command
   * would refuse ("No model is configured for this stage") after resuming, so
   * the resume must not be arranged at all.
   */
  readonly noModel?: {
    readonly review?: true;
    readonly apply?: true;
  };
  /** Provider that would run each candidate action (display label), when resolvable. */
  readonly providers: {
    readonly review?: string;
    readonly apply?: string;
    readonly stage?: string;
  };
}

const REVIEW_STAGES_V1: ReadonlySet<TaskStage> = new Set([
  "plan-high-review",
  "plan-low-review",
  "impl-high-review",
  "impl-low-review",
]);

function withProvider(label: string, provider: string | undefined): string {
  return provider ? `${label} (${provider})` : label;
}

function noModelPrecondition(what: string): string {
  return `No AI model is configured for ${what}. Choose one in AI Models, then resume.`;
}

/** Review is only arrangeable when a model is configured and the notes it is built from are usable. */
function planRunReview(facts: ResumeActionFactsV1, label: string): ResumeActionPlanV1 {
  if (facts.noModel?.review) {
    return { kind: "blocked", precondition: noModelPrecondition("the review") };
  }
  const unusable = facts.unusableSummary;
  if (unusable) {
    return {
      kind: "blocked",
      precondition:
        "The last implementation round did not produce usable implementation notes, so there is " +
        `nothing to review it against. ${unusable.remedy}`,
      restoreSummary: unusable.canRestore,
    };
  }
  return { kind: "run-review", label };
}

/** Pure: no git, no fs. */
export function planResumeActionV1(facts: ResumeActionFactsV1): ResumeActionPlanV1 {
  const { stage } = facts;

  // Never Draft with AI on an empty task, and never re-run Publish Checks that
  // already passed: at these two stages a human-next task has nothing for
  // automation to redo.
  if (facts.nextActor === "human" && stage === "desc") {
    return {
      kind: "resume-only",
      reason: "Describe the task, then use Draft with AI — there is nothing for automation to re-run yet.",
    };
  }

  // Fresh Publish checks are never re-run: arrange the step the stage-action
  // table names after them (the review while one exists, else Commit & Push,
  // which is the user's own click). This is judged BEFORE the generic
  // human-next branch below: a completed Publish Checks run hands back with
  // `nextActor: "human"`, so that is the real production state in which the
  // Publish review (state B) must still be arranged.
  if (stage === "publish" && facts.publishChecksFresh === true) {
    if (publishNextStepFromActionsV1(facts.publishActions) === "review") {
      // The review is the step arranged here, so its own artifact prerequisites
      // (not the checks') decide whether it can start.
      if (facts.unmet.review) {
        return { kind: "blocked", precondition: facts.unmet.review };
      }
      return planRunReview(facts, withProvider("Resume and run the Publish review", facts.providers.review));
    }
    return {
      kind: "resume-only",
      reason: "Publish checks already passed for this commit — Commit & Push is the next step, and it is yours.",
    };
  }
  if (facts.nextActor === "human" && stage === "publish") {
    return {
      kind: "resume-only",
      reason: "Publish is waiting for you — its checks already ran, so the next step is yours.",
    };
  }

  if (REVIEW_STAGES_V1.has(stage)) {
    const stageName = STAGE_DISPLAY_NAMES[stage];
    const review = facts.reviewContent;
    if (review === undefined) {
      if (facts.unmet.review) {
        return { kind: "blocked", precondition: facts.unmet.review };
      }
      return planRunReview(facts, withProvider(`Resume and run the ${stageName}`, facts.providers.review));
    }
    const stale =
      isStaleReviewArtifactV1(review) ||
      (REVIEWED_COMMIT_STAGES.has(stage) &&
        (computeReviewFreshness(review, facts.headSha).behindHead || facts.reviewPassCurrent === false));
    if (stale) {
      if (facts.unmet.review) {
        return { kind: "blocked", precondition: facts.unmet.review };
      }
      return planRunReview(facts, withProvider("Resume and run the review again", facts.providers.review));
    }
    if (facts.unmet.apply) {
      return { kind: "blocked", precondition: facts.unmet.apply };
    }
    if (facts.noModel?.apply) {
      return { kind: "blocked", precondition: noModelPrecondition("applying the review") };
    }
    const blockers = parseReviewBlockers(review).length;
    const what =
      blockers === 0
        ? "Resume and apply the review"
        : `Resume and fix the review's ${blockers} blocker${blockers === 1 ? "" : "s"}`;
    return { kind: "apply-review", label: withProvider(what, facts.providers.apply) };
  }

  if (facts.unmet.stage) {
    return { kind: "blocked", precondition: facts.unmet.stage };
  }
  return {
    kind: "stage-default",
    label: withProvider(`Resume and run ${STAGE_DISPLAY_NAMES[stage]}`, facts.providers.stage),
  };
}

async function readTextIfPresent(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

interface ProviderFactV1 {
  readonly label: string | undefined;
  /** The stage resolved no model at all (as opposed to a lookup that failed). */
  readonly noModel: boolean;
}

async function providerFactForStageV1(taskFolderUri: vscode.Uri, stage: TaskStage): Promise<ProviderFactV1> {
  try {
    const resolved = await resolveModelForStage(taskFolderUri, stage);
    if (!resolved.modelId) {
      return { label: undefined, noModel: true };
    }
    const provider = resolveEffectiveProvider(resolved.modelId);
    return { label: provider.kind === "cli" ? provider.def.label : "Copilot", noModel: false };
  } catch {
    return { label: undefined, noModel: false };
  }
}

async function providerLabelForStageV1(taskFolderUri: vscode.Uri, stage: TaskStage): Promise<string | undefined> {
  return (await providerFactForStageV1(taskFolderUri, stage)).label;
}

/** Reads the facts {@link planResumeActionV1} needs, then plans. */
export async function loadResumeActionPlanV1(
  taskFolderPath: string,
  progress: TaskProgress
): Promise<ResumeActionPlanV1> {
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const stage = progress.currentStage;
  const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
  const isReview = REVIEW_STAGES_V1.has(stage);
  const reviewActionId: StageActionIdV1 = stage.startsWith("plan") ? "reviewPlan" : "reviewImplementation";
  const applyActionId: StageActionIdV1 = stage.startsWith("plan") ? "applyReviewPlan" : "applyReviewImplementation";
  // Publish's review step (state B) is judged on its own requirements, and only
  // once the checks have passed. The checks that precede it carry none, so a
  // missing review artifact must never block them (`unmet.stage` stays unset).
  const publishReviewStepExists = stage === "publish" && PUBLISH_STAGE_ACTIONS_V1.includes("review");
  const [reviewContent, headSha, unmetReview, unmetApply, unmetStage] = await Promise.all([
    isReview && artifactName ? readTextIfPresent(vscode.Uri.joinPath(taskFolderUri, artifactName)) : undefined,
    isReview && REVIEWED_COMMIT_STAGES.has(stage) ? resolveHeadCommitSha(taskFolderPath) : undefined,
    isReview || publishReviewStepExists ? firstUnmetStageActionRequirementV1(reviewActionId, taskFolderUri) : undefined,
    isReview ? firstUnmetStageActionRequirementV1(applyActionId, taskFolderUri) : undefined,
    isReview || stage === "publish" ? undefined : firstUnmetStagePrerequisiteV1(stage, taskFolderUri),
  ]);
  const unusableSummary = await loadUnusableSummaryFactV1(taskFolderUri, stage);
  const publishChecksFresh =
    stage === "publish" ? await loadPublishChecksFreshFactV1(taskFolderUri, progress) : undefined;
  const applyStage: TaskStage = stage.startsWith("plan") ? "plan" : "impl";
  const [review, apply, stageProvider] = await Promise.all([
    isReview || stage === "publish" ? providerFactForStageV1(taskFolderUri, stage) : undefined,
    isReview ? providerFactForStageV1(taskFolderUri, applyStage) : undefined,
    isReview ? undefined : providerLabelForStageV1(taskFolderUri, stage),
  ]);
  // Publish is a configurable AI stage (AI_MODEL_STAGES) and, while its table
  // still carries a review step, that review can refuse for a missing model.
  const noModel = {
    ...(review?.noModel ? { review: true as const } : {}),
    ...(apply?.noModel ? { apply: true as const } : {}),
  };
  return planResumeActionV1({
    stage,
    nextActor: progress.nextActor,
    reviewContent,
    headSha,
    ...(reviewContent !== undefined && REVIEWED_COMMIT_STAGES.has(stage)
      ? {
          reviewPassCurrent:
            isReviewPassCurrentV1(reviewContent, progress.stageReviewPasses, stage) &&
            !reviewPredatesLatestImplementationRoundV1(progress, stage),
        }
      : {}),
    unmet: {
      review: unmetReview?.missingMessage,
      apply: unmetApply?.missingMessage,
      stage: unmetStage?.missingMessage,
    },
    unusableSummary,
    ...(publishChecksFresh !== undefined ? { publishChecksFresh } : {}),
    ...(Object.keys(noModel).length > 0 ? { noModel } : {}),
    providers: { review: review?.label, apply: apply?.label, stage: stageProvider },
  });
}

async function loadPublishChecksFreshFactV1(
  taskFolderUri: vscode.Uri,
  progress: TaskProgress
): Promise<boolean | undefined> {
  try {
    const { folder: scopeFolder } = resolvePublishScopeFolder(taskFolderUri, progress);
    const head = await resolveHeadCommitSha(scopeFolder);
    return (await checkPublishChecksFreshnessV1(taskFolderUri, scopeFolder, head)).status === "valid";
  } catch {
    return undefined;
  }
}

/** Only implementation-review stages build their prompt from the implementation notes. */
async function loadUnusableSummaryFactV1(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<ResumeActionFactsV1["unusableSummary"]> {
  if (stage !== "impl-high-review" && stage !== "impl-low-review") {
    return undefined;
  }
  const content = await readImplementationReviewContent(taskFolderUri);
  if (content === undefined || !isUnusableImplementationSummaryV1(content)) {
    return undefined;
  }
  const previous = await readTextIfPresent(previousVersionUri(getImplementationSummaryUri(taskFolderUri)));
  const canRestore = previous !== undefined && !isUnusableImplementationSummaryV1(previous);
  const plan = await readPlanOfRecordV1(taskFolderUri);
  const settled = plan.hasChecklist && plan.counts !== undefined && plan.counts.remaining === 0;
  return { remedy: describeUnusableSummaryRemedyV1(canRestore, settled), canRestore };
}

/** Why a fixed-target resume (`resumeAndRerunReviewV1`, `resumeAndDispatchImplementationV1`) must not start. */
export interface DispatchPreflightRefusalV1 {
  readonly precondition: string;
  /** The refusal is the unusable-summary stamp and the previous summary can clear it. */
  readonly restoreSummary: boolean;
}

/**
 * Checks the preconditions of the ONE action a fixed-target resume dispatches,
 * before the task is resumed (v1 fixes 2, item 14: never dispatch something the
 * product already knows will be refused). Unlike {@link loadResumeActionPlanV1}
 * this never re-chooses the action — these commands name their action — it only
 * says whether that action can start.
 *
 * - `review`: the stage's review needs its artifacts, and an implementation
 *   review also refuses notes carrying the unusable-round stamp.
 * - `implementation`: only the `impl` stage has a prerequisite (the
 *   implementation plan); routing between continuation, Apply Review and a
 *   fresh round lives inside `runImplementationWithAI` itself.
 */
export async function preflightFixedDispatchV1(
  taskFolderPath: string,
  stage: TaskStage,
  action: "review" | "implementation" | "apply-review",
  /**
   * The task's review-pass reservations. When supplied, an Apply Review whose
   * review belongs to an earlier pass (or carries no pass marker) is refused
   * here with "run the review again" — the same fail-closed rule the resume
   * planner applies (item 32). Omitted by callers that have no progress to hand.
   */
  passes?: Pick<TaskProgress, "stageReviewPasses" | "reviewScoreHistory" | "roundLedger">
): Promise<DispatchPreflightRefusalV1 | undefined> {
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  if (action === "apply-review") {
    // `stage` is the review stage Apply Review will run at (the caller jumps
    // there first). Refuse exactly what `applyReviewWithAI` /
    // `applyReviewEditWithAI` refuse on their own guard clauses: a missing or
    // stale review, or an unmet artifact prerequisite.
    if (!REVIEW_STAGES_V1.has(stage)) {
      return undefined;
    }
    const applyActionId: StageActionIdV1 = stage.startsWith("plan") ? "applyReviewPlan" : "applyReviewImplementation";
    const unmetApply = await firstUnmetStageActionRequirementV1(applyActionId, taskFolderUri);
    if (unmetApply) {
      return { precondition: unmetApply.missingMessage, restoreSummary: false };
    }
    const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
    const reviewContent = artifactName
      ? await readTextIfPresent(vscode.Uri.joinPath(taskFolderUri, artifactName))
      : undefined;
    if (reviewContent === undefined) {
      return {
        precondition: `There is no ${STAGE_DISPLAY_NAMES[stage]} to apply. Run the review first.`,
        restoreSummary: false,
      };
    }
    if (isStaleReviewArtifactV1(reviewContent)) {
      return {
        precondition: `The ${STAGE_DISPLAY_NAMES[stage]} is stale. Run the review again before applying it.`,
        restoreSummary: false,
      };
    }
    if (
      passes !== undefined &&
      REVIEWED_COMMIT_STAGES.has(stage) &&
      !isReviewPassCurrentV1(reviewContent, passes.stageReviewPasses, stage)
    ) {
      return {
        precondition:
          `The ${STAGE_DISPLAY_NAMES[stage]} was left over from an earlier pass, not this one. ` +
          "Run the review again before applying it.",
        restoreSummary: false,
      };
    }
    if (
      passes !== undefined &&
      REVIEWED_COMMIT_STAGES.has(stage) &&
      reviewPredatesLatestImplementationRoundV1(passes, stage)
    ) {
      return {
        precondition:
          `The ${STAGE_DISPLAY_NAMES[stage]} was written before the latest implementation round, so it ` +
          "does not describe the code as it stands. Run the review again before applying it.",
        restoreSummary: false,
      };
    }
    return undefined;
  }
  if (action === "implementation") {
    if (stage !== "impl") {
      return undefined;
    }
    const unmet = await firstUnmetStageActionRequirementV1("runImplementation", taskFolderUri);
    return unmet ? { precondition: unmet.missingMessage, restoreSummary: false } : undefined;
  }
  const reviewActionId = stageActionForReviewV1(stage);
  if (reviewActionId === undefined) {
    return undefined;
  }
  const unmet = await firstUnmetStageActionRequirementV1(reviewActionId, taskFolderUri);
  if (unmet) {
    return { precondition: unmet.missingMessage, restoreSummary: false };
  }
  const unusable = await loadUnusableSummaryFactV1(taskFolderUri, stage);
  return unusable
    ? {
        precondition:
          "The last implementation round did not produce usable implementation notes, so there is " +
          `nothing to review it against. ${unusable.remedy}`,
        restoreSummary: unusable.canRestore,
      }
    : undefined;
}

/**
 * The label and consequence a resume button carries for `plan` — one plain
 * name for the action it will run, with the provider, never "re-run this
 * stage". `undefined` (the plan could not be loaded) still avoids the banned
 * wording rather than guessing an action.
 */
export function describeResumeOptionV1(plan: ResumeActionPlanV1 | undefined): {
  readonly label: string;
  readonly consequence: string;
} {
  // Pre-1.0.0 fixes register, item 22: name the action AND say whether it
  // edits code — a shared generic label/consequence here is exactly what let
  // "Resume and re-run this stage" dispatch an implementation round while
  // reading as a review re-run. What decides the outcome (an apply-review vs
  // a run-review) is whether a usable, fresh review already exists for this
  // stage (see planResumeActionV1 above) — stated here rather than guessed at.
  if (plan === undefined) {
    return {
      label: "Resume and run this stage's next action",
      consequence:
        "Resumes the task and dispatches the action its current stage calls for, through the same " +
        "admission-protected path a scheduled resume uses. Which action that is, and whether it edits " +
        "code, depends on whether a usable, fresh review already exists for this stage.",
    };
  }
  switch (plan.kind) {
    case "run-review":
      return {
        label: `${plan.label} — a review; it does not edit code`,
        consequence:
          "Resumes the task and immediately starts this review through the same admission-protected " +
          "path a scheduled resume uses — the task will not go active again without genuine work " +
          "arranged for it. A review reads the workspace and writes its own findings; it does not edit code.",
      };
    case "apply-review":
      return {
        label: `${plan.label} — runs an implementation round that edits code`,
        consequence:
          "Resumes the task and immediately starts applying the review through the same " +
          "admission-protected path a scheduled resume uses — the task will not go active again without " +
          "genuine work arranged for it. This runs an implementation round that edits the workspace to " +
          "address the review's findings.",
      };
    case "stage-default":
      return {
        label: plan.label,
        consequence:
          "Resumes the task and immediately starts this stage's own action through the same " +
          "admission-protected path a scheduled resume uses — the task will not go active again without " +
          "genuine work arranged for it. Whether that action edits code depends on the stage.",
      };
    case "resume-only":
      return {
        label: "Resume the task",
        consequence: `Resumes the task; nothing is dispatched. ${plan.reason}`,
      };
    case "blocked":
      return {
        label: "Resume (the task stays paused — a prerequisite is missing)",
        consequence: `No action can run yet: ${plan.precondition} Choosing this leaves the task paused and says so.`,
      };
  }
}

/**
 * The "Retry now" option of a provider-chain-exhausted card, carrying the
 * identity of the action that failed (v1 fixes 2, items 14 + 25). The chain that
 * exhausts belongs to a Review round — that is what `routeReviewOutcomeV1`
 * records it for — so the retry re-runs that Review, not whatever the stage's
 * default action happens to be. When the Review's own preconditions are unmet
 * the option is disabled and shows the failed precondition, never a button that
 * dispatches something the product already knows will be refused.
 *
 * Pure: `provider` is the display label of the provider chain's primary, when
 * resolvable.
 */
export function describeRetryFailedReviewV1(
  stage: TaskStage,
  provider: string | undefined,
  refusal: DispatchPreflightRefusalV1 | undefined
): {
  readonly label: string;
  readonly consequence: string;
  readonly disabled?: true;
  readonly disabledReason?: string;
} {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  if (refusal) {
    return {
      label: "Retry now (unavailable — a prerequisite is missing)",
      consequence: `The ${stageName} cannot run yet: ${refusal.precondition}`,
      disabled: true,
      disabledReason: refusal.precondition,
    };
  }
  return {
    label: `Retry now: ${withProvider(`run the ${stageName} again`, provider)}`,
    consequence:
      `Resumes the task and re-runs the ${stageName} — the action whose provider chain was exhausted — ` +
      "against the same provider chain.",
  };
}

/** Loads the facts {@link describeRetryFailedReviewV1} needs. A failed lookup degrades to an enabled option. */
export async function loadRetryFailedReviewOptionFieldsV1(
  taskFolderPath: string,
  stage: TaskStage
): Promise<ReturnType<typeof describeRetryFailedReviewV1>> {
  const [refusal, provider] = await Promise.all([
    preflightFixedDispatchV1(taskFolderPath, stage, "review").catch(() => undefined),
    providerLabelForStageV1(vscode.Uri.file(taskFolderPath), stage),
  ]);
  return describeRetryFailedReviewV1(stage, provider, refusal);
}
