# syntax=docker/dockerfile:1
#
# Voice AI API. Build from the REPOSITORY ROOT:
#   docker build -f infra/docker/api.Dockerfile -t voice-agent-api .
#
# Configuration is environment variables only (see .env.example). With NODE_ENV=production the server validates its
# configuration at startup and refuses to start, listing every problem, if something required is missing.
#
#   run the API:        docker run --env-file .env -p 4000:4000 voice-agent-api
#   apply migrations:   docker run --env-file .env voice-agent-api node dist/db/migrate.js
#
# Give the container time to drain live calls on SIGTERM: set the orchestrator's stop grace period above
# SHUTDOWN_DRAIN_TIMEOUT_MS (default 120s), e.g. `docker stop -t 150` or terminationGracePeriodSeconds: 150.
ARG NODE_VERSION=22
ARG PNPM_VERSION=12.6.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
# Only the manifests first, so the dependency layer is cached until a manifest changes. (The lockfile also lists the
# web app, so its manifest must be present for --frozen-lockfile even though only the API is installed.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @voice-agent/api...
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @voice-agent/api build

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter @voice-agent/api...
COPY --from=build /repo/apps/api/dist apps/api/dist
# tsc does not copy the SQL migrations; db/migrate.js expects them next to itself.
COPY apps/api/src/db/migrations apps/api/dist/db/migrations
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
# Liveness only (never the database); orchestrators should use GET /ready for traffic decisions.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT_API||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
