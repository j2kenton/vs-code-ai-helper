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
       * outcomes").
       */
      readonly responseStarted: boolean;
      /** Sanitized cause carried through from the transport — see `AgentTransportExitV1`. */
      readonly detail?: string;
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
    };

/**
 * Flatten a caught error into a short, single-line cause for
 * `transportFailure.detail`.
 *
 * Mirrors `boundedDiagnosticDetailV1` in taskActionCoordinatorV1.ts — same
 * flatten-and-cap discipline, kept here because this is where the field it
 * fills is declared and because a transport should not have to import from
 * the action coordinator to report its own failure. Takes `unknown` since
 * every call site is a `catch` binding.
 */
export function boundedTransportDetailV1(error: unknown, maxChars = 200): string | undefined {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : String(error);
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) {
    return undefined;
  }
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
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
