import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const BIN = path.join(PLUGIN_ROOT, "bin", "codex-companion");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function makeRepoWithWorktree() {
  const repo = fs.realpathSync(makeTempDir());
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const worktree = path.join(fs.realpathSync(makeTempDir()), "wt");
  const added = run("git", ["worktree", "add", "-b", "feature", worktree], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);
  return { repo, worktree };
}

function parseFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, "missing frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
  );
}

test("all git worktrees of a repository share one state directory", () => {
  const { repo, worktree } = makeRepoWithWorktree();
  assert.equal(resolveStateDir(worktree), resolveStateDir(repo));
  const sub = path.join(worktree, "nested");
  fs.mkdirSync(sub);
  assert.equal(resolveStateDir(sub), resolveStateDir(repo));
});

test("a repository outside any worktree keeps a distinct state directory", () => {
  const first = makeRepoWithWorktree();
  const second = makeRepoWithWorktree();
  assert.notEqual(resolveStateDir(first.repo), resolveStateDir(second.repo));
});

test("a job started from a worktree is visible from the main checkout, and vice versa", () => {
  const { repo, worktree } = makeRepoWithWorktree();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: path.join(binDir, "plugin-data"),
    CODEX_COMPANION_SESSION_ID: "session-main"
  };
  const script = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

  const fromWorktree = run("node", [script, "task", "--json", "from worktree"], { cwd: worktree, env });
  assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
  const fromMain = run("node", [script, "task", "--json", "from main"], { cwd: repo, env });
  assert.equal(fromMain.status, 0, fromMain.stderr);

  for (const cwd of [repo, worktree]) {
    const status = run("node", [script, "status", "--json"], { cwd, env });
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    const jobs = [...(report.running ?? []), ...(report.recent ?? []), ...(report.latestFinished ? [report.latestFinished] : [])];
    const roots = new Set(jobs.map((job) => job.workspaceRoot));
    assert.ok(roots.has(worktree), `worktree job missing when listing from ${cwd}`);
    assert.ok(roots.has(repo), `main job missing when listing from ${cwd}`);
  }

  const text = run("node", [script, "status"], { cwd: repo, env });
  assert.match(text.stdout, new RegExp(`Workspace: ${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("the codex-companion bin entry point runs without CLAUDE_PLUGIN_ROOT", () => {
  assert.ok(fs.statSync(BIN).mode & 0o111, "bin/codex-companion must be executable");
  const repo = makeRepoWithWorktree().repo;
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  env.CLAUDE_PLUGIN_DATA = makeTempDir();
  const result = run(BIN, ["status", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).workspaceRoot);
});

test("SessionStart exports the plugin bin directory on PATH idempotently", () => {
  const envFile = path.join(makeTempDir(), "env.sh");
  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: makeTempDir(),
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    input: JSON.stringify({ session_id: "s1" })
  });
  assert.equal(result.status, 0, result.stderr);
  const probe = run("bash", ["-c", `source '${envFile}'; source '${envFile}'; echo "$PATH"`], { env: { PATH: "/usr/bin:/bin" } });
  const entries = probe.stdout.trim().split(":").filter((entry) => entry === path.join(PLUGIN_ROOT, "bin"));
  assert.equal(entries.length, 1);
});

test("the codex-companion-cli skill is model-invocable and documents the whole CLI", () => {
  const skillPath = path.join(PLUGIN_ROOT, "skills", "codex-companion-cli", "SKILL.md");
  assert.ok(fs.existsSync(skillPath));
  const markdown = fs.readFileSync(skillPath, "utf8");
  const frontmatter = parseFrontmatter(markdown);
  assert.equal(frontmatter.name, "codex-companion-cli");
  assert.ok(frontmatter.description.length > 20);
  assert.equal(frontmatter["disable-model-invocation"], undefined);
  assert.notEqual(frontmatter["user-invocable"], "false");
  for (const needle of [
    "task --background",
    "--write",
    "--resume-thread",
    "adversarial-review",
    "status --json",
    "result <job-id> --json",
    "cancel <job-id>",
    "codex resume",
    "codex resume --remote unix://"
  ]) {
    assert.ok(markdown.includes(needle), `skill should mention ${needle}`);
  }
});

test("slash commands for the human user stay hidden from the model", () => {
  for (const name of ["status", "result", "cancel", "review", "adversarial-review", "transfer"]) {
    const markdown = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${name}.md`), "utf8");
    assert.equal(parseFrontmatter(markdown)["disable-model-invocation"], "true", name);
  }
});
