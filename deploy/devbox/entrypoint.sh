#!/bin/sh
# Keep sshd host keys on the persistent volume: rebuilding the image must not
# change the box's identity (VS Code would refuse the "changed host key").
set -eu
mkdir -p /home/dev/.devbox-hostkeys
for type in ed25519 rsa; do
  key="/home/dev/.devbox-hostkeys/ssh_host_${type}_key"
  if [ ! -f "$key" ]; then
    ssh-keygen -q -t "$type" -N "" -f "$key"
  fi
  cp "$key" "/etc/ssh/ssh_host_${type}_key"
  cp "$key.pub" "/etc/ssh/ssh_host_${type}_key.pub"
  chmod 0600 "/etc/ssh/ssh_host_${type}_key"
done
# Every Remote-SSH window on this box is a VIEWER (src/state/hostRoleV1.ts):
# the VS Code server reads its machine settings from here. Merged, so other
# machine settings survive.
mkdir -p /home/dev/.vscode-server/data/Machine
node -e '
const fs = require("fs");
const p = "/home/dev/.vscode-server/data/Machine/settings.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s["ensemble.hostRole"] = "viewer";
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
'
chown -R dev:dev /home/dev /workspace
# sshd's StrictModes refuses a key file owned by the host's uid (the mount):
# copy it root-owned.
mkdir -p /etc/ssh/authorized_keys
install -o root -g root -m 0644 /run/devbox-keys/dev /etc/ssh/authorized_keys/dev
# The always-on runner VS Code (see runner.sh), as `dev`, alongside sshd.
su dev -s /bin/sh -c /usr/local/bin/devbox-runner &
runner_pid=$!
# sshd is NOT exec'd any more: this shell has to stay alive to forward
# SIGTERM. `docker stop` signals tini, tini signals this shell — and with the
# old `exec`, the runner's VS Code was never signalled at all and died with
# the container's SIGKILL. A runner killed that way cannot record that it
# stopped mid-round, so a viewer could only ever report that it had "stopped
# reporting" (verification review, 2026-09-18).
/usr/sbin/sshd -D -e &
sshd_pid=$!
shutdown() {
  kill -TERM "$runner_pid" 2>/dev/null || true
  # `su` does not reliably forward a signal to the script it started, so the
  # runner windows are asked to close directly too. This pattern matches only
  # the desktop runner VS Code — never a Remote-SSH server (.vscode-server),
  # i.e. never the user's own window.
  pkill -TERM -u dev -f '/usr/share/code/[c]ode --wait' 2>/dev/null || true
  # Signalling is not enough on its own: exiting here would end the container
  # while VS Code was still deactivating, and the "the runner stopped while
  # this was running" record it writes on the way out would never land. Wait
  # for the windows to go, bounded well inside `docker stop`'s default
  # 10-second grace (verification review, 2026-09-18).
  waited=0
  while pgrep -u dev -f '/usr/share/code/[c]ode --wait' >/dev/null 2>&1; do
    waited=$((waited + 1))
    [ "$waited" -ge 8 ] && break
    sleep 1
  done
  kill -TERM "$sshd_pid" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
# `|| true`: a signal makes `wait` return 143, and `set -e` would otherwise
# end this shell before the trap's own shutdown had run.
wait "$sshd_pid" || true
