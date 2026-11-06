import { createHash } from "node:crypto";

import { resolveAnalyticsRange } from "@moya/contracts/internal/admin-mcp";
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
  mediaItems: 20_000,
  publishingJobs: 20_000,
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

// What C2 and C3 write to, past the target scale so no read path meets a changed row.
// Each holds a transcription, so C1's count stays true whichever runs first.
const FIRST_FIXTURE = BENCH_SCALE.catalogs + 1;
const C2_TITLE = "泰山经石峪";
const C2_NEW_TITLE = "泰山经石峪金刚经";
const C3_FIRST = FIRST_FIXTURE + 3;
const C3_COUNT = 30;
const C3_MISSING_FIELD = "title";

/** How many records the seed holds beyond BENCH_SCALE.catalogs. */
export const BENCH_FIXTURE_RECORDS = 3 + C3_COUNT;

const fixtureSpec = (
  index: number,
  status: "draft" | "published",
  title: string,
  rich = false,
): CatalogSpec => ({
  index,
  catalogId: catalogIdOf(index),
  sourceId: sourceIdOf(index),
  ...(rich
    ? {
        provenanceSourceId: `bench-provenance-${String(index).padStart(5, "0")}`,
      }
    : {}),
  status,
  dynasty: { state: "VALUE", value: "南北朝" },
  province: { state: "VALUE", value: "山东" },
  versions: [
    {
      revision: 1,
      status,
      title,
      transcription: { state: "VALUE", value: textOf(index, 120) },
    },
  ],
  mediaCount: rich ? 1 : 0,
  aliases: rich ? [`${title}别称`] : [],
});

/**
 * C2: the draft to edit, its near-twin, and a published record with the same title.
 * C3: thirty drafts with no images, so a publish has no delivery to wait for.
 */
const fixtureSpecs = (): readonly CatalogSpec[] => [
  fixtureSpec(FIRST_FIXTURE, "draft", C2_TITLE, true),
  fixtureSpec(FIRST_FIXTURE + 1, "draft", `${C2_TITLE}（拓片）`),
  fixtureSpec(FIRST_FIXTURE + 2, "published", C2_TITLE),
  ...Array.from({ length: C3_COUNT }, (_, at) =>
    fixtureSpec(C3_FIRST + at, "draft", `合成待发布第${at + 1}条`),
  ),
];

const hex = (text: string, size = 32) =>
  createHash("sha256").update(text).digest("hex").slice(0, size);

const statefulColumns = (name: string, field: Stateful) => ({
  [`${name}_state`]: field.state,
  [`${name}_value`]: field.value ?? null,
});

const AT = "2026-10-01T00:00:00.000Z";
const atOf = (index: number, revision: number) =>
  new Date(Date.parse(AT) - index * 60_000 + revision * 1_000).toISOString();

export const kindOf = (index: number) =>
  index % 2 === 0 ? "inscription" : "calligraphy";

const contentColumns = (spec: CatalogSpec, version: CatalogVersion) => ({
  revision: version.revision,
  catalog_id: spec.catalogId,
  source_id: spec.sourceId,
  kind: kindOf(spec.index),
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
  const specs = [
    ...Array.from({ length: count }, (_, at) => catalogSpec(at + 1)),
    ...fixtureSpecs(),
  ];
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

/** A document someone has open now: the row a keystroke in the Admin writes. */
export const holdLock = async (
  db: BenchDb,
  catalogId: number,
  userId: number,
) => {
  const { rows } = await db.query(
    `INSERT INTO payload_locked_documents DEFAULT VALUES RETURNING id`,
  );
  const parent = rows[0]!.id;
  await db.query(
    `INSERT INTO payload_locked_documents_rels ("order", parent_id, path, catalogs_id, users_id)
     VALUES (NULL, $1, 'document', $2, NULL), (NULL, $1, 'user', NULL, $3)`,
    [parent, catalogId, userId],
  );
};

/** A few documents the Owner has open, so the lock read is not of an empty table. */
const seedLocks = async (
  db: BenchDb,
  catalogIds: readonly number[],
  ownerId: number,
) => {
  for (const catalogId of catalogIds) await holdLock(db, catalogId, ownerId);
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
  readonly c2: {
    readonly id: number;
    readonly title: string;
    readonly newTitle: string;
    readonly nearTwinId: number;
    readonly publishedTwinId: number;
  };
  readonly c3: {
    /** Row ids, in the order the prompt lists them. */
    readonly targets: readonly number[];
    readonly locked: number;
    readonly missingField: { readonly id: number; readonly field: string };
    readonly alreadyPublished: number;
    /** What this path alone publishes. */
    readonly publishes: readonly number[];
  };
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
  const targets = Array.from({ length: C3_COUNT }, (_, at) => C3_FIRST + at);
  // Spread through the list, so a failure has targets after it to reach.
  const [locked, missing, alreadyPublished] = [
    targets[6]!,
    targets[13]!,
    targets[21]!,
  ];
  return {
    c1: {
      total: list.reduce((sum, { count }) => sum + count, 0),
      groups: list,
    },
    c2: {
      id: FIRST_FIXTURE,
      title: C2_TITLE,
      newTitle: C2_NEW_TITLE,
      nearTwinId: FIRST_FIXTURE + 1,
      publishedTwinId: FIRST_FIXTURE + 2,
    },
    c3: {
      targets,
      locked,
      missingField: { id: missing, field: C3_MISSING_FIELD },
      alreadyPublished,
      publishes: targets.filter(
        (id) => id !== locked && id !== missing && id !== alreadyPublished,
      ),
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
  const oracle = oracleOf(specs);
  // A draft may have no title. Publishing asks for one, so this one cannot publish.
  const { id, field } = oracle.c3.missingField;
  await db.query(`UPDATE catalogs SET ${field} = NULL WHERE id = $1`, [id]);
  await db.query(
    `UPDATE _catalogs_v SET version_${field} = NULL WHERE parent_id = $1`,
    [id],
  );
  return oracle;
};

/**
 * The community side of the target, for the slices that read it. Nothing in S3 reads
 * these tables, so their latency is not measured yet: the rows are here so the first
 * reader meets the target scale. Row-level triggers stay on, as in Production.
 */
/** A case's kind and state, a pure function of its index, in the seed and the oracle. */
const reportKindOf = (index: number) =>
  index % 5 === 0
    ? "rights_notice"
    : index % 5 === 1
      ? "quick_comment"
      : "standard";
const reportStatusOf = (index: number) =>
  index % 3 === 0
    ? "resolved"
    : index % 7 === 0
      ? "appealed"
      : index % 11 === 0
        ? "reviewing"
        : "open";
const reportAtOf = (index: number) =>
  new Date(Date.parse(AT) - index * 3_600_000).toISOString();

/**
 * The account U1 asks about, past the scale's own rows, holding what a count must leave
 * out: a self-only work with a comment and a report on it, and a deleted work. The
 * handle follows public_users_handle_normalized, which holds no underscore.
 */
const U1 = {
  id: `user-${"1".repeat(32)}`,
  handle: "lishu-test",
  createdAt: "2025-03-04T05:06:07.000Z",
  publicWorks: [`work-${"a".repeat(32)}`, `work-${"b".repeat(32)}`],
  selfWork: `work-${"c".repeat(32)}`,
  deletedWork: `work-${"d".repeat(32)}`,
  canary: "u1selfonlycanary",
};

/**
 * M3's account: 40 comments of which 12 hold the phrase inside the range and 3 hold it
 * a few minutes before it starts, and another account of the same display name holding
 * it too. All on a work of neither, so hiding them moves nothing else U1 or M1 reads.
 */
const M3 = {
  id: `user-${"2".repeat(32)}`,
  handle: "lishu-ads",
  twin: `user-${"3".repeat(32)}`,
  twinHandle: "lishu-ads-twin",
  name: "李书",
  work: `work-${"e".repeat(32)}`,
  phrase: "加微信",
};
const M3_INSIDE = 12;
const M3_JUST_OUTSIDE = 3;
const M3_COMMENTS = 40;
const m3CommentId = (name: string) =>
  `comment-${createHash("md5").update(`m3-${name}`).digest("hex")}`;

/** U3's fifteen handles: the 7th and 14th already suspended, the 15th no account's. */
const U3_HANDLES = 15;
const u3Handle = (index: number) => `batch-ads-${index}`;
const u3Id = (index: number) =>
  `user-${createHash("md5").update(`u3-${index}`).digest("hex")}`;
const u3IsSuspended = (index: number) => index % 7 === 0;

export interface CommunityOracle {
  readonly m3: {
    readonly handle: string;
    readonly id: string;
    readonly phrase: string;
    /** What the path must hide, and nothing else moves. */
    readonly matching: readonly string[];
    readonly untouched: readonly string[];
  };
  readonly u3: {
    readonly handles: readonly string[];
    readonly missingHandle: string;
    readonly changed: readonly string[];
    readonly skipped: readonly string[];
  };
  readonly m1: {
    readonly total: number;
    readonly oldestAt: string;
    readonly groups: readonly {
      readonly value: string;
      readonly count: number;
      readonly oldestAt: string;
    }[];
  };
  readonly u1: {
    readonly id: string;
    readonly handle: string;
    readonly createdAt: string;
    readonly status: string;
    readonly submittedWorks: number;
    readonly commentCount: number;
    readonly reportCount: number;
    readonly canary: string;
  };
}

const seedU1 = async (db: BenchDb) => {
  await db.query(
    `INSERT INTO community.public_users (id, handle, display_name, status, created_at, updated_at)
     VALUES ($1, $2, '李书', 'active', $3::timestamptz, $3::timestamptz)`,
    [U1.id, U1.handle, U1.createdAt],
  );
  for (const id of U1.publicWorks)
    await db.query(
      `INSERT INTO community.works (id, author_id, title, text, first_published_at, updated_at, visibility, operator_state)
       VALUES ($1, $2, '合成作品', '合成作品正文', $3::timestamptz, $3::timestamptz, 'public', 'visible')`,
      [id, U1.id, AT],
    );
  await db.query(
    `INSERT INTO community.works (id, author_id, title, text, visibility, created_via)
     VALUES ($1, $2, $3, $3, 'self', 'publishing')`,
    [U1.selfWork, U1.id, U1.canary],
  );
  await db.query(
    `INSERT INTO community.works (id, author_id, title, text, visibility, deleted_at, created_via)
     VALUES ($1, $2, '', '', 'self', $3::timestamptz, 'publishing')`,
    [U1.deletedWork, U1.id, AT],
  );
  const comment = (name: string) =>
    `comment-${createHash("md5").update(`u1-${name}`).digest("hex")}`;
  for (const [name, work] of [
    ["a", U1.publicWorks[0]],
    ["b", U1.publicWorks[0]],
    ["c", U1.publicWorks[1]],
    ["self", U1.selfWork],
  ] as const)
    await db.query(
      `INSERT INTO community.catalog_comments (id, catalog_id, author_id, text, moderation, target_type, created_at)
       VALUES ($1, $2, $3, $4, 'visible', 'work', $5::timestamptz)`,
      [
        comment(name),
        work,
        U1.id,
        name === "self" ? U1.canary : "合成评论",
        AT,
      ],
    );
  for (const [name, root] of [
    ["reply-a", "a"],
    ["reply-self", "self"],
  ] as const)
    await db.query(
      `INSERT INTO community.catalog_comment_replies (id, root_comment_id, author_id, text, moderation, created_at)
       VALUES ($1, $2, $3, $4, 'visible', $5::timestamptz)`,
      [
        comment(name),
        comment(root),
        U1.id,
        name === "reply-self" ? U1.canary : "合成回复",
        AT,
      ],
    );
  const reporter = `user-${createHash("md5").update("bench-user-1").digest("hex")}`;
  for (const [name, work, status] of [
    ["a", U1.publicWorks[0], "open"],
    ["b", U1.publicWorks[1], "resolved"],
    ["self", U1.selfWork, "open"],
  ] as const)
    await db.query(
      `INSERT INTO community.report_cases (id, reporter_id, target_type, target_id, canonical_path, affected_user_id, snapshot, kind, reason, status, created_at, updated_at)
       VALUES ($1, $2, 'work', $3, '/', $4, $5::jsonb, 'standard', 'other', $6, $7::timestamptz, $7::timestamptz)`,
      [
        `report-${createHash("md5").update(`u1-${name}`).digest("hex")}`,
        reporter,
        work,
        U1.id,
        JSON.stringify(name === "self" ? { title: U1.canary } : {}),
        status,
        AT,
      ],
    );
};

const seedM3 = async (db: BenchDb) => {
  await db.query(
    `INSERT INTO community.public_users (id, handle, display_name, status, created_at, updated_at)
     VALUES ($1, $2, $5, 'active', $6::timestamptz, $6::timestamptz),
            ($3, $4, $5, 'active', $6::timestamptz, $6::timestamptz)`,
    [M3.id, M3.handle, M3.twin, M3.twinHandle, M3.name, AT],
  );
  await db.query(
    `INSERT INTO community.works (id, author_id, title, text, first_published_at, updated_at, visibility, operator_state)
     VALUES ($1, $2, '合成作品', '合成作品正文', $3::timestamptz, $3::timestamptz, 'public', 'visible')`,
    [M3.work, M3.twin, AT],
  );
  // Inside lies well within the days the range names, so a run that crosses a Shanghai
  // midnight still reads the same set; just outside stays outside whichever day it is.
  const { start, requestedEnd } = resolveAnalyticsRange(
    { range: "last_7_days" } as never,
    new Date(),
  );
  const insideAt = (index: number) =>
    new Date(
      requestedEnd.getTime() - (index % 6) * 86_400_000 - 86_400_000 / 2,
    ).toISOString();
  const outsideAt = (index: number) =>
    new Date(start.getTime() - (index + 1) * 60_000).toISOString();
  const insert = (id: string, author: string, text: string, at: string) =>
    db.query(
      `INSERT INTO community.catalog_comments (id, catalog_id, author_id, text, moderation, target_type, created_at)
       VALUES ($1, $2, $3, $4, 'visible', 'work', $5::timestamptz)`,
      [id, M3.work, author, text, at],
    );
  for (let index = 0; index < M3_COMMENTS; index += 1) {
    const matches = index < M3_INSIDE + M3_JUST_OUTSIDE;
    const inside =
      index < M3_INSIDE || index >= M3_INSIDE + M3_JUST_OUTSIDE + 5;
    await insert(
      m3CommentId(String(index)),
      M3.id,
      matches ? `合成评论，${M3.phrase}${index}` : `合成评论${index}`,
      inside ? insideAt(index) : outsideAt(index),
    );
  }
  for (let index = 0; index < 3; index += 1)
    await insert(
      m3CommentId(`twin-${index}`),
      M3.twin,
      `合成评论，${M3.phrase}${index}`,
      insideAt(index),
    );
};

const seedU3 = async (db: BenchDb) => {
  for (let index = 1; index < U3_HANDLES; index += 1)
    await db.query(
      `INSERT INTO community.public_users (id, handle, display_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
      [
        u3Id(index),
        u3Handle(index),
        `合成广告账号${index}`,
        u3IsSuspended(index) ? "suspended" : "active",
        AT,
      ],
    );
};

/** Every number comes from the functions the rows came from, never through a tool. */
const communityOracleOf = (reports: number): CommunityOracle => {
  const byKind = new Map<string, { count: number; oldestAt: string }>();
  const add = (kind: string, at: string) => {
    const known = byKind.get(kind);
    byKind.set(kind, {
      count: (known?.count ?? 0) + 1,
      oldestAt:
        known === undefined || at < known.oldestAt ? at : known.oldestAt,
    });
  };
  for (let index = 1; index <= reports; index += 1)
    if (reportStatusOf(index) !== "resolved")
      add(reportKindOf(index), reportAtOf(index));
  // The two open cases of U1's three, one of them owner-only: it still waits on someone.
  add("standard", AT);
  add("standard", AT);
  const groups = [...byKind.entries()].map(([value, group]) => ({
    value,
    ...group,
  }));
  const u3Accounts = Array.from({ length: U3_HANDLES - 1 }, (_, at) => at + 1);
  return {
    m3: {
      handle: M3.handle,
      id: M3.id,
      phrase: M3.phrase,
      matching: Array.from({ length: M3_INSIDE }, (_, at) =>
        m3CommentId(String(at)),
      ),
      untouched: [
        ...Array.from({ length: M3_COMMENTS - M3_INSIDE }, (_, at) =>
          m3CommentId(String(M3_INSIDE + at)),
        ),
        ...[0, 1, 2].map((at) => m3CommentId(`twin-${at}`)),
      ],
    },
    u3: {
      handles: Array.from({ length: U3_HANDLES }, (_, at) => u3Handle(at + 1)),
      missingHandle: u3Handle(U3_HANDLES),
      changed: u3Accounts.filter((index) => !u3IsSuspended(index)).map(u3Id),
      skipped: u3Accounts.filter(u3IsSuspended).map(u3Id),
    },
    m1: {
      total: groups.reduce((sum, { count }) => sum + count, 0),
      oldestAt: groups
        .map(({ oldestAt }) => oldestAt)
        .sort((a, b) => a.localeCompare(b))[0]!,
      groups,
    },
    u1: {
      id: U1.id,
      handle: U1.handle,
      createdAt: U1.createdAt,
      status: "active",
      submittedWorks: U1.publicWorks.length,
      // Roots a, b and c and the reply under a; those under the self-only work are out.
      commentCount: 4,
      // The case on the self-only work names its author only to the Owner.
      reportCount: 2,
      canary: U1.canary,
    },
  };
};

/**
 * Items, each on the work of the same number when that has a public revision, and the
 * jobs a settlement reads past. One in twenty stopped, so the partial index of unfinished
 * jobs is not the whole table. None has a public asset, so none counts as newer than an
 * operation, and no reference path waits on them.
 */
const seedMediaWork = async (db: BenchDb) => {
  const { users, mediaItems, publishingJobs } = BENCH_SCALE;
  await db.query(
    `INSERT INTO community.media_items (id, owner_id, kind, quality_mode, source, state, presentation, ready_at)
     SELECT 'media-item-' || md5('bench-item-' || i),
       'user-' || md5('bench-user-' || (1 + i % $2::int)),
       'static', 'standard', 'upload', 'ready', '{"width":512,"height":384}', $3::timestamptz
     FROM generate_series(1, $1::int) i`,
    [mediaItems, users, AT],
  );
  await db.query(
    `INSERT INTO community.work_revision_items (revision_id, position, item_id, edit)
     SELECT w.public_revision_id, 1, 'media-item-' || md5('bench-item-' || i), '{"rotation":0,"crop":null}'
     FROM generate_series(1, $1::int) i
     JOIN community.works w ON w.id = 'work-' || md5('bench-work-' || i)
     WHERE w.public_revision_id IS NOT NULL`,
    [mediaItems],
  );
  await db.query(
    `INSERT INTO community.publishing_jobs (id, kind, subject_id, state, run_after, created_at, updated_at, finished_at)
     SELECT 'publishing-job-' || md5('bench-job-' || i),
       CASE WHEN i % 2 = 0 THEN 'publish_media' ELSE 'withdraw_media' END,
       'media-item-' || md5('bench-item-' || (1 + i % $2::int)),
       CASE WHEN i % 20 = 0 THEN 'failed' ELSE 'succeeded' END,
       $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz
     FROM generate_series(1, $1::int) i`,
    [publishingJobs, mediaItems, AT],
  );
};

export const seedCommunity = async (db: BenchDb): Promise<CommunityOracle> => {
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
  // Each case by kind and state as reportKindOf and reportStatusOf say.
  await db.query(
    `INSERT INTO community.report_cases (id, reporter_id, target_type, target_id, canonical_path, affected_user_id, snapshot, kind, reason, claimant, status, created_at, updated_at)
     SELECT 'report-' || md5('bench-report-' || i),
       'user-' || md5('bench-user-' || (1 + i % $2::int)),
       CASE WHEN i % 5 = 1 THEN 'comment' ELSE 'work' END,
       CASE WHEN i % 5 = 1 THEN 'comment-' || md5('bench-comment-' || (1 + i % $5::int))
         ELSE 'work-' || md5('bench-work-' || (1 + i % $3::int)) END,
       '/works/work-' || md5('bench-work-' || (1 + i % $3::int)),
       'user-' || md5('bench-user-' || (2 + i % ($2::int - 1))),
       '{}'::jsonb,
       CASE WHEN i % 5 = 0 THEN 'rights_notice' WHEN i % 5 = 1 THEN 'quick_comment' ELSE 'standard' END,
       CASE WHEN i % 5 = 0 THEN 'copyright' WHEN i % 5 = 1 THEN NULL ELSE 'spam_scam' END,
       CASE WHEN i % 5 = 0 THEN '{"name":"合成权利人","contact":"contact-canary","rightsBasis":"合成依据"}'::jsonb END,
       CASE WHEN i % 3 = 0 THEN 'resolved' WHEN i % 7 = 0 THEN 'appealed' WHEN i % 11 = 0 THEN 'reviewing' ELSE 'open' END,
       $4::timestamptz - i * interval '1 hour', $4::timestamptz - i * interval '1 hour'
     FROM generate_series(1, $1::int) i`,
    [reports, users, works, AT, comments],
  );
  await seedMediaWork(db);
  await seedU1(db);
  await seedM3(db);
  await seedU3(db);
  return communityOracleOf(reports);
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
export const finishSeed = async (db: BenchDb) => {
  // Not in parallel: a container's 64 MiB of /dev/shm cannot hold it at a million rows.
  await db.query("VACUUM (ANALYZE, PARALLEL 0)");
  const counts: Record<string, number> = {};
  for (const [table, name] of [...CMS_TABLES, ...COMMUNITY_TABLES]) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[name] = Number(rows[0]!.n);
  }
  return counts;
};
