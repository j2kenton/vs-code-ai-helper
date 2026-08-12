/**
 * Read-only file-viewer render model (plan Part 10).
 *
 * Turns served file text plus the server's pre-tokenized spans (the shared
 * token-span schema) into per-line segment lists the native client renders
 * as virtualized text. The client treats the stream as untrusted display
 * data: malformed spans (non-integer offsets, empty or inverted ranges,
 * out-of-bounds ends, overlaps) are DROPPED individually — the file always
 * renders, at worst with less highlighting. Unknown scopes are kept and
 * rendered unstyled by the scope→color map, per the contract's
 * forward-compatibility rule.
 */
import type { TokenSpanDtoV1 } from '../api/controlPlaneClientV1';

export interface CodeSegmentV1 {
  readonly text: string;
  /** Highlight scope, or undefined for unstyled text between spans. */
  readonly scope?: string;
}

export interface CodeLineV1 {
  /** 1-based line number (the viewer's gutter). */
  readonly number: number;
  readonly segments: readonly CodeSegmentV1[];
}

/**
 * Keep only spans that are well-formed against the text and mutually
 * non-overlapping, sorted by start. First-wins on overlap after sorting, so
 * one bad span cannot shadow the rest of the file.
 */
export function sanitizeTokenSpansV1(
  spans: readonly TokenSpanDtoV1[] | undefined,
  textLength: number
): TokenSpanDtoV1[] {
  if (spans === undefined) {
    return [];
  }
  const valid = spans.filter(
    (span) =>
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= textLength &&
      typeof span.scope === 'string'
  );
  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: TokenSpanDtoV1[] = [];
  let previousEnd = 0;
  for (const span of valid) {
    if (span.start >= previousEnd) {
      kept.push(span);
      previousEnd = span.end;
    }
  }
  return kept;
}

/**
 * Split the text into lines of render segments. Spans may cross newlines
 * (block comments, template strings): each line receives its intersection.
 */
export function buildCodeLinesV1(
  text: string,
  spans: readonly TokenSpanDtoV1[] | undefined
): CodeLineV1[] {
  const clean = sanitizeTokenSpansV1(spans, text.length);
  const lines: CodeLineV1[] = [];
  let lineStart = 0;
  let spanIndex = 0;
  let lineNumber = 1;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    const segments: CodeSegmentV1[] = [];
    let cursor = lineStart;
    // Skip spans that ended before this line.
    while (spanIndex < clean.length && (clean[spanIndex] as TokenSpanDtoV1).end <= lineStart) {
      spanIndex += 1;
    }
    for (let i = spanIndex; i < clean.length; i += 1) {
      const span = clean[i] as TokenSpanDtoV1;
      if (span.start >= lineEnd) {
        break;
      }
      const from = Math.max(span.start, lineStart);
      const to = Math.min(span.end, lineEnd);
      if (from > cursor) {
        segments.push({ text: text.slice(cursor, from) });
      }
      if (to > from) {
        segments.push({ text: text.slice(from, to), scope: span.scope });
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < lineEnd) {
      segments.push({ text: text.slice(cursor, lineEnd) });
    }
    if (segments.length === 0) {
      segments.push({ text: '' });
    }
    lines.push({ number: lineNumber, segments });
    if (lineEnd === text.length) {
      break;
    }
    lineStart = lineEnd + 1;
    lineNumber += 1;
  }
  // A trailing newline produces a final empty line; drop it so the viewer
  // matches what editors show.
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last !== undefined && last.segments.length === 1 && last.segments[0]?.text === '') {
    lines.pop();
  }
  return lines;
}
