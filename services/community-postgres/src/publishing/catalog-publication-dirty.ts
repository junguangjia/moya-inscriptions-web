import type { Pool } from "pg";

import { nowParam, writeTransaction, type PublishingDb } from "./db.js";

/*
 * catalog-scale-v1 (Issue #323) 1B, W7/W8: the writer of the scoped
 * reconcile's dirty queue (App migration A1, community.catalog_publication_dirty)
 * and the per-minute membership fingerprints
 * (community.catalog_reconcile_state).
 *
 * The scoped reconcile (W7) plans only a bounded scope of Catalog assets per
 * pass, so every change that can alter an asset's publication plan must mark
 * the asset here, in the transaction that observes or makes the change:
 * - the worker's membership step, once a minute: the published Catalog's
 *   pairs (public membership) and the live private prepare projection's
 *   intents (private membership), each as a count and a sum of element
 *   hashes in 256 buckets. Only when a total differs from the stored one are
 *   buckets listed: those that changed since the step's own last committed
 *   observation (kept in the worker's memory while the stored fingerprint
 *   is still that one), or, without it, those in which the CMS differs from
 *   the App's own record of that membership (the assets it serves or cannot
 *   render yet; the intent mirror). Only the listed buckets' members are
 *   read and diffed against the App; the assets that differ are marked, with
 *   the new fingerprint, in one App transaction. A minute without a change
 *   reads two aggregates and writes the state row. The same step marks the
 *   time-driven boundaries the CMS never writes: a prepared or requested
 *   lease, and the render grace after it, that passed since the last
 *   observation;
 * - the Catalog sync (catalog-assets.ts), for the mirror changes and the
 *   reference flips it applies itself: the step compares the CMS with the
 *   mirror, so an intent change the sync applies first would otherwise leave
 *   no difference to find (a reference flip the step also finds; the sync
 *   marks it in the pass that applies it, whichever runs first). After
 *   a mass takedown the step has queued, the next sync marks the same assets
 *   again as it flips them: those the reconcile already cleared are queued
 *   once more, at the tail (each plans as a no-op once withdrawn). That is
 *   accepted rather than tying the sync's marks to the step's;
 * - a recorded render (catalog-assets.ts), whose new renditions the
 *   reconcile must copy;
 * - the scoped reconcile itself (publication.ts, W7), for the assets a pass
 *   leaves for the next one ('publication').
 * This module is the one writer of marks: markCatalogPublicationDirty and
 * its one statement (catalogPublicationDirtyMarkSql), A1's mark. A mark
 * raises mark_seq, and a row that is pending keeps its marked_at (its place
 * in the FIFO queue) while a cleared one takes the mark's time; so a mark
 * made while the reconcile plans an asset keeps it pending after the
 * reconcile clears with cleared_seq = the mark_seq it read. Nothing is
 * deleted.
 *
 * Lock order, binding for every transaction that marks or clears (the sync,
 * a recorded render, the membership step here, the scoped reconcile, and the
 * render tiers that build on them):
 * 1. the catalog_reconcile_state row first, by a transaction that writes it
 *    (a reconcile pass: SELECT … FOR UPDATE; the membership step: its
 *    UPDATE … WHERE id), before any dirty row;
 * 2. then asset rows (catalog_media_assets, and the renditions under them),
 *    in asset id order;
 * 3. then the dirty rows, in asset id order, by one statement: a marker's
 *    mark, or a consumer's lockCatalogPublicationDirty before it writes
 *    several (new rows included); every later dirty-row write of the
 *    transaction is on rows that statement already holds.
 * No transaction takes the state row or an asset row after a dirty row, and
 * none takes the state row after an asset row. Each step waits only for
 * rows above the ones it holds, so two such transactions never wait for
 * each other in turn (40P01): a pass that held the state row would wait for
 * a dirty row the membership step marked before taking the row, and a
 * consumer that locked existing dirty rows and then inserted a missing one
 * would wait for a marker's uncommitted lower row while holding the higher
 * one that marker goes on to (tests/integration/postgres/
 * catalog-dirty-lock-order.test.ts).
 */

export const CATALOG_PUBLICATION_DIRTY_REASONS = [
  "reference",
  "intent",
  "rendition",
  "publication",
  "public_membership",
  "private_membership",
] as const;
export type CatalogPublicationDirtyReason =
  (typeof CATALOG_PUBLICATION_DIRTY_REASONS)[number];

/**
 * G (Owner decision D3): how long after its lease an intent's images still
 * render (catalog-scale-v1 W10's render grace). The membership step marks an
 * intent's assets when its lease and when this grace pass. G stays at least
 * 24 hours shorter than R (CATALOG_PREPARE_RETENTION_HOURS, 96, in
 * admin/published), so an intent in grace is still in the live projection
 * and observed live in the mirror.
 */
export const CATALOG_RENDER_GRACE_HOURS = 72;

/** The time-driven window of the first observation (no earlier one stored). */
export const CATALOG_MEMBERSHIP_FIRST_WINDOW_MINUTES = 15;

const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BUCKET = /^[0-9a-f]{2}$/u;
const SUM = /^[0-9]{1,40}$/u;
const REASONS: ReadonlySet<string> = new Set(CATALOG_PUBLICATION_DIRTY_REASONS);

/** The A1 mark: a new row at 1, or one more on a pending or cleared row; a
 * row that becomes pending again is queued as of this mark. */
export const catalogPublicationDirtyMarkSql = `
  INSERT INTO community.catalog_publication_dirty AS d (asset_id, mark_seq, reason, marked_at)
  SELECT m.asset_id, 1, m.reason, $3::timestamptz
  FROM unnest($1::text[], $2::text[]) AS m(asset_id, reason)
  ORDER BY m.asset_id
  ON CONFLICT (asset_id) DO UPDATE SET mark_seq = d.mark_seq + 1, reason = EXCLUDED.reason,
    marked_at = CASE WHEN d.mark_seq > d.cleared_seq THEN d.marked_at ELSE EXCLUDED.marked_at END`;

/**
 * Marks Catalog assets for the scoped reconcile, one reason each, in the
 * caller's transaction: one statement, in asset id order. No mark, no
 * statement. An invalid id or reason throws before any statement.
 */
export const markCatalogPublicationDirty = async (
  db: Pick<PublishingDb, "query">,
  marks: ReadonlyMap<string, CatalogPublicationDirtyReason>,
  now: Date,
): Promise<number> => {
  for (const [assetId, reason] of marks)
    if (!ASSET_ID.test(assetId) || !REASONS.has(reason))
      throw new TypeError("Catalog publication mark invalid");
  if (!marks.size) return 0;
  const at = nowParam(now);
  const ids = [...marks.keys()].sort();
  await db.query(catalogPublicationDirtyMarkSql, [
    ids,
    ids.map((id) => marks.get(id)!),
    at,
  ]);
  return ids.length;
};

/**
 * A consumer's lock of the dirty rows it will write (step 3 of the lock
 * order): one statement in asset id order that locks each existing row as
 * it is (ON CONFLICT … DO UPDATE … WHERE false locks a row without writing
 * it) and gives an asset without a row a cleared one (mark_seq =
 * cleared_seq = 1: not pending, not in the queue), which the consumer's own
 * mark then raises. It marks nothing.
 */
export const catalogPublicationDirtyLockSql = `
  INSERT INTO community.catalog_publication_dirty AS d (asset_id, mark_seq, cleared_seq, reason, marked_at)
  SELECT l.asset_id, 1, 1, 'publication', $2::timestamptz
  FROM unnest($1::text[]) AS l(asset_id)
  ORDER BY l.asset_id
  ON CONFLICT (asset_id) DO UPDATE SET mark_seq = d.mark_seq WHERE false`;

/**
 * Locks the dirty rows of the given assets in the caller's transaction, for
 * a consumer that then clears, marks or requeues several of them (the
 * scoped reconcile's settle). No asset, no statement. An invalid id throws
 * before any statement.
 */
export const lockCatalogPublicationDirty = async (
  db: Pick<PublishingDb, "query">,
  assetIds: readonly string[],
  now: Date,
): Promise<void> => {
  if (assetIds.some((id) => !ASSET_ID.test(id)))
    throw new TypeError("Catalog publication mark invalid");
  const ids = [...new Set(assetIds)].sort();
  if (!ids.length) return;
  await db.query(catalogPublicationDirtyLockSql, [ids, nowParam(now)]);
};

/** One bucket of a membership fingerprint: its element count and the exact
 * sum (decimal) of its elements' 60-bit hashes. */
export interface CatalogMembershipBucket {
  readonly count: number;
  readonly sum: string;
}
/** A membership fingerprint by bucket (two hex digits), non-empty ones only. */
export type CatalogMembershipBuckets = ReadonlyMap<
  string,
  CatalogMembershipBucket
>;

/** A stored fingerprint and the CMS time it was read at. */
export interface CatalogMembershipFingerprint extends CatalogMembershipBucket {
  readonly observedAt: Date;
}

/** The last stored fingerprints; null before the first (or, for the
 * private one, while no prepare reader is configured). */
export interface CatalogMembershipState {
  readonly public: CatalogMembershipFingerprint | null;
  readonly private: CatalogMembershipFingerprint | null;
}

/** The total of a bucketed fingerprint (exact: sums are added as bigints). */
export const catalogMembershipTotal = (
  buckets: CatalogMembershipBuckets,
): CatalogMembershipBucket => {
  let count = 0;
  let sum = 0n;
  for (const bucket of buckets.values()) {
    count += bucket.count;
    sum += BigInt(bucket.sum);
  }
  return { count, sum: sum.toString() };
};

/** Whether a stored fingerprint differs from a total (none stored: yes). */
export const catalogMembershipChanged = (
  stored: CatalogMembershipBucket | null,
  total: CatalogMembershipBucket,
): boolean =>
  stored === null || stored.count !== total.count || stored.sum !== total.sum;

/** The buckets in which two bucketed fingerprints differ, in order. */
export const differingCatalogMembershipBuckets = (
  left: CatalogMembershipBuckets,
  right: CatalogMembershipBuckets,
): string[] =>
  [...new Set([...left.keys(), ...right.keys()])]
    .filter((bucket) => {
      const a = left.get(bucket);
      const b = right.get(bucket);
      return a?.count !== b?.count || a?.sum !== b?.sum;
    })
    .sort();

/** Parses bucket rows `{bucket, count, sum}` as a bucketed fingerprint; a
 * malformed row throws, never a partial fingerprint. */
export const catalogMembershipBuckets = (
  rows: readonly { bucket: unknown; count: unknown; sum: unknown }[],
): CatalogMembershipBuckets => {
  const buckets = new Map<string, CatalogMembershipBucket>();
  for (const { bucket, count, sum } of rows) {
    const n = Number(count);
    if (
      typeof bucket !== "string" ||
      !BUCKET.test(bucket) ||
      buckets.has(bucket) ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      typeof sum !== "string" ||
      !SUM.test(sum)
    )
      throw new TypeError("Catalog membership fingerprint invalid");
    buckets.set(bucket, { count: n, sum });
  }
  return buckets;
};

/**
 * SQL: the 60-bit hash of an element as a bigint, from 15 hex digits of its
 * md5 (`hex`, an expression) starting at `from`. md5 is the same on every
 * server, so the CMS and the App (two databases) hash alike.
 */
export const catalogMembershipHashSql = (hex: string, from: number) =>
  `('x' || substr(${hex}, ${from}, 15))::bit(60)::bigint`;

/**
 * SQL: the Catalog assets with a publication that serves or is being
 * published (publishing or published), whatever the reason (public, or a
 * requested private intent).
 */
const SERVING_ASSETS_SQL = `SELECT pa.catalog_asset_id
  FROM community.media_public_assets pa
  JOIN community.media_publications p ON p.public_asset_id = pa.id
  WHERE pa.catalog_asset_id IS NOT NULL AND p.state IN ('publishing', 'published')`;

/**
 * The App's record of the public membership, by bucket: the Catalog assets
 * it serves, and the ones the last complete sync found published
 * (unreferenced_since IS NULL) that cannot be served yet (pending or
 * failed). Settled, this is exactly the published set (each published asset
 * is either served or not renderable), so only the buckets of a recent
 * change differ. It follows what the reconcile did, not only what the sync
 * saw: a record taken down, withdrawn and published again before any sync
 * differs again. An asset id is `catalog-asset-` and the md5 of its pair,
 * so its bucket and hash are read from the id, as the CMS side computes
 * them from the pair. Read only without the step's own last observation (a
 * start, or a stored row another process advanced); it is linear in the
 * live publications (cost about 16k at 25k).
 */
export const catalogPublicMembershipAppBucketsSql = `
  SELECT substr(s.id, 15, 2) AS bucket, count(*)::integer AS count,
    sum(${catalogMembershipHashSql("s.id", 17)})::text AS sum
  FROM (
    SELECT a.id FROM community.catalog_media_assets a
    WHERE a.unreferenced_since IS NULL AND a.state <> 'ready'
    UNION
    ${SERVING_ASSETS_SQL}
  ) s
  GROUP BY 1`;

/**
 * The App's record of the private membership, by bucket (two hex digits of
 * the intent id): each intent the mirror observes live, hashed with its
 * state and state version, as the CMS side hashes the live projection's
 * intents (a lapsed lease reads as expired on both).
 */
export const catalogPrivateMembershipAppBucketsSql = `
  SELECT substr(p.intent_id::text, 1, 2) AS bucket, count(*)::integer AS count,
    sum(${catalogMembershipHashSql("md5(p.intent_id::text || ':' || p.source_state || ':' || p.source_state_version)", 1)})::text AS sum
  FROM community.catalog_delivery_prepares p
  WHERE p.observed_live
  GROUP BY 1`;

/**
 * The App assets of the given buckets: whether each is ready and served (as
 * SERVING_ASSETS_SQL: its own public asset, by the unique catalog_asset_id,
 * with a publishing or published publication). The served test is a semi
 * join inside the outer join, so the planner looks each listed asset up by
 * index when few buckets are listed (cost about 6k at 25k for 7 buckets)
 * and hashes the publications once for all 256 (about 13k), where a
 * correlated subquery in the select list was priced at about 320k and
 * compiled with JIT. The assets themselves are one scan of
 * catalog_media_assets (the bucket is an expression of the id).
 */
export const catalogPublicMembershipAppMembersSql = `
  SELECT a.id, a.state = 'ready' AS ready, pa.id IS NOT NULL AS serving
  FROM community.catalog_media_assets a
  LEFT JOIN community.media_public_assets pa ON pa.catalog_asset_id = a.id
    AND EXISTS (SELECT 1 FROM community.media_publications p
      WHERE p.public_asset_id = pa.id AND p.state IN ('publishing', 'published'))
  WHERE substr(a.id, 15, 2) = ANY($1::text[])`;

/** The mirror's live intents of the given buckets. */
export const catalogPrivateMembershipAppMembersSql = `
  SELECT p.intent_id, p.source_state, p.source_state_version
  FROM community.catalog_delivery_prepares p
  WHERE p.observed_live AND substr(p.intent_id::text, 1, 2) = ANY($1::text[])`;

/** The assets App mirror members name for the given intents. */
export const catalogIntentAssetsSql = `
  SELECT DISTINCT r.asset_id
  FROM community.catalog_delivery_media_refs r
  WHERE r.intent_id = ANY($1::uuid[])
  ORDER BY r.asset_id`;

/**
 * The time-driven scope: the assets of the mirror's live intents whose
 * prepared or requested lease ($1, $2], or whose render grace ($3 hours
 * after the lease, prepared, requested or expired), passed in the window.
 * The CMS writes nothing when a lease passes, so no fingerprint of the
 * mirror changes then. Each branch reads its own index: the unended rows'
 * expiry (catalog_delivery_prepares_active) and the live rows (A1's
 * catalog_delivery_prepares_observed_live).
 */
export const catalogMembershipBoundariesSql = `
  SELECT DISTINCT r.asset_id
  FROM community.catalog_delivery_media_refs r
  WHERE r.intent_id IN (
    SELECT p.intent_id FROM community.catalog_delivery_prepares p
    WHERE p.ended_at IS NULL AND p.observed_live
      AND p.source_state IN ('prepared', 'release_requested')
      AND p.expires_at > $1::timestamptz AND p.expires_at <= $2::timestamptz
    UNION
    SELECT p.intent_id FROM community.catalog_delivery_prepares p
    WHERE p.observed_live AND p.source_state IN ('prepared', 'release_requested', 'expired')
      AND p.expires_at > $1::timestamptz - make_interval(hours => $3::integer)
      AND p.expires_at <= $2::timestamptz - make_interval(hours => $3::integer))
  ORDER BY r.asset_id`;

/** The stored fingerprints (one row, which startup guarantees). */
export const catalogMembershipStateSql = `
  SELECT public_count, public_sum::text AS public_sum, public_observed_at,
    private_count, private_sum::text AS private_sum, private_observed_at
  FROM community.catalog_reconcile_state WHERE id`;

/** Thrown when the state row is missing (startup refuses without it; an
 * owner-side truncate while a worker runs is the only other way). */
export class CatalogReconcileStateMissingError extends Error {
  constructor() {
    super("Catalog reconcile state row missing");
    this.name = "CatalogReconcileStateMissingError";
  }
}

const fingerprintOf = (
  count: unknown,
  sum: unknown,
  observedAt: unknown,
): CatalogMembershipFingerprint | null =>
  count === null || sum === null || observedAt === null
    ? null
    : {
        count: Number(count),
        sum: String(sum),
        observedAt: observedAt as Date,
      };

/** The stored fingerprints. A missing state row throws. */
export const readCatalogMembershipState = async (
  db: Pick<Pool, "query">,
): Promise<CatalogMembershipState> => {
  const row = (
    await db.query<Record<string, unknown>>(catalogMembershipStateSql)
  ).rows[0];
  if (row === undefined) throw new CatalogReconcileStateMissingError();
  return {
    public: fingerprintOf(
      row.public_count,
      row.public_sum,
      row.public_observed_at,
    ),
    private: fingerprintOf(
      row.private_count,
      row.private_sum,
      row.private_observed_at,
    ),
  };
};

/** The App's record of one membership, by bucket. */
export const readCatalogMembershipAppBuckets = async (
  db: Pick<Pool, "query">,
  side: "public" | "private",
): Promise<CatalogMembershipBuckets> =>
  catalogMembershipBuckets(
    (
      await db.query<{ bucket: string; count: number; sum: string }>(
        side === "public"
          ? catalogPublicMembershipAppBucketsSql
          : catalogPrivateMembershipAppBucketsSql,
      )
    ).rows,
  );

/** One side of an observation: the CMS total and, when it differs from the
 * stored one, the listed buckets (those that changed since the observer's
 * own last committed observation, or those in which the CMS and the App
 * record differ) and their CMS members. */
export interface CatalogMembershipSide<Member> extends CatalogMembershipBucket {
  readonly diff: {
    readonly buckets: readonly string[];
    readonly members: readonly Member[];
  } | null;
}

/** A live intent of the private projection, as its fingerprint hashes it. */
export interface CatalogMembershipIntent {
  readonly intentId: string;
  readonly state: string;
  readonly stateVersion: number;
}

/**
 * One observation of the CMS memberships, read in one CMS snapshot at
 * `observedAt` (the CMS clock, which also bounds the time-driven window):
 * the published pairs as their asset ids, and, with a prepare reader, the
 * live projection's intents (null without one: the private fingerprint and
 * the time-driven scope are left as they are).
 */
export interface CatalogMembershipObservation {
  readonly observedAt: Date;
  /** The stored state the observation was compared with. */
  readonly previous: CatalogMembershipState;
  readonly public: CatalogMembershipSide<string>;
  readonly private: CatalogMembershipSide<CatalogMembershipIntent> | null;
}

/** What one observation marked, by cause (an asset counts once per cause). */
export interface CatalogMembershipMarks {
  readonly public: number;
  readonly private: number;
  readonly boundaries: number;
}

const ms = (date: Date) => date.getTime();

/**
 * Applies one observation in one App transaction: marks the assets whose
 * public or private membership differs from the App's record in the
 * observation's listed buckets, and the assets of intents whose lease or
 * render grace passed since the stored private observation, and stores the
 * new fingerprints. The reads take no lock; the state row is then written
 * before the marks (the lock order above: a reconcile pass holds that row
 * while it settles its marks), and only while it still holds the
 * fingerprints the observation was compared with; a missing row, or one
 * that another process advanced meanwhile, throws before any mark (the next
 * observation compares with what is stored). Only an asset the reconcile
 * can act on is marked: a published one that is ready and not served, and a
 * served one the Catalog does not publish. A CMS member the App has no ready
 * asset for is not: the reconcile could not copy anything for it, and the
 * render that makes it ready marks it. An intent change marks the assets
 * App mirror members name for the intent; an intent App does not know
 * grants nothing until a sync mirrors (and marks) it.
 */
export const applyCatalogMembership = async (
  pool: Pool,
  observation: CatalogMembershipObservation,
  now: Date,
): Promise<CatalogMembershipMarks> => {
  const at = nowParam(now);
  const observedAt = nowParam(observation.observedAt);
  for (const side of [observation.public, observation.private])
    if (
      side !== null &&
      (!Number.isSafeInteger(side.count) ||
        side.count < 0 ||
        !SUM.test(side.sum) ||
        side.diff?.buckets.some((bucket) => !BUCKET.test(bucket)))
    )
      throw new TypeError("Catalog membership observation invalid");
  return writeTransaction(pool, async (db) => {
    const marks = new Map<string, CatalogPublicationDirtyReason>();
    const counts = { public: 0, private: 0, boundaries: 0 };
    const mark = (
      ids: Iterable<string>,
      reason: CatalogPublicationDirtyReason,
    ) => {
      let n = 0;
      for (const id of ids) {
        n += 1;
        if (!marks.has(id)) marks.set(id, reason);
      }
      return n;
    };
    // A published asset that is ready and not served is to be copied; an
    // asset served while the Catalog does not publish it is to be withdrawn
    // (or is held by a requested private intent, which its plan keeps).
    const publicDiff = observation.public.diff;
    if (publicDiff?.buckets.length) {
      const published = new Set(publicDiff.members);
      const changed: string[] = [];
      for (const row of (
        await db.query<{ id: string; ready: boolean; serving: boolean }>(
          catalogPublicMembershipAppMembersSql,
          [publicDiff.buckets],
        )
      ).rows)
        if (published.has(row.id) ? row.ready && !row.serving : row.serving)
          changed.push(row.id);
      counts.public = mark(changed, "public_membership");
    }
    const privateDiff = observation.private?.diff;
    if (privateDiff?.buckets.length) {
      const live = new Map(
        privateDiff.members.map((m) => [
          m.intentId,
          `${m.state}:${m.stateVersion}`,
        ]),
      );
      const changed = new Set<string>();
      const mirrored = new Set<string>();
      for (const row of (
        await db.query<{
          intent_id: string;
          source_state: string;
          source_state_version: number;
        }>(catalogPrivateMembershipAppMembersSql, [privateDiff.buckets])
      ).rows) {
        mirrored.add(row.intent_id);
        if (
          live.get(row.intent_id) !==
          `${row.source_state}:${row.source_state_version}`
        )
          changed.add(row.intent_id);
      }
      for (const intentId of live.keys())
        if (!mirrored.has(intentId) && UUID.test(intentId))
          changed.add(intentId);
      if (changed.size)
        counts.private = mark(
          (
            await db.query<{ asset_id: string }>(catalogIntentAssetsSql, [
              [...changed].sort(),
            ])
          ).rows.map((row) => row.asset_id),
          "private_membership",
        );
    }
    if (observation.private !== null) {
      const to = ms(observation.observedAt);
      const from =
        observation.previous.private === null
          ? to - CATALOG_MEMBERSHIP_FIRST_WINDOW_MINUTES * 60_000
          : ms(observation.previous.private.observedAt);
      if (from < to)
        counts.boundaries = mark(
          (
            await db.query<{ asset_id: string }>(
              catalogMembershipBoundariesSql,
              [
                new Date(from).toISOString(),
                observedAt,
                CATALOG_RENDER_GRACE_HOURS,
              ],
            )
          ).rows.map((row) => row.asset_id),
          "private_membership",
        );
    }
    // The state row first, then the marks (the lock order above).
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const sets: string[] = [];
    const expected: string[] = [];
    for (const [side, observed, previous] of [
      ["public", observation.public, observation.previous.public],
      ["private", observation.private, observation.previous.private],
    ] as const) {
      if (observed === null) continue;
      sets.push(
        `${side}_count=${bind(observed.count)}::bigint`,
        `${side}_sum=${bind(observed.sum)}::numeric`,
        `${side}_observed_at=${bind(observedAt)}::timestamptz`,
      );
      expected.push(
        `${side}_count IS NOT DISTINCT FROM ${bind(previous?.count ?? null)}::bigint`,
        `${side}_sum IS NOT DISTINCT FROM ${bind(previous?.sum ?? null)}::numeric`,
      );
    }
    const updated = await db.query(
      `UPDATE community.catalog_reconcile_state
       SET ${sets.join(", ")}, updated_at=${bind(at)}::timestamptz
       WHERE id AND ${expected.join(" AND ")}`,
      values,
    );
    if (updated.rowCount !== 1) {
      if (
        (
          await db.query(
            "SELECT 1 FROM community.catalog_reconcile_state WHERE id",
          )
        ).rowCount !== 1
      )
        throw new CatalogReconcileStateMissingError();
      throw new Error("Catalog membership state changed concurrently");
    }
    await markCatalogPublicationDirty(db, marks, now);
    return counts;
  });
};

/** The App side of the worker's membership step, bound to the App pool. */
export const catalogMembershipStore = (pool: Pool) => ({
  readCatalogMembershipState: () => readCatalogMembershipState(pool),
  readCatalogMembershipAppBuckets: (side: "public" | "private") =>
    readCatalogMembershipAppBuckets(pool, side),
  applyCatalogMembership: (
    observation: CatalogMembershipObservation,
    now: Date,
  ) => applyCatalogMembership(pool, observation, now),
});

/** Before and after a sync's mirror writes: each named intent's state,
 * version and liveness, by id (invalid ids are not read). */
export const catalogMirrorStatesSql = `
  SELECT p.intent_id, p.source_state, p.source_state_version, p.observed_live
  FROM community.catalog_delivery_prepares p
  WHERE p.intent_id = ANY($1::uuid[])`;

export const readCatalogMirrorStates = async (
  db: Pick<PublishingDb, "query">,
  intentIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const ids = [
    ...new Set(
      intentIds.map((id) => id.toLowerCase()).filter((id) => UUID.test(id)),
    ),
  ];
  if (!ids.length) return new Map();
  return new Map(
    (
      await db.query<{
        intent_id: string;
        source_state: string;
        source_state_version: number;
        observed_live: boolean;
      }>(catalogMirrorStatesSql, [ids])
    ).rows.map((row) => [
      row.intent_id,
      `${row.source_state}:${row.source_state_version}:${row.observed_live}`,
    ]),
  );
};

/** The assets of the intents whose mirror state differs between two reads. */
export const changedCatalogIntentAssets = async (
  db: Pick<PublishingDb, "query">,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Promise<string[]> => {
  const changed = [...after.keys()]
    .filter((id) => before.get(id) !== after.get(id))
    .sort();
  if (!changed.length) return [];
  return (
    await db.query<{ asset_id: string }>(catalogIntentAssetsSql, [changed])
  ).rows.map((row) => row.asset_id);
};
