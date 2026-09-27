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
import { HandoffGatingV1 } from "./handoffGuidanceV1";

/** One selectable effect of choosing a decision's option. */
export type WorkflowDecisionOptionEffectV1 =
  | { readonly kind: "command"; readonly command: string; readonly args?: readonly unknown[] }
  /** A legitimate "do nothing" choice — resolves the decision without dispatching anything. */
  | { readonly kind: "doNothing" };

/**
 * Pre-1.0.0 fixes register, items 14 and 22: whether choosing this option
 * merely unpauses the task (dispatches nothing) or continues whatever
 * process was interrupted (a Fast Forward run, or the current stage's own
 * action). Required so every builder states it next to the option's label
 * and consequence, rather than the dispatcher inferring it from task state.
 * A persisted or mirrored record from before this field existed is defaulted
 * to `"unpause"` by `normalizeWorkflowDecisionV1` — the safe direction, since
 * an old record then never dispatches more than it did before.
 */
export type WorkflowDecisionResumeKindV1 = "unpause" | "continue";

export interface WorkflowDecisionOptionV1 {
  readonly optionId: string;
  readonly label: string;
  /** What choosing this option actually does — always shown to the user. */
  readonly consequence: string;
  /** See `WorkflowDecisionResumeKindV1`. */
  readonly resumeKind: WorkflowDecisionResumeKindV1;
  /** True when this option discards work or is otherwise hard to reverse. */
  readonly destructive?: boolean;
  readonly effect: WorkflowDecisionOptionEffectV1;
  /**
   * Set when the system already knows, at creation time, that this option's
   * effect will refuse if chosen right now (task "stage chat as a record of
   * work" item 14 / Part 12: "never render an option the system already
   * knows is wrong for the situation at hand" — the same rule item 10
   * established for options that can never help, extended here to options
   * that CAN help but cannot currently run). A disabled option is still
   * shown (so the user can see it exists and why it is unavailable) but
   * cannot be selected and — enforced below — can never be the
   * recommendation. `recommendationPreconditionsV1`
   * (`src/utils/recommendationPreconditionsV1.ts`) is the shared precondition
   * check `postWorkflowDecisionV1` runs against every option before posting.
   */
  readonly disabled?: boolean;
  /** Required when `disabled` is true — why, e.g. "resume the task first". */
  readonly disabledReason?: string;
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

export type WorkflowDecisionStateV1 = "pending" | "resolved" | "dismissed" | "superseded" | "withdrawn";

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
  /**
   * Hand-off contract field 6 (task: "Actionable Hand-offs", PART 5) — whether
   * resolving THIS decision actually unblocks task progress, so a user facing
   * several outstanding decisions can tell which one is gating without
   * inferring it (the reconciliation decision's worked example: it was
   * answered while the task stayed paused by an unrelated escalation, and
   * nothing said the two were different).
   *
   * Optional on the persisted type ONLY for backward compatibility with
   * records written before this field existed (every current production
   * creation site supplies it — see `workflowDecisionGatingInventoryV1.test.ts`).
   * Every renderer treats an absent value as an explicit "not recorded"
   * statement (`handoffGuidanceV1.ts`), never as "not gating".
   */
  readonly gating?: HandoffGatingV1;
  /**
   * v1 fixes 2, item 7: stable identity of the condition this decision asks
   * about plus the answers it offers (see `workflowDecisionIdentityV1`).
   * Set only when the poster opted in to answered-decision suppression.
   */
  readonly identity?: string;
  readonly createdAt: string;
  readonly state: WorkflowDecisionStateV1;
  readonly resolvedOptionId?: string;
  readonly resolvedAt?: string;
  /**
   * Set only when `state === "withdrawn"` — the SYSTEM's own reason the
   * card's triggering condition no longer holds (e.g. "the restored files
   * were already cleared" or "the plan's item set changed since this was
   * posted"), distinct from a user `dismiss` (which carries no reason at
   * all: the user simply declined to answer). Rendered verbatim as
   * "Withdrawn: <reason>" in the transcript (item 13c) so a card vanishing
   * from the panel is legible as "no longer applicable", not silence.
   */
  readonly withdrawnReason?: string;
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
  /**
   * Required for every NEW call site (task PART 5's creation-time guard).
   * Left optional on this input type, rather than a mandatory property,
   * because `createWorkflowDecisionV1` is also exercised directly by tests
   * validating its other required-shape rules independent of gating.
   *
   * The actual enforcement is `assertGatingRequirementV1`
   * (`src/utils/workflowDecisionDispatchV1.ts`), called by the single
   * dispatch chokepoint `postWorkflowDecisionV1` before any decision is
   * persisted: it throws unconditionally for any decision key that omits
   * `gating`, so a BRAND-NEW call site cannot silently omit it — a
   * source-grep audit alone could only ever check sites it already knew
   * about. `src/test/workflowDecisionGatingInventoryV1.test.ts` additionally
   * documents, per known source file, that every current production call
   * site supplies `gating` in source. `createWorkflowDecisionV1` still
   * validates the shape of whatever `gating` IS supplied, so a call site that
   * passes it cannot pass a malformed one.
   */
  readonly gating?: HandoffGatingV1;
  /**
   * v1 fixes 2, item 7 (release core): opt in to "an answered decision is not
   * re-posted". While the last settled decision for this key + task was
   * `resolved` with one of `answeredOptionIds` and carries the same identity
   * (`conditionFingerprint` + the enabled option ids), `post` is a no-op.
   * Only options that leave the condition standing belong in
   * `answeredOptionIds`: an answer that clears the condition makes any
   * recurrence a NEW condition, which must be asked again.
   */
  readonly suppressWhileAnswered?: {
    readonly conditionFingerprint: string;
    readonly answeredOptionIds: readonly string[];
  };
  readonly createdAt: string;
}

/**
 * Compatibility normalizer, applied at the store boundary
 * (`WorkflowDecisionStoreV1.all()`) and by the host decision mirror, so every
 * reader of a persisted or mirrored decision sees a fully classified option
 * set even when the record predates `resumeKind`. Pure: returns the input
 * unchanged when every option already carries a recognised value, so a
 * record is only rewritten in storage the next time it is legitimately
 * saved, not by merely being read.
 */
export function normalizeWorkflowDecisionV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  let changed = false;
  const options = record.options.map((option) => {
    if (option.resumeKind === "unpause" || option.resumeKind === "continue") {
      return option;
    }
    changed = true;
    return { ...option, resumeKind: "unpause" as const };
  });
  return changed ? { ...record, options } : record;
}

/** Identity of a decision: its condition fingerprint plus the answers it currently offers. */
export function workflowDecisionIdentityV1(
  conditionFingerprint: string,
  options: readonly WorkflowDecisionOptionV1[]
): string {
  const enabled = options
    .filter((option) => option.disabled !== true)
    .map((option) => option.optionId)
    .sort();
  return `${conditionFingerprint}|${enabled.join(",")}`;
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
  if (option.disabled === true && !isNonEmptyString(option.disabledReason)) {
    return `disabled option "${option.optionId}" must state a non-empty "disabledReason"`;
  }
  return undefined;
}

/**
 * 1.0.0 gate, Part C item 7: order a decision's options the same way at the
 * single place every decision is built, rather than leaving each of the many
 * call sites (`reviewEscalation.ts` and friends) to remember to do it
 * themselves — recommended option first (a user should not have to hunt for
 * the option the system itself is telling them to pick), otherwise
 * least-destructive first so a card never leads with an irreversible action
 * by accident of array-literal order. Stable within each group: this only
 * moves the recommended/least-destructive options to the front, it never
 * reorders two options of the same kind relative to each other.
 */
function orderOptionsV1(
  options: readonly WorkflowDecisionOptionV1[],
  recommendation: WorkflowDecisionRecommendationV1
): readonly WorkflowDecisionOptionV1[] {
  if (recommendation.kind === "option") {
    const recommended = options.find((o) => o.optionId === recommendation.optionId);
    if (!recommended) {
      return options;
    }
    return [recommended, ...options.filter((o) => o.optionId !== recommendation.optionId)];
  }
  // No basis to recommend: least-destructive first — never lead with an
  // option that discards work or is otherwise hard to reverse.
  const nonDestructive = options.filter((o) => o.destructive !== true);
  const destructive = options.filter((o) => o.destructive === true);
  return [...nonDestructive, ...destructive];
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
    const recommendedOption = input.options.find((o) => o.optionId === recommendation.optionId);
    if (recommendedOption?.disabled === true) {
      return {
        ok: false,
        reason: `recommendation references disabled option "${recommendation.optionId}" — a known-unavailable option can never be recommended`,
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
  // `gating` itself stays optional (see the field's doc comment on
  // `CreateWorkflowDecisionInputV1` for why), but a value that IS supplied
  // must be well-formed — a caller cannot pass a gating claim with no
  // supporting detail, since "does this unblock the task" with no "why" is
  // exactly the unexplained-consequence defect this whole task exists to fix.
  if (input.gating !== undefined) {
    if (typeof input.gating.holdsTaskPaused !== "boolean") {
      return { ok: false, reason: "a supplied \"gating\" requires a boolean \"holdsTaskPaused\"" };
    }
    if (typeof input.gating.unblocksProgress !== "boolean") {
      return { ok: false, reason: "a supplied \"gating\" requires a boolean \"unblocksProgress\"" };
    }
    if (!isNonEmptyString(input.gating.detail)) {
      return { ok: false, reason: "a supplied \"gating\" requires a non-empty \"detail\"" };
    }
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
      options: orderOptionsV1(input.options, recommendation),
      recommendation,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.gating !== undefined ? { gating: input.gating } : {}),
      ...(input.suppressWhileAnswered !== undefined
        ? {
            identity: workflowDecisionIdentityV1(
              input.suppressWhileAnswered.conditionFingerprint,
              input.options
            ),
          }
        : {}),
      createdAt: input.createdAt,
      state: "pending",
    },
  };
}
