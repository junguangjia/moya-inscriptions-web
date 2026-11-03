import { ADMIN_CMS_RECORD_TYPES } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminCmsRecordType,
  AdminFindData,
  AdminFindInput,
  AdminFindItem,
  AdminMatchKind,
  AdminMcpEnvelope,
  AdminRecordType,
} from "@moya/contracts/internal/admin-mcp";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { createLocalReq, type PayloadRequest, type Where } from "payload";

import { isMissingRecord } from "../editorial/transaction";
import { withIdentityAccess } from "../editorial/state";
import { actionsFor, candidateActions } from "./actions-for";
import type { ActionScope } from "./actions-for";
import { okEnvelope } from "./envelope";
import { classifyQuery } from "./locate-reference";
import type { ClassifiedQuery, LocateReference } from "./locate-reference";
import {
  adminPathOf,
  CMS_FAMILIES,
  findDocuments,
  liveStatusesOf,
  lockOf,
  locksOf,
  stateOf,
  titleOf,
} from "./records";
import type { CmsFamily, RecordDocument } from "./records";
import { normalizeSearchQuery, snippetAround } from "./text-window";

/**
 * One call resolves a human reference to a stable ref and says whether it is unique
 * (admin-mcp-completion-v1 section 6). Only an identity field can make a hit unique:
 * text search merges near-twin records, and many stele works share a name.
 */

type SourceStatus = "ok" | "timed_out" | "failed" | "not_available";
type Sources = Record<string, SourceStatus>;

interface Hit {
  readonly family: CmsFamily;
  readonly doc: RecordDocument;
  readonly field: string;
  readonly kind: AdminMatchKind;
  readonly offset?: number;
  readonly snippet?: string;
}

const COMMUNITY_SOURCE: Readonly<Record<string, string>> = {
  user: "users",
  work: "works",
  comment: "comments",
  thread: "threads",
  report: "reports",
  feedback: "feedback",
  publishing_job: "publishing_jobs",
  work_revision: "work_revisions",
  media_item: "media_items",
  invitation: "invitations",
  article: "article_documents",
};

/** What a text search covers on the Backend once the community slice ships. */
const COMMUNITY_SEARCH_SOURCES = [
  "users",
  "works",
  "comments",
  "threads",
  "reports",
] as const;

const SOURCE_OF_FAMILY: Readonly<Record<AdminCmsRecordType, string>> = {
  catalog: "catalogs",
  article: "articles",
  collection: "collections",
  media: "media",
};

const isCmsType = (type: AdminRecordType): type is AdminCmsRecordType =>
  (ADMIN_CMS_RECORD_TYPES as readonly string[]).includes(type);

const familiesFor = (
  type: AdminRecordType | undefined,
): readonly CmsFamily[] =>
  type === undefined
    ? ADMIN_CMS_RECORD_TYPES.map((name) => CMS_FAMILIES[name])
    : isCmsType(type)
      ? [CMS_FAMILIES[type]]
      : [];

/** An id the integer column cannot hold names no record: it is a miss, not a failure. */
const missOnImpossible = async (
  read: () => Promise<readonly RecordDocument[]>,
): Promise<readonly RecordDocument[]> => {
  try {
    return await read();
  } catch (error) {
    if (isMissingRecord(error)) return [];
    throw error;
  }
};

const lookup = (
  req: PayloadRequest,
  family: CmsFamily,
  where: Where,
  limit = 2,
) =>
  missOnImpossible(() =>
    findDocuments(req, family, {
      where,
      limit,
      select: family.findSelect,
    }),
  );

const identityHits = (
  family: CmsFamily,
  field: string,
  docs: readonly RecordDocument[],
): readonly Hit[] =>
  docs.map((doc) => ({ family, doc, field, kind: "identity" }));

/**
 * A catalogId or a sourceId, which the unique identity claims keep apart, and last a
 * sourceId bound only in a record's provenance list.
 */
const catalogByIdentity = async (
  req: PayloadRequest,
  value: string,
): Promise<readonly Hit[]> => {
  const family = CMS_FAMILIES.catalog;
  const direct = await lookup(req, family, {
    or: [{ catalogId: { equals: value } }, { sourceId: { equals: value } }],
  });
  if (direct.length > 0)
    return direct.map((doc) => ({
      family,
      doc,
      field: doc.catalogId === value ? "catalogId" : "sourceId",
      kind: "identity",
    }));
  const claim = await withIdentityAccess(req, () =>
    req.payload.find({
      collection: "editorial-identities",
      where: { identityValue: { equals: value } },
      limit: 1,
      depth: 0,
      pagination: false,
      overrideAccess: false,
      req,
      user: req.user,
    }),
  );
  const catalogId = claim.docs[0]?.catalogId;
  if (catalogId === undefined) return [];
  return identityHits(
    family,
    "provenance.sourceId",
    await lookup(req, family, { catalogId: { equals: catalogId } }),
  );
};

const mediaByIdentity = async (
  req: PayloadRequest,
  values: readonly string[],
): Promise<readonly Hit[]> =>
  identityHits(
    CMS_FAMILIES.media,
    "mediaId",
    await lookup(req, CMS_FAMILIES.media, {
      mediaId: { in: values as string[] },
    }),
  );

const wants = (
  families: readonly CmsFamily[],
  type: AdminCmsRecordType,
): boolean => families.some((family) => family.type === type);

const hitsOf = async (
  req: PayloadRequest,
  reference: LocateReference,
  families: readonly CmsFamily[],
): Promise<readonly Hit[]> => {
  const catalog = wants(families, "catalog");
  const media = wants(families, "media");
  switch (reference.kind) {
    case "row": {
      const family = CMS_FAMILIES[reference.type];
      return wants(families, reference.type)
        ? identityHits(
            family,
            "id",
            await lookup(req, family, { id: { equals: reference.id } }),
          )
        : [];
    }
    case "identity": {
      const family = CMS_FAMILIES[reference.type];
      if (!wants(families, reference.type)) return [];
      if (reference.type === "catalog")
        return catalogByIdentity(req, reference.value);
      return identityHits(
        family,
        reference.field,
        await lookup(req, family, {
          [reference.field]: { equals: reference.value },
        }),
      );
    }
    case "token":
      return [
        ...(catalog ? await catalogByIdentity(req, reference.value) : []),
        ...(media ? await mediaByIdentity(req, [reference.value]) : []),
      ];
    case "digits": {
      const hits = catalog
        ? [...(await catalogByIdentity(req, reference.value))]
        : [];
      for (const family of families)
        hits.push(
          ...identityHits(
            family,
            "id",
            await lookup(req, family, { id: { equals: reference.id } }),
          ),
        );
      return hits;
    }
    case "sha256":
      return media
        ? identityHits(
            CMS_FAMILIES.media,
            "sha256",
            await lookup(
              req,
              CMS_FAMILIES.media,
              { sha256: { equals: reference.value } },
              25,
            ),
          )
        : [];
    case "uuid":
      return media
        ? mediaByIdentity(req, [reference.value, `media-${reference.value}`])
        : [];
    default:
      return [];
  }
};

const sameRecord = (left: Hit, right: Hit) =>
  left.family === right.family && left.doc.id === right.doc.id;

const distinct = (hits: readonly Hit[]): readonly Hit[] =>
  hits.filter(
    (hit, index) => hits.findIndex((other) => sameRecord(hit, other)) === index,
  );

/**
 * Step 2. Community references are named not_available until their slice ships, and
 * an Article hit in the CMS settles an id the community side cannot also hold.
 */
const exactStage = async (
  req: PayloadRequest,
  { references }: ClassifiedQuery,
  input: AdminFindInput,
  sources: Sources,
) => {
  const families = familiesFor(input.type);
  const hits: Hit[] = [];
  let considered = 0;
  for (const reference of references) {
    if (reference.kind === "text") continue;
    if (reference.kind === "community" || reference.kind === "handle") {
      const type = reference.kind === "handle" ? "user" : reference.type;
      const settled =
        reference.kind === "community" &&
        reference.type === "article" &&
        hits.some(({ family }) => family.type === "article");
      if (settled || (input.type !== undefined && input.type !== type))
        continue;
      considered += 1;
      sources[COMMUNITY_SOURCE[type]!] = "not_available";
      continue;
    }
    considered += 1;
    const found = await hitsOf(req, reference, families);
    for (const family of families)
      if (
        reference.kind === "digits" ||
        reference.kind === "token" ||
        reference.kind === "sha256" ||
        reference.kind === "uuid" ||
        reference.type === family.type
      )
        sources[SOURCE_OF_FAMILY[family.type]] = "ok";
    hits.push(...found);
  }
  return { hits: distinct(hits), considered };
};

const BRANCH_STATEMENT_TIMEOUT = "2000ms";
const QUERY_CANCELED = "57014";

/**
 * A search branch's budget, enforced where the SQL runs: its own READ ONLY
 * transaction, because a timeout aborts the transaction it happens in and an abort
 * on this side would not stop the statement.
 */
export const withinBudget = async <T>(
  req: PayloadRequest,
  work: (branch: PayloadRequest, db: BranchDb) => Promise<T>,
): Promise<
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "timed_out" | "failed" }
> => {
  const { payload } = req;
  const adapter = payload.db as unknown as Pick<PostgresAdapter, "sessions">;
  let transactionID: number | string | undefined;
  try {
    const started = await payload.db.beginTransaction();
    if (started === null) return { status: "failed" };
    transactionID = started;
    const db = adapter.sessions![String(started)]!.db as BranchDb;
    await db.execute(sql`SET TRANSACTION READ ONLY`);
    await db.execute(
      sql.raw(`SET LOCAL statement_timeout = '${BRANCH_STATEMENT_TIMEOUT}'`),
    );
    const branch = await createLocalReq(
      { user: req.user as NonNullable<PayloadRequest["user"]> },
      payload,
    );
    branch.transactionID = started;
    return { status: "ok", value: await work(branch, db) };
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (code === QUERY_CANCELED) return { status: "timed_out" };
    payload.logger.error({ category: "ADMIN_MCP_FIND_BRANCH_FAILED" });
    return { status: "failed" };
  } finally {
    if (transactionID !== undefined)
      await payload.db
        .rollbackTransaction(transactionID)
        .catch(() => undefined);
  }
};

interface BranchDb {
  execute(query: ReturnType<typeof sql>): Promise<{
    rows: readonly Record<string, unknown>[];
  }>;
}

/** Whitespace separates same-record AND parts, and punctuation stays literal. */
const queryParts = (text: string) => text.split(/\s+/u).filter(Boolean);
const likePattern = (part: string) => `%${part.replace(/[\\%_]/gu, "\\$&")}%`;

interface SearchRow {
  readonly catalog_id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly normalized_title: string;
  readonly normalized_aliases: readonly string[];
  readonly snippet: string | null;
  readonly at: number | null;
}

const asSearchRow = (row: Readonly<Record<string, unknown>>) =>
  row as unknown as SearchRow;

/**
 * How a published search row matched. Raw only where the words as typed are in the
 * stored title or an alias; a body match is only known through normalized text.
 */
const publishedMatch = (
  row: SearchRow,
  raw: string,
  normalized: string,
): Pick<Hit, "field" | "kind" | "offset" | "snippet"> => {
  const inTitle = snippetAround(row.title, raw);
  if (inTitle) return { field: "title", kind: "raw", ...inTitle };
  for (const alias of row.aliases) {
    const inAlias = snippetAround(alias, raw);
    if (inAlias) return { field: "aliases", kind: "raw", ...inAlias };
  }
  const inNormalizedTitle = snippetAround(row.normalized_title, normalized);
  if (inNormalizedTitle)
    return { field: "title", kind: "t2s", ...inNormalizedTitle };
  for (const alias of row.normalized_aliases) {
    const inAlias = snippetAround(alias, normalized);
    if (inAlias) return { field: "aliases", kind: "t2s", ...inAlias };
  }
  return {
    field: "content",
    kind: "t2s",
    ...(row.at === null ? {} : { offset: row.at }),
    ...(row.snippet === null ? {} : { snippet: row.snippet }),
  };
};

/** Published Catalogs, on the search documents and their trigram index. */
const publishedCatalogHits = async (
  branch: PayloadRequest,
  db: BranchDb,
  text: string,
  limit: number,
): Promise<readonly Hit[]> => {
  const normalized = normalizeSearchQuery(text);
  const parts = queryParts(normalized);
  const first = parts[0] ?? "";
  const contains = sql.join(
    parts.map(
      (part) => sql`combined_text LIKE ${likePattern(part)} ESCAPE '\\'`,
    ),
    sql` AND `,
  );
  const { rows } = await db.execute(sql`SELECT catalog_id, title, aliases,
      normalized_title, normalized_aliases,
      NULLIF(strpos(combined_text, ${first}::text), 0) - 1 AS at,
      substr(combined_text,
        GREATEST(strpos(combined_text, ${first}::text) - 20, 1),
        40 + length(${first}::text)) AS snippet
    FROM catalog_search_documents
    WHERE ${contains}
    ORDER BY (title = ${text}::text) DESC,
      (normalized_title = ${normalized}::text) DESC,
      catalog_id COLLATE "C" ASC
    LIMIT ${limit}`);
  return catalogHitsOf(branch, rows.map(asSearchRow), (row) =>
    publishedMatch(row, text, normalized),
  );
};

const catalogHitsOf = async (
  branch: PayloadRequest,
  rows: readonly SearchRow[],
  matchOf: (
    row: SearchRow,
  ) => Pick<Hit, "field" | "kind" | "offset" | "snippet">,
): Promise<readonly Hit[]> => {
  if (rows.length === 0) return [];
  const family = CMS_FAMILIES.catalog;
  const docs = await findDocuments(branch, family, {
    where: { catalogId: { in: rows.map((row) => row.catalog_id) } },
    limit: rows.length,
    select: family.findSelect,
  });
  const byId = new Map(docs.map((doc) => [doc.catalogId, doc]));
  return rows.flatMap((row) => {
    const doc = byId.get(row.catalog_id);
    return doc === undefined ? [] : [{ family, doc, ...matchOf(row) }];
  });
};

const TRIGRAM_MINIMUM_CHARS = 3;
const TRIGRAM_THRESHOLD = 0.3;

/** A close spelling, tried only once no branch contains the words, and it says so. */
const closeCatalogHits = async (
  branch: PayloadRequest,
  db: BranchDb,
  text: string,
  limit: number,
): Promise<readonly Hit[]> => {
  const normalized = normalizeSearchQuery(text);
  const { rows } = await db.execute(sql`SELECT catalog_id,
      public.similarity(title_alias_text, ${normalized}::text) AS score
    FROM catalog_search_documents
    WHERE public.similarity(title_alias_text, ${normalized}::text) > ${TRIGRAM_THRESHOLD}
    ORDER BY score DESC, catalog_id COLLATE "C" ASC
    LIMIT ${limit}`);
  return catalogHitsOf(branch, rows.map(asSearchRow), () => ({
    field: "title",
    kind: "trigram",
  }));
};

/** Payload's `contains`, on the fields a person would call this record by. */
const SEARCHED_FIELDS: Readonly<Record<AdminCmsRecordType, readonly string[]>> =
  {
    catalog: ["title"],
    article: ["title", "subtitle", "summary", "byline"],
    collection: ["title", "subtitle", "summary"],
    media: ["alt"],
  };

const containsHits = async (
  branch: PayloadRequest,
  family: CmsFamily,
  text: string,
  limit: number,
): Promise<readonly Hit[]> => {
  const fields = SEARCHED_FIELDS[family.type];
  // Simplified words reach a stored simplified title; a traditional stored title is
  // only reached by the same characters, and the published branch covers the rest.
  const normalized = normalizeSearchQuery(text);
  const variants = normalized === text ? [text] : [text, normalized];
  const docs = await findDocuments(branch, family, {
    where: {
      or: variants.flatMap((variant) =>
        fields.map((field) => ({ [field]: { contains: variant } })),
      ),
    },
    limit,
    select: {
      ...family.findSelect,
      ...Object.fromEntries(fields.map((field) => [field, true])),
    },
    sort: "-updatedAt",
  });
  return docs.map((doc) => {
    for (const variant of variants)
      for (const field of fields) {
        const value = doc[field];
        const found =
          typeof value === "string"
            ? snippetAround(value, queryParts(variant)[0] ?? variant)
            : undefined;
        if (found)
          return {
            family,
            doc,
            field,
            kind: variant === text ? "raw" : "t2s",
            ...found,
          };
      }
    return { family, doc, field: fields[0]!, kind: "raw" };
  });
};

/** Step 3: each branch budgeted and named, never added up as if complete. */
const fuzzyStage = async (
  req: PayloadRequest,
  text: string,
  input: AdminFindInput,
  limit: number,
  sources: Sources,
): Promise<readonly Hit[]> => {
  const families = familiesFor(input.type);
  const hits: Hit[] = [];
  const runBranch = async (
    source: string,
    work: (branch: PayloadRequest, db: BranchDb) => Promise<readonly Hit[]>,
  ) => {
    const answer = await withinBudget(req, work);
    sources[source] = answer.status;
    if (answer.status === "ok") hits.push(...answer.value);
  };
  // In turn: the Admin pool is five connections and the screens share it.
  for (const family of families) {
    if (family.type === "catalog") {
      await runBranch("catalogs_published", (branch, db) =>
        publishedCatalogHits(branch, db, text, limit),
      );
      await runBranch("catalogs_draft", (branch) =>
        containsHits(branch, family, text, limit),
      );
    } else
      await runBranch(SOURCE_OF_FAMILY[family.type], (branch) =>
        containsHits(branch, family, text, limit),
      );
  }
  if (
    hits.length === 0 &&
    wants(families, "catalog") &&
    Array.from(text).length >= TRIGRAM_MINIMUM_CHARS
  )
    await runBranch("catalogs_similar", (branch, db) =>
      closeCatalogHits(branch, db, text, limit),
    );
  if (input.type === undefined)
    for (const source of COMMUNITY_SEARCH_SOURCES)
      sources[source] = "not_available";
  else if (!isCmsType(input.type))
    sources[COMMUNITY_SOURCE[input.type]!] = "not_available";
  return distinct(hits);
};

const itemsOf = async (
  req: PayloadRequest,
  hits: readonly Hit[],
  exact: boolean,
  scope: ActionScope,
): Promise<readonly AdminFindItem[]> => {
  const families = [...new Set(hits.map(({ family }) => family))];
  const context = new Map(
    await Promise.all(
      families.map(async (family) => {
        const ids = hits
          .filter((hit) => hit.family === family)
          .map(({ doc }) => doc.id);
        return [
          family,
          {
            live: await liveStatusesOf(req, family, ids),
            locks: await locksOf(req, family, ids),
          },
        ] as const;
      }),
    ),
  );
  return hits.map(({ family, doc, field, kind, offset, snippet }) => {
    const { live, locks } = context.get(family)!;
    const id = doc.id as number;
    const title = titleOf(family, doc);
    const lock = lockOf(locks, family, id);
    const state = family.versioned
      ? stateOf(doc._status, live.get(id))
      : ("registered" as const);
    const version = typeof doc.revision === "number" ? doc.revision : undefined;
    return {
      type: family.type,
      id,
      ...(title === undefined ? {} : { title }),
      state,
      ...(typeof doc.updatedAt === "string"
        ? { updatedAt: doc.updatedAt }
        : {}),
      ...(version === undefined ? {} : { version }),
      ...(lock === undefined ? {} : { lock }),
      disambiguators: family.disambiguators(doc),
      match: {
        field,
        kind,
        ...(offset === undefined ? {} : { offset }),
        ...(snippet === undefined ? {} : { snippet }),
      },
      ...(exact
        ? {
            adminPath: adminPathOf(family, id),
            actions: [
              ...actionsFor(
                {
                  type: family.type,
                  id,
                  state,
                  ...(version === undefined ? {} : { revision: version }),
                  locked: lock?.held === true,
                  ...(family.type === "catalog"
                    ? { catalogId: String(doc.catalogId) }
                    : {}),
                  ...(family.type === "media"
                    ? { mediaId: String(doc.mediaId) }
                    : {}),
                },
                scope,
              ),
            ],
          }
        : { actions: [...candidateActions(family.type, id)] }),
    };
  });
};

const DEFAULT_LIMIT = 10;

const UNTRUSTED = [
  "/data/items/*/title",
  "/data/items/*/match/snippet",
  "/data/items/*/disambiguators",
];

export const findEnvelope = async (
  req: PayloadRequest,
  input: AdminFindInput,
  scope: ActionScope,
): Promise<AdminMcpEnvelope> => {
  const classified = classifyQuery(input.query);
  const sources: Sources = {};
  const limit = input.limit ?? DEFAULT_LIMIT;
  const skip = input.skip ?? 0;
  const exact = await exactStage(req, classified, input, sources);
  const textToSearch =
    exact.hits.length > 0 || classified.link
      ? undefined
      : classified.references.flatMap((reference) =>
          reference.kind === "text"
            ? [reference.text]
            : reference.kind === "token" || reference.kind === "digits"
              ? [reference.value]
              : [],
        )[0];
  const fuzzy =
    textToSearch === undefined
      ? []
      : await fuzzyStage(req, textToSearch, input, limit + skip, sources);
  const hits = exact.hits.length > 0 ? exact.hits : fuzzy;
  // Unique means one identity hit from one reference: a link naming two things, one
  // of them unanswered, has not said which it means.
  const unique =
    hits.length === 1 && hits[0]!.kind === "identity" && exact.considered === 1;
  const page = hits.slice(skip, skip + limit);
  const items = await itemsOf(req, page, unique, scope);
  const data: AdminFindData = {
    resolution: {
      status: unique ? "exact" : hits.length > 0 ? "candidates" : "none",
      uniqueIdentity: unique,
      ...(unique ? { ref: { type: items[0]!.type, id: items[0]!.id } } : {}),
    },
    items: [...items],
    ...(classified.focusMediaId === undefined
      ? {}
      : { focus: { mediaId: classified.focusMediaId } }),
  };
  const partial = Object.values(sources).some((status) => status !== "ok");
  const envelope = okEnvelope(data, UNTRUSTED);
  return {
    ...envelope,
    ...(hits.length > skip + limit
      ? {
          next: {
            tool: "admin_find",
            args: { ...input, skip: skip + limit },
          },
        }
      : {}),
    meta: {
      ...envelope.meta,
      sources,
      ...(partial ? { partial: true as const } : {}),
      ...(classified.excluded.length > 0
        ? { excluded: [...classified.excluded] }
        : {}),
    },
  };
};
