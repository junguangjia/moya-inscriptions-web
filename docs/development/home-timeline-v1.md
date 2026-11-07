# Home timeline — Issue #384 r3

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
rows, and Apple or Harmony clients.

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

## Behavior Matrix

The frozen Behavior Matrix is in Issue #384 and wins over tests. It covers rows
present, linked, unpublished and unlinked rows, the unavailable message, old
links, scroll and Detail return, viewer identity and the QA scenarios
`timeline-demo` and `timeline-unavailable`, which replace `nearby-demo` and
`nearby-unavailable`. r3 adds rows for the five ops, the import guard, hidden
rows, command text the store cannot hold, and a stored row that fails the
contract. The amendment carries the same rows.

## Delivery

r2 stopped at a local preview for Owner phone acceptance, because it is a
presentation change. r3 changes no presentation: the public read only leaves out
hidden rows. The Owner's device acceptance of r2 therefore carries forward, and
the review checks that the Web is unchanged. r3 adds a migration delta and
grants, so the PR stays Draft until an independent review of the exact head, and
the Owner signs the amendment at merge.

Production release, migration and import are separate Owner gates. Before them,
the Owner still has to review the lower-confidence dates in the private dataset.
The import file stays in the private task directory, never in Git, the Web
bundle or the Issue. Development and tests use synthetic rows, so the private
dataset never goes through MCP before the Production import.

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
