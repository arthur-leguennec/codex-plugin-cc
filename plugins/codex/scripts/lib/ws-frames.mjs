// Fork addition (Apache-2.0 §4(b)): minimal WebSocket client codec (RFC 6455)
// used to talk to the shared Codex app-server through `codex app-server proxy`,
// which relays raw bytes to a WebSocket endpoint. Strict server-frame validation.
import { createHash, randomBytes } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function buildHandshake(host = "localhost") {
  const key = randomBytes(16).toString("base64");
  const request =
    `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
  return { request, expectedAccept };
}

/** Encode one masked client frame (opcode 0x1 text, 0x8 close, 0xA pong). */
export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const mask = randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Incremental parser for server frames (unmasked). Handles fragmentation.
 * Calls onMessage(text) for data messages, onControl(opcode, payload) for ping/pong/close,
 * and onError(error) once on a protocol violation (the parser then ignores further input).
 */
export class FrameParser {
  constructor({ onMessage, onControl, onError = null, maxMessageBytes = MAX_MESSAGE_BYTES }) {
    this.chunks = [];
    this.buffered = 0;
    this.needed = 2;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.failed = false;
    this.onMessage = onMessage;
    this.onControl = onControl;
    this.onError = onError;
    this.maxMessageBytes = maxMessageBytes;
  }

  fail(message) {
    this.failed = true;
    this.chunks = [];
    this.fragments = [];
    const error = new Error(`WebSocket protocol error: ${message}`);
    if (this.onError) {
      this.onError(error);
      return;
    }
    throw error;
  }

  push(chunk) {
    if (this.failed) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    // Only concatenate once a whole frame (or header) is available: large messages
    // arrive in many chunks and re-concatenating each time would be quadratic.
    if (this.buffered < this.needed) return;
    let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.buffered = 0;
    this.needed = 2;

    while (!this.failed) {
      if (buffer.length < 2) break;
      const fin = (buffer[0] & 0x80) !== 0;
      const rsv = buffer[0] & 0x70;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (rsv !== 0) return this.fail("reserved bits set");
      if (masked) return this.fail("server frames must not be masked");
      if ((opcode > 0x2 && opcode < 0x8) || opcode > 0xa) return this.fail(`unknown opcode ${opcode}`);
      if (length === 126) {
        if (buffer.length < 4) {
          this.needed = 4;
          break;
        }
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) {
          this.needed = 10;
          break;
        }
        const bigLength = buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(this.maxMessageBytes)) return this.fail("frame too large");
        length = Number(bigLength);
        offset = 10;
      }
      if (opcode >= 0x8 && (length > 125 || !fin)) return this.fail("invalid control frame");
      if (opcode < 0x8 && this.fragmentBytes + length > this.maxMessageBytes) return this.fail("message too large");
      if (buffer.length < offset + length) {
        this.needed = offset + length;
        break;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (opcode >= 0x8) {
        this.onControl(opcode, payload);
        continue;
      }
      if ((opcode === 0x0) === (this.fragments.length === 0)) {
        return this.fail(opcode === 0x0 ? "continuation without a message" : "new message inside a fragmented one");
      }
      // Text and binary messages both carry JSON text for the app-server protocol.
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.onMessage(text);
      }
    }
    if (!this.failed && buffer.length > 0) {
      this.chunks = [buffer];
      this.buffered = buffer.length;
    }
  }
}
