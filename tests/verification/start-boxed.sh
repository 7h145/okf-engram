#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WORKDIR="$(cd "$REPO/.." && pwd -P)"
PROFILE="${1:-full}"
RUN_ID="${2:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_ID="$(printf '%s' "$RUN_ID" | tr -cd '[:alnum:]_.-')"
[[ -n "$RUN_ID" ]] || { echo "invalid run ID" >&2; exit 2; }

SOCKET="$WORKDIR/.agents/run/tmux-socket"
SESSION="agent-engram-verification"
WINDOW="verify-$RUN_ID"
RUNS="$WORKDIR/.agents/run/verification"
OUTPUT="$RUNS/$RUN_ID"

mkdir -p "$WORKDIR/.agents/run" "$RUNS"
chmod 700 "$WORKDIR/.agents/run" "$RUNS"
[[ ! -e "$OUTPUT" ]] || { echo "verification output already exists: $OUTPUT" >&2; exit 2; }

if ! tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  tmux -S "$SOCKET" new-session -d -s "$SESSION" -c "$WORKDIR"
fi
if tmux -S "$SOCKET" list-windows -t "$SESSION" -F '#{window_name}' | grep -Fxq "$WINDOW"; then
  echo "tmux verification window already exists: $SESSION:$WINDOW" >&2
  exit 2
fi

WINDOW_ID="$(tmux -S "$SOCKET" new-window -d -P -F '#{window_id}' -t "$SESSION:" -n "$WINDOW" -c "$REPO" bash)"
COMMAND=(node tests/verification/run.mjs --profile "$PROFILE" --output-dir "$OUTPUT")
if [[ "${ALLOW_DIRTY:-0}" == "1" ]]; then COMMAND+=(--allow-dirty); fi
SHELL_COMMAND="$(printf '%q ' "${COMMAND[@]}")"
SHELL_COMMAND+="; code=\$?; printf '\\nverification runner exit: %s\\n' \"\$code\""
tmux -S "$SOCKET" send-keys -t "$WINDOW_ID" "$SHELL_COMMAND" C-m

cat <<EOF
Verification started.
Profile: $PROFILE
Run ID: $RUN_ID
Output: $OUTPUT
Session: $SESSION
Window: $WINDOW
Done sentinel: $OUTPUT/done
EOF
