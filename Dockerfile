# syntax=docker/dockerfile:1
# Base image is overridable for China-region builds that can't set a daemon
# registry-mirror (registry-mirrors only proxy docker.io), e.g.:
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:20-slim
ARG NODE_IMAGE=node:20-slim
# uv/uvx binaries come from a NAMED stage (not COPY --from=$ARG, which the
# legacy non-BuildKit builder can't expand). Override the source image for
# China-region builds, e.g.:
#   --build-arg UV_IMAGE=ghcr.m.daocloud.io/astral-sh/uv:latest
ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv

# Build stage: install workspaces and compile.
# Debian slim (glibc) so any native node_modules match the glibc runtime stage
# below (and so the runtime can host code-review-graph's manylinux wheels).
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Optional npm registry mirror for restricted networks, e.g.:
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
# The MongoDB driver and the Claude Agent SDK are loaded lazily at runtime (no
# build/test dependency), so install them into node_modules here without
# touching the committed lockfile.
RUN npm install --no-save mongodb@^6 @anthropic-ai/claude-agent-sdk
COPY . .
# Bake a fresh Ed25519 attestation signing key INTO the image: generate it here
# (node's crypto — no extra tools) and compile it into the bundle via
# attest/signing-key.ts, so the server needs no runtime key file or env var. The
# matching PUBLIC key is printed below and is also served at /api/attest/pubkey.
# In production, override with the ATTEST_SIGNING_KEY env var (from a secret)
# instead of baking the key into the image (anyone who can pull the image can
# otherwise extract the private key and forge attestations).
RUN node -e "const c=require('crypto');const fs=require('fs');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');const priv=privateKey.export({type:'pkcs8',format:'pem'}).toString();fs.writeFileSync('packages/server/src/attest/signing-key.ts','// generated at image build — do not edit\nexport const EMBEDDED_SIGNING_KEY = '+JSON.stringify(priv)+';\n');process.stdout.write('=== ReviewPilot attestation PUBLIC key (also at /api/attest/pubkey) ===\n'+publicKey.export({type:'spki',format:'pem'}).toString()+'\n');"
# Build only the deployable workspaces. The VS Code extension (packages/extension)
# is a separate dev artifact whose esbuild devDependency isn't installed here, and
# it is never shipped in the server image.
RUN npm run build --workspace=packages/server --workspace=packages/web

# Runtime stage (Debian slim / glibc): git for the cloner to sync repos, the
# Claude Code CLI (default review engine, run `claude -p` non-interactively with
# ANTHROPIC_API_KEY at runtime), and uv + code-review-graph (the structural-
# context engine). glibc is required: code-review-graph's tree-sitter-language-
# pack ships manylinux wheels but no musl wheels, so it can't install on alpine
# without a full C toolchain.
FROM ${NODE_IMAGE} AS runtime
# Optional Debian apt mirror for restricted networks (China-friendly). Pass the
# mirror HOST (e.g. mirrors.aliyun.com or mirrors.tuna.tsinghua.edu.cn); it
# rewrites both deb822 (.sources) and classic sources.list. Big win: installing
# git pulls perl/openssl/curl etc. from deb.debian.org, which is slow overseas.
#   --build-arg APT_MIRROR=mirrors.aliyun.com
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# --- Structural-context engine: uv + code-review-graph ---
# uvx is the default CODE_GRAPH_LAUNCHER; the static binaries come from the `uv`
# stage above (override its source via --build-arg UV_IMAGE). Referencing the
# stage NAME keeps this working on the legacy builder too.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_CACHE_DIR=/opt/uv/cache \
    UV_HTTP_TIMEOUT=300
# Optional mirrors for restricted networks (China-friendly):
#   --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
#   --build-arg UV_PYTHON_INSTALL_MIRROR=https://<mirror>   (Python download)
# The uv-managed Python is fetched from GitHub by default — also slow in China.
ARG PIP_INDEX_URL=
ARG UV_PYTHON_INSTALL_MIRROR=
# Install + pre-warm at BUILD time so reviews never hit PyPI at runtime: uvx
# reuses the installed tool env (and the cached --from env) offline. Failing
# here is a loud, visible build error rather than a silently-degraded image.
RUN if [ -n "$PIP_INDEX_URL" ]; then export UV_DEFAULT_INDEX="$PIP_INDEX_URL"; fi \
 && if [ -n "$UV_PYTHON_INSTALL_MIRROR" ]; then export UV_PYTHON_INSTALL_MIRROR; fi \
 && uv python install 3.12 \
 && uv tool install --python 3.12 code-review-graph \
 && uvx code-review-graph --version \
 && uvx --from code-review-graph python -c "import code_review_graph"
# --- Claude Code CLI (default external review engine) ---
# Optional npm registry mirror (e.g. https://registry.npmmirror.com).
ARG NPM_REGISTRY=
# Verify the CLI is actually runnable at BUILD time. On restricted networks npm
# can silently skip the platform-specific binary (optionalDependency), leaving a
# CLI that fails at runtime with "spawn … ENOEXEC". `claude --version` here turns
# that into a loud, visible build failure instead of a broken image.
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && npm install -g @anthropic-ai/claude-code \
 && claude --version
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
EXPOSE 3000
CMD ["node", "packages/server/dist/src/index.js"]
