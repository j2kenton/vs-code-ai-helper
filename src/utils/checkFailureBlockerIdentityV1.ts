/**
 * review2 Step 42: one failing check is one blocker. A check's failure reaches the blocker list twice, as the
 * reviewer's own finding and as Ensemble's mechanical record from Verified Checks, and each later review can copy
 * either forward again. This merges them by the check's command, and drops a blocker the reviewer marks as a
 * duplicate of another, so the counts say how many different things are wrong.
 *
 * Pure: no `vscode`, no I/O.
 */

import type { ReviewBlocker } from "./reviewReadiness";

/** A backticked command that runs a check: `pnpm run lint`, `npm test`, `npx vitest run …`, `tsc --noEmit`. */
const CHECK_COMMAND_RE =
  /`((?:\[[^\]]+\]\s*)?(?:pnpm|npm|yarn|npx|tsc|eslint|vitest|jest|node|make|cargo|go|pytest)\b[^`]*)`/i;

/** Words that say the check failed, so a command named only in passing (a fix that runs it) is not merged. */
const CHECK_FAILURE_WORD_RE = /\b(?:fail(?:s|ed|ing|ure)?|exit(?:ed)?\s+\d+|errors?)\b/i;

/** A reviewer saying this blocker restates another one. */
const MARKED_DUPLICATE_RE =
  /\b(?:duplicates?|duplicated|restates?|repeats?)\b[^.\n]{0,80}\b(?:above|same|earlier|previous|other|another|blocker|failure)\b|\bsame\s+(?:failure|blocker|lint|check)\s+as\s+(?:the\s+)?(?:above|first|one\s+above)\b/i;

/** The command a blocker's description names as failing, normalised; `undefined` when it names none. */
export function failingCheckCommandOfBlockerV1(description: string): string | undefined {
  const named = CHECK_COMMAND_RE.exec(description);
  if (named?.[1] === undefined || !CHECK_FAILURE_WORD_RE.test(description)) return undefined;
  return named[1].replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when the blocker's own text says it duplicates another blocker. */
export function isMarkedDuplicateBlockerV1(description: string): boolean {
  return MARKED_DUPLICATE_RE.test(description);
}

/**
 * The blockers with each failing check counted once.
 *  - A blocker marked as a duplicate is dropped, unless it is the only one for its check (then it stays: nothing else
 *    holds that failure).
 *  - Blockers naming the same failing command become one. The first keeps its place and its lineage id; when any of
 *    the group is Ensemble's mechanical record, the survivor carries `origin: "mechanical"`, since the check really
 *    failed and the clean-round veto depends on that origin.
 * Blockers that name no check command pass through unchanged.
 */
export function mergeCheckFailureBlockersV1(blockers: readonly ReviewBlocker[]): ReviewBlocker[] {
  const commandOf = blockers.map((blocker) => failingCheckCommandOfBlockerV1(blocker.description));
  const groups = new Map<string, number[]>();
  commandOf.forEach((command, index) => {
    if (command === undefined) return;
    groups.set(command, [...(groups.get(command) ?? []), index]);
  });
  const drop = new Set<number>();
  const mechanical = new Set<string>();
  for (const [command, indexes] of groups) {
    if (indexes.some((index) => blockers[index]!.origin === "mechanical")) mechanical.add(command);
    const keeper =
      indexes.find((index) => !isMarkedDuplicateBlockerV1(blockers[index]!.description)) ?? indexes[0]!;
    for (const index of indexes) if (index !== keeper) drop.add(index);
  }
  // A marked duplicate that names no check command is dropped only when another blocker precedes it.
  blockers.forEach((blocker, index) => {
    if (commandOf[index] === undefined && isMarkedDuplicateBlockerV1(blocker.description) && index > 0) drop.add(index);
  });
  return blockers.flatMap((blocker, index) => {
    if (drop.has(index)) return [];
    const command = commandOf[index];
    if (command !== undefined && mechanical.has(command) && blocker.origin !== "mechanical") {
      return [{ ...blocker, origin: "mechanical" as const }];
    }
    return [blocker];
  });
}
