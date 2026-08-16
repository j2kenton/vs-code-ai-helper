/**
 * Provider failure classification (plan Part 4b port of the pure
 * classification layer in `src/utils/quota.ts`).
 *
 * The marker lists and the auth/quota/transport layering are ported
 * verbatim — they encode live-incident lessons (see the extension file's
 * comments) and the cascade gates in `providerDispatchV1.ts` key on exactly
 * these verdicts, so drifting them would silently change which failures may
 * spend a backup allocation.
 *
 * One deliberate difference from `src/utils/quota.ts`: the extension's
 * `classifyFailure` never consults TRANSPORT_MARKERS because it is shared
 * with provider-context-free callers whose diagnostic text may be raw model
 * prose (kiro-cli/codex-cli stdout). The engine's adapters are direct HTTP
 * calls whose failure text is always scoped to the transport/response layer
 * (never model output), so `classifyEngineProviderFailureV1` MAY promote a
 * transport-marker match to "temporarily-unavailable" — the same reasoning
 * `applyTransportTransience` (cliAgentRunner.ts) applies for
 * structured-stream CLI providers. The extension's argv-size marker
 * (`PROVIDER_PROMPT_TOO_LARGE_MARKER`) is not ported: it is generated only
 * by the CLI argv transport, which has no engine counterpart.
 */
import { TaskStage } from "../../ensemble-core/src/taskProgressV1";

export type EngineFailureKindV1 =
  | "quota"
  | "temporarily-unavailable"
  | "model-entitlement"
  | "generic";

// Deliberately excludes a bare "exceeded" marker: real quota phrasing
// already matches via "quota"/"rate limit"/"usage limit"/"session limit",
// while "exceeded" alone would false-positive on unrelated errors like
// "context length exceeded".
const QUOTA_MARKERS = [
  "quota",
  "rate limit",
  "ratelimit",
  "credits",
  "credit limit",
  "usage limit",
  "session limit",
];
const TEMPORARY_MARKERS = [
  "temporarily unavailable",
  "service unavailable",
  "too many requests",
  "try again later",
  "overloaded",
];
// Transport-level failures: the request/stream died in transit rather than
// the service answering with a refusal. Narrow by design (see the extension
// file for why looser phrases are dangerous); engine adapter failure text is
// always transport-scoped, so these are safe to honor here.
const TRANSPORT_MARKERS = [
  "streaming response failed",
  "socket hang up",
  "econnreset",
  "econnaborted",
  "fetch failed",
  "premature close",
];

// Model-entitlement failures (e.g. Bedrock's "anthropic.claude-sonnet-5 is
// not available for this account") are NOT authentication failures: the
// credential is valid and the request reached the provider, which simply
// refuses to serve THIS model id to THIS account. The only remedies are
// switching models or changing the account's entitlement — a different model
// id, which is exactly what a backup model is, is a legitimate fix. The
// discriminator is deliberately this phrasing, never the 401/403 status code
// alone, since genuine credential failures must keep classifying as auth.
// Byte-for-byte port of the extension's MODEL_ENTITLEMENT_MARKERS
// (src/utils/quota.ts) — kept in sync deliberately.
const MODEL_ENTITLEMENT_MARKERS = [
  "is not available for this account",
  "not enabled for this account",
  "does not have access to model",
  "does not have access to the model",
  "not entitled to model",
];

export function isModelEntitlementFailureV1(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return MODEL_ENTITLEMENT_MARKERS.some((marker) => value.includes(marker));
}

/**
 * Authentication failures are terminal for the selected provider — the
 * dispatch cascade must NEVER spend a backup allocation on one. Kept
 * deliberately broad, byte-for-byte the extension's pattern.
 */
export function isAuthenticationFailureV1(message: string | undefined): boolean {
  const value = message ?? "";
  if (/not\s+installed|command\s+not\s+found|could\s+not\s+start\b/i.test(value)) {
    return false;
  }
  // A model-entitlement refusal often also carries "403"/"forbidden" wording
  // that the broad regex below would otherwise match — checked first so
  // entitlement failures never misclassify as auth regardless of which
  // status text accompanies them.
  if (isModelEntitlementFailureV1(value)) {
    return false;
  }
  return /sign[\s-]*in|log(?:ged|ging)?[\s-]*(?:in|out)|session(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|timed?\s*out)|authenticat\w*|authoris\w*|authoriz\w*|credential|re[-\s]?auth\w*|token(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|revoked)|api\s*key|access\s*denied|permission\s*denied|forbidden|unauthori[sz]ed|\b(?:401|403)\b/i.test(
    value
  );
}

/**
 * The failure kinds a backup-model cascade may fire on: the primary is
 * reachable and simply cannot serve this request right now (quota, temporary
 * outage) or cannot serve THIS model id to this account (model-entitlement)
 * — in every case a different model id is a legitimate remedy. "generic"
 * (including auth) is deliberately excluded. Byte-for-byte port of the
 * extension's isCascadeEligibleFailureKind (src/utils/quota.ts).
 */
export function isCascadeEligibleFailureKindV1(
  failureKind: EngineFailureKindV1 | undefined
): boolean {
  return (
    failureKind === "quota" ||
    failureKind === "temporarily-unavailable" ||
    failureKind === "model-entitlement"
  );
}

export function isQuotaErrorV1(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return QUOTA_MARKERS.some((marker) => value.includes(marker));
}

export function isTransportErrorV1(message: string | undefined): boolean {
  const value = (message ?? "").toLowerCase();
  return TRANSPORT_MARKERS.some((marker) => value.includes(marker));
}

export interface EngineProviderFailureV1 {
  readonly errorMessage?: string;
  /** The adapter's own pre-hint auth verdict (e.g. from an HTTP 401/403). */
  readonly authFailure?: boolean;
  /** errorMessage minus any appended remediation hint — the classification-safe form. */
  readonly authDiagnosticText?: string;
}

/**
 * Classify a provider failure into the cascade-gating verdict. Quota first
 * (a rate-limited request whose stream also dropped is a quota event);
 * TEMPORARY/TRANSPORT promotion is gated on the message NOT also being an
 * authentication failure, because the cascade keys on failureKind alone and
 * an auth failure must never cascade. `authDiagnosticText` is preferred over
 * `errorMessage` for the auth check so an appended remediation hint cannot
 * re-confirm the very auth verdict that produced it.
 */
export function classifyEngineProviderFailureV1<T extends EngineProviderFailureV1>(
  result: T
): T & { failureKind: EngineFailureKindV1 } {
  const message = (result.errorMessage ?? "").toLowerCase();
  const isAuth =
    result.authFailure === true ||
    isAuthenticationFailureV1(result.authDiagnosticText ?? result.errorMessage);
  // Checked before the temporary/transport promotion (isAuth above already
  // excludes entitlement phrasing itself — see isAuthenticationFailureV1) so
  // a Bedrock/Vertex-style "not available for this account" message
  // classifies as its own kind rather than falling through to "generic",
  // which would suppress the backup cascade exactly when a different model
  // id is the correct remedy.
  const isEntitlement = isModelEntitlementFailureV1(
    result.authDiagnosticText ?? result.errorMessage
  );
  const failureKind = isQuotaErrorV1(result.errorMessage)
    ? ("quota" as const)
    : isEntitlement
      ? ("model-entitlement" as const)
      : !isAuth &&
          (TEMPORARY_MARKERS.some((m) => message.includes(m)) ||
            isTransportErrorV1(result.errorMessage))
        ? ("temporarily-unavailable" as const)
        : ("generic" as const);
  return { ...result, failureKind };
}

// ─── Session-observed quota status ──────────────────────────────────────────
//
// Port of the extension's honest, session-scoped quota ledger: no provider
// exposes numeric "percent remaining", so the ledger records only what runs
// actually revealed. Factory-scoped (not module-global) because the engine
// is a service that may host many tenants' runs in one process.

export type EngineQuotaStateV1 = "ok" | "exhausted" | "unavailable" | "entitlement-blocked";

export interface EngineQuotaObservationV1 {
  readonly state: EngineQuotaStateV1;
  readonly observedAt: string;
  /** Only present when the provider explicitly reported a percentage. */
  readonly remainingPercent?: number;
}

export interface EngineQuotaObservationLedgerV1 {
  record(
    stage: TaskStage,
    modelId: string | undefined,
    failureKind: EngineFailureKindV1 | undefined,
    errorMessage?: string
  ): void;
  get(stage: TaskStage, modelId: string | undefined): EngineQuotaObservationV1 | undefined;
}

export function createQuotaObservationLedgerV1(
  now: () => Date = () => new Date()
): EngineQuotaObservationLedgerV1 {
  const observations = new Map<string, EngineQuotaObservationV1>();
  const key = (stage: TaskStage, modelId: string | undefined): string =>
    `${stage}::${modelId ?? "(default)"}`;
  return {
    record(stage, modelId, failureKind, errorMessage): void {
      const percentMatch = /(?:remaining|left|available)[^\d]{0,12}(\d{1,3})\s*%/i.exec(
        errorMessage ?? ""
      );
      const parsedPercent = percentMatch ? Number(percentMatch[1]) : undefined;
      observations.set(key(stage, modelId), {
        state:
          failureKind === "quota"
            ? "exhausted"
            : failureKind === "temporarily-unavailable"
              ? "unavailable"
              // A model this account cannot use at all must never read as
              // "OK" — that reading is what previously sent an operator back
              // to the provider's own re-login flow for a problem no
              // re-login can fix.
              : failureKind === "model-entitlement"
                ? "entitlement-blocked"
                : "ok",
        observedAt: now().toISOString(),
        ...(parsedPercent !== undefined && parsedPercent <= 100
          ? { remainingPercent: parsedPercent }
          : {}),
      });
    },
    get(stage, modelId): EngineQuotaObservationV1 | undefined {
      return observations.get(key(stage, modelId));
    },
  };
}
