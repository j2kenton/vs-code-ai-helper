/**
 * Carries a round's checkbox progress back into the implementation plan of
 * record (plan-final.md).
 *
 * `run-implementation.md` requires a completed round to reproduce the
 * `<!-- ensemble:implementation-checklist -->` checklist as its response's
 * first section, with only the checkbox state changed: "This is the only
 * persistent record of overall plan progress across rounds: if you omit it
 * here, the next round will not know what remains, and will incorrectly treat
 * the plan as finished."
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

import {
  findLastHeadingV1,
  headingsV1,
  walkLinesV1,
} from "./markdownStructure";

/**
 * One checklist line, split so a merge can rewrite only the checkbox glyph and
 * leave every other byte (indent, bullet, spacing, trailing `\r`) untouched.
 * Mirrors the item pattern `verifyPlanItems` uses, so the two always agree on
 * what counts as a checklist item.
 */
const ITEM_LINE = /^([ \t]*[-*][ \t]*\[)([ xX])(\][ \t]+)(.*\S)([ \t]*\r?)$/m;
const ANY_ITEM_LINE = /^[ \t]*[-*][ \t]*\[([ xX])\][ \t]+(.*\S)[ \t]*\r?$/;

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
 * explicitly with this marker instead of reproducing the checklist echo. Used
 * by `describeImplementationSummaryShapeIssue` to accept the response without
 * requiring `echoesPlanChecklist` to find an overlapping item, since a round
 * that changed no checkbox state has nothing to echo.
 */
export const NO_CHECKLIST_CHANGE_MARKER_V1 = "<!-- ensemble:no-checklist-change -->";

/** True when `response` declares, via the marker above, that no checkbox state changed this round. */
export function declaresNoChecklistChangeV1(response: string): boolean {
  return response.includes(NO_CHECKLIST_CHANGE_MARKER_V1);
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
 * A marked item is still a real checklist item for every purpose except the
 * completeness denominator: `itemsInLatestRendering` still returns it (so it
 * is still matched/ticked by `mergeChecklistProgressV1` and still counted by
 * `hasImplementationChecklistV1`/`collectChecklistItemKeysV1`), but
 * `countChecklistProgressV1` excludes it from `total` and `checked` — which
 * is what `reconcileProgressWithChecklistV1` (reviewReadiness.ts) reads as
 * the denominator the completeness gate cannot be satisfied without.
 *
 * Additive only: a plan-final.md with no markers at all has zero lines
 * matching this, so existing in-flight plans are completely unaffected.
 */
export const EXCLUDED_CHECKLIST_ITEM_MARKER_V1 = "<!-- ensemble:excluded -->";

/** True when `itemText` (the checklist line's captured text) carries the exclusion marker. */
function isExcludedChecklistItemText(itemText: string): boolean {
  return itemText.trimEnd().endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1);
}

/**
 * Reverses the over-escaping a checklist line can pick up from a round-trip
 * through a JSON-encoded field (the checklist echo travels inside the
 * `<<<ENSEMBLE_AI_RESULT_V1>>>` frame's `"markdown"` string, and the plan of
 * record was itself generated the same way): backslash-escaped quotes
 * (`\"` -> `"`), apostrophes (`\'` -> `'`) and doubled backslashes
 * (`\\` -> `\`). Shared by `normalizeChecklistItemTextV1` (for the merge key)
 * and `verifyPlanItems` (for the text it displays/hands to AI verification),
 * so a corrupted plan item is unescaped identically wherever it is read —
 * neither copy duplicates this logic.
 */
export function unescapeChecklistItemTextV1(text: string): string {
  return text
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
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
 */
function parsePlanItemChecklistLine(
  raw: string
): { itemText: string; status: string; evidence: string } | undefined {
  const outer = CHECKLIST_ENTRY_LINE.exec(raw);
  if (!outer) {
    return undefined;
  }
  const parts = (outer[1] ?? "").split(/\s+—\s+/);
  if (parts.length < 2) {
    return undefined;
  }
  return {
    itemText: (parts[0] ?? "").trim(),
    status: (parts[1] ?? "").trim(),
    evidence: parts.slice(2).join(" — ").trim(),
  };
}

/**
 * Retroactive-tick claims declared in `ownSummary` — the part of a response
 * AFTER the `## Files Changed` boundary (`splitSummaryAtEchoV1`'s `own`),
 * never the echoed plan checklist itself, so a plan quoting this marker in
 * its own text cannot be mistaken for a round claiming it.
 *
 * A claim with empty `evidence` is still returned (not dropped): the caller
 * must treat it as an unfulfilled claim rather than silently ticking
 * unverified work, and surface it the same way an unmatched echoed tick is
 * surfaced — the hard evidence requirement is what keeps this from becoming
 * a licence to mark unbuilt work done.
 */
export function collectRetroactiveTickClaimsV1(
  ownSummary: string
): RetroactiveTickClaimV1[] {
  const claims: RetroactiveTickClaimV1[] = [];
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
    const parsed = parsePlanItemChecklistLine(line.text);
    if (!parsed) {
      continue;
    }
    if (
      !parsed.status.toLowerCase().startsWith("done") ||
      !parsed.status.includes(RETROACTIVE_TICK_MARKER_V1)
    ) {
      continue;
    }
    claims.push({ itemText: parsed.itemText, evidence: parsed.evidence });
  }
  return claims;
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

/** Countable state of a plan-of-record checklist. */
export interface ChecklistProgressV1 {
  /** Checklist items in the latest rendering, excluding marked-excluded items. */
  readonly total: number;
  /** Items whose box is ticked, excluding marked-excluded items. */
  readonly checked: number;
  /** `total - checked` — the work the plan still says is outstanding. */
  readonly remaining: number;
  /**
   * Items carrying `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` — counted separately
   * so a caller can say WHY the denominator is smaller than the checklist's
   * visible line count, without those items affecting `total`/`checked`.
   */
  readonly excluded: number;
}

/**
 * Every checklist item in one rendering, in document order — skipping items
 * inside fenced examples, which are illustrations of a checklist rather than
 * this plan's own work.
 */
function itemsInLatestRendering(
  content: string
): { text: string; checked: boolean; excluded: boolean }[] {
  const items: { text: string; checked: boolean; excluded: boolean }[] = [];
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
    const match = ANY_ITEM_LINE.exec(line.text);
    if (match) {
      const text = match[2] ?? "";
      items.push({
        text,
        checked: match[1]?.toLowerCase() === "x",
        excluded: isExcludedChecklistItemText(text),
      });
    }
  }
  return items;
}

/**
 * Count the plan of record's checklist, or `undefined` when it carries none.
 *
 * One line is one item. Scoping to a single rendering is what removes the
 * cross-copy duplication, so nothing here collapses by text — two genuinely
 * distinct steps that happen to share wording stay two steps, and neither
 * disappears from the denominator.
 *
 * Items carrying `EXCLUDED_CHECKLIST_ITEM_MARKER_V1` are excluded from both
 * `total` and `checked` — an operator-action/optional/descoped step the
 * implementation stage cannot itself perform must not hold the completeness
 * gate (`reconcileProgressWithChecklistV1`) open forever. The presence check
 * below still counts them: a plan whose only items are all marked excluded is
 * a real (if fully out-of-scope) checklist, not "no checklist", so it must
 * not fall through to `undefined` and silently disable the gate.
 */
export function countChecklistProgressV1(
  planOfRecord: string
): ChecklistProgressV1 | undefined {
  const items = itemsInLatestRendering(planOfRecord);
  if (items.length === 0) {
    return undefined;
  }
  const counted = items.filter((item) => !item.excluded);
  const checked = counted.filter((item) => item.checked).length;
  return {
    total: counted.length,
    checked,
    remaining: counted.length - checked,
    excluded: items.length - counted.length,
  };
}

/** Normalized text of every checklist item in `content`'s latest rendering. */
export function collectChecklistItemKeysV1(content: string): ReadonlySet<string> {
  return new Set(
    itemsInLatestRendering(content).map((item) =>
      normalizeChecklistItemTextV1(item.text)
    )
  );
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
  | { readonly kind: "no-match"; readonly unmatchedSample: readonly string[] }
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
  const retroactiveKeys = new Set<string>();
  const retroactiveEvidenceByKey = new Map<string, string>();
  const missingEvidenceSamples: string[] = [];
  for (const claim of collectRetroactiveTickClaimsV1(own)) {
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

  if (reported.size === 0) {
    if (missingEvidenceSamples.length > 0) {
      return { kind: "no-match", unmatchedSample: missingEvidenceSamples.slice(0, 2) };
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
  const planKeys = collectChecklistItemKeysV1(planOfRecord);
  const unmatchedSample: string[] = [...missingEvidenceSamples];
  for (const key of reported.keys()) {
    if (!planKeys.has(key) && !unmatchedSample.includes(reportedRawText.get(key) ?? key)) {
      unmatchedSample.push(reportedRawText.get(key) ?? key);
    }
    if (unmatchedSample.length >= 2) {
      break;
    }
  }
  if (unmatchedSample.length > 0) {
    return { kind: "no-match", unmatchedSample: unmatchedSample.slice(0, 2) };
  }
  return { kind: "unchanged" };
}
