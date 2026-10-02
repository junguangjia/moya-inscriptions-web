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

Production authentication, media processing and final migration/grant acceptance
remain separate dependency deliveries. Do not copy Development provider or
filesystem settings into these templates. Exact upload body/streaming limits,
processing directories, worker configuration and systemd directory permissions
must come from `full-release-media-v1`. Runtime startup only verifies readiness
and the current migration ledger; the explicit migration/grant process must
consume `full-release-database-v1` before deployment. No automatic grant or
migration is introduced.

## Three processes behind Nginx

| Process | Unix identity  | Listener         | EnvironmentFile         |
| ------- | -------------- | ---------------- | ----------------------- |
| Web     | `yoyi-web`     | `127.0.0.1:3000` | `/etc/yoyi/web.env`     |
| Backend | `yoyi-backend` | `127.0.0.1:3001` | `/etc/yoyi/backend.env` |
| Admin   | `yoyi-admin`   | `127.0.0.1:3002` | `/etc/yoyi/admin.env`   |

All names, paths, hostnames and provider identifiers in these templates are
fictional examples. Replace them in private deployment input after actual
resource and release authorization. Do not commit real values or write them to
logs. The three systemd services use independent non-login users, read-only
code, `NoNewPrivileges`, strict filesystem protection, no capabilities,
`Restart=on-failure`, SIGTERM and a 30-second graceful-stop deadline. Listener
arguments are fixed in `ExecStart` so an environment file cannot expose a
process port. Startup performs readiness checks; it never executes migrations or
DDL.

A future deployment operator must install Node 24/pnpm 11.9.0, create the three
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

Start from the three `env/*.env.example` files, with private resource values
provided per service. `web.env` contains only the loopback Backend URL and
internal CMS preview URL. `backend.env` contains the published-read DB role and
the independent COS read runtime. `admin.env` contains Payload's own DB role,
secret, URLs and COS write configuration. Missing required production settings
fail closed. Staging uses these same contracts with distinct database roles,
origins and private bucket.

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
