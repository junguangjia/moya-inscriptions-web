import {
  CATALOG_BLOCK_CONTENT_FAILURES,
  CATALOG_BLOCK_JOB_CELLS,
  CATALOG_BLOCK_OPEN_SETS,
} from "@moya/api";
import type { CatalogBlockJobPayload } from "@moya/api";
import {
  CATALOG_ZOOM_BLOCK_EDGE,
  CATALOG_ZOOM_BLOCK_OVERLAP,
  CATALOG_ZOOM_BLOCKS_MAXIMUM,
  CATALOG_ZOOM_MAX_LONG_EDGE,
} from "@moya/contracts/schemas";

import type { PublishingDb } from "./db.js";
import { catalogBlockJobSql, insertJob } from "./jobs.js";

/*
 * Block sets of Catalog display masters (catalog-deep-zoom-v1): the frame of
 * a master, the cells of its one level of blocks, and the block jobs that cut
 * the missing cells (a `catalog_render` payload variant, at most 16 cells per
 * job, at most two open sets). The geometry matches the published-blocks view
 * `community.catalog_media_zoom_blocks` (migration 20261020010000) exactly.
 */

const MASTER_ID = /^catalog-master-[0-9a-f]{32}$/u;

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
  if (!Number.isSafeInteger(cell) || cell < 0 || cell >= CATALOG_ZOOM_BLOCKS_MAXIMUM)
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
  const blocks = await db.query<{ role: string; width: number; height: number }>(
    `SELECT r.role, r.width, r.height FROM community.media_renditions r
     JOIN community.media_blobs b ON b.id=r.blob_id AND b.state='committed'
     WHERE r.catalog_master_id=$1 AND r.state='ready'`,
    [master.id],
  );
  const ready = new Set<number>();
  for (const block of blocks.rows) {
    const cell = Number(block.role.slice("block-".length));
    if (!Number.isSafeInteger(cell) || cell >= cells) continue;
    const expected = catalogBlockCell(master.frameWidth, master.frameHeight, cell);
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
  const contentCodes: ReadonlySet<string> = new Set(CATALOG_BLOCK_CONTENT_FAILURES);
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
      missing.some((cell) => cell >= payload.cells[0] && cell <= payload.cells[1])
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
         WHERE ${catalogBlockJobSql("j")} AND j.state IN ('queued','running')`,
      )
    ).rows.map((row) => row.master_id),
  );

/**
 * Enqueues the missing cells of one active master's set, in runs of at most
 * 16 cells, unless its set is complete, open, failed on content or the other
 * open sets already reach the bound. Returns the jobs queued, or the reason.
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
): Promise<
  | { readonly status: "queued"; readonly jobs: number }
  | {
      readonly status: "skipped";
      readonly reason: "set_complete" | "set_open" | "content_failure" | "sets_busy";
    }
> => {
  if (!MASTER_ID.test(master.id)) throw new TypeError("Unknown master id");
  const set = await readCatalogBlockSet(db, master);
  if (set.missing.length === 0) return { status: "skipped", reason: "set_complete" };
  if (set.contentFailure !== null)
    return { status: "skipped", reason: "content_failure" };
  if (set.openJobs > 0) return { status: "skipped", reason: "set_open" };
  const open = await openCatalogBlockSets(db);
  if ([...open].filter((id) => id !== master.id).length >= CATALOG_BLOCK_OPEN_SETS)
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
