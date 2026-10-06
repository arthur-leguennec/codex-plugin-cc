---
name: codex-companion-cli
description: Run, monitor and continue Codex jobs (task, review, adversarial-review) from the main session, a subagent or a workflow agent through the `codex-companion` CLI, and get the commands to resume or join a Codex session. Use when you need Codex to work, review or investigate and you cannot (or should not) use the /codex:* slash commands.
---

<!-- Fork addition (Apache-2.0 §4(b)): model-invocable CLI guide for agents. -->

# Codex Companion CLI (for agents)

`codex-companion` is on the PATH of the Bash tool while this plugin is enabled. Do not look for `${CLAUDE_PLUGIN_ROOT}`.
If `command -v codex-companion` finds nothing, run `ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/codex/*/bin/codex-companion | head -1` and call that file directly (the newest installed version).

Every command below accepts `--json` for machine-readable output. Run them from the directory you work in
(your repo or your git worktree): jobs from all worktrees of one repository share the same job list.

## Run a job

Delegate work (a fresh Codex thread, kept and resumable):

```bash
codex-companion task --write "Fix the failing test in tests/foo.test.mjs and explain the root cause"   # may edit files
codex-companion task "Find the root cause of the flaky login test"                                        # read-only
codex-companion task --background --write "Implement X"      # returns a job id immediately
codex-companion task --model spark --effort high "..."        # optional model / effort
codex-companion task --prompt-file prompt.md                  # long prompt from a file
```

- Foreground `task` blocks until Codex finishes and prints the result. Use `--background` for long work, then poll.
- `--write` lets Codex edit the workspace. Without it Codex is read-only. Pass `--write` only when edits are wanted.

Reviews (always read-only, foreground; start them with Bash `run_in_background: true` if they may take long):

```bash
codex-companion review                                    # uncommitted changes (or branch diff vs. default branch)
codex-companion review --base main                        # branch diff against a ref
codex-companion review --scope working-tree|branch|auto
codex-companion adversarial-review "focus on auth and race conditions"   # challenges the design; free-text focus allowed
codex-companion adversarial-review --base main
```

`review` does not accept focus text; `adversarial-review` does.

## Follow a job

```bash
codex-companion status --json                 # jobs of this session in this repository (all worktrees)
codex-companion status --all --json           # jobs of every Claude session for this repository
codex-companion status <job-id> --json        # one job: status, phase, threadId, log file
codex-companion status <job-id> --wait --timeout-ms 240000 --json   # block until it finishes or times out
codex-companion result <job-id> --json        # final output of a finished job
codex-companion cancel <job-id> --json        # stop a queued or running job
```

Job statuses: `queued`, `running`, `completed`, `failed`, `cancelled`. `status --wait` can return while the job is
still `running` (`waitTimedOut: true`): poll again. Without a job id, `result` and `cancel` pick the latest finished
or only active job; pass the id explicitly when several jobs run in parallel.

## Continue a specific thread

Every job exposes its Codex `threadId` in `status <job-id> --json` and `result --json`, and foreground `task --json`
prints it too. A `--background` launch only returns the job id: read the `threadId` from `status <job-id> --json`
once the job is running.
When several jobs run in parallel, continue YOUR thread by id; `--resume-last` may pick someone else's:

```bash
codex-companion task --resume-thread <thread-id> "Now also handle the empty-input case"
codex-companion task --resume-thread <thread-id> --write --background "Apply the fix you proposed"
```

`--resume-thread` cannot be combined with `--resume-last` or `--fresh`, and needs a non-empty id. `--resume-last`
continues the most recent task thread of this Claude session started from this checkout (worktree), and refuses while
such a task is still running.
Reviews keep their own threads too (named `Codex Companion [Adversarial ]Review: <target>`).

## Resume or join a session in the Codex terminal UI

Read `threadId` from `status --json` / `result --json`, then give the user:

- Resume after the job ended: `codex resume <thread-id>` (human-readable output also prints `Resume in Codex: ...`).
- Join while it runs, when the job used the shared app-server (`appServerTransport: "shared"`, printed as
  `Join live (shared server): ...`): `codex resume --remote unix:// <thread-id>`.

The shared app-server is opt-in (`CODEX_COMPANION_APP_SERVER_MODE=shared|auto`; default `private`). In `private` mode a
running job cannot be joined, only resumed once it is finished. Commands Codex runs on the shared server use the
server's environment, not the Claude session's (no venv, no AWS profile...). Do not type into a session that a job is
currently driving.

## Rules

- Never fabricate a job id or thread id; copy them from command output.
- Run at most one blocking Codex command per tool call; do not chain `task` calls with `&`.
- Present Codex output faithfully; do not claim you verified what Codex reported unless you did.
