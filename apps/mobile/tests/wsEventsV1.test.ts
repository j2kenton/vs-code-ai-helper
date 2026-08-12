/**
 * Structural-decoder tests for inbound WS frames: every contract event kind
 * decodes, and malformed frames decode to null (dropped whole, never
 * partially rendered).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeWsServerEventV1 } from '../src/events/wsEventsV1';

const QUESTION = {
  questionId: 'q1',
  kind: 'singleChoice',
  prompt: 'Deploy?',
  required: true,
  options: [
    { optionId: 'yes', label: 'Yes' },
    { optionId: 'no', label: 'No' },
  ],
};

test('every contract event kind decodes to its typed shape', () => {
  const events = [
    { type: 'subscribed', userId: 'user-1' },
    { type: 'taskProgress', taskId: 't1', progress: { ensembleProgressVersion: 1 } },
    {
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'gateRequested', taskId: 't1', gateId: 'g1', summary: 'Apply diff' },
    },
    {
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'agentLifecycle', taskId: 't1', phase: 'started' },
    },
    {
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'candidateSkipped', taskId: 't1', modelId: 'm', reason: 'quota' },
    },
    {
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'indeterminateAttempt', taskId: 't1', gateId: 'g1', attemptKey: 'ak' },
    },
    {
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'error', code: 'boom', message: 'it broke' },
    },
    { type: 'structuredQuestions', taskId: 't1', interactionId: 'i1', questions: [QUESTION] },
    { type: 'chatTransactionState', taskId: 't1', interactionId: 'i1', state: 'answered' },
    { type: 'gateStateChanged', taskId: 't1', gateId: 'g1', state: 'approved' },
    { type: 'subscriptionClosed', reason: 'tokenExpired' },
  ];
  for (const raw of events) {
    const decoded = decodeWsServerEventV1(raw);
    assert.notEqual(decoded, null, `expected ${JSON.stringify(raw)} to decode`);
    assert.equal(decoded?.type, raw.type);
  }
});

test('unknown event types and non-objects decode to null', () => {
  assert.equal(decodeWsServerEventV1({ type: 'somethingNew', payload: 1 }), null);
  assert.equal(decodeWsServerEventV1('subscribe'), null);
  assert.equal(decodeWsServerEventV1(null), null);
  assert.equal(decodeWsServerEventV1([{ type: 'subscribed', userId: 'u' }]), null);
});

test('a malformed notification rejects the whole frame', () => {
  assert.equal(
    decodeWsServerEventV1({
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'gateRequested', taskId: 't1' },
    }),
    null
  );
  assert.equal(
    decodeWsServerEventV1({
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'agentLifecycle', taskId: 't1', phase: 'exploded' },
    }),
    null
  );
});

test('a malformed question list rejects the whole structuredQuestions frame', () => {
  assert.equal(
    decodeWsServerEventV1({
      type: 'structuredQuestions',
      taskId: 't1',
      interactionId: 'i1',
      questions: [QUESTION, { questionId: 'q2', kind: 'mystery', prompt: 'x', required: true }],
    }),
    null
  );
  assert.equal(
    decodeWsServerEventV1({ type: 'structuredQuestions', taskId: 't1', interactionId: 'i1', questions: [] }),
    null
  );
});

test('an out-of-enum close reason decodes to null', () => {
  assert.equal(decodeWsServerEventV1({ type: 'subscriptionClosed', reason: 'because' }), null);
});
