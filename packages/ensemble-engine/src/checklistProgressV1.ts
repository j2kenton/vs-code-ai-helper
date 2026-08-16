/**
 * Round/part (`N/M`) progress machinery (plan Part 4a).
 *
 * Semantic port of the extension's plan-of-record checklist accounting —
 * `src/utils/markdownStructure.ts` (line/fence/heading walking),
 * `src/utils/implementationChecklist.ts` (checklist scoping, counting, and
 * the ticks-only byte-preserving merge), and the `<!-- progress: N/M -->`
 * marker parse plus checklist reconciliation from
 * `src/utils/reviewReadiness.ts`. The extension keeps its own copies and
 * never imports this package; the engine's checklist-parity test suite runs
 * both implementations over the same documents and asserts identical
 * results, exactly as the Part 2 dual-decode suite does for codecs.
 *
 * Why this is load-bearing for the task loop: a round's summary echoes the
 * plan checklist with updated boxes, the merge accumulates those ticks into
 * the plan of record, and the CHECKLIST — never a self-reported marker — is
 * the authority on how much of the plan remains. A reviewer that narrows its
 * denominator (`<!-- progress: 5/5 -->` against a 47-item plan) must not be
 * able to declare the task finished; `reconcileProgressWithChecklistV1`
 * enforces that asymmetry verbatim from the extension.
 */

/**
 * Every line with its terminator preserved, flagged for whether it sits
 * inside a fenced code block (port of `walkLinesV1`).
 */
export function walkLinesV1(
  content: string
): { text: string; raw: string; fenced: boolean }[] {
  const parts = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const walked: { text: string; raw: string; fenced: boolean }[] = [];
  let fence: string | undefined;
  for (const raw of parts) {
    const text = raw.replace(/\r?\n$/, "");
    const fenceAt = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence !== undefined) {
      walked.push({ text, raw, fenced: true });
      if (
        fenceAt &&
        fenceAt[1]![0] === fence[0] &&
        fenceAt[1]!.length >= fence.length &&
        text.slice(fenceAt[0].length).trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceAt) {
      fence = fenceAt[1];
      walked.push({ text, raw, fenced: true });
      continue;
    }
    walked.push({ text, raw, fenced: false });
  }
  return walked;
}

/** A heading, its depth, and the index of the line it sits on. */
export interface MarkdownHeadingV1 {
  readonly title: string;
  readonly level: number;
  readonly line: number;
}

/** Every heading in `content`, ignoring fenced blocks (port of `headingsV1`). */
export function headingsV1(content: string): MarkdownHeadingV1[] {
  const lines = walkLinesV1(content);
  const found: MarkdownHeadingV1[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.fenced) {
      continue;
    }
    const atx = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line.text);
    if (atx) {
      found.push({
        title: (atx[2] ?? "").replace(/[ \t]+#+$/, "").trim(),
        level: (atx[1] ?? "#").length,
        line: i,
      });
      continue;
    }
    const underline = lines[i + 1];
    if (
      underline !== undefined &&
      !underline.fenced &&
      line.text.trim().length > 0 &&
      !/^[ \t]{0,3}([-*+]|\d+\.)[ \t]/.test(line.text) &&
      /^[ \t]{0,3}(=+|-+)[ \t]*$/.test(underline.text)
    ) {
      found.push({
        title: line.text.trim(),
        level: underline.text.trim().startsWith("=") ? 1 : 2,
        line: i,
      });
    }
  }
  return found;
}

/** Index of the LAST heading whose title matches `text`, or -1. */
export function findLastHeadingV1(
  all: readonly MarkdownHeadingV1[],
  text: string
): number {
  const want = text.trim().toLowerCase();
  for (let i = all.length - 1; i >= 0; i--) {
    if ((all[i]?.title ?? "").toLowerCase() === want) {
      return i;
    }
  }
  return -1;
}

const ITEM_LINE = /^([ \t]*[-*][ \t]*\[)([ xX])(\][ \t]+)(.*\S)([ \t]*\r?)$/m;
const ANY_ITEM_LINE = /^[ \t]*[-*][ \t]*\[([ xX])\][ \t]+(.*\S)[ \t]*\r?$/;

/** The marker a generated implementation checklist opens with. */
export const IMPLEMENTATION_CHECKLIST_MARKER_V1 =
  "<!-- ensemble:implementation-checklist -->";

const STANDALONE_MARKER_LINE = new RegExp(
  `^[ \\t]*${IMPLEMENTATION_CHECKLIST_MARKER_V1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`
);

/**
 * A round that legitimately fixed a review blocker without ticking any plan
 * checkbox may state so explicitly with this marker instead of reproducing
 * the checklist echo — port of the extension's `NO_CHECKLIST_CHANGE_MARKER_V1`;
 * must match its marker text exactly (parity-tested).
 */
export const NO_CHECKLIST_CHANGE_MARKER_V1 = "<!-- ensemble:no-checklist-change -->";

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
 * True when `content` both declares `NO_CHECKLIST_CHANGE_MARKER_V1` ("nothing
 * to tick") and ALSO reports at least one retroactive-tick claim in its own
 * `## Plan Item Checklist` section — a round that wants checklist state to
 * change while explicitly declaring it does not. Port of the extension's
 * `hasContradictoryNoChecklistChangeClaimV1` (round 013, task "1.9",
 * 2026-08-14): the declaration check requires the marker on its OWN line, and
 * the claims check is scoped to `own` (`splitSummaryAtEchoV1`'s post-echo
 * region), so a plan that merely quotes either marker inside a checklist
 * item's descriptive text can never trigger this on its own.
 */
export function hasContradictoryNoChecklistChangeClaimV1(content: string): boolean {
  const trimmed = content.trim();
  if (!declaresNoChecklistChangeV1(trimmed)) {
    return false;
  }
  const { own } = splitSummaryAtEchoV1(trimmed);
  return collectRetroactiveTickClaimsV1(own).length > 0;
}

/**
 * Item-identity text: must match the extension's key exactly (parity-tested).
 *
 * Unescapes backslash-escaped quotes/apostrophes/backslashes BEFORE the trim/
 * lowercase/whitespace collapse — port of the extension's
 * `normalizeChecklistItemTextV1`, which exists because a round-trip through a
 * JSON-encoded field can leave over-escaped quotes on disk as literal
 * backslash-quote sequences.
 */
export function normalizeChecklistItemTextV1(text: string): string {
  const unescaped = text
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
  return unescaped.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A round's `## Plan Item Checklist` section may report an item as `done`
 * with this marker to claim it was completed in an EARLIER round and only
 * verified (not built) this round — port of the extension's
 * `RETROACTIVE_TICK_MARKER_V1`; must match its marker text exactly
 * (parity-tested). Only honored alongside non-empty evidence following it.
 */
export const RETROACTIVE_TICK_MARKER_V1 = "<!-- ensemble:retroactive -->";

/** One retroactive-tick claim parsed from a round's `## Plan Item Checklist` section. */
export interface RetroactiveTickClaimV1 {
  readonly itemText: string;
  readonly evidence: string;
}

const CHECKLIST_ENTRY_LINE = /^[ \t]*[-*][ \t]+(.*\S)[ \t]*\r?$/;

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
 * never the echoed plan checklist itself. Port of the extension's
 * `collectRetroactiveTickClaimsV1`. A claim with empty `evidence` is still
 * returned so the caller can treat it as unfulfilled rather than dropping it.
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
 * summary it wrote (port of `splitSummaryAtEchoV1` — the boundary is the
 * last `## Files Changed` heading, but only when it really is a summary's
 * file list rather than a plan area heading followed by checkboxes).
 */
export function splitSummaryAtEchoV1(summary: string): {
  echo: string;
  own: string;
} {
  const all = headingsV1(summary);
  const at = findLastHeadingV1(all, "Files Changed");
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
 * count exactly one rendering of the list (port of `scopeToLatestChecklistV1`;
 * a marker only starts a rendering when it is unfenced markup actually
 * followed by checklist items).
 */
export function scopeToLatestChecklistV1(content: string): {
  found: boolean;
  prefix: string;
  region: string;
} {
  const walked = walkLinesV1(content);
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
  return {
    found: true,
    prefix: walked.slice(0, lastMarker).map((line) => line.raw).join(""),
    region: walked.slice(lastMarker).map((line) => line.raw).join(""),
  };
}

/**
 * True when the last `## Files Changed` heading is a run summary's file list
 * rather than a plan's area heading (decided by what the section holds).
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

/** True when `content` carries a real generated implementation checklist. */
export function hasImplementationChecklistV1(content: string): boolean {
  return (
    scopeToLatestChecklistV1(content).found &&
    itemsInLatestRendering(content).length > 0
  );
}

/**
 * Marks one checklist line as an operator-action/optional/descoped step —
 * port of the extension's `EXCLUDED_CHECKLIST_ITEM_MARKER_V1`. See
 * `src/utils/implementationChecklist.ts` for the full rationale; must match
 * the extension's marker text exactly (parity-tested).
 */
export const EXCLUDED_CHECKLIST_ITEM_MARKER_V1 = "<!-- ensemble:excluded -->";

function isExcludedChecklistItemText(itemText: string): boolean {
  return itemText.trimEnd().endsWith(EXCLUDED_CHECKLIST_ITEM_MARKER_V1);
}

/** Countable state of a plan-of-record checklist. */
export interface ChecklistProgressV1 {
  /** Checklist items in the latest rendering, excluding marked-excluded items. */
  readonly total: number;
  /** Items whose box is ticked, excluding marked-excluded items. */
  readonly checked: number;
  /** `total - checked` — the work the plan still says is outstanding. */
  readonly remaining: number;
  /** Items carrying `EXCLUDED_CHECKLIST_ITEM_MARKER_V1`, counted separately. */
  readonly excluded: number;
}

function itemsInLatestRendering(
  content: string
): { text: string; checked: boolean; excluded: boolean }[] {
  const items: { text: string; checked: boolean; excluded: boolean }[] = [];
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
 * Marked-excluded items are excluded from `total`/`checked` but still count
 * toward "is there a checklist at all" (a plan whose only items are all
 * excluded is a real, if fully out-of-scope, checklist).
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
 * Outcome of {@link mergeChecklistProgressV1} — port of the extension's
 * `MergeChecklistProgressResultV1`. Distinguishes a legitimate no-op
 * ("unchanged"/"no-report") from a round that reported ticks matching
 * nothing in the plan of record ("no-match"), which must be surfaced rather
 * than silently swallowed.
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
 * Apply the checkbox state a round reported in `summary` to `planOfRecord`
 * (port of `mergeChecklistProgressV1`): ticks only (never untick), matched
 * by text and COUNT rather than position, byte-preserving and confined to
 * the latest rendering. Also folds in retroactive-tick claims from the
 * round's own `## Plan Item Checklist` section. See
 * {@link MergeChecklistProgressResultV1}.
 */
export function mergeChecklistProgressV1(
  planOfRecord: string,
  summary: string
): MergeChecklistProgressResultV1 {
  const { echo, own } = splitSummaryAtEchoV1(summary);
  const reported = new Map<string, number>(collectCheckedChecklistCountsV1(echo));

  const reportedRawText = new Map<string, string>();
  for (const item of itemsInLatestRendering(echo)) {
    if (item.checked) {
      const key = normalizeChecklistItemTextV1(item.text);
      if (!reportedRawText.has(key)) {
        reportedRawText.set(key, item.text);
      }
    }
  }

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

  const planKeys = new Set(
    itemsInLatestRendering(planOfRecord).map((item) => normalizeChecklistItemTextV1(item.text))
  );
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

/** A round's self-reported `N/M` plan progress. */
export interface ReviewProgressV1 {
  readonly complete: number;
  readonly total: number;
}

const PROGRESS_MARKER_RE = /<!--\s*progress\s*:\s*(\d+)\s*\/\s*(\d+)\s*-->/gi;

/**
 * Parse the machine-readable `<!-- progress: N/M -->` marker (port of
 * `parseReviewProgress`): the LAST occurrence is authoritative (prompts show
 * worked examples of the marker earlier in a document), and a nonsensical
 * marker (`total` of zero, `complete` past `total`) returns null so callers
 * degrade to pre-marker behavior rather than acting on an untrusted number.
 */
export function parseReviewProgressV1(content: string): ReviewProgressV1 | null {
  const match = [...content.matchAll(PROGRESS_MARKER_RE)].at(-1);
  if (!match) {
    return null;
  }
  const complete = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(complete) || !Number.isInteger(total)) {
    return null;
  }
  if (total <= 0 || complete < 0 || complete > total) {
    return null;
  }
  return { complete, total };
}

/**
 * THE single definition of "this plan still has work left in it" (port of
 * `isPlanIncomplete`). Null/absent progress means completeness is UNKNOWN —
 * reported as "not incomplete" so callers fall back to pre-marker behavior.
 */
export function isPlanIncompleteV1(
  progress: ReviewProgressV1 | null | undefined
): progress is ReviewProgressV1 {
  return progress !== null && progress !== undefined && progress.complete < progress.total;
}

/**
 * Reconcile a round's self-reported `N/M` against the plan of record's own
 * checklist, which is the authority on how much of the plan remains (port of
 * `reconcileProgressWithChecklistV1`). When the plan still lists unchecked
 * items, THOSE numbers win and no reported marker can advance the stage;
 * deliberately asymmetric — a fully ticked checklist does NOT override a
 * marker still reporting work left.
 */
export function reconcileProgressWithChecklistV1(
  progress: ReviewProgressV1 | null,
  checklist: ChecklistProgressV1 | undefined
): ReviewProgressV1 | null {
  if (!checklist || checklist.remaining <= 0) {
    return progress;
  }
  return { complete: checklist.checked, total: checklist.total };
}
