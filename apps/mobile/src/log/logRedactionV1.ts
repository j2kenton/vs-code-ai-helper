/**
 * Token/key redaction for app diagnostics (plan Part 11) — the mobile twin
 * of the engine package's `logRedactionV1` (the app is deliberately
 * standalone and does not import workspace packages; the two modules are
 * kept semantically identical and both covered by tests).
 *
 * The app never intentionally logs secrets: sandbox/model keys go straight
 * to the control plane and session tokens live only in the token store.
 * Every diagnostic line still passes through here (see `appLogV1.ts`) so an
 * accidental interpolation of a bearer header, session token, or key
 * material is redacted, never recorded.
 *
 * Deliberately NOT redacted: bare lowercase-hex identifiers (task ids, gate
 * ids, attempt keys) — observability data with no credential value.
 */

const REDACTED_V1 = '[REDACTED]';

/** Field names whose assigned values are always redacted (case-insensitive). */
const SECRET_FIELD_NAMES_V1 = [
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'authorizationCode',
  'codeVerifier',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'key',
  'secret',
  'password',
  'authorization',
  'cookie',
  'set-cookie',
  'token',
].join('|');

const SCHEME_PATTERN_V1 = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

const FIELD_PATTERN_V1 = new RegExp(
  `(["']?)\\b(${SECRET_FIELD_NAMES_V1})\\b\\1\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\])]+)`,
  'gi'
);

const SHAPE_PATTERNS_V1: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\be2b_[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g,
];

/** Redact every recognized secret shape in one line of diagnostic text. */
export function redactSecretsV1(text: string): string {
  let redacted = text.replace(SCHEME_PATTERN_V1, (_match, name: string) => `${name} ${REDACTED_V1}`);
  redacted = redacted.replace(
    FIELD_PATTERN_V1,
    (_match, quote: string, name: string) => `${quote}${name}${quote}: ${REDACTED_V1}`
  );
  for (const pattern of SHAPE_PATTERNS_V1) {
    redacted = redacted.replace(pattern, REDACTED_V1);
  }
  return redacted;
}
