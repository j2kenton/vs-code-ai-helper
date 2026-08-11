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
 * Item-identity text. Must match `verifyPlanItems`' key exactly, or an item
 * could merge here and count differently in Plan Item Verification.
 */
export function normalizeChecklistItemTextV1(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
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
  /** Checklist items in the latest rendering. */
  readonly total: number;
  /** Items whose box is ticked. */
  readonly checked: number;
  /** `total - checked` — the work the plan still says is outstanding. */
  readonly remaining: number;
}

/**
 * Every checklist item in one rendering, in document order — skipping items
 * inside fenced examples, which are illustrations of a checklist rather than
 * this plan's own work.
 */
function itemsInLatestRendering(
  content: string
): { text: string; checked: boolean }[] {
  const items: { text: string; checked: boolean }[] = [];
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
      items.push({
        text: match[2] ?? "",
        checked: match[1]?.toLowerCase() === "x",
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
 */
export function countChecklistProgressV1(
  planOfRecord: string
): ChecklistProgressV1 | undefined {
  const items = itemsInLatestRendering(planOfRecord);
  if (items.length === 0) {
    return undefined;
  }
  const checked = items.filter((item) => item.checked).length;
  return { total: items.length, checked, remaining: items.length - checked };
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
 * Apply the checkbox state a round reported in `summary` to `planOfRecord`,
 * returning the updated document, or `undefined` when nothing changed.
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
): string | undefined {
  // Only the echoed checklist counts as reported progress. The summary's own
  // `## Verification` is itself "a short checklist" per the prompt, so reading
  // the whole response let verification ticks add to the echo's — checking
  // more copies of a duplicated item than the round actually reported done.
  const reported = collectCheckedChecklistCountsV1(splitSummaryAtEchoV1(summary).echo);
  if (reported.size === 0) {
    return undefined;
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
          return `${open}x${close}${text}${trailing}`;
        }
      );
    })
    .join("");

  return changed ? `${prefix}${mergedRegion}` : undefined;
}
