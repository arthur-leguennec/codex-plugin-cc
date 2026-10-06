// Fork addition (Apache-2.0 §4(b)): minimal WebSocket client codec (RFC 6455)
// used to talk to the shared Codex app-server through `codex app-server proxy`,
// which relays raw bytes to a WebSocket endpoint.
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

/**
 * Incremental parser for server frames (unmasked). Handles fragmentation.
 * Calls onMessage(text) for data messages, onControl(opcode, payload) for ping/pong/close.
 */
export class FrameParser {
  constructor({ onMessage, onControl }) {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onMessage = onMessage;
    this.onControl = onControl;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length);

      if (opcode >= 0x8) {
        this.onControl(opcode, payload);
        continue;
      }
      this.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.onMessage(text);
      }
    }
  }
}
