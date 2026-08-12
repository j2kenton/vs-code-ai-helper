/**
 * Idempotent gate/answer command identity (plan Parts 3 and 9).
 *
 * The contract requires the CLIENT to generate a gate decision's idempotency
 * key — hex-32, unique per (authenticated owner, target gate) — and to retry
 * ONLY with the same key and an identical payload, so a flaky connection can
 * never double-approve. This module makes that rule structural: a decision
 * request is created ONCE as a frozen payload, and the UI resubmits that
 * same object on retry. The same generator serves the chat contract's
 * `answerIdempotencyId` (also hex-32).
 */

/** Injectable byte source for tests; production prefers WebCrypto. */
export type RandomBytesV1 = (byteCount: number) => Uint8Array;

function defaultRandomBytes(byteCount: number): Uint8Array {
  const bytes = new Uint8Array(byteCount);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues !== undefined) {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  // Idempotency keys are collision-avoidance identifiers, not secrets: on
  // the rare platform without WebCrypto this fallback still satisfies the
  // contract's uniqueness-per-(owner, gate) expectation.
  for (let index = 0; index < byteCount; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** A 32-char lowercase hex id matching the contract's `^[0-9a-f]{32}$`. */
export function randomHex32V1(randomBytes: RandomBytesV1 = defaultRandomBytes): string {
  const bytes = randomBytes(16);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export interface GateDecisionRequestV1 {
  readonly decision: 'approve' | 'reject';
  readonly idempotencyKey: string;
  readonly comment?: string;
}

/**
 * Create the decision payload exactly once per user decision. Retries MUST
 * resubmit this same frozen object — a changed payload under the same key
 * surfaces the contract's typed `gateDecisionPayloadMismatch`.
 */
export function createGateDecisionRequestV1(
  decision: 'approve' | 'reject',
  comment?: string,
  randomBytes?: RandomBytesV1
): GateDecisionRequestV1 {
  const trimmed = comment?.trim() ?? '';
  return Object.freeze({
    decision,
    idempotencyKey: randomHex32V1(randomBytes),
    ...(trimmed.length > 0 ? { comment: trimmed } : {}),
  });
}
