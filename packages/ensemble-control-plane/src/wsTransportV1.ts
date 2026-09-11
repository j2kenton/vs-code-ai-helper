/**
 * RFC6455 WebSocket wire transport for `/v1/events` (plan Part 5).
 *
 * Dependency-free by design: the workspace cannot install a `ws` package in
 * this environment, and the plan's WS requirement is subscription SEMANTICS
 * (which live in `wsHubV1.ts`) plus a wire codec — so the codec is written
 * here against RFC6455 directly using only `node:crypto`:
 *
 * - handshake: `Sec-WebSocket-Accept` = base64(SHA-1(key + GUID)), version 13
 *   only, anything malformed answered `400` and the socket destroyed;
 * - framing: full 7/16/64-bit payload lengths, fragmentation reassembly,
 *   interleaved control frames, ping→pong, close echo;
 * - the RFC's masking rule is enforced: a client frame without a mask closes
 *   the connection with protocol error `1002`;
 * - inbound text messages must parse as the contract's `WsClientMessageV1`
 *   shapes — anything else closes with `1008` (policy violation); binary
 *   data closes with `1003` (unsupported data);
 * - every connection is handed to the hub, so authorization is exactly the
 *   contract's: the first message must be `subscribe` with a current access
 *   token, `refreshAuth` revalidates, and a hub-side close
 *   (`subscriptionClosed`) flushes to the wire and then closes the socket.
 *
 * The transport holds NO authorization logic of its own — it cannot drift
 * from the hub's contract semantics because it only moves frames.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WsClientMessageV1, WsServerEventV1 } from "../../ensemble-contract/src/wsEventsV1";
import type { WsHubV1 } from "./wsHubV1";

const WS_HANDSHAKE_GUID_V1 = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Frames larger than this close the connection with 1009 (message too big). */
const DEFAULT_MAX_PAYLOAD_BYTES_V1 = 1024 * 1024;
/** Unsent server→client bytes one socket may hold before the peer is dropped. */
const MAX_WS_BUFFERED_BYTES_V1 = 4 * 1024 * 1024;
/** Open WebSocket connections across the whole process (one owner; generous). */
const MAX_OPEN_WS_CONNECTIONS_V1 = 256;
/** How long a new connection may stay without a successful subscribe. */
const WS_SUBSCRIBE_DEADLINE_MS_V1 = 30_000;

export const WS_OPCODE_V1 = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export function computeWebSocketAcceptV1(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_HANDSHAKE_GUID_V1).digest("base64");
}

export interface WsFrameV1 {
  readonly fin: boolean;
  readonly opcode: number;
  readonly masked: boolean;
  readonly payload: Buffer;
}

/** Serialize one server→client frame (servers never mask, per the RFC). */
export function encodeWsFrameV1(opcode: number, payload: Buffer, fin = true): Buffer {
  const finBit = fin ? 0x80 : 0x00;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([finBit | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = finBit | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = finBit | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function encodeWsTextFrameV1(text: string): Buffer {
  return encodeWsFrameV1(WS_OPCODE_V1.text, Buffer.from(text, "utf8"));
}

export function encodeWsCloseFrameV1(code: number, reason = ""): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeWsFrameV1(WS_OPCODE_V1.close, payload);
}

/** Serialize one client→server frame (clients MUST mask, per the RFC). */
export function encodeMaskedClientFrameV1(
  opcode: number,
  payload: Buffer,
  maskKey: Buffer = Buffer.from([0x12, 0x34, 0x56, 0x78])
): Buffer {
  if (maskKey.length !== 4) {
    throw new Error("a WebSocket mask key is exactly 4 bytes");
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] as number) ^ (maskKey[index % 4] as number);
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

export type WsFrameFeedResultV1 =
  | { readonly ok: true; readonly frames: readonly WsFrameV1[] }
  | { readonly ok: false; readonly closeCode: number; readonly reason: string };

export interface WsFrameReaderV1 {
  feed(chunk: Buffer): WsFrameFeedResultV1;
}

/** Incremental frame parser: buffers partial TCP chunks between feeds. */
export function createWsFrameReaderV1(options?: {
  readonly maxPayloadBytes?: number;
}): WsFrameReaderV1 {
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES_V1;
  let pending: Buffer = Buffer.alloc(0);
  // While a frame's body is still arriving, its chunks are only COLLECTED
  // and joined once, when the whole frame is here. Re-concatenating the
  // growing buffer on every chunk was quadratic: one 1 MB frame sent in
  // 100-byte pieces cost ~3 s of event-loop CPU, pre-auth (final review).
  let queued: Buffer[] = [];
  let queuedBytes = 0;
  let awaitingBytes: number | undefined;
  return {
    feed(chunk: Buffer): WsFrameFeedResultV1 {
      if (awaitingBytes !== undefined) {
        queued.push(chunk);
        queuedBytes += chunk.length;
        if (pending.length + queuedBytes < awaitingBytes) {
          return { ok: true, frames: [] };
        }
        pending = Buffer.concat([pending, ...queued]);
        queued = [];
        queuedBytes = 0;
        awaitingBytes = undefined;
      } else {
        // Only header bytes (at most 14) can be waiting here: cheap.
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      }
      const frames: WsFrameV1[] = [];
      for (;;) {
        if (pending.length < 2) {
          return { ok: true, frames };
        }
        const byte0 = pending[0] as number;
        const byte1 = pending[1] as number;
        const fin = (byte0 & 0x80) !== 0;
        if ((byte0 & 0x70) !== 0) {
          return { ok: false, closeCode: 1002, reason: "reserved bits set" };
        }
        const opcode = byte0 & 0x0f;
        const masked = (byte1 & 0x80) !== 0;
        let payloadLength = byte1 & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (pending.length < offset + 2) {
            return { ok: true, frames };
          }
          payloadLength = pending.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (pending.length < offset + 8) {
            return { ok: true, frames };
          }
          const wide = pending.readBigUInt64BE(offset);
          if (wide > BigInt(maxPayloadBytes)) {
            return { ok: false, closeCode: 1009, reason: "frame exceeds the payload limit" };
          }
          payloadLength = Number(wide);
          offset += 8;
        }
        if (payloadLength > maxPayloadBytes) {
          return { ok: false, closeCode: 1009, reason: "frame exceeds the payload limit" };
        }
        const maskLength = masked ? 4 : 0;
        if (pending.length < offset + maskLength + payloadLength) {
          awaitingBytes = offset + maskLength + payloadLength;
          return { ok: true, frames };
        }
        const maskKey = masked ? pending.subarray(offset, offset + 4) : undefined;
        const rawPayload = pending.subarray(
          offset + maskLength,
          offset + maskLength + payloadLength
        );
        let payload: Buffer;
        if (maskKey !== undefined) {
          payload = Buffer.alloc(payloadLength);
          for (let index = 0; index < payloadLength; index += 1) {
            payload[index] = (rawPayload[index] as number) ^ (maskKey[index % 4] as number);
          }
        } else {
          payload = Buffer.from(rawPayload);
        }
        pending = pending.subarray(offset + maskLength + payloadLength);
        frames.push({ fin, opcode, masked, payload });
      }
    },
  };
}

function isWsClientMessageV1(value: unknown): value is WsClientMessageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "unsubscribe") {
    return true;
  }
  if (record.type === "refreshAuth") {
    return typeof record.accessToken === "string";
  }
  if (record.type === "subscribe") {
    return (
      typeof record.accessToken === "string" &&
      (record.taskId === undefined || typeof record.taskId === "string")
    );
  }
  return false;
}

export interface AttachWsEventsTransportOptionsV1 {
  readonly hub: WsHubV1;
  /** Defaults to the contract's `/v1/events`. */
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  /** Test seams; production uses the defaults. */
  readonly subscribeDeadlineMs?: number;
  readonly maxOpenConnections?: number;
}

/**
 * Attach the `/v1/events` WebSocket upgrade to a node:http server, bridging
 * wire frames to the hub's transport-agnostic subscription semantics.
 */
export function attachWsEventsTransportV1(
  server: Server,
  options: AttachWsEventsTransportOptionsV1
): void {
  const path = options.path ?? "/v1/events";
  const { hub } = options;
  /** Open WebSocket connections, bounded — each is a file descriptor and a hub entry. */
  let openSockets = 0;

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Everything on this path runs BEFORE any token check, so nothing here
    // may be able to throw out of the listener or leave an 'error' event
    // unlistened — either one terminates the whole process (second-round
    // review, confirmed: `GET //%5B` made `new URL` throw here).
    let socketErrorSeen = false;
    socket.on("error", () => {
      socketErrorSeen = true;
      socket.destroy();
    });
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (socketErrorSeen) {
      return;
    }
    const upgradeHeader = request.headers.upgrade?.toLowerCase();
    const key = request.headers["sec-websocket-key"];
    const version = request.headers["sec-websocket-version"];
    if (
      url.pathname !== path ||
      upgradeHeader !== "websocket" ||
      typeof key !== "string" ||
      key.length === 0 ||
      version !== "13"
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (openSockets >= (options.maxOpenConnections ?? MAX_OPEN_WS_CONNECTIONS_V1)) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    openSockets += 1;
    let counted = true;
    const release = (): void => {
      if (counted) {
        counted = false;
        openSockets -= 1;
      }
    };
    socket.once("close", release);

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${computeWebSocketAcceptV1(key)}\r\n\r\n`
    );

    let socketClosed = false;
    const reader = createWsFrameReaderV1(
      options.maxPayloadBytes !== undefined
        ? { maxPayloadBytes: options.maxPayloadBytes }
        : {}
    );

    /**
     * Every server→client write goes through here. A peer that never reads
     * lets unsent frames pile up in this process (pings echoed as pongs,
     * events fanned out): 300 × 1 MB pings grew one socket's buffer to 312 MB,
     * pre-auth, in the final review. Past the cap the peer is dropped.
     */
    function send(frame: Buffer): void {
      if (socketClosed) {
        return;
      }
      if (socket.writableLength + frame.length > MAX_WS_BUFFERED_BYTES_V1) {
        socketClosed = true;
        detachFromHub();
        socket.destroy();
        return;
      }
      socket.write(frame);
    }

    const connection = hub.connect((event: WsServerEventV1): void => {
      if (socketClosed) {
        return;
      }
      send(encodeWsTextFrameV1(JSON.stringify(event)));
      if (event.type === "subscriptionClosed") {
        closeSocket(1000, event.reason);
      }
    });

    // A connection must subscribe (with a valid token) promptly; an
    // anonymous socket may not idle here forever holding a descriptor and a
    // hub entry (final review).
    const subscribeDeadline = setTimeout(() => {
      if (!socketClosed && connection.userId === undefined) {
        closeSocket(1008, "subscribe required");
      }
    }, options.subscribeDeadlineMs ?? WS_SUBSCRIBE_DEADLINE_MS_V1);
    subscribeDeadline.unref?.();
    socket.once("close", () => clearTimeout(subscribeDeadline));

    function detachFromHub(): void {
      if (!connection.closed) {
        // Remove the subscription without a server-close event: the socket
        // is already gone (or going), so there is nowhere to send one.
        void connection.handleMessage({ type: "unsubscribe" });
      }
    }

    function closeSocket(code: number, reason: string): void {
      if (socketClosed) {
        return;
      }
      socketClosed = true;
      detachFromHub();
      socket.write(encodeWsCloseFrameV1(code, reason));
      socket.end();
      // `end()` only half-closes: a peer that never closes its side kept the
      // socket (and its descriptor) forever. Give it a moment, then cut it.
      setTimeout(() => socket.destroy(), 5000).unref?.();
    }

    // Inbound messages apply strictly in arrival order even though the hub
    // handler is async: each handler chains behind the previous one.
    let inboundChain: Promise<void> = Promise.resolve();
    let fragmentOpcode: number | undefined;
    let fragmentParts: Buffer[] = [];
    /**
     * The frame reader caps each FRAME, but a fragmented message is many
     * frames: with no cap on their sum, an unauthenticated client (a socket
     * subscribes by message, so none of this is behind sign-in) could stream
     * continuation frames until the process ran out of memory (review lead,
     * 2026-09-11). The whole reassembled message gets the same limit.
     */
    let fragmentBytes = 0;
    const maxMessageBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES_V1;
    /**
     * Bytes alone are not a bound: zero-length continuation frames add
     * nothing to the byte count but still cost a frame each (second-round
     * review). The number of pieces is capped too, and empty pieces are
     * never retained.
     */
    let fragmentCount = 0;
    const MAX_FRAGMENTS_PER_MESSAGE_V1 = 1024;

    function deliverText(text: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        closeSocket(1008, "messages must be JSON");
        return;
      }
      if (!isWsClientMessageV1(parsed)) {
        closeSocket(1008, "unrecognized client message shape");
        return;
      }
      const message = parsed;
      inboundChain = inboundChain.then(async () => {
        if (socketClosed) {
          return;
        }
        await connection.handleMessage(message);
        // A silent hub-side close (unsubscribe) still closes the wire; the
        // event-carrying closes already went through the send callback.
        if (connection.closed && !socketClosed) {
          closeSocket(1000, "unsubscribed");
        }
      }).catch(() => {
        // A failing hub handler must not become an unhandled rejection (fatal
        // to Node) nor jam the chain: this connection ends, the process lives.
        closeSocket(1011, "internal error");
      });
    }

    function handleFrame(frame: WsFrameV1): void {
      if (!frame.masked) {
        // RFC6455 §5.1: a server MUST close on an unmasked client frame.
        closeSocket(1002, "client frames must be masked");
        return;
      }
      const isControl =
        frame.opcode === WS_OPCODE_V1.close || frame.opcode === WS_OPCODE_V1.ping || frame.opcode === WS_OPCODE_V1.pong;
      if (isControl && (!frame.fin || frame.payload.length > 125)) {
        // RFC6455 §5.5: control frames are ≤125 bytes and never fragmented.
        // Unchecked, 1 MB pings were echoed as 1 MB pongs (final review).
        closeSocket(1002, "invalid control frame");
        return;
      }
      switch (frame.opcode) {
        case WS_OPCODE_V1.close:
          socketClosed = true;
          detachFromHub();
          socket.write(encodeWsCloseFrameV1(1000, ""));
          socket.end();
          setTimeout(() => socket.destroy(), 5000).unref?.();
          return;
        case WS_OPCODE_V1.ping:
          send(encodeWsFrameV1(WS_OPCODE_V1.pong, frame.payload));
          return;
        case WS_OPCODE_V1.pong:
          return;
        case WS_OPCODE_V1.binary:
          closeSocket(1003, "binary messages are not part of the contract");
          return;
        case WS_OPCODE_V1.text:
        case WS_OPCODE_V1.continuation: {
          if (frame.opcode === WS_OPCODE_V1.text) {
            if (fragmentOpcode !== undefined) {
              closeSocket(1002, "interleaved data message");
              return;
            }
            if (frame.fin) {
              deliverText(frame.payload.toString("utf8"));
              return;
            }
            fragmentOpcode = frame.opcode;
            fragmentParts = frame.payload.length > 0 ? [frame.payload] : [];
            fragmentBytes = frame.payload.length;
            fragmentCount = 1;
            return;
          }
          if (fragmentOpcode === undefined) {
            closeSocket(1002, "continuation without a started message");
            return;
          }
          fragmentBytes += frame.payload.length;
          fragmentCount += 1;
          if (fragmentBytes > maxMessageBytes || fragmentCount > MAX_FRAGMENTS_PER_MESSAGE_V1) {
            fragmentOpcode = undefined;
            fragmentParts = [];
            fragmentBytes = 0;
            fragmentCount = 0;
            closeSocket(1009, "message exceeds the payload limit");
            return;
          }
          if (frame.payload.length > 0) {
            fragmentParts.push(frame.payload);
          }
          if (frame.fin) {
            const text = Buffer.concat(fragmentParts).toString("utf8");
            fragmentOpcode = undefined;
            fragmentParts = [];
            fragmentBytes = 0;
            fragmentCount = 0;
            deliverText(text);
          }
          return;
        }
        default:
          closeSocket(1002, "unrecognized opcode");
      }
    }

    function consume(chunk: Buffer): void {
      if (socketClosed) {
        return;
      }
      try {
        const result = reader.feed(chunk);
        if (!result.ok) {
          closeSocket(result.closeCode, result.reason);
          return;
        }
        for (const frame of result.frames) {
          if (socketClosed) {
            return;
          }
          handleFrame(frame);
        }
      } catch {
        // A 'data' listener that throws takes the process down; a bad frame
        // must only ever cost its own connection.
        closeSocket(1011, "internal error");
      }
    }

    socket.on("data", consume);
    socket.on("error", () => {
      socketClosed = true;
      detachFromHub();
      socket.destroy();
    });
    // node:http sockets allow half-open: a peer that drops TCP without a
    // close frame only ends ITS side, and without this our side (its hub
    // entry, descriptor and connection slot) stayed open indefinitely.
    socket.on("end", () => {
      socketClosed = true;
      detachFromHub();
      socket.destroy();
    });
    socket.on("close", () => {
      socketClosed = true;
      detachFromHub();
    });
    if (head.length > 0) {
      consume(head);
    }
  });
}
