#!/bin/sh
# The always-on runner VS Code(s), as the `dev` user. Each is restarted if it
# exits. Display :99 is virtual (Xvfb); nothing is ever shown anywhere unless
# you attach with VNC through an SSH tunnel for one-time setup.
#
# ONE RUNNER PER WORKSPACE. A task's rounds run `pnpm run verify` in its own
# checkout and take a workspace-scoped session lease, so two tasks sharing a
# checkout would corrupt each other's test runs and mix their edits. Parallel
# tasks therefore each get their own git worktree and their own runner window
# (ENSEMBLE_RUNNER_WORKSPACES, colon-separated; the first is the original).
# VS Code is single-instance per user-data directory — a second `code
# --new-window` on the same directory just hands the folder to the existing
# instance and returns at once (verified 2026-09-18) — so every runner after
# the first gets its own `--user-data-dir`, seeded from the first's settings.
# Extensions live in ~/.vscode/extensions regardless of user-data-dir, so one
# install (install-extension.sh) serves every runner.
set -u
export DISPLAY=:99
export HOME=/home/dev
# Every runner window IS a runner (src/state/hostRoleV1.ts): it executes the
# tasks of its workspace; Remote-SSH windows on this box are viewers (see
# run.sh, which writes that role into the VS Code server's machine settings).
export ENSEMBLE_HOST_ROLE=runner
WORKSPACES="${ENSEMBLE_RUNNER_WORKSPACES:-${ENSEMBLE_RUNNER_WORKSPACE:-/workspace/vs-code-ai-helper}}"
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

# One restart loop per workspace. $1 = workspace folder, $2 = runner index
# (1 = the original, which keeps the default user-data directory so nothing
# about the existing runner changes).
run_runner() {
  workspace="$1"
  index="$2"
  log="$HOME/.devbox-logs/runner.log"
  data_dir_args=""
  if [ "$index" != "1" ]; then
    data_dir="$HOME/.config/Code-runner-$index"
    log="$HOME/.devbox-logs/runner-$index.log"
    if [ ! -f "$data_dir/User/settings.json" ]; then
      # Same settings as the first runner (models, trust off, no updates);
      # window state and workspaceState stay per instance, as they must.
      mkdir -p "$data_dir/User"
      cp "$HOME/.config/Code/User/settings.json" "$data_dir/User/settings.json"
    fi
    data_dir_args="--user-data-dir $data_dir"
  fi
  while true; do
    # Before every start, not only at boot: stopping a runner VS Code is then
    # enough to pick up a newer ~/ensemble.vsix (installed into both profiles
    # and pinned — see install-extension.sh). Serialized across runners, since
    # they share one extensions directory.
    if [ -f "$HOME/ensemble.vsix" ]; then
      flock "$HOME/.devbox-logs/install.lock" \
        sh /usr/local/bin/devbox-install-extension "$HOME/ensemble.vsix" >>"$log" 2>&1 || true
    fi
    echo "$(date -u +%FT%TZ) starting runner $index VS Code on $workspace" >>"$log"
    # --wait keeps this process in the foreground until the window closes.
    # shellcheck disable=SC2086 # data_dir_args is deliberately word-split
    dbus-run-session -- code --wait --no-sandbox --disable-gpu --password-store=basic \
      $data_dir_args --new-window "$workspace" >>"$log" 2>&1
    echo "$(date -u +%FT%TZ) runner $index VS Code exited ($?); restarting in 10s" >>"$log"
    sleep 10
  done
}

index=1
old_ifs="$IFS"
IFS=':'
for workspace in $WORKSPACES; do
  IFS="$old_ifs"
  run_runner "$workspace" "$index" &
  index=$((index + 1))
  IFS=':'
done
IFS="$old_ifs"
wait
