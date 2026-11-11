/**
 * Carries a round's checkbox progress back into the implementation plan of
 * record (plan-final.md).
 *
 * `run-implementation.md` and `apply-impl-review-code.md` prefer a completed
 * round to reproduce the `<!-- ensemble:implementation-checklist -->`
 * checklist as its response's first section, with only the checkbox state
 * changed. That full echo is not the only way to record progress (RC2 #10):
 * a round may instead quote a finished item verbatim, with evidence, as its
 * own entry in the response's `## Plan Item Checklist` section — the merge
 * below matches items by exact text wherever it finds them, echo or per-item
 * entry — and a round with neither ticks nothing rather than being rejected.
 *
 * That record used to survive because the run summary was written straight
 * over plan-final.md, so the reproduced checklist became the next round's
 * "Final Plan". That coupling is also what destroyed a 47-item checklist when
 * a provider returned a status message instead of a summary (task "1.8",
 * 2026-08-10) — one malformed response and the plan of record was gone.
 *
 * Splitting the summary into impl-summary.md fixed the destruction but would
 * have severed the carry-forward: `runImplementationWithAI` still reads
 * plan-final.md as the Final Plan, so it would see the original all-unchecked
 * checklist every round and either redo finished work or stall. Merging the
 * checkbox state instead keeps both properties — the plan of record is never
 * replaced, and progress through it still accumulates.
 */

import { createHash } from "crypto";
import {
  findLastHeadingV1,
  headingsV1,
  walkLinesV1,
} from "./markdownStructure";
import { DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1 } from "../types/structuredQuestionV1";

/**
 * One checklist line, split so a merge can rewrite only the checkbox glyph and
 * leave every other byte (indent, bullet, spacing, trailing `\r`) untouched.
 * Mirrors the item pattern `verifyPlanItems` uses, so the two always agree on
 * what counts as a checklist item.
 */
const ITEM_LINE = /^([ \t]*[-*][ \t]*\[)([ xX])(\][ \t]+)(.*\S)([ \t]*\r?)$/m;
/**
 * Captures leading indentation (group 1) alongside checked-glyph (group 2)
 * and text (group 3) — the indentation is what {@link itemsInLatestRendering}
 * uses to tell a top-level plan item from a nested discovered-sub-work child
 * (1.0.0 gate A3, Step 13: "nested items do not count" toward the plan's
 * fixed denominator, and must not be flagged as a checklist-item-set mutation
 * when a round adds them under an existing, unchanged parent).
 */
const ANY_ITEM_LINE = /^([ \t]*)[-*][ \t]*\[([ xX])\][ \t]+(.*\S)[ \t]*\r?$/;

/** The marker a generated implementation checklist opens with. */
export const IMPLEMENTATION_CHECKLIST_MARKER =
  "<!-- ensemble:implementation-checklist -->";

/**
 * The marker on a line of its own — the only form that starts a rendering.
 *
 * A plan may also *quote* the marker in prose or inside a checklist item (this
 * repo's own plans do, when the work is about this mechanism). Treating such a
 * mention as the start of a new rendering silently dropped every item before
 * it — and, when the mention was in the last item, left nothing to count at
 * all, which reads as "no checklist" and disables the completeness gate.
 */
const STANDALONE_MARKER_LINE = new RegExp(
  `^[ \\t]*${IMPLEMENTATION_CHECKLIST_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`
);

/**
 * A round that legitimately fixed a review blocker without ticking any plan
 * checkbox (the work was a defect fix, not an unbuilt step) may state so
 * explicitly with this marker instead of reproducing the checklist echo.
 * `describeImplementationSummaryShapeIssue` no longer requires an echo at all
 * (RC2 #10), so this marker is not what makes a missing echo acceptable —
 * it is one of several signals (alongside a `## Plan Item Checklist` claim)
 * `describeIncompleteImplementationRoundV1` uses to tell a round that
 * deliberately reported no checkbox change from one whose response was cut
 * short with nothing recorded at all.
 */
export const NO_CHECKLIST_CHANGE_MARKER_V1 = "<!-- ensemble:no-checklist-change -->";

/**
 * The marker on a line of its own — the only form that counts as an actual
 * declaration, mirroring `STANDALONE_MARKER_LINE`'s identical fix for
 * `IMPLEMENTATION_CHECKLIST_MARKER`.
 *
 * A response's echoed checklist can legitimately QUOTE this marker inside an
 * item's own descriptive text — this repo's own plan does, in the very item
 * describing this mechanism ("Treat a summary that both declares
 * `<!-- ensemble:no-checklist-change -->` and supplies retroactive/done
 * claims as self-contradictory"). A bare substring match over the whole
 * response read that quoted mention as the round's own declaration and
 * rejected an otherwise-valid response that echoed the checklist correctly
 * and reported genuine retroactive completions elsewhere (review finding,
 * 2026-08-14). Requiring the marker on its own line is the same fix
 * `STANDALONE_MARKER_LINE` already applies for the checklist-rendering marker.
 */
const NO_CHECKLIST_CHANGE_STANDALONE_LINE = new RegExp(
  `^[ \\t]*${NO_CHECKLIST_CHANGE_MARKER_V1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`
);

/** True when `response` declares, via the marker above, that no checkbox state changed this round. */
export function declaresNoChecklistChangeV1(response: string): boolean {
  return walkLinesV1(response).some(
    (line) => !line.fenced && NO_CHECKLIST_CHANGE_STANDALONE_LINE.test(line.text)
  );
}

/** Done claims a report made under its own no-checklist-change marker that left their items open (review2 Step 11). */
export interface DroppedDoneClaimsV1 {
  /** Each claimed item that is still open after the round's merge, as the plan words it. */
  readonly itemTexts: readonly string[];
}

/**
 * review2 Step 11 (bugs6 item 25): a report that declares `<!-- ensemble:no-checklist-change -->` and also claims
 * items done contradicts itself. Which of its claims did the round's merge leave unused: the claimed items that are
 * still open in `planAfterMerge`? `[]` when the report does not declare the marker. A claim that did tick its item is
 * not listed: it was used, and the report's note that it applied the claims already covers it.
 */
export function listDroppedDoneClaimsUnderNoChangeMarkerV1(
  summary: string,
  planBeforeMerge: string,
  planAfterMerge: string
): DroppedDoneClaimsV1 {
  const own = splitSummaryAtEchoV1(summary, planBeforeMerge).own;
  if (!declaresNoChecklistChangeV1(own)) return { itemTexts: [] };
  const claims = collectRetroactiveTickClaimsV1(own, collectChecklistItemKeysV1(planBeforeMerge));
  const open = new Map<string, string>();
  for (const item of itemsInLatestRendering(planAfterMerge)) {
    if (!item.checked && !item.excluded) open.set(normalizeChecklistItemTextV1(item.text), unescapeChecklistItemTextV1(item.text));
  }
  const dropped: string[] = [];
  for (const claim of claims) {
    const planText = open.get(normalizeChecklistItemTextV1(claim.itemText));
    if (planText !== undefined && !dropped.includes(planText)) dropped.push(planText);
  }
  return { itemTexts: dropped };
}

/** The sentence that names the contradiction, for the run log, the notification and the card. */
export function describeNoChangeMarkerContradictionV1(dropped: DroppedDoneClaimsV1): string {
  const n = dropped.itemTexts.length;
  return (
    `The round's report contradicted itself: it declared no checklist change, but it also claimed ${n} item${n === 1 ? "" : "s"} ` +
    `done. ${n === 1 ? "That claim was" : "Those claims were"} not used, so ${n === 1 ? "the item is" : "the items are"} still open.`
  );
}

/**
 * One blocker an implementer round declined to act on, recorded under its own
 * `## Remaining Blockers` section — RC2 item 7's contract (rule 7 of
 * `apply-impl-review-code.md` / `run-implementation.md`): a removal named
 * only in the plan or a review, with no approval in the owner's own `## Task
 * Description`, is declined rather than made, and the round records it here
 * so the NEXT review can recognize the decline and stop counting it as
 * task-fixable (see `reclassifyDeclinedBlockersV1`, reviewReadiness.ts).
 */
export interface DeclinedBlockerV1 {
  /** The blocker text as the declining round quoted it — matched, not
   * exactly, against a reviewer's own description text (reviews reword). */
  readonly blockerText: string;
  readonly reason: string;
}

/**
 * Matches a line of the exact shape rule 7 asks a declining round to write:
 * `<blocker> — declined: needs a human decision — <why>`.
 */
const DECLINED_BLOCKER_LINE_RE =
  /^[ \t]*[-*][ \t]+(.+?)[ \t]+—[ \t]+declined:[ \t]+needs a human decision[ \t]+—[ \t]+(.+?)[ \t]*\r?$/i;

/**
 * Parses every declined-blocker line out of `summary`'s own `## Remaining
 * Blockers` section (the LAST such heading, mirroring `findLastHeadingV1`'s
 * rationale for `## Plan Item Checklist` — an echoed prior response can carry
 * its own copy of the same heading). Fenced code and any other heading's
 * content is never scanned. Returns an empty list when the section is absent
 * or carries no matching line — a round with no declined blocker writes
 * nothing here, which is the common case, not an error.
 */
export function parseDeclinedBlockersV1(summary: string): DeclinedBlockerV1[] {
  const all = headingsV1(summary);
  const index = findLastHeadingV1(all, "Remaining Blockers");
  if (index === -1) {
    return [];
  }
  const lines = walkLinesV1(summary);
  const heading = all[index];
  const start = (heading?.line ?? -1) + 1;
  let end = lines.length;
  for (let h = index + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= (heading?.level ?? 1)) {
      end = candidate.line;
      break;
    }
  }
  const results: DeclinedBlockerV1[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const match = DECLINED_BLOCKER_LINE_RE.exec(line.text);
    if (!match) {
      continue;
    }
    const blockerText = (match[1] ?? "").trim();
    const reason = (match[2] ?? "").trim();
    if (blockerText.length === 0) {
      continue;
    }
    results.push({ blockerText, reason });
  }
  return results;
}

/**
 * bugs6 items 41 and 46: the lines of `summary`'s own `## Remaining Blockers` section (the LAST such heading, fenced
 * code skipped), each trimmed, blank lines dropped. Empty when the section is absent.
 */
export function remainingBlockersLinesV1(summary: string): string[] {
  const all = headingsV1(summary);
  const index = findLastHeadingV1(all, "Remaining Blockers");
  if (index === -1) {
    return [];
  }
  const lines = walkLinesV1(summary);
  const heading = all[index];
  const start = (heading?.line ?? -1) + 1;
  let end = lines.length;
  for (let h = index + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= (heading?.level ?? 1)) {
      end = candidate.line;
      break;
    }
  }
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const text = line.text.trim();
    if (text.length > 0) {
      out.push(text);
    }
  }
  return out;
}

/**
 * True when `content` both declares `NO_CHECKLIST_CHANGE_MARKER_V1` ("nothing
 * to tick") and ALSO reports at least one {@link RETROACTIVE_TICK_MARKER_V1}
 * claim, in its own `## Plan Item Checklist` section, that does NOT name a
 * plan item already ticked in the plan of record — a round that wants
 * checklist state to change while explicitly declaring it does not. A claim
 * that genuinely names an already-ticked item is a status note, not a
 * contradiction — see the `alreadyCheckedPlanItemKeys` paragraph below.
 *
 * Confirmed live (round 013, task "1.9", 2026-08-14): the round declared the
 * marker, then listed dozens of retroactive completions for Parts 1-3 with
 * PARAPHRASED item text ("`.model-combo-input` small font + reduced padding"
 * against the plan's actual "In the webview `<style>`, set `.model-combo-input`
 * to `font-size: ...` and reduce its vertical padding..."). The retroactive-
 * claim mechanism itself worked exactly as designed — exact-text matching
 * correctly refused to guess that a paraphrase meant the same item — so the
 * merge legitimately returned "no-match", but the marker already satisfied
 * `checklistEchoPresent`, so the round was silently accepted as complete with
 * only a warning notification. No merge/scoping bug was found; the missing
 * guard was taken to be this contradiction itself, and the shape gate
 * rejected such a round before the merge ran. RC2 #10 (2026-09-27) removed
 * that rejection, since it looped tasks on their report format: the claims
 * now go through the merge like any others. This function has no production
 * caller at present.
 *
 * The declaration check requires the marker on its OWN line
 * (`declaresNoChecklistChangeV1`), and the claims check is scoped to `own`
 * (`splitSummaryAtEchoV1`'s post-echo region) — the same scope
 * `collectRetroactiveTickClaimsV1` already reads. Together they mean a plan
 * that merely quotes either marker inside a checklist item's descriptive text
 * can never trigger this on its own.
 *
 * `planItemKeys` (optional) is forwarded to `collectRetroactiveTickClaimsV1`
 * so an item whose own text contains ` — ` is still recognized as a claim;
 * omitting it falls back to the naive split, which still finds a claim to
 * check against `alreadyCheckedPlanItemKeys` below, just with a coarser split
 * on any embedded dash.
 *
 * `alreadyCheckedPlanItemKeys` (optional, normalized via
 * `normalizeChecklistItemTextV1`) is what turns "any claim at all" into "a
 * claim that does not already hold" (wf10 item 12): a round may legitimately
 * report the status of items it touched without ticking anything NEW, using
 * this exact marker plus per-item "already ticked in a prior round" notes —
 * three independent providers converged on that shape unprompted (run 064
 * and two sibling occurrences). Omitting this parameter (the default empty
 * set) reproduces the original all-claims-are-contradictory behavior, so
 * every existing caller that has not been updated to pass it keeps its prior
 * semantics unchanged.
 *
 * A claim is genuinely contradictory — this marker cannot be used — in
 * exactly three cases, all still caught: (1) the claimed item text matches NO
 * real plan item at all (the round-013 reproduction: a paraphrase that the
 * merge could never have matched either); (2) the claimed item text matches a
 * real plan item that is NOT yet ticked (a claim trying to advance state
 * while declaring none changed); and (3) the claimed item text matches an
 * already-ticked plan item, but the entry itself never says so — no
 * {@link RETROACTIVE_TICK_MARKER_V1} and no "already ticked"/"already
 * checked"/"already complete" phrasing in its own `status`/`evidence` fields
 * (review-flagged, 2026-08-25: matching an already-checked plan item is a
 * fact about the PLAN, not about what the entry claims — a bare
 * `"— done — <anything>"` naming an item that merely happens to already be
 * ticked read as a legitimate status note regardless of what the entry
 * actually said, which would also have accepted an entry that (wrongly)
 * claimed FRESH completion of an already-ticked item. A second, narrower form
 * of the same bug — also fixed 2026-08-25 — scanned the entry's WHOLE raw
 * bullet, including the immutable `itemText`, so an item whose own wording
 * happens to contain the marker or "already ticked"-style phrasing could
 * satisfy the self-declaration requirement with no self-declaration at all;
 * the check is now scoped to `status`/`evidence` only). Case (3) also
 * requires non-empty evidence, matching the marker's own documented
 * requirement. Part-level claims
 * (`collectPartLevelTickClaimsV1`) are always treated as contradictory here —
 * this marker's accepted exception is per-item status notes only, never a
 * whole-Part claim.
 */
export function hasContradictoryNoChecklistChangeClaimV1(
  content: string,
  planItemKeys: ReadonlySet<string> = new Set(),
  alreadyCheckedPlanItemKeys: ReadonlySet<string> = new Set()
): boolean {
  const trimmed = content.trim();
  if (!declaresNoChecklistChangeV1(trimmed)) {
    return false;
  }
  const { own } = splitSummaryAtEchoV1(trimmed);
  const itemClaims = collectRetroactiveTickClaimsInternalV1(own, planItemKeys);
  const hasGenuinelyContradictoryItemClaim = itemClaims.some((claim) => {
    if (!alreadyCheckedPlanItemKeys.has(normalizeChecklistItemTextV1(claim.itemText))) {
      return true;
    }
    return !claim.alreadyAnnotated || claim.evidence.length === 0;
  });
  return hasGenuinelyContradictoryItemClaim || collectPartLevelTickClaimsV1(own).length > 0;
}

/**
 * Marks one checklist line as an operator-action/optional/descoped step the
 * implementation stage cannot itself perform (e.g. "Deploy the classifier
 * change to production", "Optional: add telemetry once the dashboard
 * exists"). Written as a trailing HTML comment, on the same line, after the
 * item's text:
 *
 *   - [ ] Deploy the classifier change to the production cluster <!-- ensemble:excluded -->
 *
 * An HTML comment (not a bracketed `[operator-action]` tag before the text)
 * was chosen to match `NO_CHECKLIST_CHANGE_MARKER_V1`'s existing convention
 * in this same file, and because it sits at the END of the line: `ITEM_LINE`
 * and `ANY_ITEM_LINE` already capture "everything after the checkbox" as the
 * item's text via `(.*\S)`, so a trailing marker needs no change to either
 * regex — only to how the captured text is interpreted afterward.
 *
 * A marked item is still a real checklist item, and still part of the FIXED
 * denominator: `itemsInLatestRendering` still returns it (so it is still
 * matched/ticked by `mergeChecklistProgressV1` and still counted by
 * `hasImplementationChecklistV1`/`collectChecklistItemKeysV1`), and
 * `countChecklistProgressV1` still counts it toward `total`. It is excluded
 * from `checked` and instead settles as `closedWithoutDoing` — closed
 * without the work having been done, rather than open — which is what
 * `reconcileProgressWithChecklistV1` (reviewReadiness.ts) reads via
 * `remaining` as the denominator the completeness gate cannot be satisfied
 * without.
 *
 * Additive only: a plan-final.md with no markers at all has zero lines
 * matching this, so existing in-flight plans are completely unaffected.
 */
export const EXCLUDED_CHECKLIST_ITEM_MARKER_V1 = "<!-- ensemble:excluded -->";

/** The same marker wrapped in a single pair of backticks — a formatting slip that must still settle the item. */
const BACKTICK_WRAPPED_EXCLUDED_MARKER_V1 = "`<!-- ensemble:excluded -->`";

/**
 * Length of the trailing exclusion marker on `text`, recognizing both the
 * bare marker and the marker wrapped in a single pair of backticks. Returns
 * `undefined` when neither form trails the line.
 */
function trailingExcludedMarkerLengthV1(text: string): number | undefined {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(BACKTICK_WRAPPED_EXCLUDED_MARKER_V1)) {
    return BACKTICK_WRAPPED_EXCLUDED_MARKER_V1.length;
  }
  if (trimmed.endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1)) {
    return EXCLUDED_CHECKLIST_ITEM_MARKER_V1.length;
  }
  return undefined;
}

/**
 * True when `itemText` (the checklist line's captured text) genuinely carries
 * the exclusion marker, as opposed to merely mentioning it. The marker counts
 * only as a TRAILING comment: it ends the line, follows real item text, is
 * and is separated from that text by whitespace (a marker inside an inline
 * code span never ends the line, so it is already not trailing). So an item
 * that is ABOUT the marker ("Add the marker `<!-- ensemble:excluded -->`",
 * "… the literal<!-- ensemble:excluded -->") stays an ordinary open item
 * rather than silently settling as excluded and shrinking the count (RC1
 * item 7). The marker wrapped in a single pair of backticks at the end of the
 * line is also accepted, so a formatting slip cannot reopen an excluded item.
 */
export function isExcludedChecklistItemText(itemText: string): boolean {
  const markerLen = trailingExcludedMarkerLengthV1(itemText);
  if (markerLen === undefined) {
    return false;
  }
  const before = itemText.trimEnd().slice(0, itemText.trimEnd().length - markerLen);
  return before.trim().length > 0 && /\s$/.test(before);
}

/**
 * Resolve a review blocker to an excluded five-field owner hand-off from the
 * plan's Owner checks / Publish hand-off area. Uses the same normalized item
 * identity as checklist tick reconciliation; an incidental wording overlap
 * cannot authorize moving on.
 */
export function resolveExcludedOwnerHandoffV1(
  blockerDescription: string,
  planOfRecord: string
): { itemText: string; isPrerequisite: boolean } | undefined {
  const blockerKey = normalizeChecklistItemTextV1(blockerDescription);
  const lines = planOfRecord.split(/\r?\n/);
  let inHandoff = false;
  for (const line of lines) {
    const heading = /^#{1,4}\s+(.+)$/.exec(line)?.[1]?.toLowerCase();
    if (heading) {
      inHandoff = /owner checks|publish checks hand-off|publish hand-off|manual hand-offs/.test(heading);
      continue;
    }
    if (!inHandoff) continue;
    const item = /^\s*[-*+]\s+\[[ xX]\]\s+(.+\S)\s*$/.exec(line)?.[1];
    if (!item || !isExcludedChecklistItemText(item)) continue;
    const title = /\*\*([^*]+)\*\*/.exec(item)?.[1];
    const titleKey = title ? normalizeChecklistItemTextV1(title.replace(/[.:]$/, "")) : "";
    const itemKey = normalizeChecklistItemTextV1(item);
    if (!titleKey || (!blockerKey.includes(titleKey) && !itemKey.includes(blockerKey))) continue;
    if (!/\bwhat\b/i.test(item) || !/\bwhy\b/i.test(item) || !/\bhow\b/i.test(item) ||
        !/\bif it fails\b/i.test(item) || !/\bpriority\b/i.test(item)) continue;
    return {
      itemText: item,
      isPrerequisite: /\b(?:required before|prerequisite)\b/i.test(item),
    };
  }
  return undefined;
}

/**
 * Placed immediately BEFORE the trailing {@link EXCLUDED_CHECKLIST_ITEM_MARKER_V1}
 * on an item that was already closed without doing when Implementation first
 * started (RC8 item 6), e.g.
 *
 *   - [ ] Light theme looks the same as before <!-- ensemble:closed-before-implementation --> <!-- ensemble:excluded -->
 *
 * The excluded marker stays LAST, so a version that does not know this one
 * still reads the item as excluded. Display only: the Implementation row's
 * percentage leaves such items out of both sides. Counts, completeness gates,
 * tick matching and the item-set comparison ignore it (identity keys strip it).
 */
export const CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1 = "<!-- ensemble:closed-before-implementation -->";

/** Matches the closed-before-implementation marker plus the whitespace before it. */
const CLOSED_BEFORE_IMPLEMENTATION_STRIP_RE = /[ \t]*<!-- ensemble:closed-before-implementation -->/g;

/** Matches a trailing exclusion marker, bare or wrapped in a single pair of backticks, plus surrounding whitespace. */
const EXCLUDED_MARKER_STRIP_RE = /[ \t]*`?<!-- ensemble:excluded -->`?[ \t]*$/;

/**
 * True when `itemText` is an excluded item whose trailing excluded marker is
 * immediately preceded by {@link CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1}.
 */
export function isClosedBeforeImplementationChecklistItemTextV1(itemText: string): boolean {
  if (!isExcludedChecklistItemText(itemText)) {
    return false;
  }
  const trimmed = itemText.trimEnd();
  const markerLen = trailingExcludedMarkerLengthV1(itemText) ?? 0;
  const before = trimmed.slice(0, trimmed.length - markerLen).trimEnd();
  if (!before.endsWith(CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1)) {
    return false;
  }
  const base = before.slice(0, before.length - CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1.length);
  return base.trim().length > 0 && /\s$/.test(base);
}

/**
 * Reverses the over-escaping a checklist line can pick up from a round-trip
 * through a JSON-encoded field (the checklist echo travels inside the
 * `<<<ENSEMBLE_AI_RESULT_V1>>>` frame's `"markdown"` string, and the plan of
 * record was itself generated the same way): backslash-escaped quotes
 * (`\"` -> `"`), apostrophes (`\'` -> `'`), backticks (`` \` `` -> `` ` ``)
 * and doubled backslashes (`\\` -> `\`). Backtick was the one escapable
 * character missing from this set (workflow 8, item 2's jester probe): a
 * plan item that quotes an identifier or format string in markdown — the
 * single most common reason a checklist line contains a backtick at all —
 * survived a JSON round-trip as `` \` `` on the plan side while the round's
 * own echo reproduced it clean, so the two normalized to different keys and
 * the tick was silently dropped even though six of eight items in the same
 * fixture ticked normally. Shared by `normalizeChecklistItemTextV1` (for the
 * merge key) and `verifyPlanItems` (for the text it displays/hands to AI
 * verification), so a corrupted plan item is unescaped identically wherever
 * it is read — neither copy duplicates this logic.
 */
export function unescapeChecklistItemTextV1(text: string): string {
  return text
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\`/g, "`")
    .replace(/\\\\/g, "\\");
}

/**
 * Item-identity text. Must match `verifyPlanItems`' key exactly, or an item
 * could merge here and count differently in Plan Item Verification.
 *
 * Unescapes via `unescapeChecklistItemTextV1` BEFORE the trim/lowercase/
 * whitespace collapse below. Without unescaping here, a plan item written
 * `Fix the \"foo\" bug` and an echo of the same item written clean as
 * `Fix the "foo" bug` normalize to two different keys and never match, so the
 * tick is silently dropped. Order matters: unescape first, so the corrupted
 * and clean spellings of the same item collapse to one key before
 * whitespace/case folding.
 */
export function normalizeChecklistItemTextV1(text: string): string {
  const unescaped = unescapeChecklistItemTextV1(text)
    .replace(CLOSED_BEFORE_IMPLEMENTATION_STRIP_RE, "")
    .replace(EXCLUDED_MARKER_STRIP_RE, "");
  return unescaped.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable identity for plan acceptance: checkbox state is progress, not a
 * revision. Item wording and exclusion markers remain part of the hash. */
export function getPlanRevisionV1(planText: string): string {
  const revisionContent = planText.replace(/^(\s*[-*+]\s+\[)[ xX](\])/gm, "$1 $2");
  return createHash("sha256").update(revisionContent).digest("hex");
}

/**
 * review1 Step 2: the item's text without Ensemble's own annotations — the exclusion and
 * closed-before-implementation markers, the `— Checked: …` / `— Excluded by you: …` notes the settle
 * flow appends, and an `Owner decision YYYY-MM-DD: …` or reviewer-narrowing note — so adding any of
 * them never changes what the item says.
 */
export function stripPlanItemAnnotationsV1(text: string): string {
  return unescapeChecklistItemTextV1(text)
    .replace(CLOSED_BEFORE_IMPLEMENTATION_STRIP_RE, "")
    .replace(EXCLUDED_MARKER_STRIP_RE, "")
    .replace(/\s+— (?:Checked|Excluded by you): [\s\S]*$/, "")
    .replace(/\s+— Owner decision \d{4}-\d{2}-\d{2}: [\s\S]*$/, "")
    .replace(/\s+— narrowed \(reviewer-verified\): [\s\S]*$/, "");
}

/**
 * review2 Step 4: the one way an item's text becomes the text a stored row (evidence, owner decision, test run)
 * records and keys on: Ensemble's own annotations are removed (a card's `— Checked: …` display note, a settle
 * note, an exclusion marker), so display text never reaches progress or plan writes.
 */
export function cleanPlanItemTextV1(text: string): string {
  return stripPlanItemAnnotationsV1(text).trim();
}

/**
 * review2 Step 3: the hash entry of the item `itemId` names in `planText`'s latest rendering, or `undefined` when
 * the plan holds no item with that issued id. The id list and the hash list walk the same rendering, so an index
 * names the same item in both.
 */
export function findPlanItemHashEntryByIdV1(planText: string, itemId: string): PlanItemHashEntryV1 | undefined {
  const ids = listPlanItemIdsV1(planText);
  const hashes = listPlanItemContentHashesV1(planText);
  if (ids.length !== hashes.length) return undefined;
  const index = ids.findIndex((entry) => entry.itemId === itemId);
  return index === -1 ? undefined : hashes[index];
}

/**
 * review1 Step 2: a hash of one checklist item's own content — its normalised text plus the normalised
 * text of each nested child — that ignores the checkbox state and Ensemble's annotations. Evidence about
 * the item stays valid while this hash is unchanged, whatever else in the plan changes.
 */
export function computePlanItemContentHashV1(itemText: string, childTexts: readonly string[] = []): string {
  const parts = [itemText, ...childTexts].map((text) => normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(text)));
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** One item of the latest rendering with its identity keys and content hash. */
export interface PlanItemHashEntryV1 {
  readonly text: string;
  /** `normalizeChecklistItemTextV1` of the item's text as written (the evidence `itemKey`). */
  readonly key: string;
  /** The same key after Ensemble's annotations are removed. */
  readonly annotationFreeKey: string;
  /** A top-level item's hash covers its nested children; a nested item's covers only itself. */
  readonly hash: string;
  readonly checked: boolean;
  readonly excluded: boolean;
  readonly nested: boolean;
  /** 1-based count of this annotation-free key among the items of the same level, in plan order. */
  readonly occurrence: number;
  /** Index (in the returned list) of a nested item's parent. */
  readonly parentIndex?: number;
  /**
   * True when a top-level item and a nested item of the latest rendering share this annotation-free wording.
   * Such twins hash alike, so a stored row that did not record its level is read as the top-level item's.
   */
  readonly sharesKeyAcrossLevels?: boolean;
}

/**
 * review1 (review fix): may a stored row apply to this item given the nesting level? A row that recorded its
 * level (`itemNested`) applies only to an item of that level. A row from before the field existed applies to
 * either level, except that it never settles a nested child when a top-level item has the same wording.
 */
function rowLevelAppliesV1(
  rowNested: boolean | undefined,
  current: { readonly nested?: boolean; readonly sharesKeyAcrossLevels?: boolean }
): boolean {
  if (current.nested === undefined) return true;
  if (rowNested !== undefined) return rowNested === current.nested;
  return !(current.nested && current.sharesKeyAcrossLevels === true);
}

/** Every item (top-level and nested) of `planText`'s latest rendering with its content hash, in plan order. */
export function listPlanItemContentHashesV1(planText: string): PlanItemHashEntryV1[] {
  const items = itemsInLatestRendering(planText);
  const entries: PlanItemHashEntryV1[] = [];
  const seen = new Map<string, number>();
  let parentIndex: number | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const key = normalizeChecklistItemTextV1(item.text);
    const annotationFreeKey = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(item.text));
    const level = item.nested ? "n" : "t";
    const occurrence = (seen.get(`${level}${annotationFreeKey}`) ?? 0) + 1;
    seen.set(`${level}${annotationFreeKey}`, occurrence);
    if (item.nested) {
      entries.push({
        text: item.text,
        key,
        annotationFreeKey,
        hash: computePlanItemContentHashV1(item.text),
        checked: item.checked,
        excluded: item.excluded,
        nested: true,
        occurrence,
        ...(parentIndex !== undefined ? { parentIndex } : {}),
      });
      continue;
    }
    const children: string[] = [];
    for (let j = i + 1; j < items.length && items[j]!.nested; j++) children.push(items[j]!.text);
    parentIndex = entries.length;
    entries.push({
      text: item.text,
      key,
      annotationFreeKey,
      hash: computePlanItemContentHashV1(item.text, children),
      checked: item.checked,
      excluded: item.excluded,
      nested: false,
      occurrence,
    });
  }
  const topKeys = new Set(entries.filter((entry) => !entry.nested).map((entry) => entry.annotationFreeKey));
  const nestedKeys = new Set(entries.filter((entry) => entry.nested).map((entry) => entry.annotationFreeKey));
  return entries.map((entry) =>
    topKeys.has(entry.annotationFreeKey) && nestedKeys.has(entry.annotationFreeKey)
      ? { ...entry, sharesKeyAcrossLevels: true }
      : entry
  );
}

/** A reviewer entry that names more than one checked plan item, so it verifies none of them. */
export interface AmbiguousVerificationEntryV1 {
  /** The reviewer's text, as written. */
  readonly text: string;
  /** How many checked plan items carry that wording (across levels and copies). */
  readonly matches: number;
}

/** A reviewer entry that cites an `[item:<id>]` Ensemble never issued for this plan, so it verifies nothing. */
export interface UnknownVerificationIdV1 {
  readonly id: string;
  /** The label that followed the id, or `item:<id>` when there was none. */
  readonly text: string;
}

/** One reviewer entry: its text, and the `[item:<id>]` it cited when it did. */
export interface VerificationCandidateV1 {
  readonly text: string;
  readonly itemId?: string;
  /** The reviewer's own evidence line for the entry, carried through to {@link CheckedVerificationTargetsV1.sources}. */
  readonly evidence?: string;
}

export interface CheckedVerificationTargetsV1 {
  /** The entry that selected each target, so a caller reads that entry's evidence line, not another's. */
  readonly sources: ReadonlyMap<PlanItemHashEntryV1, VerificationCandidateV1>;
  /** The checked, non-excluded items that exactly one reviewer entry names, in plan order. */
  readonly targets: PlanItemHashEntryV1[];
  /** Entries that matched several checked items; none of those items is a target. */
  readonly ambiguous: AmbiguousVerificationEntryV1[];
  /** Entries that cited an id Ensemble did not issue; recorded as nothing and reported. */
  readonly unknownIds: UnknownVerificationIdV1[];
}

/**
 * review1 (owner decision 2026-11-05): resolves what a reviewer's "Verified Complete" entries mean among the
 * checked, non-excluded items of `planText`. An entry names an item by its text, and a top-level item and a
 * nested child (or two copies at one level) can share that text, so the text alone cannot say which one it
 * means. An entry that matches exactly one checked item verifies that item; an entry that matches more than
 * one verifies none of them and is returned in `ambiguous` so the caller can say so. One entry is never fanned
 * out to several items.
 *
 * Owner decision 2026-11-05 (item identity by design): an entry may instead cite the `[item:<id>]` Ensemble listed
 * for the item, or a bare `Step N` that matches exactly one top-level item. An id verifies exactly the item it
 * was issued for, even when that item shares its wording with another; Ensemble records nothing for an id it
 * did not issue, and returns it in `unknownIds`. A `Step N` that names several items is ambiguous, like text.
 */
export function listCheckedVerificationTargetsV1(
  planText: string,
  candidates: readonly (string | VerificationCandidateV1)[]
): CheckedVerificationTargetsV1 {
  const all = listPlanItemContentHashesV1(planText);
  // The hash list and the id list walk the same latest rendering, so an index names the same item in both.
  const ids = listPlanItemIdsV1(planText);
  const aligned = all.length === ids.length;
  const entries = all.filter((entry) => entry.checked && !entry.excluded);
  const targets = new Set<PlanItemHashEntryV1>();
  const sources = new Map<PlanItemHashEntryV1, VerificationCandidateV1>();
  const ambiguous: AmbiguousVerificationEntryV1[] = [];
  const unknownIds: UnknownVerificationIdV1[] = [];
  const seen = new Set<string>();
  let current: VerificationCandidateV1 = { text: "" };
  const add = (entry: PlanItemHashEntryV1): void => {
    targets.add(entry);
    if (!sources.has(entry)) sources.set(entry, current);
  };
  const addIfChecked = (entry: PlanItemHashEntryV1 | undefined): void => {
    if (entry && entries.includes(entry)) add(entry);
  };
  for (const raw of candidates) {
    const candidate: VerificationCandidateV1 = typeof raw === "string" ? { text: raw } : raw;
    current = candidate;
    if (candidate.itemId) {
      const key = `id:${candidate.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const index = aligned ? ids.findIndex((entry) => entry.itemId === candidate.itemId) : -1;
      if (index < 0) unknownIds.push({ id: candidate.itemId, text: candidate.text });
      else addIfChecked(all[index]);
      continue;
    }
    const wanted = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(candidate.text));
    if (seen.has(wanted)) continue;
    seen.add(wanted);
    const reference = aligned ? resolvePlanItemReferenceV1(planText, candidate.text) : undefined;
    if (reference?.kind === "item") {
      addIfChecked(all[reference.itemIndex]);
      continue;
    }
    const bareStep = /^\W*(?:\*\*)?step\s+(\d+)\W*$/i.exec(candidate.text.trim());
    if (bareStep && reference) {
      // A bare `Step N` that does not resolve to one item: when several checked top-level items carry that step
      // label (a repeated numbering, or the same item twice) it is ambiguous and verifies none of them.
      const labelled = new RegExp(`^[\\s*_\`]*step\\s+${Number(bareStep[1])}(?!\\d)`, "i");
      const matches = entries.filter((entry) => !entry.nested && labelled.test(entry.text)).length;
      if (matches > 1) {
        ambiguous.push({ text: candidate.text.trim(), matches });
        continue;
      }
      if (reference.kind === "problem") continue;
    }
    const matching = entries.filter((entry) => entry.annotationFreeKey === wanted);
    if (matching.length === 1) add(matching[0]!);
    else if (matching.length > 1) ambiguous.push({ text: candidate.text.trim(), matches: matching.length });
  }
  return { targets: entries.filter((entry) => targets.has(entry)), ambiguous, unknownIds, sources };
}

/**
 * review1 (owner decision 2026-11-05, item identity by design): for the text-based paths that tick or count items
 * a review names (the card that applies reviewer-verified ticks, the open-items card), turns each Verified Complete
 * entry into the plan item's own text. An entry citing an issued `[item:<id>]`, or a bare `Step N` that names one
 * item, becomes that item's text; an entry citing an id Ensemble did not issue is returned in `unknownIds` and
 * dropped; one whose item's wording another item shares (so its text would name both) is returned in `ambiguous`
 * and dropped, because one entry is never fanned out. A plain text entry passes through unchanged.
 */
export function resolveVerifiedCompleteEntryTextsV1(
  planText: string | undefined,
  entries: readonly VerificationCandidateV1[]
): {
  readonly entries: readonly { readonly text: string; readonly evidence?: string }[];
  readonly unknownIds: readonly UnknownVerificationIdV1[];
  readonly ambiguous: readonly AmbiguousVerificationEntryV1[];
} {
  const resolved: { text: string; evidence?: string }[] = [];
  const unknownIds: UnknownVerificationIdV1[] = [];
  const ambiguous: AmbiguousVerificationEntryV1[] = [];
  const ids = planText ? listPlanItemIdsV1(planText) : [];
  const sharedWording = (text: string): number => {
    const wanted = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(text));
    return ids.filter(
      (entry) => !entry.excluded && normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(entry.itemText)) === wanted
    ).length;
  };
  for (const entry of entries) {
    const evidence = entry.evidence !== undefined ? { evidence: entry.evidence } : {};
    let named: { text: string } | undefined;
    if (entry.itemId) {
      const found = ids.find((candidate) => candidate.itemId === entry.itemId);
      if (!found) {
        unknownIds.push({ id: entry.itemId, text: entry.text });
        continue;
      }
      named = { text: found.itemText };
    } else if (planText) {
      const reference = resolvePlanItemReferenceV1(planText, entry.text);
      if (reference.kind === "item") named = { text: reference.itemText };
      else if (reference.kind === "problem") {
        const step = /^\W*(?:\*\*)?step\s+(\d+)\W*$/i.exec(entry.text.trim());
        const matches = step ? listPlanItemStepOwnersV1(planText).filter((owner) => owner.stepNumber === Number(step[1])).length : 0;
        if (matches > 1) ambiguous.push({ text: entry.text.trim(), matches });
        continue;
      }
    }
    if (named) {
      const matches = sharedWording(named.text);
      if (matches > 1) {
        ambiguous.push({ text: entry.text.trim(), matches });
        continue;
      }
      resolved.push({ text: named.text, ...evidence });
      continue;
    }
    resolved.push({ text: entry.text, ...evidence });
  }
  return { entries: resolved, unknownIds, ambiguous };
}

/** One unchecked item a reviewer's Verified Complete entry asks Ensemble to tick (review1, item identity by design). */
export interface UncheckedVerificationTargetV1 {
  /** The plan's own text for the item. */
  readonly text: string;
  /** The issued id of the exact item, when the entry cited it (or a `Step N` that names one item). */
  readonly itemId?: string;
  readonly evidence?: string;
}

/**
 * review1 (owner decision 2026-11-05, item identity by design): resolves a reviewer's Verified Complete entries
 * to the unchecked, non-excluded items to tick, keeping the identity of an entry that named its item by an
 * issued `[item:<id>]` (or a `Step N` that names one item). That entry targets exactly that item even when
 * another item shares its wording, so a completed child is ticked while a same-worded parent is left alone. An
 * id Ensemble did not issue, and an item that is already ticked or excluded, drop out. A plain text entry
 * resolves to the first unchecked item with that wording, as before, unless an id entry already named that
 * wording (so one item is never ticked twice). Entries are de-duplicated by id, or by wording for plain text.
 */
export function listUncheckedVerificationTargetsV1(
  planText: string,
  entries: readonly VerificationCandidateV1[]
): UncheckedVerificationTargetV1[] {
  const ids = listPlanItemIdsV1(planText);
  const targets: UncheckedVerificationTargetV1[] = [];
  const seenIds = new Set<string>();
  const idWordingKeys = new Set<string>();
  const plain: VerificationCandidateV1[] = [];
  const evidenceOf = (entry: VerificationCandidateV1): { evidence?: string } =>
    entry.evidence !== undefined ? { evidence: entry.evidence } : {};
  for (const entry of entries) {
    let found: PlanItemIdEntryV1 | undefined;
    if (entry.itemId) {
      found = ids.find((candidate) => candidate.itemId === entry.itemId);
      if (!found) continue;
    } else {
      const reference = resolvePlanItemReferenceV1(planText, entry.text);
      if (reference.kind === "problem") continue;
      if (reference.kind === "item") found = ids[reference.itemIndex];
      else {
        plain.push(entry);
        continue;
      }
    }
    if (!found || found.checked || found.excluded || seenIds.has(found.itemId)) continue;
    seenIds.add(found.itemId);
    idWordingKeys.add(normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(found.itemText)));
    targets.push({ text: found.itemText, itemId: found.itemId, ...evidenceOf(entry) });
  }
  const seenKeys = new Set<string>();
  const unchecked = filterUncheckedPlanItemsV1(planText, plain.map((entry) => entry.text));
  for (const text of unchecked) {
    const key = normalizeChecklistItemTextV1(text);
    if (seenKeys.has(key) || idWordingKeys.has(normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(text)))) continue;
    seenKeys.add(key);
    const source = plain.find((entry) => normalizeChecklistItemTextV1(entry.text) === key);
    targets.push({ text, ...(source ? evidenceOf(source) : {}) });
  }
  return targets;
}

/**
 * review1 (review fix): the items whose checkbox is ticked in `after` but not in `before` — the exact items a
 * tick merge changed, with their level and copy number. Returns undefined when the two renderings do not line
 * up item for item, so a caller falls back to naming items by text.
 */
export function listItemsTickedBetweenV1(before: string, after: string): PlanItemHashEntryV1[] | undefined {
  const was = listPlanItemContentHashesV1(before);
  const now = listPlanItemContentHashesV1(after);
  if (was.length !== now.length) return undefined;
  if (!was.every((entry, index) => entry.annotationFreeKey === now[index]!.annotationFreeKey && entry.nested === now[index]!.nested)) {
    return undefined;
  }
  return was.filter((entry, index) => !entry.checked && now[index]!.checked);
}

/**
 * review1 Step 2: the content hash of the first item in `planText` that `itemText` names (compared by
 * text with Ensemble's annotations removed; a top-level item wins over a nested one of the same wording).
 * Copies with the same wording and children hash alike, so the first copy is as good as any.
 */
export function findPlanItemContentHashV1(planText: string, itemText: string): string | undefined {
  return findPlanItemHashEntryV1(planText, itemText)?.hash;
}

/** The first item in `planText` that `itemText` names (a top-level item wins over a nested one). */
export function findPlanItemHashEntryV1(planText: string, itemText: string): PlanItemHashEntryV1 | undefined {
  const wanted = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(itemText));
  const named = listPlanItemContentHashesV1(planText).filter((entry) => entry.annotationFreeKey === wanted);
  return named.find((entry) => !entry.nested) ?? named[0];
}

/**
 * review1 Step 2: finds which stored rows apply to each plan item. Rows are matched by the item's
 * content hash or, for legacy rows without one, by `itemKey`; `planRevision` is never consulted.
 */
export function indexPlanItemRowsV1<
  R extends {
    readonly itemKey: string;
    readonly itemContentHash?: string;
    readonly itemOccurrence?: number;
    readonly itemNested?: boolean;
  },
>(
  rows: readonly R[]
): (
  entry: Pick<PlanItemHashEntryV1, "key" | "annotationFreeKey" | "hash"> & {
    readonly occurrence?: number;
    readonly nested?: boolean;
    readonly sharesKeyAcrossLevels?: boolean;
  }
) => R[] {
  const byKey = new Map<string, R[]>();
  const byHash = new Map<string, R[]>();
  for (const row of rows) {
    const bucket = row.itemContentHash === undefined ? byKey : byHash;
    const id = row.itemContentHash ?? row.itemKey;
    const list = bucket.get(id);
    if (list) list.push(row);
    else bucket.set(id, [row]);
  }
  return (entry) => {
    // A hashed row that recorded which copy of identical items it was written for only applies to that copy.
    const hashed = (byHash.get(entry.hash) ?? []).filter(
      (row) => row.itemOccurrence === undefined || entry.occurrence === undefined || row.itemOccurrence === entry.occurrence
    );
    const found = new Set<R>([...hashed, ...(byKey.get(entry.key) ?? [])]);
    for (const row of byKey.get(entry.annotationFreeKey) ?? []) found.add(row);
    // A top-level leaf and an identically worded child hash alike: a row only applies to the level it was recorded for.
    return [...found].filter((row) => rowLevelAppliesV1(row.itemNested, entry));
  };
}

/**
 * review1 Step 2: does a stored row (evidence entry, owner decision) still apply to the item it was
 * recorded for? A row with a stored `itemContentHash` applies while the item's current hash equals it.
 * A legacy row without a hash applies when its `itemKey` equals the item's current normalised text.
 * `planRevision` is a record only and never consulted.
 */
export function planItemRowAppliesV1(
  row: {
    readonly itemKey: string;
    readonly itemContentHash?: string;
    readonly itemOccurrence?: number;
    readonly itemNested?: boolean;
  },
  current: {
    readonly key: string;
    readonly annotationFreeKey: string;
    readonly hash: string;
    readonly occurrence?: number;
    readonly nested?: boolean;
    readonly sharesKeyAcrossLevels?: boolean;
  }
): boolean {
  if (!rowLevelAppliesV1(row.itemNested, current)) return false;
  if (row.itemContentHash !== undefined) {
    if (row.itemContentHash !== current.hash) return false;
    // A row that recorded which copy of identical items it was written for applies to that copy only.
    return row.itemOccurrence === undefined || current.occurrence === undefined || row.itemOccurrence === current.occurrence;
  }
  return row.itemKey === current.key || row.itemKey === current.annotationFreeKey;
}

/**
 * A leading step label a round may omit when echoing an item: `Step 4:`,
 * `Step 4 —`, `4.`, or `**Step 4**`. Applied only after exact matching fails
 * (see {@link mergeChecklistProgressV1}), so an item whose own text really
 * starts with one of these forms still matches itself first.
 */
const LEADING_STEP_LABEL_RE =
  /^(?:\*\*step[ \t]+\d+\*\*(?:[ \t]*[:—–-])?|step[ \t]+\d+[ \t]*(?::|—|–|-)|[0-9]+\.[ \t]+)[ \t]*/i;

/** Remove one leading step label from an already-normalized item key. */
function stripLeadingStepLabelV1(normalizedText: string): string {
  return normalizedText.replace(LEADING_STEP_LABEL_RE, "").trim();
}

/**
 * A round's `## Plan Item Checklist` section may report an item as `done`
 * with this marker to claim it was completed in an EARLIER round and only
 * verified (not built) this round — see `apply-impl-review-code.md` and
 * `run-implementation.md`. `FULLY COMPLETED this round` otherwise governs
 * which boxes a round may tick, so this is the one sanctioned exception, and
 * it is only honored when the same entry also carries non-empty evidence
 * (file:line, symbol, or test name) after the marker.
 */
export const RETROACTIVE_TICK_MARKER_V1 = "<!-- ensemble:retroactive -->";

/** One retroactive-tick claim parsed from a round's `## Plan Item Checklist` section. */
export interface RetroactiveTickClaimV1 {
  /** The plan item's identity text, matched the same way an echoed tick is. */
  readonly itemText: string;
  /** Verification evidence following the marker; empty when the round omitted it. */
  readonly evidence: string;
}

const CHECKLIST_ENTRY_LINE = /^[ \t]*[-*][ \t]+(.*\S)[ \t]*\r?$/;

/**
 * Splits one `## Plan Item Checklist` bullet into its em-dash-separated
 * fields: `<item> — <status> — <evidence...>`. `apply-impl-review-code.md`
 * and `run-implementation.md` both mandate exactly this shape for every
 * entry in that section.
 *
 * A naive "first ` — ` wins" split truncates a plan item whose OWN text
 * contains ` — ` (previously a documented open gap,
 * `docs/verification/known-gaps.md`): the item's own dash gets read as the
 * item/status boundary, and everything after it — including the real status
 * and evidence — is mangled. When `planItemKeys` is supplied (the plan of
 * record's own item keys), this instead tries the LONGEST prefix of the
 * line — split on ` — `, most segments first — that normalizes to a REAL
 * plan item, shrinking one segment at a time until one matches. That
 * absorbs an item's embedded dash into its own text instead of letting it
 * bleed into the status field. A line whose item text matches nothing in
 * `planItemKeys` (a genuinely unknown/foreign/paraphrased claim, or a caller
 * with no plan text to check against) falls back to the original naive
 * split — which is exactly what lets a genuinely unmatched claim still
 * surface as `no-match` rather than being silently absorbed into the wrong
 * field.
 */
function parsePlanItemChecklistLine(
  raw: string,
  planItemKeys: ReadonlySet<string> = new Set()
): { itemText: string; status: string; evidence: string } | undefined {
  const outer = CHECKLIST_ENTRY_LINE.exec(raw);
  if (!outer) {
    return undefined;
  }
  const segments = (outer[1] ?? "").split(/\s+—\s+/);
  if (segments.length < 2) {
    return undefined;
  }
  for (let k = segments.length - 1; k >= 1; k--) {
    const candidateItemText = segments.slice(0, k).join(" — ").trim();
    if (planItemKeys.has(normalizeChecklistItemTextV1(candidateItemText))) {
      return {
        itemText: candidateItemText,
        status: (segments[k] ?? "").trim(),
        evidence: segments.slice(k + 1).join(" — ").trim(),
      };
    }
  }
  return {
    itemText: (segments[0] ?? "").trim(),
    status: (segments[1] ?? "").trim(),
    evidence: segments.slice(2).join(" — ").trim(),
  };
}

/**
 * Matches a PART-level claim line ("Part 7 — done this round (6/6),
 * evidence: ...") so `collectRetroactiveTickClaimsV1` can skip it rather
 * than misreading it as a single item literally named "Part 7" — see
 * {@link collectPartLevelTickClaimsV1}.
 */
const PART_CLAIM_LINE = /^[ \t]*[-*][ \t]+Part[ \t]+(\d+[A-Za-z]?)[ \t]*—[ \t]*(.+?)[ \t]*\r?$/i;

/**
 * Retroactive-tick claims declared in `ownSummary` — the part of a response
 * AFTER the `## Files Changed` boundary (`splitSummaryAtEchoV1`'s `own`),
 * never the echoed plan checklist itself, so a plan quoting this marker in
 * its own text cannot be mistaken for a round claiming it.
 *
 * Two forms are accepted, both requiring a `status` beginning with "done":
 * the explicit {@link RETROACTIVE_TICK_MARKER_V1} (still the recommended,
 * unambiguous way to claim earlier-round work), or bare prose with no
 * marker at all — the form models actually emit in practice (observed live,
 * unprompted, on two separate tasks: a round summarizing "Part 7 — done
 * this round (6/6), evidence: ..." and rounds reporting "— done —
 * <evidence>" with no special markup). A status of "not reached"/"not done"
 * never starts with "done" and is silently skipped either way — it is the
 * round's honest report of remaining work, not an error worth flagging.
 *
 * A claim with empty `evidence` is still returned (not dropped): the caller
 * must treat it as an unfulfilled claim rather than silently ticking
 * unverified work, and surface it the same way an unmatched echoed tick is
 * surfaced — the hard evidence requirement is what keeps this from becoming
 * a licence to mark unbuilt work done.
 *
 * `planItemKeys` (optional) is forwarded to `parsePlanItemChecklistLine` so
 * a plan item whose own text contains ` — ` can still be claimed; omitting
 * it (or passing an empty set) falls back to the original naive split.
 */
export function collectRetroactiveTickClaimsV1(
  ownSummary: string,
  planItemKeys: ReadonlySet<string> = new Set()
): RetroactiveTickClaimV1[] {
  return collectRetroactiveTickClaimsInternalV1(ownSummary, planItemKeys).map(
    ({ itemText, evidence }) => ({ itemText, evidence })
  );
}

/**
 * Matches either {@link RETROACTIVE_TICK_MARKER_V1} or the bare-prose
 * "already ticked"/"already checked"/"already complete" phrasing the
 * shape-issue message documents as the marker's plain-language equivalent
 * ("a plain \"— done — already ticked...\" note"). Used only to compute
 * {@link RetroactiveTickClaimInternalV1.alreadyAnnotated} — a claim whose
 * `status`/`evidence` fields match neither is a bare "done" note with no
 * self-declaration that the item was already ticked, which is what makes it
 * a genuinely contradictory claim under a `no-checklist-change` declaration
 * (see {@link hasContradictoryNoChecklistChangeClaimV1}'s case 3).
 *
 * Deliberately checked against `status`/`evidence` only, never `itemText`
 * (review-flagged, 2026-08-25): a plan item's own wording can legitimately
 * contain "already ticked"-like phrasing or literally quote
 * {@link RETROACTIVE_TICK_MARKER_V1} — this file's own step 21 checklist
 * text does — and testing the whole raw bullet let that item-text substring
 * alone satisfy the annotation requirement for a claim that never actually
 * self-declared anything, reopening the exact bypass case 3 exists to close.
 */
const ALREADY_TICKED_ANNOTATION_PATTERN = /already[ \t]+(?:ticked|checked|complete)/i;

/** {@link RetroactiveTickClaimV1} plus whether the entry's own `status`/
 * `evidence` fields self-declare as an already-ticked status note — see
 * {@link ALREADY_TICKED_ANNOTATION_PATTERN}. Kept internal (not exported)
 * because every existing caller of {@link collectRetroactiveTickClaimsV1}
 * pattern-matches the narrower public shape with `assert.deepEqual`; adding
 * a field there would break those fixtures for callers that have no use for
 * it. Only {@link hasContradictoryNoChecklistChangeClaimV1} needs this. */
interface RetroactiveTickClaimInternalV1 extends RetroactiveTickClaimV1 {
  readonly alreadyAnnotated: boolean;
}

function collectRetroactiveTickClaimsInternalV1(
  ownSummary: string,
  planItemKeys: ReadonlySet<string> = new Set()
): RetroactiveTickClaimInternalV1[] {
  const claims: RetroactiveTickClaimInternalV1[] = [];
  const all = headingsV1(ownSummary);
  const at = findLastHeadingV1(all, "Plan Item Checklist");
  if (at === -1) {
    return claims;
  }
  const heading = all[at];
  if (!heading) {
    return claims;
  }
  const lines = walkLinesV1(ownSummary);
  let end = lines.length;
  for (let h = at + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= heading.level) {
      end = candidate.line;
      break;
    }
  }
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced || PART_CLAIM_LINE.test(line.text)) {
      continue;
    }
    const parsed = parsePlanItemChecklistLine(line.text, planItemKeys);
    if (!parsed) {
      continue;
    }
    if (!parsed.status.toLowerCase().startsWith("done")) {
      continue;
    }
    const statusAndEvidence = `${parsed.status} ${parsed.evidence}`;
    claims.push({
      itemText: parsed.itemText,
      evidence: parsed.evidence,
      alreadyAnnotated:
        ALREADY_TICKED_ANNOTATION_PATTERN.test(statusAndEvidence) ||
        statusAndEvidence.includes(RETROACTIVE_TICK_MARKER_V1),
    });
  }
  return claims;
}

/** One PART-level retroactive-tick claim — see {@link collectPartLevelTickClaimsV1}. */
export interface PartLevelTickClaimV1 {
  /** The part number as written, e.g. "7" or "3A" — matched against `## Part N` headings. */
  readonly partNumber: string;
  /** Verification evidence for the whole part; empty when the round omitted it. */
  readonly evidence: string;
}

function parsePartLevelClaimLine(raw: string): PartLevelTickClaimV1 | undefined {
  const match = PART_CLAIM_LINE.exec(raw);
  if (!match) {
    return undefined;
  }
  const partNumber = match[1] ?? "";
  const segments = (match[2] ?? "").trim().split(/\s+—\s+/);
  const status = segments[0] ?? "";
  if (!status.toLowerCase().startsWith("done")) {
    return undefined;
  }
  let evidence = segments.slice(1).join(" — ").trim();
  if (!evidence) {
    // The observed compact shape ("done this round (6/6), evidence: ...")
    // never separates evidence with its own ` — `; it names it inline
    // instead.
    const inline = /evidence:\s*(.+)$/i.exec(status);
    evidence = inline ? (inline[1] ?? "").trim() : "";
  }
  return { partNumber, evidence };
}

/**
 * PART-level claims from `ownSummary`'s `## Plan Item Checklist` section —
 * a round may report an entire plan Part complete in one line ("Part 7 —
 * done this round (6/6), evidence: ...") rather than enumerating every item,
 * observed live (round 073, "workflow 3"). Resolution to individual plan
 * items happens in {@link mergeChecklistProgressV1} via
 * `collectPlanItemsUnderPartHeadingV1`, which needs the plan of record this
 * function does not have.
 */
export function collectPartLevelTickClaimsV1(ownSummary: string): PartLevelTickClaimV1[] {
  const claims: PartLevelTickClaimV1[] = [];
  const all = headingsV1(ownSummary);
  const at = findLastHeadingV1(all, "Plan Item Checklist");
  if (at === -1) {
    return claims;
  }
  const heading = all[at];
  if (!heading) {
    return claims;
  }
  const lines = walkLinesV1(ownSummary);
  let end = lines.length;
  for (let h = at + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= heading.level) {
      end = candidate.line;
      break;
    }
  }
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const parsed = parsePartLevelClaimLine(line.text);
    if (parsed) {
      claims.push(parsed);
    }
  }
  return claims;
}

/** One open plan item's reason, as the round itself reported it. RC2 #13. */
export interface PlanItemReasonV1 {
  /** The plan item's identity text, matched the same way an echoed tick is. */
  readonly itemText: string;
  /** The round's own status field verbatim (e.g. "deferred", "not reached"). */
  readonly status: string;
  /** The round's own evidence/reason field verbatim; empty when it gave none. */
  readonly reason: string;
}

/**
 * Every entry in `summary`'s `## Plan Item Checklist` section whose status
 * does NOT start with "done" — the open items a round reported by name,
 * together with whatever reason it gave for each (RC2 #13, Step 49).
 *
 * `mergeChecklistProgressV1`'s own scan of this section only ever looks for
 * `done` claims (see {@link collectRetroactiveTickClaimsV1}) and silently
 * skips every other status; that is correct for ticking, but it is exactly
 * the information a "nothing more to build" decision card needs, so this is
 * a second, independent read of the same section rather than a change to
 * the ticking path.
 *
 * `planItemKeys` (optional) is forwarded to the shared line parser so a
 * plan item whose own text contains an em dash (` — `) is still split
 * correctly; omitting it falls back to the naive first-dash split, which is
 * still enough to recover `itemText` for matching against open items by
 * {@link normalizeChecklistItemTextV1}.
 */
export function collectPlanItemReasonsV1(
  summary: string,
  planItemKeys: ReadonlySet<string> = new Set()
): PlanItemReasonV1[] {
  const reasons: PlanItemReasonV1[] = [];
  const all = headingsV1(summary);
  const at = findLastHeadingV1(all, "Plan Item Checklist");
  if (at === -1) {
    return reasons;
  }
  const heading = all[at];
  if (!heading) {
    return reasons;
  }
  const lines = walkLinesV1(summary);
  let end = lines.length;
  for (let h = at + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= heading.level) {
      end = candidate.line;
      break;
    }
  }
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced || PART_CLAIM_LINE.test(line.text)) {
      continue;
    }
    const parsed = parsePlanItemChecklistLine(line.text, planItemKeys);
    if (!parsed || parsed.status.toLowerCase().startsWith("done")) {
      continue;
    }
    reasons.push({
      itemText: parsed.itemText,
      status: parsed.status,
      reason: parsed.evidence,
    });
  }
  return reasons;
}

/** One item the owner settled via {@link appendAcceptedNonGoalV1}. RC2 #13. */
export interface AcceptedNonGoalItemV1 {
  /** The plan item's own text, matching {@link settleChecklistItemV1}'s `itemText`. */
  readonly itemText: string;
  /** The one-line reason the owner gave (or confirmed) for excluding it. */
  readonly reason: string;
}

/**
 * Append one dated entry to `planOfRecord`'s `## Accepted Non-Goals` section
 * naming every item the owner settled in a single owner-decision card (RC2
 * #13, Step 52) — the write companion to {@link parseAcceptedNonGoalsV1}
 * (`reviewEvidenceNormalizerV1.ts`), which reads entries back by sub-heading.
 * Creates the `## Accepted Non-Goals` section itself when the plan has none
 * yet (most plans predate this feature). `items` empty is a no-op: returns
 * `planOfRecord` unchanged rather than writing an empty entry.
 *
 * When the section already has sub-headings, the new entry is inserted ahead
 * of them and each survives as its own entry. When the section instead holds
 * flat prose with no sub-heading of its own (also common — most plans predate
 * this feature and never got a second entry), that prose is first wrapped in
 * a `### Prior entries` heading of its own before the new entry is added.
 * Skipping this step would silently fold the old prose into the new dated
 * entry: once ANY sub-heading exists in the section,
 * {@link parseAcceptedNonGoalsV1} attributes all content up to the next
 * same-or-higher-level heading to whichever sub-heading precedes it, so
 * flat text left sitting ahead of a freshly inserted sub-heading would read
 * back as part of it — misattributing an older non-goal to this decision.
 *
 * This applies even when the section is a MIX of the two shapes: flat prose
 * followed by one or more existing sub-headings (e.g. a plan whose first
 * non-goal predates sub-headings and whose second one added them). That
 * leading flat prose is not "inside" the first existing sub-heading — it sits
 * ahead of it — so it gets the same `### Prior entries` treatment as the
 * fully-flat case before the new entry is inserted.
 */
export function appendAcceptedNonGoalV1(
  planOfRecord: string,
  items: readonly AcceptedNonGoalItemV1[],
  date: string,
  /** RC4 item 3: overrides the default sub-heading text (the narrowing entry names itself). */
  headingText?: string
): string {
  if (items.length === 0) {
    return planOfRecord;
  }
  const heading = `### ${headingText ?? `Open items settled by the owner (owner decision, ${date})`}`;
  const body = items.map((item) => `- ${item.itemText} — ${item.reason}`).join("\n");
  const entry = `${heading}\n\n${body}\n`;

  const headings = headingsV1(planOfRecord);
  const topIndex = headings.findIndex(
    (h) => h.title.trim().toLowerCase() === "accepted non-goals"
  );
  if (topIndex === -1) {
    const sep = planOfRecord.endsWith("\n") ? "" : "\n";
    return `${planOfRecord}${sep}\n## Accepted Non-Goals\n\n${entry}`;
  }
  const top = headings[topIndex]!;
  let sectionEndLine: number | undefined;
  for (let i = topIndex + 1; i < headings.length; i++) {
    if (headings[i]!.level <= top.level) {
      sectionEndLine = headings[i]!.line;
      break;
    }
  }
  const firstSubHeading = headings.find(
    (h, idx) =>
      idx > topIndex &&
      h.level > top.level &&
      (sectionEndLine === undefined || h.line < sectionEndLine)
  );

  const lines = walkLinesV1(planOfRecord);
  const lineStartOffsets: number[] = [];
  let runningOffset = 0;
  for (const l of lines) {
    lineStartOffsets.push(runningOffset);
    runningOffset += l.raw.length;
  }
  const headingLineEnd =
    (lineStartOffsets[top.line] ?? 0) + (lines[top.line]?.raw.length ?? 0);
  const sectionEnd =
    sectionEndLine !== undefined
      ? (lineStartOffsets[sectionEndLine] ?? planOfRecord.length)
      : planOfRecord.length;

  const beforeSection = planOfRecord.slice(0, headingLineEnd);
  const sectionBody = planOfRecord.slice(headingLineEnd, sectionEnd);
  const afterSection = planOfRecord.slice(sectionEnd);

  if (sectionBody.trim() === "") {
    return `${beforeSection}\n\n${entry}${sectionBody}${afterSection}`;
  }

  if (!firstSubHeading) {
    const preserved = `### Prior entries\n\n${sectionBody.trim()}\n`;
    return `${beforeSection}\n\n${preserved}\n${entry}${afterSection}`;
  }

  const firstSubHeadingOffset = lineStartOffsets[firstSubHeading.line] ?? headingLineEnd;
  const leadingFlat = planOfRecord.slice(headingLineEnd, firstSubHeadingOffset);
  const restWithHeadings = planOfRecord.slice(firstSubHeadingOffset, sectionEnd);

  if (leadingFlat.trim() === "") {
    return `${beforeSection}\n\n${entry}${sectionBody}${afterSection}`;
  }

  const preserved = `### Prior entries\n\n${leadingFlat.trim()}\n`;
  return `${beforeSection}\n\n${preserved}\n${entry}\n${restWithHeadings}${afterSection}`;
}

/** One owner decision for one open plan item (RC2 #13, Step 51's per-item QuickPick). */
export interface OpenPlanItemDecisionV1 {
  /** The plan item's own text, matching {@link settleChecklistItemV1}'s `itemText`. */
  readonly itemText: string;
  readonly mode: "tick" | "exclude" | "leave";
  /** Required (non-empty) for `"tick"` and `"exclude"`; ignored for `"leave"`. */
  readonly reason?: string;
}

/** Result of {@link applyOpenPlanItemDecisionsV1}. */
export interface ApplyOpenPlanItemDecisionsResultV1 {
  /** The updated plan text — `planOfRecord` unchanged if nothing matched. */
  readonly content: string;
  readonly ticked: readonly string[];
  readonly excluded: readonly string[];
  /** Decisions whose `itemText` no longer matches an open, unsettled item. */
  readonly notFound: readonly string[];
}

/**
 * Applies every owner decision from the "nothing more to build" card's
 * per-item QuickPick flow (RC2 #13, Step 52) in ONE pass over the plan and
 * returns updated content for a single write — never one write per item, so a
 * concurrent edit is caught (or not) atomically for the whole batch rather
 * than leaving it half-applied.
 *
 * Reuses {@link settleChecklistItemV1} for both `"tick"` and `"exclude"` (so
 * an excluded item gets the same inline `Excluded by you: …` note and
 * {@link EXCLUDED_CHECKLIST_ITEM_MARKER_V1} it would from the existing
 * single-item command), then appends ONE dated
 * `## Accepted Non-Goals` entry via {@link appendAcceptedNonGoalV1} naming
 * every excluded item together — not one entry per item — matching the
 * requirement's "one Accepted Non-Goal entry naming each excluded item and
 * reason". `"leave"` decisions are a no-op, kept in the input only so a
 * caller can pass every item's decision uniformly.
 */
export function applyOpenPlanItemDecisionsV1(
  planOfRecord: string,
  decisions: readonly OpenPlanItemDecisionV1[],
  date: string
): ApplyOpenPlanItemDecisionsResultV1 {
  let content = planOfRecord;
  const ticked: string[] = [];
  const excludedItems: AcceptedNonGoalItemV1[] = [];
  const notFound: string[] = [];
  for (const decision of decisions) {
    if (decision.mode === "leave") {
      continue;
    }
    const { content: next, settledItemText } = settleChecklistItemV1(
      content,
      decision.itemText,
      decision.mode,
      decision.reason ?? ""
    );
    if (settledItemText === undefined) {
      notFound.push(decision.itemText);
      continue;
    }
    content = next;
    if (decision.mode === "tick") {
      ticked.push(settledItemText);
    } else {
      excludedItems.push({ itemText: settledItemText, reason: decision.reason ?? "" });
    }
  }
  if (excludedItems.length > 0) {
    content = appendAcceptedNonGoalV1(content, excludedItems, date);
  }
  return {
    content,
    ticked,
    excluded: excludedItems.map((item) => item.itemText),
    notFound,
  };
}

/**
 * RC3 item 5, Step 10 (engine slice): one top-level checklist item's stable
 * identity, independent of its current checked/excluded state. `occurrence`
 * is the 1-based count of that exact (normalized) text among every
 * top-level checklist item in plan order — computed over ALL items, settled
 * or not, so it never shifts as items get ticked or excluded, and two items
 * that happen to share text still resolve to distinct plan lines.
 */
export interface OpenPlanItemRecordV1 {
  readonly itemId: string;
  readonly itemText: string;
  readonly occurrence: number;
  /** True when this line is already ticked or carries the excluded marker. */
  readonly settled: boolean;
  /** True when the line is ticked and not excluded (review1 Step 10: a tick the owner can still confirm). */
  readonly ticked: boolean;
}

/**
 * A stable id for one checklist item occurrence: a hash of its normalized
 * text plus its 1-based occurrence count, so a duplicate-text item and a
 * later occurrence of the same wording never collide. Deliberately opaque
 * and independent of plan-wide numbering (Step numbers/line numbers), which
 * change as the plan is edited.
 */
function exactItemKeyV1(text: string): string {
  // Exact identity: only unescape and trim; case and inner whitespace are
  // significant, so an edited line is never mistaken for the original.
  return unescapeChecklistItemTextV1(text).replace(CLOSED_BEFORE_IMPLEMENTATION_STRIP_RE, "").trim();
}

function occurrenceKeyV1(text: string, settled: boolean): string {
  if (!settled) {
    return exactItemKeyV1(text);
  }
  // A line this flow settled carries an appended annotation (and the excluded
  // marker); strip it so the line keeps the id it had while open and is
  // reported as "already settled" rather than "no longer in the plan".
  const withoutMarker = text.replace(/[ \t]*`?<!-- ensemble:excluded -->`?[ \t]*$/, "");
  return exactItemKeyV1(withoutMarker.replace(/\s+— (?:Checked|Excluded by you): [\s\S]*$/, ""));
}

export function computeOpenPlanItemIdV1(itemText: string, occurrence: number, nested = false): string {
  // review1 Step 9: a nested item's id is salted, so it never collides with a top-level item of the same wording;
  // a top-level item's id is unchanged.
  return createHash("sha256")
    .update(`${nested ? "nested\u0000" : ""}${exactItemKeyV1(itemText)}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 16);
}

/** One checklist item (top-level or nested) with the id a round may refer to it by (review1 Step 9). */
export interface PlanItemIdEntryV1 {
  readonly itemId: string;
  readonly itemText: string;
  readonly nested: boolean;
  readonly checked: boolean;
  readonly excluded: boolean;
  readonly occurrence: number;
  /** The item's position among all items (nested ones included) of the latest rendering. */
  readonly index: number;
  /** The id of a nested item's parent. */
  readonly parentId?: string;
}

/**
 * review1 Step 9: every item of the latest rendering, nested ones included, with an occurrence-aware id (two
 * items with the same wording get different ids; a settled item keeps the id it had while open).
 */
export function listPlanItemIdsV1(planOfRecord: string): readonly PlanItemIdEntryV1[] {
  const seen = new Map<string, number>();
  const entries: PlanItemIdEntryV1[] = [];
  let parentId: string | undefined;
  for (const item of itemsInLatestRendering(planOfRecord)) {
    const settled = item.checked || item.excluded;
    const key = `${item.nested ? "n" : "t"}${occurrenceKeyV1(item.text, settled)}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const itemId = computeOpenPlanItemIdV1(occurrenceKeyV1(item.text, settled), occurrence, item.nested);
    entries.push({
      itemId,
      itemText: unescapeChecklistItemTextV1(item.text),
      nested: item.nested,
      checked: item.checked,
      excluded: item.excluded,
      occurrence,
      index: entries.length,
      ...(item.nested && parentId !== undefined ? { parentId } : {}),
    });
    if (!item.nested) parentId = itemId;
  }
  return entries;
}

/** Result of {@link resolvePlanItemReferenceV1}. */
export type PlanItemReferenceResolutionV1 =
  | { readonly kind: "not-a-reference" }
  | { readonly kind: "item"; readonly itemText: string; readonly itemIndex: number }
  | { readonly kind: "problem"; readonly reason: string };

/**
 * review1 Step 9: reads a claim's item text as a reference by id (`item:<id>` or `[item:<id>]`, optionally
 * followed by the item's text) or as a bare `Step N` that names exactly one top-level item. Anything else is
 * `not-a-reference` and is matched by text as before. An unknown id, or a `Step N` that names several items,
 * is a problem with a true reason; it never ticks anything and never latches the checklist.
 */
export function resolvePlanItemReferenceV1(planOfRecord: string, reference: string): PlanItemReferenceResolutionV1 {
  const idMatch = /^\W*item:\s*([0-9a-f]{16})\b/i.exec(reference.trim());
  if (idMatch) {
    const id = idMatch[1]!.toLowerCase();
    const found = listPlanItemIdsV1(planOfRecord).find((entry) => entry.itemId === id);
    return found
      ? { kind: "item", itemText: found.itemText, itemIndex: found.index }
      : {
          kind: "problem",
          reason: `item:${id} is not an item id in the plan of record (the plan may have changed since the list was shown), so nothing was ticked for it`,
        };
  }
  const stepMatch = /^\W*(?:\*\*)?step\s+(\d+)\W*$/i.exec(reference.trim());
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    const owners = listPlanItemStepOwnersV1(planOfRecord).filter((owner) => owner.stepNumber === step);
    if (owners.length === 1) {
      const owner = owners[0]!;
      const entry = listPlanItemIdsV1(planOfRecord).find(
        (candidate) => !candidate.nested && candidate.itemId === owner.itemId
      );
      if (entry) {
        return { kind: "item", itemText: owner.itemText, itemIndex: entry.index };
      }
    }
    if (owners.length > 1) {
      return {
        kind: "problem",
        reason: `“Step ${step}” names ${owners.length} plan items, so nothing was ticked for it; name each item by its [item:<id>] or its text`,
      };
    }
  }
  return { kind: "not-a-reference" };
}

/**
 * Every top-level checklist item in `planOfRecord`'s latest rendering, in
 * plan order, each carrying the stable {@link computeOpenPlanItemIdV1} id
 * for its own text+occurrence. The basis for both assigning ids when an
 * open-items form is built and for resolving a submitted answer back to a
 * plan line later, since re-running this over a possibly-edited plan is the
 * only way to tell "still there, same occurrence" from "no longer in the
 * plan as written" without trusting a caller-supplied line number.
 */
export function listOpenPlanItemRecordsV1(planOfRecord: string): readonly OpenPlanItemRecordV1[] {
  const seen = new Map<string, number>();
  const records: OpenPlanItemRecordV1[] = [];
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.nested) {
      continue;
    }
    const settled = item.checked || item.excluded;
    const key = occurrenceKeyV1(item.text, settled);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const itemText = unescapeChecklistItemTextV1(item.text);
    records.push({
      itemId: computeOpenPlanItemIdV1(key, occurrence),
      itemText,
      occurrence,
      settled: item.checked || item.excluded,
      ticked: item.checked && !item.excluded,
    });
  }
  return records;
}

/** A top-level checklist item together with the plan step it belongs to, when that is readable. */
export interface PlanItemStepOwnerV1 extends OpenPlanItemRecordV1 {
  /**
   * The step number the item belongs to: its own `Step N` / `N.` prefix, else the
   * numbered section heading (`### 4. …`, `### Step 4 — …`) it sits under.
   * `undefined` when neither is present, or when the number is claimed by more
   * than one distinct owner (a repeated numbering across Parts), which is
   * never guessed at.
   */
  readonly stepNumber: number | undefined;
  /** The section heading text the item sits under (empty when none). */
  readonly section: string;
}

/**
 * Every top-level checklist item in plan order with its step owner. Pure and
 * conservative: an item whose step cannot be read exactly has no `stepNumber`.
 */
export function listPlanItemStepOwnersV1(planOfRecord: string): readonly PlanItemStepOwnerV1[] {
  const seen = new Map<string, number>();
  const raw: { record: OpenPlanItemRecordV1; step: number | undefined; ownerKey: string; section: string }[] = [];
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.nested) {
      continue;
    }
    const settled = item.checked || item.excluded;
    const key = occurrenceKeyV1(item.text, settled);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const itemText = unescapeChecklistItemTextV1(item.text);
    const record: OpenPlanItemRecordV1 = {
      itemId: computeOpenPlanItemIdV1(key, occurrence),
      itemText,
      occurrence,
      settled,
      ticked: item.checked && !item.excluded,
    };
    const plainItem = itemText.replace(/^[\s*_`]+/, "");
    const itemStep = /^step\s+(\d+)(?!\d)/i.exec(plainItem) ?? /^(\d+)[.)](?!\d)/.exec(plainItem);
    if (itemStep) {
      raw.push({ record, step: Number(itemStep[1]), ownerKey: `item:${itemText}`, section: item.section });
      continue;
    }
    const plainSection = item.section.trim().replace(/^[\s*_`]+/, "");
    const sectionStep = /^(?:step\s+)?(\d+)(?:\s*[:)—–-]|\.(?!\d)|\s*$)/i.exec(plainSection);
    raw.push({
      record,
      step: sectionStep ? Number(sectionStep[1]) : undefined,
      ownerKey: `section:${plainSection}`,
      section: item.section,
    });
  }
  const ownersByStep = new Map<number, Set<string>>();
  for (const entry of raw) {
    if (entry.step !== undefined) {
      const owners = ownersByStep.get(entry.step) ?? new Set<string>();
      owners.add(entry.ownerKey);
      ownersByStep.set(entry.step, owners);
    }
  }
  return raw.map((entry) => ({
    ...entry.record,
    section: entry.section,
    stepNumber:
      entry.step !== undefined && (ownersByStep.get(entry.step)?.size ?? 0) === 1 ? entry.step : undefined,
  }));
}

/**
 * The step numbers every `Step N` / `Steps N, M and K` / `Steps N–M` expression
 * in `text` names, in order of appearance, plus the expressions that could not
 * be read exactly (reversed or over-wide ranges). Never guesses at those.
 */
export function listStepNumbersNamedInTextV1(text: string): {
  readonly steps: readonly number[];
  readonly unreadable: readonly string[];
} {
  const steps: number[] = [];
  const unreadable: string[] = [];
  for (const match of text.matchAll(STEP_REFERENCE_RE)) {
    const expanded = expandStepNumbersV1(match[2]!);
    if (expanded === undefined) {
      unreadable.push(match[0]);
      continue;
    }
    for (const n of expanded) {
      if (!steps.includes(n)) {
        steps.push(n);
      }
    }
  }
  return { steps, unreadable };
}

/** One answer to one item on an open-items form (RC3 item 5, Step 10). */
export interface OpenPlanItemsFormAnswerV1 {
  readonly itemId: string;
  readonly choice: "exclude" | "tick" | "leave";
  /** The reason (Exclude) or note (tick); ignored for "leave". */
  readonly note?: string;
}

export interface OpenPlanItemsFormSkippedV1 {
  readonly itemId: string;
  readonly itemText: string;
  readonly reason: string;
}

export type ApplyOpenPlanItemsFormResultV1 =
  | {
      readonly ok: true;
      readonly content: string;
      readonly ticked: readonly string[];
      readonly excluded: readonly string[];
      /** Each ticked item's text as written (with its `— Checked:` note) — the gate's lookup key after the write. */
      readonly tickedWritten: readonly string[];
      /** Each excluded item's text as written (with its `— Excluded by you:` note). */
      readonly excludedWritten: readonly string[];
      /**
       * review1 Step 10: items that were already ticked in the plan and that the owner confirmed with "tick". The
       * plan line is not rewritten; the caller records the owner's tick so the gate settles the item.
       */
      readonly confirmedTicked: readonly string[];
      /**
       * review2 Step 3: every item the owner settled in this submission (a written tick, a confirmed existing tick,
       * an exclusion) with its issued id and its own clean text — never the text the plan line carries after the
       * `— Checked: …` / `— Excluded by you: …` note was appended. The owner decisions are keyed from this.
       */
      readonly decided: readonly {
        readonly itemId: string;
        readonly itemText: string;
        readonly decision: "tick" | "exclude";
      }[];
      readonly skipped: readonly OpenPlanItemsFormSkippedV1[];
    }
  | {
      /** A validation failure against the form itself — nothing was applied, the form stays open. */
      readonly ok: false;
      readonly rejectionReason: string;
    };

/**
 * RC3 item 5, Step 10 (engine slice): applies one open-items form submission
 * to `planOfRecord` in a single pass, the same one-write contract
 * {@link applyOpenPlanItemDecisionsV1} already gives its QuickPick-flow
 * caller, extended to be occurrence-aware so duplicate-text items resolve to
 * distinct lines.
 *
 * Two validation layers, matching the plan's contract:
 *  - Submission-level (any one bad answer rejects the WHOLE submission, so
 *    the caller can report one message and the form stays `open` with every
 *    selection intact): an `itemId` absent from `formItemIds`, an
 *    unrecognized `choice`, a `note` over
 *    {@link DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1}, or `exclude` with a blank
 *    note.
 *  - Per-item (a stale item is skipped, not rejected): resolved against
 *    `currentPlanRecords` — {@link listOpenPlanItemRecordsV1} over the plan
 *    text being applied to, RE-READ fresh rather than trusted from
 *    card-post time — by `itemId` only, never by position, text alone, or
 *    plan step number. An id with no match (edited, removed, or renumbered
 *    since the form was posted) or one already settled is skipped with a
 *    visible reason; the rest still apply.
 */
export function applyOpenPlanItemsFormV1(
  planOfRecord: string,
  formItemIds: ReadonlySet<string>,
  answers: readonly OpenPlanItemsFormAnswerV1[],
  date: string,
  /** Form items that were posted as already ticked: "tick" on one of these confirms the existing tick. */
  confirmableIds: ReadonlySet<string> = new Set()
): ApplyOpenPlanItemsFormResultV1 {
  for (const answer of answers) {
    if (!formItemIds.has(answer.itemId)) {
      return { ok: false, rejectionReason: "One of the submitted answers does not match an item on this form." };
    }
    if (answer.choice !== "exclude" && answer.choice !== "tick" && answer.choice !== "leave") {
      return { ok: false, rejectionReason: "One of the submitted answers has an unrecognized choice." };
    }
    if ((answer.note?.length ?? 0) > DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1) {
      return { ok: false, rejectionReason: "One of the submitted notes is too long." };
    }
    if (answer.choice === "exclude" && (answer.note ?? "").trim().length === 0) {
      return { ok: false, rejectionReason: "Excluding an item needs a reason — one of the submitted answers left it blank." };
    }
  }
  const currentRecords = listOpenPlanItemRecordsV1(planOfRecord);
  const currentById = new Map(currentRecords.map((record) => [record.itemId, record]));
  let content = planOfRecord;
  const ticked: string[] = [];
  const tickedWritten: string[] = [];
  const excludedWritten: string[] = [];
  const excludedItems: AcceptedNonGoalItemV1[] = [];
  const confirmedTicked: string[] = [];
  const decided: { itemId: string; itemText: string; decision: "tick" | "exclude" }[] = [];
  const skipped: OpenPlanItemsFormSkippedV1[] = [];
  for (const answer of answers) {
    if (answer.choice === "leave") {
      continue;
    }
    const current = currentById.get(answer.itemId);
    if (!current) {
      skipped.push({
        itemId: answer.itemId,
        itemText: "",
        reason: "skipped: this item is no longer in the plan as written",
      });
      continue;
    }
    if (current.ticked && answer.choice === "tick" && confirmableIds.has(answer.itemId)) {
      // Ticked already but not settled by a review: the owner's "tick" confirms it without touching the line.
      confirmedTicked.push(current.itemText);
      decided.push({ itemId: answer.itemId, itemText: cleanPlanItemTextV1(current.itemText), decision: "tick" });
      continue;
    }
    if (current.settled) {
      skipped.push({
        itemId: answer.itemId,
        itemText: current.itemText,
        reason: "skipped: this item was already settled",
      });
      continue;
    }
    const mode = answer.choice === "tick" ? "tick" : "exclude";
    const { content: next, settledItemText, writtenItemText } = settleChecklistItemAtOccurrenceV1(
      content,
      current.itemText,
      current.occurrence,
      mode,
      answer.note ?? ""
    );
    if (settledItemText === undefined) {
      // The plan changed between the lookup above and this write within the
      // same pass (only possible if two answers collide on the same
      // occurrence, which formItemIds/currentById already rule out) — treat
      // as stale rather than silently dropping the answer.
      skipped.push({
        itemId: answer.itemId,
        itemText: current.itemText,
        reason: "skipped: this item is no longer in the plan as written",
      });
      continue;
    }
    content = next;
    decided.push({ itemId: answer.itemId, itemText: cleanPlanItemTextV1(settledItemText), decision: mode });
    if (mode === "tick") {
      ticked.push(settledItemText);
      tickedWritten.push(writtenItemText ?? settledItemText);
    } else {
      excludedItems.push({ itemText: settledItemText, reason: answer.note ?? "" });
      excludedWritten.push(writtenItemText ?? settledItemText);
    }
  }
  if (excludedItems.length > 0) {
    content = appendAcceptedNonGoalV1(content, excludedItems, date);
  }
  return {
    ok: true,
    content,
    ticked,
    excluded: excludedItems.map((item) => item.itemText),
    tickedWritten,
    excludedWritten,
    confirmedTicked,
    decided,
    skipped,
  };
}

/**
 * Occurrence-aware sibling of {@link settleChecklistItemV1}: settles the
 * `occurrence`-th top-level item (1-based, counted over every top-level item
 * regardless of state — the same counting {@link listOpenPlanItemRecordsV1}
 * uses) whose normalized text matches `itemText`, instead of the first open
 * match. Returns `settledItemText: undefined` when that occurrence does not
 * exist or is not currently open (already ticked/excluded) — callers that
 * already checked `settled` via {@link listOpenPlanItemRecordsV1} should not
 * normally hit the latter case, but this stays fail-closed rather than
 * mutating a line the caller did not mean to touch.
 */
function settleChecklistItemAtOccurrenceV1(
  planOfRecord: string,
  itemText: string,
  occurrence: number,
  mode: "tick" | "exclude",
  note: string
): SettleChecklistItemResultV1 {
  const key = exactItemKeyV1(itemText);
  const cleanNote = note.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  let settledItemText: string | undefined;
  let writtenItemText: string | undefined;
  let seen = 0;
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced || settledItemText !== undefined) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (
            /^[ \t]/.test(open) ||
            occurrenceKeyV1(text, state !== " " || isExcludedChecklistItemText(text)) !== key
          ) {
            return whole;
          }
          seen += 1;
          if (seen !== occurrence || state !== " " || isExcludedChecklistItemText(text)) {
            return whole;
          }
          settledItemText = unescapeChecklistItemTextV1(text);
          const noteSuffix = mode === "tick"
            ? (cleanNote ? ` — Checked: ${cleanNote}.` : "")
            : (cleanNote ? ` — Excluded by you: ${cleanNote}.` : "");
          writtenItemText = unescapeChecklistItemTextV1(`${text}${noteSuffix}`);
          if (mode === "tick") {
            return `${open}x${close}${text}${noteSuffix}${trailing}`;
          }
          return `${open}${state}${close}${text}${noteSuffix} ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}${trailing}`;
        }
      );
    })
    .join("");
  return {
    content: settledItemText !== undefined ? `${prefix}${mergedRegion}` : planOfRecord,
    settledItemText,
    writtenItemText,
  };
}

/**
 * True when `ownSummary`'s `## Plan Item Checklist` section contains at
 * least one syntactically well-formed completion claim — item-level or
 * PART-level — REGARDLESS of whether it will go on to resolve against a
 * real plan item.
 *
 * Used by the shape gate (`describeImplementationSummaryShapeIssue`) so a
 * prose-only claim (no `- [x]` checkbox echo at all — the shape round 073 of
 * "workflow 3" actually used) satisfies the checklist-echo requirement on
 * its own, instead of being rejected before `mergeChecklistProgressV1` ever
 * runs. Whether the claim actually MATCHES a plan item is deliberately not
 * this function's concern: a claim that fails to resolve must still reach
 * the merge step so it is reported as `checklistClaimedButUnmerged` and
 * counted toward the sterile-round/latch accounting
 * (`hasContradictoryNoChecklistChangeClaimV1`'s sibling concern) — rejecting
 * it outright here would hide that signal behind a generic "malformed
 * summary" refusal instead.
 */
export function hasPlanItemChecklistClaimV1(ownSummary: string): boolean {
  return (
    collectRetroactiveTickClaimsV1(ownSummary).length > 0 ||
    collectPartLevelTickClaimsV1(ownSummary).length > 0
  );
}

/**
 * Every checklist item's raw text under the `## Part {partNumber}` heading
 * of `planOfRecord`'s latest checklist rendering, in document order — the
 * expansion target for a {@link PartLevelTickClaimV1}. Returns an empty
 * array when no heading matches (e.g. a claim naming a part the plan does
 * not have), which the caller surfaces exactly like any other unmatched
 * claim rather than expanding to nothing silently.
 */
function collectPlanItemsUnderPartHeadingV1(
  planOfRecord: string,
  partNumber: string
): string[] {
  return checklistMatchesUnderPartHeadingV1(planOfRecord, partNumber).map((match) => match[3] ?? "");
}

/**
 * Every checklist line (nested ones included, with its indent in group 1)
 * under the `Part <partNumber>` heading's range, in document order.
 */
function checklistMatchesUnderPartHeadingV1(
  planOfRecord: string,
  partNumber: string
): RegExpExecArray[] {
  const scoped = scopeToLatestChecklistV1(planOfRecord).region;
  const all = headingsV1(scoped);
  const partPattern = new RegExp(`^Part\\s+${partNumber}\\b`, "i");
  const at = all.findIndex((entry) => partPattern.test(entry.title.trim()));
  if (at === -1) {
    return [];
  }
  const heading = all[at]!;
  const lines = walkLinesV1(scoped);
  let end = lines.length;
  for (let h = at + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= heading.level) {
      end = candidate.line;
      break;
    }
  }
  const items: RegExpExecArray[] = [];
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const match = ANY_ITEM_LINE.exec(line.text);
    if (match) {
      items.push(match);
    }
  }
  return items;
}

/** One plan reference found in a blocker's text, with the plan's state for it (RC7 item 3). */
export interface BlockerPlanReferenceV1 {
  readonly kind: "item" | "step" | "part";
  readonly reference: string;
  /** Top-level items the reference resolves to that are still open. */
  readonly open: number;
  /** Top-level items it resolves to that are ticked or excluded. */
  readonly settled: number;
}

const PART_REFERENCE_RE =
  /\b[Pp]arts?\s+((?:[A-Z]|\d+)(?![A-Za-z0-9])(?:\s*(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)(?:[A-Z]|\d+)(?![A-Za-z0-9]))*)/g;
/**
 * `Step N`, plural `Steps N, M and K`, and ranges `Steps N–M` / `N-M` / `N to M`
 * (ordinary hyphen or en dash). Group 1 is an optional Part prefix; group 2 is
 * the whole numeric expression, tokenised by {@link expandStepNumbersV1}.
 */
const STEP_REFERENCE_RE =
  /\b(?:[Pp]art\s+([A-Z]|\d+)[,:\s]+)?[Ss]teps?\s+(\d+(?:\s*(?:[-–]|\bto\b|\bthrough\b)\s*\d+|(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)(?:[Ss]teps?\s+)?\d+(?:\s*(?:[-–]|\bto\b|\bthrough\b)\s*\d+)?)*)(?!\d)/g;
const QUOTED_SPAN_RE = /`([^`]+)`|"([^"]+)"|“([^”]+)”/g;
/** A range wider than this is treated as malformed rather than expanded. */
const MAX_STEP_RANGE_SPAN_V1 = 99;

function stepRecordMatches(itemText: string, step: string): boolean {
  const plain = itemText.replace(/^[\s*_`]+/, "");
  return new RegExp(`^(?:step\\s+${step}(?!\\d)|${step}[.)])`, "i").test(plain);
}

/**
 * Step numbers named by one {@link STEP_REFERENCE_RE} expression, or
 * `undefined` when any range in it is reversed, wider than
 * {@link MAX_STEP_RANGE_SPAN_V1} or otherwise malformed — a group that cannot
 * be read exactly is not guessed at.
 */
function expandStepNumbersV1(expression: string): readonly number[] | undefined {
  const numbers: number[] = [];
  for (const token of expression.matchAll(/(\d+)(?:\s*(?:[-–]|\bto\b|\bthrough\b)\s*(\d+))?/g)) {
    const from = Number(token[1]);
    const to = token[2] === undefined ? from : Number(token[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from > MAX_STEP_RANGE_SPAN_V1) {
      return undefined;
    }
    for (let n = from; n <= to; n++) {
      numbers.push(n);
    }
  }
  return numbers.length > 0 ? numbers : undefined;
}

interface NumberedSectionV1 {
  readonly number: number;
  /** The Part heading key (`1`, `A`, …) the section sits under, when any. */
  readonly part: string | undefined;
  readonly open: number;
  readonly settled: number;
}

/**
 * Numbered section headings (`### 1. Title`, `### Step 2 — Title`) in the
 * latest checklist rendering, each with the open/settled counts of its
 * unindented checklist lines up to the next heading of the same or a higher
 * level. A section with no checklist lines is not listed.
 */
function listNumberedSectionsV1(planOfRecord: string): readonly NumberedSectionV1[] {
  const scoped = scopeToLatestChecklistV1(planOfRecord).region;
  const all = headingsV1(scoped);
  const lines = walkLinesV1(scoped);
  const sections: NumberedSectionV1[] = [];
  all.forEach((heading, at) => {
    const title = heading.title.trim().replace(/^[\s*_`]+/, "");
    const numbered = /^(?:step\s+)?(\d+)(?:\s*[:)—–-]|\.(?!\d)|\s*$)/i.exec(title);
    if (!numbered) {
      return;
    }
    let end = lines.length;
    for (let h = at + 1; h < all.length; h++) {
      const candidate = all[h];
      if (candidate && candidate.level <= heading.level) {
        end = candidate.line;
        break;
      }
    }
    let open = 0;
    let settled = 0;
    for (let i = heading.line + 1; i < end; i++) {
      const line = lines[i];
      if (!line || line.fenced) {
        continue;
      }
      const item = ANY_ITEM_LINE.exec(line.text);
      if (!item || (item[1] ?? "").length > 0) {
        continue;
      }
      if (item[2]?.toLowerCase() === "x" || isExcludedChecklistItemText(item[3] ?? "")) {
        settled++;
      } else {
        open++;
      }
    }
    if (open + settled === 0) {
      return;
    }
    let part: string | undefined;
    for (let h = at - 1; h >= 0; h--) {
      const candidate = all[h];
      const partMatch = candidate && candidate.level < heading.level ? /^Part\s+([A-Za-z]|\d+)\b/i.exec(candidate.title.trim()) : null;
      if (partMatch) {
        part = (partMatch[1] ?? "").toUpperCase();
        break;
      }
    }
    sections.push({ number: Number(numbered[1]), part, open, settled });
  });
  return sections;
}

/**
 * RC7 item 3: the plan items a blocker's text points at, each with its
 * open/settled counts of top-level items. Item references are backticked or
 * quoted spans that name exactly one item; `Step N` (also `Steps N, M and K`
 * and `Steps N–M` ranges, with a hyphen or an en dash) names the one top-level
 * item starting with that step number — or, when the plan groups its checklist
 * under numbered section headings (`### 4. …`), that section's unindented
 * items, counting only the ones still open (inside the named Part, when the
 * text gives one). A list or range with any member that does not resolve to
 * exactly one item or section, or a reversed or over-wide range, adds no
 * reference. `Part X` (also lists like "Parts A, B and D") covers the
 * top-level checklist lines under the Part heading — an open nested child
 * never makes a Part count as open. A reference that matches nothing, or an
 * item span that matches several items, is dropped.
 */
export function resolveBlockerPlanReferencesV1(
  text: string,
  planOfRecord: string
): readonly BlockerPlanReferenceV1[] {
  const references: BlockerPlanReferenceV1[] = [];
  const records = listOpenPlanItemRecordsV1(planOfRecord);
  const partTopLevel = (part: string): { text: string; settled: boolean }[] =>
    checklistMatchesUnderPartHeadingV1(planOfRecord, part)
      .filter((match) => (match[1] ?? "").length === 0)
      .map((match) => {
        const itemText = match[3] ?? "";
        return { text: itemText, settled: match[2]?.toLowerCase() === "x" || isExcludedChecklistItemText(itemText) };
      });

  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    const span = normalizeChecklistItemTextV1(match[1] ?? match[2] ?? match[3] ?? "");
    if (span.length < 12) {
      continue;
    }
    const exact = records.filter((record) => normalizeChecklistItemTextV1(record.itemText) === span);
    const hits =
      exact.length > 0
        ? exact
        : records.filter((record) => normalizeChecklistItemTextV1(record.itemText).startsWith(span));
    if (hits.length === 1) {
      references.push({
        kind: "item",
        reference: hits[0]!.itemText,
        open: hits[0]!.settled ? 0 : 1,
        settled: hits[0]!.settled ? 1 : 0,
      });
    }
  }

  const consumedParts = new Set<string>();
  let numberedSections: readonly NumberedSectionV1[] | undefined;
  for (const match of text.matchAll(STEP_REFERENCE_RE)) {
    const part = match[1];
    if (part !== undefined) {
      consumedParts.add(part.toUpperCase());
    }
    const steps = expandStepNumbersV1(match[2]!);
    if (steps === undefined) {
      continue;
    }
    const candidates =
      part !== undefined
        ? partTopLevel(part.toUpperCase())
        : records.map((record) => ({ text: record.itemText, settled: record.settled }));
    // Every step in a list or range must resolve to exactly one item or one
    // numbered section; a group with an unresolvable or ambiguous member adds
    // no reference at all.
    const group: BlockerPlanReferenceV1[] = [];
    for (const step of steps) {
      const hits = candidates.filter((candidate) => stepRecordMatches(candidate.text, String(step)));
      if (hits.length === 1) {
        group.push({
          kind: "step",
          reference: `Step ${step}`,
          open: hits[0]!.settled ? 0 : 1,
          settled: hits[0]!.settled ? 1 : 0,
        });
        continue;
      }
      if (hits.length > 1) {
        break;
      }
      numberedSections ??= listNumberedSectionsV1(planOfRecord);
      const sections = numberedSections.filter(
        (section) =>
          section.number === step && (part === undefined || section.part === part.toUpperCase())
      );
      if (sections.length !== 1) {
        break;
      }
      group.push({
        kind: "step",
        reference: `Step ${step}`,
        open: sections[0]!.open,
        settled: sections[0]!.settled,
      });
    }
    if (group.length === steps.length) {
      references.push(...group);
    }
  }

  for (const match of text.matchAll(PART_REFERENCE_RE)) {
    for (const part of (match[1] ?? "").split(/\s*(?:,|\band\b|&)\s*/).filter((p) => p.length > 0)) {
      const key = part.toUpperCase();
      if (consumedParts.has(key)) {
        continue;
      }
      const items = partTopLevel(key);
      if (items.length === 0) {
        continue;
      }
      const settled = items.filter((item) => item.settled).length;
      references.push({ kind: "part", reference: `Part ${key}`, open: items.length - settled, settled });
    }
  }
  return references;
}

/**
 * Index (into `lines`) of the last real checklist marker line: unfenced, standalone, and followed by at least
 * one checklist item. The same rule as {@link scopeToLatestChecklistV1}, which cuts the document there.
 */
function findLatestChecklistMarkerLineIndexV1(lines: ReturnType<typeof walkLinesV1>): number | undefined {
  const candidates: number[] = [];
  const itemLines: number[] = [];
  lines.forEach((line, i) => {
    if (line.fenced) return;
    if (STANDALONE_MARKER_LINE.test(line.text)) candidates.push(i);
    else if (ANY_ITEM_LINE.test(line.text)) itemLines.push(i);
  });
  for (let c = candidates.length - 1; c >= 0; c--) {
    const at = candidates[c]!;
    if (itemLines.some((item) => item > at)) return at;
  }
  return undefined;
}

/** Headings that name a section of a round's own report. */
const REPORT_SECTION_TITLES_V1: ReadonlySet<string> = new Set([
  "plan item checklist",
  "verification",
  "plan deviations",
  "remaining blockers",
  "verified complete",
  "owner decisions needed",
  "files changed",
  "implemented",
]);

/**
 * Line index where the echoed plan ends and the round's own report begins, between `markerLine` and `boundary`
 * (review1 Step 12). `## Plan Item Checklist` is never part of a plan. A report-section heading ends the echo
 * when the echoed plan could not have carried it. With the plan of record in hand, that is a heading the plan
 * lacks, or one that appears more often than the plan has it (the round's own `## Verification` after the
 * plan's own, or the only `## Verification` when the plan has none). Without the plan, a repeated
 * report-section heading is the round's own second copy. A repeated heading that names no report section (a
 * plan phase the plan itself repeats) never ends the echo. With none of these, the echo runs to the
 * `## Files Changed` boundary as before.
 */
function findEchoEndLineV1(
  all: ReturnType<typeof headingsV1>,
  markerLine: number,
  boundary: number,
  planOfRecord?: string
): number {
  const planCounts = new Map<string, number>();
  if (planOfRecord !== undefined) {
    for (const heading of headingsV1(scopeToLatestChecklistV1(planOfRecord).region)) {
      const title = heading.title.trim().toLowerCase();
      planCounts.set(title, (planCounts.get(title) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  for (const heading of all) {
    if (heading.line <= markerLine || heading.line >= boundary) continue;
    const title = heading.title.trim().toLowerCase();
    if (title === "plan item checklist") return heading.line;
    const used = (seen.get(title) ?? 0) + 1;
    seen.set(title, used);
    if (!REPORT_SECTION_TITLES_V1.has(title)) continue;
    const allowed = planOfRecord !== undefined ? (planCounts.get(title) ?? 0) : 1;
    if (used > allowed) return heading.line;
  }
  return boundary;
}

/**
 * Split an implementation response into the checklist it echoed and the
 * summary it wrote.
 *
 * `run-implementation.md` puts the echo FIRST and the summary's own sections
 * after it, starting at `## Files Changed`. That boundary matters in both
 * directions:
 *
 *  - Reading checkbox state from the whole response also picked up the ticks
 *    in the summary's own `## Verification` — which the prompt specifies as "a
 *    short checklist". Those ticks could push the merge past what the echo
 *    actually reported, and a verification box whose text happened to match a
 *    plan item could satisfy the echo requirement with no echo present at all.
 *  - Reading prose from the whole response found the ECHOED `## Verification`
 *    first (the plan's own, guaranteed by `create-implementation.md`) rather
 *    than the run's, so a PR would describe planned verification steps instead
 *    of what the round actually verified.
 *
 * With no `## Files Changed` heading the whole response is treated as the
 * echo, which only happens for a response that fails the shape gate anyway.
 *
 * review1 Step 12: only the ECHOED PLAN is echo. The echo is the block that starts at the response's standalone
 * checklist marker and reproduces the checklist; everything outside that block is the round's own text,
 * wherever it sits. A round that writes `## Plan Item Checklist` and `## Verification` before `## Files Changed`
 * (bugs6 item 11: chat1's `runs/037`) used to have both read as echo and ignored, with the false reason that
 * the report "has no `## Plan Item Checklist` section". A response with no marker and no checkbox before its
 * `## Files Changed` has no echo at all, so all of it is the round's own.
 */
export function splitSummaryAtEchoV1(
  summary: string,
  planOfRecord?: string
): {
  echo: string;
  own: string;
} {
  const all = headingsV1(summary);
  const at = findLastHeadingV1(all, "Files Changed");
  if (at !== -1 && filesChangedIsSummaryBoundary(summary)) {
    const lines = walkLinesV1(summary);
    const markerLine = findLatestChecklistMarkerLineIndexV1(lines);
    const boundary = all[at]?.line ?? 0;
    if (markerLine !== undefined && markerLine < boundary) {
      // The echo is the reproduced checklist block: from the marker to the first heading that can only be the
      // round's own report (`## Plan Item Checklist`, or a heading the echoed plan already carried, such as the
      // round's own `## Verification` after the plan's). Everything before the marker and from that heading on
      // is the round's own text, wherever it sits relative to `## Files Changed`.
      const echoEnd = findEchoEndLineV1(all, markerLine, boundary, planOfRecord);
      return {
        echo: lines.slice(markerLine, echoEnd).map((line) => line.raw).join(""),
        own: [...lines.slice(0, markerLine), ...lines.slice(echoEnd)].map((line) => line.raw).join(""),
      };
    }
    if (markerLine === undefined) {
      const hasEchoedCheckboxes = lines.slice(0, boundary).some((line) => !line.fenced && ANY_ITEM_LINE.test(line.text));
      if (!hasEchoedCheckboxes) {
        // Nothing before the boundary reproduces a checklist: the whole response is the round's own text.
        return { echo: "", own: summary };
      }
    }
  }
  // The heading has to be a SUMMARY's file list, not a plan phase that happens
  // to carry that name. Splitting on the name alone let a response consisting
  // of nothing but the echoed plan split at the plan's own heading — so the
  // shape gate read the plan's `## Files Changed` and `## Verification` as the
  // run's, and an echo with no summary at all was promoted for review. Same
  // predicate the counting path uses, so the two agree on what a boundary is.
  if (at === -1 || !filesChangedIsSummaryBoundary(summary)) {
    return { echo: summary, own: "" };
  }
  const lines = walkLinesV1(summary);
  const boundary = all[at]?.line ?? 0;
  return {
    echo: lines.slice(0, boundary).map((line) => line.raw).join(""),
    own: lines.slice(boundary).map((line) => line.raw).join(""),
  };
}

/**
 * Split `content` at the LAST standalone checklist-marker line, so callers
 * count exactly one rendering of the list.
 *
 * A document can carry the checklist more than once: the round-progress
 * convention has a response reproduce "that entire checklist marker and list
 * verbatim" with updated boxes, and such a response can be appended into or
 * alongside the plan (observed live: 8 entries, 4 unique). Every rendering
 * opens with its own marker line, so the text from the last one onward is the
 * most recently updated copy.
 *
 * Returns the whole content as the region when there is no marker line, so
 * plain checklists behave exactly as before.
 */
export function scopeToLatestChecklistV1(content: string): {
  /** True when a real standalone marker line was found. */
  found: boolean;
  prefix: string;
  region: string;
} {
  const walked = walkLinesV1(content);

  // A marker only starts a rendering when it is real markup — not inside a
  // fenced example — and is actually followed by checklist items. A plan that
  // documents this mechanism can show the marker in a fenced block after the
  // real checklist; taking that example as the newest rendering discarded
  // every item above it, and when the example held no items, left nothing to
  // count at all — which reads as "no checklist" and disables the gate.
  const candidates: number[] = [];
  const itemLines: number[] = [];
  walked.forEach((line, i) => {
    if (line.fenced) {
      return;
    }
    if (STANDALONE_MARKER_LINE.test(line.text)) {
      candidates.push(i);
    } else if (ANY_ITEM_LINE.test(line.text)) {
      itemLines.push(i);
    }
  });

  let lastMarker = -1;
  for (let c = candidates.length - 1; c >= 0; c--) {
    const at = candidates[c]!;
    if (itemLines.some((item) => item > at)) {
      lastMarker = at;
      break;
    }
  }
  if (lastMarker === -1) {
    return { found: false, prefix: "", region: content };
  }
  // Rejoining the raw lines reproduces the original bytes exactly, so the
  // byte-preserving merge stays byte-preserving across the split.
  return {
    found: true,
    prefix: walked.slice(0, lastMarker).map((line) => line.raw).join(""),
    region: walked.slice(lastMarker).map((line) => line.raw).join(""),
  };
}

/**
 * True when the last `## Files Changed` heading is a run summary's file list
 * rather than a plan's area heading.
 *
 * Decided by what the section holds: a summary lists changed files, while a
 * plan grouping items under that name is followed by checkboxes. Anything
 * else — no such heading at all — is not a boundary.
 */
function filesChangedIsSummaryBoundary(content: string): boolean {
  const all = headingsV1(content);
  const at = findLastHeadingV1(all, "Files Changed");
  const heading = all[at];
  if (at === -1 || !heading) {
    return false;
  }
  const lines = walkLinesV1(content);
  let end = lines.length;
  for (let h = at + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= heading.level) {
      end = candidate.line;
      break;
    }
  }
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (line && !line.fenced && ANY_ITEM_LINE.test(line.text)) {
      return false;
    }
  }
  return true;
}

/**
 * True when `content` carries a real generated implementation checklist.
 *
 * THE definition, exported so nothing has to invent its own. Callers kept
 * reaching for `content.includes(IMPLEMENTATION_CHECKLIST_MARKER)`, which says
 * yes for a plan that merely quotes the marker in prose or inside a fenced
 * example — this repo's own plans do exactly that when the work is about this
 * mechanism. Those callers then treated ordinary `- [ ]` bullets as
 * authoritative plan progress and rejected valid summaries for not echoing
 * them. Same rule as the scoping that follows: a standalone, unfenced marker
 * line that is actually followed by checklist items.
 */
export function hasImplementationChecklistV1(content: string): boolean {
  // Asks the scoping pass whether it actually FOUND a standalone marker line.
  // The previous form compared `prefix !== content`, which is true for any
  // non-empty document whenever no marker was found (prefix is then ""), so a
  // plan that merely QUOTES the marker and happens to carry ordinary `- [ ]`
  // bullets was classified as a generated checklist — handing those unrelated
  // boxes authority over completeness, firing the echo requirement against
  // them, and suppressing real checklist generation.
  return (
    scopeToLatestChecklistV1(content).found &&
    itemsInLatestRendering(content).length > 0
  );
}

/**
 * Countable state of a plan-of-record checklist.
 *
 * `total` is FIXED: it is every item in the latest rendering and never
 * shrinks when an item is later marked excluded (wf "make the stage chat a
 * record of work", Part 5 / item 4 — a moving denominator makes two readings
 * of the same plan incomparable). An item is always either OPEN or SETTLED,
 * and settled has two renderings: ✓ `checked` (closed by doing the work) or
 * ✗ `closedWithoutDoing` (excluded — descoped, superseded, already covered,
 * or a branch not taken). Both count toward `settled` against the fixed
 * `total`; neither is ever subtracted from it.
 */
export interface ChecklistProgressV1 {
  /** Every checklist item in the latest rendering. Never shrinks when an
   * item is later marked excluded — see this interface's doc comment. */
  readonly total: number;
  /** Items whose box is ticked and NOT marked excluded — a step closed BY
   * doing the work (✓). */
  readonly checked: number;
  /**
   * Items carrying `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` — a step closed
   * WITHOUT doing the work (✗): descoped, superseded, turned out trivial,
   * turned out already done, or a branch not taken. Settled against `total`
   * exactly like `checked`, never subtracted from it.
   */
  readonly closedWithoutDoing: number;
  /** `checked + closedWithoutDoing` — every item settled one way or the
   * other against the fixed `total`. */
  readonly settled: number;
  /** `total - settled` — genuinely open work; the only number a completeness
   * gate should ever block on. */
  readonly remaining: number;
  /** @deprecated Alias for `closedWithoutDoing`, kept for one release so
   * callers migrate on their own schedule. Identical value. */
  readonly excluded: number;
  /**
   * Top-level items already closed without doing when Implementation first
   * started (they carry {@link CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1}). A
   * subset of `closedWithoutDoing`, so `total`/`settled`/`remaining` are
   * unchanged. Display only: the Implementation row's percentage leaves these
   * out of both sides. Absent on values built from older records.
   */
  readonly closedBeforeImplementation?: number;
}

export interface ChecklistEvidenceProgressV1 {
  /** Checkbox state shown to the owner; self-claims remain visible here. */
  readonly display: ChecklistProgressV1;
  /** Reviewer-verified completion plus explicit exclusions; used by gates. */
  readonly gate: ChecklistProgressV1;
  /** Ticked items the reviewer verified (never includes owner decisions). */
  readonly verified: number;
  /** Ticked items with only a model claim: neither verified nor decided by the owner. */
  readonly provisional: number;
  /**
   * bugs4 item 7: ticked items the owner settled through the form (recorded
   * with owner provenance). Counted as settled by the gate, kept apart from
   * `verified` so it is never mistaken for reviewer verification.
   */
  readonly ownerSettled: number;
}

/**
 * bugs4 Step 13 (item 29): how many nested (sub-)items in the plan of record are still
 * open (unticked and not excluded). They never change the plan's total, but an unticked
 * child keeps its parent open, so cards that warn about a changed plan name them.
 */
export function countOpenNestedChecklistItemsV1(planOfRecord: string): number {
  return itemsInLatestRendering(planOfRecord).filter((item) => item.nested && !item.checked && !item.excluded).length;
}

/**
 * bugs4 Step 13 (item 39): how many nested (sub-)items the plan of record has in total, whatever
 * their state. A review records this at dispatch so a later count can say "N sub-items added since
 * the last review" instead of treating children as a changed checklist set.
 */
export function countNestedChecklistItemsV1(planOfRecord: string): number {
  return itemsInLatestRendering(planOfRecord).filter((item) => item.nested).length;
}

/** An unticked, non-excluded plan item as Publish lists it: top-level or nested. */
export interface UnsettledPlanItemV1 {
  readonly text: string;
  readonly nested: boolean;
}

/**
 * bugs4 Step 13 (item 42): every unticked, non-excluded checklist item in the plan of record,
 * top-level and nested, in plan order. Publish lists these as blockers; excluded owner
 * hand-offs are left out because they wait on a person, not on a build.
 */
export function listUnsettledPlanItemsV1(planOfRecord: string): readonly UnsettledPlanItemV1[] {
  return itemsInLatestRendering(planOfRecord)
    .filter((item) => !item.checked && !item.excluded)
    .map((item) => ({ text: unescapeChecklistItemTextV1(item.text), nested: item.nested }));
}

/**
 * Every checklist item in one rendering, in document order — skipping items
 * inside fenced examples, which are illustrations of a checklist rather than
 * this plan's own work.
 *
 * `nested` is true for an item indented under another item (any non-zero
 * leading whitespace) — a discovered-sub-work child (1.0.0 gate A3, Step 13),
 * as opposed to a `nested: false` top-level plan item. Callers that compute
 * the plan's fixed denominator or detect item-set mutation must filter to
 * `nested === false`; callers that only tick/merge/list checkbox state
 * operate on every item regardless of nesting, since a child's own box is
 * still real, checkable state.
 */
function itemsInLatestRendering(
  content: string
): { text: string; checked: boolean; excluded: boolean; nested: boolean; section: string }[] {
  const items: { text: string; checked: boolean; excluded: boolean; nested: boolean; section: string }[] = [];
  /** The nearest preceding markdown heading — what area of the plan an item sits under. */
  let section = "";
  // Scoped to the latest rendering, then cut at a run summary's `## Files
  // Changed` — but only when that heading really is a summary boundary.
  //
  // A pre-split plan-final.md IS a run response (the summary used to be
  // written over the plan), so its region runs on through the response's own
  // `## Files Changed` and `## Verification`, and Verification is "a short
  // checklist" whose boxes were being counted as plan work.
  //
  // Cutting unconditionally was worse than the bug it fixed:
  // `create-implementation.md` groups items "under headings by area or phase",
  // so a plan may legitimately have `## Files Changed` as an AREA heading —
  // and every item from there on vanished from the count, reporting an
  // unfinished plan as complete and letting it advance. Under-counting is the
  // failure this whole gate exists to prevent, so the boundary now has to earn
  // it: a summary's Files Changed lists files, a plan's heading is followed by
  // checklist items.
  const scoped = scopeToLatestChecklistV1(content).region;
  const region = filesChangedIsSummaryBoundary(scoped)
    ? splitSummaryAtEchoV1(scoped).echo
    : scoped;
  // bugs4 item 30: the items of the current top-level item's block (the item
  // itself, then its nested children), with their indent, so a marker that sits
  // on an indented line of its own can be attributed to the item it belongs to.
  let block: { index: number; indent: number }[] = [];
  for (const line of walkLinesV1(region)) {
    if (line.fenced) {
      continue;
    }
    const heading = /^#{1,6}[ \t]+(.*\S)/.exec(line.text);
    if (heading) {
      section = heading[1] ?? "";
      block = [];
      continue;
    }
    const match = ANY_ITEM_LINE.exec(line.text);
    if (match) {
      const text = match[3] ?? "";
      const indent = match[1]?.length ?? 0;
      if (indent === 0) {
        block = [];
      }
      block.push({ index: items.length, indent });
      items.push({
        text,
        checked: match[2]?.toLowerCase() === "x",
        excluded: isExcludedChecklistItemText(text),
        nested: indent > 0,
        section,
      });
      continue;
    }
    if (line.text.trim().length === 0) {
      continue;
    }
    const lineIndent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
    if (lineIndent === 0) {
      block = [];
      continue;
    }
    if (isExcludedContinuationLineV1(line.text)) {
      for (let b = block.length - 1; b >= 0; b--) {
        const owner = block[b]!;
        if (owner.indent < lineIndent) {
          items[owner.index]!.excluded = true;
          break;
        }
      }
    }
  }
  return items;
}

/** One finding from {@link checkExclusionMarkerPlacementV1}. */
export interface ExclusionMarkerPlacementFindingV1 {
  /** 1-based line number in the plan text. */
  readonly line: number;
  /**
   * `own-line`: the marker sits on an indented line under its item. The gate
   * counts it, but the writer should put it on the item line.
   * `orphan`: the marker belongs to no item, so it excludes nothing.
   */
  readonly kind: "own-line" | "orphan";
  readonly text: string;
}

/**
 * bugs4 item 30, plan-format check: lists every line that carries a real
 * exclusion marker (not inside a code fence, not merely mentioned) without
 * being the item line itself. Orphans exclude nothing and are almost always a
 * formatting slip; own-line markers are honoured by the gate but flagged so
 * the writer moves them onto the item line.
 */
export function checkExclusionMarkerPlacementV1(planOfRecord: string): readonly ExclusionMarkerPlacementFindingV1[] {
  const findings: ExclusionMarkerPlacementFindingV1[] = [];
  const scoped = scopeToLatestChecklistV1(planOfRecord);
  const prefixLines = scoped.prefix.length === 0 ? 0 : scoped.prefix.split("\n").length - 1;
  let hasOwner = false;
  let lineNo = prefixLines;
  for (const line of walkLinesV1(scoped.region)) {
    lineNo++;
    if (line.fenced) continue;
    if (/^#{1,6}[ \t]+\S/.test(line.text)) {
      hasOwner = false;
      continue;
    }
    if (ANY_ITEM_LINE.test(line.text)) {
      hasOwner = true;
      continue;
    }
    if (line.text.trim().length === 0) continue;
    const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
    if (indent === 0) hasOwner = false;
    const bare = line.text.trim().replace(/^[-*][ \t]+/, "");
    if (!bare.includes(EXCLUDED_CHECKLIST_ITEM_MARKER_V1)) continue;
    if (isExcludedContinuationLineV1(line.text)) {
      findings.push({ line: lineNo, kind: indent > 0 && hasOwner ? "own-line" : "orphan", text: line.text.trim() });
    } else if (bare === EXCLUDED_CHECKLIST_ITEM_MARKER_V1 || bare === BACKTICK_WRAPPED_EXCLUDED_MARKER_V1) {
      findings.push({ line: lineNo, kind: "orphan", text: line.text.trim() });
    }
  }
  return findings;
}

/** Plan-format check wording for the reviewer; empty when the placement is canonical. */
export function formatExclusionMarkerPlacementForReviewerV1(planOfRecord: string | undefined): string {
  if (!planOfRecord) return "";
  const findings = checkExclusionMarkerPlacementV1(planOfRecord);
  if (findings.length === 0) return "";
  const orphans = findings.filter((f) => f.kind === "orphan");
  const ownLine = findings.filter((f) => f.kind === "own-line");
  const parts: string[] = [];
  if (orphans.length > 0) {
    parts.push(`${orphans.length} stray exclusion marker(s) belong to no checklist item and exclude nothing (plan-final.md line ${orphans.map((f) => f.line).join(", ")}); move each onto its item's own line.`);
  }
  if (ownLine.length > 0) {
    parts.push(`${ownLine.length} exclusion marker(s) sit on a line of their own under their item (line ${ownLine.map((f) => f.line).join(", ")}); the gate counts them, but the writer should put the marker on the item line.`);
  }
  return `Plan format: ${parts.join(" ")}`;
}

/**
 * bugs4 item 30: the plan's unfinished top-level items split into buildable
 * work and owner hand-offs ("N open, of which M are owner hand-offs"). A
 * hand-off is an excluded item whose box is still unticked: the gate settles it
 * against the fixed total, but it is still waiting on a person. `undefined`
 * when the plan has no countable checklist.
 */
export function describeOpenAndHandOffsV1(planOfRecord: string): string | undefined {
  const counted = countChecklistProgressV1(planOfRecord);
  if (!counted) return undefined;
  const handOffs = countOpenOwnerHandOffsV1(planOfRecord);
  return `${counted.remaining + handOffs} open, of which ${handOffs} are owner hand-offs`;
}

/** Excluded top-level items whose box is still unticked: waiting on a person, not unbuilt work. */
export function countOpenOwnerHandOffsV1(planOfRecord: string): number {
  return itemsInLatestRendering(planOfRecord).filter((item) => !item.nested && item.excluded && !item.checked).length;
}

/**
 * review2 Step 44: true when the plan has open work and every open top-level item waits on test evidence (an item
 * that requires tests). Owner hand-offs are excluded items, so they are not counted as open work here. No round can
 * build any of these items by editing; a zero-change round over them has nothing to do, and a clean review does not
 * mean the checklist is under-recorded.
 */
export function openItemsAllWaitOnTestEvidenceV1(planOfRecord: string): boolean {
  const open = itemsInLatestRendering(planOfRecord).filter((item) => !item.nested && !item.checked && !item.excluded);
  return open.length > 0 && open.every((item) => isTestDependentChecklistItemV1(item.text));
}

/**
 * bugs4 item 30: true when an indented, non-checkbox line under a checklist
 * item carries the exclusion marker for that item: the marker alone on its own
 * line (optionally as a bullet, or wrapped in backticks), or following text on
 * a continuation line. Stricter than the item-line rule: the marker wrapped in
 * backticks after other text is a mention of the marker, not an exclusion.
 */
export function isExcludedContinuationLineV1(lineText: string): boolean {
  const text = lineText.trim().replace(/^[-*][ \t]+/, "").trim();
  if (text === EXCLUDED_CHECKLIST_ITEM_MARKER_V1 || text === BACKTICK_WRAPPED_EXCLUDED_MARKER_V1) {
    return true;
  }
  if (!text.endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1)) {
    return false;
  }
  const before = text.slice(0, text.length - EXCLUDED_CHECKLIST_ITEM_MARKER_V1.length);
  return /\s$/.test(before) && !before.endsWith("`") && (before.match(/`/g)?.length ?? 0) % 2 === 0;
}

/** Return newly checked item texts between two plan renderings, preserving plan order. */
export function listNewlyCheckedChecklistItemsV1(before: string, after: string): readonly string[] {
  const oldCounts = new Map<string, number>();
  for (const item of itemsInLatestRendering(before)) {
    if (!item.checked || item.excluded) continue;
    const key = normalizeChecklistItemTextV1(item.text);
    oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const added: string[] = [];
  for (const item of itemsInLatestRendering(after)) {
    if (!item.checked || item.excluded) continue;
    const key = normalizeChecklistItemTextV1(item.text);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if (occurrence > (oldCounts.get(key) ?? 0)) added.push(item.text);
  }
  return added;
}

/**
 * review1 Step 9: the same comparison as {@link listNewlyCheckedChecklistItemsV1}, but each newly checked
 * item keeps WHICH copy of identically worded items it is (1-based, counted among items of its own level), so a
 * claim recorded for the second copy is stored against the second copy and not the first. `nested` says which
 * level the copy number counts in.
 */
export function listNewlyCheckedChecklistItemOccurrencesV1(
  before: string,
  after: string
): readonly { readonly text: string; readonly occurrence: number; readonly nested: boolean }[] {
  const settledBefore = new Set<string>();
  for (const entry of listPlanItemContentHashesV1(before)) {
    if (entry.checked && !entry.excluded) {
      settledBefore.add(`${entry.nested ? "n" : "t"}${entry.annotationFreeKey}#${entry.occurrence}`);
    }
  }
  const added: { text: string; occurrence: number; nested: boolean }[] = [];
  for (const entry of listPlanItemContentHashesV1(after)) {
    if (!entry.checked || entry.excluded) continue;
    if (settledBefore.has(`${entry.nested ? "n" : "t"}${entry.annotationFreeKey}#${entry.occurrence}`)) continue;
    // Nested items keep their copy number too: it counts among nested items of the same wording.
    added.push({ text: entry.text, occurrence: entry.occurrence, nested: entry.nested });
  }
  return added;
}

/** A plan area whose unticked boxes are checks for a person (or Ensemble's own verification run), not work a round can build. */
const HANDOFF_SECTION_PATTERN = /\b(verification|hand-?off)\b/i;

export interface UncheckedItemClassificationV1 {
  /** Unticked items a round could still build, in document order. */
  readonly buildable: readonly string[];
  /** Unticked items under a `## Verification` / hand-off heading — checks, not work. */
  readonly handoff: readonly string[];
}

/**
 * Splits the plan of record's outstanding (unticked, non-excluded, top-level)
 * items into work a round can still build and hand-off checks (v1 fixes 2,
 * item 31). Excluded items are settled and never appear; nested items belong
 * to their parent and are not counted, matching {@link countChecklistProgressV1}.
 */
export function classifyUncheckedChecklistItemsV1(planOfRecord: string): UncheckedItemClassificationV1 {
  const buildable: string[] = [];
  const handoff: string[] = [];
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.excluded || item.checked || item.nested) {
      continue;
    }
    const text = unescapeChecklistItemTextV1(item.text);
    (HANDOFF_SECTION_PATTERN.test(item.section) ? handoff : buildable).push(text);
  }
  return { buildable, handoff };
}

/** Result of {@link tickHandoffChecksV1}. */
export interface TickHandoffChecksResultV1 {
  /** The updated plan text — `planOfRecord` itself when nothing was ticked. */
  readonly content: string;
  /** The plan's own text of each item that was ticked. */
  readonly tickedItemTexts: readonly string[];
}

/**
 * Ticks hand-off checks on the user's word (v1 fixes 2, item 31, step 13): an
 * unticked, non-excluded, top-level item under a `## Verification` / hand-off
 * heading. Each tick records why — `— Checked: <note>.` — so a later reader can
 * tell a check a person confirmed from a box a round ticked.
 *
 * Deliberately narrow: an item outside a hand-off section, a nested item, an
 * excluded item and an already-ticked one are never touched, so this cannot be
 * used to settle buildable work. Only the checkbox glyph and the appended note
 * change; every other byte is preserved. Each requested target is ticked once,
 * matched by normalized text.
 */
export function tickHandoffChecksV1(
  planOfRecord: string,
  ticks: readonly { readonly itemText: string; readonly note: string }[]
): TickHandoffChecksResultV1 {
  const pending = new Map<string, string>();
  for (const tick of ticks) {
    const key = normalizeChecklistItemTextV1(tick.itemText);
    if (!pending.has(key)) {
      pending.set(key, tick.note.replace(/\s+/g, " ").trim().replace(/\.$/, ""));
    }
  }
  const tickedItemTexts: string[] = [];
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  let section = "";
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced) {
        return line.raw;
      }
      const heading = /^#{1,6}[ \t]+(.*\S)/.exec(line.text);
      if (heading) {
        section = heading[1] ?? "";
        return line.raw;
      }
      if (!HANDOFF_SECTION_PATTERN.test(section)) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (state !== " " || /^[ \t]/.test(open) || isExcludedChecklistItemText(text)) {
            return whole;
          }
          const key = normalizeChecklistItemTextV1(text);
          const note = pending.get(key);
          if (note === undefined) {
            return whole;
          }
          pending.delete(key);
          tickedItemTexts.push(unescapeChecklistItemTextV1(text));
          return `${open}x${close}${text} — Checked: ${note.length > 0 ? note : "confirmed by you"}.${trailing}`;
        }
      );
    })
    .join("");
  return {
    content: tickedItemTexts.length > 0 ? `${prefix}${mergedRegion}` : planOfRecord,
    tickedItemTexts,
  };
}

/** Result of {@link settleChecklistItemV1}. */
export interface SettleChecklistItemResultV1 {
  /** The updated plan text — `planOfRecord` itself when no line matched. */
  readonly content: string;
  /** The plan's own text of the item that was settled, or `undefined` when none matched. */
  readonly settledItemText: string | undefined;
  /**
   * The item's text as it reads on the written line, including the
   * `— Checked:` / `— Excluded by you:` note the settle appended. Its
   * normalized form is the key the gate looks the item up by after the write
   * (the original `settledItemText` no longer matches once a note is added).
   */
  readonly writtenItemText?: string | undefined;
}

/**
 * Settles ONE checklist item on the user's word (RC1 item 8): ticks it, or
 * excludes it (leaves the box open and appends the trailing exclusion marker).
 * Unlike {@link tickHandoffChecksV1} this works in any section, because it is
 * the user's explicit choice from a command — but it is otherwise as narrow: an
 * unticked, non-excluded, top-level item in the latest rendering, matched by
 * normalized text, first match only. Only that one line changes; every other
 * byte is preserved, so the item set and the denominator cannot change.
 */
export function settleChecklistItemV1(
  planOfRecord: string,
  itemText: string,
  mode: "tick" | "exclude",
  note: string
): SettleChecklistItemResultV1 {
  const key = normalizeChecklistItemTextV1(itemText);
  const cleanNote = note.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  let settledItemText: string | undefined;
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced || settledItemText !== undefined) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (
            state !== " " ||
            /^[ \t]/.test(open) ||
            isExcludedChecklistItemText(text) ||
            normalizeChecklistItemTextV1(text) !== key
          ) {
            return whole;
          }
          settledItemText = unescapeChecklistItemTextV1(text);
          if (mode === "tick") {
            return `${open}x${close}${text}${cleanNote ? ` — Checked: ${cleanNote}.` : ""}${trailing}`;
          }
          return `${open}${state}${close}${text}${cleanNote ? ` — Excluded by you: ${cleanNote}.` : ""} ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}${trailing}`;
        }
      );
    })
    .join("");
  return {
    content: settledItemText !== undefined ? `${prefix}${mergedRegion}` : planOfRecord,
    settledItemText,
  };
}

/** Result of {@link addNestedChecklistItemsV1}. */
export interface AddNestedChecklistItemsResultV1 {
  /** The updated plan text: `planOfRecord` itself when the parent item was not found. */
  readonly content: string;
  /** How many sub-items were added. */
  readonly added: number;
}

/**
 * bugs6 item 46: adds same-task sub-items (indented `- [ ]` lines) directly under ONE open top-level checklist item,
 * found the way {@link settleChecklistItemV1} finds it (latest rendering, normalized text, first match). Sub-items
 * never change the plan's total or the frozen count (a nested item is not part of the denominator), but an unticked
 * child keeps its parent open until it is built. Every other byte is preserved.
 */
export function addNestedChecklistItemsV1(
  planOfRecord: string,
  parentItemText: string,
  children: readonly string[]
): AddNestedChecklistItemsResultV1 {
  const key = normalizeChecklistItemTextV1(parentItemText);
  const clean = children.map((child) => child.replace(/\s+/g, " ").trim()).filter((child) => child.length > 0);
  if (clean.length === 0) {
    return { content: planOfRecord, added: 0 };
  }
  let inserted = false;
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  const merged: string[] = [];
  for (const line of walkLinesV1(region)) {
    merged.push(line.raw);
    if (inserted || line.fenced) {
      continue;
    }
    const match = ITEM_LINE.exec(line.raw);
    if (!match) {
      continue;
    }
    const [, open, state, , text] = match;
    if (state !== " " || /^[ \t]/.test(open ?? "") || isExcludedChecklistItemText(text ?? "") || normalizeChecklistItemTextV1(text ?? "") !== key) {
      continue;
    }
    const eol = /\r\n$/.test(line.raw) ? "\r\n" : "\n";
    if (!/\r?\n$/.test(line.raw)) {
      merged[merged.length - 1] = `${line.raw}${eol}`;
    }
    for (const child of clean) {
      merged.push(`  - [ ] ${child}${eol}`);
    }
    inserted = true;
  }
  return inserted ? { content: `${prefix}${merged.join("")}`, added: clean.length } : { content: planOfRecord, added: 0 };
}

/** Result of {@link rewordChecklistItemV1}. */
export interface RewordChecklistItemResultV1 {
  /** The updated plan text — `planOfRecord` itself when no line matched. */
  readonly content: string;
  /** The item's text before the rewording, or `undefined` when no line matched. */
  readonly previousItemText: string | undefined;
}

/**
 * review1 Step 4: replaces ONE checklist item's wording, scoped through the same latest-rendering line walk as
 * {@link settleChecklistItemV1} instead of the first textual match anywhere in the file (which could hit a
 * copy of the item in an older rendering, a nested item, or prose). The item is the `occurrence`-th
 * (1-based, default first) top-level item whose text, without Ensemble's annotations, matches `itemText`.
 * The checkbox state and a trailing exclusion marker are kept; every other byte is preserved.
 */
/**
 * review1 Step 4: how many top-level checklist items of the latest rendering read as `itemText` (compared the way
 * {@link rewordChecklistItemV1} compares). More than one means a text-only target is ambiguous: the caller needs the
 * occurrence the owner meant.
 */
export function countTopLevelPlanItemsNamedV1(planOfRecord: string, itemText: string): number {
  const key = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(itemText));
  return listPlanItemContentHashesV1(planOfRecord).filter((entry) => !entry.nested && entry.annotationFreeKey === key)
    .length;
}

export function rewordChecklistItemV1(
  planOfRecord: string,
  itemText: string,
  newText: string,
  note: string,
  occurrence = 1
): RewordChecklistItemResultV1 {
  const key = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(itemText));
  const cleanNote = note.replace(/\s+/g, " ").trim();
  const replacement = cleanNote ? `${newText.trim()} — ${cleanNote}` : newText.trim();
  let previousItemText: string | undefined;
  let seen = 0;
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  const rewritten = walkLinesV1(region)
    .map((line) => {
      if (line.fenced || previousItemText !== undefined) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (/^[ \t]/.test(open) || normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(text)) !== key) {
            return whole;
          }
          seen++;
          if (seen < occurrence) {
            return whole;
          }
          previousItemText = unescapeChecklistItemTextV1(text);
          const markerLen = isExcludedChecklistItemText(text) ? (trailingExcludedMarkerLengthV1(text) ?? 0) : 0;
          const marker = markerLen > 0 ? ` ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}` : "";
          return `${open}${state}${close}${replacement}${marker}${trailing}`;
        }
      );
    })
    .join("");
  return {
    content: previousItemText !== undefined ? `${prefix}${rewritten}` : planOfRecord,
    previousItemText,
  };
}

/** One reviewer-verified narrowing: the item, the part of it that does not apply, and the evidence for that. */
export interface VerifiedNarrowingInputV1 {
  readonly itemText: string;
  readonly notApplicable: string;
  readonly evidence: string;
}

/** Result of {@link applyVerifiedNarrowingsToPlanV1}. */
export interface ApplyVerifiedNarrowingsResultV1 {
  readonly content: string;
  readonly applied: readonly VerifiedNarrowingInputV1[];
  readonly skipped: readonly { readonly itemText: string; readonly reason: string }[];
}

/**
 * review1 Step 43: records each reviewer-verified narrowing as a NESTED, already-excluded child of the item it
 * narrows, noted `narrowed (reviewer-verified): <evidence>`. A nested exclusion settles by the same rule every
 * nested item does, so the parent stops waiting on work that does not apply, and the part that was cut stays
 * visible in the plan. Idempotent: a narrowing whose line is already under the item is skipped. An item that is
 * not a top-level item of the latest rendering is skipped with a reason, never guessed at.
 */
export function applyVerifiedNarrowingsToPlanV1(
  planOfRecord: string,
  narrowings: readonly VerifiedNarrowingInputV1[]
): ApplyVerifiedNarrowingsResultV1 {
  let content = planOfRecord;
  const applied: VerifiedNarrowingInputV1[] = [];
  const skipped: { itemText: string; reason: string }[] = [];
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  for (const narrowing of narrowings) {
    const key = normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(narrowing.itemText));
    const part = clean(narrowing.notApplicable);
    const evidence = clean(narrowing.evidence);
    if (!key || !part || !evidence) {
      skipped.push({ itemText: narrowing.itemText, reason: "the narrowing names no item, part or evidence" });
      continue;
    }
    const noteText = `${part} — narrowed (reviewer-verified): ${evidence}.`;
    const { prefix, region } = scopeToLatestChecklistV1(content);
    const lines = walkLinesV1(region);
    const parentIndex = lines.findIndex((line) => {
      if (line.fenced) {
        return false;
      }
      const match = ITEM_LINE.exec(line.raw);
      return !!match && !/^[ \t]/.test(match[1]!) && normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(match[4]!)) === key;
    });
    if (parentIndex === -1) {
      skipped.push({ itemText: narrowing.itemText, reason: "it is not a top-level item of the plan's checklist" });
      continue;
    }
    // Already recorded: a nested line under this item that carries the same note.
    let alreadyThere = false;
    for (let j = parentIndex + 1; j < lines.length; j++) {
      const match = ITEM_LINE.exec(lines[j]!.raw);
      if (match && !/^[ \t]/.test(match[1]!)) {
        break;
      }
      if (match && normalizeChecklistItemTextV1(match[4]!).includes(normalizeChecklistItemTextV1(noteText))) {
        alreadyThere = true;
        break;
      }
    }
    if (alreadyThere) {
      continue;
    }
    const parentRaw = lines[parentIndex]!.raw;
    const eol = parentRaw.endsWith("\r\n") ? "\r\n" : "\n";
    const child = `  - [ ] ${noteText} ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}${eol}`;
    const parentWithEol = /\r?\n$/.test(parentRaw) ? parentRaw : `${parentRaw}${eol}`;
    content =
      prefix +
      lines
        .map((line, index) => (index === parentIndex ? `${parentWithEol}${child}` : line.raw))
        .join("");
    applied.push(narrowing);
  }
  return { content, applied, skipped };
}

/**
 * Count the plan of record's checklist, or `undefined` when it carries none.
 *
 * One line is one item. Scoping to a single rendering is what removes the
 * cross-copy duplication, so nothing here collapses by text — two genuinely
 * distinct steps that happen to share wording stay two steps, and neither
 * disappears from the denominator.
 *
 * `total` counts EVERY TOP-LEVEL item, including ones marked excluded — the
 * denominator never shrinks (see `ChecklistProgressV1`'s doc comment). An
 * item marked excluded settles as `closedWithoutDoing` rather than
 * `checked`, so it still holds the completeness gate
 * (`reconcileProgressWithChecklistV1`) open only via `remaining`, never by
 * vanishing from the count entirely. The presence check below still counts
 * excluded items toward "has a checklist at all": a plan whose only items
 * are all marked excluded is a real (if fully out-of-scope) checklist, not
 * "no checklist", so it must not fall through to `undefined` and silently
 * disable the gate.
 *
 * Nested items (1.0.0 gate A3, Step 13's "discovered sub-work nests, and
 * nested items do not count") are indented checklist lines directly under a
 * top-level item — a round records a discovered-but-unenumerated piece of
 * work there instead of inflating the plan's fixed top-level denominator.
 * They never contribute to `total`, but they DO gate their parent: a
 * top-level item is only `checked` when its own box is ticked AND every
 * nested child immediately following it (until the next top-level item) is
 * itself settled (checked or excluded) — so a parent cannot be marked done
 * while a child it spawned is still open, keeping the percentage honest.
 */
export function countChecklistProgressV1(
  planOfRecord: string
): ChecklistProgressV1 | undefined {
  const items = itemsInLatestRendering(planOfRecord);
  const topLevelCount = items.filter((item) => !item.nested).length;
  if (topLevelCount === 0) {
    return undefined;
  }
  let checked = 0;
  let closedWithoutDoing = 0;
  let closedBeforeImplementation = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.nested) {
      continue;
    }
    let allChildrenSettled = true;
    for (let j = i + 1; j < items.length && items[j]!.nested; j++) {
      const child = items[j]!;
      if (!child.excluded && !child.checked) {
        allChildrenSettled = false;
      }
    }
    if (item.excluded) {
      closedWithoutDoing++;
      if (isClosedBeforeImplementationChecklistItemTextV1(item.text)) {
        closedBeforeImplementation++;
      }
    } else if (item.checked && allChildrenSettled) {
      checked++;
    }
  }
  const settled = checked + closedWithoutDoing;
  return {
    total: topLevelCount,
    checked,
    closedWithoutDoing,
    settled,
    remaining: topLevelCount - settled,
    excluded: closedWithoutDoing,
    ...(closedBeforeImplementation > 0 ? { closedBeforeImplementation } : {}),
  };
}

/** The slice of a stored owner decision the gate reads (`TaskProgress.planItemOwnerDecisions`). */
export interface OwnerDecisionRowV1 {
  readonly planRevision: string;
  readonly itemKey: string;
  readonly decision: string;
  /** review1 Step 2: the content hash of the item when the decision was recorded. */
  readonly itemContentHash?: string;
  /** review1 Step 2: which copy of identical items the decision was recorded for. */
  readonly itemOccurrence?: number;
  /** review1 (review fix): the nesting level the decision was recorded for. */
  readonly itemNested?: boolean;
  /** review2 Step 3: the issued id of the item the owner decided (absent on a row written before ids were stored). */
  readonly itemId?: string;
  /** The item's text as the row recorded it; read only to resolve a row that has no id. */
  readonly itemText?: string;
}

/**
 * review2 Steps 5 and 8: how stored owner decisions apply to a plan.
 *
 * - A row with an issued id (`byId`) applies to the item that id names, whatever else in the plan changed since.
 * - A row without an id but with a content hash and copy number (`byContent`) applies to that copy, as before.
 * - A legacy row with neither is read by its wording after annotation stripping, and only when exactly one item of
 *   the plan carries that wording. A row that names several items is `unresolved`: it settles none of them and is
 *   reported, because an owner's tick must never land on a same-worded item the owner did not mean.
 * - A row that names nothing in the plan is dropped without a report: its item is gone.
 */
export function resolveOwnerDecisionRowsV1<R extends OwnerDecisionRowV1>(
  planOfRecord: string,
  rows: readonly R[]
): { readonly byId: readonly R[]; readonly byContent: readonly R[]; readonly unresolved: readonly R[] } {
  const entries = listPlanItemContentHashesV1(planOfRecord);
  const byId: R[] = [];
  const byContent: R[] = [];
  const unresolved: R[] = [];
  for (const row of rows) {
    if (row.itemId !== undefined) {
      byId.push(row);
      continue;
    }
    if (row.itemContentHash !== undefined && row.itemOccurrence !== undefined) {
      byContent.push(row);
      continue;
    }
    const wanted = normalizeChecklistItemTextV1(cleanPlanItemTextV1(row.itemText ?? row.itemKey));
    const matching = entries.filter(
      (entry) =>
        (row.itemContentHash !== undefined ? entry.hash === row.itemContentHash : entry.annotationFreeKey === wanted) &&
        rowLevelAppliesV1(row.itemNested, entry)
    );
    if (matching.length === 1) byContent.push(row);
    else if (matching.length > 1) unresolved.push(row);
  }
  return { byId, byContent, unresolved };
}

/** The owner rows (any decision) that name several same-worded items and so settle none (review2 Step 5). */
export function listUnresolvedLegacyOwnerDecisionsV1<R extends OwnerDecisionRowV1>(
  planOfRecord: string,
  rows: readonly R[]
): readonly R[] {
  return resolveOwnerDecisionRowsV1(planOfRecord, rows).unresolved;
}

/**
 * review1 Step 2: which top-level items are settled by a reviewer verification or an owner tick, matched to
 * each item by content hash (or, for legacy rows, by text) — never by plan revision. A ticked item also needs
 * every nested child excluded or ticked and settled the same way.
 */
function settlementByItemV1(
  planOfRecord: string,
  itemEvidence: readonly {
    readonly itemKey: string;
    readonly itemContentHash?: string;
    readonly itemOccurrence?: number;
    readonly itemNested?: boolean;
    readonly verifications?: readonly unknown[];
    readonly claims?: readonly { readonly at: string }[];
  }[],
  ownerDecisions: readonly OwnerDecisionRowV1[]
): {
  readonly entry: PlanItemHashEntryV1;
  readonly verified: boolean;
  readonly owner: boolean;
  readonly childrenSettled: boolean;
  readonly unsettledChildren: readonly PlanItemHashEntryV1[];
  readonly claimedAt?: string;
  readonly index: number;
}[] {
  const entries = listPlanItemContentHashesV1(planOfRecord);
  const evidenceFor = indexPlanItemRowsV1(itemEvidence);
  // review2 Steps 5 and 8: a row with an issued id applies to the item that id names (across plan revisions); a
  // legacy row applies only when it names exactly one item.
  const ownerRows = resolveOwnerDecisionRowsV1(
    planOfRecord,
    ownerDecisions.filter((row) => row.decision === "tick")
  );
  const ownerFor = indexPlanItemRowsV1(ownerRows.byContent);
  const entryIds = listPlanItemIdsV1(planOfRecord);
  const idOfEntry = (entry: PlanItemHashEntryV1): string | undefined =>
    entryIds.length === entries.length ? entryIds[entries.indexOf(entry)]?.itemId : undefined;
  const ownerIds = new Set(ownerRows.byId.map((row) => row.itemId));
  const verifiedOf = (entry: PlanItemHashEntryV1): boolean =>
    evidenceFor(entry).some((row) => (row.verifications?.length ?? 0) > 0);
  const ownerOf = (entry: PlanItemHashEntryV1): boolean => {
    if (ownerFor(entry).length > 0) return true;
    const id = idOfEntry(entry);
    return id !== undefined && ownerIds.has(id);
  };
  const result: ReturnType<typeof settlementByItemV1> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.nested) continue;
    const unsettledChildren: PlanItemHashEntryV1[] = [];
    for (let j = i + 1; j < entries.length && entries[j]!.nested; j++) {
      const child = entries[j]!;
      if (!child.excluded && (!child.checked || !(verifiedOf(child) || ownerOf(child)))) unsettledChildren.push(child);
    }
    let claimedAt: string | undefined;
    for (const row of evidenceFor(entry)) {
      for (const claim of row.claims ?? []) {
        if (claimedAt === undefined || claim.at < claimedAt) claimedAt = claim.at;
      }
    }
    result.push({
      entry,
      verified: verifiedOf(entry),
      owner: ownerOf(entry),
      childrenSettled: unsettledChildren.length === 0,
      unsettledChildren,
      ...(claimedAt !== undefined ? { claimedAt } : {}),
      index: i,
    });
  }
  return result;
}

/** Separate visible checkboxes from completion that has reviewer provenance. */
export function countChecklistEvidenceProgressV1(
  planOfRecord: string,
  itemEvidence: readonly {
    readonly planRevision: string;
    readonly itemKey: string;
    readonly itemContentHash?: string;
    readonly verifications?: readonly unknown[];
  }[],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): ChecklistEvidenceProgressV1 | undefined {
  const display = countChecklistProgressV1(planOfRecord);
  if (!display) return undefined;
  // review1 Step 2: rows match the item they were recorded for (content hash, or text for legacy rows), not
  // the plan revision. bugs4 item 7: a form tick is an explicit owner decision. It settles the item for the
  // gate, but only while the box is still ticked in the plan, and it is counted apart from reviewer
  // verification.
  let verified = 0;
  let provisional = 0;
  let ownerSettled = 0;
  for (const item of settlementByItemV1(planOfRecord, itemEvidence, ownerDecisions)) {
    if (item.entry.excluded || !item.entry.checked) continue;
    if (item.verified && item.childrenSettled) verified++;
    else if (item.owner && item.childrenSettled) ownerSettled++;
    else provisional++;
  }
  const settled = verified + ownerSettled + display.closedWithoutDoing;
  return {
    display,
    gate: {
      ...display,
      checked: verified + ownerSettled,
      settled,
      remaining: display.total - settled,
    },
    verified,
    provisional,
    ownerSettled,
  };
}

/** One top-level item with the gate's verdict on it (review1 Step 8). */
export interface PlanItemSettlementV1 {
  readonly key: string;
  readonly hash: string;
  readonly settled: boolean;
  /** `Step N` when the item starts with a step label, else its first words. */
  readonly label: string;
}

/** A short label for an item in chat lines and tooltips. */
export function labelPlanItemV1(itemText: string): string {
  const step = /^\W*step\s+(\d+)\b/i.exec(itemText);
  return step ? `Step ${step[1]}` : truncateChecklistItemTextV1(stripPlanItemAnnotationsV1(itemText), 60);
}

/**
 * review1 Step 8: whether the gate counts each top-level item as settled — excluded, or ticked and verified or
 * owner-settled with every child settled — by the item's content hash. The basis for noticing which items a plan
 * change sent back to the review.
 */
export function listPlanItemSettlementV1(
  planOfRecord: string,
  itemEvidence: Parameters<typeof settlementByItemV1>[1],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): PlanItemSettlementV1[] {
  return settlementByItemV1(planOfRecord, itemEvidence, ownerDecisions).map((item) => ({
    key: item.entry.key,
    hash: item.entry.hash,
    settled: item.entry.excluded || (item.entry.checked && (item.verified || item.owner) && item.childrenSettled),
    label: labelPlanItemV1(item.entry.text),
  }));
}

/**
 * review1 Step 61 (review fix): the plan items still neither ticked nor excluded, read from the same per-item
 * settlement the gate and the Tasks pane use, so nested work is included. A top-level item that is not ticked is
 * listed itself; a ticked top-level item with an unticked, unexcluded child is represented by that child, named
 * "<child> (under <parent label>)", because a checked parent with unfinished work under it is not done. Ticked
 * items that only lack a review's check are not listed here; they count as `provisional` in the shared counts.
 */
export function listOpenPlanItemsForEndV1(
  planOfRecord: string,
  itemEvidence: Parameters<typeof settlementByItemV1>[1],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): string[] {
  const open: string[] = [];
  for (const item of settlementByItemV1(planOfRecord, itemEvidence, ownerDecisions)) {
    if (item.entry.excluded) continue;
    if (!item.entry.checked) {
      open.push(unescapeChecklistItemTextV1(item.entry.text));
      continue;
    }
    for (const child of item.unsettledChildren) {
      if (child.checked || child.excluded) continue;
      open.push(`${unescapeChecklistItemTextV1(child.text)} (under ${labelPlanItemV1(item.entry.text)})`);
    }
  }
  return open;
}

/**
 * What would satisfy the test-evidence rule for an item held back only for a missing
 * test report (bugs4 items 11 and 21): an editing round whose `## Verification` lists the
 * passing command that runs the item's test files, with passed/failed counts and the
 * post-edit source state. The command is a suggestion; the rule itself is unchanged.
 */
export const TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1 =
  "Run an Implementation or Apply Review round that lists, under ## Verification, the passing command for each item's test files " +
  "(for example `pnpm run test:unit -- <the item's test files>`) with its passed and failed counts and the post-edit source state.";

/** A ticked top-level item that only a model has claimed (no reviewer or owner settlement yet). */
export interface ProvisionalTickedItemV1 {
  readonly text: string;
  /** review1 (owner decision 2026-11-05): the id a reviewer cites in `## Verified Complete` for this item. */
  readonly id: string;
  readonly testDependent: boolean;
  /** Earliest recorded claim time for the item, when one exists. */
  readonly claimedAt?: string;
  /** Ticked nested items that no reviewer or owner has settled yet (review1 Step 6). */
  readonly unverifiedChildren?: readonly string[];
  /** The ids of {@link unverifiedChildren}, in the same order. */
  readonly unverifiedChildIds?: readonly string[];
}

/**
 * The ticked items the gate counts as provisional (the same rule as
 * {@link countChecklistEvidenceProgressV1}), oldest first: items with no recorded claim
 * time lead (ticked before evidence tracking), then by earliest claim time, ties in plan
 * order. A reviewer too short on budget to check them all therefore shrinks the backlog
 * from the old end every round (bugs4 item 21).
 */
export function listProvisionalTickedItemsV1(
  planOfRecord: string,
  itemEvidence: readonly {
    readonly planRevision: string;
    readonly itemKey: string;
    readonly itemContentHash?: string;
    readonly verifications?: readonly unknown[];
    readonly claims?: readonly { readonly at: string }[];
  }[],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): ProvisionalTickedItemV1[] {
  // review1 Step 2 / Step 6: rows match items by content hash (or text for legacy rows); a ticked child
  // that no reviewer or owner has settled is listed under its parent so the reviewer is asked about it.
  const found: { item: ProvisionalTickedItemV1; order: number }[] = [];
  // The hash list and the id list walk the same latest rendering, so an index names the same item in both.
  const ids = listPlanItemIdsV1(planOfRecord);
  const hashEntries = listPlanItemContentHashesV1(planOfRecord);
  for (const settlement of settlementByItemV1(planOfRecord, itemEvidence, ownerDecisions)) {
    const { entry } = settlement;
    if (entry.excluded || !entry.checked) continue;
    if ((settlement.verified || settlement.owner) && settlement.childrenSettled) continue;
    const openChildren = settlement.unsettledChildren.filter((child) => child.checked);
    const children = openChildren.map((child) => child.text);
    // `settlementByItemV1` builds its own entries, so a child is found again by what identifies it, not by reference.
    const childIds = openChildren.map((child) => {
      const at = hashEntries.findIndex(
        (candidate) =>
          candidate.nested && candidate.hash === child.hash && candidate.key === child.key && candidate.occurrence === child.occurrence
      );
      return ids[at]?.itemId ?? "";
    });
    found.push({
      item: {
        text: entry.text,
        id: ids[settlement.index]?.itemId ?? "",
        testDependent: isTestDependentChecklistItemV1(entry.text),
        ...(settlement.claimedAt ? { claimedAt: settlement.claimedAt } : {}),
        ...(children.length > 0 ? { unverifiedChildren: children, unverifiedChildIds: childIds } : {}),
      },
      order: settlement.index,
    });
  }
  return found
    .sort((a, b) => {
      const ak = a.item.claimedAt;
      const bk = b.item.claimedAt;
      if (ak === bk) return a.order - b.order;
      if (ak === undefined) return -1;
      if (bk === undefined) return 1;
      return ak < bk ? -1 : 1;
    })
    .map((entry) => entry.item);
}

/** Reviewer-facing block listing provisional ticked items by text, within a size limit. */
export function formatProvisionalTickedItemsForReviewerV1(
  planOfRecord: string | undefined,
  itemEvidence: Parameters<typeof listProvisionalTickedItemsV1>[1],
  ownerDecisions: readonly OwnerDecisionRowV1[] = [],
  limits: { readonly maxItems: number; readonly maxChars: number } = { maxItems: 40, maxChars: 8000 }
): string {
  if (!planOfRecord) return "unknown";
  const provisional = listProvisionalTickedItemsV1(planOfRecord, itemEvidence, ownerDecisions);
  if (provisional.length === 0) {
    return "None: every ticked item already has reviewer verification or an owner decision.";
  }
  const lines: string[] = [];
  let chars = 0;
  for (const item of provisional) {
    const childLines = (item.unverifiedChildren ?? []).map(
      (child, index) =>
        `  - ${item.unverifiedChildIds?.[index] ? `[item:${item.unverifiedChildIds[index]}] ` : ""}${child} [nested: verify separately]`
    );
    const line = [
      `- ${item.id ? `[item:${item.id}] ` : ""}${item.text}${item.testDependent ? " [needs a passing test report]" : ""}`,
      ...childLines,
    ].join("\n");
    if (lines.length >= limits.maxItems || chars + line.length > limits.maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const hidden = provisional.length - lines.length;
  return [
    `${provisional.length} ticked item${provisional.length === 1 ? " is" : "s are"} still provisional (ticked by a round, not yet verified by a reviewer). ` +
      `Listed oldest first${hidden > 0 ? `; ${lines.length} shown, ${hidden} more come up in later reviews` : ""}.`,
    "For each one you personally confirmed against the workspace, name it in `## Verified Complete` by its `[item:<id>]`, copying the id exactly (the item's text may follow it). Leave out any you did not check.",
    `Items marked [needs a passing test report] also need an applicable durable passing report from the list above. ${TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1}`,
    ...lines,
  ].join("\n");
}

/**
 * bugs4 item 7: one sentence that explains any gap between boxes ticked and
 * items the gate counts as settled, using the gate's own numbers. Shown where
 * the owner acts (the open-items form result, the cards).
 */
export function describeChecklistGateGapV1(
  progress: Pick<ChecklistEvidenceProgressV1, "verified" | "provisional" | "ownerSettled">
): string {
  const ticked = progress.verified + progress.provisional + progress.ownerSettled;
  const parts = [`${ticked} ticked`, `${progress.verified} verified by review`];
  if (progress.ownerSettled > 0) parts.push(`${progress.ownerSettled} settled by you`);
  if (progress.provisional > 0) parts.push(`${progress.provisional} awaiting review verification`);
  return parts.join(", ");
}

/**
 * Rewrites every top-level excluded item of the latest rendering that does not
 * yet carry {@link CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1}, inserting the
 * marker and a space immediately before the trailing excluded marker. Done
 * once, when the plan is first promoted for Implementation (RC8 item 6), so
 * the items closed during planning or plan review are recorded in
 * `plan-final.md` itself.
 *
 * Byte-preserving and scoped like {@link mergeChecklistProgressV1}: only the
 * matched lines of the latest rendering change; indentation, bullets, prose,
 * line endings and any older copy earlier in the document are untouched.
 * Nested (indented) items and fenced examples are never marked.
 */
export function markClosedBeforeImplementationV1(content: string): string {
  return rewriteClosedBeforeImplementationV1(content, () => true);
}

/**
 * Re-promotion for a plan revision: marks a top-level excluded item only when
 * an item with the same identity key carried the marker in `priorContent`
 * (counted per key, so duplicate wording is matched copy for copy). Marks
 * nothing else, so an item excluded after the first freeze is not newly
 * marked and progress made since then stays in the count.
 */
export function carryClosedBeforeImplementationMarkersV1(newContent: string, priorContent: string): string {
  const remainingByKey = new Map<string, number>();
  for (const item of itemsInLatestRendering(priorContent)) {
    if (!item.nested && isClosedBeforeImplementationChecklistItemTextV1(item.text)) {
      const key = normalizeChecklistItemTextV1(item.text);
      remainingByKey.set(key, (remainingByKey.get(key) ?? 0) + 1);
    }
  }
  if (remainingByKey.size === 0) {
    return newContent;
  }
  return rewriteClosedBeforeImplementationV1(newContent, (text) => {
    const key = normalizeChecklistItemTextV1(text);
    const left = remainingByKey.get(key) ?? 0;
    if (left <= 0) {
      return false;
    }
    remainingByKey.set(key, left - 1);
    return true;
  });
}

function rewriteClosedBeforeImplementationV1(content: string, shouldMark: (itemText: string) => boolean): string {
  const { found, prefix, region } = scopeToLatestChecklistV1(content);
  if (!found) {
    return content;
  }
  let changed = false;
  const rewritten = walkLinesV1(region)
    .map((line) => {
      if (line.fenced) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (
            /^[ \t]/.test(open) ||
            !isExcludedChecklistItemText(text) ||
            isClosedBeforeImplementationChecklistItemTextV1(text) ||
            !shouldMark(text)
          ) {
            return whole;
          }
          const markerLen = trailingExcludedMarkerLengthV1(text) ?? 0;
          const markerAt = text.trimEnd().length - markerLen;
          changed = true;
          return (
            `${open}${state}${close}${text.slice(0, markerAt)}` +
            `${CLOSED_BEFORE_IMPLEMENTATION_MARKER_V1} ${text.slice(markerAt)}${trailing}`
          );
        }
      );
    })
    .join("");
  return changed ? `${prefix}${rewritten}` : content;
}

/**
 * Format a settled/total checklist ratio as a whole-number percentage for
 * display (wf "make the stage chat a record of work", Part 5 / item 6).
 *
 * Floors rather than rounds, and returns 100 ONLY when every item is
 * actually settled — 84 of 85 settled must never read as "99%" (which reads
 * as finished) or "100%" (which would make the checklist a liar). `total
 * <= 0` (no checklist) reads as 0%, matching a fresh/empty progress state.
 */
/**
 * The counts the Implementation percentage is shown over (RC8 item 6):
 * `settled - closedBeforeImplementation` over `total - closedBeforeImplementation`,
 * so a task's first Implementation run starts at 0%. Display only — every
 * gate keeps the full counts. When every item was closed before Implementation
 * the row reads 0 of 0 (0%), matching the empty-checklist display.
 */
export function implementationDisplayCountsV1(
  counts: Pick<ChecklistProgressV1, "settled" | "total" | "closedBeforeImplementation">
): { complete: number; total: number; closedBeforeImplementation: number } {
  const closedBefore = counts.closedBeforeImplementation ?? 0;
  return {
    complete: counts.settled - closedBefore,
    total: counts.total - closedBefore,
    closedBeforeImplementation: closedBefore,
  };
}

export function formatChecklistPercentV1(settled: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  if (settled >= total) {
    return 100;
  }
  return Math.min(99, Math.floor((settled / total) * 100));
}

/**
 * Ensemble's own `settled/total` for the plan of record, in the exact form the
 * reviewer echoes as `<!-- progress: N/M -->` (RC1 item 7: Ensemble computes
 * the count and hands it over; the displayed figure is always Ensemble's).
 * `unknown` when there is no readable checklist, in which case the prompt tells
 * the reviewer to count for itself.
 */
export function formatChecklistProgressForReviewerV1(
  planOfRecord: string | undefined,
  itemEvidence?: readonly { readonly planRevision: string; readonly itemKey: string; readonly verifications?: readonly unknown[] }[],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): string {
  const counted = planOfRecord ? countChecklistProgressV1(planOfRecord) : undefined;
  if (!counted || itemEvidence === undefined || !planOfRecord) return counted ? `${counted.settled}/${counted.total}` : "unknown";
  const evidence = countChecklistEvidenceProgressV1(planOfRecord, itemEvidence, ownerDecisions);
  return evidence ? `${evidence.gate.settled}/${evidence.gate.total}` : "unknown";
}

export function formatChecklistEvidenceForReviewerV1(
  planOfRecord: string | undefined,
  itemEvidence: readonly {
    readonly planRevision: string;
    readonly itemKey: string;
    readonly verifications?: readonly unknown[];
  }[],
  ownerDecisions: readonly OwnerDecisionRowV1[] = []
): string {
  if (!planOfRecord) return "unknown";
  const evidence = countChecklistEvidenceProgressV1(planOfRecord, itemEvidence, ownerDecisions);
  return evidence ? `${evidence.verified} reviewer-verified; ${evidence.provisional} provisional; ` +
    (evidence.ownerSettled > 0 ? `${evidence.ownerSettled} settled by the owner; ` : "") +
    `${evidence.display.closedWithoutDoing} explicitly excluded` : "unknown";
}

/**
 * The Implementation row's progress label. ALWAYS a percentage, never a
 * fraction competing with the review row's score — including a latched
 * (unverified) count, which keeps its qualifier instead of switching format
 * (RC1 item 7: "84/243 · unverified" read as a different kind of number).
 */
export function formatImplementationProgressLabelV1(
  settled: number,
  total: number,
  unverified: boolean
): string {
  const percent = `${formatChecklistPercentV1(settled, total)}%`;
  return unverified ? `${percent} · unverified` : percent;
}

/**
 * Tri-state glyph for one checklist item, matching {@link ChecklistProgressV1}'s
 * settled/total scheme exactly: `✓` for a step closed BY doing the work
 * (checked and not excluded), `✗` for a step closed WITHOUT doing the work
 * (carries `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` — descoped, superseded, or a
 * branch not taken — regardless of its own checkbox state), and `☐` for
 * genuinely open work.
 *
 * Shared so every UI list of checklist items (the reconcile evidence blocks,
 * the outstanding-items tooltip, the reviewer-verified-ticks confirmation)
 * renders the same three symbols instead of a bare `-` bullet that cannot by
 * itself distinguish "closed without doing" from "still open" (wf "make the
 * stage chat a record of work", Part 5 / item 6). The on-disk
 * `<!-- ensemble:excluded -->` marker format this reads is unchanged by this
 * function — it only affects how a list is displayed, never how it is stored.
 */
export function formatChecklistItemGlyphV1(item: {
  readonly checked: boolean;
  readonly excluded: boolean;
}): "✓" | "✗" | "☐" {
  if (item.excluded) {
    return "✗";
  }
  return item.checked ? "✓" : "☐";
}

/** Normalized text of every checklist item in `content`'s latest rendering. */
export function collectChecklistItemKeysV1(content: string): ReadonlySet<string> {
  return new Set(
    itemsInLatestRendering(content).map((item) =>
      normalizeChecklistItemTextV1(item.text)
    )
  );
}

/**
 * review2 Step 6: the key an item is compared under when asking whether a round changed the item SET. Ensemble's own
 * notes (`— Checked: …`, `— Excluded by you: …`) and markers are not part of what the item says, so an owner's tick
 * or exclusion made while the round ran never reads as a dropped and an added item.
 */
function itemSetKeyV1(text: string): string {
  return normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(text));
}

const STEP_LABEL_RE = /^\s*(?:\*\*)?Step\s+(\d+)(?:\*\*)?\s*[:.—–-]?\s*/i;

/**
 * review2 Step 7: did a change to the item set move step numbers? True when some dropped item and some added item
 * carry the same wording after their `Step N` label is removed, under different numbers. Only then is the change a
 * renumbering; any other add-plus-drop is a rewording or a replacement and must be called that.
 */
export function hasStepNumbersChangedV1(removedItems: readonly string[], addedItems: readonly string[]): boolean {
  const split = (text: string): { readonly step: string; readonly rest: string } | undefined => {
    const match = STEP_LABEL_RE.exec(text);
    return match ? { step: match[1]!, rest: itemSetKeyV1(text.slice(match[0].length)) } : undefined;
  };
  const added = addedItems.map(split).filter((entry): entry is { step: string; rest: string } => entry !== undefined);
  return removedItems
    .map(split)
    .some((gone) => gone !== undefined && added.some((entry) => entry.rest === gone.rest && entry.step !== gone.step));
}

/**
 * review2 Step 6: `restoredText` (the plan as it read at round start) with the line of each owner-settled item taken
 * from `currentText`, so putting the item set back never reverts what the owner ticked, excluded or noted while the
 * round ran. Items are paired by issued id (a settled item keeps the id it had while open). Returns `restoredText`
 * unchanged when the two renderings cannot be paired line by line.
 */
export function carryOwnerSettledLinesV1(
  restoredText: string,
  currentText: string,
  ownerItemIds: ReadonlySet<string>
): string {
  if (ownerItemIds.size === 0) return restoredText;
  const itemLines = (text: string): { readonly region: ReturnType<typeof walkLinesV1>; readonly indexes: number[]; readonly prefix: string } => {
    const scoped = scopeToLatestChecklistV1(text);
    const region = walkLinesV1(scoped.region);
    const indexes: number[] = [];
    region.forEach((line, index) => {
      if (!line.fenced && ANY_ITEM_LINE.test(line.text)) indexes.push(index);
    });
    return { region, indexes, prefix: scoped.prefix };
  };
  const current = itemLines(currentText);
  const restored = itemLines(restoredText);
  const currentIds = listPlanItemIdsV1(currentText);
  const restoredIds = listPlanItemIdsV1(restoredText);
  // The id lists cover the same items as the item lines (a summary boundary can cut the list short, never extend it).
  if (currentIds.length > current.indexes.length || restoredIds.length > restored.indexes.length) return restoredText;
  const replacements = new Map<string, string>();
  currentIds.forEach((entry, k) => {
    if (ownerItemIds.has(entry.itemId)) replacements.set(entry.itemId, current.region[current.indexes[k]!]!.raw);
  });
  if (replacements.size === 0) return restoredText;
  const out = restored.region.map((line) => line.raw);
  restoredIds.forEach((entry, k) => {
    const raw = replacements.get(entry.itemId);
    if (raw === undefined) return;
    const at = restored.indexes[k]!;
    // Keep the restored line's own ending so a last line without one never joins the next.
    out[at] = raw.replace(/\r?\n$/, "") + (/\r?\n$/.exec(out[at]!)?.[0] ?? "");
  });
  return restored.prefix + out.join("");
}

/** Result of {@link detectChecklistItemSetMutationV1}: the item texts a round
 * added and/or dropped, exactly as they read in each side's own rendering. */
export interface ChecklistItemSetMutationV1 {
  /** `"added"` — only new items; `"removed"` — only dropped items;
   * `"renumbered"` — both, which is what a plan reads as when an item's text
   * changed enough to no longer match (its old key drops out while a new one
   * appears), not only when literal numbering shifted. */
  readonly kind: "added" | "removed" | "renumbered";
  /** Item texts present after but not before, in the after-content's document
   * order, each key reported once even if the round duplicated it. */
  readonly addedItems: readonly string[];
  /** Item texts present before but not after, in the before-content's
   * document order, each key reported once. */
  readonly removedItems: readonly string[];
}

/**
 * Compares two renderings of a plan checklist by item-text KEY (not tick
 * state, not position) and reports whether the item SET itself changed —
 * the guard behind wf "make the stage chat a record of work" item 5's rule
 * that a round never adds, removes, or renumbers a checklist item.
 * {@link mergeChecklistProgressV1} only ever flips existing items' checkbox
 * glyphs, so under ordinary operation `before`/`after` always key-match
 * exactly; a mismatch can only come from a round directly editing
 * `plan-final.md`'s item list (an edit-mode round with file-write access —
 * see the wf10 "Batch F" incident this guard exists to catch). Returns
 * `undefined` when the item sets match exactly, regardless of tick-state
 * changes.
 *
 * Compares TOP-LEVEL items only (`item.nested === false`) for the add/remove
 * sets above. A nested item — indented under an existing top-level item — is
 * a discovered-sub-work child (1.0.0 gate A3, Step 13) that a round is
 * explicitly permitted to ADD without moving the plan's fixed denominator;
 * treating an addition as a mutation would revert exactly the recording
 * behavior that requirement asks for. Adding, removing, or reordering a
 * TOP-LEVEL item is still caught unchanged.
 *
 * The addition exception is deliberately narrower than "nested items never
 * count": a nested child recorded against a top-level item which is STILL
 * PRESENT afterward, and that has since disappeared or been reworded, IS
 * reported (folded into `removedItems`, same as a dropped top-level item) —
 * review finding, 2026-09-06: filtering nested items out of both snapshots
 * unconditionally let a round silently delete or reword a discovered child
 * and tick its parent, since `countChecklistProgressV1` can only gate on
 * children it can still see. Only ADDING a nested child is a permitted,
 * denominator-neutral exception (1.0.0 gate A3, Step 13); removing or
 * rewording one — settled (checked/excluded) or not — is still flagged,
 * exactly like a top-level item's removal, so a round cannot silently erase
 * the audit trail of discovered work once it has been recorded. Review
 * finding, 2026-09-06 (second pass): an earlier revision of this fix
 * exempted already-SETTLED children from removal detection on the theory
 * that dropping done bookkeeping is harmless — but that let a round quietly
 * delete a COMPLETED discovered child's record, which is exactly the
 * plan-integrity guarantee this guard exists to enforce. The only exemption
 * remaining is a child whose parent was itself removed (already caught as
 * the parent's own top-level removal — deleting an item's children along
 * with it is not an additional mutation).
 */
export function detectChecklistItemSetMutationV1(
  beforeContent: string,
  afterContent: string
): ChecklistItemSetMutationV1 | undefined {
  const beforeAll = itemsInLatestRendering(beforeContent);
  const afterAll = itemsInLatestRendering(afterContent);
  const beforeItems = beforeAll.filter((item) => !item.nested);
  const afterItems = afterAll.filter((item) => !item.nested);
  const beforeKeys = new Set(beforeItems.map((item) => itemSetKeyV1(item.text)));
  const afterKeys = new Set(afterItems.map((item) => itemSetKeyV1(item.text)));

  const addedItems: string[] = [];
  const seenAdded = new Set<string>();
  for (const item of afterItems) {
    const key = itemSetKeyV1(item.text);
    if (!beforeKeys.has(key) && !seenAdded.has(key)) {
      seenAdded.add(key);
      addedItems.push(item.text);
    }
  }
  const removedItems: string[] = [];
  const seenRemoved = new Set<string>();
  for (const item of beforeItems) {
    const key = itemSetKeyV1(item.text);
    if (!afterKeys.has(key) && !seenRemoved.has(key)) {
      seenRemoved.add(key);
      removedItems.push(item.text);
    }
  }

  // Pair each nested item with the top-level item immediately preceding it in
  // document order, so removal can be checked against ITS OWN parent rather
  // than the item set as a whole.
  const pairWithParent = (
    items: readonly { text: string; checked: boolean; excluded: boolean; nested: boolean }[]
  ): { parentKey: string; text: string; checked: boolean; excluded: boolean }[] => {
    const pairs: { parentKey: string; text: string; checked: boolean; excluded: boolean }[] = [];
    let currentParentKey: string | undefined;
    for (const item of items) {
      if (!item.nested) {
        currentParentKey = itemSetKeyV1(item.text);
      } else if (currentParentKey !== undefined) {
        pairs.push({
          parentKey: currentParentKey,
          text: item.text,
          checked: item.checked,
          excluded: item.excluded,
        });
      }
    }
    return pairs;
  };
  const afterChildKeysByParent = new Map<string, Set<string>>();
  for (const pair of pairWithParent(afterAll)) {
    const key = itemSetKeyV1(pair.text);
    const set = afterChildKeysByParent.get(pair.parentKey) ?? new Set<string>();
    set.add(key);
    afterChildKeysByParent.set(pair.parentKey, set);
  }
  const seenRemovedNested = new Set<string>();
  for (const pair of pairWithParent(beforeAll)) {
    if (!afterKeys.has(pair.parentKey)) {
      continue; // Parent itself was dropped — already caught above.
    }
    const key = itemSetKeyV1(pair.text);
    const stillPresent = afterChildKeysByParent.get(pair.parentKey)?.has(key) ?? false;
    if (!stillPresent && !seenRemovedNested.has(key)) {
      seenRemovedNested.add(key);
      removedItems.push(pair.text);
    }
  }

  if (addedItems.length === 0 && removedItems.length === 0) {
    return undefined;
  }
  const kind: ChecklistItemSetMutationV1["kind"] =
    addedItems.length > 0 && removedItems.length > 0
      ? "renumbered"
      : addedItems.length > 0
        ? "added"
        : "removed";
  return { kind, addedItems, removedItems };
}

/** How many times each item is reported CHECKED in `content`. */
export function collectCheckedChecklistCountsV1(
  content: string
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of itemsInLatestRendering(content)) {
    if (item.checked) {
      const key = normalizeChecklistItemTextV1(item.text);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Count plain `item — done — evidence` claims in the latest round checklist. */
export function collectPlainDoneChecklistCountsV1(content: string): ReadonlyMap<string, number> {
  const headings = [...content.matchAll(/^#{1,6}\s+Plan Item Checklist\s*$/gim)];
  const heading = headings.at(-1);
  if (!heading || heading.index === undefined) return new Map();
  const start = heading.index + heading[0].length;
  const nextHeading = /^#{1,6}\s+.+$/gm;
  nextHeading.lastIndex = start;
  const end = nextHeading.exec(content)?.index ?? content.length;
  const counts = new Map<string, number>();
  for (const line of content.slice(start, end).split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+(.+?)\s+—\s*done(?:\s+—|\s*$)/i.exec(line);
    if (!match?.[1]) continue;
    const key = normalizeChecklistItemTextV1(match[1]);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface ImplementationReportClaimAccountingV1 {
  readonly claimed: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly newlyRecorded: number;
}

/** Compare a correction's new done claims with the plan and resulting merge. */
export function accountImplementationReportCorrectionClaimsV1(
  planOfRecord: string,
  correctedReport: string,
  mergedPlan?: string
): ImplementationReportClaimAccountingV1 {
  const planKeys = collectChecklistItemKeysV1(planOfRecord);
  const priorCounts = collectCheckedChecklistCountsV1(planOfRecord);
  const reportedCounts = new Map(collectCheckedChecklistCountsV1(correctedReport));
  for (const [key, count] of collectPlainDoneChecklistCountsV1(correctedReport)) {
    reportedCounts.set(key, Math.max(reportedCounts.get(key) ?? 0, count));
  }
  let claimed = 0;
  let matched = 0;
  let unmatched = 0;
  for (const [key, count] of reportedCounts) {
    const newlyClaimed = Math.max(0, count - (priorCounts.get(key) ?? 0));
    if (newlyClaimed === 0) continue;
    claimed += newlyClaimed;
    if (planKeys.has(key)) matched += newlyClaimed;
    else unmatched += newlyClaimed;
  }
  let newlyRecorded = 0;
  if (mergedPlan !== undefined) {
    const mergedCounts = collectCheckedChecklistCountsV1(mergedPlan);
    for (const [key, count] of mergedCounts) {
      newlyRecorded += Math.max(0, count - (priorCounts.get(key) ?? 0));
    }
  }
  return { claimed, matched, unmatched, newlyRecorded };
}

/** Result of {@link listUncheckedChecklistItemTextsV1}: a bounded preview plus the true total, so a caller can say "and N more" honestly. */
export interface UncheckedChecklistItemsV1 {
  /** Outstanding item texts, in document order, truncated to the requested limit. */
  readonly items: readonly string[];
  /** The true count of outstanding items — may exceed `items.length`. */
  readonly total: number;
}

/**
 * Truncates a single checklist item's display text to its first line, then to
 * `maxChars`, appending an ellipsis when either cut discards content (wf
 * "make the stage chat a record of work" item 16 — the reconcile panel's
 * evidence block once inlined whole multi-paragraph annotated items,
 * pushing a decision card's real options below the fold). The full text
 * always remains on disk in `plan-final.md`; this only bounds what a decision
 * card or notification excerpts.
 */
export function truncateChecklistItemTextV1(text: string, maxChars: number): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const lineTruncated = firstLine.length < text.length;
  if (firstLine.length <= maxChars) {
    return lineTruncated ? `${firstLine}…` : firstLine;
  }
  return `${firstLine.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Plan-item texts whose box is currently UNCHECKED in `planOfRecord`'s latest
 * rendering, in document order, unescaped for display and bounded to `limit`.
 *
 * Items carrying `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` are never included —
 * they never hold the completeness gate open, so naming them as "outstanding"
 * to an operator would misdescribe what is actually blocking advancement.
 *
 * Used everywhere a human is told to "tick the missed items in plan-final.md"
 * — the breaker escalation, the reconciliation run-log/notification, and the
 * task-tree tooltip — so that instruction names the items instead of leaving
 * the reader to search a plan they may not have open (workflow 3 continuation
 * plan, Part 5).
 *
 * `maxItemChars`, when given, caps each returned item to its first line and
 * to that many characters via {@link truncateChecklistItemTextV1} (item 16's
 * evidence-block fix). Omitted by default so existing callers that rely on
 * full item text (lexical matching, single-item lookups) are unaffected.
 */
export function listUncheckedChecklistItemTextsV1(
  planOfRecord: string,
  limit: number = 10,
  options?: { readonly maxItemChars?: number }
): UncheckedChecklistItemsV1 {
  const outstanding = itemsInLatestRendering(planOfRecord).filter(
    (item) => !item.excluded && !item.checked
  );
  const maxItemChars = options?.maxItemChars;
  return {
    items: outstanding.slice(0, limit).map((item) => {
      const text = unescapeChecklistItemTextV1(item.text);
      return maxItemChars !== undefined ? truncateChecklistItemTextV1(text, maxItemChars) : text;
    }),
    total: outstanding.length,
  };
}

/**
 * Checked plan items whose acceptance explicitly depends on tests and whose
 * latest accepted editing-round report does not provide a matching passing
 * test record. Keep those items visible as provisional so an editing round
 * can supply the evidence instead of treating an unexplained tick as settled.
 * The later provenance step will retain this association across subsequent
 * reports and bind it to durable source-state evidence.
 */
export function listProvisionalTestDependentChecklistItemsV1(
  planOfRecord: string,
  editingRoundReport?: string
): readonly string[] {
  return itemsInLatestRendering(planOfRecord)
    .filter((item) => {
      if (item.excluded || !item.checked) return false;
      return isTestDependentChecklistItemV1(item.text) &&
        !hasApplicablePassingTestReportForItemV1(planOfRecord, item.text, editingRoundReport ?? "");
    })
    .map((item) => unescapeChecklistItemTextV1(item.text));
}

/**
 * Text that mentions tests without requiring any (bugs4 item 11):
 *  - a path or file name (`src/test/x.ts`, `processor.close-account.test.ts`),
 *    which only says where something lives;
 *  - tests named as a place to search or a scope to check ("including tests",
 *    "plus any test found");
 *  - a statement that no test work is needed ("no test changes needed",
 *    "without tests").
 * Removed before the requirement check below.
 */
const NON_REQUIREMENT_TEST_MENTIONS_V1: readonly RegExp[] = [
  /\S*(?:\/|\.(?:test|spec)\.)\S*/gi,
  /\b(?:including|incl\.?|plus(?:\s+any)?)\s+(?:(?:any|all|the)\s+)?(?:unit\s+|existing\s+)?tests?(?:\s+(?:files?|directories|dirs?|folders?|found))?\b/gi,
  /\bno\s+(?:new\s+|further\s+)?tests?(?:\s+(?:changes?|updates?|edits?|files?|additions?))?(?:\s+(?:are\s+)?(?:needed|required|necessary|changed))?\b/gi,
  /\bwithout\s+(?:any\s+)?tests?\b/gi,
  /\b(?:not|never)\s+(?:need|require)s?\s+(?:any\s+)?tests?\b/gi,
];

/** A requirement clause starts the item or follows sentence punctuation or a conjunction. */
const TEST_REQUIREMENT_LEAD_V1 = String.raw`(?:^|[.;:,(]\s*|\b(?:and|then|also|plus)\s+)`;
/** Up to four filler words (articles, adjectives, "parser table") between a verb and its noun. */
const TEST_REQUIREMENT_GAP_V1 = String.raw`(?:\s+[^\s,.;:()\`]+){0,4}?\s+`;
const TEST_NOUN_V1 = String.raw`(?:tests?(?:\s+(?:cases?|suites?|files?))?|regression(?:\s+(?:tests?|cases?|suites?))?|specs?|fixtures?)(?![-\w])`;

/**
 * What an item has to ask for to be test-dependent: a verb that makes tests,
 * running them, tests that must pass, or coverage. Descriptive uses of the noun
 * ("test evidence", "test report", "failed tests", "test-dependent") are not
 * requirements and match none of these.
 */
const TEST_REQUIREMENT_PATTERNS_V1: readonly RegExp[] = [
  // "Add a parser table test", "Update any test that asserts…", "Add fixtures for…"
  new RegExp(
    `${TEST_REQUIREMENT_LEAD_V1}(?:add|write|create|update|extend|author|introduce|include|fix|adjust|rewrite|regenerate|refresh|expand)s?` +
      `${TEST_REQUIREMENT_GAP_V1}${TEST_NOUN_V1}`,
    "i"
  ),
  // "Run the tests", "Execute the unit test suite"
  new RegExp(
    `${TEST_REQUIREMENT_LEAD_V1}(?:re-?run|run|execute)s?${TEST_REQUIREMENT_GAP_V1.replace("{0,4}?", "{0,2}?")}${TEST_NOUN_V1}`,
    "i"
  ),
  // "Commit the captured response as a test fixture": a test fixture is itself test work.
  /\btest\s+fixtures?\b/i,
  // "All unit tests pass after the change."
  new RegExp(
    String.raw`\b(?:all|every|existing|those|these)\s+(?:[^\s,.;:()]+\s+){0,2}tests?\s+(?:still\s+|must\s+|should\s+)?(?:pass|passes|are\s+green|succeed)\b`,
    "i"
  ),
  // "(coverage must not drop)", "raise coverage", "test coverage target"
  /\b(?:increase|improve|raise|maintain|keep|preserve)\s+(?:the\s+)?(?:test\s+)?coverage\b|\bcoverage\s+(?:must|should|target|threshold|gate|drop|report)\b|\btest\s+coverage\b/i,
];

/** "Run `pnpm run test:unit -- …`": the command is a backticked span, so read it before paths are stripped. */
const RUN_TEST_COMMAND_V1 = new RegExp(
  `${TEST_REQUIREMENT_LEAD_V1}(?:re-?run|run|execute)s?\\s+\`[^\`]*\\b(?:test|tests|vitest|jest|mocha)\\b[^\`]*\``,
  "i"
);

/**
 * An item is test-dependent only when it requires tests to be added, updated or
 * run, tests to pass, or coverage. The word "test" anywhere in the text is not
 * enough, and anything uncertain is left not test-dependent so the reviewer's
 * evidence or the owner can settle it (bugs4 item 11).
 */
export function isTestDependentChecklistItemV1(itemText: string): boolean {
  if (RUN_TEST_COMMAND_V1.test(itemText)) return true;
  let remaining = itemText;
  for (const pattern of NON_REQUIREMENT_TEST_MENTIONS_V1) {
    remaining = remaining.replace(pattern, " ");
  }
  return TEST_REQUIREMENT_PATTERNS_V1.some((pattern) => pattern.test(remaining));
}

/**
 * A checked test-dependent item is no longer provisional only when its
 * latest editing-round report ties that exact plan item and its named test
 * evidence to an actual passing command, and says the report describes the
 * post-edit source state. This is
 * deliberately a narrow report contract; it is a prompt/claim qualification
 * bridge until the later per-item provenance store is implemented.
 */
export interface ApplicablePlanItemTestReportV1 {
  readonly testIdentity: string;
  readonly command: string;
  readonly workingDirectory?: string;
  readonly passed: number;
  readonly failed: number;
  readonly sourceState: string;
}

/** Why an editing round's report does or does not count as a passing test report for one item (bugs4 item 21). */
export type TestReportDiagnosisV1 =
  | { readonly kind: "applicable"; readonly report: ApplicablePlanItemTestReportV1 }
  | { readonly kind: "not-applicable"; readonly reason: string };

const TEST_FILE_TOKEN_V1 = /[\w@.\-/\\]+?\.(?:test|spec)\.(?:[cm]?[jt]sx?)(?![\w-])/gi;
/**
 * A statement that the run used the edited tree. review1 Step 13: besides "post-edit source state", "post-edit
 * run", "final source" and "tree fingerprint", plain statements count: "on the working tree after the edit",
 * "the current working tree", "no source edits between runs", "the edited tree".
 */
export const POST_EDIT_STATEMENT_V1 =
  /post[- ]edit(?:\s+(?:source(?:\s+state)?|tree|state|run|working\s+tree))?|final\s+(?:post-edit\s+)?(?:source|tree)|tree[- ]fingerprint|(?:working\s+)?tree\s+after\s+(?:the|this\s+round'?s?|my)\s+edits?|after\s+(?:the|this\s+round'?s?|my)\s+(?:last\s+)?edits?\b|(?:the\s+)?current\s+working\s+tree|no\s+(?:source\s+)?(?:edits?|changes?)\s+(?:were\s+made\s+)?between\s+(?:the\s+)?runs?|(?:the\s+)?edited\s+(?:working\s+)?(?:tree|source)/i;
/**
 * A statement that the tests ran BEFORE this round's edits. A report is post-edit unless it says so (review1
 * Step 13): "before the edit", "prior to my changes", "pre-edit", "stale tree".
 */
export const PRE_EDIT_STATEMENT_V1 =
  /\b(?:before|prior\s+to|ahead\s+of)\s+(?:the|this\s+round'?s?|my|any)\s+(?:edits?|changes?|modifications?)\b|\bpre[- ]edit\b|\bstale\s+(?:tree|source|build)\b/i;
/** The state recorded for a report that does not say either way: post-edit by default. */
export const ASSUMED_POST_EDIT_SOURCE_STATE_V1 =
  "post-edit source state (assumed: the report does not say the tests ran before the edits)";
/** A listed file the round says it did not run is not covered by the command above it. */
const NOT_RUN_LINE_V1 = /\bnot\s+run\b|\bskipp|\bcould\s+not\b|\brefused\b/i;

function normalizeTestPathTokenV1(token: string): string {
  return token
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^[([{'"`]+|[)\]}'"`,;]+$/g, "");
}

/** `src/test/X.test.ts` and the compiled `out/test/X.test.js` are one test: compare by directory-free stem. */
function testStemV1(token: string): string {
  const normalized = normalizeTestPathTokenV1(token);
  return (normalized.split("/").pop() ?? normalized).replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function recordCoversTestV1(commandTokens: readonly string[], evidencePath: string): boolean {
  const wanted = normalizeTestPathTokenV1(evidencePath);
  const wantedStem = testStemV1(wanted);
  return commandTokens.some((raw) => {
    const token = normalizeTestPathTokenV1(raw);
    if (!token) return false;
    if (token === wanted) return true;
    const last = token.split("/").pop() ?? token;
    if (/\.[a-z]+$/.test(last)) return wantedStem.length > 0 && testStemV1(token) === wantedStem;
    // A directory the runner was pointed at (`vitest run src/__tests__/`) covers the tests under it.
    // Only path-shaped tokens count: a bare word such as `test` must not cover every test file.
    const dir = token.replace(/\/+$/, "");
    return dir.includes("/") && (wanted.startsWith(`${dir}/`) || wanted.includes(`/${dir}/`));
  });
}

/**
 * Whether a stored test report's command still covers the test identity it was recorded
 * against (bugs4 item 21). A bare test file is covered the way the report parser covers it: the
 * same path, the same file as its compiled `.js` counterpart, or a directory the runner was
 * pointed at. Any other identity is a command or the item's evidence text, which the report
 * parser tied to this command when it accepted the report, so there is no file to re-check; the
 * narrower basename-only check this replaces rejected every such report at apply time.
 */
export function reportCommandCoversTestIdentityV1(command: string, testIdentity: string): boolean {
  const identity = testIdentity.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const bareTestFile = !/\s/.test(identity) && /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(identity);
  if (!bareTestFile) return true;
  return recordCoversTestV1(command.split(/[\s'"`;=,]+/), identity);
}

function countsInRecordV1(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1] ?? match[2]));
}

/**
 * Decides whether an editing round's report counts as a passing test report for a
 * checked test-dependent item, and says why not when it does not (bugs4 item 21).
 * Accepted: one command run over several listed files, or over directories;
 * evidence naming several test files with prose around them; a source `.ts` test and
 * its compiled `.js` counterpart as the same test; evidence that points at a command
 * listed under Verification; and any clear statement that the run used the edited tree.
 * Never accepted: a command that names none of the item's tests, a failing run, or
 * prose that merely mentions a file.
 */
export function diagnoseApplicablePassingTestReportForItemV1(
  planOfRecord: string,
  itemText: string,
  editingRoundReport: string
): TestReportDiagnosisV1 {
  const no = (reason: string): TestReportDiagnosisV1 => ({ kind: "not-applicable", reason });
  if (!editingRoundReport) return no("the round left no report");
  if (!isTestDependentChecklistItemV1(itemText)) return no("the item is not test-dependent");
  const wanted = normalizeChecklistItemTextV1(itemText);
  const planItemKeys = collectChecklistItemKeysV1(planOfRecord);
  const { own } = splitSummaryAtEchoV1(editingRoundReport, planOfRecord);
  const all = headingsV1(own);
  // review1 Step 14: a reason is never false. A section missing from the round's own text may still exist inside
  // the block read as the echoed plan, and the reason then says that, and what to change.
  const missingSectionReason = (name: string): string => {
    const existsElsewhere = findLastHeadingV1(headingsV1(editingRoundReport), name) >= 0;
    return existsElsewhere
      ? `the report's \`## ${name}\` section sits inside the block that reproduces the plan's checklist, so it was read as part of the plan; move it below that block`
      : `the report has no \`## ${name}\` section (add one ${name === "Plan Item Checklist" ? "with an entry `<item text> — done — <test file or command>` for this item" : "that lists each test command in backticks with its passed and failed counts"})`;
  };
  const checklistAt = findLastHeadingV1(all, "Plan Item Checklist");
  const checklistHeading = checklistAt < 0 ? undefined : all[checklistAt];
  if (!checklistHeading) return no(missingSectionReason("Plan Item Checklist"));
  const lines = walkLinesV1(own);
  let checklistEnd = lines.length;
  for (let i = checklistAt + 1; i < all.length; i++) {
    const heading = all[i];
    if (heading && heading.level <= checklistHeading.level) {
      checklistEnd = heading.line;
      break;
    }
  }
  let itemClaimEvidence = "";
  let claimedDone = false;
  for (let i = checklistHeading.line + 1; i < checklistEnd; i++) {
    const line = lines[i];
    if (!line || line.fenced) continue;
    // review2: a report line that names its item by `[item:<id>]` (the form the ordered open-items list asks for)
    // counts for the item that id issues, never for another item and never by the line's own wording.
    const idPrefix = /^([ \t]*[-*][ \t]+)\[?item:([0-9a-f]{16})\]?/i.exec(line.text);
    let lineText = line.text;
    let idItemText: string | undefined;
    if (idPrefix) {
      const issued = listPlanItemIdsV1(planOfRecord).find((entry) => entry.itemId === idPrefix[2]!.toLowerCase());
      if (!issued || normalizeChecklistItemTextV1(issued.itemText) !== wanted) continue;
      idItemText = issued.itemText;
      const rest = line.text.slice(idPrefix[0].length).trim();
      lineText = rest.startsWith("—") ? `${idPrefix[1]}${issued.itemText} ${rest}` : `${idPrefix[1]}${rest}`;
    }
    const parsedLine = parsePlanItemChecklistLine(lineText, planItemKeys);
    const parsed = parsedLine && idItemText !== undefined ? { ...parsedLine, itemText: idItemText } : parsedLine;
    if (parsed && parsed.status.toLowerCase().startsWith("done") &&
        normalizeChecklistItemTextV1(parsed.itemText) === wanted) {
      // review1 Step 14: the test files an entry lists in bullets nested under it ("— done — these tests exist and pass
      // in the command below:" then one file per sub-bullet, as chat1's runs/029, 033 and 037 wrote it) are part of
      // that entry's evidence. Without them the entry named no test file and every such report was rejected.
      const claimIndent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      const nested: string[] = [];
      for (let j = i + 1; j < checklistEnd; j++) {
        const next = lines[j];
        if (!next || next.fenced || next.text.trim() === "") break;
        if ((/^\s*/.exec(next.text)?.[0].length ?? 0) <= claimIndent) break;
        nested.push(next.text.trim().replace(/^[-*+]\s+/, ""));
      }
      itemClaimEvidence = [parsed.evidence, ...nested].join(" ").trim();
      claimedDone = true;
      break;
    }
  }
  if (!claimedDone) {
    return no("the round did not claim this item done in its `## Plan Item Checklist` (add `<exact item text> — done — <test file or command>`)");
  }
  // A backticked span with a space is a command; a single token is a file or test name.
  const evidenceCommands = [...itemClaimEvidence.matchAll(/`([^`]+)`/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter((span) => /\s/.test(span));
  const evidenceNamesTests = /\btests?\b|\.(?:test|spec)\.|\bvitest\b|\bjest\b/i.test(itemClaimEvidence);
  if (!itemClaimEvidence || (!evidenceNamesTests && evidenceCommands.length === 0)) {
    return no("the item's evidence names no test file, test name or command (name the test file, for example `foo.test.ts`, or the command in backticks)");
  }
  const evidenceKey = itemClaimEvidence
    .replace(/^\s*test(?:\s+evidence)?\s*[:=]\s*/i, "")
    .trim()
    .toLowerCase();
  if (!evidenceKey) return no("the item's evidence names no test file, test name or command (name the test file, for example `foo.test.ts`, or the command in backticks)");

  const verificationAt = findLastHeadingV1(all, "Verification");
  const verificationHeading = verificationAt < 0 ? undefined : all[verificationAt];
  if (!verificationHeading) return no(missingSectionReason("Verification"));
  let verificationEnd = lines.length;
  for (let i = verificationAt + 1; i < all.length; i++) {
    const heading = all[i];
    if (heading && heading.level <= verificationHeading.level) {
      verificationEnd = heading.line;
      break;
    }
  }
  const verificationLines = lines
    .slice(verificationHeading.line + 1, verificationEnd)
    .filter((line) => line && !line.fenced);
  // review1 Step 13: a report counts as post-edit unless it says the tests ran before the edits.
  const explicitStatementLine = verificationLines.find((line) => POST_EDIT_STATEMENT_V1.test(line.text));
  const preEditLine = explicitStatementLine ? undefined : verificationLines.find((line) => PRE_EDIT_STATEMENT_V1.test(line.text));
  if (preEditLine) {
    return no(
      `the Verification section says the tests ran before this round's edits (“${preEditLine.text.trim().slice(0, 100)}”); run them again after the edits and say so`
    );
  }
  const statementLine = explicitStatementLine ?? { text: ASSUMED_POST_EDIT_SOURCE_STATE_V1 };

  // A Markdown list item and its more-deeply indented continuation lines are one
  // record: the command, any files listed under it, and its counts. A sibling
  // record's prose can never lend its filename or pass counts to another command.
  const indentOf = (text: string): number => /^\s*/.exec(text)?.[0].length ?? 0;
  interface VerificationRecordV1 {
    readonly command: string;
    readonly commandTokens: string[];
    readonly text: string;
  }
  const records: VerificationRecordV1[] = [];
  for (let i = 0; i < verificationLines.length; i++) {
    const line = verificationLines[i];
    if (!line) continue;
    const command = /`([^`]+)`/.exec(line.text)?.[1];
    if (!command) continue;
    const baseIndent = indentOf(line.text);
    const recordLines = [line.text];
    const listed: string[] = [];
    for (let j = i + 1; j < verificationLines.length; j++) {
      const next = verificationLines[j];
      if (!next) continue;
      if (/^\s*[-*+]\s+/.test(next.text) && indentOf(next.text) <= baseIndent) break;
      recordLines.push(next.text);
      if (!NOT_RUN_LINE_V1.test(next.text)) listed.push(next.text);
    }
    records.push({
      command,
      commandTokens: [command, ...listed].join(" ").split(/[\s'"`;=,]+/),
      text: recordLines.join(" "),
    });
  }
  if (records.length === 0) {
    return no("the Verification section lists no backticked command (put each test command in backticks, with its passed and failed counts)");
  }

  const build = (record: VerificationRecordV1, identity: string): ApplicablePlanItemTestReportV1 | undefined => {
    const passes = countsInRecordV1(record.text, /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b|\bpass(?:ed)?\s*[:=]?\s*(\d+)/gi);
    const fails = countsInRecordV1(record.text, /(\d+)\s+fail(?:ed|ures?|ing)?\b|\bfail(?:ed|ures?)?\s*[:=]?\s*(\d+)/gi);
    if (passes.length === 0 || fails.length === 0 || fails.some((n) => n !== 0)) return undefined;
    const workingDirectory = /(?:working directory|cwd)\s*[:=]\s*`?([^`\n]+)`?/i.exec(record.text)?.[1]?.trim();
    return {
      testIdentity: identity,
      command: record.command,
      ...(workingDirectory ? { workingDirectory } : {}),
      passed: passes[0] ?? 0,
      failed: 0,
      sourceState: statementLine.text.slice(0, 1000),
    };
  };

  // Evidence that points at a command listed under Verification.
  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  for (const evidenceCommand of evidenceCommands) {
    const wantedCommand = collapse(evidenceCommand);
    const record = records.find((r) => {
      const have = collapse(r.command);
      return have === wantedCommand || have.includes(wantedCommand) || wantedCommand.includes(have);
    });
    const report = record ? build(record, wantedCommand) : undefined;
    if (report) return { kind: "applicable", report };
  }

  // Evidence naming one or several test files, with prose around them: every
  // named file must be covered by a passing command.
  const named = [...new Set((itemClaimEvidence.match(TEST_FILE_TOKEN_V1) ?? []).map(normalizeTestPathTokenV1))];
  const targets = named.length > 0 ? named : [evidenceKey.replace(/\\/g, "/").replace(/^\.\//, "")];
  let firstReport: ApplicablePlanItemTestReportV1 | undefined;
  for (const target of targets) {
    const covering = records.filter((r) => recordCoversTestV1(r.commandTokens, target));
    if (covering.length === 0) {
      return no(`no Verification command names ${named.length > 0 ? `\`${target}\`` : `“${evidenceKey.slice(0, 80)}”`}`);
    }
    const report = covering.map((r) => build(r, evidenceKey)).find((r): r is ApplicablePlanItemTestReportV1 => r !== undefined);
    if (!report) {
      return no(`the command covering \`${target}\` did not report “N passed” and “0 failed” (state both counts next to the command)`);
    }
    firstReport ??= report;
  }
  return firstReport ? { kind: "applicable", report: firstReport } : no("no Verification command matched the item's evidence");
}

/**
 * Test-dependent items the round claimed done whose report did not count as a
 * passing test report, each with the reason. An item the round never claimed is
 * not listed: that is a missing claim, not a report that failed to parse.
 */
export function listUncountedTestReportClaimsV1(
  planOfRecord: string,
  editingRoundReport: string
): ReadonlyArray<{ readonly itemText: string; readonly reason: string }> {
  const uncounted: Array<{ itemText: string; reason: string }> = [];
  const candidates = itemsInLatestRendering(planOfRecord)
    .filter((item) => !item.excluded && isTestDependentChecklistItemV1(item.text))
    .map((item) => unescapeChecklistItemTextV1(item.text));
  for (const itemText of candidates) {
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(planOfRecord, itemText, editingRoundReport);
    if (diagnosis.kind === "applicable") continue;
    if (/did not claim this item done|left no report/.test(diagnosis.reason)) continue;
    uncounted.push({ itemText, reason: diagnosis.reason });
  }
  return uncounted;
}

/** The run-log section that tells the owner why a claimed test-dependent item was not verified (bugs4 item 21). */
export function formatUncountedTestReportClaimsSectionV1(
  uncounted: ReadonlyArray<{ readonly itemText: string; readonly reason: string }>
): string {
  if (uncounted.length === 0) return "";
  return (
    "\n\n## Test reports that did not count\n\n" +
    "These items were claimed done by the round, but their test evidence did not count as a passing " +
    "report for the post-edit tree, so they stay provisional:\n\n" +
    uncounted.map((entry) => `- ${entry.itemText} — ${entry.reason}`).join("\n") +
    "\n"
  );
}

export function getApplicablePassingTestReportForItemV1(
  planOfRecord: string,
  itemText: string,
  editingRoundReport: string
): ApplicablePlanItemTestReportV1 | undefined {
  const diagnosis = diagnoseApplicablePassingTestReportForItemV1(planOfRecord, itemText, editingRoundReport);
  return diagnosis.kind === "applicable" ? diagnosis.report : undefined;
}

export function hasApplicablePassingTestReportForItemV1(
  planOfRecord: string,
  itemText: string,
  editingRoundReport: string
): boolean {
  return getApplicablePassingTestReportForItemV1(planOfRecord, itemText, editingRoundReport) !== undefined;
}

/** Ordered, untruncated authority for what an editing round may claim as open plan work. */
export function formatOpenPlanItemsForRoundV1(planOfRecord: string, editingRoundReport?: string): string {
  const parsedItems = itemsInLatestRendering(planOfRecord).filter((item) => !item.excluded);
  const provisionalTestItems = new Set(listProvisionalTestDependentChecklistItemsV1(planOfRecord, editingRoundReport));
  // review1 Step 9: every item carries an occurrence-aware id a round may use instead of quoting the text.
  const idsByText = new Map<string, string[]>();
  for (const entry of listPlanItemIdsV1(planOfRecord)) {
    const bucket = idsByText.get(`${entry.nested ? "n" : "t"}${entry.itemText}`) ?? [];
    bucket.push(entry.itemId);
    idsByText.set(`${entry.nested ? "n" : "t"}${entry.itemText}`, bucket);
  }
  const takenIds = new Map<string, number>();
  const idOf = (text: string, nested: boolean): string => {
    const key = `${nested ? "n" : "t"}${text}`;
    const used = takenIds.get(key) ?? 0;
    takenIds.set(key, used + 1);
    return idsByText.get(key)?.[used] ?? "";
  };
  type OpenListedItem = { text: string; provisional: boolean; id: string; children: { text: string; id: string }[]; heldOpen?: boolean };
  const items: OpenListedItem[] = [];
  let current: OpenListedItem | undefined;
  let lastTopLevel: { text: string; id: string } | undefined;
  for (const item of parsedItems) {
    const text = unescapeChecklistItemTextV1(item.text);
    const id = idOf(text, item.nested);
    if (item.nested) {
      // An open nested child holds its parent open; list it under the parent it belongs to, even when the
      // parent's own box is ticked (the parent is then listed as held open by its child).
      if (!item.checked) {
        if (!current && lastTopLevel) {
          current = { text: lastTopLevel.text, provisional: false, id: lastTopLevel.id, children: [], heldOpen: true };
          items.push(current);
        }
        current?.children.push({ text, id });
      }
      continue;
    }
    lastTopLevel = { text, id };
    if (!item.checked || provisionalTestItems.has(text)) {
      current = { text, provisional: item.checked, id, children: [] };
      items.push(current);
    } else {
      current = undefined;
    }
  }
  if (items.length === 0) {
    return "The plan of record has no unchecked, non-excluded top-level checklist items.";
  }
  const hasProvisionalItems = items.some((item) => item.provisional);
  return [
    "This is the only ordered list of open plan items eligible for completion claims in this round. The item text and embedded identifiers are copied from the plan of record in its original order. Start with item 1. Do not invent, renumber, combine, paraphrase, or claim an item that is absent from this list.",
    "Each item also carries an id like [item:0123456789abcdef]. In `## Plan Item Checklist` you may name an item by that id (for example `item:0123456789abcdef — done — <evidence>`) instead of quoting its text.",
    ...(hasProvisionalItems
      ? [
          "A checked item marked PROVISIONAL is not verified: no applicable test report is associated with that item. Keep it open until an Implementation or Apply Review report names the test file or test name in that item's checklist evidence and reports a matching command, passed and failed counts, and the post-edit source state tested.",
        ]
      : []),
    ...items.flatMap((item, index) => [
      `${index + 1}. [item:${item.id}] ${item.provisional ? "[PROVISIONAL — evidence missing] " : ""}${item.heldOpen ? "[ticked, held open by an open nested item] " : ""}${item.text}`,
      ...item.children.map((child) => `   - [item:${child.id}] (nested, open) ${child.text}`),
    ]),
    `First item to work on: ${items[0]?.text}`,
  ].join("\n");
}

/**
 * Plan-item texts whose box is currently CHECKED in `planOfRecord`'s latest
 * rendering, in document order, unescaped for display — the mirror of
 * {@link listUncheckedChecklistItemTextsV1}, minus excluded items (which are
 * neither "checked" nor a revision's concern either way).
 *
 * Used by {@link formatPlanRevisionProposalVariableV1} so a plan revision's
 * `{{planRevisionProposal}}` prompt variable can tell the model exactly which
 * items are already done and must not be renumbered or dropped (wf "make the
 * stage chat a record of work" Part 6 / item 6).
 */
export function listCheckedChecklistItemTextsV1(planOfRecord: string): readonly string[] {
  return itemsInLatestRendering(planOfRecord)
    .filter((item) => !item.excluded && item.checked)
    .map((item) => unescapeChecklistItemTextV1(item.text));
}

/**
 * Render an in-flight `TaskProgress.planRevision` as the `{{planRevisionProposal}}`
 * plan-generation prompt variable (wf "make the stage chat a record of work"
 * Part 6 / item 6). Always returns non-empty text — a plan generated with no
 * revision in flight states that explicitly, the same discipline
 * `formatAcceptedNonGoalsVariableV1` uses for the review-side equivalent —
 * rather than leaving a silently-empty section in the rendered prompt.
 *
 * `alreadyCheckedItems` — the CURRENT `plan-final.md`'s checked item texts —
 * are listed so the revision incorporates the discovered items without
 * renumbering or dropping any of them (item 6's explicit requirement); pass
 * an empty array when no prior canonical plan exists to read from.
 */
export function formatPlanRevisionProposalVariableV1(
  planRevision: { readonly reason: string; readonly discardedItems: readonly string[]; readonly removedItems: readonly string[] } | undefined,
  alreadyCheckedItems: readonly string[]
): string {
  if (planRevision === undefined) {
    return "_No plan revision is in flight — this is an ordinary plan generation._";
  }
  const sections: string[] = [
    `A round's edit to plan-final.md tried to change the checklist item set. A round never mutates the ` +
      `checklist — the change was reverted, and now needs to be incorporated deliberately, through this plan ` +
      `revision, instead.\n\nReason: ${planRevision.reason}`,
  ];
  if (planRevision.discardedItems.length > 0) {
    sections.push(
      `Proposed additions the round attempted (discarded, now yours to evaluate and incorporate if warranted):\n` +
        planRevision.discardedItems.map((item) => `- ${item}`).join("\n")
    );
  }
  if (planRevision.removedItems.length > 0) {
    sections.push(
      `Items the round's edit tried to drop (restored — do not drop these again without an explicit reason):\n` +
        planRevision.removedItems.map((item) => `- ${item}`).join("\n")
    );
  }
  sections.push(
    alreadyCheckedItems.length > 0
      ? `Items already checked in the plan of record — a rule this plan MUST follow: never renumber, reword, or ` +
        `drop any of these; each must appear in the revised plan exactly as listed below, still checked:\n` +
        alreadyCheckedItems.map((item) => `- ${item}`).join("\n")
      : "No items are currently checked in the plan of record."
  );
  return sections.join("\n\n");
}

/**
 * The priority an item's own authored text declares for field 5 of the
 * shared hand-off contract (`HandoffImpactV1`'s `"priority"` kind, task
 * "Actionable Hand-offs", PART 2) — HIGH when a failure here would be silent
 * or damaging, LOW when it would be loud and recoverable. `undefined` when
 * the text carries no such marker at all, which is the expected shape for
 * every plan written before this contract existed: those items must sort and
 * render exactly as they did before, never inferred into a priority they
 * never declared.
 */
export type ChecklistItemPriorityV1 = "high" | "low";

/**
 * Matches the literal rendering `renderHandoffFieldLineV1` produces for a
 * `manualVerificationItem`'s "impact" field — `"Priority: HIGH — <cost of
 * failure>"` (see `formatFieldValueV1` in `handoffGuidanceV1.ts`) — so the
 * checklist-authoring prompts and this parser share one vocabulary instead of
 * each inventing their own marker syntax. Case-insensitive because the prompt
 * asks the model to write the label, not a fixed machine token.
 */
const CHECKLIST_ITEM_PRIORITY_PATTERN = /priority:\s*(high|low)\b/i;

/** Parses the priority a checklist item's own text declares, or `undefined`
 * when it declares none — see {@link ChecklistItemPriorityV1}. */
export function parseChecklistItemPriorityV1(itemText: string): ChecklistItemPriorityV1 | undefined {
  const match = CHECKLIST_ITEM_PRIORITY_PATTERN.exec(itemText);
  return match?.[1] ? (match[1].toLowerCase() as ChecklistItemPriorityV1) : undefined;
}

/**
 * Parses the leading `N.` step number an ordinary (non-hand-off) checklist
 * item's own text declares — e.g. `"26. Build a shared evidence-…"` -> `26`,
 * matching how this codebase's plans number their own steps (see
 * `create-plan.md`'s "Numbered implementation steps"). `undefined` for a
 * hand-off item (which numbers itself `"H1."`, `"H2."`, …, never a bare
 * digit) or an older plan whose items carry no number at all.
 */
export function parseChecklistItemStepNumberV1(itemText: string): number | undefined {
  const match = /^(\d+)\.\s/.exec(itemText.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Review-flagged (2026-08-25, third narrowing of task-fixable blocker
 * `57e9485f-…-0`): the plan format carries no structural link between a
 * checklist item and the specific manual-verification hand-off item(s) that
 * cover it — both live under one shared "## Manual verification"-style
 * heading, so `buildSoleBlockerReconcileGuidanceV1`
 * (`reconcilePlanChecklist.ts`) could only ever confirm a per-item
 * association in the trivial case (exactly one outstanding manual item in
 * the whole plan), and had to pool the entire outstanding set otherwise —
 * which the review correctly rejected as "a plan-wide list accompanied by
 * 'do whichever apply'" rather than the relevant item's own checks. A
 * lexical-overlap filter cannot close this gap either (the function's own
 * prior doc comment records a case where a HIGH check shares no vocabulary
 * at all with its blocker's description), so no amount of TEXT ANALYSIS of
 * the two independently-authored items can establish the link.
 *
 * `Covers: Step N[, Step M, …]` is the structural fix: an OPTIONAL,
 * author-written cross-reference on a hand-off item's own line, naming the
 * numbered checklist step(s) (see {@link parseChecklistItemStepNumberV1}) it
 * specifically verifies. Purely additive — a plan authored before this
 * convention existed (every plan on disk as of this fix, including the one
 * that produced this fix) has zero matches and falls back to the existing
 * pooled/pigeonhole behavior unchanged; only a plan whose hand-off items
 * declare it gets a real, sound, non-lexical association. `create-plan.md`
 * instructs future plans to include it when a hand-off item maps to exactly
 * one specific step.
 */
const CHECKLIST_ITEM_COVERS_PATTERN = /covers:\s*steps?\s*((?:\d+\s*(?:,\s*(?:step\s*)?\d+\s*)*))/i;

/** Parses the checklist step number(s) a manual-verification item's own text
 * declares it covers (via `Covers: Step N[, Step M, …]`), or `undefined` when
 * it declares none — see the doc comment above. */
export function parseChecklistItemCoversV1(itemText: string): readonly number[] | undefined {
  const match = CHECKLIST_ITEM_COVERS_PATTERN.exec(itemText);
  if (!match?.[1]) {
    return undefined;
  }
  const numbers = match[1].match(/\d+/g)?.map(Number) ?? [];
  return numbers.length > 0 ? numbers : undefined;
}

/** Stable sort rank for {@link listOutstandingManualVerificationItemsV1}: HIGH
 * first, then items with no declared priority, then LOW last. Kept as one
 * rank per item (not a HIGH/LOW-only partition) specifically so a list with
 * zero markers has every item at the same rank — a stable sort over equal
 * ranks cannot reorder anything, which is what keeps an older, marker-less
 * plan rendering unchanged. */
function checklistItemPriorityRank(priority: ChecklistItemPriorityV1 | undefined): number {
  if (priority === "high") {
    return 0;
  }
  if (priority === "low") {
    return 2;
  }
  return 1;
}

/**
 * Outstanding manual-verification / human-operator steps — items carrying
 * `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` whose box is still unchecked — sorted
 * so a HIGH-priority item (per {@link parseChecklistItemPriorityV1}) always
 * renders before a LOW one, per the task's "Render the priority marker at
 * hand-off" requirement: a user deciding which of several manual checks to
 * actually do should see the ones a silent failure would hurt first, not in
 * whatever order the plan happened to list them.
 *
 * These items are deliberately excluded from
 * {@link listUncheckedChecklistItemTextsV1} (they never hold the completeness
 * gate open), so that function cannot be reused for this — a manual step is
 * "outstanding" in the everyday sense (nobody has done it yet) without ever
 * being "outstanding" in the gating sense that function reports.
 *
 * A plan with no priority markers at all sorts identically to document
 * order (stable sort over equal ranks — see
 * {@link checklistItemPriorityRank}), so this is a pure addition for older
 * plans: nothing about their rendering changes.
 */
export function listOutstandingManualVerificationItemsV1(
  planOfRecord: string,
  limit: number = 10
): UncheckedChecklistItemsV1 {
  const outstanding = itemsInLatestRendering(planOfRecord).filter(
    (item) => item.excluded && !item.checked
  );
  const sorted = outstanding
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDiff =
        checklistItemPriorityRank(parseChecklistItemPriorityV1(a.item.text)) -
        checklistItemPriorityRank(parseChecklistItemPriorityV1(b.item.text));
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ item }) => item);
  return {
    items: sorted.slice(0, limit).map((item) => unescapeChecklistItemTextV1(item.text)),
    total: sorted.length,
  };
}

/** Result of {@link appendCoversAnnotationV1}. */
export interface AppendCoversAnnotationResultV1 {
  /** The updated plan text — unchanged (`=== planOfRecord`) when `appliedCount === 0`. */
  readonly content: string;
  /** How many of `targetItemTexts` actually received a new `Covers:` annotation. */
  readonly appliedCount: number;
}

/**
 * Review-flagged (2026-08-25, FOURTH round on task-fixable blocker
 * `57e9485f-…-0`): every purely textual signal for linking a pooled manual
 * item to a specific blocker has now been tried and independently disproven —
 * stated-count matching (coincidental vocabulary), per-item lexical overlap
 * (the function's own doc comment records a HIGH check sharing no word with
 * its blocker's description), and cardinality-alone (the review's original
 * counterexample). No further heuristic is added here; inventing a fifth
 * would only repeat the pattern the last three rounds already disproved.
 *
 * What this function does instead: turn the ALREADY-SOUND `Covers: Step N`
 * mechanism ({@link parseChecklistItemCoversV1}) from something a human must
 * hand-edit into plan-final.md into a one-click, auditable action — the same
 * "prefer a confirmable edit over an implied one" principle this codebase
 * already applies to reviewer-verified ticks and stage-chat blocker
 * supersessions. It never infers which items apply; the caller supplies
 * `targetItemTexts` (the human's own confirmed selection, driven from a
 * decision panel that showed the exact items), and this only records that
 * confirmed link durably. An item whose line already carries a `Covers:`
 * annotation is left untouched (this only ever ADDS one, never overwrites or
 * duplicates), and an item text with no matching plan line is silently
 * skipped — `appliedCount` tells the caller how many actually landed.
 *
 * Byte-preserving and scoped to the latest checklist rendering only, exactly
 * like {@link mergeChecklistProgressV1} (see that function's own doc comment
 * for why): only the matched line's captured text grows an annotation: every
 * other byte — indentation, bullet style, surrounding prose, older duplicate
 * renderings — is left exactly as it was.
 */
export function appendCoversAnnotationV1(
  planOfRecord: string,
  targetItemTexts: readonly string[],
  stepNumber: number
): AppendCoversAnnotationResultV1 {
  const targetKeys = new Set(targetItemTexts.map(normalizeChecklistItemTextV1));
  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);
  let appliedCount = 0;
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          const key = normalizeChecklistItemTextV1(text);
          if (!targetKeys.has(key) || parseChecklistItemCoversV1(text) !== undefined) {
            return whole;
          }
          appliedCount += 1;
          const markerLen = trailingExcludedMarkerLengthV1(text);
          const markerIndex =
            markerLen !== undefined ? text.trimEnd().length - markerLen : -1;
          const annotated =
            markerIndex >= 0
              ? `${text.slice(0, markerIndex).trimEnd()} — Covers: Step ${stepNumber}. ${text.slice(markerIndex)}`
              : `${text} — Covers: Step ${stepNumber}.`;
          return `${open}${state}${close}${annotated}${trailing}`;
        }
      );
    })
    .join("");
  return { content: `${prefix}${mergedRegion}`, appliedCount };
}

/**
 * Of `candidateTexts` (e.g. a reviewer's `## Verified Complete` list), return
 * the plan of record's OWN item text for each candidate that currently
 * resolves to an unchecked, non-excluded item — matched the same way a
 * round's echo is matched (`normalizeChecklistItemTextV1`). A candidate
 * matching nothing, or matching an item that is already checked or excluded,
 * is silently dropped: this answers "what would a tick actually change",
 * not "validate every candidate the caller supplied".
 *
 * Returning the PLAN's own text (rather than the candidate's) matters because
 * the two can differ in escaping or incidental whitespace even when they
 * normalize to the same identity — feeding the plan's own text back into
 * {@link mergeChecklistProgressV1} keeps the claim resolution exact.
 */
export function filterUncheckedPlanItemsV1(
  planOfRecord: string,
  candidateTexts: readonly string[]
): string[] {
  const uncheckedByKey = new Map<string, string>();
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.excluded || item.checked) {
      continue;
    }
    const key = normalizeChecklistItemTextV1(item.text);
    if (!uncheckedByKey.has(key)) {
      uncheckedByKey.set(key, item.text);
    }
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidateTexts) {
    const key = normalizeChecklistItemTextV1(candidate);
    const planText = uncheckedByKey.get(key);
    if (planText !== undefined && !seen.has(key)) {
      seen.add(key);
      result.push(planText);
    }
  }
  return result;
}

/**
 * Of `candidateTexts`, return the plan of record's own item text for each
 * candidate that resolves to an ALREADY-CHECKED, non-excluded plan item —
 * the mirror image of {@link filterUncheckedPlanItemsV1}. RC2 item 8, Step 37
 * (implementation-review follow-up, 2026-09-28): distinguishes "a review
 * named this item verified complete, and the plan already shows it done"
 * from "a review named text that matches nothing real in the plan" — the
 * latter is never legitimate evidence of already-done work, so it must not
 * be counted as one. A candidate matching an unchecked item, or matching
 * nothing, is silently dropped, same as `filterUncheckedPlanItemsV1`.
 */
export function filterAlreadyCheckedPlanItemsV1(
  planOfRecord: string,
  candidateTexts: readonly string[]
): string[] {
  const checkedByKey = new Map<string, string>();
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.excluded || !item.checked) {
      continue;
    }
    const key = normalizeChecklistItemTextV1(item.text);
    if (!checkedByKey.has(key)) {
      checkedByKey.set(key, item.text);
    }
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidateTexts) {
    const key = normalizeChecklistItemTextV1(candidate);
    const planText = checkedByKey.get(key);
    if (planText !== undefined && !seen.has(key)) {
      seen.add(key);
      result.push(planText);
    }
  }
  return result;
}

/**
 * Outcome of {@link mergeChecklistProgressV1}, distinguishing the two
 * situations that both used to collapse into a plain `undefined`:
 *
 *  - `"no-report"` / `"unchanged"` — nothing to do. Either the round reported
 *    no ticked items at all (no echo, or an echo with every box unchecked),
 *    or it reported ticks that exactly match what the plan already records.
 *    Both are legitimate, silent no-ops — the caller's old `undefined`
 *    behavior.
 *  - `"no-match"` — the round DID report ticked items, but not one of them
 *    matched any item text in the plan of record's latest rendering. This is
 *    never a legitimate no-op: it means either the round echoed a corrupted
 *    or reworded copy of the checklist (a live cause: escaped-quote
 *    corruption surviving normalization, or the model paraphrasing an item),
 *    or it echoed a stale/foreign checklist entirely. Silently treating this
 *    like `"unchanged"` hid real progress from ever reaching the plan of
 *    record, indistinguishable from a round that genuinely did nothing.
 *    Carries a sample of the reported-but-unmatched item text so a caller can
 *    name what did not match.
 *  - `"merged"` — at least one box was ticked; `content` is the updated
 *    document, byte-preserving except for the flipped checkbox glyphs.
 *    `retroactiveTicks`, when present, lists the subset ticked via a
 *    {@link RETROACTIVE_TICK_MARKER_V1} claim rather than the echo, each with
 *    its verification evidence, so the caller can record them in the run log
 *    for audit rather than treating every tick as identical.
 */
export type MergeChecklistProgressResultV1 = MergeChecklistProgressOutcomeV1 & {
  /** review1 Step 9: id or `Step N` references that named no single item, each with a true reason. */
  readonly referenceProblems?: readonly string[];
};

type MergeChecklistProgressOutcomeV1 =
  | { readonly kind: "unchanged"; readonly alreadyRecorded?: readonly string[] }
  | { readonly kind: "no-report"; readonly alreadyRecorded?: readonly string[] }
  | {
      readonly kind: "unverified-test-evidence";
      readonly unverifiedSample: readonly string[];
      readonly unverifiedAll: readonly string[];
    }
  | {
      readonly kind: "no-match";
      /** First two unmatched claims, for a short human-facing message. */
      readonly unmatchedSample: readonly string[];
      /** Every unmatched claim (not sliced) — the numbered-claim resolver
       * (see {@link areAllUnmatchedChecklistClaimsAlreadySettledV1}) needs the
       * complete set, since a single unresolved claim among many resolved
       * ones must still raise the unreliable-checklist flag. */
      readonly unmatchedAll: readonly string[];
      /** Claims restating items the plan already records as ticked or excluded (bugs4 item 14). */
      readonly alreadyRecorded?: readonly string[];
    }
  | {
      readonly kind: "merged";
      readonly alreadyRecorded?: readonly string[];
      readonly content: string;
      readonly retroactiveTicks?: readonly { readonly itemText: string; readonly evidence: string }[];
      readonly unverifiedTestItems?: readonly string[];
    };

/**
 * Apply the checkbox state a round reported in `summary` to `planOfRecord`.
 * See {@link MergeChecklistProgressResultV1} for the returned outcome kinds.
 *
 * Deliberately narrow, because the plan of record is durable state and the
 * summary is model-authored text:
 *
 *  - **Ticks only.** An item already `- [x]` is never reverted to `- [ ]`. A
 *    round that reproduces the checklist sloppily (dropping items, resetting
 *    boxes it did not touch) can then only fail to record progress, never
 *    erase progress an earlier round earned.
 *  - **Matched by text and COUNT, not by position.** For each distinct item
 *    text, the echo's number of ticked copies is the target; the merge ticks
 *    however many additional unchecked copies are needed to reach it, in
 *    document order. Position-based identity would have been unstable exactly
 *    where it mattered: when two items share wording and the echo reorders or
 *    partially reproduces them, "the nth copy" means different items on each
 *    side, so a tick could land on the wrong one and hide the unfinished step.
 *    Counting is order-independent, and the remaining count — the number the
 *    completeness gate actually reads — comes out exact either way. Which of
 *    two textually identical items carries the tick is arbitrary, but they are
 *    indistinguishable to any reader of the plan too.
 *  - **Byte-preserving**, and confined to the latest rendering: only the
 *    checkbox glyph of a matched line is rewritten, so indentation, bullet
 *    style, surrounding prose, line endings, and any older copy earlier in the
 *    document are all left exactly as they were.
 */
export function mergeChecklistProgressV1(
  planOfRecord: string,
  summary: string,
  options?: { readonly reviewerVerified?: boolean }
): MergeChecklistProgressResultV1 {
  // review1 Step 9: claims by item id or a bare `Step N` are resolved to the item they name; a reference that
  // names nothing (or several items) is reported here with a true reason and is never an unmatched claim, so
  // it can never latch the checklist.
  const referenceProblems: string[] = [];
  const result = mergeChecklistProgressCoreV1(planOfRecord, summary, options, referenceProblems);
  return referenceProblems.length > 0 ? { ...result, referenceProblems } : result;
}

function mergeChecklistProgressCoreV1(
  planOfRecord: string,
  summary: string,
  options: { readonly reviewerVerified?: boolean } | undefined,
  referenceProblems: string[]
): MergeChecklistProgressResultV1 {
  // Only the echoed checklist counts as reported progress. The summary's own
  // `## Verification` is itself "a short checklist" per the prompt, so reading
  // the whole response let verification ticks add to the echo's — checking
  // more copies of a duplicated item than the round actually reported done.
  const { echo, own } = splitSummaryAtEchoV1(summary, planOfRecord);
  const reported = new Map<string, number>(collectCheckedChecklistCountsV1(echo));

  // Original (pre-normalization) text for each reported key, so a "no-match"
  // result can name what the round actually echoed rather than just its
  // normalized form.
  const reportedRawText = new Map<string, string>();
  for (const item of itemsInLatestRendering(echo)) {
    if (item.checked) {
      const key = normalizeChecklistItemTextV1(item.text);
      if (!reportedRawText.has(key)) {
        reportedRawText.set(key, item.text);
      }
    }
  }

  // Retroactive claims from the round's OWN `## Plan Item Checklist` section
  // (never the echo) fold into the same reported-count map, so a valid claim
  // is ticked by the identical owed-count logic below. A claim missing its
  // required evidence is never added to `reported` — it cannot tick anything
  // — but its text is kept so the no-match path can surface it exactly like
  // an unmatched echoed tick, rather than silently discarding it.
  //
  // `planItemKeys` lets a claim line whose item text itself contains ` — `
  // still resolve to the right item (see `parsePlanItemChecklistLine`).
  const planItemKeys = collectChecklistItemKeysV1(planOfRecord);
  const retroactiveKeys = new Set<string>();
  const retroactiveEvidenceByKey = new Map<string, string>();
  const missingEvidenceSamples: string[] = [];
  // bugs4 item 14: a claim restating an item the plan already records as ticked or
  // excluded needs no evidence to be harmless. It is "already recorded": never an
  // unmatched claim, so it can never set the unreliable-checklist latch.
  const alreadyRecorded: string[] = [];
  // A claim that named its item by id (or by a unique `Step N`) targets that exact line, whichever of several
  // identically worded items it is; the count-based owed logic below must not move it to another copy.
  const targetedIndexesByKey = new Map<string, Set<number>>();
  for (const rawClaim of collectRetroactiveTickClaimsV1(own, planItemKeys)) {
    const reference = resolvePlanItemReferenceV1(planOfRecord, rawClaim.itemText);
    if (reference.kind === "problem") {
      referenceProblems.push(reference.reason);
      continue;
    }
    const claim = reference.kind === "item" ? { ...rawClaim, itemText: reference.itemText } : rawClaim;
    const key = normalizeChecklistItemTextV1(claim.itemText);
    if (claim.evidence.length === 0) {
      if (isChecklistClaimTextAlreadyRecordedV1(planOfRecord, claim.itemText)) {
        alreadyRecorded.push(claim.itemText);
      } else {
        missingEvidenceSamples.push(claim.itemText);
      }
      continue;
    }
    reported.set(key, (reported.get(key) ?? 0) + 1);
    retroactiveKeys.add(key);
    if (reference.kind === "item") {
      const targeted = targetedIndexesByKey.get(key) ?? new Set<number>();
      targeted.add(reference.itemIndex);
      targetedIndexesByKey.set(key, targeted);
    }
    if (!retroactiveEvidenceByKey.has(key)) {
      retroactiveEvidenceByKey.set(key, claim.evidence);
    }
    if (!reportedRawText.has(key)) {
      reportedRawText.set(key, claim.itemText);
    }
  }

  // PART-level claims ("Part 7 — done this round (6/6), evidence: ...")
  // expand to every item under the matching `## Part N` heading, each
  // folded into the same maps as an individual retroactive tick sharing the
  // part's one evidence string. A part naming no matching heading, or
  // carrying no evidence, contributes nothing to `reported` but is still
  // named in `missingEvidenceSamples` so it surfaces rather than vanishing.
  for (const partClaim of collectPartLevelTickClaimsV1(own)) {
    const label = `Part ${partClaim.partNumber}`;
    if (partClaim.evidence.length === 0) {
      missingEvidenceSamples.push(label);
      continue;
    }
    const itemTexts = collectPlanItemsUnderPartHeadingV1(planOfRecord, partClaim.partNumber);
    if (itemTexts.length === 0) {
      missingEvidenceSamples.push(`${label} (no matching "## Part ${partClaim.partNumber}" heading in the plan)`);
      continue;
    }
    for (const itemText of itemTexts) {
      const key = normalizeChecklistItemTextV1(itemText);
      reported.set(key, (reported.get(key) ?? 0) + 1);
      retroactiveKeys.add(key);
      if (!retroactiveEvidenceByKey.has(key)) {
        retroactiveEvidenceByKey.set(key, partClaim.evidence);
      }
      if (!reportedRawText.has(key)) {
        reportedRawText.set(key, itemText);
      }
    }
  }

  // A round sometimes omits an item's leading step label ("Step 4: …") when
  // echoing it. Exact matching ran above; for a reported key that names no
  // plan item, compare again with the label removed from both sides. Resolve
  // only a UNIQUE open item — two items that differ only by their label stay
  // ambiguous (and so unmatched) rather than risking a tick on the wrong one.
  if (reported.size > 0) {
    const openItemsByLabelFreeKey = new Map<string, { key: string; count: number }>();
    for (const item of itemsInLatestRendering(planOfRecord)) {
      if (item.checked || item.excluded) {
        continue;
      }
      const key = normalizeChecklistItemTextV1(item.text);
      const labelFreeKey = stripLeadingStepLabelV1(key);
      if (labelFreeKey.length === 0) {
        continue;
      }
      const existing = openItemsByLabelFreeKey.get(labelFreeKey);
      if (existing) {
        existing.count += 1;
      } else {
        openItemsByLabelFreeKey.set(labelFreeKey, { key, count: 1 });
      }
    }

    const resolvedKeyByOriginal = new Map<string, string>();
    for (const key of reported.keys()) {
      if (planItemKeys.has(key)) {
        resolvedKeyByOriginal.set(key, key);
        continue;
      }
      const match = openItemsByLabelFreeKey.get(stripLeadingStepLabelV1(key));
      resolvedKeyByOriginal.set(key, match?.count === 1 ? match.key : key);
    }

    const resolvedReported = new Map<string, number>();
    for (const [key, count] of reported) {
      const resolved = resolvedKeyByOriginal.get(key) ?? key;
      resolvedReported.set(resolved, (resolvedReported.get(resolved) ?? 0) + count);
    }
    reported.clear();
    for (const [key, count] of resolvedReported) {
      reported.set(key, count);
    }

    const resolvedRawText = new Map<string, string>();
    for (const [key, raw] of reportedRawText) {
      const resolved = resolvedKeyByOriginal.get(key) ?? key;
      if (!resolvedRawText.has(resolved)) {
        resolvedRawText.set(resolved, raw);
      }
    }
    reportedRawText.clear();
    for (const [key, raw] of resolvedRawText) {
      reportedRawText.set(key, raw);
    }

    const resolvedRetroactiveKeys = new Set<string>();
    for (const key of retroactiveKeys) {
      resolvedRetroactiveKeys.add(resolvedKeyByOriginal.get(key) ?? key);
    }
    retroactiveKeys.clear();
    for (const key of resolvedRetroactiveKeys) {
      retroactiveKeys.add(key);
    }

    const resolvedEvidenceByKey = new Map<string, string>();
    for (const [key, evidence] of retroactiveEvidenceByKey) {
      const resolved = resolvedKeyByOriginal.get(key) ?? key;
      if (!resolvedEvidenceByKey.has(resolved)) {
        resolvedEvidenceByKey.set(resolved, evidence);
      }
    }
    retroactiveEvidenceByKey.clear();
    for (const [key, evidence] of resolvedEvidenceByKey) {
      retroactiveEvidenceByKey.set(key, evidence);
    }
  }

  // Editing-round self-claims require a passing report in the same summary.
  // Reviewer-tick application opts out only after its host-side derivation has
  // accepted durable editing-round evidence for the specific items.
  const planTextByKey = new Map<string, string>();
  for (const item of itemsInLatestRendering(planOfRecord)) {
    planTextByKey.set(normalizeChecklistItemTextV1(item.text), item.text);
  }
  const unverifiedTestItems: string[] = [];
  if (!options?.reviewerVerified) {
    for (const key of [...reported.keys()]) {
      const itemText = planTextByKey.get(key);
      if (itemText && isTestDependentChecklistItemV1(itemText) &&
          !hasApplicablePassingTestReportForItemV1(planOfRecord, itemText, summary)) {
        reported.delete(key);
        retroactiveKeys.delete(key);
        retroactiveEvidenceByKey.delete(key);
        targetedIndexesByKey.delete(key);
        unverifiedTestItems.push(itemText);
      }
    }
  }

  if (reported.size === 0) {
    if (unverifiedTestItems.length > 0) {
      return {
        kind: "unverified-test-evidence",
        unverifiedSample: unverifiedTestItems.slice(0, 2),
        unverifiedAll: unverifiedTestItems,
      };
    }
    if (missingEvidenceSamples.length > 0) {
      return {
        kind: "no-match",
        unmatchedSample: missingEvidenceSamples.slice(0, 2),
        unmatchedAll: missingEvidenceSamples,
        ...(alreadyRecorded.length > 0 ? { alreadyRecorded } : {}),
      };
    }
    return alreadyRecorded.length > 0 ? { kind: "no-report", alreadyRecorded } : { kind: "no-report" };
  }

  const { prefix, region } = scopeToLatestChecklistV1(planOfRecord);

  // Ticks still owed per item text: what the round reported, minus what the
  // plan already records. Never negative — a summary reporting fewer copies
  // done than the plan already has is not a request to untick anything.
  const owed = new Map<string, number>();
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (item.checked) {
      const key = normalizeChecklistItemTextV1(item.text);
      owed.set(key, (owed.get(key) ?? 0) - 1);
    }
  }
  for (const [key, count] of reported) {
    // Targeted claims are applied to their own lines below; only the untargeted remainder is a count owed.
    const untargeted = count - (targetedIndexesByKey.get(key)?.size ?? 0);
    owed.set(key, (owed.get(key) ?? 0) + (untargeted > 0 ? untargeted : 0));
  }

  let changed = false;
  let itemOrdinal = -1;
  const retroactiveTicks: { itemText: string; evidence: string }[] = [];
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          itemOrdinal++;
          if (state.toLowerCase() === "x") {
            return whole;
          }
          const key = normalizeChecklistItemTextV1(text);
          if (targetedIndexesByKey.get(key)?.has(itemOrdinal) !== true) {
            const remaining = owed.get(key) ?? 0;
            if (remaining <= 0) {
              return whole;
            }
            owed.set(key, remaining - 1);
          }
          changed = true;
          if (retroactiveKeys.has(key)) {
            retroactiveTicks.push({
              itemText: text,
              evidence: retroactiveEvidenceByKey.get(key) ?? "",
            });
          }
          return `${open}x${close}${text}${trailing}`;
        }
      );
    })
    .join("");

  if (changed) {
    return {
      kind: "merged",
      ...(alreadyRecorded.length > 0 ? { alreadyRecorded } : {}),
      content: `${prefix}${mergedRegion}`,
      ...(retroactiveTicks.length > 0 ? { retroactiveTicks } : {}),
      ...(unverifiedTestItems.length > 0 ? { unverifiedTestItems } : {}),
    };
  }

  // The round reported ticks, but the merge loop above never matched one to a
  // plan line — either every reported key was already checked in the plan
  // (owed <= 0 throughout: a legitimate no-op, "unchanged"), or at least one
  // reported key never appears among the plan's item keys at all (a genuine
  // mismatch worth surfacing). Distinguish by re-checking membership rather
  // than threading a second flag through the loop above.
  const unmatchedAll: string[] = [...missingEvidenceSamples];
  for (const key of reported.keys()) {
    if (!planItemKeys.has(key) && !unmatchedAll.includes(reportedRawText.get(key) ?? key)) {
      unmatchedAll.push(reportedRawText.get(key) ?? key);
    }
  }
  if (unmatchedAll.length > 0) {
    return {
      kind: "no-match",
      unmatchedSample: unmatchedAll.slice(0, 2),
      unmatchedAll,
      ...(alreadyRecorded.length > 0 ? { alreadyRecorded } : {}),
    };
  }
  return alreadyRecorded.length > 0 ? { kind: "unchanged", alreadyRecorded } : { kind: "unchanged" };
}

/**
 * bugs4 item 14: true when `claimText`, after {@link normalizeChecklistItemTextV1},
 * exactly matches at least one plan item and EVERY item with that text is already
 * ticked or excluded. A claim like that restates recorded progress; it never needs
 * a tick, so it is neither unmatched nor a reason to doubt the checklist. A claim
 * that matches no item, or whose text also belongs to a still-open item, is not
 * "already recorded".
 */
export function isChecklistClaimTextAlreadyRecordedV1(planOfRecord: string, claimText: string): boolean {
  const key = normalizeChecklistItemTextV1(claimText);
  if (key.length === 0) {
    return false;
  }
  let matches = 0;
  for (const item of itemsInLatestRendering(planOfRecord)) {
    if (normalizeChecklistItemTextV1(item.text) !== key) {
      continue;
    }
    matches++;
    if (!item.checked && !item.excluded) {
      return false;
    }
  }
  return matches > 0;
}

/** Result of {@link parseNumberedChecklistClaimV1}. */
export type NumberedChecklistClaimParseV1 =
  | { readonly kind: "not-a-number-claim" }
  | { readonly kind: "malformed" }
  | { readonly kind: "resolved"; readonly indices: readonly number[] };

/**
 * RC3 item 1 (Step 2a): a round sometimes reports its own progress in
 * shorthand — "Steps 1–33", "Step 34", "Step 1 (lookalike-marker
 * acceptance…)" — naming plan items by their 1-based ordinal position among
 * the plan's TOP-LEVEL checklist items (the same denominator
 * {@link countChecklistProgressV1} reports as `total`/`<!-- progress: N/M
 * -->`) instead of quoting the item's own text. `mergeChecklistProgressV1`
 * cannot match that against any item text, so it reports the claim as
 * unmatched — which used to always raise the unreliable-checklist flag, even
 * when every one of those numbered items was already settled and the round
 * simply described real, already-recorded progress in the wrong shape.
 *
 * This parses ONE unmatched claim string into the item-index range it names,
 * recognizing exactly: `Step N`, `Step N (<anything>)`, `Steps N-M` / `Steps
 * N–M` / `Steps N to M` (case-insensitive, en-dash or hyphen), each anchored
 * to the WHOLE claim string (only trailing whitespace, a trailing period, or
 * — for the single-step form — one trailing parenthetical is allowed after
 * the number(s)). Anything that does not start with `Step`/`Steps` at all is
 * `"not-a-number-claim"` — an ordinary (mismatched) item-text claim, left to
 * the existing unresolved path. Anything that DOES start with `Step`/`Steps`
 * but fails to parse as one of those complete, whole-string forms —
 * `"Steps 5–"`, `"Step x"`, an inverted range like `"Steps 10-5"`, a range
 * whose span exceeds {@link MAX_NUMBERED_CLAIM_RANGE_SPAN_V1}, or a claim
 * carrying an extra, unparsed reference after the recognized number(s)
 * (`"Steps 1-2 and Step 83"`, `"Step 1 and Step 83"`) — is `"malformed"` —
 * also left unresolved, never guessed at. Requiring the whole string to
 * match (rather than only a matching prefix) is what stops a claim like
 * `"Steps 1-2 and Step 83"` from silently resolving to just `[1, 2]` while
 * quietly dropping its reference to Step 83. The range span is capped
 * (rather than left to expand to whatever two numbers the round wrote) so a
 * claim like `"Steps 1-999999999"` cannot build an unbounded array; this
 * function never consults the plan, so the cap is a fixed sanity bound, not
 * the plan's own item count. This function never consults the plan: it only
 * parses the claim's shape.
 *
 * A trailing status suffix — ` — done`, `- done`, or `– done` (any of the
 * three dash characters, case-insensitive `done`), optionally followed by a
 * trailing period — is also accepted after the number(s) (and, for the
 * single-step form, after the parenthetical), for both forms. This is a
 * narrow whitelist of exactly that one word, not a general "allow trailing
 * prose" carve-out: `"Steps 1-33 — done"` resolves, but `"Steps 1-2 and Step
 * 83"` (an unparsed reference, not the literal word "done") still does not,
 * because the suffix group only ever matches the literal text `done` and
 * nothing else. The normal path into this parser (a round's `## Plan Item
 * Checklist` claim line) already splits the status off via ` — ` before the
 * text reaches here, but a claim reported inside the ECHOED checklist block
 * itself (`- [x] Steps 1-33 — done`) carries its status suffix as part of
 * the raw item text with no such split, so this parser sees it directly.
 */
const MAX_NUMBERED_CLAIM_RANGE_SPAN_V1 = 5000;
const NUMBERED_CLAIM_STATUS_SUFFIX = "(?:\\s*[-–—]\\s*done)?";

export function parseNumberedChecklistClaimV1(claimText: string): NumberedChecklistClaimParseV1 {
  const trimmed = claimText.trim();
  const rangeMatch = new RegExp(
    `^Steps\\s+(\\d+)\\s*(?:-|–|to)\\s*(\\d+)${NUMBERED_CLAIM_STATUS_SUFFIX}\\s*\\.?\\s*$`,
    "i"
  ).exec(trimmed);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 1 ||
      end < start ||
      end - start > MAX_NUMBERED_CLAIM_RANGE_SPAN_V1
    ) {
      return { kind: "malformed" };
    }
    const indices: number[] = [];
    for (let n = start; n <= end; n++) {
      indices.push(n);
    }
    return { kind: "resolved", indices };
  }
  const singleMatch = new RegExp(
    `^Step\\s+(\\d+)(?:\\s*\\([\\s\\S]*\\))?${NUMBERED_CLAIM_STATUS_SUFFIX}\\s*\\.?\\s*$`,
    "i"
  ).exec(trimmed);
  if (singleMatch) {
    const n = Number(singleMatch[1]);
    return Number.isFinite(n) && n >= 1 ? { kind: "resolved", indices: [n] } : { kind: "malformed" };
  }
  if (/^Steps?\b/i.test(trimmed)) {
    // Started as a numbered-step claim but did not parse as one of the
    // recognized whole-string forms — a dangling range, a non-numeric
    // target, an inverted or oversized range, or trailing text/extra
    // references the forms above do not account for.
    return { kind: "malformed" };
  }
  return { kind: "not-a-number-claim" };
}

/**
 * Whether the plan's top-level checklist item at 1-based ordinal `index` is
 * already settled (ticked, or closed via {@link EXCLUDED_CHECKLIST_ITEM_MARKER_V1}).
 * An out-of-range index (0, negative, or past the plan's `total`) is never
 * settled — this is the guard that keeps an out-of-range claim unresolved
 * rather than vacuously "true".
 */
function isTopLevelChecklistIndexSettledV1(planOfRecord: string, index: number): boolean {
  if (!Number.isInteger(index) || index < 1) {
    return false;
  }
  const topLevel = itemsInLatestRendering(planOfRecord).filter((item) => !item.nested);
  const item = topLevel[index - 1];
  return item !== undefined && (item.checked || item.excluded);
}

/**
 * RC3 item 1 (Step 2a): true only when every claim in `unmatchedClaimTexts`
 * (the FULL unmatched set — see {@link MergeChecklistProgressResultV1}'s
 * `unmatchedAll`, never just the two-item `unmatchedSample`) is a numbered
 * claim ({@link parseNumberedChecklistClaimV1}) whose every referenced item
 * is already settled. A single ordinary item-text claim, a single malformed
 * numbered claim, or a single numbered claim naming even one unsettled or
 * out-of-range item, makes the whole result `false` — this only ever
 * SUPPRESSES a false-alarm flag/card for progress the plan already records;
 * it never ticks anything, and an unsettled numbered reference is left for
 * the existing review / reviewer-verified-ticks paths to resolve. An empty
 * `unmatchedClaimTexts` (nothing left unresolved) is vacuously true.
 */
export function areAllUnmatchedChecklistClaimsAlreadySettledV1(
  planOfRecord: string,
  unmatchedClaimTexts: readonly string[]
): boolean {
  return unmatchedClaimTexts.every((claimText) => {
    if (isChecklistClaimTextAlreadyRecordedV1(planOfRecord, claimText)) {
      return true;
    }
    const parsed = parseNumberedChecklistClaimV1(claimText);
    return (
      parsed.kind === "resolved" &&
      parsed.indices.every((index) => isTopLevelChecklistIndexSettledV1(planOfRecord, index))
    );
  });
}
