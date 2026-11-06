import {
  ADMIN_READ_PAGE_SIZE_MAX,
  adminApprovalListInputSchema,
  adminArticleListInputSchema,
  adminCatalogListInputSchema,
  adminCollectionListInputSchema,
  adminMediaListInputSchema,
  adminReadCountDataSchema,
  adminReadRowsDataSchema,
  adminReceiptListInputSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminListFilterOf,
  AdminMcpEnvelope,
} from "@moya/contracts/internal/admin-mcp";
import { EDITORIAL_STATEFUL_FIELDS } from "@moya/contracts/internal/editorial";
import type { EditorialStatefulField } from "@moya/contracts/internal/editorial";
import { sql } from "@payloadcms/db-postgres";
import type { PayloadRequest, Where } from "payload";
import type { z } from "zod";

import { actsAsOwner } from "../../editorial/access";
import { withinBudget } from "../budget";
import {
  offsetCursor,
  offsetOfCursor,
  rowCursor,
  rowIdOfCursor,
} from "../cursor";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import {
  findDocuments,
  CMS_FAMILIES,
  liveStatusesOf,
  stateOf,
  statefulValue,
  titleOf,
} from "../records";
import type { CmsFamily, RecordDocument } from "../records";
import { codePointLength, textHash } from "../text-window";
import type { AdminOpContext } from "./define";

/**
 * The CMS queues and pages admin_read serves (admin-mcp-completion-v1 section 6).
 * Rows are compact, a `fields` projection comes from a whitelist, and long text only
 * ever leaves as state, length and hash. view=count answers in SQL with the same
 * filter, so counting never pages rows through the model: each filter key is written
 * once, in Payload's terms and in SQL side by side, and a test holds the two equal. It
 * runs under a search branch's budget, and a count past its time answers
 * READ_TIMED_OUT, never a number.
 */

type SqlFragment = ReturnType<typeof sql>;

interface Projection {
  readonly select: Readonly<Record<string, unknown>>;
  readonly value: (doc: RecordDocument) => unknown;
}

interface CountGroup {
  /** Column expressions from this file only, never from a caller. */
  readonly value: string;
  readonly state?: string;
}

/** One filter key: the Payload where a row read uses, and the same rule in SQL. */
interface FilterKey<Value> {
  readonly where: (value: Value) => readonly Where[];
  /** Column names from this file only, never from a caller. */
  readonly sql: (value: Value) => readonly SqlFragment[];
}

/** A rule for every key a source's filter takes: one the schema adds fails typecheck. */
type FilterTable<Filter> = {
  readonly [Key in keyof Filter]-?: FilterKey<NonNullable<Filter[Key]>>;
};

export interface ListSource {
  readonly target: Pick<CmsFamily, "versioned"> & { readonly slug: string };
  readonly family?: CmsFamily;
  readonly input: z.ZodType;
  /** Defaults applied, so the answer can echo what was really asked. */
  readonly resolve: (
    filter: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** The source's filter table; the row read and the count both apply each key. */
  readonly filters: Readonly<
    Record<
      string,
      {
        readonly where: (value: never) => readonly Where[];
        readonly sql: (value: never) => readonly SqlFragment[];
      }
    >
  >;
  readonly compactSelect: Readonly<Record<string, unknown>>;
  readonly compact: (
    doc: RecordDocument,
    liveStatus: unknown,
  ) => Record<string, unknown>;
  readonly fields: Readonly<Record<string, Projection>>;
  readonly count: {
    readonly table: string;
    readonly latestOnly: boolean;
    readonly groups: Readonly<Record<string, CountGroup>>;
  };
}

/** Each key of a filter as the row read asks it. */
const whereOf = (source: ListSource, filter: Record<string, unknown>) =>
  Object.entries(source.filters).flatMap(([key, rule]) =>
    filter[key] === undefined ? [] : rule.where(filter[key] as never),
  );

/** Each key of a filter as a count, and later a selector, asks it in SQL. */
export const conditionsOf = (
  source: ListSource,
  filter: Record<string, unknown>,
): readonly SqlFragment[] =>
  Object.entries(source.filters).flatMap(([key, rule]) =>
    filter[key] === undefined ? [] : rule.sql(filter[key] as never),
  );

const plain = (name: string): Projection => ({
  select: { [name]: true },
  value: (doc) => doc[name] ?? null,
});

const longText = (name: string): Projection => ({
  select: { [name]: true },
  value: (doc) => {
    const text = doc[name];
    return typeof text === "string" && text !== ""
      ? { state: "VALUE", length: codePointLength(text), hash: textHash(text) }
      : { state: "ABSENT" };
  },
});

const statefulShort = (name: string): Projection => ({
  select: { [name]: true },
  value: (doc) => {
    const field = doc[name] as { state?: unknown } | null | undefined;
    const text = statefulValue(field);
    return {
      state: field?.state ?? "ABSENT",
      ...(text ? { value: text } : {}),
    };
  },
});

const statefulLong = (name: string): Projection => ({
  select: { [name]: true },
  value: (doc) => {
    const field = doc[name] as { state?: unknown } | null | undefined;
    const text = statefulValue(field);
    return {
      state: field?.state ?? "ABSENT",
      ...(text === undefined
        ? {}
        : { length: codePointLength(text), hash: textHash(text) }),
    };
  },
});

const countOf = (name: string, key: string): Projection => ({
  select: { [name]: { [key]: true } },
  value: (doc) => (Array.isArray(doc[name]) ? doc[name].length : 0),
});

const snake = (name: string) =>
  name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const STATEFUL: ReadonlySet<string> = new Set(EDITORIAL_STATEFUL_FIELDS);

/**
 * How a row shows each stateful text: a short one as its value, a long one by length
 * and hash. A stateful field the editorial contract adds fails typecheck here until
 * it is placed, so none reaches a row unread.
 */
const STATEFUL_PROJECTIONS = {
  dynasty: statefulShort,
  dateText: statefulShort,
  province: statefulShort,
  prefecture: statefulShort,
  county: statefulShort,
  currentLocation: statefulShort,
  currentCustodian: statefulShort,
  scriptStyle: statefulLong,
  description: statefulLong,
  transcription: statefulLong,
  historicalContext: statefulLong,
  scholarlyResearch: statefulLong,
} satisfies Record<EditorialStatefulField, (name: string) => Projection>;

const statefulFields = Object.fromEntries(
  Object.entries(STATEFUL_PROJECTIONS).map(([name, projection]) => [
    name,
    projection(name),
  ]),
);

/** Whichever version is latest decides, as Payload's draft read does. */
const statusKey: FilterKey<string> = {
  where: (status) =>
    status === "all" ? [] : [{ _status: { equals: status } }],
  sql: (status) =>
    status === "all" ? [] : [sql`version__status::text = ${status}`],
};

/** A plain column, equal in both. */
const equalsKey = (field: string, column: string): FilterKey<string> => ({
  where: (value) => [{ [field]: { equals: value } }],
  sql: (value) => [sql`${sql.raw(column)} = ${value}`],
});

/** A stateful text: only a VALUE equal to it, never an unsupplied one. */
const statefulKey = (field: string): FilterKey<string> => ({
  where: (value) => [
    { [`${field}.state`]: { equals: "VALUE" } },
    { [`${field}.value`]: { equals: value } },
  ],
  sql: (value) => [
    sql.raw(`version_${snake(field)}_state::text = 'VALUE'`),
    sql`${sql.raw(`version_${snake(field)}_value`)} = ${value}`,
  ],
});

const valueGroup = (field: string): CountGroup => ({
  state: `version_${snake(field)}_state::text`,
  value: `CASE WHEN version_${snake(field)}_state = 'VALUE' THEN version_${snake(field)}_value END`,
});

const versionedRow = (
  family: CmsFamily,
  doc: RecordDocument,
  liveStatus: unknown,
) => ({
  id: doc.id,
  ...(titleOf(family, doc) === undefined
    ? {}
    : { title: titleOf(family, doc) }),
  state: stateOf(doc._status, liveStatus),
  updatedAt: doc.updatedAt,
  version: doc.revision,
});

const versionedSelect = (family: CmsFamily) => ({
  [family.titleField]: true,
  [family.identityField]: true,
  _status: true,
  updatedAt: true,
  revision: true,
});

const catalog = CMS_FAMILIES.catalog;
const article = CMS_FAMILIES.article;
const collection = CMS_FAMILIES.collection;

const catalogs: ListSource = {
  target: catalog,
  family: catalog,
  input: adminCatalogListInputSchema,
  // The Matrix's "matching drafts": a live record with a newer draft is a draft here.
  resolve: (filter) => ({ status: "draft", ...filter }),
  filters: {
    status: statusKey,
    missing: {
      where: (fields) =>
        fields.map((field) =>
          STATEFUL.has(field)
            ? { [`${field}.state`]: { in: ["UNSUPPLIED", "CLEAR"] } }
            : { [field]: { exists: false } },
        ),
      sql: (fields) =>
        fields.map((field) =>
          // Names from the contract's enum, so this is no caller text.
          sql.raw(
            STATEFUL.has(field)
              ? `version_${snake(field)}_state::text IN ('UNSUPPLIED', 'CLEAR')`
              : `version_${snake(field)} IS NULL`,
          ),
        ),
    },
    kind: equalsKey("kind", "version_kind::text"),
    dynasty: statefulKey("dynasty"),
    province: statefulKey("province"),
  } satisfies FilterTable<
    AdminListFilterOf<typeof adminCatalogListInputSchema>
  >,
  compactSelect: versionedSelect(catalog),
  compact: (doc, live) => ({
    ...versionedRow(catalog, doc, live),
    catalogId: doc.catalogId,
  }),
  fields: {
    sourceId: plain("sourceId"),
    kind: plain("kind"),
    summary: longText("summary"),
    periodLabel: plain("periodLabel"),
    ...statefulFields,
    ownerNote: longText("ownerNote"),
    mediaCount: countOf("media", "mediaId"),
    aliasCount: countOf("aliases", "alias"),
  },
  count: {
    table: "_catalogs_v",
    latestOnly: true,
    groups: {
      status: { value: "version__status::text" },
      kind: { value: "version_kind::text" },
      dynasty: valueGroup("dynasty"),
      province: valueGroup("province"),
      prefecture: valueGroup("prefecture"),
      county: valueGroup("county"),
      scriptStyle: valueGroup("scriptStyle"),
    },
  },
};

const articles: ListSource = {
  target: article,
  family: article,
  input: adminArticleListInputSchema,
  resolve: (filter) => ({ status: "all", ...filter }),
  filters: {
    status: statusKey,
    presentation: equalsKey("presentation", "version_presentation::text"),
  } satisfies FilterTable<
    AdminListFilterOf<typeof adminArticleListInputSchema>
  >,
  compactSelect: versionedSelect(article),
  compact: (doc, live) => ({
    ...versionedRow(article, doc, live),
    articleId: doc.articleId,
  }),
  fields: {
    presentation: plain("presentation"),
    subtitle: plain("subtitle"),
    summary: longText("summary"),
    section: plain("section"),
    issue: plain("issue"),
    byline: plain("byline"),
    intro: longText("intro"),
    firstPublishedAt: plain("firstPublishedAt"),
    publishedAt: plain("publishedAt"),
    sectionCount: countOf("sections", "heading"),
  },
  count: {
    table: "_articles_v",
    latestOnly: true,
    groups: {
      status: { value: "version__status::text" },
      presentation: { value: "version_presentation::text" },
      section: { value: "version_section" },
    },
  },
};

const collections: ListSource = {
  target: collection,
  family: collection,
  input: adminCollectionListInputSchema,
  resolve: (filter) => ({ status: "all", ...filter }),
  filters: {
    status: statusKey,
    category: equalsKey("category", "version_category"),
  } satisfies FilterTable<
    AdminListFilterOf<typeof adminCollectionListInputSchema>
  >,
  compactSelect: versionedSelect(collection),
  compact: (doc, live) => ({
    ...versionedRow(collection, doc, live),
    collectionId: doc.collectionId,
  }),
  fields: {
    subtitle: plain("subtitle"),
    summary: longText("summary"),
    category: plain("category"),
    issue: plain("issue"),
    publishedAt: plain("publishedAt"),
    memberCount: countOf("members", "kind"),
  },
  count: {
    table: "_article_collections_v",
    latestOnly: true,
    groups: {
      status: { value: "version__status::text" },
      category: { value: "version_category" },
    },
  },
};

const media: ListSource = {
  target: CMS_FAMILIES.media,
  family: CMS_FAMILIES.media,
  input: adminMediaListInputSchema,
  resolve: (filter) => filter,
  filters: {
    catalogId: equalsKey("catalogId", "catalog_id"),
    origin: equalsKey("origin", "origin::text"),
  } satisfies FilterTable<AdminListFilterOf<typeof adminMediaListInputSchema>>,
  compactSelect: {
    mediaId: true,
    catalogId: true,
    alt: true,
    updatedAt: true,
  },
  compact: (doc) => ({
    id: doc.id,
    mediaId: doc.mediaId,
    catalogId: doc.catalogId,
    title: doc.alt,
    state: "registered",
    updatedAt: doc.updatedAt,
  }),
  fields: {
    origin: plain("origin"),
    mimeType: plain("mimeType"),
    filesize: plain("filesize"),
    width: plain("width"),
    height: plain("height"),
    sha256: plain("sha256"),
    orderConfidence: plain("orderConfidence"),
    rights: longText("rights"),
  },
  count: {
    table: "media",
    latestOnly: false,
    groups: {
      origin: { value: "origin::text" },
      mimeType: { value: "mime_type" },
      catalogId: { value: "catalog_id" },
      orderConfidence: { value: "order_confidence::text" },
    },
  },
};

const approvals = (slug: string, table: string): ListSource => ({
  target: { slug, versioned: false },
  input: adminApprovalListInputSchema,
  resolve: (filter) => filter,
  filters: {
    status: equalsKey("status", "status::text"),
  } satisfies FilterTable<
    AdminListFilterOf<typeof adminApprovalListInputSchema>
  >,
  compactSelect: { label: true, status: true, updatedAt: true },
  compact: (doc) => ({
    id: doc.id,
    title: doc.label,
    state: doc.status,
    updatedAt: doc.updatedAt,
  }),
  fields: {
    approvedAt: plain("approvedAt"),
    approvedBy: plain("approvedBy"),
    automationUser: plain("automationUser"),
    itemCount: countOf("items", "revision"),
  },
  count: {
    table,
    latestOnly: false,
    groups: { status: { value: "status::text" } },
  },
});

const receipts: ListSource = {
  target: { slug: "editorial-receipts", versioned: false },
  input: adminReceiptListInputSchema,
  resolve: (filter) => filter,
  filters: {
    status: equalsKey("status", "status::text"),
    operation: equalsKey("operation", "operation::text"),
  } satisfies FilterTable<
    AdminListFilterOf<typeof adminReceiptListInputSchema>
  >,
  compactSelect: { operation: true, status: true, updatedAt: true },
  compact: (doc) => ({
    id: doc.id,
    operation: doc.operation,
    state: doc.status,
    updatedAt: doc.updatedAt,
  }),
  fields: {
    catalog: plain("catalog"),
    article: plain("article"),
    articleCollection: plain("articleCollection"),
    revision: plain("revision"),
    fingerprint: plain("fingerprint"),
    errorCode: plain("errorCode"),
    actor: plain("actor"),
  },
  count: {
    table: "editorial_receipts",
    latestOnly: false,
    groups: {
      status: { value: "status::text" },
      operation: { value: "operation::text" },
    },
  },
};

export const LIST_SOURCES = {
  catalogs,
  articles,
  collections,
  media,
  approvals: approvals("editorial-approvals", "editorial_approvals"),
  article_approvals: approvals(
    "editorial-article-approvals",
    "editorial_article_approvals",
  ),
  receipts,
} as const;

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_GROUP_PAGE = 200;

const invalidCursorEnvelope = () =>
  inputInvalidEnvelope([{ path: ["cursor"], code: "invalid_cursor" }]);

const unknownFieldsEnvelope = (source: ListSource) =>
  inputInvalidEnvelope([
    {
      path: ["fields"],
      code: "unknown_field",
      allowedKeys: Object.keys(source.fields),
    },
  ]);

/**
 * SQL reads under no Payload access rule, so it answers only a caller whose rule is
 * "everything": the only kind on this path. A scoped account would need that scope.
 */
const countEnvelope = async (
  req: PayloadRequest,
  source: ListSource,
  filter: Record<string, unknown>,
  read: NonNullable<AdminOpContext["read"]>,
): Promise<AdminMcpEnvelope> => {
  if (!actsAsOwner(req))
    return inputInvalidEnvelope([{ path: ["view"], code: "not_for_this_key" }]);
  const group =
    read.groupBy !== undefined &&
    Object.hasOwn(source.count.groups, read.groupBy)
      ? source.count.groups[read.groupBy]
      : undefined;
  if (read.groupBy !== undefined && group === undefined)
    return inputInvalidEnvelope([
      {
        path: ["groupBy"],
        code: "unknown_group",
        allowedKeys: Object.keys(source.count.groups),
      },
    ]);
  const offset = read.cursor === undefined ? 0 : offsetOfCursor(read.cursor);
  if (offset === undefined) return invalidCursorEnvelope();
  const conditions = [
    ...(source.count.latestOnly ? [sql`latest = true`] : []),
    ...conditionsOf(source, filter),
  ];
  const from = sql.raw(`"${source.count.table}"`);
  const where =
    conditions.length === 0
      ? sql``
      : sql`WHERE ${sql.join(conditions, sql` AND `)}`;
  const limit = read.pageSize ?? DEFAULT_GROUP_PAGE;
  const counted = await withinBudget(req, async (_branch, db) => {
    const totalOf = async () =>
      Number(
        (
          await db.execute(
            sql`SELECT count(*)::int AS total FROM ${from} ${where}`,
          )
        ).rows[0]!.total,
      );
    if (group === undefined) return { total: await totalOf(), rows: [] };
    const { rows } = await db.execute(sql`
      SELECT ${sql.raw(group.state ?? "NULL")} AS state,
        ${sql.raw(group.value)} AS value,
        count(*)::int AS count,
        sum(count(*)) OVER ()::int AS total
      FROM ${from} ${where}
      GROUP BY 1, 2
      ORDER BY count DESC, value ASC NULLS LAST, state ASC NULLS LAST
      LIMIT ${limit + 1} OFFSET ${offset}`);
    return {
      rows,
      total:
        rows.length > 0
          ? Number(rows[0]!.total)
          : offset === 0
            ? 0
            : await totalOf(),
    };
  });
  if (counted.status !== "ok") {
    if (counted.status === "timed_out") return failedEnvelope("READ_TIMED_OUT");
    throw new Error("ADMIN_READ_COUNT_FAILED");
  }
  const { rows, total } = counted.value;
  if (group === undefined)
    return okEnvelope(adminReadCountDataSchema.parse({ total, filter }), [
      "/data/filter",
    ]);
  const page = rows.slice(0, limit);
  const envelope = okEnvelope(
    adminReadCountDataSchema.parse({
      total,
      filter,
      groupBy: read.groupBy,
      groups: page.map(({ state, value, count }) => ({
        value: value === null ? null : String(value),
        ...(state === null ? {} : { state: String(state) }),
        count: Number(count),
      })),
    }),
    ["/data/groups", "/data/filter"],
  );
  return rows.length > limit
    ? {
        ...envelope,
        next: {
          tool: "admin_read",
          args: { ...read, cursor: offsetCursor(offset + limit) },
        },
      }
    : envelope;
};

const rowsEnvelope = async (
  req: PayloadRequest,
  source: ListSource,
  filter: Record<string, unknown>,
  read: NonNullable<AdminOpContext["read"]>,
): Promise<AdminMcpEnvelope> => {
  const below =
    read.cursor === undefined ? undefined : rowIdOfCursor(read.cursor);
  if (read.cursor !== undefined && below === undefined)
    return invalidCursorEnvelope();
  const asked =
    read.view === "full" ? Object.keys(source.fields) : (read.fields ?? []);
  const projections = asked.map(
    (name) =>
      [
        name,
        Object.hasOwn(source.fields, name) ? source.fields[name] : undefined,
      ] as const,
  );
  if (projections.some(([, projection]) => projection === undefined))
    return unknownFieldsEnvelope(source);
  const pageSize = Math.min(
    read.pageSize ?? DEFAULT_PAGE_SIZE,
    ADMIN_READ_PAGE_SIZE_MAX,
  );
  const where = [
    ...whereOf(source, filter),
    ...(below === undefined ? [] : [{ id: { less_than: below } }]),
  ];
  // Keyset on the record's own id: every row exactly once, however rows change.
  const docs = await findDocuments(req, source.target, {
    where: { and: [...where] },
    limit: pageSize + 1,
    sort: "-id",
    select: Object.assign(
      {},
      source.compactSelect,
      ...projections.map(([, projection]) => projection!.select),
    ) as Record<string, unknown>,
  });
  const page = docs.slice(0, pageSize);
  const live =
    source.family === undefined
      ? new Map<unknown, unknown>()
      : await liveStatusesOf(
          req,
          source.family,
          page.map(({ id }) => id),
        );
  const rows = page.map((doc) => ({
    ...source.compact(doc, live.get(doc.id)),
    ...Object.fromEntries(
      projections.map(([name, projection]) => [name, projection!.value(doc)]),
    ),
  }));
  const nextCursor =
    docs.length > pageSize ? rowCursor(Number(page.at(-1)!.id)) : undefined;
  // `next` is the one way on: a cut page keeps fewer rows than this page read.
  const envelope = okEnvelope(adminReadRowsDataSchema.parse({ rows, filter }), [
    "/data/rows",
    "/data/filter",
  ]);
  return nextCursor === undefined
    ? envelope
    : {
        ...envelope,
        next: { tool: "admin_read", args: { ...read, cursor: nextCursor } },
      };
};

/** The body of one `list.*` op. */
export const runListSource =
  (source: ListSource) =>
  async (input: unknown, { req, read }: AdminOpContext) => {
    const { filter } = input as { filter?: Record<string, unknown> };
    const resolved = source.resolve(filter ?? {});
    const args = read ?? {};
    if (args.view !== "count" && args.groupBy !== undefined)
      return inputInvalidEnvelope([
        { path: ["groupBy"], code: "needs_view_count" },
      ]);
    return args.view === "count"
      ? countEnvelope(req, source, resolved, args)
      : rowsEnvelope(req, source, resolved, args);
  };
