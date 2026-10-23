import type {
  CatalogBlockJobPayload,
  CatalogBlockOutcome,
  CatalogBlockPlan,
  PublishingDerivativeCommit,
} from "@moya/api";
import type { Pool } from "pg";
import {
  CATALOG_ZOOM_BLOCK_EDGE,
  CATALOG_ZOOM_BLOCK_OVERLAP,
  CATALOG_ZOOM_BLOCKS_MAXIMUM,
  CATALOG_ZOOM_MAX_LONG_EDGE,
} from "@moya/contracts/schemas";

import {
  nowParam,
  readTransaction,
  safeInteger,
  writeTransaction,
  type PublishingDb,
} from "./db.js";
import { catalogBlockJobSql, insertJob } from "./jobs.js";
import { markCatalogPublicationDirty } from "./catalog-publication-dirty.js";
import {
  recordRenditionRows,
  unrecordedKeys,
  type CatalogBlockRole,
} from "./renditions.js";

/*
 * Block sets of Catalog display masters (catalog-deep-zoom-v1): the frame of
 * a master, the cells of its one level of blocks, and the block jobs that cut
 * the missing cells (a `catalog_render` payload variant, at most 16 cells per
 * job, at most two open sets). The geometry matches the published-blocks view
 * `community.catalog_media_zoom_blocks` (migration 20261020010000) exactly.
 */

const MASTER_ID = /^catalog-master-[0-9a-f]{32}$/u;

/** At most this many cells per block job, and open block sets at once. */
export const CATALOG_BLOCK_JOB_CELLS = 16;
export const CATALOG_BLOCK_OPEN_SETS = 2;
/** Content failures of a block job: never run again for that master. */
export const CATALOG_BLOCK_CONTENT_FAILURES = [
  "master_mismatch",
  "zoom_blocks_alpha",
  "master_unreadable",
] as const;

/** The frame of an oriented master under a long-edge limit: never upscaled. */
export const catalogMasterFrame = (
  masterWidth: number,
  masterHeight: number,
  maxLongEdge: number,
): { readonly width: number; readonly height: number } => {
  const long = Math.max(masterWidth, masterHeight);
  const short = Math.min(masterWidth, masterHeight);
  const target = Math.min(long, maxLongEdge, CATALOG_ZOOM_MAX_LONG_EDGE);
  const scaled = Math.max(1, Math.round((short * target) / long));
  return masterWidth >= masterHeight
    ? { width: target, height: scaled }
    : { width: scaled, height: target };
};

/** Columns, rows and cells of a frame's one level of blocks. */
export const catalogBlockGrid = (
  frameWidth: number,
  frameHeight: number,
): {
  readonly columns: number;
  readonly rows: number;
  readonly cells: number;
} => {
  const columns = Math.ceil(frameWidth / CATALOG_ZOOM_BLOCK_EDGE);
  const rows = Math.ceil(frameHeight / CATALOG_ZOOM_BLOCK_EDGE);
  return { columns, rows, cells: columns * rows };
};

/** The rectangle of one row-major cell, with the right and bottom overlap. */
export const catalogBlockCell = (
  frameWidth: number,
  frameHeight: number,
  cell: number,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} => {
  const { columns, cells } = catalogBlockGrid(frameWidth, frameHeight);
  if (!Number.isSafeInteger(cell) || cell < 0 || cell >= cells)
    throw new TypeError("A block cell lies inside its frame's grid");
  const left = (cell % columns) * CATALOG_ZOOM_BLOCK_EDGE;
  const top = Math.floor(cell / columns) * CATALOG_ZOOM_BLOCK_EDGE;
  const span = CATALOG_ZOOM_BLOCK_EDGE + CATALOG_ZOOM_BLOCK_OVERLAP;
  return {
    left,
    top,
    width: Math.min(span, frameWidth - left),
    height: Math.min(span, frameHeight - top),
  };
};

/** `block-NN` of a cell index (00..99). */
export const catalogBlockRole = (cell: number): string => {
  if (
    !Number.isSafeInteger(cell) ||
    cell < 0 ||
    cell >= CATALOG_ZOOM_BLOCKS_MAXIMUM
  )
    throw new TypeError("A block cell is 0..99");
  return `block-${String(cell).padStart(2, "0")}`;
};

/** Contiguous runs of cells, each at most `CATALOG_BLOCK_JOB_CELLS` long. */
export const catalogBlockJobRanges = (
  cells: readonly number[],
): readonly (readonly [number, number])[] => {
  const sorted = [...new Set(cells)].sort((left, right) => left - right);
  const ranges: [number, number][] = [];
  for (const cell of sorted) {
    const last = ranges.at(-1);
    if (
      last !== undefined &&
      cell === last[1] + 1 &&
      cell - last[0] + 1 <= CATALOG_BLOCK_JOB_CELLS
    )
      last[1] = cell;
    else ranges.push([cell, cell]);
  }
  return ranges;
};

/** The parsed payload of a block job, or null for any other payload. */
export const catalogBlockJobPayload = (
  payload: unknown,
): CatalogBlockJobPayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const cells = value.cells;
  if (
    value.variant !== "blocks" ||
    typeof value.masterId !== "string" ||
    !MASTER_ID.test(value.masterId) ||
    !Array.isArray(cells) ||
    cells.length !== 2 ||
    !Number.isSafeInteger(cells[0]) ||
    !Number.isSafeInteger(cells[1]) ||
    (cells[0] as number) < 0 ||
    (cells[1] as number) < (cells[0] as number) ||
    (cells[1] as number) >= CATALOG_ZOOM_BLOCKS_MAXIMUM ||
    (cells[1] as number) - (cells[0] as number) + 1 > CATALOG_BLOCK_JOB_CELLS ||
    Object.keys(value).length !== 3
  )
    return null;
  return {
    variant: "blocks",
    masterId: value.masterId,
    cells: [cells[0] as number, cells[1] as number],
  };
};

/** The block-set facts of one master, read inside the caller's transaction. */
export interface CatalogBlockSetState {
  readonly cells: number;
  /** Cells with a ready block of this master, exactly inside its frame. */
  readonly ready: ReadonlySet<number>;
  readonly missing: readonly number[];
  readonly openJobs: number;
  readonly contentFailure: string | null;
  /** A stopped (not ended) block job still covers a missing cell. */
  readonly paused: boolean;
  readonly lastFailureCode: string | null;
}

export const readCatalogBlockSet = async (
  db: PublishingDb,
  master: {
    readonly id: string;
    readonly frameWidth: number;
    readonly frameHeight: number;
  },
): Promise<CatalogBlockSetState> => {
  const { cells } = catalogBlockGrid(master.frameWidth, master.frameHeight);
  const blocks = await db.query<{
    role: string;
    width: number;
    height: number;
  }>(
    `SELECT r.role, r.width, r.height FROM community.media_renditions r
     JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
     WHERE r.catalog_master_id=$1 AND r.state='ready'`,
    [master.id],
  );
  const ready = new Set<number>();
  for (const block of blocks.rows) {
    const cell = Number(block.role.slice("block-".length));
    if (!Number.isSafeInteger(cell) || cell >= cells) continue;
    const expected = catalogBlockCell(
      master.frameWidth,
      master.frameHeight,
      cell,
    );
    if (block.width === expected.width && block.height === expected.height)
      ready.add(cell);
  }
  const missing = Array.from({ length: cells }, (_, cell) => cell).filter(
    (cell) => !ready.has(cell),
  );
  const jobs = await db.query<{
    state: string;
    payload: unknown;
    last_error_code: string | null;
  }>(
    `SELECT j.state, j.payload, j.last_error_code FROM community.publishing_jobs j
     WHERE ${catalogBlockJobSql("j")} AND j.payload->>'masterId'=$1
       AND j.state IN ('queued','running','failed','abandoned')
     ORDER BY COALESCE(j.finished_at, j.updated_at) DESC, j.id DESC`,
    [master.id],
  );
  const contentCodes: ReadonlySet<string> = new Set(
    CATALOG_BLOCK_CONTENT_FAILURES,
  );
  let openJobs = 0;
  let contentFailure: string | null = null;
  let paused = false;
  let lastFailureCode: string | null = null;
  for (const job of jobs.rows) {
    if (job.state === "queued" || job.state === "running") {
      openJobs += 1;
      continue;
    }
    if (job.last_error_code === "master_ended") continue;
    lastFailureCode ??= job.last_error_code;
    if (job.last_error_code !== null && contentCodes.has(job.last_error_code))
      contentFailure ??= job.last_error_code;
    const payload = catalogBlockJobPayload(job.payload);
    if (
      payload !== null &&
      missing.some(
        (cell) => cell >= payload.cells[0] && cell <= payload.cells[1],
      )
    )
      paused = true;
  }
  return {
    cells,
    ready,
    missing,
    openJobs,
    contentFailure,
    paused: paused && openJobs === 0,
    lastFailureCode,
  };
};

/** Masters with a queued or running block job (open sets). */
export const openCatalogBlockSets = async (
  db: PublishingDb,
): Promise<ReadonlySet<string>> =>
  new Set(
    (
      await db.query<{ master_id: string }>(
        `SELECT DISTINCT j.payload->>'masterId' AS master_id FROM community.publishing_jobs j
         JOIN community.catalog_display_masters m ON m.id=j.payload->>'masterId' AND m.ended_at IS NULL
         WHERE ${catalogBlockJobSql("j")} AND j.state IN ('queued','running')`,
      )
    ).rows.map((row) => row.master_id),
  );

/**
 * Enqueues the missing cells of one active master's set, in runs of at most
 * 16 cells, unless its set is complete, open, failed on content, paused (a
 * stopped job covers a missing cell; only `resume`, the Owner's `requeue`,
 * lifts that) or the other open sets already reach the bound. Returns the
 * jobs queued, or the reason.
 */
export const enqueueMissingCatalogBlocks = async (
  db: PublishingDb,
  master: {
    readonly id: string;
    readonly catalogAssetId: string;
    readonly frameWidth: number;
    readonly frameHeight: number;
  },
  now: Date,
  options: { readonly resume?: boolean } = {},
): Promise<
  | { readonly status: "queued"; readonly jobs: number }
  | {
      readonly status: "skipped";
      readonly reason:
        | "set_complete"
        | "set_open"
        | "set_paused"
        | "content_failure"
        | "sets_busy";
    }
> => {
  if (!MASTER_ID.test(master.id)) throw new TypeError("Unknown master id");
  // The sync pass and `catalog-master requeue` take the same lock, so the
  // two never open a third set together (re-entrant within a transaction).
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('catalog-block-sets',0))",
  );
  const set = await readCatalogBlockSet(db, master);
  if (set.missing.length === 0)
    return { status: "skipped", reason: "set_complete" };
  if (set.contentFailure !== null)
    return { status: "skipped", reason: "content_failure" };
  if (set.openJobs > 0) return { status: "skipped", reason: "set_open" };
  if (set.paused && options.resume !== true)
    return { status: "skipped", reason: "set_paused" };
  const open = await openCatalogBlockSets(db);
  if (
    [...open].filter((id) => id !== master.id).length >= CATALOG_BLOCK_OPEN_SETS
  )
    return { status: "skipped", reason: "sets_busy" };
  let jobs = 0;
  for (const cells of catalogBlockJobRanges(set.missing)) {
    const payload: CatalogBlockJobPayload = {
      variant: "blocks",
      masterId: master.id,
      cells,
    };
    const queued = await insertJob(
      db,
      {
        kind: "catalog_render",
        subjectId: master.catalogAssetId,
        payload,
        maxAttempts: 3,
      },
      now,
    );
    if (queued.created) jobs += 1;
  }
  return { status: "queued", jobs };
};

const ASSET_ID = /^catalog-asset-[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{16}$/u;

/** CatalogBlockPort.readCatalogBlockPlan */
export const readCatalogBlockPlan = async (
  pool: Pool,
  assetId: string,
  payload: unknown,
): Promise<CatalogBlockPlan | null> => {
  const job = catalogBlockJobPayload(payload);
  if (job === null || !ASSET_ID.test(assetId)) return null;
  return readTransaction(pool, async (db) => {
    const row = (
      await db.query<{
        storage_key: string;
        byte_size: string;
        sha256: string;
        content_type: "image/jpeg" | "image/png";
        master_width: number;
        master_height: number;
        frame_width: number;
        frame_height: number;
      }>(
        `SELECT b.storage_key, b.byte_size, b.sha256, m.content_type, m.master_width, m.master_height,
           m.frame_width, m.frame_height
         FROM community.catalog_display_masters m
         JOIN community.catalog_media_assets a ON a.id=m.catalog_asset_id
         JOIN community.media_blobs b ON b.id=m.blob_id AND b.state='committed' AND b.retention_hold='catalog_master'
         WHERE m.id=$1 AND m.catalog_asset_id=$2 AND m.ended_at IS NULL
           AND a.state='ready' AND a.unreferenced_since IS NULL`,
        [job.masterId, assetId],
      )
    ).rows[0];
    if (row === undefined) return null;
    const reference = (
      await db.query<{
        storage_key: string;
        byte_size: string;
        sha256: string;
        width: number;
        height: number;
      }>(
        `SELECT b.storage_key, b.byte_size, b.sha256, r.width, r.height
         FROM community.media_renditions r
         JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
         WHERE r.catalog_asset_id=$1 AND r.role='display' AND r.state='ready'
           AND r.content_type='image/webp'`,
        [assetId],
      )
    ).rows[0];
    const { cells } = catalogBlockGrid(row.frame_width, row.frame_height);
    if (reference === undefined || job.cells[1] >= cells) return null;
    return {
      assetId,
      masterId: job.masterId,
      master: {
        storageKey: row.storage_key,
        byteSize: safeInteger(row.byte_size),
        sha256: row.sha256,
        contentType: row.content_type,
        width: row.master_width,
        height: row.master_height,
      },
      frame: { width: row.frame_width, height: row.frame_height },
      reference: {
        storageKey: reference.storage_key,
        byteSize: safeInteger(reference.byte_size),
        sha256: reference.sha256,
        width: reference.width,
        height: reference.height,
      },
      cells: job.cells,
    };
  });
};

/** CatalogBlockPort.recordCatalogBlocks */
export const recordCatalogBlocks = async (
  pool: Pool,
  assetId: string,
  outcome: CatalogBlockOutcome,
  now: Date,
): Promise<PublishingDerivativeCommit> => {
  if (
    !ASSET_ID.test(assetId) ||
    !MASTER_ID.test(outcome.masterId) ||
    !Array.isArray(outcome.blocks) ||
    outcome.blocks.length < 1 ||
    outcome.blocks.length > CATALOG_BLOCK_JOB_CELLS
  )
    throw new TypeError("Malformed Catalog block outcome");
  for (const block of outcome.blocks)
    if (
      !Number.isSafeInteger(block.cell) ||
      block.cell < 0 ||
      block.cell >= CATALOG_ZOOM_BLOCKS_MAXIMUM ||
      !SHA256.test(block.sha256) ||
      !DIGEST.test(block.recipeDigest) ||
      block.contentType !== "image/jpeg"
    )
      throw new TypeError("Malformed Catalog block");
  const records = outcome.blocks.map((block) => ({
    storageKey: block.storageKey,
    byteSize: block.byteSize,
    sha256: block.sha256,
    role: catalogBlockRole(block.cell) as CatalogBlockRole,
    editKey: "base",
    contentType: "image/jpeg" as const,
    width: block.width,
    height: block.height,
    durationMs: null,
    recipeVersion: block.recipeVersion,
    recipeDigest: block.recipeDigest,
  }));
  const at = nowParam(now);
  return writeTransaction(pool, async (db) => {
    await db.query(
      "SELECT id FROM community.catalog_media_assets WHERE id=$1 FOR UPDATE",
      [assetId],
    );
    const master = (
      await db.query<{ frame_width: number; frame_height: number }>(
        `SELECT frame_width, frame_height FROM community.catalog_display_masters
         WHERE id=$1 AND catalog_asset_id=$2 AND ended_at IS NULL FOR SHARE`,
        [outcome.masterId, assetId],
      )
    ).rows[0];
    if (master === undefined)
      return {
        status: "discarded",
        storageKeys: await unrecordedKeys(db, records),
      };
    for (const block of outcome.blocks) {
      const cell = catalogBlockCell(
        master.frame_width,
        master.frame_height,
        block.cell,
      );
      if (block.width !== cell.width || block.height !== cell.height)
        throw new TypeError("A block does not fit its cell");
    }
    // One set per asset: the blocks of any other master are released.
    await db.query(
      `UPDATE community.media_renditions SET state='released', released_at=$3::timestamptz
       WHERE catalog_asset_id=$1 AND catalog_master_id IS NOT NULL AND catalog_master_id<>$2
         AND state='ready'`,
      [assetId, outcome.masterId, at],
    );
    const { duplicates } = await recordRenditionRows(
      db,
      { kind: "catalog", id: assetId, masterId: outcome.masterId },
      records,
      now,
    );
    // The new set is copied, and any released one withdrawn, only by a
    // reconcile that plans the asset (catalog-scale-v1): a normal mark, the
    // last write, after the asset row's lock.
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

/** CatalogBlockPort.enqueueCatalogBlockSets */
export const enqueueCatalogBlockSets = async (
  pool: Pool,
  now: Date,
  limit: number,
): Promise<{ readonly enqueued: number }> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new TypeError("A block step considers 1..1000 sets per pass");
  return writeTransaction(pool, async (db) => {
    // One pass at a time, so two processes never open a third set.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('catalog-block-sets',0))",
    );
    // Pages of `limit` sets, oldest first: a set that waits (open, paused)
    // never keeps a newer one from its turn; the pass ends at the bound.
    const seen: string[] = [];
    let enqueued = 0;
    for (;;) {
      const masters = (
        await db.query<{
          id: string;
          catalog_asset_id: string;
          frame_width: number;
          frame_height: number;
        }>(
          // Only sets that can still be queued take a place in the pass:
          // incomplete, never failed on content, with a ready display
          // rendition to check the master against (no silent re-queue loop).
          `SELECT m.id, m.catalog_asset_id, m.frame_width, m.frame_height
         FROM community.catalog_display_masters m
         JOIN community.catalog_media_assets a ON a.id=m.catalog_asset_id
         JOIN community.media_blobs b ON b.id=m.blob_id AND b.state='committed' AND b.retention_hold='catalog_master'
         WHERE m.ended_at IS NULL AND a.state='ready' AND a.unreferenced_since IS NULL
           AND EXISTS (
             SELECT 1 FROM community.media_renditions d
             JOIN community.media_blobs db ON db.id=d.blob_id AND db.state='committed'
             WHERE d.catalog_asset_id=a.id AND d.role='display' AND d.edit_key='base' AND d.state='ready')
           AND (
             SELECT count(*) FROM community.media_renditions r
             JOIN community.media_blobs rb ON rb.id=r.blob_id AND rb.state='committed'
             WHERE r.catalog_master_id=m.id AND r.state='ready'
           ) < ceil(m.frame_width / 1024.0) * ceil(m.frame_height / 1024.0)
           AND NOT EXISTS (
             SELECT 1 FROM community.publishing_jobs j
             WHERE ${catalogBlockJobSql("j")} AND j.payload->>'masterId'=m.id
               AND j.state IN ('failed','abandoned')
               AND j.last_error_code = ANY($2::text[]))
           AND NOT (m.id = ANY($3::text[]))
         ORDER BY m.created_at, m.id
         LIMIT $1`,
          [limit, [...CATALOG_BLOCK_CONTENT_FAILURES], seen],
        )
      ).rows;
      for (const master of masters) {
        seen.push(master.id);
        const queued = await enqueueMissingCatalogBlocks(
          db,
          {
            id: master.id,
            catalogAssetId: master.catalog_asset_id,
            frameWidth: master.frame_width,
            frameHeight: master.frame_height,
          },
          now,
        );
        if (queued.status === "queued") enqueued += queued.jobs;
        else if (queued.reason === "sets_busy") return { enqueued };
      }
      if (masters.length < limit) return { enqueued };
    }
  });
};
