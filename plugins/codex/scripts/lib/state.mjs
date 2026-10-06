// Fork modification (Apache-2.0 §4(b)): state directory shared by all git worktrees of a repository,
// locked and atomic state updates.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_FILE_SUFFIX = ".lock";
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 15000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// All linked worktrees of a repository share the state of its main checkout,
// so jobs started from a worktree show up everywhere (and vice versa).
// Bare repositories and separate git dirs are keyed by the common git dir itself.
// Falls back to the plain workspace root outside git.
const stateRootCache = new Map();

export function resolveStateRoot(cwd) {
  // Resolved for every state/job path: spawn git once per directory and process.
  const key = path.resolve(cwd ?? process.cwd());
  if (!stateRootCache.has(key)) {
    stateRootCache.set(key, computeStateRoot(key));
  }
  return stateRootCache.get(key);
}

function computeStateRoot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return workspaceRoot;
  }
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    return workspaceRoot;
  }
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
}

function stateDirForRoot(workspaceRoot) {
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateDir(cwd) {
  return stateDirForRoot(resolveStateRoot(cwd));
}

// Per-checkout state (not shared across worktrees), e.g. the app-server broker,
// which runs with the cwd and environment of the checkout that started it.
export function resolveWorkspaceStateDir(cwd) {
  return stateDirForRoot(resolveWorkspaceRoot(cwd));
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function tryRemoveStaleLock(lockPath) {
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // The lock disappeared in the meantime.
  }
}

function tryAcquireLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    tryRemoveStaleLock(lockPath);
    return false;
  }
}

function lockTimeoutError(lockPath) {
  return new Error(`Timed out waiting for the Codex companion state lock (${lockPath}).`);
}

/** Runs `fn` while holding an exclusive lockfile next to `filePath` (synchronous). */
export function withFileLock(filePath, fn) {
  const lockPath = `${filePath}${LOCK_FILE_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryAcquireLock(lockPath)) {
    if (Date.now() > deadline) {
      throw lockTimeoutError(lockPath);
    }
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Async variant of withFileLock, for critical sections that await. */
export async function withFileLockAsync(filePath, fn) {
  const lockPath = `${filePath}${LOCK_FILE_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryAcquireLock(lockPath)) {
    if (Date.now() > deadline) {
      throw lockTimeoutError(lockPath);
    }
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Writes through a temp file and a rename, so readers never see a partial file. */
export function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (attempt >= 20 || (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY")) {
        fs.rmSync(tempPath, { force: true });
        throw error;
      }
      sleepSync(10);
    }
  }
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function readStateFile(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

// Inside the lock: a corrupt state file is moved aside (never silently overwritten).
function readStateFileForUpdate(stateFile) {
  try {
    return readStateFile(stateFile);
  } catch {
    try {
      fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
    } catch {
      // Keep going with an empty state; the next save replaces the file.
    }
    return defaultState();
  }
}

export function loadState(cwd) {
  try {
    return readStateFile(resolveStateFile(cwd));
  } catch {
    return defaultState();
  }
}

// The cap applies per checkout, so a busy worktree cannot evict the jobs of another one.
function pruneJobs(jobs) {
  const keptPerRoot = new Map();
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .filter((job) => {
      const key = job.workspaceRoot ?? "";
      const kept = keptPerRoot.get(key) ?? 0;
      keptPerRoot.set(key, kept + 1);
      return kept < MAX_JOBS;
    });
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeState(cwd, state, previousJobs) {
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  const stateFile = resolveStateFile(cwd);
  return withFileLock(stateFile, () => writeState(cwd, state, readStateFileForUpdate(stateFile).jobs));
}

// Read-modify-write under the state lock: the mutation always applies to the latest
// state, and only jobs removed or pruned by this update lose their files.
export function updateState(cwd, mutate) {
  const stateFile = resolveStateFile(cwd);
  return withFileLock(stateFile, () => {
    const state = readStateFileForUpdate(stateFile);
    const previousJobs = [...state.jobs];
    mutate(state);
    return writeState(cwd, state, previousJobs);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
