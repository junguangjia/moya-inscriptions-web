# Owner Amendment — Community V1 scope and architecture

- Status: Active — approved by the Owner on 2026-09-11 with the decisions
  recorded in section 11; narrowly amended by the Owner on 2026-09-12 as
  recorded in sections 12 and 13.
- Effective date: 2026-09-11; section 12 effective 2026-09-12.
- Authority: explicit Owner "Community V1 scope decision" instruction of
  2026-09-11 (Mission 1 of the Community sequence); explicit Owner instruction
  of 2026-09-12 for section 12.
- Applies to: public-user identity; authentication and session ownership; the
  Comment V1 model, its API boundary and its minimum moderation; the integration
  boundary with Draft PR #106; the frozen Mission 2A / 2B / 2C sequence.

This amendment freezes scope and architecture. It implements nothing: no table,
migration, endpoint, route, session, provider or moderation surface. The only
code in Mission 1 is the freeze guard in section 9. Every later mission still
freezes its own Scope, non-goals, Behavior Matrix and Plan and passes
independent review and the applicable Owner gates.

## Current state this amendment starts from

Written against `origin/main` `d926926da7a9ec86a655c95108735efccfc741ea` (#108)
and PR #106 at `8e7d12a` — its original head `638c0b7` plus the Owner's
real-device layout changes.

- The repository has no public-user, session, comment or moderation table,
  migration, Contract, endpoint, route handler, client module or environment
  variable. `APP_DATABASE_URL` is reserved in documentation only
  (`docs/architecture.md`, `docs/development.md`, `infra/production/README.md`).
- The only authenticated identity is Payload `users` (`apps/admin/src/users.ts`:
  `role: owner | automation`, `scopeCatalogIds`, `payload-token` cookie). Admin
  access is Owner-only.
- The Backend HTTP surface is `GET /health`, `GET /v1/catalog`,
  `GET /v1/catalog/{catalogId}` and `GET /v1/catalog-search`. Web reaches it
  only through `apps/web/lib/public-api` server modules, from the allowlisted
  request-render loader and from the same-origin route handlers under
  `apps/web/app/api/catalog` and `apps/web/app/api/catalog-search`.
  `infra/production/nginx/yoyi.conf.template` proxies `/api/` to Payload and
  only `/api/catalog`, `/api/catalog/` and `/api/catalog-search` to Web.
- `packages/contracts` exports `.`, `./types`, `./schemas`, `./json-schema`,
  `./internal/catalog-import` and `./internal/editorial`; `ApiErrorCode` is
  exactly
  `INVALID_QUERY | ITEM_NOT_FOUND | SERVICE_UNAVAILABLE | INTERNAL_ERROR`.
  Migrations are append-only and `scripts/migrate.mjs` accepts exactly
  `MOYA_CONTENT_SOURCE=legacy | payload`.
- PR #106 (`codex/comment-feature-main`, QA-only) adds
  `apps/web/features/comments/` and the seam
  `T02pProductPreview.renderCommentSection?(catalogId)` →
  `PreviewCatalogDetailOverlay.commentSection` →
  `CatalogDetailExperience.commentSection` →
  `CatalogDetailScreen.commentSection` (rendered through
  `CatalogDetailContentPager.comments` on phone and tablet-portrait, the
  landscape aside on tablet-landscape, inline otherwise) → `CommentSection`,
  wired only inside the QA harness (`/dev/t02p/qa`) from `useQaCommentStore`
  fixtures. Its own E2E asserts that the Formal compositions render no comment
  section. The Owner recorded real-device visual acceptance for `8e7d12a` on
  2026-09-11; the identical patch was rebased as `f48ee2f` and squash-merged as
  `b27c85c`. It is not redesigned here.

## Rule classification

- MODERNIZE Constitution §6 and React current-authority amendment §4 (general
  deferral of unapproved domains) and Constitution §19, which requires each
  social domain to have its own approved Scope, Behavior Matrix and
  contract/domain evolution: public-user identity, sessions and Catalog comments
  become one approved bounded domain, Community V1, implementable only through
  Missions 2A → 2B → 2C below. The "Phase 3 / not part of this work" wording in
  `docs/architecture.md`, `docs/development.md` and `infra/production/README.md`
  is superseded for this domain; the mission that implements each part updates
  those documents. Every other social capability stays deferred.
- PRESERVE, with one narrow modernization, ADR 0006 §6 (Official
  Catalog、UGC 与 media — the accepted statement of the fact boundary first
  recorded in the now-superseded ADR 0003 as
  `CatalogRecord != CommunityPost != Product / Order`): a comment references a
  `CatalogId`; no shared content base class; `CatalogSummary`, `CatalogDetail`
  and Search DTOs gain no comment or user field. Its rule that user submissions
  pass moderation and a platform publication decision before association with a
  Catalog Entity is preserved as the default `PRE_MODERATION` mode; the
  Owner-controlled `DIRECT_PUBLICATION` mode (section 5) is the one narrow,
  explicit modernization, for Catalog comments only — a comment references a
  `CatalogId` and never enters Catalog content.
- PRESERVE ADR 0010, the P2-04 amendment and the `docs/architecture.md` role
  statement ("Payload users serve Owner/automation only"): Payload users remain
  Owner/automation identities; no public CMS management API; no second editable
  content master; the CMS runtime role receives no community privilege.
- PRESERVE Constitution §1, §3, §4, §5, §7, §17 and the React current-authority
  amendment: one Detail implementation; QA fixtures stay semantically distinct
  and never enter PostgreSQL, Public API or Contracts; PostgreSQL → Public API →
  Web data authority; no frontend PostgreSQL; Contracts only in
  `packages/contracts`; append-only migrations; separate database roles;
  machine-verified review; Owner visual gates; separate Production authority.
- RETIRE: none.

## 1. Public-user identity

```text
PublicUser
  id           PublicUserId — opaque, platform-generated, immutable; never a
               provider id, phone, e-mail, handle, Payload row id or serial
  handle       system-assigned, unique, normalized, bounded, no whitespace
  displayName  bounded plain text; the rendered author name; Chinese supported;
               duplicates allowed; set explicitly in Development test data
  avatar, bio  in the Owner's conceptual model; no V1 write path, so no column
               or DTO field until a later amendment adds one
  status       active | suspended
  createdAt / updatedAt
```

```text
PublicUserId != Payload users.id != CatalogId != SourceId != MediaId
Public product user != Payload Admin / Operator
```

- Payload `users` keep exactly `owner | automation`. Payload Admin accounts
  never become ordinary public-user accounts; public users never obtain Admin,
  REST, MCP or CMS Local API access. No shared cookie, secret, table, schema or
  database login. No Payload collection references a `PublicUser`, and the
  PublicUser table references no Payload user.
- Public users are Backend-owned rows in the community namespace (section 2),
  never a Payload collection and never reached through `CMS_DATABASE_URL`.
- Public DTOs: `PublicUserProfile { id, handle, displayName }` returned only to
  the session owner; `CommentAuthor { id, displayName }` embedded in comments
  (no avatar in any V1 DTO: Mission 2C maps `avatarSrc: null` so PR #106 renders
  its initial-glyph fallback; the avatar affordance is treated like the other
  unsupported affordances under decision 5). `status`, timestamps and credential
  linkage never appear in a Public DTO. `PublicUser` carries no credential
  material; credential bindings are introduced only by an Owner-authorized
  provider task.
- QA identities (`qa-user-01` / 访碑者 and the fixture comment authors) remain
  presentation fixtures: never a fallback for a missing session, never bound to
  a `PublicUserId`, never in PostgreSQL.
- Development test accounts are real `PublicUser` rows seeded only in
  Development; QA fixture users are never promoted into identities.
- V1 has no public registration, public profile page, profile editing or
  handle-change flow (decision 3, decision 7).

## 2. Authentication and session ownership

The Backend owns authentication and session state: it alone creates, validates,
revokes and stores sessions as server-side records in the community namespace.
Web owns exactly two things: one browser cookie carrying an opaque session
reference and the same-origin route handlers that forward it. Web never mints,
signs, decodes or validates a session and holds no signing secret. Admin owns
nothing here: `payload-token` is never forwarded to the Backend and a public
session credential is never forwarded to `CMS_INTERNAL_URL`.

```text
Browser ── one HttpOnly cookie ──▶ Web route handler ── bearer credential ──▶
Backend ── session lookup in the community namespace ──▶ PublicUserId | 401
```

- Cookie: dedicated name distinct from `payload-token`; `HttpOnly`; never
  readable by browser JavaScript, never in `localStorage` or a URL. Remaining
  cookie attributes are Mission 2A Plan decisions.
- Web → Backend: the route handler reads the cookie from the incoming request
  and passes it explicitly to an `apps/web/lib/public-api` server function (the
  existing `fetchEditorialPreview(id, { session })` pattern).
- Backend: sessions are opaque server-side records with real issuance,
  validation on every request, expiry and revocation/logout, all delivered in
  Mission 2A; Web-asserted identity headers are never trusted. Token storage and
  expiry mechanics are Mission 2A Plan decisions.
- Development sign-in (decision 2): dedicated Development test accounts with
  real Backend session issuance, validation, expiry and revocation/logout. The
  Development authentication entry is composed only under `NODE_ENV=development`
  and is unavailable in Production.
- Providers: none is chosen or integrated — no WeChat login, SMS, e-mail
  delivery, Apple/Google OAuth, CAPTCHA, passwords or password reset. Production
  has no sign-in path until a provider is separately authorized (decision 7).

Database domain and role:

- `APP_DATABASE_URL` is the Community runtime role: DML-only, read at runtime
  only by the `services/backend-production` composition root. No other workspace
  reads it (freeze row 5 walks `apps`, `services`, `packages` and `scripts`).
  The Payload runtime role and the Public read role receive no privilege on
  community relations.
- Community relations (public users, sessions, comments, moderation state) live
  in their own PostgreSQL schema namespace, never among Catalog relations in
  `public`. No cross-family foreign key; a write requires a currently published
  Catalog record, checked by a mechanism decided in the 2B Plan.
- Community migrations are a Backend-owned append-only family separate from
  `legacy` and `payload`, never selected by `MOYA_CONTENT_SOURCE`, applied only
  through the explicit migration command with migration-privileged credentials;
  startup never performs DDL. Directory, selector and whether a separate
  backend-only adapter workspace is needed at all are Mission 2A Plan decisions.
- Sessions, tokens and public-user rows never enter logs, Public responses,
  Contracts, QA fixtures, importer input or workbooks.

## 3. Comment V1 model

```text
CatalogComment
  id            CatalogCommentId — opaque, platform-generated
  catalogId     CatalogId of a currently published Catalog record
  author        PublicUserId
  text          plain text; trimmed; bounded length fixed by the 2B Contract
                review and enforced by the Backend
  createdAt     ISO 8601 UTC
  moderation    pending | visible | hidden — the entry state follows the
                publication setting (section 5)
  replies       CatalogCommentReply[] — exactly one level, no children

CatalogCommentReply
  id, rootCommentId, author, text, createdAt, moderation   as above
  replyTo       optional CommentAuthor (PR #106's 回复 X： pointer)
```

- Reply depth is one. A reply belongs to one root comment and never has
  children; an answer to a reply is a sibling reply under the same root carrying
  `replyTo`. No recursive discussion trees. Larger reply sets are served through
  bounded pagination/load-more, never an arbitrary lifetime reply-count cap
  (decision 6).
- Ordering is server-defined and deterministic, fixed by the 2B Contract review
  together with the text bound; Web renders the page in server order. Since
  section 12 the root listing is one combined list: a small Backend-computed hot
  section first, then the remaining roots newest first, no root in both. The
  `isQaGenerated` partition and the 热门/最新 reversal in PR #106's
  `CommentSection.sortedItems` are QA-only ordering inputs that Mission 2C
  removes under prop narrowing; the 热门 sort control (a client-side reordering
  of whatever is loaded) stays hidden in the real composition (decision 5) — the
  hot section is not that control.
- Public reads return `visible` items only; a reply never bypasses a hidden or
  pending root's visibility restriction; nothing is deleted; moderation state
  never appears in Public DTOs.
- `text` is plain text: no rich text, mentions, links, media, stickers or
  attachments. Whether the composer mirrors the text bound is a 2C Behavior
  Matrix row under the visual gate. PR #106's `CommentMediaPresentation`,
  `likeCount`, `liked`, `isQaGenerated` and `createdAtLabel` are presentation
  fields, not Contract fields.
- Comments never alter Catalog facts, never enter Catalog DTOs, importer,
  workbook, CMS or Search V1; no comment count is added to Catalog DTOs.

Public DTOs: `CommentAuthor`,
`CatalogComment { id, catalogId, author, text, createdAt, replies, replyTotal }`,
`CatalogCommentReply { id, author, text, createdAt, replyTo? }`,
`CatalogCommentPage` (the `CatalogPage` shape and invariants over `items`, plus
the `hot` section of section 12) and `CatalogCommentReplyPage` (the
`CatalogPage` shape; the pagination support for reply load-more under decision
6).

## 4. API boundary and minimum contract surface

```text
Browser → Next.js Web
  → same-origin /api/* route handler → apps/web/lib/public-api server module
  → Backend /v1/* (services/backend-runtime) → services/api community module
  → community PostgreSQL adapter (App role) → PostgreSQL
```

Web never queries PostgreSQL, never imports backend, adapter or CMS modules, and
performs business HTTP only inside `apps/web/lib/public-api`.

The four operations the Owner named are the minimum business scope of Community
V1. They are not a ban on the support the missions need to deliver them: session
lifecycle (Development sign-in and sign-out, `GET /v1/me`), the Owner's
authenticated operator boundary for moderation and the publication setting, and
bounded reply pagination/load-more. No further business operation is added
without a further amendment.

| Operation        | Backend endpoint                                            | Auth      | Result                       |
| ---------------- | ----------------------------------------------------------- | --------- | ---------------------------- |
| Read comments    | `GET /v1/catalog/{catalogId}/comments?page&pageSize&pinned` | anonymous | `CatalogCommentPage`         |
| Create comment   | `POST /v1/catalog/{catalogId}/comments`                     | session   | `201 CatalogComment`         |
| Create reply     | `POST /v1/catalog/{catalogId}/comments/{commentId}/replies` | session   | `201 CatalogCommentReply`    |
| Current identity | `GET /v1/me`                                                | session   | `PublicUserProfile` or `401` |

- Session establishment and termination for Development test accounts are
  delivered in Mission 2A as support operations; the Development entry is never
  composed in Production. External providers remain deferred (decision 7).
- Same-origin Web routes: comments under `/api/catalog/{catalogId}/comments`
  (already routed to Web by `location ^~ /api/catalog/`); identity and the
  Development session lifecycle under `/api/community/`. Mission 2A adds exactly
  one Nginx line routing `/api/community/` to Web and a current-truth assertion
  that it never routes to Admin.
- Transport pattern: each operation follows the existing `catalog-search`
  route-handler → `apps/web/lib/public-api` server-function → browser-client
  pattern; every new route, server function, client module and importer gets an
  explicit allowlist entry in `tests/unit/architecture/workspace-scanner.ts`,
  and each client-consumed DTO name is added to `allowedClientContractTypes` by
  the mission that first consumes it in a Client Component; nothing by wildcard.
  File layout is a Plan decision of the mission that adds it.
- Public DTOs are added to `packages/contracts` (`schemas.ts`, `types.ts`,
  `index.ts`, `json-schema.ts`) and to the OpenAPI document by the mission that
  introduces each name. Mission 2B adds the server-only operator-boundary shapes
  (moderation commands and the publication setting) on an internal subpath and
  updates freeze row 1 in the same PR (decision 4).
- `ApiErrorCode` gains exactly `UNAUTHENTICATED` (401; Mission 2A) and
  `INVALID_INPUT` (rejected body; Mission 2B). Unknown or unpublished
  `catalogId`, and unknown or hidden root comment, return `404 ITEM_NOT_FOUND`.
  Public responses never expose SQL rows, driver errors, session tokens,
  moderation records, hidden content or `status`.
- No new environment variable enters `apps/web` for Community.

## 5. Moderation minimum

```text
Comment   pending → visible       (Owner approval)
          visible ⇄ hidden        (hide / unhide)
User      active ⇄ suspended      (suspend / reinstate)
Setting   PRE_MODERATION | DIRECT_PUBLICATION   (Owner-controlled, global)
```

- The Owner is the only V1 moderator; `automation` never moderates. Each
  moderation action records who and when; the record shape is a 2B Plan
  decision. The operator label is never a `PublicUserId` and never a Payload row
  id reused as public identity.
- Suspension revokes the user's sessions and refuses new writes; it changes no
  comment's moderation state. A suspended author's `visible` comments stay
  readable until hidden individually.
- The Backend is the sole writer of community data, including moderation. Admin
  may act only as a client of the Backend: Payload holds no comment or
  public-user collection and the CMS runtime role has no community grants. The
  Owner interface is the existing Payload Admin calling an authenticated Backend
  operator boundary (decision 4); public-user identity stays separate from
  Payload Owner/automation accounts.
- Publication policy (decision 1): one comment system with an Owner-controlled
  global setting in the existing Payload Admin interface. `DIRECT_PUBLICATION`
  (the initial default since section 12): new comments and replies become
  visible after successful validation; the Owner can still hide them afterwards.
  `PRE_MODERATION`: new comments and replies enter `pending`; only Owner
  approval makes them visible. The Backend owns, persists and enforces the
  setting; changing it requires no code change, restart or redeployment.
  Switching affects new submissions only — existing pending items stay pending,
  visible items stay visible, hidden items stay hidden; no bulk publication or
  bulk takedown is part of the setting. Replies never bypass a hidden root
  comment's visibility restriction. The setting and moderation are implemented
  in Mission 2B; the corresponding user-facing states in Mission 2C.
- No AI moderation, trust scores, reputation, strikes, moderator hierarchies,
  large review queues, keyword engines or user reporting.

## 6. Relationship to PR #106

- PR #106 is the accepted presentation direction: the Owner recorded real-device
  visual acceptance on 2026-09-11 for `8e7d12a` (its original head `638c0b7`
  plus the Owner's layout changes). A conflict-free rebase onto `main` that
  changes no file under `apps/web/features/comments/`,
  `apps/web/features/detail/` or `apps/web/features/product-preview/` keeps that
  acceptance; any other change re-opens the visual gate. This amendment does not
  redesign it, and no mission may alter its Detail, comment section or composer
  to ease implementation (Constitution §17.4). Missions 2A and 2B do not depend
  on it; Mission 2C requires it merged. Merging it does not expose QA comments
  in Production.
- Mission 2C replaces only the data seam:

```text
today:   QA fixtures → useQaCommentStore → CommentSection → Catalog Detail
future:  Backend API → same-origin route → real comment client → CommentSection → Catalog Detail
```

A one-way mapper from `CatalogComment*` DTOs to the #106 presentation types
lives beside the loader; presentation types never feed persistence, Contracts or
the API. Allowed `CommentSection` changes are limited to replacing QA-only
inputs with contract-derived props, re-deriving the existing loading skeleton
from the real client instead of the QA `scenario` prop, and adding the truthful
signed-out and unavailable states, each frozen in the Mission 2C Behavior Matrix
under the Owner visual gate. No other markup, layout, gesture, pager or composer
change; no second comment component; no second Detail.

- The Comment V1 contract carries no like, sort or media data. The first real
  comment UI implements text comments and replies; likes, 热门 sorting, upload
  and other unsupported controls are hidden in the real composition, and no fake
  interaction counts or implied functionality are shown (decision 5). The
  image/sticker presentation does not authorize media upload, media fields or
  sticker packs in Community V1; it stays in the QA prototype.
- QA fixtures (`comment-scenarios.ts`, `useQaCommentStore`, `qaCurrentUser`) and
  the #106 tests are preserved for deterministic visual and E2E scenarios inside
  `/dev/t02p/qa`, available by default in Development. The Formal root and
  `/dev/t02p` compose the real client only and import no QA fixture, scenario or
  store.

## 7. Behavior Matrix ownership and Production exposure

Every mission freezes its own Behavior Matrix before implementation
(Constitution §7), covering only the surfaces it delivers: 2A `GET /v1/me`, the
cookie relay and `401`; 2B the three comment operations, `404` /
`INVALID_INPUT`, hidden filtering and moderation effects; 2C the Formal Detail
states (signed-out, empty, loading, pending, unavailable, create and reply,
session expiry) under the Owner visual gate. No matrix row is frozen here.

Production exposure of any Community surface remains deferred (decision 7): it
requires an authorized identity provider, Backend runtime configuration, the
P2-R2 release gates and separate Owner Production authority. Merged code alone
enables nothing in Production. `/dev/t02p/qa` keeps returning `404` in
Production; its QA store, six scenarios and `qaCurrentUser` stay available by
default in Development; QA identities never enter PostgreSQL, Contracts or the
API.

## 8. Frozen Mission 2 sequence

```text
Mission 1   this amendment + freeze guard          — governance and one architecture test
Mission 2A  public-user identity + auth/session foundation         — one PR
Mission 2B  comment contract + PostgreSQL + API + moderation       — one PR
Mission 2C  connect the accepted #106 seam to the real Comment API — one PR
```

- 2A delivers: `PublicUser` and session persistence (community namespace,
  migration family, `APP_DATABASE_URL` role, local role and grant), real Backend
  session issuance, validation, expiry and revocation/logout, `GET /v1/me`, the
  Development-only sign-in/sign-out path using dedicated test accounts, the Web
  cookie relay and `/api/community/*` routes, the Nginx line, `PublicUserId` /
  `PublicUserProfile`, `UNAUTHENTICATED`, OpenAPI, scanner allowlists, the guard
  updates listed in section 9, tests for authenticated/unauthenticated access,
  expiry, logout/revocation, account isolation and Production exclusion of the
  Development entry, and a simple working Development entry for Owner
  acceptance. No comment table, endpoint or UI; no public registration; no
  external provider.
- 2B delivers: comment and moderation persistence, the comment and moderation
  use-cases and ports inside the `community` module that 2A creates, the three
  comment operations with bounded reply pagination, `CatalogComment*` DTOs,
  `INVALID_INPUT`, OpenAPI, the same-origin comment route handlers, server
  functions and client seam, the Owner-controlled publication setting, and the
  Payload Admin moderation interface calling the authenticated Backend operator
  boundary (decisions 1 and 4). It changes no Formal root composition and no
  `CommentSection` code.
- 2C delivers: the real comment client, loader and DTO → presentation mapper,
  Formal root and `/dev/t02p` composition through the frozen seam,
  `CommentSection` prop narrowing, the signed-out, pending and unavailable
  states, hiding of unsupported controls, the approved Behavior Matrix, unit and
  E2E coverage, and Owner real-device acceptance. It adds no Contract, migration
  or Backend change.
- Each mission is an independently reviewable Draft PR from a fresh
  `origin/main`. The three stages are never combined; no mission pre-creates the
  next mission's tables, Contracts, routes or UI; 2B starts only after 2A is
  merged and verified at the merged head; 2C only after 2B is merged and PR #106
  is accepted and merged.

## 9. Freeze guard

Mission 1 adds one architecture test,
`tests/unit/architecture/community-v1-freeze.test.ts`, pinning six facts that
are true on `main` today. Each row names the only mission(s) allowed to change
it; each named mission replaces the row with the new exact value in the same PR
that changes it. Rows 2, 3 and 5 overlap facts also pinned by
`tests/unit/backend/openapi-contract.test.ts` and
`tests/unit/backend/migration-routing.test.ts`, and the contracts export list is
pinned by `tests/unit/architecture/contracts-surface.test.ts`; the mission that
changes a row updates those existing tests in the same PR. The guard pins
nothing else: what each mission may add or change is bounded by sections 4 and
8, and no mission changes a pinned value except the mission named in its row.

| #   | Fact pinned today                                                                                                                                                                                      | Changed by                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | `packages/contracts/src/internal` holds exactly `admin-mcp`, `catalog-import`, `community-operator`, `editorial`                                                                                       | 2B (operator-boundary shapes, decision 4); 2026-11-03 Admin MCP amendment (`admin-mcp`)         |
| 2   | `apiErrorCodeSchema` lists exactly the four existing codes                                                                                                                                             | 2A (`UNAUTHENTICATED`), 2B (`INVALID_INPUT`)                                                    |
| 3   | The Backend router matches exactly `/health`, `/v1/catalog`, `/v1/catalog-search` and one `/v1/catalog/{catalogId}` regex; no comment/community/me/session token                                       | 2A (`/v1/me`, Development session lifecycle), 2B (comment, reply-pagination and operator paths) |
| 4   | `services/api/src/modules` is exactly `catalog`                                                                                                                                                        | 2A (`community`)                                                                                |
| 5   | `scripts/migrate.mjs` accepts only `legacy` / `payload` and contains no `community` or `APP_DATABASE_URL` token; `APP_DATABASE_URL` appears in no file under `apps`, `services`, `packages`, `scripts` | 2A                                                                                              |
| 6   | Payload `users` role values are exactly `owner`, `automation`, `ai_operator`                                                                                                                           | 2026-11-03 Admin MCP amendment (`ai_operator`)                                                  |

## 10. Explicit non-goals

Community V1 does not include, and this amendment does not authorize: posts;
following; a social feed; direct messaging; notifications; user-uploaded media
(comment images, stickers, avatars); marketplace; payments; recommendations;
Redis; another database; Firebase; Supabase; a large authentication framework;
WeChat login, SMS, e-mail delivery, Apple/Google OAuth, CAPTCHA or
password-reset infrastructure; AI moderation, trust scores, reputation, strikes,
moderator hierarchies or large review queues; refactoring of unrelated code;
redesign of Catalog, Search, CMS, Detail or Viewer.

Deferred pending their own Owner decision: comment editing and author
self-deletion, persisted likes or reactions, user reporting, public profile
pages, profile or handle editing, comment counts on Catalog DTOs, nested reply
trees, rich text, mentions and links, account deletion and personal-information
erasure, and write rate limits or other anti-abuse controls beyond the text
bound; V1 ships none. This deferral is not a waiver: anti-abuse, account and
content handling, and compliance work are preconditions to be decided before any
future public release (decision 7).

## 11. Owner decisions recorded on 2026-09-11

These product decisions are approved and are not reopened by any mission.

1. Publication policy: one comment system with an Owner-controlled global
   setting in the existing Payload Admin interface — `PRE_MODERATION` (default)
   or `DIRECT_PUBLICATION` — owned, persisted and enforced by the Backend as
   specified in section 5.
2. Development sign-in: dedicated Development test accounts with real Backend
   session issuance, validation, expiry and revocation/logout; QA fixture users
   are never promoted; the Development authentication entry is unavailable in
   Production.
3. Identity names: an immutable opaque user ID and a system-assigned unique
   handle for Development accounts; `displayName` kept separate, supporting
   Chinese and allowing duplicates, set explicitly in Development test data;
   public registration and profile/handle editing remain deferred.
4. Moderation surface: Payload Admin as the Owner interface, calling an
   authenticated Backend operator boundary; the Backend remains the sole
   community-data writer; public-user identity stays separate from Payload
   Owner/automation accounts.
5. First real comment UI: text comments and replies first; unimplemented likes,
   hot sorting, upload and other unsupported controls are hidden in the real
   composition; the QA prototype and fixtures are preserved; no fake interaction
   counts or implied functionality.
6. Replies: one root-comment level plus flat replies; larger reply sets through
   bounded pagination/load-more, not an arbitrary lifetime cap; no recursive
   trees.
7. Production: external identity providers, public registration, public
   community exposure and deployment remain deferred; the separate cloud/filing
   workflow is not resumed by Community work.

Historical decisions remain unchanged and are interpreted under this amendment.
This amendment records authorization and boundaries, not completion or
Production approval.

## 12. Owner scope amendment of 2026-09-12 (narrow)

Recorded from the Owner's explicit instruction of 2026-09-12, while Mission 2B
(PR #112) was still an unmerged Draft. It supersedes exactly three earlier
points and reopens nothing else: the seven decisions of section 11 stand.

1. Comment display — hot first, then latest, one combined list. The root listing
   is a small hot-comment section at the top followed by the remaining root
   comments newest first. A root shown in the hot section never appears again in
   the latest section, nor through load-more. This is not a pair of mutually
   exclusive 热门/最新 tabs, and it is not permission to rank every comment by
   popularity. Provisional implementation defaults, adjustable by the Owner and
   explicitly not a permanent ranking formula:
   - at most 3 hot root comments;
   - heat = the actual number of currently visible replies under that root;
   - only roots with a positive score qualify; otherwise only the latest list is
     shown;
   - deterministic ties: newer creation time, then the stable id. The selection
     is computed on the Backend from eligible database rows, never by sorting
     the comments already loaded in the browser; pending and hidden comments and
     replies never contribute. No likes system, recommendation engine, Redis or
     ranking service is introduced; nothing is ever ranked by fabricated QA
     likes or counts. The flat reply relationship and reply pagination are
     unchanged; root popularity never sorts replies. The implementation keeps
     the hot selection stable during a loaded browsing sequence (the client pins
     the hot ids it holds on load-more and the Backend excludes exactly those
     from the latest pages) and refreshes the combined view coherently on
     demand; a timestamp tie-breaker alone is not claimed to guarantee
     pagination stability under concurrent changes. Contract consequences, the
     only ones needed: `CatalogCommentPage` gains the `hot` section (at most 3
     `CatalogComment`, empty on a pinned request); `CatalogComment` gains
     `replyTotal`, the real count of currently visible replies (what tells a
     reader whether load-more has anything left, and the hot score); the read
     operation accepts `pinned`. Supersedes the newest-only root ordering of
     section 3 and the earlier deferral of a hot-comment display in sections 6
     and 11.5 to the extent described here.
2. Default publication mode — `DIRECT_PUBLICATION`. The initial default of the
   publication setting changes from `PRE_MODERATION` to `DIRECT_PUBLICATION`.
   Both Owner-controlled modes stay in the existing Payload Admin surface with
   the semantics of section 5; switching still requires no code change, restart
   or redeployment and affects future submissions only (pending stays pending,
   visible stays visible, hidden stays hidden; a reply never bypasses an
   unavailable, pending or hidden root). Direct publication bypasses no
   authentication, validation, suspension check or other safeguard. Fresh
   initialization defaults to `DIRECT_PUBLICATION` through a forward-only
   migration that changes only the untouched platform seed; a saved Owner choice
   is never overwritten by startup or migration, and the existing local
   acceptance database receives one explicit, recorded change through the
   operator boundary. The 201-visible / 202-pending distinction stays.
   Supersedes the `PRE_MODERATION` default in sections 5 and 11.1 and the
   default noted in the rule classification above.
3. Acceptance preview. The Owner authorizes the minimum Development-only
   frontend integration required to accept this behavior visually: the accepted
   #106 Detail/comment presentation connected to the real Development Backend
   through the section 4 transport, under a Development-only route, reusing the
   accepted layout and components without redesign and without substituting
   `useQaCommentStore` for the real path (the QA prototype stays separate).
   Backend/contract changes and the frontend preview stay separately reviewable.
   This does not merge Mission 2C's Formal-root composition or its visual gate;
   those remain as frozen in section 8.

## 13. Owner instruction of 2026-09-12: the moderation workspace (bounded)

Recorded from the Owner's rejection of the first Community moderation Admin
experience and the instruction that replaced it. It permits exactly the
following bounded changes and reopens nothing in sections 11 and 12.

1. Comment state machine: one explicit, audited `reject` edge (pending → hidden)
   joins `approve`, `hide` and `unhide`. Rejection is recorded as its own
   action, distinct from hiding previously published content. Transition guards
   stay; nothing is deleted; a stale state is a conflict that records nothing.
2. Admin request boundary: the Payload endpoints validate the complete request
   envelope strictly (including the platform-format subject id), map the id into
   the Backend route and forward only the validated command body. The acting
   identity is the server-side operator label; no request field names an actor.
3. Review workspace in the existing Payload Admin: a queue with status counts,
   server-side search and bounded filters, server-side pagination, a review
   order independent of the public hot/latest ordering, a context panel with
   thread context and the item's audit history, a separate publication-setting
   view and an operation-history view backed by the audit table; navigation
   organized around work (the dashboard as 工作台; sidebar
   groups 内容, 社区, 系统与自动化 and 自动化工具 for the editorial batch
   workflow) with a workspace card carrying a few real numbers. Payload stays
   the only Admin application; no collection slug is renamed and no database
   ownership moves. Catalog context reaches Admin only through the Backend's
   published read side.
4. Bounded bulk moderation: selected items on the current page only, at most 50,
   through the same authorized operations and transition checks as a single
   action, with per-item success, conflict and failure reporting and a retry of
   failed items only. Never "every matching record"; never bulk suspension or
   deletion; separate from the publication setting, which still changes no
   existing comment.
5. Analysis boundary: a typed, provider-independent, advisory
   `CommentAnalysisPort` and the result shape of section 8 of the Owner's
   instruction, documented in `docs/community-analysis-boundary.md`. Today only
   a disabled adapter and contract-level tests exist. Analysis never changes
   publication or account state, an unconfigured or failed analysis is never a
   clean verdict, machine findings stay apart from the authoritative human audit
   trail, and no paid provider, external transmission, scheduler, job system or
   analysis table is introduced. The Backend read services the Admin uses are
   the ones a later REST or MCP adapter reuses.

Everything already approved stays: `DIRECT_PUBLICATION` as the fresh-install
default, the Owner's switch to `PRE_MODERATION`, the saved local choice never
reset by startup or migration, policy changes affecting only later submissions,
replies never bypassing a pending or hidden root, the public hot section
followed by the remaining latest roots without duplicates, and the accepted
public Detail, Viewer and comment layout.
