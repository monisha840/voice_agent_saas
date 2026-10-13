# syntax=docker/dockerfile:1
#
# Voice AI dashboard (Next.js). Build from the REPOSITORY ROOT:
#   docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t voice-agent-web .
#
# NEXT_PUBLIC_API_URL is baked into the browser bundle at build time, so it is a build argument, not a runtime
# variable. At runtime the server side may use API_URL (internal address of the API) and SESSION_COOKIE_NAME.
ARG NODE_VERSION=22
ARG PNPM_VERSION=12.6.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm install --frozen-lockfile --filter @voice-agent/web...
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @voice-agent/web build

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter @voice-agent/web...
COPY --from=build /repo/apps/web/.next apps/web/.next
COPY apps/web/next.config.mjs apps/web/
RUN chown -R node:node /repo
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
