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
# Where the list comes from, in order: the container's environment
# (run.sh passes ENSEMBLE_RUNNER_WORKSPACES through), then a file on the HOME
# volume. The file is what makes a second runner survive a container restart:
# an environment variable set in the shell that happened to start runner.sh
# by hand was gone on the next boot, and the second task's runner silently
# did not come back (verification review, 2026-09-18).
#   printf '%s\n' /workspace/vs-code-ai-helper /workspace/wt-b > ~/.devbox-runner-workspaces
WORKSPACES_FILE="$HOME/.devbox-runner-workspaces"
WORKSPACES="${ENSEMBLE_RUNNER_WORKSPACES:-}"
if [ -z "$WORKSPACES" ] && [ -f "$WORKSPACES_FILE" ]; then
  # One per line or colon-separated. A line whose first non-blank character is
  # '#' is a comment; a '#' INSIDE a path is part of the path
  # (/workspace/review#2 is a legal directory name).
  WORKSPACES="$(sed -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' "$WORKSPACES_FILE" | grep -v '^$' | tr '\n' ':')"
fi
WORKSPACES="${WORKSPACES:-${ENSEMBLE_RUNNER_WORKSPACE:-/workspace/vs-code-ai-helper}}"
mkdir -p "$HOME/.devbox-logs"
SUPERVISOR_LOG="$HOME/.devbox-logs/runner-supervisor.log"

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
    data_dir_args="--user-data-dir $data_dir"
  fi
  while true; do
    if [ "$index" != "1" ] && [ -f "$HOME/.config/Code/User/settings.json" ]; then
      # Copied when runner 1's file is NEWER than this runner's, not once and
      # never again, and not unconditionally. Seeding once meant every
      # model/provider change made in runner 1 stayed invisible here for ever;
      # copying on every start threw away a change made deliberately in THIS
      # runner's own window. Newest-wins keeps both (verification review,
      # 2026-09-18). Window state, workspaceState and globalStorage stay per
      # instance, as they must — only settings.json is shared.
      mkdir -p "$data_dir/User"
      if [ ! -f "$data_dir/User/settings.json" ] ||
         [ "$HOME/.config/Code/User/settings.json" -nt "$data_dir/User/settings.json" ]; then
        cp "$HOME/.config/Code/User/settings.json" "$data_dir/User/settings.json"
      fi
    fi
    # Before every start, not only at boot: stopping a runner VS Code is then
    # enough to pick up a newer ~/ensemble.vsix (installed into both profiles
    # and pinned — see install-extension.sh). Serialized across runners, since
    # they share one extensions directory; `flock` is in util-linux, present
    # in this image, but a missing one must not skip the install silently.
    if [ -f "$HOME/ensemble.vsix" ]; then
      if command -v flock >/dev/null 2>&1; then
        flock "$HOME/.devbox-logs/install.lock" \
          sh /usr/local/bin/devbox-install-extension "$HOME/ensemble.vsix" >>"$log" 2>&1 || true
      else
        # mkdir is atomic everywhere: the same mutual exclusion, no flock.
        lock_dir="$HOME/.devbox-logs/install.lock.d"
        lock_held=1
        waited=0
        while ! mkdir "$lock_dir" 2>/dev/null; do
          # A lock left behind by a crash outlives the container (the home
          # volume is persistent). Its own age is the evidence: older than
          # five minutes and no install is still running, so it is removed and
          # the lock RE-ACQUIRED — never simply bypassed, which would let two
          # runners install into the shared extensions directory at once
          # (verification review, 2026-09-18).
          if [ -z "$(find "$lock_dir" -maxdepth 0 -mmin -5 2>/dev/null)" ]; then
            echo "$(date -u +%FT%TZ) removing an install lock left behind by an earlier run" >>"$log"
            rm -rf "$lock_dir"
            continue
          fi
          waited=$((waited + 2))
          if [ "$waited" -ge 600 ]; then
            echo "$(date -u +%FT%TZ) install lock still held after 10 min; starting without reinstalling" >>"$log"
            lock_held=0
            break
          fi
          sleep 2
        done
        # Only the holder installs, and only the holder releases: bypassing
        # the lock here would install concurrently with whoever holds it, and
        # removing it would release somebody else's.
        if [ "$lock_held" = "1" ]; then
          sh /usr/local/bin/devbox-install-extension "$HOME/ensemble.vsix" >>"$log" 2>&1 || true
          rm -rf "$lock_dir"
        fi
      fi
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

# Split the colon-separated list ONCE, into the positional parameters, so the
# loop below never has to juggle IFS (an early `continue` used to leave IFS
# set to ':' for the rest of the script).
old_ifs="$IFS"
IFS=':'
# shellcheck disable=SC2086 # deliberate word split of the workspace list
set -- $WORKSPACES
IFS="$old_ifs"

pids=""
# `docker stop` reaches this script only because entrypoint.sh forwards the
# signal. Passing it on lets each runner VS Code shut down rather than be
# SIGKILLed with the container, which is what records "the runner stopped
# while this was running" for the viewer (hostOperationsMirrorV1.ts).
terminate() {
  echo "$(date -u +%FT%TZ) supervisor: stopping $index_started runner(s)" >>"$SUPERVISOR_LOG"
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # The restart loops are gone now, so closing the windows cannot restart them.
  pkill -TERM -f '/usr/share/code/[c]ode --wait' 2>/dev/null || true
  # Give each window the moment it needs to record that it stopped mid-round
  # (entrypoint.sh waits too; whichever gets there first, nobody exits while
  # VS Code is still writing).
  waited=0
  while pgrep -f '/usr/share/code/[c]ode --wait' >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -ge 8 ] && break
    sleep 1
  done
  exit 0
}
trap terminate TERM INT

index=1
index_started=0
started=""
for workspace in "$@"; do
  # An empty entry (a trailing or doubled ':') is not a workspace.
  [ -n "$workspace" ] || continue
  # A duplicate would give one checkout two runner windows — the exact
  # collision one-runner-per-workspace exists to prevent.
  case ":$started:" in
    *":$workspace:"*)
      echo "$(date -u +%FT%TZ) supervisor: $workspace listed twice; ignoring the duplicate" >>"$SUPERVISOR_LOG"
      continue
      ;;
  esac
  if [ ! -d "$workspace" ]; then
    # Say so once, loudly: VS Code would otherwise open an empty window that
    # looks like a working runner and can run nothing.
    echo "$(date -u +%FT%TZ) supervisor: $workspace does not exist; no runner started for it" >>"$SUPERVISOR_LOG"
    continue
  fi
  run_runner "$workspace" "$index" &
  pids="$pids $!"
  started="$started:$workspace"
  index=$((index + 1))
  index_started=$((index_started + 1))
done

if [ "$index_started" = "0" ]; then
  echo "$(date -u +%FT%TZ) supervisor: no usable workspace in '$WORKSPACES'; no runner is running" >>"$SUPERVISOR_LOG"
fi
wait
