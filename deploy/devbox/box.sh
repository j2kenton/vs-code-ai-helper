#!/usr/bin/env sh
# Shortcuts for reaching the cloud dev box from a phone (Termux), Linux or
# macOS - the same commands as box.ps1 on Windows.
#
#   box               explain the commands
#   box ssh           shell on the VM                  (ssh ensemble-box)
#   box dev           shell inside the box             (ssh ensemble-devbox)
#   box vnc           noVNC tunnel, opens the runner's screen in the browser
#   box viewer        browser-viewer tunnel, opens the viewer in the browser
#   box tunnel        both tunnels over one connection
#   box status        one-screen status of every task on the box
#   box models        each stage's AI models as the runner sees them
#   box update [ver]  update every copy of Ensemble on the box
#   box drop-viewers  end every browser-viewer session on the box
#
# Nothing private lives here: hosts, users and keys come from the two aliases
# in ~/.ssh/config (ensemble-box = the VM, ensemble-devbox = the container,
# reached through the VM). The viewer's token is read from the box each time.
#
# Install on Termux, once (the phone's key must be accepted by the box):
#   scp ensemble-devbox:box.sh "$PREFIX/bin/box" && chmod +x "$PREFIX/bin/box"
# Opening the browser automatically needs the Termux:API app and
# `pkg install termux-api`; without it the address is printed to tap.

VM=ensemble-box
BOX=ensemble-devbox
VNC_PORT=6080
VIEWER_PORT=8082
LOCAL_VIEWER_PORT="${BOX_VIEWER_PORT:-8082}"
case "$LOCAL_VIEWER_PORT" in
  ''|*[!0-9]*) echo "BOX_VIEWER_PORT must be a port number, not '$LOCAL_VIEWER_PORT'." >&2; exit 2 ;;
esac
WORKSPACE=/workspace/vs-code-ai-helper
VNC_URL="http://localhost:$VNC_PORT/vnc.html?autoconnect=true&resize=scale"

# Try each opener that exists until one works; the URL is printed anyway.
open_url() {
  for opener in termux-open-url xdg-open open; do
    command -v "$opener" >/dev/null 2>&1 && "$opener" "$1" >/dev/null 2>&1 && return 0
  done
  return 1
}

viewer_url() {
  token=$(ssh "$BOX" 'cat ~/.serve-web-viewer.token') || return 1
  [ -n "$token" ] || { echo "Could not read the viewer token from the box." >&2; return 1; }
  echo "http://localhost:$LOCAL_VIEWER_PORT/?tkn=$token&folder=$WORKSPACE"
}

# $1 = ssh -L forwards (space-separated), remaining args = URLs to open.
tunnel() {
  forwards=$1; shift
  for url in "$@"; do echo "Open: $url"; done
  echo "Tunnel running. Leave this open; Ctrl+C closes it."
  # The browser opens a moment after ssh starts. If the tunnel ends first
  # (Ctrl+C, or ssh failing at once), the pending opener is cancelled.
  (sleep 8; for url in "$@"; do open_url "$url"; done) &
  opener=$!
  trap 'kill "$opener" 2>/dev/null' INT TERM
  # shellcheck disable=SC2086  # forwards is deliberately word-split
  ssh -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 $forwards "$BOX"
  rc=$?
  kill "$opener" 2>/dev/null
  wait "$opener" 2>/dev/null
  trap - INT TERM
  echo "Tunnel closed (ssh exit code $rc)."
  return "$rc"
}

command=${1:-help}
[ $# -gt 0 ] && shift
case "$command" in
  ssh) exec ssh "$VM" "$@" ;;
  dev) exec ssh "$BOX" "$@" ;;
  vnc) tunnel "-L $VNC_PORT:127.0.0.1:$VNC_PORT" "$VNC_URL" ;;
  viewer)
    url=$(viewer_url) || exit 1
    tunnel "-L $LOCAL_VIEWER_PORT:127.0.0.1:$VIEWER_PORT" "$url" ;;
  tunnel)
    url=$(viewer_url) || exit 1
    tunnel "-L $VNC_PORT:127.0.0.1:$VNC_PORT -L $LOCAL_VIEWER_PORT:127.0.0.1:$VIEWER_PORT" "$VNC_URL" "$url" ;;
  status) exec ssh "$BOX" 'sh ~/status.sh' ;;
  models) exec ssh "$BOX" 'python3 ~/box-models.py' ;;
  update)
    # Only the forms update-ensemble.sh supports, so nothing else reaches
    # the remote shell: no argument, --status, or a version number.
    case "$*" in
      ''|--status) ;;
      *[!0-9.]*) echo "Usage: box update [--status | <version, e.g. 1.5.2>]" >&2; exit 2 ;;
    esac
    exec ssh "$BOX" "~/update-ensemble.sh $*" ;;
  drop-viewers) exec ssh "$BOX" 'sh ~/reap-viewers.sh --restart-all' ;;
  *)
    cat <<'EOF'
box ssh           Shell on the cloud VM (the machine the box runs on).
box dev           Shell inside the box itself (where Ensemble, the runner and the code live).
box vnc           noVNC: opens the runner window's screen in your browser. Cheapest way
                  to click Ensemble's buttons; uses almost no memory on the box.
box viewer        Browser viewer: a full VS Code in your browser, with Claude Code.
                  Heavy (about 3 GB on the box); use it only when no other viewer is connected.
box tunnel        Both of the above over one connection.
box status        One-screen status of every task on the box. Read-only.
box models        Each stage's AI models as the runner sees them: ON/off, which runs first.
                  Use it to check a settings change has reached the box. Read-only.
box update        Update every copy of Ensemble on the box to the newest version.
                  'box update --status' only reports; 'box update 1.5.2' installs that version.
box drop-viewers  End all browser-viewer sessions on the box to free memory.
                  An open viewer tab just reloads; a Claude chat running in it ends.

Tunnel commands keep running: leave them open, Ctrl+C closes the tunnel.
If local port 8082 is taken on this device, run with BOX_VIEWER_PORT=8083.
EOF
    ;;
esac
