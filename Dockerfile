# syntax=docker/dockerfile:1.7
# Streamline — one image containing the web UI, REST API, MCP server and CLI.
#   docker build -t streamline .
#   docker run -p 8080:8080 -e SESSION_SECRET=$(openssl rand -hex 32) \
#     -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com -e BOOTSTRAP_ADMIN_PASSWORD='Change-Me-123!' \
#     -v streamline-data:/data streamline

ARG NODE_VERSION=22

# ---------------------------------------------------------------- build
# The full image includes python3/make/g++ in case a native module must compile.
FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build -w @streamline/web && npm run build -w @streamline/server
# Reinstall production dependencies of the server only.
RUN rm -rf node_modules packages/*/node_modules \
 && npm ci --omit=dev --workspace=@streamline/server --include-workspace-root=false \
 && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_URL=sqlite:/data/streamline.db \
    WEB_DIST_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/server/dist ./dist
COPY --from=build --chown=node:node /app/packages/server/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/web/dist ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]
