# Local development

P2-R2A prepares the existing Public Web, sole Backend composition and Payload
Admin for ordinary PostgreSQL. This setup uses synthetic local content. It does
not purchase cloud resources, deploy, migrate real data, switch the production
content source, retire XLSX or implement public users/community/filtering.

## First run

Use Node 24, pnpm 11.9.0 and Docker Compose. From the repository root:

```sh
pnpm install
cp infra/env/local.env.example .env.local
pnpm dev:db:up
pnpm dev:migrate
pnpm dev:all
```

`compose.dev.yml` creates PostgreSQL **18.4**, database `yoyi_dev`, port
`127.0.0.1:54330` and the separate `yoyi-development_yoyi_dev_data` volume. It
does not reuse `compose.postgres.yml`, `TEST_DATABASE_URL`, any Stage A database
or existing content. The checked-in local credentials are explicitly synthetic
and only for this loopback container. Real values and local `.env.local` stay
outside Git; use independently provisioned credentials for any shared
environment.

`dev:migrate` first builds the existing shared packages. Its `--development`
preflight requires Payload, the same loopback `yoyi_dev` database and different
CMS/public roles. It then runs only Payload migrations and grants the local
public role `SELECT` on the six published views and published search table.
Legacy migrations never run here. It then applies the separate Community V1
family (`scripts/migrate-community.mjs --development`, using the local
`APP_MIGRATION_DATABASE_URL` owner role), grants the DML-only `yoyi_dev_app`
role on the `community` schema — first the Mission 2A/2B bootstrap
(`infra/development/grant-community-app.sql`), then the complete Phase 4 and
work-publishing runtime plan
(`infra/development/work-publishing/grant-runtime.sql`, applied with
`-v app_role=yoyi_dev_app`), which revokes the table-level `UPDATE` the
bootstrap granted before granting its column lists, so the role ends with
exactly the runtime plan whichever grants it held before — and seeds the three
Development test accounts
(`infra/development/community-development-accounts.sql`). The grant commands
address only this Compose container; do not edit local URLs to target another
server. Database and Admin startup run no DDL. Run migrations explicitly when
the code changes them; an existing `yoyi_dev` that received only the bootstrap
before this chain converges the next time `dev:migrate` runs.

`dev:all` runs the existing Turbo watch mode and the standard `tsx` development
runner; Turbo rebuilds shared dependencies and restarts affected tasks. It
starts:

| Process       | Address                       | Database use                                                                      |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| Public Web    | `http://127.0.0.1:3000`       | Public HTTP API only                                                              |
| Backend       | `http://127.0.0.1:3001`       | `yoyi_dev_public` published reads; `yoyi_dev_app` community identity and sessions |
| Payload Admin | `http://127.0.0.1:3002/admin` | `yoyi_dev_payload`, CMS runtime                                                   |

Web and Admin retain their existing development hostname behavior for device QA.
The Backend and PostgreSQL listen on loopback. The root `.env.local` is loaded
by Node's native env-file support before Turbo; task-specific environment
forwarding keeps database/COS settings out of the Web task. The existing
`pnpm dev:web` and `pnpm dev:admin` standalone commands still support their
existing app-local Next.js environment files. Use `dev:all` for the shared root
template.

Payload owner/automation accounts are administrative identities, not public
users. The local template uses `CMS_ENVIRONMENT=synthetic` for the existing HTTP
local authentication behavior. `CMS_STORAGE_MODE=local` requires no COS/Tencent
credentials. Admin resolves `CMS_MEDIA_DIR=../../.local/media` from its
workspace directory to the gitignored root `.local/media`. The Backend maps
published opaque keys to `PUBLIC_MEDIA_BASE_URL=http://127.0.0.1:3002` and
Payload’s existing `/api/media/file/<filename>` route. Only published local
uploads are anonymously readable when development, synthetic and local-storage
guards all pass. Media metadata, drafts and Admin preview retain authentication;
filesystem paths never enter Public DTOs. Use the same `127.0.0.1` hostname for
all three processes. Create it locally if needed with `mkdir -p .local/media`.
Do not commit media, secrets or synthetic database dumps.

## Daily commands

- `pnpm dev:db:up`: start only the dedicated development database and wait for
  health.
- `pnpm dev:db:down`: stop it while retaining the named volume and data.
- `pnpm dev:migrate`: explicit Payload migrations, local published-read grants,
  community migrations, the local App-role grants and the Development test
  accounts.
- `pnpm db:migrate:community`: the community migration family alone, with
  `APP_MIGRATION_DATABASE_URL` (add `--development` for the local preflight).
- `pnpm dev:backend`: run the Backend and rebuild changed shared dependencies.
- `pnpm dev:all`: run Web, Backend and Admin together; Ctrl-C stops these
  processes.

No custom watchdog, session controller or new process platform is added. `tsx`
4.22.4 is the sole direct dev-runner addition, reusing the already locked
version. The ordinary `pnpm verify` and production `pnpm build` commands remain
in place.

## Community V1 Development sign-in

Community V1 (Owner amendment 2026-09-11, Mission 2A) adds Backend-owned public
users and sessions. The local `yoyi_dev` database holds three real Development
test accounts — handles `dev-user-01`, `dev-user-02`, `dev-user-03` with Chinese
display names — seeded by `dev:migrate`; they are not QA fixtures and exist in
no other environment. Open `http://127.0.0.1:3000/dev/community` (or the same
path on the LAN address used for device QA) to sign in as one of them, see the
identity the Backend returns from `GET /api/community/me`, and sign out. The
Backend issues, validates, expires (seven days, absolute) and revokes the
session; Web only holds the opaque credential in the HttpOnly `yoyi-session`
cookie and relays it as a bearer credential. The sign-in and sign-out routes and
the page answer 404 unless `NODE_ENV=development`, and the Backend composes
`/v1/development/*` only under `NODE_ENV=development`; Production has no sign-in
path.

### Where comments show (Mission 2C)

In the Development runtime the Formal root `/`, `/dev/t02p` and the acceptance
entry `/dev/community/preview` all compose the same Product application with the
live comment section on every Catalog Detail: open a record from Home, Browse or
Search and the comments load from `GET /api/catalog/{catalogId}/comments` (hot
roots first, then the latest, `加载更多评论`, `查看更多回复`). Signed out, the
composer is replaced by a link to `/dev/community`; signed in, submissions go
through the same-origin routes and every failure keeps the draft and says why.
`/dev/community/preview` differs only in its clean Development states and stays
as the regression and acceptance entry. A Production build composes no comment
section and links to no Development route
(`apps/web/features/product-application/community-comment-surface.ts`):
Production exposure of any Community surface stays deferred under decision 7 of
the 2026-09-11 amendment. The QA prototype at `/dev/t02p/qa` keeps its fixture
store and scenarios and never uses the real client.

## Community V1 comments and moderation

Mission 2B adds Catalog comments with one level of replies, the Owner-controlled
publication setting and the Owner's moderation surface. Signed in through the
Development entry above, a public user can post a comment on any published
Catalog record and reply once under a root comment. Reads are anonymous:

- `GET /api/catalog/{catalogId}/comments?page&pageSize&pinned` — one combined
  list: `hot`, up to three visible roots ranked by their number of currently
  visible replies (positive scores only; ties to the newer root, then the
  greater id), then `items`, the remaining visible roots newest first. A root
  never appears in both. Each root carries its first three visible replies
  (oldest first) and `replyTotal`, its real visible reply count. A load-more
  request passes the hot ids it already holds as `pinned` (comma-separated, at
  most three): it then receives an empty `hot` and pages the latest list with
  exactly those roots excluded, so the sequence neither repeats nor drops a root
  because the hot selection moved. Offset pagination is still not stable under
  concurrent inserts; the client refreshes the whole list to resynchronize. The
  count and metric are provisional Owner defaults (scope amendment 2026-09-12),
  computed on the Backend from visible rows only; pending and hidden rows never
  count.
- `GET /api/catalog/{catalogId}/comments/{commentId}/replies?page&pageSize` —
  bounded load-more for one thread, oldest first; never ranked.
- `POST` on either path requires the session cookie. `201` means the submission
  is visible; `202` means it entered moderation and awaits Owner approval.

The Owner moderates in Payload Admin (sign in at `http://127.0.0.1:3002/admin`).
The sidebar is grouped around
work: 内容 (资料, 媒体), 社区 (审核队列, 发布设置, 操作历史), 系统与自动化 (操作身份, 批次发布批准, 批处理回执,
API 密钥) and 自动化工具 (编辑批处理工作流); the workspace card on the dashboard
leads to the Community views:

- `/admin/community-moderation` — the review queue, the primary working surface.
  It lists root comments and replies together with status tabs
  (待审核 / 已公开 / 已隐藏 / 全部) whose counts follow the current search and
  filters, server-side search over comment text and the author's handle or
  display name, bounded filters by Catalog record and item type, newest or
  oldest review order, server-side pagination at 20 or 50 per page, row actions
  that show only the applicable transitions
  (pending: 通过并公开 / 拒绝；visible: 隐藏；hidden: 恢复公开), a 更多 menu for
  account suspension or reinstatement behind a confirmation, and selected-item
  bulk actions for at most 50 items on the current page with per-item outcomes
  (applied, state conflict, not found, failed) and a retry of the failed items
  only. Clicking an item opens a context panel (`?item=`) with the full text,
  the root and replied-to context for a reply, the Catalog title and list link,
  the author and account status, the stored state with any parent restriction,
  the item's own audit history and the machine-analysis state ("未接入" when no
  provider is configured). Filters, page and the open item live in the URL, so
  browser back, reload and direct entry agree.
- `/admin/community-moderation/settings` — the publication
  setting: 直接发布 (`DIRECT_PUBLICATION`, the initial default since the
  2026-09-12 scope amendment; forward migration `20260912080000` flips only the
  untouched platform seed and never a saved Owner choice)
  or 先审后发 (`PRE_MODERATION`). Switching affects new submissions only;
  nothing is bulk-published or bulk-hidden, nothing is ever deleted, and a reply
  never bypasses a pending or hidden root.
- `/admin/community-moderation/history` — the operation history, straight from
  the audit table, filterable by action.
- The 资料 filter offers the records present on the current page (plus the one
  already chosen); any record can also be addressed directly through the
  `?catalog=` query. Three pages of synthetic queue items for this workspace
  come from `infra/development/community-acceptance-queue.sql`, applied by hand
  after `dev:migrate` and the acceptance comments:
  `docker compose -f compose.dev.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U yoyi_dev_owner -d yoyi_dev -f - < infra/development/community-acceptance-queue.sql`.

Selected tabs and mode options are black with white text; unselected ones light
gray with dark text (`aria-selected` / `aria-checked`, never a disabled look).
Timestamps are Beijing time (UTC+8) with the precise timestamp in the detail
panel. A failed or conflicting action keeps the item in place with its own
message (refresh for a state conflict, retry for a transient failure); a success
leaves a receipt that a later list refresh does not erase. Every action is a
single audited transition of the comment state machine (`approve`, `reject` =
pending → hidden, `hide`, `unhide`); a stale state is a 409 conflict, never a
silent rewrite or a misleading audit entry.

Admin never touches community tables: it calls the Backend's loopback-only
`/internal/community/*` boundary at `COMMUNITY_OPERATOR_BASE_URL` with the
shared `COMMUNITY_OPERATOR_TOKEN`, both from `.env.local`, and the Backend stays
the sole writer. Catalog titles in the queue come from the Backend's published
Catalog read side, never from a Payload join. The base URL must resolve to
loopback whatever its scheme, so the credential never leaves the machine. Leave
the token unset and the boundary rejects every request, so the moderation views
and the workspace card report that the Backend is not connected rather than
opening. In Development the Admin dev server allows `127.0.0.1`, `localhost` and
the hosts in `MOYA_ALLOWED_DEV_ORIGINS`; without the loopback entries Next
refuses its own dev chunks and the Admin renders blank.

The view's own server routes are `POST /api/community-moderation/*` in Payload.
They carry that prefix deliberately: Payload mounts every endpoint under `/api`,
so a `/community/...` endpoint would land on the public Community read surface
that Web and the Backend already own.

## Content, Threads and Direct Messages (content-community-completion-v1)

Development-only composition (`NODE_ENV=development`), recorded in
[docs/community/content-community-completion-v1.md](community/content-community-completion-v1.md).

- **Editorial content.** Payload Admin gains `articles` (news or academic
  presentation, sections, citations, an optional Catalog cover) and
  `article-collections` (ordered Article/Catalog members). They follow the
  existing editorial rules: automation saves drafts only, publication needs an
  exact-revision approval (`editorial-article-approvals`) unless the Owner
  publishes, withdrawal is Owner-only, hard delete is disabled. The Backend
  reads only the published SQL views (`article_entries`, `article_sections`,
  `article_citations`, `article_collection_entries`,
  `article_collection_members`) through the public read role; `dev:migrate`
  applies the Payload migrations and `grant-public-read.sql`. Web reads
  `GET /api/community/editorial/{articles,collections}[/{id}]` (the existing
  same-origin relay to `/v1/community/editorial/**`) for the 近闻 and 专题 tabs
  and their readers; a withdrawn Article answers 404 and leaves lists and
  Collections.
- **Threads.** The Owner creates and edits Threads in Admin (话题管理) over
  `/internal/community/threads`. A signed-in account posts to a Thread with the
  accepted editor in Thread mode (text plus at most three static images); the
  Work is one identity on the Thread, the author's Works and discovery.
  `GET /api/community/threads` ranks by `Σ weight·2^(-age_days/7)` (Work 1,
  comment or reply 2, like 1) at one server anchor per browsing sequence;
  `POST …/threads/{id}/read` stores the per-user read marker. Article discussion
  uses the existing discussion routes with the target kind `article`.
- **Direct messages.** `GET/POST /api/community/messages` and the
  per-conversation routes (`/with/{userId}`, `/{id}`,
  `/{id}/{hide|unhide| mute|unmute|read}`, `/unread`) relay to
  `/v1/community/messages/**`. The first message to a new pair is allowed;
  further messages wait for a committed reply (`dm_request_pending`); limits are
  2,000 code points, 20 new pairs per UTC day and 20 messages per minute. The
  open conversation polls every 10 s in the foreground (paused while hidden).
  Sign in as two Development accounts at `/dev/community` to exercise the gate.
  Owner moderation (私信处理) reads one named conversation or looks a pair up
  with a stated purpose and removes single messages; every access is audited
  content-free in `community.dm_moderation_events`, and ordinary logs never
  carry bodies.
- **Migrations and grants.** Community migrations `20260922030000_threads`,
  `20260922031000_article_discussion_target` and
  `20260922032000_direct_messages` are append-only; `grant-runtime.sql` carries
  one named `content-community-completion-v1` block. The PostgreSQL suite covers
  Threads and DMs on `TEST_DATABASE_URL` only.

## Optional local read-only browser role

After `dev:migrate`, an operator can explicitly create a local inspection role:

```sh
docker compose -f compose.dev.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U yoyi_dev_owner -d yoyi_dev -f /opt/yoyi/readonly-browser.sql
```

Use `yoyi_dev_browser` with the synthetic password shown in
`infra/development/readonly-browser.sql` and `127.0.0.1:54330/yoyi_dev` in an
existing database client. This optional role can read drafts and CMS metadata,
has no write grants, and defaults to read-only transactions. It is never used by
the Backend. No database browser UI or pgAdmin container enters the product.

## Templates, tests and future work

| Purpose           | Tracked source                                                   | Private runtime file                           |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Local development | `infra/env/local.env.example`                                    | root `.env.local`                              |
| Synthetic tests   | `infra/env/test.env.example`                                     | `.env.test.local` or isolated test process env |
| Staging           | `infra/env/staging.env.example` plus the three service templates | three isolated staging EnvironmentFiles        |
| Production        | `infra/production/env/*.env.example`                             | three controlled service EnvironmentFiles      |

The test template deliberately separates `TEST_DATABASE_URL` (legacy test
schema) from `CMS_TEST_DATABASE_URL` (Payload synthetic schema). Existing
`pnpm test:postgres` and `pnpm test:cms` must use new disposable synthetic
databases; do not point either at `yoyi_dev`, Stage A or real content. Every
suite under `tests/integration/postgres` enforces this before its first database
access: the `TEST_DATABASE_URL` database name must be `moya_synthetic_test` or
carry a whole `test` or `synthetic` segment (CI uses `moya_test`), and
`yoyi_dev` is refused by name; see
`tests/integration/postgres/synthetic-test-database.ts`. That guard reads the
name only. A name, a loopback host or a variable called `TEST_DATABASE_URL` is
not proof that a database is disposable, so the preparation entry points that
run before the suites require a second, explicit identification: the target
database must carry the comment `yoyi-disposable-test-target`
(`scripts/disposable-test-target.mjs`). `node scripts/verify.mjs test` runs
`node scripts/test-target.mjs check TEST_DATABASE_URL` before `pnpm db:migrate`
and sets `MOYA_EXPECT_DISPOSABLE_TARGET=1` so `scripts/migrate.mjs` re-probes
the marker before its first DDL; `pnpm test:cms` applies the same name rule to
`CMS_TEST_DATABASE_URL` and probes the marker before the Payload migrations (the
remote synthetic path keeps its own emptiness preflight instead). The probe is
read-only and compares the connected database's own name with the one the URL
names; `yoyi_dev` is refused by name whatever its comment says.

The marker is set on purpose, never inferred: `compose.postgres.yml` mounts
`infra/test/disposable-test-target.sql` as an initdb script, so a freshly
created test container is marked on first start; CI runs the same file against
its service containers; and a database you know is disposable can be marked with
`node scripts/test-target.mjs mark <VARIABLE> --yes`, which also refuses
`yoyi_dev` and any name without a `test`/`synthetic` segment. An existing test
container keeps its old data directory and stays unmarked until
`docker compose -f compose.postgres.yml down -v` recreates it (a plain
`up --force-recreate` reuses the volume) or you mark it. Two hand-run commands
have narrower coverage: `pnpm test:postgres` keeps the suites' name rule only,
and a bare `pnpm db:migrate` keeps only its existing content-source probe — no
name rule and no marker — so prefer the verification entries. The CMS
verification runner generates an isolated synthetic secret and local media
workspace. Templates never load automatically into CI.

`DATABASE_POOL_MAX` defaults to 5, `DATABASE_IDLE_TIMEOUT_MS` defaults to 10000,
and Payload keeps `max=5`. Local loopback PostgreSQL does not need TLS; remote
TLS must validate CA, optionally through `DATABASE_SSL_CA_FILE` or
`CMS_DATABASE_SSL_CA_FILE`. See the single
[production guide](../infra/production/README.md) for roles, CA and deployment
boundaries; staging shares that topology with independent resources.

Community V1 development runs on this local PostgreSQL: `APP_DATABASE_URL`
(`yoyi_dev_app`, DML-only on the `community` schema) is read only by the Backend
composition root and `APP_MIGRATION_DATABASE_URL` only by the community
migration command. Mission 2A introduces the public-user and session tables;
comment tables arrive with Mission 2B. Profiles, posts, likes, favorites, UGC
media and production filtering are not introduced. The PostgreSQL integration
suite exercises the community family on `TEST_DATABASE_URL`, never on
`yoyi_dev`.
