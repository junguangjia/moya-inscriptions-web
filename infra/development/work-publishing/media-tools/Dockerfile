# Development-only media tools for work publishing: HEIC/HEIF still decoding
# (libheif + libde265) and motion probing/transcoding (FFmpeg). The Backend
# runs one tool per container under coreutils `timeout` with the sandbox flags
# documented in ../README.md. Not a Production image.
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

USER 10001:10001
WORKDIR /tmp
# No default tool: every invocation names /usr/bin/timeout and the tool.
ENTRYPOINT ["/bin/false"]
