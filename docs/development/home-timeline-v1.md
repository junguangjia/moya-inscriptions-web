# Home timeline — Issue #384 r3, and its posts (timeline-posts-v1)

## Owner direction and scope

Owner instruction
(2026-11-03): 「把主页附近的功能改成时间轴，匹配对应的图标动画」and, after
accepting the three-platform design, 「开始实现」. On content: keep the axis
clean, with no source or absence wording. Catalog images are the main
thing. 书帖 stay the current Catalog ones.

Reference:
[时间轴 · 三端方案 v0.3](https://www.figma.com/design/PKhG0jrFs2xCbHb8Ri5kW9?node-id=489-491).

The tab at index 1 of Home stops being 附近, which was a hard-coded empty state
with no data path, and becomes a chronological axis from the oracle-bone era to
now. Old `?feed=nearby` links open the timeline. The other three feeds, the
pager and the tab order are unchanged.

Owner instruction (2026-11-06), given while the merge of this work was held for
the Admin MCP task:

> 我之所以暂时你的merge的原因是另一个MCP任务在跑。现在这个任务基本上已经完成了，我需要你去看看代码。因为你的时间轴任务也要可以通过后台，通过MCP实现最大程度上的AI操控。所以对应的后端也要完善。

Revision r3 follows from it. The database becomes the master of the timeline
rows, and the Owner and AI edit them through the Backend. The authority is the
[2026-11-06 amendment](../governance/amendments/2026-11-06-home-timeline-admin-mcp.md),
which the Owner is asked to sign at merge.

Issue #384 is the authoritative scope: its allowed modules, its non-goals and
its restrictions. The main non-goals are linking user posts to entries, any
Catalog field or record change, a new Payload collection, a human Admin page for
rows, and Apple or Harmony clients. Linking user posts to entries is the next
task, `timeline-posts-v1`, with its own Issue and amendment; see
[Timeline posts](#timeline-posts-timeline-posts-v1).

## Why a table and not Catalog fields

Most of the roughly 1,700 entries have no Catalog page.

- Every published Catalog row flows into `/v1/catalog`, search documents and
  `catalog_discovery`, with no flag to exclude it. Text-only entries would
  surface in Discover, the kind pages and the article picker.
- Catalog has no numeric date fields. Adding them changes the Payload field,
  `contentShape`, the `catalog_entries` view, the query both content sources
  share and the strict `catalogSummarySchema`, which an older Web rejects with
  a 502. A new field with a default would also change content fingerprints.
- A static list in the Web bundle or in Git conflicts with ADR 0006 and
  Constitution §19. The data path stays PostgreSQL → Public API → Web.

So `community.timeline_entries` holds all entries, with a nullable `catalog_id`
for rows that link a published record. The community migration family does not
depend on `MOYA_CONTENT_SOURCE`, and `/api/community/` already reaches Web
through the existing relay and Nginx rule, so no new route file is needed.

## Who writes the rows

r2 said: "This is reference data, not a second editable content master." Rows
changed only through the import. The Owner's direction of 2026-11-06 reverses
that. The database is now the master:

- `scripts/import-timeline.mjs` seeds the table from a private file. It stays
  the Owner's guarded path for replacing the whole set.
- After that, the Owner and AI create and edit rows through the Backend's
  operator routes. Admin calls those routes and never touches the table.
- No row is deleted through the Backend. A hidden row leaves the public read at
  once, and can be shown again.

Every writer runs its checks inside the shared content-operator lock, against
the contract's import row, `timelineImportEntrySchema`. The import holds its
whole file to `checkTimelineEntrySet`: every row passes, each id and Catalog
record appears once, the file has at most `TIMELINE_ENTRIES_MAXIMUM` rows, and
its response estimate is within `TIMELINE_RESPONSE_BYTES_MAXIMUM`. An operator
write runs `checkTimelineEntryWrite` over the stored set before and after it,
and is refused only for what it makes worse:

- Each row the write stores must pass the import row when the write creates it,
  changes one of its import fields (`position` included) or leaves it visible;
  otherwise the write answers `ENTRY_INVALID`. So a write that only hides a row
  passes, and showing a row that fails is refused. A reorder stores every row of
  its year, so it is refused while a visible row of that year fails, or while a
  hidden one that fails would move.
- Every other stored row is left out of the check, whether it passes or not.
- `TIMELINE_FULL` only when the write adds rows past the maximum, and
  `TIMELINE_TOO_LARGE` only when the estimate after the write is past its limit
  and above the estimate before it. Hidden rows count toward both limits.
- Ids and Catalog links stay unique by the table's keys, which answer
  `ENTRY_EXISTS` and `CATALOG_ALREADY_LINKED`.

So no write takes the set past a limit, and while the set is within its limits,
no write turns a public read that passes into one that fails. A stored row fails
the contract, or the set passes a limit, only after direct SQL or a contract
change. Past `TIMELINE_ENTRIES_MAXIMUM`, showing a hidden row can still make the
public read fail. A row that fails can be hidden at once and fixed with
`update-timeline-entry`, one at a time (see the refusals below).

Group and chapter consistency are reported, not enforced: the summary counts
them, and `read-timeline` filters on them. The chapter year spans live in
`TIMELINE_CHAPTER_SPANS` in `packages/contracts/src/schemas.ts`, which the
operator read's mapper imports for `issue=chapter_year`. Frontend code may not
import runtime contracts, so the Web keeps its own presentation table,
`TIMELINE_CHAPTERS`, with the same spans, and
`tests/unit/backend/timeline-operator-http.test.ts` pins the two equal.

A linked row takes its publication and media rules from the existing Catalog
projection. A row whose record is not published stays text-only and unlinked.

Each row records who wrote it. `created_by` and `updated_by` hold `import`,
`owner` or `ai-admin`, the operator labels the Backend passes, and a database
check allows only those. A new label needs a migration. `version` rises by one
on each change, and `created_at` and `updated_at` record the times. An import
brings a replaced id back one version past the row it replaces, so a version
read before an import never matches the row that replaces it. An id the import
drops and a later import or create brings back starts again at version 1.

## Admin MCP ops

Five ops on tools that already exist, on the `community` credential. Each is
also an Owner route, `POST /api/community-moderation/<route>`, so the Owner has
the same powers in an Admin session.

| Op                                | Tool            | Backend route                                    | What it does                                      |
| --------------------------------- | --------------- | ------------------------------------------------ | ------------------------------------------------- |
| `community.read-timeline`         | `admin_read`    | `GET /internal/community/timeline-entries`       | A filtered page of stored rows                    |
| `community.read-timeline-summary` | `admin_read`    | `GET /internal/community/timeline-summary`       | Counts, issues and limits                         |
| `community.create-timeline-entry` | `admin_execute` | `POST /internal/community/timeline-entries`      | One new row under a chosen id                     |
| `community.update-timeline-entry` | `admin_execute` | `POST /internal/community/timeline-entries/{id}` | Edit, hide, show, link, unlink or regroup one row |
| `community.reorder-timeline`      | `admin_execute` | `POST /internal/community/timeline-order`        | The order of one start year's rows                |

The three top-level paths differ, so an entry id such as `summary` can only name
a row.

**`read-timeline`.** Every filter is optional: `id`, `ids` (up to 100), `search`
(title, full title, date label, polity, holder and province), `chapter`,
`yearFrom` and `yearTo` (spans that overlap them), `polity`, `precision`,
`onAxis`, `disputed`, `groupId`, `linked` (`any`, `linked`, `unlinked`,
`not_published`), `catalogId`, `hidden` (`include`, the default, `exclude` or
`only`), `updatedBy` and `issue`. `issue` finds a row that fails the contract, a
group whose members disagree, a start year outside its chapter, or a link to a
record that is not published. Pages hold 20 rows by default and 50 at most, in
the public read's order: start year, position, id. Each row carries its import
fields, `version`, `hidden`, `linkState`, its writers and times. `admin_read`'s
compact view shows the main columns and `full` shows the rest. There is no count
view: the summary is the count. On the Backend a number is read only from its
decimal digits, so an empty or blank `page`, `pageSize`, `yearFrom` or `yearTo`
answers 400 and is never read as 0; so does a query key that an object inherits,
such as `constructor`.

**`read-timeline-summary`.** Counts over every stored row: visible and hidden,
on the axis and on the shelf, per chapter, by link state, by last writer and by
issue. It also counts the groups among visible rows, and those that fold (three
or more members). It gives the row count and response estimate against their
limits, and the last change time.

**`create-timeline-entry`.** The caller chooses the id. Optional fields default
to null, and `disputed` to false. Without `position`, the row goes to the end of
its start year. The row starts at version 1 with the caller's label.

A text field of either command refuses a NUL and an unpaired UTF-16 surrogate,
which PostgreSQL text cannot hold, so the Backend answers such a command 400
`INVALID_COMMAND` before anything runs.

**`update-timeline-entry`.** Any subset of a row's fields, against the
`expectedVersion` the caller read. The id never changes. `catalogId: null`
unlinks. `groupId` and `groupTitle` change as a pair. A new `startYear` without
a `position` moves the row to the end of that year. `hidden` takes the row out
of the public read, or puts it back. Moving a link to another row takes two
updates in order: unlink, then link.

**`reorder-timeline`.** The rows of one start year, each with its version, in
their new order. The list must name every row of that year, hidden ones
included, or the op refuses. Positions become 0, 1024, 2048 and so on, in one
transaction under one receipt. Position orders rows only within a year and a
display rank: the Web shows rows with an image first, then folded groups, then
text-only rows.

Every write carries a `requestId` in its body. A lost answer is safe to retry
with the same key: the Backend replays the stored answer, and the AI's copy says
it was replayed. The same key on a different command answers
`IDEMPOTENCY_CONFLICT`. Keys share one space with the other content-operator
commands. Each write records one `content_operator_events` row with content type
`timeline_entry`, action `timeline.create`, `timeline.update` or
`timeline.reorder`, and the operator label. An AI write waits at most 8 seconds
for the lock, as other AI writes do.

Admin names a written row by its index, not its id, because an entry id is text
its writer chose. The rule is Admin's own for every op: an id is echoed only in
a shape that no text fits in. So an entry id that is all digits (up to 15, with
no leading zero, echoed as a number), a UUID, or a platform id such as
`work-<32 hex>` is still echoed and audited as the target id. Any other entry
id, a slug for example, is in neither the answer nor the Admin audit. The answer
carries the title, marked as untrusted, the state, the version and the link
state.

To trace a write, start from the Backend's event row in
`content_operator_events`, with content type `timeline_entry`. Its
`detail.command.requestId` is the key that the receipt row holds as
`content_operator_receipts.request_id`, and its `content_id` names the entry,
except for a reorder. On the Owner's route that key is the `requestId` the Owner
sent. On the AI path it is not the call's `requestId`. Admin sends each target
the key `requestKeyFor(requestId, index, connectionId)`
(`apps/admin/src/admin-mcp/tools/execute.ts`): a UUID-shaped SHA-256 of the
call's `requestId`, the target's zero-based index and the connection id, or of
the first two for a key with no connection. Admin's audit rows record the call's
`requestId`, its connection id and its target count, but not the derived key. To
match an AI call to its event rows, recompute the key for each index below that
count, and look for it under operator label `ai-admin`. The derivation is in
[`admin-mcp-completion-v1.md`](admin-mcp-completion-v1.md), section 7 and the
section 22 note on one requestId over two connections.

Refusals change nothing and record nothing:

| Code                     | When                                                                                            | HTTP |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---- |
| `ENTRY_EXISTS`           | The new id is taken                                                                             | 422  |
| `CATALOG_ALREADY_LINKED` | Another row links that Catalog record                                                           | 422  |
| `TIMELINE_FULL`          | The write would add rows past `TIMELINE_ENTRIES_MAXIMUM`                                        | 422  |
| `TIMELINE_TOO_LARGE`     | The write would grow the response estimate and leave it past its limit                          | 422  |
| `ENTRY_INVALID`          | A row the write stores, visible after it or with an import field changed, fails the import row  | 422  |
| `SET_CHANGED`            | A reorder does not list exactly the rows of its year                                            | 422  |
| `STATE_CONFLICT`         | The row changed since the caller read it                                                        | 409  |
| `IDEMPOTENCY_CONFLICT`   | The `requestId` was used for a different command                                                | 409  |
| `INVALID_COMMAND`        | A malformed body, text with a NUL or an unpaired surrogate, or an update with nothing to change | 400  |
| `NOT_FOUND`              | No row has that id                                                                              | 404  |

The named refusals answer 422 because the Owner's transport keeps a 422 code and
turns every 409 into `STATE_CONFLICT`. The AI sees a named refusal as a failed
target under its code, and a stale version as a conflict.

A stored row that fails the contract never refuses another write; read
`issue=contract` to find one. While it is visible, the public read fails and the
feed shows as unavailable. Hide it at once with `update-timeline-entry`, which
passes although the row fails, then fix it with the same op. Until it passes,
showing it, a change that still fails, and a reorder of its year while it is
visible each answer `ENTRY_INVALID`. This holds for the text and length rules. A
change to the chapter or precision values ships with a data migration, because
the table's checks list the same values and the operator read parses them.

### Not built, and why

- **Hard delete.** It is irreversible, and the Admin MCP engine on `main` cannot
  run an irreversible op yet. It waits for the irreversible run engine (#355
  S8b), and its name is not registered before then. Hiding a row gives the same
  public effect now.
- **Whole-set replace or import.** The import stays an Owner script. The run
  engine works per target, not as one transaction.
- **Export.** `read-timeline` already returns rows in import shape.
- **Media.** The table has no media columns. Images come only from the linked
  Catalog record.
- **A `timeline_entry` record type for `admin_find` and `admin_get`.** It waits
  for the S10 record descriptors. `read-timeline`'s `id`, `ids` and `search`
  cover lookup.
- **History.** Reading past events needs wider grants on
  `content_operator_events`. `version`, `updatedBy` and `updatedAt` show the
  latest change.
- **Selectors.** The whole timeline fits explicit targets, at most 100 per
  `admin_execute` call.
- **A human Admin page.** Parity runs from each Owner surface to an op, not the
  other way. The Owner routes exist, and the Owner sees the result on the public
  timeline.

## Axis, undated rows and folds

Owner direction (2026-11-07), after seeing the live timeline:

> 有大致时期的也放上去，完全不能确定的再折叠收录

> 同一年太多的只有确定是同一处且同一类别再折叠，比如石鼓文这样。其他还是要展开显示

And after seeing the rows that were still behind 「其他」 (Issue #422):

> 你误解了我的意思，同类的可以折叠，但不同类的都要显示出来，即使不确定时间

**On the axis.** A row goes on the axis when its date is narrower than its
dynasty or polity: a year, a reign, or a period such as 「玄宗朝（约712后）」. A
row dated only by its dynasty or polity stays off the axis. A row's `onAxis`
carries the choice and the Web draws what it says, so moving a row is an
`update-timeline-entry`, not a Web change. Following the first sentence, the
rows with an approximate period were moved onto the axis through the Admin MCP
on 2026-11-07; only dynasty- or polity-level rows stay off it.

**年代不详.** Nothing is hidden behind a 「其他」 shelf any more. A chapter's
off-axis rows close it under a small heading 「年代不详」, one row each, in the
public read's order, and each opens like any row. They print no year and no
mark, on a dotted spine, and name their entry by its short title, as the axis
rows do (the 词条卡 and the deck give the full title). The position bar
reads 「唐 · 年代不详」 and writes no year to the URL, and a year or reign jump
never lands on them. A chapter with only off-axis rows shows its head, then the
heading, with no empty row.

**Folds.** No year folds: every row of a year shows, however many share it, and
there is no 「另 N 条」 row. Only a group folds, following the second sentence.
A group is the rows that share a `groupId`, a curated set of one place and one
kind such as 石鼓, 熹平石经 or 云峰山摩崖. Three or more members fold into one
row where the first member stands, and a pair stays two plain rows;
under 年代不详 a group folds the same way. On-axis and off-axis members of one
id fold apart. Within a year the order stays: rows with an image, then groups,
then text-only rows, each in position order.

## Behavior Matrix

The frozen Behavior Matrix is in Issue #384 and wins over tests. It covers rows
present, linked, unpublished and unlinked rows, the unavailable message, old
links, scroll and Detail return, viewer identity and the QA scenarios
`timeline-demo` and `timeline-unavailable`, which replace `nearby-demo` and
`nearby-unavailable`. r3 adds rows for the five ops, the import guard, hidden
rows, command text the store cannot hold, and a stored row that fails the
contract. The amendment carries the same rows. The rows for posts are in the
`timeline-posts-v1` Issue and the 2026-11-07 amendment, which changed no row of
#384.

Issue #422 (the Owner's direction of 2026-11-07, quoted under
[Axis, undated rows and folds](#axis-undated-rows-and-folds) and
[What a user sees](#what-a-user-sees)) replaces these rows; every other row
stands:

- **#384 「Row linked to a published Catalog record」 and 「Published record
  with no deliverable image」.** A tap no longer opens Detail. It opens the
  entry's card deck, whose first card, the Catalog card, opens Detail from the
  row, so Detail identity and the return position are kept. See **Card deck**.
- **#384 「Row without Catalog record」.** It opens the 词条卡 only while the
  entry has no posts; with posts it opens the deck, and a row whose count is not
  known reads its total first. See **Card deck** and **词条卡**.
- **The 其他 shelf** (step one's 「唐 · 其他 N」 row and its sheet). Gone: a
  chapter's off-axis rows close it under 年代不详, one row each, and open like
  any row. See **年代不详**.
- **The amendment's 「收录于 on Work Detail」** (a tap opens that entry's card).
  The tap opens the entry's deck. See **Work Detail**.
- **The amendment's 「Catalog Detail of a record a row links (D1-A)」, and the
  clause of 「Upload from a 词条卡」 that gives Catalog Detail and the
  card 收录于 opens the same upload.** Catalog Detail shows its heading, the
  posts and 「全部 N 篇」 with no upload or attach action; a post starts from
  the deck's 「上传」 or the 词条卡. See **Catalog Detail** and **Upload**.
- **The amendment's 「Post counts on group members and on shelf entries」(not
  built).** A 年代不详 row shows its count like any row; group members still
  show none.

## Delivery

r2 stopped at a local preview for Owner phone acceptance, because it is a
presentation change. r3 changes no presentation: the public read only leaves out
hidden rows. The Owner's device acceptance of r2 therefore carries forward, and
the review checks that the Web is unchanged. r3 adds a migration delta and
grants, so the PR stays Draft until an independent review of the exact head, and
the Owner signs the amendment at merge (signed on 2026-11-07).

Production release, migration and import are separate Owner gates. For the
lower-confidence dates the Owner chose on 2026-11-07 to move every row
rated考证（中） with a single year off the axis to its chapter's shelf before
the import, to drop one entry that duplicates a live Catalog record, and to have
the AI re-check those rows through the Admin MCP after launch, putting each back
on the axis once its date is confirmed. After launch the Owner widened the axis
to every row with a date narrower than its dynasty or polity (see
[Axis, undated rows and folds](#axis-undated-rows-and-folds)). The import file
stays in the private task directory, never in Git, the Web bundle or the Issue.
Development and tests use synthetic rows, so the private dataset never goes
through MCP before the Production import.

The contract change means Web, Backend and Admin ship together; a Web-only
release cannot carry it. `main` is ahead of the last Production tag, so the
release must account for what else that carries. #355 E1 is already live, with
`ADMIN_MCP_CONTRACT_VERSION` at its own release day. The new ops change what a
client sees, so the commit merged for this release raises it to this release's
day (extending rule 7); if the release slips, a one-line change re-dates it.

The migration is edited in place because it is not on `main` and has never run
in Production. A database that applied the earlier text, a local preview for
example, must be recreated: the runner refuses an edited migration it has
already applied. Once merged, the migration only adds.

## Production order

1. **Migrate.** `pnpm db:migrate:community` applies
   `20261105235900_timeline_entries.sql` with the migration authority.
2. **Grants.** Re-apply the runtime grants with the setup role, in one
   transaction:
   `psql -X -v ON_ERROR_STOP=1 --single-transaction -v app_role="$APP_RUNTIME_ROLE" -f infra/development/work-publishing/grant-runtime.sql`.
   It gives the runtime role `SELECT` on `community.timeline_entries`; `INSERT`
   on the columns a new row names, which are the entry fields, `created_by` and
   `updated_by`, so `version`, `hidden_at`, `created_at` and `updated_at` come
   from their defaults; and `UPDATE` on every column except `entry_id`,
   `created_by` and `created_at`. It gives no `DELETE` or `TRUNCATE`. It first
   revokes any table-level `INSERT` or `UPDATE`, which takes the column grants
   with it, so a re-run converges on the column grants. Confirm with the
   App-role preflight below, because startup does not probe these grants: a
   missed one shows only as this feed being unavailable, or as failed writes.
3. **Import.** Run `node scripts/import-timeline.mjs --file <absolute path>` as
   a dry run and read its counts per chapter, on-axis and linked. Then repeat it
   with `--apply`, which replaces all rows in one transaction. It reads
   `APP_MIGRATION_DATABASE_URL`, refuses a relative path or a missing migration
   ledger entry, and prints no row content or connection string. It takes the
   shared content-operator lock, so it waits for an operator write in progress,
   and an operator write waits for it. It refuses, with counts only, while any
   row was created, edited or hidden by an operator, unless
   `--replace-operator-edits` is also given, which discards those edits. Each
   apply records one `content_operator_events` row with label `import`, action
   `timeline.import` and counts only. Imported rows are labelled `import` and
   visible. An id the import replaces comes back one version past the row it
   replaces, so a version read before the import never matches the row that
   replaces it; a new id, including one an earlier import dropped, starts at
   version 1.
4. **Restart.** Restart Backend, Web and Admin on the tagged release. A Backend
   restarted before step 1 fails closed on its community ledger check. The Owner
   routes work from here.
5. **AI access.** The timeline ops use `COMMUNITY_OPERATOR_AI_TOKEN`, which the
   #355 login door release already placed. AI reads and writes of the timeline
   therefore start with the restart in step 4; there is no separate gate. Where
   it is not placed, they answer `AI_CREDENTIAL_NOT_CONFIGURED`.

App-role preflight, read-only, after step 2. It checks each grant the amendment
states: reads; `INSERT` on exactly the columns a new row names; `UPDATE` on
every column but the id, the creator and the creation time; no `DELETE` or
`TRUNCATE`; and the event and receipt grants the writes use. Every column must
be true:

```sql
SELECT
  has_table_privilege(:'app_role', 'community.timeline_entries', 'SELECT') AS reads,
  bool_and(has_column_privilege(:'app_role', attrelid, attnum, 'INSERT')
    = (attname NOT IN ('version', 'hidden_at', 'created_at', 'updated_at'))) AS creates,
  bool_and(has_column_privilege(:'app_role', attrelid, attnum, 'UPDATE')
    = (attname NOT IN ('entry_id', 'created_by', 'created_at'))) AS edits,
  NOT has_table_privilege(:'app_role', 'community.timeline_entries', 'DELETE') AS no_delete,
  NOT has_table_privilege(:'app_role', 'community.timeline_entries', 'TRUNCATE') AS no_truncate,
  has_column_privilege(:'app_role', 'community.content_operator_events', 'detail', 'INSERT') AS events,
  has_table_privilege(:'app_role', 'community.content_operator_receipts', 'SELECT')
    AND has_table_privilege(:'app_role', 'community.content_operator_receipts', 'INSERT') AS receipts
FROM pg_attribute
WHERE attrelid = 'community.timeline_entries'::regclass AND attnum > 0 AND NOT attisdropped;
```

The App-role preflight in
[`admin-mcp-completion-v1.md`](admin-mcp-completion-v1.md) names
`community.timeline_entries` for reads only. Its timeline row reads null, not an
error, before step 1, while this preflight needs the table.

A withdrawn Catalog record loses its link and image on the next read, and its
row stays as text. To take the row off the timeline as well, for a rights
request for example, hide it with `update-timeline-entry`. Removing the stored
row waits for hard delete, or for an import with `--replace-operator-edits`.

If the table is missing or empty, or the read fails, the feed
shows 时间轴暂时不可用 / 请稍后再试。 and the other feeds are unaffected.

## Timeline posts (timeline-posts-v1)

Step one left out linking user posts to entries, because no link existed yet.
The step-two plan put three choices to the Owner, each with a recommendation,
and the Owner answered on 2026-11-07:

> 可以，按照推荐吧

So: the rows that open Catalog Detail get a 帖子 section there (D1 = A); a post
is attached to at most one entry (D2 = A); an attachment takes effect at once,
and the AI or the Owner can take it off through the Admin MCP (D3 = A). The
authority is the
[2026-11-07 amendment](../governance/amendments/2026-11-07-timeline-posts.md),
which the Owner is asked to sign at merge. The `timeline-posts-v1` Issue holds
the scope and the frozen Behavior Matrix.

The earlier rules stand. A row's image comes only from its linked Catalog
record, and a post never replaces a missing one. The timeline shows no absence
wording. `GET /v1/community/timeline` answers as before: everything about posts
comes from new routes, so no existing strict response gains a field.

### What a user sees

Owner direction (2026-11-07, Issue #422), after seeing the 词条卡:

> 点开一个词条后应该悬浮展示卡片，背景做高斯模糊。如果有多个用户上传的卡片就做成左右滑动可以切换卡片，做成扇形切换的动画。右下角放上传按钮来让用户上传词条。点开某一个卡片后不要再显示上传

- **Card deck.** A row whose entry has a Catalog page, or posts, opens a deck of
  cards floating over the page, at every width; any other row opens
  the 词条卡 as before. The feed's counts list only rows with posts: once they
  are read for this reader since the last change of posts, a row missing from
  them has none and opens its 词条卡 at once. Only while they are pending, have
  failed or are stale does a row with no Catalog page and no count read its own
  total first (a page of one post), then open the deck or the 词条卡; meanwhile
  the row stays pressed and gently breathing (`aria-busy`), a second tap does
  nothing, and a failed read opens the 词条卡. The look is the 装裱 (mounted)
  design the Owner chose on 2026-11-08 from four explored directions, after
  rejecting the first one as not beautiful, badly proportioned and sitting too
  low. The page behind reads as frosted paper: the shared `.yoyi-blur-scrim`
  primitive in `packages/ui` blurs it under its paper veil
  (`.yoyi-blur-scrim-paper`, the page's own paper at 76%, light or dark with the
  theme; the veil doubles where the browser has no backdrop blur, and with
  reduced transparency or more contrast). The deck covers the whole window, a
  desktop's scrollbar gutter included, and the shell's dock and its create
  action are hidden while it is open, so no second 「+」 shows through the blur.
  The header's and the cue's words are ink on that paper with a soft halo of the
  page's paper behind them, which keeps the grey ink at 4.5:1 even over a dark
  patch of the page behind, in both themes. Over the cards stand the entry's
  full title (two lines at most, its first line level with the close button on
  phone and wide; on tablet × keeps the window's corner) and one quiet line
  of 年代 · 地点 · 保管, absent values left out, which a long holder's name may
  wrap to a second. Each card is a mounted work: a paper mount with a hairline
  ring and a layered soft shadow, the image in a 3:4 window cut into a 16 px
  mat, and a label in the mount under it, one serif line and the author, centred
  as a museum label. The Catalog card comes first (the row's image floating
  whole in the mount, never cropped, and its title, else its title as the cover,
  and 查看详情 after a small seal), then the posts in the list's order: cover or
  the grid's text cover, title (未命名作品 when untitled; a title already on the
  cover is not repeated), author, and the grid's 仅自己可见 or 暂不公开 mark on
  the reader's own hidden posts. With no Catalog page the posts come first, and
  a placeholder card holds their place while they load. A swipe, the round paper
  arrows beside the 「2 / 8」 cue or ←/→ from anywhere in the deck switch cards;
  an arrow at its end stays, dimmed, with the focus on it. The arrows stand in
  the cue's own row under the cards at every width, not beside the card: there
  they stood on the fanned neighbours, and on phone a screen reader needs them
  to reach every card. The neighbours fan out around a pivot below the deck (9°
  a card), smaller and receding under a layer of the page's paper inside each
  card, never by the card's opacity, so no words of a card behind show through
  the one in front, at rest or in a drag; a neighbour's label waits and fades in
  with the drag as its card comes to the front. Each turned card rises until its
  lowest corner is on the front card's bottom line, so no card ever reaches the
  cue's row. The card coming to the front passes over the one leaving, the cards
  follow the finger and settle, and a short swipe springs back. With reduced
  motion a switch is a quick cross-fade, the new front card fading in over the
  old one. The front card and two on each side show; one more on each side waits
  hidden under the outermost, and after a switch the cards of the window it left
  stay drawn until the move settles, so no card pops in or out, a jump of two
  included. 「2 / 8」 under them counts the cards, and each card's name
  says 「第 2 张，共 8 张」. The cue's row is held from the first frame, and a
  failure or a notice shows on a surface of its own out of the column's flow,
  over the cards' lower edge at every width, so the cards never move when the
  posts arrive; on a short viewport the title stays in view, and the deck never
  scrolls sideways. The group stands at the optical centre: the room is kept for
  a second title line and a second meta line, and a quarter of what one line of
  each leaves stands above the header (0.4 on tablet, 0.35 wide), never taking
  that reserve, so the card's centre sits at about 47% of an iPhone 17 Pro's
  Safari page (402 × 716), the cue's row in the thumb's reach and clear of the
  bottom edge either way. A phone card is 76% of the width (at least 60% of a
  375 × 548 page, where the gaps tighten), 340 at most; tablet 480, wide 420. A
  very short window (under 28rem: a phone held sideways, a squat laptop window)
  keeps the whole column, the cue's row and 「上传」 included: the title and the
  meta keep one line each, the mat narrows, the card's label gives way (its name
  stays the card's accessible name) and the card may shrink to 80 px. The posts
  page in as the reader nears the end: 6, then pages of 18. A tap on the Catalog
  card closes the deck and opens Catalog Detail; on a post card, that work's
  Detail. Back, Escape, × or a tap beside the cards fades the deck out briefly
  and gives the focus back to the row; a card or an upload that hands over to
  another view closes it at once. A round seal-red 「上传」 button ends the
  cue's row on phone, level with the arrows whatever the title's length, and
  keeps the window's bottom-right corner on tablet and wide, clear of the cards
  and of the cue; it opens「上传新帖子」(the upload below)
  and「关联我发过的帖子」 (the list below, in a sheet over the deck, which Back
  closes alone; the deck's × and 「上传」 are not drawn beside it meanwhile).
  The menu opens above the button over a light paper veil on the deck, so it
  reads as a layer above the card label it may cover, and is a Back step of its
  own: Back, Escape, Tab or a tap outside closes only the menu. A guest reaches
  sign-in from either, and browse-only shows no button. The button belongs to
  the deck: a card that opens takes it away.
- **词条卡.** Opened by a row with neither a Catalog page nor posts. Under the
  facts, 「上传这件碑帖」 and the caption「发布后会出现在这个词条下。」, which
  is also the empty state. Below it, the entry's posts as a 3-column grid of
  square covers, newest attachment first: 6, then 「全部 N 篇」, then pages of
  18 in the same sheet. A tap opens Work Detail. The author's own posts that
  others cannot see carry the profile works grid's mark on their
  cover: 仅自己可见 for a self-only work, 暂不公开 for a pending, hidden or
  removed one. A failed read shows 「帖子载入失败」and 重试. Under the
  grid,「关联我发过的帖子」 lists the reader's own works to pick one. Each pick
  is checked on its own when it is chosen, through
  `content/work/{id}/timeline-entry`: a work already on another entry
  asks「已在：X。改为关联到「Y」？」 before it moves, and a work already on this
  entry writes nothing. There is no batch route, so the list itself shows
  no「已在」 mark.
- **Upload.** 「上传这件碑帖」, and the deck's 「上传新帖子」, close the card or
  deck and open a new-work editor with 关联词条 set to that entry. 作品性质 is
  not chosen for the author. A guest reaches sign-in, and a browse-only layout
  shows no upload or attach button. When an unfinished new-work session exists,
  the editor opens that session and the tapped entry wins: it becomes the
  session's 关联词条 as an author edit, saved like any other choice, and the
  rest of the draft stays as it was. The same holds for the deck
  that 收录于 opens. The tap is spent once it is applied: the editor's history
  entry and the session's own target drop the entry, so a reload (a phone tab
  the browser restored included), Back then Forward, or 返回正在编辑的作品 never
  applies it again over the author's later choice. An unfinished Thread quick
  composer post (参与话题) takes no entry, so a tap that finds one
  shows「还有一项编辑没有结束」, as any other open edit does: the author returns
  to that post as it was, or saves and ends it first. The entry is never dropped
  unseen.
- **Catalog Detail.** A row that links a record opens its deck, whose first card
  opens Detail. A record that a visible row links shows a 帖子 section in every
  Detail layout, loaded after the Detail has painted: its heading, the posts
  grid and 「全部 N 篇」, with no 「上传这件碑帖」, caption
  or「关联我发过的帖子」, because a card the deck opened shows no upload (Owner,
  Issue #422: 「点开某一个卡片后不要再显示上传」). A post starts from the
  deck's「上传」 or the 词条卡. A record with no such row shows nothing, and
  with nothing left to offer, neither does an entry with no posts: the section,
  its heading and the desktop band are drawn only once posts are known (a failed
  read still says so, with 重试).
- **Publishing.** New works and their drafts get a 关联词条 row after 可见范围:
  on phone in the publish screen, on desktop in the text settings. Its picker
  searches the cached timeline locally (every word must match, 50 results at
  most) and takes one entry; 不关联词条 clears it. The choice is saved,
  autosaved and restored with the draft. Editing a published work shows no such
  row, and neither does the Thread quick composer (参与话题): a post written
  there never sends `timelineEntryId`.
- **Work Detail.** The author's management menu gains 关联词条, the same picker,
  which takes effect at once. A work on a visible entry
  shows 「收录于 · 题名」under its title for everyone, read after the Detail has
  painted; a tap opens that entry's deck, and only that tap reads the whole
  timeline. The line shows only for a work its reader can read, which the
  entry's posts hold by the same rule, so it always opens the deck. The picker
  opens with the focus on its search; closing it without a change gives the
  focus back to 关联词条, and a change to the result line. The same holds for
  the desktop text settings' picker (back to 选择词条 or 更改) and
  for 「关联我发过的帖子」, whose list takes the focus on its title.
- **Rows.** On phone, 「N 篇帖子」 takes the place of 保管 at the end of the
  meta line. On tablet and wide, a small count follows the name inside its
  two-line clamp, and the row-height estimate includes it. 0 shows nothing.
  Counts are read after the list, for each viewer, and the reader keeps its row
  when they arrive. A 年代不详 row shows its count like any row; group members
  show none.

Who sees which posts follows the shared Work read rule (`workVisibleTo` in
`services/community-postgres/src/work-dto.ts`): public works for everyone, and
the viewer's own self-only, pending or removed works outside the recycle bin.
One predicate serves the list, the counts and a work's entry, so a row's count
always equals that viewer's list, blocks included. The entry route checks the
Work read first by the same rule: a third party asks only about a public work,
and an author about an own work the list shows them, one an operator hid or
removed included, so Work Detail can take a hidden one off its entry. A work
that becomes hidden, removed, trashed or deleted, or whose author is suspended,
leaves at the next read with no write. A hidden entry's posts leave with it, and
come back when it is shown again.

### The table

Migration `20261107010000_timeline_entry_posts.sql` adds
`community.timeline_entry_posts`, one row per post: the post's work, the entry
it is attached to while it is attached, its state (`attached`, `detached` by its
author, `withheld` by an operator), the entry an operator last withheld it from,
who attached it and its version. A move, a detach and a withhold are updates,
and no row is deleted. Every change raises the version, so an operator's
compare-and-set sees an author's change too.

An author takes a post off by detaching it. An operator takes one off by
withholding it, and the row records the entry it was withheld from
(`withheld_entry_id`). That record blocks an author re-attach to that entry
only: the author answers `timeline_entry_withheld` there, and may attach the
post to any other entry. Only the most recent withhold is remembered. An
operator attach to that entry lifts the withhold, and an author's detach of a
withheld post keeps it withheld.

A work's permanent deletion detaches its attached row in the same transaction:
by its author, by the purge of a deleted account, or by the recycle bin's purge
when its retention ends. The row turns `detached`, with no entry, its version
raised and `updated_by` `author`. An erased post therefore never shows, never
counts and never holds an import back. A detached or withheld row stays as it
is. The two purges run in the media worker in Production. This release leaves
the worker on its current build, so there they detach only once the worker runs
this code; until then such a row stays attached, never shows or counts, and the
import refusal counts it.

Every writer locks in one order: the work `FOR UPDATE`, then the entry
`FOR SHARE` while it is visible, then the post row. Operator writes and the
import also hold the shared content-operator lock, so they never overlap each
other. The entry lock holds off an operator hiding the entry, and the import
replacing it, until the write ends; the import then sees the attach, and refuses
a file that drops its entry. An attach that waited for an import locks its entry
again once the import has committed, so it ends as if it had started after the
import: on the row that replaced its entry, or with `timeline_entry_unavailable`
when the file dropped it. No pair of writers deadlocks: PG16 tests race an
author attach with an operator write, and with the import, in both orders.

### Public routes

All four are private and never cached. The three reads sit behind the product
access gate like the other community reads.

| Route                                                         | What it answers                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/community/timeline/post-counts`                      | `{counts}`: for each visible entry with at least one post this viewer may see, how many. No query string                                                                        |
| `GET /v1/community/timeline/{entryId}/posts`                  | A page of that viewer's posts on a visible entry, newest attachment first, as `AuthorPage<UserWork>`; `page` and `pageSize` only. An unknown or hidden entry answers 404        |
| `GET /v1/community/content/{type}/{id}/timeline-entry`        | `{entry: {id, title, fullTitle} \| null}`: the visible entry a work is attached to, or the visible row that links a Catalog record. A target the viewer may not see answers 404 |
| `POST /v1/community/publishing/works/{workId}/timeline-entry` | `{requestId, entryId \| null}` attaches an own work, moves it or takes it off; answers `{workId, entryId, version}`, with version 0 while the work has no row                   |

`post-counts` is also a valid entry id, so it is reserved: no
`timeline/{entryId}` route may be added beside it.

The author command runs as author action `publishing.work.timeline_entry`. It
takes effect at once and writes no revision. A lost answer is safe to retry with
the same `requestId`, and asking for what is already true writes nothing and
keeps its receipt.

A new work can be attached at submission: `timelineEntryId` on the submission
command creates the work and its attachment in one transaction. The editor keeps
the entry in its draft content and moves it from the content onto the command at
submission, for a new work only. Submitted content refuses the field, so it
never reaches a revision. A draft that carries an entry submits with no conflict
copy, because the draft comparison leaves the entry out.

Refusals answer 422 with the failure code, and change nothing:

| Code                         | When                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `timeline_entry_unavailable` | The entry is unknown or hidden                                        |
| `timeline_entry_conflict`    | A submission for an existing work names an entry; it uses the command |
| `timeline_entry_withheld`    | The author attaches a post to the entry an operator withheld it from  |
| `work_unavailable`           | The work is in the recycle bin or removed                             |

Another author's work, or an unknown one, answers 404.

### Operator side of timeline posts

The Owner and the AI read and change posts through two operator routes and two
Admin MCP ops, both on the `community` credential. Each op is also an Owner
route, `POST /api/community-moderation/<route>`.

| Op                              | Tool            | Backend route                                      | What it does                           |
| ------------------------------- | --------------- | -------------------------------------------------- | -------------------------------------- |
| `community.read-timeline-posts` | `admin_read`    | `GET /internal/community/timeline-posts`           | A filtered page of post rows           |
| `community.set-timeline-post`   | `admin_execute` | `POST /internal/community/timeline-posts/{workId}` | Attach, move, take off or withhold one |

- **`read-timeline-posts`.** Filters `entryId`, `workId`, `authorId`, `state`,
  `attachedBy`, `from` and `to`, all optional; pages of 20 by default and 50 at
  most, newest change first. `entryId` matches posts attached to that row and
  posts withheld from it; `from` and `to` bound the row's last change. Rows
  carry the work id, the title marked untrusted, the work's state, whether it is
  public, the author, the entry, the state, the writers, the version and the
  times. The AI never reads a self-only work here: it is left out of the page
  and of the total. There is no count view.
- **`set-timeline-post`**, with `{requestId, expectedVersion, entryId, state?}`.
  `expectedVersion` 0 means the work has no row yet. `entryId` attaches a public
  work by an active author to a visible row, or moves it there; an operator
  attach of the row the post was withheld from lifts that withhold.
  `entryId: null` takes the post off; with `state: "withheld"` its author also
  cannot attach it to that row again, and may attach it to any other. A wrong
  version answers 409 `STATE_CONFLICT`. A refusal answers 422 with
  `WORK_NOT_PUBLIC`, `ENTRY_UNAVAILABLE` or `POST_NOT_ATTACHED`, and changes and
  records nothing. A request for what is already true writes no event and
  answers AI `ALREADY_SET`. An AI write on a self-only work answers
  `SELF_ONLY_OWNER_REVIEW` before it runs.

Each write runs in the timeline's receipted command: the AI's lock wait limit,
the shared content-operator lock, one `content_operator_events` row with action
`timeline.post`, content type `work` and the work id, and one receipt. A lost
answer replays. Because the event names the work, the work's erasure also
empties that event and receipt, and a replay of an emptied receipt answers
`NOT_FOUND`. Admin targets the write by the work id and echoes the work id, the
title marked untrusted, the state, the version and whether the post is public.
The entry id is in neither the answer nor the Admin audit, by the rule above for
timeline writes.

`community.read-timeline` rows carry `postCount`, and the summary carries
`posts: {total, entries}`. Both count only public posts (a public work by an
active author, attached), the same for the Owner and the AI, so no count shows
that a self-only post exists. They include posts on hidden rows, because the
operator list shows those rows. `posts=with|without` narrows the rows by that
count; the Admin sends it only when it narrows. The count is on the list rows
only: a create or update answer, and its stored receipt, keep the row shape they
had.

Moderation of the posts themselves is unchanged: `moderate-work`,
`moderate-work-submission` and `decide-report` apply as before. An operator
withhold does not notify the author, who sees 收录于 disappear.

### Grants, preflight and import

`grant-runtime.sql` gives the runtime role, in blocks that skip an earlier phase
without the table: `SELECT`; `INSERT` on `work_id`, `entry_id`, `attached_by`,
`updated_by`, `attached_at` and `updated_at`, so `state` and `version` come from
their defaults and stored times come from the Backend's clock; `UPDATE` on every
column except `work_id`; and no `DELETE` or `TRUNCATE`. It first revokes any
table-level `INSERT` or `UPDATE`, so a re-run converges on the column grants.
The App role is shared with the operator bridge and the media worker. Once the
worker runs this code it writes these columns in one place: the account purge
and the recycle bin's purge detach a deleted work's row, with the same update as
an author's deletion.

App-role preflight for timeline posts, read-only, after the grants. Every column
must be true:

```sql
SELECT
  has_table_privilege(:'app_role', 'community.timeline_entry_posts', 'SELECT') AS reads,
  bool_and(has_column_privilege(:'app_role', attrelid, attnum, 'INSERT')
    = (attname IN ('work_id', 'entry_id', 'attached_by', 'updated_by',
      'attached_at', 'updated_at'))) AS creates,
  bool_and(has_column_privilege(:'app_role', attrelid, attnum, 'UPDATE')
    = (attname <> 'work_id')) AS edits,
  NOT has_table_privilege(:'app_role', 'community.timeline_entry_posts', 'DELETE') AS no_delete,
  NOT has_table_privilege(:'app_role', 'community.timeline_entry_posts', 'TRUNCATE') AS no_truncate,
  has_any_column_privilege(:'app_role', 'community.timeline_entries', 'UPDATE') AS locks_entries,
  has_column_privilege(:'app_role', 'community.author_events', 'action', 'INSERT') AS events,
  has_table_privilege(:'app_role', 'community.author_command_receipts', 'SELECT')
    AND has_table_privilege(:'app_role', 'community.author_command_receipts', 'INSERT') AS receipts
FROM pg_attribute
WHERE attrelid = 'community.timeline_entry_posts'::regclass AND attnum > 0 AND NOT attisdropped;
```

`locks_entries` is there because an attach holds its entry with `FOR SHARE`,
which needs `UPDATE` on some column of the entry table. The operator writes also
use the event and receipt grants that the timeline preflight above checks.

The entry key is checked at commit, so an import that deletes and re-inserts an
id keeps the posts attached to it. An import whose file drops a row that holds
attached posts is refused, with counts only (rows and posts), and changes
nothing: keep the row, or take its posts off first. `--replace-operator-edits`
does not override it. The check runs after the replacement, inside the import's
transaction, where it holds every replaced row, so no author attach can land on
a dropped id before it ends. Posts that are detached or withheld name no entry
and never hold an import back, and neither does an erased post, whose erasure
detached it. On a database without the posts table the import skips the check;
`TIMELINE_MIGRATION_ID` stays the same.

### Release order

One release carries Backend, Admin and Web; the issuer and the media worker are
unchanged. The worker's two purges detach a deleted work's post once the worker
runs this code, at its next release (see the table above).

1. **Migrate.** `pnpm db:migrate:community` applies
   `20261107010000_timeline_entry_posts.sql` with the migration authority. The
   running release starts with it applied: it reads no new relation.
2. **Grants.** Re-apply the runtime grants with the setup role, in one
   transaction, as in step 2 of the timeline's
   [Production order](#production-order).
3. **Preflight.** Run the App-role preflight for timeline posts above, and the
   release preflight in
   [`admin-mcp-completion-v1.md`](admin-mcp-completion-v1.md), whose
   `community.timeline_entry_posts` row reads null before step 1. Startup does
   not probe these grants.
4. **Restart** the Backend, then the Admin, then the Web, on the tagged release.
   The Owner routes parse the operator list and summary strictly, so the Backend
   and the Admin ship and roll back together: between their restarts the Owner's
   `read-timeline` and `read-timeline-summary` answer
   `OPERATOR_RESPONSE_INVALID`, and a new Admin on an old Backend breaks
   `read-timeline` on both paths. The AI path drops keys it does not know.

The import is not run. The commit merged for this release raises
`ADMIN_MCP_CONTRACT_VERSION` to `2026-11-07.2`, the second release that day
after step one's `2026-11-07`, because the new ops change what a client sees.
The community AI credential is already placed, so AI access to posts starts with
step 4.

An older Web tab keeps working on every existing response. It cannot open a
draft that a newer tab saved with an entry, because the draft schema is strict,
until it reloads; the release notes say so.

**Rollback.** The new table is additive: the previous release starts with it and
leaves it unused, and the attachments stay. Stored drafts are not: the previous
Backend parses draft content strictly, so a draft saved with 关联词条, and the
history of any draft or edit whose lineage holds such a snapshot (a work
published from that draft included), would fail to open. Before the runtimes
(Backend, Admin and Web) return to the previous release, take the key out of
stored drafts and their history, once, with the setup role, in one transaction.
Those drafts lose their chosen entry; the author picks it again.

```sql
UPDATE community.work_drafts
SET content = content - 'timelineEntryId',
  content_sha256 = encode(sha256(convert_to((content - 'timelineEntryId')::text, 'UTF8')), 'hex')
WHERE content ? 'timelineEntryId';
UPDATE community.work_draft_snapshots
SET content = content - 'timelineEntryId'
WHERE content ? 'timelineEntryId';
```

The previous release does not detach a deleted work's post. A work deleted while
it runs, by its author, an account purge or the recycle bin's purge, keeps its
row attached, and an import that drops that entry is refused for it. Once this
release runs again, detach those rows once, with the setup role:

```sql
UPDATE community.timeline_entry_posts p
SET state = 'detached', entry_id = NULL, updated_by = 'author',
  version = p.version + 1, updated_at = now()
FROM community.works w
WHERE w.id = p.work_id AND p.state = 'attached' AND w.deleted_at IS NOT NULL;
```

### Not built, and why

- **More than one entry per post** (D2 option B): an additive migration that
  changes the primary key, and a picker with several choices.
- **Review of each attachment before it shows** (D3 options B and C): a new
  queue op.
- **Telling an author about a withhold.** The author sees 收录于 disappear.
- **A batch route for an 「已在：某词条」 mark in the list of my works.** Not
  built, by decision: the picker checks each pick when it is chosen and asks
  before a move.
- **Counts on group members.** The design did not draw them.
- **The deck reopening at its card.** Back from a Detail the deck opened returns
  to where the deck was opened, the timeline row or the work's 收录于 line, with
  the deck closed; reopening it at the same card was left optional.
- **A blur for Chromium's software compositor.** Where Chromium composites in
  software at a device scale over 1 (a desktop Chrome or Edge whose GPU is
  blocklisted or has crashed, some virtual machines and remote desktops), a
  full-window backdrop blur leaves a band of about 30–60 px along the right and
  bottom edges unblurred, so the page shows through there under the paper veil.
  No CSS works round it, and Android Chrome, Android WebView, desktop Chrome on
  a GPU and iOS Safari blur the whole window. Playwright's default headless
  shell composites in software, so screenshots of the deck launch Chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader` (GPU compositing on
  SwiftShader) or `channel: "chromium"`.
- **Every withheld entry.** The row keeps only the latest.
- **A `timeline_post` record type for `admin_find` and `admin_get`.** After the
  S10 record descriptors; `read-timeline-posts` filters by work, entry and
  author.
- **Hard delete of a timeline row** still waits for #355 S8b, and must handle
  the row's attached posts: the entry key refuses deleting a row that still
  holds them.
