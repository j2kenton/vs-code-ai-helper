/**
 * Protocol tests for the `/v1/events` client against a scripted socket and
 * manual timers: subscribe-first authorization, refreshAuth ahead of expiry
 * with a newly refreshed token, reconnect-with-resubscribe revalidation,
 * fail-closed stops (signed out, unauthorized), and per-task filtering.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEventsClientV1,
  eventsUrlV1,
  type WsSocketLikeV1,
} from '../src/events/eventsClientV1';
import type { WsServerEventV1 } from '../src/events/wsEventsV1';

class FakeSocket implements WsSocketLikeV1 {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  dropConnection(): void {
    this.onclose?.();
  }
}

function fakeTimers(): {
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  advance: (ms: number) => void;
} {
  let nextId = 1;
  let currentTime = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimer(callback, delayMs): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: currentTime + delayMs, callback });
      return id;
    },
    clearTimer(handle): void {
      timers.delete(handle as number);
    },
    now: (): number => currentTime,
    advance(ms): void {
      currentTime += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= currentTime);
        if (due.length === 0) {
          return;
        }
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  readonly sockets: FakeSocket[];
  readonly events: WsServerEventV1[];
  readonly statuses: string[];
  readonly timers: ReturnType<typeof fakeTimers>;
  readonly client: ReturnType<typeof createEventsClientV1>;
  readonly sentMessages: (socket: FakeSocket) => unknown[];
}

function harness(options?: {
  readonly tokens?: readonly (string | null)[];
  readonly expiresInMs?: number;
}): Harness {
  const sockets: FakeSocket[] = [];
  const events: WsServerEventV1[] = [];
  const statuses: string[] = [];
  const timers = fakeTimers();
  const tokens = [...(options?.tokens ?? ['token-1', 'token-2', 'token-3', 'token-4'])];
  const client = createEventsClientV1({
    baseUrl: 'https://cp.example.com',
    getAccessToken: () => Promise.resolve(tokens.length > 1 ? (tokens.shift() ?? null) : (tokens[0] ?? null)),
    ...(options?.expiresInMs !== undefined
      ? {
          getAccessTokenExpiresAt: (): string =>
            new Date(timers.now() + (options.expiresInMs ?? 0)).toISOString(),
        }
      : {}),
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    refreshSkewMs: 30_000,
  });
  return {
    sockets,
    events,
    statuses,
    timers,
    client,
    sentMessages: (socket) => socket.sent.map((data) => JSON.parse(data) as unknown),
  };
}

test('the events URL converts the control-plane origin to ws(s)', () => {
  assert.equal(eventsUrlV1('https://cp.example.com/'), 'wss://cp.example.com/v1/events');
  assert.equal(eventsUrlV1('http://localhost:8080'), 'ws://localhost:8080/v1/events');
});

test('the first message on every connection is subscribe with the current token and filter', async () => {
  const h = harness();
  h.client.start('task-9');
  assert.equal(h.sockets.length, 1);
  h.sockets[0]?.open();
  await flush();
  assert.deepEqual(h.sentMessages(h.sockets[0] as FakeSocket)[0], {
    type: 'subscribe',
    accessToken: 'token-1',
    taskId: 'task-9',
  });
});

test('decoded events dispatch; malformed frames are dropped silently', async () => {
  const h = harness();
  h.client.start();
  h.sockets[0]?.open();
  await flush();
  const socket = h.sockets[0] as FakeSocket;
  socket.onmessage?.({ data: 'not json at all' });
  socket.receive({ type: 'somethingNew' });
  socket.receive({ type: 'subscribed', userId: 'user-1' });
  socket.receive({
    type: 'gateStateChanged',
    taskId: 't1',
    gateId: 'g1',
    state: 'approved',
  });
  assert.deepEqual(
    h.events.map((event) => event.type),
    ['subscribed', 'gateStateChanged']
  );
  assert.equal(h.statuses.at(-1), 'connected');
});

test('refreshAuth is sent ahead of expiry carrying a newly refreshed token, then reschedules', async () => {
  const h = harness({ tokens: ['token-1', 'token-2', 'token-3'], expiresInMs: 90_000 });
  h.client.start();
  const socket = h.sockets[0] as FakeSocket;
  socket.open();
  await flush();
  socket.receive({ type: 'subscribed', userId: 'user-1' });
  // Expiry 90s out, skew 30s: the refresh fires at 60s.
  h.timers.advance(59_000);
  await flush();
  assert.equal(socket.sent.length, 1);
  h.timers.advance(1_000);
  await flush();
  const messages = h.sentMessages(socket);
  assert.deepEqual(messages[1], { type: 'refreshAuth', accessToken: 'token-2' });
  // Rescheduled from the fresh snapshot: another window, another refresh.
  h.timers.advance(60_000);
  await flush();
  assert.deepEqual(h.sentMessages(socket)[2], { type: 'refreshAuth', accessToken: 'token-3' });
});

test('a dropped connection reconnects with backoff and re-subscribes with a fresh token', async () => {
  const h = harness({ tokens: ['token-1', 'token-2'] });
  h.client.start();
  h.sockets[0]?.open();
  await flush();
  (h.sockets[0] as FakeSocket).dropConnection();
  assert.equal(h.statuses.at(-1), 'disconnected');
  h.timers.advance(1_000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1]?.open();
  await flush();
  assert.deepEqual(h.sentMessages(h.sockets[1] as FakeSocket)[0], {
    type: 'subscribe',
    accessToken: 'token-2',
  });
});

test('an unauthorized subscription close stops the client instead of looping', async () => {
  const h = harness();
  h.client.start();
  const socket = h.sockets[0] as FakeSocket;
  socket.open();
  await flush();
  socket.receive({ type: 'subscriptionClosed', reason: 'unauthorized' });
  assert.equal(h.events.at(-1)?.type, 'subscriptionClosed');
  assert.equal(h.statuses.at(-1), 'disconnected');
  assert.equal(socket.closed, true);
  h.timers.advance(120_000);
  assert.equal(h.sockets.length, 1);
});

test('a signed-out session (no token) stops cleanly without subscribing', async () => {
  const h = harness({ tokens: [null] });
  h.client.start();
  const socket = h.sockets[0] as FakeSocket;
  socket.open();
  await flush();
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closed, true);
  assert.equal(h.statuses.at(-1), 'disconnected');
  h.timers.advance(120_000);
  assert.equal(h.sockets.length, 1);
});

test('changing the task filter reconnects and re-authorizes at subscribe time', async () => {
  const h = harness({ tokens: ['token-1', 'token-2'] });
  h.client.start();
  h.sockets[0]?.open();
  await flush();
  h.client.setTaskFilter('task-2');
  assert.equal((h.sockets[0] as FakeSocket).closed, true);
  assert.equal(h.sockets.length, 2);
  h.sockets[1]?.open();
  await flush();
  assert.deepEqual(h.sentMessages(h.sockets[1] as FakeSocket)[0], {
    type: 'subscribe',
    accessToken: 'token-2',
    taskId: 'task-2',
  });
});

test('stop() sends unsubscribe, closes the socket, and cancels reconnects', async () => {
  const h = harness();
  h.client.start();
  const socket = h.sockets[0] as FakeSocket;
  socket.open();
  await flush();
  h.client.stop();
  assert.deepEqual(h.sentMessages(socket).at(-1), { type: 'unsubscribe' });
  assert.equal(socket.closed, true);
  h.timers.advance(600_000);
  assert.equal(h.sockets.length, 1);
});
