# syntax=docker/dockerfile:1
# Build stage: install workspaces and compile.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
# The MongoDB driver and the Claude Agent SDK are loaded lazily at runtime (no
# build/test dependency), so install them into node_modules here without
# touching the committed lockfile.
RUN npm install --no-save mongodb@^6 @anthropic-ai/claude-agent-sdk
COPY . .
RUN npm run build

# Runtime stage: git is required by the cloner to sync full repositories;
# the Claude Code CLI is the default external review engine (run with
# `claude -p` non-interactively; provide ANTHROPIC_API_KEY at runtime).
FROM node:20-alpine AS runtime
RUN apk add --no-cache git
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
EXPOSE 3000
CMD ["node", "packages/server/dist/src/index.js"]
