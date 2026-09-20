#!/bin/sh
# Build and (re)start the dev box on the cloud host. Idempotent.
#   AUTHORIZED_KEY_FILE=~/.ssh/devbox_authorized_key sh run.sh
#
# DESTRUCTIVE: this DELETES and RECREATES the container (docker rm -f below),
# which kills the runner's VS Code and any workflow round it is part-way
# through — the round's work-admission claim is then left behind, so the task
# refuses new actions until that claim ages out (~20 min). Run it only when
# nothing is running, and only when the image itself needs rebuilding.
# To restart ONE runner (seconds, nothing else touched) name its workspace —
# with two runners the bare pattern kills both, including the one running
# somebody else's task (verification review, 2026-09-18):
#   ssh ensemble-devbox "pkill -f '[c]ode --wait.*/workspace/vs-code-ai-helper'"
# NOT anchored with `$`: VS Code's own main process carries the workspace in
# the MIDDLE of its command line (`--waitMarkerFilePath <workspace> <marker>`),
# so an anchored pattern matches only the wrapper processes and leaves the
# window itself running. runner.sh brings a fresh window for that workspace
# straight back up.
# The home (logins, VS Code server, extensions) and the workspace are named
# volumes: rebuilding or restarting the container keeps both.
set -eu
cd "$(dirname "$0")"
: "${AUTHORIZED_KEY_FILE:?set AUTHORIZED_KEY_FILE to the public key allowed to connect}"

sudo docker build -t ensemble-devbox:latest .

keys_dir="$HOME/.ensemble-devbox-keys"
mkdir -p "$keys_dir"
cp "$AUTHORIZED_KEY_FILE" "$keys_dir/dev"
chmod 0644 "$keys_dir/dev"

# Codex's review sandbox (bubblewrap) needs its own user namespace, which two
# separate layers deny a container by default: Ubuntu 24.04's AppArmor
# restriction, and Docker's seccomp filter. Both are relaxed as narrowly as
# measured to work (2026-09-17):
#   - AppArmor: a profile for THIS container only, granting `userns`
#     (apparmor-ensemble-devbox). The host-wide restriction stays on.
#   - seccomp: Docker's own default profile with ONLY the namespace syscalls
#     allowed (seccomp-allow-userns.mjs) — all ~350 other rules stay. This is
#     what `--security-opt seccomp=unconfined` would have thrown away.
# Set DEVBOX_CODEX_SANDBOX=0 to keep the stock confinement instead; Codex
# reviews on the box then cannot run any command, so they verify nothing.
sandbox_opts=""
if [ "${DEVBOX_CODEX_SANDBOX:-1}" = "1" ]; then
  sudo install -m 0644 apparmor-ensemble-devbox /etc/apparmor.d/ensemble-devbox
  sudo apparmor_parser -r /etc/apparmor.d/ensemble-devbox
  sandbox_opts="--security-opt apparmor=ensemble-devbox"
  # Docker's default profile is compiled into the daemon, so the patch starts
  # from moby's published copy of it.
  seccomp_base="${DEVBOX_SECCOMP_BASE:-}"
  if [ -z "$seccomp_base" ] && curl -fsS -o /tmp/devbox-seccomp-base.json \
      https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json; then
    seccomp_base=/tmp/devbox-seccomp-base.json
  fi
  if [ -n "$seccomp_base" ] && node seccomp-allow-userns.mjs "$seccomp_base" /tmp/devbox-seccomp.json; then
    sandbox_opts="$sandbox_opts --security-opt seccomp=/tmp/devbox-seccomp.json"
  elif [ "${DEVBOX_SECCOMP_UNCONFINED:-0}" = "1" ]; then
    echo "WARNING: DEVBOX_SECCOMP_UNCONFINED=1 — running with seccomp=unconfined." >&2
    echo "         Every syscall filter is off, not only the namespace ones." >&2
    sandbox_opts="$sandbox_opts --security-opt seccomp=unconfined"
  else
    # FAILS CLOSED. A download that returned an error page, a truncated file
    # or a profile from another Docker version used to end up as
    # seccomp=unconfined — silently throwing away ~350 syscall rules to gain
    # the one thing we wanted (user namespaces). The box then still works;
    # only Codex's own sandboxed reviews on it do not (verification review,
    # 2026-09-18).
    # STOPS HERE, before `docker rm -f` below: continuing would destroy a
    # working box and replace it with one whose Codex reviews verify nothing,
    # and still exit 0 (verification review, 2026-09-18).
    echo "ERROR: could not build the narrowed seccomp profile. Nothing has been changed." >&2
    echo "       Set DEVBOX_SECCOMP_BASE=<path to moby's seccomp/default.json> to fix it," >&2
    echo "       DEVBOX_CODEX_SANDBOX=0 to deploy without the relaxation (Codex reviews on" >&2
    echo "       the box then cannot run commands), or DEVBOX_SECCOMP_UNCONFINED=1 to accept" >&2
    echo "       an unconfined container." >&2
    exit 1
  fi
fi

# One runner VS Code per workspace, for parallel tasks (runner.sh). Passed
# into the container so the list is not lost on a restart:
#   ENSEMBLE_RUNNER_WORKSPACES=/workspace/vs-code-ai-helper:/workspace/wt-b sh run.sh
# Unset, runner.sh falls back to ~/.devbox-runner-workspaces on the home
# volume (which survives even a recreate) and then to the single original
# workspace.
# Held in the POSITIONAL PARAMETERS, not a string: a workspace path with a
# space in it would be word-split into two docker arguments, and the run would
# fail AFTER the old container had already been removed below (verification
# review, 2026-09-18).
if [ -n "${ENSEMBLE_RUNNER_WORKSPACES:-}" ]; then
  set -- --env "ENSEMBLE_RUNNER_WORKSPACES=$ENSEMBLE_RUNNER_WORKSPACES"
else
  set --
fi

sudo docker rm -f ensemble-devbox >/dev/null 2>&1 || true
# SSH only on the host's loopback: reached through the host's own SSH
# (ProxyJump), never exposed to the internet directly.
#
# --memory 20g: the VM has 23 GB and the container was capped at 12. Two
# desktop runners, their extension hosts, a renderer that had leaked to 2.4 GB
# and a couple of viewers reached that cap on 2026-09-20; the kernel killed
# four processes and took a review round with it. The cap was the shortage, not
# the machine. ~3 GB is left for the VM itself.
#
# -p 8082: the serve-web VIEWER (runner.sh starts it) published on the VM's
# loopback, so a PHONE needs one SSH hop to the VM instead of two. Still
# nothing on the internet — loopback only, and the viewer requires its
# connection token.
#
# --shm-size 2g: Docker's default /dev/shm is 64 MB, which two Electron
# renderers and x11vnc's framebuffer exhaust. The renderers then die with
# "renderer process gone (reason: crashed, code: 133)" and VS Code leaves each
# window sitting on a "Reopen" dialog — every runner on the box went down that
# way inside two minutes on 2026-09-18, after five hours of two runners
# running happily, when a VNC viewer was attached. runner.sh additionally
# passes --disable-dev-shm-usage, which is what protects a box whose container
# predates this line.
sudo docker run -d --name ensemble-devbox \
  --restart unless-stopped \
  --hostname ensemble-devbox \
  -p 127.0.0.1:2222:2222 \
  -p 127.0.0.1:8082:8082 \
  --memory 28g --cpus 15 --pids-limit 4096 --shm-size 2g \
  $sandbox_opts \
  "$@" \
  -v ensemble-devbox-home:/home/dev \
  -v ensemble-devbox-workspace:/workspace \
  -v "$keys_dir:/run/devbox-keys:ro" \
  ensemble-devbox:latest
sudo docker ps --filter name=ensemble-devbox --format '{{.Names}} {{.Status}}'
