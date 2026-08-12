/**
 * Chat live-refresh mapping tests (plan Part 9 polish): exactly the events
 * that can change a task's chat transcript or gate list trigger a refresh
 * for that task, and nothing else does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatRefreshTaskIdV1 } from '../src/events/chatRefreshV1';

test('gate and chat-transaction events refresh their task', () => {
  assert.equal(
    chatRefreshTaskIdV1({
      type: 'notification',
      at: '2026-08-12T00:00:00.000Z',
      notification: { kind: 'gateRequested', taskId: 'task-1', gateId: 'gate-1', summary: 'review' },
    }),
    'task-1'
  );
  assert.equal(
    chatRefreshTaskIdV1({ type: 'gateStateChanged', taskId: 'task-2', gateId: 'g', state: 'approved' }),
    'task-2'
  );
  assert.equal(
    chatRefreshTaskIdV1({
      type: 'chatTransactionState',
      taskId: 'task-3',
      interactionId: 'i-1',
      state: 'completed',
    }),
    'task-3'
  );
});

test('events that cannot change the transcript do not trigger a refresh', () => {
  assert.equal(chatRefreshTaskIdV1({ type: 'subscribed', userId: 'u' }), null);
  assert.equal(
    chatRefreshTaskIdV1({ type: 'taskProgress', taskId: 'task-1', progress: {} }),
    null
  );
  assert.equal(
    chatRefreshTaskIdV1({
      type: 'notification',
      at: '2026-08-12T00:00:00.000Z',
      notification: { kind: 'agentLifecycle', taskId: 'task-1', phase: 'progress' },
    }),
    null
  );
  assert.equal(chatRefreshTaskIdV1({ type: 'subscriptionClosed', reason: 'tokenExpired' }), null);
});
