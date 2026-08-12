/**
 * The shared token-span schema (plan Part 10).
 *
 * One schema serves both highlighting paths: the engine/control plane
 * tokenizes server-side and relays these spans to the native client for
 * virtualized text rendering, and a web client that highlights locally must
 * emit the same shape. Offsets index into the file's UTF-16 text exactly as
 * served by `getFile` (start inclusive, end exclusive), and the scope
 * vocabulary is CLOSED — the OpenAPI `TokenSpan.scope` enum and this list
 * are the same set (pinned by tests/contract.test.ts), so server and clients
 * can never drift on scope names. Clients must treat an unknown scope as
 * unstyled text, never as an error.
 */

export const TOKEN_SPAN_SCOPES_V1 = [
  "comment",
  "keyword",
  "string",
  "number",
  "literal",
  "property",
  "tag",
  "heading",
] as const;

export type TokenSpanScopeV1 = (typeof TOKEN_SPAN_SCOPES_V1)[number];

export interface TokenSpanV1 {
  /** Inclusive UTF-16 offset into the served file text. */
  readonly start: number;
  /** Exclusive UTF-16 offset; always greater than `start`. */
  readonly end: number;
  readonly scope: TokenSpanScopeV1;
}

export function isTokenSpanScopeV1(value: unknown): value is TokenSpanScopeV1 {
  return (
    typeof value === "string" && (TOKEN_SPAN_SCOPES_V1 as readonly string[]).includes(value)
  );
}

export function isTokenSpanV1(value: unknown): value is TokenSpanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const span = value as { start?: unknown; end?: unknown; scope?: unknown };
  return (
    typeof span.start === "number" &&
    Number.isInteger(span.start) &&
    span.start >= 0 &&
    typeof span.end === "number" &&
    Number.isInteger(span.end) &&
    span.end > span.start &&
    isTokenSpanScopeV1(span.scope)
  );
}

/**
 * Whether a span list is well-formed against a text of the given length:
 * every span valid, in bounds, sorted by start, and non-overlapping. This is
 * the invariant the server tokenizer guarantees and renderers may rely on.
 */
export function areTokenSpansWellFormedV1(
  spans: readonly TokenSpanV1[],
  textLength: number
): boolean {
  let previousEnd = 0;
  for (const span of spans) {
    if (!isTokenSpanV1(span) || span.start < previousEnd || span.end > textLength) {
      return false;
    }
    previousEnd = span.end;
  }
  return true;
}
