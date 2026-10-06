# Review findings (fork main @ f2c0a79)

Working list for the fix PR. Remove this file once every item is fixed or
explicitly dropped. Origin: **fork** = introduced or widened by the fork
changes, **upstream** = present in `openai/codex-plugin-cc` at `db52e28`.
Paths are relative to `plugins/codex/` unless stated otherwise.

## High

- [ ] **H1. One worktree's SessionEnd kills the broker other worktrees use** (fork)
  `broker.json` lives in `resolveStateDir()`, which is now shared by all
  worktrees (`scripts/lib/state.mjs`, `scripts/lib/broker-lifecycle.mjs:73`).
  Session B in a linked worktree reuses the broker spawned by session A; when
  A ends, `scripts/session-lifecycle-hook.mjs:106-134` shuts it down and B's
  turn dies. The broker also runs with A's cwd and environment. The same
  teardown already hits two sessions in the *same* checkout (upstream).
  Fix: keep broker state per workspace root (not per git common dir), and only
  tear a broker down when no other session still uses it (client list or
  refcount).

- [ ] **H2. `state.json` updates are racy and can delete job files** (upstream, widened by fork)
  `scripts/lib/state.mjs:81-145`: read-modify-write without lock, non-atomic
  `writeFileSync`, a torn read silently returns `defaultState()`, and
  `saveState` unlinks the job JSON and log of every job missing from a stale
  snapshot. Reproduced: 3 concurrent writers kept 8/45 jobs and reset
  `stopReviewGate` to false; 4 writers deleted 18/48 job files. Worktree-shared
  state and the 50-job cap shared across worktrees make it more likely.
  Fix: lockfile (`O_EXCL` + retry + stale timeout) around `updateState`, write
  via temp file + `rename` (state, job files, broker.json), throw/retry on parse
  error instead of defaulting, prune only what this save evicts.

- [ ] **H3. Shared mode: proxy child leaks on handshake/initialize failure, CLI hangs** (fork)
  `scripts/lib/app-server.mjs:385-398, 504-508`: when `initialize()` throws, the
  `codex app-server proxy` child is never killed, keeping the event loop alive.
  Reproduced with a proxy answering `HTTP/1.1 400`: `auto` mode falls back to
  private, finishes, then hangs; `shared` mode hangs after the error.
  Fix: `await shared.close()` (or kill the proxy) in the `catch` before
  falling back or rethrowing. Add a test.

## Medium

- [ ] **M1. Requests hang forever once the connection has exited** (upstream + fork)
  `scripts/lib/app-server.mjs:126-137, 203-216`: after `handleExit`, `closed`
  stays false, so `request()` registers a pending entry nobody will settle.
  Hits the shared client after a server close frame (`:359`) and the broker
  when its app-server dies (broker keeps listening, every later call hangs).
  Fix: reject in `request()` when `exitResolved`; on a close frame echo it and
  end/kill the proxy, keep the close code in the error; make the broker exit
  and clean its socket/pid when `appClient.exitPromise` resolves.

- [ ] **M2. Shared mode: no timeout on handshake / `initialize`** (fork)
  `scripts/lib/app-server.mjs:398`: a wedged daemon makes `auto` wait forever
  instead of falling back. Fix: ~10 s timeout, kill proxy, reject.

- [ ] **M3. Cancel targets the current mode's server, not the job's** (fork)
  `scripts/lib/codex.mjs:983` (`interruptAppServerTurn`) reconnects with the
  current mode. A job started on the broker in `auto` mode while the daemon was
  down is "interrupted" on the shared daemon after it comes up (and vice
  versa); the turn keeps running. Fix: pass `job.appServerTransport` and force
  `appServerMode` accordingly.

- [ ] **M4. Shared mode on Windows: `close()` kills only the shell wrapper** (fork)
  `scripts/lib/app-server.mjs:429` uses `proc.kill("SIGTERM")` although the
  proxy is spawned through a shell on win32. Fix: reuse the
  `terminateProcessTree` branch from the private client (`:288-300`).

- [ ] **M5. `/codex:rescue --resume-thread` ends in a parser error** (fork)
  `commands/rescue.md:22-35` still asks Continue/New when a resumable thread
  exists; either answer adds `--resume`/`--fresh`, which `task` rejects with
  `--resume-thread`. Fix: "If the request includes `--resume-thread`, do not
  ask; leave it in the forwarded request."

- [ ] **M6. `status --all` does not show other sessions' jobs** (fork doc)
  `skills/codex-companion-cli/SKILL.md` promises "jobs of every Claude session",
  but `scripts/lib/job-control.mjs:216` always filters by the current session;
  `--all` only lifts the display cap. Fix the code or the doc.

- [ ] **M7. `terminateProcessTree` never signals a non-group-leader pid** (upstream)
  `scripts/lib/process.mjs:100-117`: on `ESRCH` from `kill(-pid)` it returns
  without trying `kill(pid)`. Foreground and stop-gate jobs are not group
  leaders, so `cancel` marks them cancelled while they keep running and later
  overwrite the status. Fix: fall back to `kill(pid)` on `ESRCH`.

- [ ] **M8. Dead jobs stay queued/running forever** (upstream)
  No liveness check (`process.kill(pid, 0)`), no SIGTERM handler marking the
  job failed. A crashed/killed worker blocks `--resume-last` ("still running")
  and its stale pid may later be signalled. The Stop hook timeout (900 s,
  `hooks/hooks.json`) equals the inner `spawnSync` timeout
  (`scripts/stop-review-gate-hook.mjs:109`), so the hook is killed first and
  the child is orphaned. Fix: liveness check on list/cancel, signal handlers,
  inner timeout below the hook timeout.

- [ ] **M9. Concurrent `ensureBrokerSession` spawns two brokers** (upstream)
  `scripts/lib/broker-lifecycle.mjs:113-171`: no lock; the losing broker is
  never recorded or killed. Stale teardown at `:120` passes no `killProcess`.
  Fix: lock around check-and-spawn, pass `terminateProcessTree`.

- [ ] **M10. `cancel` can overwrite a job that completed during the interrupt** (upstream)
  `scripts/codex-companion.mjs:986-1026` writes `{...existing, ...cancelled}`
  from a snapshot taken before the interrupt, dropping `result`/`rendered`.
  Fix: re-read the job after interrupt/kill; skip if already terminal.

## Low

- [ ] **L1. `--resume-last` without session id can pick another worktree's thread** (fork)
  `scripts/codex-companion.mjs:338-351` does not filter by `job.workspaceRoot`.
- [ ] **L2. Stop-review-gate config is now repo-wide across worktrees** (fork)
  Document it in README "Fork changes" or keep config per worktree.
- [ ] **L3. No state migration note** (fork)
  Worktree users lose per-worktree state; switching from `codex@openai-codex`
  changes `CLAUDE_PLUGIN_DATA` (gate setting, jobs orphaned). Add a README/
  CHANGELOG note.
- [ ] **L4. Bare-repo / `--separate-git-dir` worktrees are not shared** (fork)
  `scripts/lib/state.mjs:46-49` requires basename `.git`. Use `commonDir` itself
  as key otherwise, or document.
- [ ] **L5. Blank `--resume-thread` silently starts a fresh thread** (fork)
  `scripts/codex-companion.mjs:785`. Throw when present but blank.
- [ ] **L6. SKILL.md: background `task --json` has no `threadId`** (fork doc)
  Say to read it from `status <job-id> --json`.
- [ ] **L7. Licensing/branding details** (fork)
  `tests/fake-codex-fixture.mjs` lacks the modification notice; README claims
  all modified files carry one (JSON files cannot) — reword;
  `.claude-plugin/marketplace.json` `owner` still "OpenAI" on the renamed
  marketplace — set to the fork maintainer.
- [ ] **L8. Shared daemon probes are synchronous, 20 s timeout, every connect** (fork)
  `scripts/lib/app-server.mjs:40-61`: probe once per process, short timeout;
  retry proxy briefly after `daemon start` (possible not-yet-listening race).
- [ ] **L9. Argument splitting mangles backslashes and apostrophes** (upstream)
  `scripts/lib/args.mjs:76-128`: `C:\Users\me\a.jsonl` -> `C:Usersmea.jsonl`;
  `it's slow --base main` swallows `--base`. Value options also swallow the next
  flag (`--model --write`).
- [ ] **L10. `"$ARGUMENTS"` is shell-expanded in command files** (upstream)
  `commands/{cancel,status,result,transfer,review,adversarial-review}.md`:
  `$()`/backticks in focus text are executed. Low risk (user-typed), but
  corrupts legitimate text.
- [ ] **L11. `runCommand` maps signal-killed commands to status 0** (upstream)
  `scripts/lib/process.mjs:19`.
- [ ] **L12. Stop gate fails with E2BIG on >128 KiB last message** (upstream)
  `scripts/stop-review-gate-hook.mjs:105`: pass the prompt via file/stdin.
- [ ] **L13. Background worker spawned before its job file is written** (upstream, plausible)
  `scripts/codex-companion.mjs:692-706`.
- [ ] **L14. Broker `data` handler is async over a shared buffer** (upstream, plausible)
  `scripts/app-server-broker.mjs:123-223`: serialize per socket.

## Nits

- `ws-frames.mjs` accepts masked server frames, RSV bits, unknown opcodes;
  decodes binary as text; no size cap. Accept check uses `head.includes`.
- `status --timeout-ms 0` falls back to the default (`Number(x) || DEFAULT`).
- Root `package.json` name still `@openai/codex-plugin-cc`.
- SKILL.md fallback `ls ~/.claude/plugins/cache/...` ignores `CLAUDE_CONFIG_DIR`.

## Test gaps

- No unit tests for `ws-frames.mjs` (126/127 lengths, fragmentation, ping,
  close, 101 + frames in one chunk). Fake proxy cannot parse 127-length frames.
- No test for auto fallback after a failed handshake/initialize (would catch H3),
  handshake timeout, server close frame, cancel with transport != mode.
- No concurrency test on `state.json` (H2) or cross-worktree broker teardown (H1).
- `tests/shared-mode.test.mjs:171` cleanup not in `finally`.

## Not verifiable here (needs a real Codex login / Claude Code session)

- `codex resume --remote unix:// <id>` syntax and non-default `CODEX_HOME`.
- `codex app-server daemon` JSON `status` values (`running`, `started`).
