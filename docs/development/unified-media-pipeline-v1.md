# Unified media pipeline — unified-media-pipeline-v1

Task `unified-media-pipeline-v1`, Issue #206. Authority: Owner instruction:
unified media pipeline, 2026-10-04 (private; cited by name only). Governance
record:
[2026-10-04 unified media pipeline amendment](../governance/amendments/2026-10-04-unified-media-pipeline.md).
The Issue holds the frozen scope and Behavior Matrix; this document is the
public-safe design. Increment 1 is described in detail. Increments 2–4 are fixed
here at the semantic level and receive their details by revision before each
starts. Issue #206 r21 splits increment 3 into 3a and 3b; 3a is described in
[Profile images (increment 3a)](#profile-images-increment-3a).

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
Increment 3 deploys in two parts (Issue #206 r21): 3a from
`media-pipeline-inc3a` and 3b from `media-pipeline-inc3b`. Turning 3a's emission
on is a configuration change recorded on Issue #206, without a tag.

| Increment                                        | Content                                                                                                                                                                                                                                                                    | User-visible                                                                                                            | Switch and rollback                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, PR 1a "pipeline"                              | Rendition model and migration, recipes v1 plus `viewer`, sandbox renderer, separate media worker, Catalog processing, retention hold, governance record                                                                                                                    | No; Production Web output unchanged                                                                                     | Previous release plus the private rollback and roll-forward steps ([Operations notes](#operations-notes))                                             |
| 1, PR 1b "delivery"                              | Additive rendition candidates and placeholder colour in the contracts, Backend builders, Web `srcset`/`sizes`/aspect/placeholder, progressive Viewer, Development Catalog candidates                                                                                       | Yes; Owner visual gate on a Development preview before Ready                                                            | Previous release; legacy `src` remains the fallback everywhere                                                                                        |
| 2 "published delivery"                           | Published copies of eligible renditions in a dedicated private published origin behind a new media hostname on the existing EdgeOne subscription; publication, withdrawal and EdgeOne purge lifecycle                                                                      | No; delivery URLs change, rendered pages do not                                                                         | Configuration switch back to the authorized read paths                                                                                                |
| 3a "profile renditions"                          | Avatars and covers (`community.user_media`) as a third rendition subject keyed by the unchanged user-media id: four WebP roles, owner-less blobs, `profile_render` jobs queued by a paced worker sweep, an authorized origin route, optional `renditions` on `AuthorMedia` | Yes; Owner visual and real-device gate before Ready; emission switched on in Production at least 72 h after the release | `MEDIA_PROFILE_RENDITIONS=off` drops `renditions` from the answers; `MEDIA_PROFILE_RENDER=off` stops rendering; the original `src` stays the fallback |
| 3b "direct upload and profile source relocation" | Direct browser-to-storage upload; hash-verified relocation of existing `user_media` bytes out of PostgreSQL; the `user_media` retention follow-up; optional edge delivery of profile renditions                                                                            | Yes; Owner visual and real-device gate                                                                                  | Configuration switch back to the upload relay; profile bytes in PostgreSQL retained                                                                   |
| 4 "deep zoom and completion"                     | IIIF Image API 3 Level 0 JPEG tiles in the existing Viewer, resolution-policy controls, backfill, before/after measurement, retirement of superseded paths and the old media hostname, retention follow-up record                                                          | Yes; Owner visual and real-device gate                                                                                  | Tiles are optional per asset; the bounded viewer image remains the fallback                                                                           |

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
  - Exactly one subject per row: a media item, a Catalog asset or, from
    increment 3a, a profile image (`community.user_media`, by its unchanged
    public id).
  - Identity: subject, edit key (`base` or 32 hex; Catalog assets and profile
    images are always `base`), role, recipe version and recipe digest.
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
  no owner, and increment 3a adds `profile_derivative`, also with no owner. Such
  blobs are recorded, so store reconciliation keeps them, and they never count
  toward any account's capacity. The new `retention_hold` column marks
  pre-existing blobs that this task must not physically delete yet (see
  [Retention hold](#retention-hold)). Every other derivative, including the new
  `viewer`, counts toward its owner's stored usage as derivatives do today, so a
  new upload uses somewhat more of the owner's quota than before.
- **References** stay where they are: `media_item_refs` holders (drafts,
  revisions, snapshots, sessions, Article drafts and revisions),
  `work_revision_items`, the published Catalog projection, and the profile
  pointers (a user's avatar and background). From increment 3a those pointers
  select a profile image's renditions directly; there is no profile holder in
  `media_item_refs`. A rendition stays `ready` while any holder needs it;
  removing one holder never releases what another needs. Hash equality grants
  nothing: there is no cross-owner lookup by hash, and storage keys stay random
  per write.
- **Readiness and edits.** Readiness keeps today's required roles (`thumb`,
  `display`, `full`; `cover` where required; `motion` for Live items). `viewer`
  is optional and never blocks readiness or submission. Edit-key semantics are
  unchanged.
- **Jobs.** The job kinds gain `catalog_render`, and increment 3a adds
  `profile_render`. One TypeScript list is the source; an integration test keeps
  the database `CHECK` equal to it.

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

| Role@version             | Framing                                                   | Geometry (never upscaled)                                                                                                                                                                                                           | WebP quality | Planned for                    |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------ |
| `thumb@1`                | Card (the author's cover crop where it applies)           | Long edge ≤ 480                                                                                                                                                                                                                     | 80           | Work items, Catalog            |
| `cover@1`                | Card for work items; complete for Catalog (no cover crop) | Long edge ≤ 1080                                                                                                                                                                                                                    | 86           | Work items, Catalog            |
| `display@1`              | Complete                                                  | Long edge ≤ 2048; long scroll: short edge ≤ 1280, long edge ≤ 16,000, ≤ 20 MP                                                                                                                                                       | 86           | Work items, Catalog            |
| `viewer@1` (new)         | Complete                                                  | Long edge ≤ 4096 (≤ 4096 × 4096 pixels); long scroll: short edge ≤ 2048, long edge ≤ 16,000, ≤ 20 MP; never above `full`. Rendered only when it differs from `display` and, for a work item, is smaller than its `full` (see below) | 88           | Work items (optional), Catalog |
| `full@1`                 | Complete                                                  | Long edge ≤ 8192; long scroll: long edge ≤ 16,000, ≤ 40 MP                                                                                                                                                                          | 90           | Work items only                |
| `motion@1`               | Complete                                                  | Unchanged motion profile (H.264, long edge ≤ 1920)                                                                                                                                                                                  | —            | Live items                     |
| `avatar-128@1` (3a)      | Complete                                                  | Long edge ≤ 128                                                                                                                                                                                                                     | 80           | Profile avatars                |
| `avatar-512@1` (3a)      | Complete                                                  | Long edge ≤ 512; not rendered when its size equals `avatar-128`'s                                                                                                                                                                   | 82           | Profile avatars                |
| `background-960@1` (3a)  | Complete                                                  | Long edge ≤ 960                                                                                                                                                                                                                     | 82           | Profile backgrounds            |
| `background-1600@1` (3a) | Complete                                                  | Long edge ≤ 1600; not rendered when its size equals `background-960`'s                                                                                                                                                              | 84           | Profile backgrounds            |

A long scroll is an image whose long edge exceeds 2.5 times its short edge.

The viewer is never a second copy of another rendition. It is not rendered when
its size equals `display`'s or would exceed `full`'s, and a work item gets none
when it would be as large as the item's `full`: any frame up to 4096 px on the
long edge, or a long scroll within the viewer's bounds. A Catalog asset has no
`full`, so its viewer exists whenever it differs from `display`. These rules
decide only whether a viewer exists, never its bytes: the job's plan (`work` for
an item edit, `catalog` for a Catalog asset, `profile` for a profile image from
increment 3a) travels in the sandbox request, the renderer and the coordinator
evaluate the same registry function with it, and the plan rule is not part of
the `viewer@1` digest. Readiness, submission and the Catalog sync never require
a viewer.

Common still pipeline:

- EXIF orientation is applied once; then edit rotation, crop and (for card
  framing) cover crop; then resize.
- Explicit ICC-aware conversion to sRGB. Outputs carry no EXIF, XMP, IPTC, ICC
  or other chunks; alpha is preserved for PNG and WebP sources.
- No source passthrough for any role: every published byte is re-encoded.
- Placeholder colour: the mean colour of the base-edit `thumb`, computed inside
  the sandbox; `null` when any pixel is not opaque.

Not in increment 1: card-box `thumb@2`/`cover@2` (revisited with measurement in
increment 4), the four profile roles (added by increment 3a with the parameters
above; the six increment-1 digests are unchanged), and tiles (increment 4). A
changed transformation always gets a new version; from increment 2 a new version
also gets a new published path and never overwrites a published representation.

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
  other kind and also runs reconciliation and the Catalog sync; from increment
  3a it claims `profile_render` and runs the profile sweep only while
  `MEDIA_PROFILE_RENDER` is on.
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
  The Backend listener must use `HOST=127.0.0.1` so it serves that fixed IPv4
  address; IPv6-only and DNS-resolved listener names are refused. That route
  exists only in synthetic Development with local storage and a publishing
  store, and the resolver names renditions only when it exists; without a
  publishing store Catalog media keep their approved `src`. The route serves
  exactly that `GET` target (no query), streams the committed blob of a
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
  name the same blobs as the adopted renditions. In increment 3b the profile
  bytes in `user_media` are relocated under the same rule; increment 3a moves
  and deletes none of them.
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
| `MEDIA_PROFILE_RENDER` (3a)                    | Worker (and the Development embedded Backend) | Default `on`                           | Default `off`; turned `on` during the release window                   |
| `MEDIA_PROFILE_RENDITIONS` (3a)                | Backend                                       | Default `on`                           | Default `off`; turned `on` only at the switch-on                       |

In Production the Backend ignores the tools image, work directory and
concurrency keys; its environment template keeps them as rollback-retained
values, so one environment file stays valid for the previous release during
rollback. Later increments add their own keys by revision, for example
`MEDIA_PUBLIC_DELIVERY` and `MEDIA_PUBLISHED_ORIGIN` (Backend and worker only)
in increment 2, the two profile switches above in increment 3a (each accepts
only `on` or `off`; any other value refuses startup), and a direct-upload switch
in increment 3b. The published-media origin is configured privately and never
committed.

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
the task scope. Increment 3a adds `MEDIA_PROFILE_RENDER` and
`MEDIA_PROFILE_RENDITIONS` to the same pass-through list, so Development can
exercise the switch-off path; Issue #270 r1 records that root configuration
line. Both switches default to `on` in Development, so after 3a every
Development and preview stack with `WORK_MEDIA_*` set renders profile images
too.

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

## Profile images (increment 3a)

Task `profile-media-renditions-v1`, Issue #270 r1, under Issue #206 r21 (Owner
decisions D1–D13, 2026-10-13). The [task record](profile-media-renditions-v1.md)
holds the Behavior Matrix and the scope records; the
[release runbook](../deployment/media-profile-renditions-inc3a.md) holds the
Production steps.

- **Subject.** Profile images become a third rendition subject next to media
  items and Catalog assets, keyed by the unchanged public user-media id
  (amendment entry 6). One forward migration,
  `20261014010000_profile_media_renditions`, takes all of its locks first under
  a 5 s lock timeout (`community.user_media` in SHARE ROW EXCLUSIVE, then
  `media_renditions`, `media_blobs` and `publishing_jobs` in ACCESS EXCLUSIVE).
  It gives `media_renditions` a `user_media_id`, limits profile rows to the four
  profile roles as unedited WebP, and allows one `ready` row per image and role.
  `user_media` and `public_users` keep their schema, and setting an avatar or a
  cover queues nothing. Apart from the removal of the daily avatar limit (see
  the task record), the author write path is unchanged. Profile images are not
  wrapped as media items with profile holders, because legacy items never render
  the unedited form, items without holders are purged, item renditions count
  toward capacity, and the item read path would expose media-item ids instead of
  the unchanged profile ids.
- **Rendering.** A `profile_render` job reads the stored PNG by its user-media
  id, only while it is not erased, and checks its size, PNG signature, SHA-256
  and dimensions against the row. The existing sandbox renders it with the
  `profile` plan: unedited, complete framing, no placeholder colour and no
  motion; metadata is stripped, alpha is kept and nothing is upscaled. A
  family's roles (`avatar-128` and `avatar-512`, or `background-960` and
  `background-1600`) are rendered together and recorded in one transaction as
  owner-less `profile_derivative` blobs in the existing private publishing
  store. A replay is a no-op, and a rejected source records a content-free
  failure code. Worker concurrency stays 1 and every sandbox bound is unchanged.
- **Sweep.** Only a paced sweep in the worker maintenance queues
  `profile_render`, so it is also the backfill. It reads the current avatar and
  background pointers of active users, never the image bytes, and queues an
  image whose family anchor (`avatar-128`, `background-960`) is not ready at its
  current recipe version or a later one.
  - One pass every 60 s, with at most 2 new jobs per pass. Images of owners with
    the most recent public work are queued first, and those of owners without
    public work last. An owner has at most one open `profile_render` job, so a
    pass queues at most one image per owner and one owner never takes both
    slots.
  - Nothing is queued while 2 or more `profile_render` jobs are open, or while
    any `process_item`, `derive_edit` or `catalog_render` job is queued or
    running. The queue is first in, first out, so a work upload waits behind at
    most about 2 short profile jobs.
  - Content rejections are final until an operator retries the job; an exhausted
    retryable failure is queued again a day later; an abandoned job blocks (the
    Catalog rule).
  - The worker logs one content-free count line when the counts change: missing,
    blocked, enqueued, requeued and paused.
  - The plan and the sweep look at the anchor only, and count it as ready at the
    current recipe version or a later one, whatever its digest. That matches the
    recording rule, which replaces a ready rendition only with a higher version,
    so a rollback after a future version change never renders the same image
    again on every pass. A lost non-anchor blob is not rendered again while the
    anchor stands, and a recipe version change of `avatar-512` or
    `background-1600` alone needs an anchor version change or an extension of
    the sweep.
- **Capacity, edge and retention.** Profile renditions count toward no account's
  capacity. The publication insert trigger and the edge eligibility query refuse
  them, so 3a never publishes them to the edge. Renditions of a replaced avatar
  or a cleared cover are kept, readable by the owner only, until the image is
  erased; erasure releases them in the same transaction. The existing
  `purge_blob` schedule then deletes each object once it is not in use and at
  least 1 h after its blob was created (when it was rendered, not when it was
  released), so a rendition older than 1 h is usually deleted within about a
  minute of the erasure. This task creates these blobs, so none is under the
  retention hold.
- **Read route.** `/api/community/media/<user-media-id>/<role>` relays `GET` and
  `HEAD` (at most one byte range) to the Backend's
  `/v1/community/media/{mediaId}/{rendition}`.
  - Access is the original image route's rule narrowed by family. The owner can
    always read. Others read the avatar roles of the current avatar and the
    background roles of the current background, while the owner is active, the
    image is not erased and neither account blocks the other. Everything else is
    `404`. A query string gets `422` at the Backend and `404` in the relay;
    without a publishing service the Backend answers `503`.
  - The Backend always sends `private, no-store` and `Vary: Authorization`. Only
    for a current image (the family's pointer still selects it) does it add a
    strong `ETag`, the rendition SHA-256, and answer a matching `If-None-Match`
    with `304` from the stored hash, without reading storage.
  - The Web relay turns a tagged answer into `private, no-cache` with
    `Vary: Cookie` and the `ETag`; an untagged, owner-only answer stays
    `private, no-store`. It forwards only a well-formed `If-None-Match` of at
    most 1 KiB, streams without buffering, repeats the read signed out when the
    Backend refuses a stale session, passes `401`, `403`, `404` and `503` with
    no body and `no-store`, keeps the range header of a `416`, and turns every
    other status into `502`.
  - This extends the
    [closed-beta caching exception](../production/closed-beta-access-v1.md#where-it-is-enforced)
    to current renditions (decision D4); owner-only reads and errors keep
    `private, no-store`, as amendment entry 5 requires. Nginx is unchanged.
- **`AuthorMedia`.** An optional `renditions` list of one family, ascending by
  size; `src` stays the original PNG. The contract also accepts future published
  URLs, but 3a emits none. With `MEDIA_PROFILE_RENDITIONS=on` the Backend lists
  a family in profile and people answers only when its anchor is ready; the
  blocked-accounts list carries none, and a list that breaks a contract rule is
  dropped with one content-free log line. With the switch off those answers
  carry no `renditions` key and are otherwise identical to the previous
  release's, except that an owner's own `nextAvatarChangeAt` is always `null`,
  because the avatar-limit removal shipped in the same release. The upload
  answer never carries renditions. The key-set pin moves as amendment entry 14
  allows.
- **Web.** Avatars drawn at 48 px or less use `avatar-128`. The profile header
  (80 px) and registration (96 px) use `avatar-128` at 1× and `avatar-512` from
  2×. The profile cover uses one URL, the largest background rendition, for its
  photo, compact strip and frost, and samples its tint from it. The owner's
  avatar and cover editors, every other surface and any image without renditions
  keep `src`. Box sizes, loading and the cover's framing are unchanged.
- **Release.** One late-night window ships the migration, contracts, Web,
  Backend, Admin and worker from `media-pipeline-inc3a` with emission off. The
  worker starts with rendering off, then on, which begins the backfill. Emission
  is switched on no earlier than 72 h after the release, with at least 95% of
  current images rendered and every failure explained, the Owner's preview
  sign-off and real-device checks. While emission is on, Web is never rolled
  back below the 3a release.

## Catalog deep zoom (increment 4 slice)

Task `catalog-deep-zoom-v1`, Issue #295 r1, reopened by Issue #206 r22 (Owner
decisions 2026-10-19). Every other increment-4 item stays paused. The slice cuts
a private, Owner-attached display master into one level of 1024 px JPEG blocks;
no IIIF pyramid, OpenSeadragon or dependency is added (a named deviation from
the increment-4 wording, for this slice only).

- **Masters.** A display master is the private, byte-exact 8-bit JPEG or PNG
  behind one exact approved Catalog image. It is an owner-less blob of purpose
  `catalog_master` in the existing private store, held by the retention hold
  `catalog_master` while committed, so no purge path removes it.
  `community.catalog_display_masters` attaches it to one Catalog asset: at most
  one active row per asset and per blob, a row is only ever ended (`detached`,
  `limit_changed`, `reattached`), never rewritten. The frame L is the oriented
  master scaled to min(master, the Owner's limit, 8192 px long edge), for every
  aspect, never upscaled; CHECKs enforce it. Masters drive only the blocks:
  thumb, cover, display and viewer keep coming from the approved image.
- **The `catalog-master` command** (`node dist/catalog-master-cli.js` in
  `@moya/backend-production`) is the only way masters change: `candidates`,
  `manifest` (on the Owner's Mac: drafts the approval document from the curation
  lineage and the originals), `attach` / `attach-batch` (approval document with
  each master's SHA-256, a private inbox, `--dry-run`),
  `attach --existing-master` (re-attach without a second upload), `status`,
  `requeue`, `set-limit`, `detach`, `erase` and `guard`. Each Production run is
  an Owner run with the worker's environment. Attach refuses an image outside
  the published projection, an unready asset, an approved image above 4096 px
  (unless the master is a self-master, below), a SHA-256 mismatch, an aspect off
  by more than 0.2 % or a frame that does not show the approved image's framing
  within the rounding of each side, a frame below 1.25 × the viewer, a base
  below 0.45 × the frame, a file above 128 MiB or 120 MP, anything but 8-bit
  JPEG or opaque PNG, and an attach that would cross either storage bound,
  measured live at that attach: masters plus blocks at most 20 GiB (the slice
  cap, `CATALOG_MASTER_SLICE_CAP`; it was 10 GiB), and every byte #206 created
  at most 45 GB. Both measured figures also count the projected blocks (1 byte
  per frame pixel) of every active master whose set is not yet cut, because
  blocks are cut only on an idle queue and an `attach-batch` attaches far
  faster; a partly cut set counts twice until it is complete; once a set is cut,
  the published copy of every ready block without a live publication row stays
  counted at its blob's size until that row exists; and a limit change or
  re-attach leaves out the master it ends. (Issue #321 asked this for the slice
  cap; the 45 GB task figure counts them too, because D4 refuses an attach that
  would cross either bound.) Attach and limit changes take one advisory lock
  before the check, so two `catalog-master` processes cannot both pass a bound.
  The projection is above the activation plan's estimate (313 self-masters,
  13,034 cells: about 13 GB at 1 byte per frame pixel against 6.3–8.4 GB of
  private and published blocks), but it is an estimate: a set whose private
  blocks weigh T bytes finishes at about 2T, so when T is more than half a byte
  per frame pixel it ends 2T − P above its projection P (block recording does
  not re-check the bounds). Compare the real bytes per frame pixel of the first
  batch before attaching more. A dry run writes nothing, so in an
  `attach-batch --dry-run` every entry sees only what exists now: its storage
  figures are per entry, not cumulative, and a real batch can stop at a bound
  that its dry run passed. The batch needs `status`'s `sliceBytes` (and
  `taskBytes`) plus the sum of the entries' `attachBytes`. Output is
  content-free.
- **Self-masters** (task `catalog-deep-zoom-self-master-v1`, Issue #321; the
  RP-11 revision, the 20 GiB cap, the purge budget and the breaker bytes below
  await the Owner's confirmation in #206 r23). The Catalog records #312
  published carry their `editorial/` originals (6000–9504 px) as the approved
  images, so the 4096 px bound (RP-11) would refuse every master. A published
  `editorial/` original may therefore be its own master when all four hold: the
  approved key is `editorial/`; the master's SHA-256 is the approved image's and
  the one the asset's base render recorded (`master_sha256`); the master's
  oriented size is the size that render decoded (`master_width`,
  `master_height`; a rotated original whose recorded size is not oriented fails
  closed); and the derivation is `submitted`. Any other master of an approved
  image above 4096 px, `display/v1/` keys included, is still refused with
  `approved_too_large`; every other check applies unchanged, and the public
  still receives only the 1024 px blocks of a frame of at most 8192 px. `attach`
  / `attach-batch --from-source` (with `--approval` and an empty private
  `--inbox`; the approval entry names the approved bytes as the master,
  `submitted`, else `not_self_master`) asks the store for the published original
  (`not_published`, `asset_not_ready`, `not_editorial`, `already_attached`),
  refuses a WebP original (`master_format`) before any read, copies the original
  through the worker's read-only `CATALOG_SOURCE_COS_*` identity (Development:
  `CMS_MEDIA_DIR`) into the inbox while checking the approved SHA-256
  (`source_unreadable`, `source_too_large`, `source_hash_mismatch`,
  `source_unavailable`), and attaches that file exactly like an Owner's (header,
  128 MiB, 120 MP, alpha or 16-bit refusals, dry run, upload, attach). The copy
  is removed on every path, so the inbox holds at most one original at a time;
  no key, path or file name is printed. `manifest` drafts entries only from Mac
  lineage and originals, so a self-master approval document is drafted from
  `candidates --catalog <id>` instead: one entry per line with `assetState`
  `ready`, an `approvedSha256` and no `activeMasterId` that the Owner approves,
  with `mediaId` and `approvedSha256` copied, `masterSha256` equal to
  `approvedSha256`, `derivation` `submitted`, and a unique `masterFile` such as
  `<mediaId>.original` (only the name of the temporary inbox copy; the format
  comes from the file's header). `maxLongEdge` and `note` stay optional.
- **Blocks.** A block is a Catalog rendition `block-NN` (row-major, at most 100)
  of one master: an unedited JPEG of at most 1024 px plus a 2 px overlap on the
  right and bottom, named by `catalog_master_id`, on an owner-less
  `catalog_derivative` blob. The `security_barrier` view
  `community.catalog_media_zoom_blocks` lists the ready blocks of each ready,
  referenced asset's active master with their exact cell geometry; the App and
  public read roles read it. Block work is a `catalog_render` payload variant
  `{variant: "blocks", masterId, cells: [from, to]}` (at most 16 cells, at most
  two open sets); the job kind list is unchanged. Claim classes: previews and
  everything else 0, HD 1, base Catalog renders 2, blocks 3, and a block job
  only for a worker whose block render switch is on, on an idle queue (no other
  claimable job due or running, no upload in flight changed within 2 minutes).
  The Admin's retry and abandon refuse block jobs with the existing conflict
  error; only `catalog-master requeue` and `detach` manage them.
- **Cutting.** Only a worker whose `MEDIA_CATALOG_ZOOM_BLOCKS_RENDER` is `on`
  (missing means on in Development, off in Production) runs the block step of
  the 5-minute Catalog sync and claims block jobs. The step queues the missing
  cells of each active master's incomplete set in runs of at most 16 cells, with
  at most two open sets, and skips complete sets, sets that failed on content
  and paused sets (a stopped job still covers a missing cell;
  `catalog-master requeue` resumes it). The sandbox operation `blocks` reads the
  master and the asset's `display` rendition, decodes the master once (oriented
  once, ICC to untagged sRGB, Lanczos3 to the frame), refuses a master that does
  not match the display rendition (both compared at a 512 px long edge: luma
  PSNR below 40 dB or a channel mean more than 2 apart; calibrated on local
  originals and real pairs) and encodes each cell as baseline JPEG q85 4:4:4
  without metadata (recipe `block@1`). Content failures (`master_unreadable`,
  `zoom_blocks_alpha`, `master_mismatch`) are never retried for that master.
  Each job logs one content-free line
  (`[media-worker] catalog blocks stage_ms=… render_ms=… cells=N outcome=…`).
  Recording discards a late job of an ended master and releases any other
  master's ready blocks, so an asset keeps one set.
- **Publication and withdrawal.** The desired set adds the blocks the view
  lists; Work and Article branches never admit them. Keys follow the existing
  grammar (`…/base/block-NN.r1.jpg`). Withdrawal purges ordinary roles first, in
  their own tasks, with per-group attempts and failure. Block URLs use at most
  the daily block purge budget B (25 % of the zone's daily URL-purge quota,
  which P0 read as 1,000,000: B = 250,000 per day,
  `CATALOG_BLOCK_PURGE_BUDGET_PER_DAY`; it was 0 until that reading); beyond it
  a block group takes the TTL path: its origin objects are deleted, it records
  the forced edge TTL and finishes after that TTL plus 5 minutes, and one
  content-free error line
  (`publication.withdrawal code=block_budget_deferred units=N ttl_seconds=T`)
  reports the deferral. Blocks are verified by two samples per set and swept
  once (one origin HEAD each and two sampled edge checks).
- **Read path.** Behind `MEDIA_CATALOG_ZOOM_BLOCKS` (missing means on in
  Development, off in Production) the Catalog Detail gives an image the strict
  frame `zoom: {width, height}` when its block set is complete, its rendition
  group resolved (never on the approved-`src` fallback) and the frame shows its
  framing; a failing frame read omits every frame and the Detail still answers.
  The blocks themselves are read once per image from
  `GET /v1/catalog/{catalogId}/media/{mediaId}/zoom-blocks` (frame, edge 1024,
  overlap 2, one URL per row-major cell, all resolved or 404), behind the same
  access gate; the Web reaches it through its same-origin proxy, parses it
  strictly and, in Development, rewrites each URL to the same-origin relay. No
  Detail, Article body or article tool output carries a block URL. Both reads
  reach the published-blocks view through `LATERAL`, so a Detail reads only its
  own images' rows.
- **Breaker.** The read path is open only where blocks can be delivered (edge
  delivery, or the Development relay) and while the breaker is closed. The
  worker stores the image host's day-to-date requests and response traffic
  (`l7Flow_request`, `l7Flow_outFlux`; P0 settles the metric) every 15 minutes
  from 00:00 Asia/Shanghai, with content-free lines at 100,000 requests or 0.25
  GB (`publication.usage code=day_usage_warning`) and at 150,000 or 0.4 GB
  (`code=day_usage_trip`); the byte thresholds were 3 GB and 5 GB, and they
  count the image host's whole response traffic, not blocks only. The Backend
  reads that row at most once a minute: with edge delivery a missing or stale (>
  1 h) reading, or a trip threshold, hides every frame and answers 404 on the
  list until the cap's next day.
- **Viewer.** Only a Catalog Detail image with a frame gets the block layer
  (Work Detail, the feed and Articles never do). It mounts once the zoom asks
  for more than 1.15 × the widest base candidate, unless more than 24 blocks
  would be visible at that point (a large desktop keeps today's ladder); it then
  reads the list once, loads the visible blocks nearest the centre first while
  the zoom rests (at most 4 in flight, 24 decoded, never evicting a visible
  block), inserts each only once decoded and draws it on device pixels. Paging
  away or closing aborts the old image; a 404 or refused list leaves today's
  Viewer; three failed blocks switch the layer off for the session. A tiled
  image zooms to min(40, max(today's ceiling, 1.25 × its frame's one-to-one
  zoom, fill)). `data-viewer-zoom-blocks` on the stage reports `none`,
  `unusable`, `idle`, `loading`, `ready` or `fallback`.
- **Rollback floor.** The expand release handles block rows in every state and
  never claims a block job. Once any block rendition, block job or block
  publication exists, code older than the expand release must not run:
  `catalog-master guard` (and the same three counts in SQL) is the release
  toolkit's rollback pre-check. Withdrawing masters runs in this order:
  `catalog-master detach` (one image, or `--all`), then wait until every block
  publication of those masters is withdrawn (at once within B, else after the
  forced edge TTL plus 5 minutes), and only then `catalog-master erase` for each
  master, which refuses with `blocks_published` before that.

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
- **Increment 3, split into 3a and 3b (Issue #206 r21).** Increment 3 counts as
  deployed only when 3b is deployed. Until then amendment entry 6's existing
  rule stays in force: avatar and background bytes stay in PostgreSQL and
  retained rows are not rewritten; "PostgreSQL receives no new image bytes" is
  deferred to 3b.
- **Increment 3a: profile renditions** (`profile-media-renditions-v1`). Avatars
  and backgrounds become a rendition subject keyed by the unchanged `user_media`
  id, with roles `avatar-128`, `avatar-512`, `background-960` and
  `background-1600`, rendered from the stored PNG and served from the origin
  through an authorized route. It moves no bytes and adds none beyond today's
  upload path. Details:
  [Profile images (increment 3a)](#profile-images-increment-3a).
- **Increment 3b: direct upload and profile source relocation.**
  - The Backend issues per-part presigned upload URLs, signed with short-lived
    credentials restricted to one staging object; the browser holds no
    credentials.
  - The server verifies total size and SHA-256 and binds an immutable verified
    copy.
  - A staging lifecycle rule is a backstop only; it is generated from the
    validated prefix and canaried before use.
  - Existing `user_media` bytes are relocated out of PostgreSQL through an
    explicit, hash-verified mapping; the public profile-media ids do not change
    and the PostgreSQL bytes are retained until the retention follow-up.
  - Optional edge delivery of profile renditions.
  - Amendment entries 10 and 11 and the cloud identity changes it needs are
    approved (Owner decisions, 2026-10-04).
- **Increment 4: deep zoom and completion.** Paused on 2026-10-18 except the
  Catalog slice reopened by r22 (see
  [Catalog deep zoom](#catalog-deep-zoom-increment-4-slice)), which uses one
  level of JPEG blocks instead of the IIIF wording below.
  - IIIF Image API 3 Level 0 with JPEG tiles. `full/max` is the bounded viewer
    image, and the contract carries a resolved `info.json` URL.
  - OpenSeadragon runs inside the existing Viewer.
  - Resolution policy: the defaults recorded above, a curator limit for Catalog
    items, and an explicit author opt-in above the default for new works.
  - An explicit Catalog display-master relationship, backfill and the
    before/after measurement.
  - Retirement of superseded paths and of the old media hostname, and the
    recorded retention follow-up.
