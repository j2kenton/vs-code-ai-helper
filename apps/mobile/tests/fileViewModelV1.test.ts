/**
 * File-viewer render model tests (plan Part 10): server token spans become
 * per-line segments; malformed spans are dropped individually (the file
 * always renders); spans crossing newlines split per line.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCodeLinesV1, sanitizeTokenSpansV1 } from '../src/files/fileViewModelV1';

test('segments a highlighted line with plain gaps between spans', () => {
  const text = 'export const app = 1;\n';
  const lines = buildCodeLinesV1(text, [
    { start: 0, end: 6, scope: 'keyword' },
    { start: 7, end: 12, scope: 'keyword' },
    { start: 19, end: 20, scope: 'number' },
  ]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    number: 1,
    segments: [
      { text: 'export', scope: 'keyword' },
      { text: ' ' },
      { text: 'const', scope: 'keyword' },
      { text: ' app = ' },
      { text: '1', scope: 'number' },
      { text: ';' },
    ],
  });
});

test('a span crossing newlines contributes its intersection to every line', () => {
  const text = 'a\n/* two\nlines */\nb\n';
  const lines = buildCodeLinesV1(text, [{ start: 2, end: 17, scope: 'comment' }]);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[1]?.segments, [{ text: '/* two', scope: 'comment' }]);
  assert.deepEqual(lines[2]?.segments, [{ text: 'lines */', scope: 'comment' }]);
  assert.deepEqual(lines[3]?.segments, [{ text: 'b' }]);
});

test('no spans → whole lines as single unstyled segments; empty lines render', () => {
  const lines = buildCodeLinesV1('one\n\ntwo\n', undefined);
  assert.deepEqual(
    lines.map((line) => line.segments),
    [[{ text: 'one' }], [{ text: '' }], [{ text: 'two' }]]
  );
  assert.deepEqual(lines.map((line) => line.number), [1, 2, 3]);
});

test('sanitize drops malformed spans individually and keeps the rest', () => {
  const kept = sanitizeTokenSpansV1(
    [
      { start: 5, end: 3, scope: 'keyword' }, // inverted
      { start: -1, end: 2, scope: 'keyword' }, // negative
      { start: 0.5, end: 2, scope: 'keyword' }, // non-integer
      { start: 0, end: 99, scope: 'keyword' }, // out of bounds
      { start: 0, end: 3, scope: 'keyword' }, // valid
      { start: 2, end: 6, scope: 'string' }, // overlaps the valid one
      { start: 4, end: 6, scope: 'string' }, // valid
    ],
    10
  );
  assert.deepEqual(kept, [
    { start: 0, end: 3, scope: 'keyword' },
    { start: 4, end: 6, scope: 'string' },
  ]);
});

test('unknown scopes survive sanitization (rendered unstyled downstream)', () => {
  const text = 'abc';
  const lines = buildCodeLinesV1(text, [{ start: 0, end: 3, scope: 'rainbow' }]);
  assert.deepEqual(lines[0]?.segments, [{ text: 'abc', scope: 'rainbow' }]);
});

test('a trailing newline does not produce a phantom final line', () => {
  assert.equal(buildCodeLinesV1('one\ntwo\n', []).length, 2);
  assert.equal(buildCodeLinesV1('one\ntwo', []).length, 2);
  assert.equal(buildCodeLinesV1('', []).length, 1);
});
