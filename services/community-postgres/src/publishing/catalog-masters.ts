import { randomUUID } from "node:crypto";

import type {
  CatalogBlockGuardCounts,
  CatalogDisplayMasterPort,
  CatalogMasterAttach,
  CatalogMasterAttached,
  CatalogMasterCandidate,
  CatalogMasterEndReason,
  CatalogMasterRefusal,
  CatalogMasterResult,
  CatalogMasterStatus,
  CatalogMasterStatusRow,
  CatalogMasterStorage,
} from "@moya/api";
import {
  CATALOG_ZOOM_MAX_LONG_EDGE,
  sameMediaFraming,
} from "@moya/contracts/schemas";
import type { Pool } from "pg";

import {
  nowParam,
  readTransaction,
  safeInteger,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { catalogBlockJobSql } from "./jobs.js";
import {
  catalogBlockGrid,
  catalogBlockSetIncompleteSql,
  catalogMasterFrame,
  enqueueMissingCatalogBlocks,
  readCatalogBlockSet,
} from "./catalog-zoom-blocks.js";

/*
 * The store of the `catalog-master` command (catalog-deep-zoom-v1): attach,
 * re-attach, limit, detach and erase private Catalog display masters, requeue
 * a paused block set, report status, storage and the rollback guard, and name
 * the published original a self-master is read from
 * (catalog-deep-zoom-self-master-v1). Each write is one transaction that
 * locks the Catalog asset row first (the lock order of Catalog renders), then
 * master rows, blobs and jobs, and re-checks every precondition there.
 * Results are content-free.
 */

/** The first pipeline release (Asia/Shanghai day start): bytes since count toward T0. */
export const CATALOG_MASTER_TASK_SINCE = "2026-10-07T00:00:00+08:00";
/**
 * Masters plus blocks, private and published (the slice cap). 20 GiB holds
 * every self-master the activation plan counts: 313 images, about 7.3 GB of
 * master copies plus 6.3–8.4 GB of blocks (13,034 cells, private and
 * published), so about 14–16 GB; it was 10 GiB. The value awaits the Owner's
 * confirmation (#206 r23) and is set here only.
 */
export const CATALOG_MASTER_SLICE_CAP = 20 * 1024 ** 3;
/** Every byte #206 created: 50 GB less a 5 GB margin (D4). */
export const CATALOG_MASTER_TASK_CAP = 45 * 1000 ** 3;
/**
 * Projected bytes per frame pixel of a block set, private and published
 * copies together. Above the plan's estimate (13,034 cells of about 1 MP
 * would project about 13 GB against 6.3–8.4 GB), so an uncut set is never
 * under-counted.
 */
export const CATALOG_BLOCK_PROJECTED_BYTES_PER_PIXEL = 1;
/**
 * The approved image stays at or below this long edge (RP-11), unless the
 * master is a self-master (`isSelfMaster`; the RP-11 revision awaits the
 * Owner's confirmation, #206 r23).
 */
export const CATALOG_APPROVED_MAX_LONG_EDGE = 4096;
/** Blocks exist only where the frame gains at least this over the viewer. */
export const CATALOG_BLOCK_MIN_GAIN = 1.25;
/** The base the viewer shows is at least this share of the frame (one level). */
export const CATALOG_BLOCK_MIN_BASE_SHARE = 0.45;
/** Oriented master and approved image aspects differ by at most this share. */
export const CATALOG_MASTER_ASPECT_TOLERANCE = 0.002;

const MEDIA_ID = /^[^\s]{1,128}$/u;
const MASTER_ID = /^catalog-master-[0-9a-f]{32}$/u;
const CATALOG_ID = /^[^\s]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const STORAGE_KEY = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/u;
const DISPLAY_KEY = /^display\/v1\/media_[a-f0-9]{32}\/([a-f0-9]{64})\.webp$/u;
const EDITORIAL_KEY =
  /^editorial\/[a-f0-9]{64}\/[a-f0-9]{64}-([a-f0-9]{64})\.(?:jpg|png|webp)$/u;

const approvedSha = (key: string): string | null =>
  DISPLAY_KEY.exec(key)?.[1] ?? EDITORIAL_KEY.exec(key)?.[1] ?? null;

/** SHA-256 of the approved image's bytes: the asset's, else its key's. */
const approvedOf = (asset: {
  readonly source_sha256: string | null;
  readonly source_object_key: string;
}): string | null =>
  asset.source_sha256 ?? approvedSha(asset.source_object_key);

const refused = (
  code: CatalogMasterRefusal,
  storage?: CatalogMasterStorage,
): {
  readonly status: "refused";
  readonly code: CatalogMasterRefusal;
  readonly storage?: CatalogMasterStorage;
} =>
  storage === undefined
    ? { status: "refused", code }
    : { status: "refused", code, storage };

interface AssetRow {
  id: string;
  media_id: string;
  source_object_key: string;
  source_sha256: string | null;
  state: string;
  unreferenced_since: Date | null;
  /** What the base render decoded: the source's SHA-256 and oriented size. */
  master_sha256: string | null;
  master_width: number | null;
  master_height: number | null;
  published_width: number;
  published_height: number;
  viewer_long_edge: number | null;
}

interface MasterRow {
  id: string;
  catalog_asset_id: string;
  blob_id: string;
  master_sha256: string;
  content_type: "image/jpeg" | "image/png";
  master_width: number;
  master_height: number;
  derivation: "submitted" | "edited-export";
  max_long_edge: number;
  frame_width: number;
  frame_height: number;
  note: string | null;
  operator: string;
  ended_at: Date | null;
  end_reason: CatalogMasterEndReason | null;
}

/** SQL: blob alias belongs to a block rendition (catalog-deep-zoom-v1). */
const blockBlobSql = (blob: string): string =>
  `EXISTS (SELECT 1 FROM community.media_renditions br WHERE br.blob_id=${blob}.id AND br.catalog_master_id IS NOT NULL)`;

/**
 * The live storage figures. Besides the bytes that exist, both count the
 * projected blocks of every active master whose set is not yet cut (all of
 * its frame, so a partly cut set counts twice for a while): blocks are cut
 * only on an idle queue, so an `attach-batch` attaches far faster than the
 * cutting, and without them each attach would see none of the earlier
 * attaches' blocks. Once a set is cut, the published copy of every ready
 * block that has no live publication yet stays counted at its blob's size:
 * publication rows come in a later pass, and without it a later attach could
 * take that room and both bounds would be passed when they land. The task
 * figure counts them too: D4 refuses an attach that would pass either bound,
 * and the same overshoot would pass the 45 GB one. `ending` names masters
 * this transaction ends, whose projection the new frame replaces.
 */
const storageOf = async (
  db: PublishingDb,
  attachBytes: number,
  ending: readonly string[] = [],
): Promise<CatalogMasterStorage> => {
  const row = (
    await db.query<{
      task_bytes: string;
      slice_bytes: string;
      pending_bytes: string;
    }>(
      `SELECT
         (SELECT COALESCE(sum(b.byte_size),0) FROM community.media_blobs b
          WHERE b.state='committed' AND (b.created_at >= $1::timestamptz OR b.retention_hold IS NOT NULL))
         + (SELECT COALESCE(sum(p.byte_size),0) FROM community.media_publications p WHERE p.state <> 'withdrawn')
           AS task_bytes,
         (SELECT COALESCE(sum(b.byte_size),0) FROM community.media_blobs b
          WHERE b.state='committed' AND (b.purpose='catalog_master' OR ${blockBlobSql("b")}))
         + (SELECT COALESCE(sum(p.byte_size),0) FROM community.media_publications p
            WHERE p.state <> 'withdrawn' AND p.role ~ '^block-[0-9]{2}$')
           AS slice_bytes,
         (SELECT COALESCE(sum(CASE WHEN ${catalogBlockSetIncompleteSql("m")}
            THEN m.frame_width::bigint * m.frame_height * $2::bigint
            ELSE (SELECT COALESCE(sum(rb.byte_size),0) FROM community.media_renditions r
              JOIN community.media_blobs rb ON rb.id=r.blob_id AND rb.state='committed'
              WHERE r.catalog_master_id=m.id AND r.state='ready'
                AND NOT EXISTS (SELECT 1 FROM community.media_publications p
                  WHERE p.rendition_id=r.id AND p.state <> 'withdrawn'))
            END),0)
          FROM community.catalog_display_masters m
          WHERE m.ended_at IS NULL AND NOT (m.id = ANY($3::text[])))
           AS pending_bytes`,
      [
        CATALOG_MASTER_TASK_SINCE,
        CATALOG_BLOCK_PROJECTED_BYTES_PER_PIXEL,
        [...ending],
      ],
    )
  ).rows[0]!;
  const pending = safeInteger(row.pending_bytes);
  return {
    taskBytes: safeInteger(row.task_bytes) + pending,
    sliceBytes: safeInteger(row.slice_bytes) + pending,
    attachBytes,
    sliceCap: CATALOG_MASTER_SLICE_CAP,
    taskCap: CATALOG_MASTER_TASK_CAP,
  };
};

/**
 * Serializes the bounded storage checks of concurrent `catalog-master`
 * processes. Taken after the asset lock and before `storageOf`, it makes a
 * second attach or limit read totals that include the first one's committed
 * master, so two of them cannot both pass a bound.
 */
const lockStorage = async (db: PublishingDb): Promise<void> => {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('catalog-master-storage',0))",
  );
};

const withinBounds = (
  storage: CatalogMasterStorage,
): CatalogMasterRefusal | null =>
  storage.sliceBytes + storage.attachBytes > storage.sliceCap
    ? "storage_slice_cap"
    : storage.taskBytes + storage.attachBytes > storage.taskCap
      ? "storage_task_cap"
      : null;

/**
 * The published image a media id names and its asset, locked: the asset of
 * the approved key the published projection names right now, with the long
 * edge of its ready `viewer` (or `display` when the plan had no viewer).
 * `sourceOf` reads the same rows in a read-only snapshot, without the lock.
 */
const lockPublishedAsset = async (
  db: PublishingDb,
  mediaId: string,
  lock = true,
): Promise<AssetRow | "not_published" | "asset_not_ready"> => {
  const published = await db.query<{
    object_key: string;
    width: number;
    height: number;
  }>(
    "SELECT DISTINCT object_key, width, height FROM public.catalog_media WHERE media_id=$1",
    [mediaId],
  );
  if (published.rows.length !== 1) return "not_published";
  const image = published.rows[0]!;
  const asset = (
    await db.query<
      Omit<
        AssetRow,
        "published_width" | "published_height" | "viewer_long_edge"
      >
    >(
      `SELECT id, media_id, source_object_key, source_sha256, state, unreferenced_since,
         master_sha256, master_width, master_height
       FROM community.catalog_media_assets
       WHERE media_id=$1 AND source_object_key=$2${lock ? " FOR UPDATE" : ""}`,
      [mediaId, image.object_key],
    )
  ).rows[0];
  if (
    asset === undefined ||
    asset.state !== "ready" ||
    asset.unreferenced_since !== null
  )
    return "asset_not_ready";
  const viewer = (
    await db.query<{ long_edge: number }>(
      `SELECT GREATEST(r.width, r.height) AS long_edge FROM community.media_renditions r
       JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
       WHERE r.catalog_asset_id=$1 AND r.state='ready' AND r.role IN ('viewer','display')
       ORDER BY CASE r.role WHEN 'viewer' THEN 0 ELSE 1 END LIMIT 1`,
      [asset.id],
    )
  ).rows[0];
  return {
    ...asset,
    published_width: image.width,
    published_height: image.height,
    viewer_long_edge: viewer?.long_edge ?? null,
  };
};

/**
 * A self-master (catalog-deep-zoom-self-master-v1; the RP-11 revision awaits
 * the Owner's confirmation, #206 r23): the published `editorial/` original is
 * its own master. All four hold: the approved key is an `editorial/` key; the
 * master's SHA-256 is the approved image's (the key's and the asset's) and the
 * one the base render recorded; its oriented size is the one the base render
 * decoded; and it is the submitted file. Only such a master lifts the 4096 px
 * bound on the approved image; every other check still applies, and the
 * public still receives only the 1024 px blocks of a frame of at most 8192 px.
 * A rotated original whose recorded size is not oriented fails closed.
 */
const isSelfMaster = (
  asset: AssetRow,
  master: {
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly derivation: CatalogMasterAttach["derivation"];
  },
): boolean =>
  EDITORIAL_KEY.exec(asset.source_object_key)?.[1] === master.sha256 &&
  approvedOf(asset) === master.sha256 &&
  asset.master_sha256 === master.sha256 &&
  asset.master_width === master.width &&
  asset.master_height === master.height &&
  master.derivation === "submitted";

/** The checks every attach and limit change shares; null when they pass. */
const frameRefusal = (
  asset: AssetRow,
  master: { readonly width: number; readonly height: number },
  frame: { readonly width: number; readonly height: number },
  selfMaster: boolean,
): CatalogMasterRefusal | null => {
  const approvedLong = Math.max(asset.published_width, asset.published_height);
  if (approvedLong > CATALOG_APPROVED_MAX_LONG_EDGE && !selfMaster)
    return "approved_too_large";
  // Oriented aspects within 0.2 %: |mw·ah − mh·aw| ≤ 0.002 · mw·ah.
  const left = master.width * asset.published_height;
  const right = master.height * asset.published_width;
  if (
    Math.abs(left - right) >
    CATALOG_MASTER_ASPECT_TOLERANCE * Math.max(left, right)
  )
    return "aspect_mismatch";
  // The Detail carries a frame only when it shows the approved image's
  // framing within the rounding of each side (the public contract), so a
  // master whose frame cannot is refused here rather than cut and never shown.
  if (
    !sameMediaFraming(frame, {
      width: asset.published_width,
      height: asset.published_height,
    })
  )
    return "aspect_mismatch";
  if (asset.viewer_long_edge === null) return "asset_not_ready";
  const frameLong = Math.max(frame.width, frame.height);
  if (frameLong < CATALOG_BLOCK_MIN_GAIN * asset.viewer_long_edge)
    return "gain_too_small";
  if (asset.viewer_long_edge < CATALOG_BLOCK_MIN_BASE_SHARE * frameLong)
    return "base_too_small";
  if (catalogBlockGrid(frame.width, frame.height).cells < 2)
    return "gain_too_small";
  return null;
};

const masterId = (): string =>
  `catalog-master-${randomUUID().replaceAll("-", "")}`;

/** Ends rows, abandons their queued block jobs and releases their blocks. */
const endMasters = async (
  db: PublishingDb,
  ids: readonly string[],
  reason: CatalogMasterEndReason,
  at: string,
): Promise<void> => {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE community.catalog_display_masters SET ended_at=$2::timestamptz, end_reason=$3
     WHERE id=ANY($1::text[]) AND ended_at IS NULL`,
    [ids, at, reason],
  );
  await db.query(
    `UPDATE community.publishing_jobs j SET state='abandoned', last_error_code='master_ended',
       lease_owner=NULL, lease_expires_at=NULL, finished_at=$2::timestamptz, updated_at=$2::timestamptz
     WHERE ${catalogBlockJobSql("j")} AND j.payload->>'masterId'=ANY($1::text[]) AND j.state='queued'`,
    [ids, at],
  );
  // A replaced block set is released at once; the existing purge removes its
  // private blobs, and the published copies leave the desired set.
  await db.query(
    `UPDATE community.media_renditions SET state='released', released_at=$2::timestamptz
     WHERE catalog_master_id=ANY($1::text[]) AND state='ready'`,
    [ids, at],
  );
};

const insertMaster = async (
  db: PublishingDb,
  row: Omit<MasterRow, "id" | "ended_at" | "end_reason">,
  at: string,
): Promise<string> => {
  const id = masterId();
  await db.query(
    `INSERT INTO community.catalog_display_masters(
       id, catalog_asset_id, blob_id, master_sha256, content_type, master_width, master_height,
       derivation, max_long_edge, frame_width, frame_height, note, operator, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz)`,
    [
      id,
      row.catalog_asset_id,
      row.blob_id,
      row.master_sha256,
      row.content_type,
      row.master_width,
      row.master_height,
      row.derivation,
      row.max_long_edge,
      row.frame_width,
      row.frame_height,
      row.note,
      row.operator,
      at,
    ],
  );
  return id;
};

const assertAttach = (input: CatalogMasterAttach): void => {
  const header = input.header;
  if (
    !MEDIA_ID.test(input.mediaId) ||
    !SHA256.test(input.approvedSha256) ||
    !SHA256.test(input.masterSha256) ||
    !OPERATOR.test(input.operator) ||
    !(
      input.derivation === "submitted" || input.derivation === "edited-export"
    ) ||
    !Number.isSafeInteger(input.maxLongEdge) ||
    input.maxLongEdge < 1 ||
    input.maxLongEdge > CATALOG_ZOOM_MAX_LONG_EDGE ||
    (input.note !== null &&
      (input.note.length < 1 ||
        input.note.length > 500 ||
        input.note !== input.note.trim())) ||
    !(
      header.contentType === "image/jpeg" || header.contentType === "image/png"
    ) ||
    !Number.isSafeInteger(header.width) ||
    !Number.isSafeInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > 65_535 ||
    header.height > 65_535
  )
    throw new TypeError("Malformed Catalog master attach");
  const source = input.source;
  if (
    (source.kind === "upload" &&
      (!STORAGE_KEY.test(source.storageKey) ||
        !Number.isSafeInteger(source.byteSize) ||
        source.byteSize < 1)) ||
    (source.kind === "dry_run" &&
      (!Number.isSafeInteger(source.byteSize) || source.byteSize < 0)) ||
    (source.kind === "existing" && !MASTER_ID.test(source.masterId))
  )
    throw new TypeError("Malformed Catalog master source");
};

export class PostgresCatalogDisplayMasterAdapter implements CatalogDisplayMasterPort {
  constructor(private readonly pool: Pool) {}

  async listCandidates(
    catalogId: string,
  ): Promise<readonly CatalogMasterCandidate[]> {
    if (!CATALOG_ID.test(catalogId)) throw new TypeError("Unknown catalog id");
    return readTransaction(this.pool, async (db) => {
      const rows = await db.query<{
        media_id: string;
        object_key: string;
        width: number;
        height: number;
        state: "pending" | "ready" | "failed" | null;
        viewer_long_edge: number | null;
        master_id: string | null;
      }>(
        `SELECT cm.media_id, cm.object_key, cm.width, cm.height, a.state,
           (SELECT GREATEST(r.width, r.height) FROM community.media_renditions r
            JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
            WHERE r.catalog_asset_id=a.id AND r.state='ready' AND r.role IN ('viewer','display')
            ORDER BY CASE r.role WHEN 'viewer' THEN 0 ELSE 1 END LIMIT 1) AS viewer_long_edge,
           (SELECT m.id FROM community.catalog_display_masters m
            WHERE m.catalog_asset_id=a.id AND m.ended_at IS NULL) AS master_id
         FROM public.catalog_media cm
         LEFT JOIN community.catalog_media_assets a
           ON a.media_id=cm.media_id AND a.source_object_key=cm.object_key
         WHERE cm.catalog_id=$1
         ORDER BY cm.position, cm.media_id`,
        [catalogId],
      );
      return rows.rows.map((row) => ({
        mediaId: row.media_id,
        approvedSha256: approvedSha(row.object_key),
        width: row.width,
        height: row.height,
        assetState: row.state ?? "missing",
        viewerLongEdge: row.viewer_long_edge,
        activeMasterId: row.master_id,
      }));
    });
  }

  async sourceOf(mediaId: string): Promise<
    CatalogMasterResult<{
      readonly objectKey: string;
      readonly approvedSha256: string;
    }>
  > {
    if (!MEDIA_ID.test(mediaId)) throw new TypeError("Unknown media id");
    return readTransaction(this.pool, async (db) => {
      const asset = await lockPublishedAsset(db, mediaId, false);
      if (typeof asset === "string") return refused(asset);
      const approved = approvedOf(asset);
      if (
        approved === null ||
        EDITORIAL_KEY.exec(asset.source_object_key)?.[1] !== approved
      )
        return refused("not_editorial");
      const active = await db.query(
        "SELECT 1 FROM community.catalog_display_masters WHERE catalog_asset_id=$1 AND ended_at IS NULL",
        [asset.id],
      );
      if ((active.rowCount ?? 0) > 0) return refused("already_attached");
      return {
        status: "done",
        objectKey: asset.source_object_key,
        approvedSha256: approved,
      };
    });
  }

  async attach(
    input: CatalogMasterAttach,
    now: Date,
  ): Promise<CatalogMasterResult<CatalogMasterAttached>> {
    assertAttach(input);
    const at = nowParam(now);
    return writeTransaction(this.pool, async (db) => {
      const asset = await lockPublishedAsset(db, input.mediaId);
      if (typeof asset === "string") return refused(asset);
      if (approvedOf(asset) !== input.approvedSha256)
        return refused("approved_mismatch");
      const active = (
        await db.query<{ id: string }>(
          "SELECT id FROM community.catalog_display_masters WHERE catalog_asset_id=$1 AND ended_at IS NULL FOR UPDATE",
          [asset.id],
        )
      ).rows[0];
      if (active !== undefined) return refused("already_attached");
      let previous: MasterRow | undefined;
      let header = input.header;
      if (input.source.kind === "existing") {
        previous = (
          await db.query<MasterRow>(
            "SELECT * FROM community.catalog_display_masters WHERE id=$1 FOR UPDATE",
            [input.source.masterId],
          )
        ).rows[0];
        if (previous === undefined) return refused("master_not_found");
        if (previous.master_sha256 !== input.masterSha256)
          return refused("master_mismatch");
        const blob = (
          await db.query<{ state: string; retention_hold: string | null }>(
            "SELECT state, retention_hold FROM community.media_blobs WHERE id=$1 FOR UPDATE",
            [previous.blob_id],
          )
        ).rows[0];
        if (
          blob?.state !== "committed" ||
          blob.retention_hold !== "catalog_master"
        )
          return refused("master_not_held");
        const elsewhere = await db.query(
          "SELECT 1 FROM community.catalog_display_masters WHERE blob_id=$1 AND ended_at IS NULL AND id<>$2",
          [previous.blob_id, previous.id],
        );
        if ((elsewhere.rowCount ?? 0) > 0) return refused("master_active");
        if (previous.ended_at === null) {
          // Still active on an asset the projection no longer names (an
          // image replaced in Admin): the re-attach ends it.
          const referenced = (
            await db.query<{ referenced: boolean }>(
              "SELECT unreferenced_since IS NULL AS referenced FROM community.catalog_media_assets WHERE id=$1",
              [previous.catalog_asset_id],
            )
          ).rows[0]?.referenced;
          if (referenced !== false) return refused("master_active");
        }
        header = {
          contentType: previous.content_type,
          width: previous.master_width,
          height: previous.master_height,
        };
      }
      const frame = catalogMasterFrame(
        header.width,
        header.height,
        input.maxLongEdge,
      );
      const failure = frameRefusal(
        asset,
        header,
        frame,
        isSelfMaster(asset, {
          sha256: input.masterSha256,
          width: header.width,
          height: header.height,
          derivation: input.derivation,
        }),
      );
      if (failure !== null) return refused(failure);
      const projected =
        frame.width * frame.height * CATALOG_BLOCK_PROJECTED_BYTES_PER_PIXEL;
      const masterBytes =
        input.source.kind === "existing" ? 0 : input.source.byteSize;
      await lockStorage(db);
      const storage = await storageOf(
        db,
        masterBytes + projected,
        previous !== undefined && previous.ended_at === null
          ? [previous.id]
          : [],
      );
      const bound = withinBounds(storage);
      if (bound !== null) return refused(bound, storage);
      const cells = catalogBlockGrid(frame.width, frame.height).cells;
      if (
        input.source.kind === "dry_run" ||
        (input.source.kind === "existing" && input.source.dryRun === true)
      )
        return {
          status: "done",
          masterId: null,
          frameWidth: frame.width,
          frameHeight: frame.height,
          cells,
          storage,
        };
      let blobId: string;
      if (input.source.kind === "upload") {
        blobId = `media-blob-${randomUUID().replaceAll("-", "")}`;
        await db.query(
          `INSERT INTO community.media_blobs(id,owner_id,purpose,storage_key,byte_size,sha256,content_type,state,created_at,retention_hold)
           VALUES($1,NULL,'catalog_master',$2,$3,$4,$5,'committed',$6::timestamptz,'catalog_master')`,
          [
            blobId,
            input.source.storageKey,
            input.source.byteSize,
            input.masterSha256,
            header.contentType,
            at,
          ],
        );
      } else {
        blobId = previous!.blob_id;
        if (previous!.ended_at === null)
          await endMasters(db, [previous!.id], "reattached", at);
      }
      const id = await insertMaster(
        db,
        {
          catalog_asset_id: asset.id,
          blob_id: blobId,
          master_sha256: input.masterSha256,
          content_type: header.contentType,
          master_width: header.width,
          master_height: header.height,
          derivation: input.derivation,
          max_long_edge: input.maxLongEdge,
          frame_width: frame.width,
          frame_height: frame.height,
          note: input.note,
          operator: input.operator,
        },
        at,
      );
      return {
        status: "done",
        masterId: id,
        frameWidth: frame.width,
        frameHeight: frame.height,
        cells,
        storage,
      };
    });
  }

  async setLimit(
    mediaId: string,
    maxLongEdge: number,
    operator: string,
    now: Date,
  ): Promise<CatalogMasterResult<CatalogMasterAttached>> {
    if (
      !MEDIA_ID.test(mediaId) ||
      !OPERATOR.test(operator) ||
      !Number.isSafeInteger(maxLongEdge) ||
      maxLongEdge < 1 ||
      maxLongEdge > CATALOG_ZOOM_MAX_LONG_EDGE
    )
      throw new TypeError("Malformed Catalog master limit");
    const at = nowParam(now);
    return writeTransaction(this.pool, async (db) => {
      const asset = await lockPublishedAsset(db, mediaId);
      if (typeof asset === "string") return refused(asset);
      const active = (
        await db.query<MasterRow>(
          "SELECT * FROM community.catalog_display_masters WHERE catalog_asset_id=$1 AND ended_at IS NULL FOR UPDATE",
          [asset.id],
        )
      ).rows[0];
      if (active === undefined) return refused("no_active_master");
      const master = {
        width: active.master_width,
        height: active.master_height,
      };
      const frame = catalogMasterFrame(
        master.width,
        master.height,
        maxLongEdge,
      );
      const failure = frameRefusal(
        asset,
        master,
        frame,
        isSelfMaster(asset, {
          sha256: active.master_sha256,
          ...master,
          derivation: active.derivation,
        }),
      );
      if (failure !== null) return refused(failure);
      await lockStorage(db);
      const storage = await storageOf(
        db,
        frame.width * frame.height * CATALOG_BLOCK_PROJECTED_BYTES_PER_PIXEL,
        [active.id],
      );
      const bound = withinBounds(storage);
      if (bound !== null) return refused(bound, storage);
      await endMasters(db, [active.id], "limit_changed", at);
      const id = await insertMaster(
        db,
        {
          ...active,
          max_long_edge: maxLongEdge,
          frame_width: frame.width,
          frame_height: frame.height,
          operator,
        },
        at,
      );
      return {
        status: "done",
        masterId: id,
        frameWidth: frame.width,
        frameHeight: frame.height,
        cells: catalogBlockGrid(frame.width, frame.height).cells,
        storage,
      };
    });
  }

  async detach(
    target: { readonly mediaId: string } | { readonly all: true },
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly ended: number }>> {
    if ("mediaId" in target && !MEDIA_ID.test(target.mediaId))
      throw new TypeError("Unknown media id");
    const at = nowParam(now);
    return writeTransaction(this.pool, async (db) => {
      // Every asset of the media id (a replaced image has an old and a new
      // one), locked in id order before its master rows.
      const assets = (
        await db.query<{ id: string }>(
          "mediaId" in target
            ? "SELECT a.id FROM community.catalog_media_assets a WHERE a.media_id=$1 AND EXISTS (SELECT 1 FROM community.catalog_display_masters m WHERE m.catalog_asset_id=a.id AND m.ended_at IS NULL) ORDER BY a.id FOR UPDATE"
            : "SELECT a.id FROM community.catalog_media_assets a WHERE EXISTS (SELECT 1 FROM community.catalog_display_masters m WHERE m.catalog_asset_id=a.id AND m.ended_at IS NULL) ORDER BY a.id FOR UPDATE",
          "mediaId" in target ? [target.mediaId] : [],
        )
      ).rows.map((row) => row.id);
      const masters = (
        await db.query<{ id: string }>(
          "SELECT id FROM community.catalog_display_masters WHERE catalog_asset_id=ANY($1::text[]) AND ended_at IS NULL ORDER BY id FOR UPDATE",
          [assets],
        )
      ).rows.map((row) => row.id);
      if (masters.length === 0) return refused("no_active_master");
      await endMasters(db, masters, "detached", at);
      return { status: "done", ended: masters.length };
    });
  }

  async erase(
    id: string,
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly byteSize: number }>> {
    if (!MASTER_ID.test(id)) throw new TypeError("Unknown master id");
    const at = nowParam(now);
    return writeTransaction(this.pool, async (db) => {
      const master = (
        await db.query<{ blob_id: string }>(
          "SELECT blob_id FROM community.catalog_display_masters WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (master === undefined) return refused("master_not_found");
      // Master rows before the blob, the order attach --existing-master takes.
      const rows = (
        await db.query<{ id: string; ended_at: Date | null }>(
          "SELECT id, ended_at FROM community.catalog_display_masters WHERE blob_id=$1 ORDER BY id FOR UPDATE",
          [master.blob_id],
        )
      ).rows;
      const blob = (
        await db.query<{
          state: string;
          retention_hold: string | null;
          byte_size: string;
        }>(
          "SELECT state, retention_hold, byte_size FROM community.media_blobs WHERE id=$1 FOR UPDATE",
          [master.blob_id],
        )
      ).rows[0];
      if (
        blob?.state !== "committed" ||
        blob.retention_hold !== "catalog_master"
      )
        return refused("master_not_held");
      if (rows.some((row) => row.ended_at === null))
        return refused("master_active");
      const published = await db.query(
        `SELECT 1 FROM community.media_publications p
         JOIN community.media_blobs pb ON pb.storage_key=p.storage_key
         JOIN community.media_renditions r ON r.blob_id=pb.id
         WHERE r.catalog_master_id=ANY($1::text[]) AND p.state <> 'withdrawn' LIMIT 1`,
        [rows.map((row) => row.id)],
      );
      if ((published.rowCount ?? 0) > 0) return refused("blocks_published");
      await db.query(
        `UPDATE community.media_blobs SET state='tombstoned', tombstoned_at=$2::timestamptz, retention_hold=NULL
         WHERE id=$1 AND state='committed' AND retention_hold='catalog_master'`,
        [master.blob_id, at],
      );
      return { status: "done", byteSize: safeInteger(blob.byte_size) };
    });
  }

  async requeue(
    mediaId: string,
    now: Date,
  ): Promise<CatalogMasterResult<{ readonly jobs: number }>> {
    if (!MEDIA_ID.test(mediaId)) throw new TypeError("Unknown media id");
    return writeTransaction(this.pool, async (db) => {
      const asset = await lockPublishedAsset(db, mediaId);
      if (typeof asset === "string") return refused(asset);
      const active = (
        await db.query<MasterRow>(
          "SELECT * FROM community.catalog_display_masters WHERE catalog_asset_id=$1 AND ended_at IS NULL",
          [asset.id],
        )
      ).rows[0];
      if (active === undefined) return refused("no_active_master");
      const queued = await enqueueMissingCatalogBlocks(
        db,
        {
          id: active.id,
          catalogAssetId: asset.id,
          frameWidth: active.frame_width,
          frameHeight: active.frame_height,
        },
        now,
        { resume: true },
      );
      if (queued.status === "queued")
        return { status: "done", jobs: queued.jobs };
      // `resume` lifts the pause, so a paused set is never the reason here.
      if (queued.reason === "set_paused")
        throw new Error("A resumed set is not paused");
      return refused(queued.reason);
    });
  }

  async status(catalogId: string | null): Promise<CatalogMasterStatus> {
    if (catalogId !== null && !CATALOG_ID.test(catalogId))
      throw new TypeError("Unknown catalog id");
    return readTransaction(this.pool, async (db) => {
      const actives = (
        await db.query<MasterRow & { media_id: string; referenced: boolean }>(
          `SELECT m.*, a.media_id, a.unreferenced_since IS NULL AS referenced
           FROM community.catalog_display_masters m
           JOIN community.catalog_media_assets a ON a.id=m.catalog_asset_id
           WHERE m.ended_at IS NULL
             AND ($1::text IS NULL OR EXISTS (
               SELECT 1 FROM public.catalog_media cm WHERE cm.catalog_id=$1 AND cm.media_id=a.media_id))
           ORDER BY a.media_id, m.id`,
          [catalogId],
        )
      ).rows;
      const masters: CatalogMasterStatusRow[] = [];
      for (const row of actives) {
        const set = await readCatalogBlockSet(db, {
          id: row.id,
          frameWidth: row.frame_width,
          frameHeight: row.frame_height,
        });
        const published = (
          await db.query<{ published: string }>(
            `SELECT count(DISTINCT p.rendition_id) AS published FROM community.media_publications p
             JOIN community.media_renditions r ON r.id=p.rendition_id
             WHERE r.catalog_master_id=$1 AND p.state='published'`,
            [row.id],
          )
        ).rows[0]!;
        masters.push({
          mediaId: row.media_id,
          masterId: row.id,
          active: true,
          referenced: row.referenced,
          frameWidth: row.frame_width,
          frameHeight: row.frame_height,
          cells: set.cells,
          blocksReady: set.ready.size,
          blocksPublished: safeInteger(published.published),
          complete: set.missing.length === 0,
          openJobs: set.openJobs,
          paused: set.paused,
          lastFailureCode: set.contentFailure ?? set.lastFailureCode,
          endReason: null,
        });
      }
      const held = (
        await db.query<{
          id: string;
          byte_size: string;
          end_reason: CatalogMasterEndReason;
        }>(
          `SELECT DISTINCT ON (b.id) m.id, b.byte_size, m.end_reason
           FROM community.media_blobs b
           JOIN community.catalog_display_masters m ON m.blob_id=b.id
           WHERE b.purpose='catalog_master' AND b.state='committed' AND b.retention_hold='catalog_master'
             AND NOT EXISTS (
               SELECT 1 FROM community.catalog_display_masters o WHERE o.blob_id=b.id AND o.ended_at IS NULL)
           ORDER BY b.id, (m.end_reason = 'detached') DESC, m.ended_at DESC, m.created_at DESC, m.id DESC`,
        )
      ).rows;
      const storage = await storageOf(db, 0);
      return {
        masters,
        heldWithoutActive: held.map((row) => ({
          masterId: row.id,
          byteSize: safeInteger(row.byte_size),
          endReason: row.end_reason,
        })),
        storage: {
          taskBytes: storage.taskBytes,
          sliceBytes: storage.sliceBytes,
          sliceCap: storage.sliceCap,
          taskCap: storage.taskCap,
        },
      };
    });
  }

  async guardCounts(): Promise<CatalogBlockGuardCounts> {
    return readTransaction(this.pool, async (db) => {
      const row = (
        await db.query<{
          publications: string;
          renditions: string;
          jobs: string;
        }>(CATALOG_BLOCK_GUARD_SQL)
      ).rows[0]!;
      return {
        blockPublications: safeInteger(row.publications),
        blockRenditions: safeInteger(row.renditions),
        blockJobs: safeInteger(row.jobs),
      };
    });
  }
}

/**
 * The rollback-floor guard (release toolkit R5): block rows in any state.
 * Code older than the expand release must not run while any count is above
 * zero. It names no column the migration adds, so it runs on any schema.
 */
export const CATALOG_BLOCK_GUARD_SQL = `SELECT
  (SELECT count(*) FROM community.media_publications WHERE role ~ '^block-') AS publications,
  (SELECT count(*) FROM community.media_renditions WHERE role ~ '^block-') AS renditions,
  (SELECT count(*) FROM community.publishing_jobs
   WHERE kind='catalog_render' AND payload->>'variant'='blocks') AS jobs`;
