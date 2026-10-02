import { CommunityInputError } from "@moya/api";
import {
  articleOwnMediaPageSchema,
  workMediaSchema,
} from "@moya/contracts/schemas";
import type {
  ArticleOwnMediaListQuery,
  ArticleOwnMediaPage,
  PublicUserId,
  WorkMedia,
} from "@moya/contracts";
import type { Pool } from "pg";
import { readTransaction } from "../publishing/db.js";
import type { PublishingDb } from "../publishing/db.js";
import { selectMediaItems } from "../publishing/media.js";
import { publishedArticleItemSql } from "./published-media.js";

/** Internal aliases only; source/master bytes and private metadata are never selected. */
export const articleReadyMediaSql = (item: string): string => `
  ${item}.state='ready' AND ${item}.cancelled_at IS NULL AND ${item}.purged_at IS NULL
  AND (
    (${item}.legacy_media_id IS NOT NULL AND ${item}.kind='static' AND EXISTS (
      SELECT 1 FROM community.user_media legacy
      WHERE legacy.id=${item}.legacy_media_id AND legacy.owner_id=${item}.owner_id
        AND legacy.deleted_at IS NULL AND octet_length(legacy.bytes)>0
    )) OR (${item}.legacy_media_id IS NULL AND EXISTS (
      SELECT 1 FROM community.media_derivatives d JOIN community.media_blobs b
        ON b.id=d.blob_id AND b.state='committed'
      WHERE d.item_id=${item}.id AND d.variant='display' AND d.edit_key='base'
    ) AND (${item}.kind<>'live' OR EXISTS (
      SELECT 1 FROM community.media_derivatives d JOIN community.media_blobs b
        ON b.id=d.blob_id AND b.state='committed'
      WHERE d.item_id=${item}.id AND d.variant='motion' AND d.edit_key='base'
    )))
  )`;

interface MediaCursor {
  readonly at: string;
  readonly id: string;
}
const validCursor = (value: unknown): value is readonly [string, string] => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  )
    return false;
  if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(
      value[0],
    ) ||
    value[0].startsWith("0000-") ||
    !/^media-item-[0-9a-f]{32}$/u.test(value[1])
  )
    return false;
  const date = new Date(value[0]);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 23) === value[0].slice(0, 23)
  );
};
/** Preserve SQL's six decimal places; Date serialization would lose seek precision. */
export const encodeArticleOwnMediaCursor = (value: MediaCursor): string => {
  if (!validCursor([value.at, value.id]))
    throw new CommunityInputError("article_media_cursor_invalid");
  return Buffer.from(JSON.stringify([value.at, value.id]), "utf8").toString(
    "base64url",
  );
};
export const decodeArticleOwnMediaCursor = (
  value: string | undefined,
): MediaCursor | null => {
  if (value === undefined) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw Error();
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) throw Error();
    const decoded: unknown = JSON.parse(buffer.toString("utf8"));
    if (!validCursor(decoded)) throw Error();
    return { at: decoded[0], id: decoded[1] };
  } catch {
    throw new CommunityInputError("article_media_cursor_invalid");
  }
};

/** Caller owns the current active actor/delegation fence and transaction. */
export const listArticleOwnMedia = async (
  db: PublishingDb,
  owner: PublicUserId,
  query: ArticleOwnMediaListQuery,
): Promise<ArticleOwnMediaPage> => {
  if (
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 50
  )
    throw new CommunityInputError("article_media_query_invalid");
  const cursor = decodeArticleOwnMediaCursor(query.cursor);
  const rows = (
    await db.query<{ id: string; cursor_at: string }>(
      `
    SELECT i.id,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM community.media_items i
    WHERE i.owner_id=$1 AND ${articleReadyMediaSql("i")}
      AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2::timestamptz,$3::text))
    ORDER BY i.created_at DESC,i.id DESC LIMIT $4::integer`,
      [owner, cursor?.at ?? null, cursor?.id ?? null, query.pageSize + 1],
    )
  ).rows;
  const visible = rows.slice(0, query.pageSize),
    last = visible.at(-1);
  const items = await selectMediaItems(
    db,
    owner,
    visible.map((row) => row.id),
  );
  return articleOwnMediaPageSchema.parse({
    items: visible.flatMap((row) => {
      const item = items.get(row.id);
      return item?.media && item.presentation && item.state === "ready"
        ? [item]
        : [];
    }),
    nextCursor:
      rows.length > query.pageSize && last
        ? encodeArticleOwnMediaCursor({ at: last.cursor_at, id: last.id })
        : null,
  });
};

/** Public reader only: exact current published refs and immutable owner, no item DTO metadata. */
export const resolvePublishedArticleManagedMedia = async (
  pool: Pool,
  owner: PublicUserId,
  itemIds: readonly string[],
): Promise<ReadonlyMap<string, WorkMedia>> => {
  const ids = [...new Set(itemIds)];
  if (
    ids.length > 60 ||
    ids.some((id) => !/^media-item-[0-9a-f]{32}$/u.test(id))
  )
    throw new CommunityInputError("article_media_references_invalid");
  if (ids.length === 0) return new Map();
  return readTransaction(pool, async (db) => {
    const rows = (
      await db.query<{ id: string }>(
        `SELECT i.id FROM community.media_items i
      WHERE i.owner_id=$1 AND i.id=ANY($2::text[]) AND ${articleReadyMediaSql("i")}
      AND ${publishedArticleItemSql("i.id", "NULL::text")}
      ORDER BY i.id`,
        [owner, ids],
      )
    ).rows;
    const items = await selectMediaItems(
      db,
      owner,
      rows.map((row) => row.id),
    );
    const result = new Map<string, WorkMedia>();
    for (const row of rows) {
      const item = items.get(row.id);
      if (!item?.media || !item.presentation || item.state !== "ready")
        continue;
      const media = workMediaSchema.safeParse({
        id: item.id,
        kind: item.kind,
        src: item.media.displaySrc,
        width: item.presentation.width,
        height: item.presentation.height,
        ...(item.kind === "live"
          ? {
              motionSrc: item.media.motionSrc,
              ...(item.presentation.hasAudio !== undefined
                ? { hasAudio: item.presentation.hasAudio }
                : {}),
            }
          : {}),
      });
      if (media.success) result.set(row.id, media.data);
    }
    return result;
  });
};
