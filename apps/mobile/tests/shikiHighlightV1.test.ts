/**
 * Client-side Shiki highlighting tests (plan Part 10, web target). Imports
 * the `.web.ts` module directly by its explicit path — Node's `node --test`
 * runner has no RN platform-extension resolution, so the bare specifier
 * `../src/files/shikiHighlightV1` would hit the native no-op instead. This
 * exercises the real `shiki` package (dynamic `import()`, the pure-JS regex
 * engine, no WASM asset) end to end, not a mock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightWithShikiV1 } from '../src/files/shikiHighlightV1.web';
import { buildCodeLinesV1 } from '../src/files/fileViewModelV1';

test('tokenizes TypeScript into the shared span shape with keyword/string/comment/number scopes', async () => {
  const text = "// note\nconst greeting: string = 'hi';\nconst n = 42;\n";
  const spans = await highlightWithShikiV1(text, 'typescript');
  assert.ok(spans !== undefined);

  for (const span of spans) {
    assert.ok(Number.isInteger(span.start) && span.start >= 0);
    assert.ok(Number.isInteger(span.end) && span.end > span.start);
    assert.ok(span.end <= text.length);
    assert.equal(text.slice(span.start, span.end).length > 0, true);
  }

  const scopes = new Set(spans.map((s) => s.scope));
  assert.ok(scopes.has('comment'), `expected a comment span, got scopes ${[...scopes].join(',')}`);
  assert.ok(scopes.has('keyword'), `expected a keyword span, got scopes ${[...scopes].join(',')}`);
  assert.ok(scopes.has('string'), `expected a string span, got scopes ${[...scopes].join(',')}`);
  assert.ok(scopes.has('number'), `expected a number span, got scopes ${[...scopes].join(',')}`);

  // The spans must be usable by the same render pipeline the server's spans
  // feed — this is the whole point of sharing one schema.
  const lines = buildCodeLinesV1(text, spans);
  assert.equal(lines.length, 3);
  const reassembled = lines.map((line) => line.segments.map((seg) => seg.text).join('')).join('\n');
  assert.equal(reassembled, text.replace(/\n$/, ''));
});

test('tags a markdown heading line with the heading scope', async () => {
  const text = '# Title\n\nBody text.\n';
  const spans = await highlightWithShikiV1(text, 'markdown');
  assert.ok(spans !== undefined);
  const headingSpans = spans.filter((s) => s.scope === 'heading');
  assert.ok(headingSpans.length > 0, 'expected heading-scoped spans for the "# Title" line');
  const titleSpan = headingSpans.find((s) => text.slice(s.start, s.end).includes('Title'));
  assert.ok(titleSpan !== undefined, 'expected a heading-scoped span covering "Title"');
});

test('returns undefined for unsupported languages so callers fall back to server spans', async () => {
  assert.equal(await highlightWithShikiV1('SELECT 1;', 'sql'), undefined);
  assert.equal(await highlightWithShikiV1('anything', undefined), undefined);
});

test('returns undefined for empty text', async () => {
  assert.equal(await highlightWithShikiV1('', 'typescript'), undefined);
});
