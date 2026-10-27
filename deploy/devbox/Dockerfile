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
RUN npm install -g --allow-scripts=cline,protobufjs,@opencode/cli @anthropic-ai/claude-code @openai/codex @opencode/cli cline @google/gemini-cli \
  && claude --version && codex --version && opencode --version && cline --version && gemini --version

# devpass-code pinned to 1.x: Ensemble's devpass-cli provider speaks the 1.x
# CLI (`run --variant`, `models --verbose`). 2.x is an OpenCode 2 fork that
# dropped both and whose background service takes OpenCode 2's port 49374.
RUN npm install -g --allow-scripts=devpass-code devpass-code@1.18.11 \
  && devpass-code --version

# Kimi Code CLI: Moonshot's official installer (a checksum-verified binary),
# NOT the npm package — that one installs a Windows .cmd shim Ensemble cannot
# run (see the kimi-cli entry in src/runners/providers.ts). System-wide, so
# the runner window's PATH finds it. Downloaded to a file first, so a failed
# or partial download fails the build instead of running half a script.
RUN curl -fsSL -o /tmp/kimi-install.sh https://code.kimi.com/kimi-code/install.sh \
  && KIMI_INSTALL_DIR=/usr/local KIMI_NO_MODIFY_PATH=1 bash /tmp/kimi-install.sh \
  && rm -f /tmp/kimi-install.sh \
  && kimi --version

# pnpm on the SYSTEM path: the workflow's rounds run `pnpm run …` from the
# runner's and viewer's VS Code processes, which never read a login profile —
# a per-user corepack install was invisible to them ("pnpm: command not
# found", seen live 2026-09-17).
RUN corepack enable --install-directory /usr/local/bin
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The user's local time, not UTC: the workflow writes times into its messages
# ("paused until 1:02 PM") in the runner's own clock, which read as three
# hours off (2026-09-17). Build with --build-arg TZ=<zone> for another user.
ARG TZ=Asia/Jerusalem
RUN ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime && echo "${TZ}" > /etc/timezone

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
# One command to bring every copy of Ensemble on the box to the newest
# Marketplace version and report what each window runs.
COPY update-ensemble.sh /usr/local/bin/devbox-update-ensemble
# The push watcher belongs in the image, not in $HOME. runner.sh started it
# from `$HOME/notify-watch.mjs`, a file nothing here ever installed — so a
# rebuilt box ran no watcher at all and sent no notifications, silently, which
# is the exact failure the watcher was moved into runner.sh to end (review,
# 2026-09-22). In the image it is deployed by a rebuild like everything else.
COPY notify-watch.mjs /usr/local/lib/devbox-notify-watch.mjs
COPY reap-viewers.sh /usr/local/bin/devbox-reap-viewers
# A DIAGNOSTIC, not a feature: three renderers died with code 133 inside 24
# hours, each taking a live round with it, and a dead renderer cannot be
# measured after the fact. Remove this once those crashes are understood.
COPY renderer-memory-log.sh /usr/local/bin/devbox-renderer-memory-log
RUN chmod 0755 /usr/local/bin/devbox-entrypoint /usr/local/bin/devbox-runner /usr/local/bin/devbox-install-extension \
    /usr/local/bin/devbox-update-ensemble \
 && chmod 0644 /usr/local/lib/devbox-notify-watch.mjs \
 && chmod 0755 /usr/local/bin/devbox-reap-viewers /usr/local/bin/devbox-renderer-memory-log

EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devbox-entrypoint"]
