# Unified media pipeline — unified-media-pipeline-v1

Task `unified-media-pipeline-v1`, Issue #206. Authority: Owner instruction:
unified media pipeline, 2026-10-04 (private; cited by name only). Governance
record:
[2026-10-04 unified media pipeline amendment](../governance/amendments/2026-10-04-unified-media-pipeline.md).
The Issue holds the frozen scope and Behavior Matrix; this document is the
public-safe design. Increment 1 is described in detail. Increments 2–4 are fixed
here at the semantic level and receive their details by revision before each
starts.

This document names no bucket, account, host, server instance, hostname or
private path. Those values live in protected runtime configuration and private
operations records.

## Owner decisions and sequencing

Recorded in the amendment (section 3) and Issue #206, 2026-10-04: the Owner
decisions in revision r2, the delivery provider and the database sequencing in
r3, and the acceptance of the prepared media hostname with its non-public
sequence in r4.

- **Public resolution.** Long scrolls keep today's short-edge-aware bounds
  (`full` at most 16,000 px on the long edge and 40 MP; `display` at most 1,280
  px on the short edge and 20 MP) as both the existing-work limit and the
  new-work default; every other image uses 8,192 px on the long edge. Public
  `full` is exposed in detail contexts within these bounds (from PR 1b), and the
  authorized relay applies the same rule.
- **Browser URL boundary.** Constitution §19 and ADR 0003 are modernized as
  amendment entries 10 and 11, in effect: the browser receives only
  Backend-issued URLs and never credentials, keys or bucket choices.
- **Cloud identity.** Increments 2 and 3 add exactly two keyless roles,
  assumable only by the existing publishing identity; no new long-lived keys.
- **Retention.** Only deletions caused by this task are held; users' own
  deletion lifecycle is unchanged ([Retention hold](#retention-hold)).
- **Delivery provider.** Increment 2 delivers through the Owner's existing
  Tencent Cloud EdgeOne subscription instead of traditional CDN: one provider,
  purge through EdgeOne, no multi-provider layer.
- **Database sequencing.** A separate task moves Production to PostgreSQL 16 and
  owns that move and its rollback. Production media changes of this task
  (migrations, backfills, byte extraction, a write-capable worker,
  behaviour-changing deployments) wait for its recorded handoff, then a fresh
  verified backup of the authoritative database. Every migration of this task
  passes on PostgreSQL 16 (the minimum supported Production major) and 18.
- **Prepared media hostname (r4).** The Owner accepted the prepared hostname,
  which stays non-public: no public DNS record and no switch of application
  media reads until PR 1a's verification and independent review are complete,
  the PostgreSQL 16 task has handed off the Production database, and this task
  has verified the Production target, taken a fresh backup, applied the media
  migrations and passed publication and withdrawal acceptance through the edge
  without public DNS. Permissions are not widened beyond the approved set.

## Increments

Each increment is merged PRs, a Production deployment through the established
verified-release procedure (a verified database backup before any migration), a
real acceptance run and a recorded rollback point. Per the Owner decision
recorded in Issue #206 r6, each increment's deployment runs from an approved
annotated tag on the verified merged `main` commit (for example
`media-pipeline-inc1` to `media-pipeline-inc4`), followed by a GitHub Release;
the rollback point is the previous release together with the previous tag.

| Increment                       | Content                                                                                                                                                                                                           | User-visible                                                 | Switch and rollback                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1, PR 1a "pipeline"             | Rendition model and migration, recipes v1 plus `viewer`, sandbox renderer, separate media worker, Catalog processing, retention hold, governance record                                                           | No; Production Web output unchanged                          | Previous release plus the private rollback and roll-forward steps ([Operations notes](#operations-notes)) |
| 1, PR 1b "delivery"             | Additive rendition candidates and placeholder colour in the contracts, Backend builders, Web `srcset`/`sizes`/aspect/placeholder, progressive Viewer, Development Catalog candidates                              | Yes; Owner visual gate on a Development preview before Ready | Previous release; legacy `src` remains the fallback everywhere                                            |
| 2 "published delivery"          | Published copies of eligible renditions in a dedicated private published origin behind a new media hostname on the existing EdgeOne subscription; publication, withdrawal and EdgeOne purge lifecycle             | No; delivery URLs change, rendered pages do not              | Configuration switch back to the authorized read paths                                                    |
| 3 "uploads and profile imagery" | Direct browser-to-storage upload; avatar and background imagery moved into the pipeline                                                                                                                           | Yes; Owner visual and real-device gate                       | Configuration switch back to the upload relay; profile bytes in PostgreSQL retained                       |
| 4 "deep zoom and completion"    | IIIF Image API 3 Level 0 JPEG tiles in the existing Viewer, resolution-policy controls, backfill, before/after measurement, retirement of superseded paths and the old media hostname, retention follow-up record | Yes; Owner visual and real-device gate                       | Tiles are optional per asset; the bounded viewer image remains the fallback                               |

## Model: assets, renditions, references

The model evolves the existing community publishing tables; it is not a generic
asset-management product.

- **Assets.**
  - Work and Article media keep `community.media_items` with their components
    and blobs (ownership, provenance, submitted-file identity, dimensions,
    processing state). Items gain `placeholder_color` (`#rrggbb` or null).
  - Catalog images get `community.catalog_media_assets`: one row per published
    `(media id, source object key)` identity, with a deterministic id
    (`catalog-asset-<32 hex>`). The row holds source facts, the oriented master
    dimensions and SHA-256 filled in by the worker after decoding, the
    placeholder colour, a state (`pending`, `ready`, `failed`), a content-free
    failure code and `unreferenced_since`. Only the two existing approved
    Catalog key formats are accepted.
- **Renditions.** `community.media_renditions` replaces
  `community.media_derivatives` for every reader and writer.
  - Exactly one subject per row: a media item or a Catalog asset.
  - Identity: subject, edit key (`base` or 32 hex; Catalog is always `base`),
    role, recipe version and recipe digest.
  - Location: one `media_blobs` row. Facts: actual width and height, duration,
    content type.
  - State: `ready`, `superseded` or `released`. At most one `ready` rendition
    per subject, edit key and role. A newer recipe version replaces the slot's
    `ready` row: a replaced rendition whose bytes predate the migration stays
    `superseded` with its blob held; one this task created becomes `released`
    (keeping its `superseded_at`) for the normal purge.
  - The migration adopts every existing derivative row as a version-1 rendition
    without re-rendering (the outputs are byte-identical to recipe v1) and
    aborts on any count mismatch. `media_derivatives` stays unchanged and is no
    longer read or written; it is retained until the retention follow-up.
- **Blobs.** `community.media_blobs` gains the purpose `catalog_derivative` with
  no owner. Such blobs are recorded, so store reconciliation keeps them, and
  they never count toward any account's capacity. The new `retention_hold`
  column marks pre-existing blobs that this task must not physically delete yet
  (see [Retention hold](#retention-hold)). Every other derivative, including the
  new `viewer`, counts toward its owner's stored usage as derivatives do today,
  so a new upload uses somewhat more of the owner's quota than before.
- **References** stay where they are: `media_item_refs` holders (drafts,
  revisions, snapshots, sessions, Article drafts and revisions),
  `work_revision_items`, the published Catalog projection, and profile pointers
  (increment 3 adds profile holders). A rendition stays `ready` while any holder
  needs it; removing one holder never releases what another needs. Hash equality
  grants nothing: there is no cross-owner lookup by hash, and storage keys stay
  random per write.
- **Readiness and edits.** Readiness keeps today's required roles (`thumb`,
  `display`, `full`; `cover` where required; `motion` for Live items). `viewer`
  is optional and never blocks readiness or submission. Edit-key semantics are
  unchanged.
- **Jobs.** The job kinds gain `catalog_render`. One TypeScript list is the
  source; an integration test keeps the database `CHECK` equal to it.

## Recipes

One pure, sharp-free registry,
`services/backend-production/src/publishing/processing/recipes.ts`, is imported
by both the coordinator and the sandbox renderer, so there is exactly one
geometry implementation and one copy of the parameters. Each recipe is
`{role, version, digest}`; the digest is the first 16 hex characters of the
SHA-256 of the canonical JSON of its parameters. A unit test pins every
version-1 digest, so a parameter change without a new version fails CI, and pins
the digests the migration writes for adopted rows to the registry. The community
store records the identity the processor names and only checks its form; it
never defaults or computes one.

| Role@version     | Framing                                                   | Geometry (never upscaled)                                                                                                                                                                                                           | WebP quality | Planned for                    |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------ |
| `thumb@1`        | Card (the author's cover crop where it applies)           | Long edge ≤ 480                                                                                                                                                                                                                     | 80           | Work items, Catalog            |
| `cover@1`        | Card for work items; complete for Catalog (no cover crop) | Long edge ≤ 1080                                                                                                                                                                                                                    | 86           | Work items, Catalog            |
| `display@1`      | Complete                                                  | Long edge ≤ 2048; long scroll: short edge ≤ 1280, long edge ≤ 16,000, ≤ 20 MP                                                                                                                                                       | 86           | Work items, Catalog            |
| `viewer@1` (new) | Complete                                                  | Long edge ≤ 4096 (≤ 4096 × 4096 pixels); long scroll: short edge ≤ 2048, long edge ≤ 16,000, ≤ 20 MP; never above `full`. Rendered only when it differs from `display` and, for a work item, is smaller than its `full` (see below) | 88           | Work items (optional), Catalog |
| `full@1`         | Complete                                                  | Long edge ≤ 8192; long scroll: long edge ≤ 16,000, ≤ 40 MP                                                                                                                                                                          | 90           | Work items only                |
| `motion@1`       | Complete                                                  | Unchanged motion profile (H.264, long edge ≤ 1920)                                                                                                                                                                                  | —            | Live items                     |

A long scroll is an image whose long edge exceeds 2.5 times its short edge.

The viewer is never a second copy of another rendition. It is not rendered when
its size equals `display`'s or would exceed `full`'s, and a work item gets none
when it would be as large as the item's `full`: any frame up to 4096 px on the
long edge, or a long scroll within the viewer's bounds. A Catalog asset has no
`full`, so its viewer exists whenever it differs from `display`. These rules
decide only whether a viewer exists, never its bytes: the job's plan (`work` for
an item edit, `catalog` for a Catalog asset) travels in the sandbox request, the
renderer and the coordinator evaluate the same registry function with it, and
the plan rule is not part of the `viewer@1` digest. Readiness, submission and
the Catalog sync never require a viewer.

Common still pipeline:

- EXIF orientation is applied once; then edit rotation, crop and (for card
  framing) cover crop; then resize.
- Explicit ICC-aware conversion to sRGB. Outputs carry no EXIF, XMP, IPTC, ICC
  or other chunks; alpha is preserved for PNG and WebP sources.
- No source passthrough for any role: every published byte is re-encoded.
- Placeholder colour: the mean colour of the base-edit `thumb`, computed inside
  the sandbox; `null` when any pixel is not opaque.

Not in increment 1: card-box `thumb@2`/`cover@2` (revisited with measurement in
increment 4), profile roles `avatar-128`, `avatar-512`, `background-960` and
`background-1600` (increment 3), and tiles (increment 4). A changed
transformation always gets a new version; from increment 2 a new version also
gets a new published path and never overwrites a published representation.

## Worker and sandbox

### Processes and job ownership

The media worker is a second entrypoint of `@moya/backend-production` (no new
workspace), compiled from `src/worker-main.ts` and composed by
`src/worker-composition.ts`. It runs from the same release as the Backend.

`WORK_MEDIA_WORKER` selects the composition:

- `external` (required in Production; `embedded` is refused there): the Backend
  opens only the publishing store, never constructs a container runner and never
  loads sharp. It claims only the two upload-coupled job kinds, `expire_session`
  and `sweep_staging`, enqueues the staging sweep, and runs the shared queue
  maintenance (lease requeue and cleanup scheduling, which schedules session
  expiry), so session expiry does not depend on the worker. These kinds stay
  with the Backend because uploads still stream through it and its in-process
  transfer registry protects live uploads. Running the shared maintenance in
  both processes is intended and safe: each step locks its rows (skipping busy
  ones) and at most one active job exists per subject. The worker claims every
  other kind and also runs reconciliation and the Catalog sync.
- `embedded` (Development default): the Backend hosts the coordinator loop as
  before, using the same sandbox runner. sharp never runs in-process in any
  mode.

Uploads are accepted while the worker is down; items stay `processing` until it
returns. Store reconciliation runs in the worker and still requires an
unrecorded object to be older than its grace before deletion.

In Production the worker runs as its own operating-system user, which alone owns
the rootless container daemon and the job workspace. A shared user would not be
a boundary (a same-user process can reach another process's mount namespace
through `/proc`), so the request-serving Backend can neither reach the daemon
nor touch staged inputs and outputs.

### Coordinator and sandbox

- **Coordinator (worker process).** Reads inputs from storage, verifies SHA-256,
  stages inputs, writes the job request, runs the sandbox, validates its output
  stream, writes renditions to storage and commits the database transaction. It
  never imports sharp. It recomputes the expected output dimensions with
  `recipes.ts` and requires exact equality, which enforces "never upscale and
  never above policy".
- **Sandbox.** One container per job runs all untrusted byte handling: container
  and metadata parsing, Live Photo pairing, HEIF decoding, probing and motion
  conversion, sharp inspection and rendering, and the placeholder colour. The
  request carries `{role, version, digest, edit, coverCrop?}` per rendition; the
  renderer looks the recipe up in the mounted registry and refuses a digest
  mismatch.
- **Image.** The existing pinned media-tools image (under
  `infra/development/work-publishing/media-tools/`) extended with pinned Node
  24.21.0 and sharp 0.35.4 under `/opt/renderer`. The versions equal the
  workspace lockfile, which a test enforces; no dependency changes. The
  release's compiled `dist` is mounted read-only, so the renderer always matches
  the coordinator that launched it.
- **Transport.** Outputs are written to a size-capped tmpfs inside the container
  and streamed to the coordinator over stdout: a manifest line first, then
  hashed file frames, bound to the run by a nonce. No host path is writable by
  the container, and the container log driver is disabled so image bytes never
  reach daemon logs.

### Bounds

| Bound                  | Value                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent jobs        | 1 (`WORK_MEDIA_WORKER_CONCURRENCY`, parser range 1–4)                                                                                                                                                                                        |
| Container              | No network, read-only root, all capabilities dropped, no new privileges, uid/gid 10001                                                                                                                                                       |
| CPU, memory, processes | 1 CPU; 1536 MiB with no swap; 256 PIDs; 1024 open files; no core dumps; preferred OOM victim                                                                                                                                                 |
| Temporary disk         | tmpfs: `/tmp` 64 MiB, work area 768 MiB, output 256 MiB                                                                                                                                                                                      |
| Input                  | ≤ 512 MiB of staged input per job (below the operator-configurable upload maximum; see the note under this table)                                                                                                                            |
| Decoded image          | ≤ 120 MP and ≤ 512 MiB decoded bytes, checked before any pixel decode; first page only; animations refused. HEIF: checked on the decoded primary image; until a header check lands, its decode is bounded by the memory and work-area limits |
| Loaders                | sharp limited to JPEG, PNG and WebP loaders; HEIF through the pinned HEIF decoder; motion through FFmpeg                                                                                                                                     |
| Rendering              | sharp cache off, one thread, renditions rendered sequentially with a per-rendition timeout of 120 s                                                                                                                                          |
| Wall clock             | Static 300 s, Live 600 s, self-check 30 s; existing per-tool deadlines unchanged                                                                                                                                                             |
| Output                 | Manifest ≤ 256 KiB; ≤ 32 files; ≤ 128 MiB per file; ≤ 256 MiB in total; stderr ≤ 64 KiB                                                                                                                                                      |
| Coordinator process    | Service memory ≤ 512 MiB, ≤ 64 tasks                                                                                                                                                                                                         |

Refusals are precise and content-free, using the existing media failure codes
(for example `dimensions_exceeded`, `decode_failed`, `unsupported_type`).

The staged-input bound is lower than what the operator settings allow. The
per-item upload limits (Original item, Standard component) can be raised up to 8
GiB, while one sandbox job stages at most 512 MiB: the components it processes
(a Live item's still and motion together) or the legacy still. With the default
limits (128 MiB per Original item, 256 MiB per Standard component) every item
fits. An item whose staged components exceed 512 MiB after the limits are raised
is accepted as an upload but fails processing as `dimensions_exceeded`. Keep the
default upload limits, or any setting under which an item stays at or below 512
MiB in total, while this bound holds; the contracts and the settings bounds are
unchanged.

The coordinator validates every output before upload: each still is re-checked
against the recipe's exact size and parsed header-only (one image chunk, no
EXIF, XMP or ICC chunk). Motion is produced by a fixed FFmpeg argument list that
drops source metadata, and the coordinator checks its container header and
recorded bounds only; a box-level metadata check of motion is a recorded
follow-up for the increment-4 format validation.

### Lifecycle

- **Abort.** Cancellation, lease loss, shutdown and timeout kill the container;
  an abort that lands before the container starts prevents the start. Work that
  finishes after an abort is discarded.
- **Restart recovery.** Lease expiry and requeue are unchanged. At start the
  worker removes orphaned sandbox containers by their name prefix and sweeps
  stale job directories, then repeats the sweep hourly. Replayed jobs produce
  identical outputs, and recording de-duplicates them.
- **Self-check.** Every worker start runs a self-check container built by the
  same argument builder: runtime versions and the effective isolation facts
  (identity, no network, read-only mounts, environment allowlist, cgroup limits,
  loader allowlist, tmpfs sizes). A mismatch exits with status 78 and is not
  restarted; an unreachable container daemon exits with 75 and is retried. The
  Development embedded mode skips this startup check (Development hosts may lack
  the full isolation facts); the worker entry runs it on demand there too.
- **Bound probes.** `worker-main.js --sandbox-bounds-check` (acceptance only,
  worker stopped) runs five probe containers through the same argument builder:
  memory (must end in a kill), processes (must meet the task limit), wall clock
  (must be stopped at the deadline), output disk (must fill at the tmpfs size)
  and stdout (must be stopped at the manifest cap), then checks that no sandbox
  container remains. It prints a content-free report and exits 0 only when every
  bound held.
- **Supervision.** `infra/production/systemd/yoyi-media-worker.service` is a
  public-safe template: its own user, `MemoryMax=512M`, `TasksMax=64`,
  `RestartPreventExitStatus=78`, no start-rate limit (status 75 is retried every
  30 s until the daemon or image returns), and `Requires=`/`After=` on
  placeholder names for the host's rootless container-daemon readiness gate and
  metadata guard, so an uncustomized copy never starts. Host-local units and
  drop-ins, not kept in this repository, provide those and give the worker, and
  only it, the daemon socket.

## Catalog processing

- **Discovery.** Worker maintenance runs a bounded Catalog sync every 5 minutes.
  It reads the published Catalog media projection read-only through the Catalog
  read connection, upserts `catalog_media_assets`, sets or clears
  `unreferenced_since`, and enqueues `catalog_render` for assets that lack a
  current-version `ready` rendition, on a committed blob, of a role every asset
  receives (`thumb`, `cover`, `display`). A render always plans `viewer` too
  (skipped only where it would equal `display`: the Catalog plan has no `full`),
  so it also restores a missing `viewer`; a future `viewer` recipe version needs
  its own re-render rule, because the store cannot evaluate the skip geometry.
  The worker therefore uses both the Catalog read connection and the Community
  App-role connection.
- **`catalog_render`.** The coordinator reads the source with the existing
  Catalog read identity over the storage service's internal endpoint (never the
  public media hostname), checks the size bound and, when known, the SHA-256,
  and runs the sandbox with the Catalog plan: `thumb`, `cover` (complete
  framing), `display` and `viewer`; no `full` in increment 1. Each output is
  written to the publishing store's `blobs/` namespace as a `catalog_derivative`
  blob, and the renditions and asset facts are recorded in one transaction.
- **Unreadable sources.** A source the read identity cannot reach (missing or
  forbidden) is retried within the job's bounded attempts; after the last one
  the asset is marked `failed` with the content-free code `source_unreadable`,
  and the sync renders it again a day later, so a read permission granted later
  or a transient signing error heals without manual steps. Every other failure
  (for example a hash mismatch or an undecodable source) is a fact of the
  hash-pinned source bytes and stays final. Development reads sources from the
  local store.
- **Rejected re-renders.** A `ready` asset is rendered again for a new recipe
  version or a lost rendition. When that render is rejected (or its attempts are
  used up), the asset keeps its state and its ready renditions, and the
  rejection is recorded as the failure of its render job (content-free code and
  time). The sync enqueues nothing for the asset while that failed job is
  younger than a day, then queues the same job again with fresh attempts, within
  the per-pass bound. An abandoned job, and the failed job of a `pending` asset,
  still wait for the operator.
- **Sources are never touched.** The pipeline never writes, renames or deletes
  Catalog source objects or Admin media.
- **Read side (PR 1b).** A `security_barrier` view exposes delivery facts of
  published Catalog renditions to the public read role (amendment entry 8);
  Catalog readers join it and the Backend URL resolver resolves the delivery
  keys. In Production, Catalog rendition delivery stays off during increment 1:
  the only identity able to sign these renditions is the work-media storage
  identity, whose key identifier would then appear in public URLs. Catalog
  responses keep the legacy `src` until increment 2 serves the renditions
  through published delivery. Development serves Catalog candidates through the
  Development resolver so the complete design can be inspected. See
  [Delivery (PR 1b)](#delivery-pr-1b).

## Delivery (PR 1b)

- **Rendition lists.** Public media objects carry an optional `renditions` list
  of `{ src, width, height, contentType }` candidates of one framing, ascending
  by size, and an optional `placeholderColor`. The list depends on the context
  of the field, never on a role name:
  - Card contexts (Catalog list, search and content cards, Article and
    Collection summaries, a work's `coverRenditions`) list the candidates up to
    the display-level anchor: `thumb`, `cover`, `display`.
  - Detail contexts (the Catalog detail gallery, an Article page, `WorkMedia`)
    add the zoom levels `viewer` and, within the bound below, `full`.
  - The parent `src`, `width` and `height` are the anchor whenever a list is
    present. A Catalog image falls back to its approved object without a list
    when one of its candidates does not resolve or the list breaks a contract
    rule, with one content-free log line; an empty resolution means delivery is
    off and is not logged. A work item whose list breaks a contract rule around
    a present anchor keeps its `src` without a list, also with one content-free
    log line. A failed resolution batch still fails the read as before.
    `placeholderColor` is the loading colour of an opaque image and is emitted
    whenever its asset is ready, whatever the delivery.
- **Public resolution bound (D3).** Anyone but the owner receives a `full`
  rendition only with a long edge of at most 8,192 px, or, for a long scroll
  (long edge more than 2.5 times the short edge), at most 16,000 px and 40 MP:
  today's `full@1` long-scroll geometry. The bound applies to the scaled frame,
  whose sides the recipe rounds to the nearest pixel, so the long-scroll aspect
  and the pixel cap allow half a pixel per side (a 2504 × 15993 frame renders
  2503 × 15984, 40,007,952 px). The DTO builders and the authorized relay apply
  one predicate, so every listed candidate is also readable through the relay by
  that reader; owners keep their own full-resolution reads.
- **Catalog delivery view.** Community migration `20261004020000` creates
  `community.catalog_media_delivery`, a `security_barrier` view with one row per
  ready rendition, on a committed blob, of a ready Catalog asset that the
  published projection named at the media worker's last Catalog sync (every five
  minutes while the worker runs), within the bound above. Readers join it to the
  published projection itself, so a withdrawn image leaves their answers at
  once. The registry view may retain it until the next sync; the Development
  byte route also checks the current published projection before serving it.
  Later consumers must keep that check rather than authorize by delivery key
  alone. Its delivery key is the opaque rendition id, never a storage key; its
  level is `card`, `display` or `zoom`. The post-Community grant phase
  [`infra/development/catalog-media/grant-public-read.sql`](../../infra/development/catalog-media/grant-public-read.sql)
  gives the public read role `SELECT` on this view only; the App role gets the
  same view in `grant-runtime.sql` for discovery cards. Catalog readers on the
  public read connection join the view in every runtime except the Pilot;
  discovery cards join it through the App role in every runtime. The Backend
  refuses to start when either role cannot read the view.
- **Production.** Catalog rendition delivery stays off in increment 1: the
  Production resolver resolves no delivery key, so Catalog responses keep the
  approved image's signed `src` and gain only the placeholder colour. Increment
  2 resolves the keys to published URLs by configuration.
- **Development delivery.** The Development resolver names each rendition on the
  Backend's own loopback listener,
  `http://127.0.0.1:<port>/v1/development/catalog-renditions/<rendition id>`.
  That route exists only in synthetic Development with local storage and a
  publishing store, and the resolver names renditions only when it exists;
  without a publishing store Catalog media keep their approved `src`. The route
  serves exactly that `GET` target (no query), streams the committed blob of a
  rendition the view lists only while the Catalog read connection confirms the
  current published media id and object identity. It uses the recorded type
  (WebP in increment 1) and length, `private, no-store` and `nosniff`, and
  answers `404` otherwise. The Web rewrites those URLs to a same-origin
  Development relay, so LAN phones see the same candidates. `pnpm dev:migrate`
  applies the post-Community public read phase after the community migrations,
  as the setup role with `public_read_role=yoyi_dev_public`.

## Retention hold

Nothing that existed before this task — objects, database byte columns,
superseded derivatives — is deleted by this task until 14 days after its
replacement is accepted. That final deletion is a recorded follow-up outside
this task's delivery stop. Only deletions caused by this task are held; users'
own deletion lifecycle (trash retention, then purge of their own works and
items) works exactly as before, including for pre-existing media.

- When a newer recipe version replaces a rendition whose blob predates the
  migration (a recipe change or the increment-4 backfill), the recording keeps
  the replaced row `superseded` and sets `retention_hold = 'd7_pre_task'` on its
  blob in the same transaction. A replaced rendition that this task created is
  released and follows the normal purge.
- The garbage-collection purge never schedules or deletes a held blob, and held
  blobs stay recorded, so reconciliation never removes them. The follow-up lists
  and deletes them after the window. Held bytes keep counting toward their
  owner's stored usage until then, like every stored derivative.
- An author's own item purge deletes the item's blobs as before, held ones
  included (their hold is cleared). Releasing an edit rendition that no holder
  needs any more is part of that user lifecycle too.
- `community.media_derivatives` is kept unchanged until the follow-up; its rows
  name the same blobs as the adopted renditions. In increment 3 the profile
  bytes in `user_media` are relocated under the same rule.
- In increment 1 every recipe is version 1, so nothing is superseded yet.
- Automatic deletion otherwise covers only published copies, staging objects and
  regenerable derivatives that this task created.

## Configuration

Values live in protected runtime configuration. Templates under `infra/` carry
`REPLACE_ME_*` and `*.example.invalid` placeholders only.

| Key                                            | Read by                                       | Development                            | Production                                                             |
| ---------------------------------------------- | --------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `WORK_MEDIA_WORKER`                            | Backend                                       | Default `embedded`; `external` allowed | `external` required; `embedded` refused at startup                     |
| `WORK_MEDIA_TOOLS_IMAGE`                       | Worker (and the Development embedded Backend) | Locally built sandbox image tag        | Pinned local image reference; never pulled                             |
| `WORK_MEDIA_WORK_DIR`                          | Worker (and the Development embedded Backend) | Private owner-only directory           | Private owner-only directory of the worker's own user                  |
| `WORK_MEDIA_WORKER_CONCURRENCY`                | Worker                                        | `1`                                    | `1`                                                                    |
| `WORK_MEDIA_COS_*`                             | Backend and worker                            | Absent (filesystem store)              | The same work-media storage identity in both                           |
| `WORK_MEDIA_STORE_DIR`                         | Backend and worker                            | The same directory for both            | Absent                                                                 |
| `APP_DATABASE_URL`, `APP_DATABASE_SSL_CA_FILE` | Backend and worker                            | As the Backend                         | Community App role; the worker uses a small pool                       |
| `DATABASE_URL`                                 | Backend and worker                            | As the Backend                         | Worker: read-only access to the published Catalog projection           |
| `COS_*` (Catalog read identity)                | Backend (resolver) and worker (source reads)  | Absent (local store)                   | The existing Catalog read identity; no new identity                    |
| Container daemon access                        | Worker only                                   | Local Docker                           | Rootless daemon of the worker's own user, through a host-local drop-in |

In Production the Backend ignores the tools image, work directory and
concurrency keys; its environment template keeps them as rollback-retained
values, so one environment file stays valid for the previous release during
rollback. Later increments add their own keys by revision, for example
`MEDIA_PUBLIC_DELIVERY` and `MEDIA_PUBLISHED_ORIGIN` (Backend and worker only)
in increment 2, and a direct-upload switch in increment 3. The published-media
origin is configured privately and never committed.

## Development prerequisite: the sandbox image

After PR 1a, every Development and preview stack that processes uploads needs
the media sandbox image built locally, because the embedded mode uses the same
sandbox runner and there is no in-process fallback. The build is idempotent and
documented in
[`infra/development/work-publishing/README.md`](../../infra/development/work-publishing/README.md);
a missing image fails processing with one actionable message. This is a
cross-task Development change: other tasks' stacks on `main` need the same
one-time build. The root `package.json` script `dev:media-sandbox` builds the
image, and the root `turbo.json` passes `WORK_MEDIA_WORKER` through to the
Development Backend; Issue #206 r5 records these two root configuration lines in
the task scope.

## Operations notes

- **Activation order.** Stop the media worker first, activate the release for
  the application services, confirm readiness, then start the worker last. The
  queue is durable, so jobs wait rather than fail.
- **Host memory.** On a small host, stop the worker before any on-host build or
  prepare step. Budget: sandbox ≤ 1.5 GiB (typically 0.6–1.0 GiB), coordinator ≤
  0.5 GiB; concurrency stays 1.
- **Image.** Build the sandbox image on the host from its pinned inputs; any
  registry mirrors are private build configuration. Record the image identifier
  and keep the previous image for rollback.
- **Self-check before activation.** Run the worker's sandbox self-check against
  the prepared release before switching to it, and the bound probes during
  acceptance. From the Backend's own user and hardening, confirm that the
  worker's daemon socket cannot be connected and its job workspace cannot be
  read.
- **Migration.** After the PostgreSQL 16 migration task's handoff, verify the
  effective target, then take and verify a fresh backup of it before applying
  the migration. The migration takes all of its table locks first and verifies
  the copied rows in its own transaction.
- **Rollback.** A private, tested SQL step, run with the worker stopped, must
  copy `ready` renditions created after the migration back into
  `media_derivatives` (old roles only) and neutralize what the previous release
  cannot handle (`catalog_render` job rows, derivative rows whose blob is gone);
  then the previous release, its Backend unit and its daemon access are
  reactivated. The previous release treats blobs that only the new tables
  reference as unused, so a rollback loses the task-created `viewer` and Catalog
  rendition bytes (regenerable). Before a roll-forward, a second private step
  must copy the renditions the previous release recorded meanwhile into
  `media_renditions`; the Catalog sync then re-renders every asset whose
  rendition blob is gone, and items regain a missing `viewer` when they are next
  rendered.
- **Evidence.** Acceptance records are content-free. Signed or token URLs are
  never printed; probes report status codes, shapes and timings. Real-content
  checks use only content the Owner authorized.
- **Cost.** Increment 1 creates no cloud resources. Incremental storage for
  renditions is reported per increment.

## Increments 2–4 (semantics)

- **Increment 2: published delivery.**
  - Published copies of eligible renditions live in a dedicated private
    published origin, served through a new media hostname on the Owner's
    existing Tencent Cloud EdgeOne subscription (one provider; no multi-provider
    layer; cache misses never pass through the application server) at
    `v1/{publicId}/{generationToken}/{editKey}/{role}.r{version}.{ext}`, where
    the generation token is unguessable. A tile set uses the same prefix with a
    trailing `/`.
  - Only renditions can ever be published. References are exposed only after a
    complete set is published.
  - Withdrawal removes the copies and purges the paths through EdgeOne
    (generation-scoped for a tile set), targeting no warmed-edge delivery within
    10 minutes; a failed purge falls back to the edge TTL. Eligibility is
    re-evaluated before every publication completes, and a publication lease is
    tied to its live job. The application refuses any purge target outside the
    new media hostname.
  - Browser caching is `max-age=300` with validators and `must-revalidate`; the
    edge TTL is 1 hour by default and never above 24 hours; offline or stale
    serving is disabled.
  - Spending controls: daily traffic and request cutoffs with early warnings on
    the media hostname only, plus a daily worker job that totals the plan
    month's requests from the provider's analytics and warns at 2,000,000.
    Cutoff enforcement is delayed, so it is not an instantaneous spending cap.
  - Sequencing (Issue #206 r4): the hostname gets no public DNS record and Web
    reads are not switched until the publication and withdrawal lifecycle,
    including the purge on a warmed edge, passes acceptance without public DNS.
  - Configuration: `MEDIA_PUBLIC_DELIVERY` and `MEDIA_PUBLISHED_ORIGIN`.
    Publisher credentials (the approved keyless role) are delivered to the
    worker only. A cost projection is reported before switch-on.
- **Increment 3: uploads and profile imagery.**
  - The Backend issues per-part presigned upload URLs, signed with short-lived
    credentials restricted to one staging object; the browser holds no
    credentials.
  - The server verifies total size and SHA-256 and binds an immutable verified
    copy.
  - A staging lifecycle rule is a backstop only; it is generated from the
    validated prefix and canaried before use.
  - Avatars and backgrounds become media items with roles `avatar-128`,
    `avatar-512`, `background-960` and `background-1600`, referenced as profile
    holders. Their PostgreSQL bytes are retained until the follow-up.
  - Amendment entries 10 and 11 and the cloud identity changes it needs are
    approved (Owner decisions, 2026-10-04).
- **Increment 4: deep zoom and completion.**
  - IIIF Image API 3 Level 0 with JPEG tiles. `full/max` is the bounded viewer
    image, and the contract carries a resolved `info.json` URL.
  - OpenSeadragon runs inside the existing Viewer.
  - Resolution policy: the defaults recorded above, a curator limit for Catalog
    items, and an explicit author opt-in above the default for new works.
  - An explicit Catalog display-master relationship, backfill and the
    before/after measurement.
  - Retirement of superseded paths and of the old media hostname, and the
    recorded retention follow-up.
