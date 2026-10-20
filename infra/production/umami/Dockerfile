# syntax=docker/dockerfile:1.7
# Umami is an application-private runtime. This never changes workspace Node/pnpm.
# Source: upstream v3.4.0, resolved and archive-hashed on 2026-10-19.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app
ADD --checksum=sha256:dfdc154f23fe52ffd8fbf13c0544ea880e5ef01463f57d06954512b41c50a93a https://codeload.github.com/umami-software/umami/tar.gz/ec0ff50388c264ed8ce46f00967e92f7e71476ae /tmp/umami.tar.gz
RUN tar -xzf /tmp/umami.tar.gz --strip-components=1 -C /app \
    && rm /tmp/umami.tar.gz \
    && apk add --no-cache libc6-compat patch \
    && npm install --global pnpm@12.3.4 \
    && printf '\nstrictDepBuilds: false\n' >> pnpm-workspace.yaml \
    && pnpm install --frozen-lockfile
COPY pool-limit.patch upstream-pool.sha256 patched-pool.sha256 /tmp/
RUN sha256sum -c /tmp/upstream-pool.sha256 \
    && patch -p1 --fuzz=0 < /tmp/pool-limit.patch \
    && sha256sum -c /tmp/patched-pool.sha256 \
    && cp /app/docker/proxy.ts /app/src/proxy.ts
ENV BASE_PATH=/admin/analytics-workspace \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_TYPE=postgresql
# Reviewed, unreachable build-only placeholder. No real database/config is copied.
ENV DATABASE_URL=postgresql://REPLACE_ME_BUILD_USER:REPLACE_ME_BUILD_PASSWORD@127.0.0.1:5432/REPLACE_ME_BUILD_DATABASE
RUN pnpm build:docker

# Explicit migration image. Never run automatically from the serving unit.
FROM builder AS migrator
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
LABEL org.opencontainers.image.title="ArtVenn private Umami" \
    org.opencontainers.image.version="3.4.0" \
    org.opencontainers.image.source="https://github.com/umami-software/umami" \
    org.opencontainers.image.revision="ec0ff50388c264ed8ce46f00967e92f7e71476ae" \
    com.artvenn.umami.base-path="/admin/analytics-workspace"
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    BASE_PATH=/admin/analytics-workspace \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=512
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/LICENSE ./LICENSE
USER node
EXPOSE 3000
# Native server only: no implicit migration, seed, dependency install or downloads.
CMD ["node", "server.js"]


# Glibc artifact for the existing Ubuntu/Debian host Node runtime. Do not export
# Alpine node_modules to a glibc host (sharp/native packages are platform-bound).
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS standalone-builder
WORKDIR /app
ADD --checksum=sha256:dfdc154f23fe52ffd8fbf13c0544ea880e5ef01463f57d06954512b41c50a93a https://codeload.github.com/umami-software/umami/tar.gz/ec0ff50388c264ed8ce46f00967e92f7e71476ae /tmp/umami.tar.gz
RUN tar -xzf /tmp/umami.tar.gz --strip-components=1 -C /app \
    && rm /tmp/umami.tar.gz \
    && apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates patch \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.3.4 \
    && printf '\nstrictDepBuilds: false\n' >> pnpm-workspace.yaml \
    && pnpm install --frozen-lockfile
COPY pool-limit.patch upstream-pool.sha256 patched-pool.sha256 /tmp/
RUN sha256sum -c /tmp/upstream-pool.sha256 \
    && patch -p1 --fuzz=0 < /tmp/pool-limit.patch \
    && sha256sum -c /tmp/patched-pool.sha256 \
    && cp /app/docker/proxy.ts /app/src/proxy.ts
ENV BASE_PATH=/admin/analytics-workspace \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_TYPE=postgresql \
    DATABASE_URL=postgresql://REPLACE_ME_BUILD_USER:REPLACE_ME_BUILD_PASSWORD@127.0.0.1:5432/REPLACE_ME_BUILD_DATABASE
RUN pnpm build:docker

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS standalone
LABEL org.opencontainers.image.title="ArtVenn private Umami standalone artifact" \
    org.opencontainers.image.version="3.4.0" \
    org.opencontainers.image.source="https://github.com/umami-software/umami" \
    org.opencontainers.image.revision="ec0ff50388c264ed8ce46f00967e92f7e71476ae" \
    com.artvenn.umami.base-path="/admin/analytics-workspace" \
    com.artvenn.umami.libc="glibc" \
    com.artvenn.umami.node-major="24" \
    com.artvenn.umami.pool-max="3"
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=127.0.0.1 \
    PORT=3010 \
    BASE_PATH=/admin/analytics-workspace \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=512
COPY --from=standalone-builder --chown=node:node /app/.next/standalone ./
COPY --from=standalone-builder --chown=node:node /app/.next/static ./.next/static
COPY --from=standalone-builder --chown=node:node /app/public ./public
COPY --from=standalone-builder --chown=node:node /app/LICENSE ./LICENSE
USER node
CMD ["node", "server.js"]
