# Special / Article Editor V1

Task: `special-article-editor-v1`, r2. Owner assignment: 2026-09-30. Baseline:
`288d4d27e72339402b648f4458ef1aacadcfc681`. Delivery: independently reviewed
Draft, isolated Development acceptance, private handoff. No Ready, merge, Issue
closure, release, cloud operation or Production activation. Physical-device and
visual judgment remain the Owner's.

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
