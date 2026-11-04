import { EDITORIAL_STATEFUL_FIELDS } from "@moya/contracts/internal/editorial";
import type {
  AdminCmsRecordType,
  AdminFieldFacts,
  AdminLock,
  AdminRecordState,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest, Where } from "payload";

import { contentFingerprint } from "../editorial/content";
import { articleContentFingerprint } from "../editorial-content/approvals";
import { codePointLength, textHash } from "./text-window";

/**
 * The four CMS families as Admin MCP reads them: Local API, this key's user,
 * overrideAccess false. Long text leaves here only by state, length and hash; a
 * window of it is requested by name (admin-mcp-completion-v1 section 6).
 */

export type RecordDocument = Readonly<Record<string, unknown>>;

/**
 * `fact`: a short value shown as it stands. `text` and `stateful`: possibly long, so
 * by length and hash. `array` and `group`: by count and hash.
 */
type FieldKind = "fact" | "text" | "stateful" | "array" | "group";

export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
}

const specs = (kind: FieldKind, ...names: readonly string[]): FieldSpec[] =>
  names.map((name) => ({ name, kind }));

export interface CmsFamily {
  readonly type: AdminCmsRecordType;
  readonly slug: "catalogs" | "articles" | "article-collections" | "media";
  readonly identityField: string;
  readonly titleField: string;
  /** Versioned families have a draft and a live row, and a revision on each. */
  readonly versioned: boolean;
  readonly fields: readonly FieldSpec[];
  /** What a found row is told apart by, read without its long text. */
  readonly findSelect: Readonly<Record<string, unknown>>;
  readonly disambiguators: (doc: RecordDocument) => Record<string, unknown>;
  readonly fingerprint: (doc: RecordDocument) => string;
}

/** The value of a stateful field when it has one; a state alone tells no value. */
export const statefulValue = (value: unknown): string | undefined => {
  const { state, value: text } = (value ?? {}) as {
    state?: unknown;
    value?: unknown;
  };
  return state === "VALUE" && typeof text === "string" ? text : undefined;
};

const withoutUndefined = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );

const canonicalHash = (value: unknown) => textHash(JSON.stringify(value));

/** Editorial fields only, in a fixed order, with row ids left out. */
const collectionFingerprint = (doc: RecordDocument): string =>
  canonicalHash(
    ["title", "subtitle", "summary", "category", "issue", "coverCatalog"]
      .map((name) => doc[name] ?? null)
      .concat([arrayItems(doc.members)]),
  );

const ownFields = (item: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries((item ?? {}) as Record<string, unknown>).filter(
      // A row's own id is transport, and an object key is never handed to a model:
      // images are read by mediaId through admin_view_media.
      ([key, value]) =>
        key !== "id" &&
        key !== "objectKey" &&
        value !== null &&
        value !== undefined,
    ),
  );

const arrayItems = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(ownFields) : [];

export const CMS_FAMILIES: Readonly<Record<AdminCmsRecordType, CmsFamily>> = {
  catalog: {
    type: "catalog",
    slug: "catalogs",
    identityField: "catalogId",
    titleField: "title",
    versioned: true,
    fields: [
      ...specs("fact", "catalogId", "sourceId", "kind"),
      ...specs("text", "title", "summary", "periodLabel"),
      ...specs("stateful", ...EDITORIAL_STATEFUL_FIELDS),
      ...specs(
        "array",
        "aliases",
        "provenance",
        "contributors",
        "sourceCitations",
        "media",
      ),
      ...specs("group", "filterMetadata"),
      ...specs("text", "ownerNote"),
    ],
    findSelect: {
      catalogId: true,
      sourceId: true,
      kind: true,
      title: true,
      dynasty: true,
      province: true,
      revision: true,
      updatedAt: true,
      _status: true,
      media: { mediaId: true },
    },
    disambiguators: (doc) =>
      withoutUndefined({
        catalogId: doc.catalogId,
        sourceId: doc.sourceId,
        kind: doc.kind,
        dynasty: statefulValue(doc.dynasty),
        province: statefulValue(doc.province),
        mediaCount: Array.isArray(doc.media) ? doc.media.length : 0,
      }),
    fingerprint: (doc) => contentFingerprint(doc),
  },
  article: {
    type: "article",
    slug: "articles",
    identityField: "articleId",
    titleField: "title",
    versioned: true,
    fields: [
      ...specs(
        "fact",
        "articleId",
        "presentation",
        "coverCatalog",
        "firstPublishedAt",
        "publishedAt",
      ),
      ...specs(
        "text",
        "title",
        "subtitle",
        "summary",
        "section",
        "issue",
        "byline",
        "coverAlt",
        "intro",
      ),
      ...specs("array", "sections", "citations"),
    ],
    findSelect: {
      articleId: true,
      presentation: true,
      title: true,
      byline: true,
      section: true,
      revision: true,
      updatedAt: true,
      _status: true,
    },
    disambiguators: (doc) =>
      withoutUndefined({
        articleId: doc.articleId,
        presentation: doc.presentation,
        byline: doc.byline,
        section: doc.section,
      }),
    fingerprint: (doc) => articleContentFingerprint(doc),
  },
  collection: {
    type: "collection",
    slug: "article-collections",
    identityField: "collectionId",
    titleField: "title",
    versioned: true,
    fields: [
      ...specs(
        "fact",
        "collectionId",
        "coverCatalog",
        "firstPublishedAt",
        "publishedAt",
      ),
      ...specs("text", "title", "subtitle", "summary", "category", "issue"),
      ...specs("array", "members"),
    ],
    findSelect: {
      collectionId: true,
      title: true,
      category: true,
      issue: true,
      revision: true,
      updatedAt: true,
      _status: true,
    },
    disambiguators: (doc) =>
      withoutUndefined({
        collectionId: doc.collectionId,
        category: doc.category,
        issue: doc.issue,
      }),
    fingerprint: collectionFingerprint,
  },
  media: {
    type: "media",
    slug: "media",
    identityField: "mediaId",
    titleField: "alt",
    versioned: false,
    fields: [
      ...specs(
        "fact",
        "mediaId",
        "catalogId",
        "origin",
        "mimeType",
        "filesize",
        "width",
        "height",
        "sha256",
        "orderConfidence",
      ),
      ...specs("text", "alt", "rights"),
    ],
    findSelect: {
      mediaId: true,
      catalogId: true,
      origin: true,
      alt: true,
      width: true,
      height: true,
      updatedAt: true,
    },
    disambiguators: (doc) =>
      withoutUndefined({
        mediaId: doc.mediaId,
        catalogId: doc.catalogId,
        origin: doc.origin,
        width: doc.width,
        height: doc.height,
      }),
    fingerprint: (doc) => canonicalHash([doc.alt ?? null]),
  },
};

export const adminPathOf = (family: CmsFamily, id: unknown): string =>
  `/admin/collections/${family.slug}/${String(id)}`;

export const titleOf = (family: CmsFamily, doc: RecordDocument) => {
  const title = doc[family.titleField];
  return typeof title === "string" ? title : undefined;
};

export interface DocumentQuery {
  readonly where: Where;
  readonly limit: number;
  readonly draft?: boolean;
  readonly select?: Readonly<Record<string, unknown>>;
  readonly sort?: string;
}

/** One query on a family, with no total: keyset paging and lookups never need one. */
export const findDocuments = async (
  req: PayloadRequest,
  family: Pick<CmsFamily, "versioned"> & { readonly slug: string },
  { where, limit, draft = family.versioned, select, sort }: DocumentQuery,
): Promise<readonly RecordDocument[]> => {
  const { docs } = await req.payload.find({
    collection: family.slug as "catalogs",
    draft,
    depth: 0,
    limit,
    pagination: false,
    overrideAccess: false,
    req,
    user: req.user,
    where,
    ...(sort === undefined ? {} : { sort }),
    ...(select === undefined ? {} : { select: select as never }),
  });
  return docs as unknown as readonly RecordDocument[];
};

/** A row id, or the public identity a string names. A miss is undefined. */
export const rowIdOf = async (
  req: PayloadRequest,
  family: CmsFamily,
  id: number | string,
): Promise<number | undefined> => {
  if (typeof id === "number") return id;
  const [found] = await findDocuments(req, family, {
    where: { [family.identityField]: { equals: id } },
    limit: 1,
    draft: false,
    select: { [family.identityField]: true },
  });
  if (found !== undefined) return found.id as number;
  // A model may hand a row id back as a string: a public identity wins, then this.
  return /^[1-9]\d{0,15}$/u.test(id) ? Number(id) : undefined;
};

/** The latest version, draft or not. Throws what Payload throws on a miss. */
export const readLatest = async (
  req: PayloadRequest,
  family: CmsFamily,
  id: number,
): Promise<RecordDocument> =>
  (await req.payload.findByID({
    collection: family.slug,
    id,
    draft: family.versioned,
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  })) as unknown as RecordDocument;

/** The row the public reads from, whatever its state. */
export const readLive = async (
  req: PayloadRequest,
  family: CmsFamily,
  id: number,
): Promise<RecordDocument> =>
  (await req.payload.findByID({
    collection: family.slug,
    id,
    draft: false,
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  })) as unknown as RecordDocument;

export const stateOf = (
  latestStatus: unknown,
  liveStatus: unknown,
): AdminRecordState =>
  latestStatus === "published"
    ? "published"
    : liveStatus === "published"
      ? "draft_over_published"
      : "draft";

/** One read for a whole page, so state costs no extra read per row. */
export const liveStatusesOf = async (
  req: PayloadRequest,
  family: CmsFamily,
  ids: readonly unknown[],
): Promise<ReadonlyMap<unknown, unknown>> => {
  if (!family.versioned || ids.length === 0) return new Map();
  const rows = await findDocuments(req, family, {
    where: { id: { in: ids as never } },
    limit: ids.length,
    draft: false,
    select: { _status: true },
  });
  return new Map(rows.map((row) => [row.id, row._status]));
};

const LOCK_DURATION_DEFAULT_SECONDS = 300;

const lockDurationSeconds = (
  req: PayloadRequest,
  family: CmsFamily,
): number => {
  const setting = req.payload.collections[family.slug]?.config.lockDocuments;
  return typeof setting === "object" && setting !== null
    ? setting.duration
    : LOCK_DURATION_DEFAULT_SECONDS;
};

const KIND_OF_ROLE: Readonly<Record<string, NonNullable<AdminLock["by"]>>> = {
  owner: "owner",
  ai_operator: "ai",
  automation: "automation",
};

/** Roles only, read after the gate: account rows stay reserved to the Owner's browser. */
export const accountKindsOf = async (
  req: PayloadRequest,
  ids: readonly unknown[],
): Promise<ReadonlyMap<unknown, NonNullable<AdminLock["by"]> | undefined>> => {
  if (ids.length === 0) return new Map();
  const { docs } = await req.payload.find({
    collection: "users",
    where: { id: { in: ids as never } },
    select: { role: true },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
    req,
  });
  return new Map(docs.map(({ id, role }) => [id, KIND_OF_ROLE[String(role)]]));
};

const NOT_HELD: AdminLock = { held: false };

/**
 * Who has these documents open, so a doomed write is not attempted. One read for all
 * of them. A lock past its time reads as not held, as Payload's own check does.
 */
export const locksOf = async (
  req: PayloadRequest,
  family: CmsFamily,
  ids: readonly unknown[],
): Promise<ReadonlyMap<unknown, AdminLock>> => {
  if (!family.versioned || ids.length === 0) return new Map();
  const { docs } = await req.payload.find({
    collection: "payload-locked-documents",
    where: {
      and: [
        { "document.relationTo": { equals: family.slug } },
        { "document.value": { in: ids as never } },
      ],
    },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: false,
    req,
    user: req.user,
  });
  const durationMs = lockDurationSeconds(req, family) * 1000;
  const live = docs.filter(
    ({ updatedAt }) => Date.now() - Date.parse(updatedAt) <= durationMs,
  );
  const kinds = await accountKindsOf(req, [
    ...new Set(live.map(({ user }) => user?.value)),
  ]);
  return new Map(
    live.map((row) => {
      const by = kinds.get(row.user?.value);
      return [
        row.document?.value,
        {
          held: true,
          ...(by === undefined ? {} : { by }),
          lastEditedAt: row.updatedAt,
          expiresAt: new Date(
            Date.parse(row.updatedAt) + durationMs,
          ).toISOString(),
        },
      ] as const;
    }),
  );
};

export const lockOf = (
  locks: ReadonlyMap<unknown, AdminLock>,
  family: CmsFamily,
  id: unknown,
): AdminLock | undefined =>
  family.versioned ? (locks.get(id) ?? NOT_HELD) : undefined;

const isPresent = (value: unknown) =>
  value !== undefined && value !== null && value !== "";

/** One field by state, length and hash, for any field of any family. */
export const factsOf = (
  spec: FieldSpec,
  doc: RecordDocument,
): AdminFieldFacts => {
  const value = doc[spec.name];
  const absent = { name: spec.name, state: "ABSENT" };
  switch (spec.kind) {
    case "stateful": {
      const state = (value as { state?: unknown } | null | undefined)?.state;
      const text = statefulValue(value);
      return {
        name: spec.name,
        state: typeof state === "string" ? state : "ABSENT",
        ...(text === undefined
          ? {}
          : { length: codePointLength(text), hash: textHash(text) }),
      };
    }
    case "text":
      return typeof value === "string" && value !== ""
        ? {
            name: spec.name,
            state: "VALUE",
            length: codePointLength(value),
            hash: textHash(value),
          }
        : absent;
    case "fact":
      return isPresent(value)
        ? { name: spec.name, state: "VALUE", value }
        : absent;
    case "array": {
      const items = arrayItems(value);
      return items.length === 0
        ? { ...absent, count: 0 }
        : {
            name: spec.name,
            state: "VALUE",
            count: items.length,
            hash: canonicalHash(items),
          };
    }
    case "group":
      return isPresent(value)
        ? { name: spec.name, state: "VALUE", hash: canonicalHash(value) }
        : absent;
  }
};

/** Past this a string is long: it travels by length and hash, and is windowed. */
export const INLINE_TEXT_CHARS = 200;

/** The rows that hold a stored link, by array field and key. */
const LINK_KEY_OF: Readonly<Record<string, string>> = {
  provenance: "sourceUrl",
  sourceCitations: "url",
  citations: "url",
};

// Whole words of a parameter's name. A harmless `?key=` link is withheld with the
// rest: it says so, and the Owner reads it in the Admin.
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "accesskey",
  "accesskeyid",
  "apikey",
  "auth",
  "authkey",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "hmac",
  "jsessionid",
  "jwt",
  "key",
  "pass",
  "passwd",
  "password",
  "phpsessid",
  "pwd",
  "secret",
  "session",
  "sessionid",
  "sig",
  "sign",
  "signature",
  "ticket",
  "token",
]);

const namesCredential = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => CREDENTIAL_WORDS.has(word));

/**
 * Userinfo, or a query parameter naming a credential or a signature. Stored links were
 * imported as they stood, so one with no scheme is read too, and one that cannot be
 * read at all is not assumed clean.
 */
export const linkCarriesCredential = (link: string): boolean => {
  if (/^[^/?#]*:[^/?#]*@/u.test(link)) return true;
  let url: URL;
  try {
    url = new URL(link, "https://relative.invalid/");
  } catch {
    return true;
  }
  return (
    url.username !== "" ||
    url.password !== "" ||
    [...new URLSearchParams(url.search.replaceAll(";", "&")).keys()].some(
      namesCredential,
    )
  );
};

const WITHHELD = "WITHHELD";

/** How `meta.excluded` names a link that does not leave. */
export const CREDENTIAL_URL = "credential_url";

const isWithheldLink = (fieldName: string, key: string, value: unknown) =>
  LINK_KEY_OF[fieldName] === key &&
  typeof value === "string" &&
  linkCarriesCredential(value);

const boundedItem = (
  fieldName: string,
  index: number,
  item: Record<string, unknown>,
) =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      isWithheldLink(fieldName, key, value)
        ? { state: WITHHELD }
        : typeof value === "string" &&
            codePointLength(value) > INLINE_TEXT_CHARS
          ? {
              length: codePointLength(value),
              hash: textHash(value),
              windowed: `${fieldName}.${index}.${key}`,
            }
          : value,
    ]),
  );

/** Whether view=full of this field has a link it does not give. */
export const holdsWithheldLink = (
  spec: FieldSpec,
  doc: RecordDocument,
): boolean =>
  spec.kind === "array" &&
  arrayItems(doc[spec.name]).some((item) =>
    Object.entries(item).some(([key, value]) =>
      isWithheldLink(spec.name, key, value),
    ),
  );

/** One field with its value when short: view=full. Whole rows, so a cut drops a row. */
export const fullFieldOf = (
  spec: FieldSpec,
  doc: RecordDocument,
): AdminFieldFacts => {
  const facts = factsOf(spec, doc);
  const value = doc[spec.name];
  if (spec.kind === "array")
    return facts.count === 0
      ? facts
      : {
          ...facts,
          value: arrayItems(value).map((item, index) =>
            boundedItem(spec.name, index, item),
          ),
        };
  if (spec.kind === "group")
    return facts.state === "ABSENT" ? facts : { ...facts, value };
  if (spec.kind === "fact") return facts;
  const text = spec.kind === "stateful" ? statefulValue(value) : value;
  if (typeof text !== "string" || text === "") return facts;
  return (facts.length ?? 0) > INLINE_TEXT_CHARS
    ? { ...facts, windowed: true }
    : { ...facts, value: text };
};

export type FieldText =
  | { readonly found: false }
  | { readonly found: true; readonly withheld: true }
  | {
      readonly found: true;
      readonly withheld?: never;
      readonly state: string;
      readonly text: string;
    };

/**
 * The text behind a field name: a text field, a stateful field's value, a short fact,
 * or a string inside an array row as `sections.2.body`. Anything else is not text to
 * window.
 */
export const fieldTextOf = (
  family: CmsFamily,
  doc: RecordDocument,
  name: string,
): FieldText => {
  const [head, index, leaf, ...rest] = name.split(".");
  const spec = family.fields.find((field) => field.name === head);
  if (spec === undefined || rest.length > 0) return { found: false };
  const value = doc[spec.name];
  if (index === undefined) {
    if (spec.kind === "stateful") {
      const state = (value as { state?: unknown } | null | undefined)?.state;
      return {
        found: true,
        state: typeof state === "string" ? state : "ABSENT",
        text: statefulValue(value) ?? "",
      };
    }
    if (spec.kind !== "text" && spec.kind !== "fact") return { found: false };
    if (typeof value === "string")
      return { found: true, state: "VALUE", text: value };
    // A number or a row id: the same value the outline shows, as text.
    return isPresent(value)
      ? { found: true, state: "VALUE", text: JSON.stringify(value) }
      : { found: true, state: "ABSENT", text: "" };
  }
  if (spec.kind !== "array" || leaf === undefined || !/^\d+$/u.test(index))
    return { found: false };
  const item = arrayItems(value)[Number(index)];
  const text = item?.[leaf];
  if (typeof text !== "string") return { found: false };
  return isWithheldLink(spec.name, leaf, text)
    ? { found: true, withheld: true }
    : { found: true, state: "VALUE", text };
};

/** Fields whose state, length or hash differ between two versions of one record. */
export const changedFieldsBetween = (
  family: CmsFamily,
  from: RecordDocument | undefined,
  to: RecordDocument,
): readonly FieldSpec[] =>
  family.fields.filter(
    (spec) =>
      JSON.stringify(factsOf(spec, from ?? {})) !==
      JSON.stringify(factsOf(spec, to)),
  );

/** Where two texts first differ, in code points, so a correction needs no paging. */
export const firstDifferenceOffset = (from: string, to: string): number => {
  const left = Array.from(from);
  const right = Array.from(to);
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  return index;
};

/** A record's fingerprint, or null where stored content no longer parses. */
export const fingerprintOf = (
  family: CmsFamily,
  doc: RecordDocument,
): string | null => {
  try {
    return family.fingerprint(doc);
  } catch {
    return null;
  }
};
