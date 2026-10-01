# Content, Threads and Direct Messages — content-community-completion-v1

Task: `content-community-completion-v1` (r1), track C of the 2026-09-22 parallel
Community plan (A = `email-auth-v1`, N =
`messaging-notification-foundation-v1`). Base `origin/main`
`0a55227e750314930851d8c09c912498ff3a2e84` (PR #143 merged). Delivery stop: one
reviewed feature Draft PR plus, when the sibling candidates exist, one clearly
labeled QA-integration Draft for combined-head CI. No Ready transition,
auto-merge, merge to `main`, Issue closure, deployment, release, retained-data
mutation or paid service. Owner visual/device acceptance stays pending until
given. Authority: the Owner's coordinated assignment of 2026-09-22 recorded in
Issue #160; Draft PR #163; scope extension recorded in
[`2026-09-22 content, Threads and direct messages`](../governance/amendments/2026-09-22-content-community-completion-scope.md).

## 1. Coverage ledger at the start checkpoint (C0)

UI entry → same-origin route → contract → Backend operation → persistence →
readback → authorization → test. Evidence is the file as it exists on the base.

| Feature                                                              | Status on base                                                | Evidence                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| News / Specials (Articles, Collections)                              | PREVIEW ONLY                                                  | `apps/web/features/discussion-preview/preview-data.ts` (`previewArticles`, `previewSpecials`), `academic-reader.tsx` (`chaptersBySpecial`); no route, contract, table or Backend port; gate `NEXT_PUBLIC_MOYA_DISCUSSION_PREVIEW` in `apps/web/app/page.tsx` |
| Home 专题 (Catalog collection topics)                                | IMPLEMENTED (server data) / Production truthfully unavailable | `apps/web/features/topics/topic.ts`, `sources/home/home-sources.ts` `unavailableTopicsSource`                                                                                                                                                                |
| Threads (话题) list, detail, quick composer, read state, heat        | PREVIEW ONLY                                                  | `preview-data.ts` `previewTopics` (fixture heat), `preview-context.tsx` (`addPost`, `markRead`, browser-local images); no `community.threads`, no route                                                                                                      |
| Thread posts                                                         | PREVIEW ONLY                                                  | `PreviewPost` local state; no association to `community.works`                                                                                                                                                                                               |
| Work publishing / editing / deletion / visibility / media            | IMPLEMENTED                                                   | `WorkPublishingService`, `/v1/community/publishing/**`, `community.works*`, `media_*`, `publishing_jobs`; tests `work-publishing-*` suites                                                                                                                   |
| Catalog and Work discussion (root/reply, likes, delete body, locate) | IMPLEMENTED                                                   | `DiscussionPort`/`discussion-store.ts`; `target_type CHECK IN ('catalog','work')`; `apps/web/features/authors/discussion-section.tsx`                                                                                                                        |
| Article discussion                                                   | MISSING                                                       | no `article` target kind; `assertTarget` handles `catalog`/`work` only                                                                                                                                                                                       |
| Message center host, MyComments                                      | IMPLEMENTED (MyComments) / PREVIEW ONLY (rest)                | `message-center.tsx` real `MyComments`; 私信/点赞/收藏 tabs hard-coded empty; `message-preview.tsx` fixture conversations, `setMessages` fake send                                                                                                           |
| Direct messages                                                      | MISSING                                                       | no table, contract, route, component                                                                                                                                                                                                                         |
| AuthorProfile private-message action                                 | MISSING                                                       | `author-profile.tsx` actions: 关注, 屏蔽 only                                                                                                                                                                                                                |
| Notifications / activity inbox / SSE                                 | MISSING — owned by N                                          | not in this task                                                                                                                                                                                                                                             |
| Public login providers                                               | MISSING — owned by A                                          | not in this task                                                                                                                                                                                                                                             |
| Operator moderation of Threads / DMs                                 | MISSING                                                       | operator boundary `/internal/community/**` has comments, works, featured, publishing, agent only                                                                                                                                                             |
| Payload editorial approval / published views                         | IMPLEMENTED for `catalogs`                                    | `apps/admin/src/editorial/*`, `published/views.ts`; no Article collection                                                                                                                                                                                    |

## 2. Frozen scope

### Goal

Real Development software for: Payload editorial Articles and Article
Collections with governed published reads and Web News/Specials;
operator-created Threads over the existing Work domain with quick posting,
deterministic heat and per-user read state; Article discussion through the
existing root/reply model; one-to-one text direct messages with the request gate
and per-participant state; narrow Owner moderation for Threads and DMs;
contracts, migrations, private QA and the cross-track QA assembly.

### Non-goals (unchanged from the assignment)

Notifications, outbox, recipient derivation, inbox/read state, mention control,
SSE, activity panel, message-center host and exact-comment locator (N).
Authentication, providers, Sessions, account UI (A). Universal content registry,
`command_receipts` replacement, renaming `catalog_comments` /
`catalog_comment_replies` / `catalog_id`, `thread_posts` store, Article likes or
favorites, new Catalog kinds, comment images, nested replies, DM attachments,
editing, recall, groups, presence, typing, E2EE claims, push, live email/SMS,
Redis, vector search, ranking jobs in `publishing_jobs`, 180-day cleanup,
Production exposure, deployment, paid services, host/firewall/tunnel changes.

### Preserved behavior

Existing Catalog/Work comment API shapes and IDs; the general Work editor limits
(50 items, Live Photo playback); the accepted Home Catalog/Work mixing; existing
`page/pageSize/total` contracts; the three receipt tables and their scopes;
Payload `users` roles; App-role convergence and the `/yoyi_dev` guard; Agent
Administration and Agent Connection powers (none added); ProductShell, the
accepted AuthorProfile, the accepted Discussion/message-center presentation.

### Frozen V1 decisions (from the assignment)

1. One `articles` collection with `presentation: news | academic`; one
   `article-collections` collection with ordered typed members (Article or
   published Catalog record). Public ids `article-<32hex>` /
   `collection-<32hex>` are generated server-side and immutable; Payload row ids
   never leave the Admin. Editorial byline is display text; it is not a public
   user.
2. Article media reuses approved Catalog media through Catalog references (cover
   and image blocks name a published Catalog record); no new upload path, no
   remote URL, no raw HTML, no video. Unsupported media fails truthfully.
3. Public reads select only `_status = 'published'` rows through
   `WHERE … OFFSET 0` views granted `SELECT` to the public read role; the Owner
   publishes/withdraws natively; `automation` may only save drafts; publication
   by automation requires an exact-revision approval item in the sibling
   collection `editorial-article-approvals` (same Owner-only, revision and
   fingerprint rule as `editorial-approvals`), through the REST operations
   `save-article-draft`, `approve-article-batch` and `publish-approved-article`
   with replay-safe `editorial-receipts`. No new MCP tool is added; exposing
   these operations to MCP is a later Owner decision.
4. Thread = `community.threads` (operator-managed); Thread post = UserWork
   associated through `community.thread_works` (`work_id` UNIQUE → one Thread
   per Work, real FKs). No duplicated text/media/author/likes.
5. Quick composer: plain text + at most three static images through the existing
   publishing session/submission path; the association commits in the submission
   transaction and rechecks Thread eligibility at commit.
6. Heat: sum of `weight * 2^(-age_days / 7)` at a server snapshot (`anchor`)
   with new eligible Work 1, visible comment/reply 2, active like 1; ties by
   latest eligible activity then Thread id; anchor frozen per browsing sequence.
7. Read state:
   `community.thread_read_state(user_id, thread_id, observed_activity_at)`
   clamped to server-observed activity; title is unread again when latest
   visible activity exceeds the marker. Anonymous read state stays local.
8. Article discussion: `catalog_comments.target_type` gains `'article'`;
   `discussionTargetSchema = ContentIdentity ∪ {type:"article"}`; content
   relations keep `ContentIdentity` unchanged.
9. DMs: `community.dm_conversations` (unique normalized pair,
   `requested | active`), `dm_participants` (hidden, muted, read sequence),
   `dm_messages` (immutable, per-conversation sequence, removal by moderation
   only), `dm_command_receipts` (actor + request id). Sender from Session only.
   Request gate: one initial message per new pair, unlocked only by a committed
   non-empty recipient reply. Limits: 2,000 code points, 20 new pairs per UTC
   day, 20 accepted messages per minute. Foreground polling 10 s, no
   background-tab polling.
10. Moderation: Owner-only, explicitly selected conversation/message view
    through `/internal/community/messages/**`; remove message with audit; Thread
    create/edit/close/hide with version checks and audit. Bodies never in
    ordinary logs.

## 3. Behavior Matrix

| Scenario                 | Development / Owner QA                                                     | Production in this task                  | Must preserve                                         |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| News/academic Article    | Real approved published read, chapters/citations and existing reader       | New entry/routes unavailable             | Draft exclusion, media privacy, gestures              |
| Collection               | Ordered typed eligible Article/Catalog members, truthful empty/error       | No new exposure                          | Stable identity/order and source provenance           |
| Editorial automation     | Existing scoped preparation/approval, only named collections               | Existing policy unchanged; no activation | Exact-revision Owner approval and machine permissions |
| Operator Thread creation | Real audited/versioned Admin → Backend operation                           | Disabled                                 | Existing operator identity and controls               |
| Thread posting           | UserWork + association; text and ≤3 quick-composer static images           | Disabled                                 | Existing Work quotas/revisions/likes/comments         |
| Thread read/heat         | Server facts, fixed ranking anchor, per-user observed marker               | Disabled                                 | No private activity/count leakage                     |
| Article comments         | Real shared root/reply discussion, current publication policy              | New target unavailable                   | Existing Catalog/Work behavior and comment IDs        |
| Article notification     | N's real source/recipient pipeline after joint integration                 | Disabled                                 | No fake owner, no duplicate inbox                     |
| DM first send            | One committed initial message; second refused until actual recipient reply | Disabled                                 | Concurrent/retry enforcement and block/suspension     |
| DM reply                 | Committed eligible reply activates same pair                               | Disabled                                 | No client/reading/following bypass                    |
| DM hide/mute/read        | Durable per-participant state, real UI and safe Undo                       | Disabled                                 | Other participant, history, monotonic observed state  |
| DM moderation            | Narrow Owner-only selected access/action with audit                        | No activation                            | Private text not exposed to public search/MCP         |
| Message center           | N-owned host receives C's real DM adapter; no fake sender                  | Existing behavior unchanged              | Accepted navigation and exact comment return          |
| Authentication           | Existing Development account path, then A integration                      | No new exposure                          | One PublicUserId/Session authority                    |
| Failure/withdrawal       | Truthful error or unavailable state; no fixture fallback                   | Truthful existing runtime                | Private drafts, parent visibility and media           |
| Combined QA              | Exact A/N/C SHAs, one independent synthetic stack                          | No deployment                            | Draft stops and separate Owner device acceptance      |

## 4. Approved paths (frozen file inventory)

- `apps/admin`: `src/editorial-content/**` (new: `articles.ts`,
  `article-collections.ts`, hooks, access, published views SQL),
  `src/editorial/collections.ts` (approval items for Articles),
  `src/editorial/operations.ts`, `endpoints.ts`, `index.ts`, `src/mcp.ts`
  (collection selection only), `src/migrations/**` (one new forward migration +
  index), `payload.config.ts`, `app/(payload)/admin/importMap.ts`,
  `src/payload-types.ts`, `src/community/**` (Thread and DM moderation views,
  endpoints, NavGroup links), `package.json` (one `./editorial-content` export
  entry; no dependency change).
- `services/api/src/modules/community/**` (new ports/services for Threads and
  direct messages, their `application/mappers/*-contract-mapper.ts`;
  `author-community-service.ts` `assertTarget`; `discussion-port.ts` target
  type), new `services/api/src/modules/editorial/**` (editorial content read
  port, service and mapper), `services/api/src/index.ts`.
- `services/catalog-postgres/src/**` (Article/Collection published-view reader
  and readiness), `services/community-postgres/src/**` (thread, thread read
  state, DM adapters; `migrations/manifest.ts`).
- `database/community-migrations/2026092203xxxx_*.sql` (append-only).
- `services/backend-runtime/src/**` (router branch, handlers),
  `services/backend-production/src/composition.ts` (composition only).
- `packages/contracts/src/**` (additive schemas/types/json-schema),
  `services/public-api/src/**`, `services/public-api/openapi/openapi.json`
  (regenerated).
- `infra/development/work-publishing/grant-runtime.sql` (one named C block),
  `infra/development/grant-public-read.sql` (SELECT on the five Article views),
  `infra/development/community-development-accounts.sql` unchanged.
- `apps/web`: new `features/editorial-content/**`, `features/threads/**`,
  `features/messages/**`; `lib/public-api/author-community-client.ts` and
  `work-publishing-client.ts` (clients; the existing
  `app/api/community/[...path]` relay carries `/v1/community/editorial/**`,
  `/threads/**` and `/messages/**`, so no new route file was added); narrow
  wiring in `features/home/discussion-screen.tsx`,
  `features/product-preview/t02p-product-preview.tsx`,
  `features/product-application/product-application.tsx`,
  `features/authors/message-center.tsx` (DM slot, badge sum, entry seam),
  `features/authors/author-profile.tsx` (one private-message action),
  `features/authors/discussion-section.tsx` and `local-library.ts` (target
  type), `features/discussion-preview/**` (data seam replacement only),
  `features/product-shell/product-shell.tsx` and `product-history.ts`
  (`threadId` on the editor target), `features/publishing/**` (Thread mode of
  the accepted editor: `publishing-runtime.ts`, `publishing-entry.tsx`,
  `ui/editor/editor-overlay.tsx`, `ui/media/media-section.tsx`),
  `features/qa/t02p-qa-harness.tsx` (provider stack for the real panels).
- Tests: `tests/unit/**`, `tests/integration/postgres/**`, `tests/cms/**`,
  `tests/e2e/**` as directly affected; exact allowlist entries in
  `tests/unit/architecture/workspace-scanner.ts`, `community-v1-freeze.test.ts`,
  `api-surface.test.ts`, `catalog-postgres-surface.test.ts`,
  `tests/unit/backend/openapi-contract.test.ts`,
  `tests/unit/backend/community-migrations.test.ts`.
- Docs: this file, the dated amendment and its `AGENTS.md` bullet,
  `docs/project-status.md`, `docs/development.md` (C profile notes).

Not touched: verification classifier/runner, CI, hooks, branch protection,
`apps/web/AGENTS.md` / `CLAUDE.md`, dependencies and lockfile,
`scripts/migrate*.mjs`.

## 5. Interface checkpoint with A and N

1. A (auth): C keeps using `CommunitySessionService.identify` /
   `readBearerToken` and Web `useAuthors()` (`viewer`, `checking`,
   `sessionError`, `signInHref`) until A's candidate is integrated.
2. N (notifications): C exposes, for N's producers, the Article visibility seam
   `ArticlePublicationPort.isPublished(articleId)` and the discussion target
   kind `article`; Thread posts are Works and inherit N's existing Work path. C
   does not enqueue notifications and adds no event table.
3. C supplies: `DirectMessagePanel` (feature module
   `apps/web/features/messages`) with a typed adapter
   `{ render(props), useUnreadConversationCount() }` that the message-center
   host mounts in the 私信 slot; DM unread unit = unread conversations, reported
   separately from N's activity count and added once.
4. Migration ranges: A `2026092201xxxx`, N `2026092202xxxx`, C `2026092203xxxx`;
   baseline ends at `20260921010000`. C allocates any integration range after
   all three. No Track builds on another's unmerged branch.

## 6. Slices and acceptance criteria

C1 Editorial — Owner creates, previews, publishes, withdraws an Article and a
Collection in Admin; Web News/Specials and their readers show only published
revisions through `/api/community/editorial/**` → `/v1/community/editorial/**`;
withdrawal makes detail 404 and removes list/collection membership without
losing order.

C2 Threads and Article discussion — Owner creates a Thread; a Development
account posts text + ≤3 images from the Thread; the Work appears on the Thread,
the author's Works and discovery with one identity; heat and read state are
deterministic; Article roots/replies/likes/moderation work through the real
discussion API; existing Catalog/Work comments unchanged.

C3 DMs — two Development accounts: first message allowed, second refused with
the exact reason after refresh and on a second connection; reply activates;
hide/Undo, mute, read state and block behave as frozen; Owner moderation view
removes a message with audit; bodies never in ordinary logs or public search.

C4 Delivery and joint QA — cumulative `verify-task` from the worktree,
independent exact-head review, Draft PR, private handoff; joint assembly only
when A/N candidates exist.

## 7. Migration and application plan for retained environments (NOT applied)

New forward migrations `20260922030000_threads`,
`20260922031000_article_discussion_target`, `20260922032000_direct_messages`
plus the Payload forward migration for the two editorial collections and their
published views. Apply order: Payload family (`pnpm db:migrate` as the CMS
migration role) → `grant-public-read.sql` (adds the Article views) → community
family (`APP_MIGRATION_DATABASE_URL`) → `grant-runtime.sql` (idempotent; the C
block grants column-level DML on the new tables). Forward recovery: disable the
Development composition of the new services (they are composed only under
`NODE_ENV=development`) rather than dropping tables; schema rollback never
deletes DM or Thread rows and never restores broad grants. Retained targets
(compose.dev `yoyi_dev`, the publishing acceptance database, TencentDB) were not
inspected or modified by this task.

## 8. Route and composition matrix (as built)

| Surface            | Route                                                                                                                                                         | Auth                                       | Composition                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Editorial reads    | `GET /v1/community/editorial/articles[/{id}]`, `…/collections[/{id}]` (Web relay `/api/community/editorial/**`)                                               | none; published revisions only             | `EditorialContentReadService` over `PostgresEditorialContentAdapter` (public read role, five `article_*` views); Development only         |
| Editorial writes   | Payload `articles`, `article-collections`, `editorial-article-approvals`; endpoints `save-article-draft`, `approve-article-batch`, `publish-approved-article` | Payload Owner / automation (drafts only)   | `apps/admin/src/editorial-content/**`; receipts in `editorial-receipts`                                                                   |
| Threads            | `GET /v1/community/threads[?anchor]`, `GET …/{id}`, `GET …/{id}/posts`, `POST …/{id}/read`                                                                    | reads public, read marker session          | `ThreadService` over `PostgresThreadAdapter`; posts are Works submitted with `threadId` (`submitInTransaction`)                           |
| Thread operations  | `GET/POST /internal/community/threads`, `POST …/{id}`                                                                                                         | operator credential; Admin 话题管理        | operator Contracts parsed in `ThreadService`; `content_operator_events` + receipts                                                        |
| Article discussion | existing `/v1/community/discussion/article/{id}/**`                                                                                                           | as Catalog/Work discussion                 | `catalog_comments.target_type = 'article'`; visibility via `isArticlePublished`                                                           |
| Direct messages    | `GET/POST /v1/community/messages`, `GET …/unread`, `GET …/with/{userId}`, `GET …/{id}`, `POST …/{id}/{hide,unhide,mute,unmute,read}`                          | session required; sender = session account | `DirectMessageService` over `PostgresDirectMessageAdapter` (pair advisory lock, request gate, daily/minute limits, `dm_command_receipts`) |
| DM moderation      | `POST /internal/community/messages/{conversation,lookup}`, `POST …/{messageId}/remove`                                                                        | operator credential; Admin 私信处理        | purpose required; content-free `dm_moderation_events`; replay through `content_operator_receipts`                                         |

All of the above are composed only under `NODE_ENV=development`
(`services/backend-production/src/composition.ts`); a Production build composes
none of these ports and the Web relay answers as before for unknown paths.

## 9. Known gaps recorded by the independent review (Draft #163, head `b3c39d7`)

- A Thread post edited later through the general editor (no `threadId`) is bound
  by the general editor limits, not the quick-composer limit of three static
  images; the Thread association itself is unchanged.
- The operator conversation view shows the latest 200 messages with the total
  count; a lookup that finds no conversation is not audited because audit rows
  name a conversation.
- The send receipt replays the committed message to its sender; moderation
  removal now redacts that receipt as well as the message row.

## 10. Integration repair round (2026-09-23)

Authority: the Owner's 2026-09-23 goal-delivery authorization for the combined
A/N/C QA. The integration coordinator (`parallel-community-integration-qa`) held
this task's writer role for this round and fixed the defects the combined
journeys demonstrated at their source here; the reviewed forward delta is then
integrated into the QA branch. No Ready, merge, deployment or retained-data
change.

- **C1 — moderation removal lacked a runtime privilege.**
  `operatorRemoveMessage` redacts the sender's send receipt
  (`UPDATE community.dm_command_receipts SET result = …`), but
  `grant-runtime.sql` granted the App role only SELECT and INSERT there, so
  removal failed with `42501` for the real App role. The DM tests ran as the
  database owner, which hid it. Fix: `GRANT UPDATE (result)` only (actor,
  request, fingerprint and time stay write-once; nothing is deleted).
  Regression: `tests/integration/postgres/direct-message-app-role.test.ts` runs
  removal, replay and forbidden statements as a real App role on a clean apply
  and on a reapply over the previous grant state; with the previous grant file 8
  of its 12 cases fail with `permission denied`.
- **C2 — an operator error stopped the Backend.** The router started handlers
  with `void handleX(…)`; the DM and Thread operator sub-dispatches ran outside
  the operator handler's `try`, and a malformed percent-encoded path segment
  threw `URIError`. Any of these became an unhandled rejection that ended the
  process. Fix: `http/request-boundary.ts` (`containRequest` answers only the
  failing request with a bounded 500, or closes it if a response had started,
  and logs the error class and code only; `decodePathSegment` turns a malformed
  segment into an ordinary refusal), every operator family inside the existing
  boundary. No global `uncaughtException`/`unhandledRejection` handler.
  Regression: `tests/integration/postgres/operator-error-boundary.test.ts`
  drives the real server and dispatch chain as the App role with injected
  database failures and malformed segments, then proves the process keeps
  serving and nothing partial was written; against the previous source all three
  cases fail.
- **C3 — the 私信 panel did not follow the accepted message center.** The
  conversation and start views used the list-row class, so the stream, composer
  and textbox sat side by side. Measuring the combined stack also showed: list
  rows painted their mute/delete actions over the row with native button chrome
  (the accepted swipe markup was only partly used); inline status (request tag,
  gate, refusal, start hint) used the accepted floating toast, so the start hint
  covered 发送; the participant took an extra row instead of the dialog header;
  focus fell to the page after sending; the scoped host did not give an open
  conversation the dialog body. Fix: the accepted chat grid (stream above a
  bottom composer, filling the host region); `direct-conversation-row.tsx`
  follows the accepted two-action swipe row (left swipe or ArrowLeft reveals,
  ArrowRight/Escape/activation closes, one open row, actions disabled while
  covered); inline notices; the toast only for delete/restore/mute;
  `onTitleChange` hands the participant to a host header (the view keeps its own
  title row when a host has no such seam); the composer regains focus; the
  scoped host hides its tabs and gives the panel the body while a conversation
  is open. Regression: five panel cases and one scoped-host case in `apps/web`
  (they fail against the previous panel); browser geometry on the combined stack
  — the live host at 360/390/430/768/1280 px and the scoped host at
  360/390/768/1280 px (composer below a scrolling stream and inside the
  viewport, textbox width, wrapping, no horizontal overflow, Back, start view,
  offline failure, empty list, swipe and keyboard actions, Undo) — is recorded
  in the private integration evidence. Browser emulation is not physical-device
  QA.

Independent review of `a10aa32` approved it with no blockers
(`independent-review-a10aa32.md` in the task's private artifacts). Its
suggestions were applied in a follow-up commit:

- the header seam keeps the latest `onTitleChange` in a ref, so a host that
  passes a new callback on every render no longer loops (a test proves it
  settles; the previous code exhausts the heap);
- a malformed percent-encoded segment now yields no identifier, and every caller
  refuses it explicitly — `messages/with/<malformed>` answers 400 instead of
  looking the pair up;
- a request whose answer had already ended is left alone (its keep-alive
  connection is not closed); an unmapped operator failure logs its error class
  and code;
- the router answers a request target that is not a URL path (for example `//[`)
  with 400. That synchronous parse predates this task (it is on `main`) and
  ended the process like C2; the shared request boundary lives here, so the fix
  does too. A raw-socket case in `operator-error-boundary.test.ts` proves it
  (the previous router crashes with `ERR_INVALID_URL`);
- the boundary test closes open connections before stopping its server and
  always drops its disposable role;
- a panel case pins the accepted chat structure (stream above the composer).

The review of that follow-up (`817a5ed`, independent-review-817a5ed.md) also
approved with no blockers; its two small suggestions were applied: an operator
failure after the answer had started or ended is logged (class and code only),
and the boundary test drops its role even when dropping its database fails.

The combined J9 journey then found one more panel defect: a send that failed
while offline refreshed the conversation, the refresh failed too, and the whole
view was replaced by 暂时无法完成，请重试 — the composer and the typed draft
were gone and nothing offered a retry. A failed send now refreshes without
replacing the view (a failing refresh changes nothing, so the draft stays), and
a conversation that cannot load offers 重试. Two panel cases cover both (they
fail against the previous code).

The review of `aa76cc7` (independent-review-aa76cc7.md) found one blocker that
predates this round: a refused send never showed its reason. The server names it
in a 422 body (`dm_request_pending`, `dm_blocked`, `dm_daily_limit`,
`dm_rate_limited`, `dm_self`, `dm_recipient_unavailable`, `dm_text_invalid`),
but the shared author client kept only 409 text, so every refusal
read 暂时无法完成，请重试 and the panel's reason table never matched.
`AuthorRequestError` now carries a 422's machine reason separately (a lower-case
identifier only, never shown as is; other features keep their messages), the
panel maps it to the exact text, and a gate refusal shows once as the composer's
reason instead of beside a generic retry. Four panel cases cover a blocked
start, the daily and minute limits and the gate (they fail against the previous
code). `apps/web/lib/public-api/author-community-client.ts` is already in this
task's approved paths (§4). The review of `f5d75a8` approved the cumulative
head; its two suggestions were applied: a send error is cleared when the
composer's own refusal appears or clears (so it cannot return as a stale alert
once the pair may send again), and the reason table matches only its own keys.

A later combined J9 run found that returning to the window (the author context
revalidates the confirmed account on `focus`, and on reconnect) closed an open
conversation and lost its draft: the panel showed its account states whenever
`checking` or `sessionError` was set, unmounting the conversation. Revalidation
keeps the confirmed account by design, so the panel now shows those states only
while no account is confirmed; a different account still remounts the panel
through its host and a revoked Session still clears the viewer. Two panel cases
cover both flags (they fail against the previous code); a third keeps the
unknown-account states.

The combined-head review of the QA integration (blocker B2) found that
"前往评论位置" on an Article comment in 我的评论 called `openTopic` directly and
skipped the host's `onOpenContent`: from the home destination nothing happened
(openTopic refuses outside discussion), and from discussion the Article opened
under the still-open message center. Every target, Articles included, now goes
through the host, which closes first; the scoped host then switches to the
discussion destination and opens the Article, and without a host MyComments does
the same itself. Three cases cover the host hand-off, the scoped host's
close-then-open and the host-less path (they fail against the previous code).

The final combined journey run showed the live Article discussion running edge
to edge in the accepted Article reader, while the reading column above it and
the preview's comments are centred. Supplying a live `comments` slot replaced
the preview's whole `PreviewComments`, including the accepted `.comments` column
(maximum width, centring, side padding and room for the fixed composer). Both
readers now place a live section in that same column
(`apps/web/features/discussion-preview/article-reader.tsx`); two cases in
`article-reader.test.tsx` fail against the previous code.

Owner phone acceptance runs the Development Web on the Wi-Fi address. Editorial
images (Article covers, section and academic figures, Collection covers) are
native synthetic Payload files at loopback URLs that a phone cannot reach, while
Catalog media already had a same-origin Development relay. As for Catalog media,
the editorial pictures and the academic figure mapping now pass their source
through `editorialMediaSrc(src, owner)`, which rewrites only loopback Payload
files to the Development-only route
`/api/editorial-media/<article-or-collection id>/<hashed file>`. The route
(`relayServerLocalEditorialMedia` in `lib/public-api/server.ts`, registered in
the architecture scanner's server-import list like the Catalog media route)
reads that published Article or Collection from the Backend. It serves the file
only when that detail shows it, fetching the loopback URL the detail itself
carries, anonymously and with type and size checks. It never reads the CMS
address from configuration and answers 404 outside Development. Other sources
are unchanged.

Paths added for this round:
`services/backend-runtime/src/http/request-boundary.ts`,
`apps/web/features/messages/direct-conversation-row.tsx`,
`apps/web/features/messages/direct-message-panel.module.css`,
`apps/web/features/authors/message-center.module.css` (scoped host),
`apps/web/features/authors/message-center-direct.test.tsx`,
`apps/web/features/discussion-preview/article-reader.test.tsx`,
`apps/web/features/editorial-content/editorial-media.ts`,
`apps/web/app/api/editorial-media/[owner]/[file]/route.ts` (with tests) and the
two PostgreSQL tests above.

Integration-owned, not in this branch: the live (notifications) message host's
fill region and header seam for this panel, and the profile 私信 entry that
opens the live host, live on the QA branch with their own regression tests and
must reach `main` with the integration commits after A, N and C.

**Thread posts (Owner phone acceptance, 2026-09-26).** Tapping a post in a live
Thread did nothing. `ThreadDetail` asked the shell to open the post's Work
detail, and the shell refuses to open content while a topic overlay is open. As
in the accepted discussion preview, a post now opens inside its Thread as
a 帖子 page. The page shows the Work's text and images and, below them, the
Work's live discussion, which the host supplies through
`renderDiscussion({ type: "work" })`. Header Back or browser Back (a swipe)
returns to the Thread at its scroll position through the preview's local child
history, and the post card reads 展开阅读. The Thread records the author's own
view of a post before opening it, as Work Detail does, so a post only its author
can see shows the closed note instead of a composer. An open post keeps its page
while the Thread reloads. Regression:
`apps/web/features/threads/thread-detail.test.tsx`.

## 11. Owner phone acceptance decisions (2026-09-25)

During phone acceptance of the combined QA candidate, the Owner changed these
presentations (items 1–3 on 2026-09-25, item 4 on 2026-09-26). Each is the
Owner's own decision at the visual gate of the community scope amendment (§6 of
`2026-09-11-community-v1-scope.md`). They supersede the rows cited below. The
composer spans main's comment section, N's mention control and this track's
direct messages, so the change is integration-owned. It lives on the QA branch
and must reach `main` with the integration commits after A, N and C.

1. **One composer shape.** Comments, replies and direct messages share one
   shape: a single text box with the 发送 button on its right.
   - Removed: the composer avatar (supersedes Phase 4's composer-avatar rows and
     `work-publishing-v1` "Comment avatars" for the composer only) and the
     visible 以“…”发布 line, which now only describes the box for screen
     readers.
   - The box is one line high and scrolls longer text inside it.
   - Mentions stay reachable. An "@" inside the box (accessible name 提醒用户)
     opens the same resolved-user picker above the box. Only a person chosen
     there is mentioned, as before. Escape closes the picker, and Enter in its
     search field no longer sends the comment.
2. **专题 opens one Article.** The 专题 tab lists published academic Articles as
   the large cards. A card opens that Article's reader directly, titled 专题;
   there is no Collection 阅读目录 step. When the tapped card is in 专题, the
   Discussion pager stays on 专题. This changes the Goal's (§2) Web Specials:
   Collections are no longer listed as 专题 cards.
   - Collections keep their published reads and their detail page, reachable by
     a deep link to a `collection-…` id. The Web no longer lists them.
   - An Article opened from 近闻 or 专题 is titled from its feed at once. A deep
     link to any Article is titled 文章 until the Article loads (before, a news
     deep link read 近闻 at once), and the pager behind it follows the id prefix
     (近闻) as before.
3. **Direct-message rows show only the count.** A row no longer shows
   a 私信请求 or 等待对方回复 tag; the unread count stays on the right, and a
   muted row keeps its muted mark. The request state moves into the row's
   accessible name. Inside the conversation, the gate notice and the composer's
   refusal are unchanged. This drops the row's request tag kept inline by §10's
   C3 repair.
4. **Leaving the avatar editor.** Back, from the header button or a swipe,
   closes 更换头像 without a discard prompt or a leave-page warning, even after
   a photo was chosen. Nothing is uploaded or saved. This supersedes Phase 4's
   unsaved-crop prompt for the avatar editor only; the other editors keep
   theirs. The avatar editor is main's Phase 4 code, so this change is also
   integration-owned.
