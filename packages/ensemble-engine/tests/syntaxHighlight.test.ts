/**
 * Server-side highlighter tests (plan Part 10): the tokenizer must emit
 * spans in the shared closed vocabulary that are always well-formed
 * (sorted, non-overlapping, in bounds), be deterministic, and fall back to
 * NO spans — never an error — for unknown languages and oversized files.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { areTokenSpansWellFormedV1, isTokenSpanV1 } from "../../ensemble-contract/src/tokenSpanV1";
import { HIGHLIGHT_MAX_CHARS_V1, highlightTokenSpansV1 } from "../src/syntaxHighlightV1";

function scopesAt(text: string, language: string): Array<[string, string]> {
  return highlightTokenSpansV1(text, language).map((span) => [
    text.slice(span.start, span.end),
    span.scope,
  ]);
}

test("typescript: keywords, strings, comments, numbers — spans well-formed", () => {
  const text = 'export const app = 1; // answer\nconst s = "hi";\n/* block\nspans lines */\nlet t = `tpl`;\n';
  const spans = highlightTokenSpansV1(text, "typescript");
  assert.ok(areTokenSpansWellFormedV1(spans, text.length));
  assert.ok(spans.every((span) => isTokenSpanV1(span)));
  const tokens = scopesAt(text, "typescript");
  assert.deepEqual(tokens, [
    ["export", "keyword"],
    ["const", "keyword"],
    ["1", "number"],
    ["// answer", "comment"],
    ["const", "keyword"],
    ['"hi"', "string"],
    ["/* block\nspans lines */", "comment"],
    ["let", "keyword"],
    ["`tpl`", "string"],
  ]);
});

test("typescript: quotes and comment markers inside strings do not open new tokens", () => {
  const text = 'const a = "not // a comment";\nconst b = \'it\\\'s\';\n';
  const tokens = scopesAt(text, "typescript");
  assert.deepEqual(tokens, [
    ["const", "keyword"],
    ['"not // a comment"', "string"],
    ["const", "keyword"],
    ["'it\\'s'", "string"],
  ]);
});

test("json: keys are properties, values are strings/numbers/literals", () => {
  const text = '{\n  "name": "app",\n  "count": 3,\n  "on": true,\n  "none": null\n}\n';
  const spans = highlightTokenSpansV1(text, "json");
  assert.ok(areTokenSpansWellFormedV1(spans, text.length));
  assert.deepEqual(scopesAt(text, "json"), [
    ['"name"', "property"],
    ['"app"', "string"],
    ['"count"', "property"],
    ["3", "number"],
    ['"on"', "property"],
    ["true", "literal"],
    ['"none"', "property"],
    ["null", "literal"],
  ]);
});

test("python: hash comments, triple-quoted strings, keywords", () => {
  const text = 'def go():\n    """doc\n    string"""\n    return None  # done\n';
  const spans = highlightTokenSpansV1(text, "python");
  assert.ok(areTokenSpansWellFormedV1(spans, text.length));
  assert.deepEqual(scopesAt(text, "python"), [
    ["def", "keyword"],
    ['"""doc\n    string"""', "string"],
    ["return", "keyword"],
    ["None", "keyword"],
    ["# done", "comment"],
  ]);
});

test("markdown: headings, fenced code, inline code", () => {
  const text = "# Title\n\nSome `inline` text.\n```ts\nconst x = 1;\n```\n";
  const spans = highlightTokenSpansV1(text, "markdown");
  assert.ok(areTokenSpansWellFormedV1(spans, text.length));
  assert.deepEqual(scopesAt(text, "markdown"), [
    ["# Title", "heading"],
    ["`inline`", "string"],
    ["```ts", "literal"],
    ["const x = 1;", "literal"],
    ["```", "literal"],
  ]);
});

test("css and html emit their family scopes", () => {
  const css = "/* base */\n.card { color: #fff; margin: 4px; }\n";
  const cssSpans = highlightTokenSpansV1(css, "css");
  assert.ok(areTokenSpansWellFormedV1(cssSpans, css.length));
  assert.deepEqual(scopesAt(css, "css"), [
    ["/* base */", "comment"],
    ["color", "property"],
    ["margin", "property"],
    ["4px", "number"],
  ]);

  const html = '<!-- note --><div class="row">x</div>';
  const htmlSpans = highlightTokenSpansV1(html, "html");
  assert.ok(areTokenSpansWellFormedV1(htmlSpans, html.length));
  assert.deepEqual(scopesAt(html, "html"), [
    ["<!-- note -->", "comment"],
    ["<div", "tag"],
    ['"row"', "string"],
    ["</div", "tag"],
  ]);
});

test("fallbacks: unknown language, empty text, oversized file → no spans, no error", () => {
  assert.deepEqual(highlightTokenSpansV1("const a = 1;", undefined), []);
  assert.deepEqual(highlightTokenSpansV1("const a = 1;", "cobol"), []);
  assert.deepEqual(highlightTokenSpansV1("", "typescript"), []);
  const oversized = "x".repeat(HIGHLIGHT_MAX_CHARS_V1 + 1);
  assert.deepEqual(highlightTokenSpansV1(oversized, "typescript"), []);
});

test("determinism: identical input yields identical spans", () => {
  const text = 'import { a } from "./a";\nexport function f(): number { return 42; }\n';
  const first = highlightTokenSpansV1(text, "typescript");
  const second = highlightTokenSpansV1(text, "typescript");
  assert.deepEqual(first, second);
});
