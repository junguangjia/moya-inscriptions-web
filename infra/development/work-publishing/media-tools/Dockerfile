# Media sandbox image for work publishing and the unified media pipeline
# (Development and Production). One container per processing job runs the
# release's own compiled renderer (mounted read-only at /opt/renderer/app/dist)
# with pinned Node and sharp, and HEIC/HEIF still decoding (libheif + libde265)
# and motion probing/transcoding (FFmpeg) as local tools. The worker runs it
# without network, with a read-only root and the flags documented in
# ../README.md. The image itself holds no application code and no secret.

# Pinned Node runtime: only its `node` binary is copied into the final image.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
FROM ${NODE_IMAGE} AS renderer-runtime
WORKDIR /opt/renderer
# sharp 0.35.4 and its prebuilt libvips for the build platform (linux x64 or
# arm64). The lockfile integrity values equal the workspace pnpm-lock.yaml; npm
# verifies them whatever registry serves the tarballs. No install scripts run.
COPY runtime/package.json runtime/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="${NPM_REGISTRY}" \
  && node -e "const s=require('/opt/renderer/node_modules/sharp');if(s.versions.sharp!=='0.35.4')process.exit(1)"

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

# The tools and their decoding libraries are pinned to exact Debian trixie
# versions. When Debian supersedes one (for example a security update), the
# build fails instead of silently changing the toolchain: update the pins on
# purpose and re-run the checks in ../README.md. Other transitive packages
# follow the mirror at build time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg=7:7.1.5-0+deb13u1 \
    libavcodec61=7:7.1.5-0+deb13u1 \
    libavfilter10=7:7.1.5-0+deb13u1 \
    libavformat61=7:7.1.5-0+deb13u1 \
    libde265-0=1.0.15-1+deb13u2 \
    libheif-examples=1.19.8-1+deb13u1 \
    libheif-plugin-dav1d=1.19.8-1+deb13u1 \
    libheif-plugin-libde265=1.19.8-1+deb13u1 \
    libheif1=1.19.8-1+deb13u1 \
    libx264-164=2:0.164.3108+git31e19f9-2+b1 \
    libzimg2=3.0.5+ds1-1+b2 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 media \
  && useradd --system --uid 10001 --gid 10001 --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin media

# The renderer runtime: `node` at the path the worker invokes, and the flat
# `node_modules` the mounted ESM `dist` resolves `sharp` from (its
# package.json declares "type": "module").
COPY --from=renderer-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=renderer-runtime /opt/renderer /opt/renderer

USER 10001:10001
WORKDIR /tmp
# No default program: every run names /usr/bin/timeout and the renderer.
ENTRYPOINT ["/bin/false"]
