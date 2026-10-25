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
 *   time-driven boundary the CMS never writes: a prepared or requested lease
 *   that passed since the last observation (render grace, which only decides
 *   whether an image renders, changes no publication plan and marks
 *   nothing);
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
 * - the block sets of display masters ('rendition'): a recorded block set,
 *   which releases any other master's blocks (catalog-zoom-blocks.ts), and a
 *   master ended by a detach, a re-attach or a new limit, whose blocks leave
 *   the plan (catalog-masters.ts);
 * - the scoped reconcile itself (publication.ts, W7), for the assets a pass
 *   leaves for the next one ('publication').
 * This module is the one writer of marks: markCatalogPublicationDirty and
 * its one statement (catalogPublicationDirtyMarkSql), A1's mark. A mark
 * raises mark_seq, and a row that is pending keeps its marked_at (its place
 * in the queue) while a cleared one takes the mark's time; so a mark made
 * while the reconcile plans an asset keeps it pending after the reconcile
 * clears with cleared_seq = the mark_seq it read. Nothing is deleted.
 *
 * Each mark has a class (W-AC5). An urgent mark is a change that can only
 * remove public or private-B exposure: an asset the Catalog no longer
 * publishes that serves a publication no live release request pins (the
 * step's public diff, which counts a request's pins only once the App holds
 * a pin for each of its members and the CMS confirms it in the same
 * observation; one such requests alone serve, which their plans keep
 * wherever a prepare reader is configured, is not marked at all, and
 * applyCatalogMembership names the one residual), the end of an intent that
 * may have granted exposure (endsCatalogGrant: the step's private diff, the
 * sync's mirror changes, F3's tombstones), a requested intent whose lease
 * passed (the step's boundaries), and an asset that existed before a sync
 * pass and that the pass flips to unreferenced. Every other mark is normal:
 * an asset to copy, an intent requested, prepared or released, the end or
 * lapse of an intent the App saw prepared and the CMS shows was never
 * requested since, an asset a sync pass created and flips at once (it was
 * never published), a recorded render or block set, and the reconcile's own
 * carried-over marks. The reconcile reads pending urgent marks before every
 * normal one, each class oldest first, and a pass plans in batches of 100:
 * the first CATALOG_RECONCILE_RESERVED (100) of its priority part (urgent
 * marks, then in flight, then normal marks), then its sweep's share (a tenth
 * of K: 100 assets of the rolling sweep, whatever their work, publish-side
 * included), then the rest of the priority part and of the sweep
 * (publication.ts). Those first 100 and the share (at most two batches) are
 * the reserved part, attempted whatever the budget; the rest only while it
 * lasts. So a takedown with fewer than 100 pending urgent marks ahead of it
 * is attempted in the first batch of the next pass, behind those only,
 * unless its own asset has a publication job queued or running: a pass
 * leaves that asset (its mark and place kept) for after the job. One
 * further back is planned after the sweep's share, and only while the
 * budget lasts: when the reserved part takes the budget it waits for a
 * later pass, each of which attempts the 100 oldest pending urgent marks
 * first. Apart from the sweep's share, a takedown never waits behind
 * publish-side work or the no-op re-marks of a release wave, however much
 * of either is queued. The two reserved batches run back to back however
 * long each takes, so a pass plans until about the later of its budget and
 * their end: two slow ones that succeed take it past the budget by both
 * their times less the budget, more than one batch when either alone
 * outlasts the budget (a failed reserved batch is retried asset by asset
 * only until the budget plus the slowest capture so far). A pending row
 * stays urgent whatever normal mark lands on it, and a pending normal row
 * becomes urgent (keeping its place) when an urgent one lands.
 *
 * Lock order, binding for every transaction that marks or clears (the sync,
 * a recorded render, a recorded block set and an ended master
 * (catalog-zoom-blocks.ts, catalog-masters.ts), the membership step here,
 * the scoped reconcile, and the render tiers that build on them):
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

/** One mark of an asset: the reason (content-free; the row keeps the
 * latest) and the class (urgent: the change can only remove public or
 * private-B exposure, see above). */
export interface CatalogPublicationDirtyMark {
  readonly reason: CatalogPublicationDirtyReason;
  readonly urgent: boolean;
}

/** The intent states that end what an intent grants. */
const ENDED_STATES: ReadonlySet<string> = new Set([
  "cancelled",
  "superseded",
  "expired",
  "withdrawn",
]);

/** An intent's lifecycle as the App mirror or the CMS holds it. */
interface CatalogIntentLifecycle {
  readonly state: string;
  readonly version: number;
}

/**
 * Whether an intent's change can only end what it granted (an urgent mark):
 * it ends (an ended state, or the live projection or the mirror no longer
 * lists it: `next` undefined) an intent that may have granted exposure as
 * the App last saw it (`previous`; undefined when the App did not know it).
 * A requested intent grants private B, a released one its public
 * generations. A prepared one grants nothing a takedown removes (nothing to
 * a pair that is not public; to a public one only pins its public permission
 * already selects), so its end is normal, but only when the CMS shows that no
 * request came between: at the version the App saw (its lease lapsed, as the
 * projection reads it), or one transition later in a state other than
 * expired (a cancellation, supersession or withdrawal; every CMS transition
 * raises the version by one). The reconcile plans from the CMS, so a request
 * the mirror never saw may have been copied: an expiry one version later
 * (which may end such a request) and a prepared intent leaving unseen stay
 * urgent. An intent the App last saw ended grants nothing more.
 */
const endsCatalogGrant = (
  previous: CatalogIntentLifecycle | undefined,
  next: CatalogIntentLifecycle | undefined,
): boolean => {
  if (next !== undefined && !ENDED_STATES.has(next.state)) return false;
  if (previous === undefined) return true;
  if (ENDED_STATES.has(previous.state)) return false;
  if (previous.state !== "prepared" || next === undefined) return true;
  return !(
    next.version === previous.version ||
    (next.version === previous.version + 1 && next.state !== "expired")
  );
};

/**
 * G (Owner decision D3): how long after its lease an intent's images still
 * render (catalog-scale-v1 W10's render grace). Rendering only: no
 * publication input reads it, so neither its start nor its end marks
 * anything. G stays at least 24 hours shorter than R
 * (CATALOG_PREPARE_RETENTION_HOURS, 96, in admin/published), so an intent in
 * grace is still in the live projection and observed live in the mirror.
 */
export const CATALOG_RENDER_GRACE_HOURS = 72;

/** The time-driven window of the first observation (no earlier one stored). */
export const CATALOG_MEMBERSHIP_FIRST_WINDOW_MINUTES = 15;

const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BUCKET = /^[0-9a-f]{2}$/u;
const SUM = /^[0-9]{1,40}$/u;
const POLICY = /^[0-9a-f]{64}$/u;
const REASONS: ReadonlySet<string> = new Set(CATALOG_PUBLICATION_DIRTY_REASONS);

/** The A1 mark: a new row at 1, or one more on a pending or cleared row; a
 * row that becomes pending again is queued as of this mark, in the mark's
 * class. A pending row keeps its place and stays urgent once it is. */
export const catalogPublicationDirtyMarkSql = `
  INSERT INTO community.catalog_publication_dirty AS d (asset_id, mark_seq, reason, urgent, marked_at)
  SELECT m.asset_id, 1, m.reason, m.urgent, $4::timestamptz
  FROM unnest($1::text[], $2::text[], $3::boolean[]) AS m(asset_id, reason, urgent)
  ORDER BY m.asset_id
  ON CONFLICT (asset_id) DO UPDATE SET mark_seq = d.mark_seq + 1, reason = EXCLUDED.reason,
    urgent = EXCLUDED.urgent OR (d.mark_seq > d.cleared_seq AND d.urgent),
    marked_at = CASE WHEN d.mark_seq > d.cleared_seq THEN d.marked_at ELSE EXCLUDED.marked_at END`;

/**
 * Marks Catalog assets for the scoped reconcile, one reason and class each,
 * in the caller's transaction: one statement, in asset id order. No mark, no
 * statement. An invalid id, reason or class throws before any statement.
 */
export const markCatalogPublicationDirty = async (
  db: Pick<PublishingDb, "query">,
  marks: ReadonlyMap<string, CatalogPublicationDirtyMark>,
  now: Date,
): Promise<number> => {
  for (const [assetId, mark] of marks)
    if (
      !ASSET_ID.test(assetId) ||
      typeof mark !== "object" ||
      mark === null ||
      !REASONS.has(mark.reason) ||
      typeof mark.urgent !== "boolean"
    )
      throw new TypeError("Catalog publication mark invalid");
  if (!marks.size) return 0;
  const at = nowParam(now);
  const ids = [...marks.keys()].sort();
  await db.query(catalogPublicationDirtyMarkSql, [
    ids,
    ids.map((id) => marks.get(id)!.reason),
    ids.map((id) => marks.get(id)!.urgent),
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
 * failed). Settled, this is the published set (each published asset is
 * either served or not renderable) plus the assets private B serves while
 * their records are not published yet, so only the buckets of a recent
 * change, or of such an asset (which the members read below does not mark
 * while private B alone serves it), differ. It follows what the reconcile
 * did, not only what the sync saw: a record taken down, withdrawn and
 * published again before any sync differs again. An asset id is
 * `catalog-asset-` and the md5 of its pair, so its bucket and hash are read
 * from the id, as the CMS side computes them from the pair. Read only
 * without the step's own last observation (a start, or a stored row another
 * process advanced); it is linear in the live publications (cost about 16k
 * at 25k).
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
 * The App assets of the given buckets: whether each is ready, served (as
 * SERVING_ASSETS_SQL: its own public asset, by the unique catalog_asset_id,
 * with a publishing or published publication), and exposed: served by a
 * publication that no confirmed release request pins. A pin counts only for
 * one of the requests the step confirmed in the CMS for this observation
 * ($4: of catalogMembershipHoldsSql's, each holding a pin for every
 * member), and only while the mirror agrees ($2, $3: release_requested,
 * observed live, not ended, its lease after $2, of the current recipe
 * policy $3). Such a request's plan (private B) keeps its pins, so an asset
 * served by those alone has nothing to withdraw while its record is not
 * published. With no confirmed request (none in $4, or $3 NULL) no pin
 * counts, and every served asset is exposed. Each test is a semi join
 * inside an outer join, so the planner looks each listed asset up by index
 * when few buckets are listed and hashes the publications once for all 256,
 * where a correlated subquery in the select list was priced at about 320k
 * and compiled with JIT. The assets themselves are one scan of
 * catalog_media_assets (the bucket is an expression of the id).
 */
export const catalogPublicMembershipAppMembersSql = `
  SELECT a.id, a.state = 'ready' AS ready, pa.id IS NOT NULL AS serving,
    x.id IS NOT NULL AS exposed
  FROM community.catalog_media_assets a
  LEFT JOIN community.media_public_assets pa ON pa.catalog_asset_id = a.id
    AND EXISTS (SELECT 1 FROM community.media_publications p
      WHERE p.public_asset_id = pa.id AND p.state IN ('publishing', 'published'))
  LEFT JOIN community.media_public_assets x ON x.catalog_asset_id = a.id
    AND EXISTS (SELECT 1 FROM community.media_publications p
      WHERE p.public_asset_id = x.id AND p.state IN ('publishing', 'published')
        AND NOT EXISTS (SELECT 1 FROM community.catalog_delivery_rendition_pins h
          JOIN community.catalog_delivery_prepares i ON i.intent_id = h.intent_id
          WHERE h.rendition_id = p.rendition_id AND i.intent_id = ANY($4::uuid[])
            AND i.source_state = 'release_requested' AND i.observed_live
            AND i.ended_at IS NULL AND i.expires_at > $2::timestamptz
            AND i.recipe_manifest_sha256 = $3::text))
  WHERE substr(a.id, 15, 2) = ANY($1::text[])`;

/**
 * The release requests whose pins may keep a served asset of the given
 * buckets unmarked, each once: the mirror's intents that are
 * release_requested, observed live, not ended, leased past the observation
 * ($2) and of the current recipe policy ($3), that name an asset of those
 * buckets (a superset of those whose pins serve one: inspect pins only its
 * members' own renditions, and a request that names one but pins nothing
 * there only widens the confirmation), and that hold a pin for each of
 * their members. Inspect pins every member that is ready, and reports the
 * request private-ready only when all are: a request with a member it could
 * not pin (still rendering, or failed) is granted nothing by its plan
 * (planCatalogAsset), so its pins keep nothing unmarked. The mirror lags the
 * CMS by up to a sync (a request the CMS cancelled or superseded still reads
 * as requested here), so the step confirms these in the CMS before their
 * pins count (the members read's $4). It reads the mirror's unended leases
 * (catalog_delivery_prepares_active), their members and their pins by key,
 * so it is bounded by the live requests, not by the listed buckets nor the
 * Catalog size.
 */
export const catalogMembershipHoldsSql = `
  SELECT DISTINCT i.intent_id::text AS intent_id
  FROM community.catalog_delivery_prepares i
  JOIN community.catalog_delivery_media_refs r ON r.intent_id = i.intent_id
  WHERE i.source_state = 'release_requested' AND i.observed_live
    AND i.ended_at IS NULL AND i.expires_at > $2::timestamptz
    AND i.recipe_manifest_sha256 = $3::text
    AND substr(r.asset_id, 15, 2) = ANY($1::text[])
    AND i.media_count = (SELECT count(DISTINCT h.ordinal)
      FROM community.catalog_delivery_rendition_pins h WHERE h.intent_id = i.intent_id)
  ORDER BY 1`;

/** The mirror's live intents of the given buckets. */
export const catalogPrivateMembershipAppMembersSql = `
  SELECT p.intent_id, p.source_state, p.source_state_version
  FROM community.catalog_delivery_prepares p
  WHERE p.observed_live AND substr(p.intent_id::text, 1, 2) = ANY($1::text[])`;

/** The assets App mirror members name for the given intents ($1), each once,
 * and whether one of the intents of $2 (those whose change ends what they
 * granted, a subset of $1) names it. */
export const catalogIntentAssetsSql = `
  SELECT r.asset_id, bool_or(r.intent_id = ANY($2::uuid[])) AS urgent
  FROM community.catalog_delivery_media_refs r
  WHERE r.intent_id = ANY($1::uuid[])
  GROUP BY r.asset_id
  ORDER BY r.asset_id`;

/** The assets the given intents name, each with whether an intent whose
 * change ends what it granted names it (an urgent mark). */
const intentAssets = async (
  db: Pick<PublishingDb, "query">,
  changed: ReadonlyMap<string, boolean>,
): Promise<ReadonlyMap<string, boolean>> => {
  if (!changed.size) return new Map();
  const ids = [...changed.keys()].sort();
  return new Map(
    (
      await db.query<{ asset_id: string; urgent: boolean }>(
        catalogIntentAssetsSql,
        [ids, ids.filter((id) => changed.get(id))],
      )
    ).rows.map((row) => [row.asset_id, row.urgent]),
  );
};

/**
 * The time-driven scope: the assets of the mirror's live intents whose
 * prepared or requested lease passed in the window ($1, $2], each with
 * whether a requested one names it (urgent: its lease ends private B). A
 * prepared lease grants nothing a takedown removes (endsCatalogGrant), so
 * its assets are marked normal; one the CMS requested before the mirror saw
 * it also changes the CMS projection then, whose diff marks it urgent in the
 * same observation. The CMS writes nothing when a lease passes, so no
 * fingerprint of the mirror changes then. It reads the unended rows' expiry
 * (catalog_delivery_prepares_active). The render grace after a lease is
 * rendering only (W10): its end changes no publication plan, so it marks
 * nothing.
 */
export const catalogMembershipBoundariesSql = `
  SELECT r.asset_id, bool_or(p.source_state = 'release_requested') AS urgent
  FROM community.catalog_delivery_media_refs r
  JOIN community.catalog_delivery_prepares p ON p.intent_id = r.intent_id
  WHERE p.ended_at IS NULL AND p.observed_live
    AND p.source_state IN ('prepared', 'release_requested')
    AND p.expires_at > $1::timestamptz AND p.expires_at <= $2::timestamptz
  GROUP BY r.asset_id
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

/** The release requests whose pins may keep an asset of the given buckets
 * unmarked (catalogMembershipHoldsSql), in id order, for the step to
 * confirm in the CMS. No bucket, no read; an invalid bucket or policy throws
 * before any. */
export const readCatalogMembershipHolds = async (
  db: Pick<Pool, "query">,
  buckets: readonly string[],
  observedAt: Date,
  policy: string,
): Promise<string[]> => {
  if (
    buckets.some((bucket) => !BUCKET.test(bucket)) ||
    typeof policy !== "string" ||
    !POLICY.test(policy)
  )
    throw new TypeError("Catalog membership observation invalid");
  if (!buckets.length) return [];
  return (
    await db.query<{ intent_id: string }>(catalogMembershipHoldsSql, [
      buckets,
      nowParam(observedAt),
      policy,
    ])
  ).rows.map((row) => row.intent_id);
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
  /**
   * With a prepare reader and listed public buckets: the release requests
   * whose pins keep a served asset the Catalog does not publish unmarked.
   * Of the mirror's live requests that name an asset of the listed buckets
   * and hold a pin for each of their members (catalogMembershipHoldsSql, a
   * superset of those whose pins serve one), those the live projection
   * reports in the observation's own snapshot as release_requested, leased
   * past `observedAt` and of `policy`, the current recipe policy. Absent
   * (no confirmation, or one that failed), no pin keeps an asset unmarked.
   */
  readonly requests?: {
    readonly policy: string;
    readonly intentIds: readonly string[];
  };
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
 * observation's listed buckets, and the assets of intents whose lease passed
 * since the stored private observation, each in its class, and stores the
 * new fingerprints. The reads take no lock; the state row is then written
 * before the marks (the lock order above: a reconcile pass holds that row
 * while it settles its marks), and only while it still holds the
 * fingerprints the observation was compared with; a missing row, or one
 * that another process advanced meanwhile, throws before any mark (the next
 * observation compares with what is stored). Only an asset the reconcile
 * can act on is marked: a published one that is ready and not served, and
 * an exposed one the Catalog does not publish: with a prepare reader, served
 * by a publication no release request of `observation.requests` pins (the
 * requests the CMS confirmed for this observation, each holding a pin for
 * every member), and without one, any served one. A CMS member the App has
 * no ready asset for is not: the reconcile could not copy anything for it,
 * and the render that makes it ready marks it. An intent change marks the
 * assets App mirror members name for the intent; an intent App does not
 * know grants nothing until a sync mirrors (and marks) it.
 */
export const applyCatalogMembership = async (
  pool: Pool,
  observation: CatalogMembershipObservation,
  now: Date,
): Promise<CatalogMembershipMarks> => {
  const at = nowParam(now);
  const observedAt = nowParam(observation.observedAt);
  const requests = observation.requests;
  for (const side of [observation.public, observation.private])
    if (
      side !== null &&
      (!Number.isSafeInteger(side.count) ||
        side.count < 0 ||
        !SUM.test(side.sum) ||
        side.diff?.buckets.some((bucket) => !BUCKET.test(bucket)))
    )
      throw new TypeError("Catalog membership observation invalid");
  if (
    requests !== undefined &&
    (typeof requests.policy !== "string" ||
      !POLICY.test(requests.policy) ||
      !Array.isArray(requests.intentIds) ||
      requests.intentIds.some((id) => typeof id !== "string" || !UUID.test(id)))
  )
    throw new TypeError("Catalog membership observation invalid");
  return writeTransaction(pool, async (db) => {
    const marks = new Map<string, CatalogPublicationDirtyMark>();
    const counts = { public: 0, private: 0, boundaries: 0 };
    // An asset keeps the reason of its first cause, and is urgent when any
    // of its causes is.
    const mark = (
      ids: Iterable<readonly [string, boolean]>,
      reason: CatalogPublicationDirtyReason,
    ) => {
      let n = 0;
      for (const [id, urgent] of ids) {
        n += 1;
        const prior = marks.get(id);
        marks.set(id, {
          reason: prior?.reason ?? reason,
          urgent: urgent || prior?.urgent === true,
        });
      }
      return n;
    };
    // A published asset that is ready and not served is to be copied; an
    // asset the Catalog does not publish that is exposed is to be withdrawn,
    // an urgent mark. Exposed: served by a publication that no release
    // request pins which holds a pin for each of its members and which the
    // CMS confirmed in this observation as requested, unexpired and of the
    // current recipe policy (observation.requests). One that such requests
    // alone serve is not marked, however often its bucket is listed (a
    // release wave lists about half the buckets each minute): its plan keeps
    // every such pin, and the end of its request marks it (the private diff,
    // the sync, a passed lease). A request the CMS has ended, which the
    // mirror holds as requested until the next sync, keeps nothing: a record
    // withdrawn after its pending request was cancelled is marked in that
    // same observation, as is one whose images only an earlier policy's
    // request pins (its plan grants such a request nothing), or only a
    // request with a member still rendering (not private-ready: its plan
    // grants it nothing either). Inspect can still fail on a request that
    // pinned every member (a planned role without its one ready rendition):
    // its plan then keeps nothing, and an image only its pins serve, shared
    // with a record just withdrawn, waits for the next sync's unreferenced
    // flip (up to 5 minutes). Without a prepare reader (no private side) the
    // reconcile reads no intent and keeps no pin, so every such served asset
    // is to be withdrawn.
    const privateB = observation.private !== null;
    const publicDiff = observation.public.diff;
    if (publicDiff?.buckets.length) {
      const published = new Set(publicDiff.members);
      const changed: (readonly [string, boolean])[] = [];
      for (const row of (
        await db.query<{
          id: string;
          ready: boolean;
          serving: boolean;
          exposed: boolean;
        }>(catalogPublicMembershipAppMembersSql, [
          publicDiff.buckets,
          observedAt,
          requests?.policy ?? null,
          requests?.intentIds ?? [],
        ])
      ).rows)
        if (published.has(row.id)) {
          if (row.ready && !row.serving) changed.push([row.id, false]);
        } else if (privateB ? row.exposed : row.serving)
          changed.push([row.id, true]);
      counts.public = mark(changed, "public_membership");
    }
    const privateDiff = observation.private?.diff;
    if (privateDiff?.buckets.length) {
      const members = new Map(
        privateDiff.members.map((m) => [
          m.intentId,
          { state: m.state, version: m.stateVersion },
        ]),
      );
      // Each changed intent, and whether its change can only end what it
      // granted (urgent, endsCatalogGrant): the mirror holds what the App
      // last saw, the projection what the CMS holds now.
      const changed = new Map<string, boolean>();
      const mirrored = new Set<string>();
      for (const row of (
        await db.query<{
          intent_id: string;
          source_state: string;
          source_state_version: number;
        }>(catalogPrivateMembershipAppMembersSql, [privateDiff.buckets])
      ).rows) {
        mirrored.add(row.intent_id);
        const next = members.get(row.intent_id);
        if (
          next?.state !== row.source_state ||
          next.version !== row.source_state_version
        )
          changed.set(
            row.intent_id,
            endsCatalogGrant(
              { state: row.source_state, version: row.source_state_version },
              next,
            ),
          );
      }
      for (const [intentId, next] of members)
        if (!mirrored.has(intentId) && UUID.test(intentId))
          changed.set(intentId, endsCatalogGrant(undefined, next));
      counts.private = mark(
        await intentAssets(db, changed),
        "private_membership",
      );
    }
    if (observation.private !== null) {
      const to = ms(observation.observedAt);
      const from =
        observation.previous.private === null
          ? to - CATALOG_MEMBERSHIP_FIRST_WINDOW_MINUTES * 60_000
          : ms(observation.previous.private.observedAt);
      // A requested lease that passed ends private B: urgent. A prepared one
      // ends nothing a takedown removes: normal.
      if (from < to)
        counts.boundaries = mark(
          (
            await db.query<{ asset_id: string; urgent: boolean }>(
              catalogMembershipBoundariesSql,
              [new Date(from).toISOString(), observedAt],
            )
          ).rows.map((row) => [row.asset_id, row.urgent] as const),
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
  readCatalogMembershipHolds: (
    buckets: readonly string[],
    observedAt: Date,
    policy: string,
  ) => readCatalogMembershipHolds(pool, buckets, observedAt, policy),
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

/** One mirror row as a sync compares it: its state, version and liveness. */
export interface CatalogMirrorState {
  readonly state: string;
  readonly version: string;
  readonly live: boolean;
}

export const readCatalogMirrorStates = async (
  db: Pick<PublishingDb, "query">,
  intentIds: readonly string[],
): Promise<ReadonlyMap<string, CatalogMirrorState>> => {
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
      {
        state: row.source_state,
        version: String(row.source_state_version),
        live: row.observed_live,
      },
    ]),
  );
};

/** A mirror row as endsCatalogGrant reads it: undefined unless observed
 * live (a tombstone, F3's included, no longer lists the intent). */
const mirroredLifecycle = (
  row: CatalogMirrorState | undefined,
): CatalogIntentLifecycle | undefined =>
  row?.live ? { state: row.state, version: Number(row.version) } : undefined;

/** The assets of the intents whose mirror state differs between two reads,
 * each with whether a change that can only end what its intent granted
 * (endsCatalogGrant, from the row before to the row after: an ended state,
 * or a row no longer observed live, F3's tombstone) names it. */
export const changedCatalogIntentAssets = async (
  db: Pick<PublishingDb, "query">,
  before: ReadonlyMap<string, CatalogMirrorState>,
  after: ReadonlyMap<string, CatalogMirrorState>,
): Promise<ReadonlyMap<string, boolean>> => {
  const changed = new Map<string, boolean>();
  for (const [id, now] of after) {
    const was = before.get(id);
    if (
      was?.state !== now.state ||
      was.version !== now.version ||
      was.live !== now.live
    )
      changed.set(
        id,
        endsCatalogGrant(mirroredLifecycle(was), mirroredLifecycle(now)),
      );
  }
  return intentAssets(db, changed);
};
