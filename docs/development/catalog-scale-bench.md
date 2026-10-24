# Catalog scale bench

Task `catalog-scale-v1`, Issue #323, increment 1B slice W0. A deterministic
synthetic Catalog of any size, and a local bench that measures the read path and
the media worker on it. The later 1B slices (W1–W10) compare against the
baseline below. The bench runs locally only; CI runs just the reduced smoke
test.

## Files

- `tests/integration/postgres/catalog-scale-fixture.ts` is the generator. It
  creates one synthetic database with three roles, each holding only its
  Production grants: the App runtime role, the public reader of `catalog_media`
  and the prepare reader of the two private prepare views. The 25k shape
  (`CATALOG_SCALE_25K`) is 3,600 published records × 7 images, with 3,000
  released, 15,000 ended and 500 live intents; it seeds in about 30 s. Of the
  ended intents, 200 (`recentEndedIntents`) ended 1–48 hours before the seed,
  inside R (`CATALOG_PREPARE_RETENTION_HOURS`, 96 h): 15,000 intents ending at
  an even rate over the ten months since the fixture's epoch put about 200 in
  any 96 hours. The other 14,800 ended at the epoch. Each recent one is a later
  draft (revision 3) of a record published at revision 2, so no release of a
  later revision precedes its end. Its lease follows from its end, as the CMS
  writes one: prepared an hour before it was cancelled, superseded or withdrawn,
  or a whole 24-hour lease before it expired. The ones that ended at the epoch
  keep the epoch as their creation time too. That history is compressed, but no
  reader compares an ended intent's creation or lease with its end: the live
  projection tests only the end. The seed fills both sides with set-based SQL:
  - the CMS: Payload-shaped tables under the real view text, the delivery
    intents of CMS migration `20261020_160000`, and both prepare views of M2
    (`20261024_000000`): the full `catalog_delivery_prepare_media` and the live
    projection `catalog_delivery_live_prepare_media`, which lists every released
    intent and every other intent that ended or expired within R;
  - the App: assets, renditions, published generations and the intent mirror. An
    intent the live projection lists is observed live. One it no longer lists
    (the 14,800 old ended intents) is a tombstone, as the sync leaves an absent
    intent.
- `tests/integration/postgres/catalog-scale-fixture.test.ts` is the CI smoke
  test, at 75 images. The seed is a fixed point of this head's worker: a sync of
  the live projection changes no mirror row (except its observation time), asset
  or job, and reconcile schedules nothing. The test checks the rows before and
  after, and checks the CMS history above. The worker's snapshot reads
  `liveIntents` intents in `livePrivateRows` rows (3,700 intents in 24,700 rows
  at 25k; the full view holds 18,500 in 39,500).
- `tests/integration/postgres/catalog-scale-bench.ts` and
  `catalog-scale-bench.config.mts` are the bench. No suite collects them.
- `tests/integration/postgres/catalog-scale-indexes.ts` (W6) plans, at the 25k
  fixture, the statements that App migration A1 and CMS migration M2 index, and
  asserts their plans. The bench config runs it too; no suite collects it. CI
  plans the same statements in `catalog-publication-scope.test.ts`, on a
  700-image Catalog with 20,000 ended intents, where the planner picks each
  index itself in about 7 seconds.
- `tests/integration/postgres/catalog-scale-reconcile.test.ts` (W7) runs the
  scoped reconcile on the fixture in CI. With
  `MOYA_CATALOG_SCALE_RECONCILE_IMAGES=25200` it also runs its 25k gate: one
  sweep pass and one dirty pass, every reconcile statement planned as it ran
  (EXPLAIN ANALYZE, rolled back), none JIT-compiled.
- `tests/integration/postgres/catalog-membership.test.ts` (W8) runs the
  membership step on the fixture in CI, and at 25k with
  `MOYA_CATALOG_MEMBERSHIP_IMAGES=25200` (about 5.5 minutes).
- `tests/integration/postgres/catalog-dirty-lock-order.test.ts` (the wave C
  integration) holds one writer of the dirty queue where the other lock order
  would wait on it, and requires both to commit (no 40P01).
- `tests/integration/postgres/catalog-render-queue.test.ts` (W9) runs the render
  tiers on the fixture's roles in CI: one pass's claim order, the queue target,
  a backlog write that fails after the commit, W-AC10's 50 records (leases a
  minute apart, all in the snapshot from the first pass), records that arrive
  pass by pass behind re-renders already queued, and an intent's images ready
  under an older recipe: re-rendered in the intent's tier (a prepared record's
  before more published re-renders than the target, a published image a
  requested intent names in t1, a grace member in t3), while a re-render only
  the published list names stays behind the gate (t4). With
  `MOYA_CATALOG_RENDER_IMAGES=25200` it also runs its 25k gate: one sync pass
  through the worker's snapshot, every App statement planned as it ran (EXPLAIN
  ANALYZE, rolled back), none JIT-compiled, each under a cost of 100,000 and 2 s
  (about 40 seconds with the seed).
- `tests/integration/postgres/catalog-render-grace.test.ts` (W10) runs render
  grace on the real clock (W-AC9), and that a cancelled, superseded or withdrawn
  intent is never in grace and a newer intent ends it whatever its state, and
  `tests/unit/backend/catalog-render-grace.test.ts` holds G at least 24 hours
  inside R, and the App's R equal to the R of CMS migration M2.

## Run

```sh
set -a; . <task resources.env>; set +a   # loopback disposable TEST_DATABASE_URL
pnpm -w exec turbo run build --filter=@moya/tests^... --filter=!admin
cd tests
MOYA_CATALOG_SCALE_BENCH_OUTPUT=/absolute/path/bench.json \
  pnpm exec vitest run --config integration/postgres/catalog-scale-bench.config.mts
```

Add a file name filter to run one file: `catalog-scale-bench` for the bench,
`catalog-scale-indexes` for the index plans (about 45 seconds, no output file;
it prints its plans when it ends).

Options:

- `MOYA_CATALOG_SCALE_BENCH_SCENARIOS=1k,25k` selects scenarios.
- `MOYA_CATALOG_SCALE_BENCH_REPEAT` sets the read repeats (default 5).

Output:

- `bench.json`: per role, statements and timings, plus the slowest statements
  and EXPLAIN ANALYZE plans.
- `bench.txt`: a summary.

Some details and plans find a statement by its SQL text. If no statement
matches, the detail is `null` and the plan is `statement not found`. Neither is
ever 0. This can mean the statement did not run, or that a later wave rewrote
it. In the second case, update the matcher in `catalog-scale-bench.ts` along
with the statement. A statement that ran and changed no row reads 0.

The matchers as of wave C (W1–W8):

| Detail or plan                  | Statement                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| plan `listing.*`                | `DECLARE catalog_published_sources NO SCROLL CURSOR FOR` the published listing                                   |
| plan `snapshot.privateRows`     | `DECLARE catalog_private_snapshot NO SCROLL CURSOR FOR SELECT * FROM public.catalog_delivery_live_prepare_media` |
| `sync.*` `mirrorRowsRead`       | `SELECT * FROM community.catalog_delivery_prepares WHERE observed_live UNION ALL `                               |
| `sync.*` `mediaRefRowsRead`     | `SELECT intent_id,ordinal,… FROM community.catalog_delivery_media_refs WHERE intent_id=ANY(`                     |
| `sync.*` `mirrorRowsAdvanced`   | `UPDATE community.catalog_delivery_prepares p SET source_state=`                                                 |
| `sync.*` `mirrorRowsAdded`      | `INSERT INTO community.catalog_delivery_prepares (intent_id,`                                                    |
| `sync.*` `mirrorRowsTombstoned` | `UPDATE community.catalog_delivery_prepares SET observed_live=false`                                             |
| `plans` `inspections`           | `SELECT * FROM community.catalog_delivery_prepares WHERE intent_id=$1 FOR SHARE` (a count)                       |
| plan `plans.publicReady`        | `SELECT DISTINCT r.id,a.media_id,a.source_object_key`                                                            |
| `reconcile` detail and plan     | `WITH desired AS (`                                                                                              |
| plan `readiness`                | `SELECT * FROM public.catalog_delivery_prepare_media`                                                            |
| plan `acquire.assetRow`         | `SELECT id,media_id,source_object_key FROM community.catalog_media_assets WHERE id=ANY(`                         |
| plan `acquire.knownIntents`     | `SELECT DISTINCT asset_id,intent_id FROM community.catalog_delivery_media_refs`                                  |
| plan `acquire.selector`         | `SELECT DISTINCT r.id,a.media_id,a.source_object_key`, in the acquire's own statements                           |
| plan `fence.current`            | `catalogLiveIntentRowsSql`: `SELECT * FROM public.catalog_delivery_live_prepare_media WHERE intent_id=ANY(`      |

`plans` measures `wholeCatalogCopySet()` in
`tests/unit/backend/catalog-copy-set.ts`, the whole-Catalog plan (the old
`copyRenditionIds()`). Since W7 nothing in production runs it: the authority's
`planScope` plans each pass's scope of at most K assets, and the whole-Catalog
plan stays only as the tests' oracle (`planCatalogPermissions`). The `reconcile`
detail and plan are one scoped pass at the default K (1,000) and budget (14 s).
A job's `acquire` plans its own asset (`captureCatalogAssets`), so its three
`acquire.*` plans and its `fence.current` read are keyed by the asset and its
App-known intents. The `fence.current` statement is the capture's own private
read; the `SELECT DISTINCT intent_id,catalog_document_id,state,state_version`
read it replaced no longer runs.

The two cursor plans are EXPLAINed as the `DECLARE` the code runs, so the select
is planned as a cursor (for fast start, `cursor_tuple_fraction`), and EXPLAIN
ANALYZE runs it to the end. The `sync.*` details are each the rows of one
statement. They replace three details of the baseline, whose statements W4
removed:

- `mirrorRowsLockedForUpdate` (every mirror row read `FOR UPDATE`) is now
  `mirrorRowsRead`: only the rows a pass can change, the ones observed live and
  the snapshot's intents, without a lock. Since W7 these are two disjoint reads,
  `… WHERE observed_live UNION ALL … WHERE intent_id=ANY($1) AND NOT observed_live`,
  so each takes its own index on either major (see the W6 index plans).
- `mirrorRowUpdates` (one `UPDATE` per intent, changed or not) is now
  `mirrorRowsAdvanced`, `mirrorRowsAdded` and `mirrorRowsTombstoned`. Each is
  one set-based statement. The first two run only when a row changes, so a pass
  that changes nothing reads `null` for them; the tombstone statement always
  runs and reads 0 then.
- `mediaRefReads` (one read per intent) is now `mediaRefRowsRead`: one read of
  the stored members of every snapshot intent.

At `d51114c5` a full run took about 15 minutes on an Apple-silicon Mac, most of
it `plans()` in the 5k, 8k and `rows=20000` scenarios. At the wave A integration
the 10k–40k scenarios no longer stop at the old bounds, so their `plans()`,
reconcile and `acquire` each run every inspection first: the 25k scenario alone
took 59 minutes. Since W5 a job's `acquire` inspects only its own asset's
intents, and since W7 a reconcile pass inspects only its scope's; `plans()` (the
oracle) still inspects every one. Watch the run for stalls; each scenario's
timeout is one hour, which the 40k scenario may exceed. Vitest prints a
scenario's result only when the file ends, so watch the database (for example
`pg_stat_database.xact_commit` of the `csbench_*` database) rather than the log.

## Baseline at `d51114c5` (the 1A head)

Measured on local Docker PostgreSQL 18.4 / 16.15 on an Apple-silicon Mac. M1 is
applied (the keyed view) unless a row says fenced. Times are wall times, and the
CVM is likely slower (inferred). Each cell gives PG18 / PG16.

The stand-in `catalogs` table got the real table's indexes after this table was
measured. A second PG18 run with those indexes gave the same outcomes, statement
counts, Seq Scans and indexes in every scenario. The CMS reads (pair checks,
listing, snapshot) took about the same time. The App-bound `plans()`, reconcile
and `acquire` at 1k–8k differed by up to 2× between the two runs. They read the
CMS in only 5 statements, so the difference is likely run-to-run variance on a
shared machine (inferred). PG16 was not run again.

| Operation (statements)                | 1k                   | 5k                  | 8k                    | 10k–40k                  |
| ------------------------------------- | -------------------- | ------------------- | --------------------- | ------------------------ |
| pair check, k=100, keyed (1 CMS)      | 1.1 / 1.2 ms         | 1.1 / 1.1 ms        | 1.1 / 0.9 ms          | 1.0–1.7 ms               |
| pair check, k=100, fenced (1 CMS)     | 1.3 / 1.6 ms         | 1.4 / 1.4 ms        | 1.8 / 1.9 ms          | 3.1 / 2.4 → 5.5 / 6.4 ms |
| delivery facts, k=100 (1 CMS + 1 App) | 6.5 / 7.6 ms         | 8.6 / 7.5 ms        | 9.6 / 9.8 ms          | 8–11 ms                  |
| published listing (1 CMS)             | 1.6 / 1.7 ms         | 8.7 / 7.3 ms        | 15 / 13 ms            | `null`                   |
| snapshot (5 CMS + 4 prepare)          | 21 / 17 ms           | 93 / 84 ms          | 132 / 124 ms          | `null`                   |
| sync pass (App)                       | 0.3 / 0.3 s (887)    | 1.4 / 1.4 s (4,382) | 2.3 / 2.2 s (7,000)   | skipped                  |
| `plans()` (App)                       | 4.9 / 4.8 s (15,634) | 47 / 44 s (78,286)  | 114 / 119 s (125,185) | throws                   |
| one reconcile pass                    | 5.8 / 4.8 s          | 58 / 43 s           | 97 / 112 s            | throws                   |
| one job's `acquire`                   | 5.4 / 5.4 s          | 50 / 45 s           | 100 / 110 s           | throws                   |
| fence `current()` (1 prepare)         | 1.7 / 1.7 ms         | 6.8 / 7.2 ms        | 9.8 / 11.6 ms         | no lease                 |
| fence `authorized()` (+1 CMS listing) | 4.9 / 5.9 ms         | 26 / 22 ms          | 33 / 34 ms            | no lease                 |
| Admin readiness read                  | 51 / 39 ms           | 89 / 77 ms          | 111 / 127 ms          | 225 / 195 → 526 / 580 ms |

What the table shows:

- **The read path (1A) is flat.** On both majors, the keyed pair check uses
  `catalogs_media_media_id_lookup_idx`, with no Seq Scan from 5k images up. The
  fenced view (before M1) scans the table: about 8–9 ms by EXPLAIN at 40k. These
  plans come from the fixture's stand-in tables. They have the columns the views
  read and the real tables' indexes on those columns, but none of the other
  Payload columns. The gates for CMS plans run on Payload schema clones in
  `tests/cms`, not here: R7 in `catalog-media-keyed-reads.test.ts`, and the CMS
  plans of W-AC3 belong there too.
- **`plans()` grows faster than the Catalog.** Each run inspects every released
  or requested intent, at about 127 App statements per intent (123 inspections
  at 1k, 615 at 5k, 984 at 8k), and each statement gets slower as the Catalog
  grows. Every reconcile and every Catalog job's `acquire` runs `plans()` again.
  With no intents at all, the JS filter still takes about 5 s at 10,000 images,
  because it is O(sources × renditions).
- **Each sync pass rewrites the whole mirror.** It locks every mirror row
  `FOR UPDATE` and writes one `UPDATE` per intent, changed or not. 10,000
  intents take about 3 s.
- **The fence and readiness reads scan the private view.** `current()` and the
  readiness read run a Seq Scan on `catalog_delivery_intents`. `authorized()`
  also re-reads the whole published listing.

### Where `d51114c5` returns `null` or throws

Both majors give the same outcomes.

| Bound (code)                                                      | At the limit                                | One past                                                       | Effect                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Published list, 10,000 (`catalog.ts` `LIMIT 10001`)               | ok                                          | the listing is `null`                                          | The sync logs `skipped: incomplete snapshot`. `plans()`, reconcile and `acquire` throw `Catalog complete source unavailable`, so every Catalog publish and withdraw job fails. |
| Sync union, 10,000 (backend `catalog-delivery-intents.ts`)        | 9,993 + 7 live pairs: ok                    | 9,994 + 7: the snapshot is `null`                              | As above, although the listing alone is still fine. With the 25k proportions of live prepares, this bound is reached at about 8,800 published images.                          |
| Decoded intents, 10,000 (community `catalog-delivery-intents.ts`) | ok                                          | the sync throws `Catalog intent snapshot exceeds its bound`    | The sync rolls back with zero writes. `plans()` is unaffected.                                                                                                                 |
| Private rows, 20,000 (`LIMIT 20001`, decode bound)                | ok                                          | the snapshot throws `Catalog private source exceeds its bound` | The sync and `plans()` throw. Released media rows roughly equal published images, so 20,000 rows need over 10,000 ended intents: the intent bound stops the sync first.        |
| `publicReady` rows, 40,000                                        | 6,997 published + 3,003 mid recipe bump: ok | 40,004 rows: `plans()` throws `Catalog selector invalid`       | Each image has 4 rows, or 8 while its recipe bump is in progress. Above 5,000 published images, a full recipe re-render crosses this bound midway.                             |
| Store sources, 10,000 (`catalog-assets.ts`)                       | ok                                          | `TypeError`                                                    | Reached only by a direct call: the worker's union is `null` first.                                                                                                             |
| Reconcile selector, 40,000 ids (`publication.ts`)                 | ok                                          | `Catalog selector invalid`                                     | Reached only by a direct call: `publicReady` throws first, unless private-B pins add ids.                                                                                      |

Above 10,000 published images, the read path keeps working: Catalog, feed,
editorial and Article reads still succeed.

## At the wave A integration (W1–W4)

Measured on PG18.4 only, on `b6468cb4` plus the uncommitted wave A changes (the
report says `service tree clean: false`), in two runs: the 1k, 25k, `direct` and
every boundary scenario. The 5k–40k worker scenarios and PG16 were not run.
Statement counts and outcomes are deterministic; times are single runs.

The snapshot reads each side through a cursor in pages of
`CATALOG_SNAPSHOT_FETCH_ROWS` (5,000) rows. A side of n rows takes ⌊n / 5,000⌋ +
1 FETCHes, because a short or empty page ends it. So the snapshot runs 6 CMS
statements plus the published FETCHes (`BEGIN`, `clock_timestamp()`, `DECLARE`,
`CLOSE`, `pg_export_snapshot()`, `ROLLBACK`), and 5 prepare statements plus the
private FETCHes (`BEGIN`, `SET TRANSACTION SNAPSHOT`, `DECLARE`, `CLOSE`,
`ROLLBACK`). The published listing on its own connection runs 4 statements plus
its FETCHes.

| Operation                     | 1k                                             | 25k                                                          |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| published listing (CMS)       | 5 statements, 2.6 ms                           | 10 statements, 42 ms                                         |
| snapshot (CMS + prepare)      | 7 + 6 statements, 17 ms; 981 live private rows | 12 + 10 statements, 283 ms; 24,700 live private rows         |
| sync pass, no change (App)    | 15 statements, 42 ms; reads 147 mirror rows    | 15 statements, 0.88 s; reads 3,700 mirror rows               |
| `plans()` (App)               | 15,634 statements, 4.8 s; 123 inspections      | 394,101 statements, 1,111 s, then `Catalog selector invalid` |
| one reconcile pass, `acquire` | 4.9 s, 4.8 s                                   | 1,192 s and 1,206 s, then `Catalog selector invalid`         |

- **The snapshot follows live content, not history.** At 25k it reads 24,700
  live rows (3,700 intents) instead of the full view's 39,500 (18,500 intents).
  With 10,001 ended intents older than R and no others, it reads none. The
  cursor's plan is still a Seq Scan on `catalog_delivery_intents`, which filters
  every intent ever prepared: about 2 ms over 10,001 intents, 76 ms at 25k by
  EXPLAIN ANALYZE.
- **A sync pass that changes nothing writes no mirror row.** It reads only the
  mirror rows observed live (3,700 at 25k, none of the 14,800 tombstones), reads
  the stored members in one statement (24,500 rows), runs no advance or insert,
  and its tombstone statement changes 0 rows.
- **`plans()` still costs about 127 App statements per released or requested
  intent, and still reads every one before the selector.** W1 made the plan
  itself linear, but each inspection gets slower as the Catalog grows: about
  0.36 s each at 25k (3,100 inspections), against 0.04 s at 1k. The selector
  read that follows keeps its 40,000-row ceiling (W1's open W-AC7), so above
  10,000 published images (4 roles each) `plans()`, every reconcile and every
  Catalog job's `acquire` throw `Catalog selector invalid`, at 25k only after
  about 19 minutes of inspections each. They fail closed: reconcile publishes
  and withdraws nothing.

| Scenario               | `d51114c5`                                                                   | This integration                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `list=10000`           | ok                                                                           | ok: 40,000 selector rows                                                                              |
| `list=10001`           | the listing is `null`                                                        | listing, snapshot and sync ok; `plans()` throws `Catalog selector invalid` (40,004 selector rows)     |
| `union=10000/10001`    | ok / the snapshot is `null`                                                  | both ok                                                                                               |
| `intents=10000/10001`  | ok / the sync throws                                                         | both ok: the live projection lists none of the ended intents, and the mirror holds them as tombstones |
| `rows=20000/20001`     | ok / the snapshot throws                                                     | both ok: 7,000 live private rows, 1,000 inspections in about 100 s                                    |
| `selector=40000/40004` | ok / `plans()` throws                                                        | the same                                                                                              |
| `direct`               | store 10,000 / 10,001 sources and reconcile 40,000 / 40,001 ids: ok / throws | all four ok                                                                                           |

The listing and snapshot ceilings are now 200,000 sources and 400,000 live
private rows. No scenario reaches them; the unit suites cover them.

## A job's authority at wave B (W5 and A1's rendition index)

W5 plans a Catalog job's asset alone: its `acquire`, `current()` and
`authorized()` issue the same statements per role at 245, 2,100 and 25k images
(`catalog-scale-authority.test.ts`, which also gates their plans). One job's
`acquire` for a released record's image (7 images, so 28 pinned roles), in local
runs:

| Measured by                                                  | 5k     | 25k                                                      |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------- |
| W5, before A1's `media_publications_rendition` (PG18 / PG16) | 115 ms | 297 / 450 ms                                             |
| wave B integration, with the index (PG18 / PG16)             | –      | 44–45 / 43 ms (medians of 5 warm runs)                   |
| the same seed with the index dropped (PG18 / PG16)           | –      | 251–261 / 299 ms; the same 146 statements (with release) |

The PG18 ranges are two runs of the same seed; PG16 is PG16.15 in a disposable
container on the same Mac.

- **The capture and fence read by key.** The asset's row, its App-known intents,
  its exact pair and those intents' live rows cost 8–59 each, with no JIT, on
  both majors (W5's probe). The selector reads in batches of 250 assets: at 25k
  one batch costs about 33,700 on index lookups and takes 4.6 ms on PG16; 2,000
  pairs take 8 statements and 79 ms.
- **Inspection read every publication per pinned role until A1 indexed
  `rendition_id`.** `inspectCatalogDelivery` reads each pinned rendition's
  publications by `rendition_id` alone, 28 times per `acquire` here, and the
  partial live index (`media_publications_live_rendition`) holds only the
  publishing and published rows. It was a Seq Scan: cost 1,585 at 5k and 7,980
  at 25k (6.8 ms on PG18, 9.3 ms on PG16). With A1's plain index it is an Index
  Scan, cost 8, 0.1 ms and 10 shared blocks at 25k on both majors, with no JIT
  (6,722 blocks without it), so that `acquire` drops from about 250–260 ms to
  about 45 ms on PG18 and from about 300 ms to about 43 ms on PG16.
- **Inspection's sorted media lock is the one Seq Scan left, and bounded.** It
  scans `catalog_media_assets` below about 10k images (cost 454 at 5k) and
  probes `catalog_media_assets_identity_unique` above (about 824 at 25k).
- **Reconcile still planned the whole Catalog at wave B.** It no longer threw at
  25k: W5 measured about 1,033 s and about 3,100 inspection transactions for one
  pass, before the rendition index. W7 bounds it (see wave C below).

## Index plans of W6 (A1 and M2)

`catalog-scale-indexes.ts` at the 25k fixture, on PG18.4 with JIT on (an
Apple-silicon Mac, Docker). Single runs; blocks are shared blocks hit or read,
children included. On PG16.15 every plan, cost and block count is the same
within a few percent, except the mirror read with 20,000 more tombstones
(below); the cursor took 72–91 ms there and the App reads at most 5.3 ms. The
two rows of the inspection's rendition read were measured at the wave B
integration; on PG16.15 they have the same plans, costs and blocks (0.1 ms with
the index, 11.0 ms without). The rows marked W7 are the statements as W7 rewrote
them, measured at the wave C integration on PG18.4 only (single run); the W6
rows above them are the statements they replaced. The index names are those of
App migration `20261024010000_catalog_publication_scope` (A1) and CMS migration
`20261024_000000_catalog_delivery_live_prepare` (M2).

| Statement (role)                                   | Plan                                                              | Cost    | Time   | Blocks | JIT    |
| -------------------------------------------------- | ----------------------------------------------------------------- | ------- | ------ | ------ | ------ |
| snapshot private cursor (prepare reader)           | BitmapOr: `…_intents_state_ended`, `…_intents_expiry`             | 165,680 | 76 ms  | 952    | 8.5 ms |
| the same without M2's index                        | Seq Scan on `catalog_delivery_intents`                            | 166,389 | 68 ms  | 4,625  | 5.8 ms |
| the cursor, 59,200 more old ended intents (77,700) | BitmapOr, as above                                                | 169,840 | 66 ms  | 946    | 7.5 ms |
| the same without M2's index                        | Seq Scan                                                          | 183,514 | 86 ms  | 19,425 | 6.0 ms |
| sync tombstone (App)                               | Bitmap Index Scan on `catalog_delivery_prepares_observed_live`    | 950     | 1.2 ms | 178    | no     |
| sync mirror read (App), W6: one `OR` read          | Seq Scan on `catalog_delivery_prepares` (772 pages)               | 1,498   | 3.7 ms | 775    | no     |
| the read, 20,000 more tombstones                   | BitmapOr: `…_observed_live`, `…_prepares_pkey`                    | 2,567   | 1.9 ms | 370    | no     |
| W7: two disjoint reads (`UNION ALL`)               | Bitmap Index Scans: `…_observed_live`, `…_prepares_pkey`          | 2,368   | 2.2 ms | 429    | no     |
| W7, 20,000 more tombstones                         | the same                                                          | 4,182   | 2.3 ms | 528    | no     |
| reconcile in-flight, 3 withdrawing (App), W6       | Index Only Scan on `media_publications_in_flight`                 | 17      | 0.0 ms | 14     | no     |
| W7: with `allow`, no pending mark, no active job   | Index Scan on `media_publications_in_flight`, anti-joins by index | 18      | 0.1 ms | 26     | no     |
| reconcile pending marks, 1,000 of 25,200 (App), W6 | Index Scan on `catalog_publication_dirty_pending`, no Sort        | 102     | 0.1 ms | 33     | no     |
| W7: no active job                                  | Index Only Scan on `catalog_publication_dirty_pending`, no Sort   | 119     | 0.3 ms | 35     | no     |
| inspection's rendition publications read (App)     | Index Scan using `media_publications_rendition`                   | 8       | 0.1 ms | 10     | no     |
| the same without A1's rendition index              | Seq Scan on `media_publications`                                  | 7,981   | 7.1 ms | 6,722  | no     |

- **The cursor's read of the intents follows the live set.** M2's index makes
  the cursor visit the 3,700 listed intents' pages (about 950 blocks) instead of
  every intent ever prepared, and keeps that flat as the ended history grows:
  with four times the old ended intents the Seq Scan reads 19,425 blocks and
  takes 86 ms, the indexed read 946 blocks and 66 ms. At the 25k fixture itself
  the time is about the same either way (66–76 ms): most of it is the cursor's
  sort of the 24,700 member rows and JIT, not the scan (inferred, since five
  times fewer blocks take as long).
- **The cursor still JIT-compiles.** Its cost (about 166,000) is above
  `jit_above_cost` (100,000) and below `jit_optimize_above_cost` (500,000), so
  JIT runs without optimization: 6–9 ms of each run. The cost is the sort,
  estimated at 100 members per intent (about 7 actual). It grows with the live
  intents, so it would reach `jit_optimize_above_cost` at about three times the
  25k live set. Ordering in the worker or reading in keyset pages by `intent_id`
  (W3) removes it.
- **The sync reads tombstones only at scale.** The tombstone statement reads the
  observed-live rows through A1's partial index already at 25k. For W6's mirror
  read, `observed_live OR intent_id = ANY(…)`, a scan of the 772-page table was
  the planner's cheaper choice at 25k (about 4 ms); with 20,000 more tombstones
  PG18 switched to the indexes and read half the blocks, while PG16 kept the
  scan (1,605 blocks, 4.7 ms), growing with history. W7 split it into the
  observed-live index read and the primary key lookup of the snapshot's other
  intents (`UNION ALL`, disjoint because `observed_live` is NOT NULL): at 25k it
  reads 429 blocks in 2.2 ms through both indexes, and 528 blocks with 20,000
  more tombstones. PG16 was not run locally for this form; CI's PG16 stage plans
  it in `catalog-publication-scope.test.ts` (700 images, 20,000 ended intents:
  an index scan of the observed-live rows, no Seq Scan).
- **A job's inspection reads one rendition's publications, history included,
  through A1's plain index.** The 100,800 seeded generations are about 6,700
  pages that the read scanned 28 times per `acquire` without it.
- **The reconcile's scope reads are index-only or bounded by their limit.** The
  in-flight read and the FIFO read of pending marks touch only the rows they
  return. Since W7 both leave out assets with an active publication job, and the
  in-flight read also leaves out assets with a pending mark and takes whether
  the pass may publish (`$2`); each anti-join is an index probe per row
  returned. Its worst case, every published generation withdrawing, is in the
  wave C section below.

## The scoped reconcile and the membership step at wave C (W7, W8)

### One reconcile pass (W7)

`catalog-scale-reconcile.test.ts`'s 25k gate at the wave C integration, on
PG18.4 (single run; W7's own run measured 12.3 s and 3.2 s too). K is 1,000 and
the planning budget 14 s; the sweep's share is 100, and in flight and dirty
share the other 900, each guaranteed half.

| Pass                                    | Wall   | Planned        | App statements | Scheduled       |
| --------------------------------------- | ------ | -------------- | -------------- | --------------- |
| sweep only (no mark, nothing in flight) | 12.3 s | 500 of 1,000   | 44,786         | nothing         |
| 1,001 taken-down assets marked          | 3.2 s  | 1,000 of 1,000 | 10,942         | 900 withdrawals |

Every statement of the reconcile itself, planned as it ran (EXPLAIN ANALYZE,
rolled back), with no JIT:

| Statement                                                | Sweep pass      | Dirty pass                                    |
| -------------------------------------------------------- | --------------- | --------------------------------------------- |
| state row read (`sweep_cursor`)                          | 8, 0.0 ms       | 8, 0.0 ms                                     |
| in-flight read (`$1` limit, `$2` allow)                  | 18, 0.1 ms      | 18, 0.0 ms                                    |
| pending marks, FIFO (`$1` limit)                         | 45, 0.0 ms      | 157, 0.5 ms (Seq Scan of the 1,001-row table) |
| the sweep's keyset read                                  | 305, 1.3 ms     | 35, 0.1 ms                                    |
| the scope's pending `mark_seq`                           | 21, 0.1 ms      | 96, 0.1 ms                                    |
| state row `FOR UPDATE` (the pass's first lock)           | 9, 0.0 ms       | 9, 0.0 ms                                     |
| the reconcile `WITH desired AS (` (UGC subjects scan)    | 29,729, 19.3 ms | 39,646, 45.0 ms                               |
| settle: lock of the dirty rows it writes (one statement) | –               | 69, 7.1 ms                                    |
| settle: the 'publication' marks                          | –               | 58, 10.5 ms                                   |
| settle: the marks it leaves, to the back of the queue    | –               | 105, 4.8 ms                                   |
| state row: sweep cursor and policy                       | 8, 0.2 ms       | 8, 0.1 ms                                     |

- **A pass follows K, not the Catalog, except for inspections.** The sweep pass
  stops at about 500 of its 1,000 assets when the budget would run out: most of
  its 44,786 statements are `inspectCatalogDelivery`, about 130 per released
  intent of the assets it plans. So with nothing else to do a whole sweep round
  at 25k takes about 50 passes. A set-based inspect (the design's follow-up)
  would about double the rate. Marked takedowns do not wait for the sweep: 900
  were planned and scheduled in one 3.2 s pass. Since the review fixes below, a
  takedown with fewer than 100 pending urgent marks ahead of it waits only
  behind those, each of which removes exposure itself (and behind its own
  asset's publication job, when one is queued or running); one further back is
  planned after the sweep's share (100 sweep assets, publish-side work included,
  attempted whatever the budget) and only while the budget lasts. Apart from
  that share it never waits behind publish-side work, nor behind the images
  private B alone serves during a release wave, which the membership step no
  longer marks (the integration review below). A queue of N urgent marks drains
  in ⌈N / 900⌉ passes with the jobs running between passes (⌈N / 450⌉ at worst,
  while as many in-flight assets take their half): urgent marks are read first,
  and the first 100 are planned whatever the budget. Normal marks drain at most
  900 a pass, and only about as fast as the sweep (about 500 a pass at 25k) when
  their plans inspect.
- **The in-flight read at its worst.** With every published generation
  withdrawing (a mass takedown whose jobs all failed after planning), the
  in-flight read takes 371 ms with the statistics of before (cost estimate 19: a
  Nested Loop over the whole partial index, then Sort and Unique) and 54 ms once
  analyzed (cost 3,340: a Merge Join that its LIMIT stops early), with no JIT
  either way; autovacuum's analyze after such a mass update restores the cheap
  plan.
- **The settle holds every dirty row it writes before it writes any.** Its first
  dirty statement, `catalogPublicationDirtyLockSql`, locks the existing rows and
  creates the missing ones (cleared) in asset id order, so a pass never waits
  for a marker's new lower row while holding a higher one that marker goes on to
  (`catalog-dirty-lock-order.test.ts`).

### The membership step (W8)

From W8's own runs on the 25k fixture (PG18.4, and PG16.15 in a disposable
container), every statement with no JIT. A step runs once a minute; it reads one
aggregate per side in one CMS snapshot and lists buckets only after a change.

| Observation                                    | PG18   | PG16   |
| ---------------------------------------------- | ------ | ------ |
| first observation (every bucket compared)      | 115 ms | 130 ms |
| a minute without a change                      | 39 ms  | 40 ms  |
| one record taken down, from its own baseline   | 74 ms  | –      |
| the same after a restart (App record compared) | 112 ms | –      |

| Statement (role)                                        | Cost (PG18 / PG16) | Time  |
| ------------------------------------------------------- | ------------------ | ----- |
| CMS public aggregate, 256 buckets (public reader)       | 2,428 (PG18)       | 29 ms |
| App public members, 7 buckets (semi join in the join)   | 5,995 / 5,898      | 6 ms  |
| App public members, all 256 buckets                     | 12,559 / 12,564    | 40 ms |
| App public buckets, the fallback only (no own baseline) | 15,875 / 25,053    | –     |

- **A correlated `EXISTS` for the members' served flag was rejected.** At 256
  buckets it was priced at 318,591 and compiled with JIT; the semi join inside
  the outer join uses index lookups for a few buckets and one hash of the
  publications for all 256. The integration review's exposed flag (below) is a
  second such join, and about doubles both costs.
- **A mass takedown is queued as a whole.** On the 25k fixture a 21,000-image
  takedown is marked by one observation and drains in 24 passes of 900. Its
  marks are urgent, so it drains at that rate behind no publish-side mark.
- **Two reads stay linear in the Catalog each minute.** The CMS public aggregate
  (a scan and an md5 per published row) and, on a change minute, the scan of
  `catalog_media_assets` in the App members read (the bucket is an expression of
  the id). The App public buckets aggregate runs only without the step's own
  last observation (after a start, or when two processes run the step and
  alternate); it grows with the live publications, so near the 200,000-source
  ceiling it may pass `jit_above_cost` (100,000) and compile with basic JIT,
  though far below `jit_optimize_above_cost` (500,000).
- **The step takes the state row before its marks.** Its reads take no lock; its
  fingerprint write (a compare-and-set on the stored counts and sums) comes
  before its marks, as a reconcile pass takes the row before it settles, so
  neither waits for the other in turn (`catalog-dirty-lock-order.test.ts`).
- **The step runs wherever the scoped reconcile has a Catalog authority.** In
  the media worker that is the one condition of the sync, the step and the
  reconcile's authority (the published read pool). The Development embedded
  Backend reconciles whenever publishing media is set, with its authority always
  on the published read pool, so it runs the step then too, even without
  `CMS_MEDIA_DIR` (no sync, no render): a takedown or a passed lease is still
  marked within a minute rather than left to the sweep.

### Review fixes: takedowns first, a reserved part, block marks (W7, W8)

The 1B cross-wave review found four gaps, fixed before the PR:

- **Takedowns waited behind publish-side marks (W-AC5).** The queue was one
  FIFO, so a takedown marked after a release wave of requested intents or public
  assets waited until every earlier mark was planned, at the budget's rate when
  those plans inspect (about 500 a pass at 25k): many passes, not 2. A1, amended
  in place (unreleased; ledger checksum `82fab0de…`), gives each dirty row a
  class, `urgent boolean NOT NULL DEFAULT false`, and the pending index is now
  `(urgent DESC, marked_at, asset_id) WHERE mark_seq > cleared_seq`. The App
  role's column grant and the startup check include `UPDATE (urgent)`. A change
  that can only remove public or private-B exposure marks urgent: the membership
  step's served-but-not-published assets, an intent that became cancelled,
  superseded, expired or withdrawn or left the live projection, a passed lease,
  the sync's flips to unreferenced (since the PR review, only of an asset that
  existed before the pass: an asset the pass itself created was never published,
  and its flip is a normal mark) and the intents it ends or tombstones (F3).
  Every other mark is normal: an asset to copy, an intent requested, prepared or
  released, a recorded render or block set, and the settle's carried-over marks.
  (The integration review below narrowed the step's assets, the ended intents
  and the passed leases to the changes that can remove exposure.) A pending
  urgent row stays urgent under a normal mark (the settle's `publication` marks
  included), and a pending normal row becomes urgent, keeping its place, under
  an urgent one. The pending read is
  `ORDER BY urgent DESC, marked_at, asset_id`, and the scope's priority part is
  urgent marks, then in flight, then normal marks. In CI, at K = 100 (a pass
  plans at most 90 marks), behind 287 publish-side marks whose plans inspect (42
  records with released intents), a 7-image takedown marked last is planned
  first in the first pass (a FIFO needed more than 2 passes: 287 > 2 × 90).
- **A slow first batch could block every marked asset.** The sweep's share (100,
  one planning batch at K = 1,000) was planned first, and a batch starts only
  while twice the longest batch so far fits the 14 s budget, so a first batch of
  7 s or more (records of about 20 images, or about 3 times the local
  per-statement latency) ended every pass before any marked or in-flight asset.
  The planning order is now the priority part's first 100
  (`CATALOG_RECONCILE_RESERVED`), the sweep's share, the rest of the priority
  part and the rest of the sweep, and `planScope` takes `reserved`: the priority
  part's first 100 and the share's first 100 are attempted whatever the budget,
  back to back however long each takes, so a pass ends at about the later of its
  budget and their end: two slow ones that succeed take it past the budget by
  both their times less the budget, which is more than one batch whenever either
  of them alone takes longer than the entire budget. A failed batch among them
  is captured again asset by asset only until the budget plus the slowest batch
  capture so far, and the pass ends there (any other failed batch's retries stop
  at the budget, as before): when every capture fails slowly (an outage, a 5 s
  connect timeout), a pass ends about one batch past its budget instead of
  retrying 200 assets one by one (about 17 minutes in the withdraw lane). In CI,
  with every batch taking 60% of the budget (an injected clock), a pass plans
  the 7 marked takedown assets, schedules their withdrawals and moves the sweep
  193 assets on; a unit test retries a failed reserved batch in full past its
  budget and stops an outage's retries one batch past it.
- **Block sets marked nothing.** `recordCatalogBlocks` and a detach, a new limit
  or a re-attach (which end a master and release its blocks) now mark their
  asset (normal, reason `rendition`) as the transaction's last write, after the
  asset rows. A scoped pass that plans no sweep asset publishes a recorded set
  and withdraws a detached master's published blocks; before, both waited for
  the sweep (about 50 passes at 25k).
- **Render grace marked its end.** No publication input reads render grace (it
  decides only whether an image renders), so the boundaries statement keeps the
  lease branch only: a passed lease is marked (urgent; since the integration
  review, a prepared one normal), the end of grace is not.

The changed statements at the 25k fixture, planned as they ran (EXPLAIN ANALYZE,
rolled back), on PG18.4 and on PG16.15 in a disposable container (single runs on
a shared machine), none JIT-compiled, each far below a cost of 100,000:

| Statement (role App), 25k                                  | PG18.4         | PG16.15       | Plan                                                                    |
| ---------------------------------------------------------- | -------------- | ------------- | ----------------------------------------------------------------------- |
| pending marks, 1,000 of 25,200 pending, a tenth urgent     | 148, 0.3 ms    | 148, 0.2 ms   | Index Only Scan on `catalog_publication_dirty_pending`, no Sort         |
| pending marks in a sweep pass (empty queue)                | 45, 0.0 ms     | 45, 0.0 ms    | the same                                                                |
| pending marks in a dirty pass (1,001 urgent marks)         | 155, 0.4 ms    | 155, 0.5 ms   | Seq Scan of the 1,001-row table                                         |
| the settle's `publication` marks (900 kept, urgent stays)  | 58, 12.2 ms    | 58, 11.4 ms   | ModifyTable over the sorted `unnest`                                    |
| the mark at its largest: 25,200 urgent (membership gate)   | 2,220, 282 ms  | 2,220, 209 ms | the same                                                                |
| an intent change's assets with their class (3,700 intents) | 9,860, 27.5 ms | 10,161, 33 ms | PG18 Bitmap Index Scan on the refs' key, PG16 Seq Scan; Aggregate, Sort |
| lease boundaries of one minute (grace branch dropped)      | 40, 0.0 ms     | 40, 0.0 ms    | Index Scan on `catalog_delivery_prepares_active`, refs by index         |

The passes themselves: a dirty pass of 1,001 urgent takedown marks planned 1,000
of 1,000 (900 marks, 100 swept) and scheduled 900 withdrawals in 3.2 s (PG16 3.1
s); a sweep pass (no mark, its reserved part the share's 100) planned 500 of
1,000 in 12.2 s (PG16 11.9 s), 44,786 App statements, as before. The membership
step's first observation took 117 ms (PG16 126 ms), a minute without a change 39
ms (46 ms). The render gate (`catalog-render-queue.test.ts` at 25k, PG18) still
plans every sync statement without JIT (largest 15,992, the tiered insert of the
render section below); its fixed-point sync issues neither the mark nor the
intent-assets statement, which the membership gate plans at their largest above.

### Integration review: what is urgent (W8)

The integration review of the fixes above found two kinds of no-op that the
class still counted as takedowns:

- **The images private B alone serves.** During a release wave (takedown-1's
  increment-2 scenario: about 700 requests holding about 5,000 images, released
  over about 20 minutes) the public total changes each minute and about half of
  the 256 buckets are listed. The App members read flagged every served image
  the Catalog does not publish, so each held image in a listed bucket was marked
  urgent every minute, though its plan keeps its pins and plans as a no-op (an
  inspection each): at about 500 such plans a pass, a takedown marked mid-wave
  waited about 5 to 8 passes. The members read now also returns `exposed`:
  served by a publication that no live release request pins (a
  `catalog_delivery_rendition_pins` row of a mirror row that is
  `release_requested`, observed live, not ended, and leased past the
  observation). Only an exposed image the Catalog does not publish is marked,
  urgent; one private B alone serves is not marked at all, and the end of its
  request marks it (the private diff, the sync, a passed lease). A step without
  a prepare reader (whose reconcile reads no intent, so keeps no pin) still
  marks every served image the Catalog does not publish. (This read the
  request's state from the App mirror, which lags the CMS by up to a sync; the
  delta review below found takedowns it left unmarked, and a pin now counts only
  for a request that pins each of its members and that the CMS confirms in the
  same observation.) In CI, after a release of 40 records lists 168 buckets
  holding 251 images that 60 requests serve (K is 100 there, so a pass plans at
  most 90 marks), a takedown marked the next minute is scheduled in the first
  pass; without the exposed test it is not scheduled after two (251 urgent marks
  ahead of it).
- **The end of a prepared intent.** A prepared intent grants nothing a takedown
  removes (nothing to a pair that is not public; to a public one only pins its
  public permission already selects), yet its end, lapse and passed lease were
  urgent: a bulk prepare whose 24-hour leases lapse together (700 intents, about
  5,000 images) queued about 5,000 urgent no-op marks, about 6 passes ahead of a
  takedown. The class now follows the state the App last saw (the mirror row, in
  the step's diff and in the sync): an ending is normal when the App saw the
  intent prepared and the CMS shows no request since, at the same state version
  (a lapse, as the projection reads it) or one transition later in a state other
  than expired (a cancellation, supersession or withdrawal; every CMS transition
  raises the version by one). The reconcile plans from the CMS, so a request the
  mirror never saw may have been copied: an expiry one version later (which may
  end such a request), a prepared intent that leaves the projection unseen, and
  one the App did not know stay urgent. An intent the App last saw ended grants
  nothing more, so its leaving the projection R later is normal too. The
  boundaries statement returns per asset whether a requested lease passed
  (urgent) or only a prepared one (normal); a request the mirror never saw also
  changes the CMS projection at that lease, whose diff marks it urgent in the
  same observation.

The changed statements at the 25k fixture (the membership gate), planned as they
ran (EXPLAIN ANALYZE, rolled back), on PG18.4 and on PG16.15 in a disposable
container, none JIT-compiled:

| Statement (role App), 25k                         | PG18.4        | PG16.15       | Plan                                                                                         |
| ------------------------------------------------- | ------------- | ------------- | -------------------------------------------------------------------------------------------- |
| App public members, all 256 buckets               | 24,428, 81 ms | 24,428, 84 ms | the publications hashed for each test; the held pins from `catalog_delivery_prepares_active` |
| App public members, 7 buckets                     | 11,533, 10 ms | 11,187, 11 ms | per listed asset: its public asset, publications, pins by rendition, the mirror row memoized |
| App public members, one bucket                    | 4,817, 4 ms   | 4,767, 5 ms   | the same                                                                                     |
| the same, all 256 buckets, 700 records held       | 24,864, 97 ms | 24,855, 91 ms | as all 256 buckets                                                                           |
| the same, 7 buckets, 700 records held             | 11,841, 10 ms | 11,495, 12 ms | as 7 buckets                                                                                 |
| lease boundaries of one minute, a class per asset | 40, 0.0 ms    | 40, 0.0 ms    | Index Scan on `catalog_delivery_prepares_active`, refs by index; Sort, Aggregate             |
| lease boundaries, every live lease at once (500)  | 68, 6.5 ms    | 68, 7.0 ms    | the same                                                                                     |

The exposed test about doubles the members read (12,559 and 5,995 before), a
quarter of the threshold. The step's first observation took 113 ms (PG16 120
ms), a minute without a change 38 ms (39 ms).

### Delta review: only requests the CMS confirms keep an image (W8)

The review of the integration fixes above found that the exposed test trusted
the App mirror, which only the sync writes (every 5 minutes):

- **A request the CMS had ended still held its images.** A published record's
  image is served by its four current renditions, which a pending release
  request X also pins (the record's own new revision, or another record's
  request). The editor cancels X, or saves a draft, which supersedes it; the
  next step marks the image urgent (the private diff), and the reconcile, which
  plans it while the record is public, clears the mark. When the record is
  withdrawn a minute or two later, before the next sync, nothing ends: X has
  ended already, and the record has no released intent, as after a text-only
  republish. So the private total does not change. The public diff listed the
  image's bucket, but X's mirror row still read as a live request pinning every
  served publication, and the image was not marked. Its takedown waited for the
  next sync (up to 5 minutes), against W-AC5's two reconciles.
- **The pins of an earlier recipe policy's request counted.** After a deploy
  that changes the policy, a live request of the earlier one can no longer be
  released, and its plan grants it nothing (`planCatalogAsset`), yet its pins
  kept its images unmarked.
- **A request with a member still rendering held its other images** (found by
  the review of this fix). Inspect pins every member that is ready and reports
  the request private-ready only when all are, and the plan grants a request
  that is not private-ready nothing. A request of a draft record whose member J
  is still rendering (a render backlog can last hours) or failed still pins the
  four current renditions of its other members. When such a member I is also a
  published record's image, and no live intent of that record names it (a legacy
  record, or after a text-only republish), withdrawing the record ends nothing,
  and the request's pins covered every publication I serves. I waited for the
  next sync's unreferenced flip (up to 5 minutes).

A pin now counts only for a request that holds a pin for each of its members and
that the CMS itself reports, in the observation's own snapshot, as
`release_requested`, leased past the observation and of the current recipe
policy. After the public members are listed, the step reads the App mirror's
live requests of the current policy that name an asset of the listed buckets and
hold a pin for each member (`catalogMembershipHoldsSql`: from the mirror's
unended leases, their members and their pins by key, so it is bounded by the
live requests, not by the listed buckets). That set is a superset of the
requests whose pins serve a listed image: a request that names one but pins
nothing there only widens the confirmation. The step then confirms them by
intent id through the prepare reader in the same snapshot, as that reader's last
statement (`catalogMembershipRequestsSql`). The members read counts only the
pins of confirmed requests whose mirror row still agrees (requested, observed
live, not ended, leased, the current policy). A confirmation that fails, in the
App or in the CMS, confirms none and logs
`catalog membership requests unconfirmed`. Every served image of the listed
buckets that the Catalog does not publish is then marked, urgent, as by a step
without a prepare reader. In CI, the reviewer's sequence marks the record's
images urgent in the observation that sees the withdrawal: cancel X, drain its
marks while the record is public, then withdraw the record before any sync. With
the mirror-only test (the previous behaviour), it marks nothing. A step under a
changed policy marks a takedown whose images only earlier-policy requests pin,
and so does a step whose confirmation fails. A takedown whose images only a
request with an unpinned member (its asset pending, its pins gone) pins is
marked in the observation that sees it; without the pin check it marks nothing.

One residual remains. Inspect can also fail on a request that pinned every
member, when a planned role has no one ready rendition (a missing or duplicated
row; the per-member count cannot see which roles a size plans, since the viewer
role is skipped for small images). Its plan then keeps nothing, and an image
that only its pins serve, shared with a record just withdrawn, still waits for
the next sync's unreferenced flip (up to 5 minutes).

The same review found no test of a prepared intent's lapse as the CMS projection
reports it: expired at the same state version, the branch of `endsCatalogGrant`
that keeps a bulk lapse normal. A test now lapses a prepared intent and a
request in the CMS and the mirror alike, an hour before the step's window, so no
lease boundary marks them. The step's private diff marks the prepared intent
normal and the request urgent, and so does the sync's mirror change after it.
Dropping the same-version disjunct makes the prepared lapse urgent, and the test
fails.

The changed and new statements at the 25k fixture (the membership gate), planned
as they ran (EXPLAIN ANALYZE, rolled back), on PG18.4 and on PG16.15 in a
disposable container, none JIT-compiled. The held rows are a release wave's 700
requests, each pinning every member. The fixture's 100 other live requests pin
nothing, so the holds read returns the 700 for all 256 buckets and 134 for 7,
and the CMS confirms them all:

| Statement, 25k                                             | PG18.4        | PG16.15       | Plan                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App holds, all 256 buckets                                 | 2,594, 0.8 ms | 2,594, 0.9 ms | BitmapAnd of `catalog_delivery_prepares_active` and `_observed_live`; per request its pins by `catalog_delivery_rendition_pins_pkey` (Sort, Aggregate), its members by key; Sort, Unique |
| App holds, 7 buckets                                       | 2,593, 0.3 ms | 2,593, 0.3 ms | the same                                                                                                                                                                                 |
| App holds, all 256 buckets, 700 records held               | 5,480, 11 ms  | 5,480, 11 ms  | the same; 11,543 blocks                                                                                                                                                                  |
| App holds, 7 buckets, 700 records held                     | 5,479, 7.2 ms | 5,479, 7.2 ms | the same; 11,543 blocks                                                                                                                                                                  |
| CMS requests (prepare reader), 700 ids                     | 529, 2.9 ms   | 981, 2.5 ms   | BitmapAnd of the live projection's condition (BitmapOr of `catalog_delivery_intents_state_ended` and `_expiry`) and `catalog_delivery_intents_pkey`                                      |
| CMS requests (prepare reader), 134 ids                     | 244, 0.8 ms   | 478, 0.7 ms   | the same                                                                                                                                                                                 |
| App public members, all 256 buckets (none confirmed)       | 24,393, 79 ms | 24,403, 79 ms | as before                                                                                                                                                                                |
| App public members, 7 buckets                              | 11,549, 10 ms | 11,206, 11 ms | as before                                                                                                                                                                                |
| App public members, one bucket                             | 4,819, 4 ms   | 4,770, 4 ms   | as before                                                                                                                                                                                |
| the same, all 256 buckets, 700 records held, 700 confirmed | 24,741, 87 ms | 24,759, 86 ms | as before; the confirmed requests' unended leases, their pins by key                                                                                                                     |
| the same, 7 buckets, 700 records held, 134 confirmed       | 15,974, 11 ms | 17,676, 44 ms | PG18 per listed asset, as 7 buckets; PG16 a hash plan: Seq Scans of `media_public_assets` and `media_publications`, the held pins from `catalog_delivery_prepares_active`                |

- **Reading the holds through the pins was rejected.** It found the same
  requests, but looked up a publication and a public asset for each of the
  wave's 19,600 pins: priced at 182, it visited 165,098 blocks (66 ms with 700
  held requests). The read through the members visited 3,718 before the pin
  check.
- **The pin check reads each live request's pins.** The planner puts the count
  on the scan of the requests, before the bucket test, so it runs for every live
  request whatever the buckets: with the wave held, the holds read visits 11,543
  blocks and takes 7 to 11 ms on both engines (2.3 to 5.1 ms without it), at
  about a twentieth of the threshold.
- **The confirmed ids make a takedown minute dearer during a release wave.**
  With the wave in its buckets, the 7-bucket members read (a single-record
  takedown) costs 11,841 and takes 10 ms on PG18 before, 15,974 and 11 ms now,
  per listed asset as before. PG16 (Production's engine) leaves that plan once
  requests are confirmed: 11,495 and 12 ms before, 17,676 and 44 ms now, with a
  hash plan that scans `media_public_assets` and `media_publications` whole.
  Both are under a fifth of the threshold at 25k. Both plans are linear in the
  Catalog (PG18's scans `catalog_media_assets` and probes the listed buckets'
  assets, 7/256 of them; PG16's also scans the public assets and publications),
  so near the 200,000-source ceiling (about 7.9 times this fixture) such a
  minute extrapolates to about 127,000 on PG18 and 140,000 on PG16 (about 94,000
  and 91,000 before): basic JIT, still far below `jit_optimize_above_cost`
  (500,000), as for the App public buckets aggregate (above) and the members
  read on any minute that lists many buckets. These are linear extrapolations,
  not measurements.

The step's first observation took 121 ms (PG16 129 ms), a minute without a
change 38 ms (40 ms).

## Render tiers and render grace at wave D (W9, W10)

A sync pass now queues the Catalog's renders in tier order and records the
backlog per tier:

- **Tiers.** t0 a published image with no rendition yet, in its record's order
  (catalog id, then position: the published listing reads both); t1 an image of
  a live release_requested intent; t2 one of a live prepared intent, soonest
  lease first; t3 one of an intent in render grace (below); t4 a ready image
  missing a current recipe identity that no intent of t1–t3 names (a recipe
  re-render of a published image, which N3 keeps serving its old set meanwhile).
  An image several records name takes its highest tier; within t1–t3 an intent's
  images follow its lease, document, intent and ordinal, so a record renders
  together. A ready image missing a current identity that an intent of t1–t3
  names is re-rendered in that intent's tier, even when it is published too: no
  old set serves the intent (readiness wants the current recipe). The sync
  keeps, per named image, its best intent rank beside its best rank. New assets
  are created in the same order, a bounded number a pass.
- **Claim order.** Each job runs after the pass's time plus its rank in
  milliseconds (`run_after = at + rank × 1 ms`). Claims order one class by
  run_after, then by the random job id, so without the rank a pass's jobs ran in
  random order. A later pass's jobs follow an earlier pass's; user jobs keep
  their claim class.
- **Queue target.** The worker passes `CATALOG_RENDER_QUEUE_TARGET` (300, about
  40 minutes at about 7 renders a minute): a pass queues base renders only into
  the room below it. The tiered images (t0–t3) are queued first, in one ranked
  statement: every pending one, and every ready one missing an identity that an
  intent names, at that intent's rank. The daily retry of an intent's failed
  re-render follows them whatever the gate below, ranked after the pass's tiered
  jobs (a retry comes at most once a day, so it is not interleaved by tier).
  Re-renders that no intent names (t4), and their daily retries, enter the queue
  only when no image of a higher tier waits at that pass: every tiered one is
  queued and every named one has its asset. A recipe bump of the published
  Catalog therefore never takes a place a published, requested, prepared or
  grace image of the same pass could take, an intent's image ready under the
  older recipe included (such an image used to be t4: queued after every
  published re-render, about 48 hours at 20,000 images, past its 24-hour lease).
  Claims follow the passes in turn, so a t0–t3 image that arrives at a later
  pass waits behind at most the re-renders already queued: about the target
  (300, about 40 minutes).
- **Backlog.** Per tier, the named images still to render (not created yet or
  pending, in their tier; ready but missing an identity, in the tier of the best
  intent that names them, else in t4), written to
  `catalog_reconcile_state.render_backlog` after the pass commits, in a
  transaction of its own (the lock order never takes the state row after an
  asset or dirty row). `readCatalogRenderBacklog` reads it with the queued and
  running base renders, for the pacing of increment 2. A write that fails (a
  lost connection, the state row missing) never fails the committed pass: its
  counts come back with `renderBacklogRecorded: false`, the worker still logs
  its tombstoned and mismatched intents and its counts, adds one line
  (`catalog sync render backlog not recorded`), and the next pass writes anew.
- **Render grace (G = 72 h, R = 96 h).** For G hours after a prepared or
  requested intent's lease passed, its images are still rendered: the render
  plan counts them as referenced, and the sync names the members the mirror
  stored while the intent was live (the CMS lists a lapsed intent without its
  members) as t3. Only a prepared, requested or expired intent is in grace (a
  cancelled, superseded or withdrawn one never is), only while the mirror
  observes it live, and only while it is its document's latest intent: a newer
  intent of the document ends the grace whatever its state. The sync names only
  an intent of the current recipe policy; the render plan's `referenced` does
  not check the policy (its port passes none, and the private processing
  reference beside it does not check one either), so it only keeps a job that is
  already queued rendering. It is rendering only; blob pins, approvals, release
  requests and the publication fence still require an unexpired lease. The
  sync's `referenced=` log count now includes the t3 members it names.
  `G ≤ R − 24 h` is a named relation in community-postgres (it refuses to load
  otherwise), and a unit test holds the App's R equal to CMS migration M2's.

### One sync pass at 25k

`catalog-render-queue.test.ts`'s 25k gate on PG18.4 and on PG16.15 (a disposable
container, removed afterwards), single runs: the 25k fixture with the live
intents' images rendered; 200 published images that no live unreleased intent
names under an older recipe (50 of them with a failed re-render older than a
day); 20 published images that a recent expired intent in render grace names
under it (each twice in the tiered list: t0 as published, t3 as the intent's);
60 live intents' images under it (20 of them with a failed re-render older than
a day); and 5,000 failed renders of other subjects. The pass queued the 40 live
intents' re-renders and the 20 grace members' with the pending images, the 20
retries, then 150 published re-renders and their 50 retries (`enqueued=280`,
every intent job ranked before every t4 one; backlog t1 9, t2 51, t3 20, t4 200)
in 1.7 s on both majors. Every statement it ran was planned as it ran (EXPLAIN
ANALYZE, rolled back), with no JIT on either major. The costs below are the same
on both, the times within about 10% (PG16 in parentheses where they differ):

| Statement (App role)                                         | Cost   | Time             |
| ------------------------------------------------------------ | ------ | ---------------- |
| the grace members (t3), observed-live mirror rows            | 2,041  | 1.3 ms           |
| the first uncreated images, in render order (limit + 1)      | 139    | 33 ms (32 ms)    |
| the queued base renders, against the target                  | 6      | 0.1 ms           |
| the tiered jobs (t0–t3: pending, intents' re-renders) ranked | 15,992 | 228 ms (231 ms)  |
| the intents' failed re-renders queued again, before the gate | 2,065  | 0.5 ms (0.6 ms)  |
| the re-renders' jobs (t4), ranked after them                 | 9,623  | 238 ms (234 ms)  |
| the failed t4 re-renders queued again, ranked last           | 4,125  | 9.9 ms (10.7 ms) |
| the backlog by tier                                          | 15,268 | 165 ms (163 ms)  |
| the backlog write (its own transaction)                      | 1      | 0.1 ms (0.0 ms)  |

The sync's other statements are unchanged from wave C (here at most 11,844, or
11,362 on PG16: the stored members' read).

- **The tiered insert reads `current` too.** An intent's image that is ready but
  misses an identity is found by the same hashed `NOT IN` subplan as the t4
  insert, evaluated only for the ready rows an intent names. The insert's cost
  went from 2,847 (5 ms, pending images only) to 15,992 (about 230 ms): one more
  aggregate of the ready renditions per pass, never a loop over it. Its array
  holds every named image once and a published one an intent names once more (so
  at most the intents' members more), as the 20 grace members above.
- **Which images miss an identity is one set-based read.** The assets holding a
  ready rendition of every current identity (`current`, one aggregate of the
  ready renditions per pass) replace the per-asset subquery of the old job
  insert for every named asset. That subquery is priced per asset: as the
  backlog count it cost 87,465 at 25k (162 ms), close to `jit_above_cost`
  (100,000), and it grows with the Catalog toward `jit_optimize_above_cost`
  (500,000); the set-based count costs about 15,250.
- **Anti-joins are hashed subplans (`NOT IN`).** Left-joined to `current`, the
  re-render insert was planned for the few rows the aggregate is estimated at: a
  nested loop over the materialized set, cost 5,949–6,617, which ran 16–21 s at
  25k. `a.id NOT IN (SELECT … FROM current)` runs as one hashed subplan in about
  190 ms whatever the estimate (with the left join back, the gate fails on its 2
  s bound). The open-job check is one too: as `NOT EXISTS` it was a nested loop
  over the materialized open jobs (101 ms with 5,300 of them, growing with jobs
  × candidates); as `NOT IN`, 20 ms. Neither column is ever NULL.

## Render timing at the ingest limits (increment 2, S5b)

The Owner's D6 bounds for ingested Catalog originals (128 MiB, 120 million
pixels, 512 MiB decoded, 65,535 px per side) were to be confirmed or lowered by
a Development measurement before switch-on (I-AC7). This section is that
measurement. It kept the first three, lowered the edge to 65,500 px and added
one bound, 256 KiB per stored decoded row. Its review added three more: JPEG
samples of 8 bits only, at most 512 MiB of DCT coefficients in a JPEG with more
than one scan, and at most 256 MiB decoded in an interlaced (Adam7) PNG (see
[Decision](#decision-the-ingest-limits)).

### Files

- `tests/integration/postgres/catalog-render-bench.ts` is the render bench. It
  is not a `*.test.ts` file and needs no database. Each case is a deterministic
  synthetic original (a seeded texture, no Owner material) written once into the
  output directory. Each case is rendered with the worker's own Catalog renderer
  (`createCatalogRenderer`): the Development source reader with its SHA-256
  check, the real sandbox runner with Production's container flags, the protocol
  checks and a filesystem store. It renders every planned Catalog role: thumb,
  cover, display, and viewer when it differs from display. Blocks are a separate
  job, switched off. Per run it records:
  - each role's render time from the renderer's manifest (`timings`);
  - the container's wall time (the 300 s job bound);
  - the container's cgroup `memory.peak` (page cache included, so the staged
    source counts);
  - the largest anon + shmem (tmpfs) seen. A sidecar container reads these every
    100 ms, and only from cgroups whose memory limit equals the sandbox's.

  The bench checks that each case sits at or under every `CATALOG_ORIGINAL_*`
  limit, except the one limit an evidence case is marked to exceed, and runs the
  Admin's own ingest probe (`ImageStructureProbe`) on every generated original:
  it must accept exactly the cases within the limits and refuse each evidence
  case with `bounds`.

- `tests/cms/catalog-ingest-render.test.ts` is the opt-in Development e2e
  (below).

### Run

```sh
pnpm dev:media-sandbox   # the local sandbox image, once
pnpm -w exec turbo run build --filter=@moya/tests^... --filter=!admin
cd tests
MOYA_CATALOG_RENDER_BENCH_OUTPUT=/absolute/private/directory \
  pnpm exec vitest run --config integration/postgres/catalog-scale-bench.config.mts catalog-render-bench
```

The output directory must lie outside any Git working tree. The originals take
about 1.9 GB under its `media/` and are reused until a case changes. A run
writes `render-bench.json`, `render-bench.txt` and a live `progress.log`; the
whole list takes about 9 minutes at three repeats. Options:

- `MOYA_CATALOG_RENDER_BENCH_REPEAT` (default 3).
- `MOYA_CATALOG_RENDER_BENCH_CASES`, a comma-separated list of case names.
- `MOYA_CATALOG_RENDER_BENCH_CPUS` replaces the sandbox's `--cpus` value, in the
  bench only, to emulate a slower core. Every other flag stays Production's.
- `MOYA_CATALOG_RENDER_BENCH_EXTRA_CASES`, a JSON array of extra cases of the
  same shape, for one-off explorations.
- `MOYA_CATALOG_RENDER_BENCH_IMAGE` (default
  `yoyi-work-publishing-media-tools:v2`).

### Budget

- The sandbox's own bounds (`profiles.ts`): 120 s per rendition (the libvips
  timeout), 300 s per job (the container), and 1,536 MiB of memory with no swap.
  A job that exceeds the memory bound is killed and rejected.
- The Production host has 3.64 GiB. The S1 read-only probe of 2026-10-23 saw
  about 1.9 GiB available with the services up. The sandbox container is what
  grows during a job.
- A case passes with a margin of at least 30%: a peak of at most 1,075 MiB (70%
  of 1,536 MiB, and also under 70% of the 1.9 GiB), at most 84 s per role and at
  most 210 s per job, on the Production CPU.

### Results at the limits

Measured 2026-10-23 on an Apple M5 Pro (Docker Desktop VM: 18 vCPUs, 8 GiB,
cgroup v2). The image was the local `yoyi-work-publishing-media-tools:v2` (sharp
0.35.4, libvips 8.18.6), with `--cpus 1` and Production's other flags, three
repeats each. Values are the median, with the range in parentheses where the
repeats differ by more than 5%. Peak includes the page cache.

| Case                     | Original                                                | Slowest role s | Container s    | Peak MiB      | Anon + shmem MiB |
| ------------------------ | ------------------------------------------------------- | -------------- | -------------- | ------------- | ---------------- |
| `jpeg-120mp`             | 13,416 × 8,944 JPEG, q90, 50 MiB                        | 1.1            | 2.5            | 152           | 149              |
| `jpeg-128mib`            | 13,416 × 8,944 JPEG, q98 4:4:4, 127 MiB                 | 1.7            | 4.1            | 226           | 190 (184–200)    |
| `png-120mp-rgba`         | 13,416 × 8,944 RGBA PNG, 122 MiB (458 MiB decoded)      | 1.5            | 4.2            | 309 (309–380) | 183 (179–254)    |
| `webp-16383`             | 16,383 × 7,324 lossy WebP, q90, 46 MiB                  | 3.1            | 11.0           | 193           | 144              |
| `pano-jpeg-65500`        | 65,500 × 1,832 JPEG, 50 MiB                             | 0.8            | 1.7            | 249           | 179 (179–197)    |
| `pano-jpeg-cmyk-65500`   | 65,500 × 1,832 CMYK JPEG, 70 MiB                        | 1.8            | 3.0            | 303           | 228              |
| `pano-png-rgba-65500`    | 65,500 × 1,832 RGBA PNG, 104 MiB (row 256,000 B)        | 1.1            | 2.6            | 891 (683–892) | 774 (586–774)    |
| `pano-png16-rgba-32768`  | 32,768 × 2,048 16-bit RGBA PNG, 80 MiB (row 256 KiB)    | 7.8 (7.4–7.9)  | 9.7 (9.2–10.0) | 770 (601–776) | 686 (514–686)    |
| `pano-png16-rgb-43690`   | 43,690 × 2,048 16-bit RGB PNG, 81 MiB (row 256 KiB)     | 7.0 (6.8–7.6)  | 8.6 (8.4–9.3)  | 689           | 605              |
| `png16-rgba-512mib`      | 8,192 × 8,192 16-bit RGBA PNG, 80 MiB (512 MiB decoded) | 6.9 (6.7–7.2)  | 15.3           | 313 (301–344) | 229 (216–261)    |
| `jpeg-120mp-orient6`     | `jpeg-120mp` with EXIF Orientation 6                    | 1.3            | 2.7            | 158           | 155              |
| `png-120mp-rgba-orient6` | `png-120mp-rgba` with EXIF Orientation 6                | 2.4 (2.3–2.5)  | 6.7            | 381 (346–387) | 260 (219–286)    |
| `tall-png16-rgba-o6`     | 1,024 × 65,500 16-bit RGBA PNG, EXIF Orientation 6      | 2.0            | 5.0            | 168 (155–169) | 97               |

Within the limits, the worst values were a peak of 892 MiB (58% of 1,536 MiB,
46% of 1.9 GiB), a slowest role of 7.9 s of 120 and a slowest job of 15.8 s
of 300. The renderer's preparation (container checks and the header inspection,
no pixel decode) took under 0.1 s in every case.

The two cases over the old limits, which set the new ones:

| Case                                 | Original                                       | Outcome                                                                    |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `jpeg-65535-header` (over the edge)  | a JPEG whose frame header says 65,535 × 1,831  | rejected `decode_failed` after 0.2 s, every repeat                         |
| `pano-png16-rgba-65500` (over a row) | 65,500 × 1,024 16-bit RGBA PNG (row 512,000 B) | rendered in 2.4 s with a peak of 1,106 MiB (1,005–1,163), 72% of 1,536 MiB |

- **The JPEG edge is 65,500.** libjpeg-turbo's `JPEG_MAX_DIMENSION` is 65,500
  px. The encoder refuses to write a longer side, and the sandbox's decoder
  refuses a frame header that declares one before it reads any scan. The ingest
  probe accepted any side up to 65,535 px, so such a JPEG could be registered
  and then never render. Registered originals cannot be deleted.
- **Memory follows the stored row, not the decoded size.** While the renderer
  shrinks a wide image, libvips holds many stored rows, mostly for the long
  scroll display role (16,000 px wide) and the strip's thumb. One-off
  explorations (`MOYA_CATALOG_RENDER_BENCH_EXTRA_CASES`, 2 to 8 repeats each)
  gave these peaks for strips 65,535 px wide:

  | Format       | Row     | Height | Peak MiB    |
  | ------------ | ------- | ------ | ----------- |
  | RGB, 8-bit   | 192 KiB | 1,831  | 512–693     |
  | RGBA, 8-bit  | 256 KiB | 1,831  | 689–892     |
  | RGB, 16-bit  | 384 KiB | 1,365  | 798–1,071   |
  | RGBA, 16-bit | 512 KiB | 512    | 750–1,153   |
  | RGBA, 16-bit | 512 KiB | 768    | 880–1,290   |
  | RGBA, 16-bit | 512 KiB | 1,024  | 1,003–1,424 |

  The last row is 512 MiB decoded and peaked at 93% of the bound. With a 256 KiB
  row, 16-bit RGBA strips 32,768 px wide peaked at 560–776 MiB (1,536 and 2,048
  rows), 16-bit RGB strips 43,690 px wide at 533–712 MiB, and a square 8,192 ×
  8,192 16-bit RGBA PNG (512 MiB decoded, row 64 KiB) at 283–345 MiB. A tall
  strip has short rows: 1,024 × 65,535 16-bit RGBA peaked at 144–149 MiB, and
  155–169 MiB with EXIF Orientation 6, since the renderer turns the shrunk
  output, not the source. The same holds for JPEG, which shrinks on load: 65,500
  px strips peaked at 249 MiB (YCbCr) and 305 MiB (CMYK).

- **Peaks vary by run.** The same wide PNG peaked 30–40% apart between repeats
  (for example 1,003 and 1,424 MiB), so the decision uses the largest value
  seen, never the median.

### Progressive JPEG and interlaced PNG

The first round measured only baseline JPEG and non-interlaced PNG. A
progressive JPEG keeps all its DCT coefficients until the last scan (per
component, its 8 × 8 blocks × 64 coefficients × 2 B), and an interlaced (Adam7)
PNG is decoded whole before its first full row, so neither shrinks a band at a
time. libjpeg keeps the same coefficients for a sequential JPEG whose first scan
holds fewer components than the frame (one scan per component, for example; see
[Sequential JPEG in several scans](#sequential-jpeg-in-several-scans)). Both
were inside every first-round limit. Measured the same way (one core, three
repeats):

| Case                              | Original                                            | Buffer held whole | Slowest role s | Container s | Peak MiB            |
| --------------------------------- | --------------------------------------------------- | ----------------- | -------------- | ----------- | ------------------- |
| `jpeg-prog-cmyk-444-120mp` (over) | 13,416 × 8,944 progressive CMYK JPEG, 4:4:4, 64 MiB | 915 MiB           | 3.5            | 9.8         | 1,094 (1,082–1,094) |
| (exploration)                     | the same, progressive RGB, 4:4:4, 47 MiB            | 686 MiB           | 2.0            | 6.4         | 839 (824–840)       |
| `png-adam7-rgba-65500` (over)     | 65,500 × 1,832 Adam7 RGBA PNG, 114 MiB              | 458 MiB           | 1.6            | 4.3         | 1,021 (1,015–1,113) |
| (exploration)                     | 13,416 × 8,944 Adam7 RGBA PNG, 121 MiB              | 458 MiB           | 1.8            | 5.9         | 733 (733–765)       |
| (exploration)                     | 32,768 × 2,048 Adam7 16-bit RGBA PNG, 84 MiB        | 512 MiB           | 7.5 (7.0–12.2) | 9.8         | 972 (965–992)       |

The over cases peaked at 71–73% of 1,536 MiB, beyond the 70% budget (the
interlaced strip reached 1,121 MiB in the exploration). Progressive peaks follow
the coefficients (the buffer plus 150–185 MiB), and interlaced ones the decoded
size plus the wide-row effect above. So both buffers got a bound of their own,
and at that bound:

| Case                             | Original                                                                   | Buffer held whole | Slowest role s | Container s   | Peak MiB      |
| -------------------------------- | -------------------------------------------------------------------------- | ----------------- | -------------- | ------------- | ------------- |
| `jpeg-prog-444-512mib`           | 11,584 × 7,720 progressive JPEG, 4:4:4, 35 MiB                             | 511.7 MiB         | 1.8            | 5.0           | 696 (663–697) |
| `jpeg-prog-cmyk-444-512mib`      | 10,000 × 6,700 progressive CMYK JPEG, 4:4:4, 36 MiB                        | 511.5 MiB         | 3.6            | 7.3           | 668 (666–684) |
| `jpeg-prog-cmyk-444-strip`       | 65,500 × 1,000 progressive CMYK JPEG, 4:4:4, 35 MiB                        | 499.8 MiB         | 1.7            | 3.9           | 728 (725–728) |
| `jpeg-prog-420-120mp`            | 13,416 × 8,944 progressive JPEG, 4:2:0, 46 MiB                             | 343.5 MiB         | 1.9            | 5.9           | 496 (486–497) |
| `jpeg-seq-scans-cmyk-444-512mib` | 10,000 × 6,700 sequential CMYK JPEG, 4:4:4, one scan per component, 14 MiB | 511.5 MiB         | 2.4 (2.4–2.5)  | 3.9 (3.8–3.9) | 651 (646–652) |
| `png-adam7-rgba-strip`           | 65,500 × 1,024 Adam7 RGBA PNG, 63 MiB                                      | 255.9 MiB         | 0.9            | 2.4           | 789 (787–790) |
| `png-adam7-rgb-strip`            | 65,500 × 1,366 Adam7 RGB PNG, 87 MiB                                       | 256.0 MiB         | 1.1            | 2.9           | 695 (671–701) |
| `png16-adam7-rgba-strip`         | 32,768 × 1,024 Adam7 16-bit RGBA PNG, 42 MiB                               | 256 MiB           | 4.1 (4.1–4.7)  | 5.4           | 693 (690–721) |
| `png-adam7-rgba-8192`            | 8,192 × 8,192 Adam7 RGBA PNG, 72 MiB                                       | 256 MiB           | 2.2            | 5.3           | 491 (478–513) |

The worst was 790 MiB (51%). At a quarter of a core the slowest role was 21.1 s
(`png16-adam7-rgba-strip`) and the slowest job 40.2 s
(`jpeg-prog-cmyk-444-512mib`), 3.8–5.5 times the one-core time; memory did not
change. A 4:2:0 progressive JPEG (the usual web form) keeps all 120 million
pixels; a 4:4:4 one keeps about 89 million (RGB) or 67 million (CMYK).

### Sequential JPEG in several scans

The review of the buffer bounds found that libjpeg decides on a whole-image
coefficient buffer by the scan structure, not by the frame type: `jdinput.c`
sets `has_multiple_scans` when the frame is progressive or when the first scan
holds fewer components than the frame, and the decoder then keeps every
coefficient as for a progressive file. A baseline (SOF0) JPEG written one scan
per component is such a file. The first probe bounded SOF2 and SOF10 only, so a
120 MP CMYK 4:4:4 baseline file in four scans passed every bound.

sharp writes one interleaved scan only, so the bench writes these cases with its
own baseline encoder (standard tables, quality 90; the sandbox's sharp reports
them as `isProgressive`, its name for libjpeg's multi-scan flag). Measured
2026-10-24 in the same way (one core; three repeats for the bench case, two for
the explorations):

| Case                                   | Original                                                               | Buffer held whole | Slowest role s | Container s   | Peak MiB            |
| -------------------------------------- | ---------------------------------------------------------------------- | ----------------- | -------------- | ------------- | ------------------- |
| (exploration)                          | 10,000 × 6,700 baseline CMYK JPEG, 4:4:4, one interleaved scan, 39 MiB | none              | 3.0            | 4.8           | 178 (161–178)       |
| `jpeg-seq-scans-cmyk-444-512mib`       | the same pixels, one scan per component, 14 MiB                        | 511.5 MiB         | 2.4 (2.4–2.5)  | 3.9 (3.8–3.9) | 651 (646–652)       |
| `jpeg-prog-cmyk-444-512mib` (same run) | the same size, progressive (sharp), 36 MiB                             | 511.5 MiB         | 3.6            | 7.5 (7.4–7.6) | 665 (664–668)       |
| (exploration, over)                    | 13,416 × 8,944 baseline CMYK JPEG, 4:4:4, one scan per component       | 915.5 MiB         | 1.7 (1.6–1.7)  | 3.5 (3.4–3.5) | 1,058 (1,046–1,058) |

The peak follows the buffer, as for a progressive file: four scans of the same
pixels took 3.7 times the memory of one interleaved scan. The 120 MP case
reached 69% of 1,536 MiB, about the progressive over case. The ingest probe now
reads the first scan's component count and applies the coefficient bound to
every multi-scan JPEG: it accepts the bench case and refuses the 120 MP one with
`bounds`.

**12-bit JPEG.** The sandbox's sharp is built with mozjpeg, which decodes 8-bit
samples only: the encoder's own baseline frame, marked 12-bit, fails with
`Unsupported JPEG data precision 12` in the repository's sharp. The first
round's probe accepted 12-bit frames (and counted them as 2 bytes a sample), so
such an original could be registered and never render. It is now refused as
`format`.

### A slower CPU

The CVM's vCPU is slower than an M5 Pro core, by how much is not known: no
Production render timing exists, and the figure of about 7 images a minute is a
review note for typical originals, COS reads and writes included. Wall time
under `MOYA_CATALOG_RENDER_BENCH_CPUS=0.25` (a quarter of a core) was 3.8–8.7
times the one-core time per job, and up to 9.7 times per role: more than 4,
because of throttling. Every case ran once:

| Case                     | Slowest role s | Container s | Times one core |
| ------------------------ | -------------- | ----------- | -------------- |
| `jpeg-120mp`             | 4.5            | 9.6         | 3.8            |
| `jpeg-128mib`            | 6.8            | 16.2        | 4.0            |
| `png-120mp-rgba`         | 6.0            | 16.7        | 4.0            |
| `webp-16383`             | 18.5           | 57.6        | 5.2            |
| `pano-jpeg-65500`        | 4.5            | 8.6         | 5.1            |
| `pano-jpeg-cmyk-65500`   | 10.4           | 16.0        | 5.3            |
| `pano-png-rgba-65500`    | 5.5            | 12.7        | 4.9            |
| `pano-png16-rgba-32768`  | 75.3           | 84.5        | 8.7            |
| `pano-png16-rgb-43690`   | 50.6           | 57.8        | 6.7            |
| `png16-rgba-512mib`      | 39.9           | 87.7        | 5.7            |
| `jpeg-120mp-orient6`     | 7.0            | 14.1        | 5.2            |
| `png-120mp-rgba-orient6` | 12.8           | 36.1        | 5.4            |
| `tall-png16-rgba-o6`     | 11.1           | 27.0        | 5.4            |

Every case within the limits still kept a 30% margin at a quarter of a core. The
slowest role was the display of the 16-bit RGBA strip at the row bound: 75.3 s,
63% of 120 s. The slowest job used 87.7 s, 29% of 300 s. Memory did not change
with the CPU (the same peaks, within the run-to-run spread). A 16-bit PNG at the
row bound is the case with the least time margin: if the CVM proves slower than
a quarter of this core, it is the first to reach a bound. Its job is retried
and, after its attempts, fails: the image stays unrendered, and the readiness
gate keeps its record unpublished.

### Decision: the ingest limits

| Limit                                                           | Before (D6) | After              |
| --------------------------------------------------------------- | ----------- | ------------------ |
| `CATALOG_ORIGINAL_MAX_BYTES`                                    | 128 MiB     | 128 MiB (kept)     |
| `CATALOG_ORIGINAL_MAX_PIXELS`                                   | 120,000,000 | 120,000,000 (kept) |
| `CATALOG_ORIGINAL_MAX_DECODED_BYTES`                            | 512 MiB     | 512 MiB (kept)     |
| `CATALOG_ORIGINAL_MAX_EDGE`                                     | 65,535 px   | 65,500 px          |
| `CATALOG_ORIGINAL_MAX_ROW_BYTES`                                | none        | 256 KiB (new)      |
| `CATALOG_ORIGINAL_MAX_JPEG_COEFFICIENT_BYTES` (multi-scan JPEG) | none        | 512 MiB (new)      |
| `CATALOG_ORIGINAL_MAX_INTERLACED_DECODED_BYTES` (Adam7 PNG)     | none        | 256 MiB (new)      |
| JPEG sample precision                                           | 8 or 12 bit | 8 bit only         |

- **The edge applies to every format.** JPEG needs 65,500. A PNG side between
  65,501 and 65,535 px is the only loss. An intent that declares its size (the
  Codex library's manifest always does) is refused at `start`, before any byte
  is sent; otherwise `complete` refuses it.
- **The row bound** is the stored width × decoded channels × bytes per sample (a
  palette PNG counts 4 channels, and a grey or RGB PNG with a tRNS chunk one
  more, since libvips decodes it with alpha). The Admin's ingest probe checks it
  at the image header, with the other bounds (`INGEST_CONTENT_INVALID`). The
  intent carries no channels, so `start` cannot check it. At the edge it never
  binds for an 8-bit image: a JPEG row is 196,500 B (CMYK 262,000 B), a WebP row
  65,532 B and an 8-bit RGBA PNG row 262,000 B. It binds for 16-bit PNG only
  (RGBA at most 32,768 px wide, RGB at most 43,690), since JPEG samples are
  8-bit.
- **The buffer bounds** apply to a JPEG with more than one scan (a progressive
  frame, SOF2 and SOF10, or a sequential one whose first scan holds fewer
  components than the frame; from its sampling factors) and to an interlaced PNG
  (IHDR's interlace method, with tRNS alpha counted), at the header, with the
  other bounds (`INGEST_CONTENT_INVALID`). A sequential JPEG whose first scan
  holds every component and a non-interlaced PNG hold no such buffer.
- **What did not change.** The worker's own sandbox bounds, the processing
  snapshot's 65,535 px edge, and the native and relay paths (40 MiB, 80 MP) are
  unchanged. A native upload of a wide 16-bit PNG within 80 MP can still reach
  the sandbox (an open issue, outside this increment).

With these limits, the worst measured case is again the non-interlaced RGBA
strip at the edge, a peak of 892 MiB, with a role of 7.9 s and a job of 15.8 s
on one core, and 889 MiB, 75.3 s and 87.7 s on a quarter of a core. Every bound
keeps at least 30% margin in both. (The first round's same figure had missed the
progressive and interlaced cases above, which reached 1,121 MiB inside its
limits.)

### Development e2e (I-AC7)

`tests/cms/catalog-ingest-render.test.ts` runs one original over 40 MiB from
ingest to recorded renditions. It is opt-in and never runs in CI. Besides the
synthetic CMS target every CMS test uses, it needs:

- a disposable synthetic App database, which the test migrates;
- Docker and the local sandbox image.

```sh
docker run -d --rm --pull never --name <name> -e POSTGRES_PASSWORD=<synthetic> \
  -e POSTGRES_DB=moya_s5b_synthetic_test -p 127.0.0.1:<port>:5432 postgres:16.15-alpine
# The CMS test environment, as verify-cms sets it: CMS_DATABASE_URL (the task's
# synthetic CMS database), CMS_ENVIRONMENT=synthetic, CMS_STORAGE_MODE=local,
# CMS_MEDIA_DIR and CMS_SECRET. Then, in tests/:
CATALOG_INGEST_RENDER_E2E=1 \
CATALOG_INGEST_RENDER_E2E_APP_DATABASE_URL=postgresql://postgres:<synthetic>@127.0.0.1:<port>/moya_s5b_synthetic_test \
  pnpm exec vitest run cms/catalog-ingest-render.test.ts --no-file-parallelism
docker stop <name>
```

The steps:

1. **Ingest** into the Development store (`CMS_CATALOG_INGEST=on`,
   `CMS_STORAGE_MODE=local`). `start` and `complete` go through the Codex
   library's Admin client (`createAdminSend` in
   `scripts/editorial/direct-ingest.mjs`). The PUT goes to the Development PUT
   route with exactly the signed headers.
2. **Prepare** through the real Admin route, with the current recipe policy.
3. **One worker Catalog sync** reads the CMS's published and private prepare
   views into the App database.
4. **The publishing worker** claims the `catalog_render` job and renders in the
   sandbox container from the Development media directory.

Results, 2026-10-23 (App on PostgreSQL 16.15 in a disposable container, CMS on
the task's 18.4). Two runs passed, each in about 5 s:

- **Original.** A 9,504 × 6,336 JPEG of 48,993,290 B (46.7 MiB).
- **Ingest.** Two Admin requests (`start` and `complete`); the PUT answered 200.
  The media doc was registered under the content-addressed key with the file's
  size and dimensions. The file in `CMS_MEDIA_DIR` has the ingested SHA-256, and
  staging was empty afterwards.
- **Prepare.** The intent was `prepared` with readiness `PENDING`, and the
  current recipe policy pinned.
- **Sync.** One pass created the asset, whose source SHA-256 is the ingested
  one, and queued one `catalog_render` job.
- **Render.** The job succeeded on its first attempt in 2.7 s. thumb (480 ×
  320), cover (1,080 × 720), display (2,048 × 1,365) and viewer (4,096 × 2,731)
  are ready under the current recipes, and their blobs are in the store.
- **Asset.** The asset is ready, with no failure code and a master SHA-256 equal
  to the ingested one. The worker hashed the staged source against the key
  first, so no `source_hash_mismatch` occurred.

What was simulated or narrowed:

- **The staging PUT.** The library sends original bytes only to an https COS
  host. Its COS client refuses the Development store's loopback URL with
  `COS_TARGET_REFUSED`, which the test asserts, so the test sends that one PUT
  itself. The library's `runDirectIngest` against the real Admin routes and a
  stand-in bucket host, with a 70 MB original, is in
  `tests/cms/catalog-ingest.test.ts`.
- **In-process requests.** The Admin requests go through Payload's own endpoint
  handling in the test process, not over a socket. The operator boundary is a
  loopback server that runs the real operator handler and serves only the recipe
  policy.
- **The snapshot.** The sync's snapshot is narrowed to this record, because the
  shared task CMS database holds other tests' records.
- **The worker.** It runs in the test process, with the real job handlers and no
  maintenance steps.
- **Not covered.** Release and publication of the rendered set (PR #320's chain,
  with its own tests) and COS, which only the Owner's dry run and canary cover.
