import { createHash } from "node:crypto";

import type {
  CatalogAssetSyncCounts,
  CatalogAssetSyncOptions,
  CatalogMediaSource,
  CatalogRenderOutcome,
  CatalogRenderPlan,
  CatalogRenditionIdentity,
  PublishingDerivativeCommit,
} from "@moya/api";
import type { Pool } from "pg";

import { nowParam, readTransaction, writeTransaction } from "./db.js";
import { RECIPE_DIGEST_PATTERN } from "./recipe-identity.js";
import {
  catalogPrivateProcessingReferenceSql,
  catalogRenderGraceReferenceSql,
  catalogRenderGraceSourcesSql,
  synchronizeCatalogDeliveryIntents,
} from "./catalog-delivery-intents.js";
import { CATALOG_SNAPSHOT_MAX_SOURCES } from "./catalog-snapshot-ceiling.js";
import {
  CatalogReconcileStateMissingError,
  changedCatalogIntentAssets,
  markCatalogPublicationDirty,
  readCatalogMirrorStates,
  type CatalogPublicationDirtyMark,
} from "./catalog-publication-dirty.js";
import { recordRenditionRows, unrecordedKeys } from "./renditions.js";

/*
 * Catalog media assets (unified media pipeline, increment 1): sync from the
 * published Catalog list, the render plan of one `catalog_render` job, and
 * recording its renditions and facts in one transaction. Each exported
 * function implements the same-named CatalogMediaAssetPort method (see its
 * JSDoc in @moya/api); `pool` is the adapter's pool. Catalog source objects
 * are never written or deleted here; their renditions are owner-less blobs.
 */

/**
 * One sync pass as this store runs it: a complete snapshot may also name the
 * intents it holds but could not decode, whose mirror rows are left untouched
 * (catalog-delivery-release-hardening-v1 F7), and the pass reports the decoded
 * intents it refused and tombstoned (F3, including an identity drift of an
 * intent that is over), and the live ones whose immutable identity the
 * snapshot contradicts and whose mirror rows it left untouched, each only
 * when there are any, for the caller's log. Intent IDs are opaque UUIDs, never
 * content.
 */
export type CatalogAssetSyncPassOptions = CatalogAssetSyncOptions & {
  readonly snapshot?: NonNullable<CatalogAssetSyncOptions["snapshot"]> & {
    readonly undecodableIntentIds?: readonly string[];
    /**
     * The worker's current recipe policy (the recipe manifest SHA-256 it
     * renders for). With it, only that policy's intents order the renders
     * (T1, T2), and the members of that policy's intents in render grace
     * (T3, catalog-scale-v1 W10) are named; without it, no intent is named
     * for grace.
     */
    readonly recipeManifestSha256?: string;
  };
  /**
   * The render queue's target (catalog-scale-v1 W9, 1..1000): with it, a
   * pass queues base `catalog_render` jobs only while fewer than this many
   * are queued, at most the difference, in place of `limit` as the job
   * bound (so a pass never floods the queue, and a new image of a higher
   * tier waits behind at most this many). Without it, `limit` bounds the
   * jobs as before.
   */
  readonly renderQueueTarget?: number;
};
export type CatalogAssetSyncPassCounts = CatalogAssetSyncCounts & {
  readonly refusedIntentIds?: readonly string[];
  readonly mismatchedIntentIds?: readonly string[];
  /** The committed pass could not record its render backlog (W9; present
   * only then): the pass stands, and the recorded backlog is an older one. */
  readonly renderBacklogRecorded?: false;
};

/**
 * A Catalog media source as the worker's published listing reads it: a
 * published one also names its record and its position there, which keep
 * the record's renders together (W9). Optional, so a list without them still
 * syncs (its images then render in media id order).
 */
type CatalogSyncSource = CatalogMediaSource & {
  readonly catalogId?: unknown;
  readonly position?: unknown;
};

/**
 * The render tiers of the Catalog sync (catalog-scale-v1 W9), highest first:
 * - t0: a published image that has no servable rendition yet (pending);
 * - t1: an image of a live release_requested intent;
 * - t2: an image of a live prepared intent, soonest lease first;
 * - t3: an image of an intent in render grace (W10), soonest lease first;
 * - t4: a ready image missing a current recipe identity that no intent of
 *   t1-t3 names (a recipe re-render of a published image; its earlier set
 *   keeps serving, N3), last in a pass, and queued only while no image of a
 *   higher tier waits (see the queue target).
 * An image several records name takes its highest tier. A ready image
 * missing a current identity that an intent of t1-t3 names is re-rendered in
 * that intent's tier, even when it is published too: no earlier set serves
 * the intent (readiness wants the current recipe), so a recipe bump never
 * holds a prepare behind the published images' re-renders. Within t0 images
 * follow their record (catalog id, then position), within t1-t3 their
 * intent (lease, document, intent, ordinal), so one record's images render
 * together.
 */
export const CATALOG_RENDER_TIERS = ["t0", "t1", "t2", "t3", "t4"] as const;
export type CatalogRenderTier = (typeof CATALOG_RENDER_TIERS)[number];
/** Per tier, the images a sync pass named that still need a render: not
 * created yet or pending, in their tier; ready but missing a current
 * identity, in the tier of the best intent that names them, else in t4. */
export type CatalogRenderBacklog = Readonly<Record<CatalogRenderTier, number>>;

const MAX_BATCH = 1000;
/**
 * How long a failed render waits before the sync tries it again. A pending
 * asset that failed only because its source could not be read (missing or
 * forbidden: a read permission not granted yet, a transient signing or
 * deployment error) is rendered again this long after it failed; every other
 * failure of a pending asset is a fact of the hash-pinned source bytes and
 * stays final. A ready asset never fails: its failed render job (a rejected
 * re-render, or attempts used up) is queued again this long after it failed,
 * while the asset keeps its ready renditions.
 */
const RETRY_DELAY_SQL = "interval '24 hours'";
/** A ready rendition counts only while its blob is committed (a rollback can purge it). */
const LIVE_RENDITION_SQL = `community.media_renditions r
  JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'`;
/**
 * SQL: asset `a` misses a ready rendition, on a committed blob, of one of the
 * listed identities (`$3`, a JSON array of `{role, version, digest}`).
 */
const MISSING_IDENTITY_SQL = `EXISTS (
  SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS want(role text, version integer, digest text)
  WHERE NOT EXISTS (
    SELECT 1 FROM ${LIVE_RENDITION_SQL}
    WHERE r.catalog_asset_id=a.id AND r.state='ready' AND r.role=want.role
      AND r.recipe_version=want.version AND r.recipe_digest=want.digest))`;
/**
 * SQL, the body of a CTE `current`: the Catalog assets holding a ready
 * rendition, on a committed blob, of every listed identity (`$3`; each role
 * once). One set-based read of the ready renditions for a whole pass, where
 * MISSING_IDENTITY_SQL is a subquery per asset: over every named asset that
 * form is priced per asset, so its plan grows with the Catalog toward JIT
 * (87,000 for the backlog count at 25k images, against about 14,000).
 */
const CURRENT_ASSETS_SQL = `SELECT r.catalog_asset_id AS id
  FROM ${LIVE_RENDITION_SQL}
  JOIN jsonb_to_recordset($3::jsonb) AS want(role text, version integer, digest text)
    ON want.role=r.role AND want.version=r.recipe_version AND want.digest=r.recipe_digest
  WHERE r.state='ready' AND r.catalog_asset_id IS NOT NULL
  GROUP BY r.catalog_asset_id
  HAVING count(DISTINCT r.role)=jsonb_array_length($3::jsonb)`;
/**
 * SQL: ready asset `a` misses a listed identity (MISSING_IDENTITY_SQL, set
 * based, beside a CTE `current`); with no listed identity none does. A NOT
 * IN of a subquery runs as one hashed subplan, whatever the planner expects
 * of `current` (an anti-join planned for the few rows the aggregate is
 * estimated at looped over the materialized set: 16 s at 25k images).
 * Neither column is ever NULL.
 */
const RERENDER_SQL = `a.state='ready' AND jsonb_array_length($3::jsonb)>0
  AND a.id NOT IN (SELECT cur.id FROM current cur)`;
/**
 * SQL: job alias `j` is a base `catalog_render` job (the four ordinary roles),
 * not a block job of a display master (payload variant `blocks`,
 * catalog-deep-zoom-v1). Base jobs carry no payload today; a future base
 * payload without a variant stays base.
 */
export const baseCatalogRenderJobSql = (job: string): string =>
  `${job}.kind='catalog_render' AND COALESCE(${job}.payload->>'variant','base')='base'`;
/**
 * SQL: asset `a` has no base `catalog_render` job that is queued or running,
 * or failed or abandoned (those wait for the operator, or the sync's daily
 * retry of a failed re-render). One hashed subplan over the open render
 * jobs, as in RERENDER_SQL, never a loop over them per named asset; a
 * subject is never NULL.
 */
const NO_RENDER_JOB_SQL = `a.id NOT IN (
  SELECT j.subject_id FROM community.publishing_jobs j
  WHERE ${baseCatalogRenderJobSql("j")}
    AND j.state IN ('queued','running','failed','abandoned'))`;
/** SQL: when job `j` ended (failed rows always carry `finished_at`). */
const endedAtSql = (job: string): string =>
  `COALESCE(${job}.finished_at, ${job}.updated_at)`;
const MAX_DIMENSION = 65_535;
const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const MEDIA_ID = /^[^\s]{1,128}$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLACEHOLDER_COLOR = /^#[0-9a-f]{6}$/u;
const CATALOG_ROLES: ReadonlySet<string> = new Set([
  "thumb",
  "cover",
  "display",
  "viewer",
]);
/** The two approved key forms; each embeds the SHA-256 of the object bytes. */
const DISPLAY_KEY = /^display\/v1\/media_[a-f0-9]{32}\/([a-f0-9]{64})\.webp$/u;
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-([a-f0-9]{64})\.(jpg|png|webp)$/u;
const SOURCE_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type SourceContentType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];

/** The byte hash and content type an approved key names, or null for any other key. */
const approvedKey = (
  key: string,
): {
  readonly sha256: string;
  readonly contentType: SourceContentType;
} | null => {
  const display = DISPLAY_KEY.exec(key);
  if (display?.[1] !== undefined)
    return { sha256: display[1], contentType: "image/webp" };
  const editorial = EDITORIAL_KEY.exec(key);
  if (editorial?.[1] !== undefined && editorial[2] !== undefined)
    return {
      sha256: editorial[1],
      contentType: SOURCE_TYPES[editorial[2] as keyof typeof SOURCE_TYPES],
    };
  return null;
};

/** `catalog-asset-` + md5(media id ':' key), as the table CHECK derives it. */
const assetIdOf = (mediaId: string, objectKey: string): string =>
  `catalog-asset-${createHash("md5").update(`${mediaId}:${objectKey}`, "utf8").digest("hex")}`;

const dimension = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_DIMENSION
    ? value
    : null;

const assertAssetId = (assetId: string): void => {
  if (!ASSET_ID.test(assetId))
    throw new TypeError("A Catalog asset id is catalog-asset-<32 hex>");
};

const assertIdentities = (
  identities: readonly CatalogRenditionIdentity[],
): void => {
  const roles = new Set<string>();
  for (const identity of identities) {
    if (
      !CATALOG_ROLES.has(identity.role) ||
      roles.has(identity.role) ||
      !Number.isSafeInteger(identity.version) ||
      identity.version < 1 ||
      !RECIPE_DIGEST_PATTERN.test(identity.digest)
    )
      throw new TypeError(
        "Catalog rendition identities name distinct roles, versions and digests",
      );
    roles.add(identity.role);
  }
};

interface NamedSource {
  readonly id: string;
  readonly media_id: string;
  readonly object_key: string;
  readonly source_sha256: string;
  readonly source_content_type: SourceContentType;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * SQL: asset alias `a` is named by the pass, the typed `text[]` bind `$1`.
 * Each statement of the sync joins or anti-joins that one array (never a
 * temporary table, which the App role may not create, and never a DELETE),
 * so a pass at the snapshot ceiling binds each id once per statement and
 * sends complete source rows only for the assets it creates
 * (catalog-scale-v1 W4).
 */
const NAMED_SQL = `EXISTS (SELECT 1 FROM unnest($1::text[]) AS named(id) WHERE named.id=a.id)`;

/** A named image's render tier (0..3; t4 is decided by the App's asset row
 * and the intents naming it) and its place within the tier: a tuple
 * compared element by element. */
interface RenderRank {
  readonly tier: 0 | 1 | 2 | 3;
  readonly key: readonly (string | number)[];
}
/** A named image no listing ranks (defensive: the union names nothing else). */
const UNRANKED: RenderRank = {
  tier: 2,
  key: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "", 0],
};
const compareKeys = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return left.length - right.length;
};
const compareRanks = (left: RenderRank, right: RenderRank): number =>
  left.tier - right.tier || compareKeys(left.key, right.key);
/** Ranked ids in render order: by rank, then by id. */
const compareRanked = (
  left: { readonly id: string; readonly rank: RenderRank },
  right: { readonly id: string; readonly rank: RenderRank },
): number =>
  compareRanks(left.rank, right.rank) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
/** A finite number, or `fallback`. */
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
/** The lease order of an intent's images: expiry, document, intent, ordinal. */
const leaseKey = (
  expiresAt: number,
  documentId: unknown,
  intentId: unknown,
  ordinal: unknown,
): readonly (string | number)[] => [
  finite(expiresAt, Number.MAX_SAFE_INTEGER),
  finite(documentId, Number.MAX_SAFE_INTEGER),
  typeof intentId === "string" ? intentId : "",
  finite(ordinal, 0),
];

/** CatalogMediaAssetPort.syncCatalogAssets */
export const syncCatalogAssets = async (
  pool: Pool,
  sources: readonly CatalogMediaSource[],
  now: Date,
  options: CatalogAssetSyncPassOptions,
): Promise<CatalogAssetSyncPassCounts> => {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_BATCH
  )
    throw new TypeError("A Catalog sync takes 1..1000 assets per pass");
  const target = options.renderQueueTarget;
  if (
    target !== undefined &&
    (!Number.isSafeInteger(target) || target < 1 || target > MAX_BATCH)
  )
    throw new TypeError("A Catalog render queue target is 1..1000 jobs");
  const policy = options.snapshot?.recipeManifestSha256;
  if (policy !== undefined && !/^[a-f0-9]{64}$/u.test(policy))
    throw new TypeError("A Catalog recipe policy is a SHA-256");
  assertIdentities(options.renditions);
  if (
    !Array.isArray(sources) ||
    sources.length > CATALOG_SNAPSHOT_MAX_SOURCES ||
    (options.snapshot !== undefined &&
      (!Array.isArray(options.snapshot.publishedSources) ||
        options.snapshot.publishedSources.length >
          CATALOG_SNAPSHOT_MAX_SOURCES))
  )
    throw new TypeError(
      "A Catalog sync takes at most the snapshot ceiling of sources",
    );
  const named = new Map<string, NamedSource>();
  let skipped = 0;
  for (const source of sources) {
    const key = approvedKey(source.objectKey);
    if (key === null || !MEDIA_ID.test(source.mediaId)) {
      skipped += 1;
      continue;
    }
    const id = assetIdOf(source.mediaId, source.objectKey);
    if (named.has(id)) continue;
    const width = dimension(source.width);
    const height = dimension(source.height);
    const paired = width !== null && height !== null;
    named.set(id, {
      id,
      media_id: source.mediaId,
      object_key: source.objectKey,
      source_sha256: key.sha256,
      source_content_type: key.contentType,
      width: paired ? width : null,
      height: paired ? height : null,
    });
  }
  const at = nowParam(now);
  // The render order (W9). A published image is t0, in its record's order;
  // the list without a snapshot is the published list. Each live intent of
  // the current policy ranks its images t1 (requested) or t2 (prepared) by
  // its lease; the members of intents in grace (t3) are added in the pass.
  // Each named id keeps its best rank and, apart, its best intent rank
  // (t1-t3), which a re-render of the image takes even when it is published.
  const ranks = new Map<string, RenderRank>();
  const intentRanks = new Map<string, RenderRank>();
  const rank = (id: string, candidate: RenderRank) => {
    for (const best of candidate.tier === 0 ? [ranks] : [ranks, intentRanks]) {
      const current = best.get(id);
      if (current === undefined || compareRanks(candidate, current) < 0)
        best.set(id, candidate);
    }
  };
  const published = new Set<string>();
  for (const source of (options.snapshot?.publishedSources ??
    sources) as readonly CatalogSyncSource[]) {
    const id = assetIdOf(source.mediaId, source.objectKey);
    published.add(id);
    rank(id, {
      tier: 0,
      key: [
        typeof source.catalogId === "string" ? source.catalogId : "",
        finite(source.position, 0),
        source.mediaId,
        source.objectKey,
      ],
    });
  }
  for (const intent of options.snapshot?.preparations ?? []) {
    const state = (intent as { state?: unknown }).state;
    if (
      (state !== "prepared" && state !== "release_requested") ||
      (policy !== undefined && intent.recipeManifestSha256 !== policy) ||
      !Array.isArray(intent.media)
    )
      continue;
    const expires = Date.parse(String(intent.expiresAt));
    for (const media of intent.media as readonly unknown[]) {
      const { mediaId, objectKey, ordinal } = (media ?? {}) as {
        mediaId?: unknown;
        objectKey?: unknown;
        ordinal?: unknown;
      };
      if (typeof mediaId !== "string" || typeof objectKey !== "string")
        continue;
      rank(assetIdOf(mediaId, objectKey), {
        tier: state === "release_requested" ? 1 : 2,
        key: leaseKey(expires, intent.documentId, intent.intentId, ordinal),
      });
    }
  }
  const publishedIds = [...published].sort();
  const pass = await writeTransaction(pool, async (db) => {
    // The mirror rows of the snapshot's intents before and after the pass
    // applies them (catalog-scale-v1 W8): an intent whose state, version or
    // liveness the pass changes (a new, advanced or refused one) marks its
    // assets for the scoped reconcile, urgent when the change can only end
    // what the intent granted (an ended state, or F3's tombstone, of an
    // intent that may have granted exposure as the mirror held it before:
    // not the lapse or cancellation of one it held prepared, see
    // changedCatalogIntentAssets). The membership step compares the CMS
    // with this mirror, so a change applied here first leaves it nothing to
    // find. An intent absent from the snapshot ended or lapsed more than R
    // ago and grants nothing, so its tombstone marks nothing.
    const snapshotIntentIds = (options.snapshot?.preparations ?? []).map(
      (intent) => (intent as { intentId?: unknown }).intentId,
    );
    const intentIds = snapshotIntentIds.filter(
      (id): id is string => typeof id === "string",
    );
    const mirrorBefore = options.snapshot?.preparations
      ? await readCatalogMirrorStates(db, intentIds)
      : undefined;
    const intents = options.snapshot
      ? await synchronizeCatalogDeliveryIntents(
          db,
          options.snapshot.preparations,
          options.snapshot.observedAt,
          options.snapshot.undecodableIntentIds,
        )
      : undefined;
    const marks = new Map<string, CatalogPublicationDirtyMark>();
    if (mirrorBefore)
      for (const [id, urgent] of await changedCatalogIntentAssets(
        db,
        mirrorBefore,
        await readCatalogMirrorStates(db, intentIds),
      ))
        marks.set(id, { reason: "intent", urgent });
    // Render grace (W10): the images of the current policy's intents whose
    // lease passed within G, as the mirror stored them while the intent was
    // live (the CMS lists a lapsed intent without its members), are named
    // for their render (t3) and never as published.
    if (options.snapshot?.preparations && policy !== undefined)
      for (const row of (
        await db.query<{
          media_id: string;
          object_key: string;
          width: number;
          height: number;
          ordinal: number;
          intent_id: string;
          cms_document_id: number;
          expires_at: Date;
        }>(catalogRenderGraceSourcesSql, [at, policy])
      ).rows) {
        const key = approvedKey(row.object_key);
        if (key === null || !MEDIA_ID.test(row.media_id)) continue;
        const id = assetIdOf(row.media_id, row.object_key);
        if (!named.has(id))
          named.set(id, {
            id,
            media_id: row.media_id,
            object_key: row.object_key,
            source_sha256: key.sha256,
            source_content_type: key.contentType,
            width: dimension(row.width),
            height: dimension(row.height),
          });
        rank(id, {
          tier: 3,
          key: leaseKey(
            row.expires_at.getTime(),
            row.cms_document_id,
            row.intent_id,
            row.ordinal,
          ),
        });
      }
    const ids = [...named.keys()].sort();
    // Every named id in render order, with its tier (t0..t3).
    const ordered = ids
      .map((id) => ({ id, rank: ranks.get(id) ?? UNRANKED }))
      .sort(compareRanked);
    const order = ordered.map(({ id }) => id);
    // The queue order of the tiered jobs (t0..t3). Each named id at its rank
    // is queued there while pending and, when that rank is an intent's, also
    // while ready but missing a listed identity. A published id an intent
    // also names comes again at its intent rank, for the second case only.
    // An asset is pending or ready, so it is queued at most once.
    const tiered = [
      ...ordered.map(({ id, rank: own }) => ({
        id,
        rank: own,
        pending: true,
        stale: own.tier > 0 && intentRanks.has(id),
      })),
      ...ordered.flatMap(({ id, rank: own }) => {
        const intent = intentRanks.get(id);
        return own.tier === 0 && intent !== undefined
          ? [{ id, rank: intent, pending: false, stale: true }]
          : [];
      }),
    ].sort(compareRanked);
    // The named ids an intent names, and the others in render order, whose
    // re-renders are t4.
    const intentNamedIds = ids.filter((id) => intentRanks.has(id));
    const rerenderOrder = order.filter((id) => !intentRanks.has(id));
    // The first `limit` named ids without an asset (anti-join), in render
    // order, then only their complete rows, as typed arrays. One more is
    // read to learn whether any is left for a later pass.
    const uncreated = (
      await db.query<{ id: string }>(
        `SELECT named.id FROM unnest($1::text[]) WITH ORDINALITY AS named(id, ord)
         WHERE NOT EXISTS (SELECT 1 FROM community.catalog_media_assets a WHERE a.id=named.id)
         ORDER BY named.ord
         LIMIT $2`,
        [order, options.limit + 1],
      )
    ).rows;
    const missing = uncreated
      .slice(0, options.limit)
      .map((row) => named.get(row.id)!);
    const created = missing.length
      ? await db.query<{ id: string }>(
          `INSERT INTO community.catalog_media_assets(
             id, media_id, source_object_key, source_sha256, source_width, source_height,
             source_content_type, state, created_at, updated_at)
           SELECT s.id, s.media_id, s.object_key, s.source_sha256, s.width, s.height,
             s.source_content_type, 'pending', $8::timestamptz, $8::timestamptz
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
             $6::integer[], $7::integer[])
             AS s(id, media_id, object_key, source_sha256, source_content_type, width, height)
           ORDER BY s.id
           ON CONFLICT (media_id, source_object_key) DO NOTHING
           RETURNING id`,
          [
            missing.map((source) => source.id),
            missing.map((source) => source.media_id),
            missing.map((source) => source.object_key),
            missing.map((source) => source.source_sha256),
            missing.map((source) => source.source_content_type),
            missing.map((source) => source.width),
            missing.map((source) => source.height),
            at,
          ],
        )
      : { rowCount: 0, rows: [] };
    // The assets this pass created: the insert returns only the rows it
    // inserted, never one that existed (or that another pass inserted).
    const createdIds = new Set(created.rows.map((row) => row.id));
    // Every existing asset row the statements below change is locked first,
    // by one statement in id order: each row whose reference state flips and
    // each unreadable source due for a retry. That is the sorted asset lock
    // order readiness inspection and render recording take, so an inspection
    // running beside this pass (no lock of every mirror row holds it back
    // any more) waits for the pass or the pass for it, never each for the
    // other (40P01). The statements below then wait on no asset row: only
    // this pass writes reference state, and a row falls due only by a write
    // older than the retry delay.
    await db.query(
      `SELECT count(*)::integer AS locked FROM (
         SELECT a.id FROM community.catalog_media_assets a
         LEFT JOIN unnest($3::text[]) AS published(id) ON published.id=a.id
         WHERE (published.id IS NOT NULL) = (a.unreferenced_since IS NOT NULL)
           OR (a.state='failed' AND a.failure_code='source_unreadable'
             AND a.updated_at < $2::timestamptz - ${RETRY_DELAY_SQL}
             AND ${NAMED_SQL})
         ORDER BY a.id
         FOR UPDATE OF a
       ) changing`,
      [ids, at, publishedIds],
    );
    // Re-referenced (join) and newly unreferenced (anti-join) assets, from
    // the complete published list only: never from a partial one, which the
    // snapshot reader refuses as a whole (null) before this is called. Each
    // flip marks its asset for the scoped reconcile (W8): a re-published one
    // may copy its renditions again, a taken-down one must be withdrawn (an
    // urgent mark). An asset this pass created and flips at once (an image
    // only a private intent or render grace names) was never published:
    // whatever could serve it (a public asset or a rendition, and through
    // them a publication or a pin) references its row, which did not exist
    // before this pass, so the flip removes nothing. Its mark is normal: an
    // urgent one would put publish-side or no-op work in the takedown class,
    // where it could fill a pass's reserved part ahead of a later takedown.
    // It is still marked, as every flip is, so the reconcile never depends
    // on that reading; a normal mark plans as a no-op behind every urgent
    // one. Either flip keeps an urgent mark of this pass (an intent's end)
    // urgent.
    const rereferenced = await db.query<{ id: string }>(
      `UPDATE community.catalog_media_assets a
       SET unreferenced_since=NULL, updated_at=$2::timestamptz
       FROM unnest($1::text[]) AS published(id)
       WHERE a.id=published.id AND a.unreferenced_since IS NOT NULL
       RETURNING a.id`,
      [publishedIds, at],
    );
    const unreferenced = await db.query<{ id: string }>(
      `UPDATE community.catalog_media_assets a
       SET unreferenced_since=$2::timestamptz, updated_at=$2::timestamptz
       WHERE a.unreferenced_since IS NULL
         AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS published(id) WHERE published.id=a.id)
       RETURNING a.id`,
      [publishedIds, at],
    );
    for (const { id } of rereferenced.rows)
      marks.set(id, {
        reason: "reference",
        urgent: marks.get(id)?.urgent === true,
      });
    for (const { id } of unreferenced.rows)
      marks.set(id, {
        reason: "reference",
        urgent: !createdIds.has(id) || marks.get(id)?.urgent === true,
      });
    // A named asset whose source was unreadable gets another render once the
    // retry delay passed (bounded per pass); other failures stay final.
    await db.query(
      `UPDATE community.catalog_media_assets a
       SET state='pending', failure_code=NULL, updated_at=$2::timestamptz
       FROM (
         SELECT a.id FROM community.catalog_media_assets a
         WHERE a.state='failed' AND a.failure_code='source_unreadable'
           AND a.updated_at < $2::timestamptz - ${RETRY_DELAY_SQL}
           AND ${NAMED_SQL}
         ORDER BY a.updated_at, a.id
         LIMIT $3
         FOR UPDATE OF a
       ) due
       WHERE a.id=due.id`,
      [ids, at, options.limit],
    );
    const wanted = JSON.stringify(options.renditions);
    // The pass's job bound: with a queue target, only the room left below it
    // (W9), so the queue holds about the target and a new image of a higher
    // tier waits behind no more than that.
    const bound =
      target === undefined
        ? options.limit
        : Math.max(
            0,
            target -
              (
                await db.query<{ queued: number }>(
                  `SELECT count(*)::integer AS queued FROM community.publishing_jobs j
                   WHERE j.state='queued' AND ${baseCatalogRenderJobSql("j")}`,
                )
              ).rows[0]!.queued,
          );
    // A named asset is rendered while pending, or again while ready but
    // missing a ready rendition (on a committed blob) of a listed identity.
    // One queued or running job per asset (the active unique index); a
    // failed or abandoned job waits for the operator, as every scheduled
    // kind does, except as below. Jobs are queued in render order, and each
    // runs after the pass's time plus its rank in milliseconds: claims order
    // the jobs of one class by run_after, then by their random id, so
    // without the rank one pass's jobs would run in random order (W9). A
    // later pass's jobs run after this pass's, and user jobs keep their
    // claim class. First the tiered images (t0..t3) in the queue order:
    // every pending one, and every ready one missing a listed identity that
    // an intent names, in that intent's tier.
    const tieredQueued =
      bound === 0
        ? 0
        : ((
            await db.query(
              `WITH current AS (${CURRENT_ASSETS_SQL})
               INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,created_at,updated_at)
               SELECT 'publishing-job-' || replace(gen_random_uuid()::text, '-', ''), 'catalog_render', c.id,
                 'queued', 0, $2::timestamptz + (c.rank - 1) * interval '1 millisecond', $2::timestamptz, $2::timestamptz
               FROM (
                 SELECT due.id, row_number() OVER (ORDER BY due.ord) AS rank
                 FROM (
                   SELECT a.id, named.ord
                   FROM unnest($1::text[], $4::boolean[], $5::boolean[]) WITH ORDINALITY
                     AS named(id, pending, stale, ord)
                   JOIN community.catalog_media_assets a ON a.id=named.id
                   WHERE ((named.pending AND a.state='pending') OR (named.stale AND ${RERENDER_SQL}))
                     AND ${NO_RENDER_JOB_SQL}
                   ORDER BY named.ord
                   LIMIT $6
                 ) due
               ) c
               ORDER BY c.rank
               ON CONFLICT (kind, subject_id, md5(COALESCE(payload, '{}'::jsonb)::text)) WHERE state IN ('queued', 'running') DO NOTHING
               RETURNING id`,
              [
                tiered.map(({ id }) => id),
                at,
                wanted,
                tiered.map(({ pending }) => pending),
                tiered.map(({ stale }) => stale),
                bound,
              ],
            )
          ).rowCount ?? 0);
    // A ready asset still missing a listed identity whose latest render job
    // failed (its re-render was rejected, or its attempts were used up) keeps
    // its ready renditions; that job is queued again, with fresh attempts,
    // once the retry delay passed since it failed, so a rejection is retried
    // daily instead of on every pass. An abandoned job (the operator's stop)
    // still blocks. Only an asset of `namedIds`, at most `room` jobs, ranked
    // after the `offset` jobs this pass queued before, by when they failed.
    const requeueFailed = async (
      namedIds: readonly string[],
      room: number,
      offset: number,
    ): Promise<number> =>
      room <= 0 || namedIds.length === 0
        ? 0
        : ((
            await db.query(
              `UPDATE community.publishing_jobs j
               SET state='queued', attempts=0,
                   run_after=$2::timestamptz + ($5::integer + due.rank - 1) * interval '1 millisecond',
                   lease_owner=NULL, lease_expires_at=NULL, last_error_code=NULL, finished_at=NULL,
                   updated_at=$2::timestamptz
               FROM (
                 SELECT locked.id, row_number() OVER (ORDER BY locked.ended, locked.id) AS rank
                 FROM (
                   SELECT f.id, ${endedAtSql("f")} AS ended FROM community.publishing_jobs f
                   JOIN community.catalog_media_assets a ON a.id=f.subject_id
                   WHERE ${baseCatalogRenderJobSql("f")} AND f.state='failed'
                     AND ${endedAtSql("f")} < $2::timestamptz - ${RETRY_DELAY_SQL}
                     AND ${NAMED_SQL}
                     AND a.state='ready' AND ${MISSING_IDENTITY_SQL}
                     AND NOT EXISTS (
                       SELECT 1 FROM community.publishing_jobs o
                       WHERE ${baseCatalogRenderJobSql("o")} AND o.subject_id=f.subject_id AND o.id<>f.id
                         AND (o.state IN ('queued','running','abandoned')
                           OR (o.state='failed'
                             AND (${endedAtSql("o")}, o.id) > (${endedAtSql("f")}, f.id))))
                   ORDER BY ${endedAtSql("f")}, f.id
                   LIMIT $4
                   FOR UPDATE OF f SKIP LOCKED
                 ) locked
               ) due
               WHERE j.id=due.id AND j.state='failed'
               RETURNING j.id`,
              [namedIds, at, wanted, room, offset],
            )
          ).rowCount ?? 0);
    // Next the failed re-renders of the images an intent names, whether the
    // gate below opens or not: the same daily retry within the same bound,
    // ranked after the pass's tiered jobs (a retry comes at most once a day,
    // so it is not interleaved with them by tier).
    const intentRequeued = await requeueFailed(
      intentNamedIds,
      bound - tieredQueued,
      tieredQueued,
    );
    const tieredCount = tieredQueued + intentRequeued;
    // Then the re-renders (t4) of the images no intent names, only when no
    // image of a higher tier waits at this pass: every tiered one is queued
    // (room was left) and every named one has its asset (created a bounded
    // number a pass). A recipe bump of the published Catalog (its old set
    // keeps serving, N3) thus never takes a place a published, requested,
    // prepared or grace image of this pass could take, an intent's image
    // ready under the older recipe included; one that arrives at a later
    // pass waits behind at most the re-renders already queued (the target,
    // about 40 minutes), since claims follow the passes in turn.
    const rerendering =
      tieredCount < bound && uncreated.length <= options.limit;
    const rerendersQueued = !rerendering
      ? 0
      : ((
          await db.query(
            `WITH current AS (${CURRENT_ASSETS_SQL})
             INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,run_after,created_at,updated_at)
             SELECT 'publishing-job-' || replace(gen_random_uuid()::text, '-', ''), 'catalog_render', c.id,
               'queued', 0, $2::timestamptz + ($5::integer + c.rank - 1) * interval '1 millisecond',
               $2::timestamptz, $2::timestamptz
             FROM (
               SELECT due.id, row_number() OVER (ORDER BY due.ord) AS rank
               FROM (
                 SELECT a.id, named.ord
                 FROM unnest($1::text[]) WITH ORDINALITY AS named(id, ord)
                 JOIN community.catalog_media_assets a ON a.id=named.id
                 WHERE ${RERENDER_SQL} AND ${NO_RENDER_JOB_SQL}
                 ORDER BY named.ord
                 LIMIT $4
               ) due
             ) c
             ORDER BY c.rank
             ON CONFLICT (kind, subject_id, md5(COALESCE(payload, '{}'::jsonb)::text)) WHERE state IN ('queued', 'running') DO NOTHING
             RETURNING id`,
            [rerenderOrder, at, wanted, bound - tieredCount, tieredCount],
          )
        ).rowCount ?? 0);
    const queuedCount = tieredCount + rerendersQueued;
    // Last their failed re-renders (t4), ranked after the t4 jobs.
    const requeued = !rerendering
      ? 0
      : await requeueFailed(rerenderOrder, bound - queuedCount, queuedCount);
    // The backlog by tier after the pass (W9): every named image not
    // created yet or pending, in its tier, and every ready one missing a
    // listed identity, in its best intent's tier, else t4. Read only;
    // written below, after the commit.
    const backlog = Object.fromEntries(
      CATALOG_RENDER_TIERS.map((tier) => [tier, 0]),
    ) as Record<CatalogRenderTier, number>;
    for (const row of (
      await db.query<{ tier: number | null; assets: number }>(
        `WITH current AS (${CURRENT_ASSETS_SQL})
         SELECT CASE WHEN a.id IS NULL OR a.state='pending' THEN named.tier
             WHEN ${RERENDER_SQL} THEN COALESCE(named.intent_tier, 4) END AS tier,
           count(*)::integer AS assets
         FROM unnest($1::text[], $2::integer[], $4::integer[]) AS named(id, tier, intent_tier)
         LEFT JOIN community.catalog_media_assets a ON a.id=named.id
         GROUP BY 1`,
        [
          order,
          ordered.map(({ rank }) => rank.tier),
          wanted,
          ordered.map(({ id }) => intentRanks.get(id)?.tier ?? null),
        ],
      )
    ).rows) {
      const tier =
        row.tier === null ? undefined : CATALOG_RENDER_TIERS[row.tier];
      if (tier !== undefined) backlog[tier] = row.assets;
    }
    // The marks are the pass's last write, one statement in asset id order
    // after every asset and job row it writes (the lock order of
    // catalog-publication-dirty): the dirty rows are held only to commit.
    await markCatalogPublicationDirty(db, marks, now);
    return {
      backlog,
      counts: {
        referenced: ids.length,
        skipped,
        created: created.rowCount ?? 0,
        unreferenced: unreferenced.rowCount ?? 0,
        enqueued: queuedCount + requeued,
        ...(intents?.refused.length
          ? { refusedIntentIds: intents.refused }
          : {}),
        ...(intents?.mismatched.length
          ? { mismatchedIntentIds: intents.mismatched }
          : {}),
      },
    };
  });
  // The backlog goes to the reconcile state row in its own transaction,
  // after the pass committed: a transaction never takes that row after an
  // asset or dirty row (the lock order of catalog-publication-dirty), and
  // the pass need not wait for a reconcile that holds it. An older pass
  // never overwrites a newer one's. The backlog only informs the pacing: a
  // write that fails (a lost connection, the state row missing) never fails
  // the committed pass, whose counts and refused or mismatched intents the
  // caller must still log. It is flagged, and the next pass writes anew.
  const recorded = await recordCatalogRenderBacklog(
    pool,
    pass.backlog,
    now,
  ).then(
    () => true,
    () => false,
  );
  return recorded
    ? pass.counts
    : { ...pass.counts, renderBacklogRecorded: false };
};

/** The reconcile state row's render backlog: per tier, and when a sync
 * pass counted it (W9). */
export const catalogRenderBacklogWriteSql = `
  UPDATE community.catalog_reconcile_state
  SET render_backlog=$1::jsonb, render_backlog_at=$2::timestamptz, updated_at=$2::timestamptz
  WHERE id AND (render_backlog_at IS NULL OR render_backlog_at<=$2::timestamptz)`;

const recordCatalogRenderBacklog = async (
  pool: Pool,
  backlog: CatalogRenderBacklog,
  now: Date,
): Promise<void> => {
  await writeTransaction(pool, async (db) => {
    const written = await db.query(catalogRenderBacklogWriteSql, [
      JSON.stringify(backlog),
      nowParam(now),
    ]);
    if (
      written.rowCount !== 1 &&
      (
        await db.query(
          "SELECT 1 FROM community.catalog_reconcile_state WHERE id",
        )
      ).rowCount !== 1
    )
      throw new CatalogReconcileStateMissingError();
  });
};

/**
 * The Catalog render backlog for the later pacing (catalog-scale-v1 W9; an
 * internal read, no contract yet): the per-tier counts the last sync pass
 * recorded and when (null before the first), and the base `catalog_render`
 * jobs queued and running now. A missing state row throws. Pacing reads
 * every tier as images still to render, so a recorded count with a tier that
 * is missing or not a safe non-negative integer (corruption), or with a key
 * that is no tier this build knows (a newer worker's tier it would drop), is
 * reported as never counted (both null), which stops a wave; it is never
 * read as 0.
 */
export const readCatalogRenderBacklog = async (
  pool: Pick<Pool, "query">,
): Promise<{
  readonly tiers: CatalogRenderBacklog | null;
  readonly countedAt: Date | null;
  readonly queued: number;
  readonly running: number;
}> => {
  const row = (
    await pool.query<{
      render_backlog: Record<string, unknown> | null;
      render_backlog_at: Date | null;
      queued: number;
      running: number;
    }>(
      `SELECT s.render_backlog, s.render_backlog_at,
         (SELECT count(*)::integer FROM community.publishing_jobs j
          WHERE j.state='queued' AND ${baseCatalogRenderJobSql("j")}) AS queued,
         (SELECT count(*)::integer FROM community.publishing_jobs j
          WHERE j.state='running' AND ${baseCatalogRenderJobSql("j")}) AS running
       FROM community.catalog_reconcile_state s WHERE s.id`,
    )
  ).rows[0];
  if (row === undefined) throw new CatalogReconcileStateMissingError();
  const recorded = row.render_backlog;
  // Exactly the known tiers: as many keys, each of them counted below.
  const counts =
    recorded === null ||
    Object.keys(recorded).length !== CATALOG_RENDER_TIERS.length
      ? null
      : CATALOG_RENDER_TIERS.map((tier) => [tier, recorded[tier]] as const);
  const counted =
    counts !== null &&
    counts.every(
      ([, count]) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    );
  return {
    tiers: counted
      ? (Object.fromEntries(counts) as CatalogRenderBacklog)
      : null,
    countedAt: counted ? row.render_backlog_at : null,
    queued: row.queued,
    running: row.running,
  };
};

/** CatalogMediaAssetPort.readCatalogRenderPlan */
export const readCatalogRenderPlan = async (
  pool: Pool,
  assetId: string,
): Promise<CatalogRenderPlan | null> => {
  assertAssetId(assetId);
  return readTransaction(pool, async (db) => {
    const asset = (
      await db.query<{
        id: string;
        media_id: string;
        source_object_key: string;
        source_width: number | null;
        source_height: number | null;
        state: "pending" | "ready" | "failed";
        unreferenced_since: Date | null;
        referenced: boolean;
        master_sha256: string | null;
        master_width: number | null;
        master_height: number | null;
      }>(
        // Referenced while published, while a live intent names it, and
        // while an intent in render grace does (W10: rendering only).
        `SELECT id, media_id, source_object_key, source_width, source_height, state, unreferenced_since,master_sha256,master_width,master_height,
          (unreferenced_since IS NULL OR ${catalogPrivateProcessingReferenceSql("id")}
            OR ${catalogRenderGraceReferenceSql("id")}) AS referenced
         FROM community.catalog_media_assets WHERE id=$1`,
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed") return null;
    const key = approvedKey(asset.source_object_key);
    if (key === null) return null;
    const ready = await db.query<{
      role: CatalogRenditionIdentity["role"];
      recipe_version: number;
      recipe_digest: string;
      width: number;
      height: number;
    }>(
      `SELECT r.role, r.recipe_version, r.recipe_digest, r.width, r.height
       FROM ${LIVE_RENDITION_SQL}
       WHERE r.catalog_asset_id=$1 AND r.state='ready'
         AND r.role IN ('thumb','cover','display','viewer')
       ORDER BY r.role`,
      [assetId],
    );
    return {
      assetId: asset.id,
      mediaId: asset.media_id,
      sourceObjectKey: asset.source_object_key,
      sourceSha256: key.sha256,
      sourceContentType: key.contentType,
      sourceWidth: asset.source_width,
      sourceHeight: asset.source_height,
      state: asset.state,
      referenced: asset.referenced,
      masterSha256: asset.master_sha256,
      masterWidth: asset.master_width,
      masterHeight: asset.master_height,
      ready: ready.rows.map((row) => ({
        role: row.role,
        version: row.recipe_version,
        digest: row.recipe_digest,
        width: row.width,
        height: row.height,
      })),
    };
  });
};

const assertOutcome = (outcome: CatalogRenderOutcome): void => {
  const sideOk = (value: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION;
  if (
    !SHA256.test(outcome.masterSha256) ||
    !sideOk(outcome.masterWidth) ||
    !sideOk(outcome.masterHeight) ||
    (outcome.placeholderColor !== null &&
      !PLACEHOLDER_COLOR.test(outcome.placeholderColor)) ||
    !Array.isArray(outcome.renditions)
  )
    throw new TypeError("Malformed Catalog render outcome");
  for (const record of outcome.renditions)
    if (!CATALOG_ROLES.has(record.role))
      throw new TypeError("Unknown Catalog rendition role");
};

/** CatalogMediaAssetPort.recordCatalogRenditions */
export const recordCatalogRenditions = async (
  pool: Pool,
  assetId: string,
  outcome: CatalogRenderOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  assertAssetId(assetId);
  assertOutcome(outcome);
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    const asset = (
      await db.query<{ state: string; source_sha256: string | null }>(
        "SELECT state, source_sha256 FROM community.catalog_media_assets WHERE id=$1 FOR UPDATE",
        [assetId],
      )
    ).rows[0];
    if (asset === undefined || asset.state === "failed")
      return {
        status: "discarded",
        storageKeys: await unrecordedKeys(db, outcome.renditions),
      };
    if (
      asset.source_sha256 !== null &&
      asset.source_sha256 !== outcome.masterSha256
    )
      throw new TypeError("The rendered source is not the asset's source");
    const { duplicates } = await recordRenditionRows(
      db,
      { kind: "catalog", id: assetId },
      outcome.renditions.map((record) => ({
        storageKey: record.storageKey,
        byteSize: record.byteSize,
        sha256: record.sha256,
        role: record.role,
        editKey: "base",
        contentType: record.contentType,
        width: record.width,
        height: record.height,
        durationMs: null,
        recipeVersion: record.recipeVersion,
        recipeDigest: record.recipeDigest,
      })),
      now,
    );
    await db.query(
      `UPDATE community.catalog_media_assets
       SET state='ready', failure_code=NULL, master_sha256=$2, master_width=$3, master_height=$4,
           placeholder_color=$5, updated_at=$6::timestamptz
       WHERE id=$1`,
      [
        assetId,
        outcome.masterSha256,
        outcome.masterWidth,
        outcome.masterHeight,
        outcome.placeholderColor,
        at,
      ],
    );
    // New renditions are copied only by a reconcile that plans the asset: a
    // first render of a published image, or a recipe re-render whose set
    // replaces the one serving (N3). The mark puts the asset in the next
    // scoped pass (catalog-scale-v1 W7/W8) instead of waiting for the sweep;
    // it is the last write, after the asset row's lock.
    await markCatalogPublicationDirty(
      db,
      new Map([[assetId, { reason: "rendition", urgent: false }]]),
      now,
    );
    return duplicates.length === 0
      ? { status: "recorded" }
      : { status: "discarded", storageKeys: duplicates };
  });
};

/** CatalogMediaAssetPort.failCatalogAsset */
export const failCatalogAsset = async (
  pool: Pool,
  assetId: string,
  failureCode: string,
  now: Date,
): Promise<void> => {
  assertAssetId(assetId);
  if (!FAILURE_CODE.test(failureCode))
    throw new TypeError("Catalog failure codes are content-free identifiers");
  const at = nowParam(now);
  await writeTransaction(pool, (db) =>
    db.query(
      `UPDATE community.catalog_media_assets
       SET state='failed', failure_code=$2, updated_at=$3::timestamptz
       WHERE id=$1 AND state='pending'`,
      [assetId, failureCode, at],
    ),
  );
};
