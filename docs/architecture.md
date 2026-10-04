# Architecture

## System shape

由艺（Yoyi）使用 pnpm
workspace 与 Turborepo 管理模块化单体 repository。当前公开 Catalog 范围严格为
`inscription | calligraphy`。

```text
Browser
  → Next.js Public Web / React Formal Root
  → same-origin Web API boundary
  → Public HTTP API
  → backend Catalog application
  → CatalogQueryPort
  → PostgreSQL adapter

PostgreSQL media object keys
  → backend StorageUrlResolver
  → resolved PublicMedia.src
  → Public HTTP API
  → React presentation
```

Frontend 不直接读取 PostgreSQL、Query Port、backend implementation、raw
datasets、provider configuration 或 credentials。Public
DTO 没有独立的 objectKey、bucket 或 region 字段；Backend 解析的签名 URL 可以包含 opaque
key。

## Workspace responsibilities

- `apps/web`：Public Web composition、React Product
  Shell、interaction、server-side Public HTTP client 与 same-origin API routes。
- `apps/admin`：已实现 Payload Catalog
  Admin、原生草稿/版本、Owner 发布与受限 automation。
- `services/backend-runtime`：Node.js listener、runtime
  config、router、handlers、JSON response、readiness injection 与 graceful
  shutdown。
- `services/backend-production`：PostgreSQL adapter、HTTP runtime 与 production
  composition root；启动时只读验证所选内容源的 readiness。
- `services/api`：backend-only Catalog application boundary，拥有 normalized
  query、internal projections、`CatalogQueryPort`、`StorageUrlResolver`、read
  service 与 explicit Public mapper。
- `services/catalog-postgres`：private PostgreSQL adapter、queries、migration
  runner 与 required-ledger/readiness validation。
- `services/catalog-importer`：private controlled importer；执行 strict
  CSV 与 bounded XLSX parsing、canonical
  convergence、diagnostics、dry-run、hash-bound approval 和 transactional
  apply。
- `services/public-api`：Public OpenAPI contract 与 deterministic
  generator；不启动 HTTP listener。
- `packages/contracts`：Public DTO/query/error/ID/runtime
  schema 的唯一来源，并隔离 server-only Catalog Import contracts。
- `packages/image`：backend-only `StorageUrlResolver`
  implementations；不拥有 provider credential、upload 或 transport policy。
- `packages/ui`、`packages/design-tokens`：共享 semantic
  components、assets 与 tokens。
- `packages/search`：已实现 Search
  V1 中文归一化；标准 PostgreSQL 负责检索与排序。
- `database/migrations`：仅 legacy
  migrations；`apps/admin/src/migrations`：仅 Payload migrations。

The retired empty `@moya/data-access` workspace is not part of the current
architecture.

## Formal Web composition

`apps/web/app/page.tsx` is the current Formal `/` composition root:

```text
readFormalRequestContext()
+
loadProductionProductStates()
  ├── Home Discover
  ├── Nearby unavailable
  ├── Topics unavailable
  ├── inscription page 1
  └── calligraphy page 1
        ↓
T02pProductPreview
        ↓
ProductShell
```

The page is request-rendered and uses Production-only sources. Initial Catalog
pages are loaded server-side. Later Inscriptions and Calligraphy `全部` pages
use the same-origin `GET /api/catalog` boundary and explicit progressive
loading.

The current React Product Shell owns:

- Home, Inscriptions, and Calligraphy primary destinations;
- Settings and preferences;
- platform/orientation presentation state;
- canonical Product history;
- per-destination and Detail scroll restoration;
- opener focus restoration;
- mutually exclusive Topic, Detail, Viewer, and Settings layers.

Catalog cards open one shared Detail implementation. Detail uses the same-origin
Catalog Detail boundary. The bounded Carousel and full-screen Viewer own media
paging, fit, zoom, pan, pinch, URL state, and restoration behavior.

`GET /catalog/{catalogId}` remains a 307 compatibility redirect into the
canonical Formal root query/history journey.

## Development, QA, Prototype, and legacy static code

Development may combine truthful runtime records with explicit synthetic QA
records. Their identities and media origins remain distinct. QA values never
enter PostgreSQL, Public API, Contracts, importer, workbook, or Production
runtime data.

- `/dev/t02p` and `/dev/t02p/qa` are Development-only React acceptance surfaces;
  Production returns 404. `/dev/community` (Development sign-in) and
  `/dev/community/preview` (the Community acceptance entry) are Development-only
  as well.
- `/docs/prototypes/mobile-preview/` is a direct non-production static
  Prototype.
- `apps/web/lib/t02-static-files.ts` remains a Prototype-serving utility with a
  retained legacy `formal-root` regression seam.

The legacy static seam is not called by `apps/web/app/page.tsx` and is not the
current Formal Web architecture. Its presence preserves historical/Prototype
evidence only. Broad Prototype or bridge cleanup remains separately scoped and
must not be mixed into ordinary Product work.

## Public HTTP and application boundary

Current backend Public endpoints are:

- `GET /health`;
- `GET /v1/catalog`;
- `GET /v1/catalog/{catalogId}`；
- `GET /v1/catalog-search`。

Web exposes bounded same-origin list and Detail routes under `/api/catalog`, and
Search V1 under `/api/catalog-search`. Transport input is parsed strictly.
Catalog list supports page-based pagination and optional
`kind=inscription|calligraphy`.

```text
Public transport input
  → transport parser
  → normalized application query
  → CatalogReadService
  → CatalogQueryPort
  → internal projection
  → StorageUrlResolver when media exists
  → explicit Public mapper
  → strict Public DTO
```

Public responses do not expose SQL rows, driver errors, private source evidence,
independent objectKey/bucket/region fields, storage configuration, or
credentials. The existing `PublicMedia.src` may contain an opaque object path
and short-lived read authorization generated by the Backend.

## Catalog Content V1

Catalog Detail currently supports the original canonical fields plus optional:

- ordered contributors with `textAuthor | calligrapher` roles;
- `scriptStyle`;
- `transcription`;
- `historicalContext`;
- `scholarlyResearch`;
- citation `appliesTo` scopes.

The source-of-truth chain remains:

```text
Zod
  → inferred TypeScript
  → Draft 2020-12 JSON Schema
  → OpenAPI 3.1.1
```

PostgreSQL persistence, read projection, explicit Public mapping, API
population, `catalog-import/v2`, and the bounded T09-F1 React Detail
presentation of every Content V1 field (PR #89) are implemented.

## Media boundary

PostgreSQL stores logical object keys. Backend `StorageUrlResolver`
implementations convert them to public or signed runtime URLs. Public API
outputs only `PublicMedia.src`; Web and `@moya/ui` consume that resolved value.

Non-Pilot production composition uses `ProductionCosStorageUrlResolver`: the
published projection supplies the object key, the official COS SDK signs a
short-lived URL, and the browser reads COS directly through `PublicMedia.src`.
There is no new media endpoint or Backend byte proxy. Production keys retain the
existing MediaId/hash/SHA structures; titles, personal information and local
paths must not become keys. Existing approved keys are not renamed.

The resolver requires a custom HTTPS media origin, defaults to 300-second URLs
(allowed 60–600), verifies TLS, and bounds timeout/errors. It has no Pilot
manifest, object-count cap or upload operation. Pilot upload and manifest guards
remain in the Pilot module. URLs are runtime-only, not logged or persisted;
pages retain `no-referrer`. Withdrawal stops new URLs, but does not recall
downloaded bytes or invalidate a previously issued URL before expiry. Domain
binding, TLS and real COS signature verification remain Stage B work.

Local development uses gitignored Payload media, the Backend local resolver and
Payload’s existing file route, with anonymous reads limited to published media
in synthetic development. It requires no COS credentials and exposes no local
absolute filesystem path. Drafts and Admin preview remain authenticated. Future
private UGC has a separate permission/storage boundary. A future custom CDN with
private COS origin authentication and necessary URL authentication can replace
the resolver after formal public launch without changing the Public Contract.

## PostgreSQL, migrations, and importer

Payload with PostgreSQL published views is implemented; Search V1 consumes the
published read model. Legacy remains an explicit compatibility source until the
separately authorized operational cutover. TencentDB is a standard PostgreSQL
target; business code has no Tencent database SDK dependency. Production startup
and schema migration are separate:

```text
explicit migration command
  → verify required migration ledger
  → production startup
  → listener
```

Startup does not execute DDL. Supported PostgreSQL majors are 16 (the minimum
Production major) and 18. CI runs both (16.15 and 18.4); local Compose uses
18.4.

The controlled write path is:

```text
Owner XLSX or strict CSV
  → versioned parse
  → canonical envelope and hash
  → validation and duplicate/diff dry-run
  → hash-bound approval
  → one PostgreSQL transaction
  → operation audit
```

`catalog-import/v1` remains compatible. `catalog-import/v2` adds Content V1
fields, ordered contributors, curated citations, citation scopes, and explicit
`PRESERVE | REPLACE | CLEAR` collection semantics. Import is not publication.

## Production status and deployment authority

The repository contains no persistent Production Catalog dataset, Production
credential, or configured Production media provider. The 28-record P5 flow was
validated against disposable infrastructure and remains non-production evidence.

The Owner currently tests in an Owner-owned Tencent account. Future CVM,
TencentDB PostgreSQL and private COS resources will belong to the domestic
partner's verified main account; those resources have not been created.
[Production topology](../infra/production/README.md) defines three separate
loopback processes behind Nginx and distinct service users. Historical CloudBase
material under `docs/archive/deployment/` remains non-authoritative.

Production provider choice, purchases, domains, credentials, secrets, release
operations, data import approval, backup/restore, and deployment require
separate Owner authority.

## Database roles and the Community boundary

`CMS_DATABASE_URL` is Payload runtime; `DATABASE_URL` is the Public Backend
published-read runtime; `TEST_DATABASE_URL` is dedicated disposable testing.
`APP_DATABASE_URL` is the Backend's Community V1 runtime role (Mission 2A): DML
only on the `community` schema namespace, read at runtime solely by the
`services/backend-production` composition root, and the only login that reaches
public users and sessions. CMS, Public and App roles may use the same TencentDB
instance and database, but must be different database users with separate
permissions. Tests and local development remain isolated from staging and
production. Public Backend grants read access only to published views;
deployment migration privileges are separate from runtime privileges.

Public pool defaults to 5, with explicit idle timeout. Payload retains max 5.
Optional CA files configure verified TLS; `rejectUnauthorized=false` is
forbidden. Migrations route by `MOYA_CONTENT_SOURCE`: `legacy` selects only
legacy SQL; `payload` selects only Payload migrations. The community family
(`database/community-migrations/`, `pnpm db:migrate:community`) is separate from
both, is never selected by `MOYA_CONTENT_SOURCE`, and runs only with the
migration-privileged `APP_MIGRATION_DATABASE_URL`. Startup never performs DDL;
the Backend only verifies each ledger read-only.

Payload users serve Owner/automation only and are never public users. Community
V1 is the one approved social domain (Owner amendment 2026-09-11): public-user
identity and Backend-owned sessions are implemented (Mission 2A, including the
Development-only test-account sign-in that is never composed in Production), and
Mission 2B adds Catalog comments with exactly one level of replies, the
Owner-controlled publication setting (`DIRECT_PUBLICATION` initial default since
the 2026-09-12 scope amendment) and the moderation surface. The public listing
is one combined list, a small Backend-computed hot section (visible roots ranked
by visible replies, provisional Owner defaults) followed by the latest roots,
with no root in both; replies stay flat and paginated, never ranked. Comments
live only in the community namespace and hold no cross-family foreign key: a
write is admitted only after the published Catalog read side confirms the
record, and comments never enter Catalog DTOs, the importer, CMS or Search.
Payload holds no comment or public-user collection — the Owner's Admin views
(review queue, publication setting, operation history) call a loopback-only
authenticated Backend operator boundary and the Backend stays the sole writer.
The queue is typed, authenticated and paginated Backend reads (listing with
counts, item detail with thread context and history, audit events, a ranged
summary); the same services will serve any later REST or MCP adapter, so no
future automation needs browser automation or database access. Moderation is
four audited edges of one state machine (`approve`, `reject` pending → hidden,
`hide`, `unhide`); a stale state is a 409 conflict that records nothing. Bulk
actions are bounded to the selected items on one page (at most 50), applied one
by one through the same edges with per-item outcomes. Machine analysis is a
provider-independent, advisory boundary (see
`docs/community-analysis-boundary.md`): it may recommend, never act, and an
unconfigured provider reads as "not connected", never as clean. The Formal
comment UI (Mission 2C) composes the real comment client through the frozen #106
seam on every Catalog Detail of the Product application, in the Development
runtime only; a Production build composes no comment section until the decision
7 gates are met. Posts, likes, favorites, following, messaging and UGC media
stay deferred. QA filter fixtures remain QA-only; hard-coded dynasties, script
styles, kinds or regions do not become production taxonomies or contracts. No
production filtering is added.

## Stable guardrails

- Public and cross-workspace contracts are defined only in `packages/contracts`.
- Frontend does not import backend runtime/application or query PostgreSQL.
- Frontend receives only resolved `PublicMedia.src`, never independent storage
  identifier fields or provider credentials; it never constructs/signs object
  keys.
- Database schema changes use append-only migrations.
- Dependency upgrades require explicit scope.
- Prototype/QA presence does not authorize Production consumption.
- Current React Product behavior is not duplicated or replaced by ordinary data
  or backend work.
- Formal Production states omit absent optional content and never invent facts.
- Every new task starts from a freshly resolved latest `origin/main`.

Accepted and superseded decisions are indexed in [`adr/`](adr/README.md).
Dynamic milestone and next-task truth exists only in
[`project-status.md`](project-status.md).
