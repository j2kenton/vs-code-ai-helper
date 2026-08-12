/**
 * Tests for the Part 7 presentation rules: the fallback naming rule (never
 * raw internal folder names), `N/M` round-progress derivation, and the
 * status-badge mapping.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  humanizeTaskFolderNameV1,
  latestRoundProgressV1,
  parseRoundProgressSummaryV1,
  statusBadgeV1,
  taskDisplayNameV1,
} from '../src/tasks/taskPresentationV1';

test('displayName wins when present and non-blank', () => {
  assert.equal(
    taskDisplayNameV1({ displayName: 'ff for 1 pt 2', taskFolder: 'task_4' }),
    'ff for 1 pt 2'
  );
  assert.equal(taskDisplayNameV1({ displayName: '  padded  ', taskFolder: 'task_4' }), 'padded');
});

test('blank or missing displayName falls back to the humanized folder name', () => {
  assert.equal(taskDisplayNameV1({ displayName: '   ', taskFolder: 'task_4' }), 'Task 4');
  assert.equal(taskDisplayNameV1({ taskFolder: 'task_4' }), 'Task 4');
});

test('humanization never shows the raw internal folder form', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2025-12-01_task_1', 'Task 1'],
    ['task_4', 'Task 4'],
    ['fix-login-flow', 'Fix login flow'],
    ['2026-08-12-port_side_panel', 'Port side panel'],
    ['', 'Task'],
    ['___', 'Task'],
  ];
  for (const [folder, expected] of cases) {
    assert.equal(humanizeTaskFolderNameV1(folder), expected, folder);
  }
});

test('round progress summaries parse only the N/M form', () => {
  assert.deepEqual(parseRoundProgressSummaryV1('3/7'), { complete: 3, total: 7 });
  assert.deepEqual(parseRoundProgressSummaryV1(' 12/14 '), { complete: 12, total: 14 });
  assert.equal(parseRoundProgressSummaryV1('round completed'), null);
  assert.equal(parseRoundProgressSummaryV1('3/7 parts'), null);
  assert.equal(parseRoundProgressSummaryV1(undefined), null);
});

test('latestRoundProgressV1 prefers the newest parseable round', () => {
  assert.deepEqual(
    latestRoundProgressV1([
      { summary: '1/7' },
      { summary: '3/7' },
      { summary: 'round completed' },
    ]),
    { complete: 3, total: 7 }
  );
  assert.equal(latestRoundProgressV1([{ summary: 'round completed' }]), null);
  assert.equal(latestRoundProgressV1([]), null);
});

test('status badges map every persisted status; missing means active', () => {
  assert.deepEqual(statusBadgeV1(undefined), { label: 'active', tone: 'accent' });
  assert.deepEqual(statusBadgeV1('active'), { label: 'active', tone: 'accent' });
  assert.deepEqual(statusBadgeV1('creating'), { label: 'creating', tone: 'accent' });
  assert.deepEqual(statusBadgeV1('paused'), { label: 'paused', tone: 'warning' });
  assert.deepEqual(statusBadgeV1('completed'), { label: 'completed', tone: 'success' });
  assert.deepEqual(statusBadgeV1('archived'), { label: 'archived', tone: 'muted' });
  assert.deepEqual(statusBadgeV1('failed'), { label: 'failed', tone: 'danger' });
  assert.deepEqual(statusBadgeV1('something-new'), { label: 'something-new', tone: 'muted' });
});
