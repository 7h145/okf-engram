#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
WORKDIR="$(cd "$REPO/.." && pwd -P)"
VERIFICATION_DIR="${1:-}"
RUN_ID="${2:-triage-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ -n "$VERIFICATION_DIR" ]] || {
  echo "usage: $0 VERIFICATION_RUN_DIR [RUN_ID]" >&2
  exit 2
}
VERIFICATION_DIR="$(cd "$VERIFICATION_DIR" && pwd -P)"
[[ -f "$VERIFICATION_DIR/done" ]] || {
  echo "verification run has no done sentinel: $VERIFICATION_DIR" >&2
  exit 2
}
RUN_ID="$(printf '%s' "$RUN_ID" | tr -cd '[:alnum:]_.-')"
[[ -n "$RUN_ID" ]] || { echo "invalid run ID" >&2; exit 2; }

SOCKET="$WORKDIR/.agents/run/tmux-socket"
SESSION="agent-engram-verification"
WINDOW="triage-$RUN_ID"
RUNS="$WORKDIR/.agents/run/subagents/failed-log-triage"
OUTPUT="$RUNS/$RUN_ID"

mkdir -p "$WORKDIR/.agents/run" "$WORKDIR/.agents/run/subagents" "$RUNS"
chmod 700 "$WORKDIR/.agents/run" "$WORKDIR/.agents/run/subagents" "$RUNS"
[[ ! -e "$OUTPUT" ]] || { echo "triage output already exists: $OUTPUT" >&2; exit 2; }

if ! tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  tmux -S "$SOCKET" new-session -d -s "$SESSION" -c "$WORKDIR"
fi
if tmux -S "$SOCKET" list-windows -t "$SESSION" -F '#{window_name}' | grep -Fxq "$WINDOW"; then
  echo "tmux triage window already exists: $SESSION:$WINDOW" >&2
  exit 2
fi

COMMAND=(
  node tests/verification/triage/run.mjs
  --verification-dir "$VERIFICATION_DIR"
  --output-dir "$OUTPUT"
)
if [[ -n "${ENGRAM_TRIAGE_CONFIG:-}" ]]; then COMMAND+=(--config "$ENGRAM_TRIAGE_CONFIG"); fi
if [[ -n "${ENGRAM_TRIAGE_MODEL:-}" ]]; then COMMAND+=(--model "$ENGRAM_TRIAGE_MODEL"); fi
if [[ -n "${ENGRAM_TRIAGE_THINKING:-}" ]]; then COMMAND+=(--thinking "$ENGRAM_TRIAGE_THINKING"); fi

tmux -S "$SOCKET" new-window -d -t "$SESSION:" -n "$WINDOW" -c "$REPO" bash
SHELL_COMMAND="$(printf '%q ' "${COMMAND[@]}")"
SHELL_COMMAND+="; code=\$?; printf '\\ntriage runner exit: %s\\n' \"\$code\""
tmux -S "$SOCKET" send-keys -t "$SESSION:$WINDOW" "$SHELL_COMMAND" C-m

cat <<EOF
Failed-log triage started.
Verification: $VERIFICATION_DIR
Run ID: $RUN_ID
Output: $OUTPUT
Session: $SESSION
Window: $WINDOW
Done sentinel: $OUTPUT/done
EOF
