# syntax=docker/dockerfile:1
# One Dockerfile, three runnable targets:
#   docker build --target web     -t warrant-web .       (static dashboard behind nginx, :8080)
#   docker build --target demo    -t warrant-demo .      (Ledgerline paid API :8788 + injected notes site :8789)
#   docker build -t warrant-relayer .                    (x402 facilitator + gas-paying relayer, :8787; the default target,
#                                                         so hosts that cannot pick a target, such as Render and Fly, build it)

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
# manifests first so the dependency layer is cached
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
COPY web web
COPY deployments deployments
COPY scripts scripts
RUN pnpm build
# static export of the dashboard (config.js is rewritten at container start)
RUN node scripts/sync-web-config.mjs && cd web && STATIC_EXPORT=1 pnpm exec next build

# ---------------------------------------------------------------- web (static)
FROM nginx:1.27-alpine AS web
COPY --from=build /app/web/out /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# writes /usr/share/nginx/html/config.js from the environment on every start
COPY docker/40-write-config.sh /docker-entrypoint.d/40-write-config.sh
RUN chmod +x /docker-entrypoint.d/40-write-config.sh
EXPOSE 8080
# ---------------------------------------------------------------- demo merchant + notes site
FROM build AS demo
ENV NODE_ENV=production PORT=8788 NOTES_PORT=8789 DATABASE_PATH=/data/ledgerline.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8788 8789
USER node
WORKDIR /app/packages/demo
CMD ["./node_modules/.bin/tsx", "src/serve.ts"]

# ---------------------------------------------------------------- relayer
FROM build AS relayer
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/relayer.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "packages/relayer/dist/server.js"]

