# Settings feedback v1 — Issue #329

Task: `settings-feedback-v1` r1. Owner-approved scope: authenticated plain-text
feedback, real Community persistence and read-only Owner Admin review. Delivery
stops at an independently reviewed Draft PR and Development preview, pending
Owner visual and physical-phone acceptance. No Production deployment or
activation.

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
relay, accepts `{ submissionId, message }` under the current Backend session and
expected account. The UUID identifies one submission; the message is trimmed and
must contain 1–5000 UTF-16 code units. The response contains only
`{ id, createdAt }`. The database transaction commits before success. Reusing
the same user/key/body returns the original receipt; a changed body under the
same user/key conflicts. Another user has a separate key namespace.

`GET /internal/community/feedback?page&pageSize` uses the existing operator
credential boundary. Admin checks the Payload Owner role before relaying the
validated query; the Backend returns a bounded page ordered by creation time and
feedback id descending, with full message, user id/display name and timestamp.
The Admin route is `/admin/community-moderation/feedback`.

The append-only `community.feedback` table has no public projection. Runtime
receives SELECT/INSERT only; public-read and Payload database roles receive no
feedback grant. No message content or credential is logged. Schema installation
uses the normal Community migration command; startup never creates tables.
Existing databases require the new migration and runtime grant before releasing
this feature.

Drafts live in the current Settings component only. Child Back retains them;
closing discards them after the existing dirty-exit guard. Logout/account change
clears them. No localStorage or server-side draft persistence is added.

## Boundaries and acceptance

No category, attachment, status workflow, reply, user history or email delivery.
Reports, rights-holder complaints and appeals stay in #326. No dependency
upgrades or authentication changes.

Focused tests cover validation, confirmed success, errors/retries, concurrent
submissions, idempotency conflicts, real App-role persistence, access denial,
Admin pagination and account isolation. The task uses cumulative `verify-task`
checks and exact-candidate independent review. Browser evidence uses synthetic
data only. Emulated desktop/mobile review is separate from Owner
visual/physical-phone acceptance, which remains pending until recorded.
