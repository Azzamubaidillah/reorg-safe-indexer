FROM node:22.16-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

# Dependency layer first so source edits do not reinstall packages. Every workspace manifest is
# copied so the lockfile matches; only the indexer and its workspace dependencies are installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/analytics/package.json packages/analytics/
RUN pnpm install --frozen-lockfile --filter "@rsi/indexer..." --filter reorg-safe-indexer

COPY tsconfig.json ./
COPY packages/db packages/db
COPY packages/contracts/src packages/contracts/src
COPY apps/indexer/src apps/indexer/src

USER node
# tsx runs the TypeScript sources directly; there is no separate build step.
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["apps/indexer/src/main.ts", "run"]
