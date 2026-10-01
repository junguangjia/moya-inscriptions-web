> 2026-09-11 update: T09-F1、Search V1、P2-04 Payload editorial/MCP
> automation 与 P2-R2A 均已合入 `main`。P2-R2B Stage
> B 目标环境已装载 3 条批准资料与 20 个媒体对象并在目标内发布，但公开入口、媒体自定义域名、Production 启动与发布仍未完成，该云端轨道明确 parked。当前没有公开的 Production
> release。Public
> user/community 开发可独立于 parked 的 Production-release 轨道继续，但须先通过其自身的 Owner
> amendment（Community V1）冻结范围。

# 当前项目状态

能力基线审计：2026-09-04；本轮有限事实更新：2026-09-17

本文件是 current project status、active Phase 2 work、Production
gaps 与远端 lineage disposition 的唯一动态来源。历史实现过程保留在 PR、ADR 与
`docs/history/`，不作为当前任务状态。

## 基线读取规则

```text
Shared development branch:
main

Audited capability baseline:
14ee3c0c57a73ee3a3995e9d64c698243c0a2447
feat(import): add Catalog import v2 (#86)
```

该 SHA 是本次全仓审计所依据的不可变能力基线，不是一个会自动更新的“current
head”字段。每个新任务开始前必须 fetch 并实时解析最新
`origin/main`；不得复制本文件中的历史审计 SHA 作为分支起点。

`main` 是唯一长期 shared branch、默认分支和当前开发主线。

## 当前阶段

```text
Phase 2 — trustworthy read-only digital Catalog MVP
```

目标是发布具有受治理内容、真实媒体、正式搜索、最小 Operator
governance 和可恢复 Production operations 的只读 Catalog。

Phase 2 的 Production-release critical path 不包含普通 public-user
identity、favorites/likes、comments、posts、user upload、social
following、messaging、native mobile apps、transactions、AI
recommendation、OCR 或 knowledge graph。自 2026-09-11 起，public
user/community 开发作为独立轨道进行，不以 Production
release 为前提，也不阻塞 Production release；其第一步是 Community V1
scope/architecture
amendment，在该 amendment 获批前不得实现 community 持久化、身份或 API。

## 已完成的 Formal Web

### Formal root

```text
apps/web/app/page.tsx
  → request-rendered Production states
  → T02pProductPreview
  → ProductShell
```

Formal `/` 已完成 React cutover。旧 static T02 document 不再是 Formal
runtime；它只保留为 direct Prototype 和 legacy regression evidence。

### Product Shell

当前正式 React Product 包含：

- Home、Inscriptions、Calligraphy；
- Settings、theme 与 feed-layout preference；
- platform/orientation handling；
- Back/Forward 与 canonical query/history；
- per-destination scroll restoration；
- Detail scroll restoration；
- opener focus restoration；
- mutually exclusive Topic、Detail、Viewer 与 Settings layers；
- Search V1 presentation（fullscreen search、Search → Detail → Back）；
- QA long-press quick actions（Development/QA only）；
- Development/QA 与 Production isolation。

### Home and Browse

```text
Home Discover:
real Public Catalog first page

Home Nearby:
truthful unavailable in Production

Home Topics:
truthful unavailable in Production

Inscriptions:
kind=inscription + explicit progressive loading

Calligraphy 全部:
kind=calligraphy + explicit progressive loading

Calligraphy 墨迹 / 拓本:
truthful classification-unavailable
```

Initial server page is `page=1&pageSize=24`. Later pages use explicit
“继续加载”, preserve existing records on failure, support same-page retry, and
retain mounted list/scroll/opener state across Detail/Viewer journeys. Home
Discover does not yet progressively load; this remains a separate known product
gap (see “下一步任务”).

No canonical `ink/rubbing` field exists. Formal UI must not infer classification
from titles, aliases, summaries, periods, media, or hard-coded IDs.

### Detail and media

One shared Catalog Detail and Viewer currently support:

- truthful loading/not-found/unavailable/unexpected-error states；
- Catalog Content V1 Detail presentation（contributors、script
  style、transcription、historical context、scholarly research、scoped
  citations；PR #89）；
- no-media、single-media、multiple-media and failed-media states；
- bounded Detail Carousel；
- full-screen Viewer；
- fit、zoom、pan、pinch and media paging；
- owned-media validation；
- direct Detail/Viewer query entry；
- Back/Forward、scroll and focus restoration。

## Backend, data, and import capabilities

Completed foundation includes:

- strict Public Catalog list/detail Contracts；
- `CatalogKind = inscription | calligraphy`；
- page-based list query and error contracts；
- Public Catalog list/detail HTTP API；
- Public Search API（`GET /v1/catalog-search`）；
- backend application boundary and `CatalogQueryPort`；
- PostgreSQL adapter、queries、migrations and readiness ledger（18.4 local
  development；18.6 verified remote target）；
- backend-owned `StorageUrlResolver` boundary；
- controlled CSV/XLSX importer；
- dry-run、hash-bound approval、transactional apply and idempotent replay；
- `catalog-import/v1` backward compatibility；
- `catalog-import/v2` Content V1 support；
- Payload CMS editorial source（native draft/version/media、Owner
  approval、published-only public reads、editorial MCP automation）；
- deterministic JSON Schema and OpenAPI generation；
- format、lint、typecheck、unit/integration、PostgreSQL、CMS、build and browser
  E2E CI。

## P2-01 — Catalog Content V1

```text
T09-C0:  CLOSED / PASS
Contract, roles, content fields, citation scopes, JSON Schema, OpenAPI, ADR

T09-B1A: CLOSED / PASS
PostgreSQL persistence, ordered contributors, citation scopes, read projection,
explicit Public mapping and Detail API readback

T09-B1B: CLOSED / PASS
catalog-import/v2 XLSX/CSV, canonical hash, dry-run, approval, transactional
apply, rollback, replay and v1 compatibility

T09-F1:  CLOSED / PASS
React Detail presentation for all Content V1 fields and scoped citations
(PR #89, merged 2026-09-04)
```

Current Content V1 fields are:

- `contributors`;
- `scriptStyle`;
- `transcription`;
- `historicalContext`;
- `scholarlyResearch`;
- source-citation `appliesTo`.

Backend、importer 与 React Detail 均已支持这些字段。P2-01 整体 CLOSED。

## Production gaps

The repository now contains the P2-R2A production topology (three loopback
services behind Nginx, distinct service users, env templates and systemd units)
and the necessary IP-identity TLS fix for a literal-IP PostgreSQL endpoint (PR
#107). Backup/restore and rollback guidance is still the pre-existing
provider-neutral rollback plan and the P2-04 CMS recovery notes; P2-R2A defers
backup/restore execution to a separately approved production operation. The
repository still does not contain, and no public environment yet provides:

- a public Production release or release tag；
- an Owner-controlled media custom domain bound to the private COS bucket and a
  configured `COS_MEDIA_ORIGIN`；
- a public protected HTTPS entry serving Web and Backend；
- Production real-device smoke, logs or monitoring evidence for a public entry。

The P2-R2B Stage B target environment (new CVM, TencentDB PostgreSQL 18.6 with
`verify-full` TLS, private COS with two least-privilege identities) has been
prepared and loaded with the 3 approved Catalog records and 20 hash-verified
media objects; the 3 records are published on that target, a formal backup and
an isolated restore were verified, and a real Payload Owner account exists. Web
and Backend are not started there because the media domain is unresolved. This
is deployment-candidate evidence, not a Production release. The old personal
server, old COS and the isolated restore database remain unchanged pending Owner
acceptance.

## Remaining Phase 2 roadmap

### P2-01 — CLOSED

All four P2-01 tasks are closed; see above.

### P2-02 — Production Data and Media Pilot

Delivered as the bounded remote HTTPS Pilot (PR #97; protected IP entry, three
real records, twenty verified COS objects). It remains non-production evidence
and was superseded as a data source by the P2-R2B Stage B export and target
load.

### P2-03 — Search V1

已实现并合入主干（PR #101）；保留其已验收前端与公共 API 行为。已交付范围：

- governed Search Contract；
- Chinese normalization；
- PostgreSQL search/ranking；
- deterministic pagination；
- Golden Query Set；
- Public Search API；
- frontend Search presentation。

Local array filtering is not Search V1. Elasticsearch, vector databases, and AI
embeddings are not pre-authorized.

### P2-04 — Payload editorial workflow and Codex automation

The Owner-approved P2-04 amendment replaces the earlier minimal-operator-only
scope with self-hosted Payload Admin, official MCP/REST, PostgreSQL and COS. It
includes native draft/version/media editing, scoped automated batches,
exact-revision Owner approval and published-only public reads. It does not add
ordinary public-user accounts or community features.

Payload Admin、editorial MCP automation 与 published-only 数据读取已合入主干（PR
#102、#104），Stage A 已完成。P2-R2B Stage
B 已在目标环境执行正式 migrations、导入并发布 3 条资料，但正式内容源切换、traffic
cutover 与 XLSX 写入口退役仍未执行；既有写入口继续保留。历史验证与实施过程见
[implementation and evidence](cms/p2-04-implementation.md) and the
[single operations guide](cms/operations.md).

### P2-R2 — Production Release Gate

```text
P2-R2A  Production topology & development readiness   CLOSED / PASS (PR #105)
P2-R2B  Tencent Stage B transfer                      IN PROGRESS — PARKED
```

P2-R2B completed on the target: database identity/TLS/migrations/role
separation, media transfer 20/20 hash-verified, 3 records published, backup and
isolated restore, real Owner account. Parked until explicit Owner instruction:
media custom domain and `COS_MEDIA_ORIGIN`, public protected HTTPS entry,
Web/Backend Production start, real-device Production smoke, release tag, GitHub
Release, ICP/domain work. Do not resume these without explicit instruction.

## Apple bootstrap and validation profiles

2026-09-17 limited factual update:

Apple Multiplatform bootstrap is delivered to `main` (Issue #145 / PR #146,
merge `20425a22a62a6bfec222f741f7c085b7367b9bd1`). Local released Xcode 27 / iOS
27 Simulator and physical-iPhone bootstrap acceptance are complete. Issue #142
remains the historical LOCAL-ONLY Apple baseline record and is not extended.

Validation profiles are delivered (amendment
[2026-09-16 validation profiles](governance/amendments/2026-09-16-validation-profiles.md);
Issue #148 / PR #149, merge `81c819df782e5f83cf8761fe19a81468bf19e07c`): fast
feedback is separated from full acceptance for Apple, Web, and CMS. Hosted
released-Xcode-27 CI remains pending and nonblocking. No native product feature
has yet been implemented.

## HarmonyOS repository foundation

2026-09-18 limited factual update:

HarmonyOS is authorized as an independent native ArtVenn client domain
(`apps/harmony/**`). The repository foundation and partner handoff are delivered
by this task. Native Harmony product implementation has not started. Real DevEco
project generation remains for the partner bootstrap task (Harmony Multidevice
Bootstrap V1). No AppGallery publication authority and no Production deployment
authority have been granted. Apple and Harmony remain independently developed
native clients. The existing Backend / Public API remains the intended shared
service boundary. Hosted Harmony native CI is
`HARMONY_NATIVE_VALIDATION_NOT_YET_CONFIGURED`.

## 下一步任务

```text
Required branch origin for every task:
fresh latest origin/main
```

Active development tracks (independent of the parked cloud track):

1. **Community V1** — the
   [Community V1 scope amendment](governance/amendments/2026-09-11-community-v1-scope.md)
   is Active (Owner-approved 2026-09-11) and records the product decisions:
   Owner-controlled publication setting (`DIRECT_PUBLICATION` initial default
   since the 2026-09-12 scope amendment, which also adds the small hot-comment
   section above the latest roots), Development test-account sign-in,
   system-assigned handles, Payload Admin moderation over a Backend operator
   boundary, text comments first, flat paginated replies, Production deferred.
   PR #106's comment UI was accepted at `8e7d12a` and merged as `b27c85c`.
   Implementation ran in three separately reviewable stages, all complete:
   identity/session foundation → comment contract, persistence, API and
   moderation → connecting the merged #106 UI seam to the real API. Mission 2A
   (public-user identity, Backend-owned sessions, `GET /v1/me`, the
   Development-only test-account sign-in and the `/dev/community` entry) is
   merged as `4077aef` after the Owner's Development acceptance at `76655ff`.
   Mission 2B (Catalog comments with one reply level, bounded reply pagination,
   hot-first listing, the Owner-controlled publication setting defaulting to
   direct publication, the same-origin comment routes and the Backend operator
   boundary) is merged as `3d0f69e`; its Development acceptance preview
   (`/dev/community/preview`) as `9c75964`; the revised moderation workspace in
   Payload Admin, visually accepted by the Owner on 2026-09-12, as `0fa6d5e`.
   Mission 2C (the Formal root, `/dev/t02p` and the preview composing the real
   comment client through the frozen seam, Development runtime only) passed
   Owner acceptance on 2026-09-12 at `8f5e7b3` and is merged as `5aefc25`; its
   frozen Behavior Matrix and the acceptance record are in
   `docs/community/mission-2c-formal-comments.md`. Community features stay
   unavailable in Production: outside the Development runtime the Formal
   composition resolves to no comment section and no Development sign-in link,
   and opening any Community surface in Production still requires decision 7 of
   the amendment, the P2-R2 release gates and separate Owner Production
   authority.

   **Community V1's currently authorized Development implementation is closed.**
   Missions 2A, 2B and 2C are merged and verified at their merged heads; no
   further work in this track is authorized without a new Owner decision. Two
   maintenance pull requests closed with the milestone: PR #115, which makes the
   PostgreSQL suites refuse a non-synthetic `TEST_DATABASE_URL` before their
   first database access, merged as `7700341`; and PR #111, which makes the
   editorial batch budget expiry deterministic through an injectable clock,
   merged as `702a168`.

   This closure is about the Community V1 Development implementation only. The
   Phase 2 Catalog software and its still-incomplete Production release remain
   separate status dimensions, tracked above and in the Production gaps section;
   closing Community V1 changes neither.

   Development database incident of 2026-09-12, recorded factually: a PostgreSQL
   integration run was pointed at the live `yoyi_dev` database, and its
   `community` rows were deleted. The synthetic acceptance data was re-created
   from `infra/development/community-acceptance-comments.sql` and
   `community-acceptance-queue.sql` — that is re-creation of synthetic fixtures,
   not recovery. The Development comments, moderation history and sessions from
   the earlier acceptance session were not recovered, and no backup of them
   existed; a restricted-permission local dump of the `community` schema, held
   outside the repository, was taken during this closure. PR #115 now refuses
   such a target inside the suites, and both Development seed files refuse any
   database but `yoyi_dev`. The guard reads the database name only and covers
   those suites only: `node scripts/verify.mjs test` still runs
   `pnpm db:migrate` against `TEST_DATABASE_URL` before them, and
   `pnpm test:cms` runs through `scripts/editorial/verify-cms.mjs` under its own
   separate check, so test preparation must still be aimed at a disposable
   target such as the isolated `compose.postgres.yml` container. The
   `wf-test-target-safety` task closes that gap at the preparation entry points:
   `verify.mjs test`, the migration it runs and `test:cms` now refuse any target
   that does not carry the explicit `yoyi-disposable-test-target` database
   comment (see [Local development](development.md)); a hand-run
   `pnpm test:postgres` keeps the suites' name rule only, and a hand-run
   `pnpm db:migrate` keeps only its existing content-source probe.

   Deferred recommendations, recorded as recommendations only — not implemented,
   not started, and not closure gates: the audit-transaction and data-model
   improvements discussed while building the moderation workspace, a guard for
   the migration runner itself, and the known product limitations recorded on
   the merged pull requests (among them the reply load-more in-flight guard and
   the composer draft cleared by a submission that succeeds while new text is
   being typed).

2. **Phase 4 author/community** — Owner-accepted on 2026-09-13, including the
   final comment-avatar synchronization correction. The approved Development
   scope adds discovery, author profiles, relationships, saved lists,
   discussions and Admin existing-work management. Accepted presentation
   includes shared author bars, inscription rows, long-press actions, My
   display/account settings, icon-only Detail actions, direct avatar cropping
   and Save recovery after Back or refresh. Comment and reply avatars follow the
   saved profile; since the Owner's 2026-09-25 phone acceptance the composer has
   no avatar
   ([decision](community/content-community-completion-v1.md#11-owner-phone-acceptance-decisions-2026-09-25)).
   Work creation/editing/deletion entrances remain frozen; favorites/likes list
   filters remain hidden. Backend authorization, media ownership and the
   America/New_York avatar-change rule remain in force. The
   [Behavior Matrix](community/phase4-author-community-v1.md) preserves scope
   and acceptance history;
   [PR #126](https://github.com/nontwo/moya-inscriptions-web/pull/126) records
   the exact delivery head, independent reviews, CI outcomes and merge
   verification. Owner acceptance does not waive failed checks. This is a
   Development milestone, with no Production deployment or release authority.

3. **Work publishing and draft editing (`work-publishing-v1`)** — Draft PR #138,
   r6 implements the Owner's explicit Save Draft model: no cloud autosave or
   autosave option, one latest ordinary saved draft, local interruption recovery
   and unsaved-change exit prompts. Targeted regressions, mobile Chromium with
   two independent browser contexts, and the complete local verification entry
   pass. Exact-head CI and the final independent review are recorded in PR #138;
   Owner physical-device acceptance remains pending. Historical local failures
   and timeouts are preserved. r5 adds whole-card media drag/selection and bulk
   removal, automatic photo upload after selection, an in-place public switch
   and icon-based comment actions with entry-to-reply activation. r4 adds the
   Owner-requested current-recommendation list/order, selected-work bulk
   management, public-user details and automatic recommendation of a selected
   user's eligible public works. Web photo selection is static-only; existing
   Live playback and backend compatibility remain. The author header, compact
   actions and phone ordering follow the latest Owner feedback. r3 discussion,
   album, profile/settings, draft, search and spacing refinements remain; Admin
   content management does not edit authors' title/body/images. The PR records
   exact validation and independent final-head review status. Owner
   visual/real-device acceptance remains pending. Owner-approved on 2026-09-13:
   album-style works (new and edited), static and complete Live Photo media in
   Standard and Original modes, private media storage with derivatives,
   account-scoped background uploads, optional persistent drafts and no-save
   sessions, version conflicts and history, public/self-only visibility with an
   independent work publication policy, a recycle bin, bounded cleanup, quotas
   and essential Admin controls; the dock action becomes a plus and Search moves
   to the upper-left. Scope, Behavior Matrix, feasibility note and proof limits
   are in [work-publishing-v1](community/work-publishing-v1.md); the Draft PR
   records the exact base/head, checks and review state. The 2026-09-14 Owner
   correction makes complete Live Photo import an iPhone PhotosUI/PhotoKit
   dependency in a separate Apple task, including third-party camera content
   recognized by Photos. Web image/text/drafts and backend paired-media/playback
   evidence are assessed separately. Missing importer, hardware and complete
   motion samples remain pending dependencies, not waivers. This is a
   Development milestone with no Production deployment or release authority. PR
   #138 was merged as `30deb84` on 2026-09-16 after Owner acceptance; Issue #137
   is closed.
   - **Data and administration hardening (`data-admin-hardening-v1`)** — Draft
     PR #143, Issue #141 (r2), from `30deb84`. An independent audit of the
     community data model, grants, migrations, adapters and the Payload Admin
     community workflow with reproduced defects repaired: App-role privilege
     convergence (`grant-runtime.sql` now revokes the earlier table-level grants
     before re-granting; `dev:migrate` applies it; a same-role upgrade test),
     profile totals computed with the list predicates, discovery page reads and
     expired-sequence cleanup bounded, three access indexes, batched works /
     people / discussion / My Comments / Admin queue reads, conflict copies of
     new-work drafts bound to their work so purges release their media, atomic
     suspension and policy audits, receipt timestamps, and targeted Admin
     usability fixes (unresolved bulk items block leaving the view and can be
     discarded explicitly, truthful refusals, no-op skips, labels, small-screen
     detail focus). Findings, Owner decisions, the extension note and the
     retained-target application plan are in
     [data-admin-hardening-v1](community/data-admin-hardening-v1.md). Retained
     databases were inspected read-only only; nothing was applied to them. Owner
     visual acceptance of the Admin changes is pending. Phase A closure (r3)
     added atomic grant convergence, a projection-kind-aware profile regression
     and per-target retained plans (`641220a`). Phase B (Agent Administration
     V1, Development only) adds machine principals, bounded delegations,
     prepared durable operations, ten `artvenn_*` MCP tools, an Owner-only
     operations view and the `artvenn-admin` skill; record in
     [agent-admin-v1](community/agent-admin-v1.md).
   - **Content, Threads and Direct Messages
     (`content-community-completion-v1`)** — Draft PR #163, Issue #160 (r1),
     from `0a55227`; track C of the three-track parallel plan (A
     `email-auth-v1`, N `messaging-notification-foundation-v1`). Development
     software, not an audit: Payload `articles` / `article-collections` with the
     existing exact-revision approval, published-only SQL views read by the
     Backend (`/v1/community/editorial/**`) and the Web 近闻 / 专题 tabs and
     readers; operator-created Threads as an association over existing Works
     (quick composer text + ≤3 static images through the accepted editor,
     deterministic heat `Σ weight·2^(-age_days/7)`, per-user read state);
     Article discussion through the existing root/reply tables (`target_type`
     gains `article`, no renames); real 1:1 plain-text direct messages
     (canonical pair, immutable per-conversation sequence, one-first-message
     request gate, per-participant hide/mute/read, 2,000 code points, 20 new
     pairs per UTC day, 20 messages per minute, 10 s foreground polling) in the
     message center's 私信 tab with the profile's 私信 action; Owner-only Thread
     and DM moderation views over the Backend operator boundary with
     content-free audit. Frozen decisions, Behavior Matrix, path inventory, the
     A/N interface checkpoint and the retained-environment plan are in
     [content-community-completion-v1](community/content-community-completion-v1.md).
     Everything is composed under `NODE_ENV=development` only; no retained
     database was inspected or modified; Owner visual and device acceptance, the
     independent review and the joint A/N/C QA assembly are pending.
4. **Home Discover progressive loading** — NOT STARTED. Small product task using
   the established explicit “继续加载” pattern; not mixed into Community work
   and not begun by the Community V1 closure.
5. **Editorial hardening on the local P2-R2A environment** — NOT STARTED.
   Independent of Community work.
6. **Content growth** — NOT STARTED. Separately scoped research delivery through
   `catalog-import/v2`; parallel, non-blocking.

## Current remote lineage disposition

No historical feature branch is an active implementation base.

| Branch                                                |   PR | Current disposition                                                                                                                                           |
| ----------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/comment-feature-main`                          | #106 | MERGED as `b27c85c` (2026-09-12) after Owner real-device visual acceptance at `8e7d12a` (identical patch rebased as `f48ee2f`); QA-only comment presentation. |
| `ops/p2-r2b-tencent-stage-b`                          | #107 | MERGED; necessary PostgreSQL IP-identity TLS fix and guarded remote 18.6 verification only.                                                                   |
| `codex/t02-adaptive-quick-actions`                    |  #94 | CLOSED; superseded by the merged minimal quick actions (#95). Reference only.                                                                                 |
| `fix/t02-development-composition`                     |  #54 | MERGED HISTORY; squash result is already in the current `main` lineage.                                                                                       |
| `feat/catalog-detail-ui-t09-2`                        |  #52 | SUPERSEDED; closed unmerged and replaced by the current React Detail/MIG lineage.                                                                             |
| `feat/t02p-12-react-detail-gallery-viewer-acceptance` |  #69 | SUPERSEDED REFERENCE; closed unmerged after bounded concepts were reimplemented.                                                                              |
| `feat/t02-petal-quick-actions-rebuild`                |  #72 | CLOSED DESIGN REFERENCE ONLY; never merge, retarget, rebase, or bulk cherry-pick.                                                                             |

Remote refs may remain for traceability. Their existence does not grant
implementation authority. PR #72 is closed, and obsolete Issue #11 is closed as
completed. #106 is not an implementation base for Community persistence; its QA
data seam is the integration point defined in section 6 of the Community V1
amendment.

## Research relationship

`moya-catalog-research` remains an independent private research/evidence system.

Its P5 software delivery is CLOSED / PASS:

- 1658 immutable SourceRecords were ingested and validated；
- the Pilot resolved and researched a bounded subset；
- 28 canonically ready records were exported；
- 5 title-blocked PART records were safely excluded；
- 28 records passed disposable PostgreSQL import and Public API readback；
- zero silent loss and zero silent invention were recorded。

The current Research export target remains `catalog-import/v1`. A future
separately scoped research delivery is required to produce approved Content V1
data through `catalog-import/v2`.

## Explicitly deferred

Phase 2 Production-release critical path excludes:

- public-user authentication；
- favorites、likes、comments and posts；
- user uploads and social graph；
- notifications and messaging；
- native iOS、Android、HarmonyOS or visionOS apps；
- transactions；
- OCR and recommendation；
- knowledge graph；
- generic taxonomy framework；
- broad Prototype/static-seam cleanup；
- cosmetic directory or component renaming。

Public-user identity and comments are no longer deferred: they form the
independent Community V1 track above, authorized by the active
[Community V1 scope amendment](governance/amendments/2026-09-11-community-v1-scope.md).
The other items remain deferred unless separately authorized. The Apple
Multiplatform bootstrap is on `main`; that delivery is not a native product
feature. The HarmonyOS repository foundation is also on `main`; native Harmony
product implementation, AppGallery publication, and Production deployment have
not been authorized.

## Branch and release policy

- `main` is the sole long-lived, default, and shared development branch；
- task branches start from a freshly fetched latest `origin/main`；
- each task uses an isolated worktree and bounded branch；
- each task returns to `main` through Draft PR、CI、actual-diff
  review、expected-head squash merge and merged-head verification；
- no direct push to `main`；
- no force-push or history rewrite；
- a stable milestone uses a verified `main` commit, explicit Owner decision,
  annotated tag, and GitHub Release；
- Production release requires an approved tag and the P2-R2 protected
  environment, deployment, smoke, and rollback gates。
