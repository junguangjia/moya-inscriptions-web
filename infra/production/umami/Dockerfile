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
# Preserve the actual host when upgrading pg's existing socket to strict TLS.
# With Node 24 and an IP target, omitting it makes certificate checks use localhost.
COPY pg-tls-host.patch upstream-pg-tls.sha256 patched-pg-tls.sha256 /tmp/
RUN sha256sum -c /tmp/upstream-pg-tls.sha256 \
    && patch -p1 --fuzz=0 < /tmp/pg-tls-host.patch \
    && sha256sum -c /tmp/patched-pg-tls.sha256
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
ADD --checksum=sha256:46df66d141c04e4920e00b5e4bbfc4445178adc11de9a8b2900bcea79c100c0e https://raw.githubusercontent.com/GitSquared/node-geolite2-redist/e26a98449d33ab0639d555b736898d4f55623c82/redist/GeoLite2-City.tar.gz /tmp/geolite-city.tar.gz
RUN mkdir -p /app/geo \
    && tar -xzf /tmp/geolite-city.tar.gz --strip-components=1 -C /app/geo \
    && echo 'fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029  /app/geo/GeoLite2-City.mmdb' | sha256sum -c - \
    && rm /tmp/geolite-city.tar.gz
COPY chinese-workspace.patch upstream-chinese.sha256 patched-chinese.sha256 generated-chinese.sha256 /tmp/
COPY generate-chinese-dictionaries.mjs /app/scripts/artvenn-generate-chinese.mjs
RUN sha256sum -c /tmp/upstream-chinese.sha256 \
    && patch -p1 --fuzz=0 < /tmp/chinese-workspace.patch \
    && sha256sum -c /tmp/patched-chinese.sha256 \
    && echo 'bb6148463d47161c894f28b09d6f93611a002f0f8013d84df6a61126419680f7  /app/scripts/artvenn-generate-chinese.mjs' | sha256sum -c - \
    && node scripts/artvenn-generate-chinese.mjs --database geo/GeoLite2-City.mmdb --output-dir src/data \
    && sha256sum -c /tmp/generated-chinese.sha256 \
    && cp src/data/geo-translations-NOTICE.txt geo/geo-translations-NOTICE.txt
COPY archive-theme.css /app/src/app/archive-theme.css
COPY archive-navigation.json /app/src/data/archive-navigation.json
COPY archive-icons.svg /app/public/archive-icons.svg
COPY archive-assets.sha256 /tmp/archive-assets.sha256
RUN echo '0cdc492b32ec8631fa93821577a0cc0b8bdc31fd75204349323e6b806c8f9b1e  /tmp/archive-assets.sha256' | sha256sum -c -
RUN sha256sum -c /tmp/archive-assets.sha256
COPY china-provinces.json china-map-NOTICE.txt /app/public/maps/
RUN echo '99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275  /app/public/maps/china-provinces.json' | sha256sum -c - \
    && echo '9c7d4778ad5c927ebb19371132f4b4943147f28f13eca7c60b1bd1a6852d79e1  /app/public/maps/china-map-NOTICE.txt' | sha256sum -c -
ENV SKIP_BUILD_GEO=1
RUN pnpm exec vitest run src/lib/format.test.ts src/lib/artvenn-labels.test.ts src/lib/artvenn-geography.test.ts src/components/hooks/useFormat.test.ts src/lib/artvenn-china-map.test.ts src/components/metrics/artvenn-geography-lists.test.tsx src/queries/sql/sessions/artvenn-geography-context.test.ts src/components/metrics/MetricLabel.test.tsx src/components/metrics/WorldMap.test.tsx src/components/metrics/WorldMap.geometry.test.tsx 'src/app/(main)/boards/[boardId]/BoardViewHeader.test.tsx' src/components/metrics/MetricsExpandedTable.accessibility.test.tsx 'src/app/api/websites/[websiteId]/metrics/artvenn-display.test.ts' 'src/app/(main)/App.archive.test.tsx' 'src/app/(main)/ArchiveShell.test.tsx' 'src/app/(main)/websites/[websiteId]/ArchiveReportNav.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsiteHeader.archive.test.tsx' 'src/app/(main)/ArchiveContextNav.test.tsx' 'src/app/(main)/ArchiveContinuousNavigation.test.tsx' 'src/lib/archive-analysis.test.ts' 'src/components/hooks/archive-analysis-scope.test.tsx' 'src/components/metrics/WeeklyTraffic.test.tsx' 'src/components/common/DataGrid.archive.test.tsx' 'src/components/input/WebsiteFilterButton.archive.test.tsx' 'src/app/(main)/websites/[websiteId]/ArchiveAnalysis.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsitePage.composed.test.tsx' 'src/app/(main)/websites/[websiteId]/compare/CompareTables.archive.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsiteExpandedView.archive.test.tsx' --maxWorkers=1 \
    && pnpm build:docker

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
    com.artvenn.umami.patch-sha256="fcb4463a3a67860e710a6b7c94fffdca29813bb5a324ee45a9578f0dd7fbbcdd" \
    com.artvenn.umami.pg-tls-host-sha256="ad0a70c6fc8820bb613a8437c634b6a0a6a04cc3cc36175ab72590d2733c24e6" \
    com.artvenn.umami.locale="zh-CN" \
    com.artvenn.umami.geography="cn-province-map-v2" \
    com.artvenn.umami.china-map-sha256="99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275" \
    com.artvenn.umami.geo-sha256="fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029" \
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
COPY --from=builder --chown=node:node /app/geo ./geo
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
# Preserve the actual host when upgrading pg's existing socket to strict TLS.
# With Node 24 and an IP target, omitting it makes certificate checks use localhost.
COPY pg-tls-host.patch upstream-pg-tls.sha256 patched-pg-tls.sha256 /tmp/
RUN sha256sum -c /tmp/upstream-pg-tls.sha256 \
    && patch -p1 --fuzz=0 < /tmp/pg-tls-host.patch \
    && sha256sum -c /tmp/patched-pg-tls.sha256
COPY pool-limit.patch upstream-pool.sha256 patched-pool.sha256 /tmp/
RUN sha256sum -c /tmp/upstream-pool.sha256 \
    && patch -p1 --fuzz=0 < /tmp/pool-limit.patch \
    && sha256sum -c /tmp/patched-pool.sha256 \
    && cp /app/docker/proxy.ts /app/src/proxy.ts
ENV BASE_PATH=/admin/analytics-workspace \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_TYPE=postgresql \
    DATABASE_URL=postgresql://REPLACE_ME_BUILD_USER:REPLACE_ME_BUILD_PASSWORD@127.0.0.1:5432/REPLACE_ME_BUILD_DATABASE
ADD --checksum=sha256:46df66d141c04e4920e00b5e4bbfc4445178adc11de9a8b2900bcea79c100c0e https://raw.githubusercontent.com/GitSquared/node-geolite2-redist/e26a98449d33ab0639d555b736898d4f55623c82/redist/GeoLite2-City.tar.gz /tmp/geolite-city.tar.gz
RUN mkdir -p /app/geo \
    && tar -xzf /tmp/geolite-city.tar.gz --strip-components=1 -C /app/geo \
    && echo 'fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029  /app/geo/GeoLite2-City.mmdb' | sha256sum -c - \
    && rm /tmp/geolite-city.tar.gz
COPY chinese-workspace.patch upstream-chinese.sha256 patched-chinese.sha256 generated-chinese.sha256 /tmp/
COPY generate-chinese-dictionaries.mjs /app/scripts/artvenn-generate-chinese.mjs
RUN sha256sum -c /tmp/upstream-chinese.sha256 \
    && patch -p1 --fuzz=0 < /tmp/chinese-workspace.patch \
    && sha256sum -c /tmp/patched-chinese.sha256 \
    && echo 'bb6148463d47161c894f28b09d6f93611a002f0f8013d84df6a61126419680f7  /app/scripts/artvenn-generate-chinese.mjs' | sha256sum -c - \
    && node scripts/artvenn-generate-chinese.mjs --database geo/GeoLite2-City.mmdb --output-dir src/data \
    && sha256sum -c /tmp/generated-chinese.sha256 \
    && cp src/data/geo-translations-NOTICE.txt geo/geo-translations-NOTICE.txt
COPY archive-theme.css /app/src/app/archive-theme.css
COPY archive-navigation.json /app/src/data/archive-navigation.json
COPY archive-icons.svg /app/public/archive-icons.svg
COPY archive-assets.sha256 /tmp/archive-assets.sha256
RUN echo '0cdc492b32ec8631fa93821577a0cc0b8bdc31fd75204349323e6b806c8f9b1e  /tmp/archive-assets.sha256' | sha256sum -c -
RUN sha256sum -c /tmp/archive-assets.sha256
COPY china-provinces.json china-map-NOTICE.txt /app/public/maps/
RUN echo '99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275  /app/public/maps/china-provinces.json' | sha256sum -c - \
    && echo '9c7d4778ad5c927ebb19371132f4b4943147f28f13eca7c60b1bd1a6852d79e1  /app/public/maps/china-map-NOTICE.txt' | sha256sum -c -
ENV SKIP_BUILD_GEO=1
RUN pnpm exec vitest run src/lib/format.test.ts src/lib/artvenn-labels.test.ts src/lib/artvenn-geography.test.ts src/components/hooks/useFormat.test.ts src/lib/artvenn-china-map.test.ts src/components/metrics/artvenn-geography-lists.test.tsx src/queries/sql/sessions/artvenn-geography-context.test.ts src/components/metrics/MetricLabel.test.tsx src/components/metrics/WorldMap.test.tsx src/components/metrics/WorldMap.geometry.test.tsx 'src/app/(main)/boards/[boardId]/BoardViewHeader.test.tsx' src/components/metrics/MetricsExpandedTable.accessibility.test.tsx 'src/app/api/websites/[websiteId]/metrics/artvenn-display.test.ts' 'src/app/(main)/App.archive.test.tsx' 'src/app/(main)/ArchiveShell.test.tsx' 'src/app/(main)/websites/[websiteId]/ArchiveReportNav.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsiteHeader.archive.test.tsx' 'src/app/(main)/ArchiveContextNav.test.tsx' 'src/app/(main)/ArchiveContinuousNavigation.test.tsx' 'src/lib/archive-analysis.test.ts' 'src/components/hooks/archive-analysis-scope.test.tsx' 'src/components/metrics/WeeklyTraffic.test.tsx' 'src/components/common/DataGrid.archive.test.tsx' 'src/components/input/WebsiteFilterButton.archive.test.tsx' 'src/app/(main)/websites/[websiteId]/ArchiveAnalysis.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsitePage.composed.test.tsx' 'src/app/(main)/websites/[websiteId]/compare/CompareTables.archive.test.tsx' 'src/app/(main)/websites/[websiteId]/WebsiteExpandedView.archive.test.tsx' --maxWorkers=1 \
    && pnpm build:docker

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS standalone
LABEL org.opencontainers.image.title="ArtVenn private Umami standalone artifact" \
    org.opencontainers.image.version="3.4.0" \
    org.opencontainers.image.source="https://github.com/umami-software/umami" \
    org.opencontainers.image.revision="ec0ff50388c264ed8ce46f00967e92f7e71476ae" \
    com.artvenn.umami.patch-sha256="fcb4463a3a67860e710a6b7c94fffdca29813bb5a324ee45a9578f0dd7fbbcdd" \
    com.artvenn.umami.pg-tls-host-sha256="ad0a70c6fc8820bb613a8437c634b6a0a6a04cc3cc36175ab72590d2733c24e6" \
    com.artvenn.umami.locale="zh-CN" \
    com.artvenn.umami.geography="cn-province-map-v2" \
    com.artvenn.umami.china-map-sha256="99adfeded5223848bbe37a0a12f8023e11ee12161c7800521c27db42fdeac275" \
    com.artvenn.umami.geo-sha256="fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029" \
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
COPY --from=standalone-builder --chown=node:node /app/geo ./geo
USER node
CMD ["node", "server.js"]
