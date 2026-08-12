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

/** Item-identity text: must match the extension's key exactly (parity-tested). */
export function normalizeChecklistItemTextV1(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
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

/** Countable state of a plan-of-record checklist. */
export interface ChecklistProgressV1 {
  /** Checklist items in the latest rendering. */
  readonly total: number;
  /** Items whose box is ticked. */
  readonly checked: number;
  /** `total - checked` — the work the plan still says is outstanding. */
  readonly remaining: number;
}

function itemsInLatestRendering(
  content: string
): { text: string; checked: boolean }[] {
  const items: { text: string; checked: boolean }[] = [];
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

/** Count the plan of record's checklist, or `undefined` when it carries none. */
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
 * Apply the checkbox state a round reported in `summary` to `planOfRecord`
 * (port of `mergeChecklistProgressV1`): ticks only (never untick), matched
 * by text and COUNT rather than position, byte-preserving and confined to
 * the latest rendering. Returns the updated document, or `undefined` when
 * nothing changed.
 */
export function mergeChecklistProgressV1(
  planOfRecord: string,
  summary: string
): string | undefined {
  const reported = collectCheckedChecklistCountsV1(splitSummaryAtEchoV1(summary).echo);
  if (reported.size === 0) {
    return undefined;
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
