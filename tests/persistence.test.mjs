import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function makeChangedRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return { repo, binDir };
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

test("review keeps its Codex thread so it can be resumed", () => {
  const { repo, binDir } = makeChangedRepo();
  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  const threads = readFakeState(binDir).threads;
  assert.ok(threads.length >= 1);
  for (const thread of threads) {
    assert.equal(thread.ephemeral, false);
  }
  assert.match(threads[0].name, /^Codex Companion Review: /);
});

test("adversarial-review keeps its Codex thread so it can be resumed", () => {
  const { repo, binDir } = makeChangedRepo();
  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  const threads = readFakeState(binDir).threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].ephemeral, false);
  assert.match(threads[0].name, /^Codex Companion Adversarial Review: /);
});

test("task --resume-thread continues a specific thread, not the latest one", () => {
  const { repo, binDir } = makeChangedRepo();
  const env = buildEnv(binDir);
  const first = run("node", [SCRIPT, "task", "--json", "first task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstThreadId = JSON.parse(first.stdout).threadId;
  const second = run("node", [SCRIPT, "task", "--json", "second task"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  const secondThreadId = JSON.parse(second.stdout).threadId;
  assert.notEqual(firstThreadId, secondThreadId);

  const resumed = run("node", [SCRIPT, "task", "--json", "--resume-thread", firstThreadId, "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, firstThreadId);
  assert.equal(readFakeState(binDir).threads.length, 2);
});

test("task --resume-thread rejects --resume-last and --fresh", () => {
  const { repo, binDir } = makeChangedRepo();
  const env = buildEnv(binDir);
  const both = run("node", [SCRIPT, "task", "--resume-thread", "thr_1", "--resume-last", "x"], { cwd: repo, env });
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /not both/);
  const fresh = run("node", [SCRIPT, "task", "--resume-thread", "thr_1", "--fresh", "x"], { cwd: repo, env });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /--fresh/);
});
