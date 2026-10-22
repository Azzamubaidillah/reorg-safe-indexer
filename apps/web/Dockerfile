# Build from the repository root: docker build -f apps/web/Dockerfile --build-arg API_URL=http://api:3200 .
FROM node:22.23.4-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/analytics/package.json packages/analytics/
RUN pnpm install --frozen-lockfile --filter "@rsi/web..."

COPY packages/contracts/src packages/contracts/src
COPY apps/web apps/web

# next.config.ts bakes the /api rewrite target into the build, so the API address is a build argument.
ARG API_URL
RUN test -n "$API_URL" && pnpm --filter @rsi/web build

USER node
EXPOSE 3100
CMD ["pnpm", "--filter", "@rsi/web", "start"]
