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

## Run

```sh
set -a; . <task resources.env>; set +a   # loopback disposable TEST_DATABASE_URL
pnpm -w exec turbo run build --filter=@moya/tests^... --filter=!admin
cd tests
MOYA_CATALOG_SCALE_BENCH_OUTPUT=/absolute/path/bench.json \
  pnpm exec vitest run --config integration/postgres/catalog-scale-bench.config.mts
```

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

The matchers as of the wave A integration (W1–W4):

| Detail or plan                  | Statement                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| plan `listing.*`                | `DECLARE catalog_published_sources NO SCROLL CURSOR FOR` the published listing                                   |
| plan `snapshot.privateRows`     | `DECLARE catalog_private_snapshot NO SCROLL CURSOR FOR SELECT * FROM public.catalog_delivery_live_prepare_media` |
| `sync.*` `mirrorRowsRead`       | `SELECT * FROM community.catalog_delivery_prepares WHERE observed_live OR intent_id=ANY(`                        |
| `sync.*` `mediaRefRowsRead`     | `SELECT intent_id,ordinal,… FROM community.catalog_delivery_media_refs WHERE intent_id=ANY(`                     |
| `sync.*` `mirrorRowsAdvanced`   | `UPDATE community.catalog_delivery_prepares p SET source_state=`                                                 |
| `sync.*` `mirrorRowsAdded`      | `INSERT INTO community.catalog_delivery_prepares (intent_id,`                                                    |
| `sync.*` `mirrorRowsTombstoned` | `UPDATE community.catalog_delivery_prepares SET observed_live=false`                                             |
| `plans` `inspections`           | `SELECT * FROM community.catalog_delivery_prepares WHERE intent_id=$1 FOR SHARE` (a count)                       |
| plan `plans.publicReady`        | `SELECT DISTINCT r.id,a.media_id,a.source_object_key`                                                            |
| `reconcile` detail and plan     | `WITH desired AS (`                                                                                              |
| plan `readiness`                | `SELECT * FROM public.catalog_delivery_prepare_media`                                                            |
| plan `fence.current`            | `SELECT DISTINCT intent_id,catalog_document_id,state,state_version`                                              |

The two cursor plans are EXPLAINed as the `DECLARE` the code runs, so the select
is planned as a cursor (for fast start, `cursor_tuple_fraction`), and EXPLAIN
ANALYZE runs it to the end. The `sync.*` details are each the rows of one
statement. They replace three details of the baseline, whose statements W4
removed:

- `mirrorRowsLockedForUpdate` (every mirror row read `FOR UPDATE`) is now
  `mirrorRowsRead`: only the rows a pass can change, the ones observed live and
  the snapshot's intents, without a lock.
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
took 59 minutes. Watch the run for stalls; each scenario's timeout is one hour,
which the 40k scenario may exceed. Vitest prints a scenario's result only when
the file ends, so watch the database (for example `pg_stat_database.xact_commit`
of the `csbench_*` database) rather than the log.

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
