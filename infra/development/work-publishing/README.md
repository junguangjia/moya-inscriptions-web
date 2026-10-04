# Work publishing — media sandbox image

This directory provides the locally built media sandbox image that processes
work publishing media and published Catalog images
(`docs/community/work-publishing-v1.md`,
`docs/development/unified-media-pipeline-v1.md`). It is built on the machine
that runs it (Development, and the Production host from the same pinned inputs);
it is never pushed to a registry or distributed.

Every untrusted byte is parsed and decoded inside one no-network container per
job: container and metadata parsing, Live Photo pairing, HEIC/HEIF decoding
(`heif-dec`), motion probing and transcoding (FFmpeg), and still rendering with
`sharp`. The renderer program is the release's own compiled
`services/backend-production/dist`, mounted read-only; the image carries the
pinned runtime only (Node 24.21.0, sharp 0.35.4 with its prebuilt libvips, and
the tools). No process outside the sandbox loads `sharp` or decodes an upload.

## App-role bootstrap (Development)

After applying the committed community migration set as the migration/setup
role, apply `grant-runtime.sql` explicitly with psql:

```sh
psql --no-psqlrc --set ON_ERROR_STOP=1 --single-transaction --set app_role=yoyi_dev_app \
  --file infra/development/work-publishing/grant-runtime.sql
```

`--single-transaction` matters: the script revokes table-level privileges before
it grants the column lists, so a failure between those steps would otherwise
leave the role with fewer privileges than before. With one transaction the
script either completes or leaves the effective privileges exactly as they were
(`ON_ERROR_STOP` alone only stops; it does not roll back). The Node adapter path
used by the tests sends the whole file as one multi-statement query, which
PostgreSQL runs as one implicit transaction with the same guarantee.

Use protected libpq configuration for the already verified Development database;
do not put passwords or connection strings in command arguments or evidence.
Verify the database/container identity before this write. The role must already
exist as a non-owner login with NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and
NOCREATEROLE. Do not transfer schema/table ownership. The script requires the
published Catalog projections and the complete Phase 4/publishing migration set.
It grants only the runtime statements' relations and UPDATE columns, including
snapshot conflict resolution, with no DDL or audit/ledger mutation privileges.
Applying the same script again is idempotent. It does not create credentials. It
converges an earlier, broader grant path: a role that first received
`grant-community-app.sql` (table-level `UPDATE` on `sessions`, both comment
tables and `publication_setting`) keeps those privileges under GRANT alone, so
the script revokes exactly the table-level privileges it grants at column level
and then grants the columns again in the same run (PostgreSQL drops column
entries together with the table-level one). Nothing else is revoked; residue
beyond that set on a retained role is listed for an Owner decision, never
removed blindly. `pnpm dev:migrate` applies this script after the bootstrap.

For this publishing environment, this is the complete task-scoped runtime grant
path; the older `infra/development/grant-community-app.sql` covers the initial
comment/session domain only and is insufficient for Phase 4/publishing. Backend
startup never applies either script. Payload authentication remains separate:
the authenticated Admin bridge calls Backend, whose App SQL role also serves the
processing worker (in the Backend in Development by default, or the separate
media worker). CMS and public Catalog read roles gain no community grant.

`tests/integration/postgres/work-publishing-app-role.test.ts` exercises clean
installation, a Phase 4 upgrade and an upgrade of the SAME role from the Mission
2A/2B grant set (it must end with exactly the privilege set of a fresh role)
with an independently connected non-owner App login, checks active
identity/flags and denied DDL/identity/audit/ledger writes, and executes draft
conflicts, submission, visibility, moderation, trash/restore and worker lease
operations. Privileged connections perform only isolated setup, migration and
exact-resource cleanup. The test first requires a marked loopback disposable
administration target; it never runs on `yoyi_dev`.

Existing retained acceptance grants and provenance are historical evidence. Do
not reset retained data, edit an applied migration or rewrite its SQL ledger to
match new code. If a forward schema update becomes necessary, preserve a
verified recoverable backup first and record the update separately.

## Build

```sh
pnpm dev:media-sandbox
# equivalent to:
docker build --tag yoyi-work-publishing-media-tools:v2 infra/development/work-publishing/media-tools
```

Rebuilding is idempotent (cached layers) and needed only when the pins below
change; renderer code changes need no image rebuild, only
`pnpm --filter @moya/backend-production build` (the sandbox runs that `dist`;
from source in Development, a `dist` older than its sources is refused with that
command in the log).

- Base:
  `debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132`
  (pinned digest).
- Packages, installed with `--no-install-recommends` and pinned to exact Debian
  trixie versions: `ffmpeg`, `libavcodec61`, `libavformat61` and `libavfilter10`
  `7:7.1.5-0+deb13u1`; `libx264-164` `2:0.164.3108+git31e19f9-2+b1`; `libzimg2`
  `3.0.5+ds1-1+b2` (zscale colour conversion); `libheif-examples` (`heif-dec`),
  `libheif1`, `libheif-plugin-dav1d` and `libheif-plugin-libde265`
  `1.19.8-1+deb13u1`; `libde265-0` `1.0.15-1+deb13u2`. The required dav1d
  decoder plugin is pinned to the same version as libheif so APT cannot select
  an incompatible newer plugin.
- Renderer runtime: `/usr/local/bin/node` copied from `node:24.21.0-trixie-slim`
  (pinned index digest in the `Dockerfile`), and `/opt/renderer/node_modules`
  from `runtime/package-lock.json` (`npm ci --omit=dev --ignore-scripts`): sharp
  0.35.4 with `@img/sharp-linux-x64` / `@img/sharp-linux-arm64` 0.35.4 and
  `@img/sharp-libvips-linux-*` 1.3.3. Every integrity value in that lockfile
  equals the workspace `pnpm-lock.yaml` (a unit test enforces it), and the
  worker refuses to start unless the container reports exactly sharp 0.35.4 and
  Node 24. `runtime/package.json` declares `"type": "module"`, so the mounted
  ESM `dist` loads. A registry mirror can be used with
  `--build-arg NPM_REGISTRY=<mirror>`; npm still verifies the lockfile
  integrity.
- Reproducibility: when Debian supersedes a pinned version (for example with a
  security update) the build fails rather than silently changing the toolchain.
  Update the pins deliberately and re-run the checks below. Other transitive
  packages follow the Debian mirror at build time, so a rebuild can still differ
  in those.
- User: non-root `media`, uid/gid `10001`, working directory `/tmp`. No default
  entrypoint (`/bin/false`); every run names `/usr/bin/timeout` and the renderer
  explicitly.

Check the built image (each prints versions only):

```sh
docker run --rm --network none --entrypoint ffmpeg yoyi-work-publishing-media-tools:v2 -hide_banner -version
docker run --rm --network none --entrypoint heif-dec yoyi-work-publishing-media-tools:v2 --list-decoders
docker run --rm --network none --entrypoint ffmpeg yoyi-work-publishing-media-tools:v2 -hide_banner -filters | grep -E ' (zscale|tonemap|setparams) '
docker run --rm --network none --entrypoint /usr/local/bin/node yoyi-work-publishing-media-tools:v2 -e "console.log(process.versions.node, require('/opt/renderer/node_modules/sharp').versions.sharp)"
```

The worker's own self-check runs the real renderer with the real flags and
compares the isolation facts with the expected values:

```sh
NODE_ENV=development WORK_MEDIA_STORE_DIR=... WORK_MEDIA_TOOLS_IMAGE=yoyi-work-publishing-media-tools:v2 \
  WORK_MEDIA_WORK_DIR=... node services/backend-production/dist/worker-main.js --sandbox-check
```

The same command with `--sandbox-bounds-check` instead runs the active bound
probes (acceptance; one short container each drives memory, processes, wall
clock, output disk and stdout to its bound) and prints a content-free report.
The embedded Development Backend does not run the self-check at startup; run it
on demand as above.

## Backend and media worker configuration (Development)

The Development Backend reads these keys when `NODE_ENV=development`.
`turbo.json` passes them through to the Development Backend. Values are local to
one machine, so none of them is set in `infra/env/local.env.example`; export
them in the shell (or a private, untracked env file) that starts the Development
Backend. Production configuration is in
`infra/production/env/backend.env.example` and `media-worker.env.example`.

| Key                             | Required           | Meaning                                                                                                          |
| ------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `WORK_MEDIA_STORE_DIR`          | with the two below | Private store for committed blobs (`blobs/aa/bb/<32hex>`) and upload staging (`staging/<uuid>.part`).            |
| `WORK_MEDIA_TOOLS_IMAGE`        | with the other two | The local media sandbox image with an explicit tag or digest, for example `yoyi-work-publishing-media-tools:v2`. |
| `WORK_MEDIA_WORK_DIR`           | with the other two | Private directory for sandbox jobs (`job-<32hex>/`); only each job's `in/` is mounted, read-only.                |
| `WORK_MEDIA_WORKER_CONCURRENCY` | no (default `1`)   | Publishing jobs one worker leases and runs at once, an integer from 1 to 4.                                      |
| `WORK_MEDIA_WORKER`             | no                 | `embedded` (Development default): the Backend hosts the processing worker. `external`: see below.                |

- All or nothing. With none of the first three keys set the Backend still
  starts: publishing uploads, item registration and media reads answer 503
  (`SERVICE_UNAVAILABLE`, content-free), no item is accepted, no worker runs and
  `WORK_MEDIA_WORKER_CONCURRENCY` is ignored. Setting only some of them, or an
  unusable value, fails startup before any database pool opens; the message
  names the key and never echoes its value.
- Directories (`WORK_MEDIA_STORE_DIR`, `WORK_MEDIA_WORK_DIR`): absolute,
  normalized paths without a trailing separator and without `,`, `"` or line
  breaks; they must already exist as real directories (not symlinks), be owned
  by the Backend user with owner-only permissions (no group or other bits, for
  example `0700`), and lie outside `/tmp`, `/private/tmp`, `/var/folders`,
  `/private/var/folders` and any Git working tree. The two must not contain each
  other, and neither may overlap `CMS_MEDIA_DIR` (Payload media). Create them
  once, for example:

  ```sh
  mkdir -p "$HOME/.local/share/yoyi-work-publishing/store" "$HOME/.local/share/yoyi-work-publishing/work"
  chmod 700 "$HOME/.local/share/yoyi-work-publishing/store" "$HOME/.local/share/yoyi-work-publishing/work"
  ```

- Image (`WORK_MEDIA_TOOLS_IMAGE`): `name[:tag][@sha256:digest]` with a tag or
  digest (or `sha256:<image id>`); it is never pulled (`--pull never`), so build
  it first (above). **This image is a Development prerequisite for every
  upload:** JPEG, PNG and WebP stills are no longer decoded in the Backend
  process. A missing image does not fail startup; processing jobs then fail with
  a content-free `media_tool_sandbox_unavailable` code, the Backend logs once
  which command builds the image, jobs are retried with backoff and finally mark
  the item failed so the author can remove it or reset a component. An image
  built from the earlier tools-only Dockerfile has no Node runtime and fails the
  same way: rebuild it.
- Worker: with `embedded` one in-process worker starts after the Backend
  listens, polls the PostgreSQL job queue every second with a five-minute
  renewed lease, and on shutdown waits up to 30 s for running jobs before giving
  their leases back. Each processing job runs in one sandbox container, so at
  most this many containers run at once.
- `WORK_MEDIA_WORKER=external` (optional in Development, required in
  Production): the Backend opens only `WORK_MEDIA_STORE_DIR` (the sandbox keys
  are not read) and claims only session expiry and staging sweeps; run the media
  worker separately with the same keys plus the database keys:
  `pnpm --filter @moya/backend-production dev:worker`. Uploads are accepted
  while the worker is down; items stay `processing` until it runs.
- Catalog: with `CMS_MEDIA_DIR` set, the worker also renders published Catalog
  images (`thumb`, `cover`, `display` and, when larger than `display`, `viewer`)
  from the local Payload media files into the same store, syncing the published
  list every five minutes. Pilot `display/v1/` keys have no local file and are
  marked unreadable.
- Uploads and the Backend share one in-process transfer registry. A no-save
  session whose lease lapsed is not expired while one of its component uploads
  began within the last session lease period (`unsaved_session_lease_minutes`,
  Admin setting). When the Backend expires it, any upload for its components
  still open in this Backend process (one that began before that period) is
  stopped, and a commit presented afterwards, from any process, is refused by
  the attempt fence.
- Edits of media carried over from earlier PNG works (legacy user media) are
  derived by the worker too: it reads the PNG (at most 4 MiB, signature checked)
  into the job input and the sandbox renders the requested renditions. It never
  writes user media, and those PNGs never enter the publishing store as sources.

## How the worker runs the sandbox

The coordinator
(`services/backend-production/src/publishing/sandbox/sandbox-runner.ts`) spawns
`docker` directly with an argument array (never a shell), one container per job:

```text
docker run --rm --pull never --log-driver none --name yoyi-wp-media-<24hex>
  --network none --read-only
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m
  --tmpfs /job/work:rw,nosuid,nodev,noexec,size=768m,uid=10001,gid=10001,mode=0700
  --tmpfs /job/out:rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700
  --memory 1536m --memory-swap 1536m --cpus 1 --pids-limit 256
  --ulimit nofile=1024:1024 --ulimit core=0 --oom-score-adj 1000
  --security-opt no-new-privileges --cap-drop ALL --user 10001:10001
  --env TMPDIR=/tmp --env VIPS_BLOCK_UNTRUSTED=1 --env MALLOC_ARENA_MAX=2 --env UV_THREADPOOL_SIZE=2
  --mount type=bind,source=<work>/job-<32hex>/in,target=/job/in,readonly
  --mount type=bind,source=<release>/services/backend-production/dist,target=/opt/renderer/app/dist,readonly
  --workdir /tmp --entrypoint /usr/bin/timeout <WORK_MEDIA_TOOLS_IMAGE>
  --signal=KILL <limit + 10 s> /usr/local/bin/node --max-old-space-size=384
  --disallow-code-generation-from-strings /opt/renderer/app/dist/publishing/sandbox/renderer-main.js
```

- `--pull never`: a missing image fails instead of reaching the network.
  `--log-driver none`: no image byte is copied into the daemon's logs.
- No writable host path: the job input `in/` (`0755`, files `0644`) is written
  only by the coordinator (the verified components and `job.json`) and mounted
  read-only; scratch and outputs are size-capped tmpfs mounts owned by the
  sandbox user, so a full disk is an `ENOSPC` inside the container, never on the
  host. No host environment value enters the container; the Docker CLI itself
  gets only `PATH`, `HOME`, `DOCKER_*` and `XDG_RUNTIME_DIR`.
- Outputs travel as a framed stdout stream: one manifest line (≤ 256 KiB,
  strictly validated, carrying the job's random nonce and the runtime versions),
  then per output a header line and exactly its bytes (each ≤ 128 MiB, ≤ 256 MiB
  and ≤ 32 files in total, SHA-256 verified), then an end frame. The coordinator
  writes each frame to the job's private `out/` (exclusive create, no links,
  `0600`), recomputes every expected rendition size with the recipe registry
  (`recipes.ts`) and requires equality, probes the WebP and MP4 headers (no
  metadata chunks, exact canvas) and only then writes the outputs to the store.
  Any violation kills the container and rejects the item as `processing_failed`
  (logged as `sandbox_protocol_violation`).
- Inside the container the renderer allows only the JPEG, PNG and WebP file
  loaders of libvips (`sharp.block`), decodes one page, refuses more than 120 MP
  or 512 MiB decoded before any pixel decode (`dimensions_exceeded`), renders
  one rendition at a time without an operation cache, and runs `heif-dec`,
  `ffprobe` and `ffmpeg` as direct child processes with an empty environment and
  their own deadlines (60 s, 20 s, 180 s) and output caps.
- Before a container starts, the coordinator refuses a job whose staged input
  (the components it processes; a Live item's still and motion together) exceeds
  512 MiB, as `dimensions_exceeded`. That bound is below the per-item upload
  limits the Admin settings allow (up to 8 GiB). With the default limits (128
  MiB per Original item, 256 MiB per Standard component) every item fits;
  raising them so that an item exceeds 512 MiB in total makes its upload fail
  processing as `dimensions_exceeded`, so keep the defaults.
- Timeout, cancellation, lease loss and shutdown run `docker kill <name>`,
  SIGKILL the CLI after a grace period and run `docker rm --force <name>` twice
  (at once and after the grace). The container wall clock is 300 s for stills
  and 600 s for Live items; `timeout --signal=KILL` ends it 10 s later even if
  the coordinator lost track of it. An OOM kill or other signal exit rejects the
  item (`processing_failed`, logged as `sandbox_resource_exceeded`); a missing
  image or daemon and a renderer that fails to start are retried.
- At start the media worker runs a self-check container with the same arguments:
  exact sharp and Node versions, uid/gid 10001, no capabilities, no new
  privileges, seccomp, only the loopback interface and no route, read-only root,
  application and input, writable tmpfs mounts, the environment allowlist, the
  cgroup memory, swap, PID and CPU limits, `oom_score_adj`, core and file limits
  and the loader allowlist. Any difference exits 78; an unreachable daemon or
  missing image exits 75. It also removes leftover `yoyi-wp-media-*` containers
  and job directories older than an hour.

Tool invocations inside the sandbox:

- `heif-dec --quiet /job/in/still /job/work/still.png`: primary image only, with
  `irot`/`imir`/`clap` applied by libheif. HEIF files with image-sequence brands
  (`msf1`, `hevc`, …) or a `moov` box are rejected before decoding, and so are
  APNGs (`acTL` before `IDAT`).
- `ffprobe -v error -f mov -show_streams -show_format -of json <motion>` is
  accepted only when all of these hold:
  - exactly one video stream, at most one audio stream and at most 8 data (timed
    metadata) streams;
  - duration ≤ 30 s and each dimension ≤ 8192;
  - colour tags on the allowlist (see `MOTION_COLOR` in `profiles.ts`).
- `ffmpeg -nostdin -n -f mov -i <motion> -map 0:v:0 -map 0:a:0? -map_metadata -1 -map_chapters -1 -dn -sn -vf <setparams,rotation,crop,scale,colour> -c:v libx264 -profile:v high -preset veryfast -crf 21 -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv -c:a aac -b:a 128k -movflags +faststart -f mp4 /job/out/motion.mp4`
  - Autorotation stays enabled and the edit is baked into pixels, so every
    browser shows the same orientation. The long edge is ≤ 1920.
  - Crops use the same whole-pixel rounding as still renditions.
  - Colour: untagged or BT.709 8-bit sources pass through. Other SDR colour
    spaces are converted with `zscale`. HLG and PQ sources are tone-mapped to
    SDR (`zscale` linearize at 100 nits, `tonemap=hable`, BT.709).
  - The output is re-probed and must be H.264 `yuv420p` tagged BT.709 limited
    range, upright, with AAC audio when the source had audio, and within 100 ms
    of the source duration.
  - Renditions never claim HDR; originals keep theirs.
- Stills: every rendition is re-encoded with its recipe (`recipes.ts`): source
  orientation, edit rotation, crop (and the cover crop for `thumb`/`cover`),
  resize without upscaling, conversion to untagged sRGB honouring the embedded
  ICC profile, every metadata chunk stripped, alpha kept, WebP.

## Licenses

- FFmpeg: the Debian package is built with `--enable-gpl` (including libx264 and
  libx265), so this build is GPL-2.0-or-later.
- x264: GPL-2.0-or-later.
- zimg: WTFPL-2.
- libheif and libde265: LGPL-3.0-or-later (libheif example programs such as
  `heif-dec` are MIT).
- Node.js: MIT (with the bundled third-party licenses of the official binary).
- sharp: Apache-2.0; the prebuilt `@img/sharp-libvips-*` binaries:
  LGPL-3.0-or-later (libvips and its bundled libraries; see the package's
  `THIRD-PARTY-NOTICES`).
- Debian base image: the licenses of the respective Debian packages
  (`/usr/share/doc/*/copyright` inside the image).

The image is built and used locally on the machine that runs it and is not
distributed. H.264/HEVC patent licensing is not assessed for any other use.
