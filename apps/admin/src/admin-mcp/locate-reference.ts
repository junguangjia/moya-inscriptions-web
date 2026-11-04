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
  | { readonly kind: "sha256"; readonly value: string }
  | { readonly kind: "uuid"; readonly value: string }
  | { readonly kind: "text"; readonly text: string };

export interface ClassifiedQuery {
  readonly references: readonly LocateReference[];
  /** Categories this query named and no search will read. */
  readonly excluded: readonly string[];
  /** The image of a viewer link, beside the record it belongs to. */
  readonly focusMediaId?: string;
  /** A link names records: a miss is a miss, never a text search for its URL. */
  readonly link: boolean;
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
    return { kind: "sha256", value: value.toLowerCase() };
  if (UUID_SHAPE.test(value))
    return { kind: "uuid", value: value.toLowerCase() };
  if (DIGITS_SHAPE.test(value))
    return { kind: "digits", value, id: Number(value) };
  return { kind: "token", value };
};

const asLink = (text: string): URL | undefined => {
  const looksLikeLink =
    /^https?:\/\//iu.test(text) ||
    text.startsWith("/") ||
    text.startsWith("?") ||
    text.startsWith("#");
  if (!looksLikeLink || WHITESPACE.test(text)) return undefined;
  try {
    // Only path, query and hash are read, so the base is never compared to anything.
    return new URL(text, "http://link.invalid");
  } catch {
    return undefined;
  }
};

const decoded = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const fromPath = (pathname: string): readonly LocateReference[] => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "catalog" && segments.length === 2) {
    const value = decoded(segments[1]!);
    return value === undefined || value.length > 128
      ? []
      : [{ kind: "identity", type: "catalog", field: "catalogId", value }];
  }
  if (segments[0] === "admin" && segments[1] === "collections") {
    const type = ADMIN_COLLECTIONS[segments[2] ?? ""];
    const id = segments[3] ?? "";
    if (type !== undefined && DIGITS_SHAPE.test(id))
      return [{ kind: "row", type, id: Number(id) }];
  }
  return [];
};

const classifyLink = (url: URL): ClassifiedQuery => {
  const references: LocateReference[] = [...fromPath(url.pathname)];
  const excluded = new Set<string>();
  let focusMediaId: string | undefined;
  for (const [name, value] of url.searchParams) {
    const exclusion = LINK_PARAMETER_EXCLUSIONS[name];
    if (exclusion !== undefined) {
      excluded.add(exclusion);
      continue;
    }
    const rule = LINK_PARAMETER_RULES[name];
    if (rule === undefined || value.length === 0 || value.length > 128)
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
    const value = decoded(topic[1]!);
    if (value !== undefined)
      references.push({ kind: "community", type: "thread", value });
  }
  // A viewer link with no record names only its image.
  if (focusMediaId !== undefined && references.length === 0)
    references.push(referenceOfId(focusMediaId));
  return {
    references,
    excluded: [...excluded],
    ...(focusMediaId === undefined ? {} : { focusMediaId }),
    link: true,
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
  if (link !== undefined) return classifyLink(link);
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
