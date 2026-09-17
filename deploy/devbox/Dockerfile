# The Ensemble dev box: where the REAL extension runs your workflow in the cloud.
#
# Not a port of the workflow — the same VS Code extension, the same task
# folders, the same provider CLIs, running on the box instead of the laptop.
# VS Code connects over SSH (Remote-SSH), installs its server in here, and the
# extension host keeps running after the laptop disconnects for as long as
# `remote.SSH.reconnectionGraceTime` allows (set to weeks; see README.md).
#
# Build and run on the box: see run.sh next to this file.
FROM node:24-bookworm

# sshd (Remote-SSH's transport) and what the workflow and VS Code server expect.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server ripgrep less procps ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/sshd

# The RUNNER: a real desktop VS Code that runs permanently on a virtual
# display. A Remote-SSH window's extension host ends the moment its client
# closes cleanly (a laptop shutdown does exactly that — confirmed live), so the
# workflow cannot live there; it lives here, in a VS Code that never
# disconnects. x11vnc + noVNC are for one-time interactive setup (e.g. signing
# Copilot in) from a browser, reached only through an SSH tunnel; x11-apps and
# imagemagick take diagnostic screenshots of the runner (xwd | convert).
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb x11vnc dbus-x11 xauth novnc python3-websockify \
     x11-apps imagemagick \
     libasound2 libgbm1 libgtk-3-0 libnss3 libxkbfile1 libsecret-1-0 fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/code.deb "https://update.code.visualstudio.com/latest/linux-deb-$(dpkg --print-architecture)/stable" \
  && apt-get update && apt-get install -y --no-install-recommends /tmp/code.deb \
  && rm -rf /var/lib/apt/lists/* /tmp/code.deb \
  && code --version --no-sandbox --user-data-dir /tmp/code-probe

# The provider CLIs enabled in the local setup, installed signed-out. Each is
# signed in once, interactively, on the user's own subscription; the logins
# persist in /home/dev (a volume).
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
  && claude --version && codex --version && opencode --version

# One non-root user who owns the workspace and the logins. uid 1000 is
# `node` in this base image: reuse the uid under a clearer name.
RUN usermod -l dev -d /home/dev -m node \
  && groupmod -n dev node \
  && mkdir -p /workspace && chown dev:dev /workspace

# Key-only SSH on 2222, for `dev` alone. The authorized key is mounted at run
# time (run.sh), never baked in.
RUN printf '%s\n' \
    'Port 2222' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PermitRootLogin no' \
    'AllowUsers dev' \
    'AuthorizedKeysFile /etc/ssh/authorized_keys/%u' \
    'AllowTcpForwarding yes' \
    'X11Forwarding no' \
    > /etc/ssh/sshd_config.d/ensemble-devbox.conf

# Host keys live on the volume so the box's identity survives rebuilds.
COPY entrypoint.sh /usr/local/bin/devbox-entrypoint
COPY runner.sh /usr/local/bin/devbox-runner
COPY install-extension.sh /usr/local/bin/devbox-install-extension
RUN chmod 0755 /usr/local/bin/devbox-entrypoint /usr/local/bin/devbox-runner /usr/local/bin/devbox-install-extension

EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devbox-entrypoint"]
