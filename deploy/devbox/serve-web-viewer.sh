#!/bin/sh
# A serve-web VIEWER for one workspace: the real Ensemble panel in any
# browser, phone included.
#
# A VIEWER, never a runner. The difference is the whole point:
#   - a RUNNER executes the work and publishes its status. Two runners on one
#     task root overwrite each other's status file every 30 seconds, so a
#     viewer sees progress flicker in and out, and Stop starts failing with
#     "that operation belonged to an earlier run of the runner". Seen live
#     2026-09-20, when this script's predecessor was left in runner mode
#     alongside the desktop runner.
#   - a VIEWER executes nothing and publishes nothing. It reads the runner's
#     mirrored status, shows the tasks, the chat and the pending decisions,
#     and hands any action pressed here to the runner over the file relay.
#     Two viewers cannot collide, because neither writes the status.
#
# That also makes the extension host's lifetime a non-issue here. serve-web
# disposes its extension host the moment a browser disconnects gracefully
# (VS Code's own log: "The client has disconnected gracefully, so the
# connection will be disposed") — fatal for a runner, irrelevant for a viewer,
# which only needs to exist while someone is looking at it.
set -u
WORKSPACE="${1:-/workspace/vs-code-ai-helper}"
PORT="${2:-8082}"
DATA_DIR="$HOME/.serve-web-viewer"
TOKEN_FILE="$HOME/.serve-web-viewer.token"
LOG="$HOME/.devbox-logs/serve-web-viewer.log"

RUNNING_PATTERN="serve-web --host [1]27.0.0.1 --port $PORT"
if pgrep -f "$RUNNING_PATTERN" >/dev/null 2>&1; then
  echo "already running on port $PORT"
  echo "url: http://localhost:$PORT/?tkn=$(cat "$TOKEN_FILE")&folder=$WORKSPACE"
  exit 0
fi

mkdir -p "$DATA_DIR/data/User" "$DATA_DIR/data/Machine" "$HOME/.devbox-logs"
[ -f "$TOKEN_FILE" ] || node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# The server keeps its own extensions directory — separate from ~/.vscode and
# from ~/.vscode-server. An empty one is why the first attempt looked like a
# dead extension host when it simply had nothing to host.
SERVER_BIN="$(ls -d "$HOME"/.vscode/cli/serve-web/*/bin/code-server 2>/dev/null | head -1)"
if [ -n "$SERVER_BIN" ] && [ -f "$HOME/ensemble.vsix" ]; then
  if ! grep -q 'j2kenton' "$DATA_DIR/extensions/extensions.json" 2>/dev/null; then
    "$SERVER_BIN" --extensions-dir "$DATA_DIR/extensions" --install-extension "$HOME/ensemble.vsix" >>"$LOG" 2>&1 || true
  fi
fi

# viewer in the environment AND in the machine settings, so no stray browser
# profile can turn this into a second runner.
{
  echo '{'
  echo '  "ensemble.hostRole": "viewer",'
  echo '  "update.mode": "none"'
  echo '}'
} > "$DATA_DIR/data/Machine/settings.json"

ENSEMBLE_HOST_ROLE=viewer setsid nohup code serve-web \
  --host 127.0.0.1 --port "$PORT" \
  --connection-token-file "$TOKEN_FILE" \
  --server-data-dir "$DATA_DIR" \
  --default-folder "$WORKSPACE" \
  --accept-server-license-terms \
  --disable-telemetry \
  >>"$LOG" 2>&1 < /dev/null &

sleep 6
if pgrep -f "$RUNNING_PATTERN" >/dev/null 2>&1; then
  echo "serve-web VIEWER up for $WORKSPACE on 127.0.0.1:$PORT"
  echo "url: http://localhost:$PORT/?tkn=$(cat "$TOKEN_FILE")&folder=$WORKSPACE"
else
  echo "FAILED to start; last lines of $LOG:"
  tail -10 "$LOG"
  exit 1
fi
