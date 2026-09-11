/**
 * Wire-level tests for the RFC6455 `/v1/events` transport (plan Part 5):
 * real sockets against the node adapter, a hand-rolled masked client codec,
 * and the hub's contract semantics observed THROUGH the wire — handshake
 * accept-key correctness, subscribe/publish round-trips, unauthorized close,
 * masking enforcement (1002), ping/pong, unsubscribe close, and the 426
 * answer on a plain HTTP GET.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WsServerEventV1 } from "../../ensemble-contract/src/wsEventsV1";
import {
  createControlPlaneHandlerV1,
  createControlPlaneNodeServerV1,
} from "../src/controlPlaneServerV1";
import { createBootSecretKekProviderV1 } from "../src/keyCustodyV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { createControlPlaneStoreV1 } from "../src/storeV1";
import { createWsHubV1, WsHubV1 } from "../src/wsHubV1";
import {
  attachWsEventsTransportV1,
  computeWebSocketAcceptV1,
  createWsFrameReaderV1,
  encodeMaskedClientFrameV1,
  WS_OPCODE_V1,
  WsFrameV1,
} from "../src/wsTransportV1";
import { createInMemorySandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import { makeClock, makeFakeValidator } from "./helpersV1";

const CLIENT_KEY = Buffer.from("wire-test-nonce!").toString("base64");

interface WireWorld {
  readonly server: Server;
  readonly port: number;
  readonly hub: WsHubV1;
  readonly token: string;
  readonly otherToken: string;
  readonly userId: string;
  readonly otherUserId: string;
  close(): Promise<void>;
}

async function makeWireWorld(
  wsOptions?: { readonly subscribeDeadlineMs?: number; readonly maxOpenConnections?: number }
): Promise<WireWorld> {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a", "code-b": "subject-b" })],
    now: clock.now,
  });
  const hub = createWsHubV1({ sessions, store });
  const handler = createControlPlaneHandlerV1({
    store,
    sessions,
    hub,
    kekProvider: createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" }),
    sandboxFactory: { clientFor: () => createInMemorySandboxClientV1() },
    now: clock.now,
  });
  // With test seams, the transport is attached directly (the node adapter
  // always attaches it with production defaults).
  const server =
    wsOptions === undefined
      ? createControlPlaneNodeServerV1(handler, { hub })
      : createControlPlaneNodeServerV1(handler);
  if (wsOptions !== undefined) {
    attachWsEventsTransportV1(server, { hub, ...wsOptions });
  }
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const a = await sessions.exchange({
    provider: "github",
    authorizationCode: "code-a",
    codeVerifier: "v",
    redirectUri: "app://callback",
  });
  const b = await sessions.exchange({
    provider: "github",
    authorizationCode: "code-b",
    codeVerifier: "v",
    redirectUri: "app://callback",
  });
  assert.ok(a.ok && b.ok);
  return {
    server,
    port: address.port,
    hub,
    token: a.tokens.accessToken,
    otherToken: b.tokens.accessToken,
    userId: a.userId,
    otherUserId: b.userId,
    close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

interface WireClient {
  readonly socket: Duplex;
  readonly acceptHeader: string;
  /** Resolves with the next complete frame from the server. */
  nextFrame(): Promise<WsFrameV1>;
  /** Resolves with the next text frame parsed as a server event. */
  nextEvent(): Promise<WsServerEventV1>;
  sendText(text: string): void;
  sendRaw(bytes: Buffer): void;
  closed(): Promise<void>;
}

function openWireClient(port: number): Promise<WireClient> {
  return new Promise((resolve, reject) => {
    const upgradeRequest = request({
      host: "127.0.0.1",
      port,
      path: "/v1/events",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": CLIENT_KEY,
        "Sec-WebSocket-Version": "13",
      },
    });
    upgradeRequest.on("response", (response) => {
      reject(new Error(`expected an upgrade, got HTTP ${response.statusCode}`));
    });
    upgradeRequest.on("error", reject);
    upgradeRequest.on("upgrade", (response, socket) => {
      const reader = createWsFrameReaderV1();
      const frames: WsFrameV1[] = [];
      const waiters: ((frame: WsFrameV1) => void)[] = [];
      const closedPromise = new Promise<void>((resolveClosed) => {
        socket.on("close", () => resolveClosed());
        socket.on("end", () => socket.end());
      });
      socket.on("data", (chunk: Buffer) => {
        const fed = reader.feed(chunk);
        assert.ok(fed.ok, "the server never sends malformed frames");
        for (const frame of fed.frames) {
          const waiter = waiters.shift();
          if (waiter !== undefined) {
            waiter(frame);
          } else {
            frames.push(frame);
          }
        }
      });
      function nextFrame(): Promise<WsFrameV1> {
        const queued = frames.shift();
        if (queued !== undefined) {
          return Promise.resolve(queued);
        }
        return new Promise((resolveFrame) => waiters.push(resolveFrame));
      }
      resolve({
        socket,
        acceptHeader: String(response.headers["sec-websocket-accept"] ?? ""),
        nextFrame,
        async nextEvent(): Promise<WsServerEventV1> {
          const frame = await nextFrame();
          assert.equal(frame.opcode, WS_OPCODE_V1.text);
          return JSON.parse(frame.payload.toString("utf8")) as WsServerEventV1;
        },
        sendText(text: string): void {
          socket.write(
            encodeMaskedClientFrameV1(WS_OPCODE_V1.text, Buffer.from(text, "utf8"))
          );
        },
        sendRaw(bytes: Buffer): void {
          socket.write(bytes);
        },
        closed: (): Promise<void> => closedPromise,
      });
    });
    upgradeRequest.end();
  });
}

test("handshake computes the RFC6455 accept key; subscribe + publish round-trip over the wire", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    assert.equal(client.acceptHeader, computeWebSocketAcceptV1(CLIENT_KEY));

    client.sendText(JSON.stringify({ type: "subscribe", accessToken: world.token }));
    const subscribed = await client.nextEvent();
    assert.deepEqual(subscribed, { type: "subscribed", userId: world.userId });

    // Cross-user isolation holds at the wire: B's event never arrives; A's
    // event published AFTER it is the next frame this socket sees.
    await world.hub.publishToOwner(world.otherUserId, {
      type: "gateStateChanged",
      taskId: "t-b",
      gateId: "g-b",
      state: "approved",
    });
    await world.hub.publishToOwner(world.userId, {
      type: "notification",
      at: "2026-08-12T00:00:01.000Z",
      notification: { kind: "agentLifecycle", taskId: "t-a", phase: "started" },
    });
    const event = await client.nextEvent();
    assert.equal(event.type, "notification");
    assert.ok(event.type === "notification");
    assert.equal(event.notification.kind, "agentLifecycle");
    client.socket.destroy();
  } finally {
    await world.close();
  }
});

test("a forged token subscription closes over the wire with unauthorized", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    client.sendText(JSON.stringify({ type: "subscribe", accessToken: "cpat_forged" }));
    const closedEvent = await client.nextEvent();
    assert.deepEqual(closedEvent, { type: "subscriptionClosed", reason: "unauthorized" });
    const closeFrame = await client.nextFrame();
    assert.equal(closeFrame.opcode, WS_OPCODE_V1.close);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("an unmasked client frame violates the RFC and closes with 1002", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    const payload = Buffer.from(JSON.stringify({ type: "unsubscribe" }), "utf8");
    // Unmasked client frame: FIN + text, mask bit clear.
    client.sendRaw(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    const closeFrame = await client.nextFrame();
    assert.equal(closeFrame.opcode, WS_OPCODE_V1.close);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1002);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("an unauthenticated client cannot grow a fragmented message past the payload limit: 1009, connection closed", async () => {
  // Each frame is under the per-frame cap, so the frame reader accepts every
  // one; before the fix their SUM was unbounded — and a socket subscribes by
  // message, so this needs no token at all (review lead, 2026-09-11).
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    const piece = Buffer.alloc(512 * 1024, 0x20);
    const clearFin = (frame: Buffer): Buffer => {
      const copy = Buffer.from(frame);
      copy[0] = (copy[0] as number) & 0x7f;
      return copy;
    };
    client.sendRaw(clearFin(encodeMaskedClientFrameV1(WS_OPCODE_V1.text, piece)));
    for (let index = 0; index < 4; index += 1) {
      client.sendRaw(clearFin(encodeMaskedClientFrameV1(WS_OPCODE_V1.continuation, piece)));
    }
    const closeFrame = await client.nextFrame();
    assert.equal(closeFrame.opcode, WS_OPCODE_V1.close);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1009);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("zero-length continuation frames are bounded too: a flood of empty pieces closes with 1009", async () => {
  // The byte cap alone missed this: empty pieces add no bytes but each one
  // was still retained (second-round review).
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    const clearFin = (frame: Buffer): Buffer => {
      const copy = Buffer.from(frame);
      copy[0] = (copy[0] as number) & 0x7f;
      return copy;
    };
    const empty = clearFin(encodeMaskedClientFrameV1(WS_OPCODE_V1.continuation, Buffer.alloc(0)));
    client.sendRaw(clearFin(encodeMaskedClientFrameV1(WS_OPCODE_V1.text, Buffer.from("{", "utf8"))));
    client.sendRaw(Buffer.concat(Array.from({ length: 2000 }, () => empty)));
    const closeFrame = await client.nextFrame();
    assert.equal(closeFrame.opcode, WS_OPCODE_V1.close);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1009);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("a malformed upgrade target (GET //%5B) gets a 400 and the process keeps serving", async () => {
  // Confirmed in review: `new URL("//%5B", base)` throws, and the throw used
  // to escape the upgrade listener — one unauthenticated request killed the
  // process. Sent over a raw socket so no client library normalizes it.
  const { connect } = await import("node:net");
  const world = await makeWireWorld();
  const escaped: unknown[] = [];
  const onException = (error: unknown): void => {
    escaped.push(error);
  };
  process.on("uncaughtException", onException);
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const raw = connect(world.port, "127.0.0.1", () => {
        raw.write(
          "GET //%5B HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            `Sec-WebSocket-Key: ${CLIENT_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let text = "";
      raw.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      raw.on("close", () => resolve(text));
      raw.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.deepEqual(escaped, [], "the malformed target must not escape as an uncaught exception");

    // Still serving: a normal client can connect afterwards.
    const client = await openWireClient(world.port);
    client.socket.destroy();
  } finally {
    process.off("uncaughtException", onException);
    await world.close();
  }
});

test("ping is answered with a pong echoing the payload", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    client.sendRaw(
      encodeMaskedClientFrameV1(WS_OPCODE_V1.ping, Buffer.from("heartbeat", "utf8"))
    );
    const pong = await client.nextFrame();
    assert.equal(pong.opcode, WS_OPCODE_V1.pong);
    assert.equal(pong.payload.toString("utf8"), "heartbeat");
    client.socket.destroy();
  } finally {
    await world.close();
  }
});

test("an oversized ping is refused with 1002, never echoed back as a pong", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    client.sendRaw(encodeMaskedClientFrameV1(WS_OPCODE_V1.ping, Buffer.alloc(126, 0x61)));
    const frame = await client.nextFrame();
    assert.equal(frame.opcode, WS_OPCODE_V1.close);
    assert.equal(frame.payload.readUInt16BE(0), 1002);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("a fragmented control frame is refused with 1002", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    const ping = encodeMaskedClientFrameV1(WS_OPCODE_V1.ping, Buffer.from("x", "utf8"));
    ping[0] = (ping[0] as number) & 0x7f; // clear FIN
    client.sendRaw(ping);
    const frame = await client.nextFrame();
    assert.equal(frame.opcode, WS_OPCODE_V1.close);
    assert.equal(frame.payload.readUInt16BE(0), 1002);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("a connection that never subscribes is closed with 1008 at the subscribe deadline", async () => {
  const world = await makeWireWorld({ subscribeDeadlineMs: 50 });
  try {
    const client = await openWireClient(world.port);
    const frame = await client.nextFrame();
    assert.equal(frame.opcode, WS_OPCODE_V1.close);
    assert.equal(frame.payload.readUInt16BE(0), 1008);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("a subscribed connection outlives the subscribe deadline", async () => {
  const world = await makeWireWorld({ subscribeDeadlineMs: 50 });
  try {
    const client = await openWireClient(world.port);
    client.sendText(JSON.stringify({ type: "subscribe", accessToken: world.token }));
    assert.equal((await client.nextEvent()).type, "subscribed");
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.sendRaw(encodeMaskedClientFrameV1(WS_OPCODE_V1.ping, Buffer.from("alive", "utf8")));
    const pong = await client.nextFrame();
    assert.equal(pong.opcode, WS_OPCODE_V1.pong);
    client.socket.destroy();
  } finally {
    await world.close();
  }
});

test("open connections are capped (503), and a closed one frees its slot", async () => {
  const world = await makeWireWorld({ maxOpenConnections: 1 });
  try {
    const first = await openWireClient(world.port);
    await assert.rejects(openWireClient(world.port), /HTTP 503/);
    first.socket.destroy();
    await first.closed();
    // The server sees the close asynchronously; retry briefly.
    let second: WireClient | undefined;
    for (let attempt = 0; attempt < 20 && second === undefined; attempt += 1) {
      second = await openWireClient(world.port).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      });
    }
    assert.ok(second !== undefined, "the freed slot is usable again");
    second.socket.destroy();
  } finally {
    await world.close();
  }
});

test("unsubscribe closes the socket cleanly and drops the hub subscription", async () => {
  const world = await makeWireWorld();
  try {
    const client = await openWireClient(world.port);
    client.sendText(JSON.stringify({ type: "subscribe", accessToken: world.token }));
    const subscribed = await client.nextEvent();
    assert.equal(subscribed.type, "subscribed");
    client.sendText(JSON.stringify({ type: "unsubscribe" }));
    const closeFrame = await client.nextFrame();
    assert.equal(closeFrame.opcode, WS_OPCODE_V1.close);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1000);
    await client.closed();
  } finally {
    await world.close();
  }
});

test("a plain HTTP GET on /v1/events still answers 426 through the node adapter", async () => {
  const world = await makeWireWorld();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const plain = request(
        {
          host: "127.0.0.1",
          port: world.port,
          path: "/v1/events",
          headers: { authorization: `Bearer ${world.token}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      plain.on("error", reject);
      plain.end();
    });
    assert.equal(status, 426);
  } finally {
    await world.close();
  }
});
