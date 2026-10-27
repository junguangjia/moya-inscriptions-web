# Account switching v1 — Issue #352

Task: `account-switching-v1` r2. One browser holds up to three signed-in
accounts and switches between them from settings. Owner decisions (2026-10-27):
at most three accounts including the current one; signing out of the current
account returns to the signed-out state and keeps the other added accounts in
the list. Web only: no Backend session model change, no migration, no change to
session lifetime. Delivery stops at an independently reviewed Draft PR pending
Owner physical-phone acceptance. No Production deployment.

## Behavior Matrix

| Scenario                         | Development                                        | Production         | Must preserve                                  |
| -------------------------------- | -------------------------------------------------- | ------------------ | ---------------------------------------------- |
| Single account (no others added) | Unchanged                                          | Unchanged          | Existing sign-in and sign-out                  |
| Add account                      | 添加账号 → sign-in (Development accounts too)      | Same, phone layout | Sign-in/registration rules, invitation, access |
| Fourth account                   | Refused before sign-in                             | Same               | Existing accounts kept                         |
| Switch                           | Guard → swap → full reload as the new account      | Same               | Upload and recovery isolation                  |
| Expired/revoked/deleted account  | 需重新登录                                         | Same               | No false success                               |
| Sign out current                 | Signed out; others stay listed                     | Same               | Server revoke of the current account only      |
| Remove / sign out all            | Server revoke, then removed                        | Same               | Other devices unaffected                       |
| Other tab after a switch         | Refreshes to the new account; stale writes refused | Same               | No cross-account write                         |
| PC / wide screen                 | Browse-only (no sign-in)                           | Same               | pc-browse-only-v1                              |
| Appeal login failure             | Ordinary session kept                              | Same               | Appeal flow                                    |

## Session storage

The current account stays in the existing `yoyi-session` cookie, so every
existing reader is unchanged. At most two other accounts live in one new
HttpOnly cookie, `yoyi-saved-sessions` (same attributes: host-only, `Path=/`,
`SameSite=Lax`, `Secure` on https). Each entry holds the user id, handle, opaque
session token and an expiry ceiling; the parser fails closed and clears the
cookie on anything malformed or repeated. Tokens never reach browser JavaScript
or a response body. Each session keeps its own absolute seven-day Backend
lifetime; switching never extends it. An entry past its ceiling has certainly
lapsed; the cookie outlives its latest entry by seven days so such an entry is
still reported as 需重新登录 instead of disappearing.

## Routes

- `GET /api/community/accounts` lists the current account and the others. Every
  held token is checked with `/v1/me`; a refused or lapsed saved entry is
  reported once as `reauth_required` and dropped. A saved copy of the current
  account is never listed: it is signed out (best effort) and dropped.
- `POST /api/community/accounts/switch { accountId }` swaps the current and the
  saved session after `/v1/me` confirms the target; a refused or lapsed target
  answers 409 `reauth_required` and changes nothing else.
- `POST /api/community/auth/accounts/remove { accountId }` and
  `POST /api/community/auth/accounts/sign-out-all` revoke on the Backend. They
  sit under the existing auth relay because Production nginx gives the trusted
  auth-ingress proof that Backend sign-out requires only to
  `/api/community/auth/`. When sign-out-all cannot confirm every sign-out it
  answers 503
  `{ reason: "unavailable", currentCleared, remaining: [{ id, handle }] }`:
  whether this browser still has a current session, and which other accounts are
  still held (never a session). If the current session was cleared, the page
  reloads as signed out and the next load shows a one-shot notice (carried in
  `sessionStorage`, shown through the AuthorProvider notice) naming the accounts
  left to sign out from 设置 → 切换账号. Otherwise the page stays with the error
  and lists what is still held. Only an unanswered request makes the page read
  the list again.
- Add-account mode: the sign-in flow opened with `?intent=add-account` sends
  `x-yoyi-account-intent: add`. The relay then never forwards the current
  session on sign-in or registration steps (the new account's challenge cannot
  record the old account), refuses a fourth account before calling the Backend
  (`AUTH_ACCOUNT_LIMIT`), and on success moves the previous account into the
  saved list. Re-adding a listed account replaces its stored session. Without
  the header, sign-in behaves as before, except that an older saved session of
  the account signing in is signed out and dropped in the same answer, so a
  later 退出登录 leaves nothing of that account switchable.
- The browser runs every request that rewrites these cookies (list, switch,
  remove, sign out all, the add-account steps and an ordinary sign-in) under one
  exclusive Web Lock across its tabs, so two answers never write cookies from
  different snapshots; without Web Locks the request runs directly.

All answers are `private, no-store` with `Vary: Cookie`; writes require the
same-origin checks of the author relay.

## Isolation and fences

- A switch or sign-out-all first checks unfinished work (composer uploads and
  unsaved edits, a pending avatar save, report-evidence uploads in flight,
  unsaved settings or feedback) and runs the existing `useBeforeAuth` pipeline
  so the editor saves local recovery; the reader can cancel. Success writes the
  `yoyi-community-session-change` localStorage ping and reloads the whole
  document. Other tabs refresh their identity on that ping and show which
  account is now current.
- Writes and private reads are bound to the account the UI shows: catalog
  comment and reply POSTs now have the same-origin check and forward
  `x-author-account`, which the Backend refuses when it differs from the
  session; direct-message reads carry the assertion and the author handler
  refuses a mismatch on reads as on writes; auth sign-out with a mismatched
  assertion answers 409 `AUTH_ACCOUNT_MISMATCH` and keeps the session, and the
  relay clears the cookie only on success or a refused session.
- Fixed: a 401 on an `appeals/*` auth call no longer clears the ordinary
  `yoyi-session`.
- A deleted or suspended account's stored session is refused by `/v1/me` and
  shown as 需重新登录 (#351).

## Known limitations

- On wide screens 添加账号 and 重新登录 open `/login`, which pc-browse-only-v1
  sends back to Home in public mode.
- Article editor uploads are not visible to the settings guard: they live in the
  article editor's own upload session, which exposes no in-flight signal. The
  editor's leave prompt covers unsaved edits and a pending publication.
- The account routes carry no trusted authentication source in Production, so
  their best-effort sign-out of a saved copy of the current account is refused
  there and that session lapses at its own expiry. The auth relay (ordinary and
  add-account sign-in) signs such copies out for real.
- The legacy `LiveCommentSection` (used only when Author Community is off) binds
  comment writes to the account its transport last confirmed, not to its own
  section.
- The analytics visitor id is per browser, so analytics can link accounts used
  in the same browser; an Owner or test account's analytics exclusion stays
  browser-wide.
