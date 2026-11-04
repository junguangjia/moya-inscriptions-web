import { createHash } from "node:crypto";

import { projectCatalogSearchDocument } from "@moya/search";

// The Admin MCP bench seed (admin-mcp-completion-v1 section 21). Plain SQL on a
// marked disposable database, so a run costs seconds, and every row is a pure
// function of its index, so a run is repeatable. Oracles come from the rows generated
// here, never from the tools under test and never from the same SQL they run.

/**
 * The design's target, an assumption until live counts are read. Articles,
 * collections and versions per record are this seed's own assumption: the design
 * names no number for them, and the find branches should not run on empty tables.
 */
export const BENCH_SCALE = {
  catalogs: 5_000,
  articles: 200,
  collections: 40,
  users: 20_000,
  works: 50_000,
  comments: 200_000,
  reports: 2_000,
} as const;

export interface BenchDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

type RecordStatus = "draft" | "published" | "draft_over_published";
type StatefulState = "VALUE" | "UNSUPPLIED" | "CLEAR";

interface Stateful {
  readonly state: StatefulState;
  readonly value?: string;
}

interface CatalogVersion {
  readonly revision: number;
  readonly status: "draft" | "published";
  readonly title: string;
  readonly transcription: Stateful;
}

export interface CatalogSpec {
  readonly index: number;
  readonly catalogId: string;
  readonly sourceId: string;
  readonly provenanceSourceId?: string;
  readonly status: RecordStatus;
  readonly dynasty: Stateful;
  readonly province: Stateful;
  /** Oldest first; the last one is the latest version. */
  readonly versions: readonly CatalogVersion[];
  readonly mediaCount: number;
  readonly aliases: readonly string[];
}

const mix = (index: number, salt: number): number => {
  let hash =
    Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

const pick = <T>(index: number, salt: number, list: readonly T[]): T =>
  list[mix(index, salt) % list.length]!;

const percent = (index: number, salt: number) => mix(index, salt) % 100;

const DYNASTIES = [
  "秦",
  "汉",
  "三国",
  "晋",
  "南北朝",
  "隋",
  "唐",
  "五代",
  "宋",
  "辽",
  "金",
  "元",
  "明",
  "清",
] as const;

const PROVINCES = [
  "陕西",
  "河南",
  "山东",
  "山西",
  "河北",
  "甘肃",
  "四川",
  "江苏",
  "浙江",
  "北京",
  "云南",
  "广西",
] as const;

/** Near-twins on purpose: a stem repeats, as stele names do. Some are traditional. */
const TITLE_STEMS = [
  "泰山经石峪",
  "泰山經石峪",
  "龙门造像记",
  "龍門造像記",
  "张迁碑",
  "曹全碑",
  "礼器碑",
  "石门颂",
  "乙瑛碑",
  "西狭颂",
  "郑文公碑",
  "张猛龙碑",
] as const;

const FILLER = Array.from(
  "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔",
);
const SUPPLEMENTARY = "\u{20000}";

const LONG_TEXT_EVERY = 500;
const LONG_TEXT_CHARS = 90_000;

/** Mostly a few hundred characters, some several thousand, a few very long. */
const transcriptionLength = (index: number) => {
  if (index % LONG_TEXT_EVERY === 0) return LONG_TEXT_CHARS;
  const roll = mix(index, 3) % 100;
  return roll < 4
    ? 5_000 + (mix(index, 4) % 15_000)
    : 80 + (mix(index, 4) % 1_400);
};

const textOf = (index: number, length: number) => {
  const parts: string[] = [];
  for (let at = 0; at < length; at += 1)
    parts.push(FILLER[mix(index + at, 5) % FILLER.length]!);
  if (index % 50 === 0) parts[Math.floor(length / 2)] = SUPPLEMENTARY;
  return parts.join("");
};

const statefulOf = (index: number, salt: number, values: readonly string[]) => {
  const roll = percent(index, salt);
  return roll < 70
    ? ({ state: "VALUE", value: pick(index, salt + 1, values) } as const)
    : ({ state: roll < 90 ? "UNSUPPLIED" : "CLEAR" } as const);
};

const flipped = (index: number, transcription: Stateful): Stateful =>
  transcription.state === "VALUE"
    ? { state: "UNSUPPLIED" }
    : { state: "VALUE", value: textOf(index, 120) };

export const catalogIdOf = (index: number) =>
  `bench-catalog-${String(index).padStart(5, "0")}`;
export const sourceIdOf = (index: number) =>
  `bench-source-${String(index).padStart(5, "0")}`;

/**
 * Row ids equal the index on a database this seed filled, so a bench can name a record
 * by id with no read. Older versions hold the opposite transcription state, and a live
 * row under a newer draft holds its own: a count that reads the wrong row is wrong.
 */
export const catalogSpec = (index: number): CatalogSpec => {
  const statusRoll = percent(index, 1);
  const status: RecordStatus =
    statusRoll < 55
      ? "published"
      : statusRoll < 85
        ? "draft"
        : "draft_over_published";
  const stateRoll = percent(index, 2);
  const transcription: Stateful =
    stateRoll < 30
      ? { state: "UNSUPPLIED" }
      : stateRoll < 38
        ? { state: "CLEAR" }
        : { state: "VALUE", value: textOf(index, transcriptionLength(index)) };
  const stem = pick(index, 6, TITLE_STEMS);
  const title = `${stem}（合成${index}）`;
  const older =
    status === "draft_over_published"
      ? 1 + (mix(index, 7) % 3)
      : mix(index, 7) % 4;
  const versions: CatalogVersion[] = [];
  for (let at = 1; at <= older; at += 1)
    versions.push({
      revision: at,
      status:
        status === "draft_over_published" && at === older
          ? "published"
          : "draft",
      title:
        at === older ? `${stem}（旧题${index}）` : `${stem}（底稿${index}）`,
      transcription: flipped(index, transcription),
    });
  versions.push({
    revision: older + 1,
    status: status === "published" ? "published" : "draft",
    title,
    transcription,
  });
  const provenanceSourceId =
    index % 4 === 0
      ? `bench-provenance-${String(index).padStart(5, "0")}`
      : undefined;
  return {
    index,
    catalogId: catalogIdOf(index),
    sourceId: sourceIdOf(index),
    ...(provenanceSourceId === undefined ? {} : { provenanceSourceId }),
    status,
    dynasty: statefulOf(index, 8, DYNASTIES),
    province: statefulOf(index, 10, PROVINCES),
    versions,
    mediaCount: index % 10 === 0 ? 0 : 1 + (mix(index, 12) % 3),
    aliases: index % 3 === 0 ? [`${stem}别称${index}`] : [],
  };
};

const hex = (text: string, size = 32) =>
  createHash("sha256").update(text).digest("hex").slice(0, size);

const statefulColumns = (name: string, field: Stateful) => ({
  [`${name}_state`]: field.state,
  [`${name}_value`]: field.value ?? null,
});

const AT = "2026-10-01T00:00:00.000Z";
const atOf = (index: number, revision: number) =>
  new Date(Date.parse(AT) - index * 60_000 + revision * 1_000).toISOString();

const contentColumns = (spec: CatalogSpec, version: CatalogVersion) => ({
  revision: version.revision,
  catalog_id: spec.catalogId,
  source_id: spec.sourceId,
  kind: spec.index % 2 === 0 ? "inscription" : "calligraphy",
  title: version.title,
  summary: `${version.title}的合成摘要`,
  ...statefulColumns("dynasty", spec.dynasty),
  ...statefulColumns("province", spec.province),
  ...statefulColumns("transcription", version.transcription),
  updated_at: atOf(spec.index, version.revision),
  created_at: atOf(spec.index, 0),
});

const prefixed = (columns: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(columns).map(([name, value]) => [`version_${name}`, value]),
  );

const insertRows = async (
  db: BenchDb,
  table: string,
  rows: readonly Record<string, unknown>[],
  batch = 500,
) => {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!)
    .map((name) => `"${name}"`)
    .join(", ");
  for (let at = 0; at < rows.length; at += batch)
    await db.query(
      `INSERT INTO "${table}" (${columns}) SELECT ${columns}
       FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb)`,
      [JSON.stringify(rows.slice(at, at + batch))],
    );
};

const moveSequence = (db: BenchDb, table: string) =>
  db.query(
    `SELECT setval(pg_get_serial_sequence($1, 'id'),
       (SELECT COALESCE(max(id), 1) FROM "${table}"))`,
    [`"${table}"`],
  );

/** The version the live row holds; a pure draft's live row is its latest draft. */
const liveVersionOf = (spec: CatalogSpec): CatalogVersion =>
  spec.status === "draft_over_published"
    ? spec.versions.at(-2)!
    : spec.versions.at(-1)!;

const seedCatalogs = async (db: BenchDb, count: number, ownerId: number) => {
  const specs = Array.from({ length: count }, (_, at) => catalogSpec(at + 1));
  const CHUNK = 500;
  let versionId = 0;
  for (let start = 0; start < specs.length; start += CHUNK) {
    const chunk = specs.slice(start, start + CHUNK);
    const main: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const mainMedia: Record<string, unknown>[] = [];
    const versionMedia: Record<string, unknown>[] = [];
    const mediaRows: Record<string, unknown>[] = [];
    const mainAliases: Record<string, unknown>[] = [];
    const versionAliases: Record<string, unknown>[] = [];
    const mainProvenance: Record<string, unknown>[] = [];
    const versionProvenance: Record<string, unknown>[] = [];
    const identities: Record<string, unknown>[] = [];
    const receipts: Record<string, unknown>[] = [];
    const searchDocuments: Record<string, unknown>[] = [];
    const firstPublications: Record<string, unknown>[] = [];
    for (const spec of chunk) {
      const live = liveVersionOf(spec);
      const isLive = spec.status !== "draft";
      main.push({
        id: spec.index,
        ...contentColumns(spec, live),
        _status: isLive ? "published" : "draft",
      });
      const media = Array.from({ length: spec.mediaCount }, (_, at) => {
        const mediaId = `bench-media-${spec.index}-${at + 1}`;
        const sha256 = hex(mediaId, 64);
        return {
          sha256,
          row: {
            media_id: mediaId,
            object_key: `editorial/${sha256}/${sha256}.jpg`,
            width: 6_000,
            height: 9_000,
            alt: `${spec.catalogId} 图${at + 1}`,
            position: at,
            is_representative: at === 0,
          },
        };
      });
      for (const { sha256, row } of media) {
        mainMedia.push({
          _order: row.position + 1,
          _parent_id: spec.index,
          id: hex(`main-${row.media_id}`, 24),
          ...row,
        });
        mediaRows.push({
          media_id: row.media_id,
          catalog_id: spec.catalogId,
          object_key: row.object_key,
          sha256,
          alt: row.alt,
          filename: `${sha256}.jpg`,
          prefix: `editorial/${sha256}`,
          mime_type: "image/jpeg",
          filesize: 12_000_000,
          width: row.width,
          height: row.height,
        });
      }
      spec.aliases.forEach((alias, at) =>
        mainAliases.push({
          _order: at + 1,
          _parent_id: spec.index,
          id: hex(`alias-${spec.index}-${at}`, 24),
          alias,
          alias_type: "alternate",
        }),
      );
      if (spec.provenanceSourceId !== undefined) {
        mainProvenance.push({
          _order: 1,
          _parent_id: spec.index,
          id: hex(`provenance-${spec.index}`, 24),
          source_id: spec.provenanceSourceId,
        });
        identities.push({
          identity_value: spec.provenanceSourceId,
          kind: "source",
          catalog_id: spec.catalogId,
        });
      }
      identities.push(
        {
          identity_value: spec.catalogId,
          kind: "catalog",
          catalog_id: spec.catalogId,
        },
        {
          identity_value: spec.sourceId,
          kind: "source",
          catalog_id: spec.catalogId,
        },
      );
      spec.versions.forEach((version, at) => {
        versionId += 1;
        const latest = at === spec.versions.length - 1;
        versions.push({
          id: versionId,
          parent_id: spec.index,
          ...prefixed(contentColumns(spec, version)),
          version__status: version.status,
          created_at: atOf(spec.index, version.revision),
          updated_at: atOf(spec.index, version.revision),
          latest,
          autosave: false,
        });
        for (const { row } of media)
          versionMedia.push({
            _order: row.position + 1,
            _parent_id: versionId,
            _uuid: hex(`version-${versionId}-${row.media_id}`, 24),
            ...row,
          });
        spec.aliases.forEach((alias, order) =>
          versionAliases.push({
            _order: order + 1,
            _parent_id: versionId,
            _uuid: hex(`version-alias-${versionId}-${order}`, 24),
            alias,
            alias_type: "alternate",
          }),
        );
        if (spec.provenanceSourceId !== undefined)
          versionProvenance.push({
            _order: 1,
            _parent_id: versionId,
            _uuid: hex(`version-provenance-${versionId}`, 24),
            source_id: spec.provenanceSourceId,
          });
        receipts.push({
          deduplication_key: `bench-${spec.index}-${version.revision}`,
          request_fingerprint: hex(`request-${versionId}`, 64),
          actor_id: ownerId,
          operation: "save-draft",
          status: "completed",
          catalog_id: spec.index,
          revision: version.revision,
          fingerprint: hex(`content-${versionId}`, 64),
          updated_at: atOf(spec.index, version.revision),
          created_at: atOf(spec.index, version.revision),
        });
      });
      if (isLive) {
        const projected = projectCatalogSearchDocument({
          title: live.title,
          aliases: spec.aliases,
          summary: `${live.title}的合成摘要`,
          ...(spec.dynasty.value === undefined
            ? {}
            : { dynasty: spec.dynasty.value }),
          ...(spec.province.value === undefined
            ? {}
            : { province: spec.province.value }),
          ...(live.transcription.value === undefined
            ? {}
            : { transcription: live.transcription.value }),
        } as Parameters<typeof projectCatalogSearchDocument>[0]);
        searchDocuments.push({
          catalog_id: spec.catalogId,
          normalization_version: projected.normalizationVersion,
          title: projected.title,
          aliases: projected.aliases,
          normalized_title: projected.normalizedTitle,
          normalized_aliases: projected.normalizedAliases,
          title_alias_text: projected.titleAliasText,
          structured_text: projected.structuredText,
          combined_text: projected.combinedText,
        });
        firstPublications.push({
          catalog_id: spec.catalogId,
          first_published_at: atOf(spec.index, live.revision),
        });
      }
    }
    await insertRows(db, "catalogs", main, 100);
    await insertRows(db, "_catalogs_v", versions, 100);
    await insertRows(db, "catalogs_media", mainMedia);
    await insertRows(db, "_catalogs_v_version_media", versionMedia);
    await insertRows(db, "media", mediaRows);
    await insertRows(db, "catalogs_aliases", mainAliases);
    await insertRows(db, "_catalogs_v_version_aliases", versionAliases);
    await insertRows(db, "catalogs_provenance", mainProvenance);
    await insertRows(db, "_catalogs_v_version_provenance", versionProvenance);
    await insertRows(db, "editorial_identities", identities);
    await insertRows(db, "editorial_receipts", receipts);
    await insertRows(db, "catalog_search_documents", searchDocuments, 100);
    await insertRows(db, "catalog_first_publications", firstPublications);
  }
  await moveSequence(db, "catalogs");
  await moveSequence(db, "_catalogs_v");
  return specs;
};

const seedArticles = async (db: BenchDb, count: number) => {
  const articles = Array.from({ length: count }, (_, at) => {
    const index = at + 1;
    const title = `合成文章第${index}篇`;
    return {
      id: index,
      revision: 1,
      article_id: `article-${hex(`article-${index}`)}`,
      presentation: index % 2 === 0 ? "news" : "academic",
      title,
      summary: `${title}的摘要`,
      updated_at: atOf(index, 1),
      created_at: atOf(index, 0),
      _status: index % 3 === 0 ? "draft" : "published",
    };
  });
  await insertRows(db, "articles", articles);
  await insertRows(
    db,
    "_articles_v",
    articles.map(({ id, _status, updated_at, created_at, ...content }) => ({
      id,
      parent_id: id,
      ...prefixed({ ...content, updated_at, created_at }),
      version__status: _status,
      created_at,
      updated_at,
      latest: true,
      autosave: false,
    })),
  );
  await moveSequence(db, "articles");
  await moveSequence(db, "_articles_v");
};

const seedCollections = async (db: BenchDb, count: number) => {
  const collections = Array.from({ length: count }, (_, at) => {
    const index = at + 1;
    const title = `合成专题第${index}辑`;
    return {
      id: index,
      revision: 1,
      collection_id: `collection-${hex(`collection-${index}`)}`,
      title,
      summary: `${title}的摘要`,
      updated_at: atOf(index, 1),
      created_at: atOf(index, 0),
      _status: "published",
    };
  });
  await insertRows(db, "article_collections", collections);
  await insertRows(
    db,
    "_article_collections_v",
    collections.map(({ id, _status, updated_at, created_at, ...content }) => ({
      id,
      parent_id: id,
      ...prefixed({ ...content, updated_at, created_at }),
      version__status: _status,
      created_at,
      updated_at,
      latest: true,
      autosave: false,
    })),
  );
  await moveSequence(db, "article_collections");
  await moveSequence(db, "_article_collections_v");
};

/** A few documents the Owner has open, so the lock read is not of an empty table. */
const seedLocks = async (
  db: BenchDb,
  catalogIds: readonly number[],
  ownerId: number,
) => {
  for (const catalogId of catalogIds) {
    const { rows } = await db.query(
      `INSERT INTO payload_locked_documents DEFAULT VALUES RETURNING id`,
    );
    const parent = rows[0]!.id;
    await db.query(
      `INSERT INTO payload_locked_documents_rels ("order", parent_id, path, catalogs_id, users_id)
       VALUES (NULL, $1, 'document', $2, NULL), (NULL, $1, 'user', NULL, $3)`,
      [parent, catalogId, ownerId],
    );
  }
};

export interface BenchOracle {
  readonly c1: {
    readonly total: number;
    readonly groups: readonly {
      readonly state: StatefulState;
      readonly value: string | null;
      readonly count: number;
    }[];
  };
  readonly c4: Readonly<
    Record<
      RecordStatus,
      {
        readonly id: number;
        readonly catalogId: string;
        readonly sourceId: string;
      }
    >
  >;
  readonly longTextIds: readonly number[];
  readonly statusCounts: Readonly<Record<RecordStatus, number>>;
}

/** Computed from the generated rows alone: the tools and their SQL have no part in it. */
export const oracleOf = (specs: readonly CatalogSpec[]): BenchOracle => {
  const groups = new Map<
    string,
    { state: StatefulState; value: string | null; count: number }
  >();
  const statusCounts = { draft: 0, published: 0, draft_over_published: 0 };
  const first: Partial<Record<RecordStatus, CatalogSpec>> = {};
  for (const spec of specs) {
    statusCounts[spec.status] += 1;
    first[spec.status] ??= spec;
    const latest = spec.versions.at(-1)!;
    if (
      latest.status === "draft" &&
      (latest.transcription.state === "UNSUPPLIED" ||
        latest.transcription.state === "CLEAR")
    ) {
      const value = spec.dynasty.value ?? null;
      const key = `${spec.dynasty.state}|${value}`;
      const group = groups.get(key) ?? {
        state: spec.dynasty.state,
        value,
        count: 0,
      };
      group.count += 1;
      groups.set(key, group);
    }
  }
  const named = (status: RecordStatus) => {
    const spec = first[status]!;
    return {
      id: spec.index,
      catalogId: spec.catalogId,
      sourceId: spec.sourceId,
    };
  };
  const list = [...groups.values()];
  return {
    c1: {
      total: list.reduce((sum, { count }) => sum + count, 0),
      groups: list,
    },
    c4: {
      draft: named("draft"),
      published: named("published"),
      draft_over_published: named("draft_over_published"),
    },
    longTextIds: specs
      .filter(
        ({ index, versions }) =>
          index % LONG_TEXT_EVERY === 0 &&
          versions.at(-1)!.transcription.state === "VALUE",
      )
      .map(({ index }) => index),
    statusCounts,
  };
};

export const seedCms = async (
  db: BenchDb,
  ownerId: number,
): Promise<BenchOracle> => {
  const specs = await seedCatalogs(db, BENCH_SCALE.catalogs, ownerId);
  await seedArticles(db, BENCH_SCALE.articles);
  await seedCollections(db, BENCH_SCALE.collections);
  await seedLocks(db, [11, 12, 13], ownerId);
  return oracleOf(specs);
};

/**
 * The community side of the target, for the slices that read it. Nothing in S3 reads
 * these tables, so their latency is not measured yet: the rows are here so the first
 * reader meets the target scale. Row-level triggers stay on, as in Production.
 */
export const seedCommunity = async (db: BenchDb) => {
  const { users, works, comments, reports } = BENCH_SCALE;
  await db.query(
    `INSERT INTO community.public_users (id, handle, display_name, status, created_at, updated_at)
     SELECT 'user-' || md5('bench-user-' || i), 'bench-u' || i, '合成用户' || i,
       CASE WHEN i % 97 = 0 THEN 'suspended' ELSE 'active' END,
       $2::timestamptz - i * interval '1 minute', $2::timestamptz - i * interval '1 minute'
     FROM generate_series(1, $1::int) i`,
    [users, AT],
  );
  await db.query(
    `INSERT INTO community.works (id, author_id, title, text, first_published_at, updated_at, visibility, operator_state)
     SELECT 'work-' || md5('bench-work-' || i),
       'user-' || md5('bench-user-' || (1 + i % $2::int)),
       '合成作品' || i, '合成作品正文' || i,
       $3::timestamptz - i * interval '1 minute', $3::timestamptz - i * interval '1 minute',
       CASE WHEN i % 50 = 0 THEN 'self' ELSE 'public' END,
       CASE WHEN i % 211 = 0 THEN 'hidden' ELSE 'visible' END
     FROM generate_series(1, $1::int) i`,
    [works, users, AT],
  );
  await db.query(
    `INSERT INTO community.catalog_comments (id, catalog_id, author_id, text, moderation, target_type, created_at)
     SELECT 'comment-' || md5('bench-comment-' || i),
       'work-' || md5('bench-work-' || (1 + i % $2::int)),
       'user-' || md5('bench-user-' || (1 + i % $3::int)),
       '合成评论' || i,
       CASE WHEN i % 40 = 0 THEN 'hidden' ELSE 'visible' END,
       'work', $4::timestamptz - i * interval '10 seconds'
     FROM generate_series(1, $1::int) i`,
    [comments, works, users, AT],
  );
  await db.query(
    `INSERT INTO community.report_cases (id, reporter_id, target_type, target_id, canonical_path, affected_user_id, snapshot, kind, reason, status, created_at, updated_at)
     SELECT 'report-' || md5('bench-report-' || i),
       'user-' || md5('bench-user-' || (1 + i % $2::int)), 'work',
       'work-' || md5('bench-work-' || (1 + i % $3::int)),
       '/works/work-' || md5('bench-work-' || (1 + i % $3::int)),
       'user-' || md5('bench-user-' || (2 + i % ($2::int - 1))),
       '{}'::jsonb, 'standard', 'spam_scam',
       CASE WHEN i % 3 = 0 THEN 'resolved' ELSE 'open' END,
       $4::timestamptz - i * interval '1 hour', $4::timestamptz - i * interval '1 hour'
     FROM generate_series(1, $1::int) i`,
    [reports, users, works, AT],
  );
};

const CMS_TABLES = [
  ["catalogs", "catalogs"],
  ["_catalogs_v", "catalogVersions"],
  ["media", "media"],
  ["editorial_identities", "identities"],
  ["catalog_search_documents", "searchDocuments"],
  ["editorial_receipts", "receipts"],
  ["articles", "articles"],
  ["article_collections", "collections"],
] as const;

const COMMUNITY_TABLES = [
  ["community.public_users", "users"],
  ["community.works", "works"],
  ["community.catalog_comments", "comments"],
  ["community.report_cases", "reports"],
] as const;

/** What actually landed, read with plain counts, and planner statistics refreshed. */
export const finishSeed = async (db: BenchDb, withCommunity: boolean) => {
  // Not in parallel: a container's 64 MiB of /dev/shm cannot hold it at a million rows.
  await db.query("VACUUM (ANALYZE, PARALLEL 0)");
  const counts: Record<string, number> = {};
  for (const [table, name] of [
    ...CMS_TABLES,
    ...(withCommunity ? COMMUNITY_TABLES : []),
  ]) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[name] = Number(rows[0]!.n);
  }
  return counts;
};
