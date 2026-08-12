/**
 * WebSocket client for the contract's `/v1/events` stream (plan Part 8),
 * honoring the Part 3/6 subscription-authorization rules end to end:
 *
 * - the FIRST message on every connection is `subscribe` carrying a current
 *   control-plane access token (fetched through the Part 6 session manager,
 *   which refreshes single-flight ahead of expiry) — never any other
 *   credential or client-asserted identity;
 * - the client re-authenticates BEFORE token expiry by sending `refreshAuth`
 *   with a newly refreshed access token, scheduled from the session
 *   snapshot's expiry (the contract's revalidation rule);
 * - a dropped connection reconnects with backoff and re-subscribes, which
 *   revalidates the subscription on reconnect; a server close for
 *   `unauthorized` stops the client instead of looping, and a signed-out
 *   session (no token available) always stops cleanly;
 * - inbound frames pass through the structural decoder; malformed frames
 *   are dropped, never dispatched.
 *
 * Socket and timer construction are injectable so the full protocol is
 * node-testable; the default socket is the platform `WebSocket` global
 * (present on React Native and web alike).
 */
import { decodeWsServerEventV1, type WsClientMessageV1, type WsServerEventV1 } from './wsEventsV1';

export type EventsConnectionStatusV1 = 'disconnected' | 'connecting' | 'connected';

/** The subset of the platform WebSocket the client drives; fakeable in tests. */
export interface WsSocketLikeV1 {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface CreateEventsClientOptionsV1 {
  /** Control-plane HTTP(S) origin; converted to ws(s) + `/v1/events`. */
  readonly baseUrl: string;
  /** Session-manager seam: refreshes ahead of expiry; null when signed out. */
  readonly getAccessToken: () => Promise<string | null>;
  /** Current access-token expiry (session snapshot), for refresh scheduling. */
  readonly getAccessTokenExpiresAt?: () => string | undefined;
  readonly onEvent: (event: WsServerEventV1) => void;
  readonly onStatus?: (status: EventsConnectionStatusV1) => void;
  readonly createSocket?: (url: string) => WsSocketLikeV1;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Reconnect backoff schedule; the last delay repeats. */
  readonly reconnectDelaysMs?: readonly number[];
  /** Send refreshAuth this far ahead of token expiry (default 30s). */
  readonly refreshSkewMs?: number;
  /** refreshAuth cadence when the expiry is unknown (default 4 min). */
  readonly fallbackRefreshMs?: number;
  readonly now?: () => number;
}

export interface EventsClientV1 {
  start(taskId?: string): void;
  /** Change the server-side per-task filter; reconnects the subscription. */
  setTaskFilter(taskId: string | undefined): void;
  stop(): void;
}

export function eventsUrlV1(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  const wsOrigin = trimmed.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return `${wsOrigin}/v1/events`;
}

function defaultCreateSocket(url: string): WsSocketLikeV1 {
  const SocketCtor = (globalThis as { WebSocket?: new (url: string) => WsSocketLikeV1 }).WebSocket;
  if (SocketCtor === undefined) {
    throw new Error('no WebSocket implementation is available on this platform');
  }
  return new SocketCtor(url);
}

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function createEventsClientV1(options: CreateEventsClientOptionsV1): EventsClientV1 {
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const refreshSkewMs = options.refreshSkewMs ?? 30_000;
  const fallbackRefreshMs = options.fallbackRefreshMs ?? 240_000;
  const now = options.now ?? ((): number => Date.now());
  const url = eventsUrlV1(options.baseUrl);

  // Each (re)connect and stop() bumps the generation; callbacks from an
  // older socket or timer check it and become no-ops, so a slow token fetch
  // can never send on a superseded connection.
  let generation = 0;
  let socket: WsSocketLikeV1 | undefined;
  let refreshTimer: unknown;
  let reconnectTimer: unknown;
  let reconnectAttempt = 0;
  let taskFilter: string | undefined;
  let stopped = true;

  function setStatus(status: EventsConnectionStatusV1): void {
    options.onStatus?.(status);
  }

  function clearTimers(): void {
    if (refreshTimer !== undefined) {
      clearTimer(refreshTimer);
      refreshTimer = undefined;
    }
    if (reconnectTimer !== undefined) {
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function send(message: WsClientMessageV1): void {
    try {
      socket?.send(JSON.stringify(message));
    } catch {
      // A socket still connecting (or already torn down) rejects sends; the
      // close/reconnect path owns recovery.
    }
  }

  function stopInternal(): void {
    generation += 1;
    stopped = true;
    clearTimers();
    const current = socket;
    socket = undefined;
    current?.close();
    setStatus('disconnected');
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }
    setStatus('disconnected');
    const delay =
      reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 1_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      if (!stopped) {
        connect();
      }
    }, delay);
  }

  function scheduleRefresh(myGeneration: number): void {
    if (refreshTimer !== undefined) {
      clearTimer(refreshTimer);
      refreshTimer = undefined;
    }
    const expiresAt = options.getAccessTokenExpiresAt?.();
    const parsed = expiresAt !== undefined ? Date.parse(expiresAt) : Number.NaN;
    const delay = Number.isFinite(parsed)
      ? Math.max(parsed - now() - refreshSkewMs, 1_000)
      : fallbackRefreshMs;
    refreshTimer = setTimer(() => {
      refreshTimer = undefined;
      void (async (): Promise<void> => {
        // getAccessToken rotates ahead of expiry, so this token is new.
        const token = await options.getAccessToken();
        if (generation !== myGeneration) {
          return;
        }
        if (token === null) {
          stopInternal();
          return;
        }
        send({ type: 'refreshAuth', accessToken: token });
        scheduleRefresh(myGeneration);
      })();
    }, delay);
  }

  function handleEvent(event: WsServerEventV1): void {
    if (event.type === 'subscribed') {
      reconnectAttempt = 0;
      setStatus('connected');
    }
    if (event.type === 'subscriptionClosed' && event.reason === 'unauthorized') {
      // The identity itself does not authorize this stream; reconnecting
      // would loop. Expired/revoked tokens fall through to the socket-close
      // reconnect, where the fresh subscribe revalidates.
      options.onEvent(event);
      stopInternal();
      return;
    }
    options.onEvent(event);
  }

  function connect(): void {
    generation += 1;
    const myGeneration = generation;
    clearTimers();
    setStatus('connecting');
    const nextSocket = createSocket(url);
    socket = nextSocket;

    nextSocket.onopen = (): void => {
      void (async (): Promise<void> => {
        const token = await options.getAccessToken();
        if (generation !== myGeneration) {
          return;
        }
        if (token === null) {
          stopInternal();
          return;
        }
        send({
          type: 'subscribe',
          accessToken: token,
          ...(taskFilter !== undefined ? { taskId: taskFilter } : {}),
        });
        scheduleRefresh(myGeneration);
      })();
    };

    nextSocket.onmessage = (message): void => {
      if (generation !== myGeneration || typeof message.data !== 'string') {
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(message.data) as unknown;
      } catch {
        return;
      }
      const event = decodeWsServerEventV1(raw);
      if (event !== null) {
        handleEvent(event);
      }
    };

    nextSocket.onclose = (): void => {
      if (generation !== myGeneration) {
        return;
      }
      socket = undefined;
      if (refreshTimer !== undefined) {
        clearTimer(refreshTimer);
        refreshTimer = undefined;
      }
      scheduleReconnect();
    };

    nextSocket.onerror = (): void => {
      // The close handler owns recovery; errors surface there.
    };
  }

  return {
    start(taskId?: string): void {
      taskFilter = taskId;
      stopped = false;
      reconnectAttempt = 0;
      connect();
    },

    setTaskFilter(taskId: string | undefined): void {
      if (stopped || taskId === taskFilter) {
        taskFilter = taskId;
        return;
      }
      taskFilter = taskId;
      // Reconnect so the new filter is authorized at subscribe time. Bump
      // the generation first so the old socket's close handler is a no-op
      // instead of scheduling a competing reconnect.
      generation += 1;
      const current = socket;
      socket = undefined;
      current?.close();
      connect();
    },

    stop(): void {
      if (socket !== undefined) {
        send({ type: 'unsubscribe' });
      }
      stopInternal();
    },
  };
}
