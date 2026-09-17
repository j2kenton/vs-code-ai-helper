#!/bin/sh
# Build and (re)start the dev box on the cloud host. Idempotent.
#   AUTHORIZED_KEY_FILE=~/.ssh/devbox_authorized_key sh run.sh
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

# Codex's review sandbox (bubblewrap) needs a user namespace, which the host
# denies to containers by default — see apparmor-ensemble-devbox for what was
# measured. The profile grants that to THIS container only; with it, the
# container also runs without Docker's seccomp filter, which blocks the same
# calls. Set DEVBOX_CODEX_SANDBOX=0 to keep the stock confinement instead
# (Codex reviews on the box then cannot run commands).
sandbox_opts=""
if [ "${DEVBOX_CODEX_SANDBOX:-1}" = "1" ]; then
  sudo install -m 0644 apparmor-ensemble-devbox /etc/apparmor.d/ensemble-devbox
  sudo apparmor_parser -r /etc/apparmor.d/ensemble-devbox
  sandbox_opts="--security-opt seccomp=unconfined --security-opt apparmor=ensemble-devbox"
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
