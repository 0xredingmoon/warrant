# syntax=docker/dockerfile:1
# Hugging Face Docker Space for the Warrant relayer. Binds 0.0.0.0:7860.
# The Space repo is a copy of the Warrant tree (see scripts/deploy-hf-space.sh).
FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/store/package.json packages/store/
COPY packages/relayer/package.json packages/relayer/
COPY packages/merchant/package.json packages/merchant/
COPY packages/demo/package.json packages/demo/
COPY packages/mcp/package.json packages/mcp/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY tsconfig.base.json tsconfig.base.json
RUN pnpm --filter @warrant/sdk --filter @warrant/store --filter @warrant/relayer build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7860 DATABASE_PATH=/tmp/relayer.db
EXPOSE 7860
USER node
CMD ["node", "packages/relayer/dist/server.js"]
