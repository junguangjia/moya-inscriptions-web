# Account deletion v1 — Issue #351

Task: `account-deletion-v1` r3. A signed-in public user permanently ends their
own account from Web settings. Owner decisions (2026-10-27): deletion takes
effect immediately with no cooling-off period and no undo; comments and replies
keep their text with the author shown as 已注销用户; direct-message history
stays with the counterpart; phone and email are freed at deletion; the handle
stays reserved; invitation quota is not refunded. r3: the blocks the account set
are removed, while blocks other users set against it stay in force (its retained
comments stay hidden from them) and it no longer appears in
their 已屏蔽账户 lists. Delivery stops at an independently reviewed Draft PR
pending Owner physical-phone acceptance. No Production deployment, migration or
grant change is part of this task.

## Behavior Matrix

| Scenario                                 | Development                                              | Production                               | Must preserve                        |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| Entry                                    | 注销账号 at the end of 账号与安全 for signed-in accounts | Same, phone layout only                  | Existing settings pages and sign-out |
| Not eligible (no usable phone or email)  | Explains why; no request sent                            | Same                                     | Account unchanged                    |
| Re-verification fails, expires or cancel | Nothing changes; can retry                               | Same (real SMS/email)                    | Rate limits and lockouts             |
| Unfinished uploads or unsaved edits      | Warned before confirming; can cancel                     | Same                                     | Local recovery behavior              |
| Confirmed deletion                       | Immediate; all sessions revoked; 账号已注销              | Same                                     | Other accounts unaffected            |
| Retry, double submit, interruption       | Same result once; an interrupted request changes nothing | Same                                     | No partial state                     |
| Another device or tab of the account     | Next request is signed out                               | Same                                     | No 500s                              |
| Sign in or appeal as the deleted account | Phone/email unregistered; no appeal                      | Same                                     | Other accounts' sign-in and appeals  |
| Re-register with the same phone or email | New unrelated account                                    | Same; invitation required in invite-only | Invitation quota not refunded        |
| Others viewing the user's content        | Works gone; comments show 已注销用户; DM history kept    | Same                                     | Others' replies, threads, counts     |
| Admin                                    | 已注销 shown; no reinstate, suspend or recommend         | Same                                     | Moderation of other accounts         |

## Interface

`POST /v1/community/auth/account/deletion`, reached through the existing
same-origin auth relay (`/api/community/auth/account/deletion`), with a Bearer
session, the header `x-author-account` naming the confirmed account, and
`{ reauthToken, idempotencyKey }`. The re-verification token comes from the
existing `reauthenticate` challenge (single use, bound to the session, ten
minutes). Success answers `200 { outcome: "deleted", deletedAt }`,
`private, no-store`; the relay then clears `yoyi-session` and
`yoyi-appeal-session`. A 200 whose body the relay cannot use (cut off, not JSON,
outside the contract) answers 502 and keeps both cookies, so the page's same-key
retry still presents the revoked session and reaches the replay. Failures reuse
existing reasons: `AUTH_UNAUTHENTICATED` (401: missing or foreign account,
invalid session, a retry with another key or session), `AUTH_ACCOUNT_SUSPENDED`
(401), `AUTH_PROOF_REJECTED` (422), `AUTH_CHANNEL_UNAVAILABLE` (503,
password-only profile). An exact retry with the same key and the same, now
revoked, session answers the original success. In a closed beta the operation is
open in the product-access gate, like sign-out, so that retry still reaches its
replay check; the first request still needs a live session.

The Web page keeps the idempotency key until a definitive answer. It
says 账号没有被注销 only for a refusal that proves the account is still live:
the final request's `AUTH_PROOF_REJECTED`, which the Backend sends only after
finding, under the account's lock, no deletion and an active account. Every
other refusal is worded without that claim, because another page or device may
have deleted the account meanwhile (which also revokes this session and removes
this proof): `AUTH_UNAUTHENTICATED`, the code step's `AUTH_PROOF_REJECTED`, a
rate limit ("这次请求没有处理") and unknown refusals. After an unanswered
attempt, a following 401 (the session cookie is gone or was replaced) is shown
as "may already be deleted", and this browser forgets the account's local data
as after a confirmed deletion; any other refusal that proves nothing keeps the
key and the retry. While an attempt is unconfirmed, 取消, the dialog's Back,
Escape, a swipe or a browser/phone Back first ask inline (an `alertdialog`, as
the drafts confirmations) whether to leave: the deletion may already have
happened and leaving keeps this device's data of the account; 留下重试 is the
default, 仍然离开 leaves; a reload or closed tab gets the browser's leave
prompt. From the first final request until the page is left, the author provider
defers its session rechecks (focus, other tabs, retry timers) and its `revision`
changes (so neither the open profile nor the provider rereads with that session;
a failed profile reread would re-key the settings, and with them this page, to a
guest), and a pending avatar save starts nothing and stops before its next
request. A revoked-session answer therefore neither tears down the page and
its 账号已注销 result nor clears the cookie the retry needs. Requests the hold
does not cover can still meet the revoked session and clear the cookie: an
avatar request already in flight when the hold starts, and foreground polls (the
DM unread badge every ten seconds and on focus, upload readiness). A retry after
that gets a 401 and is handled as above (non-definitive copy, local cleanup), so
the definitive 账号已注销 replay is reliable only for a prompt retry. On success
the tab first stops the account's composer persistence, uploads, autosave and
publication, then clears its local data, so nothing writes that data back, and
then writes the deletion ping `yoyi-account-deleted` (`{ accountId, at }`, no
credential) to `localStorage` and removes it at once (the write alone reaches
the other tabs); the same happens on the unconfirmed-then-401 path. Every other
tab of the browser ends that account's editing, clears the same local data and,
rechecking on that storage event, falls back to signed out.

## Transaction

One authentication transaction under the user lock: verify the session and the
confirmed account, check the receipt, validate and consume the re-verification
handoff, invalidate password-reset proofs, challenges and handoffs, revoke every
session (community and appeal scope), close auth receipts, then `eraseAccount`:

- status becomes `deleted` (terminal in the database: only `active → deleted` is
  allowed and nothing leaves `deleted`, so Admin reinstate and report
  suspend/restore can never revive it);
- display name 已注销用户; bio, studio name, avatar and background cleared;
  privacy flags private; the handle stays and is never reused;
- the account's auth challenges and handoffs, including other rows that hold the
  digest of a contact bound at deletion, are deleted; login identities (freed
  for registration) and the password credential are deleted;
- follows in both directions, the blocks the account set, likes, favorites,
  comment likes and the profile IP location are deleted; a featured entry is
  disabled. Blocks other users set against the account stay (r3): its retained
  comments and replies stay hidden from them and out of their discussion counts
  (`accounts_can_interact`), and their 已屏蔽账户 list and its total no longer
  show it (a suspended account is still listed);
- one `community.account_deletions` record, a publication withdrawal request
  (public CDN copies go through the publication worker) and one
  `purge_deleted_account` publishing job are written.

## Background purge

The `purge_deleted_account` job (media worker in Production, the embedded worker
in Development) runs bounded batches under the deleted owner's lock and resumes
after any interruption. It erases every work (live, trashed or trash-purged)
with the same code as an author's permanent delete, ends publishing sessions,
deletes drafts, conflict copies and snapshots, ends article drafts and empties
their title, document and cover (also of drafts the author had already deleted,
which kept them; the migration lets the draft-terminal trigger admit exactly
that erasure, only for an owner whose account is `deleted`), cancels
unreferenced media (the existing `purge_item`/`purge_blob` jobs delete private
objects), tombstones every legacy, avatar and background image with its profile
renditions, and scrubs author command receipt payloads. It then marks the record
`completed`. A job that fails five real attempts stops in `failed` like other
purge jobs and is retried by an operator.

## Retained data and known limitations

- Comments and replies keep their text (decision); the public comment author
  carries `deleted: true` and Web shows 已注销用户 without a profile link.
- Direct messages keep their text for the counterpart (decision); the
  conversation is unavailable for new messages.
- Feedback and its images, reports, appeals, evidence, moderation and audit rows
  stay under their existing rules (reports and appeals three years after
  closure, sensitive attachments 180 days, legal hold).
- Submitted and published article revisions (`community.article_revisions`) stay
  in the database: they are immutable snapshots, hidden because the owner is no
  longer active. Erasing them needs a separate decision and migration. Article
  drafts do not keep their text: the purge ends each live one with the author's
  draft-deletion semantics and, in the same update, empties its title, document
  and cover (owner unchanged, one version step, the empty draft's fingerprint).
  An author's own draft deletion is unchanged and keeps the stored content until
  the account is deleted; the purge then empties those drafts in a separate
  update (deletion time, owner and status unchanged, one version step). The
  draft-terminal trigger still refuses every other change of a deleted draft.
- Blocks other users set against the deleted account stay in force (r3), so its
  retained comments and replies stay hidden from them; those blocks are no
  longer listed in their 已屏蔽账户 and cannot be lifted there.
- Challenge and handoff rows created without a user id (sign-in, registration,
  `register_confirm`) for a contact that was unlinked or replaced before the
  deletion, or that carry a digest from an earlier lookup-key version, are not
  matched by `eraseAccount`, which deletes only rows of the account and of the
  contacts bound at deletion. They keep their encrypted contact, are not
  associated with the account and are not deleted by 注销; cleaning them up
  needs a separate retention task. The privacy policy's 保留 list states both
  cases (contacts unlinked or replaced before deletion, and records written
  before a key change, including those of contacts still bound at deletion).
- Product analytics (180 days by default, IP observations seven days), Umami
  (180 days) and backups age out on their own schedules; nothing is purged
  early.
- Rate-limit counters keyed by a contact digest (15-minute window) are not
  cleared; email and SMS provider logs (Tencent SES, Aliyun) are outside the
  repository's control.
- The privacy policy in `apps/web/app/policies/content.ts` describes the above.
  The Production registration agreement is a private server file and must be
  updated by the Owner outside the repository.

## Release notes

Release order: apply migration `20261027010000_account_deletion.sql`, re-apply
`infra/development/work-publishing/grant-runtime.sql` to the runtime role (new
DELETE on `user_password_credentials`, `auth_challenges`, `auth_handoffs`,
`profile_ip_locations`; SELECT, INSERT and UPDATE(purge_state,
purge_completed_at) on `account_deletions`; still no DELETE on `public_users`),
then start the new Backend, media worker, Web and Admin builds together: the
Admin contracts and Backend status mappers must both understand `deleted`.
