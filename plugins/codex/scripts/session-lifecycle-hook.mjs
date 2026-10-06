#!/usr/bin/env node
// Fork modification (Apache-2.0 §4(b)): exports the plugin bin/ dir on PATH; keeps the broker
// alive while other sessions still run jobs; locked job cleanup.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readStdinSync } from "./lib/fs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { listJobs } from "./lib/job-control.mjs";
import { resolveStateFile, updateState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = readStdinSync().trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// Fallback for hosts that do not put the plugin's bin/ on PATH: expose it through
// CLAUDE_ENV_FILE, idempotently.
function appendPluginBinToPath() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!process.env.CLAUDE_ENV_FILE || !root) {
    return;
  }
  const binDir = path.join(root, "bin");
  if (!fs.existsSync(binDir)) {
    return;
  }
  const quoted = shellEscape(binDir);
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `case ":$PATH:" in *":"${quoted}":"*) ;; *) export PATH="$PATH":${quoted} ;; esac\n`,
    "utf8"
  );
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const removedJobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

// Several Claude sessions in the same checkout share one broker: keep it while another
// session still has a job in flight there.
function otherSessionsHaveActiveJobs(cwd, sessionId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return false;
  }
  return listJobs(workspaceRoot).some(
    (job) =>
      (job.status === "queued" || job.status === "running") &&
      job.sessionId !== sessionId &&
      (!job.workspaceRoot || job.workspaceRoot === workspaceRoot)
  );
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  appendPluginBinToPath();
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  cleanupSessionJobs(cwd, sessionId);
  if (otherSessionsHaveActiveJobs(cwd, sessionId)) {
    return;
  }

  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
