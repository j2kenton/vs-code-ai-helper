/**
 * Feed-model tests: event→entry mapping for every plan Part 8 kind,
 * newest-first accumulation with the cap, and per-task filtering.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendFeedEntryV1,
  feedEntryFromServerEventV1,
  filterFeedByTaskV1,
  nextFeedEntryIdV1,
  type FeedEntryV1,
} from '../src/events/notificationFeedV1';
import type { WsNotificationV1, WsServerEventV1 } from '../src/events/wsEventsV1';

const AT = '2026-08-12T09:00:00.000Z';
const RECEIVED = '2026-08-12T09:00:01.000Z';

function notification(payload: WsNotificationV1): WsServerEventV1 {
  return { type: 'notification', notification: payload, at: AT };
}

test('every plan feed kind maps to a titled entry with its gate/task links', () => {
  const gate = feedEntryFromServerEventV1(
    notification({ kind: 'gateRequested', taskId: 't1', gateId: 'g1', summary: 'Apply the diff' }),
    RECEIVED,
    'id-1'
  );
  assert.deepEqual(gate, {
    id: 'id-1',
    at: AT,
    kind: 'gateRequested',
    title: 'Gate approval requested',
    detail: 'Apply the diff',
    taskId: 't1',
    gateId: 'g1',
  });

  const lifecycle = feedEntryFromServerEventV1(
    notification({ kind: 'agentLifecycle', taskId: 't1', phase: 'failed', detail: 'provider quota' }),
    RECEIVED,
    'id-2'
  );
  assert.equal(lifecycle?.title, 'Agent run failed');
  assert.equal(lifecycle?.detail, 'provider quota');

  const skipped = feedEntryFromServerEventV1(
    notification({ kind: 'candidateSkipped', taskId: 't1', modelId: 'claude-sonnet-5', reason: 'quota' }),
    RECEIVED,
    'id-3'
  );
  assert.equal(skipped?.title, 'Candidate skipped: claude-sonnet-5');

  const indeterminate = feedEntryFromServerEventV1(
    notification({ kind: 'indeterminateAttempt', taskId: 't1', gateId: 'g2', attemptKey: 'ak-1' }),
    RECEIVED,
    'id-4'
  );
  assert.equal(indeterminate?.kind, 'indeterminateAttempt');
  assert.equal(indeterminate?.gateId, 'g2');
  assert.match(indeterminate?.detail ?? '', /ak-1/);
  assert.match(indeterminate?.detail ?? '', /will not re-execute/);

  const error = feedEntryFromServerEventV1(
    notification({ kind: 'error', code: 'sandboxUnreachable', message: 'timeout' }),
    RECEIVED,
    'id-5'
  );
  assert.equal(error?.title, 'Error: sandboxUnreachable');
  assert.equal(error?.taskId, undefined);
});

test('gate state changes join the feed stamped with receipt time', () => {
  const entry = feedEntryFromServerEventV1(
    { type: 'gateStateChanged', taskId: 't1', gateId: 'g1', state: 'approved' },
    RECEIVED,
    'id-6'
  );
  assert.deepEqual(entry, {
    id: 'id-6',
    at: RECEIVED,
    kind: 'gateStateChanged',
    title: 'Gate approved',
    taskId: 't1',
    gateId: 'g1',
  });
});

test('progress, chat, and subscription frames do not enter the feed', () => {
  const skipped: WsServerEventV1[] = [
    { type: 'subscribed', userId: 'u' },
    { type: 'taskProgress', taskId: 't1', progress: {} },
    { type: 'structuredQuestions', taskId: 't1', interactionId: 'i1', questions: [] },
    { type: 'chatTransactionState', taskId: 't1', interactionId: 'i1', state: 'answered' },
    { type: 'subscriptionClosed', reason: 'serverShutdown' },
  ];
  for (const event of skipped) {
    assert.equal(feedEntryFromServerEventV1(event, RECEIVED, 'x'), null);
  }
});

test('appending is newest-first and trims at the cap', () => {
  let entries: readonly FeedEntryV1[] = [];
  for (let index = 0; index < 5; index += 1) {
    entries = appendFeedEntryV1(
      entries,
      { id: `id-${index}`, at: AT, kind: 'error', title: `entry ${index}` },
      3
    );
  }
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['id-4', 'id-3', 'id-2']
  );
});

test('filtering by task keeps only that task; null means everything', () => {
  const entries: readonly FeedEntryV1[] = [
    { id: '1', at: AT, kind: 'error', title: 'a', taskId: 't1' },
    { id: '2', at: AT, kind: 'error', title: 'b', taskId: 't2' },
    { id: '3', at: AT, kind: 'error', title: 'c' },
  ];
  assert.deepEqual(filterFeedByTaskV1(entries, 't1').map((entry) => entry.id), ['1']);
  assert.equal(filterFeedByTaskV1(entries, null).length, 3);
});

test('feed-entry ids are unique per session', () => {
  const first = nextFeedEntryIdV1();
  const second = nextFeedEntryIdV1();
  assert.notEqual(first, second);
});
