import type { MediaRendition } from "@moya/contracts";
import {
  addMediaRenditionAnchorIssues,
  mediaRenditionListSchema,
} from "@moya/contracts/schemas";

/*
 * Rendition candidates of community media items (unified media pipeline,
 * increment 1, CW4/CW12): one SQL fragment reads the ready still renditions
 * of one item and framing, and one mapper turns them into a contract list for
 * a context. Every candidate a reader receives is also one the authorized
 * relay serves that reader: the fragment applies the same public resolution
 * policy (`withinPublicPolicySql`) as `resolveMediaRead`, and callers admit
 * the same edit keys as its revision branch. Candidates are same-origin relay
 * paths built by the caller (`publishingMediaSrc`); recipe and role names
 * never reach a client.
 */

/** Still roles a reader may receive, smallest recipe first; `motion` never is a candidate. */
export const CANDIDATE_ROLES = [
  "thumb",
  "cover",
  "display",
  "viewer",
  "full",
] as const;
export type CandidateRole = (typeof CANDIDATE_ROLES)[number];

/**
 * Card contexts stop at the anchor (no zoom levels in cards and lists);
 * detail contexts add the zoom levels wider than it.
 */
export type RenditionContext = "card" | "detail";

/**
 * D3 (Owner decision Q1, 2026-10-04): a `full` rendition reaches anyone but
 * the item's owner only within today's public bounds: a long edge of at most
 * 8192 px, or for a long scroll (long edge more than 2.5 times the short
 * edge) today's full@1 long-scroll geometry, a long edge of at most 16000 px
 * and at most 40 million pixels. The bounds apply to the scaled frame: a
 * rendition's sides are that frame's sides rounded to the nearest pixel, so
 * the long-scroll aspect and the pixel cap allow half a pixel per side (a
 * 2504 × 15993 frame renders 2503 × 15984, 40,007,952 px; a 12501 × 5000
 * frame renders 10000 × 4000). Every other still role is within its recipe's
 * bounds already.
 */
export const PUBLIC_FULL_BOUNDS = Object.freeze({
  maxLongEdge: 8192,
  longScrollAspectRatio: 2.5,
  longScrollMaxLongEdge: 16_000,
  longScrollMaxPixels: 40_000_000,
});

/**
 * SQL for one rendition row alias: true when a reader other than the owner
 * may receive it (the public resolution policy, D3). The one definition used
 * by the DTO builders and the authorized relay; the Catalog delivery view
 * (migration 20261004020000) spells the same predicate.
 */
export const withinPublicPolicySql = (rendition: string): string => {
  const long = `GREATEST(${rendition}.width,${rendition}.height)`;
  const short = `LEAST(${rendition}.width,${rendition}.height)`;
  const bounds = PUBLIC_FULL_BOUNDS;
  // Exact numeric arithmetic; 0.5 is the rounding of one side.
  return `(${rendition}.role<>'full' OR ${long}<=${bounds.maxLongEdge} OR (${long}+0.5>${bounds.longScrollAspectRatio}*(${short}-0.5) AND ${long}<=${bounds.longScrollMaxLongEdge} AND (${rendition}.width-0.5)*(${rendition}.height-0.5)<=${bounds.longScrollMaxPixels}))`;
};

/**
 * SQL (a jsonb array, `[]` when none) of the candidate renditions of item id
 * expression `item` under the edit key expression `framingKey`: ready rows of
 * the still roles with a committed blob, of an item that is not cancelled or
 * purged, within the public resolution policy, ordered by size. `admitted`
 * adds the caller's predicate on the rendition alias it receives (the edit
 * key its role is authorized under). Map the value with `toMediaRenditions`.
 */
export const itemRenditionsSql = (
  item: string,
  framingKey: string,
  admitted: (rendition: string) => string = () => "TRUE",
): string => `COALESCE((
  SELECT jsonb_agg(jsonb_build_object('role',ir.role,'width',ir.width,'height',ir.height,
      'contentType',ir.content_type,'byteSize',ib.byte_size) ORDER BY ir.width,ir.height,ir.role)
  FROM community.media_renditions ir
  JOIN community.media_blobs ib ON ib.id=ir.blob_id AND ib.state='committed'
  JOIN community.media_items ii ON ii.id=ir.item_id AND ii.state NOT IN ('cancelled','purged')
  WHERE ir.item_id=${item} AND ir.edit_key=${framingKey} AND ir.state='ready'
    AND ir.role IN (${CANDIDATE_ROLES.map((role) => `'${role}'`).join(",")})
    AND ${withinPublicPolicySql("ir")} AND ${admitted("ir")}
), '[]'::jsonb)`;

interface CandidateRow {
  readonly role: CandidateRole;
  readonly width: number;
  readonly height: number;
  readonly contentType: MediaRendition["contentType"];
  readonly byteSize: number;
}

const side = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const candidateRow = (value: unknown): CandidateRow | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return (CANDIDATE_ROLES as readonly unknown[]).includes(row.role) &&
    side(row.width) &&
    side(row.height) &&
    (row.contentType === "image/webp" || row.contentType === "image/jpeg") &&
    typeof row.byteSize === "number"
    ? (row as unknown as CandidateRow)
    : null;
};

/** The parent of a list: its `src` is the anchor; a size, when given, has the list's framing. */
export interface RenditionAnchor {
  readonly src: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The contract list of rows read with `itemRenditionsSql`, or `undefined`
 * (the parent keeps its legacy `src` without candidates) when the anchor is
 * not among them or the list breaks a contract rule. `src` gives the URL of a
 * role of this item and framing (the same-origin relay path in increment 1);
 * the anchor is the row whose URL is `anchor.src`. A card context keeps the
 * rows up to the anchor; a detail context keeps every row. Rows of one size
 * collapse into one entry: the anchor, else the smaller blob, else the
 * smaller recipe. A list the contract refuses around a present anchor is a
 * defect and is logged (content-free), as are malformed rows or a missing
 * anchor in a nonempty set. Empty legacy sets stay silent.
 */
export const toMediaRenditions = (
  rows: unknown,
  anchor: RenditionAnchor,
  context: RenditionContext,
  src: (role: CandidateRole) => string,
): MediaRendition[] | undefined => {
  const candidates = (Array.isArray(rows) ? rows : []).flatMap((value) => {
    const row = candidateRow(value);
    return row === null ? [] : [{ ...row, src: src(row.role) }];
  });
  const anchorRow = candidates.find((row) => row.src === anchor.src);
  const malformed = Array.isArray(rows) && candidates.length !== rows.length;
  if (anchorRow === undefined) {
    if (Array.isArray(rows) && rows.length > 0)
      console.warn("[community-media] rendition_fallback");
    return undefined;
  }
  const bySize = new Map<string, (typeof candidates)[number]>();
  for (const row of candidates) {
    if (
      context === "card" &&
      (row.width > anchorRow.width || row.height > anchorRow.height)
    )
      continue;
    const size = `${row.width}x${row.height}`;
    const kept = bySize.get(size);
    if (
      kept === undefined ||
      (kept !== anchorRow &&
        (row === anchorRow ||
          row.byteSize < kept.byteSize ||
          (row.byteSize === kept.byteSize &&
            CANDIDATE_ROLES.indexOf(row.role) <
              CANDIDATE_ROLES.indexOf(kept.role))))
    )
      bySize.set(size, row);
  }
  const list = [...bySize.values()]
    .sort(
      (left, right) => left.width - right.width || left.height - right.height,
    )
    .map(({ src: url, width, height, contentType }) => ({
      src: url,
      width,
      height,
      contentType,
    }));
  const parsed = mediaRenditionListSchema
    .superRefine((value, issues) =>
      addMediaRenditionAnchorIssues(anchor, value, issues),
    )
    .safeParse(list);
  if (parsed.success) {
    if (malformed) console.warn("[community-media] rendition_fallback");
    return parsed.data;
  }
  console.warn("[community-media] rendition_fallback");
  return undefined;
};
