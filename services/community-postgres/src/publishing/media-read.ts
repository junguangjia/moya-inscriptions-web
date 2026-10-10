import type { MediaRendition, MediaVariant, WorkMedia } from "@moya/contracts";
import { WORK_EXCERPT_MAXIMUM } from "@moya/contracts/schemas";
import type { PublishingMediaReadTarget } from "@moya/api";
import type { Pool, QueryResultRow } from "pg";

import { readTransaction } from "./db.js";
import type { PublishingDb } from "./db.js";
import { legacyMediaSrc, publishingMediaSrc } from "./media.js";
import {
  itemRenditionsSql,
  toMediaRenditions,
  withinPublicPolicySql,
} from "./rendition-read.js";
import { publishedArticleItemSql } from "../article-authoring/published-media.js";

/*
 * Private derivative read authorization for owners and third parties, and the
 * revision media projections shared by the author, discovery and recycle bin
 * reads. Legacy items keep their Phase 4 user media path; every other item is
 * addressed only through derivative paths (sources and masters never are).
 * The path builders live in ./media.ts (one definition each); rendition
 * candidates and the public resolution policy in ./rendition-read.ts.
 */

/**
 * SQL for one media item row alias: true when its private registration
 * metadata says the browser received it from a clipboard paste. Editable
 * content derived from a revision carries that as the item's presentation
 * `origin`; the metadata itself never leaves storage.
 */
export const clipboardOriginSql = (item: string): string =>
  `COALESCE(${item}.private_metadata #>> '{provenance,clientSource}' = 'clipboard', FALSE)`;

/** Card, draft and recycle bin excerpts: the first 160 code points of the body, trimmed after cutting. */
export const workExcerpt = (body: string): string =>
  [...body].slice(0, WORK_EXCERPT_MAXIMUM).join("").trim();

/**
 * The SQL edit key a derivative variant of a revision item uses: display,
 * viewer, full and motion from the edit alone; thumb and cover also from the
 * cover crop when the item is the revision's cover.
 */
export const variantEditKeySql = (
  variant: string,
  item: string,
  revision: string,
): string =>
  `community.media_edit_key(${item}.edit, CASE WHEN ${variant} IN ('thumb','cover') AND ${item}.item_id=${revision}.cover_item_id THEN ${revision}.cover_crop END)`;

/**
 * SQL (a jsonb array) of the candidates of revision item alias `item` of
 * revision alias `revision` under the edit key expression `framingKey`: only
 * roles the relay serves third parties under that key (`variantEditKeySql`),
 * so the cover-cropped thumb and cover of a cover item never join its
 * full-frame list, nor its full-frame stills the cover list.
 */
const revisionItemRenditionsSql = (
  item: string,
  revision: string,
  framingKey: string,
): string =>
  itemRenditionsSql(
    `${item}.item_id`,
    framingKey,
    (rendition) =>
      `${rendition}.edit_key=${variantEditKeySql(`${rendition}.role`, item, revision)}`,
  );

/**
 * A lateral join (alias `alias`) selecting the card cover of revision alias
 * `revision`: its explicit cover item (its `cover` derivative), else its first
 * item (its `cover` derivative when one exists for the edit, else its
 * `display` derivative), with the card candidates of that derivative's own
 * framing. Read its columns with `revisionCoverColumns` and map them with
 * `revisionCover`.
 */
export const revisionCoverJoin = (revision: string, alias: string): string =>
  `LEFT JOIN LATERAL (
    SELECT cc.*, ${revisionItemRenditionsSql("cc", revision, "cc.edit_key")} AS renditions
    FROM (
      SELECT ci.item_id, ci.edit, cm.kind, cm.legacy_media_id, um.width AS legacy_width, um.height AS legacy_height,
        cm.presentation, cm.state, cm.placeholder_color, cd.variant, cd.edit_key, cd.width AS cover_width, cd.height AS cover_height
      FROM community.work_revision_items ci
      JOIN community.media_items cm ON cm.id=ci.item_id
      LEFT JOIN community.user_media um ON um.id=cm.legacy_media_id AND um.owner_id=cm.owner_id
      LEFT JOIN LATERAL (
        SELECT d.role AS variant, d.edit_key, d.width, d.height FROM community.media_renditions d
        WHERE d.item_id=cm.id AND d.state='ready' AND (
          (d.role='cover' AND d.edit_key=${variantEditKeySql("'cover'", "ci", revision)})
          OR (d.role='display' AND d.edit_key=community.media_edit_key(ci.edit, NULL))
        )
        ORDER BY d.role='cover' DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE ci.revision_id=${revision}.id
      ORDER BY (ci.item_id=${revision}.cover_item_id) IS NOT TRUE, ci.position
      LIMIT 1
    ) cc
  ) ${alias} ON TRUE`;

/** The columns `revisionCoverColumns` selects. */
export interface RevisionCoverColumns extends QueryResultRow {
  readonly cover_item_id: string | null;
  readonly cover_kind: "static" | "live" | null;
  readonly cover_legacy_media_id: string | null;
  readonly cover_legacy_width: number | null;
  readonly cover_legacy_height: number | null;
  readonly cover_presentation: { width?: unknown; height?: unknown } | null;
  readonly cover_state: string | null;
  readonly cover_variant: "cover" | "display" | null;
  readonly cover_edit_key: string | null;
  readonly cover_width: number | null;
  readonly cover_height: number | null;
  readonly cover_placeholder_color: string | null;
  /** Candidate rows (`itemRenditionsSql`) of the cover derivative's framing. */
  readonly cover_renditions: unknown;
}

/** SELECT list for the `revisionCoverJoin` columns under `RevisionCoverColumns` names. */
export const revisionCoverColumns = (alias: string): string =>
  `${alias}.item_id AS cover_item_id,${alias}.kind AS cover_kind,${alias}.legacy_media_id AS cover_legacy_media_id,
  ${alias}.legacy_width AS cover_legacy_width,${alias}.legacy_height AS cover_legacy_height,
  ${alias}.presentation AS cover_presentation,${alias}.state AS cover_state,${alias}.variant AS cover_variant,${alias}.edit_key AS cover_edit_key,
  ${alias}.cover_width,${alias}.cover_height,${alias}.placeholder_color AS cover_placeholder_color,${alias}.renditions AS cover_renditions`;

export interface RevisionCover {
  /** The legacy user media id, or the media item id. */
  readonly id: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly live: boolean;
  /**
   * Card candidates of the cover derivative's own framing (the cover crop
   * when the cover item has one) with `src` as the anchor; absent for a
   * Phase 4 PNG and whenever the anchor has no ready candidate.
   */
  readonly renditions?: MediaRendition[];
  /** The item's loading colour; absent for a Phase 4 PNG and a non-opaque image. */
  readonly placeholderColor?: string;
}

const dimension = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

/** `placeholderColor` of a rendition-backed entry when the item has one. */
const placeholderOf = (
  color: string | null | undefined,
): { placeholderColor?: string } =>
  typeof color === "string" ? { placeholderColor: color } : {};

/**
 * The card cover of a revision, or null for a text-only revision. A legacy
 * item shows its edited card derivative once one is recorded for the
 * revision's edit and cover crop, and its Phase 4 user media PNG otherwise
 * (its unedited form has no derivative).
 */
export const revisionCover = (
  row: RevisionCoverColumns,
): RevisionCover | null => {
  if (row.cover_item_id === null) return null;
  if (
    row.cover_legacy_media_id !== null &&
    (row.cover_variant === null ||
      row.cover_edit_key === null ||
      row.cover_edit_key === "base")
  ) {
    const width = dimension(row.cover_legacy_width);
    const height = dimension(row.cover_legacy_height);
    return width === null || height === null
      ? null
      : {
          id: row.cover_legacy_media_id,
          src: legacyMediaSrc(row.cover_legacy_media_id),
          width,
          height,
          live: false,
        };
  }
  if (
    row.cover_state !== "ready" ||
    row.cover_variant === null ||
    row.cover_edit_key === null
  )
    return null;
  const width = dimension(row.cover_width);
  const height = dimension(row.cover_height);
  if (width === null || height === null) return null;
  const itemId = row.cover_item_id;
  const editKey = row.cover_edit_key;
  const src = publishingMediaSrc(itemId, row.cover_variant, editKey);
  const renditions = toMediaRenditions(
    row.cover_renditions,
    { src, width, height },
    "card",
    (role) => publishingMediaSrc(itemId, role, editKey),
  );
  return {
    id: itemId,
    src,
    width,
    height,
    live: row.cover_kind === "live",
    ...(renditions === undefined ? {} : { renditions }),
    ...placeholderOf(row.cover_placeholder_color),
  };
};

interface RevisionMediaRow extends QueryResultRow {
  item_id: string;
  kind: "static" | "live";
  state: string;
  legacy_media_id: string | null;
  legacy_width: number | null;
  legacy_height: number | null;
  presentation: {
    width?: unknown;
    height?: unknown;
    hasAudio?: unknown;
  } | null;
  display_key: string;
  display_width: number | null;
  display_height: number | null;
  is_cover: boolean;
  placeholder_color: string | null;
  /** Candidate rows (`itemRenditionsSql`) of the item's edit framing. */
  renditions: unknown;
}

/** One revision's ordered media and the entry its card cover uses. */
export interface RevisionMediaView {
  readonly media: WorkMedia[];
  /**
   * The media id (a legacy user media id for an unedited legacy item) of the
   * revision's chosen cover item when it is shown, else of the first shown
   * entry (legacy revisions name no cover); null without shown media.
   */
  readonly coverMediaId: string | null;
}

/**
 * The ordered media of one revision as viewers see it: an unedited legacy
 * item as its Phase 4 PNG (unchanged id and path), every other ready item
 * (an edited legacy item included, under its media item id) as its display
 * derivative for the revision edit, with motion for Live items, the detail
 * candidates of the edit's framing (the display as anchor; the thumb and
 * cover of a cover item with a cover crop never, the relay serves those only
 * under the crop's key) and its loading colour.
 */
export const revisionMedia = async (
  db: PublishingDb,
  revisionId: string | null,
): Promise<RevisionMediaView> => {
  if (revisionId === null) return { media: [], coverMediaId: null };
  return (
    (await revisionsMedia(db, [revisionId])).get(revisionId) ?? {
      media: [],
      coverMediaId: null,
    }
  );
};

/**
 * The ordered media of several revisions in one statement (a page of works):
 * the same rows and rules as `revisionMedia`, grouped by revision id. A
 * revision without shown media is absent from the map.
 */
export const revisionsMedia = async (
  db: PublishingDb,
  revisionIds: readonly string[],
): Promise<ReadonlyMap<string, RevisionMediaView>> => {
  const views = new Map<string, RevisionMediaView>();
  if (revisionIds.length === 0) return views;
  const rows = (
    await db.query<RevisionMediaRow & { revision_id: string }>(
      `SELECT ri.revision_id,ri.item_id,i.kind,i.state,i.legacy_media_id,um.width AS legacy_width,um.height AS legacy_height,
        i.presentation,k.display_key,d.width AS display_width,d.height AS display_height,
        ri.item_id IS NOT DISTINCT FROM r.cover_item_id AS is_cover,i.placeholder_color,
        ${revisionItemRenditionsSql("ri", "r", "k.display_key")} AS renditions
      FROM community.work_revision_items ri
      JOIN community.work_revisions r ON r.id=ri.revision_id
      JOIN community.media_items i ON i.id=ri.item_id
      CROSS JOIN LATERAL (SELECT community.media_edit_key(ri.edit,NULL) AS display_key) k
      LEFT JOIN community.user_media um ON um.id=i.legacy_media_id AND um.owner_id=i.owner_id
      LEFT JOIN community.media_renditions d ON d.item_id=i.id AND d.role='display' AND d.edit_key=k.display_key AND d.state='ready'
      WHERE ri.revision_id=ANY($1::text[])
      ORDER BY ri.revision_id,ri.position`,
      [[...revisionIds]],
    )
  ).rows;
  const grouped = new Map<string, RevisionMediaRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.revision_id);
    if (list === undefined) grouped.set(row.revision_id, [row]);
    else list.push(row);
  }
  for (const [revisionId, list] of grouped)
    views.set(revisionId, revisionMediaView(list));
  return views;
};

const revisionMediaView = (
  rows: readonly RevisionMediaRow[],
): RevisionMediaView => {
  const media: WorkMedia[] = [];
  let chosenCover: string | null = null;
  for (const row of rows) {
    if (row.legacy_media_id !== null && row.display_key === "base") {
      const width = dimension(row.legacy_width);
      const height = dimension(row.legacy_height);
      if (width !== null && height !== null) {
        media.push({
          id: row.legacy_media_id,
          src: legacyMediaSrc(row.legacy_media_id),
          width,
          height,
        });
        if (row.is_cover) chosenCover = row.legacy_media_id;
      }
      continue;
    }
    if (row.state !== "ready") continue;
    const width =
      dimension(row.display_width) ?? dimension(row.presentation?.width);
    const height =
      dimension(row.display_height) ?? dimension(row.presentation?.height);
    if (width === null || height === null) continue;
    if (row.is_cover) chosenCover = row.item_id;
    const src = publishingMediaSrc(row.item_id, "display", row.display_key);
    const renditions = toMediaRenditions(
      row.renditions,
      { src, width, height },
      "detail",
      (role) => publishingMediaSrc(row.item_id, role, row.display_key),
    );
    media.push({
      id: row.item_id,
      src,
      width,
      height,
      kind: row.kind,
      ...(row.kind === "live"
        ? {
            motionSrc: publishingMediaSrc(
              row.item_id,
              "motion",
              row.display_key,
            ),
            ...(typeof row.presentation?.hasAudio === "boolean"
              ? { hasAudio: row.presentation.hasAudio }
              : {}),
          }
        : {}),
      ...(renditions === undefined ? {} : { renditions }),
      ...placeholderOf(row.placeholder_color),
    });
  }
  return { media, coverMediaId: chosenCover ?? media[0]?.id ?? null };
};

/** One card gallery entry: a shown image in its full framing, never motion. */
export interface RevisionGalleryEntry {
  /** The media item id, or the user media id of an unedited legacy PNG. */
  readonly id: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly live: boolean;
  /** Card candidates up to the display still, `src` as the anchor. */
  readonly renditions?: MediaRendition[];
  readonly placeholderColor?: string;
}

/** A revision's first gallery entries and the number of its media items. */
export interface RevisionGalleryView {
  readonly entries: readonly RevisionGalleryEntry[];
  /** Every item of the revision; `entries` may stop short of it. */
  readonly total: number;
}

/**
 * The card gallery of several revisions in one statement (a page of cards):
 * the first `maximum` items of each revision by position, shown exactly as
 * `revisionMedia` shows them (the unedited legacy PNG, else the display
 * derivative of the revision edit) but with the card candidates of that
 * framing and the Live flag instead of motion, plus each revision's item
 * total. The window runs over revision items only, so candidates are read
 * for at most `maximum` rows per revision. A revision without shown media is
 * absent from the map.
 */
export const revisionsGallery = async (
  db: PublishingDb,
  revisionIds: readonly string[],
  maximum: number,
): Promise<ReadonlyMap<string, RevisionGalleryView>> => {
  const views = new Map<string, RevisionGalleryView>();
  if (revisionIds.length === 0) return views;
  const rows = (
    await db.query<RevisionMediaRow & { revision_id: string; total: string }>(
      `SELECT ri.revision_id,ri.item_id,ri.total,i.kind,i.state,i.legacy_media_id,um.width AS legacy_width,um.height AS legacy_height,
        i.presentation,k.display_key,d.width AS display_width,d.height AS display_height,
        ri.item_id IS NOT DISTINCT FROM r.cover_item_id AS is_cover,i.placeholder_color,
        ${revisionItemRenditionsSql("ri", "r", "k.display_key")} AS renditions
      FROM (
        SELECT x.* FROM (
          SELECT ri.*,
            row_number() OVER (PARTITION BY ri.revision_id ORDER BY ri.position) AS rn,
            count(*) OVER (PARTITION BY ri.revision_id) AS total
          FROM community.work_revision_items ri
          WHERE ri.revision_id=ANY($1::text[])
        ) x WHERE x.rn<=$2
      ) ri
      JOIN community.work_revisions r ON r.id=ri.revision_id
      JOIN community.media_items i ON i.id=ri.item_id
      CROSS JOIN LATERAL (SELECT community.media_edit_key(ri.edit,NULL) AS display_key) k
      LEFT JOIN community.user_media um ON um.id=i.legacy_media_id AND um.owner_id=i.owner_id
      LEFT JOIN community.media_renditions d ON d.item_id=i.id AND d.role='display' AND d.edit_key=k.display_key AND d.state='ready'
      ORDER BY ri.revision_id,ri.position`,
      [[...revisionIds], maximum],
    )
  ).rows;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.revision_id);
    if (list === undefined) grouped.set(row.revision_id, [row]);
    else list.push(row);
  }
  for (const [revisionId, list] of grouped) {
    const entries = list.flatMap((row) => {
      const entry = revisionGalleryEntry(row);
      return entry === null ? [] : [entry];
    });
    if (entries.length > 0)
      views.set(revisionId, { entries, total: Number(list[0]!.total) });
  }
  return views;
};

const revisionGalleryEntry = (
  row: RevisionMediaRow,
): RevisionGalleryEntry | null => {
  if (row.legacy_media_id !== null && row.display_key === "base") {
    const width = dimension(row.legacy_width);
    const height = dimension(row.legacy_height);
    return width === null || height === null
      ? null
      : {
          id: row.legacy_media_id,
          src: legacyMediaSrc(row.legacy_media_id),
          width,
          height,
          live: false,
        };
  }
  if (row.state !== "ready") return null;
  const width =
    dimension(row.display_width) ?? dimension(row.presentation?.width);
  const height =
    dimension(row.display_height) ?? dimension(row.presentation?.height);
  if (width === null || height === null) return null;
  const src = publishingMediaSrc(row.item_id, "display", row.display_key);
  const renditions = toMediaRenditions(
    row.renditions,
    { src, width, height },
    "card",
    (role) => publishingMediaSrc(row.item_id, role, row.display_key),
  );
  return {
    id: row.item_id,
    src,
    width,
    height,
    live: row.kind === "live",
    ...(renditions === undefined ? {} : { renditions }),
    ...placeholderOf(row.placeholder_color),
  };
};

export interface MediaReadTargetRow extends QueryResultRow {
  storage_key: string;
  content_type: string;
  byte_size: string;
  sha256: string;
}

/** The streamable facts of a committed derivative blob, or null. */
export const mediaReadTarget = (
  row: MediaReadTargetRow | undefined,
): PublishingMediaReadTarget | null => {
  if (row === undefined) return null;
  if (row.content_type !== "image/webp" && row.content_type !== "video/mp4")
    return null;
  const byteSize = Number(row.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) return null;
  return {
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize,
    sha256: row.sha256,
  };
};

/**
 * SQL (placeholders $1 item, $2 role, $3 edit key) selecting the committed
 * blob of the ready rendition of an item that is not cancelled or purged, as
 * `d` (rendition), `b` (blob) and `i` (item). Callers append their
 * authorization predicate with AND.
 */
export const derivativeReadSql = `SELECT b.storage_key,d.content_type,b.byte_size,b.sha256
  FROM community.media_renditions d
  JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed'
  JOIN community.media_items i ON i.id=d.item_id AND i.state NOT IN ('cancelled','purged')
  WHERE d.item_id=$1 AND d.role=$2 AND d.edit_key=$3 AND d.state='ready'`;

/**
 * WorkPublishingPort.resolveMediaRead. The active owner reads any rendition
 * of their item. Anyone else reads a role (`viewer` like `display` and
 * `full`) only under the edit key the public revision of a public work shows
 * it with, or the unedited rendition of an item a published Article holds,
 * and a `full` only within the public resolution policy (D3), exactly what
 * the DTO builders list. Self-only and pending revisions stay owner-only.
 */
export const resolveMediaRead = async (
  pool: Pool,
  viewerId: string | null,
  itemId: string,
  variant: MediaVariant,
  editKey: string,
): Promise<PublishingMediaReadTarget | null> =>
  readTransaction(pool, async (db) =>
    mediaReadTarget(
      (
        await db.query<MediaReadTargetRow>(
          `${derivativeReadSql} AND (
            (i.owner_id=$4::text AND EXISTS (SELECT 1 FROM community.public_users o WHERE o.id=$4::text AND o.status='active'))
            OR (${withinPublicPolicySql("d")} AND (
              EXISTS (
                SELECT 1 FROM community.work_revision_items ri
                JOIN community.work_revisions r ON r.id=ri.revision_id
                JOIN community.works w ON w.id=r.work_id AND w.public_revision_id=r.id
                JOIN community.public_users u ON u.id=w.author_id
                WHERE ri.item_id=d.item_id AND community.work_is_public(w) AND u.status='active'
                  AND community.accounts_can_interact($4::text,w.author_id)
                  AND d.edit_key=${variantEditKeySql("d.role", "ri", "r")}
              )
              OR (i.state='ready' AND d.edit_key='base'
                AND ${publishedArticleItemSql("d.item_id", "$4::text")})
            ))
          )`,
          [itemId, variant, editKey, viewerId],
        )
      ).rows[0],
    ),
  );
