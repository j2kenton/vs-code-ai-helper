/**
 * Push-policy tests: gate-approval payload mapping with deep links,
 * native-only platform gating (web feed is the source of truth), and the
 * deep-link round trip the notification tap handler will use.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createUnavailablePushDriverV1,
  gateDeepLinkV1,
  gatePushForEventV1,
  isPushPlatformV1,
  parseGateDeepLinkV1,
  presentGatePushV1,
  type GatePushV1,
} from '../src/events/pushNotificationsV1';
import type { WsServerEventV1 } from '../src/events/wsEventsV1';

const GATE_EVENT: WsServerEventV1 = {
  type: 'notification',
  at: '2026-08-12T09:00:00.000Z',
  notification: { kind: 'gateRequested', taskId: 't 1', gateId: 'g/1', summary: 'Apply the diff' },
};

test('gateRequested and indeterminateAttempt map to pushes; nothing else does', () => {
  const gatePush = gatePushForEventV1(GATE_EVENT);
  assert.equal(gatePush?.title, 'Gate approval requested');
  assert.equal(gatePush?.body, 'Apply the diff');
  assert.equal(gatePush?.deepLink, 'ensemble://tasks/t%201/gates/g%2F1');

  const reOffer = gatePushForEventV1({
    type: 'notification',
    at: '2026-08-12T09:00:00.000Z',
    notification: { kind: 'indeterminateAttempt', taskId: 't1', gateId: 'g2', attemptKey: 'ak' },
  });
  assert.equal(reOffer?.title, 'Attempt needs re-approval');
  assert.equal(reOffer?.deepLink, gateDeepLinkV1('t1', 'g2'));

  assert.equal(
    gatePushForEventV1({
      type: 'notification',
      at: '2026-08-12T09:00:00.000Z',
      notification: { kind: 'agentLifecycle', taskId: 't1', phase: 'completed' },
    }),
    null
  );
  assert.equal(gatePushForEventV1({ type: 'gateStateChanged', taskId: 't1', gateId: 'g1', state: 'approved' }), null);
});

test('the deep link round-trips through the parser, including encoded ids', () => {
  const link = gateDeepLinkV1('t 1', 'g/1');
  assert.deepEqual(parseGateDeepLinkV1(link), { taskId: 't 1', gateId: 'g/1' });
  assert.equal(parseGateDeepLinkV1('ensemble://tasks/t1'), null);
  assert.equal(parseGateDeepLinkV1('https://evil.example/tasks/t1/gates/g1'), null);
});

test('pushes are native-only: ios/android present, web and others do not', () => {
  assert.equal(isPushPlatformV1('ios'), true);
  assert.equal(isPushPlatformV1('android'), true);
  assert.equal(isPushPlatformV1('web'), false);
  assert.equal(isPushPlatformV1('windows'), false);
});

test('presentGatePushV1 presents exactly when platform and event both qualify', async () => {
  const presented: GatePushV1[] = [];
  const driver = { present: (push: GatePushV1): Promise<void> => (presented.push(push), Promise.resolve()) };

  assert.equal(await presentGatePushV1(driver, 'ios', GATE_EVENT), true);
  assert.equal(presented.length, 1);

  assert.equal(await presentGatePushV1(driver, 'web', GATE_EVENT), false);
  assert.equal(
    await presentGatePushV1(driver, 'ios', { type: 'subscribed', userId: 'u' }),
    false
  );
  assert.equal(presented.length, 1);
});

test('the unavailable driver is a resolving no-op', async () => {
  const driver = createUnavailablePushDriverV1();
  await driver.present({ title: 't', body: 'b', deepLink: gateDeepLinkV1('t1', 'g1') });
});
