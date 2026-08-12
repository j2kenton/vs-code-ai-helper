/**
 * Client-side mirror of the Part 3 WebSocket event contract
 * (`packages/ensemble-contract/src/wsEventsV1.ts`), plus a structural
 * decoder for inbound frames. Mirrored rather than imported for the same
 * reason as the REST DTOs: the app cannot declare `workspace:*` dependencies
 * until the dependency-install round. The decoder is the app's trust
 * boundary for stream data — an unrecognized or malformed frame decodes to
 * `null` and is dropped, never partially rendered.
 */
import { decodeQuestionListV1, type StructuredQuestionV1 } from '../chat/structuredQuestionsV1';

/** Messages the client sends over an established WS connection. */
export type WsClientMessageV1 =
  | { readonly type: 'subscribe'; readonly accessToken: string; readonly taskId?: string }
  | { readonly type: 'refreshAuth'; readonly accessToken: string }
  | { readonly type: 'unsubscribe' };

export type WsNotificationV1 =
  | {
      readonly kind: 'agentLifecycle';
      readonly taskId: string;
      readonly phase: 'started' | 'progress' | 'completed' | 'failed';
      readonly detail?: string;
    }
  | { readonly kind: 'gateRequested'; readonly taskId: string; readonly gateId: string; readonly summary: string }
  | { readonly kind: 'candidateSkipped'; readonly taskId: string; readonly modelId: string; readonly reason: string }
  | {
      readonly kind: 'indeterminateAttempt';
      readonly taskId: string;
      readonly gateId: string;
      readonly attemptKey: string;
    }
  | { readonly kind: 'error'; readonly taskId?: string; readonly code: string; readonly message: string };

export type WsServerEventV1 =
  | { readonly type: 'subscribed'; readonly userId: string }
  | { readonly type: 'taskProgress'; readonly taskId: string; readonly progress: Record<string, unknown> }
  | { readonly type: 'notification'; readonly notification: WsNotificationV1; readonly at: string }
  | {
      readonly type: 'structuredQuestions';
      readonly taskId: string;
      readonly interactionId: string;
      readonly questions: readonly StructuredQuestionV1[];
    }
  | {
      readonly type: 'chatTransactionState';
      readonly taskId: string;
      readonly interactionId: string;
      /** Opaque to the client; displayed, never branched on. */
      readonly state: string;
    }
  | { readonly type: 'gateStateChanged'; readonly taskId: string; readonly gateId: string; readonly state: string }
  | {
      readonly type: 'subscriptionClosed';
      readonly reason: 'tokenExpired' | 'tokenRevoked' | 'unauthorized' | 'serverShutdown';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LIFECYCLE_PHASES = new Set(['started', 'progress', 'completed', 'failed']);
const CLOSE_REASONS = new Set(['tokenExpired', 'tokenRevoked', 'unauthorized', 'serverShutdown']);

function decodeNotification(raw: unknown): WsNotificationV1 | null {
  if (!isRecord(raw)) {
    return null;
  }
  switch (raw.kind) {
    case 'agentLifecycle':
      if (
        typeof raw.taskId !== 'string' ||
        typeof raw.phase !== 'string' ||
        !LIFECYCLE_PHASES.has(raw.phase) ||
        (raw.detail !== undefined && typeof raw.detail !== 'string')
      ) {
        return null;
      }
      return {
        kind: 'agentLifecycle',
        taskId: raw.taskId,
        phase: raw.phase as 'started' | 'progress' | 'completed' | 'failed',
        ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      };
    case 'gateRequested':
      if (typeof raw.taskId !== 'string' || typeof raw.gateId !== 'string' || typeof raw.summary !== 'string') {
        return null;
      }
      return { kind: 'gateRequested', taskId: raw.taskId, gateId: raw.gateId, summary: raw.summary };
    case 'candidateSkipped':
      if (typeof raw.taskId !== 'string' || typeof raw.modelId !== 'string' || typeof raw.reason !== 'string') {
        return null;
      }
      return { kind: 'candidateSkipped', taskId: raw.taskId, modelId: raw.modelId, reason: raw.reason };
    case 'indeterminateAttempt':
      if (typeof raw.taskId !== 'string' || typeof raw.gateId !== 'string' || typeof raw.attemptKey !== 'string') {
        return null;
      }
      return { kind: 'indeterminateAttempt', taskId: raw.taskId, gateId: raw.gateId, attemptKey: raw.attemptKey };
    case 'error':
      if (
        typeof raw.code !== 'string' ||
        typeof raw.message !== 'string' ||
        (raw.taskId !== undefined && typeof raw.taskId !== 'string')
      ) {
        return null;
      }
      return {
        kind: 'error',
        code: raw.code,
        message: raw.message,
        ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      };
    default:
      return null;
  }
}

/** Decode one inbound frame; `null` means "drop it", never "render part of it". */
export function decodeWsServerEventV1(raw: unknown): WsServerEventV1 | null {
  if (!isRecord(raw)) {
    return null;
  }
  switch (raw.type) {
    case 'subscribed':
      return typeof raw.userId === 'string' ? { type: 'subscribed', userId: raw.userId } : null;
    case 'taskProgress':
      if (typeof raw.taskId !== 'string' || !isRecord(raw.progress)) {
        return null;
      }
      return { type: 'taskProgress', taskId: raw.taskId, progress: raw.progress };
    case 'notification': {
      if (typeof raw.at !== 'string') {
        return null;
      }
      const notification = decodeNotification(raw.notification);
      return notification === null ? null : { type: 'notification', notification, at: raw.at };
    }
    case 'structuredQuestions': {
      if (typeof raw.taskId !== 'string' || typeof raw.interactionId !== 'string') {
        return null;
      }
      const questions = decodeQuestionListV1(raw.questions);
      return questions === null
        ? null
        : { type: 'structuredQuestions', taskId: raw.taskId, interactionId: raw.interactionId, questions };
    }
    case 'chatTransactionState':
      if (
        typeof raw.taskId !== 'string' ||
        typeof raw.interactionId !== 'string' ||
        typeof raw.state !== 'string'
      ) {
        return null;
      }
      return {
        type: 'chatTransactionState',
        taskId: raw.taskId,
        interactionId: raw.interactionId,
        state: raw.state,
      };
    case 'gateStateChanged':
      if (typeof raw.taskId !== 'string' || typeof raw.gateId !== 'string' || typeof raw.state !== 'string') {
        return null;
      }
      return { type: 'gateStateChanged', taskId: raw.taskId, gateId: raw.gateId, state: raw.state };
    case 'subscriptionClosed':
      if (typeof raw.reason !== 'string' || !CLOSE_REASONS.has(raw.reason)) {
        return null;
      }
      return {
        type: 'subscriptionClosed',
        reason: raw.reason as 'tokenExpired' | 'tokenRevoked' | 'unauthorized' | 'serverShutdown',
      };
    default:
      return null;
  }
}
