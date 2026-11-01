/**
 * bugs4 item 19 / Step 27: an owner-evidence gate the plan describes in the present tense
 * ("the current `task.md` has no …") goes stale the moment the owner records the evidence. The
 * latest review has already decided whether `task.md` now satisfies the gate, so a round that is
 * carrying that blocker is told the verdict, and a round whose summary contradicts a "satisfied"
 * verdict is flagged instead of being counted as a stall.
 *
 * Pure text functions: nothing here reads files or posts anything.
 */

export interface OwnerEvidenceVerdictV1 {
  readonly state: "satisfied" | "unmet";
  /** The review sentence or blocker the verdict was read from (trimmed, one line). */
  readonly sourceText: string;
}

const BLOCKERS_BLOCK_RE = /<!--\s*blockers:start\s*-->([\s\S]*?)<!--\s*blockers:end\s*-->/i;
const OWNER_EVIDENCE_BLOCKER_RE = /\bowner[- ]evidence\b/i;
/** "task.md now satisfies the owner-preservation prerequisite", "the gate is satisfied", … */
const SATISFIED_RE =
  /\b(?:now\s+)?(?:satisf(?:ies|ied|y)|meets?|fulfil(?:s|led))\b[^.\n]{0,120}\b(?:owner|evidence|prerequisite|gate)\b|\b(?:owner|evidence|prerequisite|gate)\b[^.\n]{0,120}\b(?:is|are|now)\s+(?:satisfied|met|recorded|present)\b/i;

function stripBlockersBlock(review: string): string {
  return review.replace(BLOCKERS_BLOCK_RE, "");
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237).trimEnd()}…` : collapsed;
}

/**
 * The latest review's verdict on the owner-evidence gate, or undefined when it says nothing
 * about one. An owner-evidence blocker still listed means "unmet"; a review sentence outside
 * the blockers block that says the evidence/prerequisite/gate is satisfied, with no such blocker
 * left, means "satisfied".
 */
export function readOwnerEvidenceVerdictV1(reviewContent: string): OwnerEvidenceVerdictV1 | undefined {
  const blockers = BLOCKERS_BLOCK_RE.exec(reviewContent)?.[1] ?? "";
  const unmetLine = blockers
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("-") && OWNER_EVIDENCE_BLOCKER_RE.test(line));
  if (unmetLine !== undefined) {
    return { state: "unmet", sourceText: oneLine(unmetLine.replace(/^\s*-\s*/, "")) };
  }
  const satisfiedLine = stripBlockersBlock(reviewContent)
    .split(/\r?\n/)
    .find((line) => SATISFIED_RE.test(line) && /task\.md|owner/i.test(line));
  if (satisfiedLine !== undefined) {
    return { state: "satisfied", sourceText: oneLine(satisfiedLine.replace(/^\s*[-*>]\s*/, "")) };
  }
  return undefined;
}

/**
 * The block appended to a round's review text. Empty when the review has no verdict. A
 * "satisfied" verdict also tells the round the plan's gate wording is superseded.
 */
export function formatOwnerEvidenceVerdictForRoundV1(reviewContent: string): string {
  const verdict = readOwnerEvidenceVerdictV1(reviewContent);
  if (verdict === undefined) return "";
  if (verdict.state === "unmet") {
    return (
      "\n\n## Owner-evidence verdict from the latest review\n\n" +
      `owner evidence: not yet satisfied — ${verdict.sourceText}\n`
    );
  }
  return (
    "\n\n## Owner-evidence verdict from the latest review\n\n" +
    `owner evidence: satisfied — ${verdict.sourceText}\n\n` +
    "The `## User Request` section above is the current `task.md`. Where the plan says `task.md` " +
    "currently has no such evidence, that wording is superseded by this verdict and by the current " +
    "`task.md`; do not treat the gate as unmet. Build the work the gate was holding back.\n"
  );
}

/** Round-summary phrasings that declare an owner-evidence gate unmet. */
const SUMMARY_DECLARES_UNMET_RE =
  /\b(?:task\.md\b[^.\n]{0,100}\b(?:still\s+)?(?:has|contains|records|names|lacks)\s+no\b|no\s+owner[- ](?:selected|recorded|supplied)\b|owner[- ]evidence\b[^.\n]{0,60}\b(?:is\s+)?(?:still\s+)?(?:missing|unmet|not\s+(?:recorded|present|satisfied)))/i;

export interface OwnerEvidenceContradictionV1 {
  readonly summaryText: string;
  readonly reviewVerdictText: string;
}

/**
 * The latest review marked the gate satisfied but the round's summary says it is unmet. Returns
 * undefined when the review has no "satisfied" verdict or the summary does not claim the opposite.
 */
export function detectOwnerEvidenceContradictionV1(
  reviewContent: string,
  roundSummary: string
): OwnerEvidenceContradictionV1 | undefined {
  const verdict = readOwnerEvidenceVerdictV1(reviewContent);
  if (verdict?.state !== "satisfied") return undefined;
  const line = roundSummary.split(/\r?\n/).find((candidate) => SUMMARY_DECLARES_UNMET_RE.test(candidate));
  if (line === undefined) return undefined;
  return { summaryText: oneLine(line), reviewVerdictText: verdict.sourceText };
}

/** The one chat line for a contradiction. */
export function formatOwnerEvidenceContradictionLineV1(contradiction: OwnerEvidenceContradictionV1): string {
  return (
    "The round reported an owner-evidence gate as unmet, but the latest review found it satisfied. " +
    `Round: “${contradiction.summaryText}” Review: “${contradiction.reviewVerdictText}” ` +
    "This round is not counted as a stall; run the next stage action again and it will carry the review's verdict."
  );
}
