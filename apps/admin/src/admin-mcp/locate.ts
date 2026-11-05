import {
  ADMIN_CMS_RECORD_TYPES,
  ADMIN_FIND_SKIP_MAX,
  AI_FIND_SOURCES,
  AI_LOOKUP_TYPES,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminCmsRecordType,
  AdminFindData,
  AdminFindInput,
  AdminFindItem,
  AdminMatchKind,
  AdminMcpEnvelope,
  AdminRecordType,
  AiFindItem,
  AiFindResult,
  AiFindSource,
  AiLookupType,
} from "@moya/contracts/internal/admin-mcp";
import { operatorExactIdSchema } from "@moya/contracts/internal/community-operator";
import { sql } from "@payloadcms/db-postgres";
import type { PayloadRequest, Where } from "payload";

import { aiCredentialConfigured } from "../community/backend";
import { isMissingRecord } from "../editorial/transaction";
import { withIdentityAccess } from "../editorial/state";
import {
  actionsFor,
  candidateActions,
  communityActionsFor,
} from "./actions-for";
import type { ActionScope } from "./actions-for";
import { withinBudget } from "./budget";
import type { BranchDb } from "./budget";
import {
  CUT_WITH_NO_WAY_ON,
  inputInvalidEnvelope,
  okEnvelope,
} from "./envelope";
import { classifyQuery } from "./locate-reference";
import type { ClassifiedQuery, LocateReference } from "./locate-reference";
import { askFind, fitsFindAddress } from "./ops/community-reads";
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
import {
  normalizeSearchQuery,
  snippetAround,
  traditionalSearchQuery,
} from "./text-window";

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

/** A record the Backend found, as it said it. */
interface CommunityHit {
  readonly community: AiFindItem;
}

type AnyHit = Hit | CommunityHit;

const isCommunityHit = (hit: AnyHit): hit is CommunityHit => "community" in hit;

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

const isSearchSource = (source: string | undefined): source is AiFindSource =>
  (AI_FIND_SOURCES as readonly string[]).includes(source ?? "");

const isLookupType = (type: string): type is AiLookupType =>
  (AI_LOOKUP_TYPES as readonly string[]).includes(type);

/** One source asked twice is only as answered as its worst call. */
const noted = (sources: Sources, source: string, status: SourceStatus) => {
  if (status !== "ok" || sources[source] === undefined)
    sources[source] = status;
};

/** A branch not really read says so, and a failed call is every branch it asked for. */
const askedBackend = async (
  query: Readonly<Record<string, string | number>>,
  asked: readonly string[],
  sources: Sources,
  excluded: Set<string>,
): Promise<readonly CommunityHit[]> => {
  if (!aiCredentialConfigured("community")) {
    for (const source of asked) sources[source] = "not_available";
    return [];
  }
  let answer: AiFindResult;
  try {
    answer = await askFind(query);
  } catch {
    for (const source of asked) sources[source] = "failed";
    return [];
  }
  for (const [source, status] of Object.entries(answer.sources))
    noted(sources, source, status);
  for (const category of answer.excluded) excluded.add(category);
  return answer.items.map((community) => ({ community }));
};

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
  reach: number,
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
    // A catalogId or a sourceId can hold these two shapes too, and it is exact.
    case "sha256":
      return [
        ...(catalog ? await catalogByIdentity(req, reference.typed) : []),
        ...(media
          ? identityHits(
              CMS_FAMILIES.media,
              "sha256",
              await lookup(
                req,
                CMS_FAMILIES.media,
                { sha256: { equals: reference.value } },
                reach,
              ),
            )
          : []),
      ];
    case "uuid":
      return [
        ...(catalog ? await catalogByIdentity(req, reference.typed) : []),
        ...(media
          ? await mediaByIdentity(req, [
              reference.typed,
              reference.value,
              `media-${reference.value}`,
            ])
          : []),
      ];
    default:
      return [];
  }
};

const sameRecord = (left: AnyHit, right: AnyHit) =>
  isCommunityHit(left) || isCommunityHit(right)
    ? isCommunityHit(left) &&
      isCommunityHit(right) &&
      left.community.type === right.community.type &&
      left.community.id === right.community.id
    : left.family === right.family && left.doc.id === right.doc.id;

const distinct = <Found extends AnyHit>(hits: readonly Found[]) =>
  hits.filter(
    (hit, index) => hits.findIndex((other) => sameRecord(hit, other)) === index,
  );

/**
 * A link's community ids run in turn, each up to 20 s: a wait of 5 s and a call of 15 s.
 * Nginx and the clients stop at 60 s, so no new call starts past this, and the last to
 * start still answers in time. The product's own links name only two or three ids.
 */
const EXACT_STAGE_DEADLINE_MS = 35_000;

/** The one exact lookup a community reference names. Its value can name no record. */
const communityLookup = async (
  reference: Extract<LocateReference, { kind: "community" | "handle" }>,
  sources: Sources,
  excluded: Set<string>,
  stopped: () => boolean,
): Promise<readonly CommunityHit[]> => {
  const type = reference.kind === "handle" ? "user" : reference.type;
  const source = COMMUNITY_SOURCE[type]!;
  const value =
    reference.kind === "handle" ? reference.handle : reference.value;
  if (!isLookupType(type)) {
    sources[source] = "not_available";
    return [];
  }
  if (!operatorExactIdSchema.safeParse(value).success) {
    noted(sources, source, "ok");
    return [];
  }
  if (stopped()) {
    sources[source] = "timed_out";
    return [];
  }
  return askedBackend(
    reference.kind === "handle" ? { handle: value } : { type, id: value },
    [source],
    sources,
    excluded,
  );
};

/**
 * Step 2. An Article hit in the CMS settles an id the community side cannot also
 * hold.
 */
const exactStage = async (
  req: PayloadRequest,
  { references }: ClassifiedQuery,
  input: AdminFindInput,
  reach: number,
  sources: Sources,
  excluded: Set<string>,
) => {
  const families = familiesFor(input.type);
  const hits: AnyHit[] = [];
  let considered = 0;
  const deadline = Date.now() + EXACT_STAGE_DEADLINE_MS;
  // A client that has gone is waiting for no answer.
  const stopped = () => Date.now() >= deadline || req.signal?.aborted === true;
  for (const reference of references) {
    if (reference.kind === "text") continue;
    if (reference.kind === "community" || reference.kind === "handle") {
      const type = reference.kind === "handle" ? "user" : reference.type;
      const settled =
        reference.kind === "community" &&
        reference.type === "article" &&
        hits.some(
          (hit) => !isCommunityHit(hit) && hit.family.type === "article",
        );
      if (settled || (input.type !== undefined && input.type !== type))
        continue;
      // One id asked of two stores is one reference; its CMS twin already counted.
      if (reference.kind !== "community" || reference.type !== "article")
        considered += 1;
      hits.push(
        ...(await communityLookup(reference, sources, excluded, stopped)),
      );
      continue;
    }
    considered += 1;
    const found = await hitsOf(req, reference, families, reach);
    // Only what hitsOf really read: a family it skipped is not a zero.
    for (const family of families)
      if (
        reference.kind === "digits" ||
        (reference.kind === "row" || reference.kind === "identity"
          ? reference.type === family.type
          : family.type === "catalog" || family.type === "media")
      )
        sources[SOURCE_OF_FAMILY[family.type]] = "ok";
    hits.push(...found);
  }
  return { hits: distinct(hits), considered };
};

/** Whitespace separates same-record AND parts, and punctuation stays literal. */
const queryParts = (text: string) => [
  ...new Set(text.split(/\s+/u).filter(Boolean)),
];
/** Each word is a SQL condition and a scan of every row read, in synchronous JS. */
const QUERY_WORDS_MAX = 32;
const escapedLike = (part: string) => part.replace(/[\\%_]/gu, "\\$&");
const likePattern = (part: string) => `%${escapedLike(part)}%`;

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

/** Where the first word is, and only once each word is in one of these fields. */
const locatedIn = (
  doc: RecordDocument,
  fields: readonly string[],
  parts: readonly string[],
) => {
  const places = parts.map((part) => {
    for (const field of fields) {
      const value = doc[field];
      const found =
        typeof value === "string" ? snippetAround(value, part) : undefined;
      if (found) return { field, ...found };
    }
    return undefined;
  });
  return places.every(Boolean) ? places[0] : undefined;
};

const containsHits = async (
  branch: PayloadRequest,
  family: CmsFamily,
  text: string,
  limit: number,
): Promise<readonly Hit[]> => {
  const fields = SEARCHED_FIELDS[family.type];
  // There is no normalized copy to compare with here, so each form of the words is
  // tried against the stored text. Conversion is one-to-many and cannot reach every
  // form, and the published branch has the normalized text for the rest.
  const forms = [
    { words: text, kind: "raw" as const },
    { words: normalizeSearchQuery(text), kind: "t2s" as const },
    { words: traditionalSearchQuery(text), kind: "s2t" as const },
  ];
  const variants = forms.filter(
    ({ words }, index) =>
      forms.findIndex((form) => form.words === words) === index,
  );
  const docs = await findDocuments(branch, family, {
    where: {
      or: variants.map(({ words }) => ({
        and: queryParts(words).map((part) => ({
          or: fields.map((field) => ({
            // Payload's contains is ILIKE around the value as it stands.
            [field]: { contains: escapedLike(part) },
          })),
        })),
      })),
    },
    limit,
    select: {
      ...family.findSelect,
      ...Object.fromEntries(fields.map((field) => [field, true])),
    },
    sort: "-updatedAt",
  });
  return docs.map((doc) => {
    for (const { words, kind } of variants) {
      const found = locatedIn(doc, fields, queryParts(words));
      if (found) return { family, doc, kind, ...found };
    }
    // SQL and JS fold case apart (`İ`), so no form could be placed: of those tried it
    // claims the weakest, which is raw only when raw was all there was.
    return { family, doc, field: fields[0]!, kind: variants.at(-1)!.kind };
  });
};

/** A title given whole names its record however many others contain those words. */
const wholeTitleHits = async (
  branch: PayloadRequest,
  family: CmsFamily,
  text: string,
  limit: number,
): Promise<readonly Hit[]> =>
  (
    await findDocuments(branch, family, {
      where: { title: { equals: text } },
      limit,
      select: family.findSelect,
    })
  ).map((doc) => ({
    family,
    doc,
    field: "title",
    kind: "raw",
    ...snippetAround(text, text),
  }));

/** With no token placed no Backend address is ever built. */
const asksBackendToSearch = ({ type }: AdminFindInput): boolean =>
  aiCredentialConfigured("community") &&
  (type === undefined || isSearchSource(COMMUNITY_SOURCE[type]));

/** The Backend's branches, each budgeted where its SQL runs and named per branch. */
const communitySearch = async (
  text: string,
  input: AdminFindInput,
  limit: number,
  sources: Sources,
  excluded: Set<string>,
): Promise<readonly CommunityHit[]> => {
  if (input.type !== undefined && isCmsType(input.type)) return [];
  const source =
    input.type === undefined ? undefined : COMMUNITY_SOURCE[input.type];
  if (source !== undefined && !isSearchSource(source)) {
    sources[source] = "not_available";
    return [];
  }
  return askedBackend(
    { text, limit, ...(source === undefined ? {} : { source }) },
    source === undefined ? AI_FIND_SOURCES : [source],
    sources,
    excluded,
  );
};

/** Step 3: each branch budgeted and named, never added up as if complete. */
const fuzzyStage = async (
  req: PayloadRequest,
  text: string,
  input: AdminFindInput,
  limit: number,
  sources: Sources,
  excluded: Set<string>,
): Promise<readonly AnyHit[]> => {
  const families = familiesFor(input.type);
  const hits: Hit[] = [];
  const runBranch = async (
    source: string,
    work: (branch: PayloadRequest, db: BranchDb) => Promise<readonly Hit[]>,
  ) => {
    const answer = await withinBudget(req, work);
    sources[source] = answer.status;
    if (answer.status === "failed")
      req.payload.logger.error({ category: "ADMIN_MCP_FIND_BRANCH_FAILED" });
    if (answer.status === "ok") hits.push(...answer.value);
  };
  // The Backend's reads hold no connection of this pool, so they need not wait for it.
  const community = communitySearch(text, input, limit, sources, excluded);
  // In turn: the Admin pool is five connections and the screens share it.
  for (const family of families) {
    if (family.type === "catalog") {
      await runBranch("catalogs_published", (branch, db) =>
        publishedCatalogHits(branch, db, text, limit),
      );
      await runBranch("catalogs_draft", async (branch) => [
        ...(await wholeTitleHits(branch, family, text, limit)),
        ...(await containsHits(branch, family, text, limit)),
      ]);
    } else
      await runBranch(SOURCE_OF_FAMILY[family.type], (branch) =>
        containsHits(branch, family, text, limit),
      );
  }
  const others = distinct(await community);
  if (
    hits.length === 0 &&
    others.length === 0 &&
    wants(families, "catalog") &&
    Array.from(text).length >= TRIGRAM_MINIMUM_CHARS
  )
    await runBranch("catalogs_similar", (branch, db) =>
      closeCatalogHits(branch, db, text, limit),
    );
  // First wherever a branch read it: drafts come after the published branch, and past
  // enough near-twins no page would reach one.
  const found = distinct(hits);
  const isWhole = ({ family, doc }: Hit) => titleOf(family, doc) === text;
  // An id or a handle given whole is first for the same reason.
  const isIdentity = ({ community: { match } }: CommunityHit) =>
    match.kind === "identity";
  return [
    ...others.filter(isIdentity),
    ...found.filter(isWhole),
    ...found.filter((hit) => !isWhole(hit)),
    ...others.filter((hit) => !isIdentity(hit)),
  ];
};

const communityItemOf = (
  {
    type,
    id,
    title,
    state,
    updatedAt,
    version,
    disambiguators,
    match,
  }: AiFindItem,
  exact: boolean,
  scope: ActionScope,
): AdminFindItem => ({
  type,
  id,
  ...(title === undefined ? {} : { title }),
  state,
  ...(updatedAt === undefined ? {} : { updatedAt }),
  ...(version === undefined ? {} : { version }),
  disambiguators,
  match,
  actions: [
    ...(exact
      ? communityActionsFor(
          type,
          id,
          scope,
          (disambiguators as { ownerOnly?: unknown }).ownerOnly === true,
        )
      : candidateActions(type, id)),
  ],
});

const itemsOf = async (
  req: PayloadRequest,
  hits: readonly AnyHit[],
  exact: boolean,
  scope: ActionScope,
): Promise<readonly AdminFindItem[]> => {
  const cmsHits = hits.filter((hit): hit is Hit => !isCommunityHit(hit));
  const families = [...new Set(cmsHits.map(({ family }) => family))];
  const context = new Map(
    await Promise.all(
      families.map(async (family) => {
        const ids = cmsHits
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
  return hits.map((hit) => {
    if (isCommunityHit(hit))
      return communityItemOf(hit.community, exact, scope);
    const { family, doc, field, kind, offset, snippet } = hit;
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
                  lock,
                  ...(family.type === "catalog"
                    ? { catalogId: String(doc.catalogId) }
                    : {}),
                  // The one fingerprint a find can read: the rest cover long text.
                  ...(family.type === "media"
                    ? {
                        mediaId: String(doc.mediaId),
                        fingerprint: family.fingerprint(doc),
                      }
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
  // The two identities a skeleton copies from the record; the rest of it is ours.
  "/data/items/*/actions/*/args/input/filter/catalogId",
  "/data/items/*/actions/*/args/mediaId",
];

const NOTHING_LOOKED_UP =
  "Nothing was looked up: this query names nothing this tool can read, or nothing of the type asked for. This none does not mean the record is missing. Try its id or title, or drop type.";

/**
 * A known link with no scheme is a legal sourceId too, and the record holding that text
 * is what it names. Only this shape pays for the lookup: a `/catalog/<id>` is the
 * common path, and its statements are pinned.
 */
const classifiedFor = async (
  req: PayloadRequest,
  input: AdminFindInput,
): Promise<ClassifiedQuery> => {
  const classified = classifyQuery(input.query);
  const { literal } = classified;
  return literal !== undefined &&
    wants(familiesFor(input.type), "catalog") &&
    (await catalogByIdentity(req, literal)).length > 0
    ? {
        references: [{ kind: "token", value: literal }],
        excluded: [],
        link: false,
      }
    : classified;
};

export const findEnvelope = async (
  req: PayloadRequest,
  input: AdminFindInput,
  scope: ActionScope,
): Promise<AdminMcpEnvelope> => {
  const classified = await classifiedFor(req, input);
  const sources: Sources = {};
  const excluded = new Set(classified.excluded);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const skip = input.skip ?? 0;
  const reached = skip + limit;
  // One past the page, so a source that holds more is seen to hold more.
  const reach = reached + 1;
  const exact = await exactStage(
    req,
    classified,
    input,
    reach,
    sources,
    excluded,
  );
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
  // Named, never searched on some of the words: a partial AND would over-match.
  if (
    textToSearch !== undefined &&
    queryParts(textToSearch).length > QUERY_WORDS_MAX
  )
    return inputInvalidEnvelope([
      { path: ["query"], code: `more_than_${QUERY_WORDS_MAX}_words` },
    ]);
  // Named too: it would answer `failed` every time, which reads as worth repeating.
  if (
    textToSearch !== undefined &&
    asksBackendToSearch(input) &&
    !fitsFindAddress(textToSearch)
  )
    return inputInvalidEnvelope([
      { path: ["query"], code: "too_long_for_community_search" },
    ]);
  const fuzzy =
    textToSearch === undefined
      ? []
      : await fuzzyStage(req, textToSearch, input, reach, sources, excluded);
  const hits = exact.hits.length > 0 ? exact.hits : fuzzy;
  const only = hits.length === 1 ? hits[0]! : undefined;
  const kindOfOnly =
    only === undefined
      ? undefined
      : isCommunityHit(only)
        ? only.community.match.kind
        : only.kind;
  // Unique means one identity hit from one reference: a link naming two things, one
  // of them unanswered, has not said which it means. A fuzzy hit is unique only once
  // every source answered, because one that did not may hold the same word.
  const unique =
    kindOfOnly === "identity" &&
    exact.considered === 1 &&
    (exact.hits.length > 0 ||
      Object.values(sources).every((status) => status === "ok"));
  const page = hits.slice(skip, reached);
  const items = await itemsOf(req, page, unique, scope);
  const data: AdminFindData = {
    resolution: {
      status: unique ? "exact" : hits.length > 0 ? "candidates" : "none",
      uniqueIdentity: unique,
      // From the hit: a skip past it leaves this page empty and the answer the same.
      ...(unique
        ? {
            ref: isCommunityHit(only!)
              ? { type: only.community.type, id: only.community.id }
              : { type: only!.family.type, id: only!.doc.id as number },
          }
        : {}),
    },
    items: [...items],
    ...(classified.focusMediaId === undefined
      ? {}
      : { focus: { mediaId: classified.focusMediaId } }),
  };
  // A withheld category is named on its own; with nothing read and nothing named, this
  // none would read as searched and missing.
  const unread = Object.keys(sources).length === 0 && excluded.size === 0;
  const partial =
    unread || Object.values(sources).some((status) => status !== "ok");
  const envelope = okEnvelope(data, UNTRUSTED);
  const more = hits.length > reached;
  const stopped = more && reached > ADMIN_FIND_SKIP_MAX;
  return {
    ...envelope,
    ...(more && !stopped
      ? { next: { tool: "admin_find", args: { ...input, skip: reached } } }
      : {}),
    ...(stopped ? { hint: CUT_WITH_NO_WAY_ON } : {}),
    ...(unread ? { hint: NOTHING_LOOKED_UP } : {}),
    meta: {
      ...envelope.meta,
      sources,
      ...(partial ? { partial: true as const } : {}),
      ...(stopped ? { truncated: true as const } : {}),
      ...(excluded.size > 0 ? { excluded: [...excluded] } : {}),
    },
  };
};
