/**
 * Unified-diff render model tests (plan Part 10): row classification for the
 * gate-review diff viewer, file-name extraction, and the empty-diff state.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDiffRowsV1, diffFileNamesV1 } from '../src/files/diffViewModelV1';

const DIFF = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' unchanged',
  '-const a = 1;',
  '+const a = 2;',
  '\\ No newline at end of file',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export {};',
  '',
].join('\n');

test('classifies every unified-diff row kind', () => {
  const rows = buildDiffRowsV1(DIFF);
  assert.deepEqual(
    rows.map((row) => row.kind),
    [
      'file',
      'file',
      'hunk',
      'context',
      'remove',
      'add',
      'meta',
      'file',
      'file',
      'hunk',
      'add',
    ]
  );
  // `---`/`+++` headers classify as file, never as remove/add.
  assert.equal(rows[0]?.text, '--- a/src/app.ts');
  assert.equal(rows[4]?.text, '-const a = 1;');
});

test('extracts changed file names from +++ headers, skipping /dev/null', () => {
  const rows = buildDiffRowsV1(DIFF);
  assert.deepEqual(diffFileNamesV1(rows), ['src/app.ts', 'src/new.ts']);
});

test('an empty diff yields no rows (the explicit empty state)', () => {
  assert.deepEqual(buildDiffRowsV1(''), []);
});

test('row keys are stable and unique', () => {
  const rows = buildDiffRowsV1(DIFF);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});
