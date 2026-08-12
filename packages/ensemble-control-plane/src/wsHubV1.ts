/**
 * WebSocket subscription hub (plan Part 5): authorization + fan-out of
 * engine events to clients, per the Part 3 WS contract (wsEventsV1).
 *
 * Transport-agnostic by design: a connection is a `send` callback plus a
 * message handler, so the same hub drives the real RFC6455 upgrade
 * (`wsTransportV1.ts`, attached at the node adapter) and the in-process
 * tests. The SEMANTICS the contract requires all live here:
 *
 * - the FIRST message must be `subscribe` with a current access token; the
 *   subscription is authorized at subscribe time against the Part 6 session
 *   service — never client-asserted identity;
 * - an optional `taskId` filter is authorized against task OWNERSHIP at
 *   subscribe time (a task the user does not own reads as unauthorized);
 * - `refreshAuth` re-authenticates before expiry with a newly refreshed
 *   access token; a token resolving to a DIFFERENT user, or an
 *   expired/revoked token, closes the subscription;
 * - every delivery re-validates the subscription's current token
 *   (revalidated on token refresh/expiry, as the contract requires) and
 *   closes with `tokenExpired`/`tokenRevoked` when it no longer authorizes;
 * - events fan out ONLY to subscriptions whose authenticated user owns the
 *   event's resource — cross-user delivery is structurally impossible
 *   because publication is keyed by owner.
 */
import type {
  WsClientMessageV1,
  WsServerEventV1,
} from "../../ensemble-contract/src/wsEventsV1";
import type { EngineEventSinkV1, EngineEventV1 } from "../../ensemble-engine/src/engineEventsV1";
import type { SessionServiceV1 } from "./sessionServiceV1";
import type { ControlPlaneStoreV1 } from "./storeV1";

export interface WsHubConnectionV1 {
  handleMessage(message: WsClientMessageV1): Promise<void>;
  /** Established at subscribe; undefined until then / after close. */
  readonly userId: string | undefined;
  readonly closed: boolean;
}

export interface WsHubV1 {
  connect(send: (event: WsServerEventV1) => void): WsHubConnectionV1;
  /** Fan one event out to the owner's live, still-authorized subscriptions. */
  publishToOwner(ownerUserId: string, event: WsServerEventV1): Promise<void>;
  /** An engine event sink that relays into the owner's subscriptions. */
  createEngineSink(ownerUserId: string): EngineEventSinkV1;
}

interface HubConnectionStateV1 {
  send: (event: WsServerEventV1) => void;
  userId?: string;
  accessToken?: string;
  taskId?: string;
  closed: boolean;
}

/** The task an event belongs to, for per-task subscription filters. */
function eventTaskId(event: WsServerEventV1): string | undefined {
  if (event.type === "notification") {
    return "taskId" in event.notification ? event.notification.taskId : undefined;
  }
  if ("taskId" in event && typeof event.taskId === "string") {
    return event.taskId;
  }
  return undefined;
}

export function createWsHubV1(options: {
  readonly sessions: SessionServiceV1;
  readonly store: ControlPlaneStoreV1;
}): WsHubV1 {
  const { sessions, store } = options;
  const connections = new Set<HubConnectionStateV1>();

  function close(
    state: HubConnectionStateV1,
    reason: "tokenExpired" | "tokenRevoked" | "unauthorized" | "serverShutdown"
  ): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.send({ type: "subscriptionClosed", reason });
    connections.delete(state);
  }

  async function handle(state: HubConnectionStateV1, message: WsClientMessageV1): Promise<void> {
    if (state.closed) {
      return;
    }
    if (message.type === "subscribe") {
      const identity = await sessions.authenticate(message.accessToken);
      if (identity === undefined) {
        close(state, "unauthorized");
        return;
      }
      if (message.taskId !== undefined) {
        const task = store.readTask(message.taskId);
        if (task === undefined || task.ownerUserId !== identity.userId) {
          // Ownership mismatch reads identically to absence: unauthorized.
          close(state, "unauthorized");
          return;
        }
        state.taskId = message.taskId;
      }
      state.userId = identity.userId;
      state.accessToken = message.accessToken;
      state.send({ type: "subscribed", userId: identity.userId });
      return;
    }
    if (message.type === "refreshAuth") {
      if (state.userId === undefined) {
        close(state, "unauthorized");
        return;
      }
      const identity = await sessions.authenticate(message.accessToken);
      if (identity === undefined || identity.userId !== state.userId) {
        close(state, "tokenExpired");
        return;
      }
      state.accessToken = message.accessToken;
      return;
    }
    // unsubscribe: the client is leaving; no server-close event required.
    state.closed = true;
    connections.delete(state);
  }

  async function publishToOwner(ownerUserId: string, event: WsServerEventV1): Promise<void> {
    const taskId = eventTaskId(event);
    for (const state of [...connections]) {
      if (state.closed || state.userId !== ownerUserId || state.accessToken === undefined) {
        continue;
      }
      if (state.taskId !== undefined && taskId !== undefined && taskId !== state.taskId) {
        continue;
      }
      // Revalidation on every delivery: an expired or revoked token closes
      // the subscription instead of receiving the event.
      const identity = await sessions.authenticate(state.accessToken);
      if (identity === undefined || identity.userId !== ownerUserId) {
        close(state, "tokenExpired");
        continue;
      }
      state.send(event);
    }
  }

  return {
    connect(send: (event: WsServerEventV1) => void): WsHubConnectionV1 {
      const state: HubConnectionStateV1 = { send, closed: false };
      connections.add(state);
      return {
        handleMessage: (message: WsClientMessageV1): Promise<void> => handle(state, message),
        get userId(): string | undefined {
          return state.userId;
        },
        get closed(): boolean {
          return state.closed;
        },
      };
    },

    publishToOwner,

    createEngineSink(ownerUserId: string): EngineEventSinkV1 {
      return {
        emit: (event: EngineEventV1): void => {
          void publishToOwner(ownerUserId, event);
        },
      };
    },
  };
}
