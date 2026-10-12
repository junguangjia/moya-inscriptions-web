import { asCommunityOperationError } from "./availability.js";
import { effectiveFeatured } from "./featured-content.js";
import { randomUUID } from "node:crypto";
import { CommunityNotFoundError, CommunityConflictError } from "@moya/api";
import type { CommunityDiscoveryPort, DiscoveryCardRecord } from "@moya/api";
import type {
  AuthorListQuery,
  ContentIdentity,
  DiscoveryQuery,
  InscriptionFilterOptions,
  MediaId,
} from "@moya/contracts";
import { CARD_GALLERY_MAXIMUM } from "@moya/contracts/schemas";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { visibleDiscussionCountSql } from "./discussion-visibility.js";

import {
  mapCatalogMediaDelivery,
  catalogMediaDeliveryJoinSql,
} from "./publishing/catalog-delivery.js";
import {
  revisionCover,
  revisionCoverColumns,
  revisionCoverJoin,
  revisionsGallery,
  workExcerpt,
} from "./publishing/media-read.js";
import type { RevisionCoverColumns } from "./publishing/media-read.js";
/**
 * App-role SELECT is granted only on published Catalog projections, never
 * Payload tables. In feeds, search and collections works are eligible for
 * every viewer (their author included) only when effectively public
 * (community.work_is_public) with an active, unblocked author: self-only,
 * pending first, trashed, hidden, removed and purged works never appear
 * there. A single card follows the work read rule instead: third parties the
 * same public rule, the author also their own works outside the recycle bin
 * (design §2.4 author branch). A card's title, excerpt and cover come from
 * the public revision (the denormalized public title) for everyone except the
 * work's author, who sees the author revision (P07: the latest own
 * submission, never a pending label).
 */
/**
 * The two eligible branches. `item` narrows each branch to one materialized
 * sequence item (`s.content_type`, `s.content_id`) so a page read can be driven
 * by the items index instead of re-scanning every eligible row; the
 * predicates are otherwise identical, so membership and live eligibility have
 * one definition.
 */
const eligibleBranches = (authorBranch: boolean, item = false) => `
 SELECT 'catalog'::text AS content_type,c.catalog_id AS content_id,c.kind,c.title,c.aliases,c.first_published_at,NULL::text AS author_id,c.filter_metadata
 FROM catalog_discovery c${item ? " WHERE s.content_type='catalog' AND c.catalog_id=s.content_id" : ""}
 UNION ALL
 SELECT 'work',w.id,NULL,COALESCE(ar.title,w.title),ARRAY[]::varchar[],w.first_published_at,w.author_id,'{}'::jsonb FROM community.works w
 JOIN community.public_users u ON u.id=w.author_id
 LEFT JOIN community.work_revisions ar ON w.author_id=$1 AND ar.id=w.author_revision_id
 WHERE ${item ? "s.content_type='work' AND w.id=s.content_id AND " : ""}u.status='active' AND community.accounts_can_interact($1,w.author_id) AND (community.work_is_public(w)${
   authorBranch
     ? " OR (w.author_id=$1 AND w.deleted_at IS NULL AND w.trashed_at IS NULL)"
     : ""
 })`;
const eligibleFor = (authorBranch: boolean) =>
  `WITH eligible AS (${eligibleBranches(authorBranch)}\n)`;
const eligible = eligibleFor(false);
/** Per-item live eligibility for one sequence row `s` (LATERAL). */
const eligibleItem = `LATERAL (${eligibleBranches(false, true)}\n) e`;
/**
 * Expired sequences are removed in bounded batches: at most 100 parents per
 * first-page browse, oldest first, and the batch stops at the first parent
 * whose items would not fit this budget, so one call cascades at most the
 * budget plus one sequence (the first parent always goes, however large).
 */
export const DISCOVERY_CLEANUP_ITEM_BUDGET = 20_000;
const filter = `($2='all' OR e.kind=$2) AND ($3='' OR position(lower($3) IN lower(e.title||' '||array_to_string(e.aliases,' ')))>0)
 AND NOT EXISTS(SELECT 1 FROM jsonb_each($4::jsonb) f WHERE jsonb_array_length(f.value)>0 AND NOT (
 (e.filter_metadata->f.key->'values') ?| ARRAY(SELECT jsonb_array_elements_text(f.value))
 OR (f.value ? '@unknown' AND e.filter_metadata->f.key->>'state'='UNKNOWN')
 OR (f.value ? '@unsupplied' AND e.filter_metadata->f.key->>'state'='UNSUPPLIED')
 ))`;
interface CardRow extends QueryResultRow {
  content_type: "catalog" | "work";
  content_id: string;
  kind: "inscription" | "calligraphy" | null;
  title: string;
  aliases: string[];
  author_id: string | null;
  first_published_at: Date | null;
  ordinal?: string;
}
interface WorkCardRow extends RevisionCoverColumns {
  work_id: string;
  revision_id: string;
  body: string;
}
interface CatalogCardMediaRow extends QueryResultRow {
  catalog_id: string;
  media_id: MediaId;
  object_key: string;
  width: number;
  height: number;
  is_representative: boolean;
  rn: string;
  total: string;
  renditions: unknown;
  placeholder_color: unknown;
}
const emptyFilters = {
  dynasty: [],
  textAuthor: [],
  calligrapher: [],
  originalRegion: [],
  script: [],
};
const queryIdentity = (q: DiscoveryQuery) => ({
  kind: q.kind,
  filters: q.filters,
  search: q.search,
  pageSize: q.pageSize,
});
export class PostgresCommunityDiscoveryAdapter implements CommunityDiscoveryPort {
  constructor(private readonly pool: Pool) {}
  private async run<T>(
    write: boolean,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect().catch((error) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query(
        write
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
          : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }
  private async project(
    db: PoolClient,
    rows: readonly CardRow[],
    viewer: string | null,
  ): Promise<DiscoveryCardRecord[]> {
    const catalogs = rows
        .filter((r) => r.content_type === "catalog")
        .map((r) => r.content_id),
      works = rows
        .filter((r) => r.content_type === "work")
        .map((r) => r.content_id);
    // Catalog cards carry the rendition delivery facts of their images (the
    // published-only community view); the service resolves card candidates.
    // One read lists each item's representative image and its first gallery
    // images by position, with the item's image total.
    const catalogMedia = new Map<string, CatalogCardMediaRow[]>();
    for (const row of (
      await db.query<CatalogCardMediaRow>(
        `SELECT cm.catalog_id,cm.media_id,cm.object_key,cm.width,cm.height,cm.is_representative,cm.rn,cm.total,
          delivery.renditions,delivery.placeholder_color
        FROM (
          SELECT m.*,
            row_number() OVER (PARTITION BY m.catalog_id ORDER BY m.position) AS rn,
            count(*) OVER (PARTITION BY m.catalog_id) AS total
          FROM catalog_media m WHERE m.catalog_id=ANY($1::text[])
        ) cm${catalogMediaDeliveryJoinSql("cm")}
        WHERE cm.is_representative OR cm.rn<=$2
        ORDER BY cm.catalog_id,cm.position`,
        [catalogs, CARD_GALLERY_MAXIMUM],
      )
    ).rows) {
      const list = catalogMedia.get(row.catalog_id);
      if (list === undefined) catalogMedia.set(row.catalog_id, [row]);
      else list.push(row);
    }
    const catalogImage = (row: CatalogCardMediaRow) => ({
      type: "catalog" as const,
      id: row.media_id,
      objectKey: row.object_key,
      width: row.width,
      height: row.height,
      ...mapCatalogMediaDelivery(row.renditions, row.placeholder_color),
    });
    const provinces = new Map(
      (
        await db.query<{ catalog_id: string; province: string }>(
          "SELECT catalog_id,province FROM catalog_entries WHERE catalog_id=ANY($1::text[]) AND province_state='VALUE'",
          [catalogs],
        )
      ).rows.map((row) => [row.catalog_id, row.province]),
    );
    // Cards read the viewer's revision (the author revision for the work's
    // author, else the public revision): its excerpt and its cover (the chosen
    // cover item under its cover crop, else the first item), static even for
    // a Live Photo, with the card candidates of the cover's own framing.
    const wm = (
      await db.query<WorkCardRow>(
        `SELECT w.id AS work_id,r.id AS revision_id,r.body,${revisionCoverColumns("cov")}
        FROM community.works w JOIN community.work_revisions r
          ON r.id=CASE WHEN w.author_id=$2::text THEN COALESCE(w.author_revision_id,w.public_revision_id) ELSE w.public_revision_id END
        ${revisionCoverJoin("r", "cov")}
        WHERE w.id=ANY($1::text[])`,
        [works, viewer],
      )
    ).rows;
    const workRows = new Map(wm.map((row) => [row.work_id, row]));
    // The gallery comes from the same revision as the cover, so an author's
    // newer revision never reaches anyone else.
    const galleries = await revisionsGallery(
      db,
      [...new Set(wm.map((row) => row.revision_id))],
      CARD_GALLERY_MAXIMUM,
    );
    return rows.map((r): DiscoveryCardRecord => {
      const target = { type: r.content_type, id: r.content_id } as const;
      const card = {
        target: target as DiscoveryCardRecord["target"],
        title: r.title,
        aliases: r.aliases,
        kind: r.kind,
        authorId: r.author_id,
        firstPublishedAt: r.first_published_at?.toISOString() ?? null,
      };
      if (r.content_type === "catalog") {
        const list = catalogMedia.get(r.content_id) ?? [];
        const representative = list.find((row) => row.is_representative);
        // An item without a representative image keeps no card image and
        // therefore no gallery.
        const gallery =
          representative === undefined
            ? []
            : list
                .filter((row) => Number(row.rn) <= CARD_GALLERY_MAXIMUM)
                .map(catalogImage);
        return {
          ...card,
          ...(provinces.has(r.content_id)
            ? { province: provinces.get(r.content_id)! }
            : {}),
          media: representative ? catalogImage(representative) : null,
          ...(gallery.length === 0
            ? {}
            : { gallery, mediaCount: Number(list[0]!.total) }),
        };
      }
      const w = workRows.get(r.content_id);
      const cover = w ? revisionCover(w) : null;
      const excerpt = workExcerpt(w?.body ?? "");
      const media = cover
        ? {
            type: "work" as const,
            id: cover.id,
            // Unedited legacy covers keep their user media path; every other
            // cover uses its derivative path.
            src: cover.src,
            width: cover.width,
            height: cover.height,
            ...(cover.renditions === undefined
              ? {}
              : { renditions: cover.renditions }),
            ...(cover.placeholderColor === undefined
              ? {}
              : { placeholderColor: cover.placeholderColor }),
          }
        : null;
      const view =
        media === null || w === undefined
          ? undefined
          : galleries.get(w.revision_id);
      return {
        ...card,
        ...(excerpt === "" ? {} : { excerpt }),
        live: cover?.live ?? false,
        media,
        ...(view === undefined
          ? {}
          : {
              gallery: view.entries.map((entry) => ({
                type: "work" as const,
                id: entry.id,
                src: entry.src,
                width: entry.width,
                height: entry.height,
                ...(entry.live ? { live: true } : {}),
                ...(entry.renditions === undefined
                  ? {}
                  : { renditions: entry.renditions }),
                ...(entry.placeholderColor === undefined
                  ? {}
                  : { placeholderColor: entry.placeholderColor }),
              })),
              mediaCount: Math.max(view.total, view.entries.length),
            }),
      };
    });
  }
  async browse(viewer: string | null, q: DiscoveryQuery) {
    // Bounded maintenance in its own READ COMMITTED statement. A concurrent
    // cleanup can wait for deletion without invalidating a browsing snapshot.
    // Oldest first; the batch stops once the cascaded items would exceed the
    // budget (the first parent always goes), so a backlog of large sequences
    // is drained over several browses instead of one long request.
    if (!q.sequence)
      await this.pool.query(
        `DELETE FROM community.discovery_sequences WHERE id IN (
      SELECT id FROM (
        SELECT x.id,x.n,sum(x.n) OVER (ORDER BY x.created_at,x.id) AS run FROM (
          SELECT id,created_at,(SELECT count(*) FROM community.discovery_sequence_items i WHERE i.sequence_id=s.id) AS n
          FROM community.discovery_sequences s WHERE created_at<CURRENT_TIMESTAMP-INTERVAL '24 hours'
          ORDER BY created_at,id LIMIT 100
        ) x
      ) y WHERE run-n<$1::bigint
    )`,
        [DISCOVERY_CLEANUP_ITEM_BUDGET],
      );
    return this.run(true, async (db) => {
      const sequence = q.sequence ?? randomUUID(),
        fingerprint = JSON.stringify(queryIdentity(q));
      if (q.sequence) {
        const state = (
          await db.query<{ query: unknown }>(
            "SELECT query FROM community.discovery_sequences WHERE id=$1 AND viewer_id IS NOT DISTINCT FROM $2::text AND created_at>CURRENT_TIMESTAMP-INTERVAL '24 hours'",
            [sequence, viewer],
          )
        ).rows[0];
        if (
          !state ||
          JSON.stringify(state.query) !==
            JSON.stringify(JSON.parse(fingerprint))
        ) {
          // JSONB sorts object keys; compare JSONB rather than JavaScript serialization below.
          const matches =
            state &&
            (
              await db.query("SELECT $1::jsonb=$2::jsonb AS equal", [
                JSON.stringify(state.query),
                fingerprint,
              ])
            ).rows[0]?.equal;
          if (!matches)
            throw new CommunityConflictError(
              "This browsing sequence expired or belongs to another view; refresh to continue",
            );
        }
      } else {
        if (q.after !== 0)
          throw new CommunityConflictError("A new sequence starts at the top");
        await db.query(
          "INSERT INTO community.discovery_sequences(id,viewer_id,query) VALUES($1,$2,$3::jsonb)",
          [sequence, viewer, fingerprint],
        );
        await db.query(
          `${eligible}, ${effectiveFeatured}, filtered AS (SELECT e.* FROM eligible e WHERE ${filter}), featured AS (
      SELECT f.content_type,f.content_id,row_number() OVER(ORDER BY f.position,f.content_type,f.content_id) AS featured_order
      FROM effective_featured f JOIN filtered e USING(content_type,content_id) WHERE f.enabled
      ORDER BY f.position,f.content_type,f.content_id LIMIT (SELECT enabled_quantity FROM community.featured_settings WHERE id=TRUE)
     ), ordered AS (SELECT e.content_type,e.content_id,row_number() OVER(ORDER BY (f.featured_order IS NULL),f.featured_order,e.first_published_at DESC NULLS LAST,e.content_type,e.content_id) AS ordinal
      FROM filtered e LEFT JOIN featured f USING(content_type,content_id))
     INSERT INTO community.discovery_sequence_items(sequence_id,ordinal,content_type,content_id) SELECT $5::uuid,ordinal,content_type,content_id FROM ordered`,
          [viewer, q.kind, q.search, JSON.stringify(q.filters), sequence],
        );
      }
      // Sequence membership and order stay fixed; live eligibility suppresses
      // withdrawals. The items index drives the read (ordinal order, LIMIT)
      // and eligibility is re-checked per item, so a page costs its own rows
      // rather than a scan of every eligible row.
      const rows = (
        await db.query<CardRow>(
          `SELECT e.*,s.ordinal FROM community.discovery_sequence_items s CROSS JOIN ${eligibleItem}
    WHERE ${filter} AND s.sequence_id=$5 AND s.ordinal>$6 ORDER BY s.ordinal LIMIT $7`,
          [
            viewer,
            q.kind,
            q.search,
            JSON.stringify(q.filters),
            sequence,
            q.after,
            q.pageSize + 1,
          ],
        )
      ).rows;
      const page = rows.slice(0, q.pageSize),
        nextAfter = Number(page.at(-1)?.ordinal ?? q.after);
      return {
        items: await this.project(db, page, viewer),
        sequence,
        nextAfter,
        hasMore: rows.length > q.pageSize,
      };
    });
  }
  async collection(
    owner: string,
    viewer: string | null,
    list: "favorite" | "like",
    q: AuthorListQuery,
  ) {
    return this.run(false, async (db) => {
      const privacyColumn =
        list === "favorite" ? "favorites_privacy" : "likes_privacy";
      if (
        (
          await db.query(
            `SELECT id FROM community.public_users WHERE id=$1 AND status='active' AND community.accounts_can_interact($2,id) AND (id=$2 OR ${privacyColumn}='public')`,
            [owner, viewer],
          )
        ).rowCount !== 1
      )
        throw new CommunityNotFoundError();
      const from = `FROM eligible e JOIN community.content_relations r ON r.content_type=e.content_type AND r.content_id=e.content_id WHERE ${filter} AND r.user_id=$5 AND r.relation=$6`,
        args = [
          viewer,
          q.kind,
          q.search,
          JSON.stringify(emptyFilters),
          owner,
          list,
        ];
      const total = Number(
        (await db.query(`${eligible} SELECT count(*) AS n ${from}`, args))
          .rows[0]?.n ?? 0,
      );
      const rows = (
        await db.query<CardRow>(
          `${eligible} SELECT e.* ${from} ORDER BY r.created_at DESC,e.content_type,e.content_id LIMIT $7 OFFSET $8`,
          [...args, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      return {
        items: await this.project(db, rows, viewer),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  async card(target: ContentIdentity, viewer: string | null) {
    return this.run(false, async (db) => {
      const rows = (
        await db.query<CardRow>(
          `${eligibleFor(true)} SELECT e.* FROM eligible e WHERE content_type=$2 AND content_id=$3`,
          [viewer, target.type, target.id],
        )
      ).rows;
      const item = (await this.project(db, rows, viewer))[0];
      if (!item) throw new CommunityNotFoundError();
      return item;
    });
  }
  async state(target: ContentIdentity, actor: string | null) {
    return this.run(false, async (db) => {
      const row = (
        await db.query<{
          favorite: boolean;
          liked: boolean;
          favorite_count: string;
          like_count: string;
        }>(
          `SELECT COALESCE(bool_or(r.user_id=$1 AND r.relation='favorite'),false) AS favorite,
           COALESCE(bool_or(r.user_id=$1 AND r.relation='like'),false) AS liked,
           count(*) FILTER(WHERE r.relation='favorite') AS favorite_count,
           count(*) FILTER(WHERE r.relation='like') AS like_count
           FROM community.content_relations r
           JOIN community.public_users u ON u.id=r.user_id AND u.status='active'
           WHERE r.content_type=$2 AND r.content_id=$3`,
          [actor, target.type, target.id],
        )
      ).rows[0]!;
      const comments = (
        await db.query<{ n: string }>(visibleDiscussionCountSql, [
          target.type,
          target.id,
          actor,
        ])
      ).rows[0];
      return {
        favorite: row.favorite,
        liked: row.liked,
        favoriteCount: Number(row.favorite_count),
        likeCount: Number(row.like_count),
        commentCount: Number(comments?.n ?? 0),
      };
    });
  }
  async filterOptions(): Promise<InscriptionFilterOptions> {
    return this.run(false, async (db) => {
      const result: Record<
        string,
        { values: string[]; unknown: number; unsupplied: number }
      > = {};
      for (const dimension of Object.keys(emptyFilters)) {
        const rows = (
          await db.query<{ value: string }>(
            "SELECT DISTINCT jsonb_array_elements_text(filter_metadata->$1->'values') AS value FROM catalog_discovery WHERE kind='inscription' ORDER BY value",
            [dimension],
          )
        ).rows;
        const counts = (
          await db.query(
            "SELECT count(*) FILTER(WHERE filter_metadata->$1->>'state'='UNKNOWN') AS unknown,count(*) FILTER(WHERE filter_metadata->$1->>'state'='UNSUPPLIED') AS unsupplied FROM catalog_discovery WHERE kind='inscription'",
            [dimension],
          )
        ).rows[0];
        result[dimension] = {
          values: rows.map((r) => r.value),
          unknown: Number(counts?.unknown ?? 0),
          unsupplied: Number(counts?.unsupplied ?? 0),
        };
      }
      return result as InscriptionFilterOptions;
    });
  }
}
