/**
 * Post-1.0 fixes, item 10: a review can contradict itself — its verdict or
 * "next" text names plan steps that are still to be built while its blockers
 * list carries no `[completion]` blocker, so the score stays above the
 * threshold and the stage would advance on unfinished work.
 *
 * The review prompts now ask for one `[completion]` blocker naming unbuilt
 * steps. This is the check on the review Ensemble parses: if the text says
 * steps remain to be built and no completion blocker backs that up, the stage
 * is held and the chat card says why.
 *
 * Built-but-unticked items are NOT unbuilt work (reviewers list those under
 * `## Verified Complete`), so a sentence that says so never counts.
 */
import { parseReviewBlockersDetailed } from "./reviewReadiness";

export interface UnbuiltStepsContradictionV1 {
  /** The sentence of the verdict / next-work text that names unbuilt steps. */
  readonly sentence: string;
}

const NAMES_PLAN_STEPS_RE =
  /\b(?:plan\s+)?(?:steps?|items?)\s+\d+|\bStep\s+\d+|\bchecklist items?\b|\bplan (?:steps|items)\b|\bPart\s+\d+/i;

const STILL_TO_BUILD_RE = new RegExp(
  "\\b(?:" +
    "remain(?:s|ing)?\\s+(?:to\\s+be\\s+)?(?:built|implemented|done|unbuilt)" +
    "|still\\s+(?:to\\s+(?:build|implement|do|finish)|needs?\\s+(?:to\\s+be\\s+)?(?:built|implemented|finished))" +
    "|not\\s+(?:yet\\s+)?(?:been\\s+)?(?:built|implemented|started)" +
    "|unbuilt" +
    "|(?:finish|build|implement|complete|continue(?:\\s+with)?)\\s+(?:the\\s+)?(?:remaining\\s+)?(?:Step|steps|items?|Part)" +
    "|next,?\\s+(?:finish|build|implement|complete)" +
    "|come\\s+next" +
    "|left\\s+to\\s+(?:build|do)" +
    ")\\b",
  "i"
);

const BUILT_BUT_NOT_TICKED_RE =
  /\b(?:built|implemented|done|completed?)\s+but\s+(?:not|un)\s*ticked|\bun-?ticked\b|\bnot\s+ticked\b|\balready\s+(?:built|implemented|done)\b|\bverified\s+complete\b/i;

const BLOCKS_RE = /<!--\s*(?:blockers|verified-complete):start\s*-->[\s\S]*?<!--\s*(?:blockers|verified-complete):end\s*-->/gi;

/** The verdict and next-work segments of a review, without its machine-readable blocks. */
function verdictAndNextSegments(content: string): string[] {
  const body = content.replace(BLOCKS_RE, "");
  const lines = body.split(/\r?\n/);
  const segments: string[] = [];
  let sectionHeading = false;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      segments.push(current.join(" "));
      current = [];
    }
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s*(.*)$/.exec(line);
    if (heading) {
      flush();
      sectionHeading = /\b(verdict|next(?:\s+steps)?|coverage|remaining|summary)\b/i.test(heading[1] ?? "");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (sectionHeading || /\bverdict\b/i.test(line.slice(0, 40)) || /^\W*next\b/i.test(line)) {
      current.push(line.trim());
    }
  }
  flush();
  return segments;
}

/**
 * The first sentence in the review's verdict / next-work text that names plan
 * steps still to be built, when the review has no `[completion]` blocker.
 * `undefined` when the review is consistent (or says nothing about open steps).
 */
export function findUnbuiltStepsWithoutCompletionBlockerV1(
  content: string
): UnbuiltStepsContradictionV1 | undefined {
  const evidence = parseReviewBlockersDetailed(content);
  if (evidence.blockers.some((blocker) => blocker.category === "completion")) {
    return undefined;
  }
  for (const segment of verdictAndNextSegments(content)) {
    for (const sentence of segment.split(/(?<=[.!?])\s+|\s+—\s+(?=Next\b)/)) {
      if (
        NAMES_PLAN_STEPS_RE.test(sentence) &&
        STILL_TO_BUILD_RE.test(sentence) &&
        !BUILT_BUT_NOT_TICKED_RE.test(sentence)
      ) {
        return { sentence: sentence.trim() };
      }
    }
  }
  return undefined;
}
