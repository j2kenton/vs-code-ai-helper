/**
 * Shared structural parsing for the Markdown documents the workflow reads back
 * from providers — implementation summaries and the plan of record.
 *
 * Consolidated deliberately. Fence tracking and heading detection were each
 * implemented twice (once for the summary shape gate, once for checklist
 * scoping), and every defect in them was found and fixed at one site while the
 * other kept the bug: a fence whose close was not recognized, a heading form
 * that was not enumerated, a marker matched as a bare substring. One
 * definition means a fix lands everywhere it belongs.
 */

/**
 * Every line with its terminator preserved, flagged for whether it sits inside
 * a fenced code block.
 *
 * Keeping the raw text lets callers rewrite a single character on one line and
 * leave every other byte — including mixed line endings — exactly as found.
 */
export function walkLinesV1(
  content: string
): { text: string; raw: string; fenced: boolean }[] {
  const parts = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const walked: { text: string; raw: string; fenced: boolean }[] = [];
  let fence: string | undefined;
  for (const raw of parts) {
    const text = raw.replace(/\r?\n$/, "");
    // Indent is part of match[0] and excluded from match[1]: a legally
    // indented fence must be closed by slicing the whole match, or the block
    // never closes and everything after it is treated as code.
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
  /** 1–6 for `#`–`######`; Setext `===` is 1 and `---` is 2. */
  readonly level: number;
  readonly line: number;
}

/**
 * Every heading in `content`, ignoring anything inside a fenced block.
 *
 * ONE parser for heading structure rather than a per-section regex that has to
 * spell out which forms are legal. Enumerating forms produced a false
 * rejection for indented fences, then another for closed ATX headings
 * (`## Files Changed ##`) — each stamping a contract-satisfying round unusable.
 * Parsing the structure once and comparing the TITLE means an
 * unanticipated-but-valid heading style is parsed, not rejected.
 *
 * Covers ATX at any level, with any legal indent and optional closing hashes,
 * plus Setext (`Files Changed` underlined by `===`/`---`). The Setext branch
 * excludes list items so a `- item` above a `---` thematic break is not read
 * as a heading.
 */
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
      // Trailing hashes close a heading only when whitespace-separated;
      // `## C#` is a title ending in a hash, not a closed heading.
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

/**
 * Index of the LAST heading whose title matches `text`, or -1.
 *
 * Last, not first, because a response legitimately contains headings that are
 * not its own: the required checklist echo reproduces the plan of record,
 * which `create-implementation.md` makes end with a "Verification" section, so
 * the summary's own sections come after the echoed ones.
 */
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

/**
 * True when the section under heading `index` carries at least one line of
 * real content before the next heading.
 *
 * This is the structural form of "the response is only prose": the failure
 * this guards was a round reporting ON work instead of reporting work, and an
 * empty required section is that same thing wearing the right headings.
 * Deliberately NOT detected by language — "still running", "not yet reached",
 * "still outstanding" all appear in fully compliant summaries, because
 * `run-implementation.md` REQUIRES a staged round to say which items it did
 * not reach. A keyword blacklist would reject exactly the summaries the
 * staged-delivery design depends on.
 */
export function sectionHasContentV1(
  content: string,
  all: readonly MarkdownHeadingV1[],
  index: number
): boolean {
  const lines = walkLinesV1(content);
  const heading = all[index];
  const start = (heading?.line ?? -1) + 1;
  // A section ends at the next heading of the SAME OR HIGHER level, not at the
  // next heading of any level. Treating every heading as a boundary meant a
  // summary that groups its entries under child headings — `## Files Changed`,
  // then `### Source`, then the list — scanned zero lines and was stamped
  // unusable while containing exactly the required detail. Subsections are
  // part of their parent section.
  let next = lines.length;
  for (let h = index + 1; h < all.length; h++) {
    const candidate = all[h];
    if (candidate && candidate.level <= (heading?.level ?? 1)) {
      next = candidate.line;
      break;
    }
  }
  // Nested headings delimit content; they are not content themselves. A
  // `## Files Changed` whose only line is an empty `### Source` still lists no
  // files, so counting the subheading as substance would let a hollow section
  // pass merely for being structured.
  const headingLines = new Set(all.map((entry) => entry.line));
  for (let i = start; i < next; i++) {
    const text = (lines[i]?.text ?? "").trim();
    // A Setext underline belongs to its heading, not to this section.
    if (text.length === 0 || headingLines.has(i) || /^(=+|-+)$/.test(text)) {
      continue;
    }
    return true;
  }
  return false;
}
