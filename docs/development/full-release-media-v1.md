# Production publishing media integration — full-release-media-v1

This task supplies a private COS implementation for the existing publishing
media port and a callable configuration factory. It does not enable Production
routes, change shared deployment templates, create cloud resources, or authorize
deployment. `full-release-runtime-v1` owns composition, application routing, Web
relays, Nginx and systemd. `full-release-database-v1` owns migrations and
grants.

## Scope and behavior

| Scenario                                 | Development                                                         | Production integration                                                    | Must preserve                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| New work and Article-owned media         | Existing private filesystem factory                                 | New private COS factory behind the same port                              | Upload attempts, exact sizes, SHA-256, manifests, derivatives, references and publication rules |
| Avatar and profile background            | Existing bounded PNG storage in `community.user_media`              | Retain that storage and authenticated read path                           | Ownership, audience checks and profile references                                               |
| Legacy work and Article PNGs             | Existing `user_media` sources; edits produce publishing derivatives | Preserve source rows; new derivatives use the configured publishing store | No source migration or duplicate source blobs                                                   |
| Catalog and Article Catalog references   | Existing local development resolver                                 | Existing Catalog COS URL resolver                                         | Published-only projection and provider details kept out of DTOs                                 |
| Payload/Admin media                      | Existing CMS namespace                                              | Existing CMS namespace                                                    | No publishing reconciliation or deletion authority                                              |
| Missing or malformed media configuration | Existing all-or-nothing optional filesystem configuration           | Production parser requires complete, valid configuration                  | No silent filesystem fallback or anonymous cloud access                                         |

The source boundaries are the
[publishing port](../../services/api/src/modules/community/application/ports/publishing-media-store-port.ts),
[profile and legacy media adapter](../../services/community-postgres/src/author-adapter.ts),
[Article managed-media reader](../../services/community-postgres/src/article-authoring/media-read.ts),
[Article Catalog resolver](../../services/catalog-postgres/src/authored-article-media-resolver.ts)
and
[Catalog COS resolver](../../services/backend-production/src/storage/production-cos.ts).
Enabling their existing Production routes remains the runtime task's work.

## Factory and configuration

The existing module boundary
`@moya/backend-production/internal/publishing-config` exports
`parseProductionPublishingMediaConfig(environment)` and
`openProductionPublishingMedia(config, options)`. Their implementation is in
[publishing/config.ts](../../services/backend-production/src/publishing/config.ts).

Runtime integration must parse configuration and open the factory before opening
database pools. Pass `foreignDirectories: [environment.CMS_MEDIA_DIR]` and any
other retained local media roots. The result is `{ store, runner, processor }`:
pass the same `store` to the existing upload/read service and job handlers,
`processor` to those handlers, and `runner` as `toolJobs`. Use the parsed
`workerConcurrency` for the existing `PublishingWorker`. Keep one transfer
registry shared by HTTP uploads and worker cancellation callbacks. Start the
worker after listening, and stop it before closing its database pool.

Parsing and opening perform local validation; neither makes a COS request or
runs Docker. Successful startup validation therefore does not establish bucket,
credential, policy, Docker or media-tool availability. Production must not call
the Development parser as fallback. Development keeps
`parsePublishingMediaConfig` and `openPublishingMedia` unchanged in behavior.

| Environment key                        | Requirement                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORK_MEDIA_COS_BUCKET`                | Required COS bucket name including its numeric account suffix                                                                                                                                  |
| `WORK_MEDIA_COS_REGION`                | Required COS region identifier                                                                                                                                                                 |
| `WORK_MEDIA_COS_PREFIX`                | Required exclusive `ugc/publishing/<namespace>/` prefix; namespace is 1–63 lowercase letters, digits or hyphens, starting with a letter or digit                                               |
| `WORK_MEDIA_COS_SECRET_ID`             | Required server-only identity for the UGC role                                                                                                                                                 |
| `WORK_MEDIA_COS_SECRET_KEY`            | Required server-only credential for that identity                                                                                                                                              |
| `WORK_MEDIA_COS_SECURITY_TOKEN`        | Optional temporary-credential token; when present, expiry is required                                                                                                                          |
| `WORK_MEDIA_COS_CREDENTIAL_EXPIRES_AT` | Unix seconds; required with a token and forbidden without one; must have more than 30 seconds remaining at parsing                                                                             |
| `WORK_MEDIA_COS_REQUEST_TIMEOUT_MS`    | Optional positive integer, default 30000, maximum 120000; total bound for control/read operations; multipart part uploads use the setup, inactivity and response-header bounds described below |
| `WORK_MEDIA_TOOLS_IMAGE`               | Required local Docker image reference with explicit tag or digest; the runner never pulls it                                                                                                   |
| `WORK_MEDIA_WORK_DIR`                  | Required private local processing directory, separate from code and retained media                                                                                                             |
| `WORK_MEDIA_WORKER_CONCURRENCY`        | Optional integer 1–4, default 1                                                                                                                                                                |
| `WORK_MEDIA_STORE_DIR`                 | Must be absent or empty in Production COS configuration; retained filesystem storage remains Development-only                                                                                  |

Keep these values in protected runtime configuration. UGC credentials are
separate from Catalog's `COS_*` credentials and Payload identity. Do not expose
them, bucket names, prefixes, logical storage keys or signed links through
public payloads or diagnostics. The environment parser captures a credential
snapshot; it does not refresh temporary credentials. Compensating cleanup shares
a one-second deadline; uncertain objects remain unrecorded for age-gated
reconciliation. Worker cancellation reaches multipart sweeps and active read
destruction cancels its owned network request.

A caller supplying a rotating server-side `credentials` callback through the
typed configuration must retain the same role separation. Each operation rejects
expired or malformed credentials and bounds signing to at most five minutes and
the credential expiry. Maintain a correctly synchronized host clock.

## Private COS namespace and commit semantics

The
[adapter](../../services/backend-production/src/storage/publishing-cos-store.ts)
maps a database key `blobs/aa/bb/<32hex>` to
`<WORK_MEDIA_COS_PREFIX>blobs/aa/bb/<32hex>` internally. The physical prefix
never changes the database key. Reserve the entire configured namespace
exclusively for this publishing installation. Run exactly one active Backend
process per namespace, including during restart: stop the old process before
starting its replacement. The current in-process runtime needs no extra worker
service. Do not deploy overlapping replicas against this prefix; in-flight
protection is process-local, and a slow active producer need not have a recent
completed part. Development/test/Production installations must not share a
namespace, even if a separately approved bucket is shared.

The target must be private and unversioned. The adapter checks the versioning
response before writes and deletes and refuses Enabled, Suspended, malformed or
unproved state. It sends private ACLs, private/no-store metadata and
forbid-overwrite headers. Administrative policy must preserve that condition;
this task does not change bucket versioning or policy.

The UGC role needs the operations used by the adapter: bucket-versioning read;
namespace-confined object HEAD, GET, DELETE and listing; multipart initiation,
part upload, completion, abort, upload listing and part listing. Prepare the
provider policy against those exact operations. Object authority and list
prefixes must be confined to the configured UGC namespace; bucket-versioning
read is the necessary bucket-level exception. Catalog `display/v1/`, CMS/Admin
and other task objects must remain outside its write/delete authority. Provider
policy acceptance remains an explicitly approved live check.

Writes use sequential 8 MiB multipart parts with bounded memory, count and hash
the actual bytes, verify each part's MD5/ETag, and complete only after stream
validation. Acknowledged completion is followed by an exact-size and upload-
identity HEAD check. Failed or cancelled uploads are aborted; ambiguous
completion cleanup deletes only an object carrying this attempt's identity.
Uncertain cleanup is left for the existing age-gated reconciliation. An
unacknowledged or incomplete upload is never returned as an application blob.

Reads use bounded 1 MiB range requests, pinned to the HEAD ETag, and verify the
returned range and byte length. Closing a read cancels further requests. Removal
is idempotent for absent objects. Object listing returns at most 1000 ordered
logical keys and resumes exclusively after the last returned key;
out-of-namespace or malformed results fail closed. Multipart sweeping has its
own bounded cursor and checks part timestamps before abandoning old uploads.

The
[transport](../../services/backend-production/src/storage/publishing-cos-transport.ts)
reuses installed `cos-nodejs-sdk-v5` 3.0.0 and the existing
[bounded SDK transport](../../services/backend-production/src/storage/cos-sdk.ts):
verified HTTPS, no redirects/host switching, no implicit network retries,
bounded responses and operation timeouts. A fresh SDK instance per operation
keeps cancellation isolated. Errors exposed outside storage are content-free.

For `multipartUpload` only, the configured timeout bounds credential
acquisition, connection setup through the TLS handshake, socket inactivity
during transmission and the wait for complete response headers after the native
request's `finish` event. That event means bytes were handed to the operating
system, not confirmed received by COS. A peer trickling incomplete headers
cannot extend this header bound. The SDK's native socket inactivity timer
remains enabled; Node checks pending native write-queue progress even when the
existing 8 MiB part is submitted as one Buffer. SDK `onProgress`, local Buffer
consumption and queued byte counts are not used to renew deadlines. A
continuously progressing part may take longer than the configured timeout in
total; a stalled part still fails and cancellation destroys its own request.
Catalog/Pilot and every other publishing COS operation retain their existing
total deadline. The environment name, default, maximum, part size,
single-attempt behavior and public/store interfaces are unchanged.

Database recording still follows blob commitment. The existing upload and worker
code performs compensating cleanup for definite recording failures; unknown
transaction outcomes retain objects until their unrecorded state and age are
established. Reconciliation lists only this UGC store. An absent Community row
never permits deletion of a Catalog or Admin object.

## HTTP and Nginx integration owned by the runtime task

The existing browser request is raw
`POST /api/community/publishing/uploads/:componentId`, relayed to
`POST /v1/community/publishing/uploads/:componentId`. Preserve Content-Length,
`application/octet-stream`, upload-attempt/account headers, same-origin checks,
session-cookie-to-Bearer relay and browser-disconnect cancellation. The existing
handler rejects transfer encoding and mismatched registered sizes. Do not add
direct browser-to-COS uploads or a multipart form protocol.

The [Web relay](../../apps/web/lib/public-api/server.ts) has an 8 GiB sanity
ceiling. Both publishing stores retain the existing 4 GiB per-blob sanity bound.
The saved Backend business settings remain authoritative: fresh defaults are 128
MiB per Original logical item and 256 MiB per Standard component, with no
whole-work byte cap. These different existing bounds are not changed here.

The dedicated upload location must reach Web, precede broader Community routing,
and retain the site's existing Host/forwarded-header policy. Required directives
for that location are:

```nginx
client_max_body_size 8g;
client_body_timeout 130s;
proxy_http_version 1.1;
proxy_request_buffering off;
proxy_buffering off;
proxy_cache off;
proxy_next_upstream off;
proxy_connect_timeout 5s;
proxy_send_timeout 130s;
proxy_read_timeout 75s;
```

The Backend's upload idle deadline is 120 s and its early-refusal drain window
is 5 s. The 130 s ingress idle values leave those application decisions time to
complete. The Web relay waits 60 s after the last byte or beginning of an early
answer; the 75 s proxy response value leaves that answer time to return. Nginx
read/send timeouts measure gaps between operations, and disabled request
buffering forwards bytes as received, as documented by
[Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html). They are not
whole-upload deadlines. Keep the Backend's existing
[streaming request-deadline exemption](../../services/backend-runtime/src/server.ts),
and ensure the Web host and any outer ingress do not impose a shorter total
deadline on a flowing upload. Verify this with a slow upload lasting more than
five minutes through the exact intended runtime chain.

The COS operation timeout does not extend the relay's 60 s answer wait. A final
part, completion and HEAD check can together outlast that wait, especially with
a larger configured operation deadline. Preserve the existing unknown-outcome
response and client item reconciliation in this case; an HTTP timeout is not
proof that the blob or database commit failed. Exercise this boundary in runtime
acceptance instead of automatically replaying the upload.

The existing template's Community location has no explicit large-body allowance;
the separate Admin `50m` setting does not cover it. Change only the upload
location's body ceiling. Do not broaden all Community JSON or Payload routes.

Derivative routes retain GET/HEAD and Range, 200/206/416, Content-Length,
Content-Range, Accept-Ranges, private/no-store, Vary and same-origin response
headers. Disable proxy caching and response buffering for those streams. The Web
derivative-header wait is 15 s; its body has no total timeout. COS's per-read
deadline still bounds a stalled storage operation. Do not replace a failed read
with an original or another user's object.

## Processing directory, tools and service requirements

`WORK_MEDIA_WORK_DIR` must already exist as an absolute, normalized, non-symlink
directory owned by the backend user with no group/other permissions (0700). It
cannot be inside a Git tree, `/tmp`, `/private/tmp`, `/var/folders`,
`/private/var/folders`, or another configured media namespace. Production keeps
retained objects in COS and working input/output copies in this separate local
directory. Job input copies are removed by normal disposal or abandoned-job
sweeping; they are not retained-media backups.

The existing
[runner](../../services/backend-production/src/publishing/processing/media-tools.ts)
needs `docker` in the service PATH, access to the intended Docker daemon, and
bind mounts of the host processing directory visible to that daemon. Restrict
service writable paths to this directory and the daemon facilities it actually
needs; the current `ProtectSystem=strict` service requires an explicit writable
directory allowance. Choose a location accessible with `ProtectHome=true`.
Retain `UMask=0077` and the existing backend identity. Confirm the chosen daemon
access model as part of runtime integration; do not silently remove service
hardening or install another worker service.

Reuse sharp 0.35.4 and the capabilities of the pinned existing
[media-tools image](../../infra/development/work-publishing/media-tools/Dockerfile):
FFmpeg 7.1.5, libheif 1.19.8, libde265 1.0.15, libx264, AAC, zscale/tonemap and
coreutils timeout. That Dockerfile is explicitly Development-only; Production
must prepare and validate a local pinned image with the same required
capabilities. This task neither upgrades dependencies nor certifies an image on
the real host. The runner uses `--pull never`.

Each tool container runs without network, with a read-only root, all
capabilities dropped, no-new-privileges and uid/gid 10001. Its existing limits
are 1536 MiB memory, 2 CPUs, 256 PIDs and a 512 MiB temporary filesystem. Only
the current output directory is writable; input mounts are read-only. Tool
deadlines remain 60 s for HEIF decoding, 20 s for probing and 180 s for motion
conversion, with a 10 s independent container timeout margin. The output-file
bound remains 1 GiB. See the authoritative
[profiles](../../services/backend-production/src/publishing/processing/profiles.ts).

Worker concurrency 1–4 bounds simultaneous tool containers. Provision at least
the configured concurrent sandbox memory allowance plus measured backend, sharp,
OS and other-service headroom. Sharp's JPEG/PNG/WebP processing runs in the
backend process and is not covered by Docker's memory limit. Local disk must
cover concurrent source copies, decoded stills, accepted outputs and temporary
output copies; one active job may contain more than one component/output. Do not
treat the 8 MiB upload part buffer as a complete host-memory or disk
requirement. Host capacity measurements with representative synthetic workloads
remain part of runtime acceptance.

## Existing worker and database obligations

Keep the
[existing PostgreSQL worker](../../services/backend-production/src/publishing/worker.ts)
in the backend process. Its defaults are concurrency 1, 1 s polling, a renewed 5
min lease, expired-lease requeue every 30 s, cleanup scheduling every 60 s,
staging sweep hourly and store reconciliation every 6 h. Existing
[handlers](../../services/backend-production/src/publishing/job-handlers.ts)
check processing cancellation every 10 s, sweep leftovers older than 6 h, and
reconcile at most 20 pages of 1000 objects per run. Unrecorded committed objects
require the greater of the saved orphan grace and one day; the fresh setting is
7 days. Referenced media remains retained.

Shutdown can use 30 s to finish jobs and up to three additional 5 s
abort/release waits. Set the backend systemd `TimeoutStopSec` to at least 60 s,
and preserve worker-stop-before-pool-close ordering. The current 30 s template
is too short for that worker bound. Other runtime shutdown work must also fit
the selected deadline. Crash recovery remains lease expiry/requeue plus
namespace-confined staging and object reconciliation; no Redis or second queue
is needed.

No new SQL field or migration is required by this adapter. Existing
[`media_blobs` key constraints](../../database/community-migrations/20260914090000_work_publishing_storage.sql)
continue accepting the unchanged logical keys. The database task must apply and
verify the current migration ledger and runtime permissions for media items,
components, blobs, derivatives, item references, jobs, settings, capacity,
sessions and their existing functions. Use the exact current
[App-role grants](../../infra/development/work-publishing/grant-runtime.sql) as
the source, retaining column-level updates, immutable identities/manifests, no
DDL from startup and separate `APP_DATABASE_URL` authority. Do not reset saved
limits/publication policy or rewrite retained `user_media` rows.

## Evidence boundary and outstanding live acceptance

Deterministic SDK/transport seams and filesystem tests are offline engineering
evidence. They do not establish Tencent service behavior, actual policy scope,
real-host tool availability or a launched product. This task performs no real
bucket creation, policy/versioning change, object upload/deletion, service
installation or retained-media migration.

After separate approval names an exact task-owned COS target and allowed
operations, verify:

1. Private access, scoped identity, denied cross-namespace
   writes/deletes/listing, and accepted unversioned-state response;
   enabled/suspended versioning must fail closed.
2. Multipart checksum/ETag behavior, forbid-overwrite at completion, exact
   post-commit HEAD metadata, single/range reads, absence and idempotent delete.
3. Interrupted/aborted initiation, part upload and completion; ambiguous commit
   cleanup and restart sweeping without retaining false application blobs.
4. Multi-page object and multipart listings, namespace boundaries, old
   unrecorded cleanup, retained-reference protection and capacity reconciliation
   against the task-owned database.
5. Credential expiry/rotation, TLS failures and per-operation timeout behavior
   without printing credentials or signed requests.
6. Complete upload and read journeys through intended Nginx/Web/Backend routes,
   slow flowing uploads, idle rejection, cancellation, Range/HEAD responses and
   shutdown/restart recovery.
7. Synthetic supported still and Live Photo processing using the exact pinned
   Production image, service identity, sandbox flags, directory mounts and
   measured CPU/memory/disk budget. Native import/device acceptance remains a
   separate existing boundary.

Record the target, approved operations, exact code/image versions, counts and
content-free outcomes in private evidence. Code review or merge does not
authorize these operations or establish full release acceptance.
