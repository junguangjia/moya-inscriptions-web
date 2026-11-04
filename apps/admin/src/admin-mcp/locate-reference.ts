import type {
  AdminCmsRecordType,
  AdminCommunityRecordType,
} from "@moya/contracts/internal/admin-mcp";

/**
 * Step 1 of locate (admin-mcp-completion-v1 section 6): what a pasted reference is,
 * with no I/O. A link gives its path and query only; a domain is never compared, so
 * a link from any host resolves the same way.
 */

export type LocateReference =
  | {
      /** A row id, from an Admin path. */
      readonly kind: "row";
      readonly type: AdminCmsRecordType;
      readonly id: number;
    }
  | {
      /** A public identity on one family, from a prefix or a link parameter. */
      readonly kind: "identity";
      readonly type: AdminCmsRecordType;
      readonly field: string;
      readonly value: string;
    }
  | {
      /** Lives in the community database. `article` is on both sides. */
      readonly kind: "community";
      readonly type: AdminCommunityRecordType | "article";
      readonly value: string;
    }
  | { readonly kind: "handle"; readonly handle: string }
  /** No prefix, no spaces: a catalogId, a sourceId or a mediaId, else search text. */
  | { readonly kind: "token"; readonly value: string }
  /** Digits name a row in every family, and can be a catalogId too. */
  | { readonly kind: "digits"; readonly value: string; readonly id: number }
  /** `value` in lower case, as media stores it; a Catalog identity is as `typed`. */
  | { readonly kind: "sha256"; readonly value: string; readonly typed: string }
  | { readonly kind: "uuid"; readonly value: string; readonly typed: string }
  | { readonly kind: "text"; readonly text: string };

export interface ClassifiedQuery {
  readonly references: readonly LocateReference[];
  /** Categories this query named and no search will read. */
  readonly excluded: readonly string[];
  /** The image of a viewer link, beside the record it belongs to. */
  readonly focusMediaId?: string;
  /** A link names records: a miss is a miss, never a text search for its URL. */
  readonly link: boolean;
  /** A known link with no scheme, as typed: a record can hold it as its own identity. */
  readonly literal?: string;
}

type LinkRule =
  | { readonly record: AdminCmsRecordType; readonly field: string }
  | { readonly community: AdminCommunityRecordType }
  | { readonly communityToo: "article"; readonly record: "article" }
  | { readonly focus: true };

/**
 * Every query parameter a public link carries. A test reads the names from
 * apps/web/features/product-shell/product-history.ts and fails on one with neither a
 * rule here nor a stated exclusion below. `topic` is what Reporting links carry.
 */
export const LINK_PARAMETER_RULES: Readonly<Record<string, LinkRule>> = {
  catalogId: { record: "catalog", field: "catalogId" },
  articleId: { communityToo: "article", record: "article" },
  workId: { community: "work" },
  authorId: { community: "user" },
  topic: { community: "thread" },
  image: { focus: true },
};

/** `draftId` is private: a draft's id stays in history state and is never searched. */
export const LINK_PARAMETER_EXCLUSIONS: Readonly<Record<string, string>> = {
  draftId: "private_draft",
};

const HEX32 = "[0-9a-f]{32}";
const COMMUNITY_SHAPES: readonly (readonly [
  RegExp,
  AdminCommunityRecordType,
])[] = [
  [new RegExp(`^user-${HEX32}$`, "u"), "user"],
  [new RegExp(`^work-${HEX32}$`, "u"), "work"],
  [new RegExp(`^comment-${HEX32}$`, "u"), "comment"],
  [new RegExp(`^thread-${HEX32}$`, "u"), "thread"],
  [new RegExp(`^feedback-${HEX32}$`, "u"), "feedback"],
  [new RegExp(`^report-${HEX32}$`, "u"), "report"],
  [new RegExp(`^publishing-job-${HEX32}$`, "u"), "publishing_job"],
  [new RegExp(`^work-revision-${HEX32}$`, "u"), "work_revision"],
  [new RegExp(`^media-item-${HEX32}$`, "u"), "media_item"],
  [new RegExp(`^invitation-${HEX32}$`, "u"), "invitation"],
];
const ARTICLE_SHAPE = new RegExp(`^article-${HEX32}$`, "u");
const COLLECTION_SHAPE = new RegExp(`^collection-${HEX32}$`, "u");
const WORK_DRAFT_SHAPE = new RegExp(`^work-draft-${HEX32}$`, "u");
const MEDIA_SHAPE = /^media-[A-Za-z0-9._-]{1,120}$/u;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_SHAPE = /^[0-9a-f]{64}$/iu;
const HANDLE_SHAPE = /^@[A-Za-z0-9_.-]{1,64}$/u;
const DIGITS_SHAPE = /^[1-9]\d{0,15}$/u;
const WHITESPACE = /\s/u;

/** Direct messages are never searched, in any shape, on any switch. */
const isDirectMessageId = (value: string) => /^dm(?:sg)?-/iu.test(value);

/** Admin collection paths that name one record. */
const ADMIN_COLLECTIONS: Readonly<Record<string, AdminCmsRecordType>> = {
  catalogs: "catalog",
  articles: "article",
  "article-collections": "collection",
  media: "media",
};

/** A pasted name is any text: `constructor` is on every object, and no rule. */
const own = <T>(table: Readonly<Record<string, T>>, name: string) =>
  Object.hasOwn(table, name) ? table[name] : undefined;

const notExcluded = (references: readonly LocateReference[]) => ({
  references,
  excluded: [],
  link: false,
});

/** Whatever an id looks like on its own, whether pasted bare or read from a link. */
const referenceOfId = (value: string): LocateReference => {
  for (const [shape, type] of COMMUNITY_SHAPES)
    if (shape.test(value)) return { kind: "community", type, value };
  if (ARTICLE_SHAPE.test(value))
    return { kind: "identity", type: "article", field: "articleId", value };
  if (COLLECTION_SHAPE.test(value))
    return {
      kind: "identity",
      type: "collection",
      field: "collectionId",
      value,
    };
  if (MEDIA_SHAPE.test(value))
    return { kind: "identity", type: "media", field: "mediaId", value };
  if (SHA256_SHAPE.test(value))
    return { kind: "sha256", value: value.toLowerCase(), typed: value };
  if (UUID_SHAPE.test(value))
    return { kind: "uuid", value: value.toLowerCase(), typed: value };
  if (DIGITS_SHAPE.test(value))
    return { kind: "digits", value, id: Number(value) };
  return { kind: "token", value };
};

/** A host with no scheme ahead of a path or query, as copied from an address bar. */
const BARE_HOST =
  /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?=[/?#])/u;

/**
 * `certain` is a link whatever it names. Anything else that could be one, a leading
 * `/` or `#` or a bare host, is also legal text and a legal sourceId, so it is read
 * as a link only once it names something a link can.
 */
const asLink = (
  text: string,
): { readonly url: URL; readonly certain: boolean } | undefined => {
  if (WHITESPACE.test(text)) return undefined;
  const certain = /^https?:\/\//iu.test(text) || text.startsWith("?");
  const address =
    certain || text.startsWith("/") || text.startsWith("#")
      ? text
      : BARE_HOST.test(text)
        ? `http://${text}`
        : undefined;
  if (address === undefined) return undefined;
  try {
    // Only path, query and hash are read, so the base is never compared to anything.
    return { url: new URL(address, "http://link.invalid"), certain };
  } catch {
    return undefined;
  }
};

/** PostgreSQL text cannot hold a NUL, so a value carrying one names no record. */
const decoded = (segment: string): string | undefined => {
  try {
    const value = decodeURIComponent(segment);
    return value.includes("\u0000") ? undefined : value;
  } catch {
    return undefined;
  }
};

/** What a path names, which can be nothing readable; undefined is no link we know. */
const fromPath = (pathname: string): readonly LocateReference[] | undefined => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "catalog" && segments.length >= 2) {
    const value = decoded(segments[1]!);
    return value === undefined || value.length > 128
      ? []
      : [{ kind: "identity", type: "catalog", field: "catalogId", value }];
  }
  // What admin_get view=preview gives as renderPath, on the Catalog's row id.
  if (segments[0] === "editorial-preview" && segments.length >= 2)
    return DIGITS_SHAPE.test(segments[1]!)
      ? [{ kind: "row", type: "catalog", id: Number(segments[1]) }]
      : [];
  if (segments[0] === "admin") {
    const type =
      segments[1] === "collections"
        ? own(ADMIN_COLLECTIONS, segments[2] ?? "")
        : undefined;
    const id = segments[3] ?? "";
    return type !== undefined && DIGITS_SHAPE.test(id)
      ? [{ kind: "row", type, id: Number(id) }]
      : [];
  }
  return undefined;
};

/** A value named twice, by a path and a parameter, is one reference. */
const distinctReferences = (references: readonly LocateReference[]) => [
  ...new Map(
    references.map((reference) => [JSON.stringify(reference), reference]),
  ).values(),
];

const classifyLink = (
  url: URL,
): ClassifiedQuery & { readonly known: boolean } => {
  const path = fromPath(url.pathname);
  const references: LocateReference[] = [...(path ?? [])];
  const excluded = new Set<string>();
  let focusMediaId: string | undefined;
  let known = path !== undefined;
  for (const [name, value] of url.searchParams) {
    const exclusion = own(LINK_PARAMETER_EXCLUSIONS, name);
    if (exclusion !== undefined) {
      known = true;
      excluded.add(exclusion);
      continue;
    }
    const rule = own(LINK_PARAMETER_RULES, name);
    if (rule === undefined) continue;
    known = true;
    if (value.length === 0 || value.length > 128 || value.includes("\u0000"))
      continue;
    if (isDirectMessageId(value)) excluded.add("dm");
    else if (WORK_DRAFT_SHAPE.test(value)) excluded.add("private_draft");
    else if ("focus" in rule) focusMediaId = value;
    else if ("community" in rule)
      references.push({ kind: "community", type: rule.community, value });
    else if ("communityToo" in rule)
      references.push(
        {
          kind: "identity",
          type: rule.record,
          field: `${rule.record}Id`,
          value,
        },
        { kind: "community", type: rule.communityToo, value },
      );
    else
      references.push({
        kind: "identity",
        type: rule.record,
        field: rule.field,
        value,
      });
  }
  const topic = /^#topic-(.+)$/u.exec(url.hash);
  if (topic !== null) {
    known = true;
    const value = decoded(topic[1]!);
    if (value !== undefined)
      references.push({ kind: "community", type: "thread", value });
  }
  // A viewer link with no record names only its image.
  if (focusMediaId !== undefined && references.length === 0)
    references.push(referenceOfId(focusMediaId));
  return {
    references: distinctReferences(references),
    excluded: [...excluded],
    ...(focusMediaId === undefined ? {} : { focusMediaId }),
    link: true,
    known,
  };
};

export const classifyQuery = (query: string): ClassifiedQuery => {
  const text = query.trim();
  if (text.length === 0) return notExcluded([]);
  if (isDirectMessageId(text))
    return { references: [], excluded: ["dm"], link: false };
  if (WORK_DRAFT_SHAPE.test(text))
    return { references: [], excluded: ["private_draft"], link: false };
  const link = asLink(text);
  if (link !== undefined) {
    const { known, ...classified } = classifyLink(link.url);
    if (link.certain) return classified;
    if (known)
      return BARE_HOST.test(text) && text.length <= 128
        ? { ...classified, literal: text }
        : classified;
  }
  if (HANDLE_SHAPE.test(text))
    return notExcluded([{ kind: "handle", handle: text.slice(1) }]);
  if (WHITESPACE.test(text) || text.length > 128)
    return notExcluded([{ kind: "text", text }]);
  // An Article id is on both sides, however it arrives.
  return notExcluded([
    referenceOfId(text),
    ...(ARTICLE_SHAPE.test(text)
      ? [{ kind: "community" as const, type: "article" as const, value: text }]
      : []),
  ]);
};
