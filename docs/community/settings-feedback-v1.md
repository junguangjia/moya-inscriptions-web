# Settings feedback v1 — Issue #329

Task: `settings-feedback-v1` r2. Owner-approved scope: authenticated feedback
with optional still images, real Community persistence and read-only Owner Admin
review. Delivery stops at an independently reviewed Draft PR and Development
preview, pending Owner visual and physical-phone acceptance. No Production
deployment or activation.

## Behavior Matrix

| Scenario                | Development                                                  | Production after separate release | Must preserve                                         |
| ----------------------- | ------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------- |
| Guest opens feedback    | Visible Settings entry, sign-in required                     | Same                              | Existing login return and navigation                  |
| Valid message           | Synthetic account submits to disposable PostgreSQL           | Real account feedback saved       | Confirm success only after commit                     |
| Failure or repeat click | Retain draft, retry same submission key; one in-flight write | Same                              | No accidental duplicate records                       |
| Return and close        | Child Back retains draft; root exit confirms discard         | Same                              | Settings focus, motion, swipe, scroll, reduced motion |
| Account changes         | Clear draft; abort and ignore stale request results          | Same                              | No cross-account state or authority                   |
| Owner review            | Paginated read-only existing Admin view                      | Same                              | No public or automation access                        |

## Interfaces and persistence

`POST /v1/community/feedback`, reached through the existing same-origin Web
relay, accepts `{ submissionId, message, imageIds? }` under the current Backend
session and expected account. The UUID identifies one submission; the message is
trimmed and must contain 1–5000 UTF-16 code units. The response contains only
`{ id, createdAt }`. The database transaction commits before success. Optional
image ids are ordered and unique, and participate in the idempotency comparison.
Reusing the same user/key/body returns the original receipt; a changed body
under the same user/key conflicts. Another user has a separate key namespace.

`GET /internal/community/feedback?page&pageSize` uses the existing operator
credential boundary. Admin checks the Payload Owner role before relaying the
validated query; the Backend returns a bounded page ordered by creation time and
feedback id descending, with full message, user id/display name and timestamp.
The Admin route is `/admin/community-moderation/feedback`.

The append-only `community.feedback` table and its image associations have no
public projection. Runtime receives SELECT/INSERT only; public-read and Payload
database roles receive no feedback grant. No message content or credential is
logged. Schema installation uses the normal Community migration command; startup
never creates tables. Existing databases require the new migration and runtime
grant before releasing this feature.

Drafts live in the current Settings component only. Child Back retains them;
closing discards them after the existing dirty-exit guard. Logout/account change
clears them. No localStorage or server-side draft persistence is added.

## Boundaries and acceptance

No category, non-image attachment, status workflow, reply, user history or email
delivery. Reports, rights-holder complaints and appeals stay in #326. No
dependency upgrades or authentication changes.

Focused tests cover validation, confirmed success, errors/retries, concurrent
submissions, idempotency conflicts, real App-role persistence, access denial,
Admin pagination and account isolation. The task uses cumulative `verify-task`
checks and exact-candidate independent review. Browser evidence uses synthetic
data only. Emulated desktop/mobile review is separate from Owner
visual/physical-phone acceptance, which remains pending until recorded.

## Owner change r2: optional private images

The Owner requested image uploads on 2026-10-24. This supersedes only r1's
exclusion of attachments for the still-image capability below; every other
boundary remains.

- Message remains required; up to three optional still images, each
  selected/uploaded image at most 10 MiB. Use the existing JPEG/PNG/WebP and
  HEIC/HEIF path; unsupported browser conversion has a clear error. No video,
  GIF, SVG, PDF or other file attachments.
- Reuse the current media upload, bounded preprocessing, sandbox worker and
  private storage. A temporary publishing lease creates no Work. Do not extract
  EXIF/GPS into feedback metadata, and expose server-rendered WebP derivatives
  only.
- Images have immutable feedback purpose, isolated from Work/Article media
  choosers, attachment and publication paths. Existing items default to content
  purpose and keep their existing behavior.
- Save the ordered image references and durable retention pins atomically with
  feedback. Idempotency covers message and ordered image ids; confirmed retry
  returns the original receipt.
- Owner and authorized Owner Admin can read the private images; original/master
  bytes, storage keys and public CDN URLs are never exposed.

| Scenario               | Development                                                                      | Production after separate release | Must preserve                                       |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------- |
| Pick/remove images     | Synthetic screenshots show bounded previews; remove individual selections        | Same interaction                  | Text draft, order and settings navigation           |
| Upload/process failure | Keep files/text and allow retry or removal; no simulated success                 | Same                              | Submit waits for every retained image to be ready   |
| Feedback save/retry    | Atomically retain images before confirming; retry keeps one feedback row         | Same                              | User/key idempotency includes image list            |
| Close/account change   | Guard unsaved images; abandon temporary lease on explicit discard/account change | Same                              | No stale/cross-account response or permanent orphan |
| Admin image review     | Owner-authorized thumbnails and larger rendered images                           | Same                              | No public, automation, original or master access    |

The supporting scope includes shared media-purpose contracts/schema, narrow
Work/Article consumption guards, feedback retention/read routes, existing
pipeline composition and affected regression tests. No new provider, upload
framework, dependency upgrade or Production activation is authorized. r1
evidence remains evidence for its unchanged content only; r2 needs fresh
validation, exact-head CI, independent review and Owner visual/physical-phone
acceptance.

Feedback images use existing account byte capacity and temporary leases;
Work-specific item-count limits do not apply. Common content images retain
existing behavior. The new migration is `20261024030000_feedback_images.sql`.

## Delivery compatibility note

The Owner approved synchronizing the task branch scanner with the verified
installed 21-line compatibility fix after `SCANNER_VERSION_MISMATCH` prevented
the task Git helper from committing. This supporting scope adds only
`scripts/confidentiality-scan.mjs`; installed hooks, anonymous identity and Git
configuration remain unchanged. Existing scanner/helper regression checks
validate the alignment before delivery.
