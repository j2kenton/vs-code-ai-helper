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

# The browser/phone VIEWER: one `code serve-web` for the whole box, serving the
# real Ensemble panel to any device. run.sh publishes this port on the VM's
# loopback, so a phone needs a single SSH hop.
#
# A VIEWER, never a runner — set in the environment AND in the server's machine
# settings. A runner publishes the task's status every 30 seconds, so a second
# runner on one workspace overwrites the first's view and progress flickers in
# and out; a viewer publishes nothing and cannot collide (seen live 2026-09-20).
# It also makes serve-web's one disqualifying property harmless: it disposes its
# extension host as soon as a browser disconnects gracefully, which would kill a
# round but costs a viewer nothing.
#
# Any workspace, one URL:  http://localhost:8082/?tkn=<token>&folder=/workspace/<name>
VIEWER_PORT=8082
VIEWER_DIR="$HOME/.serve-web-viewer"
VIEWER_TOKEN="$HOME/.serve-web-viewer.token"
mkdir -p "$VIEWER_DIR/data/Machine" "$VIEWER_DIR/data/User"
[ -f "$VIEWER_TOKEN" ] || node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))' > "$VIEWER_TOKEN"
chmod 600 "$VIEWER_TOKEN"
printf '%s\n' '{' '  "ensemble.hostRole": "viewer",' '  "update.mode": "none"' '}' \
  > "$VIEWER_DIR/data/Machine/settings.json"
# The server keeps its OWN extensions directory, separate from ~/.vscode and
# ~/.vscode-server: an empty one looks exactly like a dead extension host.
VIEWER_SERVER="$(ls -d "$HOME"/.vscode/cli/serve-web/*/bin/code-server 2>/dev/null | head -1)"
if [ -n "$VIEWER_SERVER" ] && [ -f "$HOME/ensemble.vsix" ] &&
   ! grep -q 'j2kenton' "$VIEWER_DIR/extensions/extensions.json" 2>/dev/null; then
  "$VIEWER_SERVER" --extensions-dir "$VIEWER_DIR/extensions" \
    --install-extension "$HOME/ensemble.vsix" >>"$HOME/.devbox-logs/serve-web-viewer.log" 2>&1 || true
fi
ENSEMBLE_HOST_ROLE=viewer code serve-web \
  --host 0.0.0.0 --port "$VIEWER_PORT" \
  --connection-token-file "$VIEWER_TOKEN" \
  --server-data-dir "$VIEWER_DIR" \
  --default-folder /workspace/vs-code-ai-helper \
  --accept-server-license-terms --disable-telemetry \
  >>"$HOME/.devbox-logs/serve-web-viewer.log" 2>&1 &
echo "$(date -u +%FT%TZ) viewer on :$VIEWER_PORT token $(cat "$VIEWER_TOKEN")" >>"$SUPERVISOR_LOG"

# The PUSH WATCHER: tells the user's phone when a round finishes, needs an
# answer, complains, or when a runner goes quiet with work in flight. It reads
# only what the runners publish and can start nothing.
#
# Started here because it is the one thing a rebuild kept silently killing: it
# used to live only in $HOME (which survives) but nothing restarted it, so
# notifications just stopped — twice, unnoticed for hours. It covers every
# workspace on the box automatically, so a new instance needs no setup.
#
# It ships in the IMAGE (/usr/local/lib/devbox-notify-watch.mjs, Dockerfile).
# This block used to require `$HOME/notify-watch.mjs`, which nothing installed
# — so on any box built from a clean checkout the condition was simply false
# and no watcher ran, silently, which is the same failure in a new costume
# (review, 2026-09-22). A copy in $HOME still wins, so the file can be edited
# in place on the box to try a change without a rebuild.
#
# Sends nothing unless ~/.devbox-notify-url exists: deleting that file is the
# off switch, and without it the watcher only logs what it would have sent.
if [ -f "$HOME/notify-watch.mjs" ]; then
  notify_watcher="$HOME/notify-watch.mjs"
else
  notify_watcher="/usr/local/lib/devbox-notify-watch.mjs"
fi
if [ -f "$notify_watcher" ]; then
  setsid nohup node "$notify_watcher" >>"$HOME/.devbox-logs/notify-watch.out" 2>&1 < /dev/null &
  echo "$(date -u +%FT%TZ) push watcher started ($notify_watcher)" >>"$SUPERVISOR_LOG"
else
  # Visible, not silent: the watcher is how the user learns a round finished
  # or needs them, so its absence is worth a line in the log that a human
  # reads (status.sh tails this).
  echo "$(date -u +%FT%TZ) WARNING: no push watcher found at $notify_watcher; no notifications will be sent" >>"$SUPERVISOR_LOG"
fi

# The RENDERER MEMORY LOG — a diagnostic, and temporary. Three renderers died
# with "renderer process gone (reason: crashed, code: 133)" inside 24 hours
# (2026-09-22/23), each taking its extension host and a live round with it; one
# was a Fast Forward Review 96 minutes in. Neither known cause fitted the last
# one: no OOM kill in the kernel log, /dev/shm 2 GB with nothing used. So this
# samples every renderer's RSS while they are alive, because the process is
# gone before anyone can look at it.
#
# Costs a `ps` every two minutes, writes only its own log, and starts nothing.
# DELETE IT, and this block, once the crashes are understood — a permanent
# diagnostic nobody reads is just another thing to maintain.
if [ -f "$HOME/renderer-memory-log.sh" ]; then
  renderer_logger="$HOME/renderer-memory-log.sh"
else
  renderer_logger="/usr/local/bin/devbox-renderer-memory-log"
fi
if [ -f "$renderer_logger" ]; then
  setsid nohup sh "$renderer_logger" >/dev/null 2>&1 < /dev/null &
  echo "$(date -u +%FT%TZ) renderer memory log started ($renderer_logger)" >>"$SUPERVISOR_LOG"
fi

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
    #
    # ONLY WHEN THE VSIX HAS CHANGED. Installing deletes and re-extracts the
    # extension's folder, and that folder is shared: reinstalling on every
    # start pulled it out from under the OTHER runner while it was scanning or
    # running, and with two restart loops going the runners took turns
    # breaking each other (seen live 2026-09-18). The checksum of the last
    # installed package is kept beside the logs; the check is repeated under
    # the lock so two runners that both notice a new build install it once.
    if [ -f "$HOME/ensemble.vsix" ] &&
       [ "$(cksum <"$HOME/ensemble.vsix")" != "$(cat "$HOME/.devbox-logs/installed-vsix.cksum" 2>/dev/null)" ]; then
      if command -v flock >/dev/null 2>&1; then
        # shellcheck disable=SC2016 # expanded by the inner shell, deliberately
        flock "$HOME/.devbox-logs/install.lock" sh -c '
          sum="$(cksum <"$HOME/ensemble.vsix")"
          [ "$sum" = "$(cat "$HOME/.devbox-logs/installed-vsix.cksum" 2>/dev/null)" ] && exit 0
          sh /usr/local/bin/devbox-install-extension "$HOME/ensemble.vsix" &&
            printf "%s\n" "$sum" >"$HOME/.devbox-logs/installed-vsix.cksum"
        ' >>"$log" 2>&1 || true
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
          sum="$(cksum <"$HOME/ensemble.vsix")"
          if [ "$sum" != "$(cat "$HOME/.devbox-logs/installed-vsix.cksum" 2>/dev/null)" ]; then
            sh /usr/local/bin/devbox-install-extension "$HOME/ensemble.vsix" >>"$log" 2>&1 &&
              printf '%s\n' "$sum" >"$HOME/.devbox-logs/installed-vsix.cksum"
          fi
          rm -rf "$lock_dir"
        fi
      fi
    fi
    echo "$(date -u +%FT%TZ) starting runner $index VS Code on $workspace" >>"$log"
    # --disable-dev-shm-usage: Chromium puts its renderer's shared memory in
    # /tmp instead of /dev/shm, which Docker fixes at 64 MB by default. On
    # 2026-09-18 every runner window on the box died within two minutes of
    # each other — "renderer process gone (reason: crashed, code: 133)" — and
    # a 64 MB /dev/shm shared by two renderers and x11vnc's framebuffer is the
    # documented cause of exactly that. run.sh also raises the limit; this
    # flag is what protects a box that has not been recreated yet.
    #
    # --disable-workspace-trust: on the COMMAND LINE, not only in settings.json.
    # The runner's settings carried `security.workspace.trust.enabled: false`
    # until Settings Sync was switched on in the runner and replaced the file
    # with the laptop's (2026-09-18). Trust came back on, the headless window
    # opened in Restricted Mode, and Restricted Mode disables this extension —
    # so the runner ran no extension at all, with a trust prompt nobody could
    # see. A flag cannot be synced away.
    # shellcheck disable=SC2086 # data_dir_args is deliberately word-split
    dbus-run-session -- code --wait --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --disable-workspace-trust \
      --password-store=basic $data_dir_args --new-window "$workspace" >>"$log" 2>&1 &
    code_pid=$!
    started_at="$(date +%s)"
    # A CRASHED renderer is not an exit. VS Code keeps the window open on its
    # own "The window terminated unexpectedly … Reopen" dialog, so `code
    # --wait` never returns, the loop below never fires, and the runner is
    # dead while still looking alive to everything — including this
    # supervisor (seen live 2026-09-18: both runners sat on that dialog until
    # someone happened to look at the screen).
    #
    # The extension publishes its operations mirror every 30 seconds, so a
    # mirror that EXISTS and has stopped moving is that state. A window that
    # never wrote one (no task root yet) is left alone.
    #
    # Two rules learned the hard way the day this shipped (2026-09-18), when a
    # window whose extension could not load at all was killed every 60 seconds
    # for a quarter of an hour:
    #   - THIS window gets five minutes before it is judged. The mirror left
    #     by the previous window is already stale at startup, so judging it
    #     at the first check killed every window a minute after it opened.
    #   - Restarting is a cure for a crashed window, not for an extension that
    #     never loads. After three windows in a row that never reported once,
    #     the watchdog stands down and says so, rather than looping for ever.
    mirror="$workspace/.ensemble/relay-v1/operations-v1.json"
    seen_report=0
    while kill -0 "$code_pid" 2>/dev/null; do
      # Short naps so a deliberate stop (pkill) is noticed in seconds, while
      # the staleness test below still only matters on the minute scale.
      sleep 5
      kill -0 "$code_pid" 2>/dev/null || break
      [ "${never_reported:-0}" -ge 3 ] && continue
      now="$(date +%s)"
      mirror_at="$(stat -c %Y "$mirror" 2>/dev/null || echo 0)"
      [ "$mirror_at" -gt "$started_at" ] && seen_report=1
      if [ -f "$mirror" ] && [ $((now - started_at)) -ge 300 ] && [ $((now - mirror_at)) -ge 300 ]; then
        echo "$(date -u +%FT%TZ) runner $index stopped reporting for 5 min; restarting the window" >>"$log"
        # BOTH: `$code_pid` is dbus-run-session, and VS Code's own main
        # process is three levels below it (dbus-run-session → sh /usr/bin/code
        # → cli.js → code), so signalling only the pid can leave the window
        # itself running — which would then be a second runner on this
        # workspace. The pattern matches this window's whole chain; the
        # workspace path is what distinguishes it from the other runner's.
        kill -TERM "$code_pid" 2>/dev/null || true
        pkill -TERM -f "[c]ode --wait.*$workspace" 2>/dev/null || true
        waited=0
        while pgrep -f "[c]ode --wait.*$workspace" >/dev/null 2>&1 && [ "$waited" -lt 10 ]; do
          waited=$((waited + 1))
          sleep 1
        done
        kill -KILL "$code_pid" 2>/dev/null || true
        pkill -KILL -f "[c]ode --wait.*$workspace" 2>/dev/null || true
        if [ "$seen_report" = "1" ]; then
          never_reported=0
        else
          never_reported=$((${never_reported:-0} + 1))
          if [ "$never_reported" -ge 3 ]; then
            echo "$(date -u +%FT%TZ) runner $index: three windows in a row never reported at all. Restarting cannot fix that — the extension is not loading (Restricted Mode? a failed install?). The watchdog is standing down; the next window is left running." >>"$log"
          fi
        fi
        break
      fi
    done
    [ "$seen_report" = "1" ] && never_reported=0
    wait "$code_pid"
    # Captured IMMEDIATELY: `$(date …)` inside the message would reset `$?`
    # first, which is why every one of these lines has always read "(0)"
    # whatever happened to the window.
    rc=$?
    echo "$(date -u +%FT%TZ) runner $index VS Code exited ($rc); restarting in 10s" >>"$log"
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
