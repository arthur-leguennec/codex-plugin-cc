import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { APP_SERVER_MODE_ENV, resolveAppServerMode } from "../plugins/codex/scripts/lib/app-server.mjs";
import { formatCodexJoinCommand } from "../plugins/codex/scripts/lib/render.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const SESSION_HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

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

function fakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function envFor(binDir, extra = {}) {
  return { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: path.join(binDir, "plugin-data"), ...extra };
}

test("resolveAppServerMode defaults to private and accepts private|shared|auto", () => {
  assert.equal(resolveAppServerMode({}), "private");
  assert.equal(resolveAppServerMode({ [APP_SERVER_MODE_ENV]: "bogus" }), "private");
  assert.equal(resolveAppServerMode({ [APP_SERVER_MODE_ENV]: "Shared" }), "shared");
  assert.equal(resolveAppServerMode({ [APP_SERVER_MODE_ENV]: "auto" }), "auto");
  assert.equal(resolveAppServerMode({ [APP_SERVER_MODE_ENV]: "private" }), "private");
});

test("default mode never touches the shared server", () => {
  const { repo, binDir } = makeRepo();
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env: envFor(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(binDir).proxyStarts ?? 0, 0);
});

test("shared mode talks to the shared server through app-server proxy", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "shared" });
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const threadId = JSON.parse(result.stdout).threadId;
  assert.ok(threadId);
  const state = fakeState(binDir);
  assert.ok(state.proxyStarts >= 1);
  assert.equal(state.threads.length, 1);
});

test("shared jobs show the command to join the live session in status and result", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "shared" });
  const task = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const { threadId } = JSON.parse(task.stdout);

  const status = run("node", [SCRIPT, "status", "--all"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`Join live \\(shared server\\): codex resume --remote unix:// ${threadId}`));

  const result = run("node", [SCRIPT, "result"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Resume in Codex: codex resume ${threadId}`));
  assert.match(result.stdout, new RegExp(`Join live \\(shared server\\): codex resume --remote unix:// ${threadId}`));
});

test("private jobs do not advertise a live join command", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "private", FAKE_CODEX_DAEMON: "running" });
  const task = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const status = run("node", [SCRIPT, "status", "--all"], { cwd: repo, env });
  assert.doesNotMatch(status.stdout, /Join live/);
  assert.equal(fakeState(binDir).proxyStarts ?? 0, 0);
  assert.equal(formatCodexJoinCommand({ threadId: "t", appServerTransport: "direct" }), null);
});

test("auto mode falls back to a private app-server when the shared one is down", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "auto", FAKE_CODEX_DAEMON: "stopped" });
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fakeState(binDir).proxyStarts ?? 0, 0);
  const status = run("node", [SCRIPT, "status", "--all"], { cwd: repo, env });
  assert.doesNotMatch(status.stdout, /Join live/);
});

test("auto mode uses the shared server when it is running", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "auto" });
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fakeState(binDir).proxyStarts >= 1);
});

test("forced shared mode fails loudly when the shared server is unavailable", () => {
  const { repo, binDir } = makeRepo();
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "shared", FAKE_CODEX_DAEMON: "stopped" });
  const result = run("node", [SCRIPT, "task", "--json", "hello"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, new RegExp(APP_SERVER_MODE_ENV));
});

test("cancel interrupts the running turn of a shared-server job", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = envFor(binDir, { [APP_SERVER_MODE_ENV]: "shared" });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  const stateDir = resolveStateDir(repo);
  if (previousPluginData === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  }
  const runningJob = await waitFor(() => {
    const statePath = path.join(stateDir, "state.json");
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const job = JSON.parse(fs.readFileSync(statePath, "utf8")).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId ? job : null;
  });
  assert.equal(runningJob.appServerTransport, "shared");

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, true);

  const lastInterrupt = await waitFor(() => fakeState(binDir).lastInterrupt ?? null);
  assert.deepEqual(lastInterrupt, { threadId: runningJob.threadId, turnId: runningJob.turnId });

  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
});
