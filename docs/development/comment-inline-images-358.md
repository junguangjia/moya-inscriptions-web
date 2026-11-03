# Comment inline images — Issue #358 r3

## Owner direction and scope

Owner release direction (2026-11-03 UTC, r3): after reporting the supplied R2
computer/LAN previews passed, the Owner requested "推进上线". This supersedes
the earlier Draft-only stop. Finish accepted source delivery, independent
review, current cumulative CI, merge and merged-head verification; then prepare
and activate an immutable tagged release on the existing Production services
under the established backup, migration, native approval, smoke and recovery
gates. This does not authorize unrelated data changes, new resources, credential
or permission changes, destructive cleanup, or bypassing required checks.
Preview services stay closed; only validation environments needed for release
may run.

Owner visual correction (2026-11-03, r2): align each avatar with its rendered
first nickname column when inline pictures widen that column, and restore the
original report flag in QA with local simulated feedback. Reuse the live flag
presentation; do not submit QA reports or change live permissions. All other
requirements stayed unchanged at that revision; the R3 release direction above
now governs delivery.

The Owner selected option A on 2026-11-02: use the Figma exploration as a
reference and implement a more complete real feature. Images remain inline at
the selected start, middle or end position in comments and replies. The Figma
sample content and its simulated layout are not production data or code.

Reference:
[mobile home calligraphy exploration](https://www.figma.com/design/PKhG0jrFs2xCbHb8Ri5kW9?node-id=424-492).

This task implements that direction in the existing Web comment/discussion
composition, shared contracts, Backend services, community PostgreSQL adapter
and media pipeline. The narrow additive contract and migration work is required
to persist and authorize the requested attachments; it does not introduce a
second comment system or editable content master. The historical Community V1
and content-track deferral of comment images is superseded for #358 only by the
Owner's current implementation instruction.

Allowed supporting paths: `apps/web/features/authors`, the existing
`scripts/verification-tool-inputs.test.mjs` platform regression (accept either
explicit refusal when Ubuntu 26 native helpers resolve outside the trusted
paths; preserve all production verification and trust rules),
`apps/web/features/comments`, the existing report-flag presentation and its
tests, the existing publishing integration helpers, the existing
`use-preview-navigation-history` helper and its regression tests, the optional
QA Home composition seams in `features/qa`, `features/home` and
`features/product-preview` (the new renderer is supplied only by the explicit
inline-image QA scenario; Formal/default Home behavior is unchanged),
`apps/web/lib/public-api`, the corresponding same-origin Web routes,
`packages/contracts`, `services/api/src/modules/community`,
`services/backend-runtime/src/community`, `services/community-postgres/src`, the
existing Backend runtime index and Admin package export table (narrow
handler/component entry points used by tests, without dependency changes), the
existing Backend comment HTTP handlers and their JSON response boundary,
`services/public-api`, `database/community-migrations`, the existing runtime
grant files, the existing Admin moderation preview and its client boundary,
affected architecture, contract, unit, PostgreSQL and browser tests, and this
task record. Shared semantic visual additions, if needed, belong in
`packages/design-tokens`.

Non-goals: option B, stickers, video/Live Photo comments, new decoders or
dependencies, general rich-text authoring, editing an already submitted comment,
a new moderation system, new cloud services, or unrelated Production data,
credential and permission changes. Existing text-only comments, mentions,
ordering, publication modes, author identity, delete/report/like behavior,
viewer/navigation ownership and real/QA isolation remain intact.

## Initial bounded policy

- At most six static images per comment or reply, each at most 10 MiB, enforced
  in the shared contract and server. This uses the existing bounded temporary
  upload model; it is an initial adjustable product limit, not a Figma-implied
  restriction.
- Image positions use offsets into the canonical normalized plain-text body,
  measured in UTF-16 code units, with no split surrogate pair. Draft edits, CRLF
  normalization and trimming must preserve placement and mentions.
- Text remains bounded at the existing 1,000-character limit. An empty body is
  valid only when at least one validated ready image is submitted; no invented
  placeholder text is stored.
- Images use the existing processing/transfer/session/quota machinery with a
  distinct `comment` upload purpose. Submission atomically validates ownership,
  readiness, purpose and target permissions, and pins durable references before
  temporary upload cleanup can run.
- Repeated transport attempts for one unchanged submission use one stable
  request identity. Reusing it for different content is a conflict.
- Reads remain comment-authorized and non-cacheable, including pending own
  previews and Operator review. Hiding/deleting a body or thread, blocking and
  withdrawing/private target content revoke ordinary/public and owner publishing
  preview access accordingly. The existing authenticated Operator boundary may
  review retained hidden/removed/private-target attachments when the associated
  text remains reviewable; irreversible body deletion still denies image bytes.

## Frozen behavior matrix

| Scenario                                       | Development                                                             | Production code behavior when deployed                       | Must preserve                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Read existing text-only entries                | Real data plus clearly separate synthetic QA                            | Real runtime data only                                       | Text, mentions, ordering and reply identity                                        |
| Insert images at start/middle/end              | Actual upload plus deterministic QA coverage                            | Authenticated upload through existing media pipeline         | Plain text is preserved; chosen positions survive edits and normalization          |
| Main comment, reply and image-only body        | Validated ready static attachments, six-image bound                     | Same server validation and publication policy                | Existing target, root, account and moderation permissions                          |
| Upload in progress, rejection, retry, removal  | Clear per-item state; text and successful items remain                  | Same truthful state; no premature success                    | Current single text field and send placement, account isolation                    |
| Submission failure or ambiguous response       | Draft remains; unchanged retry is idempotent                            | Same behavior                                                | No duplicate comment or accidental loss of uploaded images                         |
| Home calligraphy, detail and standard comments | Inline images in existing vertical/horizontal composition               | Same rendering of authorized returned data                   | Reading direction, nickname/body flow, reply indentation, fold and scroll behavior |
| Open an image and close viewer                 | Existing viewer with current-entry image sequence                       | Same behavior                                                | Image click is independent of body reply; focus and reading position return        |
| Hidden/deleted/pending/private content         | Exercise actual visibility rules on disposable test data                | Recheck the existing comment/target visibility on every read | No public bypass through a media item URL                                          |
| Operator review                                | Images are visible through the existing authorized moderation workspace | Same operator-only access                                    | No public-user/Operator identity mixing                                            |

## Delivery and validation

The public `x-yoyi-comment-images: 1` representation marker selects canonical
comment-image JSON. Current Web browser clients, trusted SSR and the Owner
server request it; same-origin browser boundaries preserve the requesting
browser's marker. Already-open older pages receive their strict legacy shape,
including omission of empty `images` arrays. Image-only entries use an explicit
refresh hint for legacy display only; canonical text remains empty in storage
and version-1 responses. Nonempty text, mentions, ordering and counts remain
unchanged. This marker grants no authority and changes neither accepted inputs
nor image-byte authorization. Comment JSON stays private and uncached, with the
representation marker included in `Vary`.

One integration worktree has the integration writer. Parallel implementation
uses separate worktrees and bounded file ownership; patches are integrated only
after the producing writer stops. Normal independent code review is required.

Use the repository task-resource and verification entries on task-owned
disposable resources. Cover contracts/offsets, session and image ownership,
atomic durable pins, visibility and moderation, request retries, frontend
failure recovery, viewer behavior and mobile/desktop rendering. Run applicable
lint, typecheck, relevant tests and builds; bind evidence to the actual
candidate.

The Owner reported the supplied R2 previews passed; retain that presentation
acceptance only when the reviewed final integration preserves its behavior and
dependencies. Complete source delivery now requires an independent exact-head
review, current cumulative CI, reviewer-managed Ready/merge and merged-head
verification. Production delivery then uses an approved annotated tag on that
verified main commit and the established concrete native approval gate.

Before activation, refresh actual service/configuration/release identities,
freeze immutable artifacts and the target role changes, verify a database
backup, and apply only required forward migrations with the existing distinct
authority. Verify process/readiness, asset bindings and real authorized media
behavior after activation. Preserve required data and unrelated services. An old
Backend lacking comment-reference and private-media protections is not a safe
rollback after new comment-purpose data exists; the concrete recovery plan must
retain those protections or refuse that rollback. Do not mark the release
complete from a successful build, CI or health code alone.
