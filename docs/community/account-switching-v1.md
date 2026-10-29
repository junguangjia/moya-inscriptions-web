# Account switching v1 — Issue #352

Task: `account-switching-v1` r3. One browser holds up to three signed-in
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
| PC / wide screen                 | Existing sign-in and account entries available     | Same               | #260; normal account access still applies      |
| Appeal login failure             | Ordinary session kept                              | Same               | Appeal flow                                    |

## Session storage

The current account stays in the existing `yoyi-session` cookie, so every
existing reader is unchanged. The other accounts live in one new HttpOnly
cookie, `yoyi-saved-sessions` (same attributes: host-only, `Path=/`,
`SameSite=Lax`, `Secure` on https). Each entry holds the user id, handle, opaque
session token and a lifetime ceiling; the parser fails closed and clears the
cookie on anything malformed, repeated or holding a token twice. Tokens never
reach browser JavaScript or a response body.

A saved session (or one leaving `yoyi-session` for the saved list) leaves this
browser only once the Backend confirms that it ended: its sign-out answered
`revoked`, or it was `refused` (sign-out 401 and `/v1/me` 401), or it repeats
the token of `yoyi-session`. A sign-in grant that replaces `yoyi-session` (an
ordinary sign-in, or re-adding the current account) replaces that cookie as
before #352. An older session of an account whose sign-out cannot be confirmed
stays saved as a hidden copy next to that account's newer session (so a user id
may repeat in the cookie); the account is still listed once, never as a second
account. A later sign-in, 退出登录 (when it can name the account, see
Routes), 移除 or 退出所有账号 of that account goes through the authentication
relay, which carries the Production auth-ingress proof, and ends the copy. A
confirmed 注销账号 (#351, a contract 200 from the deletion relay) lets go of
every saved copy of the deleted account the same way: the deletion revoked them
all, so their sign-out is `refused` and they leave the list; a copy whose
sign-out cannot be confirmed (unavailable) stays held and is listed
as 需重新登录 until 移除 ends it. The cookie holds at most six entries (two
other accounts and the copies); an add-account step that would need more is
refused with `AUTH_ACCOUNT_STATE_UNAVAILABLE` before the Backend is asked.

Each session keeps its own absolute Backend lifetime (seven days by default);
switching never extends it. The ceiling (seven days from when an entry was
saved) only sets the cookie lifetime: whether an entry still works is always
asked of `/v1/me`, never inferred from the ceiling. The cookie outlives its
latest entry's ceiling by seven days, so an account whose session ended is
listed as 需重新登录 instead of disappearing. Switching to an entry past its
ceiling that the Backend still accepts (a longer configured lifetime) gives the
active cookie a new seven-day lifetime.

## Routes

- `GET /api/community/accounts` lists the current account and the others. It is
  read-only: it never sets a cookie. It answers only this origin's pages: Fetch
  Metadata, when present, must be `same-origin` (`cross-site`, `same-site` and
  `none` get 403) and an Origin, when present, must match; a browser without
  Fetch Metadata sends neither header on a same-origin GET, and such a request
  is answered (it changes nothing and is never readable cross-origin). Every
  held token is checked with `/v1/me`. A refused current session reads as
  `current: null` without being cleared here (the relays that use it clear it).
  Each other account is listed once: `ready` when one of its sessions is
  accepted as that account, otherwise `reauth_required` (需重新登录) on every
  read until it is removed, signed in again, or let go to make room when another
  account is added while three are held (only once its sign-out is confirmed;
  see add-account mode). Saved sessions of the current account are hidden
  copies.
- `POST /api/community/accounts/switch { accountId }` swaps the current and the
  saved session after `/v1/me` confirms the target; a target none of whose
  sessions is accepted answers 409 `reauth_required`, stays held and is listed
  as 需重新登录. Older sessions of the target and of the account leaving
  `yoyi-session` are signed out and let go once that is confirmed; others stay
  as hidden copies (in Production this route has no auth-ingress proof, so a
  copy the Backend still accepts stays).
- `POST /api/community/auth/accounts/remove { accountId }` and
  `POST /api/community/auth/accounts/sign-out-all` revoke on the Backend. They
  sit under the existing auth relay because Production nginx gives the trusted
  auth-ingress proof that Backend sign-out requires only to
  `/api/community/auth/`. 移除 is offered for 需重新登录 accounts too (their
  sign-out is refused, so they are let go) and signs out every saved session of
  that account; a session whose sign-out is unconfirmed stays (503).
  Sign-out-all signs out every held session, whatever its ceiling. When it
  cannot confirm every sign-out it answers 503
  `{ reason: "unavailable", currentCleared, remaining: [{ id, handle }] }`:
  whether this browser still has a current session, and which accounts are still
  held (never a session; while the current session stays, its own saved copy may
  be named and the page does not show it as another account). If the current
  session was cleared, the page reloads as signed out and the next load shows a
  one-shot notice (carried in `sessionStorage`, shown through the AuthorProvider
  notice) naming the accounts left to sign out from 设置 → 切换账号. Otherwise
  the page stays with the error and lists what is still held. Only an unanswered
  request makes the page read the list again.
- Add-account mode: the sign-in flow opened with `?intent=add-account` sends
  `x-yoyi-account-intent: add`. The relay then never forwards the current
  session on sign-in or registration steps (the new account's challenge cannot
  record the old account), refuses a fourth account before calling the Backend
  (`AUTH_ACCOUNT_LIMIT`), and on success moves the previous account into the
  saved list. At the limit, saved sessions `/v1/me` refuses do not count: the
  add step signs them out and lets them go to make room (one whose sign-out is
  unconfirmed stays, uncounted, listed as 需重新登录). Re-adding a listed
  account replaces its stored session. If another tab added accounts meanwhile
  and a verification grants a fourth account, the new session is signed out
  again (409 `AUTH_ACCOUNT_LIMIT`); if that sign-out cannot be confirmed the
  account is kept instead and the browser holds four accounts until the reader
  removes one (添加账号 stays disabled meanwhile), so a session that may be live
  is never orphaned.
- Without the header, sign-in behaves as before, except that the saved sessions
  of the account signing in are signed out and let go in the same answer, so a
  later 退出登录 leaves nothing of that account switchable.
- 退出登录 (`POST /api/community/auth/sign-out`): the relay clears
  `yoyi-session` only once the session has really ended, that is after a
  confirmed sign-out (2xx) or when the Backend no longer accepts the session
  (sign-out 401 and `/v1/me` 401; the relay then answers 204, because a session
  the Backend no longer accepts is already over). Any other answer (unavailable,
  an error, the approved fence 409 `AUTH_ACCOUNT_MISMATCH`, a refused assertion,
  or a 401 for a session `/v1/me` still accepts, such as
  `AUTH_SOURCE_UNTRUSTED`) keeps the session and its cookie, and the page's
  existing 退出未能确认，请重试 is then true: the retry can still end it. Before
  account switching the relay cleared the cookie after any delivered answer,
  which could leave a live session the browser could no longer end; this
  behavior change was confirmed by the Owner on 2026-10-27 (Issue #352 r3). When
  this browser holds saved sessions, the relay also signs out its saved copies
  of the account being signed out: on the 2xx path, and on the already-ended
  (204) path when the page sent `x-author-account`. That account is the one the
  page's `x-author-account` names; without an assertion it is named by `/v1/me`
  before the sign-out, which can name it only while the current session is still
  accepted (so a sign-out without an assertion signs out no copy when the
  session had already ended or `/v1/me` could not answer). Copies whose sign-out
  is confirmed are let go; unconfirmed copies stay held, listed under that
  account where 移除 ends them. Other accounts stay listed either way.
- The browser runs every request that rewrites these cookies (switch, remove,
  sign out all, the add-account steps, an ordinary sign-in, a factor change
  (`factors/complete`, `factors/unlink`, whose answer reissues the session),
  sign-out and 注销账号 (#351)) under one exclusive Web Lock across its tabs, so
  two answers never write cookies from different snapshots; the read-only list
  takes the same lock so it reads after a write in flight. Without Web Locks the
  request runs directly. The existing relays that clear `yoyi-session` once the
  Backend refuses it (`/api/community/me`, the author, media and notification
  relays, and the auth relay's own reads and code requests: `GET account` and
  `POST challenges` outside add-account mode, which 账号与安全 and 注销账号 use)
  run outside that lock; see Known limitations.

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
  refuses a mismatch on reads as on writes; auth sign-out with an assertion
  answers 409 `AUTH_ACCOUNT_MISMATCH` for another account's live session and 401
  `AUTH_ACCOUNT_SUSPENDED` for a suspended account's live session, and in both
  cases nothing is signed out. A session the Backend no longer accepts signs out
  as it does without an assertion: an open factor-change receipt of it is still
  sealed, which revokes the session the change reissued (so 退出登录 after a
  factor change whose answer was lost still ends that session); with no open
  receipt the answer stays 401 `AUTH_UNAUTHENTICATED`.
- Composer drafts stay bound to the account they were written as. The comment
  and colophon composers already keep a draft per confirmed account (another
  account's view never shows it, and it comes back when that account is current
  again), and the direct-message conversation remounts per account. Another
  tab's switch reaches the client's confirmed account
  (`authorClient.setAccount`) a moment before this tab's view follows; a
  discussion comment or reply, a colophon, a direct message or a new
  conversation sent in that moment is refused before any request
  (当前账户已切换，这条内容未发送。 / 当前账户已切换，这条私信未发送。) and
  never sent as the other account.
- Fixed: a 401 on an `appeals/*` auth call no longer clears the ordinary
  `yoyi-session`.
- A deleted or suspended account's stored session is refused by `/v1/me` and
  shown as 需重新登录 (#351).

## Known limitations

- The former wide-screen sign-in restriction is retired by
  #260; 添加账号 and 重新登录 use the existing authentication and account
  permissions.
- Article editor uploads are not visible to the settings guard: they live in the
  article editor's own upload session, which exposes no in-flight signal. The
  editor's leave prompt covers unsaved edits and a pending publication.
- The account routes carry no trusted authentication source in Production, so a
  switch cannot sign out a saved copy the Backend still accepts; the copy stays
  hidden until the authentication relay (sign-in,
  add-account, 退出登录, 移除, 退出所有账号, 注销账号) ends it.
- An asserted Backend sign-out of a suspended account's session is refused,
  so 移除 and 退出所有账号 let such a session go (`/v1/me` refuses it too)
  without ending it on the Backend; it lapses at its own expiry, and no browser
  holds its token any more.
- 退出登录 on the product-access page sends no account assertion. When the
  browser holds a saved copy of the current account and `/v1/me` cannot name
  that account before the sign-out (the session had already ended, or the read
  failed), the copy is not signed out: once the current session is cleared it is
  listed under that account (switchable while the Backend accepts it)
  until 移除 or 退出所有账号 ends it.
- A request still carrying a session the Backend no longer accepts (for example
  an `/api/community/me` re-check or an author read started in another tab) can
  answer after a switch has just made another account current, and the relay's
  existing refused-session clear then removes the new `yoyi-session` too. That
  account must be signed in again on this browser, and its Backend session
  lapses at its own expiry. The window is a few round trips; no data or write
  crosses accounts.
- The browser drops the saved cookie seven days after its latest entry's
  ceiling, so with a Backend session lifetime configured above fourteen days an
  untouched saved session could outlive it there.
- The legacy `LiveCommentSection` (used only when Author Community is off) binds
  comment writes to the account its transport last confirmed, not to its own
  section.
- The analytics visitor id is per browser, so analytics can link accounts used
  in the same browser; an Owner or test account's analytics exclusion stays
  browser-wide.
