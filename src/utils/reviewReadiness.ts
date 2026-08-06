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
 */
export type BlockerResolver = "task-fixable" | "environmental" | "unverifiable" | "spec-defect";

export interface ReviewBlocker {
  category: BlockerCategory;
  resolver: BlockerResolver;
  description: string;
}

const BLOCKERS_BLOCK_RE = /<!--\s*blockers:start\s*-->([\s\S]*?)<!--\s*blockers:end\s*-->/i;
const BLOCKER_LINE_RE =
  /^\s*[-*]\s*\[\s*(architectural|completion|review-confidence|shipping)\s*\]\s*\[\s*(task-fixable|environmental|unverifiable|spec-defect)\s*\]\s*(.+?)\s*$/i;

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
    if (!category || !resolver || !description) {
      continue;
    }
    blockers.push({
      category: category.toLowerCase() as BlockerCategory,
      resolver: resolver.toLowerCase() as BlockerResolver,
      description,
    });
  }
  return { blockPresent: true, blockers };
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
