# Changelog

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
