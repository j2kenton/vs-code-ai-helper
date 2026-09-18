#!/bin/sh
# Build and (re)start the dev box on the cloud host. Idempotent.
#   AUTHORIZED_KEY_FILE=~/.ssh/devbox_authorized_key sh run.sh
#
# DESTRUCTIVE: this DELETES and RECREATES the container (docker rm -f below),
# which kills the runner's VS Code and any workflow round it is part-way
# through — the round's work-admission claim is then left behind, so the task
# refuses new actions until that claim ages out (~20 min). Run it only when
# nothing is running, and only when the image itself needs rebuilding.
# To restart just the runner (seconds, nothing else touched):
#   ssh ensemble-devbox "pkill -f '/usr/share/code/[c]ode --wait'"
# runner.sh brings a fresh window straight back up.
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
  else
    echo "WARNING: could not build the narrowed seccomp profile; falling back to seccomp=unconfined." >&2
    echo "         (Set DEVBOX_SECCOMP_BASE=<path to moby's default.json> to avoid this.)" >&2
    sandbox_opts="$sandbox_opts --security-opt seccomp=unconfined"
  fi
fi

sudo docker rm -f ensemble-devbox >/dev/null 2>&1 || true
# SSH only on the host's loopback: reached through the host's own SSH
# (ProxyJump), never exposed to the internet directly.
sudo docker run -d --name ensemble-devbox \
  --restart unless-stopped \
  --hostname ensemble-devbox \
  -p 127.0.0.1:2222:2222 \
  --memory 12g --cpus 3 --pids-limit 4096 \
  $sandbox_opts \
  -v ensemble-devbox-home:/home/dev \
  -v ensemble-devbox-workspace:/workspace \
  -v "$keys_dir:/run/devbox-keys:ro" \
  ensemble-devbox:latest
sudo docker ps --filter name=ensemble-devbox --format '{{.Names}} {{.Status}}'
