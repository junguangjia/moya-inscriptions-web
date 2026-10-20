import {
  CATALOG_ZOOM_BLOCKS_MAXIMUM,
  CATALOG_ZOOM_MAX_LONG_EDGE,
  catalogZoomBlockCount,
} from "@moya/contracts/schemas";

import type {
  CatalogZoomBlocksProjection,
  CatalogZoomFrameProjection,
} from "@moya/api";
import type { MediaId } from "@moya/contracts";
import type { QueryResultRow } from "pg";

/*
 * Catalog deep zoom reads (catalog-deep-zoom-v1). The security_barrier view
 * `community.catalog_media_zoom_blocks` (migration 20261020010000) lists the
 * ready blocks of the active display master of each ready, referenced
 * Catalog asset, by opaque delivery key, in exact cell geometry. These reads
 * join it to the published media rows of one record, exactly as the
 * rendition delivery join does (media id and object key): the Detail's
 * best-effort frame query, which keeps complete sets only, and the keys of
 * one image's set. They project no master fact and resolve no key.
 */

/**
 * Whether deep zoom is deliverable now (the Backend's switch, delivery and
 * breaker gates); asked before every read, so a closed gate reads nothing.
 */
export interface CatalogZoomGate {
  isOpen(): Promise<boolean>;
}

/*
 * Both reads reach the view through LATERAL, as the rendition delivery join
 * does: each published media row's id and object key enter the view as
 * parameters, so only that image's rows are read. A plain join cannot push
 * them into the security_barrier view, which would then be read whole.
 */

/** SQL: per published image of record `$1`, its frame and listed cells. */
export const catalogZoomFramesSql = `
  SELECT cm.media_id, z.frame_width, z.frame_height, z.cells, z.listed
  FROM catalog_media cm
  CROSS JOIN LATERAL (
    SELECT b.frame_width, b.frame_height, b.cells,
           count(DISTINCT b.cell)::integer AS listed
    FROM community.catalog_media_zoom_blocks b
    WHERE b.media_id = cm.media_id AND b.object_key = cm.object_key
    GROUP BY b.frame_width, b.frame_height, b.cells
  ) z
  WHERE cm.catalog_id = $1
`;

/** SQL: the listed blocks of image `$2` of published record `$1`, row-major. */
export const catalogZoomBlocksSql = `
  SELECT z.cell, z.delivery_key, z.frame_width, z.frame_height, z.cells
  FROM catalog_media cm
  CROSS JOIN LATERAL (
    SELECT b.cell, b.delivery_key, b.frame_width, b.frame_height, b.cells
    FROM community.catalog_media_zoom_blocks b
    WHERE b.media_id = cm.media_id AND b.object_key = cm.object_key
  ) z
  WHERE cm.catalog_id = $1 AND cm.media_id = $2
  ORDER BY z.cell ASC
`;

export interface CatalogZoomFrameRow extends QueryResultRow {
  readonly media_id: unknown;
  readonly frame_width: unknown;
  readonly frame_height: unknown;
  readonly cells: unknown;
  readonly listed: unknown;
}

export interface CatalogZoomBlockRow extends QueryResultRow {
  readonly cell: unknown;
  readonly delivery_key: unknown;
  readonly frame_width: unknown;
  readonly frame_height: unknown;
  readonly cells: unknown;
}

const DELIVERY_KEY = /^media-rendition-[0-9a-f]{32}$/u;

const side = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= CATALOG_ZOOM_MAX_LONG_EDGE;

/** A frame whose cell count matches its grid, within 2 to 100 blocks. */
const frameOf = (
  width: unknown,
  height: unknown,
  cells: unknown,
): CatalogZoomFrameProjection | null => {
  if (!side(width) || !side(height)) return null;
  const count = catalogZoomBlockCount({ width, height });
  return cells === count && count >= 2 && count <= CATALOG_ZOOM_BLOCKS_MAXIMUM
    ? { width, height }
    : null;
};

/** The frames of complete sets only: every cell of the grid listed. */
export const mapCatalogZoomFrameRows = (
  rows: readonly CatalogZoomFrameRow[],
): ReadonlyMap<MediaId, CatalogZoomFrameProjection> => {
  const frames = new Map<MediaId, CatalogZoomFrameProjection>();
  const seen = new Set<string>();
  for (const row of rows) {
    const mediaId = String(row.media_id) as MediaId;
    // A second frame for one image is never trusted.
    if (seen.has(mediaId)) {
      frames.delete(mediaId);
      continue;
    }
    seen.add(mediaId);
    const frame = frameOf(row.frame_width, row.frame_height, row.cells);
    if (frame !== null && row.listed === row.cells) frames.set(mediaId, frame);
  }
  return frames;
};

/**
 * The keys of a complete set, row-major: exactly one well-formed key for
 * every cell of one frame; anything else is null.
 */
export const mapCatalogZoomBlockRows = (
  rows: readonly CatalogZoomBlockRow[],
): CatalogZoomBlocksProjection | null => {
  const first = rows[0];
  if (first === undefined) return null;
  const frame = frameOf(first.frame_width, first.frame_height, first.cells);
  if (frame === null || rows.length !== first.cells) return null;
  const keys: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (
      row.cell !== index ||
      row.frame_width !== frame.width ||
      row.frame_height !== frame.height ||
      row.cells !== first.cells ||
      typeof row.delivery_key !== "string" ||
      !DELIVERY_KEY.test(row.delivery_key)
    )
      return null;
    keys.push(row.delivery_key);
  }
  return { ...frame, keys };
};
