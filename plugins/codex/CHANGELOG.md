# Changelog

## 1.0.6-fork.2

- Lock and atomically write `state.json`, job files and `broker.json`; a corrupt state file is moved aside instead of being silently reset. The 50-job cap applies per checkout.
- Keep one app-server broker per checkout, start it under a lock, and keep it alive at SessionEnd while other sessions still have jobs in flight.
- Mark jobs whose process died as failed; companion processes record SIGTERM/SIGINT/SIGHUP; `cancel` keeps a result that arrived during the interrupt and interrupts on the server the job ran on.
- Signal non-group-leader pids on cancel; treat signal-killed commands as failures.
- Requests fail fast once the app-server connection is gone; the broker exits with its app-server and handles each client connection serially.
- Shared mode: time out the handshake, reap the proxy on failure, retry right after starting the daemon, answer server close frames, kill the whole tree on Windows, validate WebSocket frames strictly.
- `/codex:rescue --resume-thread` no longer asks to continue/start a thread; blank `--resume-thread` is an error; `--resume-last` only picks threads from the current checkout; `status --all` lists every session's jobs.
- Argument parsing keeps Windows paths and apostrophes, and value options no longer swallow the next flag.
- Stop gate: prompt passed on stdin (no 128 KiB argv limit), inner timeout below the hook timeout.
- Bare repositories with linked worktrees share state; the marketplace owner is the fork maintainer.
- Files changed by the fork that cannot carry a notice: `.claude-plugin/marketplace.json`, `plugins/codex/.claude-plugin/plugin.json`, `plugins/codex/package.json`, `package.json`, `package-lock.json`.

## 1.0.6-fork.1

Fork of `openai/codex-plugin-cc` v1.0.6 (see the README, "Fork changes").

- `review` and `adversarial-review` keep their Codex thread, with a readable thread name, so they can be opened with `codex resume`.
- Add `task --resume-thread <thread-id>`; `codex-rescue` forwards it.
- Add an opt-in shared app-server mode (`CODEX_COMPANION_APP_SERVER_MODE=private|shared|auto`) that talks to the shared Codex app-server through `codex app-server proxy`; `/codex:status` and `/codex:result` print the command to join a running session.
- Add `bin/codex-companion`, a SessionStart PATH fallback and the model-invocable `codex-companion-cli` skill so subagents and workflow agents can run and follow Codex jobs.
- Share job state across all git worktrees of a repository.
- Rename the marketplace to `arthur-leguennec-codex` (plugin name stays `codex`).

## 1.0.0

- Initial version of the Codex plugin for Claude Code
