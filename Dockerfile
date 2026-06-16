# syntax=docker/dockerfile:1
# Build stage: install workspaces and compile.
FROM node:20-alpine AS build
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
# Build only the deployable workspaces. The VS Code extension (packages/extension)
# is a separate dev artifact whose esbuild devDependency isn't installed here, and
# it is never shipped in the server image.
RUN npm run build --workspace=packages/server --workspace=packages/web

# Runtime stage: git is required by the cloner to sync full repositories;
# the Claude Code CLI is the default external review engine (run with
# `claude -p` non-interactively; provide ANTHROPIC_API_KEY at runtime).
FROM node:20-alpine AS runtime
# Optional Alpine mirror for networks where dl-cdn.alpinelinux.org is slow or
# unreachable (e.g. behind a corporate proxy / in regions with poor CDN access):
#   docker build --build-arg ALPINE_MIRROR=mirrors.aliyun.com ...
ARG ALPINE_MIRROR=
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories; \
    fi \
 && for i in 1 2 3; do apk add --no-cache git && break || { echo "apk retry $i"; sleep 3; }; done
# Optional npm registry mirror (e.g. https://registry.npmmirror.com) for the
# global Claude Code CLI install.
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
