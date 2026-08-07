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

export interface ReadinessResult {
  score: number | null;
  /** Formatted label e.g. "9/10" or "—/10" */
  label: string;
}

/** Primary regex: exact `Readiness: N/10` line (N whole or one-plus decimals) */
const EXACT_READINESS_RE = /^Readiness:\s*(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\s*$/m;
/** Legacy fallback: case-insensitive `readiness` keyword + N/10 anywhere */
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
}

const BLOCKERS_BLOCK_RE = /<!--\s*blockers:start\s*-->([\s\S]*?)<!--\s*blockers:end\s*-->/i;
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
  /^\s*[-*]\s*(?:\[\s*(architectural|completion|review-confidence|shipping)\s*\]\s*)?\[\s*(task-fixable|environmental|unverifiable|spec-defect|needs-toolchain)\s*\]\s*(.+?)\s*$/i;

/**
 * Parse the machine-readable blocker block reviewers are asked to emit
 * (see resources/prompts/review-scoring-rubric.md) in addition to their
 * prose blocker sections:
 *
 *   <!-- blockers:start -->
 *   - [completion] [task-fixable] short description
 *   <!-- blockers:end -->
 *
 * Absent, malformed, or unparseable lines are simply skipped — a review
 * that omits the block (older prompt version, or a provider that didn't
 * follow instructions) yields an empty array rather than throwing, so
 * routing degrades to "no structured blocker signal" instead of failing.
 */
export function parseReviewBlockers(content: string): ReviewBlocker[] {
  return parseReviewBlockersDetailed(content).blockers;
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
}

/** Conservative match for an explicit prose "no blockers" declaration —
 * secondary evidence when a review omits the machine block but states the
 * absence outright. Deliberately anchored so "no NEW blockers" or "no
 * blockers in this file" prose deeper in a sentence doesn't count. */
const EXPLICIT_NO_BLOCKERS_RE = /^\s*(?:[-*]\s*)?(?:blockers?:\s*none\b|no blockers\b)/im;

/**
 * Positive evidence this review reported zero task-fixable blockers: either
 * the machine-readable block is present and contains no task-fixable entry,
 * or the review explicitly states there are no blockers. Mere ABSENCE of the
 * block is never evidence — see ReviewBlockerEvidence.
 */
export function hasZeroTaskFixableEvidence(content: string): boolean {
  const evidence = parseReviewBlockersDetailed(content);
  if (evidence.blockPresent) {
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
    return { blockPresent: false, blockers: [] };
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
  for (const line of body.split(/\r?\n/)) {
    const lineMatch = BLOCKER_LINE_RE.exec(line);
    if (!lineMatch) {
      continue;
    }
    const [, category, resolver, description] = lineMatch;
    // `category` is absent when the reviewer emitted the resolver-only form;
    // that is accepted, so only resolver and description are required here.
    // Defaulting to "completion" is the conservative choice: it is the
    // rubric's general-purpose category, and it makes the sibling-disagreement
    // check (`implLowCompletionBlockers` below) MORE likely to surface a
    // conflict rather than less.
    if (!resolver || !description) {
      continue;
    }
    blockers.push({
      category: (category ?? "completion").toLowerCase() as BlockerCategory,
      resolver: resolver.toLowerCase() as BlockerResolver,
      description,
    });
  }
  return { blockPresent: true, blockers };
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
