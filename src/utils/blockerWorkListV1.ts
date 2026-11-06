import { blockerIdentity } from "./reviewRouting";
import {
  type BlockerPlanReferenceV1,
  normalizeChecklistItemTextV1,
  resolveBlockerPlanReferencesV1,
} from "./implementationChecklist";
import type { ReviewBlocker } from "./reviewReadiness";
import type { ReviewBlockerIdentity } from "../types/taskProgress";

/**
 * review1 Step 19: Ensemble sorts a review's blockers before a round starts, so the round does not have to guess
 * which ones it can act on and in what order (review1 item 1 and the moved wf12 sections: ten rounds in a row that
 * patched around two blockers that were really unbuilt plan steps, while 53 steps sat unbuilt).
 *
 * Three groups, using only what the review artifact already records (category, resolver, lineage):
 *  - fix first: a task-fixable defect in work that is already built;
 *  - build to clear: a `[completion]` blocker that names unbuilt plan work. Building the named steps IS the fix;
 *  - not this round, with the reason: the owner must decide, no code change resolves it (`environmental`,
 *    `needs-toolchain`), it has been `[same:]` across `plateauRounds` reviews, or earlier rounds declined it with
 *    recorded reasons. Another round on it would be wasted, so it is escalated, not retried.
 */
export interface BlockerWorkItemV1 {
  readonly blocker: ReviewBlocker;
}

export interface BuildToClearItemV1 extends BlockerWorkItemV1 {
  /** The plan steps, parts and items the blocker names that are still open (`Step 4`, `Part B`, an item's text). */
  readonly plan: readonly BlockerPlanReferenceV1[];
}

export interface NotThisRoundItemV1 extends BlockerWorkItemV1 {
  readonly reason: string;
  /** Why it is not this round's work: `standing` and `declined` are the ones Step 39 hands to the owner by name. */
  readonly kind?: "owner" | "environmental" | "needs-toolchain" | "declined" | "standing";
}

export interface BlockerWorkListV1 {
  readonly fixFirst: readonly BlockerWorkItemV1[];
  readonly buildToClear: readonly BuildToClearItemV1[];
  readonly notThisRound: readonly NotThisRoundItemV1[];
}

export interface BlockerWorkListInputV1 {
  readonly blockers: readonly ReviewBlocker[];
  /** The plan of record, to resolve the steps a completion blocker names; without it no blocker is "build to clear". */
  readonly planOfRecord?: string;
  /**
   * The blocker identities of the PRIOR reviews of this stage, oldest first, not including the review that produced
   * `blockers`. A blocker that matches (same category and subject) in the last `plateauRounds - 1` of them has stood
   * across `plateauRounds` reviews.
   */
  readonly priorReviewBlockers?: readonly (readonly ReviewBlockerIdentity[])[];
  /** `ensemble.reviewPlateauRounds`. */
  readonly plateauRounds: number;
  /** Blockers earlier rounds declined with recorded reasons (`## Remaining Blockers`). */
  readonly declined?: readonly { readonly blockerText: string; readonly reason: string }[];
}

const OWNER_ONLY_RE =
  /\bowner (?:decision|evidence)\b|\bawaits? (?:a |an |the )?(?:human|owner|decision)|\bneeds? (?:a |an |the )?(?:human|owner)\b|\banother task\b|\bneeds your decision\b/i;
const UNBUILT_RE =
  /\b(?:un-?built|not (?:yet )?(?:built|implemented|started|reached)|remains? (?:un-?built|incomplete|unimplemented|open|to be built)|still (?:lacks?|missing|to be built)|is missing|are missing|not delivered|incomplete)\b/i;

function normalizeBlockerText(text: string): string {
  return normalizeChecklistItemTextV1(text).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** True when `text` restates a declined blocker (reviews reword, so containment either way counts). */
function matchesDeclined(description: string, declinedText: string): boolean {
  const a = normalizeBlockerText(description);
  const b = normalizeBlockerText(declinedText);
  return a.length > 12 && b.length > 12 && (a.includes(b) || b.includes(a));
}

/** How many consecutive reviews (this one plus the prior ones, newest first) the blocker has been raised in. */
export function countReviewsBlockerHasStoodV1(
  blocker: ReviewBlocker,
  priorReviewBlockers: readonly (readonly ReviewBlockerIdentity[])[] | undefined
): number {
  const identity = blockerIdentity(blocker);
  let rounds = 1;
  for (let i = (priorReviewBlockers?.length ?? 0) - 1; i >= 0; i--) {
    const prior = priorReviewBlockers![i]!;
    const stood = prior.some((p) => p.category === identity.category && p.subject === identity.subject);
    if (!stood) break;
    rounds++;
  }
  return rounds;
}

export function buildBlockerWorkListV1(input: BlockerWorkListInputV1): BlockerWorkListV1 {
  const fixFirst: BlockerWorkItemV1[] = [];
  const buildToClear: BuildToClearItemV1[] = [];
  const notThisRound: NotThisRoundItemV1[] = [];
  for (const blocker of input.blockers) {
    const { resolver, description } = blocker;
    const declined = input.declined?.find((d) => matchesDeclined(description, d.blockerText));
    if (OWNER_ONLY_RE.test(description) || resolver === "spec-defect") {
      notThisRound.push({ blocker, reason: "it needs a decision only the owner can make", kind: "owner" });
      continue;
    }
    if (resolver === "environmental-fixable") {
      notThisRound.push({
        blocker,
        reason: "it is environmental in origin; a bounded out-of-plan fix may clear it (needs the owner's go-ahead to investigate)",
        kind: "environmental",
      });
      continue;
    }
    if (resolver === "environmental") {
      notThisRound.push({ blocker, reason: "no code change resolves it (environmental)", kind: "environmental" });
      continue;
    }
    if (resolver === "needs-toolchain") {
      notThisRound.push({
        blocker,
        reason: "it needs a build or toolchain step this stage cannot run (needs-toolchain)",
        kind: "needs-toolchain",
      });
      continue;
    }
    if (declined) {
      notThisRound.push({
        blocker,
        reason: `earlier rounds declined it, with the recorded reason: ${declined.reason}`,
        kind: "declined",
      });
      continue;
    }
    if (input.plateauRounds > 0 && countReviewsBlockerHasStoodV1(blocker, input.priorReviewBlockers) >= input.plateauRounds) {
      notThisRound.push({
        blocker,
        reason: `it has stood unchanged across ${input.plateauRounds} reviews, so another round on it alone would not help`,
        kind: "standing",
      });
      continue;
    }
    if (blocker.category === "completion" && resolver === "task-fixable" && UNBUILT_RE.test(description)) {
      const plan = input.planOfRecord ? resolveBlockerPlanReferencesV1(description, input.planOfRecord).filter((r) => r.open > 0) : [];
      if (plan.length > 0) {
        buildToClear.push({ blocker, plan });
        continue;
      }
    }
    fixFirst.push({ blocker });
  }
  return { fixFirst, buildToClear, notThisRound };
}

/** The `{{blockerWorkList}}` prompt variable: the three groups, in the order a round works through them. */
export function formatBlockerWorkListV1(list: BlockerWorkListV1): string {
  if (list.fixFirst.length + list.buildToClear.length + list.notThisRound.length === 0) {
    return "The review lists no blockers.";
  }
  const line = (b: ReviewBlocker): string => `[${b.category}] [${b.resolver}] ${b.description}`;
  const sections: string[] = [];
  sections.push(
    "1. Fix first — defects in work that is already built (fix these before building anything on top of them):",
    ...(list.fixFirst.length > 0 ? list.fixFirst.map((item) => `   - ${line(item.blocker)}`) : ["   - (none)"])
  );
  sections.push(
    "2. Build to clear — the blocker names plan work that is not built yet; building the named steps is the fix:",
    ...(list.buildToClear.length > 0
      ? list.buildToClear.map(
          (item) => `   - ${line(item.blocker)}\n     Build: ${item.plan.map((r) => `${r.reference} (${r.open} open)`).join(", ")}`
        )
      : ["   - (none)"])
  );
  sections.push(
    "3. Not this round — leave these alone and say so in your summary; each is escalated to the owner, not retried:",
    ...(list.notThisRound.length > 0
      ? list.notThisRound.map((item) => `   - ${line(item.blocker)}\n     Why not: ${item.reason}`)
      : ["   - (none)"])
  );
  return sections.join("\n");
}

/**
 * review1 Step 26: what a Fast Forward that stopped on an unchanged review says. It names what moved, what did not,
 * and which blockers cannot move in another round (the "not this round" group), and it does not guess that a
 * provider failed: a provider failure has its own message with the real error.
 */
export function describeUnchangedReviewStallV1(input: {
  readonly moved?: string;
  readonly list?: BlockerWorkListV1;
}): string {
  const parts: string[] = [];
  parts.push(
    input.moved !== undefined
      ? `the last review came back unchanged, although the work moved (${input.moved})`
      : "the last review came back unchanged and nothing else moved either (no plan item settled, no blocker closed, no higher score)"
  );
  const list = input.list;
  if (list) {
    const stuck = list.notThisRound.length;
    const workable = list.fixFirst.length + list.buildToClear.length;
    if (workable > 0) {
      parts.push(`${workable} blocker${workable === 1 ? " is" : "s are"} still work a round can do`);
    }
    if (stuck > 0) {
      parts.push(
        `${stuck} blocker${stuck === 1 ? " cannot" : "s cannot"} move in another round (${[...new Set(list.notThisRound.map((item) => item.reason))].join("; ")})`
      );
    }
  }
  return parts.join("; ");
}
