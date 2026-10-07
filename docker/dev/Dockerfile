# Development image for OpenCode: Bun, the workspace dependencies, and the Claude Code CLI used by
# `/merge claude`. Nothing is installed on the host; source edits reach running containers through
# `docker compose watch` (see compose.yaml).
FROM ubuntu:24.04 AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG BUN_VERSION=1.3.14
# The merge adapter's stdio permission protocol was verified against this Claude Code release.
ARG CLAUDE_CODE_VERSION=2.1.123

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    procps \
    python3 \
    ripgrep \
    unzip \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:/root/.local/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" && bun --version

# Claude Code keeps its login and transcripts under CLAUDE_CONFIG_DIR (a named volume), and stays on
# the pinned version instead of auto-updating inside the container.
ENV CLAUDE_CONFIG_DIR=/claude-config
ENV DISABLE_AUTOUPDATER=1
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" && claude --version

# Only the files `bun install` reads, so the dependency layer is rebuilt only when they change.
FROM base AS manifests
COPY . /src
RUN mkdir /manifests \
  && cd /src \
  && find . -name package.json -not -path "*/node_modules/*" -exec cp --parents {} /manifests \; \
  && find . -name "*.tgz" -path "*/vendor/*" -not -path "*/node_modules/*" -exec cp --parents {} /manifests \; \
  && cp --parents bun.lock bunfig.toml packages/core/script/fix-node-pty.ts /manifests \
  && cp -r patches /manifests/patches

FROM base AS dev
WORKDIR /opencode
COPY --from=manifests /manifests ./
# HUSKY=0: no git hooks in the image. Electron is only needed by the desktop package.
RUN --mount=type=cache,target=/root/.bun/install/cache \
  HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile
COPY . .
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Browser tests: the Playwright image (its version matches @playwright/test in packages/app) with Bun
# and the workspace from the dev stage. Run through the `e2e` compose service, which sets limits.
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS e2e
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
COPY --from=base /opt/bun /opt/bun
COPY --from=dev /opencode /opencode
WORKDIR /opencode/packages/app
# Warm Vite's dependency cache: the markdown worker's packages (marked, katex, shiki) are found only
# when a session page renders markdown, and finding them makes Vite reload the page in the middle of
# a test. Requesting those modules once here pre-bundles them into the image.
RUN bash -c 'bunx vite --host 127.0.0.1 --port 3999 > /tmp/vite-warm.log 2>&1 & pid=$!; \
  for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:3999/ && break; sleep 1; done; \
  for f in session-ui/src/components/markdown.worker.ts session-ui/src/components/markdown-stream.ts ui/src/context/marked-parser.tsx; do \
    curl -s -o /dev/null "http://127.0.0.1:3999/@fs/opencode/packages/$f"; done; \
  for i in $(seq 1 60); do grep -q "optimized" /tmp/vite-warm.log && break; sleep 1; done; sleep 2; \
  kill $pid; grep -i "optimiz" /tmp/vite-warm.log || true'
ENV CI=1
