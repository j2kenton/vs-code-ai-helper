/**
 * App diagnostic-log tests (plan Part 11): every entry is redacted BEFORE
 * storage or sink delivery, the ring is capped, and the redaction rules
 * match the engine module's semantics (secrets stripped, hex observability
 * ids preserved).
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  clearAppLogV1,
  logAppEventV1,
  readAppLogV1,
  setAppLogSinkV1,
  type AppLogEntryV1,
} from '../src/log/appLogV1';
import { redactSecretsV1 } from '../src/log/logRedactionV1';

beforeEach(() => {
  clearAppLogV1();
  setAppLogSinkV1(undefined);
});

test('secrets are redacted before storage AND before the sink sees the entry', () => {
  const sinkEntries: AppLogEntryV1[] = [];
  setAppLogSinkV1((entry) => sinkEntries.push(entry));

  logAppEventV1('exchange failed: authorization: Bearer sess-token-abc123XYZ', '2026-08-12T00:00:00.000Z');
  logAppEventV1('submitted {"key": "e2b_live_material_123"} for sandbox:e2b');

  const stored = readAppLogV1();
  assert.equal(stored.length, 2);
  assert.equal(sinkEntries.length, 2);
  for (const entries of [stored, sinkEntries]) {
    const joined = entries.map((entry) => entry.line).join('\n');
    assert.ok(!joined.includes('sess-token-abc123XYZ'), joined);
    assert.ok(!joined.includes('e2b_live_material_123'), joined);
    assert.ok(joined.includes('[REDACTED]'), joined);
    assert.ok(joined.includes('sandbox:e2b'), 'non-secret context survives');
  }
  assert.equal(stored[0]?.at, '2026-08-12T00:00:00.000Z');
});

test('the ring is capped: oldest entries fall off, newest are retained', () => {
  for (let i = 0; i < 230; i++) {
    logAppEventV1(`event ${i}`);
  }
  const entries = readAppLogV1();
  assert.equal(entries.length, 200);
  assert.equal(entries[0]?.line, 'event 30');
  assert.equal(entries[entries.length - 1]?.line, 'event 229');
});

test('redaction semantics: credential shapes stripped, hex observability ids preserved', () => {
  const attemptKey = 'f'.repeat(64);
  const line = `gate re-offer for attempt ${attemptKey} after ghp_SECRETTOKEN1234 leaked into a message`;
  const redacted = redactSecretsV1(line);
  assert.ok(redacted.includes(attemptKey), 'attempt keys are observability data');
  assert.ok(!redacted.includes('ghp_SECRETTOKEN1234'), redacted);

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
  assert.ok(!redactSecretsV1(`token was ${jwt}`).includes(jwt));
  assert.equal(redactSecretsV1('plain diagnostic line'), 'plain diagnostic line');
});
