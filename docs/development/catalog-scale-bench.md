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
  minute apart, all in the snapshot from the first pass), and records that
  arrive pass by pass behind re-renders already queued. With
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
`authorized()` issue the same statements per role at 1k, 5k and 25k images
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
  were planned and scheduled in one 3.2 s pass, and a queue of N marks drains in
  ⌈N / 900⌉ passes with the jobs running between passes.
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
  publications for all 256.
- **A mass takedown is queued as a whole.** On the 25k fixture a 21,000-image
  takedown is marked by one observation and drains in 24 passes of 900.
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
  `CMS_MEDIA_DIR` (no sync, no render): a takedown or a passed lease or render
  grace is still marked within a minute rather than left to the sweep.

## Render tiers and render grace at wave D (W9, W10)

A sync pass now queues the Catalog's renders in tier order and records the
backlog per tier:

- **Tiers.** t0 a published image with no rendition yet, in its record's order
  (catalog id, then position: the published listing reads both); t1 an image of
  a live release_requested intent; t2 one of a live prepared intent, soonest
  lease first; t3 one of an intent in render grace (below); t4 a ready image
  missing a current recipe identity (a recipe re-render, which N3 keeps serving
  its old set meanwhile). An image several records name takes its highest tier;
  within t1–t3 an intent's images follow its lease, document, intent and
  ordinal, so a record renders together. New assets are created in the same
  order, a bounded number a pass.
- **Claim order.** Each job runs after the pass's time plus its rank in
  milliseconds (`run_after = at + rank × 1 ms`). Claims order one class by
  run_after, then by the random job id, so without the rank a pass's jobs ran in
  random order. A later pass's jobs follow an earlier pass's; user jobs keep
  their claim class.
- **Queue target.** The worker passes `CATALOG_RENDER_QUEUE_TARGET` (300, about
  40 minutes at about 7 renders a minute): a pass queues base renders only into
  the room below it. Pending images (t0–t3) are queued first. Re-renders (t4),
  and the daily retry of a failed re-render, enter the queue only when no image
  of a higher tier waits at that pass: every pending one is queued and every
  named one has its asset. A recipe bump of the whole Catalog therefore never
  takes a place a published, requested, prepared or grace image of the same pass
  could take. Claims follow the passes in turn, so a t0–t3 image that arrives at
  a later pass waits behind at most the re-renders already queued: about the
  target (300, about 40 minutes).
- **Backlog.** Per tier, the named images still to render (not created yet,
  pending, or in t4 ready but missing an identity), written to
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
intents' images rendered, 200 published images under an older recipe (50 of them
with a failed re-render older than a day) and 5,000 failed renders of other
subjects. The pass queued 150 re-renders and the 50 retries (`enqueued=200`) in
1.1 s (PG16: 1.2 s); every statement it ran, planned as it ran (EXPLAIN ANALYZE,
rolled back), with no JIT on either major. Costs and times are the same on both
within a few percent (PG16 in parentheses where they differ):

| Statement (App role)                                    | Cost   | Time          |
| ------------------------------------------------------- | ------ | ------------- |
| the grace members (t3), observed-live mirror rows       | 2,041  | 1.2 ms        |
| the first uncreated images, in render order (limit + 1) | 139    | 29 ms         |
| the queued base renders, against the target             | 6      | 0.0 ms        |
| the pending images' jobs (t0–t3), ranked                | 2,847  | 5.3 ms        |
| the re-renders' jobs (t4), ranked after them            | 9,727  | 192 ms        |
| the failed re-renders queued again, ranked last         | 4,170  | 10 ms (12 ms) |
| the backlog by tier                                     | 15,248 | 145 ms        |
| the backlog write (its own transaction)                 | 1      | 0.1 ms        |

The sync's other statements are unchanged from wave C (at most 11,844, or 11,332
on PG16: the stored members' read).

- **Which images miss an identity is one set-based read.** The assets holding a
  ready rendition of every current identity (`current`, one aggregate of the
  ready renditions per pass) replace the per-asset subquery of the old job
  insert for every named asset. That subquery is priced per asset: as the
  backlog count it cost 87,465 at 25k (162 ms), close to `jit_above_cost`
  (100,000), and it grows with the Catalog toward `jit_optimize_above_cost`
  (500,000); the set-based count costs 15,248.
- **Anti-joins are hashed subplans (`NOT IN`).** Left-joined to `current`, the
  re-render insert was planned for the few rows the aggregate is estimated at: a
  nested loop over the materialized set, cost 5,949–6,617, which ran 16–21 s at
  25k. `a.id NOT IN (SELECT … FROM current)` runs as one hashed subplan in about
  190 ms whatever the estimate (with the left join back, the gate fails on its 2
  s bound). The open-job check is one too: as `NOT EXISTS` it was a nested loop
  over the materialized open jobs (101 ms with 5,300 of them, growing with jobs
  × candidates); as `NOT IN`, 20 ms. Neither column is ever NULL.
