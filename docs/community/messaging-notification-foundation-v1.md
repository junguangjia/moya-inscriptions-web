# Messaging V1: notification foundation

Task #159, coordinated revision r6. The current Owner assignment explicitly
authorizes this notification scope and its Behavior Matrix; C records the single
consolidated scope amendment. Base: `0a55227e750314930851d8c09c912498ff3a2e84`.
Delivery stops at an independently reviewed Draft. No Production activation,
Ready transition, merge, release or Issue closure is authorized.

## Frozen scope and behavior

N owns transaction-bound notification work, recipient derivation, mention
references/input, activity inbox/group/read state, SSE refresh, message-center
activity composition and the existing exact-comment locator. A owns identity and
Sessions. C owns Article/Thread content and real text DMs, including their
unread conversation count. Thread posts are Works. Official Catalog and Article
have no invented public-user owner. Followers and saves are not notification
sources. Native/background push, paid providers, historical backfill and
destructive retention are deferred. Catalog and Work remain separate; root/reply
tables, receipts, media ownership and immutable publishing revisions remain
canonical.

| Scenario                 | Development / Owner QA                                     | Production in this task | Must preserve                              |
| ------------------------ | ---------------------------------------------------------- | ----------------------- | ------------------------------------------ |
| Likes, comments, replies | Real source transaction and durable inbox                  | New exposure disabled   | Current visibility, no self notification   |
| Mentions and edits       | Validated stable IDs; unchanged recipients deduplicated    | New exposure disabled   | Plain text and existing editor             |
| Article comments         | C's visibility seam, separately pending until integrated   | No activation           | Official content has no user owner         |
| Read races               | Only observed committed versions read                      | No activation           | Owner scoping; later events unread         |
| SSE/logout               | Same-origin stream, durable resync, session revalidation   | Stream unavailable      | No bearer URLs; no stale private emissions |
| Fans/saves               | Existing real follow view; no fabricated alerts            | Unchanged               | Privacy and truthful states                |
| DMs                      | C's panel and unread conversations through typed host slot | No new exposure         | One host/navigation owner                  |
| Hidden source            | No stale actor/text; safe unavailable state                | Unchanged               | Block, suspension, parent visibility       |
| Sent comments            | Existing MyComments                                        | Unchanged               | Never incoming unread                      |
| Candidate                | Reviewed Draft; integration evidence distinct              | No deployment           | Owner visual/device gate                   |

## Owner screenshot change r3

Received comments, mentions and likes share the same layout: date and time at
the upper right, with a seal-red unread dot at the right of the preview text.
There is no visible unread label or separate mark-all-read control. Opening an
available notification persists its existing observation before navigation; the
refreshed server state removes its dot. Screen readers retain an unread label on
the dot.

The explicit Refresh action marks all observed activity read through the current
server-issued inbox observation, then reloads. It includes other activity
categories and off-page groups within that observation, preserving pagination.
Initial loading, automatic SSE resync, foregrounding and reconnects never mark
activity read. Events committed after the observation remain unread. Existing
sent-comment history, source visibility, precise navigation/return, account
isolation, DM ownership and Production gates are unchanged.

This Owner-requested Web change has its own focused feedback evidence. It does
not reset the exhausted cumulative repair rounds or approve the separately
requested PostgreSQL fixture compatibility repairs. Full task acceptance and
independent Draft delivery remain pending.

## Owner pull-to-refresh change r4

The permanent Refresh text control from r3 is replaced by a local pull gesture
on received comments, mentions and likes. Only a single downward touch starting
at the list's top can arm it. Chosen gesture tuning: 8 px direction slop, 0.5
resistance, 60 px visible trigger threshold, 80 px maximum reveal, and 24 px
side-edge exclusion for browser navigation. Below threshold or on touch
cancellation it returns without a read mutation. A consumed drag cannot open the
underlying notification. Native vertical scrolling, horizontal gestures,
multi-touch, sent comments, fans and the DM panel remain untouched.

The existing small UI spinner runs while the read-and-reload promise is pending;
it collapses on completion or failure. No artificial loading timer. Empty/error
lists support a reload without inventing a read observation. Keyboard and
screen-reader users have a refresh action that appears on keyboard focus. The
indicator announces pulling, release and refreshing states, and respects reduced
motion. Tab/account/route changes clean up gesture ownership. The r3
all-observed read rule, unread dots, upper-right timestamps and precise return
path remain.

Design references:
[Ionic Refresher](https://ionicframework.com/docs/api/refresher) for resisted
pulling, threshold and async completion;
[Android pull-to-refresh](https://developer.android.com/develop/ui/compose/components/pull-to-refresh)
for a compact indicator driven by pulling/loading state; and
[MDN overscroll behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior)
for containing the list's gesture without a second browser refresh. These are
interaction references, not new dependencies or a claim of native-device parity.

## Owner entry repair r5

The Development login page links directly to `/?notifications=comments` and
`/?notifications=likes`; `/?notifications=mentions` also selects the mention
tab. These entries use the existing authenticated message host. Known categories
open once after the session check; only the active visible header consumes the
entry parameter. Hidden retained headers cannot open a second dialog. Other URL
parameters and history state are preserved. Unknown values leave navigation
alone. Closing the message panel, background updates and exact-detail return
never reopen a dismissed entry. Guest/error states still use the existing
login/error presentation. Production composition is unchanged.

The earlier link to `/dev/t02p` was misleading for notification testing: that
clean Catalog preview has no notification host. It is no longer advertised as a
message example. Existing notification data stays intact. Small new unread
examples in retained synthetic QA are generated with real publishing/mention,
comment/reply and like operations, never by inserting inbox rows or resetting
read state. No fixture fallback is added to the live host.

## Owner delivery request r6

The Owner requested a Draft PR, exact HEAD, exact-head CI and independent
review. Delivery resumes with the necessary test compatibility repairs:
account-scoped notification fixture teardown, explicit empty mentions on
upgraded historical comments, and frozen historical draft rows before applying
the complete migration chain. Current-adapter checks after upgrade remain.
Applied migrations and past failed evidence are unchanged. This supersedes the
earlier pending repair-authority notes; it does not waive validation deadlines,
independent review or the Draft-only stop. Physical-device and combined A/N/C
acceptance remain separate gates.

## Implementation plan and shared hotspots

Contracts are additive in packages/contracts. Notification code lives in the
community application port/service, community-postgres notifications module,
backend notification handler/stream, backend-production worker, Web notification
client/provider/activity and reusable mention input. Source changes are limited
to existing discussion/comment/Work like and publication transactions and their
mention transport. Named integration blocks: contract exports/schema/OpenAPI,
community migration manifest, grant-runtime.sql, API exports, backend
application, router/composition, Web public-API relay and accepted
message-center/composition, comment/editor seams and exact architecture
allowlists. Relevant tests cover contract, PostgreSQL, HTTP, browser and
boundary behavior. No dependency upgrades, CI redesign, root governance edits or
unrelated Admin changes.

Ordered slices: A scope/inventory/contracts plan; B persistence, domain and
HTTP; C real Web/SSE/acceptance; D cumulative validation, Draft, independent
review, necessary bounded fixes and handoff. One prepared candidate and at most
two evidenced correction rounds per slice; failed evidence is retained.

## Recipient, identity and lifecycle rules

- Work like or new top-level Work comment: Work author.
- Comment like: comment/reply author.
- Reply: explicit reply recipient, otherwise root author; also applicable Work
  author. Mention targets add recipients. Exclude actor and deduplicate; reason
  priority is reply > mention > comment. Like actions have their own reason.
- Catalog/Article top-level comment: explicit mentions only. No broadcast.
- The durable action key derives from a committed interaction: comment ID, actor
  plus liked target, or Work identity for Work mentions. Request IDs remain
  existing command receipts, not notification identity. Delivery uniqueness is
  action plus recipient. Unlike/re-like, hide/unhide and remove/re-add of the
  same Work mention do not re-alert an already delivered recipient. A new
  comment or first mention of a new recipient is a new eligible effect.
- No migration backfills interactions. Pending comments have durable work but no
  recipient effect until legitimately visible. Publication/moderation wakes only
  task-era recorded sources; superseded Work revisions are never projected.
- Persist minimal IDs and source revision; do not retain content excerpts in the
  outbox. Every projection and read rechecks current actor, recipient, parent,
  Work/Catalog publication and blocking. No unavailable source text/actor
  leakage.

## Mentions

Maximum 20 distinct recipients and 20 spans per content; lookup returns at most
10 active, mutually unblocked users for a 2–40 character handle/name query.
References identify immutable PublicUserIds; display name is never identity.
Selected text is `@handle`, with the handle snapshot retained only to validate
text. Offsets are JavaScript UTF-16 code units into LF-normalized, outer-trimmed
text. No NFC normalization is performed; combining characters remain unchanged.
Spans are ordered, non-overlapping, in bounds and cannot split a surrogate pair.
Backend revalidates identity, handle and current eligibility at submission.
Stored references never rebind after rename. Plain unselected `@text` has no
notification authority. Edits preserve only spans whose text still matches;
paste does not manufacture references. Work mentions apply to body text only,
not editorial Article bodies. Drafts retain references; submission freezes them
with the revision.

## Groups, revisions and pagination

A like group is recipient + kind + target + UTC day of the action's first
recording. Distinct eligible actors are counted; actor previews are bounded to
three. Comments/replies/mentions are individual source rows. Unavailable groups
have no badge, actor preview, excerpt or navigable target. No stored stale text.
Activity badge counts unread rows/groups, not actors. C supplies unread DM
conversations; the host adds each unit once and labels both. MyComments and fans
have no invented unread contribution.

Each new recipient effect locks and increments that recipient's row in the same
transaction as its unique delivery and group update. Thus commit order is the
recipient revision order; an allocated global ID is never a watermark. A list
captures a committed recipient revision in a repeatable-read snapshot. Read
commands use signed owner-scoped observations; stale commands advance only to
what was observed. A group with a newer delivery stays unread. Mark-all uses the
observed high-water mark. Read state is persistent and monotonic.

Cursor pages have default 20, maximum 50 groups, ordered by snapshot maximum
delivery revision descending then stable group ID. Observations/cursors are
scoped to account, purpose, filter and snapshot, expire after 30 minutes and are
signed with a process-local key. Restart invalidates old cursors with a resync
response; it never loses durable activity/read state. Cursors are not Session
authentication and cannot authorize another account. No automatic 180-day
cleanup or retention policy is adopted.

## Worker, stream and recovery

A separate notification pump uses the existing PostgreSQL claim/lease/retry
principles; it never shares publishing jobs or a media worker. One pump per
backend process; at-least-once execution with unique consumer effects. Leases
are recoverable, retries bounded and errors contain IDs/codes only. Durable
source commits survive pump failure. V1 supports one backend process;
distributed fan-out is not claimed.

SSE carries refresh signals only, after persistence. One client subscription per
account provider, with bounded connections, slow consumers and reconnect delay.
Revalidate the Session before every private signal and on the heartbeat path;
logout immediately closes local subscription. A reconnect or foreground event
refetches a bounded authorized page/snapshot. No dedicated PostgreSQL connection
per socket; no one-second per-user polling. Web relays the stream with abort,
private/no-store and no buffering; cookies and bearer credentials never enter
URLs. Disable by removing Development notification composition, leave durable
tables intact, fix through a forward migration and resume/replay task-local
failed work. No destructive rollback or Production rollout is promised.

## Parallel boundaries and acceptance

A's CommunitySessionService.identify and existing useAuthors viewer/checking/
sessionError/signInHref remain the seams. C supplies
EditorialContentReadService.isArticlePublished through its Article publication
port, the additive Article discussion target, DM panel and unread conversation
adapter. N supplies mention input and notification/locator contracts; C's quick
composer reuses them. The stranger-DM rule is exactly one first message until
the recipient's committed eligible reply. Reading, following, changing device,
unblocking or hiding a conversation cannot unlock another. C owns enforcement; N
adds no DM persistence.

Independent acceptance uses separate real Development sessions on one task-owned
retained synthetic database, with a distinct disposable test instance. Joint
A/N/C acceptance is performed only by C's separate exact-head QA assembly.
Required journeys: every event, reason overlap/self actions, mention
edits/Unicode/forgery, worker retry/lease recovery, unread races and late
commit, two sessions/account switch, blocked/suspended/hidden/deleted sources,
same-origin streaming/logout, exact off-page comment/reply and return,
clean/upgrade DB grants, preserved publishing and production exclusion. Actual
evidence and Owner checklist are recorded in the final handoff; setup is not
acceptance.

## Focused reference decisions (checked 2026-09-22 UTC)

No external implementation was copied and no external messaging platform was
installed. These were behavior references, not adopted dependencies:

- [Mastodon grouped notifications](https://docs.joinmastodon.org/methods/grouped_notifications/),
  live documentation checked on the date above. Adopt server-side group
  identities and bounded actor previews. Do not adopt its IDs as a commit
  watermark.
  [Mastodon implementation license](https://github.com/mastodon/mastodon/blob/main/LICENSE)
  is AGPL-3.0; documentation was consulted only, not redistributed.
- NodeBB commit `3f479e8d650d94d64fbfc5a7156f3ebe2e0a68fc`:
  [create.js](https://github.com/NodeBB/NodeBB/blob/3f479e8d650d94d64fbfc5a7156f3ebe2e0a68fc/src/messaging/create.js),
  [notifications.js](https://github.com/NodeBB/NodeBB/blob/3f479e8d650d94d64fbfc5a7156f3ebe2e0a68fc/src/messaging/notifications.js)
  and
  [unread.js](https://github.com/NodeBB/NodeBB/blob/3f479e8d650d94d64fbfc5a7156f3ebe2e0a68fc/src/messaging/unread.js);
  LICENSE at that commit is GPL-3.0. Keep message persistence/membership,
  delivery signals and unread room units separate. ArtVenn uses committed
  recipient revisions rather than wall-clock read boundaries or globally
  allocated IDs.
- [Discourse Chat](https://meta.discourse.org/t/discourse-chat/230881), live
  documentation checked on the date above, informs the distinction between
  notification preferences and persistent conversation history. DM policy and
  history remain C-owned. No retention default was imported.
  [Discourse implementation license](https://github.com/discourse/discourse/blob/main/LICENSE.txt)
  is GPL-2.0; no Discourse code or documentation excerpt was copied.
- ArtVenn `services/community-postgres/src/publishing/jobs.ts`, its port and
  production worker at the baseline SHA above: reuse transaction-bound enqueue,
  `SKIP LOCKED`, lease fencing and bounded retry principles in a dedicated
  notification pump. Preserve the existing publishing worker and grants.

## Concrete bounds and recovery

The worker wakes every 2 seconds, claims at most 20 jobs, leases for 30 seconds,
and stops after five failed attempts with bounded exponential retry (maximum 60
seconds). Claim ownership includes a fresh nonce; an expired/replaced claimant
cannot complete another worker's lease. Source-generation changes wake only
recorded actions. Work republication also wakes recorded likes/comments that
could not project while private. Replays do not reset read state or redeliver
the same action/recipient. Failed-job recovery is an explicit task-local
operator procedure after diagnosing the cause, not an unbounded automatic loop.

Read queries are account-scoped with an 8-second statement timeout. They
evaluate current visibility for the recipient's observed history before
grouping/counting; they are not constant-time in total history. Delivery,
recipient/revision, group and ready-lease indexes bound lookups. Larger
histories need representative query measurement before scaling. No production
capacity claim follows from the sample.

SSE allows at most 100 process connections and four per account. Heartbeats
occur every 15 seconds with session validation before writing; event paths also
validate. A slow consumer is closed, and reconnect delays grow from 1 to 30
seconds. Backend restart invalidates process-signed cursors and observations:
refresh the authorized inbox to obtain new observations. Read state stays in
PostgreSQL. Invalidation and fan-out across multiple backend processes require a
separately reviewed design.

The accepted mobile category icons, AuthorDialog history handling, MyComments,
detail pager and comment highlighting are reused. Exact-comment navigation
reveals the Comments page before highlighting and leaves the message
view/tab/scroll in its account-owned host state. C's typed DM slot supplies
render props `onOpenProfile`, `onDepthChange`, `backRequested` and an
unread-conversation hook; its existing `openWith` may be closed over by C's
adapter. This branch does not import a fake sender or DM fixture into the live
slot.

## Secret-free real-account acceptance recipe

Use the task's isolated Development profile with the official synthetic account
seed and ordinary App runtime grants. In separate browser contexts, sign in
through `/dev/community` as `dev-user-01`, `dev-user-02`, and `dev-user-03`.
Open `/` for the live host; `/dev/t02p` is explicitly the presentation fixture
preview. Never use fixture success as live acceptance. Direct-publication
settings, if needed, are changed through the existing operator API on this new
synthetic QA instance only.

1. User 01 publishes a text Work through the editor or supported publishing
   draft and submission APIs. User 02 likes it and posts a comment. User 01
   receives one like group and the comment; its own actions produce no incoming
   notification.
2. User 02 selects User 03 with the real @ picker in a comment or reply. Verify
   the selected handle/ID, Unicode text and User 03's Mention tab. Repeat Work
   edits, remove/re-add a mention and unlike/re-like: existing recipient effects
   stay unique.
3. Make more than ten roots and replies through the real discussion API. Open a
   mention that the locator places on root page 2 and reply page 2. Confirm the
   Comments tab, exact highlighted reply, then return to the same message tab.
4. Open a second User 03 session. Mark observed activity read in the first; the
   second updates through SSE. A later committed event remains unread.
5. Delete the synthetic source through the existing author body-deletion API or
   hide it through the operator API. Refresh: unavailable rows expose no old
   text, actor, target or unread contribution. Verify logout/account switching
   clears account-owned state, and a revoked stream cannot emit a private
   refresh.

Initial 390×844 Chromium acceptance passed these real-account paths: Work like,
mention selection/submission, off-page exact reply, message-tab return,
two-session read synchronization, source deletion and same-origin unbuffered
stream/abort. This is desktop mobile-viewport evidence, not physical-phone
acceptance. Browser harness corrections (tab entry, stable IDs in retained data
and the canonical body-deletion route) and the discovered locator-page fix are
retained in private failed evidence. Unit/HTTP/PostgreSQL coverage supplements
these paths; it does not replace Owner visual/device judgment.

On a sample of 103 sources / 107 deliveries / 107 groups, the account inbox
`EXPLAIN (ANALYZE, BUFFERS)` execution was 37.056 ms. One observed
mutation-to-inbox latency was 2.214 seconds with the 2-second worker. Four
same-account streams returned their first signal in 6.2–17.1 ms; sampled Backend
RSS stayed 129,504 KiB, and sampled database connections stayed one active plus
one idle before/during/ after cancellation. This short local sample includes its
own measurement connection and is neither a soak test nor a capacity/cost
forecast. Lease-recovery tests use an expired task-owned lease. No paid service
was introduced.

The new migration is `20260922020000_notification_foundation.sql`; it adds
mention references plus notification source, recipient-version, group and
delivery tables. It has been applied only to the newly created task-owned
synthetic QA database and separate disposable test databases, never to a
pre-existing retained Owner database or Production. Its applied bytes/checksum
are immutable; corrections require a new forward migration. The final handoff
records commands, fingerprints, validation, review and the verified preview
endpoint. Joint A/N/C integration (new email user, Thread Work, Article
visibility and C's real DM panel) remains a separate C-owned exact-head gate;
individual green previews do not establish that gate.
