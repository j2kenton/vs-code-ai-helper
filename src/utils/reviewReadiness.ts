/**
 * Centralizes review readiness parsing and icon-band mapping.
 *
 * Review artifacts must include a top-level line in this exact form:
 *   Readiness: N/10
 *
 * Scores map to regular ticks/arrows (not thumbs/question glyphs):
 *   8-10 -> green positive  (check)
 *   5-7  -> yellow caution  (arrow-right)
 *   0-4  -> red negative    (arrow-down)
 */

export interface ReadinessResult {
  score: number | null;
  /** Formatted label e.g. "9/10" or "—/10" */
  label: string;
  /** VS Code codicon name */
  icon: string;
  /** VS Code ThemeColor key */
  colorKey: string;
}

/** Primary regex: exact `Readiness: N/10` line */
const EXACT_READINESS_RE = /^Readiness:\s*(10|[0-9])\/10\s*$/m;
/** Legacy fallback: case-insensitive `readiness` keyword + N/10 anywhere */
const LEGACY_READINESS_RE = /readiness[^0-9]*(10|[0-9])\/10/i;

/**
 * Parse readiness from a review artifact string.
 * Returns a ReadinessResult with icon/color for the sidebar.
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
    return {
      score: null,
      label: "—/10",
      // Must be circle-LARGE-outline, matching the "outstanding" stage rows in
      // taskTreeProvider. The smaller plain "circle-outline" made a current
      // review stage whose artifact has no parseable score render with a
      // visibly smaller circle than its neighbours (the reported intermittent
      // "smaller circle on High-Level Review (Plan)").
      icon: "circle-large-outline",
      colorKey: "disabledForeground",
    };
  }

  if (score >= 8) {
    return {
      score,
      label: `${score}/10`,
      icon: "check",
      colorKey: "charts.green",
    };
  }
  if (score >= 5) {
    return {
      score,
      label: `${score}/10`,
      icon: "arrow-right",
      colorKey: "charts.yellow",
    };
  }
  return {
    score,
    label: `${score}/10`,
    icon: "arrow-down",
    colorKey: "charts.red",
  };
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
