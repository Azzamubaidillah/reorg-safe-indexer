FROM node:22.16-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

# Dependency layer first so source edits do not reinstall packages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/indexer/package.json apps/indexer/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/db packages/db
COPY apps/indexer/src apps/indexer/src

USER node
# tsx runs the TypeScript sources directly; there is no separate build step.
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["apps/indexer/src/main.ts", "run"]
