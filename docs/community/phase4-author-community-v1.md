# Phase 4 — author and community acceptance

Task: `phase4-author-community-v1`. Revision: 2. Owner approved requirements
provided on 2026-09-13. Phase 3 remains historically CLOSED.

> **Superseded 2026-10-13 (Owner, `profile-media-renditions-v1`):** the limit of
> one avatar change per America/New_York calendar day is removed, with no
> replacement limit. Each successful change applies at once. The limit wording
> below is acceptance history, not current behavior: the "Avatar" row of the
> approved behavior matrix, the "upload/day limit" browser evidence, the "Cancel
> or failure" and "Save and daily limit" rows of the avatar UX correction, the
> "New York daily rule" of the save synchronization fix, the "one success per
> New York date" cell of the Save-survives table and the "daily-change rule" of
> the comment avatar correction. For older clients the contract keeps
> `nextAvatarChangeAt` (always `null`) and `nextChangeAt` (the time of the
> change).

## Authority and delivery

Base: `693eb3754a66fd2eac21cc29e6dbb07677638276`, freshly fetched from
`origin/main`. One source writer: current Codex task `/root`. One branch:
`codex/phase4-author-community-v1`. Worktree belongs exclusively to this task.

The current Owner instruction authorizes this product scope and supersedes the
specific Community V1 deferrals it enumerates. Constitution and six active
amendments remain effective otherwise. Workflow PRs #118, #122, #123 and #124
were verified OPEN, Draft, unmerged at the Owner reference SHAs. No yoyi-task,
yoyi-review, yoyi-handoff or verify-task entry is installed on this baseline.
Use CONTRIBUTING.md and scripts/verify.mjs. Paused workflow work remains
separate.

Stop at one running Development candidate, exact commit, automated evidence,
independent actual-diff review, and one Draft PR to main. Owner acceptance is
pending; no Ready transition, merge, release, Production exposure or closure.

## Frozen functional paths

- apps/web/features/{qa,user,authors,comments,quick-actions,product-application,product-preview,product-shell,home,calligraphy,detail}/**;
  apps/web/app/api/community/**; existing Catalog same-origin comment routes;
  apps/web/app/{page.tsx,page.test.tsx,dev/community/**};
  apps/web/lib/public-api/**; Development Catalog media relay under
  app/api/catalog/[catalogId]/media/; supported next.config.ts and generated
  next-env.d.ts; features/shell/request-identity.ts browser request-identity
  utility.
- apps/admin/src/community/**; apps/admin/payload.config.ts; supported generated
  Admin import map, editorial fields/hooks/content, forward Payload migrations
  and generated types; src/published/discovery.ts projection. Admin directly
  references the already locked OpenCC 1.4.1 so Next can externalize its native
  module; no package upgrade.
- packages/contracts/src/**; services/public-api/src/** and generated OpenAPI.
- services/api/src/modules/{community,catalog}/** and public exports;
  services/backend-runtime/src/**; services/backend-production/src/**;
  services/{community,catalog}-postgres/src/**.
- New forward files in database/community-migrations/ and, if required,
  database/migrations/; append-only migration manifests.
- scripts/{materialize-phase4-fixtures,seed-phase4-acceptance,seed-phase4-support}.mjs;
  infra/development/phase4/manifest.json and its instructions. Credentials,
  database target, process state and command journals remain private artifacts.
- Owner explicitly authorized only the new exact Phase 4 paths/import names in
  the existing workspace-scanner allowlists. Scanner logic and generic routing,
  runners, budgets, workflow and instruction files remain unchanged.
- tests/unit/{community,backend,architecture}/** product assertions only;
  tests/integration/postgres/phase4*; tests/e2e/phase4*, the existing Formal
  product spec and anonymous support/public-api.ts fixture (new product reads;
  no harness/routing changes); colocated product tests;
  docs/community/phase4-author-community-v1.md.

Actual changed-file set is recorded with the candidate. No instruction files,
workflow skills/settings/checkpoints, generic scanner, classifier, verification
runner, test-target guard, Git hook or CI/protection change is authorized. A
concrete new-route allowlist collision must be reported rather than bypassed.

## Approved behavior matrix

| Scenario             | Development                                                 | Production                                                  | Must preserve                                             |
| -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Anonymous browsing   | Browse/search public Catalog and eligible synthetic works   | Existing approved exposure only                             | No login wall for ordinary browsing                       |
| Author profile       | Real profile, works, relationships and per-list privacy     | Phase 4 exposure remains disabled pending release authority | Existing presentation and private-data separation         |
| Favorites/likes      | Real account state; guest favorites are local until login   | No newly exposed Phase 4 surface                            | No fake persistence or duplicate relations                |
| Work editing         | Only the assigned author edits an existing work             | No new public creation/upload authority                     | Stable work identity and last published version           |
| Avatar               | Upload/crop/change with New York calendar-day limit         | No newly exposed upload surface                             | Backend authorization and bounded media                   |
| Comment read         | Public items plus authorized self-only items                | Existing exposure policy retained                           | No leakage through public reads, caches or links          |
| Comment deletion     | Body tombstone or explicit whole-thread removal             | No automatic Production rollout                             | Other replies preserved only where specified              |
| Comment/reply drafts | In-memory while the composer remains open                   | No new draft service for comments                           | Refresh/exit discards; current input is not lost by races |
| Work-edit drafts     | Private server persistence and conflict handling            | No newly exposed draft surface                              | No silent overwrite between devices                       |
| Discovery            | Automatic paging; featured then remaining publication order | No public rollout in this task                              | No duplicates, no live reordering                         |
| Inscription filters  | Real server-side combinations on inscription page only      | No new public filter rollout                                | No guessed historical metadata                            |
| Sharing              | System share or copy the current safe content URL           | Existing public exposure only                               | No private/authentication links or false success          |
| Moderation           | Existing Admin plus approved actions and context            | Owner/operator boundary retained                            | Audited, authorized transitions                           |
| Acceptance fixtures  | Exactly 20 primary synthetic items plus supporting data     | Never exposed or promoted                                   | Separate identities, media and provenance                 |

## Product contract and acceptance criteria

1. Reuse accepted image-first author presentation outside QA; retain one
   ProductShell, Detail, Viewer, navigation/history owner and long-press model.
   Fixed browsing bar, right avatar, secondary tabs, search; overlays own their
   header. Guest center has honest local state and Development sign-in only.
2. Profiles: nickname/bio explicit Save and abandonment warning; immutable
   identity/handle; duplicate display names; current names on old comments.
   Avatar bounded upload/crop/replacement, Backend atomic
   one-success-per-New-York date, next eligible time, DST and concurrent-device
   coverage.
3. Works are distinct from CatalogKind inscription|calligraphy. Only operator or
   synthetic tooling creates assigned works. Authors edit existing text/media,
   order/cover and delete; stable identity/first publication, last published
   revision during editing, no restoration of operator-hidden/removed works.
   Owned media has separate identity, visibility and resolved URLs.
4. Independent following/follower/favorites/likes privacy; private totals owner
   only. Real follow/unfollow and bidirectional block removes follows, prevents
   direct interactions, filters normal surfaces; unblock restores no relation.
   One reusable authorization policy. Historical third-party comments are not
   globally removed by blocking. History/My Comments/drafts always private.
5. Whole-content favorites, newest relation first, full eligible collection
   search/All-Inscriptions-Calligraphy filters, single undo, unavailable
   relations retained. Device-local guest union merge acknowledges exact items,
   preserves failures, avoids reordered existing account items and cross-account
   replay. Separate content likes require login. Safe current-environment public
   sharing with keyboard access, cancellation handling and truthful feedback.
6. Existing discussion IDs/threads retained for Catalog and extended to works.
   Root heat is its own effective likes; up to three positive public hot roots,
   ties newest then stable ID, pinned sequence, flat chronological replies.
   Authenticated private self-only pending/hidden text without badges; own
   nonpublic-root replies stay restricted. Neutral Sent success. My Comments
   supports exact position and private-record fallback without revealing
   context. Body deletion tombstones only when needed, preserves eligible
   replies and erases original from user reads. Explicit operator whole-thread
   removal erases all user access including My Comments. Never-public deletion
   makes no new public tombstone. Committed mutation and audit must agree;
   retries are safe.
7. Comment/reply drafts exist only in open-editor memory and clear on close,
   navigation/logout/refresh, never tab backgrounding; failed requests preserve
   current text and older success cannot clear newer text. Work-edit drafts are
   private server versions, retained until applied/discarded/deleted with
   conflict recovery, no silent overwrite or automatic publish retry.
8. Mixed Discover reuses cards, typed identity, featured first then stable first
   publication. Bounded automatic paging/in-flight requests, explicit retry,
   snapshot sequence with no duplicates or unsolicited reordering. Inscription
   only filters: dynasty, role-distinguished historical contributor, original
   region, script; OR within/AND across, full server query, normalized validated
   values and source text, unknown distinct from no matches, no inferred facts.
9. Exactly 20 primary synthetic acceptance items: 10 Catalog and 10 works,
   independent accounts/media/IDs; supporting interactions extra. Cover all
   Owner listed shapes, privacy, blocking, lifecycle, draft conflicts, time
   boundaries, filter and paging cases. Repeatable guarded seed preserves
   unrelated records.

No public creation/upload authority, new auth provider/registration, cloud
history, comment-draft service, taxonomy, Redis, Agentation, workflow ownership,
Research/media transfer or Apple work is included.

## Implementation decisions

Extend the existing community namespace and Backend-owned session architecture.
Use forward migrations and existing lockfile dependencies. Media metadata and
resolved presentation URLs remain separate. Use explicit desired-state relation
commands and version-checked mutations, with audit in the same transaction. New
browsing sequences pin eligible ordering on the Backend; authorization is
rechecked when serving pages, so withdrawn items disappear without replacement
or offset duplication. Document sequence lifetime and concurrent changes in the
implementation evidence, without claiming a cross-request database snapshot.

## Environment and validation

Canonical checkout is stale and dirty and remains untouched. Acceptance and
integration tests must use distinct task-owned disposable infrastructure with
proven ownership before any migration/seed. No existing Owner DB is a test
target. Private config, evidence and checkpoint live in the task artifact
directory; credentials never enter source, issue, PR, logs or reports.
Acceptance Web may use verified private LAN; operator Backend and Admin remain
loopback.

Rebuild affected dependencies; targeted product/unit/PostgreSQL/browser tests
through real same-origin and Backend routes. Daily pnpm verify retains one
120-second shared routine budget; security delivery uses one separate shared
120-second allowance. Do not import unmerged workflow tooling or conceal failed
checks. Independent final review requires a genuinely separate session; helper
agents in this task are not independent approval. Owner visual/device judgment
remains separate and pending.

## Candidate evidence and acceptance state

The task-owned environment runs Web 3410, Backend 3411 and Admin 3412 against
separate Development infrastructure. Exactly ten synthetic Catalog records and
ten synthetic user works were seeded from a frozen manifest. The initial replay
added zero records. Browser lifecycle checks may withdraw a primary work while
retaining its original identity and publication provenance; the private handoff
records current eligibility and all retained test mutations.

Native routine attempt 7 passed all 46 workspace lint/typecheck/test/build
tasks, including 926 Web tests and 1,023 ordinary repository tests. Earlier
formatting, lint, composition and bridge-argument failures were fixed and
retained in the private evidence. The cumulative routine allowance then expired
during Formal smoke: the old anonymous fixture returned 404 for the new
discovery API. The product fixture now serves the same frozen Catalog identities
through the new reads, and the Formal assertions retain their
content/Detail/Viewer checks. Routine timeout remains a failure; any additional
smoke execution requires the Owner's explicit allowance under request
section 13. No verification runner, guard, classifier or timeout has been
changed.

The separate disposable PostgreSQL suite passes 47 tests, including all four
nonempty privacy lists, root heat cap/time/ID ties, audited hidden originals,
media ownership and avatar date concurrency, work draft conflicts and atomic
moderation/featured rollback. Native CMS integration passes 50 tests with its
one existing native skip. An omitted legacy filter field and Payload's all-empty
default represent the same content; explicit full snapshots clear old values.

Real browser journeys use the same-origin Web routes, live Backend and isolated
PostgreSQL. Evidence includes desktop Chromium and mobile WebKit browsing,
Catalog media and Viewer, guest merge and cross-account reservation, profiles,
privacy, follow/block/unblock, avatar upload/day limit, work media and
independent session drafts, comment heat/private originals/deep positioning,
both Admin deletion scopes, featured control and list retry retention. No forced
invisible clicks or fabricated response bodies are used. Browser failures and
scoped rechecks are preserved. Mobile WebKit is emulation; Owner physical-device
and visual judgment remains pending.

Independent review is performed in one separate read-only Codex session, with
final exact GitHub Head/diff and delta verification recorded in the Draft PR.
The implementation helpers are not independent approval. The private task
checkpoint and Owner walkthrough carry process/data ownership and exact final
revisions. This task does not authorize Ready, merge, release or Production.

The first independent review identified three P2 issues: suspension incorrectly
withdrew historical visible comments, cached people lists survived a privacy
withdrawal/late request, and guest favorites lacked whole-collection search and
filters. Fixes preserve the active suspension policy, revalidate and isolate
people-list requests, and resolve public card metadata in bounded batches before
local title/alias/type filtering. Catalog card aliases are public source data;
no guest collection is uploaded. The fixes have native PostgreSQL/HTTP coverage,
six focused Web unit tests, and live browser coverage for both people-list races
and thirteen guest favorites including an alias-only match past the first page.
Final exact-commit independent review remains recorded separately in the PR.

## Owner mobile acceptance revision (2026-09-13)

The Owner's screenshots and explicit follow-up replace the relevant earlier UI
requirements. This is a bounded correction on the same task and Draft PR #126;
Owner visual/device acceptance remains open. Root remains the sole writer.

| Scenario                                | Development                                                                                                                                                             | Production                                          | Must preserve                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Main-page search and bars               | Remove all duplicate top search entrances; retain bottom navigation search. Home, inscriptions and calligraphy retain the same fixed bar with right-side author avatar. | Existing approved composition remains.              | Existing search overlay, navigation and overlay Back.                                                |
| Card actions                            | Remove visible card action disclosures; use the existing long-press menu everywhere.                                                                                    | Existing approved card behavior remains.            | Real relation state, native long-press cancellation and single execution.                            |
| Inscription scrolling                   | Only vertical scrolling, no horizontal overflow, including long filter labels and single/double columns.                                                                | Existing approved composition remains.              | Stable data/pagination and the current scroll owner; no new gesture engine.                          |
| Favorites and liked lists               | Hide search/type filters; always load the unfiltered eligible list, including after a previously filtered cache.                                                        | No new exposure.                                    | Favorites/likes, privacy, local guest merge and stable identity.                                     |
| My settings                             | Reuse existing theme/layout controls and persistence in My > Settings, with Display and Account Settings tabs. Display settings also work for guests.                   | Existing settings continue using the same controls. | Unsaved account privacy state across tab changes; Back/confirmation and account isolation.           |
| Existing work editing and avatar upload | Freeze user-facing mutation entrances; existing editor/upload implementations and stored data are retained but not mounted from the product UI.                         | No new exposure.                                    | Published works, existing avatars, private drafts and server foundations are not erased or reseeded. |
| Detail actions                          | Icon-only favorite/like/share row above Information/Comments tabs. Favorite/like toggle the existing state and highlight; share invokes native share/copy.              | No new Phase 4 exposure.                            | Accessible labels, truthful failures/sign-in needs; share is not invented as a persistent relation.  |

This revision changes only relevant Web presentation/integration, focused
product tests and this record. It adds no contracts, migrations, dependencies or
Admin changes. The Owner clarified inscription scrolling as vertical-only. The
image background-removal request was superseded by this application feedback;
the screenshots are evidence, not edited assets.

Main advanced independently to `4dba8c1524fef61758e979ba9c4812365d5fc173` with
merged workflow #118. Its effective root/workflow instructions were reloaded and
integrated without conflict in `ace9bddcfa0250bd95d71f735bf15628270f2c92`. No
unmerged workflow work is copied or resumed. The merged task-diff routing is now
authoritative. The Owner explicitly approved registering only the three existing
Phase 4 fixture script names in its anchored Web path expression, plus a focused
regression test. No classification algorithm, runner, budget or workflow changes
are made. Earlier local routine timeout and subsequent exact-candidate native CI
passes remain historical evidence, not a fresh-head pass.

Mobile feedback verification also exposed a retained desktop inline pager height
when the existing runtime switches to phone/tablet presentation. Clear that
height when panels own vertical scrolling, with a regression for both
directions; the existing pager engine and navigation behavior remain intact.

## Owner inscription list correction (2026-09-13)

The Owner's follow-up screenshot clarifies that Inscriptions must retain the
existing one-item-per-row presentation from `home/catalog-screen.tsx` and the
`inscriptionList` / `inscriptionCard` styles. The earlier Phase 4 use of the
Home masonry here was incorrect. Reuse the established horizontal row
media/title layout for filtered discovery items. Home remains masonry; its
single/double column preference must not change Inscriptions into a grid.
Preserve the fixed author bar, vertical-only scrolling, filters, pagination,
Detail/Back and existing long-press actions. This correction changes only Web
presentation and focused product evidence; no API/data/workflow change or new
publication authority.

## Owner avatar UX acceptance correction (2026-09-13)

This is a bounded correction to the existing Phase 4 candidate in Draft PR #126,
not a separate task branch or stacked PR. It supersedes only the avatar-entry
freeze above; work creation/editing/deletion and all other accepted surfaces
remain unchanged. The Owner explicitly selected focused validation and
exact-head checks for this correction; the earlier full-routine timeout remains
recorded.

| Scenario                | Development                                                                                                                     | Production                        | Must preserve                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| Owner selects an avatar | Native device picker followed by a direct crop editor                                                                           | No new public entry or deployment | Existing owner/account authorization                                |
| Position and zoom       | Drag behind a circular mask, pinch/wheel, one helper zoom slider                                                                | No exposure change                | Native overlays, keyboard access and touch scroll ownership         |
| Input and output        | JPG/PNG/WebP within 4 MiB, 8192px per dimension and 16 Mi pixels; 512px PNG export                                              | Backend validation unchanged      | Existing work-editor PNG input, media identity and ownership        |
| Cancel or failure       | Cancel before Save sends no upload; failed save/replacement retains the current crop; unchanged retry reuses command identities | Unchanged                         | Daily allowance only consumed by successful binding                 |
| Save and daily limit    | Refresh profile/shared avatar; server limit and next America/New_York time remain authoritative across sessions                 | No release authority              | Existing upload then binding protocol and backend calendar-day rule |

The crop mechanics use exact-pinned `react-easy-crop` 6.2.3 (MIT; runtime
`normalize-wheel` only). Its declared React peer range includes the project's
React 19. The existing author dialog and design tokens provide presentation; the
library demo is not copied. The round mask guides the same square PNG crop used
by existing avatar presentations. Source object URLs are released on
replacement/cancel/unmount, and no remote image processing is introduced.

Automated cropper touch emulation complements, but does not replace, Owner phone
pinch/feel and native photo-picker acceptance. HEIC is not an accepted input;
JPG, PNG and WebP are explicitly offered. Final evidence, exact SHA, independent
avatar-delta review and phone instructions are recorded with PR #126. It stays
Draft; this correction does not infer acceptance, Ready, merge or deployment.

### Avatar save synchronization acceptance fix

The Owner's subsequent phone screenshot reported a failed save with an account
change error. Focus returning from the photo picker had cleared the client
identity during same-account revalidation, invalidating upload/binding
responses. Retain the last confirmed expected account while checking; a
confirmed switch, logout or failed check still invalidates it. Save waits for
confirmation and a failed check offers explicit retry with the crop intact.
Defer profile reads while checking or after a failed check, retiring earlier
callbacks so they cannot unmount the active editor. Backend expected-account
authorization, request identities, media ownership and the New York daily rule
remain unchanged.

Integrated tests exercise the real provider/client/operation guard and actual
profile parent, including focus before/during save, switch/logout, failed checks
and idempotent recovery after an accepted binding. Actual Development browser
verification must retain the failed attempt and demonstrate synchronized profile
and header avatars after the same request is retried. Owner acceptance is still
pending on the corrected exact Head; no allowance reset or other frozen feature
restoration is authorized.

### Avatar Save survives navigation and refresh

Owner acceptance failed again on the previous candidate. The Owner explicitly
requires a Save click to commit the avatar intent independently of the crop
editor, including Back and page refresh. This is an avatar-only acceptance delta
inside the same Phase 4 task/PR126.

| Scenario                                    | Development                                                                                             | Production            | Must Preserve                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| Save click                                  | Synchronously retain bounded cropped PNG and stable upload/binding IDs before starting requests         | No new upload surface | Actual account owns the intent; no credentials in local storage |
| Back after Save                             | Editor closes without an unsaved warning; page continues the save                                       | No new upload surface | Cancel before Save still performs no upload                     |
| Refresh during upload or binding            | Confirm the same signed-in owner, restore the pending intent and finish or replay the existing requests | No new upload surface | Backend idempotency and one success per New York date           |
| Network interruption                        | Keep pending crop, retry while page is available and on connection/focus recovery                       | No new upload surface | Never report success until the backend confirms it              |
| Actual account switch/logout                | Suspend that owner's pending operation; never bind using another account                                | No new upload surface | Existing backend authorization and media ownership              |
| Storage/export failure or backend rejection | Show an actionable failure; preserve the editor or pending result                                       | No new upload surface | No fake success, limit reset or validation weakening            |

Browser persistence is scoped to the same site origin and browser storage.
Leaving a page cannot keep its JavaScript running indefinitely; reopening or
refreshing that site resumes an unacknowledged save. No service, DB, API
contract, external processor, work editor, or general navigation redesign is
introduced.

The phone's generic save error was a separate confirmed upload-format bug:
WebKit's native canvas PNG includes eXIf metadata, which the existing strict
Backend correctly rejected with422. Avatar export now explicitly renders sRGB
and removes only disallowed ancillary chunks from the generated PNG. Retained
chunks, CRCs and compressed pixels are unchanged; the Backend validator and the
frozen work editor remain unchanged. Both WebKit and Chromium outputs, including
P3 source input, pass the actual validator with no pixel difference between the
same exported PNG before and after normalization.

After Save, the existing author provider owns the pending job. Unacknowledged
uploads and bindings reuse their original request identities after return,
refresh or network recovery. Definitive rejections stop automatic retry; the
retained image can be retried explicitly. A server receipt is reconciled with
the current profile before clearing local state or reporting success.

### Comment avatar synchronization acceptance correction

The Owner accepted avatar Save/navigation/refresh at
`dad37f26bd8bd47380358a9ab44257dbeb070c0b`, then reported that comment avatars
still did not match. This acceptance applies only to the completed avatar-save
correction. Comment-avatar synchronization remains pending in the same Draft PR
#126.

| Scenario                                     | Development                                                                                 | Production              | Must preserve                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| Root comments, replies and composer          | Show the author's current avatar; use the existing initial fallback when absent             | No new Phase 4 exposure | Existing comment presentation, authorship and profile navigation          |
| Own avatar changes                           | Read shared author state so loaded comments and the composer update with the profile/header | No exposure change      | Comment pages, loaded replies and unsent text remain intact               |
| Other authors and refreshed sessions         | Deduplicate authorized profile reads for loaded authors and revalidate on session revision  | No exposure change      | Bounded concurrency, account isolation and obsolete-response cancellation |
| Unavailable profiles or failed session check | Clear unavailable avatar presentation and keep the existing fallback                        | No exposure change      | Profile visibility rules; no unauthorized cached avatar restoration       |

The frozen embedded comment-author contract deliberately omits avatars. Reuse
the existing profile endpoint and comment avatar renderer; do not expand the
contract, change media/backend authorization, or alter the daily-change rule.
Other accepted surfaces and frozen work mutations remain unchanged.
