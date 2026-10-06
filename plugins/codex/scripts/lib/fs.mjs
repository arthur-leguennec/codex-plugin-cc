// Fork modification (Apache-2.0 §4(b)): EAGAIN-safe synchronous stdin read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const STDIN_RETRY_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Reads all of stdin synchronously. `fs.readFileSync(0)` throws EAGAIN when stdin is a
 * non-blocking pipe whose writer has not sent everything yet (large hook payloads).
 */
export function readStdinSync() {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN") {
        Atomics.wait(STDIN_RETRY_CELL, 0, 0, 5);
        continue;
      }
      if (error?.code === "EOF") {
        break;
      }
      throw error;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return readStdinSync();
}
