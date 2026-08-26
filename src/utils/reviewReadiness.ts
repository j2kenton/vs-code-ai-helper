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

import { BlockerLineageDeclaration, TaskStage } from "../types/taskProgress";

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
 * So when the plan still lists unchecked items, THOSE numbers win, and no
 * reported marker can advance the stage. Deliberately asymmetric: a checklist
 * with nothing left unchecked does NOT override a review still reporting
 * itself mid-plan — either source may say "not finished", neither may
 * unilaterally say "finished".
 *
 * A plan with no checklist at all reconciles to the review's own marker
 * unchanged, so tasks that never generated one behave exactly as before.
 *
 * This does not itself escalate. It removes the false "done" so the loop keeps
 * building the remaining items, and a task that genuinely cannot progress hits
 * the existing no-progress breaker and escalates to the human there — which is
 * the intended route for a plan that cannot be implemented as written.
 */
export function reconcileProgressWithChecklistV1(
  progress: ReviewProgress | null,
  checklist: { total: number; checked: number; remaining: number } | undefined
): ReviewProgress | null {
  if (!checklist || checklist.remaining <= 0) {
    return progress;
  }
  return { complete: checklist.checked, total: checklist.total };
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
  | "unverifiable"
  | "spec-defect"
  | "needs-toolchain";

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
  /^\s*[-*]\s*(?:\[\s*(architectural|completion|review-confidence|shipping)\s*\]\s*)?\[\s*(task-fixable|environmental|unverifiable|spec-defect|needs-toolchain)\s*\]\s*(?:\[\s*(new|same\s*:\s*[\w-]+|narrowed\s*:\s*[\w-]+)\s*\]\s*)?(.+?)\s*$/i;

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

/** The placeholder a workspace-change staling writes (reviewActions.ts's
 * markReviewArtifactStale). Freshness marking must never touch one: it has
 * no Readiness line and its staleness is already its whole content. */
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
  const bannerIndex = lines.findIndex((line) => STALE_REVIEW_BANNER_TEXT_RE_V1.test(line));
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
    blockers.push({
      category: (category ?? "completion").toLowerCase() as BlockerCategory,
      resolver: resolver.toLowerCase() as BlockerResolver,
      description,
      origin: "reviewer",
      ...(lineage ? { lineage } : {}),
    });
  }
  return { blockPresent: true, blockers, malformedLines };
}

/** Result of {@link parseReviewVerifiedCompleteV1}. */
export interface ReviewVerifiedCompleteEvidence {
  /** True when the `<!-- verified-complete:start/end -->` markers were found. */
  readonly blockPresent: boolean;
  /** Plan-item texts the reviewer asserted it personally verified against the tree, in the order listed. */
  readonly items: readonly string[];
}

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
    return { blockPresent: false, items: [] };
  }
  const body = match[1] ?? "";
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const lineMatch = VERIFIED_COMPLETE_LINE_RE.exec(line);
    if (lineMatch?.[1]) {
      items.push(lineMatch[1]);
    }
  }
  return { blockPresent: true, items };
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
