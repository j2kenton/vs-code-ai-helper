/**
 * Token/key redaction for log output (plan Part 11).
 *
 * The engine and control plane never PLACE secrets in log lines by design —
 * outcome codes carry "never payloads, never key material", and the provider
 * adapters scrub the API key out of every error message at the source. This
 * module is the mandatory second line of defense: every log sink in engine
 * or control-plane composition is wrapped by `createRedactingLogSinkV1`, so
 * a future call site that accidentally interpolates a bearer header, a
 * session token, or key material into a diagnostic line emits a redacted
 * form, never the secret.
 *
 * What is redacted:
 * - `Authorization`-style scheme credentials (`Bearer <...>`, `Basic <...>`,
 *   `token <...>`).
 * - Secret-bearing field assignments in JSON-ish or query-ish text —
 *   `"accessToken": "..."`, `refreshToken=...`, `key: '...'` — for the
 *   closed list of field names below.
 * - Known credential shapes by prefix: `sk-`/`pk-` API keys, GitHub `ghp_`/
 *   `gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_` tokens, `e2b_` keys, Google
 *   `AIza...` keys, Slack `xox?-` tokens, and three-part JWTs (`eyJ...`).
 *
 * Deliberately NOT redacted: bare lowercase-hex identifiers. Attempt keys,
 * task ids, and gate ids are 64-hex observability data the audit trail
 * depends on; they are derived via SHA-256 from non-secret identifiers and
 * carry no credential value.
 */

const REDACTED_V1 = "[REDACTED]";

/** Field names whose assigned values are always redacted (case-insensitive). */
const SECRET_FIELD_NAMES_V1 = [
  "accessToken",
  "refreshToken",
  "idToken",
  "sessionToken",
  "authorizationCode",
  "codeVerifier",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "key",
  "secret",
  "password",
  "authorization",
  "cookie",
  "set-cookie",
  "token",
].join("|");

const SECRET_PATTERNS_V1: readonly RegExp[] = [
  // Scheme credentials: Bearer/Basic/token followed by the credential blob.
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  // Field assignments: "name": "value", name=value, name: 'value'.
  new RegExp(
    `(["']?)\\b(${SECRET_FIELD_NAMES_V1})\\b\\1\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\])]+)`,
    "gi"
  ),
  // Known credential shapes by prefix.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\be2b_[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g,
  // Three-part JWTs.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g,
];

/** Redact every recognized secret shape in one line of log text. */
export function redactSecretsV1(text: string): string {
  let redacted = text;
  const [scheme, field, ...shapes] = SECRET_PATTERNS_V1;
  redacted = redacted.replace(scheme as RegExp, (_match, name: string) => `${name} ${REDACTED_V1}`);
  redacted = redacted.replace(
    field as RegExp,
    (_match, quote: string, name: string) => `${quote}${name}${quote}: ${REDACTED_V1}`
  );
  for (const pattern of shapes) {
    redacted = redacted.replace(pattern, REDACTED_V1);
  }
  return redacted;
}

/** A destination for one already-formatted log line. */
export type EngineLogSinkV1 = (line: string) => void;

/**
 * Wrap a raw sink so every line passes `redactSecretsV1` first. This is the
 * only sanctioned way to hand a log sink into engine or control-plane
 * composition — callers receive the wrapped sink, never the raw one.
 */
export function createRedactingLogSinkV1(sink: EngineLogSinkV1): EngineLogSinkV1 {
  return (line: string): void => sink(redactSecretsV1(line));
}
