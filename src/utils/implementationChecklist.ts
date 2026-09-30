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

/**
 * True when `itemText` (the checklist line's captured text) genuinely carries
 * the exclusion marker, as opposed to merely mentioning it. The marker counts
 * only as a TRAILING comment: it ends the line, follows real item text, is
 * and is separated from that text by whitespace (a marker inside an inline
 * code span never ends the line, so it is already not trailing). So an item
 * that is ABOUT the marker ("Add the marker `<!-- ensemble:excluded -->`",
 * "… the literal<!-- ensemble:excluded -->") stays an ordinary open item
 * rather than silently settling as excluded and shrinking the count (RC1
 * item 7).
 */
export function isExcludedChecklistItemText(itemText: string): boolean {
  const trimmed = itemText.trimEnd();
  if (!trimmed.endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1)) {
    return false;
  }
  const before = trimmed.slice(0, trimmed.length - EXCLUDED_CHECKLIST_ITEM_MARKER_V1.length);
  return before.trim().length > 0 && /\s$/.test(before);
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
  const unescaped = unescapeChecklistItemTextV1(text);
  return unescaped.trim().toLowerCase().replace(/\s+/g, " ");
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
  date: string
): string {
  if (items.length === 0) {
    return planOfRecord;
  }
  const heading = `### Open items settled by the owner (owner decision, ${date})`;
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
  return unescapeChecklistItemTextV1(text).trim();
}

function occurrenceKeyV1(text: string, settled: boolean): string {
  if (!settled) {
    return exactItemKeyV1(text);
  }
  // A line this flow settled carries an appended annotation (and the excluded
  // marker); strip it so the line keeps the id it had while open and is
  // reported as "already settled" rather than "no longer in the plan".
  const withoutMarker = text.replace(/[ \t]*<!-- ensemble:excluded -->[ \t]*$/, "");
  return exactItemKeyV1(withoutMarker.replace(/\s+— (?:Checked|Excluded by you): [\s\S]*$/, ""));
}

export function computeOpenPlanItemIdV1(itemText: string, occurrence: number): string {
  return createHash("sha256")
    .update(`${exactItemKeyV1(itemText)}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 16);
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
    });
  }
  return records;
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
  date: string
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
  const excludedItems: AcceptedNonGoalItemV1[] = [];
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
    if (current.settled) {
      skipped.push({
        itemId: answer.itemId,
        itemText: current.itemText,
        reason: "skipped: this item was already settled",
      });
      continue;
    }
    const mode = answer.choice === "tick" ? "tick" : "exclude";
    const { content: next, settledItemText } = settleChecklistItemAtOccurrenceV1(
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
    if (mode === "tick") {
      ticked.push(settledItemText);
    } else {
      excludedItems.push({ itemText: settledItemText, reason: answer.note ?? "" });
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
  const items: string[] = [];
  for (let i = heading.line + 1; i < end; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const match = ANY_ITEM_LINE.exec(line.text);
    if (match) {
      items.push(match[3] ?? "");
    }
  }
  return items;
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
 */
export function splitSummaryAtEchoV1(summary: string): {
  echo: string;
  own: string;
} {
  const all = headingsV1(summary);
  const at = findLastHeadingV1(all, "Files Changed");
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
  for (const line of walkLinesV1(region)) {
    if (line.fenced) {
      continue;
    }
    const heading = /^#{1,6}[ \t]+(.*\S)/.exec(line.text);
    if (heading) {
      section = heading[1] ?? "";
      continue;
    }
    const match = ANY_ITEM_LINE.exec(line.text);
    if (match) {
      const text = match[3] ?? "";
      items.push({
        text,
        checked: match[2]?.toLowerCase() === "x",
        excluded: isExcludedChecklistItemText(text),
        nested: (match[1]?.length ?? 0) > 0,
        section,
      });
    }
  }
  return items;
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
  };
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
export function formatChecklistProgressForReviewerV1(planOfRecord: string | undefined): string {
  const counted = planOfRecord ? countChecklistProgressV1(planOfRecord) : undefined;
  return counted ? `${counted.settled}/${counted.total}` : "unknown";
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
  const beforeKeys = new Set(beforeItems.map((item) => normalizeChecklistItemTextV1(item.text)));
  const afterKeys = new Set(afterItems.map((item) => normalizeChecklistItemTextV1(item.text)));

  const addedItems: string[] = [];
  const seenAdded = new Set<string>();
  for (const item of afterItems) {
    const key = normalizeChecklistItemTextV1(item.text);
    if (!beforeKeys.has(key) && !seenAdded.has(key)) {
      seenAdded.add(key);
      addedItems.push(item.text);
    }
  }
  const removedItems: string[] = [];
  const seenRemoved = new Set<string>();
  for (const item of beforeItems) {
    const key = normalizeChecklistItemTextV1(item.text);
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
        currentParentKey = normalizeChecklistItemTextV1(item.text);
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
    const key = normalizeChecklistItemTextV1(pair.text);
    const set = afterChildKeysByParent.get(pair.parentKey) ?? new Set<string>();
    set.add(key);
    afterChildKeysByParent.set(pair.parentKey, set);
  }
  const seenRemovedNested = new Set<string>();
  for (const pair of pairWithParent(beforeAll)) {
    if (!afterKeys.has(pair.parentKey)) {
      continue; // Parent itself was dropped — already caught above.
    }
    const key = normalizeChecklistItemTextV1(pair.text);
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
          const markerIndex = text.lastIndexOf(EXCLUDED_CHECKLIST_ITEM_MARKER_V1);
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
export type MergeChecklistProgressResultV1 =
  | { readonly kind: "unchanged" }
  | { readonly kind: "no-report" }
  | {
      readonly kind: "no-match";
      /** First two unmatched claims, for a short human-facing message. */
      readonly unmatchedSample: readonly string[];
      /** Every unmatched claim (not sliced) — the numbered-claim resolver
       * (see {@link areAllUnmatchedChecklistClaimsAlreadySettledV1}) needs the
       * complete set, since a single unresolved claim among many resolved
       * ones must still raise the unreliable-checklist flag. */
      readonly unmatchedAll: readonly string[];
    }
  | {
      readonly kind: "merged";
      readonly content: string;
      readonly retroactiveTicks?: readonly { readonly itemText: string; readonly evidence: string }[];
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
  summary: string
): MergeChecklistProgressResultV1 {
  // Only the echoed checklist counts as reported progress. The summary's own
  // `## Verification` is itself "a short checklist" per the prompt, so reading
  // the whole response let verification ticks add to the echo's — checking
  // more copies of a duplicated item than the round actually reported done.
  const { echo, own } = splitSummaryAtEchoV1(summary);
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
  for (const claim of collectRetroactiveTickClaimsV1(own, planItemKeys)) {
    const key = normalizeChecklistItemTextV1(claim.itemText);
    if (claim.evidence.length === 0) {
      missingEvidenceSamples.push(claim.itemText);
      continue;
    }
    reported.set(key, (reported.get(key) ?? 0) + 1);
    retroactiveKeys.add(key);
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

  if (reported.size === 0) {
    if (missingEvidenceSamples.length > 0) {
      return {
        kind: "no-match",
        unmatchedSample: missingEvidenceSamples.slice(0, 2),
        unmatchedAll: missingEvidenceSamples,
      };
    }
    return { kind: "no-report" };
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
    owed.set(key, (owed.get(key) ?? 0) + count);
  }

  let changed = false;
  const retroactiveTicks: { itemText: string; evidence: string }[] = [];
  const mergedRegion = walkLinesV1(region)
    .map((line) => {
      if (line.fenced) {
        return line.raw;
      }
      return line.raw.replace(
        ITEM_LINE,
        (whole, open: string, state: string, close: string, text: string, trailing: string) => {
          if (state.toLowerCase() === "x") {
            return whole;
          }
          const key = normalizeChecklistItemTextV1(text);
          const remaining = owed.get(key) ?? 0;
          if (remaining <= 0) {
            return whole;
          }
          owed.set(key, remaining - 1);
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
      content: `${prefix}${mergedRegion}`,
      ...(retroactiveTicks.length > 0 ? { retroactiveTicks } : {}),
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
    return { kind: "no-match", unmatchedSample: unmatchedAll.slice(0, 2), unmatchedAll };
  }
  return { kind: "unchanged" };
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
    const parsed = parseNumberedChecklistClaimV1(claimText);
    return (
      parsed.kind === "resolved" &&
      parsed.indices.every((index) => isTopLevelChecklistIndexSettledV1(planOfRecord, index))
    );
  });
}
