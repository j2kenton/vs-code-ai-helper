/**
 * review1 Step 32 (review1 item 2): after a lost round, the recommended next step continues what was lost.
 *
 * bugs6 item 2: an Apply Review on Gemini Flash was cut off after 55 minutes, with 13 files changed and its review
 * still the latest. The stall card recommended "Resume and run the review again" (a fresh review of half-finished
 * code) and offered no way to continue the build. The card now reads the lost round's kind from the round ledger:
 * a lost editing round is continued from the working tree (its edits are kept), against the review it was working
 * from; only a lost review, or a review that is no longer the latest, recommends a review.
 *
 * Pure: the ledger and the settings-derived model list come in as plain data.
 */
import type { RoundLedgerEntryV1, TaskProgress, TaskStage } from "../types/taskProgress";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { formatProviderErrorV1 } from "./providerErrorFormatterV1";
import { classifyRoundEndingV1 } from "./taskProgressWatchV1";
import { describeProviderLimitPhraseV1 } from "./roundStopCauseV1";

const LOST_STATES: ReadonlySet<string> = new Set(["failed", "rejected", "interrupted", "quota-blocked"]);
const EDITING_MODES: ReadonlySet<string> = new Set(["implementation", "apply-review", "continuation"]);

export interface LostEditingRoundV1 {
  readonly roundId: string;
  readonly mode: RoundLedgerEntryV1["mode"];
  readonly state: RoundLedgerEntryV1["state"];
  /** The failure text the ledger recorded, when there is one. */
  readonly failure?: string;
  /** run1 Step 15: the cause the round's settlement recorded, when it recorded one. */
  readonly stopCause?: string;
  /** run1 Step 15: files the round's own stream shows it changed (never files it could not prove). */
  readonly attributedFileCount?: number;
  readonly stage: TaskStage;
  /** The Fast Forward run the round belonged to (its counters when it opened), from the round's ledger row. */
  readonly fastForwardRun?: { readonly attemptNumber: number; readonly maxAttempts: number };
  /**
   * The round's record says whether Fast Forward was running: it carries a run stamp, or it was opened by an
   * Ensemble that stamps every round (so no run stamp means it was not part of a run). False for a round opened
   * before stamps existed.
   */
  readonly fastForwardKnown: boolean;
}

/**
 * The editing round the task was left with, if the newest terminal ledger row is a lost Implementation, Apply
 * Review or continuation round and the stage has a review on record to continue against.
 */
export function findContinuableLostEditingRoundV1(
  progress: Pick<TaskProgress, "roundLedger" | "reviewScoreHistory">,
  stage: TaskStage
): LostEditingRoundV1 | undefined {
  const terminal = (progress.roundLedger ?? [])
    .filter((row) => row.state !== "scheduled" && row.state !== "open")
    .sort((a, b) => Date.parse(a.endedAt ?? a.startedAt) - Date.parse(b.endedAt ?? b.startedAt));
  const last = terminal[terminal.length - 1];
  if (!last || !LOST_STATES.has(last.state) || !EDITING_MODES.has(last.mode)) return undefined;
  const hasReview = (progress.reviewScoreHistory ?? []).some((entry) => entry.stage === stage);
  if (!hasReview) return undefined;
  return {
    roundId: last.roundId,
    mode: last.mode,
    state: last.state,
    stage,
    ...(last.outcome?.rejectionReason !== undefined ? { failure: last.outcome.rejectionReason } : {}),
    ...(last.outcome?.stopCause !== undefined ? { stopCause: last.outcome.stopCause } : {}),
    ...((last.outcome?.attributedFiles?.length ?? 0) > 0 ? { attributedFileCount: last.outcome?.attributedFiles?.length ?? 0 } : {}),
    ...(last.fastForwardRunV1 ? { fastForwardRun: last.fastForwardRunV1 } : {}),
    fastForwardKnown: last.fastForwardRunV1 !== undefined || last.fastForwardStampedV1 === true,
  };
}

/** Stops that name nothing wrong with the model: Ensemble's own, a provider's per-turn cap, and a lone repeat stop. */
const NOT_A_REPEATING_STOP_V1: ReadonlySet<string> = new Set([
  "ensembleBackstop",
  "ensembleIdleStop",
  "ensembleEndOfTurn",
  "ensembleRepeatStop",
  "providerTimeCap",
  "processEnded",
]);

/** A failure that will repeat on the same model: a usage limit or a sign-in problem (see below for time limits). */
export function failureWillRepeatV1(
  state: RoundLedgerEntryV1["state"],
  failure: string | undefined,
  stopCause?: string,
  attributedFileCount = 0
): boolean {
  // run1 Step 15: Ensemble's own stops (time limit, quiet stretch, a turn that did not exit, one repeat stop) and
  // a provider's per-turn time cap say nothing about the model, so they never recommend another one. A round
  // that was stopped while its own stream shows it changing files was making progress: continue from the
  // working tree. Only a provider limit or a sign-in failure is a failure that will repeat.
  if (stopCause !== undefined && NOT_A_REPEATING_STOP_V1.has(stopCause)) return false;
  const kind = classifyRoundEndingV1(state, failure, new Date(), stopCause).kind;
  if (kind === "cut-off" && attributedFileCount > 0) return false;
  if (kind === "cut-off" || kind === "quota") return kind === "quota" || stopCause === undefined;
  return /\b(sign(?:ed)?[- ]?in|log(?:ged)?[- ]?in|authenticat|unauthori[sz]ed|401|403|expired token|api key)\b/i.test(failure ?? "");
}

export interface LostRoundCardInputV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly lost: LostEditingRoundV1;
  /** The Apply Review label the resume plan chose (names the provider). */
  readonly continueLabel: string;
  /** Stored model ids in the stage's chain, primary first. */
  readonly chainModels: readonly string[];
  /** The model the lost round ran on, when the ledger knew it. */
  readonly lostModel?: string;
  /**
   * The latest review is clean (0 blockers). A clean review never gets Apply Review recommended, whether or not
   * plan items remain open or provisional: that is a fact about the review alone.
   */
  readonly reviewClean?: boolean;
  /**
   * The plan gate is complete (nothing open or provisional). With a clean review there is then nothing for Apply
   * Review to act on, so the option is not offered at all.
   */
  readonly gateComplete?: boolean;
  /** A Fast Forward run's captured counters, so continuing resumes that run (`resumeFromAttemptV1`). */
  readonly resumeFastForward?: unknown;
  /**
   * A resume payload for a lost round whose record cannot say whether Fast Forward was running (it was opened
   * before rounds were stamped). Offered as a separate, owner-chosen option beside the one-cycle continue; never
   * used when `resumeFastForward` is known.
   */
  readonly offerFastForwardStart?: unknown;
}

function failureSentence(lost: LostEditingRoundV1): string {
  const readable = lost.failure !== undefined ? formatProviderErrorV1(lost.failure, { maxChars: 200 }) : undefined;
  const what =
    lost.mode === "apply-review" ? "Apply Review" : lost.mode === "continuation" ? "continuation round" : "Implementation round";
  const how =
    lost.state === "interrupted"
      ? "was interrupted"
      : lost.state === "quota-blocked"
        ? // A limit is named only when the provider's own text is on record; "usage limit" only when that text
          // says so (the shared stop wording decides). With no text, nothing claims a limit.
          lost.failure !== undefined && lost.failure.trim() !== ""
          ? `hit a ${describeProviderLimitPhraseV1(lost.failure)}`
          : "was stopped by the provider (no reason was recorded)"
        : lost.state === "rejected"
          ? "ended with a rejected report"
          : "failed";
  return `The ${what} ${how}${readable ? `: ${readable}` : ""}. Its edits are kept in the working tree.`;
}

/** The text and the options for the stalled-task card when the lost round was an editing round. */
export function buildLostEditingRoundCardPartsV1(input: LostRoundCardInputV1): {
  readonly sentence: string;
  readonly options: readonly WorkflowDecisionOptionV1[];
  readonly recommendation: WorkflowDecisionRecommendationV1;
} {
  const stageName = STAGE_DISPLAY_NAMES[input.stage] ?? input.stage;
  const taskArg = { taskFolderPath: input.taskFolderPath };
  const repeats = failureWillRepeatV1(
    input.lost.state,
    input.lost.failure,
    input.lost.stopCause,
    input.lost.attributedFileCount ?? 0
  );
  const others = input.chainModels.filter((model) => model !== input.lostModel);
  const options: WorkflowDecisionOptionV1[] = [];

  const reviewClean = input.reviewClean === true;
  const fastForwardUnknown = input.resumeFastForward === undefined && input.offerFastForwardStart !== undefined;
  if (!(reviewClean && input.gateComplete === true)) {
    const oneCycle: WorkflowDecisionOptionV1 = {
      optionId: "continueLostRound",
      resumeKind: "continue",
      label: input.continueLabel,
      consequence:
        `Resumes the task and runs Apply Review again against the same ${stageName}, from the working tree as the lost round left it ` +
        "(its edits are kept, nothing is restored or redone), then re-reviews. " +
        (input.resumeFastForward !== undefined ? "It resumes the Fast Forward run this was part of." : "It runs one cycle and stops."),
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
        // The resume plan reads the lost round off the ledger itself (`loadResumeActionPlanV1`), so no flag is needed.
        args: [{ taskFolderPath: input.taskFolderPath, ...(input.resumeFastForward !== undefined ? { resumeFastForwardV1: input.resumeFastForward } : {}) }],
      },
      recordedNext: "Apply Review continues from the working tree",
    };
    if (fastForwardUnknown) {
      // The record cannot say whether the lost round was part of a Fast Forward run. The Fast Forward continue
      // comes first and is the recommended one (it keeps the run if there was one); the one-cycle option stays
      // beside it, with its consequence saying it stops after one cycle.
      options.push({
        optionId: "continueLostRoundWithFastForward",
        resumeKind: "continue",
        label: `${input.continueLabel} and keep going with Fast Forward`,
        consequence:
          `Resumes the task and runs Apply Review again against the same ${stageName}, from the working tree as the lost round left it ` +
          "(its edits are kept), then keeps going as a new Fast Forward run from its first iteration. This record cannot say whether the lost " +
          "round was part of a Fast Forward run (it started before Ensemble kept that); this keeps the run if there was one.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
          args: [{ taskFolderPath: input.taskFolderPath, resumeFastForwardV1: input.offerFastForwardStart }],
        },
        recordedNext: "Apply Review continues from the working tree, then Fast Forward keeps going",
      });
    }
    options.push(oneCycle);
  }
  if (repeats) {
    options.push({
      optionId: "changeModel",
      resumeKind: "unpause",
      label: others.length > 0 ? "Continue on another model — choose it in AI Models" : "No other model is enabled for this stage",
      consequence:
        others.length > 0
          ? `That failure repeats on the same model, so continuing there is likely to fail the same way. Other models enabled for ${stageName}: ${others.join(", ")}. This opens AI Models on the stage; switch the model there, then continue.`
          : `That failure repeats on the same model, and no other model is enabled for ${stageName}. This opens AI Models so you can enable one.`,
      effect: { kind: "command", command: "vs-code-ai-helper.openAiModels", args: [input.stage] },
      recordedNext: "AI Models is open on this stage",
    });
  }
  options.push({
    optionId: "freshReview",
    resumeKind: "continue",
    label: "Run a fresh review",
    consequence: `Resumes the task and re-reviews ${stageName} against the working tree as it stands (including the lost round's edits). A review reads the workspace and writes its findings; it does not edit code.`,
    effect: { kind: "command", command: "vs-code-ai-helper.resumeAndRerunReview", args: [taskArg] },
    recordedNext: "the review runs again",
  });
  options.push({
    optionId: "handleMyself",
    resumeKind: "unpause",
    label: "Leave it paused — I'll review it first",
    consequence: "Leaves the task paused; nothing is dispatched. The lost round's edits stay in the working tree.",
    effect: { kind: "doNothing" },
  });

  const recommendation: WorkflowDecisionRecommendationV1 =
    reviewClean
      ? {
          kind: "none",
          reasoning:
            input.gateComplete === true
              ? "The latest review is clean and every plan item is settled, so Apply Review has nothing to act on. Review the lost round's edits yourself, or run a fresh review."
              : "The latest review is clean, so Apply Review is not recommended; plan items are still open, but that is for you to weigh. Run a fresh review of the lost round's edits, or continue the build yourself.",
        }
      : fastForwardUnknown
        ? {
            kind: "option",
            optionId: "continueLostRoundWithFastForward",
            reasoning:
              "The review is still the latest and the lost round's edits are in the working tree, so continuing finishes that work. " +
              "This task's record cannot say whether the lost round was part of a Fast Forward run; continuing with Fast Forward " +
              "keeps that run if it was, so nothing is lost by it, while the one-cycle option stops after one cycle." +
              (repeats && others.length > 0 ? " Because the failure repeats on the same model, consider switching first." : ""),
          }
        : {
          kind: "option",
          optionId: "continueLostRound",
          reasoning: repeats
            ? `The review is still the latest and the lost round's edits are in the working tree, so continuing finishes that work${others.length > 0 ? "; because the failure repeats on the same model, consider switching first" : ""}.`
            : "The review is still the latest and the lost round's edits are in the working tree, so continuing finishes that work; a fresh review would only re-list the same blockers on half-finished code.",
        };
  return { sentence: failureSentence(input.lost), options, recommendation };
}
