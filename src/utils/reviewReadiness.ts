/**
 * Centralizes review readiness parsing.
 *
 * Review artifacts must include a top-level line in this exact form:
 *   Readiness: N/10
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

/** Primary regex: exact `Readiness: N/10` line */
const EXACT_READINESS_RE = /^Readiness:\s*(10|[0-9])\/10\s*$/m;
/** Legacy fallback: case-insensitive `readiness` keyword + N/10 anywhere */
const LEGACY_READINESS_RE = /readiness[^0-9]*(10|[0-9])\/10/i;

/**
 * Parse readiness from a review artifact string.
 */
export function parseReadiness(content: string): ReadinessResult {
  let score: number | null = null;

  const exactMatch = EXACT_READINESS_RE.exec(content);
  if (exactMatch?.[1] !== undefined) {
    score = parseInt(exactMatch[1], 10);
  } else {
    const legacyMatch = LEGACY_READINESS_RE.exec(content);
    if (legacyMatch?.[1] !== undefined) {
      score = parseInt(legacyMatch[1], 10);
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
    return line === "Readiness: 10/10";
  }
  return false;
}
