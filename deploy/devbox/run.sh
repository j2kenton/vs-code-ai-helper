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

sudo docker rm -f ensemble-devbox >/dev/null 2>&1 || true
# SSH only on the host's loopback: reached through the host's own SSH
# (ProxyJump), never exposed to the internet directly.
sudo docker run -d --name ensemble-devbox \
  --restart unless-stopped \
  --hostname ensemble-devbox \
  -p 127.0.0.1:2222:2222 \
  --memory 12g --cpus 3 --pids-limit 4096 \
  -v ensemble-devbox-home:/home/dev \
  -v ensemble-devbox-workspace:/workspace \
  -v "$keys_dir:/run/devbox-keys:ro" \
  ensemble-devbox:latest
sudo docker ps --filter name=ensemble-devbox --format '{{.Names}} {{.Status}}'
