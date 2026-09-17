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
chown -R dev:dev /home/dev /workspace
# sshd's StrictModes refuses a key file owned by the host's uid (the mount):
# copy it root-owned.
mkdir -p /etc/ssh/authorized_keys
install -o root -g root -m 0644 /run/devbox-keys/dev /etc/ssh/authorized_keys/dev
# The always-on runner VS Code (see runner.sh), as `dev`, alongside sshd.
su dev -s /bin/sh -c /usr/local/bin/devbox-runner &
exec /usr/sbin/sshd -D -e
