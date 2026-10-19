# Work publishing and draft editing — work-publishing-v1

Task: `work-publishing-v1`. Revision: r5. Earlier revision records remain in
this file and Git history. Owner-approved requirements provided on 2026-09-13
(implementation assignment for image/text publishing and draft editing). Phase 4
(#125/#126) is merged; this task starts from `main`
`362781c18a85711e6b456be7933b30a70afba04a` in its own worktree and one Draft PR.

## r3 — Owner visual acceptance corrections (2026-09-14)

The Owner reported displaced discussion avatars, a missing comment-tab total,
and no complete work/image inspection entry in Admin Works & Featured. Continue
the same task/PR with the following bounded correction. The Owner's final
explicit selection is complete details plus existing management operations.
Earlier conflicting text allowing direct content editing was clarified by that
final choice: this revision does not add operator content editing or change the
existing author-only editing rule.

| Scenario           | Development                                                                                                                                                                | Production                        | Must preserve                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Comment avatars    | Center image and fallback initial in one circular button for roots, replies and composer at phone/desktop sizes                                                            | No exposure change                | Existing profile action, artwork and avatar identity                                                      |
| Comment total      | Tab and section show visible roots plus replies across all pages; 0–99, then 99+                                                                                           | Same presentation when enabled    | Existing audience/moderation/deletion filters and root pagination; never expose private counts            |
| Admin work details | Open complete operator-readable submitted title/body, authorship, cover and ordered media from Works & Featured; distinguish latest submission and current public revision | No deployment or authority change | No private autosaves/self-only submission disclosure; immutable revisions and existing management actions |

The second Owner phone screenshot batch adds these visual corrections:

| Scenario         | Development                                                                                                                               | Production                    | Must preserve                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| Album indicators | Bounded dot window below the image, outside its scroller; phone number at image top-right                                                 | Same component, no deployment | Native swipe, selected image, Viewer, original bytes                            |
| Profile/settings | Inline follow/follower totals; edit profile, own comments and trash entries inside Settings; icon-only Back                               | No permission changes         | Privacy, account isolation, unsaved-change checks and Back                      |
| Draft picker     | Home-style image-first or text-only cards                                                                                                 | No new persistence            | Recent-edit ordering, exact draft deletion, recovery and missing-local warnings |
| Search           | Fixed top-bar magnifier without a visible button frame; floating single-border input, no duplicate inner close; submit dismisses keyboard | No search semantics change    | IME composition, query/results, accessible focus and close                      |
| Feed layout      | Avoid large holes caused by a wide-card barrier; equal apparent minimized dock circles                                                    | No sorting/storage changes    | Card identity, append stability, media fidelity and navigation                  |
| Input viewport   | Opaque page backdrop behind the keyboard-sized editor; subtle search surface transition                                                   | No OS UI override             | Visual-viewport bounds, safe areas and native input controls                    |

This does not waive native iPhone import, independent review or Owner device
acceptance, and grants no additional validation budget or delivery authority.

## r2 — Owner QA and corrected import boundary (2026-09-14)

This revision records the explicit Owner QA/debug assignment for Issue #137 /
Draft PR #138. The same task, branch and worktree continue; Codex is the
incoming QA/debug writer. The complete r1 remains available at
`5cde007f76d2598e64e59b90320101e9d3dbee35`. Requirements below supersede only
the identified earlier statements; every unaffected rule and Behavior Matrix row
remains binding.

- Official product name: 由于艺 / ArtVenn. Existing technical identifiers stay.
- Complete Live Photo import uses an iPhone-native PhotosUI/PhotoKit path. Its
  implementation and authorization belong to a separate Apple task; this QA pass
  writes no `apps/apple/**`. Web owns ordinary image/text editing, upload
  sessions, drafts, permissions, storage/processing and cross-platform playback.
  Camera brand is not the upload boundary. No Android/vendor importer expansion.
- Original compatibility means the complete selected representation actually
  exported by the supported native Photos path, including Photos-recognized
  third-party camera content. OS-edited and unmodified resources must be
  distinguished; bytes never supplied cannot be recovered or promised.
- Browser still-only input is an ordinary image, never a complete Live Photo.
  Existing paired parsers, checksums, quotas, private media, derivatives and
  Viewer stay useful backend/browser evidence. Mac paired-file selection is not
  the main acceptance journey. Missing native importer, hardware and motion
  samples are separate dependencies, not waived requirements. Web readiness,
  backend Live/playback evidence, native import and physical acceptance are
  recorded separately. This supersedes the r1 Media paths and real-sample
  feasibility statements that treated file exports as the primary journey or
  missing motion as Owner waiver.
- Standard sends supported optimized bytes before upload. Only already-small
  JPEG/PNG/WebP retention is permitted; retained HEIC/HEIF or any source motion
  (including QuickTime and MP4) is not. Unsupported optimization offers
  Original/remove before source upload.
- Every self-only → public transition follows the current publication policy,
  including unchanged previously approved content and a new matching revision.
  There is no prior-approval exemption. A work that stayed public may retain V1
  while V2 waits for approval; that different case is preserved.
- Conflict selection preserves later author input and recoverable unchosen
  versions; an older response never clears newer typing. The former private
  implementation note proposing such loss is not an accepted exception.
- QA may add focused regressions, necessary local helpers, exact reproducible
  App-role grants and forward product migrations within the existing task.
  Applied migrations and SQL ledger records must not be rewritten. Retained
  acceptance data is read-only unless a necessary reviewed forward update has a
  verified recoverable backup. Mutating tests use separately verified disposable
  databases, accounts and private storage.
- Local verification and core-credential budgets retain their accumulated
  ledgers. Historic timeouts remain failures; extra execution requires a
  specifically bounded Owner allowance. No workflow, CI, hooks, policy,
  unrelated task or Production changes are authorized.

| Correction scenario  | Development                                                      | Production         | Must preserve                                                |
| -------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| Re-publication       | Current policy gates all self-only to public paths               | No exposure change | Still-public V1 while V2 pending; timestamp and interactions |
| Conflict choice      | Chosen version plus later typing, with recoverable versions      | No exposure        | No lost input, no automatic publication                      |
| Complete Live import | Separate native dependency; truthful Web image fallback          | No exposure        | Grouping, private bytes, playback; no false LIVE             |
| Initialization       | Reproducible exact App-role bootstrap and isolated upgrade proof | No deployment      | Retained ledger/data, identity and role separation           |

## Authority and delivery stop

The Owner instruction of 2026-09-13 explicitly authorizes new album-style works,
editing of existing works, static and Live Photo media in Standard and Original
modes, private media storage and processing, persistent drafts and no-save
sessions, version conflicts and history, public/self-only visibility with an
independent work publication policy, a work recycle bin, bounded cleanup, quotas
and the essential Admin controls, including the necessary scoped contracts and
forward migrations. It supersedes the Phase 4 freeze of work creation, editing
and deletion entrances only. The Constitution and the six active amendments
remain in force otherwise.

Delivery stop: one Draft PR to `main`, a retained Development environment,
automated evidence, one independent actual-diff review, and Owner manual and
real-device acceptance. No Ready transition, merge, deployment, release,
Production exposure or phase closure is authorized. Development-only wiring
follows the Phase 4 composition gates.

## Non-goals

Rich text; tags or maps; independent audio/video posts; video trimming, filters
or music; AI writing, moderation or labeling; remote URL or cloud-drive import;
public registration or new identity providers; shared draft links; a cross-work
media library; public original-download; Production exposure; Apple projects;
Research; parked cloud/media-transfer work; CI, runner, classifier, budget or
approval-setting changes; avatar redesign; comment/reply draft persistence.

## Preserved behavior

Accepted profiles, avatars and avatar synchronization, account limits, cards,
long-press actions, comments, relationships, privacy, search results, Viewer and
Admin behavior remain unchanged except for the explicit changes below. UserWork
stays distinct from Catalog. Editing never changes author ownership, work
identity, discussion identity, likes/favorites or first-publication time.
Existing Catalog media and avatar/work PNG media keep their storage and read
compatibility; nothing is migrated out of their stores or deleted.

## Frozen functional paths

- `packages/contracts/src/**` (publishing schemas, text rule, operator shapes)
  and generated `services/public-api` OpenAPI.
- `services/api/src/modules/community/**` and public exports;
  `services/community-postgres/src/**`; `services/backend-runtime/src/**`;
  `services/backend-production/src/**`.
- New forward files in `database/community-migrations/` and the manifest.
- `apps/web/app/api/community/publishing/**`; `apps/web/lib/public-api/**`;
  `apps/web/features/{publishing,authors,comments,detail,product-application,product-preview,product-shell,shell,home,calligraphy,search,quick-actions}/**`;
  `apps/web/app/page.tsx`; `packages/ui/src/{assets.ts,assets/icons/**}` for new
  icons; `apps/web/package.json` and `pnpm-lock.yaml` for the pinned
  dependencies below.
- `apps/admin/src/community/**`, `apps/admin/payload.config.ts`, the supported
  Admin import map.
- `infra/development/work-publishing/**` (Development media-tools image and
  instructions); `turbo.json` pass-through keys for the Development Backend.
- `tests/unit/{contracts,backend,architecture,community}/**` product assertions
  and exact pinned-surface updates;
  `tests/integration/postgres/work-publishing*`, the r3 discussion regression in
  `tests/integration/postgres/phase4-author-cases.ts`, plus registration in the
  existing community suite; colocated product tests; this document and
  `docs/project-status.md`.

Scanner logic, verification runners, classifier, budgets, CI, hooks and
instruction files remain unchanged. Only exact allowlist entries required by the
existing scanner for new routes, server functions and client-visible DTO names
are added.

## Dependencies

Pinned, open-source, added only where used: `@uppy/core` 6.0.1, `@uppy/react`
6.0.0 (its headless React hooks for selection, as the Owner instruction names)
and `@uppy/xhr-upload` 6.0.0 (MIT) for transfer mechanics with automatic retries
disabled; `mediabunny` 1.56.2 (MPL-2.0) for WebCodecs container demux/mux in a
worker; `exifr` 7.1.3 (MIT) for bounded metadata extraction; `@dnd-kit/core`
6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2 (MIT, already in
the lockfile) for ordering; the existing `react-easy-crop` 6.2.3 for crop; the
existing `sharp` 0.35.4 (Apache-2.0; bundled libvips LGPL-3.0) added to the
Backend. Development server derivatives for HEIC and motion use a locally built,
sandboxed Debian image with FFmpeg 7.1.5 (GPL build), libheif 1.19.8 and
libde265 1.0.15 (LGPL-3.0), run without network, read-only, with CPU, memory,
process and time bounds. No paid or third-party processing service. A Production
processing toolchain is outside this task.

## Content rules

A work is an ordered album of at most 50 complete media items, an optional title
(≤ 200) and a plain-text body (≤ 10,000) with preserved line breaks. Length is
the number of Unicode code points after normalization (CRLF/CR → LF; NUL and
lone surrogates rejected; outer whitespace trimmed; titles single-line), shared
by contracts, Web and Backend; existing valid content remains valid. Text-only,
media-only, mixed and title-only works are valid; submission is rejected only
when title, body and retained media are all empty or a genuine validation or
readiness condition fails. Authorship: original, copy or practice, or material
sharing (the latter two with optional reference work, original author and
source). No per-image captions.

## Behavior Matrix

| Scenario                     | Development                                                                                                                                                                                                                                          | Production         | Must preserve                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Entry                        | Lower-right dock action becomes a white plus on the seal token opening the editor; Search moves to the upper-left of Home, Inscriptions and Calligraphy                                                                                              | No exposure change | Dock shape, size, placement, collapse animation; one floating action; search function, focus return |
| Editor (phone)               | Full-screen three steps: media → text/authorship/visibility/draft mode → short confirmation; text-only may skip media; uploads continue across steps                                                                                                 | No exposure        | One editing session across steps and resize; keyboard, safe area, focus, Back                       |
| Editor (desktop/wide tablet) | One spacious editor with media, text and continuous real work preview; same confirmation                                                                                                                                                             | No exposure        | Existing tokens, fonts, radii, light/dark                                                           |
| Selection                    | Save draft (default on) and Original quality (default off per batch) visible before selection; picker, drop and paste; staging groups files into logical items then uploads privately                                                                | No exposure        | Text entry usable during preparation/upload                                                         |
| Standard                     | Optimized in the browser before upload; optimized master stored privately; reliable pre-optimization metadata stored privately                                                                                                                       | No exposure        | No hidden original upload; no upscaling, crop, filter or sharpening                                 |
| Original                     | Complete received components stored byte-for-byte with server checksums; separate derivatives; sources never publicly served                                                                                                                         | No exposure        | No recompression or metadata stripping of sources                                                   |
| Unsupported compression      | Explicit choice to upload Original or remove                                                                                                                                                                                                         | No exposure        | Never silently send the source as Standard or drop motion/audio                                     |
| Live Photo                   | Paired by trustworthy identifiers or container; counts as one item; ready only when all components validate and derivatives exist; cards show static cover + LIVE; Detail/Viewer play on explicit action, muted first, audio toggle                  | No exposure        | Stored audio retained; existing long-press gestures                                                 |
| Ordering and edits           | Drag, long-press, keyboard/button ordering with numbers; independent cover; rotate/crop/revert applied consistently to still and motion derivatives                                                                                                  | No exposure        | Stable item IDs; unchanged masters not retransmitted                                                |
| Upload execution             | Account-scoped manager survives navigation; global progress entry; distinct states; per-component bounded transfers; no automatic network retries except the bounded lost-answer recovery below (#292); retry only failed components                 | No exposure        | Account switch/logout pauses and isolates                                                           |
| Saved draft                  | Created on first real content; ~2 s coalesced autosave; Save now; Drafts card first in own Works with newest-first picker; conditional saves with This device / Account version choice; history of 20 important snapshots                            | No exposure        | Visitors see no drafts; unchosen content recoverable; newer input never cleared                     |
| No-save                      | No persistent draft, snapshot or local recovery copy; minimal temporary session with bounded lease; explicit discard revokes immediately and cleans session-only data                                                                                | No exposure        | Existing published/private work revisions and other drafts untouched                                |
| Submission                   | Idempotent confirmation tied to an immutable revision; receipt query on lost response; opens the author's work view with a path back                                                                                                                 | No exposure        | No duplicate works or double daily counts                                                           |
| Publication policy           | Independent work policy: fresh default direct publication; Owner can switch to pre-moderation in Admin without restart; prospective only                                                                                                             | No exposure        | Comment publication policy unchanged                                                                |
| Visibility                   | Public/self-only; public→self-only restricts third parties immediately; pending edits keep the last public revision for others; effective visibility on feed, search, profile, favorites, likes, discussion, media/Range, covers, previews and links | No exposure        | First-publication time set once; Edited marker after real content updates; interactions preserved   |
| Admin                        | Work policy, submitted-revision moderation (latest only), limits and Owner capacity designation, stuck processing/cleanup outcomes                                                                                                                   | No exposure        | Payload stays operator UI calling the Backend boundary                                              |
| Recycle bin                  | Submitted works trash for 30 days (configurable); restore as self-only; Admin-removed cannot self-restore; unsubmitted drafts delete immediately                                                                                                     | No exposure        | Discussion identity preserved; shared blobs never deleted while referenced                          |
| Limits                       | 50 items; 128 MiB per Original item (provisional, configurable); no whole-work cap; 10 GiB ordinary / 20 GiB Owner account capacity; 100 active drafts; 100 first submissions per America/New_York date                                              | No exposure        | Clear feedback at limits; no persistent quota meter; text save and deletion still work              |

Lost-answer recovery (#292, Owner-approved 2026-10-18). When a component's
upload answer is lost or unreadable after the browser reported every byte sent
(status 0, a relay 502/504 or other non-refusal 5xx, an unreadable success, or
the 150 s answer guard), the manager reads the item again, now and then on the
healthy poll cadence for at most 30 s, writing nothing meanwhile; the photo
keeps showing 「文件已发送，等待确认」. A committed component continues
silently. A component the account proves it does not have (awaiting, or still
receiving when the window ends) is retried once per user action (the first send
or each explicit 重试 / 继续上传) through the same read-first path as 重试. A
spent retry, a window without a successful read, a partial send, a refusal, a
pause, a cancel or an account change keeps today's behavior and failure text.

## Media paths and limits of proof

Complete Live Photo originals reach the browser only through verified export
paths that supply both components (for example macOS Photos “Export Unmodified
Original”, or iPhone Photos “Export Unmodified Originals” to Files followed by a
multi-file selection). iOS Safari photo-library picks provide a compatible still
without the motion component and cannot be presented as a complete Live Photo or
as camera-original proof. Synthetic pairs are regression fixtures only; the
real-device scope is limited by Owner decision as recorded in the feasibility
note below.

## Feasibility note (before building the editor)

Tested path: a private end-to-end harness (browser worker preprocessing → Uppy
raw-body transfer with retries disabled → streamed server storage with SHA-256 →
sandboxed server derivatives → authorized private reads) in headless desktop
Chrome for Testing 151, Playwright WebKit 26.5 and Firefox 153, re-run and
checked by a separate verifier. Inputs were synthetic regression fixtures; no
physical iPhone.

Results: Standard static uploads stored exactly the browser output bytes and
applied EXIF orientation in pixels; Original uploads were byte-identical;
derivatives carried no EXIF/GPS while stored originals kept them; a synthetic
HEIC+MOV pair matched by Apple content identifier on client and server, an
unrelated pair was refused, and the H.264/AAC motion derivative played in all
three browsers with duration within 1 ms and audio present; Standard Live
transcoding worked in Chromium and WebKit in about 0.5 s. A cancelled upload
that later completed was refused at commit and stored nothing.

Limits that shaped the implementation: WebKit cannot encode WebP from canvas and
its JPEG/PNG output can be larger than the input (keep the input instead); only
WebKit decodes HEIC in the browser; Firefox lacks HEVC decode and AAC encode
(explicit Original-or-remove choice); browsers re-sent a dropped `PUT` upload on
their own, so component uploads use `POST` behind a server attempt/cancel fence;
Uppy Golden Retriever cannot restore files over 10 MiB without a service worker,
so saved-draft recovery uses a bounded account-scoped IndexedDB store; WebKit
ignored a requested AAC bitrate and Chromium's H.264 output carried a
color-matrix tagging mismatch, so compatible audio is copied and color space is
set explicitly with a fidelity check; tall images need width-bounded display
derivatives. Live Development runs showed WebKit keeping an untouched input as
the Standard master whenever its own encoding was not smaller, including a 24 MP
HEIC still; the Matrix does not allow a source to be sent as Standard without an
explicit choice, so retention is limited to already-small JPEG, PNG or WebP
inputs, and a HEIC/HEIF still or QuickTime motion that Standard cannot reduce
enters the explicit Original-or-remove choice. Development tool timings: HEIC
decode about 0.46 s, motion transcode about 1.1 s including container start.

Real samples: two iPhone 17 Pro Max HEIC Live stills and two Insta360 Luna Ultra
JPEG Live stills were provided without motion components. By Owner decision only
these files are tested; complete Live Photo originals for iPhone 17 Pro Max and
Insta360 Luna Ultra, and all DJI Osmo Pocket 4P paths (no device), remain NOT
TESTED.

## Evidence

The private task artifacts hold the feasibility measurements, sample manifests,
environment ownership and walkthrough. The Draft PR records exact base/head,
checks, review and the acceptance state.

## r4 — Owner acceptance and Admin management delta (2026-09-14)

The Owner explicitly requested the following changes on the same Issue #137,
branch and Draft PR #138. This revision supersedes only the identified r1–r3
behavior; those records remain above and in Git history. No merge, deployment,
Apple implementation, account deletion or direct administrator editing of an
author's title/body/images is authorized.

| Scenario                     | Development                                                                                                                             | Production                                 | Must preserve                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New Web photo selection      | Treat selected supported images as static photos; no Live pairing/missing-component choices; refuse video inputs                        | Same behavior when publishing is available | Standard/Original remains explicit; Standard never silently sends a retained HEIC or hidden motion source; existing Live media and playback remain supported     |
| Work identity and text       | All readable works show an unframed avatar/name linking to the author; body follows title without a duplicate name or body heading      | Same presentation                          | Author identity, plain text/newlines, truthful publication dates, one existing Detail/Viewer                                                                     |
| Author management and follow | Compact one-row icon edit/trash and visibility controls; follow toggles beside profile totals                                           | Same presentation                          | Only author management, current publication policy, destructive-action confirmation, accessible names and touch targets                                          |
| Phone ordering               | Long-press sorting with a bottom hint on the media step; no visible up/down buttons on phone                                            | Same presentation                          | Desktop and keyboard sorting, stable media keys, cover choice, upload state and order independent of completion                                                  |
| Recommended works            | List all currently eligible recommended works with pagination and adjustable order; active recommendation appears black and toggles off | Existing Development-only gate retained    | Recommendation never approves or exposes private, pending-only, hidden, removed or trashed content; deterministic public order                                   |
| Bulk work management         | Explicit selection with bulk recommend, cancel recommendation, hide and remove; show individual outcomes                                | Existing Development-only gate retained    | Existing authenticated Owner Admin bridge, audit and idempotence; removal uses the existing operator removal semantics, not physical deletion                    |
| Public-user management       | Paginated users, user details and their operator-readable submitted works; same selected-work operations                                | Existing Development-only gate retained    | Public users remain Backend-owned and distinct from Payload accounts; no draft/autosave/private-submission disclosure                                            |
| Recommended users            | Toggle and bulk-toggle automatic recommendation of existing and future eligible public works                                            | Existing Development-only gate retained    | Public/moderation restrictions always apply; turning user recommendation off removes its automatic contribution while explicit work choices remain authoritative |

Allowed supporting changes are the existing Web/Admin feature paths, internal
community contracts and authenticated HTTP bridge, API/application/PostgreSQL
adapter, necessary additive forward community migration and exact runtime
grants, focused product tests, this specification and project status. No new
dependency, workflow/scanner/CI policy change, new product task or PR. Retained
Owner data is never disposable; any acceptance schema upgrade requires a
verified private backup and an isolated recovery check before the reviewed
forward path. Native PhotosUI/PhotoKit import remains a separate pending task.

User bulk operations currently cover recommendation/unrecommendation. Suspension
and reinstatement require the pending explicit Owner selection; account deletion
is excluded. Prior test results and cumulative execution/security ledgers remain
valid historical records; this scope delta itself adds no test time.

## r5 — Owner mobile interaction corrections (2026-09-15)

The Owner's three annotated screenshots explicitly replace the affected r4
interactions on the same Issue #137 and Draft PR #138. All other requirements
and historical evidence remain unchanged.

| Scenario                     | Development                                                                                                                                                                                                                            | Production                        | Must preserve                                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Media ordering and selection | The whole non-control area of each media card supports long-press drag; long press also enters selection, then tapping cards selects more for one remove action. Explain both gestures in the media-step footer.                       | Same when publishing is available | Ordinary scrolling, independent child controls, keyboard access, stable item identities/order, cancellation fences, existing media references and cover fallback                                       |
| File selection               | Selecting, dropping or pasting supported photos starts upload automatically; remove the intermediate ready-file confirmation list and Add/Cancel-all buttons. Reject an excessive selection clearly without dropping existing uploads. | Same when publishing is available | Explicit selection-stage Standard/Original, source-byte guarantees, 50 logical items, unsupported-file feedback, manual failure retry, account/session isolation, correct missing-resource replacement |
| Work visibility              | Adjacent edit/trash icons, then one visual public on/off switch acting in place without another screen or private-confirmation dialog.                                                                                                 | Same presentation                 | Author-only commands, busy lock, idempotent unknown-result retry, truthful server read-back and current publication policy; work trash confirmation remains                                            |
| Comment controls             | Trash icon for body deletion; heart icon only for likes; activate the comment text entry to reply using the existing composer.                                                                                                         | Same presentation                 | Accessible action names and keyboard activation, correct root/sibling target, text selection, no nested-control bubbling, owner-only body deletion, unchanged moderation and ephemeral draft rules     |

Allowed changes are the existing Web publishing/editor, comment and detail
feature paths, their focused tests, this specification and project status. No
new backend capability, public contract, migration, dependency, workflow policy,
Apple code, production action or merge is part of r5. Tests retain the
cumulative ledger. The Owner approved a combined remaining 480-second allowance
(mobile 90, Admin 240, full local 120, focused recheck 30), including r5 time
already charged after the request; the earlier entries and failures remain.

## r6 — Explicit draft saving and interruption recovery (2026-09-15)

The Owner replaces automatic cloud draft saving and its save/no-save option with
an explicit Save Draft action on this same task and Draft PR. This replaces
D02/D05 and the affected r1–r5 autosave/mode-switch behavior only. Historical
requirements and evidence above remain historical; they do not authorize an
automatic cloud save in r6.

| Scenario                                       | Development and Production                                                                                                                             | Must preserve                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing, uploading, or returning to an account | No draft creation or cloud content save without an explicit Save Draft action; no autosave option                                                      | Temporary upload ownership, private storage, Standard/Original, quotas and manual upload retry                                                                       |
| Save Draft                                     | Create the draft on the first explicit save; subsequent ordinary saves replace that draft's current content, without adding ordinary history snapshots | Revision-conditional writes, idempotent outcomes, newer typing, unresolved conflict copies and existing historical records                                           |
| Another device                                 | Sees only explicitly saved content; unsaved local edits do not synchronize                                                                             | Same-account authorization and conflict protection; no last-writer-wins data loss                                                                                    |
| Unexpected interruption                        | Restore the local editor content and available local upload resources in the same browser/account                                                      | Local recovery is separate from account drafts; bounded storage, visible storage failures, no hidden original retained after Standard preparation, account isolation |
| Intentional in-app return or exit              | Unsaved-draft prompt offers Save Draft and Leave, Continue Editing, or Discard Changes                                                                 | Failed saves stay open; discard removes only this session's unsaved state, preserving the last saved draft and referenced media                                      |
| Refresh or tab close                           | Native browser unsaved-changes warning plus independently persisted local recovery                                                                     | Browser-controlled warning text and mobile lifecycle limits are disclosed; no asynchronous cloud save during unload                                                  |

Allowed changes are the existing Web publishing runtime/editor/local recovery,
their focused tests and these task records. Existing Backend draft/session APIs
are reused. No new dependency, public contract, migration, Apple implementation,
workflow policy, production operation or merge is authorized by this delta. Save
Draft waits for complete uploaded component bytes; derivative processing may
continue. A failed or incomplete upload remains unsaved and recoverable locally,
with an explicit message.

Local recovery does not promise survival of cleared browser storage or a write
that the OS interrupted before completion. The existing cumulative execution and
credential ledgers remain in force; additional test time requires the Owner's
separate bounded approval.
