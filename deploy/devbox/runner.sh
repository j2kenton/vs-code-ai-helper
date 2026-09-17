#!/bin/sh
# The always-on runner VS Code, as the `dev` user. Restarted if it exits.
# Display :99 is virtual (Xvfb); nothing is ever shown anywhere unless you
# attach with VNC through an SSH tunnel for one-time setup.
set -u
export DISPLAY=:99
export HOME=/home/dev
# This VS Code is THE runner (src/state/hostRoleV1.ts): it executes every
# task; Remote-SSH windows on this box are viewers (see run.sh, which writes
# that role into the VS Code server's machine settings).
export ENSEMBLE_HOST_ROLE=runner
WORKSPACE="${ENSEMBLE_RUNNER_WORKSPACE:-/workspace/vs-code-ai-helper}"
mkdir -p "$HOME/.devbox-logs"

# `docker restart` keeps the container's /tmp: the previous boot's X lock
# survives, Xvfb refuses to start ("Server is already active for display
# 99"), and with no display VS Code exits at once and loops (seen live).
# Nothing else can own display :99 in this container, so the lock is stale.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >>"$HOME/.devbox-logs/xvfb.log" 2>&1 &
sleep 2
# VNC bound to loopback only, no password: reachable solely via SSH port-forward.
x11vnc -display :99 -localhost -forever -shared -nopw -quiet >>"$HOME/.devbox-logs/x11vnc.log" 2>&1 &
# Browser access to that display: `ssh -L 6080:127.0.0.1:6080 ensemble-devbox`,
# then open http://localhost:6080/vnc.html . Loopback only.
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >>"$HOME/.devbox-logs/novnc.log" 2>&1 &

# The runner's own profile needs the extension too (desktop profile, not the
# Remote-SSH server's). A newer package dropped at ~/ensemble.vsix is picked up
# on the next restart.
if [ -f "$HOME/ensemble.vsix" ]; then
  code --no-sandbox --install-extension "$HOME/ensemble.vsix" --force >>"$HOME/.devbox-logs/runner.log" 2>&1
fi

while true; do
  echo "$(date -u +%FT%TZ) starting runner VS Code on $WORKSPACE" >>"$HOME/.devbox-logs/runner.log"
  # --wait keeps this process in the foreground until the window closes.
  dbus-run-session -- code --wait --no-sandbox --disable-gpu --password-store=basic \
    --new-window "$WORKSPACE" >>"$HOME/.devbox-logs/runner.log" 2>&1
  echo "$(date -u +%FT%TZ) runner VS Code exited ($?); restarting in 10s" >>"$HOME/.devbox-logs/runner.log"
  sleep 10
done
