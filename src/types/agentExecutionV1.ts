/**
 * V1 agent execution contract (plan §3.2, "Replace output-file runners with
 * bounded result capture").
 *
 * A V1 provider invocation never receives an artifact or result path
 * (AC-RUNNER-01). The broker (`agentExecutionBrokerV1.ts`) — not the runner —
 * creates the bounded output writer, enforces byte limits, seals and hashes
 * the captured result, converts exit state into `RawAgentExecutionResultV1`,
 * and deletes unsealed/overflowed output. Transports (the V1 runner shape)
 * only stream bytes into the writer they are handed and report how the
 * provider exited.
 *
 * Nothing in the extension invokes this contract in production yet: the
 * action coordinator (plan §3.8, executable-order step 6) is the only
 * intended caller, AI routes remain gated (plan §1.3), and the legacy runner
 * boundary rejects V1-correlated requests for unmigrated actions
 * (`legacyAiActionSafetyGateV0.ts`).
 */
import type * as vscode from "vscode";
import { ActionCorrelationV1, ReservationIdV1 } from "./actionCorrelationV1";

export type AgentExecutionModeV1 = "text" | "preflight" | "edit";

/** Normal framed results (text/edit completions) are limited to 4 MiB UTF-8. */
export const MAX_NORMAL_RESPONSE_BYTES_V1 = 4 * 1024 * 1024;
/** Preflight results are limited to 16 MiB. */
export const MAX_PREFLIGHT_RESPONSE_BYTES_V1 = 16 * 1024 * 1024;

/** The absolute response ceiling a request's `maxResponseBytes` may not exceed for its mode. */
export function maxResponseBytesCeilingForModeV1(mode: AgentExecutionModeV1): number {
  return mode === "preflight" ? MAX_PREFLIGHT_RESPONSE_BYTES_V1 : MAX_NORMAL_RESPONSE_BYTES_V1;
}

export interface AgentExecutionRequestV1 {
  readonly correlation: ActionCorrelationV1;
  readonly reservationId: ReservationIdV1;
  readonly mode: AgentExecutionModeV1;
  readonly prompt: string;
  readonly maxResponseBytes: number;
  readonly cancellationToken: vscode.CancellationToken;
}

/**
 * Reference to a coordinator-owned provider result spool. Spools are
 * private, integrity-checked, correlation-bound, claim-once, and expire
 * within 24 hours (plan §3.2); `sha256` is over the raw spooled bytes.
 */
export interface ResultSpoolRefV1 extends ActionCorrelationV1 {
  readonly reservationId: ReservationIdV1;
  readonly storeId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * A sealed provider response: either held in memory (small results) or
 * written to a registered private spool (large results). Both carry the
 * exact raw byte length and SHA-256 so later consumers can verify integrity
 * before decoding the envelope.
 */
export type SealedResultPayloadV1 =
  | {
      readonly storage: "memory";
      readonly utf8Text: string;
      readonly byteLength: number;
      readonly sha256: string;
    }
  | {
      readonly storage: "spool";
      readonly spoolRef: ResultSpoolRefV1;
    };

export type RawAgentExecutionResultV1 =
  | { readonly kind: "response"; readonly payload: SealedResultPayloadV1 }
  | { readonly kind: "providerCancelled" }
  | { readonly kind: "callerCancelled" }
  | {
      readonly kind: "transportFailure";
      readonly code: string;
      /**
       * True when any response bytes had already been captured before the
       * failure. Response-started transport failures are terminal for
       * fallback purposes (plan §3.3: "Fallback is limited to pre-response
       * outcomes") — EXCEPT when `networkFault` is also true (see that
       * field): a dropped connection's bytes are a truncated fragment of a
       * frame that will never complete, not partial model output, so this is
       * forced `false` for a flagged network fault regardless of how many
       * bytes the writer had already buffered (item 14).
       */
      readonly responseStarted: boolean;
      /** Sanitized cause carried through from the transport — see `AgentTransportExitV1`. */
      readonly detail?: string;
      /** Carried through from `AgentTransportExitV1.networkFault` — see its doc comment. */
      readonly networkFault?: boolean;
    }
  | { readonly kind: "overflow" };

/**
 * The bounded output writer the broker hands a transport. `write` returns
 * false once the request's byte limit has been exceeded; from that point the
 * writer is overflowed, all previously buffered output has been discarded,
 * and nothing further is retained.
 */
export interface BoundedResultWriterV1 {
  write(chunk: Uint8Array | string): boolean;
  readonly overflowed: boolean;
  readonly bytesWritten: number;
}

/** How a transport's provider call ended. The broker maps this — plus writer state — into `RawAgentExecutionResultV1`. */
export type AgentTransportExitV1 =
  | { readonly kind: "completed" }
  | { readonly kind: "providerCancelled" }
  | { readonly kind: "callerCancelled" }
  | {
      readonly kind: "transportFailure";
      readonly code: string;
      /**
       * Sanitized, bounded description of what actually went wrong, when the
       * transport knows it.
       *
       * Optional because not every exit has more to say than its code — but a
       * transport that catches a thrown error MUST populate it. Two sites
       * previously used a bare `catch {}`, discarding the error object
       * entirely, so `copilotRequestFailed` reached the user with no
       * recoverable cause: prompt too large, quota, and a transient API fault
       * were indistinguishable, each with a different remedy. Diagnosing one
       * such failure on 2026-08-16 required reading four source files and
       * still ended in a guess.
       *
       * Sanitized per §2.2: a short message, never headers, payload, or key
       * material — see `boundedTransportDetailV1`.
       */
      readonly detail?: string;
      /**
       * True when the transport has classified this failure as a
       * transport-level network fault (a dropped HTTP/2 connection,
       * connection reset/abort, DNS failure, TLS handshake failure) rather
       * than the provider answering with a refusal or partial content
       * (item 14). This is an explicit signal the transport itself declares
       * — see `classifyNetworkFaultV1` — never inferred by the broker from
       * how many bytes had already streamed in. A network fault's bytes are
       * a truncated frame fragment, not partial model output: the broker
       * treats a flagged failure as fallback-eligible (pre-response) even
       * when bytes were already written, and discards them unsealed.
       */
      readonly networkFault?: boolean;
    };

/**
 * Redaction patterns for `boundedTransportDetailV1`. Unlike
 * `boundedDiagnosticDetailV1` in taskActionCoordinatorV1.ts — which only ever
 * flattens OUR OWN generated diagnostic text — this function's input is
 * whatever a caught `Error` from a provider SDK or CLI actually says, which
 * can echo request headers, an Authorization value, an API key embedded in a
 * URL, or an absolute path into this machine's private extension storage.
 * Each pattern below replaces the secret/private span with a fixed
 * placeholder so the shape of the message (still useful for diagnosing
 * quota/payload-limit causes) survives while the value does not.
 */
const REDACTION_PATTERNS_V1: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  // A provider SDK/CLI error can echo the raw request or response body it
  // choked on, including a full envelope between our own frame markers.
  // Strip it (terminated or not — an unterminated opening marker means the
  // rest of the message IS the raw payload) before anything else runs, so
  // truncation below is a backstop, not the only guard against a raw
  // provider/prompt payload reaching a sanitized outcome.
  {
    pattern: /<<<ENSEMBLE_AI_RESULT_V1>>>[\s\S]*?(?:<<<END_ENSEMBLE(?:_AI)?_RESULT_V1>>>|$)/g,
    replacement: "[redacted-content]",
  },
  // Fenced Markdown code blocks (terminated or not) can likewise carry a
  // full echoed prompt or response body.
  { pattern: /```[\s\S]*?(?:```|$)/g, replacement: "[redacted-content]" },
  // Authorization/Bearer header values.
  { pattern: /\b(bearer|authorization)\s*:?\s*[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1: [redacted]" },
  // Common API-key-shaped tokens (sk-…, ghp_…, xox…, long hex/base64 runs after a known prefix).
  { pattern: /\b(sk|pk|ghp|gho|ghu|ghs|ghr|xox[abpsu])-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted-token]" },
  { pattern: /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{4,}/gi, replacement: "$1=[redacted]" },
  // Credential-bearing URIs: scheme://user:pass@host
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: "$1[redacted]@" },
  // Windows private user/app-storage paths.
  {
    pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\(?:AppData|\.vscode|\.claude)[^\s"']*/g,
    replacement: "[redacted-path]",
  },
  // POSIX private home/app-storage paths.
  { pattern: /\/(?:home|Users)\/[^/\s]+\/(?:\.[^/\s]+|Library)[^\s"']*/g, replacement: "[redacted-path]" },
];

function redactSensitiveContentV1(text: string): string {
  return REDACTION_PATTERNS_V1.reduce(
    (acc, { pattern, replacement }) => acc.replace(pattern, replacement),
    text
  );
}

/**
 * Replace C0/C1 control characters (other than tab/newline/carriage-return,
 * which the caller's whitespace collapse already normalizes to a space) and
 * DEL with a space. Written as an explicit code-point scan rather than a
 * regex control-character class so the source contains no raw control bytes
 * or hex/unicode escape sequences to keep in sync.
 */
function stripOtherControlCharsV1(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isTabOrNewline = code === 9 || code === 10 || code === 13;
    const isControl = (code <= 31 && !isTabOrNewline) || code === 127;
    result += isControl ? " " : ch;
  }
  return result;
}

/**
 * Flatten a caught error into a short, single-line, secret-redacted cause
 * for `transportFailure.detail`.
 *
 * Takes `unknown` since every call site is a `catch` binding. Strips control
 * characters and collapses whitespace so the result is always one readable
 * line, redacts credential/token/URI/private-path shapes per
 * `REDACTION_PATTERNS_V1` before bounding, and enforces `maxChars` in UTF-16
 * code units (bounded well under any storage/render limit, so a surrogate
 * pair split at the cap is not a correctness concern here).
 */
export function boundedTransportDetailV1(error: unknown, maxChars = 200): string | undefined {
  const raw =
    error instanceof Error
      ? // A distinctive `name` (TypeError, AbortError, a provider SDK's own
        // error class, …) is useful classification the plain message loses —
        // keep it, but only when it adds information: the generic "Error"
        // name is what every plain `new Error(...)` already carries and
        // would just be noise prepended to every existing detail.
        error.name && error.name !== "Error"
        ? `${error.name}: ${error.message}`
        : error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : String(error);
  const withoutControlChars = stripOtherControlCharsV1(raw);
  const flattened = redactSensitiveContentV1(withoutControlChars.replace(/\s+/g, " ").trim());
  if (flattened.length === 0) {
    return undefined;
  }
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

/**
 * Node/undici error codes that mean "the pipe broke", not "the server
 * refused". Matched against a caught `Error`'s own `.code` property (never
 * its message), so this is a structural check, not a text heuristic.
 */
const NETWORK_FAULT_ERROR_CODES_V1 = [
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
];
/** Prefixes of Node's TLS/SSL error codes (e.g. `ERR_TLS_CERT_ALTNAME_INVALID`). */
const NETWORK_FAULT_ERROR_CODE_PREFIXES_V1 = ["ERR_TLS_", "ERR_SSL_"];

/**
 * Message substrings for network-level faults reported as plain text rather
 * than a Node error code — chiefly Chromium/Electron's `net::ERR_*` family,
 * which is exactly what VS Code's Language Model API surfaces for a dropped
 * or failed connection (item 14's observed
 * `net::ERR_HTTP2_PROTOCOL_ERROR`). Deliberately narrow (see the sibling
 * `TRANSPORT_MARKERS` in `utils/quota.ts` for the same discipline): each
 * entry names a specific fault class, never a vague phrase like "network
 * error" that could appear in an unrelated echoed payload.
 */
const NETWORK_FAULT_MESSAGE_MARKERS_V1 = [
  "net::err_http2",
  "net::err_connection",
  "net::err_ssl",
  "net::err_cert",
  "net::err_name_not_resolved",
  "net::err_timed_out",
  "net::err_socket_not_connected",
  "net::err_network_changed",
  "net::err_tunnel_connection_failed",
  "net::err_address_unreachable",
  "socket hang up",
];

/**
 * True when `error` is a transport-level network fault — a dropped HTTP/2
 * connection, connection reset/abort, DNS failure, or TLS handshake failure
 * — as opposed to the provider answering (even with a refusal or partial
 * content). Item 14: this is a property of the pipe, not of the answer, so a
 * caller uses it to decide whether captured bytes may be trusted as partial
 * output or must be discarded as a truncated frame fragment.
 *
 * Deliberately narrow and structural where possible (`.code` first, then a
 * short, specific message-marker list) — the same discipline
 * `isTransportError`/`TRANSPORT_MARKERS` in `utils/quota.ts` documents for
 * why a broad text heuristic is unsafe here: an opaque provider's error text
 * can otherwise echo unrelated content.
 */
export function classifyNetworkFaultV1(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0) {
      const upper = code.toUpperCase();
      if (
        NETWORK_FAULT_ERROR_CODES_V1.includes(upper) ||
        NETWORK_FAULT_ERROR_CODE_PREFIXES_V1.some((prefix) => upper.startsWith(prefix))
      ) {
        return true;
      }
    }
  }
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).toLowerCase();
  if (message.length === 0) {
    return false;
  }
  return NETWORK_FAULT_MESSAGE_MARKERS_V1.some((marker) => message.includes(marker));
}

/**
 * The V1 runner surface: stream the provider's framed result into the
 * broker-owned writer and report the exit state. A transport receives no
 * artifact destination, no result path, and no filesystem authority from
 * this contract.
 */
export interface AgentTransportV1 {
  readonly runnerId: string;
  invoke(
    request: AgentExecutionRequestV1,
    output: BoundedResultWriterV1
  ): Promise<AgentTransportExitV1>;
}
