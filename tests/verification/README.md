# Delegated verification

This development-only harness keeps noisy deterministic verification output out
of the foreground agent context. It is under `tests/`, so it is not included in
the npm package.

## Start through boxed-tmux

From the repository root:

```bash
tests/verification/start-boxed.sh quick
# or the complete matrix
tests/verification/start-boxed.sh full
```

The launcher uses the outer project's socket at
`../.agents/run/tmux-socket` and writes one private run under:

```text
../.agents/run/verification/<run-id>/
```

A run contains mode-0600 command logs, `summary.json`, `result.md`, and a `done`
sentinel written last. Read only the summary/result after `done` exists. Inspect a
narrow log excerpt only for a failed command, then kill the retained tmux window
and explicitly remove obsolete run data.

The default runner rejects a dirty source tree and verifies that commit/worktree
state did not change while commands ran. `ALLOW_DIRTY=1` exists only for harness
development and records the dirty snapshot; do not use it as release evidence.
Each command has a ten-minute default timeout and an 8 MiB private-log cap.

Profiles:

- `quick`: current-Node lint, syntax, and deterministic tests via `npm run check`.
- `full`: `quick`, full Node 20 runtime tests, production audit, Agent Skills
  validation, engine-strict packed Node 20/npm 9 installation, wiring smoke, and
  packed Pi skill/prompt discovery.
- `self-pass`, `self-fail`, `self-timeout`, and `self-overflow`: deterministic
  harness regressions only.

Direct invocation is available for tests:

```bash
node tests/verification/run.mjs \
  --profile self-pass \
  --output-dir /new/private/output-directory \
  --allow-dirty
```

Passing test execution is model-free. A read-only Pi subagent may later inspect
only failed logs when human/foreground triage is still substantial; that optional
phase is intentionally not implemented here.
