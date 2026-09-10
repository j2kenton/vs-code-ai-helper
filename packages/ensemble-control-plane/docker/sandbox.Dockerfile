# The self-hosted sandbox image: what a task's `docker` sandbox runs.
#
# Provisioning happens HERE, at image build time, and nowhere else. The
# alternative — installing the CLI into each fresh container at task start —
# was tried and rejected: containers run as the control plane's own non-root
# uid (see localDockerSandboxClientV1.ts), and `npm install -g` as that user
# fails against the image's root-owned global prefix; giving every task a
# network install step would also make "create sandbox" slow and flaky for
# no benefit. Bake the tools once, as root, into a world-readable prefix.
#
# Build on the control-plane host, then point the control plane at it:
#   docker build -t ensemble-sandbox:latest -f sandbox.Dockerfile .
#   ENSEMBLE_DOCKER_SANDBOX_IMAGE=ensemble-sandbox:latest   (in .env.local)
#
# What is deliberately NOT in here: any credential. The Claude Code CLI is
# installed signed-out; each user's persistent sandbox is signed in through
# the control plane's in-sandbox login flow, on that user's own subscription.
FROM node:24-bookworm

# The subscription CLI the engine's `claude-cli` provider runs per round.
# Pinned to the version validated live against the login/round flow; bump
# deliberately, re-validating `claude auth login`'s prompt shape (the app's
# cliLoginPromptV1 parser is pinned to it) and `claude -p` flags.
ARG CLAUDE_CODE_VERSION=2.1.267
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version

# A writable workspace root for the non-root uid the control plane runs
# containers as. `node` is uid 1000 in this image — the same uid the
# control plane's own `ubuntu` service user has on the host — so this is
# owned by the user that will actually run inside.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

# No ENTRYPOINT/CMD on purpose: the control plane starts containers with
# `sleep infinity` and drives every unit of work as a separate exec.
