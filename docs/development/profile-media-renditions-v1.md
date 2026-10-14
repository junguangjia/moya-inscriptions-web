# Profile media renditions — profile-media-renditions-v1

Task `profile-media-renditions-v1`, Issue #270 r1 (2026-10-13). It delivers
increment 3a of the [unified media pipeline](unified-media-pipeline-v1.md)
(Issue #206 r21) under the
[2026-10-04 unified media pipeline amendment](../governance/amendments/2026-10-04-unified-media-pipeline.md).
It also carries one separate Owner product change of the same date: the limit of
one avatar change per New York calendar day is removed.

Authority: the Owner's approval of the profile-renditions design on 2026-10-13
(decisions D1–D13) and the Owner's request of the same day to remove the avatar
limit. The Issue holds the frozen scope; this document is the public-safe task
record. The design is described in
[Profile images (increment 3a)](unified-media-pipeline-v1.md#profile-images-increment-3a),
and the Production steps in the
[release runbook](../deployment/media-profile-renditions-inc3a.md).

This document names no bucket, account, host, server instance, hostname, private
path or acceptance content. Those stay in protected runtime configuration and
private operations records.

## Goal

- Profile images (`community.user_media`) become a third rendition subject next
  to work and Article media items and Catalog assets, keyed by the unchanged
  public user-media id.
- Four version-1 WebP recipes on the existing registry: `avatar-128` (quality
  80), `avatar-512` (82), `background-960` (82) and `background-1600` (84).
  Never upscaled, metadata stripped, alpha kept; `avatar-512` and
  `background-1600` are skipped when they would equal the smaller role. The six
  existing recipe digests are unchanged.
- Rendering runs only in the existing media-worker sandbox, from the stored PNG,
  checked against the row. Outputs are owner-less `profile_derivative` blobs in
  the existing private publishing store; a family is recorded in one
  transaction.
- A new job kind, `profile_render`, is queued only by a paced worker sweep
  driven by the avatar and background pointers; the sweep is also the backfill.
  The Backend write path is unchanged apart from the avatar limit.
- An authorized read: `/api/community/media/<user-media-id>/<role>` relays to
  the Backend's `GET|HEAD /v1/community/media/{mediaId}/{rendition}`, with the
  original route's access rule narrowed by family and a Backend-decided `304`
  for current images. Nginx is unchanged.
- `AuthorMedia` gains an optional `renditions` list; `src` stays the original
  PNG. The Web uses `avatar-128` for avatars up to 48 px, `avatar-128` and
  `avatar-512` for the 80 px profile header and the 96 px registration avatar,
  and one URL, the largest background rendition, for all three cover layers.
- Two switches, each off in Production and on in Development by default:
  `MEDIA_PROFILE_RENDER` (media worker) and `MEDIA_PROFILE_RENDITIONS`
  (Backend). Any other value than `on` or `off` refuses startup.
- An author may change the avatar any number of times per day.
- The comment above the user-media helpers in the Web Public API server module
  now says the image is revalidated on each normal load and that back/forward
  may reuse it while the cookie is unchanged.

## Behavior Matrix

| Scenario                                                                                                         | Development                                                                                                                                                                                        | Production                                                                                                                                                                           | Must preserve                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Small avatars: feed post 36 px (including your own), work detail, comments, colophons, followers/following 48 px | `avatar-128` WebP once rendered; the original PNG before that                                                                                                                                      | Original PNG until emission switch-on, then `avatar-128`                                                                                                                             | Box sizes, lazy loading, initial-letter fallback when there is no avatar, profile navigation                |
| Profile header avatar 80 px; registration 96 px                                                                  | `avatar-128` at 1×, `avatar-512` at ≥ 2× (`srcset`)                                                                                                                                                | Same after switch-on                                                                                                                                                                 | Layout, eager header load, crop                                                                             |
| Profile cover: sharp, compact and frosted layers                                                                 | One largest-background URL for all three (one download); tint sampled from it                                                                                                                      | Same after switch-on                                                                                                                                                                 | 4:3 top-anchored cover, minimum height, tint behavior, no layout change                                     |
| My blocked-accounts list                                                                                         | No renditions; same as before                                                                                                                                                                      | Same                                                                                                                                                                                 | Blocked reads stay `404`                                                                                    |
| Owner's avatar and cover editors                                                                                 | Original image                                                                                                                                                                                     | Same                                                                                                                                                                                 | Editing fidelity                                                                                            |
| Rendition missing (switch off, not yet rendered, rejected source, older Backend)                                 | Original `src`                                                                                                                                                                                     | Same                                                                                                                                                                                 | Previous behavior, including the relief `ETag` revalidation                                                 |
| New avatar or cover set                                                                                          | Original shows first; the rendition appears after the next sweep (about 60 s plus queue)                                                                                                           | Same once the worker switch is on; shown only after emission switch-on                                                                                                               | Backend write path; no job queued on bind                                                                   |
| Avatar replaced or cover cleared                                                                                 | Other viewers get `404` on the old rendition URL at their next load; the owner can still read it (`no-store`)                                                                                      | Same                                                                                                                                                                                 | Authorization equal to the original route, narrowed by family                                               |
| Suspended owner, blocked pair, erased image                                                                      | `404`, as for the original                                                                                                                                                                         | Same                                                                                                                                                                                 | Erasure releases renditions in the same transaction; objects are purged ≥ 1 h after rendering               |
| Rendition caching                                                                                                | Current images: relay `private, no-cache`, `Vary: Cookie`, strong `ETag`; the Backend answers `304` from the stored hash without reading storage. Owner-only reads and errors: `private, no-store` | Same                                                                                                                                                                                 | Every normal load is authorized by the Backend; no shared cache (no Nginx cache; image optimizer closed)    |
| Backfill of existing avatars and covers                                                                          | Paced worker sweep                                                                                                                                                                                 | Starts in the release window with the worker switch on; at most 2 open jobs and 2 per 60 s pass; pauses while `process_item`, `derive_edit` or `catalog_render` is queued or running | A work upload waits behind at most about 2 short profile jobs; concurrency 1; sandbox bounds                |
| Storage capacity                                                                                                 | Profile renditions are owner-less and not counted                                                                                                                                                  | Same                                                                                                                                                                                 | Account capacity and usage                                                                                  |
| Profile and people JSON with emission off                                                                        | No `renditions` key; otherwise identical, except that an owner's own `nextAvatarChangeAt` is always `null`                                                                                         | Same (the default until switch-on)                                                                                                                                                   | Old pages keep parsing                                                                                      |
| Old Web pages kept open                                                                                          | n/a                                                                                                                                                                                                | Emission switch-on only ≥ 72 h after the release; a reload fixes it; switching off restores the identical answer                                                                     | No Web rollback below the 3a release while emission is on                                                   |
| Edge delivery                                                                                                    | Profile renditions never published                                                                                                                                                                 | Same                                                                                                                                                                                 | Increment-2 delivery for works, Catalog and Articles                                                        |
| Admin job list                                                                                                   | Shows `profile_render` with its label                                                                                                                                                              | Same                                                                                                                                                                                 | Other job views                                                                                             |
| Changing the avatar                                                                                              | Any number of successful changes per day; each applies at once; no "already changed today" message and no New York date note; `nextAvatarChangeAt` is `null`                                       | Same, live from the 3a release (no switch)                                                                                                                                           | Upload validation, ownership, request-id idempotency and receipts, Save survival, account-switch protection |
| Concurrent avatar saves from two devices                                                                         | Both commit in order; the profile shows the last                                                                                                                                                   | Same                                                                                                                                                                                 | The same request id replays its stored result; `409` only for request-identity or version conflicts         |
| Old pages and avatar changes                                                                                     | Still parse the avatar result (contract key set unchanged); may show the old daily note until reload; never blocked                                                                                | Same                                                                                                                                                                                 | No failed saves in old pages                                                                                |

Unchanged: the original image route (bytes, authorization and its revalidation
with an `ETag`), upload validation (PNG only, at most 4 MiB, 8192 px per side
and 16 Mi pixels), the cover rules, profile visibility (suspension, blocking,
erasure), work, Catalog and Article media (recipes and digests, increment-2
delivery, the publication trigger and eligibility, worker concurrency and
sandbox bounds, capacity accounting, the retention hold, users' own deletion
lifecycle), Nginx, the product-access mode, Admin separation, disabled Email and
SMS, box sizes and framing, and the Apple and HarmonyOS clients.

## Owner decisions (2026-10-13)

- **D1.** Avatars and covers are a third rendition subject keyed by the
  unchanged user-media id, not media items with profile holders. Increment 3
  splits into 3a (this task) and 3b (direct upload; moving source bytes out of
  PostgreSQL).
- **D2.** Sizes 128/512 and 960/1600; WebP quality 80/82/82/84.
- **D3.** Renditions do not count toward publishing capacity (owner-less blobs).
- **D4.** Current avatar and cover renditions follow the 2026-10-13 relief
  caching: every load is authorized, the relay sends `private, no-cache` and an
  `ETag`, and the Backend decides the `304` from the stored hash. Owner-only
  renditions are `no-store` (amendment entry 5).
- **D5.** While renditions are not ready, the original image is shown.
- **D6.** The profile cover uses one URL, the largest background rendition
  (`background-1600`, or `background-960` when 1600 was skipped), for all
  layers.
- **D7.** Renditions of replaced avatars and cleared covers are kept, readable
  by the owner only, until the source is erased. Erasure releases them in the
  same transaction, and the existing `purge_blob` schedule deletes them once
  they are not in use and at least 1 h after their blob was created (when they
  were rendered, not when they were released), so a rendition older than 1 h is
  usually deleted within about a minute of the erasure.
- **D8.** The contract already accepts future published URLs.
- **D9.** One late-night release (migration, Web, contracts, Backend, Admin,
  worker) with emission off; switch-on no earlier than 72 h later.
- **D10.** The backfill starts after the release, paced (at most 2 per minute),
  yields to uploads and follows the stop rules.
- **D11.** Switch-on threshold: at least 95% rendered, with every failure
  explained.
- **D12.** Window: a weekday, 01:00–02:30 Asia/Shanghai, ending before the
  nightly database dump. The date is the one open Owner decision.
- **D13.** Tag `media-pipeline-inc3a`. The switch-on is a setting change
  recorded on Issue #206.
- **Avatar limit.** Remove the limit of one avatar change per New York calendar
  day, in the same 3a release and under the same tag, with no replacement rate
  limit (see [Avatar change limit removed](#avatar-change-limit-removed)).

## Governance records

- **3a/3b split and tags (amendment entry 9).** Issue #206 r21 splits increment
  3: 3a "profile renditions" is this task; 3b "direct upload and profile source
  relocation" covers direct browser-to-storage upload, the hash-verified
  relocation of existing `user_media` bytes out of PostgreSQL, the `user_media`
  retention follow-up and optional edge delivery of profile renditions. 3a
  deploys from the annotated tag `media-pipeline-inc3a` on the verified merged
  `main` commit, followed by a GitHub Release; 3b deploys from
  `media-pipeline-inc3b`. Turning emission on is a configuration change recorded
  on Issue #206 without a tag; a corrective re-release needs its own approved
  tag. Rollback restores the recorded per-service release bindings and their
  previous tags.
- **Entry 6 timing.** Increment 3 counts as deployed only when 3b is deployed.
  Until then avatar and background bytes stay in PostgreSQL and retained rows
  are not rewritten; "PostgreSQL receives no new image bytes" is deferred to 3b.
  3a moves no bytes and adds none beyond the existing upload path. Public
  profile-media ids do not change.
- **Entry 5 (D4).** Renditions of a current avatar or cover are readable by
  every viewer the Backend authorizes, so they are not owner-only or unpublished
  reads; the relay serves them `private, no-cache` with `Vary: Cookie` and a
  strong `ETag`. This extends the profile-media relief exception in
  [closed-beta access](../production/closed-beta-access-v1.md#where-it-is-enforced),
  which now states that a stable rendition URL's bytes change with the recipe
  version. Owner-only reads (a replaced avatar, a cleared cover) and every error
  keep `private, no-store`.
- **`AuthorMedia` pin (entry 14).** The contract test's exact key-set pin for
  `AuthorMedia` moves to `height`, `id`, `renditions`, `src`, `width`. The
  required keys stay `id`, `src`, `width` and `height`; a legacy object without
  `renditions` still parses, an `https` `src` is still refused, and the JSON
  Schema property list gains `renditions` only. Recorded so that the pin change
  is not read as weakening a test to pass CI.
- **Owner visual gate (entry 16).** 3a is user-visible. The Owner's visual and
  real-device acceptance on a combined Development preview of the exact reviewed
  head comes before the PR is Ready. Emission switch-on additionally needs at
  least 72 h live, at least 95% backfill with every failure explained, and
  real-device checks on WeChat iOS, WeChat Android and one mobile browser.
  Development defaults both switches on; Production defaults both off.

## Avatar change limit removed

Owner request, 2026-10-13: remove the limit of one avatar change per New York
calendar day, with no replacement rate limit. It ships in the 3a release under
the same tag and needs no switch.

- Every successful change applies at once and records its own `avatar.update`
  event. A replayed request id returns the stored reply. Concurrent saves from
  two devices both commit in order, and the profile shows the last; `409`
  remains only for request-identity or version conflicts, and its message no
  longer mentions the daily limit.
- The contract key set is unchanged so that strictly parsing old pages keep
  working: `nextAvatarChangeAt` is always `null`, and `nextChangeAt` is the time
  of the change. `avatar_changed_on` is still written, with no migration, so a
  code rollback re-imposes the previous rule from consistent data.
- The avatar editor shows no daily note and no limited state. The OpenAPI `409`
  description no longer mentions an avatar date. The New York daylight-saving
  test is removed, and the concurrent-save test expects two successes.
- This supersedes the accepted Phase 4 rows (one dated note in
  [phase4-author-community-v1](../community/phase4-author-community-v1.md); the
  accepted rows stay as history) and the avatar-rule sentence in
  [project status](../project-status.md).
- Risk noted, not mitigated by this task: uploads have no rate limit. Each
  avatar change keeps its source row and, once rendered, roughly 35–70 KB of
  owner-only renditions. Sweep pacing bounds the rendering load.

## Scope records

- **Root configuration (`turbo.json`).** Only the two keys
  `MEDIA_PROFILE_RENDER` and `MEDIA_PROFILE_RENDITIONS` are added to the
  Development Backend task's `passThroughEnv`, so Development can exercise the
  switch-off path. This is the same kind of record as Issue #206 r5 and r17.
- **Scope note 1 to r1: migration-list pins.** The new migration adds one entry
  to four existing tests that pin the exact list of applied community
  migrations: `tests/unit/backend/community-migrations.test.ts`,
  `tests/integration/postgres/login-identity-rotation.test.ts`,
  `tests/integration/postgres/article-connection-migration.test.ts` and
  `tests/integration/postgres/work-publishing-upgrade.test.ts` (three lists).
  They were added to the approved scope for that one-line append only; no other
  line in them changes.
- **Scope note 2 to r1: workspace scanner.** The new Web route imports the
  profile rendition relay from the Web Public API server module. The
  architecture guard allows that import only for the files listed in
  `tests/unit/architecture/workspace-scanner.ts`, which gains one entry for this
  route in the form of the existing relay routes, and nothing else.
- **Colocated test of `discussion-avatars.ts`.** No separate test file exists
  for `apps/web/features/authors/discussion-avatars.ts`, so its new case went
  into `apps/web/features/authors/discussion-section.test.tsx`, the colocated
  test that exercises it through `DiscussionSection`. That file was changed
  under the "colocated tests" clause of the approved scope.
- **Colocated test of the avatar save flow.**
  `apps/web/features/authors/avatar-session.test.tsx` exercises the in-scope
  `avatar-save.ts`, `author-context.tsx` and `avatar-editor.tsx` together; it
  was changed under the same "colocated tests" clause.
- **Write path.** The `updateAvatar` change for the avatar limit is the only
  Backend write-path change, and it is Owner-requested.
- **Role lists.** `@moya/backend-production` does not depend on
  `@moya/contracts`, so its recipe registry keeps its own profile role list; a
  unit test reconciles the contracts, registry and community store lists.

## Accepted limitations and risks

- **Anchor-only identity.** The sweep and the job plan look only at each
  family's anchor (`avatar-128`, `background-960`), and count it as ready at the
  current recipe version or a later one, whatever its digest; this matches the
  recording rule, which replaces a ready rendition only with a higher version. A
  lost non-anchor blob is not rendered again while the anchor stands, and a
  recipe version change of `avatar-512` or `background-1600` alone needs an
  anchor version change or an extension of the sweep.
- **Old pages after switch-on.** Pages parse profiles strictly. A page loaded
  before the 3a release that receives `renditions` fails to read profiles (for
  example, feed post headers without names) until it is reloaded. The ≥ 72 h
  wait, a reload and switching emission off address it, and Web is never rolled
  back below the 3a release while emission is on.
- **Blocked-accounts list.** It emits no renditions; those URLs would answer
  `404`, as the original `src` does.
- **Development default.** After the merge, every Development and preview stack
  with `WORK_MEDIA_*` set renders profile images by default.
- **Upload volume.** See the avatar-limit risk note above.

## Non-goals

- Edge or CDN publication of profile media: no publication table, eligibility or
  trigger change, and no published URL is emitted.
- Increment 3b: direct upload, moving existing `user_media` bytes out of
  PostgreSQL and the `user_media` retention follow-up.
- Unedited legacy Phase 4 work PNGs.
- Changes to the client avatar and cover export, the Next.js image optimizer,
  Nginx, dependencies or the lockfile, and `PRODUCT_ACCESS_MODE`.
- A placeholder colour for profile images, and any new avatar or upload rate
  limit.
- Schema changes to `user_media`, `public_users` or the publication tables; the
  `avatar_changed_on` column stays.
- Apple and HarmonyOS, and account deletion (only the release primitive it will
  need is added).

## Delivery and validation

- **One Draft PR**, one commit per slice: avatar-limit removal; contracts;
  recipe registry and sandbox; migration, job kind (with the Admin label) and
  store record shape; ports, profile assets and erasure; DTO emission; worker,
  sweep and switches; Backend read route; OpenAPI; Web; infrastructure templates
  and `turbo.json`; docs; end-to-end tests.
- **Gate.** The PR stays Draft until the Owner's visual and real-device
  acceptance of a combined Development preview at the exact reviewed head. An
  independent session reviews the actual diff at that head. After the gate the
  reviewer marks it Ready and performs an expected-head squash merge and
  merged-head verification, just before the scheduled release window, so `main`
  does not hold an unreleased migration and contract change.
- **Validation.** The default task verification at the final head, required CI
  including PostgreSQL 16 and 18, and the independent exact-head review.
  Validation output and review evidence stay in private task records; acceptance
  records are content-free.
- **Production.** The tag, the GitHub Release, the release window, the backfill
  and the emission switch-on are each a separate Owner-run operation, as is
  every Production read or probe (see the
  [release runbook](../deployment/media-profile-renditions-inc3a.md)). Review
  never grants Production authority, and this record claims no deployment or
  acceptance.
