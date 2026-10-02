# Special / Article Editor V1

Task: `special-article-editor-v1`, r10. Owner assignment: 2026-09-30. Baseline:
`288d4d27e72339402b648f4458ef1aacadcfc681`. Delivery: independently reviewed
Draft, isolated Development acceptance, private handoff. No Ready, merge, Issue
closure, release, cloud operation or Production activation. Physical-device and
visual judgment remain the Owner's.

## r10 — Precise selection popup, direct crop and body-image resizing

The Owner's annotated desktop screenshots of 2026-10-01 correct r9's image
interaction meaning: editor image click must immediately enter crop mode, not
open a viewer first. Desktop mouse interaction must directly draw and adjust a
free rectangle on the image. Mobile must reuse avatar/background drag and pinch
semantics with flexible crop framing. "Enlarge" means dragging an image-edge
handle to proportionally resize its in-document presentation, with surrounding
text layout responding to the changed size. Reader-only original viewing stays
separate. Restore a compact rounded selection popup and add the same bounded
foreground/background color actions there.

Reuse the pinned native resizable image wrapper through a renderer-only adapter;
never persist native file URLs or loosen the Article schema. Persist an optional
finite normalized displayWidth (0.15–1, old document default1) on individual
managed-image blocks, preserving crop aspect, undo/redo, autosave and preview/
reader parity. One guarded commit occurs at gesture end; interrupted, stale or
unauthorized gestures never write. Flexible crop input produces the same
existing normalized per-block crop fields; no source image mutation. Keep the
existing sidebar/block drag, managed file drops and shared draft inbox.

Allowed paths: existing article-authoring helpers/editor/schema/tools/media and
direct tests, new focused resize/crop/palette helpers there, the semantic
Article reader and direct tests, canonical
packages/contracts/src/article-authoring.ts and its unit tests, generated public
OpenAPI if affected, and this specification. The existing authors crop-gestures
and native BlockNote resize component are read/reuse dependencies; do not modify
their unrelated flows. No dependency, database, Backend authorization, Work,
staff/Admin, Production or environment change. Rebuild canonical contracts and
selectively reload only the existing owned Development Backend when necessary;
keep all data and the fixed link. Root remains sole writer in the same
worktree/branch/Draft182.

Validation: two slices (selection popup; crop/resize interactions), one prepared
candidate plus at most two cause-backed corrections each. One selected feedback
plan<=120s, applicable build<=300s, focused real Development persistence<=120s,
and one focused browser smoke<=300s with shared remaining child deadlines. Prior
closed complete-feature/MCP plans stay closed, and prior failures remain. Stop
at Draft for Owner desktop/phone visual/device acceptance.

| Scenario          | Development                                                            | Production                   | Must Preserve                                                            |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Selection popup   | Rounded native formatting plus bounded text/background selectors       | No editor entry              | Selection, link safety, account fences, undo and stored styles           |
| Direct crop       | Click editor image; desktop free rectangle; flexible mobile drag/pinch | Existing cropped reader only | Source integrity, cancel, current crop, stable block/ref and identity    |
| Image edge resize | Native proportional handles; responsive normalized width               | Semantic reader parity only  | One undo unit, aspect, crop, surrounding layout, stale gesture rejection |
| Acceptance        | Same Development services, fixed entry and retained test content       | No activation                | Work publishing, shared draft inbox, prior evidence and Draft stop       |

## r9 — Reuse native rich-text tools and existing image interactions

The Owner's explicit capability-completeness correction of 2026-10-01 requests
an audit of the installed BlockNote capabilities and implementation of image
zoom/region cropping, text background color, discoverable bullet/numbered lists,
line spacing and alignment. Reuse the pinned native commands, list/heading
behavior and available icons; reuse the project's CatalogViewer and
CropWorkspace for image interactions. Keep the compact rounded floating toolbar,
one selector per function, direct independent desktop tools and mobile fit.

Persist optional bounded inline background colors, text-block alignment and line
spacing, and normalized image-block crop coordinates in the existing canonical
Article v1 JSON document. Old documents remain readable without migration. Crop
changes only the Article block's visible region, preserving the managed object,
original image, shared references, Work edits and Live Photo identity. Editor,
private preview and published semantic reader must agree. Image galleries reuse
zoom; this delta's crop editing applies to individual body image blocks.

Allowed paths: existing `article-authoring/` helpers, toolbar/schema/workspace/
media and direct tests; `article-published-body.tsx` and its direct test;
`features/detail/catalog-viewer.tsx` and its direct test for an optional
controls slot; `lib/public-api/article-authoring-client.ts`; canonical
`packages/contracts/src/article-authoring.ts` and its unit test; shared
`packages/design-tokens/src/typography.ts`/`theme.css`; generated public OpenAPI
only if affected; this specification. New image-presentation helpers/tests stay
in `article-authoring/`. Root is the sole writer in the retained worktree/Draft.
No dependency upgrade, new media storage, database migration, new identity,
Backend domain/authorization change, arbitrary embeds/tables, paid features,
hosted AI, Production change or deployment. Rebuild the changed contracts and
restart only the owned Development Backend if required to load validation;
retain the same fixed acceptance link, services, data, media and sessions.

Validation: two ordered slices (persisted formatting; image interactions), one
prepared candidate plus at most two cause-backed corrections per slice. One
selected feedback plan <=120s; an applicable Web build <=300s and focused live
Development persistence <=120s get explicit deadlines. Prior complete/MCP
acceptance failures/budgets remain closed. Stop for Owner desktop/phone visual
acceptance; no Ready, merge or task closure.

| Scenario                    | Development                                                        | Production                          | Must Preserve                                                           |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| List/heading tools          | Native behavior, icons and direct list entrypoints                 | No new editor entry                 | Text, stable IDs, bounded nesting, keyboard/slash behavior and undo     |
| Highlight/alignment/spacing | Canonical optional values survive save/reopen and semantic preview | Reader compatibility only           | Existing formatting/default documents, selection and account fences     |
| Image zoom                  | Reuse existing viewer gestures and accessible controls             | Existing resolved public media only | Object-key URLs, reader/editor separation, Live Photo controls          |
| Image crop                  | Existing crop controls; normalized per-block visible region        | Semantic reader compatibility       | Original asset, shared refs, cancel/undo, stale-block/account rejection |
| Acceptance/runtime          | Same isolated Development services/link/data                       | No activation                       | Previous evidence, Draft stop, Owner physical-device gate               |

## r8 — Image file drops throughout the Article body

The Owner's 2026-10-01 correction extends external image drops from text hits to
the full existing body scroll surface: horizontal margins, gaps between blocks,
space before the first block and below the last block, and an empty paragraph.
Use the nearest top-level block boundary when native text coordinates do not
resolve a position. The insertion indicator and final placement share that
destination; upload completion retains its stable block ID, regardless of later
caret movement. Files still pass through the existing managed uploader before
one canonical, undoable insertion. Internal BlockNote drags remain native.

Allowed delta: `article-file-drop.ts`, `article-file-drop.test.tsx`,
`article-editor.tsx`, `article-authoring.module.css`, and this specification.
Root is the sole writer in the same worktree, branch and Draft PR. No toolbar,
draft-box, Backend, contract, database, dependency, authorization, publication,
runtime or Production change. One focused feedback plan at most 120 seconds;
prior closed complete plans and failures stay recorded. Reuse the retained
Development entry and stop for Owner actual desktop/device acceptance.

| Scenario                  | Development                                                   | Production        | Must Preserve                                            |
| ------------------------- | ------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| Body margins and gaps     | External files insert at the indicated nearest block boundary | No new capability | Existing canvas and toolbar, top-level media schema      |
| Body beginning/end/empty  | Insert before first or after last block without a text hit    | No new capability | Stable IDs, file order, one-step undo                    |
| Upload/permission failure | No invalid or late insertion; existing recovery and notice    | Unchanged         | Account/session fences, quotas, readiness, autosave      |
| Internal block drag       | Existing BlockNote handlers and touch controls                | Unchanged         | Native drag, nesting guard, history and marker ownership |
| Acceptance environment    | Existing fixed Development entry/services/data                | No deployment     | Draft stop and Owner visual/device gate                  |

## r7 — Direct draft-card activation and native-position image file drop

Owner's annotated 2026-10-01 screenshots remove the redundant “Continue editing”
and “Public version” actions from the unified draft cards. Tapping a card opens
its existing editor; keyboard activation and long-press selection remain. The
original Work-only box under the false Article availability gate is unchanged.

Desktop external image files dropped into the Article body use BlockNote's
native drop coordinates and the established managed-media identification,
upload, lease and readiness pipeline. Only ready managed references enter the
canonical document. No temporary URL/file blocks, fabricated Works, new media
storage or schema are added. Internal block dragging remains native. Pending
uploads retain the chosen destination and recheck account, editability and
destination before inserting; no late result may write into another session.

Allowed delta: existing `article-authoring/` editor, media bridge/workspace and
directly affected helpers/tests; `publishing/ui/drafts/` card activation and
directly affected tests/styles; this specification. No Backend, database,
contract, dependency, authorization, publication, runtime or Production change.
One focused local feedback plan at most 120 seconds; all closed complete plans
and their failures remain unchanged. Use the retained fixed Development entry
and stop for Owner visual/device acceptance.

| Scenario                  | Development                                                     | Production                       | Must Preserve                                                        |
| ------------------------- | --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| Unified draft cards       | One card activation; no redundant edit/public buttons           | Existing Work-only box unchanged | Canonical editor dispatch, keyboard access, hold/multi-select/delete |
| External image drop       | Existing uploader; ready managed images at native drop position | No new capability                | File recognition, upload quotas, leases, account fences, autosave    |
| Drop failure/cancellation | Clear feedback; no invalid block or stale insertion             | Unchanged                        | Current content, reusable upload status/retry, no silent failure     |
| Internal block drag       | Existing BlockNote side-menu/drop transaction                   | Unchanged                        | Stable IDs, bounded nesting, native undo and redo                    |
| Acceptance                | Same owned Development entry/port/services/data                 | No deployment                    | Draft stop, prior evidence and Owner visual/device gate              |

## r6 — Restore compact desktop function selectors and original toolbar style

Owner's 2026-10-01 annotated desktop screenshot narrows r5's “all tools
directly” requirement: different functions retain directly visible icon entry
points, while choices within the same function use one selector. Restore the
existing paragraph style selector and text-color icon/palette on desktop as on
mobile; preserve all supported choices and exact selection restoration. Restore
the original rounded floating toolbar using the existing full-radius token and
unchanged SVG icons.

Allowed delta: `article-tools.tsx`, `article-authoring.module.css`, directly
affected `article-tools.test.tsx`, and this specification. No draft-box, editor
engine/schema, authorization, persistence, publication, runtime, dependencies or
Production change. One local feedback plan at most 120 seconds; prior complete
feature validation is not reopened. Stop for Owner visual acceptance on the same
retained Development entry. A feedback preview is not complete task acceptance.

| Scenario                  | Development                                                                              | Production        | Must Preserve                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| Paragraph/color variants  | One style selector and one color icon opening the existing choices                       | No new capability | Selection/bookmark, finite schema and authorization fences |
| Independent desktop tools | Existing direct style, link, history, media/Catalog/divider, movement and settings icons | Unchanged         | Existing commands/dialogs; no aggregate desktop launcher   |
| Floating appearance       | Original pill radius, shared glass styling and SVG paths                                 | No new capability | Current tokens; existing mobile two-row layout             |
| Draft/runtime acceptance  | Existing mixed card box and fixed Development entry                                      | Unchanged         | All r5 deletion semantics, data and launchd supervision    |

## r5 — Owner desktop tools and unified draft-card acceptance delta

Explicit Owner feedback of 2026-10-01 authorizes direct desktop tools, one mixed
Work/Article draft-card grid, long-press multi-selection and deletion, and reuse
of one local acceptance entry. This extends r4 only as follows. Root remains the
sole writer in the same worktree, branch and Draft PR. Earlier failed validation
and Owner rejection evidence stays unchanged.

Desktop displays all supported paragraph/list/quote choices, inline styles,
finite colors, link, history, image/gallery/Catalog/divider insertion, movement
and settings directly. Dialogs collect actual link/media/settings input. Mobile
retains the compact floating toolbar and focused launchers.

The existing draft box merges independently loaded Work and Article summaries
into one recently-edited card grid without type tabs. Type labels preserve
canonical distinctions. Long press selects; subsequent taps toggle selection; a
visible selection control supplies keyboard/desktop access. Scrolling, pointer
cancellation, a second pointer and leaving the box cancel a pending hold. Bulk
deletion names only the fixed selected loaded cards, confirms its scope, reports
per-item failures, keeps failed selections for retry and stops if account
confirmation changes. Active Work editor drafts remain protected. Existing Work
receipt replay, local-copy cleanup, media lifetime and history remain intact.

Article deletion is a human-session-only removal of the private editable copy,
version fenced and receipted in the existing Backend transaction. An internal
nullable deletion timestamp hides it from private reads/listing, quota counts,
pending review and delegated exact-candidate approval. Public immutable versions
and their media remain readable. Existing audit/history persists. Deleted draft
media pins are released; referenced public media is retained. No MCP deletion
tool or Agent/Admin scope is added. A forward migration adds only that internal
timestamp; executed migration bytes stay unchanged.

Allowed r5 paths: existing Article tools/styles/tests and draft data hook;
`apps/web/features/publishing/ui/drafts/` and directly affected history/card
tests; `packages/contracts/src/article-authoring.ts` with existing
exports/schema/JSON schema; existing Article authoring application
ports/services/parsers, HTTP handler and PostgreSQL adapter; existing Article
delegation exact-candidate query; one forward
`20261001010000_article_draft_deletion.sql` plus community manifest and existing
runtime grants; existing Article public-API client, OpenAPI source/generated
output and architecture allowlists; directly affected contract, HTTP and
isolated PostgreSQL tests; the existing Development sign-in page acceptance
link; and this specification. No dependency, governance, production/auth
provider, CMS ownership or other domain change.

| Scenario         | Development                                                                  | Production                | Must Preserve                                                    |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Desktop toolbar  | All supported tools visible directly in wrapping floating groups             | No new Article capability | Selection, undo, restricted formats                              |
| Phone toolbar    | Existing compact inset rounded tools                                         | Unchanged                 | No overflow; 44px controls                                       |
| Draft box        | Work/Article cards mixed by latest edit; one entry                           | Existing Work box         | Separate storage and type semantics                              |
| Selection        | 400ms hold; scroll cancellation; keyboard/desktop selection                  | Existing Work behavior    | Normal tap opens; release after hold does not open               |
| Bulk delete      | Confirm fixed selected cards; partial results and retry                      | No new Article route      | Active Work draft; current account; local copies                 |
| Article deletion | CAS plus receipt/audit; archived private copy and draft pins                 | Unavailable               | Published pointer/history/public media remain; stale writes fail |
| Acceptance entry | Reuse owned port and one local hostname entry/tab                            | No deployment             | Task-owned services/data only; physical-phone DNS pending        |
| Validation       | New substantive local combined plan <=900s; max two cause-backed corrections | No activation             | Full cumulative checks/review; prior failures; Draft stop        |

## r4 — Owner physical-phone acceptance correction

Owner's annotated phone screenshot on 2026-10-01 explicitly authorizes rounded
floating editor tools, current-UI pill buttons, underline, text color and usable
image reordering. This supersedes r3's horizontal mobile rail and narrowly
extends the canonical V1 inline styles with optional underline and exactly
`default`, `gray`, `red`, `brown` text colors. Existing theme tokens render
these as primary ink, secondary ink, seal red and ink gray; arbitrary CSS
values, background colors, fonts/sizes and all other forbidden formats remain
rejected. This is additive for retained V1 documents; no migration or new
storage master.

Allowed r4 files: the existing Article authoring directory (including a thin
`article-block-move.ts` and `article-block-controls.tsx` and directly relevant
tests), its semantic rich reader styles,
`packages/contracts/src/article-authoring.ts` and its schemas export,
`apps/web/lib/public-api/article-authoring-client.ts`, existing affected
contract/backend/reader/architecture tests, regenerated
`services/public-api/openapi/openapi.json`, and this specification. No
dependency, governance, auth, Work, global viewport, migration or native source
changes. Root is the sole writer in the original worktree, branch and Draft PR.

| Scenario               | Development                                                                                                                                               | Production                                                  | Must Preserve                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Mobile tools           | Inset rounded floating surface with two compact rows; all common formatting fits 320px; insertion and block actions in focused dialogs                    | No editor activation                                        | Visible hit targets, selection, focus, scroll/keyboard and current theme                  |
| Buttons                | Pill preview/actions and round icon hit areas from current Work/UI tokens                                                                                 | Existing runtime                                            | Disabled/busy states and accessible names                                                 |
| Underline/color        | Real native styles, finite palette, exact-selection restoration, canonical save/reopen and lightweight reader parity                                      | No authoring activation; existing supported document reader | Unicode, links, undo, prior publication, no arbitrary CSS or editor runtime in reader     |
| Images/blocks          | Visible drag handle; installed native desktop drag and handle-only touch adapter; top-level order validated, move/up/down/cancel/undo use the same engine | Unavailable                                                 | Stable block/ref IDs, nested list integrity, media lifetime and account/permission fences |
| Useful engine controls | Reuse native undo/redo, H2/H3/list/quote conversion, slash commands, contextual formatting, keyboard shortcuts, copy/paste and supported block movement   | Existing runtime                                            | Restricted schema and no unsupported paid/AI/collaboration/table features                 |
| Validation             | One substantive prepared r4 combined plan <=900s and at most two cause-backed corrections; real-phone judgement remains Owner                             | No deployment                                               | All r3 failed/exhausted results preserved, exact-head independent review, Draft stop      |

No unrelated cold-entry history correction is included in this delta; its known
unresolved observation remains recorded separately. This delta replaces only the
named mobile presentation and inline-format restrictions; all ownership,
autosave, media, publication, delegation and Delivery-stop requirements remain.

## r3 — Owner rejected editor UI and requested redesign

Owner instruction 2026-10-01 replaces the initial Article editor presentation
and separate draft-list workflow. The reference rich-text screenshot specifies
the quality and interaction direction, not a dependency/engine migration. The
Owner explicitly confirmed that Work and Article drafts must share the existing
draft-box entry; Article edits continue autosaving to the signed-in account.

Allowed r3 delta: `apps/web/features/editorial-content/article-authoring/`,
existing `features/publishing/ui/drafts/` card/picker/style seams,
`features/publishing/create-action.tsx`, the existing typed ProductShell
history/ composition seams and directly affected feature tests, plus this
specification. One writer applies the change in the existing
worktree/branch/Draft PR.

Provide an always-visible compact rich-text toolbar, real current-block/
selection formatting, contextual tools, safe-link dialog, clean media blocks
with image details and gallery-order dialogs, coherent title/body typography,
cover settings, and a single saved-draft destination. All visible commands act
on the existing persisted supported schema (paragraph, H2/H3, lists, quote,
divider, bold/italic/safe links, managed image/gallery/Catalog). No inert
toolbar buttons or unsupported-format claims. Do not add formats, dependencies,
contracts, migrations, storage masters, public authorization, collaboration or
AI features under this presentation redesign.

| Scenario                 | Development                                                                                                                    | Production                    | Must Preserve                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| Draft destination        | Existing account draft box contains Work and Article tabs; each opens its canonical editor                                     | No Article tab/API capability | Work counts/deletion/recovery/history and immutable Article ownership               |
| New Article              | Create directly from existing publish choice; empty writing canvas without a separate draft management screen                  | Unavailable                   | Idempotent creation and preserved failure input                                     |
| Formatting               | Fixed compact toolbar plus contextual selection tools; transform current text block, preserve text/caret, actual active states | No editor activation          | Restricted persisted schema, native undo/redo, safe link validation                 |
| Media                    | Image/gallery/Catalog use current pickers; caption/alt/order editing in scoped dialogs                                         | Unavailable                   | Media identity, upload lifecycle, Live behavior, undo and quotas                    |
| Save/leave               | Quiet truthful committed-save status; ordinary back flushes then returns to original destination                               | Existing behavior             | Composition deferral, receipt retry, no data loss, account epoch, conflict handling |
| Preview/publication      | Designed preview/footer and real validation outcome                                                                            | Unavailable                   | Exact candidate/revision, old public version, human approval and Backend policy     |
| Responsive/accessibility | Desktop grouping and mobile horizontal tools; keyboard labels, selection retention, native modal focus/cancel                  | Existing runtime              | Existing tokens, dark/reduced motion, shell history/focus/viewport                  |

This replaces only the initial editor presentation and separate Article list
entry. All r1/r2 domain, persistence, identity, publication, MCP, data-isolation
and Draft/Owner acceptance boundaries below remain binding.

## Scope and ownership freeze

Extend the existing Article/Special domain, Article identity, readers and
Backend boundary. Ordinary Works, Article Collections and Threads retain their
meanings. No Topic CMS, universal registry, separate media system or public
Admin account.

Staff Articles remain owned and written by Payload with their existing
exact-revision editorial approval. Public-user Articles are owned immutably by
the existing `PublicUserId`, obtained from the Backend session. Their one
editable versioned document lives in the community namespace; immutable revision
snapshots hold submissions and publications. Both origins use `ArticleId` and
the existing editorial read abstraction. No document has two editable bodies. A
public author cannot claim a staff Article ID or manage curated Collections.

The Owner's explicit r1 assignment narrowly supersedes track C's plain sections,
Catalog-only Article media and absence of Article MCP tools for this capability.
Staff editorial approval, public/Admin identity separation, admin connection
audience/presets, Content/Thread semantics and Production restrictions remain.
Root/local agent rules and governance are not edited.

## Allowed file inventory

New files are limited to the following named feature directories; existing files
are changed only at the seams listed here.

- `packages/contracts/src/article-authoring.ts`, `article-delegation.ts` and
  internal `community-operator/article-operator-schemas.ts`; additive exports in
  the corresponding `index.ts`, `schemas.ts`, `types.ts`, `json-schema.ts`.
- `services/api/src/modules/editorial/application/ports/article-authoring-port.ts`,
  `services/api/src/modules/editorial/application/services/article-authoring-service.ts`,
  `services/api/src/modules/editorial/transport/article-authoring-request-parsers.ts`,
  the corresponding Article delegation port and internal publication operator
  port/service/parser, existing editorial read port/service/mapper, and
  `services/api/src/index.ts`.
- `services/community-postgres/src/article-authoring/` (Article persistence,
  references and separate delegated grant storage), `src/index.ts`,
  `src/migrations/manifest.ts`; narrow changes to `src/publishing/media.ts`,
  `media-read.ts`, `permanent-media.ts`, `db.ts`, `uploads.ts`, `submissions.ts`
  and registration/holder seams required by this feature; the existing
  `author-adapter.ts` legacy PNG publication predicate and
  `notifications/source.ts` published Article target predicate and
  `discussion-store.ts` current authored Article target/owner interaction locks
  only, preserving legacy staff targets and all Work discussion behavior.
  Separate `src/article-delegation.ts`, `article-delegation-consent.ts` and
  namespace parameters in the existing agent provider/wrapper adapters reuse
  current credential storage, without changing omitted-namespace Admin behavior.
- `services/catalog-postgres/src/postgres-composite-editorial-adapter.ts`,
  `authored-article-read-projector.ts`, `authored-article-media-resolver.ts`,
  and their `src/index.ts` exports only for globally paged staff/authored public
  Article reads through the existing port.
- `database/community-migrations/20260930020000_article_authoring.sql`,
  `20260930030000_article_authoring_delegation.sql` and the forward-only
  `20260930040000_article_consent_uid_check.sql` correction, preserving the
  already executed migration and 256-character identity contract; named grants
  in `infra/development/work-publishing/grant-runtime.sql` and a precise
  `infra/development/article-authoring/grant-delegation.sql` role plan; the
  explicit post-community
  `infra/development/article-authoring/grant-public-read.sql`.
- `services/backend-runtime/src/community/article-authoring-handler.ts`,
  `article-mcp.ts`, `article-delegation-handler.ts`, `article-runtime-read.ts`,
  `article-publication-operator-handler.ts`, the existing `operator-handler.ts`
  guarded dispatch, `src/http/router.ts`, `src/application.ts`, `src/index.ts`;
  `services/backend-production/src/composition.ts` only for Development
  composition and its private-role Article delegation composition helper. Its
  `src/article-authoring/runtime-config.ts` and `read-composition.ts` reuse
  existing configuration and read adapters; `package.json` links the existing
  `@moya/agent-authorization` workspace package without an upgrade.
- `services/agent-authorization/src/article-provider.ts`, `article-server.ts`,
  and narrow `main.ts`, `wrap.ts`, `index.ts` composition/export seams only for
  a separate public-user audience and consented grants. Existing Admin presets
  and omitted-namespace behavior remain authoritative.
- `services/public-api/src/author-community-openapi.ts`, `openapi-document.ts`,
  `index.ts`, new `article-authoring-openapi.ts`, and
  `services/public-api/openapi/openapi.json` regenerated from source.
- `apps/web/features/editorial-content/article-authoring/`;
  `features/editorial-content/editorial-feed.tsx`, `editorial-detail.tsx`,
  `editorial-media.ts`; `features/discussion-preview/article-reader.tsx`,
  `academic-reader.tsx` only for semantic document rendering.
- `apps/web/features/home/discussion-screen.tsx` and its focused SSR test only
  to keep the existing provider-free production preview from invoking strict
  Development Thread hooks while validating normal production-build navigation.
  No Thread or authorization capability is enabled outside the existing author
  composition; its unavailable detail uses the existing fallback.
- `apps/web/features/product-shell/product-history.ts`, `product-shell.tsx`,
  `features/product-application/product-application.tsx` only for the existing
  conditional editor host, completion into the existing Article reader and
  history; `features/product-preview/t02p-product-preview.tsx` propagates the
  same optional Development gate. `features/publishing/create-action.tsx` adds
  the Article choice beside the existing Work action, and
  `features/publishing/ui/editor/editor-overlay.tsx` only exports its existing
  visual viewport hook for reuse.
- `apps/web/lib/public-api/article-authoring-client.ts` and the existing
  `article-delegation-client.ts`, the current `author-community-client.ts`
  request export/204 response handling, and existing community relay allowlist;
  existing upload/picker/viewport helpers may be reused through narrow export
  seams. No new uploader or global viewport change.
- `apps/web/features/authors/profile-settings.tsx` adds the account-owned
  connection entry and `apps/web/app/page.tsx` supplies the Development gate;
  keep the accepted Settings hierarchy and authentication flow. One writer owns
  this task checkout; unrelated auth work remains in its separate checkout.
- Human delegation consent/approval Pages at
  `apps/web/app/article-authoring/consent/[uid]/page.tsx` and
  `apps/web/app/article-authoring/approval/page.tsx`, using existing
  authentication and the same Article preview renderer; these are authorization
  flows only.
- `apps/web/package.json`, applicable MCP server package manifest and
  `pnpm-lock.yaml`: explicitly authorized pinned BlockNote/MCP additions only.
- Directly affected `tests/unit/`, `tests/integration/postgres/`, `tests/e2e/`
  and feature tests; exact architecture allowlists; this specification.

No native, CI, verification runner, hook, retained-data or governance edits.

## Behavior Matrix

| Scenario              | Development                                                     | Production                     | Must Preserve                                              |
| --------------------- | --------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Author entry          | Existing Special surface, authenticated own drafts              | No new entry/capability        | Ordinary Work and Thread publishing                        |
| Editor                | Conditional lazy BlockNote, Chinese UI, scoped tokens/portals   | Not composed                   | Single ProductShell/history/focus/scroll owner             |
| Document              | Restricted version 1 JSON; stable IDs and Unicode               | Existing data remains readable | Legacy sections/citations and unknown-version preservation |
| Draft write           | Backend-bound owner, expected revision, committed autosave      | Unavailable                    | No client byline/authorId authority                        |
| Conflict              | Preserve unsaved content, truthful reload/recovery              | Existing behavior              | No stale browser/Agent overwrite                           |
| Preview               | Account/grant authorized exact candidate                        | Unavailable                    | No public draft URL                                        |
| Publish               | Exact revision, reference/permission/policy checks, replay-safe | Unavailable                    | Pending is not published; staff approval stays             |
| Published edit        | New draft, previous authorized publication stays                | Existing behavior              | No premature public replacement                            |
| Upload/media          | Existing upload/processing/variants and stable IDs              | No new exposure                | Capacity accounting and Live Photo motion                  |
| Removal/Undo          | Remove reference, retain asset/history refs                     | Existing behavior              | No premature deletion or double charging                   |
| Delegation            | Separate public-user audience, draft-only default, revoke       | Unavailable                    | Admin connection scopes and subject separation             |
| Agent publish         | Human grant plus exact candidate authorization                  | Unavailable                    | No model self-approval                                     |
| Reader                | Existing reader, semantic rich renderer                         | Existing behavior              | No BlockNote runtime in browsing/reading                   |
| Errors/account switch | Actionable errors and scoped recovery                           | Existing behavior              | No private metadata or unsaved silent loss                 |
| Acceptance            | Synthetic local content, protocol/browser/performance evidence  | No activation                  | Owner visual/physical-device gate                          |

## Document and limits

The canonical envelope is `format: blocknote`, `version: 1`, ordered blocks,
typed media references and typed gallery groups. Custom block props are
supported primitive strings; gallery `groupId` refers to a typed ordered group
in the envelope. Arbitrary JSON is never encoded in a string prop.

Allowed blocks: paragraphs, headings at levels 2/3, bullet/numbered lists,
quotations, divider, managed/Catalog image, gallery and Catalog reference. Only
bold/italic and safe HTTP(S) links are allowed. No arbitrary typography, colors,
table, code, math, columns, files, remote media ingestion or embeds.

Finite new-author limits: 400 blocks including nested list children, depth 3,
40,000 Unicode code points across text/captions/alt, 1 MiB UTF-8 JSON, 60
distinct image references, 30 distinct Catalog records, 20 images per gallery,
title 120 code points and caption/alt 200 code points. These do not reduce
existing Work limits or make retained legacy Articles unreadable. No Unicode
normalization or Chinese script conversion. Unknown future versions are
preserved and refused for editing.

## Ordered implementation and verification

1. Shared restricted contract and legacy adapter, focused malformed/Unicode/
   limits/round-trip tests.
2. Thin real lazy editor with ArtVenn tokens and lifecycle, production chunk
   check.
3. Versioned persistence, media/lifetime, semantic reader and transactional
   publishing over the same Backend services; PostgreSQL and HTTP denial/replay
   tests.
4. Separate public-user delegation/consent/revocation, real maintained SDK MCP
   protocol client round-trip and stale-browser/Agent conflict.
5. Browser regressions, IME/focus/responsive checks, synthetic 100/300-block
   profiles, measured input-to-next-paint and lifecycle requests/retention.
6. Cumulative `verify-task` and `pnpm verify`, applicable exact-head CI, one
   independent actual-diff review, private acceptance services and handoff.

Validation profiles remain finite: feedback at most 120 s, Web/CMS complete 300
s per selected profile, local combined plan at most 900 s, shared remaining time
for children. Preparation is separately recorded; failed evidence remains. One
prepared candidate and at most two evidence-backed repairs per slice. Security
delivery shares one 120 s incremental allowance per genuine cycle.

## Integration and acceptance checkpoint

One isolated task worktree and branch were created from the initial fresh main
baseline above. Root remains the sole source writer. Helpers prepare private
proposals or review the actual diff read-only. The Owner checkout and sibling
writers' checkouts, indexes and services remain untouched. Unrelated tasks and
filename overlaps are not project-wide writer locks; actual mutable-worktree,
resource or incompatible consumed-interface conflicts stop the affected action.

The final integration uses freshly fetched main, including the merged
authentication UI changes. Its precise base and candidate head, complete
validation, independent review and CI belong in the Draft PR and private
handoff. Main integration preserves the accepted authentication, Settings and
ordinary Work behavior; it does not import an unmerged sibling branch.

Implemented source includes the restricted BlockNote editor, canonical document
and legacy adapter, real version-checked persistence/publication, current media
permission and lifetime guards, existing semantic readers, narrow author entry
and history integration, and separate public-user OAuth/MCP/consent/revocation
and exact human-candidate approval. These capabilities share current Backend,
identity, Catalog and media services. Server configuration and all writable
acceptance data are task-owned and private.

Three additive Article migrations retain their executed bytes. The third is a
forward-only correction to the first delegation UID constraint. Named roles
separate ordinary authorship, delegated approval control, issuer persistence,
public reads and CMS ownership. The control role's UPDATE(id) permits row locks;
immutable identity/version triggers and absent editable-column grants continue
to prevent it from editing document content.

The editor capture boundary selects attachment maps explicitly and omits only
the in-memory content:undefined metadata emitted by supported BlockNote
content:none blocks. Defined content, unknown fields and unsupported nodes still
fail canonical validation. Empty editable/focus transactions do not advance
saved edit generations; real getChanges events retain normal editing history.
Selection changes do not serialize the document or fetch references.

Synthetic Development preparation supplies real Catalog material, managed
processed images, a generated Standard Live pair, legacy staff Articles and an
ordered Collection, ordinary Work, representative/diagnostic long documents,
private new revisions and publication-policy examples. Generated Live material
is not evidence of Apple capture provenance or physical-device compatibility. No
private IDs, content, credentials, absolute paths or evidence attachments are
published here.

Focused successes do not replace complete validation. All failed runs and
original elapsed allowances remain preserved privately. The Owner explicitly
permitted cause-bound MCP/media corrections within the original remaining time,
and then one additional complete MCP attempt of at most 300 seconds after that
allowance expired. No deterministic automatic retry or budget reset is implied.
Final results distinguish protocol acceptance, actual vendor/live-model tests,
Development timing, production bundle/navigation evidence and untested device
behavior. Owner visual and physical-device acceptance remains pending.

Delivery remains an independently reviewed Draft PR and an accessible isolated
Development environment. No Ready transition, merge, deployment, Production
activation, release or Issue closure is authorized.
