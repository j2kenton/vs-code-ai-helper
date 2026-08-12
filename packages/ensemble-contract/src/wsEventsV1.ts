/**
 * WebSocket event schemas for the notification stream (plan Part 3), built
 * on Part 2 (@ensemble/core) types.
 *
 * Authorization (plan Parts 3/6):
 * - a subscription is authorized at subscribe time with a current
 *   control-plane access token — the contract's ONLY credential; no
 *   provider OAuth token or client-asserted identity is ever accepted;
 * - it is revalidated on reconnect and on token refresh/expiry — the client
 *   re-authenticates before expiry via a `refreshAuth` message carrying a
 *   newly refreshed access token, and an expired or revoked token closes
 *   the subscription;
 * - events are fanned out only for resources the authenticated user owns.
 */
import type { GateStateV1 } from "../../ensemble-core/src/gateV1";
import type { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import type { StructuredQuestionV1 } from "../../ensemble-core/src/structuredQuestionV1";
import type { ChatInteractionTransactionStateV1 } from "../../ensemble-core/src/chatInteractionTransactionV1";

/** Messages the client sends over an established WS connection. */
export type WsClientMessageV1 =
  | {
      /** First message on every connection; authorizes the subscription. */
      readonly type: "subscribe";
      /** Control-plane access token (Part 6 session credential). */
      readonly accessToken: string;
      /** Optional per-task filter; absent = all owned tasks. */
      readonly taskId?: string;
    }
  | {
      /** Re-authentication before token expiry (Part 3 revalidation rule). */
      readonly type: "refreshAuth";
      readonly accessToken: string;
    }
  | { readonly type: "unsubscribe" };

/** Notification-stream payload kinds (plan Part 8's feed renders these). */
export type WsNotificationV1 =
  | {
      readonly kind: "agentLifecycle";
      readonly taskId: string;
      readonly phase: "started" | "progress" | "completed" | "failed";
      readonly detail?: string;
    }
  | {
      /** A gate is pending and needs an approve/reject decision. */
      readonly kind: "gateRequested";
      readonly taskId: string;
      readonly gateId: string;
      readonly summary: string;
    }
  | {
      /** Mirrors the extension's onCandidateSkipped observer semantics. */
      readonly kind: "candidateSkipped";
      readonly taskId: string;
      readonly modelId: string;
      readonly reason: string;
    }
  | {
      /**
       * A crash-recovery attempt could not be proven executed-or-not (Part
       * 4c): it re-enters the gate flow for explicit user re-approval and is
       * never silently re-executed.
       */
      readonly kind: "indeterminateAttempt";
      readonly taskId: string;
      readonly gateId: string;
      readonly attemptKey: string;
    }
  | {
      readonly kind: "error";
      readonly taskId?: string;
      readonly code: string;
      readonly message: string;
    };

/** Events the server pushes to an authorized subscription. */
export type WsServerEventV1 =
  | { readonly type: "subscribed"; readonly userId: string }
  | {
      /** Live task progress (criterion 2), decoded per the Part 2 schema. */
      readonly type: "taskProgress";
      readonly taskId: string;
      readonly progress: PersistedTaskProgressV1;
    }
  | {
      readonly type: "notification";
      readonly notification: WsNotificationV1;
      /** ISO timestamp assigned by the control plane. */
      readonly at: string;
    }
  | {
      /** Structured questions posted by the engine (criterion 4). */
      readonly type: "structuredQuestions";
      readonly taskId: string;
      readonly interactionId: string;
      readonly questions: readonly StructuredQuestionV1[];
    }
  | {
      /** Chat-transaction state changes for the per-task thread (Part 9). */
      readonly type: "chatTransactionState";
      readonly taskId: string;
      readonly interactionId: string;
      readonly state: ChatInteractionTransactionStateV1;
    }
  | {
      readonly type: "gateStateChanged";
      readonly taskId: string;
      readonly gateId: string;
      readonly state: GateStateV1;
    }
  | {
      /** The subscription is closing (expired/revoked token, revoked access). */
      readonly type: "subscriptionClosed";
      readonly reason: "tokenExpired" | "tokenRevoked" | "unauthorized" | "serverShutdown";
    };
