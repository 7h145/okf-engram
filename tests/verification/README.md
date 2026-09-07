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
sentinel written last. Read only the summary/result after `done` exists. Inspect
one narrow log excerpt only for a failed command, then kill the retained tmux
window and explicitly remove obsolete run data.

The default runner rejects a dirty source tree and verifies that commit/worktree
state did not change while commands ran. `ALLOW_DIRTY=1` exists only for harness
development and records the dirty snapshot; do not use it as release evidence.
Each command has a ten-minute default timeout and an 8 MiB private-log cap.

Profiles:

- `quick`: current-Node lint, syntax, and deterministic tests via
  `npm run check`.
- `full`: `quick`, full Node 20 runtime tests, production audit, Agent Skills
  validation, engine-strict packed Node 20/npm 9 installation, wiring smoke, and
  packed Pi skill/prompt discovery.
- `self-pass`, `self-fail`, `self-timeout`, `self-overflow`, and `self-metrics`:
  deterministic harness regressions only.

Direct invocation is available for tests:

```bash
node tests/verification/run.mjs \
  --profile self-pass \
  --output-dir /new/private/output-directory \
  --allow-dirty
```

Passing test execution remains model-free.

## Optional failed-log triage

After a deterministic run fails, explicitly start the bounded reviewer:

```bash
tests/verification/triage/start-boxed.sh \
  ../.agents/run/verification/<failed-run-id>
```

The triage supervisor verifies the failed-run sentinel, log digests, and current
Git fingerprint; extracts and best-effort redacts a bounded error-centered
excerpt; and invokes Pi in ephemeral print mode with no tools, context files,
extensions, skills, or prompt templates. It validates cited line IDs and a
strict review schema before writing compact results under:

```text
../.agents/run/subagents/failed-log-triage/<triage-run-id>/
```

The default model and bounds are in `triage/config.json`. Current defaults use
`private-openai-compatible.example/deepseek-ai/DeepSeek-V4-Flash-0731` with `high` thinking.
Change the config file, pass `--model`/`--thinking` to `triage/run.mjs`, or set
`ENGRAM_TRIAGE_MODEL`/`ENGRAM_TRIAGE_THINKING` for the boxed launcher. Select a
complete alternate config with `ENGRAM_TRIAGE_CONFIG`.

Redaction is defense in depth, not a credential scanner. Do not triage logs
known to contain secrets. Read `result.md`/`summary.json` only after `done`;
inspect the private request, raw model output, or reviewer stderr only when
needed. Suggested commands are inert text and must be reviewed before execution.
The foreground agent owns diagnosis, fixes, security decisions, and final
acceptance.
