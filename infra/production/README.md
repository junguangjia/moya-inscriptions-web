# Production topology readiness

This directory prepares code and deployment templates for a future partner-owned
Tencent Cloud CVM, TencentDB PostgreSQL and private COS. **It does not execute a
deployment.** Current cloud resources and production content have not migrated;
Stage B, production release, content cutover and XLSX write-entry retirement
have not happened. Partner-account resources, TencentDB and formal COS are not
yet created. Existing Owner-account testing remains separate evidence.

The architecture remains `apps/web` Public Web, `apps/admin` Payload Catalog
Admin, and `services/backend-production` as the only public Backend composition.
Payload published views and Search V1 retain existing CatalogId/SourceId/MediaId
and API behavior. TencentDB is standard PostgreSQL; application code does not
use a Tencent database SDK. Local development has its own
[guide](../../docs/development.md); staging uses this same topology with
isolated resources and the overlay in `../env/staging.env.example`.

## Full release runtime integration (Issue #191)

The Owner selected one full release of the implemented product. The current
integration promotes the existing human business routes, Web session consumers,
Admin operations and notification worker to Production-capable composition. This
is code preparation and local synthetic acceptance, not deployment. The
[runtime scope and dependency record](../../docs/production/full-release-runtime-v1.md)
supersedes older Development-only availability statements for those business
surfaces only. QA, local verification providers and test sign-in stay excluded.

`/api/community/` stays with Web, including profile/settings, social activity,
publishing, Threads, messages, human Article authoring, auth and notifications.
The notification stream disables Nginx buffering; its existing Backend heartbeat
and session checks are preserved. Internal operator endpoints are never proxied
directly; Admin retains its Owner authorization and private Backend credential.

The continuation integrates the existing Production auth provider factory and
B's accepted COS factory/store/worker, plus explicitly configured Article
OAuth/MCP. Real email/SMS activation/delivery remains deferred. Full candidate
acceptance and C's forward Article environment migration are recorded in the
[runtime record](../../docs/production/full-release-runtime-v1.md); template
presence is not acceptance. Startup only validates protected configuration,
readiness and migration ledgers. It never sends verification messages, migrates,
grants, pulls an image or makes COS setup requests.

## Controlled password-only acceptance

For a release with real verification delivery disabled, use
`AUTH_PUBLIC_ENABLED=true`, `AUTH_PROFILE=password-only`,
`AUTH_EMAIL_PROVIDER=disabled`, and `AUTH_PHONE_PROVIDER=disabled`. Remove all
`TENCENT_SES_*` and `ALIYUN_*` delivery settings from that Backend environment.
Keep the existing dedicated auth key configuration: it protects rate-limit
identifiers and encrypted login receipts even when no OTP is sent. The existing
login form accepts a controlled account handle and password. Verification
registration/login, password recovery, and contact binding/unbinding are
unavailable on both the UI and service entry points. Provisioned accounts have
no verified email or phone; their sessions carry `password_login` provenance.

Apply the forward community migration and named runtime grants before startup.
The App role has SELECT only on `community.operator_password_accounts`; it must
not own that table, inherit an operator role, or receive write grants on it. An
operator uses `scripts/provision-password-account.mjs --input <private-file>`
with the built server packages, `NODE_ENV=production`,
`AUTH_PROFILE=password-only`, and a separately protected
`APP_PROVISION_DATABASE_URL` (plus `APP_PROVISION_DATABASE_SSL_CA_FILE` if
needed). The dedicated operator connection uses the existing verified TLS parser
and never falls back to App credentials. Do not put connection strings or
passwords in command arguments or logs.

The input is an operator-owned regular JSON file with mode `0600`, no symlink,
and exactly these fields: `requestId` (stable UUID), `handle` (3–32 lowercase
letters/digits/hyphens, beginning with a letter), `displayName` (1–40
characters), `environment` (`production`), `operatorLabel` (3–64 lowercase
letters/digits/hyphens, beginning with a letter), and `password` (the existing
password policy). Create it through a protected input mechanism; keep its
password out of shell history. A matching retry returns the existing account.
Reused identifiers, changed input, existing unprovisioned handles, inactive
users, or changed initial credentials fail without resetting or adopting an
account. Provisioning is transactional and audited; it does not create contacts,
challenges, or sessions. Use the normal website login to verify each account.

The Admin Owner is a separate native Payload user. On a migrated, empty Admin
user table, run
`pnpm --filter admin exec payload run scripts/provision-initial-owner.ts` with
the protected Admin configuration, `CMS_ENVIRONMENT=production`, and
`CMS_INITIAL_OWNER_INPUT` pointing to a mode `0600`, operator-owned regular JSON
file containing only `email` and `password` (20–128 characters). The command
serializes setup, refuses any nonempty user table, and creates one native Owner
without an API key. Then use normal Admin login. Outside the synthetic test
profile, both the native public `/api/users/first-register` endpoint and the
`/admin/create-first-user` page are closed. This command is initial
provisioning, not a password reset or public-user privilege promotion.

These instructions describe the operator boundary. Local synthetic checks do not
establish that a release was deployed or that real acceptance passed.

## Product access (closed beta)

`PRODUCT_ACCESS_MODE` in the private Backend environment is `closed-beta` or
`public`; the Backend refuses to start without one of them. In `closed-beta`
only the accounts named in `PRODUCT_ACCESS_ALLOWLIST_FILE` reach product content
and commands; everyone else can only open the sign-in flow. The file is private
JSON owned by `yoyi-backend` with mode `0600`. Replacing it adds or removes a
tester without a restart, and a missing or invalid file denies every account.
Validate a candidate before installing it with
`node services/backend-production/dist/access/check.js --file <candidate>`. The
full procedure — adding and removing testers, opening the product later, and a
rollback that keeps access restricted — is in
[`docs/production/closed-beta-access-v1.md`](../../docs/production/closed-beta-access-v1.md).

## Existing processes behind Nginx

| Process        | Unix identity                | Listener         | EnvironmentFile                       |
| -------------- | ---------------------------- | ---------------- | ------------------------------------- |
| Web            | `yoyi-web`                   | `127.0.0.1:3000` | `/etc/yoyi/web.env`                   |
| Backend        | `yoyi-backend`               | `127.0.0.1:3001` | `/etc/yoyi/backend.env`               |
| Admin          | `yoyi-admin`                 | `127.0.0.1:3002` | `/etc/yoyi/admin.env`                 |
| Article issuer | `yoyi-article-authorization` | `127.0.0.1:3003` | `/etc/yoyi/article-authorization.env` |

All names, paths, hostnames and provider identifiers in these templates are
fictional examples. Replace them in private deployment input after actual
resource and release authorization. Do not commit real values or write them to
logs. The services use independent non-login users, read-only code,
`NoNewPrivileges`, strict filesystem protection, no capabilities,
`Restart=on-failure` and SIGTERM. Backend has a90-second graceful-stop deadline
for notification/publishing shutdown before pools; Web/Admin/issuer retain30s.
Listener arguments are fixed in `ExecStart` so an environment file cannot expose
a process port. Startup performs readiness checks; it never executes migrations
or DDL.

Web uses `scripts/start-production.mts` through both `pnpm start` and its unit,
with Node 24's native TypeScript support and the public Next custom-server API.
The exact raw component POST upload path can run beyond five minutes while body
bytes keep arriving. Its 120-second body idle limit, 8 GiB ceiling and 16 active
upload slots are enforced without buffering; the response is bounded to 75
seconds after the last body byte. Other requests retain the 300-second total
body deadline and 120-second idle limit, with the existing 1 MiB default, 4 MiB
profile media and 1040 KiB Article request ceilings. All paths keep the
60-second header deadline, 16 KiB header cap, 100 header count, 512 connection
cap and 5-second keepalive. These are startup code limits, not environment
overrides. The existing relay, Backend and Nginx authorization/stream limits
still apply. Development continues to use `next dev`; do not replace the
Production wrapper with `next start`, whose native total-body deadline would
interrupt long uploads.

A future deployment operator must install Node 24/pnpm 11.9.0, create the four
service users, provide a readable release at `/srv/yoyi/current`, create the two
Next.js `.next/cache` directories writable only by their respective users, and
prepare `/var/lib/yoyi-admin/media` for Admin-only temporary media writes. All
other release files remain non-writable to runtime users. systemd manages the
Admin state directory. Provision `/etc/yoyi` as root-controlled and each private
EnvironmentFile as root-owned mode `0600`; systemd reads the file before
dropping privileges. CA files contain public certificates and must be readable
by the corresponding service user. TLS private keys are readable only by the
ingress identity that needs them.

`nginx/yoyi.conf.template` uses one public hostname: `/admin` and Payload
management APIs reach Admin; the existing public `/api/catalog`, detail and
`/api/catalog-search` routes remain with Web. `/editorial-preview/:id` remains
with Web and its server calls `CMS_INTERNAL_URL=http://127.0.0.1:3002`.
`CMS_PUBLIC_URL` and `CMS_PREVIEW_WEB_URL` must use the same hostname to
preserve Payload's host-only preview cookie. The Admin production build uses
`assetPrefix=/admin-assets`; Nginx strips that prefix when serving its static
JS/CSS from Admin. Web retains `/_next/static`. Current Payload thumbnails use
native media URLs, not Next image optimization; no new image optimizer is added.
Admin uses only the existing owner/automation permissions. Only Nginx exposes
HTTPS; database and process ports are not public ingress. Deployers must
explicitly validate rendered Nginx config (`nginx -t`), units
(`systemd-analyze verify`) and directory access before activation. No
certificate issuance, firewall edits, installation, service activation or cloud
requests run in this task. No Swarm, Kubernetes, PM2, Redis or extra controller
is introduced.

## Database roles, pools and verified TLS

A single TencentDB instance and single database can host the future Payload and
community domains, with different login roles and privileges. Variable names are
preserved:

| Variable            | Purpose                 | Permission boundary                                                            |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `CMS_DATABASE_URL`  | Payload runtime         | CMS tables and published projection maintenance; no public/community authority |
| `DATABASE_URL`      | Public Backend          | CONNECT, schema USAGE and SELECT only on approved published projections        |
| `TEST_DATABASE_URL` | Disposable test runtime | A separate synthetic target; never production or Stage A data                  |
| `APP_DATABASE_URL`  | Community Backend       | CONNECT, USAGE and DML only on the `community` schema (public users, sessions) |

The same-target option concerns runtime domains, not permission to run tests on
production content. Every runtime uses a distinct login; Web uses HTTP and never
receives database credentials. The Backend's Payload projection allowlist is
`catalog_entries`, `catalog_aliases`, `catalog_contributors`,
`catalog_source_citations`, `catalog_source_citation_scopes`, `catalog_media`
and `catalog_search_documents`, plus column-only `SELECT (name)` on
`payload_migrations` for startup readiness. Grant only SELECT on those named
relations, not `ALL TABLES` or default privileges exposing future draft tables.
The search table contains the maintained published-only search projection. No
write/schema-create privilege belongs to the public role. Separate controlled
migration authority may create/change the selected schema and install required
`pg_trgm`; runtime startup never receives permission by automatically executing
DDL.

The Backend pool explicitly defaults to 5 (`DATABASE_POOL_MAX`); Payload retains
its fixed `max=5`. `DATABASE_IDLE_TIMEOUT_MS` defaults to 10000 milliseconds.
Choose the instance connection budget after counting both pools, independent
instances and controlled operational connections.

The supported server majors are PostgreSQL 16 (minimum) and 18; the Backend
refuses any other major at startup, and the named runtime grants apply on both
([baseline](../../docs/deployment/postgres-18-readiness-and-migrations.md)).

Use `sslmode=verify-full` in each remote database URL. Optional
`DATABASE_SSL_CA_FILE` / `CMS_DATABASE_SSL_CA_FILE` supplies a custom CA when
the provider requires one; otherwise TLS uses system trusted CAs. TLS always
verifies CA and hostname. Never set `rejectUnauthorized=false`, use
`NODE_TLS_REJECT_UNAUTHORIZED=0` or replace verification with an insecure URL
mode. Real DB passwords and CA file locations stay in private EnvironmentFiles
and controlled configuration.

## Explicit migration routing

Build the release and shared server packages before selecting a migration. Set
exactly one source in the controlled environment, then invoke `pnpm db:migrate`:

| `MOYA_CONTENT_SOURCE` | Only permitted migration family                                  |
| --------------------- | ---------------------------------------------------------------- |
| `legacy`              | `database/migrations` via the catalog-postgres migration runner  |
| `payload`             | `apps/admin/src/migrations` via Payload's official migration CLI |

Unset or invalid source fails closed. The dispatcher probes schema identity
before execution and rejects mixing legacy relations with Payload published
views. Never execute legacy migrations in a new Payload database, or install
Payload's same-name views into a legacy database. A content-source environment
value is not cutover authority. Target verification, migration credentials,
backup/restore and real-content migration require the separately approved
production operation. Do not run either migration command as service startup.

## COS and environment boundaries

Start from the four `env/*.env.example` files, with private resource values
provided per service. `web.env` contains the loopback Backend URL, internal CMS
preview URL and two dedicated server-only source-admission credentials.
`backend.env` contains the published-read DB role and the independent COS read
runtime. `admin.env` contains Payload's own DB role, secret, URLs and COS write
configuration. Missing required production settings fail closed. Staging uses
these same contracts with distinct database roles, origins and private bucket.

Since `0a4ab863` (#312) the Backend's discovery (home feed browse, collections,
cards and filter options) reads the published-only Payload view
`public.catalog_discovery` through the published-read role (`DATABASE_URL`), not
the App role. That role needs `SELECT` on the view and nothing beneath it;
`infra/development/grant-public-read.sql` names it. Apply that grant with the
setup role before restarting a Backend of that release: startup refuses with
`Catalog discovery view is not readable` when the role cannot read the view
([release grant step](../../docs/deployment/full-release-database-v1.md)).

Wide screens (a PC, or a tablet at least 896 px wide) show the Web product as
browse-only to visitors without an account, and `/login` and `/register` return
them to Home. The optional `web.env` value `MOYA_WIDE_SCREEN_BROWSE_ONLY=off`
(also `false` or `0`) turns this off; Web reads it per request but only re-reads
`web.env` when the service restarts.

For authentication limits, Nginx overwrites source headers with its actual
network peer and the protected Web `AUTH_INGRESS_TOKEN`. Render only the named
`__AUTH_INGRESS_TOKEN__` marker into the private Nginx configuration; retain its
0600 protection and never commit or print the rendered value. Web validates this
proof before forwarding the canonical source with a different
`AUTH_SOURCE_RELAY_TOKEN`, which matches Backend's protected value. Both keys
must differ from each other and the Admin/operator credential. Arbitrary
`Forwarded`/`X-Forwarded-For` or direct Backend headers confer no source
authority. Browsers sharing one real network/NAT address still share its
intended limit. Live credential provisioning remains separately authorized
deployment work.

`ProductionCosStorageUrlResolver` uses the existing official COS SDK signing,
short lifetimes, timeout and error handling against an already-authorized
database object key. It does not upload, consume a Pilot manifest, enforce a
20-object ceiling, or make a bucket public. Pilot upload/manifest guards remain
inside the Pilot module. Non-Pilot composition resolves only keys returned by
the published database projection. Public API keeps only `PublicMedia.src`; no
independent bucket, region, objectKey, credential or signature fields are added,
and clients cannot request arbitrary object keys. The browser reads the signed
COS URL directly. No media proxy or new public HTTP Contract is introduced.

`COS_MEDIA_ORIGIN` must be a verified custom HTTPS media domain such as
`media.example.invalid`, hiding provider bucket/region from the hostname. The
resolved URL path may contain its existing opaque MediaId/hash/SHA key. Never
construct production keys from titles, usernames, emails, local paths or
original folder names; do not rename previously approved keys. Stage B must
verify actual domain binding, TLS, URL signing, expiry and tamper rejection.
Offline SDK tests in this PR do not substitute for that cloud acceptance.

`COS_SIGNED_URL_TTL_SECONDS` is 300 in the template, with an allowed range of
60–600 seconds. Request timeouts and configuration errors fail closed. Signed
URLs are not persisted or logged, Public responses remain uncached, and pages
retain `no-referrer`. Withdrawal stops new URLs; previously issued URLs can
remain usable until expiry, and downloaded bytes cannot be recalled. Drafts,
Admin preview and future private UGC use authenticated permission interfaces.

After filing and formal public launch, a separately scoped custom CDN with
private COS origin authentication and necessary URL authentication can replace
the resolver without changing PublicMedia or Web. No CDN/EdgeOne implementation
is included here. COS permissions, credentials and real objects are configured
only in a separately authorized operation; this task makes no live COS requests
or uploads.

The Backend owns public identity/community through the separate
`APP_DATABASE_URL` runtime role (Community V1, Mission 2A). That role receives
`CONNECT`, `USAGE` on schema `community`, `SELECT` on `community.public_users`,
`community.development_accounts` and `community.schema_migrations`, and
`SELECT, INSERT, UPDATE` on `community.sessions` — never DDL, never a Catalog or
CMS relation; `infra/development/grant-community-app.sql` is the local model for
that Production composition. A Development host that also composes the Phase 4
and work-publishing surfaces applies
`infra/development/work-publishing/grant-runtime.sql` after it (column-level
`UPDATE`, `SELECT` on the published `catalog_discovery` / `catalog_media`
projections that discovery reads); which of the two sets becomes the Production
App-role contract once those surfaces are promoted is an Owner decision recorded
in `docs/community/data-admin-hardening-v1.md`. Community migrations run only
through `pnpm db:migrate:community` with a separately provisioned
migration-privileged role (`APP_MIGRATION_DATABASE_URL`, never placed in
`backend.env`). The Backend refuses to start without `APP_DATABASE_URL` and
verifies the community ledger read-only, so on any host the order is fixed:
provision the App role → `pnpm db:migrate:community` with the migration role →
apply the App-role grants → set `APP_DATABASE_URL` in `backend.env` → restart
the Backend; restarting before those steps fails closed. Mission 2B adds
comments, the publication setting and the moderation audit in the same namespace
under the same role (`SELECT, INSERT, UPDATE` on the two comment tables,
`SELECT, UPDATE` on `community.publication_setting`, `SELECT, INSERT` on
`community.moderation_events`, column-only `UPDATE (status, updated_at)` on
`community.public_users`; still no DELETE and no DDL anywhere). It also adds
`COMMUNITY_OPERATOR_TOKEN`: a 32-512 character shared credential Admin holds
server-side to reach the Backend's loopback-only `/internal/community/*`
boundary, and `COMMUNITY_OPERATOR_BASE_URL`, the dedicated origin Admin calls it
on. Put the same token in `backend.env` and `admin.env`, rotate them together,
and never expose it to a browser or a public ingress; leaving it unset keeps the
boundary closed and the Owner's moderation view reports that it is not
configured. The base URL must resolve to loopback whatever its scheme, and Admin
refuses to start a call otherwise. Admin's own moderation endpoints answer under
`/api/community-moderation/*`, clear of the public `/api/community/*` read
surface; each validates its complete request envelope strictly and forwards only
the command body to the Backend route. Forward migration `20260912100000` adds
the audited `reject` action (pending → hidden) and an index for per-item
history; deploy it before restarting the Backend, which verifies the ledger
read-only. Nginx forwards no `/internal/` path and the Backend listens on
loopback only, so that boundary is never publicly reachable. No Production
sign-in path exists: the Development test-account entry is composed only under
`NODE_ENV=development`, and external identity providers remain deferred. Payload
users remain owner/automation only. Future UGC media receives an independent
storage boundary. QA filtering remains QA-only; no hard-coded
dynasty/script/type/region taxonomy enters production contracts or tables. This
task prepares the existing code and local development environment to connect
future CVM/TencentDB/COS; it does not release those domains or resources.

## Full-release media and formal Article wiring

B PR194 is consumed from main d434fac2060745d5ed29696197ca1cb857360c66. Since
the unified media pipeline (increment 1) media is processed by a separate
process, `yoyi-media-worker.service`
([template](systemd/yoyi-media-worker.service),
[environment](env/media-worker.env.example)); the Backend
(`WORK_MEDIA_WORKER=external`, the Production default; `embedded` is refused)
opens only the COS store from `WORK_MEDIA_COS_*` and shares it with
upload/read/Article thumbnails, and keeps one loop that claims only session
expiry and staging sweeps and also runs the shared, idempotent lease requeue and
cleanup scheduling, so sessions expire while the worker is down. One transfer
registry handles cancellation. Do not set `WORK_MEDIA_STORE_DIR` or reuse
Catalog/Payload credentials in the UGC keys. Exactly one process, the Backend,
claims staging sweeps of an exclusive `ugc/publishing/<namespace>/`; the worker
completes its own multipart writes well within the six-hour sweep age.

The media worker uses the same UGC identity and App role as the Backend, the
public read role for the published Catalog list, the dedicated Catalog
source-read identity (`CATALOG_SOURCE_COS_*`) for Catalog source reads through
the COS API endpoint, a local pinned `WORK_MEDIA_TOOLS_IMAGE` (the
[media sandbox image](../development/work-publishing/README.md), built on the
host from its pinned inputs) and its own 0700 `WORK_MEDIA_WORK_DIR`, owned by
the worker's dedicated user. Each job runs in one no-network sandbox container
(1 CPU, 1536 MiB without swap, 256 PIDs, size-capped tmpfs, no writable host
path, read-only release `dist`); concurrency stays 1 on a two-vCPU host. Its
unit has `MemoryMax=512M`, `TasksMax=64` and `RestartPreventExitStatus=78`:
startup exits 78 on a configuration or sandbox isolation mismatch (no restart)
and 75 when the container daemon or image is unavailable (restarted). It opens
no listener.

The Catalog source keys were renamed from `COS_*` to `CATALOG_SOURCE_COS_*` in
`0a4ab863` (#312); the worker no longer reads `COS_*` for Catalog sources.
Without the whole `CATALOG_SOURCE_COS_*` namespace, or without `DATABASE_URL`,
it starts with Catalog rendering off and does not claim `catalog_render` jobs.
Startup then names the reason (setting names only) before the
`[media-worker] ready … catalog=off …` line, for example
`[media-worker] catalog=off reason=source_unset: CATALOG_SOURCE_COS_* is not set; catalog_render jobs are not claimed`.
When only the retired `COS_*` keys are present the reason is
`source_keys_renamed`, logged at error level. After each worker restart, check
that the ready line says `catalog=on`.

Worker rollback across the rename: a worker before `0a4ab863` (for example
`c29dfd61`) reads Catalog sources only from `COS_BUCKET`, `COS_REGION`,
`COS_SECRET_ID` and `COS_SECRET_KEY` (plus `COS_SECURITY_TOKEN` and
`COS_CREDENTIAL_EXPIRES_AT` for temporary credentials). Without them it still
claims `catalog_render` and fails each job as retryable `catalog_unavailable`,
using up its attempts. Before rolling the worker back, put the same source-read
identity under those `COS_*` names in `media-worker.env` and its staged copy, or
keep the worker stopped. The current worker ignores `COS_*`, so both namespaces
can stay side by side for the rollback window. When rolling forward again, keep
`CATALOG_SOURCE_COS_*`, remove the `COS_*` copy, and check for `catalog=on`.

Only the exact component upload route has8GiB ingress. It streams with request
and response buffering/cache/retry disabled and130s body/send and75s response
idle limits. Derivative GET/HEAD/Range preserves200/206/416, private headers and
stream cancellation. Profile PNG remains4MiB; human Article and MCP document
commands use1MiB+16KiB envelopes. Ordinary Community requests retain1MiB.

The Backend unit has no writable path and no container daemon access. The media
worker runs as its own user, `yoyi-media`, which alone owns the rootless
container daemon (its socket in that user's runtime directory) and the job
workspace `/var/lib/yoyi-media/publishing-work` (0700), the only path the worker
unit may write. A shared user is not a boundary: a same-user process can reach
another process's mount namespace through `/proc`. Host-local units and drop-ins
(not in this repository) provide the daemon readiness gate and the host metadata
guard that the unit's `REPLACE_ME_*` `Requires=`/`After=` lines name, and bind
only that daemon's socket read-only; set its local Unix socket in the private
`DOCKER_HOST`. Remove any earlier drop-in that gave the Backend unit a daemon
socket. Do not add either service to a rootful Docker group or remove hardening.
The Docker CLI must be in the service PATH, the daemon must see the host bind
paths, and the release `dist` must be world-readable (`o+rX`) for the sandbox
user. Activation order: stop the worker first (its drain is not part of the
serving outage), swap and start the app units, then start the worker last; stop
the worker before any on-host build or prepare step (the queue is durable).
Validate real host mounts, sandbox limits, image capabilities, memory/disk
capacity and shutdown with
`node services/backend-production/dist/worker-main.js --sandbox-check` and the
active bound probes `--sandbox-bounds-check` (worker stopped) under the worker's
unit properties, and show from the Backend unit's properties (its user and
hardening) that the worker's daemon socket cannot be connected and its job
workspace cannot be read; local offline acceptance does not certify the eventual
Linux host. A rollback to the previous release restores its Backend unit (with
its `ReadWritePaths`), its daemon drop-in and the Backend user's daemon, and
relies on the rollback-retained `WORK_MEDIA_TOOLS_IMAGE`, `WORK_MEDIA_WORK_DIR`
and `WORK_MEDIA_WORKER_CONCURRENCY` in `backend.env`; the media worker stays
stopped. See B's
[exact media requirements](../../docs/development/full-release-media-v1.md) and
the
[unified media pipeline record](../../docs/development/unified-media-pipeline-v1.md).
No daemon installation, group change or service activation runs here.

The additional Article issuer uses `yoyi-article-authorization.service`,
loopback3003 and the separate HTTPS cookie host `article-auth.example.invalid`.
Nginx overwrites Host and trusted HTTPS forwarding headers and clears Forwarded.
Backend exposes only exact `/mcp/article-authoring` and its protected-resource
metadata, plus the existing authenticated human consent/approval routes. Generic
Admin Agent/OAuth remains Development-only. The issuer does not share its
private signing JWKS or SQL credential with Backend/Web. Backend has App and
separate Article-control credentials; issuer has only its own SQL credential.
Role-only `*_DATABASE_TARGET` metadata cannot contain passwords. Public-read,
CMS, App/resource, Article-control and Article-issuer must remain five distinct
roles on one database, with verified TLS for remote PostgreSQL.

Prepare the dedicated private RSA signing JWKS outside Git and approved client
registry through the existing parser. The signing file must be nonsymlink,
single-link, mode0600 and owned by the issuer service identity (the loader
checks uid); its parent remains root-controlled. Likewise the optional
registration agreement JSON is readable by Backend alone. Root-owned0600
EnvironmentFiles are loaded by systemd before dropping privileges; this does not
make referenced private files service-readable. Do not change permissions
broadly to fix that. All keys use their documented canonical encoding and
separate purposes.

Configure `AUTH_PUBLIC_ENABLED=true` with Tencent SES and optionally Aliyun
Dypns. Missing approved agreement material closes registration only; malformed
material refuses startup. Existing-account sign-in/recovery/binding/logout reuse
existing proofs, receipts and Production verified-login Sessions. Production
rejects Development/legacy Session provenance. Provider HTTP is signed, bounded,
exactly one attempt, never startup delivery and never an environment-selected
test endpoint. Code-only low-level dependency injection exists solely for
isolated acceptance; main selects real transports. Real providers, approved
legal copy, external client and real COS verification remain separately recorded
gates.

## Profile image switches (increment 3a)

Profile image renditions (avatars and covers; see the
[unified media pipeline record](../../docs/development/unified-media-pipeline-v1.md))
have one switch per service:

- `MEDIA_PROFILE_RENDER` in `media-worker.env`: the media worker claims
  `profile_render` jobs and runs the paced profile sweep, which also backfills
  the existing avatars and covers.
- `MEDIA_PROFILE_RENDITIONS` in `backend.env`: the Backend adds `renditions` to
  profile and people `AuthorMedia`. While it is off those answers carry no
  `renditions` key and are otherwise identical to the previous release's, except
  that an owner's own `nextAvatarChangeAt` is always `null`, because the
  avatar-limit removal shipped in the same release.

Each accepts only `on` or `off`; any other value refuses startup with a message
that names the key only (the media worker exits 78). A missing or empty value
means `on` in Development and `off` in Production. The Production Backend does
not read `MEDIA_PROFILE_RENDER`, because it never hosts the worker.

Both templates carry `off`, and Production stays off until the release steps
turn the switches on, one at a time, each as a separately approved operation:

1. The release starts every service with both switches off.
2. After the migration, the Backend's readiness check and the sandbox
   self-check, the media worker starts with `MEDIA_PROFILE_RENDER=off`. Once a
   normal job has drained, it restarts with `on` and the backfill begins.
3. `MEDIA_PROFILE_RENDITIONS=on` follows, with a Backend restart, no earlier
   than 72 h after the release and only after the Owner's checks pass (preview
   sign-off, real-device checks, and at least 95% of profile images rendered
   with every failure explained). Setting it back to `off` restores the previous
   answers.

## Catalog direct publish switch

An Admin built with the Catalog delivery guard (from #320 on) refuses to publish
a record whose `editorial/` image has no complete, current-recipe and published
rendition set: the Publish button, publish-approved and the MCP
`editorial_publish_approved` tool all answer 409
`CATALOG_DELIVERY_PREPARATION_REQUIRED`, and only the prepare/release flow can
publish such a record. The Admin has no prepare or release controls yet.

`admin.env` takes `CMS_CATALOG_DIRECT_PUBLISH` (`off` or `on`; absent or empty
means off) for that gap. With `on`, every publish skips the guard and works as
it did before the guard existed: the record goes public at once, the media
worker renders its published images, and the public Catalog answer leaves an
image out until its renditions are ready. Any other value (`ON`, `true`, a typo)
refuses to load the Admin's configuration, which stops both the Admin and
`payload migrate`. The value is read when the Admin starts, so changing it needs
an Admin restart; change the staged copy in `/etc/yoyi/production-v3/` too. It
changes nothing in the Backend, the worker or the prepare chain. Turn it back to
`off` once the Admin's prepare and release controls are in use.

## Catalog scale: database steps of increment 1B (catalog-scale-v1)

Increment 1B of Issue #323 adds CMS migration
`20261024_000000_catalog_delivery_live_prepare` (M2: the private prepare view
becomes `security_barrier`, the live projection
`catalog_delivery_live_prepare_media` and its index
`catalog_delivery_intents_state_ended` are created) and App migration
`20261024010000_catalog_publication_scope` (A1: the scoped reconcile's dirty
queue `community.catalog_publication_dirty`, its one-row state
`community.catalog_reconcile_state`, three partial indexes and the index
`media_publications_rendition` that a Catalog job's inspection reads
publications by). It follows 1A's CMS migration
`20261023_000000_catalog_media_keyed_reads` (M1).

A media worker or Backend of 1B starts only after both migrations and their
grants. At startup each checks, read-only, that the App role holds every
privilege the reconcile uses on A1's tables, that A1's one state row exists,
and, where `CATALOG_PREPARE_DATABASE_URL` is set, that the prepare reader can
read both private prepare views. Otherwise it refuses and names what is missing
(relation, column and privilege names only), for example
`[media-worker] startup failed: Catalog publication scope is not ready for the App role (missing SELECT on community.catalog_publication_dirty, …)`
or
`[backend-production] startup failed: Catalog prepare reader cannot read public.catalog_delivery_live_prepare_media: …`.
Its ledger check also refuses while A1 is missing.

The Owner runs each step separately, in this order, in the protected migration
or setup session the sections above describe. Payload migrations run through
`pnpm db:migrate` from the named release checkout, with `MOYA_CONTENT_SOURCE`
set to `payload` and the migration-privileged `CMS_DATABASE_URL` (Explicit
migration routing above); `payload migrate` applies every pending migration as
one batch, so a migration is a batch of its own only when it is the one pending
migration of that checkout.

1. Only if `20261020_160000_catalog_delivery_intents` has not run in Production
   yet: run the Payload migrations once from the #320 checkout, so it is a batch
   of its own.
2. M1, as a batch of its own: run the Payload migrations from the 1A checkout,
   which holds M1 but not M2 (skip this step if a 1A release already applied
   it). Run it at low traffic: the view swap waits at most 5 s (`lock_timeout`)
   behind a long reader, and a run that fails with `55P03` left nothing behind
   and is simply repeated.
3. M2, as a batch of its own: run the Payload migrations from the 1B checkout.
   It builds the index on `catalog_delivery_intents` and replaces or creates the
   two private views under the same 5 s `lock_timeout`; repeat it after a
   `55P03`.
4. Only where `CATALOG_PREPARE_DATABASE_URL` is set, or is about to be set, for
   the media worker or the Backend (the prepare reader is optional, and both
   Production env examples leave it unset): re-run
   `infra/development/catalog-media/grant-prepare-read.sql` with
   `--single-transaction` and its four identity variables. It refuses unless the
   prepare reader role exists and is the approved one, and it now also grants
   that reader `SELECT` on the live projection. Check that
   `SELECT has_table_privilege('<prepare reader>', 'public.catalog_delivery_live_prepare_media', 'SELECT')`
   is `true`. Without a prepare reader, skip this step: nothing reads either
   private view, and the startup check of the views runs only with
   `CATALOG_PREPARE_DATABASE_URL` set.
5. A1, with the migration role: `pnpm db:migrate:community` with its
   `APP_MIGRATION_DATABASE_URL`, as above. Its index builds briefly block writes
   to `community.catalog_delivery_prepares` and `community.media_publications`;
   under its 5 s `lock_timeout` a busy run fails with `55P03`, applies nothing
   and is repeated. It is forward-only, like every App migration.
6. Re-apply `infra/development/work-publishing/grant-runtime.sql` with
   `app_role` and `--single-transaction` (idempotent). It grants the App role
   `SELECT`, `INSERT` and
   `UPDATE (mark_seq, cleared_seq, reason, urgent, marked_at)` on the dirty
   queue, and `SELECT` and `UPDATE` of the state columns (not `id`) on the state
   row; never `DELETE`. Run before step 5 it grants nothing on these tables, so
   it must follow A1. Check that
   `SELECT has_table_privilege('<App role>', 'community.catalog_publication_dirty', 'INSERT')`
   is `true`.
7. Only then start the media worker and the Backend of 1B, in the activation
   order above. Check that both start and that the worker's ready line says
   `catalog=on`.

Rollback: a worker or Backend before 1B (#320, main or `c29dfd61`) runs on the
migrated databases without any migration down. It never names A1's relations,
its ledger check reads only the migration IDs it knows, and M1 and M2 keep the
rows and columns of the views it reads. A1 stays in place. To undo M2 or M1
itself, use `payload migrate:down` only while that migration is the latest batch
and a batch of its own (steps 2 and 3 make it so); otherwise run its exported
downgrade SQL and delete its `payload_migrations` row in one transaction. After
M2 is undone, the current `grant-prepare-read.sql` fails (it grants `SELECT` on
the live projection M2 creates), so any later re-grant of the prepare reader
must use the #320 version of that script. A rollback restores #320's listing
bounds, so until 1B has run stably keep the Catalog within them: fewer than
about 8,800 published images (with live prepares, the 10,000
published-plus-prepared pair bound), fewer than 10,000 prepare intents in all,
and fewer than 18,000 rows in the private prepare view.

## Catalog scale: bulk ingest of Catalog originals (increment 2)

Increment 2 of Issue #323 adds an ingest path for Catalog originals that keeps
their bytes off EdgeOne, nginx and the CVM uplink. The uploader (Codex's batch
script or `scripts/editorial/direct-ingest.mjs`) asks the Admin for one signed
staging PUT (`POST /api/editorial/media-ingest/start`), sends the bytes once
straight to the private bucket under `catalog-ingest/v1/<2 hex>/<64 hex>` with
`x-cos-forbid-overwrite`, and then calls `complete`. The Admin reads the staging
object over `CMS_COS_ENDPOINT`, checks its size, hash and image structure,
copies it to the content-addressed `editorial/` key and registers the media doc
from what it read; `abandon` deletes a caller's staging object. Nothing is read
back through artvenn.com. The routes accept originals up to 128 MiB, 120 million
pixels, 512 MiB decoded, 65,500 px per side and 256 KiB per decoded row (width ×
channels × bytes per sample, so a 16-bit RGBA PNG is at most 32,768 px wide),
with 8-bit JPEG samples only, at most 150 scans and at most 512 MiB of DCT
coefficients in a JPEG with more than one scan, at most 256 MiB decoded in an
interlaced (Adam7) PNG, and at most 256 MiB of ARGB (width × height × 4 B) in a
lossless WebP or a lossy one with VP8L-compressed alpha. The Development render
measurement and its reviews set all but the first three
([catalog-scale-bench](../../docs/development/catalog-scale-bench.md), increment
2): the sandbox's JPEG decoder refuses a side over 65,500 px and every 12-bit
JPEG, a wider 16-bit row took up to 1.4 GiB of the sandbox's 1.5 GiB, and a
decoder that holds the whole image (progressive JPEG, Adam7 PNG) took up to 1.1
GiB at 120 million pixels. The lossless WebP bound is conservative (a 120 MP
lossless file peaked under 600 MiB), and the scan count bounds the time of a
crafted JPEG, not measured. Within the limits the measured peak was at most 926
MiB (60%), on arm64; Production's amd64 render timing is still to be measured by
the canary (step 6). The native upload and the relay keep 40 MiB and 80 million
pixels, and nginx keeps `client_max_body_size 50m`. There is no migration and no
nginx or EdgeOne change.

Before its copy, `complete` refuses a staging object whose HEAD shows anything a
signed PUT never stores: another Content-Type, a Content-Encoding, -Disposition
or -Language, Cache-Control or Expires, user metadata, a storage class other
than standard, encryption other than SSE-COS (AES256), or a tag beside the
signed one. It deletes it and answers 422 `INGEST_STAGING_INVALID`, so nothing
of the kind reaches `editorial/`, which the Admin cannot delete. A final object
that shows one is refused unread (500 `INGEST_FINAL_INVALID`).

Three outcomes need the Owner. Each is logged as a fixed category with no key,
URL or file name; the final key of an intent is
`editorial/<SHA-256 of catalogId>/<SHA-256 of mediaId>-<sha256>.<jpg|png|webp>`
(hex digests).

- `INGEST_FINAL_INVALID` (500, logged as
  `EDITORIAL_MEDIA_INGEST_FINAL_INVALID`): the final object of that mediaId
  exists but fails re-verification (its size, its HEAD attributes, its hash or
  its structure), before or after the copy. Nothing is registered, and the
  staging object is kept. Every later `complete` of that mediaId answers the
  same until the Owner deletes that final object with the Owner's own COS
  identity (the Admin cannot delete `editorial/`), after checking read-only that
  no media record holds its key. Other mediaIds are not affected. Then re-run
  the batch with the credential and state file that started it.
- `EDITORIAL_MEDIA_INGEST_ORPHAN` (a warning; the request answered 409
  `MEDIA_IDENTITY_CONFLICT` or `MEDIA_IDENTITY_EXISTS`): another path registered
  the mediaId with other facts while this `complete` copied, so a verified
  original sits under `editorial/` with no media record. Nothing serves or reads
  it; it only takes storage. To remove it, list the `editorial/` keys that no
  media record holds (a read-only comparison) and delete them by hand with the
  Owner's identity.
- `EDITORIAL_MEDIA_INGEST_STAGING_DELETE_FAILED` (a warning): after a
  registration or a reuse, the best-effort delete of the caller's staging object
  failed or ran out of its deadline. The registration stands. Under L1 the
  lifecycle rule removes the object within a day. Under L2 nothing does, and
  `--abandon` skips registered items, so the Owner's listing of
  `catalog-ingest/v1/` after the batch (step 4) finds it; delete it by hand.

`admin.env` gains `CMS_CATALOG_INGEST` (`off` or `on`; absent or empty means
off) and `CMS_CATALOG_INGEST_UPLOAD_ENDPOINT`, the https origin of the public
COS API endpoint the staging URLs are signed for. Any other switch value (`ON`,
`true`, a typo) refuses to load the Admin's configuration, which stops both the
Admin and `payload migrate` until it is corrected (decision J of the design;
every other ingest setting is read only by the routes). Two more settings are
read only when the switch is on, each `on` or `off`; an invalid ingest setting
makes every ingest request answer 503 `INGEST_CONFIGURATION_INVALID` (logged as
`EDITORIAL_MEDIA_INGEST_CONFIGURATION_INVALID`):
`CMS_CATALOG_INGEST_SERVER_SHA256` (default `on`: `complete` reads and hashes
the staging object; `off`: MD5/ETag, header and tail checks only, decision D9)
and `CMS_CATALOG_INGEST_STAGING_TAG` (default `off`: lifecycle L2; `on`: L1, the
staging PUT carries the staging tag and the copy drops it, decision D8). While
the switch is off the routes are not composed (404), and the scripts use the
relay for files within 40 MiB and refuse larger ones with
`MEDIA_INGEST_UNAVAILABLE`, unless the item's staging PUT began (in this run, or
recorded in the state file by an earlier one): such an item, whatever its size,
also stops with `MEDIA_INGEST_UNAVAILABLE` and keeps its staging record, for a
re-run with the same state file or `--abandon` once the routes are back. Under
L2 nothing else removes its staging object, so run `--abandon` for every
unfinished batch before switching off (see Rollback below). The release ships
with the switch off and needs an Admin built on `main`; the live off-main Admin
cannot carry it.

Release order with 1B: this Admin is built on `main` after 1B, so its checkout
also holds `20261020_160000_catalog_delivery_intents` (#320), M1 (1A) and M2
(1B). Release it only after the CMS steps 1–3 of
[increment 1B](#catalog-scale-database-steps-of-increment-1b-catalog-scale-v1)
have run, each from its own checkout (#320, then 1A, then 1B), so that each of
these migrations is a batch of its own. Never run `pnpm db:migrate` from this
checkout while more than one of them is pending: `payload migrate` would apply
`20261020_160000`, M1 and M2 as one batch, which that section forbids. Read the
`payload_migrations` table first (read-only) to see which have run; once all
three are there, this checkout has no pending CMS migration. The pacing proxy
needs them too: `POST /api/editorial/catalog-render-backlog` reads
`catalog_delivery_intents`, which `20261020_160000` creates.

`CMS_CATALOG_INGEST_SERVER_SHA256=off` hashes nothing at `complete`: it
registers the client's declared SHA-256 as the content-addressed key, so the
`editorial/` object key and the media doc carry the client's value, and only the
staging ETag (the body's MD5), the image header and the tail are checked against
the bytes (and the JPEG scan count, which needs every byte, is not applied
beyond the part read for the header: a crafted JPEG of more scans than
`CATALOG_ORIGINAL_MAX_JPEG_SCANS` is registered, can never render within the
job's time, and cannot be deleted). A declared SHA-256 that does not match the
bytes is caught only when the worker renders the original
(`source_hash_mismatch`; nothing is published), and by then the mediaId and its
`editorial/` object stay occupied: media delete is disabled and the Admin cannot
delete `editorial/`. Keep the setting `on` unless the S0 check (step 1) shows
that the Admin's COS host resolves to a public address and the Owner accepts
that risk.

Increment 2 also paces Catalog prepares (decisions D4 and D5). The Backend gains
a read-only operator route,
`GET /internal/community/catalog-delivery/render-backlog` (operator credential;
counts only, from the App pool's existing grants), and the Admin an
authenticated proxy, `POST /api/editorial/catalog-render-backlog`. The
publication CLI's `run` and `publish` read it before a new prepare and return
`WAITING_FOR_RENDER_BACKLOG` while the backlog needs more than 12 hours at 7
images per minute (see
[the publication workflow](../../docs/curation/catalog-publication-workflow-v1.md)).
The Admin refuses no prepare because of it. Release order: the Backend first,
then the Admin, before a CLI checkout with this pacing is used for `publish` or
`run`. Against an older Admin that CLI stops with
`ADMIN_RENDER_BACKLOG_MISSING`, and against an older Backend with
`CATALOG_RENDER_BACKLOG_NOT_CONFIGURED`, before any prepare, single records
included.

Switch-on is Owner-run, one separately approved step at a time, in this order.
The plan CLI (`scripts/editorial/catalog-ingest-bucket-plan.mjs`) makes no
request and needs no credential; it prints placeholders, digests and fixed codes
only, reads its inputs (`--target`, `--current`) only from owner-only (0600)
files, and writes real values only to a new 0600 file given by `--out`. The
probe runner (`apps/admin/scripts/catalog-ingest-probes.ts`) is the only step
that sends requests: it runs on the CVM with the Admin's protected configuration
in the environment, as the Admin's own code, while the switch is still off.

1. S0, read-only checks; nothing changes:
   - the policies attached to the Admin's COS write identity;
   - GetBucketVersioning (it must not be `Enabled`: forbid-overwrite does not
     protect a versioned bucket), GetBucketEncryption (none, or SSE-COS: the
     Admin refuses staging with KMS or customer-key encryption),
     GetBucketLifecycle (capture it to a private file, the merge input of step
     4), GetBucketCors, the Referer setting (an empty Referer must stay allowed)
     and whether lifecycle tag filters are supported; keep every captured file
     owner-only (0600);
   - that the Admin and UGC stores use the same bucket;
   - on the CVM, the address class the host of `CMS_COS_ENDPOINT` and the media
     worker's Catalog source host resolve to. This is a hard gate for
     server-side hashing (decision D9): an intranet address lets `complete` read
     and hash the staging object (`CMS_CATALOG_INGEST_SERVER_SHA256=on`, the
     default, which then stays on); only a public one allows MD5/ETag checks at
     `complete`, with the SHA-256 check left to the worker at render time
     (`CMS_CATALOG_INGEST_SERVER_SHA256=off`), and only once the Owner accepts
     the risk described above; step 3 must also clear it;
   - whether Codex's runtime may reach the public COS API host.
2. The CAM statement (option 1, Codex and the CLI only), always the L1 form
   first, since step 3 tests tagging with it:
   `node scripts/editorial/catalog-ingest-bucket-plan.mjs cam --lifecycle L1`
   prints it with placeholders; with
   `--target <private target.json> --out <new private file>` (`target.json` is
   `{"region", "appId", "bucket"}`) it writes the bound statement and prints its
   SHA-256. Add it as one more statement on the Admin's COS write identity:
   `PutObject`, `GetObject`, `HeadObject`, `DeleteObject` and `PutObjectTagging`
   on `catalog-ingest/v1/*` only; no list, multipart, ACL or bucket permission.
   Keep the policy as read in S0 as the undo file.
3. The staging dry run, on the CVM, with the Admin's configuration and
   `CMS_CATALOG_INGEST_UPLOAD_ENDPOINT` (step 5's value) in the environment:
   `pnpm --filter admin exec payload run scripts/catalog-ingest-probes.ts -- --lifecycle L1 --out <new private file> --keep-source`
   (an absolute `--out` path: the command runs in `apps/admin`;
   `node scripts/editorial/catalog-ingest-bucket-plan.mjs probes --lifecycle L1`
   lists every probe and the Owner's own checks). It builds every request with
   the Admin's code: the staging PUT URL with its signer (SigV4 query signature,
   `x-id=PutObject`, the signed headers of `start`), the copy in the S3 API
   spellings COS's S3-compatible layer must honour
   (`x-amz-copy-source: <bucket>/<key>`, `x-amz-copy-source-if-match`,
   `x-amz-metadata-directive: COPY`, `x-amz-tagging-directive: REPLACE`, plus
   `x-cos-forbid-overwrite: true`) and HEAD with its own parser. Then it makes
   each probe: the signed PUT; a HEAD of a key never written (404, which
   `complete` reads as absent); a second PUT (409); the same PUT through Node's
   fetch, as the Codex library sends it; a wrong length, a missing
   `x-cos-forbid-overwrite` or Content-MD5, another body, another key, another
   method; one probe per unsigned header (copy-source, ACL, every grant,
   tagging, metadata-directive, server-side encryption including customer keys,
   storage class and user metadata, each in both spellings); unsigned standard
   headers (refused, or not stored, or stored where HEAD shows them, so
   `complete` refuses them); `?acl`, `?tagging` and `?uploads` added to a URL
   signed for an object the run placed first, the first two signed for their own
   document body (a READ grant to everyone, two tags) with no unsigned header
   (exactly 403, and the object keeps its ETag and tag count and stays private:
   a COS that ran the sub-resource would answer a key never written with 404);
   anonymous reads of the staged object and of a copy; a PUT finishing after its
   URL expired; the copy conditions (If-Match 412, forbid-overwrite 409); ETag
   or CRC64 kept across the copy and no metadata on it (and, under L2, no tag);
   the tag count on HEAD and the tag-stripping copy. It deletes every object it
   wrote (with `--keep-source`, all but the first). Standard output carries the
   verdicts (`always`, `md5Mode`, `l1`), the failed probe ids and the report's
   SHA-256; the 0600 report holds status codes and booleans, never a URL or key.
   `always` must pass: any honoured unsigned header or sub-resource stops the
   rollout, because the signing identity can read every original. An `l1`
   failure alone (no tag count on HEAD, or a copy that keeps the staging tag) is
   no stop: it chooses L2 in step 4. `md5Mode` (the staging ETag is the body's
   MD5 and the copy keeps it; CRC64 alone is not enough) must pass before
   `CMS_CATALOG_INGEST_SERVER_SHA256=off`. Then, as the Owner, read the kept
   object's tags (GetObjectTagging: exactly `moya-ingest-staging=v1`; the
   Admin's identity has no GetObjectTagging) and delete it.
4. The staging lifecycle. L1 when S0 showed tag filters are supported, step 3's
   `l1` verdict passed (COS reports `x-cos-tagging-count` on HEAD; without it
   every L1 `complete` answers 503 `INGEST_CONFIGURATION_INVALID`) and the kept
   object carried exactly the staging tag; else L2.
   - L1:
     `node scripts/editorial/catalog-ingest-bucket-plan.mjs lifecycle --lifecycle L1 --current <captured lifecycle.json> --out <new private file>`
     appends one rule, a 1-day Expiration filtered by the prefix
     `catalog-ingest/v1/` AND the tag `moya-ingest-staging=v1`, keeps every
     existing rule byte for byte and prints the diff. It checks every existing
     rule, the one under its own ID included, and stops on a rule without a
     Filter or with a rule-level Prefix beside one; on a rule that is not
     `Disabled` and expires, transitions or carries any action it does not know
     under a filter that could match `editorial/` or `display/`; and on any rule
     under its ID that differs from the generated one (compared key by key). It
     never generates a rule that could match `editorial/`, `display/` or `ugc/`.
     The input and output use the S3 API JSON shape only (`{"Rules": [...]}`;
     `{}` when the bucket has none); convert any other capture first. Apply the
     written file with read-merge-write, read the configuration back and compare
     (the plan run on the 0600 read-back must answer `"unchanged": true`); the
     captured file is the undo.
   - L2: write nothing to the lifecycle. Replace the statement of step 2 with
     the L2 form (`cam --lifecycle L2`, without `PutObjectTagging`) and run step
     3 again with `--lifecycle L2` (without `--keep-source`); its `always`
     verdict must pass under that statement. Staging objects then go at
     `complete`, at `abandon`, through
     `scripts/editorial/direct-ingest.mjs --abandon` for a batch given up, and
     by an Owner listing of `catalog-ingest/v1/` after each batch (it should be
     empty). The Admin derives each staging key from the caller, so `--abandon`
     reaches only the objects of the credential that ran the batch, with that
     batch's state file: it reports `abandoned` (removed), `absent` (nothing
     staged), `notStarted`, and `INGEST_ACTOR_MISMATCH` for items another
     credential started, which it leaves alone; without the state file it
     refuses (`STATE_NOT_FOUND`). It rebuilds each item's intent from the
     manifest and the MD5 the item's state row recorded (not secret), so it
     still reaches an item whose local file changed or was removed since. A
     batch of Codex's own script is abandoned by that script, with its identity.

   Change `CMS_CATALOG_INGEST_STAGING_TAG` later only while `catalog-ingest/v1/`
   is empty (run `--abandon` for every unfinished batch first), so no staging
   object of the other lifecycle is copied.

5. Switch on: set `CMS_CATALOG_INGEST=on` exactly (any other value but `off` or
   empty stops the Admin and `payload migrate`),
   `CMS_CATALOG_INGEST_UPLOAD_ENDPOINT`, `CMS_CATALOG_INGEST_SERVER_SHA256`
   (from steps 1 and 3) and `CMS_CATALOG_INGEST_STAGING_TAG` (`on` for L1, from
   step 4) in `admin.env` and its staged copy, then restart the Admin.
6. The 10-image canary, from the Owner's location, before any bulk batch: 10
   originals of mixed sizes, at least four over 40 MiB, through
   `scripts/editorial/direct-ingest.mjs` (or Codex's changed script). Its
   summary must show `"privacy": "private"`. The check fails closed, in the
   canary and in every batch: any answer but private (401 or 403) stops the run,
   and no item or attempt starts while it runs. After `uncertain` (no clear
   answer in three tries) the next run with the same state file checks its first
   new original, and every run of that state that checks nothing reports
   `uncertain` again (exit 1) until a check answers private. `public` (2xx) or
   `unexpected` (404) is recorded in the state file, which then refuses
   `--execute` with `PRIVACY_STOPPED` before any request: once the Owner has
   made the bucket private and confirmed it, the batch continues with a new
   state file (registered items are reused, staged bytes completed), while
   `--abandon` still runs with the old one. The stderr
   `EDITORIAL_DIRECT_INGEST_RUNBOOK` lines name the step for each. Record from
   its `metrics`, numbers only: `largePuts` and `largePutsFailedOnce` (originals
   over 40 MiB that needed more than one PUT), `putAttempts` and `failedPuts`,
   `putMiBps` (median, slowest and fastest PUT that stored the bytes) and
   `completeMs` (median and longest `complete` phase, retries included). Each
   image's own PUT times and statuses and `complete` times are in the 0600 state
   file's row (`metrics`). More than 5% of large PUTs failed at least once
   (`largePutsFailedOnce` over `largePuts`) stops the rollout (multipart staging
   is a later change); a slow canary leaves paid COS acceleration to the Owner.
7. Paced batches: rendering stays at about 7 images per minute, so prepare the
   next wave only while the render backlog drains within 12 hours; ingested
   records can wait as drafts. Ingest itself is slower for one credential: the
   Admin signs at most 4 GiB per credential per hour (12 GiB in all), about 58
   originals of 70 MiB an hour against about 420 renders, so one credential's
   batches meet `INGEST_QUOTA_EXCEEDED` (429: the run starts no new item and
   leaves the rest pending for a re-run in the next hour) long before the render
   backlog holds a wave back. The pacing read is
   `POST /api/editorial/catalog-render-backlog` (released Backend, then Admin):
   the App's per-tier count plus `preparedSince`, the images of the intents
   prepared since that count (from 10 minutes before it, so an intent whose
   prepare spanned the count is counted twice rather than missed, as long as its
   prepare and the clock skew together stay within 10 minutes), so the sessions
   of one batch are paced on each other. The publication CLI's `run` and
   `publish` apply it before every new prepare; a `WAITING_FOR_RENDER_BACKLOG`
   answer prepared nothing, so run the same command again after
   `drainMinutes - maxDrainMinutes` minutes (at least 5). Until the formal CLI
   reads originals over 40 MiB (S4b, deferred by decision D11), it stops, before
   any save or prepare, on a record that holds one. Such records are prepared
   only by a direct `POST /api/editorial/prepare-catalog-delivery` (Codex's
   private script, under the Owner's approval), which must read the pacing route
   before each prepare and apply the same rule (see
   [operations](../../docs/cms/operations.md)); the Admin itself refuses no
   prepare for the backlog. Run, resume and abandon each ingest batch with the
   credential that started it and its state file: the Admin derives the staging
   key from the caller, so a resumed item whose recorded staging key belongs to
   another credential stops with `INGEST_ACTOR_MISMATCH` and keeps its record
   and its staged object, with no PUT, `complete` or `abandon` under the new
   credential.

Rollback: set `CMS_CATALOG_INGEST=off` (or blank it), or redeploy the previous
Admin. There is no migration. Ingested docs stay readable; a formal CLI without
the ingest proof refuses a registered doc over 40 MiB when it parses it, so it
fails closed. Ingest changes neither the worker nor the Backend; the pacing adds
only the read-only Backend route and its Admin proxy, and a CLI checkout with
pacing stops before any prepare against a Backend or Admin without them. Before
switching off, while the routes still exist, run
`scripts/editorial/direct-ingest.mjs --abandon` for every unfinished batch: once
the switch is off or the previous Admin runs, `abandon` answers 404, and under
L2 no rule ever removes a staging object of up to 128 MiB. Each batch is
abandoned with the credential that ran it and its state file (Codex's script
batches by Codex, with its identity); an `INGEST_ACTOR_MISMATCH` count means the
wrong credential. Then list `catalog-ingest/v1/` and delete what is left by
hand. Keep the L1 lifecycle rule until `catalog-ingest/v1/` is empty; the CAM
statement and the rule are then removed by writing back the captured undo files.
