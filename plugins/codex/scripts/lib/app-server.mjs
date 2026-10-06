// Fork modification (Apache-2.0 §4(b)): optional shared app-server transport (WebSocket over `codex app-server proxy`),
// requests fail fast once the connection has exited.
/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { FrameParser, buildHandshake, encodeFrame } from "./ws-frames.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const APP_SERVER_MODE_ENV = "CODEX_COMPANION_APP_SERVER_MODE";
export const APP_SERVER_MODES = ["private", "shared", "auto"];
const DAEMON_PROBE_TIMEOUT_MS = 5000;
const DAEMON_START_TIMEOUT_MS = 20000;
const SHARED_CONNECT_TIMEOUT_MS = 10000;
const SHARED_CONNECT_ATTEMPTS = 3;

/**
 * private (default): one app-server per workspace, as in upstream.
 * shared: attach to the shared local app-server daemon (start it if needed).
 * auto: use the shared daemon only when it is already running, else private.
 */
export function resolveAppServerMode(env = process.env) {
  const raw = String(env?.[APP_SERVER_MODE_ENV] ?? "").trim().toLowerCase();
  return APP_SERVER_MODES.includes(raw) ? raw : "private";
}

function runDaemonCommand(subcommand, env, timeout) {
  const result = spawnSync("codex", ["app-server", "daemon", subcommand], {
    env: env ?? process.env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// One probe per process: a companion run connects several times (task, interrupt, auth).
const daemonProbeCache = new Map();

function daemonProbeKey(env) {
  const source = env ?? process.env;
  return `${source.CODEX_HOME ?? ""}\0${source.PATH ?? ""}`;
}

export function isSharedServerRunning(env) {
  const key = daemonProbeKey(env);
  if (!daemonProbeCache.has(key)) {
    daemonProbeCache.set(key, runDaemonCommand("version", env, DAEMON_PROBE_TIMEOUT_MS)?.status === "running");
  }
  return daemonProbeCache.get(key);
}

export function startSharedServer(env) {
  const key = daemonProbeKey(env);
  daemonProbeCache.delete(key);
  const started = runDaemonCommand("start", env, DAEMON_START_TIMEOUT_MS)?.status === "started" || isSharedServerRunning(env);
  if (started) {
    daemonProbeCache.set(key, true);
  }
  return started;
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }
    if (this.exitResolved) {
      return Promise.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });
    // EPIPE when the app-server exits before a write: surface it as a closed connection.
    this.proc.stdin.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

/**
 * Client for the shared local Codex app-server. `codex app-server proxy` relays
 * stdio bytes to the daemon's control socket, which speaks WebSocket, so this
 * client performs the WebSocket handshake and framing over the proxy's stdio.
 */
class SharedProxyAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "shared";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server", "proxy"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.stdin.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      this.handleExit(
        code === 0 || this.closed
          ? null
          : createProtocolError(
              `codex app-server proxy exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            )
      );
    });

    const { request, expectedAccept } = buildHandshake();
    this.parser = new FrameParser({
      onMessage: (text) => this.handleLine(text),
      onControl: (opcode, payload) => {
        if (opcode === 0x9 && !this.closed && !this.exitResolved) {
          this.proc.stdin.write(encodeFrame(payload, 0xa));
        } else if (opcode === 0x8) {
          this.handleServerClose(payload);
        }
      },
      onError: (error) => {
        this.handleExit(createProtocolError(`Shared Codex app-server: ${error.message}`));
        this.close().catch(() => {});
      }
    });

    let handshakeBuffer = Buffer.alloc(0);
    let upgraded = false;
    let resolveHandshake;
    let rejectHandshake;
    const handshake = new Promise((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    this.proc.stdout.on("data", (chunk) => {
      if (upgraded) {
        this.parser.push(chunk);
        return;
      }
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const end = handshakeBuffer.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const head = handshakeBuffer.subarray(0, end).toString("utf8");
      const acceptHeader = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1] ?? null;
      if (!/^HTTP\/1\.1 101/.test(head) || acceptHeader !== expectedAccept) {
        rejectHandshake(createProtocolError(`Shared Codex app-server rejected the WebSocket upgrade: ${head.split("\r\n")[0]}`));
        return;
      }
      upgraded = true;
      const rest = handshakeBuffer.subarray(end + 4);
      resolveHandshake();
      if (rest.length > 0) {
        this.parser.push(rest);
      }
    });
    this.exitPromise.then(() => rejectHandshake(this.exitError ?? new Error("codex app-server proxy closed during handshake.")));

    this.proc.stdin.write(request);

    // A wedged daemon must not hang the caller: bound the handshake and initialize, and
    // always reap the proxy when connecting fails (it would keep the event loop alive).
    const timeoutMs = this.options.sharedConnectTimeoutMs ?? SHARED_CONNECT_TIMEOUT_MS;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(createProtocolError(`Timed out after ${timeoutMs}ms connecting to the shared Codex app-server.`)),
        timeoutMs
      );
      timer.unref?.();
    });
    try {
      await Promise.race([
        (async () => {
          await handshake;
          await this.request("initialize", {
            clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
            capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
          });
        })(),
        timeout
      ]);
    } catch (error) {
      this.handleExit(error);
      await this.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.notify("initialized", {});
  }

  handleServerClose(payload) {
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
    const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
    if (!this.closed) {
      try {
        this.proc.stdin.write(encodeFrame(payload.subarray(0, Math.min(payload.length, 2)), 0x8));
      } catch {
        // The proxy may already be gone.
      }
    }
    this.handleExit(
      code === 1000 || code === null
        ? null
        : createProtocolError(`Shared Codex app-server closed the connection (code ${code}${reason ? `: ${reason}` : ""}).`)
    );
    this.close().catch(() => {});
  }

  sendMessage(message) {
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server proxy stdin is not available.");
    }
    stdin.write(encodeFrame(JSON.stringify(message)));
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    try {
      if (!this.exitResolved) {
        this.proc?.stdin.write(encodeFrame(Buffer.alloc(0), 0x8));
      }
      this.proc?.stdin.end();
    } catch {
      // The proxy may already be gone.
    }
    setTimeout(() => {
      if (this.proc && this.proc.exitCode === null) {
        // On Windows the direct child is the shell wrapper; kill the whole tree.
        if (process.platform === "win32") {
          try {
            terminateProcessTree(this.proc.pid);
          } catch {
            // Best-effort cleanup inside an unref'd timer.
          }
        } else {
          this.proc.kill("SIGTERM");
        }
      }
    }, 200).unref?.();
    await this.exitPromise;
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    const mode = options.disableBroker ? "private" : options.appServerMode ?? resolveAppServerMode(options.env ?? process.env);
    if (mode !== "private") {
      const env = options.env ?? process.env;
      const available = isSharedServerRunning(env) || (mode === "shared" && startSharedServer(env));
      if (available) {
        // Right after `daemon start` the socket may not be listening yet: retry briefly.
        const attempts = mode === "shared" ? SHARED_CONNECT_ATTEMPTS : 1;
        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const shared = new SharedProxyAppServerClient(cwd, options);
            await shared.initialize();
            return shared;
          } catch (error) {
            lastError = error;
            if (attempt < attempts) {
              await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            }
          }
        }
        if (mode === "shared") {
          throw lastError;
        }
      } else if (mode === "shared") {
        throw new Error(
          `${APP_SERVER_MODE_ENV}=shared but the shared Codex app-server is not running and could not be started. Run \`codex app-server daemon start\`, or set ${APP_SERVER_MODE_ENV}=private.`
        );
      }
    }
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
