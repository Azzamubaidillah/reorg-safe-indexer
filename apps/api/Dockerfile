# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22.23.4-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/analytics/package.json packages/analytics/
RUN pnpm install --frozen-lockfile --filter "@rsi/api..." --filter reorg-safe-indexer

COPY tsconfig.json ./
COPY packages/db packages/db
COPY packages/contracts/src packages/contracts/src
COPY packages/analytics/src packages/analytics/src
COPY apps/api/src apps/api/src
# Parquet partitions live on a volume so exports survive container replacement. verifyAnalytics
# re-exports into a scratch directory beside the export, so the parent must be writable too.
RUN mkdir -p /data/analytics && chown -R node:node /data
USER node
ENV ANALYTICS_DIR=/data/analytics API_HOST=0.0.0.0
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["apps/api/src/main.ts"]
