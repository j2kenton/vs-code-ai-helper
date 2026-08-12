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

export type EngineFailureKindV1 = "quota" | "temporarily-unavailable" | "generic";

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
  return /sign[\s-]*in|log(?:ged|ging)?[\s-]*(?:in|out)|session(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|timed?\s*out)|authenticat\w*|authoris\w*|authoriz\w*|credential|re[-\s]?auth\w*|token(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|revoked)|api\s*key|access\s*denied|permission\s*denied|forbidden|unauthori[sz]ed|\b(?:401|403)\b/i.test(
    value
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
  const failureKind = isQuotaErrorV1(result.errorMessage)
    ? ("quota" as const)
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

export type EngineQuotaStateV1 = "ok" | "exhausted" | "unavailable";

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
