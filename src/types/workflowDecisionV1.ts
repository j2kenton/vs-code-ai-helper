/**
 * The reusable decision contract for Chat With AI (task: "Replace hidden
 * notification decision buttons with explained, selectable decisions").
 *
 * The workflow previously stopped and asked the user via a bare notification
 * action button (`Restore Prior Round`, `Mark Plan Checklist Reconciled`,
 * `Apply the reviewer's ticks?`) whose effect was not knowable before
 * pressing it. Every point where the workflow needs something from the user
 * falls into one of four cases:
 *
 *   1. System knows what to do, no permission needed — act and report, do
 *      not ask (a `WorkflowDecisionV1` should not exist for this case at
 *      all: removing the prompt is the correct migration).
 *   2. System knows what to do, permission needed (destructive / costly /
 *      hard to reverse) — state the recommendation, explain why, one-action
 *      confirm.
 *   3. Several valid options exist — enumerate them with consequences plus a
 *      recommendation and its reasoning.
 *   4. The system genuinely cannot decide — present the evidence it does
 *      hold (`evidence`) so the user's judgement is informed, and say so
 *      explicitly via a `{ none: true }` recommendation rather than fake one.
 *
 * A record is a testable contract, not free-form prose: `createWorkflowDecisionV1`
 * rejects anything missing the four required elements (what happened, why the
 * user is needed, options with consequences, a recommendation-or-explicit-none)
 * and rejects any `destructive` option whose consequence text is empty — a
 * destructive option must say what it destroys.
 */

import { TaskStage } from "./taskProgress";

/** One selectable effect of choosing a decision's option. */
export type WorkflowDecisionOptionEffectV1 =
  | { readonly kind: "command"; readonly command: string; readonly args?: readonly unknown[] }
  /** A legitimate "do nothing" choice — resolves the decision without dispatching anything. */
  | { readonly kind: "doNothing" };

export interface WorkflowDecisionOptionV1 {
  readonly optionId: string;
  readonly label: string;
  /** What choosing this option actually does — always shown to the user. */
  readonly consequence: string;
  /** True when this option discards work or is otherwise hard to reverse. */
  readonly destructive?: boolean;
  readonly effect: WorkflowDecisionOptionEffectV1;
}

/** Either a specific recommended option with its reasoning, or an explicit "no basis to recommend". */
export type WorkflowDecisionRecommendationV1 =
  | { readonly kind: "option"; readonly optionId: string; readonly reasoning: string }
  | { readonly kind: "none"; readonly reasoning: string };

/** One piece of evidence the system already holds, surfaced for a case-4 (human-judgement) decision. */
export interface WorkflowDecisionEvidenceItemV1 {
  readonly label: string;
  readonly detail: string;
}

export type WorkflowDecisionStateV1 = "pending" | "resolved" | "dismissed" | "superseded";

export interface WorkflowDecisionV1 {
  readonly decisionId: string;
  /**
   * Stable key identifying this decision's *kind* for a given task (e.g.
   * "reconcilePlanChecklist", "restoreRejectedImplementationRound"). Reposting
   * a decision under the same key + task supersedes the earlier pending one
   * (`workflowDecisionStoreV1.ts`'s `post`) rather than accumulating stale
   * duplicates.
   */
  readonly decisionKey: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  /** The actual event, in plain language — not a code. */
  readonly whatHappened: string;
  /** What the system could not decide alone. */
  readonly whyUserNeeded: string;
  readonly options: readonly WorkflowDecisionOptionV1[];
  readonly recommendation: WorkflowDecisionRecommendationV1;
  /** Evidence the system already holds, for case-4 decisions (module header). */
  readonly evidence?: readonly WorkflowDecisionEvidenceItemV1[];
  readonly createdAt: string;
  readonly state: WorkflowDecisionStateV1;
  readonly resolvedOptionId?: string;
  readonly resolvedAt?: string;
}

export type CreateWorkflowDecisionResultV1 =
  | { readonly ok: true; readonly decision: WorkflowDecisionV1 }
  | { readonly ok: false; readonly reason: string };

export interface CreateWorkflowDecisionInputV1 {
  readonly decisionId: string;
  readonly decisionKey: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly whatHappened: string;
  readonly whyUserNeeded: string;
  readonly options: readonly WorkflowDecisionOptionV1[];
  readonly recommendation: WorkflowDecisionRecommendationV1;
  readonly evidence?: readonly WorkflowDecisionEvidenceItemV1[];
  readonly createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateOption(option: WorkflowDecisionOptionV1, index: number): string | undefined {
  if (!isNonEmptyString(option.optionId)) {
    return `option at index ${index} is missing a non-empty "optionId"`;
  }
  if (!isNonEmptyString(option.label)) {
    return `option "${option.optionId}" is missing a non-empty "label"`;
  }
  // Every option must state its consequence (this is the whole point of the
  // contract), and a destructive option gets no exemption — quite the
  // opposite, it is the case that most needs one. The check above already
  // covers destructive options (there is no separate exemption to check),
  // so there is no second destructive-specific branch here.
  if (!isNonEmptyString(option.consequence)) {
    return option.destructive === true
      ? `destructive option "${option.optionId}" must state its consequence`
      : `option "${option.optionId}" is missing a non-empty "consequence"`;
  }
  if (option.effect.kind === "command" && !isNonEmptyString(option.effect.command)) {
    return `option "${option.optionId}" has a "command" effect missing a non-empty command id`;
  }
  return undefined;
}

/**
 * Validate and construct a `WorkflowDecisionV1`. Fail-closed: rejects a
 * record missing any of the four required elements (what happened, why the
 * user is needed, at least one option with a consequence, a recommendation
 * or an explicit "no basis to recommend"), and rejects a destructive option
 * with no consequence text.
 */
export function createWorkflowDecisionV1(input: CreateWorkflowDecisionInputV1): CreateWorkflowDecisionResultV1 {
  if (!isNonEmptyString(input.decisionId)) {
    return { ok: false, reason: "a decision requires a non-empty \"decisionId\"" };
  }
  if (!isNonEmptyString(input.decisionKey)) {
    return { ok: false, reason: "a decision requires a non-empty \"decisionKey\"" };
  }
  if (!isNonEmptyString(input.taskCanonicalId)) {
    return { ok: false, reason: "a decision requires a non-empty \"taskCanonicalId\"" };
  }
  if (!isNonEmptyString(input.whatHappened)) {
    return { ok: false, reason: "a decision must explain what happened (\"whatHappened\")" };
  }
  if (!isNonEmptyString(input.whyUserNeeded)) {
    return { ok: false, reason: "a decision must explain why the user is needed (\"whyUserNeeded\")" };
  }
  if (input.options.length === 0) {
    return { ok: false, reason: "a decision requires at least one option" };
  }
  const seenOptionIds = new Set<string>();
  for (let i = 0; i < input.options.length; i++) {
    const option = input.options[i]!;
    const problem = validateOption(option, i);
    if (problem) {
      return { ok: false, reason: problem };
    }
    if (seenOptionIds.has(option.optionId)) {
      return { ok: false, reason: `duplicate option id "${option.optionId}"` };
    }
    seenOptionIds.add(option.optionId);
  }
  const { recommendation } = input;
  if (recommendation.kind === "option") {
    if (!seenOptionIds.has(recommendation.optionId)) {
      return {
        ok: false,
        reason: `recommendation references unknown option "${recommendation.optionId}"`,
      };
    }
    if (!isNonEmptyString(recommendation.reasoning)) {
      return { ok: false, reason: "a recommended option requires non-empty \"reasoning\"" };
    }
  } else if (recommendation.kind === "none") {
    if (!isNonEmptyString(recommendation.reasoning)) {
      return {
        ok: false,
        reason: "an explicit \"no recommendation\" requires non-empty \"reasoning\"",
      };
    }
  } else {
    return { ok: false, reason: "a decision requires a recommendation or an explicit \"none\"" };
  }
  if (!isNonEmptyString(input.createdAt) || Number.isNaN(Date.parse(input.createdAt))) {
    return { ok: false, reason: "a decision requires a valid \"createdAt\" timestamp" };
  }

  return {
    ok: true,
    decision: {
      decisionId: input.decisionId,
      decisionKey: input.decisionKey,
      taskCanonicalId: input.taskCanonicalId,
      stage: input.stage,
      whatHappened: input.whatHappened,
      whyUserNeeded: input.whyUserNeeded,
      options: input.options,
      recommendation,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      createdAt: input.createdAt,
      state: "pending",
    },
  };
}
