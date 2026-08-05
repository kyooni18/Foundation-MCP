FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY skill ./skill
RUN npm run build && npm prune --omit=dev

FROM pgvector/pgvector:pg16
ENV NODE_ENV=production
WORKDIR /app

# Keep PostgreSQL and the MCP server in one image. The Node runtime is copied
# from the build image so the application still runs on Node 22.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/skill ./skill
COPY container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
    && chmod 755 /usr/local/bin/container-entrypoint.sh \
    && mkdir -p /var/lib/postgresql/data \
    && chown -R postgres:postgres /var/lib/postgresql/data \
    && chown -R app:app /app

ENV POSTGRES_DB=foundation \
    POSTGRES_USER=foundation \
    POSTGRES_PASSWORD=foundation \
    PGDATA=/var/lib/postgresql/data/pgdata \
    DATABASE_URL=postgresql://foundation:foundation@127.0.0.1:5432/foundation \
    MCP_TRANSPORT=http \
    HOST=:: \
    PORT=8787
EXPOSE 8787
VOLUME ["/var/lib/postgresql/data"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD node -e "require('http').get('http://127.0.0.1:8787/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/container-entrypoint.sh"]
