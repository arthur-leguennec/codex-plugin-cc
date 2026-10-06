// Fork addition (Apache-2.0 §4(b)): regression tests for the fork review findings.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { APP_SERVER_MODE_ENV, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/job-control.mjs";
import { isProcessAlive, runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import {
  listJobs as listStoredJobs,
  loadState,
  resolveStateDir,
  resolveStateFile,
  resolveWorkspaceStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { FrameParser, encodeFrame } from "../plugins/codex/scripts/lib/ws-frames.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");
const STATE_MODULE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "state.mjs");

function makeRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir };
}

function withPluginData(dir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

// Server-side (unmasked) frame, as the shared app-server sends them.
function serverFrame(payload, { opcode = 0x1, fin = true, rsv = 0, masked = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (data.length < 126) {
    header = Buffer.from([0, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (masked) {
    header[1] |= 0x80;
    return Buffer.concat([header, Buffer.alloc(4), data]);
  }
  return Buffer.concat([header, data]);
}

function feedInPieces(parser, buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    parser.push(buffer.subarray(offset, offset + size));
  }
}

test("FrameParser decodes every payload length class, split into small chunks", () => {
  for (const length of [0, 125, 126, 65535, 65536, 70000]) {
    const messages = [];
    const parser = new FrameParser({ onMessage: (text) => messages.push(text), onControl: () => {} });
    const text = "x".repeat(length);
    feedInPieces(parser, serverFrame(text), 7);
    assert.deepEqual(messages, [text], `length ${length}`);
  }
});

test("FrameParser joins fragments around a ping and a UTF-8 character split across them", () => {
  const messages = [];
  const controls = [];
  const parser = new FrameParser({ onMessage: (text) => messages.push(text), onControl: (opcode) => controls.push(opcode) });
  const bytes = Buffer.from('{"a":"é"}', "utf8");
  const cut = bytes.indexOf(0xc3) + 1;
  parser.push(
    Buffer.concat([
      serverFrame(bytes.subarray(0, cut), { fin: false }),
      serverFrame(Buffer.from("p"), { opcode: 0x9 }),
      serverFrame(bytes.subarray(cut), { opcode: 0x0 })
    ])
  );
  assert.deepEqual(messages, ['{"a":"é"}']);
  assert.deepEqual(controls, [0x9]);
});

test("FrameParser rejects masked server frames, reserved bits, unknown opcodes and oversize messages", () => {
  const cases = [
    serverFrame("x", { masked: true }),
    serverFrame("x", { rsv: 0x40 }),
    serverFrame("x", { opcode: 0x3 }),
    serverFrame("x", { opcode: 0x0 }),
    serverFrame("x".repeat(200))
  ];
  for (const [index, frame] of cases.entries()) {
    const errors = [];
    const parser = new FrameParser({
      onMessage: () => {},
      onControl: () => {},
      onError: (error) => errors.push(error),
      maxMessageBytes: 100
    });
    parser.push(frame);
    assert.equal(errors.length, 1, `case ${index}`);
  }
});

test("encodeFrame produces masked client frames for every length class", () => {
  for (const length of [5, 300, 70000]) {
    const frame = encodeFrame("y".repeat(length));
    assert.equal(frame[0], 0x81);
    assert.equal((frame[1] & 0x80) !== 0, true);
  }
});

test("raw argument splitting keeps Windows paths and apostrophes", () => {
  assert.deepEqual(splitRawArgumentString("--source C:\\Users\\me\\a.jsonl"), ["--source", "C:\\Users\\me\\a.jsonl"]);
  assert.deepEqual(splitRawArgumentString("it's slow --base main"), ["it's", "slow", "--base", "main"]);
  assert.deepEqual(splitRawArgumentString('"two words" --x="a b" c\\ d'), ["two words", "--x=a b", "c d"]);
  assert.deepEqual(splitRawArgumentString("\\\\server\\share"), ["\\\\server\\share"]);
});

test("value options do not swallow the next flag", () => {
  const config = { valueOptions: ["model"], booleanOptions: ["write"], aliasMap: { m: "model" } };
  assert.throws(() => parseArgs(["--model", "--write", "fix"], config), /Missing value for --model/);
  assert.throws(() => parseArgs(["-m", "--write"], config), /Missing value for -m/);
  assert.equal(parseArgs(["--model=--odd"], config).options.model, "--odd");
});

test("terminateProcessTree signals a process that leads no process group", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const outcome = terminateProcessTree(child.pid);
  assert.equal(outcome.delivered, true);
  await exited;
  assert.equal(isProcessAlive(child.pid), false);
});

test("runCommand reports a signal-killed command as a failure", { skip: process.platform === "win32" }, () => {
  const result = runCommand("sh", ["-c", "kill -TERM $$"]);
  assert.equal(result.signal, "SIGTERM");
  assert.notEqual(result.status, 0);
});

test("concurrent state writers keep every job and the config", async () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir();
  const writers = 4;
  const jobsPerWriter = 12;
  const source = `
    import { setConfig, upsertJob, writeJobFile, resolveJobLogFile } from ${JSON.stringify(STATE_MODULE)};
    import fs from "node:fs";
    const [workspace, writer, count] = process.argv.slice(1);
    for (let index = 0; index < Number(count); index += 1) {
      const id = "job-" + writer + "-" + index;
      writeJobFile(workspace, id, { id, status: "completed" });
      fs.writeFileSync(resolveJobLogFile(workspace, id), "log\\n");
      upsertJob(workspace, { id, status: "completed", logFile: resolveJobLogFile(workspace, id) });
      if (index === 0 && writer === "0") setConfig(workspace, "stopReviewGate", true);
    }
  `;
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, String(writer), String(jobsPerWriter)], {
          env,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      })
    )
  );

  withPluginData(dataDir, () => {
    const state = loadState(workspace);
    assert.equal(state.jobs.length, writers * jobsPerWriter);
    assert.equal(state.config.stopReviewGate, true);
    const files = fs.readdirSync(path.join(resolveStateDir(workspace), "jobs"));
    assert.equal(files.filter((name) => name.endsWith(".json")).length, writers * jobsPerWriter);
    assert.equal(fs.existsSync(`${resolveStateFile(workspace)}.lock`), false);
  });
});

test("a corrupt state file is moved aside, not silently overwritten", () => {
  const workspace = makeTempDir();
  withPluginData(makeTempDir(), () => {
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{ not json");
    upsertJob(workspace, { id: "job-1", status: "completed" });
    const siblings = fs.readdirSync(path.dirname(stateFile));
    assert.equal(siblings.some((name) => name.startsWith("state.json.corrupt-")), true);
    assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), ["job-1"]);
  });
});

test("jobs whose process is gone are marked failed", () => {
  const workspace = makeTempDir();
  withPluginData(makeTempDir(), () => {
    upsertJob(workspace, { id: "dead", status: "running", pid: 424242 });
    writeJobFile(workspace, "dead", { id: "dead", status: "running", pid: 424242 });
    upsertJob(workspace, { id: "alive", status: "running", pid: process.pid });
    const jobs = listJobs(workspace, { isProcessAlive: (pid) => pid === process.pid });
    const byId = Object.fromEntries(jobs.map((job) => [job.id, job]));
    assert.equal(byId.dead.status, "failed");
    assert.equal(byId.dead.pid, null);
    assert.equal(byId.alive.status, "running");
    assert.equal(listStoredJobs(workspace).find((job) => job.id === "dead").status, "failed");
    const stored = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "jobs", "dead.json"), "utf8"));
    assert.equal(stored.status, "failed");
  });
});

test("the broker state is per checkout while job state is shared by worktrees", () => {
  const { repo } = makeRepo();
  const worktree = path.join(makeTempDir(), "wt");
  run("git", ["worktree", "add", "-q", worktree], { cwd: repo });
  assert.equal(resolveStateDir(worktree), resolveStateDir(repo));
  assert.notEqual(resolveWorkspaceStateDir(worktree), resolveWorkspaceStateDir(repo));
  assert.equal(resolveWorkspaceStateDir(repo), resolveStateDir(repo));
});

test("worktrees of a bare repository share their job state", () => {
  const { repo } = makeRepo();
  const bare = path.join(makeTempDir(), "project.git");
  run("git", ["clone", "-q", "--bare", repo, bare]);
  const first = path.join(makeTempDir(), "one");
  const second = path.join(makeTempDir(), "two");
  run("git", ["worktree", "add", "-q", first], { cwd: bare });
  run("git", ["worktree", "add", "-q", "--detach", second], { cwd: bare });
  assert.equal(resolveStateDir(first), resolveStateDir(second));
});

test("auto mode falls back to private and exits when the shared server rejects the upgrade", () => {
  const { repo, binDir } = makeRepo();
  const env = { ...buildEnv(binDir), [APP_SERVER_MODE_ENV]: "auto", FAKE_CODEX_PROXY: "reject" };
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env, timeout: 30000 });
  assert.equal(result.error, undefined, "the command must not hang");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.threadId);
  run("node", [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
});

test("a silent shared server times out instead of hanging", async () => {
  const { repo, binDir } = makeRepo();
  const env = { ...buildEnv(binDir), FAKE_CODEX_PROXY: "silent" };
  const started = Date.now();
  await assert.rejects(
    CodexAppServerClient.connect(repo, { env, appServerMode: "shared", sharedConnectTimeoutMs: 300 }),
    /Timed out/
  );
  assert.ok(Date.now() - started < 10000);

  const client = await CodexAppServerClient.connect(repo, {
    env,
    appServerMode: "auto",
    sharedConnectTimeoutMs: 300,
    disableBroker: false,
    brokerEndpoint: null
  });
  try {
    assert.notEqual(client.transport, "shared");
  } finally {
    await client.close();
  }
  run("node", [SESSION_HOOK, "SessionEnd"], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
});

test("requests fail fast once the connection has exited", async () => {
  const { repo, binDir } = makeRepo();
  const client = await CodexAppServerClient.connect(repo, { env: buildEnv(binDir), disableBroker: true });
  client.proc.kill("SIGKILL");
  await client.exitPromise;
  await assert.rejects(client.request("thread/list", {}), /exited|closed/);
  await client.close();
});

test("SessionEnd keeps the broker while another session still runs a job", () => {
  const { repo, binDir } = makeRepo();
  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env: { ...env, CODEX_COMPANION_SESSION_ID: "sess-a" } });
  assert.equal(review.status, 0, review.stderr);
  const brokerFile = path.join(resolveWorkspaceStateDir(repo), "broker.json");
  if (!fs.existsSync(brokerFile)) {
    return;
  }

  // Another session has a job in flight (this test process stands in for its worker).
  upsertJob(repo, { id: "other", status: "running", pid: process.pid, sessionId: "sess-b", workspaceRoot: fs.realpathSync(repo) });
  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "sess-a" })
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(fs.existsSync(brokerFile), true);

  upsertJob(repo, { id: "other", status: "completed", pid: null });
  const last = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "sess-b" })
  });
  assert.equal(last.status, 0, last.stderr);
  assert.equal(fs.existsSync(brokerFile), false);
});

test("task rejects a blank --resume-thread", () => {
  const { repo, binDir } = makeRepo();
  const result = run("node", [SCRIPT, "task", "--resume-thread=", "hello"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--resume-thread needs a Codex thread id/);
});

test("status --all lists the jobs of every session", () => {
  const { repo, binDir } = makeRepo();
  upsertJob(repo, { id: "task-a", status: "completed", sessionId: "s1", jobClass: "task", title: "A" });
  upsertJob(repo, { id: "task-b", status: "completed", sessionId: "s2", jobClass: "task", title: "B" });
  const env = { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: "s1" };
  const own = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: repo, env }).stdout);
  const all = JSON.parse(run("node", [SCRIPT, "status", "--all", "--json"], { cwd: repo, env }).stdout);
  const ids = (report) => [report.latestFinished, ...report.recent].filter(Boolean).map((job) => job.id).sort();
  assert.deepEqual(ids(own), ["task-a"]);
  assert.deepEqual(ids(all), ["task-a", "task-b"]);
});

test("the stop gate passes a large Claude message without hitting the argv limit", () => {
  const { repo, binDir } = makeRepo();
  const env = buildEnv(binDir);
  const hook = path.join(ROOT, "plugins", "codex", "scripts", "stop-review-gate-hook.mjs");
  run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  const result = spawnSync(process.execPath, [hook], {
    cwd: repo,
    env,
    encoding: "utf8",
    input: JSON.stringify({ cwd: repo, last_assistant_message: "x".repeat(200 * 1024) })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /E2BIG/);
});
