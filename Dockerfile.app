FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY skill ./skill
RUN npm run build && npm prune --omit=dev

# PostgreSQL 16 client utilities match the pg16 Compose database, so
# foundation-admin backup/migrate never depends on an older distro pg_dump.
FROM postgres:16-bookworm
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/skill ./skill
USER app
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 CMD node -e "require('http').get('http://127.0.0.1:8787/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/src/index.js"]
CMD []
