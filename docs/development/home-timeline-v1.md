# Home timeline — Issue #384 r2

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

Issue #384 is the authoritative scope: its allowed modules, its non-goals and
its restrictions. The main non-goals are linking user posts to entries, any
Catalog field or record change, a new Payload collection, an Admin editor for
rows, and Apple or Harmony clients.

## Why a read-only table and not Catalog fields

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

This is reference data, not a second editable content master. Rows change only
through `scripts/import-timeline.mjs`, which is dry-run by default and validates
against `timelineImportFileSchema`. A linked row takes its publication and media
rules from the existing Catalog projection; a row whose record is not published
stays text-only and unlinked.

## Behavior Matrix

The frozen Behavior Matrix is in Issue #384 and wins over tests. It covers rows
present, linked, unpublished and unlinked rows, the unavailable message, old
links, scroll and Detail return, viewer identity and the QA scenarios
`timeline-demo` and `timeline-unavailable`, which replace `nearby-demo` and
`nearby-unavailable`.

## Delivery

This task stops at a local preview for Owner phone acceptance, because it is a
presentation change. The PR stays Draft until the Owner accepts it on a device.

Production release, migration and import are separate Owner gates. Before them,
the Owner still has to review the lower-confidence dates in the private dataset.
The import file stays in the private task directory, never in Git, the Web
bundle or the Issue.

The contract change means Web and Backend ship together; a Web-only release
cannot carry it. `main` is ahead of the last Production tag, so the release must
account for what else that carries.

## Production order

1. **Migrate.** `pnpm db:migrate:community` applies
   `20261104010000_timeline_entries.sql` with the migration authority.
2. **Grants.** Re-apply the runtime grants with the setup role, in one
   transaction:
   `psql -X -v ON_ERROR_STOP=1 --single-transaction -v app_role="$APP_RUNTIME_ROLE" -f infra/development/work-publishing/grant-runtime.sql`.
   It gives the runtime role `SELECT` on `community.timeline_entries`. Confirm
   with
   `SELECT has_table_privilege('<runtime role>', 'community.timeline_entries', 'SELECT')`,
   because startup does not probe this grant: a missed one shows only as this
   feed being unavailable.
3. **Import.** Run `node scripts/import-timeline.mjs --file <absolute path>` as
   a dry run and read its counts per chapter, on-axis and linked. Then repeat it
   with `--apply`, which replaces all rows in one transaction. It reads
   `APP_MIGRATION_DATABASE_URL`, refuses a relative path or a missing migration
   ledger entry, and prints no row content or connection string.
4. **Restart.** Restart Backend and Web on the tagged release. A Backend
   restarted before step 1 fails closed on its community ledger check.

A withdrawn Catalog record loses its link and image on the next read, and its
row stays as text. To remove the row as well, for a rights request for example,
take it out of the file and run the import again.

If the table is missing or empty, or the read fails, the feed
shows 时间轴暂时不可用 / 请稍后再试。 and the other feeds are unaffected.
