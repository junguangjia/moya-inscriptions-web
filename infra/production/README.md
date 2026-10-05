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

B PR194 is consumed from main d434fac2060745d5ed29696197ca1cb857360c66.
Production requires `WORK_MEDIA_COS_*`, a local pinned `WORK_MEDIA_TOOLS_IMAGE`
and an existing backend-owned0700 `WORK_MEDIA_WORK_DIR`. One configured COS
store/processor/runner is shared by upload/read/Article thumbnails and the
existing publishing worker; one transfer registry handles cancellation. Do not
set `WORK_MEDIA_STORE_DIR` or reuse Catalog/Payload credentials. Keep one active
Backend per exclusive `ugc/publishing/<namespace>/`, including restart overlap.

Only the exact component upload route has8GiB ingress. It streams with request
and response buffering/cache/retry disabled and130s body/send and75s response
idle limits. Derivative GET/HEAD/Range preserves200/206/416, private headers and
stream cancellation. Profile PNG remains4MiB; human Article and MCP document
commands use1MiB+16KiB envelopes. Ordinary Community requests retain1MiB.

The Backend unit permits writes only to `/var/lib/yoyi-backend/publishing-work`.
Prepare that directory, the existing locally pinned media-tools image and a
separately authorized Docker daemon access model before service activation.
Prefer a backend-user rootless daemon and explicitly set its local Unix socket
in private `DOCKER_HOST`; do not silently add the service to a rootful Docker
group or remove hardening. The Docker CLI must be in the service PATH and the
daemon must see that host bind path. Validate real host mounts, sandbox limits,
image capabilities, memory/disk capacity and shutdown; local offline acceptance
does not certify the eventual Linux host. See B's
[exact media requirements](../../docs/development/full-release-media-v1.md). No
daemon installation, group change or service activation runs here.

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
