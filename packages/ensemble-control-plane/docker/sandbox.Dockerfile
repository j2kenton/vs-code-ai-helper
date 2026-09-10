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

# The control plane runs containers as ITS OWN host uid (see
# localDockerSandboxClientV1.ts), and that uid is not knowable at build
# time — on the first real box it was 1001, which exists in no passwd entry
# of this image, so the runtime gave it HOME=/ and it could write nowhere:
# `claude auth login` had no place to persist, and no task could touch
# /workspace (confirmed live). So: a home and a workspace any uid can write,
# rather than directories owned by a uid we guessed. 0777 is acceptable
# here because a sandbox is single-tenant by construction — one user, one
# container — there is nobody inside to protect these from.
RUN mkdir -p /workspace /home/sandbox && chmod 0777 /workspace /home/sandbox
ENV HOME=/home/sandbox
WORKDIR /workspace

# No ENTRYPOINT/CMD on purpose: the control plane starts containers with
# `sleep infinity` and drives every unit of work as a separate exec.
