/**
 * Centralizes review readiness parsing.
 *
 * Review artifacts must include a top-level line in this exact form:
 *   Readiness: N/10
 *
 * N is normally a whole number 0-10. Staged (multi-round) implementation
 * reviews may instead emit one decimal place (e.g. `Readiness: 3.1/10`) so
 * that incremental progress across rounds is visible and the Fast Forward
 * improvement gate (reviewScoreLoop.ts) can see sub-band movement rather than
 * reading a slow-but-real climb as a plateau. The value is clamped to [0, 10]
 * and normalized to one decimal.
 *
 * The score/label are the only sidebar-facing output: stage-level tree icons
 * no longer vary by score band (see taskTreeProvider.ts's StageNode — a
 * current review stage always renders a plain blue horizontal arrow,
 * regardless of readiness, so a low score can never render as a down arrow).
 */

import { createHash } from "crypto";
import { BlockerLineageDeclaration, TaskProgress, TaskStage } from "../types/taskProgress";
import { listPlanItemStepOwnersV1 } from "./implementationChecklist";

/**
 * Stages from which a review can be run, mapped to the review stage it
 * produces. Moved here (from reviewActions.ts, its original home) so both
 * the command layer (reviewActions.ts) and the tree view (taskTreeProvider.ts)
 * can translate a `taskOperations` entry's stage — which may still be a
 * pre-review stage (`plan`, `impl`, `publish`) when a rerun was launched
 * before the task advanced onto its review stage — into the review stage it
 * targets, without introducing a views -> commands dependency. See
 * `isReviewActivelyRerunningV1` (reviewActions.ts) and its tree-side use.
 */
export const REVIEW_TARGETS: Partial<Record<TaskStage, TaskStage>> = {
  plan: "plan-high-review",
  "plan-high-review": "plan-high-review",
  "plan-low-review": "plan-low-review",
  impl: "impl-high-review",
  "impl-high-review": "impl-high-review",
  "impl-low-review": "impl-low-review",
  publish: "publish",
};

export interface ReadinessResult {
  score: number | null;
  /** Formatted label e.g. "9/10" or "—/10" */
  label: string;
}

/**
 * The accepted `Readiness: N/10` grammar, deliberately, in two tiers.
 *
 * Canonical (what every review prompt asks models to emit, and what
 * {@link isStrictPerfectReview} requires verbatim): a line that is exactly
 * `Readiness: N/10`, N a whole number or a decimal, with nothing else on the
 * line.
 *
 * Tolerated (accepted by `parseReadiness` so real observed model output still
 * scores, but never required and never checked by the strict gate):
 *  - Preamble before the line: `EXACT_READINESS_RE`'s `m` flag matches at any
 *    line start, so text preceding the Readiness line is already fine — no
 *    separate handling needed.
 *  - Markdown bold: `**Readiness: 4/10**` (observed from deepseek-v4-flash@xhigh,
 *    ~7 of 12 sampled reviews, 2026-08-14).
 *  - A Markdown heading prefix: `### Readiness: 4/10`.
 *  - The legacy phrasing `Overall readiness N/10` (case-insensitive, no colon
 *    required) — the form review artifacts predating the `Readiness:` prompt
 *    wording still use. Kept ONLY for reading old artifacts; no current
 *    prompt asks for it and no new tolerance should be added to this branch.
 *
 * All four tolerated forms are matched by the single fallback regex below,
 * because each one differs from canonical only by ignorable characters
 * (asterisks, a heading `#` run, or the word order/colon of the legacy
 * phrase) around the same `readiness ... N/10` core — a model that emits any
 * of them still unambiguously means the same score.
 *
 * What is NOT tolerated, deliberately: a missing line entirely (the seventh/
 * seventeenth 2026-08-16 field-report item — a review that omits Readiness
 * must fall through to the candidate-scoped content-contract fallback in
 * `taskActionCoordinatorV1.ts`, never silently read as "no score", since
 * treating an omission as a quality signal is the exact bug this module
 * exists to prevent), and an out-of-range or non-numeric value (rejected by
 * both regexes' `[0-9]`/`10` alternation, so `parseReadiness` returns
 * `score: null` rather than clamping a bogus scan).
 */
const EXACT_READINESS_RE = /^Readiness:\s*(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\s*$/m;
/** Tolerant fallback: bold/heading-wrapped canonical line, or the legacy
 * `Overall readiness N/10` phrasing — see the grammar doc comment above. */
const LEGACY_READINESS_RE = /readiness[^0-9]*(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10/i;

/** Clamp to [0, 10] and normalize to one decimal so a whole number stays a
 * whole number (3 -> "3/10") and a decimal is tidy (3.14 -> "3.1/10"). */
function normalizeScore(raw: number): number {
  return Math.round(Math.min(10, Math.max(0, raw)) * 10) / 10;
}

/**
 * Parse readiness from a review artifact string.
 */
export function parseReadiness(content: string): ReadinessResult {
  let score: number | null = null;

  const exactMatch = EXACT_READINESS_RE.exec(content);
  if (exactMatch?.[1] !== undefined) {
    score = normalizeScore(parseFloat(exactMatch[1]));
  } else {
    const legacyMatch = LEGACY_READINESS_RE.exec(content);
    if (legacyMatch?.[1] !== undefined) {
      score = normalizeScore(parseFloat(legacyMatch[1]));
    }
  }

  if (score === null) {
    return { score: null, label: "—/10" };
  }

  return { score, label: `${score}/10` };
}

/**
 * Numeric auto-advance check: a parsed score meets the user's configured
 * threshold. This is the only condition auto-advance evaluates — blockers,
 * summary verdicts, and review prose add no independent gate, so a threshold
 * of 4 advances on a score of 4.
 */
export function meetsAutoAdvanceThreshold(
  score: number | null,
  threshold: number
): boolean {
  return score !== null && score >= threshold;
}

/**
 * THE single definition of "this plan still has work left in it".
 *
 * Every place that decides whether work is finished must call this rather
 * than re-deriving `complete < total` inline. Three separate sites now make
 * that call — `readyToAdvanceStage` below (stage advance), and the two
 * termination gates in `reviewScoreLoop.ts` — and the same "a high score
 * does not mean finished" bug has been shipped three times in different
 * disguises. Three correct copies of a rule are worth less than one shared
 * predicate: copies drift silently, and this one already did.
 *
 * A null/absent `progress` means the review emitted no marker, so
 * completeness is UNKNOWN — reported as "not incomplete" so callers fall
 * back to their exact pre-marker behavior instead of blocking on a signal
 * that was never sent.
 */
export function isPlanIncomplete(
  progress: ReviewProgress | null | undefined
): progress is ReviewProgress {
  // A type predicate, not a plain boolean: callers that go on to report the
  // remaining steps (e.g. reviewActions.ts's "13 of 25 implemented" notice)
  // then keep the narrowing the old inline `progress !== null && ...` gave
  // them, so sharing this definition costs them no null assertions.
  return progress !== null && progress !== undefined && progress.complete < progress.total;
}

/**
 * The complete "may this stage advance" decision: a high score alone is NOT
 * enough — the plan must also be finished.
 *
 * Before the progress marker existed, the review prompts capped a mid-plan
 * score below the threshold, so `score >= threshold` doubled as an
 * ACCIDENTAL completeness gate. Removing that cap (necessary — it made a
 * clean staged task unable to ever advance) freed the score to measure
 * quality, and a flawless partial plan promptly scored 8.5 at 13 of 25 steps
 * and auto-advanced out of implementation with 12 steps unbuilt.
 *
 * Kept as a pure predicate, separate from `meetsAutoAdvanceThreshold`, so
 * the rule is pinnable in a unit test — and defined in terms of
 * `isPlanIncomplete` rather than re-deriving the comparison, so the shared
 * definition is genuinely shared instead of merely claimed to be.
 */
/**
 * Reconcile a review's self-reported `<!-- progress: N/M -->` against the plan
 * of record's own checklist, which is the authority on how much of the plan
 * remains.
 *
 * A reviewer chooses its own denominator, and a reviewer that narrows it can
 * declare the task finished while most of the plan is unbuilt: `N == M` is
 * what every completeness gate reads as done. That is not hypothetical — an
 * implementation review reported `<!-- progress: 5/5 -->` for a plan whose
 * checklist held 47 items, the task auto-advanced out of implementation with
 * 41 items untouched, and only Publish noticed (task "1.8", 2026-08-10).
 *
 * The authoritative checklist count wins over the review's self-reported
 * marker in both directions. In particular, reviewer verification that settles
 * the final provisional items must not remain blocked by the older marker
 * written before that verification was applied.
 *
 * A plan with no checklist at all reconciles to the review's own marker
 * unchanged, so tasks that never generated one behave exactly as before.
 *
 * This does not itself escalate. It removes the false "done" so the loop keeps
 * building the remaining items, and a task that genuinely cannot progress hits
 * the existing no-progress breaker and escalates to the human there — which is
 * the intended route for a plan that cannot be implemented as written.
 *
 * Reports `settled`/`total` (wf "make the stage chat a record of work",
 * Part 5 / item 4's fixed-denominator model), not `checked`/total-minus-
 * excluded: `total` here is the checklist's fixed, never-shrinking item
 * count, and `settled` already folds in items closed without doing the work
 * (excluded) alongside items actually checked — both are "not open work" for
 * this reconciliation's purpose, since `checklist.remaining` (the only field
 * that gates below) is computed the same way either way.
 */
export function reconcileProgressWithChecklistV1(
  progress: ReviewProgress | null,
  checklist: { total: number; settled: number; remaining: number } | undefined
): ReviewProgress | null {
  if (!checklist) {
    return progress;
  }
  return { complete: checklist.settled, total: checklist.total };
}

export function readyToAdvanceStage(
  score: number | null,
  threshold: number,
  progress: ReviewProgress | null
): boolean {
  if (!meetsAutoAdvanceThreshold(score, threshold)) {
    return false;
  }
  return !isPlanIncomplete(progress);
}

/** A blocker's review category, as used by the existing free-text sections
 * every review prompt already asks for: "Architectural blockers" and
 * "Completion blockers" (plan/impl-high reviews), "Defect blockers" and
 * "Completion blockers" (impl-low reviews, "defect" filed under
 * "completion" — see the rubric), "Shipping blockers" (publish reviews —
 * the ONLY substantive blocker category those prompts ask for, so omitting
 * it here previously meant every Publish review parsed to zero structured
 * blockers), and "Review-confidence blockers" (all review levels). */
export type BlockerCategory = "architectural" | "completion" | "review-confidence" | "shipping";

/**
 * Who/what can resolve a blocker — the routing key `decideReviewRoute`
 * (reviewRouting.ts) uses to tell "an implementer agent can fix this" apart
 * from "no amount of re-implementation will fix this":
 *  - task-fixable: another implementation round can address it.
 *  - environmental: an infra/sandbox/OS issue unrelated to the task's code
 *    (e.g. a temp-dir permission race), not something an implementer fixes.
 *  - unverifiable: the reviewer could not confirm readiness due to its own
 *    limits (no verified evidence, truncated context), not a code defect.
 *  - spec-defect: the acceptance criterion itself cannot be satisfied as
 *    written (e.g. "all tests pass" when one pre-existing test can never
 *    pass in this environment).
 *  - needs-toolchain: resolving the blocker requires running the project's
 *    own build/codegen/toolchain step (e.g. `npm run build`, a generator)
 *    that the implementation stage structurally cannot run (it runs
 *    edit-only, with Bash denied). Distinct from task-fixable — no amount of
 *    re-editing source will fix a blocker whose resolution is "run the
 *    build" — and distinct from environmental/spec-defect, since the fix
 *    does exist and is well-defined, it just cannot be executed from this
 *    stage. Routes straight to escalation like every other non-task-fixable
 *    resolver (see decideReviewRoute in reviewRouting.ts).
 */
export type BlockerResolver =
  | "task-fixable"
  | "environmental"
  | "environmental-fixable"
  | "unverifiable"
  | "spec-defect"
  | "needs-toolchain";

/**
 * review1 Step 47: `environmental` keeps its meaning (no code change resolves it); `environmental-fixable` is
 * environmental in origin but a bounded code change, usually outside the plan's scope, resolves it (a test that
 * reads developer configuration, a config missing an exclusion, a path the host spells differently). A reviewer
 * who cannot tell uses `environmental-fixable` and states the uncertainty. Neither is something an in-plan round
 * fixes, so routing and escalation treat them alike; only the offer differs ("Investigate it for me").
 */
export function isEnvironmentalResolverV1(resolver: string | undefined): boolean {
  return resolver === "environmental" || resolver === "environmental-fixable";
}

export interface ReviewBlocker {
  category: BlockerCategory;
  resolver: BlockerResolver;
  description: string;
  /**
   * The reviewer's own declared lineage against the prior round's ID'd
   * blocker list — a THIRD bracket, e.g. `[same:b3]` or `[narrowed:b3]` —
   * parsed alongside the category/resolver brackets. Absent when the line
   * carried no lineage bracket (no prior list was injected, an older
   * prompt, or a non-compliant provider): that is lineage-unknown, not
   * "new" — see resolveBlockerLineageV1 (reviewRouting.ts), which is the
   * only place a citation is checked against the actual prior list and
   * resolved to lineage-unknown when the cited id doesn't exist there.
   */
  lineage?: BlockerLineageDeclaration;
  /**
   * Who/what raised this blocker: `"reviewer"` for one parsed from the
   * AI reviewer's own `<!-- blockers:start -->` block (set by
   * {@link parseReviewBlockersDetailed}), `"mechanical"` for one
   * synthesized directly from a failed Verified Check, bypassing the model
   * entirely (`synthesizeMechanicalBlockers`, completionLint.ts). Optional
   * so older callers/fixtures that construct a `ReviewBlocker` by hand
   * remain valid; a mechanically generated blocker must always carry it so
   * it stays distinguishable from a reviewer's own finding in the durable
   * record (wf10 continuation item 12).
   */
  origin?: "reviewer" | "mechanical";
}

/**
 * Splits a stage's task-fixable blockers by who raised them, using item 12's
 * `origin` field (`ReviewBlocker.origin`) — `"mechanical"` for one
 * synthesized from a failing Verified Check, everything else (including an
 * older/hand-built fixture with `origin` absent) reviewer-raised. The single
 * place this split is computed, so a round-ledger outcome's
 * `reviewerBlockers`/`mechanicalBlockers` counts can never disagree with how
 * `origin` is defined elsewhere (2026-08-27 review fix: a prior version
 * counted every task-fixable blocker — reviewer AND mechanical — as
 * `reviewerBlockers` and never recorded a mechanical count at all).
 */
export function splitTaskFixableBlockersByOriginV1(
  blockers: readonly ReviewBlocker[]
): { reviewerBlockers: number; mechanicalBlockers: number } {
  const taskFixable = blockers.filter((b) => b.resolver === "task-fixable");
  return {
    reviewerBlockers: taskFixable.filter((b) => b.origin !== "mechanical").length,
    mechanicalBlockers: taskFixable.filter((b) => b.origin === "mechanical").length,
  };
}

/**
 * RC2 item 4: since the fail-closed-parsing fix, an implementation review
 * (impl-high-review / impl-low-review) only ever sees fast checks (lint,
 * type-check) — the test suite runs once, before Publish (see
 * `buildVerifiedChecksSection`'s "fast" branch, completionLint.ts). A blocker
 * whose entire ask is "show a passing test run" therefore names a condition
 * this stage's reviewer can never itself observe as satisfied: no
 * implementation round can ever produce evidence this stage will accept, so
 * counting it as `task-fixable` manufactures a permanent blocker with no
 * escape — the exact failure observed on RC1 (`needs-toolchain`-shaped,
 * declared `same` across rounds until a plateau card fired).
 *
 * Deliberately scoped to the two implementation review stages only: the
 * equivalent finding at a Publish review is real and satisfiable there, since
 * Publish does run the full suite.
 *
 * Mirrors `IMPL_REVIEW_STAGES_V1` (reviewRouting.ts) by value rather than
 * importing it — reviewRouting.ts imports `BlockerResolver`/`ReviewBlocker`
 * from this module, so importing back would create a cycle.
 */
const NEEDS_PASSING_TEST_RUN_RE =
  /\bpassing\s+test\s+run\b|\btest\s+(?:suite|run)\s+(?:must|needs?\s+to|has\s+to|should)\s+pass\b/i;

/**
 * Review fix (2026-09-28, round 2): the plan's own requirement text ("A
 * blocker that nothing at the current stage can satisfy is never counted as
 * task-fixable work and never drives a plateau card on its own") does not
 * key on `resolver` at all — an implementation review structurally cannot
 * ever produce a passing test run regardless of which resolver label the
 * reviewer attaches to that ask. Gating on a resolver allowlist (originally
 * `task-fixable` + `needs-toolchain`, the two shapes RC1 happened to
 * observe) left every other resolver value — `environmental`,
 * `unverifiable`, `spec-defect` — still landing in `effectiveBlockers` for
 * the exact same unsatisfiable ask, still capable of anchoring the
 * "environmental/unverifiable/spec-defect blockers remain" escalation path
 * (reviewRouting.ts) even though no round could ever clear it. The stage
 * check (`isImplReviewStage`, below) and the entire-ask clause check
 * (`isEntirelyAPassingTestRunAskV1`) already bound this narrowly enough — a
 * resolver gate on top of them was redundant and, worse, incomplete.
 */
/**
 * Clause boundaries strong enough to mark a SEPARATE, independent claim
 * inside one blocker line — "and", "but", "also", "plus" as connectors, or a
 * semicolon. Deliberately narrow: words like "before" or "since" often
 * qualify the SAME ask ("...must pass before this is done") rather than
 * introduce a second one, and splitting on those would wrongly treat a
 * single-ask sentence as compound.
 */
const CLAUSE_BOUNDARY_RE = /,?\s+(?:and|but|also|plus)\s+|;\s*/i;

/**
 * Review fix (2026-09-28): the previous version did a plain substring test
 * against the whole description, so a compound finding that named a real,
 * distinct defect ALONGSIDE the test-run wording ("...still needs a passing
 * test run, and the `foo()` helper throws on an empty array") was removed
 * wholesale — manufacturing false success by silently discarding a genuine
 * blocker. "Whose entire ask is a passing test run" means every independent
 * clause of the description must be about that ask; a description split into
 * more than one clause where any clause fails the phrase test names
 * something else and is kept in full.
 */
function isEntirelyAPassingTestRunAskV1(description: string): boolean {
  const clauses = description
    .split(CLAUSE_BOUNDARY_RE)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) {
    return false;
  }
  return clauses.every((clause) => NEEDS_PASSING_TEST_RUN_RE.test(clause));
}

export interface StageUnsatisfiableBlockerPartitionV1 {
  /** Blockers still counted at this stage — everything not filtered out. */
  effectiveBlockers: ReviewBlocker[];
  /**
   * Blockers this stage structurally cannot ever satisfy, removed from
   * `effectiveBlockers`. Never task-fixable work and never, on their own,
   * drives a plateau card — see `hasZeroTaskFixableEvidence`'s callers,
   * which must consult `effectiveBlockers`, not the raw input.
   */
  unsatisfiableBlockers: ReviewBlocker[];
}

export function partitionStageUnsatisfiableBlockersV1(
  blockers: readonly ReviewBlocker[],
  stage: TaskStage
): StageUnsatisfiableBlockerPartitionV1 {
  const isImplReviewStage = stage === "impl-high-review" || stage === "impl-low-review";
  if (!isImplReviewStage) {
    return { effectiveBlockers: [...blockers], unsatisfiableBlockers: [] };
  }
  const effectiveBlockers: ReviewBlocker[] = [];
  const unsatisfiableBlockers: ReviewBlocker[] = [];
  for (const blocker of blockers) {
    if (isEntirelyAPassingTestRunAskV1(blocker.description)) {
      unsatisfiableBlockers.push(blocker);
    } else {
      effectiveBlockers.push(blocker);
    }
  }
  return { effectiveBlockers, unsatisfiableBlockers };
}

/** Lowercases, strips Markdown emphasis/code marks, and collapses whitespace
 * — enough to compare a reviewer's own wording against an implementer's
 * quoted-but-retyped blocker text without the two needing to be byte-identical. */
function normalizeForBlockerMatchV1(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Below this normalized length, a declined-blocker entry must match a
 * blocker's description exactly, never by substring containment — a short
 * fragment ("fix it", "the setting") would otherwise match almost anything,
 * silently reclassifying unrelated task-fixable work as environmental. */
const MIN_DECLINED_BLOCKER_CONTAINMENT_MATCH_LENGTH_V1 = 20;

function declinedBlockerMatchesV1(description: string, normalizedDeclined: readonly string[]): boolean {
  const normalizedDescription = normalizeForBlockerMatchV1(description);
  if (normalizedDescription.length === 0) {
    return false;
  }
  return normalizedDeclined.some((declined) => {
    if (declined.length === 0) {
      return false;
    }
    if (declined.length < MIN_DECLINED_BLOCKER_CONTAINMENT_MATCH_LENGTH_V1) {
      return declined === normalizedDescription;
    }
    return normalizedDescription.includes(declined) || declined.includes(normalizedDescription);
  });
}

export interface DeclinedBlockerReclassificationV1 {
  /** Every input blocker, with a matched `task-fixable` blocker's `resolver`
   * replaced by `environmental` — same length and order as the input. */
  effectiveBlockers: ReviewBlocker[];
  /** The subset that was reclassified (their ORIGINAL, pre-reclassification
   * form), for callers that want to report or log what changed. */
  reclassifiedBlockers: ReviewBlocker[];
}

/**
 * RC2 item 7: a reviewer's `task-fixable` blocker that matches an
 * implementer round's own declined-removal entry (see
 * {@link DeclinedBlockerV1} in implementationChecklist.ts — rule 7's
 * contract) is reclassified `environmental` here, BEFORE counts, history and
 * routing ever see it — the same shape as
 * {@link partitionStageUnsatisfiableBlockersV1} for item 4, except the
 * blocker stays visible (as `environmental`) rather than being removed,
 * since it is still real, just not task-fixable without a human decision.
 *
 * Matching is deliberately conservative (see `declinedBlockerMatchesV1`): an
 * unmatched blocker keeps its original classification rather than risk
 * silently hiding a genuine task-fixable finding.
 */
export function reclassifyDeclinedBlockersV1(
  blockers: readonly ReviewBlocker[],
  declined: readonly { blockerText: string }[]
): DeclinedBlockerReclassificationV1 {
  const normalizedDeclined = declined
    .map((entry) => normalizeForBlockerMatchV1(entry.blockerText))
    .filter((text) => text.length > 0);
  if (normalizedDeclined.length === 0) {
    return { effectiveBlockers: [...blockers], reclassifiedBlockers: [] };
  }
  const effectiveBlockers: ReviewBlocker[] = [];
  const reclassifiedBlockers: ReviewBlocker[] = [];
  for (const blocker of blockers) {
    if (blocker.resolver === "task-fixable" && declinedBlockerMatchesV1(blocker.description, normalizedDeclined)) {
      reclassifiedBlockers.push(blocker);
      effectiveBlockers.push({ ...blocker, resolver: "environmental" });
    } else {
      effectiveBlockers.push(blocker);
    }
  }
  return { effectiveBlockers, reclassifiedBlockers };
}

const BLOCKERS_BLOCK_RE = /<!--\s*blockers:start\s*-->([\s\S]*?)<!--\s*blockers:end\s*-->/i;

/**
 * The machine-readable block a reviewer names verified-complete plan items in
 * (see resources/prompts/review-scoring-rubric.md's "Verified Complete"
 * instruction, workflow 3 continuation plan Part 5):
 *
 *   <!-- verified-complete:start -->
 *   - <exact plan item text, copied verbatim>
 *   <!-- verified-complete:end -->
 *
 * Mirrors `BLOCKERS_BLOCK_RE`'s shape so the two parse identically.
 */
const VERIFIED_COMPLETE_BLOCK_RE =
  /<!--\s*verified-complete:start\s*-->([\s\S]*?)<!--\s*verified-complete:end\s*-->/i;
const VERIFIED_COMPLETE_LINE_RE = /^\s*[-*]\s+(.+?)\s*$/;
/** RC3 item 1, Step 2c: an item's optional `  evidence: <sentence>` continuation line. */
const VERIFIED_COMPLETE_EVIDENCE_LINE_RE = /^\s+evidence:\s*(.+?)\s*$/;
/**
 * The category bracket is OPTIONAL. Reviewers do sometimes emit only the
 * resolver — `- [needs-toolchain] baseline drifted…` instead of
 * `- [completion] [needs-toolchain] baseline drifted…` — and requiring both
 * brackets made that line unmatchable, so it was skipped and the block parsed
 * to zero blockers. That is the worst possible reading: a review that found
 * real problems became indistinguishable from one that found none, and
 * `hasZeroTaskFixableEvidence` then reported positive evidence of a clean
 * round. Observed live 2026-08-07 (`.ensemble/2026-07-24_task_1`, impl-high
 * round 1) where two genuine blockers recorded as `blockerCount: 0`.
 *
 * The resolver is the field every routing decision actually keys on, so it
 * stays required; a missing category defaults to `completion` below. Order
 * matters in the alternation — the optional group is tried first, and a line
 * carrying only a CATEGORY (`- [completion] …`, no resolver) still correctly
 * fails to match, because backtracking then requires a valid resolver in the
 * first bracket and finds a category name there instead.
 */
const BLOCKER_LINE_RE =
  /^\s*[-*]\s*(?:\[\s*(architectural|completion|review-confidence|shipping)\s*\]\s*)?\[\s*(task-fixable|environmental-fixable|environmental|unverifiable|spec-defect|needs-toolchain)\s*\]\s*(?:\[\s*(new|same\s*:\s*[\w-]+|narrowed\s*:\s*[\w-]+)\s*\]\s*)?(.+?)\s*$/i;

/** bugs5 Step 24: agent-gatherable evidence form */
export const AGENT_CAN_GATHER_RE = /\bagent can gather\s*\((?:cost:\s*)?([^)]+)\)/i;

/**
 * Parse a blocker line's optional THIRD bracket (`[new]`, `[same:<id>]`,
 * `[narrowed:<id>]`) into a declaration. Returns `undefined` when the
 * bracket was absent — the caller (not this function) decides what
 * "absent" means for lineage classification purposes.
 */
function parseLineageBracket(raw: string | undefined): BlockerLineageDeclaration | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "new") {
    return { kind: "new" };
  }
  const sameMatch = /^same\s*:\s*([\w-]+)$/.exec(normalized);
  if (sameMatch?.[1]) {
    return { kind: "same", refId: sameMatch[1] };
  }
  const narrowedMatch = /^narrowed\s*:\s*([\w-]+)$/.exec(normalized);
  if (narrowedMatch?.[1]) {
    return { kind: "narrowed", refId: narrowedMatch[1] };
  }
  return undefined;
}

/**
 * Parse the machine-readable blocker block reviewers are asked to emit
 * (see resources/prompts/review-scoring-rubric.md) in addition to their
 * prose blocker sections:
 *
 *   <!-- blockers:start -->
 *   - [completion] [task-fixable] short description
 *   <!-- blockers:end -->
 *
 * An absent block (older prompt version, or a provider that didn't follow
 * instructions) yields an empty array rather than throwing, so routing
 * degrades to "no structured blocker signal" instead of failing. A PRESENT
 * block that contains a line the parser cannot read is a different case: the
 * line is reported via {@link parseReviewBlockersDetailed}'s `malformedLines`
 * rather than silently dropped, and `hasZeroTaskFixableEvidence` fails closed
 * on it — an unreadable line must never be indistinguishable from "no
 * blockers found". Use `parseReviewBlockersDetailed` directly when the
 * caller needs to detect and surface that condition.
 */
export function parseReviewBlockers(content: string): ReviewBlocker[] {
  return parseReviewBlockersDetailed(content).blockers;
}

/**
 * File-path-shaped tokens named inside a set of blocker descriptions —
 * e.g. `` `src/foo/bar.ts` `` or `` `apps/server/lib/split.test.ts:292` ``.
 * Used to prioritise a review's context pack toward the files a standing
 * blocker actually names, so they are the last thing truncated or omitted
 * rather than an arbitrary casualty of tracked-file ordering (see item 15
 * fix 4, resources/prompts/review-scoring-rubric.md's truncation guidance).
 *
 * Deliberately conservative: only matches backtick-quoted spans that look
 * like a relative path with an extension (optionally suffixed with
 * `:line` or `:line-line`), and strips a trailing line reference before
 * returning — the pack's tracked-file list is keyed on bare relative
 * paths. A description with no such span contributes nothing; this is a
 * best-effort prioritisation hint, not a parser that must find every
 * mention.
 */
const BACKTICK_PATH_RE = /`([\w./-]+\.[\w]+)(?::\d+(?:-\d+)?)?`/g;

export function extractBlockerNamedPathsV1(
  blockers: ReadonlyArray<ReviewBlocker>
): Set<string> {
  const paths = new Set<string>();
  for (const blocker of blockers) {
    for (const match of blocker.description.matchAll(BACKTICK_PATH_RE)) {
      const path = match[1];
      if (path) {
        paths.add(path.replace(/\\/g, "/"));
      }
    }
  }
  return paths;
}

/**
 * Result of {@link parseReviewBlockersDetailed}: the parsed blockers plus
 * whether the machine-readable block was PRESENT at all. The distinction
 * matters because an empty array is ambiguous on its own — "the reviewer
 * affirmatively reported zero blockers" (block present, no entries) and "the
 * reviewer never emitted the block" (older prompt, non-compliant provider)
 * must route differently: only the former is positive evidence of a clean
 * review that termination logic (reviewScoreLoop.ts) may act on.
 */
export interface ReviewBlockerEvidence {
  /** True when the `<!-- blockers:start/end -->` markers were found. */
  blockPresent: boolean;
  blockers: ReviewBlocker[];
  /**
   * Non-blank lines inside the block that failed to match
   * {@link BLOCKER_LINE_RE} (no valid resolver bracket, or no description).
   * Non-empty means "unknown", never "clean" — see
   * {@link hasZeroTaskFixableEvidence}, which fails closed on this field
   * rather than silently dropping the line the way earlier versions did.
   */
  malformedLines: string[];
}

/** Conservative match for an explicit prose "no blockers" declaration —
 * secondary evidence when a review omits the machine block but states the
 * absence outright. Deliberately anchored so "no NEW blockers" or "no
 * blockers in this file" prose deeper in a sentence doesn't count. */
const EXPLICIT_NO_BLOCKERS_RE = /^\s*(?:[-*]\s*)?(?:blockers?:\s*none\b|no blockers\b)/im;

/**
 * Positive evidence this review reported zero task-fixable blockers: either
 * the machine-readable block is present, contains no task-fixable entry, AND
 * contains no unparseable line, or the review explicitly states there are no
 * blockers. Mere ABSENCE of the block is never evidence — see
 * ReviewBlockerEvidence. A present block with even one malformed line fails
 * CLOSED (returns false): that line might be the exact blocker the reviewer
 * meant to file, just in a shape the parser could not read, and "unknown"
 * must never be reported as "clean".
 */
export function hasZeroTaskFixableEvidence(content: string): boolean {
  const evidence = parseReviewBlockersDetailed(content);
  if (evidence.blockPresent) {
    if (evidence.malformedLines.length > 0) {
      // An unreadable line means UNKNOWN, not clean. A round that logged a
      // real blocker in a shape the parser couldn't read must never be
      // indistinguishable from a round with nothing to report — that
      // conflation is the exact incident this field exists to prevent.
      return false;
    }
    return evidence.blockers.every((b) => b.resolver !== "task-fixable");
  }
  return EXPLICIT_NO_BLOCKERS_RE.test(content);
}

/**
 * How far through an ordered plan a review reports the implementation to be.
 * `complete` counts steps the reviewer verified as landed and in order;
 * `total` is the plan's own step count.
 */
export interface ReviewProgress {
  complete: number;
  total: number;
}

/**
 * Global (not first-match) on purpose: the prompt that asks for this marker
 * contains a worked example of it, and models routinely echo format
 * instructions back before emitting the real thing. Matching the FIRST
 * occurrence would then parse the example's numbers every single round —
 * reporting frozen progress for a run that is genuinely advancing. The
 * reviewer is told to end its response with the marker, so the LAST
 * occurrence is the authoritative one. (Same failure mode, and same fix, as
 * parseAiResultEnvelopeV1 scanning for the last frame marker rather than the
 * first — this repo's own reviews quote both formats in prose.)
 */
const PROGRESS_MARKER_RE = /<!--\s*progress\s*:\s*(\d+)\s*\/\s*(\d+)\s*-->/gi;

/**
 * Parse the machine-readable plan-progress marker a review emits alongside
 * its blocker block (see resources/prompts/review-impl-high.md):
 *
 *   <!-- progress: 8/25 -->
 *
 * This is the signal that lets the loop distinguish the two very different
 * situations a low score used to conflate: "what was built is wrong" (fix it)
 * versus "what was built is right, there is simply more of the plan left"
 * (keep building). Without it, a clean-but-partial round reads as failure and
 * the loop retries the SAME scope forever instead of advancing to the next
 * steps — the multi-round runaway this marker exists to end.
 *
 * Returns null when the marker is absent (older prompt, or a provider that
 * ignored it) or nonsensical (`total` of zero, `complete` past `total`), so
 * every caller degrades to exactly the pre-marker behavior rather than acting
 * on a number it cannot trust.
 */
/**
 * Global (not first-match), for the same reason as {@link PROGRESS_MARKER_RE}:
 * the instruction that asks for this marker shows a worked example of it, and
 * the LAST occurrence is the authoritative one a reviewer was told to end its
 * response with.
 */
const REVIEWED_COMMIT_RE = /<!--\s*reviewed-commit:\s*([0-9a-f]{7,40})\s*-->/gi;

/**
 * Parse the machine-readable `<!-- reviewed-commit: SHA -->` marker an
 * implementation/publish review is asked to emit (2i, see
 * resources/prompts/review-impl-high.md and siblings): the commit the review
 * actually assessed. A re-review reads this back from the PREVIOUS review to
 * decide whether reconciling against it blocker-by-blocker still makes sense,
 * or whether it predates HEAD by enough commits that it should be treated as
 * history only (see reviewActions.ts's reconciliation-instruction selection).
 * Returns undefined when absent (older prompt, or a provider that ignored
 * it) — callers must treat that the same as "cannot determine staleness",
 * never as "definitely stale" or "definitely current".
 */
export function parseReviewedCommitSha(content: string): string | undefined {
  const match = [...content.matchAll(REVIEWED_COMMIT_RE)].at(-1);
  return match?.[1];
}

/**
 * Global (not first-match), same reason as {@link REVIEWED_COMMIT_RE}: the
 * instruction that asks for this marker shows a worked example, and the LAST
 * occurrence is the one a reviewer was told to end its response with. Matches
 * a sha256 hex digest or the literal `unknown` fallback
 * ({@link computeWorkingTreeFingerprintV1} returning undefined, e.g. no repo).
 */
const REVIEWED_TREE_FINGERPRINT_RE =
  /<!--\s*reviewed-tree-fingerprint:\s*([0-9a-f]{64}|unknown)\s*-->/gi;

/**
 * Parse the machine-readable `<!-- reviewed-tree-fingerprint: HASH -->`
 * marker an implementation/publish review is asked to emit alongside
 * `reviewed-commit` (RC1 item 3): a digest of the UNCOMMITTED working tree at
 * dispatch time (see `computeWorkingTreeFingerprintV1`, gitRepoInfo.ts),
 * which `reviewed-commit` alone cannot capture because HEAD never moves while
 * a task's edits stay uncommitted. Returns undefined when absent (older
 * artifact, or a provider that ignored the instruction) or when the recorded
 * value is the `unknown` fallback — callers must treat both the same as
 * "cannot determine," never as "definitely unchanged."
 */
export function parseReviewedTreeFingerprintV1(content: string): string | undefined {
  const match = [...content.matchAll(REVIEWED_TREE_FINGERPRINT_RE)].at(-1);
  const value = match?.[1];
  return value === "unknown" ? undefined : value;
}

/**
 * Global (not first-match), matching {@link REVIEWED_COMMIT_RE}'s own reason:
 * the instruction shows a worked example, and the LAST occurrence in the
 * reply is the authoritative one.
 */
const REVIEW_PASS_RE = /<!--\s*review-pass:\s*(\d+)\s*-->/gi;

/**
 * Parse the machine-readable `<!-- review-pass: N -->` marker a review is
 * asked to echo back (v1 fixes 2, item 32/Wave I): the stage's review-pass
 * number reserved for THIS round at dispatch time
 * (`reserveStageReviewPassV1`, `TaskProgress.stageReviewPasses`). Returns
 * undefined when absent (older prompt, a plan-review artifact that never
 * carries this marker, or a provider that dropped it) — see
 * {@link isReviewPassCurrentV1}, which treats an absent marker as always
 * stale rather than "cannot determine", unlike {@link parseReviewedCommitSha}.
 */
export function parseReviewPass(content: string): number | undefined {
  const match = [...content.matchAll(REVIEW_PASS_RE)].at(-1);
  if (match === undefined) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Whether a review artifact's stamped pass number matches the stage's
 * CURRENT reservation (v1 fixes 2, item 32/6, Wave I). Deliberately
 * fail-closed, unlike the reviewed-commit family: a review with no pass
 * marker at all, or a task with no reservation recorded for this stage yet
 * (a pre-Wave-I artifact, or a stage never dispatched through
 * `claimReviewAttempt`), reads as NOT current — a review must prove it
 * belongs to this visit to the stage, rather than being trusted by default.
 * This is what closes item 32 ("A review stage can 'pass' on a review left
 * over from an earlier visit"): a stale artifact from a prior visit can
 * never be mistaken for the current pass, because it carries an older
 * number (or none), never a matching one.
 */
export function isReviewPassCurrentV1(
  content: string,
  stageReviewPasses: TaskProgress["stageReviewPasses"],
  stage: TaskStage
): boolean {
  const stamped = parseReviewPass(content);
  const current = stageReviewPasses?.[stage];
  return stamped !== undefined && current !== undefined && stamped === current;
}

function roundKnownToChangeNothingV1(
  row: NonNullable<TaskProgress["roundLedger"]>[number]
): boolean {
  if (row.state === "scheduled" || row.state === "open") {
    return false;
  }
  const outcome = row.outcome;
  return (
    outcome !== undefined &&
    outcome.filesChangedUnknown !== true &&
    Array.isArray(outcome.filesChanged) &&
    outcome.filesChanged.length === 0
  );
}

/**
 * Whether an implementation round STARTED after this stage's current-pass
 * review was published (v1 fixes 2, item 32: a review "predates the latest
 * implementation round"). Such a review describes the tree from before that
 * round, so it is not a verdict on what exists now — even when the round
 * changed nothing HEAD-visible (an uncommitted edit leaves the reviewed
 * commit stamp equal to HEAD).
 *
 * Compares the round's `startedAt` (never `endedAt`): an Apply Review round's
 * own inline re-review publishes before that round's ledger row terminalizes,
 * and must not read as predating the round it followed. Only the history entry
 * carrying the CURRENT reservation is consulted; a review with no such entry
 * is already judged by {@link isReviewPassCurrentV1}, so this returns `false`
 * ("no evidence of predating") rather than double-counting it.
 *
 * RC4 item 2: a round that is terminal and KNOWN to have changed nothing
 * (`outcome.filesChanged` an explicit empty array, `filesChangedUnknown` not
 * set) does not stale the review — a failed or cancelled Apply Review that
 * touched no files left the tree the review assessed. An omitted change set
 * means unknown and stales. The explicit empty set is written by
 * `beginImplementationRecoveryV1` and by `executeImplementationRun`'s
 * plain-failure branch.
 */
export function reviewPredatesLatestImplementationRoundV1(
  progress: Pick<TaskProgress, "stageReviewPasses" | "reviewScoreHistory" | "roundLedger">,
  stage: TaskStage,
  /**
   * review1 Step 32: when the owner is CONTINUING a lost editing round (an Apply Review or Implementation round
   * that failed or was cut off after editing), that round's own edits do not make the review it was working from
   * stale: continuing is exactly "act on this review against the tree as that round left it". Only lost editing
   * rounds are ignored; a completed round that changed files still stales the review.
   */
  options?: { readonly ignoreLostEditingRounds?: boolean }
): boolean {
  const current = progress.stageReviewPasses?.[stage];
  if (current === undefined) {
    return false;
  }
  const publishedAt = (progress.reviewScoreHistory ?? [])
    .filter((entry) => entry.stage === stage && entry.reviewPass === current)
    .at(-1)?.at;
  if (publishedAt === undefined) {
    return false;
  }
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) {
    return false;
  }
  return (progress.roundLedger ?? []).some((row) => {
    if (row.mode === "review") {
      return false;
    }
    const started = Date.parse(row.startedAt);
    if (!Number.isFinite(started) || started <= published) {
      return false;
    }
    if (options?.ignoreLostEditingRounds === true && isLostRoundStateV1(row.state)) {
      return false;
    }
    return !roundKnownToChangeNothingV1(row);
  });
}

/** A terminal ledger state that means the round did not finish (the user's own cancel is not one). */
function isLostRoundStateV1(state: string): boolean {
  return state === "failed" || state === "rejected" || state === "interrupted" || state === "quota-blocked";
}

/**
 * Stages that record a `<!-- reviewed-commit: SHA -->` marker (2i) — the
 * implementation and publish review stages, whose "previous review" a
 * re-review is told to reconcile against can go stale relative to the
 * workspace across many rounds (the task_5 evidence: a 62-commit, 8-day gap).
 * Plan reviews assess plan.md prose, which isn't tied to commit history the
 * same way, so they stay out of scope.
 *
 * Lives here (not in reviewActions.ts, where it was born) so the freshness
 * primitives below and every trigger-point caller — review flows, the commit
 * lifecycle, chat packing, the task tree — share one definition without a
 * utils → commands dependency.
 */
export const REVIEWED_COMMIT_STAGES: ReadonlySet<TaskStage> = new Set([
  "impl-high-review",
  "impl-low-review",
  "publish",
]);

/** The LEGACY placeholder a workspace-change staling used to write wholesale
 * over a review artifact's real content (reviewActions.ts's
 * markReviewArtifactStale, before the 1.0.0 gate's A3 fix). No longer
 * written by any code path — {@link buildArtifactChangeStaleBannerV1} below
 * replaced it with a non-destructive banner line that preserves the review
 * body — but still recognized on read so an artifact staled by a
 * pre-upgrade build keeps reading as stale rather than as a malformed
 * review. Freshness marking must never touch one: it has no Readiness line
 * and its staleness is already its whole content. */
const STALE_REVIEW_PLACEHOLDER_PREFIX_V1 = "# Review Stale";

/**
 * The placeholder heading reviewActions.ts's rewrite/revert lifecycle writes
 * over a `# Review Stale` placeholder while a rerun of that same review stage
 * is genuinely in flight (`isReviewActivelyRerunningV1`). A recognized
 * placeholder VARIANT, not a fresh review: it carries no Readiness line
 * either, so `isUnusableAsExistingReview`/`parseReadiness` already treat it
 * the same way they treat the stale placeholder, with no extra handling
 * needed. Exported so reviewActions.ts's rewrite/revert helper and its
 * `backupReviewUnlessStale` guard share this one literal instead of each
 * re-declaring it.
 */
export const IN_PROGRESS_REVIEW_PLACEHOLDER_PREFIX_V1 = "# Review in progress";

/**
 * The one banner line {@link upsertStaleReviewBanner} manages, PLUS its
 * transient in-progress counterpart (`markReviewInProgressBannerV1` below)
 * that reviewActions.ts's rewrite/revert lifecycle swaps in — line-only,
 * preserving the rest of the review body — while a rerun of the SAME review
 * stage is genuinely in flight. Matching both forms in one regex is what
 * lets `upsertStaleReviewBanner` find and heal (or remove) a leftover
 * in-progress banner from an interrupted run using its existing bannerIndex
 * lookup, with no separate code path.
 */
const STALE_REVIEW_BANNER_TEXT_RE_V1 =
  /^> ⚠ Stale: this review examined ([0-9a-f]{7,40}), which is no longer HEAD\.[ \t]*\r?$/i;
const IN_PROGRESS_REVIEW_BANNER_TEXT_V1 =
  "> ⏳ Review in progress: re-evaluating this artifact against the current HEAD.";
const IN_PROGRESS_REVIEW_BANNER_RE_V1 =
  /^> ⏳ Review in progress: re-evaluating this artifact against the current HEAD\.[ \t]*\r?$/i;
const STALE_REVIEW_BANNER_RE_V1 = new RegExp(
  `(?:${STALE_REVIEW_BANNER_TEXT_RE_V1.source})|(?:${IN_PROGRESS_REVIEW_BANNER_RE_V1.source})`,
  "i"
);

/**
 * The 1.0.0 gate's A3 replacement for the destructive `# Review Stale`
 * placeholder (`markReviewArtifactStale`, reviewActions.ts): a review
 * invalidated because SOME OTHER task artifact changed (the plan, or the
 * workspace files an implementation round edited) is no longer safe to trust
 * as a verdict on the current state, but its content — verdict, score,
 * blockers, progress marker — is exactly what "where were we up to?" needs,
 * and is otherwise readable only from `_prev`, which nothing points a reader
 * at. This banner marks the artifact stale IN PLACE, one line, leaving the
 * rest of the body untouched, mirroring {@link upsertStaleReviewBanner}'s
 * non-destructive shape for the (different) commit-drift case.
 *
 * Deliberately a distinct marker from {@link STALE_REVIEW_BANNER_TEXT_RE_V1}:
 * that one is driven by comparing the `reviewed-commit` marker against HEAD
 * and is refreshed/healed idempotently by `refreshStaleReviewBannerForArtifactV1`
 * on a schedule unrelated to this one; this one is written once, at the
 * moment `markReviewArtifactStale` fires, and names WHICH artifact changed
 * and WHEN rather than a commit SHA. The two can coexist on the same
 * artifact without conflict — each function's own bannerIndex lookup only
 * ever searches for its own pattern.
 */
const ARTIFACT_CHANGE_STALE_BANNER_TEXT_RE_V1 =
  /^> ⚠ Stale: superseded by an update to .+ at .+\.[ \t]*\r?$/i;

/** Matches either stale-banner kind (commit-drift or artifact-change) PLUS
 * the shared in-progress form — used only by {@link markReviewInProgressBannerV1}
 * to find whichever banner line needs swapping to its transient in-progress
 * form while a rerun is genuinely in flight. Never used to decide whether to
 * INSERT or REMOVE a banner (each banner's own upsert keeps its own,
 * narrower lookup for that), only to find one that already exists. */
const ANY_STALE_OR_IN_PROGRESS_BANNER_RE_V1 = new RegExp(
  `(?:${STALE_REVIEW_BANNER_TEXT_RE_V1.source})|(?:${ARTIFACT_CHANGE_STALE_BANNER_TEXT_RE_V1.source})|(?:${IN_PROGRESS_REVIEW_BANNER_RE_V1.source})`,
  "i"
);

/**
 * Build the artifact-change stale banner line for `changedArtifact` (e.g.
 * `"plan.md"` or `"workspace files"`) at `atIso` (an ISO timestamp — rendered
 * as-is so the banner's "when" is exact, not relative and therefore stale
 * itself the moment it is read later).
 * @internal exported for testing
 */
export function buildArtifactChangeStaleBannerV1(changedArtifact: string, atIso: string): string {
  return `> ⚠ Stale: superseded by an update to ${changedArtifact} at ${atIso}.`;
}

/**
 * True when `content` carries the artifact-change stale banner — the
 * non-destructive replacement for the old `# Review Stale` full-content
 * placeholder. Used wherever a caller needs to know "does this artifact's
 * content still describe the current state", now that staling no longer
 * destroys the content itself.
 * @internal exported for testing
 */
export function hasArtifactChangeStaleBannerV1(content: string): boolean {
  return content.split("\n").some((line) => ARTIFACT_CHANGE_STALE_BANNER_TEXT_RE_V1.test(line));
}

/**
 * Put one note line directly below the artifact-change stale banner (RC6
 * item 5), replacing an existing note there — recognized by one of
 * `replacePrefixes` — in place. Every other line (banner, review body,
 * managed sections) is copied unchanged. Returns `content` itself when there
 * is no banner to anchor to.
 * @internal exported for testing
 */
export function upsertNoteBelowArtifactChangeBannerV1(
  content: string,
  replacePrefixes: readonly string[],
  note: string
): string {
  const lines = content.split("\n");
  const bannerIndex = lines.findIndex((line) => ARTIFACT_CHANGE_STALE_BANNER_TEXT_RE_V1.test(line));
  if (bannerIndex === -1) {
    return content;
  }
  const eol = lines[bannerIndex]!.endsWith("\r") ? "\r" : "";
  let removeCount = 0;
  while (
    bannerIndex + 1 + removeCount < lines.length &&
    replacePrefixes.some((prefix) => lines[bannerIndex + 1 + removeCount]!.startsWith(prefix))
  ) {
    removeCount++;
  }
  lines.splice(bannerIndex + 1, removeCount, note + eol);
  return lines.join("\n");
}

/**
 * The single, shared "is this review artifact stale" predicate (A1, 1.0.0
 * gate Part A3): true for the legacy `# Review Stale` full-content
 * placeholder (pre-upgrade data) OR content carrying the artifact-change
 * stale banner. Every existing consumer of this notion — recovery's
 * usability check, Apply Review's guard, Fast Forward's baseline check,
 * re-review prompt selection, backup-before-write — wants the SAME truth
 * value it always got from the placeholder-prefix check alone; this is that
 * check, widened to also recognize the non-destructive banner that replaced
 * the placeholder as the write-side mechanism. Lives here (not in
 * reviewActions.ts, its original home) so `implementationRecoveryV1.ts` can
 * read the same definition without a commands → commands import cycle
 * (reviewActions.ts already imports from implementationRecoveryV1.ts).
 * reviewActions.ts re-exports this under its established local name.
 */
export function isStaleReviewArtifactV1(content: string): boolean {
  return content.trimStart().startsWith(STALE_REVIEW_PLACEHOLDER_PREFIX_V1) || hasArtifactChangeStaleBannerV1(content);
}

/**
 * Insert the artifact-change stale banner into `content` (real review body,
 * NOT the legacy `# Review Stale` placeholder — callers gate that
 * separately), immediately after the leading `Readiness: N/10` line so the
 * review contract's Readiness line stays the first content line (matching
 * {@link upsertStaleReviewBanner}'s same convention — `isStrictPerfectReview`
 * and other first-line readers depend on this), or at the very top when no
 * Readiness line exists. Idempotent: a banner already naming the same
 * artifact/timestamp is left as-is; a banner naming a DIFFERENT change is
 * replaced in place (the newest invalidation reason wins) rather than
 * stacking multiple stale banners from repeated staling events.
 * @internal exported for testing
 */
export function upsertArtifactChangeStaleBannerV1(
  content: string,
  changedArtifact: string,
  atIso: string
): string {
  const desired = buildArtifactChangeStaleBannerV1(changedArtifact, atIso);
  const lines = content.split("\n");
  const bannerIndex = lines.findIndex((line) => ARTIFACT_CHANGE_STALE_BANNER_TEXT_RE_V1.test(line));
  if (bannerIndex !== -1) {
    const existing = lines[bannerIndex]!;
    const eol = existing.endsWith("\r") ? "\r" : "";
    if (existing === desired + eol) {
      return content;
    }
    lines[bannerIndex] = desired + eol;
    return lines.join("\n");
  }
  const anchorIndex = lines.findIndex((line) => READINESS_ANCHOR_LINE_RE_V1.test(line));
  const insertAt = anchorIndex === -1 ? 0 : anchorIndex + 1;
  const anchorEol = anchorIndex !== -1 && lines[anchorIndex]!.endsWith("\r") ? "\r" : "";
  lines.splice(insertAt, 0, desired + anchorEol);
  return lines.join("\n");
}

/**
 * Line-only transform: if `content` (a real review artifact, NOT the
 * `# Review Stale` placeholder — callers gate that separately) carries the
 * persisted commit-drift stale banner, replace just that line with the
 * in-progress form; otherwise return `content` unchanged (byte-identical
 * string, so callers can cheaply detect a no-op the same way
 * {@link upsertStaleReviewBanner} does). Never touches the review body, so
 * the artifact survives for reconciliation and backup while a rerun is live.
 *
 * Deliberately does NOT add an in-progress banner to a review that has no
 * stale banner at all — only a review already flagged commit-stale gets the
 * transient marker; a current review being re-reviewed by choice (not
 * staleness) needs no banner at all.
 */
export function markReviewInProgressBannerV1(content: string): string {
  if (content.trimStart().startsWith(STALE_REVIEW_PLACEHOLDER_PREFIX_V1)) {
    return content;
  }
  const lines = content.split("\n");
  // Either stale-banner kind (commit-drift or artifact-change) is swapped to
  // the same transient in-progress line — see
  // ANY_STALE_OR_IN_PROGRESS_BANNER_RE_V1's doc comment for why this lookup
  // is deliberately broader than upsertStaleReviewBanner's own.
  const bannerIndex = lines.findIndex((line) => ANY_STALE_OR_IN_PROGRESS_BANNER_RE_V1.test(line));
  if (bannerIndex === -1) {
    return content;
  }
  const existing = lines[bannerIndex]!;
  const eol = existing.endsWith("\r") ? "\r" : "";
  if (existing === IN_PROGRESS_REVIEW_BANNER_TEXT_V1 + eol) {
    return content;
  }
  lines[bannerIndex] = IN_PROGRESS_REVIEW_BANNER_TEXT_V1 + eol;
  return lines.join("\n");
}

/**
 * The visible counterpart of the trailing `<!-- reviewed-commit: SHA -->`
 * HTML comment, written at save time by {@link withVisibleReviewedCommitLineV1}.
 * REVIEWED_COMMIT_RE matches only the comment form, so this line can never
 * confuse {@link parseReviewedCommitSha} or any other existing parser.
 */
const VISIBLE_REVIEWED_COMMIT_LINE_RE_V1 =
  /^> Reviewed commit: ([0-9a-f]{7,40})[ \t]*\r?$/i;

/** Per-line form of EXACT_READINESS_RE (trailing `\r` tolerated via `\s*`). */
const READINESS_ANCHOR_LINE_RE_V1 =
  /^Readiness:\s*(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\s*$/;

/**
 * Prefix-tolerant SHA comparison: the recorded marker is usually the full
 * 40-char HEAD at prompt time, but tests and hand-written artifacts use the
 * 7-char short form. Two SHAs name the same commit when the shorter (at
 * least 7 chars, the marker regex's own minimum) prefixes the longer.
 */
function shasReferToSameCommitV1(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) {
    return true;
  }
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 7 && longer.startsWith(shorter);
}

/** Where the review stands relative to HEAD. */
export interface ReviewFreshnessV1 {
  /** The commit the review assessed, or undefined when it recorded none. */
  readonly reviewedSha: string | undefined;
  /**
   * True only when BOTH SHAs are known and name different commits. An
   * unreadable marker or an unresolvable HEAD reports false — "cannot
   * determine" must never read as "stale" (same rule parseReviewedCommitSha
   * documents for its own callers).
   */
  readonly behindHead: boolean;
}

/**
 * Compute whether a review artifact's recorded commit is behind HEAD.
 * Pure: no git, no fs — the caller resolves HEAD once and reuses it.
 */
export function computeReviewFreshness(
  content: string,
  headSha: string | undefined
): ReviewFreshnessV1 {
  const reviewedSha = parseReviewedCommitSha(content);
  return {
    reviewedSha,
    behindHead:
      reviewedSha !== undefined &&
      headSha !== undefined &&
      !shasReferToSameCommitV1(reviewedSha, headSha),
  };
}

/**
 * A1's 1.0.0-gate Part C, Step 5: true only when a manual review re-run would
 * dispatch against a tree that is provably identical to what the LAST review
 * of this exact stage already assessed — the reviewed-commit marker names the
 * same commit as HEAD right now, so the verdict cannot differ by
 * construction ("I've made changes — re-check" — never a review's default
 * behavior).
 *
 * Deliberately conservative, mirroring every other freshness caller in this
 * module: an absent artifact, an absent/placeholder review (nothing to
 * compare against — including the `# Review Stale`/in-progress placeholders,
 * which carry no reviewed-commit marker and so already read `reviewedSha ===
 * undefined` via `computeReviewFreshness`), an unreadable `reviewed-commit`
 * marker, or an unresolved HEAD all report `false` ("cannot determine" must
 * never read as "unchanged" — blocking a review that might in fact be
 * warranted is worse than the wasted round this guard exists to prevent).
 * Scoped by the caller to {@link REVIEWED_COMMIT_STAGES}: a plan review's
 * artifact never carries the marker, so this is a harmless no-op there
 * without an explicit stage check here.
 *
 * Also reports `false` when the artifact carries the artifact-change stale
 * banner ({@link hasArtifactChangeStaleBannerV1}) — 2026-09-04 review
 * follow-up (completion blocker, "narrowed"): that banner is written when an
 * implementation round edits workspace files, which does NOT move HEAD when
 * those edits are uncommitted, so `reviewedSha === headSha` can hold even
 * though the tree the round just changed is exactly what the caller wants
 * re-reviewed. The banner is direct evidence the tree changed since this
 * review ran; treating it as "unchanged" would refuse (or silently skip,
 * under automation) the very re-review Apply Review depends on after every
 * implementation round.
 *
 * RC1 item 3: HEAD alone is not enough even without a banner miss — a task's
 * edits stay uncommitted for its whole lifetime, so HEAD never moves and a
 * commit-only comparison reads a tree that changed by hand (not through an
 * implementation round, so no banner was ever written) as "unchanged" every
 * time. `currentTreeFingerprint` (the live digest from
 * `computeWorkingTreeFingerprintV1`) is compared against the artifact's own
 * `reviewed-tree-fingerprint` marker; the two must both be known AND equal to
 * report "unchanged" — an absent recorded marker (an artifact written before
 * this check existed) or an unresolvable current fingerprint (git
 * unavailable) is "cannot determine," which this function treats the same as
 * every other unreadable signal here: it must never read as "unchanged."
 */
export function isReviewDispatchAgainstUnchangedTreeV1(
  existingReviewContent: string | undefined,
  headSha: string | undefined,
  currentTreeFingerprint: string | undefined,
  /**
   * review1 Step 27: true when the review's other inputs (`plan.md`, `plan-final.md`, `task.md`) changed after the
   * review was written. The code fingerprint cannot see the task folder, so an owner decision recorded in `task.md`
   * or an Accepted Non-Goals entry in `plan.md` leaves the tree "unchanged" while the review is stale.
   */
  reviewInputsChanged?: boolean
): boolean {
  if (!existingReviewContent || !headSha) {
    return false;
  }
  if (reviewInputsChanged === true) {
    return false;
  }
  if (hasArtifactChangeStaleBannerV1(existingReviewContent)) {
    return false;
  }
  const freshness = computeReviewFreshness(existingReviewContent, headSha);
  if (freshness.reviewedSha === undefined || freshness.behindHead) {
    return false;
  }
  if (currentTreeFingerprint === undefined) {
    return false;
  }
  const recordedFingerprint = parseReviewedTreeFingerprintV1(existingReviewContent);
  return recordedFingerprint !== undefined && recordedFingerprint === currentTreeFingerprint;
}

/**
 * The converse of {@link isReviewDispatchAgainstUnchangedTreeV1}: true only when
 * the review's own stamps PROVE the workspace moved since it was dispatched, i.e.
 * a recorded commit that is no longer HEAD, or a recorded working-tree
 * fingerprint that differs from the live one. Unknown signals (no stamp, git
 * unavailable) are "cannot tell" and read false here, so this only ever adds
 * certainty to a stale verdict and never invents one. A resumed run uses it to
 * discard a review of a tree an external edit has changed, even when no
 * implementation round ran after that review.
 */
export function isReviewedTreeProvablyChangedV1(
  existingReviewContent: string | undefined,
  headSha: string | undefined,
  currentTreeFingerprint: string | undefined
): boolean {
  if (!existingReviewContent) {
    return false;
  }
  if (headSha !== undefined) {
    const freshness = computeReviewFreshness(existingReviewContent, headSha);
    if (freshness.reviewedSha !== undefined && freshness.behindHead) {
      return true;
    }
  }
  const recordedFingerprint = parseReviewedTreeFingerprintV1(existingReviewContent);
  return recordedFingerprint !== undefined && currentTreeFingerprint !== undefined && recordedFingerprint !== currentTreeFingerprint;
}

/**
 * Insert, refresh, or remove the single stale banner line that marks a review
 * whose recorded commit is no longer HEAD:
 *
 *   > ⚠ Stale: this review examined abc1234, which is no longer HEAD.
 *
 * Why this exists: `reviewed-commit` travels as a trailing HTML comment, so a
 * superseded review reads as current — confident prose, a readiness score,
 * nothing marking it stale. That misled the operator three times in one
 * session on 2026-08-07_task_1. The workspace-change placeholder
 * (markReviewArtifactStale) covers only the "artifact changed" case; a review
 * whose commit merely fell behind HEAD had no marker at all.
 *
 * Pure, idempotent, byte-preserving: the only permitted mutation is the one
 * banner line — inserted immediately after the leading `Readiness: N/10` line
 * (so the review contract's Readiness line stays the first content line, and
 * isStrictPerfectReview never reads the banner instead), or at the very top
 * when no Readiness line exists. Returns the input unchanged (same string)
 * when there is nothing to do:
 *
 *  - a `# Review Stale` placeholder (already a staleness marker);
 *  - no reviewed-commit marker, or no HEAD to compare against — "cannot
 *    determine" never reads as "stale";
 *  - the recorded commit still matches HEAD — except that THIS case removes a
 *    leftover banner, so a review that is current again heals itself.
 */
export function upsertStaleReviewBanner(
  content: string,
  headSha: string | undefined
): string {
  if (content.trimStart().startsWith(STALE_REVIEW_PLACEHOLDER_PREFIX_V1)) {
    return content;
  }
  const reviewedSha = parseReviewedCommitSha(content);
  if (!reviewedSha || !headSha) {
    return content;
  }
  const lines = content.split("\n");
  const bannerIndex = lines.findIndex((line) => STALE_REVIEW_BANNER_RE_V1.test(line));
  if (shasReferToSameCommitV1(reviewedSha, headSha)) {
    if (bannerIndex === -1) {
      return content;
    }
    lines.splice(bannerIndex, 1);
    return lines.join("\n");
  }
  const desired = `> ⚠ Stale: this review examined ${reviewedSha}, which is no longer HEAD.`;
  if (bannerIndex !== -1) {
    const existing = lines[bannerIndex]!;
    const eol = existing.endsWith("\r") ? "\r" : "";
    if (existing === desired + eol) {
      return content;
    }
    lines[bannerIndex] = desired + eol;
    return lines.join("\n");
  }
  const anchorIndex = lines.findIndex((line) => READINESS_ANCHOR_LINE_RE_V1.test(line));
  const insertAt = anchorIndex === -1 ? 0 : anchorIndex + 1;
  const anchorEol =
    anchorIndex !== -1 && lines[anchorIndex]!.endsWith("\r") ? "\r" : "";
  lines.splice(insertAt, 0, desired + anchorEol);
  return lines.join("\n");
}

/**
 * Write-time half of review freshness: give a freshly saved review a VISIBLE
 * `> Reviewed commit: <sha>` line immediately after its leading Readiness
 * line, mirroring the trailing `<!-- reviewed-commit: <sha> -->` HTML comment
 * the model was asked to emit (which is kept — every existing parser reads
 * only the comment form). An operator skimming the artifact no longer has to
 * reach the last line to learn which commit the verdict describes.
 *
 * Also strips any stale-banner line from the content: a review being written
 * NOW assesses the current workspace by construction, so a banner could only
 * be the model echoing the previous review it was shown back into its own
 * output. Idempotent: an existing visible line is refreshed to the marker's
 * SHA in place, and content with no reviewed-commit marker is returned
 * unchanged (same string).
 */
export function withVisibleReviewedCommitLineV1(content: string): string {
  const reviewedSha = parseReviewedCommitSha(content);
  if (!reviewedSha) {
    return content;
  }
  const lines = content.split("\n");
  const kept = lines.filter((line) => !STALE_REVIEW_BANNER_RE_V1.test(line));
  const desired = `> Reviewed commit: ${reviewedSha}`;
  const visibleIndex = kept.findIndex((line) => VISIBLE_REVIEWED_COMMIT_LINE_RE_V1.test(line));
  if (visibleIndex !== -1) {
    const existing = kept[visibleIndex]!;
    const eol = existing.endsWith("\r") ? "\r" : "";
    if (kept.length === lines.length && existing === desired + eol) {
      return content;
    }
    kept[visibleIndex] = desired + eol;
    return kept.join("\n");
  }
  const anchorIndex = kept.findIndex((line) => READINESS_ANCHOR_LINE_RE_V1.test(line));
  const insertAt = anchorIndex === -1 ? 0 : anchorIndex + 1;
  const anchorEol =
    anchorIndex !== -1 && kept[anchorIndex]!.endsWith("\r") ? "\r" : "";
  kept.splice(insertAt, 0, desired + anchorEol);
  return kept.join("\n");
}

export function parseReviewProgress(content: string): ReviewProgress | null {
  // matchAll clones the regex internally, so the module-level `g` flag's
  // lastIndex is never carried between calls.
  const match = [...content.matchAll(PROGRESS_MARKER_RE)].at(-1);
  if (!match) {
    return null;
  }
  const complete = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(complete) || !Number.isInteger(total)) {
    return null;
  }
  if (total <= 0 || complete < 0 || complete > total) {
    return null;
  }
  return { complete, total };
}

/** See {@link parseReviewBlockers}; also reports whether the block existed. */
export function parseReviewBlockersDetailed(content: string): ReviewBlockerEvidence {
  const match = BLOCKERS_BLOCK_RE.exec(content);
  if (!match) {
    return { blockPresent: false, blockers: [], malformedLines: [] };
  }
  // Presence is decided by the MARKERS, not by the capture being non-empty.
  // `<!-- blockers:start --><!-- blockers:end -->` with nothing between them
  // captures "" (falsy), and testing the capture read that as "no block at
  // all" — the one shape that means "I looked and found zero blockers" was
  // therefore indistinguishable from "the model forgot the block", which
  // hasZeroTaskFixableEvidence deliberately refuses to treat as evidence.
  // That inverted the intent of an explicitly empty block.
  const body = match[1] ?? "";
  const blockers: ReviewBlocker[] = [];
  const malformedLines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank/whitespace-only lines are formatting, not content — never
      // reported as malformed.
      continue;
    }
    const lineMatch = BLOCKER_LINE_RE.exec(line);
    if (!lineMatch) {
      malformedLines.push(trimmed);
      continue;
    }
    const [, category, resolver, lineageRaw, description] = lineMatch;
    // `category` is absent when the reviewer emitted the resolver-only form;
    // that is accepted, so only resolver and description are required here.
    // Defaulting to "completion" is the conservative choice: it is the
    // rubric's general-purpose category, and it makes the sibling-disagreement
    // check (`implLowCompletionBlockers` below) MORE likely to surface a
    // conflict rather than less.
    if (!resolver || !description) {
      malformedLines.push(trimmed);
      continue;
    }
    const lineage = parseLineageBracket(lineageRaw);
    let resolvedResolver = resolver.toLowerCase() as BlockerResolver;
    if (isEnvironmentalResolverV1(resolvedResolver) && AGENT_CAN_GATHER_RE.test(description)) {
      resolvedResolver = "task-fixable";
    }
    blockers.push({
      category: (category ?? "completion").toLowerCase() as BlockerCategory,
      resolver: resolvedResolver,
      description,
      origin: "reviewer",
      ...(lineage ? { lineage } : {}),
    });
  }
  return { blockPresent: true, blockers, malformedLines };
}

const VERIFIED_NARROWING_BLOCK_RE =
  /<!--\s*verified-narrowing:start\s*-->([\s\S]*?)<!--\s*verified-narrowing:end\s*-->/i;
const VERIFIED_NARROWING_PART_LINE_RE = /^\s+not applicable:\s*(.+?)\s*$/i;

/** One narrowing a reviewer verified: the plan item, the part of it that does not apply, and checkable evidence. */
export interface ReviewVerifiedNarrowingV1 {
  readonly itemText: string;
  readonly notApplicable: string;
  readonly evidence: string;
}

/**
 * review1 Step 43: parse the `## Verified narrowing` block a reviewer files when it CAN check that part of a
 * ticked plan item does not apply:
 *
 *   <!-- verified-narrowing:start -->
 *   - <exact plan item text, copied verbatim>
 *     not applicable: <the part that does not apply>
 *     evidence: <checkable evidence: the file or symbol opened and what it shows>
 *   <!-- verified-narrowing:end -->
 *
 * An entry missing either continuation line is dropped (a narrowing without checkable evidence is the owner's
 * decision, not the reviewer's). An absent block yields an empty list.
 */
export function parseReviewVerifiedNarrowingsV1(content: string): ReviewVerifiedNarrowingV1[] {
  const match = VERIFIED_NARROWING_BLOCK_RE.exec(content);
  if (!match) {
    return [];
  }
  const entries: { itemText: string; notApplicable?: string; evidence?: string }[] = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const part = VERIFIED_NARROWING_PART_LINE_RE.exec(line);
    const evidence = VERIFIED_COMPLETE_EVIDENCE_LINE_RE.exec(line);
    const last = entries[entries.length - 1];
    if (part?.[1] && last && last.notApplicable === undefined) {
      last.notApplicable = part[1];
      continue;
    }
    if (evidence?.[1] && last && last.evidence === undefined) {
      last.evidence = evidence[1];
      continue;
    }
    const item = VERIFIED_COMPLETE_LINE_RE.exec(line);
    const itemText = item?.[1]?.replace(/^\[[ xX]\]\s+/, "").trim();
    if (itemText) {
      entries.push({ itemText });
    }
  }
  return entries.flatMap((entry) =>
    entry.notApplicable && entry.evidence
      ? [{ itemText: entry.itemText, notApplicable: entry.notApplicable, evidence: entry.evidence }]
      : []
  );
}

/** Result of {@link parseReviewVerifiedCompleteV1}. */
export interface ReviewVerifiedCompleteEvidence {
  /** True when the `<!-- verified-complete:start/end -->` markers were found. */
  readonly blockPresent: boolean;
  /** Plan-item texts the reviewer asserted it personally verified against the tree, in the order listed. */
  readonly items: readonly string[];
  /**
   * RC3 item 1, Step 2c: same items, paired with the reviewer's own
   * `  evidence: <sentence>` continuation line when the reviewer supplied
   * one (see resources/prompts/review-scoring-rubric.md's `## Verified
   * Complete` grammar). `evidence` is `undefined` for an older review that
   * predates this grammar, or an item whose evidence line was omitted —
   * callers show a fixed "older review format" fallback in that case, never
   * a sentence pulled from anywhere else in the review.
   */
  readonly entries: readonly { readonly text: string; readonly evidence?: string; readonly itemId?: string }[];
}

/**
 * review1 (owner decision 2026-11-05, item identity by design): a Verified Complete entry may cite the item by
 * the `[item:<id>]` Ensemble listed for it, optionally followed by the item's text. Captures the id and whatever
 * text follows it.
 */
const VERIFIED_COMPLETE_ITEM_ID_RE = /^[\s*_`[(]*item:\s*([0-9a-f]{16})(?![0-9a-z])[\s*_`\])]*(?:[:—–-]+\s*)?([\s\S]*)$/i;

/**
 * Parse the machine-readable `## Verified Complete` block a reviewer may emit
 * (see resources/prompts/review-scoring-rubric.md) naming plan-item lines it
 * personally checked against the tree and confirmed complete:
 *
 *   <!-- verified-complete:start -->
 *   - <exact plan item text, copied verbatim>
 *   <!-- verified-complete:end -->
 *
 * This is the reviewer's own assertion, the same class of evidence a round's
 * own retroactive claim already is (`collectRetroactiveTickClaimsV1`) — never
 * inferred from a diff. `applyReviewerVerifiedTicks` resolves each returned
 * item against the plan of record's currently-unchecked items before ticking
 * anything, so a paraphrased or stale item here simply fails to match rather
 * than ticking the wrong box.
 *
 * An absent block yields `blockPresent: false` with an empty `items` list —
 * older prompt versions and providers that ignore the instruction degrade to
 * "no verified-complete signal" rather than an error. A present-but-empty
 * block (`<!-- verified-complete:start --><!-- verified-complete:end -->`,
 * nothing between) is a normal "reviewer verified nothing new" result, not a
 * malformed one — mirrors `parseReviewBlockersDetailed`'s empty-block handling.
 */
export function parseReviewVerifiedCompleteV1(content: string): ReviewVerifiedCompleteEvidence {
  const match = VERIFIED_COMPLETE_BLOCK_RE.exec(content);
  if (!match) {
    return { blockPresent: false, items: [], entries: [] };
  }
  const body = match[1] ?? "";
  const items: string[] = [];
  const entries: { text: string; evidence?: string; itemId?: string }[] = [];
  let lastEntry: { text: string; evidence?: string; itemId?: string } | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const lineMatch = VERIFIED_COMPLETE_LINE_RE.exec(line);
    // A reviewer who copies the checklist line verbatim keeps its `[x]` / `[ ]`
    // box; the plan item's own text never starts with one, so drop it before matching.
    const itemText = lineMatch?.[1]?.replace(/^\[[ xX]\]\s+/, "").trim();
    if (itemText) {
      // An entry that cites `[item:<id>]` names the item by that id; any text after it is only a label.
      const idMatch = VERIFIED_COMPLETE_ITEM_ID_RE.exec(itemText);
      const itemId = idMatch?.[1]?.toLowerCase();
      const label = idMatch?.[2]?.replace(/^\[[ xX]\]\s+/, "").trim();
      const text = itemId ? (label ? label : `item:${itemId}`) : itemText;
      items.push(text);
      lastEntry = { text, evidence: undefined, ...(itemId ? { itemId } : {}) };
      entries.push(lastEntry);
      continue;
    }
    // RC3 item 1, Step 2c: an indented `evidence: <sentence>` continuation
    // line attaches to the preceding item only — a stray evidence line
    // before any item, or any other non-item line, is ignored exactly as
    // before this grammar existed.
    const evidenceMatch = VERIFIED_COMPLETE_EVIDENCE_LINE_RE.exec(line);
    if (evidenceMatch?.[1] && lastEntry && lastEntry.evidence === undefined) {
      lastEntry.evidence = evidenceMatch[1].trim();
    }
  }
  return { blockPresent: true, items, entries };
}

/**
 * Result of {@link detectSiblingReviewDisagreement}: the high-level review's
 * progress marker (claiming the plan is fully complete) and the low-level
 * review's own "completion" blockers (claiming required plan items are still
 * missing) — both parsed from reviews of the SAME commit, so the
 * contradiction between them is a fact, not an inference.
 */
export interface SiblingReviewDisagreement {
  implHighProgress: ReviewProgress;
  implLowCompletionBlockers: ReviewBlocker[];
}

/**
 * Detect the 2k failure mode: an impl-high review and an impl-low review of
 * the identical commit disagree on whether the plan is actually complete.
 * The task_5 evidence (2026-08-03) was exactly this — impl-high reported
 * "18 of 18 ordered steps complete" while impl-low, ~10 minutes later on the
 * same commit, reported that steps 5-18 did not exist yet. Nothing
 * reconciled the two before both fed publish.
 *
 * Deliberately conservative: only fires when all three reviewed-commit SHAs
 * (impl-high's, impl-low's, and the one the CURRENT review being built is
 * about to assess) are present and identical. Comparing reviews of different
 * commits would manufacture false disagreements out of ordinary staleness
 * (already 2i's problem, not this function's) rather than a genuine
 * same-commit contradiction. Returns null whenever either review is
 * missing, either SHA is unresolvable, the SHAs disagree, impl-high emitted
 * no progress marker or reports the plan incomplete, or impl-low reported no
 * "completion" category blocker — i.e. whenever there is nothing to
 * mechanically prove is a contradiction.
 */
export function detectSiblingReviewDisagreement(
  implHighReview: string | undefined,
  implLowReview: string | undefined,
  currentReviewedCommitSha: string | undefined
): SiblingReviewDisagreement | null {
  if (!implHighReview || !implLowReview || !currentReviewedCommitSha) {
    return null;
  }
  const highSha = parseReviewedCommitSha(implHighReview);
  const lowSha = parseReviewedCommitSha(implLowReview);
  if (!highSha || !lowSha) {
    return null;
  }
  if (highSha !== lowSha || highSha !== currentReviewedCommitSha) {
    return null;
  }
  const progress = parseReviewProgress(implHighReview);
  if (!progress || progress.complete !== progress.total) {
    return null;
  }
  const lowBlockers = parseReviewBlockersDetailed(implLowReview);
  const completionBlockers = lowBlockers.blockers.filter(
    (b) => b.category === "completion"
  );
  if (completionBlockers.length === 0) {
    return null;
  }
  return { implHighProgress: progress, implLowCompletionBlockers: completionBlockers };
}

/** Strict gate used by automatic stage advancement. */
export function isStrictPerfectReview(content: string): boolean {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let inFrontmatter = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || !line || line.startsWith("<!--") || line.endsWith("-->") || line.startsWith("#")) {
      continue;
    }
    return /^Readiness:\s*10(?:\.0+)?\/10$/.test(line);
  }
  return false;
}

/**
 * bugs5 Step 23: parsed owner decision block from review or implementation output.
 */
export interface ParsedOwnerDecisionOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
  readonly tradeOffs?: string;
  readonly planAction?: {
    readonly kind: "exclude" | "reword" | "approveDeviation";
    readonly itemText?: string;
    /** Checklist items the option settles (verbatim text), when it marks itself `[exclude]`. */
    readonly items?: readonly string[];
    readonly newText?: string;
    /** review1 Step 4: which of several identically worded top-level items a `reword` is about (1-based). */
    readonly itemOccurrence?: number;
  };
  /**
   * True when choosing this option keeps the plan as written (it starts "Reject", "Keep the plan", ...).
   * The choice is still recorded as the owner's decision, but the blocker is not set aside.
   */
  readonly rejects?: boolean;
}

export interface ParsedOwnerDecisionBlockV1 {
  readonly id: string;
  readonly planPurpose: string;
  readonly problem: string;
  readonly options: readonly ParsedOwnerDecisionOptionV1[];
  readonly recommendation?: {
    readonly optionId: string;
    readonly reason: string;
  };
  /**
   * review1 Step 42: set when a card should carry no recommended option (a deviation the review has not
   * checked); the text is the card's reason for recommending nothing.
   */
  readonly noRecommendationReason?: string;
  readonly technicalDetails?: string;
  readonly rawContentHash: string;
  readonly rawContent: string;
}

type OwnerDecisionFieldV1 = "id" | "purpose" | "problem" | "options" | "recommendation" | "planItems" | "technical";

function classifyOwnerDecisionLabelV1(label: string): OwnerDecisionFieldV1 | undefined {
  const l = label.toLowerCase().replace(/[`*_]/g, "").trim();
  if (l === "id") {
    return "id";
  }
  if (/^plan items?\b/.test(l)) {
    return "planItems";
  }
  if (/\bpurpose\b|\bplan is for\b|^what this part/.test(l)) {
    return "purpose";
  }
  if (/\bundecided\b|\bwent wrong\b|^problem\b/.test(l)) {
    return "problem";
  }
  if (/^(?:each )?options?\b/.test(l)) {
    return "options";
  }
  if (/^recommend/.test(l)) {
    return "recommendation";
  }
  if (/^technical\b|^details\b/.test(l)) {
    return "technical";
  }
  return undefined;
}

/** An option that keeps the plan as written rather than approving a change to it. */
const OWNER_DECISION_REJECT_RE =
  /^\W*(?:reject|revert|decline|rebuild|keep (?:the )?plan|keep (?:it )?as planned|build (?:it )?as planned|implement (?:it )?as planned|require|do not approve|don't approve|not approve)/i;

function slugOwnerDecisionTextV1(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * review1 Step 42: an item that says there is nothing to decide ("None.", "**None** beyond …", "No deviations",
 * "Nothing to report"), in bold, italic, dash or bullet form. It raises no card.
 */
const NONE_ITEM_TEXT_RE = /^[\s>*_`~\-–—•]*(?:none|n\/a|no\s+(?:plan\s+)?deviations?|nothing)\b/i;

export function isNoneItemTextV1(text: string): boolean {
  return NONE_ITEM_TEXT_RE.test(text.trim()) || isClosingStatusItemTextV1(text);
}

/**
 * review1 Step 42 (owner, 2026-11-04; bugs6 item 19): a closing status line that only says there is nothing
 * more ("Otherwise none.", "Nothing else.", "No other deviations.", "That is all."), wherever "none" or
 * "nothing" falls in the line. Kept to one short sentence that names no step or code, so a real departure
 * that happens to contain the word is never swallowed.
 */
const CLOSING_STATUS_RE =
  /\b(?:none|nothing|no\s+(?:other|further|more|additional|remaining)\s+(?:plan\s+)?(?:deviations?|decisions?|departures?)|that(?:'s|\s+is)\s+all)\b/i;

export function isClosingStatusItemTextV1(text: string): boolean {
  const plain = text
    .replace(/[*_~]/g, "")
    .replace(/^[\s>\-–—•]+/, "")
    .trim();
  if (plain.length === 0 || plain.length > 80 || plain.includes("\n") || plain.includes("`")) {
    return false;
  }
  if (/\bsteps?\s+\d/i.test(plain)) {
    return false;
  }
  return CLOSING_STATUS_RE.test(plain);
}

/** The block's text without a leading `###` heading line. */
function ownerDecisionBlockBodyV1(rawBlock: string): string {
  return rawBlock.replace(/^###+[ \t]+[^\n]*\n?/, "").trim();
}

/** The text of a `## <heading>` section, up to the next level-2 heading or HTML comment. */
function ownerDecisionSectionV1(content: string, heading: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)##[ \\t]+${heading}[ \\t]*\\n([\\s\\S]*?)(?=\\n##(?!#)|\\n<!--|$)`, "i").exec(content);
  const body = match?.[1]?.trim();
  if (!body || /^_?none\.?_?$/i.test(body)) {
    return undefined;
  }
  return body;
}

/** Splits a section into its `###` sub-blocks (the whole body when it has none). */
function splitOwnerDecisionBlocksV1(sectionBody: string): string[] {
  const starts = [...sectionBody.matchAll(/(?:^|\n)(###+[ \t]+[^\n]+)/g)].map(
    (m) => (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0)
  );
  if (starts.length === 0) {
    return [sectionBody];
  }
  return starts.map((start, i) => sectionBody.slice(start, starts[i + 1] ?? sectionBody.length).trim());
}

function parseOwnerDecisionOptionV1(
  text: string,
  planItems: readonly string[]
): { option: ParsedOwnerDecisionOptionV1; recommended: boolean } | undefined {
  let rest = text.trim();
  const excludes = /\[\s*exclude\s*\]/i.test(rest);
  rest = rest.replace(/\s*\[\s*exclude\s*\]/gi, "");
  const recommended = /\(\s*recommended\s*\)/i.test(rest);
  rest = rest.replace(/\s*\(\s*recommended\s*\)/gi, "");
  let explicitId: string | undefined;
  const idMatch = /^([A-Za-z][\w-]*)\s*:\s+(\S[\s\S]*)$/.exec(rest);
  if (idMatch) {
    explicitId = idMatch[1];
    rest = idMatch[2] ?? "";
  }
  // Split the label from its trade-offs only at a SPACED dash or a colon, never inside a word ("hand-off").
  const split = /^(.+?)\s+[—–-]\s+([\s\S]+)$/.exec(rest) ?? /^(.+?):\s+([\s\S]+)$/.exec(rest);
  const label = (split ? split[1] ?? "" : rest).replace(/[`*]/g, "").trim();
  const consequence = (split ? split[2] ?? "" : "").trim();
  if (label.length === 0) {
    return undefined;
  }
  const id = explicitId ?? slugOwnerDecisionTextV1(label);
  return {
    recommended,
    option: {
      id,
      label,
      ...(OWNER_DECISION_REJECT_RE.test(label) || OWNER_DECISION_REJECT_RE.test(id) ? { rejects: true } : {}),
      consequence: consequence || `Applies "${label}".`,
      ...(consequence ? { tradeOffs: consequence } : {}),
      ...(excludes && planItems.length > 0 ? { planAction: { kind: "exclude" as const, items: planItems } } : {}),
    },
  };
}

/**
 * bugs5 Step 23: parse `## Owner decisions needed` blocks from review output. Fields are recognised by
 * their label (`id`, what the plan part is for, what is undecided, options, recommendation, plan items,
 * technical details), so the order and bullet style the reviewer uses do not matter. An option marked
 * `[exclude]` settles the block's `Plan items:` (backticked, verbatim checklist text) when chosen.
 */
export function parseOwnerDecisionsNeededV1(content: string): readonly ParsedOwnerDecisionBlockV1[] {
  const sectionBody = ownerDecisionSectionV1(content, "Owner decisions needed");
  if (!sectionBody) {
    return [];
  }
  const results: ParsedOwnerDecisionBlockV1[] = [];
  splitOwnerDecisionBlocksV1(sectionBody).forEach((rawBlock, idx) => {
    if (!rawBlock) {
      return;
    }
    // review1 Step 42: "None. …" is a statement that nothing needs deciding, not a decision to raise.
    const blockBody = ownerDecisionBlockBodyV1(rawBlock);
    if (blockBody.length === 0 ? isNoneItemTextV1(rawBlock.replace(/^###+[ \t]+/, "")) : isNoneItemTextV1(blockBody)) {
      return;
    }
    let id = `owner-decision-${idx + 1}`;
    let body = rawBlock;
    const heading = /^###+[ \t]+([^\n]+)/.exec(rawBlock);
    if (heading?.[1]) {
      id = slugOwnerDecisionTextV1(heading[1]) || id;
      body = rawBlock.slice(heading[0].length);
    }
    const fields = new Map<OwnerDecisionFieldV1, string[]>();
    let current: OwnerDecisionFieldV1 | undefined;
    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\*\*/g, "").trimEnd();
      const labelled = /^\s*(?:[-*]\s+)?([^:\n]{1,80}?)\s*:\s*(.*)$/.exec(line);
      const labelledField = labelled ? classifyOwnerDecisionLabelV1(labelled[1] ?? "") : undefined;
      if (labelled && labelledField !== undefined) {
        current = labelledField;
        if (labelled[2]) {
          fields.set(current, [...(fields.get(current) ?? []), labelled[2]]);
        }
        continue;
      }
      const bare = /^\s*(?:[-*]\s+|#{3,}\s+)?([^:\n]{1,60}?)\s*:?\s*$/.exec(line);
      const bareField = bare ? classifyOwnerDecisionLabelV1(bare[1] ?? "") : undefined;
      if (bare && bareField !== undefined) {
        current = bareField;
        continue;
      }
      if (current !== undefined && line.trim().length > 0) {
        fields.set(current, [...(fields.get(current) ?? []), line]);
      }
    }
    const joined = (field: OwnerDecisionFieldV1): string =>
      (fields.get(field) ?? []).map((l) => l.trim()).join(" ").trim();

    const explicitId = /[A-Za-z0-9_-]+/.exec(joined("id"))?.[0];
    if (explicitId) {
      id = explicitId.toLowerCase();
    }
    const planItems = [...joined("planItems").matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);

    const options: ParsedOwnerDecisionOptionV1[] = [];
    let markerRecommendedId: string | undefined;
    let pending: string | undefined;
    const flush = (): void => {
      if (pending === undefined) {
        return;
      }
      const parsed = parseOwnerDecisionOptionV1(pending, planItems);
      pending = undefined;
      if (parsed) {
        options.push(parsed.option);
        if (parsed.recommended && markerRecommendedId === undefined) {
          markerRecommendedId = parsed.option.id;
        }
      }
    };
    for (const line of fields.get("options") ?? []) {
      const bullet = /^\s*(?:[-*]|\d+[.)])\s+(\S[\s\S]*)$/.exec(line);
      if (bullet) {
        flush();
        pending = bullet[1];
      } else if (pending !== undefined) {
        pending += ` ${line.trim()}`;
      }
    }
    flush();
    if (options.length === 0) {
      options.push(
        {
          id: "approve",
          label: "Approve and update plan",
          consequence: "Approves this choice and records the owner decision in plan-final.md.",
        },
        {
          id: "reject",
          label: "Reject and require implementation as planned",
          consequence: "Rejects this choice and requires the plan to be implemented as originally approved.",
        }
      );
    }

    // The recommendation names an option by id or label; resolve it so the card never points at nothing.
    let recommendation: ParsedOwnerDecisionBlockV1["recommendation"];
    const recText = joined("recommendation");
    if (recText) {
      const lead = /^(.+?)(?:\s+[—–-]\s+|:\s+|\.\s|$)/.exec(recText);
      const leadKey = slugOwnerDecisionTextV1(lead?.[1] ?? recText);
      const reason = (lead ? recText.slice(lead[0].length) : "").trim() || recText;
      const hit =
        options.find((o) => slugOwnerDecisionTextV1(o.id) === leadKey) ??
        options.find((o) => leadKey.length >= 3 && slugOwnerDecisionTextV1(o.label).startsWith(leadKey));
      if (hit) {
        recommendation = { optionId: hit.id, reason };
      }
    }
    if (!recommendation && markerRecommendedId) {
      recommendation = { optionId: markerRecommendedId, reason: "Marked as recommended by the reviewer." };
    }

    const technicalDetails = (fields.get("technical") ?? []).join("\n").trim();
    results.push({
      id,
      planPurpose: joined("purpose") || "Owner decision needed on plan item",
      problem: joined("problem") || body.trim().slice(0, 300),
      options,
      ...(recommendation ? { recommendation } : {}),
      ...(technicalDetails ? { technicalDetails } : {}),
      rawContentHash: createHash("sha256").update(rawBlock.trim(), "utf8").digest("hex"),
      rawContent: rawBlock.trim(),
    });
  });
  return results;
}

/**
 * bugs5 Step 23: parse `## Plan deviations` section from implementation/apply output.
 */
export interface PlanDeviationContextV1 {
  /** "Implementation" or "Apply Review": the round that reported the deviation. */
  readonly roundName?: string;
  /** The plan of record, used to name the step a deviation departs from. */
  readonly planOfRecord?: string;
  /** The latest review's text, used to say whether it already verified the departure. */
  readonly latestReviewText?: string;
}

/**
 * review1 Step 42: true when a review sentence naming `Step N` says, affirmatively, that it verified or accepted
 * that step. A negated mention ("Step 43 is not verified", "has not verified Step 43", "never accepted") is not a
 * verification, and neither is "unverified"; only the text after the step mention in the same sentence is read.
 */
export function reviewAffirmsStepVerifiedV1(reviewText: string, step: number, deviationText?: string): boolean {
  const mention = new RegExp(`\\bstep\\s+${step}(?!\\d)`, "ig");
  // Describing a mechanism ("uses an alternate mechanism") is not accepting it, so only verify/accept verbs count.
  const positive = /\b(?:verified|accepted)\b/i;
  // "verified for the tick path, but …", "only partly accepted", "still needs owner approval": the departure
  // itself is not affirmed.
  const contrast = /\b(?:but|however|except|although|though|only|partly|partially|other than|still\s+(?:needs?|requires?)|awaits?|pending)\b/i;
  // `no-card` is a compound adjective, not a negation.
  const negation = /\b(?:not|never|no(?!-)|cannot|without|isn't|wasn't|hasn't|haven't|didn't|doesn't|can't)\b|n't\b/i;
  const sentences = reviewText.split(/(?<=[.;!?])\s+|\n+/);
  // With the particular departure in hand, a sentence only verifies it when it talks about it (shares at least
  // two distinctive words with it), and any sentence about it that refuses it settles the question.
  const departureTerms = deviationText === undefined ? undefined : distinctiveTermsV1(deviationText);
  const talksAboutDeparture = (sentence: string): boolean => {
    if (departureTerms === undefined) return true;
    const terms = distinctiveTermsV1(sentence);
    let shared = 0;
    for (const term of terms) if (departureTerms.has(term)) shared += 1;
    return shared >= Math.min(2, departureTerms.size);
  };
  // A departure that leaves something out ("narrowings are written with no card") is only verified by a sentence
  // that talks about the omission itself. Verifying the thing that was left out ("the narrowing card text is
  // verified") shares the words but says nothing about leaving it out.
  const omissionTerms = deviationText === undefined ? [] : departureOmissionTermsV1(deviationText);
  // The cue and the thing left out must sit together ("no card", "skipped the confirmation"). A cue elsewhere in
  // the sentence ("the card text is verified without changes") does not say the card was left out.
  const coversDepartureOmission = (sentence: string): boolean => {
    if (omissionTerms.length === 0) return true;
    const stated = new Set(departureOmissionTermsV1(sentence));
    return omissionTerms.every((term) => stated.has(term));
  };
  if (departureTerms !== undefined) {
    const refusal = /\b(?:unverified|rejected?|unsupported|fabricated|contradict\w*|fails?|failed|not\s+(?:verified|accepted|supported|acceptable)|cannot\s+(?:verify|accept))\b/i;
    // A sentence that leaves the departure waiting on the owner ("still needs owner approval", "awaiting your
    // sign-off") is a refusal too, even though it never says "not verified". It only has to be about the
    // departure (one shared term, or the step named), because it often restates it in a few words.
    const pendingOwner =
      /\b(?:still\s+(?:needs?|requires?)|awaits?|awaiting|pending|needs?|requires?|subject\s+to)\b[^.;!?\n]*\b(?:owner|your|human)\b[^.;!?\n]*\b(?:approval|decision|sign-?off|confirmation|consent)\b|\bowner\s+(?:approval|sign-?off|decision)\s+(?:is\s+)?(?:still\s+)?(?:needed|required|pending|outstanding)\b/i;
    const sharesAnyTerm = (sentence: string): boolean => {
      for (const term of distinctiveTermsV1(sentence)) if (departureTerms.has(term)) return true;
      return false;
    };
    for (const sentence of sentences) {
      if (refusal.test(sentence) && talksAboutDeparture(sentence)) {
        return false;
      }
      mention.lastIndex = 0;
      if (pendingOwner.test(sentence) && (sharesAnyTerm(sentence) || mention.test(sentence))) {
        return false;
      }
    }
  }
  for (const sentence of sentences) {
    mention.lastIndex = 0;
    const found = mention.exec(sentence);
    if (!found) {
      continue;
    }
    const after = sentence.slice(found.index + found[0].length);
    const positiveMatch = positive.exec(after);
    if (!positiveMatch) {
      continue;
    }
    // A negation between the step mention and the verb ("is not verified"), or right before it in the same
    // clause ("has not verified"), makes it a refusal. Only the part before the verb matters.
    const before = sentence.slice(Math.max(0, found.index - 40), found.index + found[0].length + positiveMatch.index);
    const rest = sentence.slice(found.index + found[0].length + positiveMatch.index + positiveMatch[0].length);
    if (
      !negation.test(before) &&
      !contrast.test(before) &&
      !contrast.test(rest) &&
      talksAboutDeparture(sentence) &&
      coversDepartureOmission(sentence)
    ) {
      return true;
    }
  }
  return false;
}

const DEPARTURE_STOP_WORDS_V1: ReadonlySet<string> = new Set([
  "step", "steps", "plan", "deviation", "deviations", "departure", "round", "review", "reviewer", "verified",
  "accepted", "that", "this", "with", "from", "have", "were", "been", "which", "their", "there", "when", "than",
  "into", "also", "instead", "built", "work", "item", "items", "does", "while", "what", "about", "after", "because",
]);

/**
 * The things a departure says were left out: "no card", "without a card", "skipped the confirmation",
 * "omits the sign-off". Returned as the same normalised terms `distinctiveTermsV1` produces.
 */
function departureOmissionTermsV1(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:no|without|skip(?:s|ped|ping)?|omit(?:s|ted|ting)?|drops?|dropped|removes?|removed|lacks?)[-\s]+(?:(?:a|an|the|any|its|their)\s+)?([a-z][a-z-]{3,})(?!\s+(?:text|wording|copy|label|changes?)\b)/gi;
  // "no longer", "no more", "without any": not things that were left out.
  const notAThing = new Set(["longer", "more", "other", "need", "such", "change", "changes", "further"]);
  for (const match of text.matchAll(pattern)) {
    for (const term of distinctiveTermsV1(match[1]!)) if (!notAThing.has(term)) found.add(term);
  }
  return [...found];
}

/** Lower-case words of four or more letters that say something about a departure, split at hyphens. */
function distinctiveTermsV1(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z]{3,}/g) ?? []) {
    if (DEPARTURE_STOP_WORDS_V1.has(word)) continue;
    // A crude plural strip so "narrowings" and "narrowing" are the same term.
    terms.add(word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return terms;
}

/** The step number a deviation's text names ("Step 18", "Steps 19/22"), resolved against the plan's own steps. */
function stepNamedByDeviationV1(text: string, planOfRecord: string | undefined): number | undefined {
  const named = /\bsteps?\s+(\d+)(?!\d)/i.exec(text);
  if (!named) {
    return undefined;
  }
  const step = Number(named[1]);
  if (planOfRecord === undefined) {
    return step;
  }
  return listPlanItemStepOwnersV1(planOfRecord).some((owner) => owner.stepNumber === step) ? step : undefined;
}

/**
 * review1 Step 42 (owner, 2026-11-04; bugs6 item 17): a line about a deviation a round already reported, not a
 * new one ("the earlier deviation is withdrawn", "the plan's own deviations still stand", "already noted"). It
 * raises no card.
 */
const STATUS_NOTE_ITEM_RE = /\b(?:withdrawn|still\s+stands?|already\s+noted|no\s+longer\s+(?:a\s+)?deviations?)\b/i;

/**
 * The top-level bullets of a list as separate items. A bullet indented deeper than the shallowest bullet, and
 * any continuation line, belongs to the item above it (kept with its leading `-`).
 */
function splitTopLevelBulletsV1(body: string): string[] {
  const bullet = /^(\s*)[-*]\s+(.*)$/;
  const lines = body.split("\n");
  let topIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const match = bullet.exec(line);
    if (match) topIndent = Math.min(topIndent, match[1]!.length);
  }
  if (!Number.isFinite(topIndent)) {
    return [];
  }
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const match = bullet.exec(line);
    if (match && match[1]!.length <= topIndent) {
      if (current) items.push(current.join("\n").trim());
      current = [match[2]!];
    } else if (current && line.trim().length > 0) {
      current.push(line.trim());
    }
  }
  if (current) items.push(current.join("\n").trim());
  return items.filter((item) => item.length > 0);
}

/**
 * review1 Step 42: the text of a "None beyond …" deviations section after the "None". It belongs in the
 * round's summary line, never on a card.
 */
export function planDeviationsNoneNoteV1(content: string): string | undefined {
  const sectionBody = ownerDecisionSectionV1(content, "Plan deviations");
  if (!sectionBody || !NONE_ITEM_TEXT_RE.test(sectionBody.trim())) {
    return undefined;
  }
  const note = sectionBody.replace(NONE_ITEM_TEXT_RE, "").replace(/^[\s.:,;—–-]+/, "").trim();
  return note.length > 0 ? note : undefined;
}

/**
 * review1 Step 42 (owner, 2026-11-04; bugs6 item 19): which option a deviation card recommends. Approve only
 * when the latest review verified the deviation. Reject when it drops plan scope or an owner sign-off (an
 * exclusion, a narrowing, a skipped card or confirmation). Otherwise neither is recommended and the card says
 * the review has not checked it.
 */
const DEVIATION_DROPS_SCOPE_RE =
  /\b(?:exclu(?:de[sd]?|sions?)|narrow(?:s|ed|ing|ings)?|descop\w*|skipp?(?:s|ed|ing)?|drops?|dropped|left\s+out|without\s+(?:a\s+)?(?:card|confirmation|sign-?off|approval)|no\s+(?:card|confirmation|sign-?off))\b/i;

function deviationRecommendationV1(
  raw: string,
  verifiedByReview: boolean,
  hasReview: boolean
): Pick<ParsedOwnerDecisionBlockV1, "recommendation" | "noRecommendationReason"> {
  if (verifiedByReview) {
    return {
      recommendation: {
        optionId: "approve-deviation",
        reason: "Verified by the review: it checked this departure and found it acceptable.",
      },
    };
  }
  if (DEVIATION_DROPS_SCOPE_RE.test(raw)) {
    return {
      recommendation: {
        optionId: "reject-deviation",
        reason:
          "This departure drops plan scope or an owner sign-off (an exclusion, a narrowing, or a skipped card or confirmation), and the review has not verified it. Rejecting keeps the plan as written.",
      },
    };
  }
  return {
    noRecommendationReason: hasReview
      ? "The latest review has not checked this departure, so neither choice is recommended."
      : "No review has checked this departure yet, so neither choice is recommended.",
  };
}

export function parsePlanDeviationsV1(
  content: string,
  context: PlanDeviationContextV1 = {}
): readonly ParsedOwnerDecisionBlockV1[] {
  const sectionBody = ownerDecisionSectionV1(content, "Plan deviations");
  if (!sectionBody) {
    return [];
  }

  const items: string[] = [];
  if (/(?:^|\n)###+[ \t]/.test(sectionBody)) {
    items.push(...splitOwnerDecisionBlocksV1(sectionBody));
  } else {
    // Bullet items: one per TOP-LEVEL bullet, whose indented sub-bullets ("Why", "What changed", "Trade-off") are
    // that deviation's body and never cards of their own.
    const bullets = splitTopLevelBulletsV1(sectionBody);
    if (bullets.length > 0) {
      items.push(...bullets);
    } else {
      // Paragraphs
      const paragraphs = sectionBody.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
      items.push(...paragraphs);
    }
  }

  const results: ParsedOwnerDecisionBlockV1[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx];
    if (!raw) {
      continue;
    }
    // review1 Step 42: "None", "None beyond …", "No deviations" and "Nothing …" raise no card (a `###` heading
    // line does not count as the item's text).
    const itemText = raw.replace(/^#+[^\n]*\n?/, "").trim();
    if (isNoneItemTextV1(itemText.length > 0 ? itemText : raw) || STATUS_NOTE_ITEM_RE.test(raw)) {
      continue;
    }
    const rawContentHash = createHash("sha256").update(raw.trim(), "utf8").digest("hex");
    // Keyed by content, not position: a different deviation in a later round is a different card.
    const id = `plan-deviation-${rawContentHash.slice(0, 8)}`;
    const roundName = context.roundName ?? "The round";
    const step = stepNamedByDeviationV1(raw, context.planOfRecord);
    const title = step !== undefined
      ? `${roundName} built Step ${step} differently from the plan`
      : `${roundName} reports a departure from the plan`;
    const verifiedByReview =
      step !== undefined &&
      context.latestReviewText !== undefined &&
      reviewAffirmsStepVerifiedV1(context.latestReviewText, step, raw);
    const reviewView = context.latestReviewText === undefined
      ? ""
      : verifiedByReview
        ? " The latest review already verified it."
        : " The latest review has not verified it.";
    results.push({
      id,
      planPurpose: title,
      problem: `${raw.trim()}${reviewView}`,
      options: [
        {
          id: "approve-deviation",
          label: "Approve plan deviation",
          consequence: "Accepts this deviation and records owner approval in plan-final.md.",
          planAction: { kind: "approveDeviation" },
        },
        {
          id: "reject-deviation",
          label: "Reject plan deviation",
          consequence:
            "Rejects this deviation. Work already done is kept in the working tree; the next round must bring it back in line with the original plan.",
          rejects: true,
        },
      ],
      ...deviationRecommendationV1(raw, verifiedByReview, context.latestReviewText !== undefined),
      rawContentHash,
      rawContent: raw.trim(),
    });
  }

  return results;
}
