import * as vscode from "vscode";
import {
  EscalationKind,
  IMPL_REVIEW_STAGES,
  ImplementationDispatchModeV1,
  PLAN_FILENAME,
  RoundOutcomeEntryV1,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordEscalation, updateTaskStatus } from "./taskProgressTransforms";
import { NotificationRouter } from "./notificationRouter";
import { normalizePath } from "./taskRoot";
import { readTextIfExists } from "./fileUtils";
import { BlockerResolver, ReviewBlocker } from "./reviewReadiness";
import { normalizeReviewEvidenceV1 } from "./reviewEvidenceNormalizerV1";
import { PostWorkflowDecisionInputV1, postWorkflowDecisionV1 } from "./workflowDecisionDispatchV1";
import { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";

/** Minimal shape this module needs from ChatViewProvider — avoids importing
 * the view layer from a utils module (chatView.ts pulls in webview/vscode UI
 * machinery reviewActions.ts and its callers don't otherwise depend on). */
export interface EscalationChatTarget {
  ask(
    question: { canonicalId: string; taskFolderPath: string; stage: TaskStage; taskName?: string; question: string },
    forceOpen?: boolean,
    notify?: { blocking?: boolean; blockedReason?: string }
  ): Promise<void>;
}

let chatTarget: EscalationChatTarget | undefined;

/**
 * Item 7b — the data a "plateau" (review-stuck) escalation needs to build a
 * `WorkflowDecisionV1` instead of a plain chat question naming only the
 * taxonomy of reasons automation can be stuck (environmental, unverifiable,
 * spec-defect, needs-toolchain) rather than the actual blocker. Supplied only
 * by review-stage plateau call sites that have this in hand from the round
 * that just published (`reviewActions.ts`'s `handleReviewRoutingOutcome`) —
 * the implementation-side no-progress breaker (a different phenomenon: zero
 * file changes across rounds, not a review's blocker list) does not have this
 * shape and keeps using the plain chat-question path below.
 */
export interface ReviewPlateauEvidenceV1 {
  /** The just-published review's raw markdown — consulted only for its
   * `<!-- progress: N/M -->` marker (see `normalizeReviewEvidenceV1`). */
  readonly content: string;
  readonly blockers: readonly ReviewBlocker[];
  readonly taskFixableCount: number;
  /**
   * `TaskProgress.roundOutcomes` for THIS stage, oldest-first, exactly as
   * recorded (item 17's `RoundOutcomeEntryV1.dispatchMode`) — not yet reduced
   * to "last N". Supplied by the caller because it already has the freshly
   * patched `TaskProgress` in hand; {@link recentDispatchModesForStageV1}
   * does the stage-filtering/windowing here so every call site does not have
   * to repeat it. Absent (older call sites, or a caller with no `TaskProgress`
   * handy) simply omits the evidence line below — a plateau escalation must
   * never fail to post for lack of this.
   */
  readonly stageRoundOutcomes?: readonly RoundOutcomeEntryV1[];
}

/** Last `limit` `dispatchMode`s recorded for `stage`, oldest-first, from
 * `TaskProgress.roundOutcomes` — the evidence a plateau escalation needs to
 * tell a DISPATCH plateau (the loop kept choosing Implementation against a
 * blocker only Apply Review can fix — see `detectPlateau`'s doc comment) from
 * a genuine WORK plateau apart. `undefined` entries (rows written before
 * `dispatchMode` existed) render as `"unknown"` rather than being dropped, so
 * the count of rounds shown still matches what actually ran.
 *
 * **Review blocker, 2026-08-26.** A zero-change/gate implementation round is
 * deliberately bookkept under the literal stage `"impl"` regardless of which
 * impl-review stage the task is currently displaying — see the
 * `appendRoundOutcome` call sites in `reviewActions.ts` (`gateStage`/
 * `implBookkeepingStage`), which exist so the fallback-provider breaker and
 * candidate-skip machinery can find a round dispatched while the task sits
 * on a review stage. A plain `entry.stage === stage` filter therefore made
 * every such round invisible to an `impl-high-review`/`impl-low-review`
 * card's "recent dispatch modes" evidence — undercounting exactly the rounds
 * most likely to show a dispatch plateau. For either impl-review stage, also
 * match rows stored under `"impl"`, merged back into the same chronological
 * (not `.slice(-limit)`-per-stage) window.
 *
 * **Review fix, 2026-08-27 (narrowed blocker 2).** A literal-"impl" row now
 * carries `originatingReviewStage` naming which of the two impl-review
 * stages was actually active when it was dispatched (see the comment on
 * `RoundOutcomeEntryV1.originatingReviewStage`). A literal-"impl" row is
 * merged into `stage`'s evidence only when `originatingReviewStage` is
 * either absent (older rows written before this field existed — kept
 * visible rather than silently dropped, matching this function's existing
 * policy of rendering an unknown `dispatchMode` as `"unknown"` instead of
 * excluding the round) or equal to `stage` — never when it names the OTHER
 * impl-review stage. This is what stops an `impl-low-review` plateau card
 * from absorbing a round that ran while the task displayed
 * `impl-high-review`, and vice versa. */
function mergedRecentDispatchEntriesForStageV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit: number
): readonly {
  readonly dispatchMode: ImplementationDispatchModeV1 | undefined;
  /** True when this entry is a literal-"impl" row merged into `stage`'s
   * evidence solely because it predates `originatingReviewStage` (an older
   * row, absent the field) — its true stage cannot be determined, so it is
   * shown in BOTH impl-review stages' evidence rather than either. */
  readonly originAmbiguous: boolean;
}[] {
  const isImplReviewStage = IMPL_REVIEW_STAGES.includes(stage);
  const matchesStage = isImplReviewStage
    ? (entry: RoundOutcomeEntryV1): boolean =>
        entry.stage === stage ||
        (entry.stage === "impl" &&
          (entry.originatingReviewStage === undefined || entry.originatingReviewStage === stage))
    : (entry: RoundOutcomeEntryV1): boolean => entry.stage === stage;
  return (roundOutcomes ?? [])
    .filter(matchesStage)
    .slice(-limit)
    .map((entry) => ({
      dispatchMode: entry.dispatchMode,
      originAmbiguous:
        isImplReviewStage && entry.stage === "impl" && entry.originatingReviewStage === undefined,
    }));
}

export function recentDispatchModesForStageV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit = 5
): readonly (ImplementationDispatchModeV1 | undefined)[] {
  return mergedRecentDispatchEntriesForStageV1(roundOutcomes, stage, limit).map(
    (entry) => entry.dispatchMode
  );
}

/**
 * True when {@link recentDispatchModesForStageV1}'s evidence window for
 * `stage` includes at least one literal-"impl" row recorded before
 * `originatingReviewStage` existed. That row's dispatch mode is merged into
 * BOTH impl-review stages' evidence (see the function above) because which
 * one it actually ran under cannot be determined from the data — a plateau
 * card's reader could otherwise mistake a mixed-origin count for a clean
 * same-stage history. Review blocker, 2026-08-27 (narrowed blocker 2):
 * "existing task history can still appear in both stage-specific evidence
 * windows without any indication that its origin is unknown" — this is the
 * indication; the merge policy itself (kept-visible over silently-excluded)
 * is unchanged and remains the documented, deliberate behavior.
 */
export function recentDispatchModesIncludeAmbiguousOriginV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit = 5
): boolean {
  return mergedRecentDispatchEntriesForStageV1(roundOutcomes, stage, limit).some(
    (entry) => entry.originAmbiguous
  );
}

function nextStageInOrderV1(stage: TaskStage): TaskStage | undefined {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 || index === STAGE_ORDER.length - 1 ? undefined : STAGE_ORDER[index + 1];
}

/**
 * Every `decisionKey` an escalation card can be posted under — the generic
 * `buildEscalationDecisionV1` card (`reviewEscalation:<kind>`, one per
 * {@link EscalationKind}) and the richer, evidence-led
 * `reviewPlateauEscalation` card `postReviewPlateauDecisionV1` posts for a
 * review-stage plateau with fresh blocker evidence in hand. Every escalation
 * pauses the task as part of raising it (`updateTaskStatus(..., "paused")`
 * above), so resuming the task is always the transition that ends whatever an
 * escalation card was asking — see `resumeTask.ts`'s `resumePausedTask`,
 * which clears `escalation` on resume and withdraws every one of these keys
 * in the same step (Part 11 item 13c, event-driven half).
 */
export const ESCALATION_DECISION_KEYS_V1: readonly string[] = [
  "reviewEscalation:plateau",
  "reviewEscalation:spec-defect",
  "reviewEscalation:environmental",
  "reviewPlateauEscalation",
];

/**
 * Shared "advance" option shape between `buildEscalationDecisionV1` (below)
 * and `postReviewPlateauDecisionV1`'s richer, evidence-led card — both name
 * the same option id, the same label, and the same `setTaskStage` effect; the
 * only thing that legitimately differs per caller is the consequence text
 * (the plateau card's is evidence-conditioned on whether `nextStage` has
 * already run once). Review blocker (2026-08-30): the two functions used to
 * construct this object independently at each call site, which is exactly
 * the "still independently builds its options" defect the review named —
 * this is the part of that duplication that was genuinely identical and
 * therefore safe to share without altering either card's rendered text.
 */
function buildAdvanceOptionV1(
  nextStage: TaskStage,
  taskFolderPath: string,
  consequence: string
): WorkflowDecisionOptionV1 {
  return {
    optionId: "advance",
    label: `Advance to ${STAGE_DISPLAY_NAMES[nextStage]}`,
    consequence,
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.setTaskStage",
      args: [{ taskFolderPath, stage: nextStage }],
    },
  };
}

/**
 * Shared "reconsiderRequirement" option shape — same rationale as
 * {@link buildAdvanceOptionV1}: both callers open plan-final.md's Accepted
 * Non-Goals section for the same reason (the requirement itself, not the
 * implementation, may need to change) and differ only in how specifically
 * the consequence text can name evidence for that (the plateau card knows
 * whether a `spec-defect`-classified blocker is actually present this round).
 */
function buildReconsiderRequirementOptionV1(
  taskFolderPath: string,
  consequence: string
): WorkflowDecisionOptionV1 {
  return {
    optionId: "reconsiderRequirement",
    label: "Change the plan instead",
    consequence,
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.openPlanNonGoals",
      args: [{ taskFolderPath }],
    },
  };
}

/**
 * The bounded, durable escalation shape used when a caller does not have a
 * freshly-published review's blocker evidence. Review-stage plateaus retain
 * their richer, evidence-led card below; implementation-side and
 * environmental escalations must still be answerable cards rather than a
 * paragraph whose reply is ambiguously consumed by stage chat.
 */
function buildEscalationDecisionV1(
  kind: EscalationKind,
  stage: TaskStage,
  reason: string,
  target: { canonicalId: string; taskFolderPath: string; taskName?: string }
): PostWorkflowDecisionInputV1 {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const nextStage = nextStageInOrderV1(stage);
  const environmental = kind === "environmental";
  const keepIterating: WorkflowDecisionOptionV1 = environmental
    ? {
        optionId: "keepIterating",
        label: "Switch this stage's model",
        consequence:
          "Opens AI Models so you can select a working model for this stage. The task stays paused until you resume it.",
        effect: { kind: "command", command: "vs-code-ai-helper.openAiModels" },
      }
    : {
        optionId: "keepIterating",
        label: "Keep iterating",
        consequence: IMPL_REVIEW_STAGES.includes(stage)
          ? `Resumes the task and reruns ${stageName}.`
          : "Resumes the task and dispatches its owed continuation or next implementation action.",
        effect: {
          kind: "command",
          // Not plain resumeTask: that only clears the pause, leaving
          // nothing running until some other trigger (auto-advance, a
          // scheduling sweep) happens to pick the task back up — on a
          // manually-answered plateau card that can silently strand the
          // task active-but-idle. resumeAndDispatchImplementationV1 resumes
          // AND dispatches runImplementationWithAI, which itself resolves
          // continuation vs Apply Review vs fresh Implementation.
          command: IMPL_REVIEW_STAGES.includes(stage)
            ? "vs-code-ai-helper.resumeAndRerunReview"
            : "vs-code-ai-helper.resumeAndDispatchImplementation",
          args: [{ taskFolderPath: target.taskFolderPath }],
        },
      };
  const options: WorkflowDecisionOptionV1[] = [
    ...(nextStage
      ? [
          buildAdvanceOptionV1(
            nextStage,
            target.taskFolderPath,
            `Accepts the current state and moves the task to ${STAGE_DISPLAY_NAMES[nextStage]}.`
          ),
        ]
      : []),
    keepIterating,
    {
      optionId: "handleMyself",
      label: "Leave it paused — I'll fix it",
      consequence: "Leaves the task paused and opens plan-final.md so you can review the plan and make the needed change yourself.",
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.openPlanFinal",
        args: [{ taskFolderPath: target.taskFolderPath }],
      },
    },
    buildReconsiderRequirementOptionV1(
      target.taskFolderPath,
      "Opens plan-final.md's Accepted Non-Goals section. The task stays paused while you review it."
    ),
  ];
  const recommendation: WorkflowDecisionRecommendationV1 = environmental
    ? {
        kind: "option",
        optionId: "keepIterating",
        reasoning: "This is an environmental failure, so changing this stage's model is the action available in Ensemble.",
      }
    : kind === "spec-defect"
      ? {
          kind: "option",
          optionId: "reconsiderRequirement",
          reasoning: "The reported issue is in the requirement rather than a change the implementation can make.",
        }
      : {
          kind: "option",
          optionId: "keepIterating",
          reasoning: "The task is paused and this is the action that returns it to a runnable state.",
        };
  return {
    decisionKey: `reviewEscalation:${kind}`,
    taskCanonicalId: target.canonicalId,
    stage,
    whatHappened: `${stageName} needs your decision: ${reason}`,
    whyUserNeeded: "Automation paused this task and cannot choose how to proceed on your behalf.",
    options,
    recommendation,
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: "This decision is holding the task paused until you choose how to proceed.",
    },
  };
}

/**
 * A backtick-quoted span inside a blocker's own description that looks like a
 * runnable command (starts with a recognized CLI verb) — e.g. a reviewer
 * writing `` `npm run check-competition-template-status` `` as part of the
 * blocker text. When present, naming it is strictly more useful than the
 * generic "no command in this product can run it" line, and — per the
 * review-narrowed blocker this exists to fix — that generic line is not even
 * true for a blocker that names its own remedy command.
 */
const COMMAND_LIKE_PREFIX_RE =
  /^(npm|npx|yarn|pnpm|node|git|python|python3|bash|sh|make|cargo|go|curl|vs-code-ai-helper\.)\b/i;

function extractNamedCommandV1(description: string): string | undefined {
  const spanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = spanRe.exec(description)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate && COMMAND_LIKE_PREFIX_RE.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const CLEARING_COMMAND_STOPWORDS_V1 = new Set([
  "about", "after", "again", "against", "always", "before", "being", "between",
  "cannot", "could", "every", "having", "however", "never", "other", "record",
  "recorded", "should", "still", "their", "there", "these", "those", "through",
  "under", "unless", "until", "which", "while", "with", "would",
]);

function significantWordsV1(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 5 && !CLEARING_COMMAND_STOPWORDS_V1.has(w)));
}

/**
 * Item 7b review fix (Step 27, 2026-08-25): `extractNamedCommandV1` alone
 * only sees a command the reviewer happened to quote INSIDE the blocker's
 * own one-line description. The task's richer evidence — the rest of the
 * SAME review round's markdown (a "Verified Checks" / "How to verify"
 * section, a named poll command, etc.) — may name the actual clearing
 * command for this blocker even when the blocker line itself does not quote
 * one. Falls back to scanning `reviewContent` line by line for a
 * command-like backtick span, keeping the one whose own line shares the most
 * significant vocabulary with the blocker description (at least one
 * five-plus-letter word in common) — a coarse correlation, not proof, but the
 * same standard `sharesSignificantOverlapV1` (reconcilePlanChecklist.ts) uses
 * elsewhere in this codebase for "these two are about the same thing".
 * Returns `undefined`, exactly as before, when nothing correlates.
 *
 * Review-narrowed (2026-08-25): scanning only the current round's review
 * markdown missed a command the APPROVED PLAN itself names — e.g. a plan's
 * own "How to verify" step quoting the exact poll command for an external
 * status this blocker is about. `additionalSources` lets a caller thread in
 * further markdown documents (currently: `plan.md`, the plan of record) to
 * search the same way, in the order given, without duplicating this scoring
 * logic per source. No task/project action-metadata registry exists
 * elsewhere in this codebase to search beyond these two document sources —
 * the four stage-chat actions (`STAGE_CHAT_ACTIONS`) are lifecycle
 * operations (complete stage, set stage, …), not clearing commands for an
 * external-status or infra blocker, so there is nothing further to add here
 * without inventing a metadata source that does not exist.
 */
function extractCorrelatedCommandV1(
  description: string,
  reviewContent: string | undefined,
  additionalSources: readonly (string | undefined)[] = []
): string | undefined {
  const direct = extractNamedCommandV1(description);
  if (direct) {
    return direct;
  }
  const blockerWords = significantWordsV1(description);
  if (blockerWords.size === 0) {
    return undefined;
  }
  let best: { command: string; score: number } | undefined;
  for (const source of [reviewContent, ...additionalSources]) {
    if (!source) {
      continue;
    }
    for (const line of source.split(/\r?\n/)) {
      const command = extractNamedCommandV1(line);
      if (!command) {
        continue;
      }
      const lineWords = significantWordsV1(line);
      let score = 0;
      for (const word of blockerWords) {
        if (lineWords.has(word)) {
          score += 1;
        }
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { command, score };
      }
    }
  }
  return best?.command;
}

/**
 * Sub-classifies an `environmental` blocker's actual clearing action from its
 * OWN description text, instead of assuming every environmental blocker is
 * an infra/sandbox/OS fix. Review-narrowed blocker `57e9485f-…-1`: that
 * blanket assumption is false for the plan's own observed cases — an owner
 * approving a policy (`[architectural] [environmental] the owner must
 * approve a complete tie policy…`) and a third-party status still pending
 * (`"Both submitted v3 templates remain PENDING at Meta"`) are both
 * classified `environmental` (no further automated round can move either
 * one) but neither is an infrastructure/sandbox/OS defect, and both DO have
 * a concrete human action, just not a code fix.
 */
function classifyEnvironmentalBlockerV1(description: string): "owner-decision" | "external-status" | "generic" {
  const OWNER_RE = /\bowners?\b/i;
  const APPROVAL_WORD_RE = /\b(approv\w*|decid\w*|decision|sign[- ]?off\w*)\b/i;
  if (OWNER_RE.test(description) && APPROVAL_WORD_RE.test(description)) {
    return "owner-decision";
  }
  const EXTERNAL_STATUS_RE = /\b(pending|awaiting|third[- ]?party|external (service|system|review|api))\b/i;
  if (EXTERNAL_STATUS_RE.test(description)) {
    return "external-status";
  }
  return "generic";
}

/**
 * Item 7b, review-narrowed blocker `-1`: the plateau escalation's "what
 * clears this" line used to name the union of every reason a blocker can be
 * non-task-fixable ("a human decision, an external system, or a toolchain
 * step") regardless of which one actually applies. `BlockerResolver`
 * (reviewReadiness.ts) already classifies each blocker into exactly one of
 * these — this derives the concrete clearing action from THAT classification
 * AND the blocker's own description text (not the resolver class alone,
 * which the review found conflates an owner-approval or third-party-status
 * case with a generic infra/sandbox/OS fix), naming an inline command when
 * the blocker itself quotes one, or (Step 27) elsewhere in the same round's
 * review markdown when it does not.
 */
function describeResolverClearingActionV1(
  resolver: BlockerResolver,
  description: string,
  stageName: string,
  reviewContent?: string,
  /** Review-narrowed (Step 27, 2026-08-25): the approved plan (`plan.md`),
   * searched the same way as `reviewContent` when the blocker itself and the
   * current review round's markdown name no command — see
   * `extractCorrelatedCommandV1`'s doc comment. */
  planContent?: string
): string {
  const namedCommand = extractCorrelatedCommandV1(description, reviewContent, [planContent]);
  switch (resolver) {
    case "environmental": {
      const kind = classifyEnvironmentalBlockerV1(description);
      if (kind === "owner-decision") {
        return (
          "an owner decision on the point described above — state it in this task's stage chat (it can record " +
          `the decision into the plan for you), then use "Keep iterating" to have ${stageName} re-verify.`
        );
      }
      if (kind === "external-status") {
        return (
          "a status change at an external system this task does not control — " +
          (namedCommand
            ? `run \`${namedCommand}\` to check current status, then `
            : "check its current status yourself, then ") +
          `use "Keep iterating" to have ${stageName} re-verify once it changes.`
        );
      }
      return (
        "an infrastructure, sandbox, or OS-level fix outside this task's code" +
        (namedCommand ? ` — run \`${namedCommand}\`, then ` : " — no command in this product can run it; address the underlying environment directly, then ") +
        `use "Keep iterating" to have ${stageName} re-verify.`
      );
    }
    case "unverifiable":
      return (
        "evidence the reviewer could not confirm within its own limits — supply what it says it could not see " +
        (namedCommand ? `(run \`${namedCommand}\`, gather the missing log, etc.) ` : "(run the missing check, gather the missing log, etc.) ") +
        `yourself, then use "Keep iterating" to have ${stageName} re-verify.`
      );
    case "spec-defect":
      return (
        'a change to the requirement itself, not the implementation — see "Change the plan instead" ' +
        "below; the acceptance criterion as written may not be satisfiable."
      );
    case "needs-toolchain":
      return (
        "running the project's own build/codegen/toolchain step from outside this task " +
        (namedCommand ? `(run \`${namedCommand}\`)` : "(e.g. a build or generator command)") +
        ` — the implementation stage cannot run it; do that yourself, then use "Keep iterating" to have ` +
        `${stageName} re-verify.`
      );
    case "task-fixable":
      return `another implementation round — use "Keep iterating" below.`;
  }
}

/**
 * Build and post the `reviewPlateauEscalation` decision (item 7b's target
 * shape): quote the blocker verbatim rather than its category taxonomy, show
 * the evidence automation is done (taskFixableCount, the progress marker),
 * recommend exactly one option with the reason it wins here, explain why each
 * rejected option is wrong in THIS instance, name what would clear the
 * blocker, and cite any `[narrowed:…]` lineage instead of implying no
 * iteration has made progress. Modeled on jester's
 * `check-competition-template-status.ts`, per the task's own worked example.
 *
 * Returns whether the decision was actually posted (no extension context
 * available is the one expected failure mode, mirroring every other
 * `postWorkflowDecisionV1` call site) — the caller falls back to the plain
 * chat-question path when this returns false, so an escalation is never
 * silently dropped just because this richer surface could not be posted.
 */
async function postReviewPlateauDecisionV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reason: string,
  evidence: ReviewPlateauEvidenceV1,
  target: { canonicalId: string; taskFolderPath: string; stage: TaskStage; taskName?: string }
): Promise<boolean> {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  // Review-flagged (2026-08-25, new architectural blocker): `evidence.blockers`
  // is always THIS round's own just-published finding (see
  // `ReviewPlateauEvidenceV1`'s doc comment) — the newest evidence that
  // exists for this stage. An OLDER `TaskProgress.blockerSupersessions` entry
  // records that some earlier, now-stale review artifact was resolved via
  // chat; it must never suppress a fresh round independently re-finding the
  // identically-worded blocker, since doing so previously let a genuinely
  // still-live blocker vanish from both this decision and
  // `reviewScoreHistory` permanently (the caller never persists a blocker
  // this function filtered out). `filterSupersededBlockersV1` is therefore
  // not called here — see its doc comment on why fresh review content is
  // never filtered by a supersession.
  const normalized = normalizeReviewEvidenceV1(evidence.content, evidence.blockers);
  const primaryBlocker = normalized.blockers[0];
  const narrowedRef =
    normalized.narrowedBlockers.length > 0 && normalized.narrowedBlockers[0]!.lineage?.kind === "narrowed"
      ? normalized.narrowedBlockers[0]!.lineage.refId
      : undefined;
  const narrowedNote =
    narrowedRef !== undefined
      ? ` This blocker has narrowed across rounds (declared \`[narrowed:${narrowedRef}]\`) — iteration IS making ` +
        "progress on it, it has simply not cleared yet."
      : "";
  const progressNote =
    normalized.progress !== null
      ? `${normalized.progress.complete} of ${normalized.progress.total} plan steps verified.`
      : "No plan-progress marker was reported for this round.";

  const nextStage = nextStageInOrderV1(stage);
  const nextStageName = nextStage ? STAGE_DISPLAY_NAMES[nextStage] : undefined;
  let nextStageHasRun = false;
  if (nextStage) {
    const filename = STAGE_ARTIFACT_FILENAMES[nextStage];
    if (filename) {
      const nextContent = await readTextIfExists(vscode.Uri.joinPath(folderUri, filename));
      nextStageHasRun = nextContent !== undefined && nextContent.trim().length > 0;
    }
  }
  const hasSpecDefect = normalized.blockers.some((b) => b.resolver === "spec-defect");
  const blockerCountLabel = `${normalized.blockers.length} of the remaining ${normalized.blockers.length === 1 ? "blocker" : "blockers"}`;
  // Review-narrowed (Step 27, 2026-08-25): read the approved plan alongside
  // the review markdown so `describeResolverClearingActionV1` can also find
  // a clearing command the PLAN itself names (e.g. a "How to verify" step)
  // when neither the blocker line nor this round's review content quotes
  // one — see `extractCorrelatedCommandV1`'s doc comment.
  const planContentForClearingNote = await readTextIfExists(vscode.Uri.joinPath(folderUri, PLAN_FILENAME));
  // Item 7b rule 5, "name what would clear the blocker, with the command if
  // one exists": when something is task-fixable, the clearing action IS
  // re-running the review (which "Keep iterating" now genuinely does — see
  // resumeAndRerunReviewV1's doc comment); when nothing is, no command in
  // this product can clear it, only an action outside the task.
  const clearingNote =
    evidence.taskFixableCount > 0
      ? `Clears via: choose "Keep iterating" below — it resumes the task and re-runs ${stageName} against the ` +
        `${evidence.taskFixableCount} task-fixable ${evidence.taskFixableCount === 1 ? "blocker" : "blockers"}.`
      : primaryBlocker
        ? `Clears via: ${describeResolverClearingActionV1(primaryBlocker.resolver, primaryBlocker.description, stageName, evidence.content, planContentForClearingNote)}`
        : "Clears via: an action outside this task — no command in this product can resolve it. Once done, " +
          `"Keep iterating" resumes the task and re-runs ${stageName} to confirm.`;

  const options: WorkflowDecisionOptionV1[] = [
    ...(nextStage
      ? [
          buildAdvanceOptionV1(
            nextStage,
            folderUri.fsPath,
            nextStageHasRun
              ? `Moves the task to ${nextStageName}, which has already run once for this task — this accepts the ` +
                "current state as good enough to proceed rather than re-reviewing it here."
              : `Moves the task to ${nextStageName}, which hasn't run yet and covers different ground — it will ` +
                `not necessarily re-find this same blocker the way another ${stageName} round would.`
          ),
        ]
      : []),
    {
      optionId: "keepIterating",
      label: "Keep iterating",
      consequence:
        evidence.taskFixableCount > 0
          ? `Resumes the task and reruns ${stageName} — ${evidence.taskFixableCount} of the ${normalized.blockers.length} ` +
            "remaining blocker(s) are task-fixable, so another round has real work to act on."
          : `Resumes the task and reruns ${stageName} — nothing to act on: 0 of the ${normalized.blockers.length} ` +
            "remaining blocker(s) are task-fixable.",
      // resumeAndRerunReviewV1, not plain resumeTask: a prior revision
      // dispatched resumeTask alone (which only clears the pause) while this
      // consequence text claimed it "reruns" the stage — a review flagged
      // the button as not doing what it said. This command actually resumes
      // AND re-dispatches the review, matching the text above.
      effect: {
        kind: "command" as const,
        command: "vs-code-ai-helper.resumeAndRerunReview",
        args: [{ taskFolderPath: folderUri.fsPath }],
      },
    },
    {
      optionId: "handleMyself",
      label: "Leave it paused — I'll fix it",
      consequence:
        "Leaves the task paused, exactly like \"Change the plan instead\" below — nothing is dispatched. " +
        "Choose this if you disagree the blocker is outside automation's control, or want to make a fix (or a " +
        "decision only you can make) yourself before resuming.",
      effect: { kind: "doNothing" },
    },
    buildReconsiderRequirementOptionV1(
      folderUri.fsPath,
      hasSpecDefect
        ? "Leaves the task paused and opens plan-final.md's Accepted Non-Goals section — nothing else is " +
          "dispatched. At least one remaining blocker here is classified spec-defect — check the plan's " +
          "non-goals and prior decisions; it may be asking for something no implementation can satisfy as " +
          "written."
        : "Leaves the task paused and opens plan-final.md's Accepted Non-Goals section — nothing else is " +
          "dispatched. No remaining blocker this round is classified spec-defect, so there is no specific " +
          "evidence the requirement itself is unsound in this instance — pick this only if you have reason to " +
          "believe otherwise despite that."
    ),
  ];

  const recommendation: WorkflowDecisionRecommendationV1 = hasSpecDefect
    ? {
        kind: "option",
        optionId: "reconsiderRequirement",
        reasoning:
          "A remaining blocker this round is classified spec-defect — that is exactly the shape where the " +
          "requirement, not the implementation, is what needs to change.",
      }
    : evidence.taskFixableCount > 0
      ? {
          kind: "option",
          optionId: "keepIterating",
          reasoning: `${blockerCountLabel} are still task-fixable, so another round has real work to do.`,
        }
      : nextStage && !nextStageHasRun
        ? {
            kind: "option",
            optionId: "advance",
            reasoning:
              `Every remaining blocker is non-task-fixable and ${nextStageName} hasn't run yet — further ` +
              `${stageName} rounds will most likely re-find this same blocker, while ${nextStageName} covers ` +
              "different ground.",
          }
        : {
            kind: "option",
            optionId: "handleMyself",
            reasoning:
              `Every remaining blocker is non-task-fixable${nextStage ? ` and ${nextStageName} has already run` : ""}` +
              ", so this needs a human decision or action, not more automated iteration.",
          };

  // Item 18 / review blocker (2026-08-26): a frozen `taskFixableCount` while
  // every recent round dispatched as `implementation` is a DISPATCH plateau
  // (Implementation only reads the checklist, so it structurally cannot move
  // the count — see `detectPlateau`'s doc comment), not evidence the problem
  // itself resists every action tried. Surfacing the modes lets the human
  // reading this card tell the two apart at a glance instead of having to
  // dig through run logs.
  const recentModes = recentDispatchModesForStageV1(evidence.stageRoundOutcomes, stage);
  // Review blocker, 2026-08-27 (narrowed blocker 2, second half): flag when
  // this window includes a legacy round whose true impl-review stage is
  // unknown — see `recentDispatchModesIncludeAmbiguousOriginV1`'s doc
  // comment. Without this, a mixed-origin count read as a clean same-stage
  // history with no indication otherwise.
  const hasAmbiguousOriginModes = recentDispatchModesIncludeAmbiguousOriginV1(
    evidence.stageRoundOutcomes,
    stage
  );
  const dispatchModeEvidence =
    recentModes.length > 0
      ? [
          {
            label: "Recent dispatch modes (oldest → newest)",
            detail:
              recentModes.map((mode) => mode ?? "unknown").join(", ") +
              (hasAmbiguousOriginModes
                ? " — includes round(s) recorded before per-stage attribution existed; their true impl-review stage is unknown, so they are shown here and in the other impl-review stage's evidence alike"
                : ""),
          },
        ]
      : [];

  const decision = await postWorkflowDecisionV1(
    {
      decisionKey: "reviewPlateauEscalation",
      taskCanonicalId: target.canonicalId,
      stage,
      whatHappened:
        `${stageName} can't progress on its own. ` +
        (primaryBlocker
          ? `${normalized.blockers.length === 1 ? "One blocker remains" : `${normalized.blockers.length} blockers remain`}` +
            `, and here is the first one, verbatim:\n\n"${primaryBlocker.description}"${narrowedNote}`
          : reason),
      whyUserNeeded:
        `Automation has done what it can here — ${progressNote} ${evidence.taskFixableCount} of the ` +
        `${normalized.blockers.length} remaining blocker(s) are task-fixable.`,
      options,
      recommendation,
      evidence: [{ label: "What clears this", detail: clearingNote }, ...dispatchModeEvidence],
      gating: {
        holdsTaskPaused: true,
        unblocksProgress: true,
        detail:
          "This decision is what is holding the task paused — resolving it with \"Advance\" or \"Keep iterating\" " +
          "resumes or advances the task immediately; \"Leave it paused — I'll fix it\" and \"Change the plan " +
          "instead\" both leave it paused and dispatch nothing.",
      },
    },
    target
  );
  return decision !== undefined;
}

/** Wire the Chat With AI provider so escalations can post a real question
 * there, not just a notification. Call once from extension.ts, mirroring
 * initNotificationRouter's singleton pattern. */
export function initReviewEscalationChat(provider: EscalationChatTarget): void {
  chatTarget = provider;
}

/**
 * Stop automated review iteration for this task and hand the decision to
 * the human: pause the task (the existing per-command paused guards then
 * starve the automation chain naturally — see stageTransition.ts and every
 * review command's entry check), record why, and surface it through every
 * channel a user might notice it from — Chat With AI (if wired), a
 * Notifications warning with a one-click way back in, and (via the
 * persisted `escalation` field) the task tree's stage description.
 *
 * Never throws: escalation is a best-effort notification path layered on
 * top of the existing review pipeline, and a failure here must not prevent
 * the review that triggered it from having already published successfully.
 *
 * Returns whether the pause/escalation record actually applied. Any of the
 * three write guards below (terminal-status, stage CAS, attempt CAS) can
 * silently decline the write — callers MUST check this before treating the
 * round as escalated: a declined write means no pause, no recorded reason,
 * no notification, and no chat question, so a caller that assumed success
 * anyway would suppress its own auto-advance/auto-publish dispatch for a
 * round that produced no visible outcome at all — a review that publishes,
 * records nothing, says nothing, and advances nothing.
 *
 * `extraMutation`, when supplied, is folded into the SAME
 * `patchTaskProgressStrictV1` transaction as the pause/escalation write —
 * applied only once the three CAS guards above have already decided to
 * apply (never on a declined write, and never as a separate patch a crash
 * could land between). Use this for state that must be durably true the
 * instant the task is paused for this reason (e.g. a remedy latch the
 * escalation reason names) rather than issuing a second
 * `patchTaskProgressStrictV1` call after this one returns.
 */
export async function escalateReviewToHuman(
  folderUri: vscode.Uri,
  stage: TaskStage,
  kind: EscalationKind,
  reason: string,
  reviewAttemptId: string | undefined,
  progressHint?: Pick<TaskProgress, "displayName">,
  secondOpinionAttempted = false,
  extraMutation?: (current: TaskProgress) => TaskProgress,
  /**
   * Item 7b: when `kind === "plateau"` and the caller has this in hand (a
   * review-stage plateau, not the implementation-side no-progress breaker —
   * see {@link ReviewPlateauEvidenceV1}'s doc comment), post the
   * `reviewPlateauEscalation` `WorkflowDecisionV1` instead of the plain chat
   * question below. Falls through to the plain question when omitted (every
   * non-plateau kind, and any plateau call site not yet supplying it) or when
   * posting the decision itself fails (no extension context available) — an
   * escalation must never go silent just because the richer surface could
   * not be posted.
   */
  reviewPlateauEvidence?: ReviewPlateauEvidenceV1
): Promise<boolean> {
  try {
    let applied = false;
    await patchTaskProgressStrictV1(folderUri, (current) => {
      // Terminal-status guard: a task the user has already completed or
      // archived must never be forced back to "paused" by an escalation
      // decision that was computed against an earlier, now-stale snapshot
      // (this callback can run well after the review round that triggered
      // it, e.g. after a second-opinion AI call). Idempotent on an
      // already-paused task — recording the (possibly updated) reason is
      // still useful there.
      if (current.status === "completed" || current.status === "archived") {
        return current;
      }
      // Stage CAS: only apply when the task is still on the stage this
      // escalation is about. If it has already advanced (or been reverted
      // to a different stage) since the review round that decided to
      // escalate, pausing it now — with a reason naming a stage it isn't on
      // anymore — would be confusing and would incorrectly halt progress
      // that has already legitimately moved on.
      if (current.currentStage !== stage) {
        return current;
      }
      // Attempt CAS: only apply when this is still the attempt that most
      // recently claimed the stage. claimReviewAttempt (reviewActions.ts)
      // overwrites `reviewAttemptId` at the START of every review round —
      // same stage or not — so a same-stage, cross-window race is
      // distinguishable from "nothing else happened": if window B started
      // a newer round on this same stage (e.g. while window A's escalation
      // was still mid-flight through its own second-opinion AI call),
      // `reviewAttemptId` has already moved on even though `currentStage`
      // hasn't. Applying window A's stale escalation in that case would
      // pause the task out from under window B's independent, still-live
      // attempt. The expected value is whatever the caller just read from
      // persisted state — including `undefined` for an implementation-stage
      // task, where the field is legitimately absent (the impl transition
      // clears it; see taskProgressFieldPolicyV1). An escalation computed
      // against an absent id therefore applies only while the id is STILL
      // absent: if a review round has claimed the stage since, the write
      // declines exactly as it does for a mismatched string. Callers that
      // read no persisted state at all should keep passing "" (which can
      // never match), not `undefined` — an unread expectation is not an
      // expectation of absence.
      if (current.reviewAttemptId !== reviewAttemptId) {
        return current;
      }
      applied = true;
      const paused = updateTaskStatus(
        recordEscalation(current, { stage, kind, reason, at: new Date().toISOString(), secondOpinionAttempted }),
        "paused"
      );
      return extraMutation ? extraMutation(paused) : paused;
    });
    if (!applied) {
      return false;
    }

    // Item 7b: a review-stage plateau with real evidence in hand gets the
    // WorkflowDecisionV1 rebuild (quoted blocker, taskFixableCount, progress
    // marker, a single ranked recommendation) instead of the plain chat
    // question below. Falls through on posting failure (no extension
    // context) rather than doubling up or going silent.
    if (kind === "plateau" && reviewPlateauEvidence) {
      const posted = await postReviewPlateauDecisionV1(
        folderUri,
        stage,
        reason,
        reviewPlateauEvidence,
        {
          canonicalId: normalizePath(folderUri.fsPath),
          taskFolderPath: folderUri.fsPath,
          stage,
          taskName: progressHint?.displayName,
        }
      );
      if (posted) {
        return true;
      }
    }

    // Every escalation with an extension context gets a durable decision
    // card. The specialized review-plateau card above remains the richer
    // path when fresh blocker evidence exists; this covers the two
    // implementation-side plateau callers and all environmental/spec-defect
    // callers that previously fell straight through to an unbound prose
    // question.
    const genericDecision = await postWorkflowDecisionV1(
      buildEscalationDecisionV1(kind, stage, reason, {
        canonicalId: normalizePath(folderUri.fsPath),
        taskFolderPath: folderUri.fsPath,
        taskName: progressHint?.displayName,
      }),
      {
        canonicalId: normalizePath(folderUri.fsPath),
        taskFolderPath: folderUri.fsPath,
        stage,
        taskName: progressHint?.displayName,
      }
    );
    if (genericDecision !== undefined) {
      return true;
    }

    const stageName = STAGE_DISPLAY_NAMES[stage];
    // Genuinely blocking (not just "here's a question, work continues"): the
    // task is paused above and automated review iteration will not resume on
    // its own — error level, not warning, per the "can't proceed without
    // user feedback" contract for hard-blocked automation.
    //
    // Item 13 (2026-08-18..20 workflow-defects batch): a `plateau` escalation
    // is NEVER ridden through (shouldRideThroughEscalationV1 excludes it
    // unconditionally — see reviewActions.ts), so for that kind the pause is
    // certain and the unqualified claim below is accurate. Every OTHER kind
    // CAN be ridden through by a Fast Forward run configured to continue
    // through escalations (ensemble.resilience.fastForwardSurvivesEscalation)
    // — this function has no visibility into whether such a run is what
    // triggered it, so it cannot know in advance whether the pause it just
    // wrote will still hold a moment later. Claiming an unconditional pause
    // for those kinds was misleading: the pause could be undone within
    // seconds by the very automation the message tells the user has stopped.
    // Both the chat question text and blockedReason below state the real,
    // conditional truth instead of a claim that isPaused's ride-through
    // branch may falsify immediately.
    const question = {
      canonicalId: normalizePath(folderUri.fsPath),
      taskFolderPath: folderUri.fsPath,
      stage,
      taskName: progressHint?.displayName,
      question:
        kind === "plateau"
          ? `Automated review iteration is stuck on ${stageName} and paused the task: ${reason}\n\n` +
            "How would you like to proceed — keep iterating (resume the task and I'll try again), make manual changes yourself, " +
            "reconsider the requirement itself (check the plan's non-goals and prior decisions — it may be asking " +
            "for something no implementation can satisfy as written), or accept the current state and advance anyway?"
          : `Automated review iteration is stuck on ${stageName} and paused the task: ${reason}\n\n` +
            "If a Fast Forward run is active with 'survive escalation' enabled, it may continue iterating to the " +
            "end of its current attempt budget before this pause takes effect (you'll see a follow-up notification " +
            "if so). Once the pause holds, how would you like to proceed — keep iterating (resume the task and " +
            "I'll try again), make manual changes yourself, reconsider the requirement itself (check the plan's " +
            "non-goals and prior decisions), or accept the current state and advance anyway?",
    };

    const blockedReason =
      kind === "plateau"
        ? `${stageName} is stuck: ${reason} The task has been paused — resume it once you've decided how to proceed.`
        : `${stageName} is stuck: ${reason} The task has been paused. If a Fast Forward run is active with ` +
          "'survive escalation' enabled, it may continue iterating to the end of its current attempt budget " +
          "before this pause takes effect (you'll see a follow-up notification if so) — otherwise, resume it " +
          "once you've decided how to proceed.";
    if (chatTarget) {
      // "vs-code-ai-helper.postStageQuestion" (registered in chatWithStage.ts)
      // routes straight to chatViewProvider.ask(question) — this task's own
      // conversation, not the unrelated Global Assistant. ask() raises the
      // error notification itself (centralized there — see chatView.ts) with
      // that same command as its action button; it only force-opens the
      // panel when nothing else is already open or this task's chat is
      // already the one showing (ask()'s own no-steal-focus rule), and this
      // call already force-opens it once at escalation time, so the button
      // mainly matters for a user who dismissed that and comes back later.
      await chatTarget.ask(question, true, { blocking: true, blockedReason });
    } else {
      // No chat surface wired up (e.g. escalation running outside a full
      // extension host) — fall back to a standalone notification so the
      // escalation is still never silent.
      NotificationRouter.showError(
        `Can't proceed without user feedback — ${question.taskName ?? question.taskFolderPath}: ${blockedReason}`,
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.postStageQuestion",
          title: "Open Chat",
          args: [question],
        }
      );
    }
    return true;
  } catch (error) {
    NotificationRouter.showWarning(
      `${STAGE_DISPLAY_NAMES[stage]} needs your input (${reason}), but recording the escalation failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
    // Whether the patchTaskProgress write itself landed before throwing is
    // not knowable from here. Report false (not escalated) rather than
    // guess true: the caller's fallback is to let its own independent
    // threshold-based advance/publish logic run, which is always safe,
    // whereas wrongly suppressing it because of an assumed-but-unconfirmed
    // pause would strand the round with no visible outcome at all.
    return false;
  }
}
