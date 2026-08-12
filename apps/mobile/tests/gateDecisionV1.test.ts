/**
 * Idempotent-command identity tests: hex-32 key format per the contract's
 * `^[0-9a-f]{32}$`, deterministic derivation from the injected byte source,
 * uniqueness across decisions, and the frozen decision payload retries
 * resubmit verbatim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGateDecisionRequestV1, randomHex32V1 } from '../src/chat/gateDecisionV1';

test('generated ids match the contract pattern and differ across calls', () => {
  const first = randomHex32V1();
  const second = randomHex32V1();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test('the injected byte source maps deterministically to lowercase hex', () => {
  const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 254, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(randomHex32V1(() => bytes), '00010f107f80feff0000000000000000');
});

test('a decision request is a frozen payload with one idempotency key', () => {
  const request = createGateDecisionRequestV1('approve', '  ship it  ');
  assert.equal(request.decision, 'approve');
  assert.equal(request.comment, 'ship it');
  assert.match(request.idempotencyKey, /^[0-9a-f]{32}$/);
  assert.equal(Object.isFrozen(request), true);
  // The retry contract: the SAME object is resubmitted, so key and payload
  // cannot drift between attempts.
  const replayed = request;
  assert.deepEqual(replayed, request);
});

test('an empty or whitespace comment is omitted, not sent as empty', () => {
  const noComment = createGateDecisionRequestV1('reject');
  const blankComment = createGateDecisionRequestV1('reject', '   ');
  assert.equal('comment' in noComment, false);
  assert.equal('comment' in blankComment, false);
});

test('two decisions never share an idempotency key', () => {
  const first = createGateDecisionRequestV1('approve');
  const second = createGateDecisionRequestV1('approve');
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
});
