import { z } from "zod";

import { operatorWorksQuerySchema } from "../community-operator/content-schemas.js";
import { operatorCommentQuerySchema } from "../community-operator/schemas.js";
import { isWellFormedEditorialText } from "../editorial/schemas.js";
import { ANALYTICS_RANGE_PRESETS } from "./analytics.js";

/**
 * admin_find, admin_get, admin_read and admin_view_media
 * (admin-mcp-completion-v1 sections 5, 6 and 10). Server-only, like the envelope:
 * nothing here is a Public DTO or appears in the OpenAPI document.
 */

/** Read in Admin on the Local API. */
export const ADMIN_CMS_RECORD_TYPES = [
  "catalog",
  "article",
  "collection",
  "media",
] as const;

/** Read through the Backend's AI routes, which a later slice builds. */
export const ADMIN_COMMUNITY_RECORD_TYPES = [
  "user",
  "work",
  "comment",
  "thread",
  "report",
  "feedback",
  "publishing_job",
  "work_revision",
  "media_item",
  "invitation",
] as const;

export const adminRecordTypeSchema = z.enum([
  ...ADMIN_CMS_RECORD_TYPES,
  ...ADMIN_COMMUNITY_RECORD_TYPES,
]);

/** A number is the record's row id; a string is its public identity. */
const recordId = z.union([
  z.number().int().positive(),
  z.string().min(1).max(128),
]);

export const adminRecordRefSchema = z.strictObject({
  type: adminRecordTypeSchema,
  id: recordId,
});

/** Prefilled, so acting on a found record needs no second look at the schema. */
export const adminActionSkeletonSchema = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

export const adminLockSchema = z.strictObject({
  held: z.boolean(),
  by: z.enum(["owner", "ai", "automation"]).optional(),
  /** With lastEditedAt, what document.lock_takeover sends back as `expected`. */
  lockId: z.number().int().positive().optional(),
  holderUserId: z.number().int().positive().optional(),
  lastEditedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

/** Only `identity` can make a hit unique: t2s, s2t and trigram merge distinct records. */
export const ADMIN_MATCH_KINDS = [
  "identity",
  "raw",
  "t2s",
  "s2t",
  "trigram",
] as const;

/** How far a search pages. Past it the answer says so, and the query needs narrowing. */
export const ADMIN_FIND_SKIP_MAX = 200;

export const adminFindInputSchema = z.strictObject({
  /** PostgreSQL text cannot hold a NUL, so no record can match one. */
  query: z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => !value.includes("\u0000")),
  type: adminRecordTypeSchema.optional(),
  limit: z.number().int().min(1).max(25).optional(),
  /** How many candidates a cut or paged answer already gave. */
  skip: z.number().int().min(0).max(ADMIN_FIND_SKIP_MAX).optional(),
});

/**
 * `draft_over_published` is a live record with a newer draft: `state` always says
 * what the public sees and whether more is waiting, in one word.
 */
export const ADMIN_RECORD_STATES = [
  "draft",
  "published",
  "draft_over_published",
  "registered",
] as const;
const recordState = z.enum(ADMIN_RECORD_STATES);

export const adminFindItemSchema = z.strictObject({
  type: adminRecordTypeSchema,
  id: recordId,
  title: z.string().optional(),
  /** A CMS record's one word, or a community record's own state as it stands. */
  state: z.string().min(1).optional(),
  updatedAt: z.string().optional(),
  version: z.number().optional(),
  lock: adminLockSchema.optional(),
  /** Near-twin records differ here, so telling them apart needs no second read. */
  disambiguators: z.record(z.string(), z.unknown()),
  match: z.strictObject({
    field: z.string().min(1),
    kind: z.enum(ADMIN_MATCH_KINDS),
    offset: z.number().int().nonnegative().optional(),
    snippet: z.string().optional(),
  }),
  /** Exact only, and relative. */
  adminPath: z.string().startsWith("/").optional(),
  /** On a candidate, exactly one admin_get: never a mutation. */
  actions: z.array(adminActionSkeletonSchema).optional(),
});

export const adminFindDataSchema = z.strictObject({
  resolution: z.strictObject({
    status: z.enum(["exact", "candidates", "none"]),
    uniqueIdentity: z.boolean(),
    /** Use this for a mutation, never the first candidate. */
    ref: adminRecordRefSchema.optional(),
  }),
  items: z.array(adminFindItemSchema),
  /** The image a pasted viewer link pointed at, beside the record it belongs to. */
  focus: z.strictObject({ mediaId: z.string().min(1) }).optional(),
});

export const ADMIN_GET_VIEWS = [
  "outline",
  "full",
  "field",
  "published",
  "preview",
  "history",
  "diff",
] as const;

/** Code points of context a find returns either side of a match. */
export const ADMIN_FIND_CONTEXT_MAX = 200;

/** A version id, the current draft, or the live record. */
const versionReference = z.union([
  z.number().int().positive(),
  z.enum(["draft", "published"]),
]);

export const adminGetInputSchema = z.strictObject({
  type: adminRecordTypeSchema,
  id: recordId,
  view: z.enum(ADMIN_GET_VIEWS).optional(),
  fields: z.array(z.string().min(1).max(64)).min(1).max(40).optional(),
  field: z.string().min(1).max(64).optional(),
  offset: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
  find: z
    .strictObject({
      /** Half a character would match inside a whole one, and report it whole. */
      text: z.string().min(1).max(2_000).refine(isWellFormedEditorialText),
      mode: z.enum(["raw", "normalized"]).optional(),
      context: z.number().int().min(0).max(ADMIN_FIND_CONTEXT_MAX).optional(),
    })
    .optional(),
  from: versionReference.optional(),
  to: versionReference.optional(),
  /** history only: continue below this version id. */
  cursor: z.number().int().positive().optional(),
});

/** Every field of a record, by state, length and hash. No long text. */
export const adminFieldFactsSchema = z.strictObject({
  name: z.string().min(1),
  state: z.string().min(1),
  /** In code points, the unit of every offset here. */
  length: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  /** Identity and short facts, and everything short enough under view=full. */
  value: z.unknown().optional(),
  /** Set when the text is long: read it through view=field. */
  windowed: z.literal(true).optional(),
});

export const adminRenderSchema = z.union([
  z.strictObject({
    renderAvailable: z.literal(true),
    /** For the Owner to open: relative, and no key opens it. */
    renderPath: z.string().startsWith("/"),
  }),
  z.strictObject({
    renderAvailable: z.literal(false),
    reason: z.enum([
      "NO_PREVIEW_PAGE",
      "PREVIEW_ORIGIN_NOT_CONFIGURED",
      "PREVIEW_HOST_MISMATCH",
      "PREVIEW_INCOMPLETE",
    ]),
  }),
]);

export const adminGetDataSchema = z
  .object({
    type: adminRecordTypeSchema,
    id: z.number().int().positive(),
    view: z.enum(ADMIN_GET_VIEWS),
    /**
     * Which version this answer read: a read with no draft flag gets the live row.
     * `version` is one named past version, on a diff `to`.
     */
    readFrom: z.enum(["draft", "published", "live", "version"]),
    state: recordState,
    revision: z.number().nullable(),
    fingerprint: z.string().nullable(),
    publishedRevision: z.number().nullable(),
    hasUnpublishedChanges: z.boolean(),
    title: z.string().optional(),
    updatedAt: z.string().optional(),
    lock: adminLockSchema.optional(),
    adminPath: z.string().startsWith("/"),
    actions: z.array(adminActionSkeletonSchema).optional(),
  })
  .loose();

/**
 * A community record has no draft, version history or render: only what is there now,
 * read through the Backend's AI routes. Its id is its public identity.
 */
export const ADMIN_COMMUNITY_GET_VIEWS = ["outline", "full", "field"] as const;

export const adminCommunityGetDataSchema = z
  .object({
    type: adminRecordTypeSchema,
    id: z.string().min(1),
    view: z.enum(ADMIN_COMMUNITY_GET_VIEWS),
    readFrom: z.literal("live"),
    state: z.string().min(1),
    version: z.number().optional(),
    title: z.string().optional(),
    updatedAt: z.string().optional(),
    actions: z.array(adminActionSkeletonSchema).optional(),
  })
  .loose();

export const ADMIN_READ_VIEWS = ["compact", "full", "count"] as const;

export const ADMIN_READ_PAGE_SIZE_MAX = 100;

export const adminReadInputSchema = z.strictObject({
  op: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().min(1).max(64).optional(),
  pageSize: z.number().int().min(1).max(ADMIN_READ_PAGE_SIZE_MAX).optional(),
  view: z.enum(ADMIN_READ_VIEWS).optional(),
  fields: z.array(z.string().min(1).max(64)).min(1).max(40).optional(),
  groupBy: z.string().min(1).max(64).optional(),
});

/** Whichever version is latest decides: a live record with a newer draft is a draft. */
const statusFilter = z.enum(["draft", "published", "all"]);

/** Fields `missing` accepts: every stateful text, and the plain optional ones. */
export const ADMIN_CATALOG_MISSING_FIELDS = [
  "dynasty",
  "dateText",
  "province",
  "prefecture",
  "county",
  "currentLocation",
  "currentCustodian",
  "description",
  "scriptStyle",
  "transcription",
  "historicalContext",
  "scholarlyResearch",
  "title",
  "summary",
  "periodLabel",
] as const;

const filterOf = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject({ filter: z.strictObject(shape).optional() });

const exactValue = z.string().min(1).max(500);

export const adminCatalogListInputSchema = filterOf({
  status: statusFilter.optional(),
  missing: z.array(z.enum(ADMIN_CATALOG_MISSING_FIELDS)).min(1).optional(),
  kind: z.enum(["inscription", "calligraphy"]).optional(),
  dynasty: exactValue.optional(),
  province: exactValue.optional(),
});

export const adminArticleListInputSchema = filterOf({
  status: statusFilter.optional(),
  presentation: z.enum(["news", "academic"]).optional(),
});

export const adminCollectionListInputSchema = filterOf({
  status: statusFilter.optional(),
  category: exactValue.optional(),
});

export const adminMediaListInputSchema = filterOf({
  catalogId: exactValue.optional(),
  origin: z.enum(["upload", "existing"]).optional(),
});

export const adminApprovalListInputSchema = filterOf({
  status: z.enum(["active", "revoked"]).optional(),
});

export const adminReceiptListInputSchema = filterOf({
  status: z.enum(["completed", "rejected"]).optional(),
  operation: z
    .enum([
      "save-draft",
      "publish-approved",
      "approve-batch",
      "approve-article-batch",
      "publish-direct",
      "withdraw",
      "restore-draft",
      "patch-text",
      "duplicate",
      "article-publish",
      "article-withdraw",
      "article-restore",
      "article-duplicate",
      "collection-save",
      "collection-publish",
      "collection-withdraw",
      "collection-restore",
      "collection-duplicate",
    ])
    .optional(),
});

/**
 * A queue's time filter takes a named range too, in Asia/Shanghai, and the answer
 * echoes the instants it resolved to. `last_N_days` are N finished days.
 */
const namedRange = {
  range: z
    .enum(ANALYTICS_RANGE_PRESETS)
    .describe(
      "A range that ends before now holds finished days in Asia/Shanghai, so today is not in it. To reach now, send from with no to.",
    )
    .optional(),
};
const rangeOrDates = ({
  range,
  from,
  to,
}: {
  readonly range?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}) => range === undefined || (from === undefined && to === undefined);

export const adminCommentListInputSchema = operatorCommentQuerySchema
  .safeExtend(namedRange)
  .refine(rangeOrDates);

export const adminWorkListInputSchema = operatorWorksQuerySchema
  .safeExtend(namedRange)
  .refine(rangeOrDates);

export const adminReadRowsDataSchema = z.strictObject({
  rows: z.array(z.record(z.string(), z.unknown())),
  /** What the filter resolved to, so a default never reads as the whole table. */
  filter: z.record(z.string(), z.unknown()),
  /** On a source that counts its rows: no page number, because `next` is the way on. */
  total: z.number().int().nonnegative().optional(),
  /** What a page says beyond its rows, such as a queue's tab counts. */
  about: z.record(z.string(), z.unknown()).optional(),
});

export const adminReadCountDataSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  filter: z.record(z.string(), z.unknown()),
  /** How long the longest waiter has waited, where the source can say. */
  oldestAt: z.string().nullable().optional(),
  groupBy: z.string().optional(),
  /** A non-VALUE state keeps its own row: unknown never reads as a dynasty. */
  groups: z
    .array(
      z.strictObject({
        value: z.string().nullable(),
        state: z.string().optional(),
        count: z.number().int().positive(),
        oldestAt: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export const ADMIN_VIEW_MEDIA_MAX_BYTES = 512 * 1024;
export const ADMIN_VIEW_MEDIA_MAX_EDGE = 2_048;

export const adminMediaRegionSchema = z.strictObject({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const adminViewMediaInputSchema = z.strictObject({
  kind: z.enum(["catalog_thumb", "catalog_original"]),
  /** PostgreSQL text cannot hold a NUL, so no record can match one. */
  mediaId: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !value.includes("\u0000")),
  maxEdge: z.number().int().min(64).max(ADMIN_VIEW_MEDIA_MAX_EDGE).optional(),
  /** In the pixels of what is viewed; required for catalog_original. */
  region: adminMediaRegionSchema.optional(),
});

export const adminViewMediaDataSchema = z.strictObject({
  kind: z.enum(["catalog_thumb", "catalog_original"]),
  mediaId: z.string().min(1),
  original: z.strictObject({
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
  rendered: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive().max(ADMIN_VIEW_MEDIA_MAX_BYTES),
    format: z.literal("webp"),
  }),
  region: adminMediaRegionSchema.optional(),
});

export type AdminRecordType = z.infer<typeof adminRecordTypeSchema>;
export type AdminCmsRecordType = (typeof ADMIN_CMS_RECORD_TYPES)[number];
export type AdminCommunityRecordType =
  (typeof ADMIN_COMMUNITY_RECORD_TYPES)[number];
export type AdminRecordRef = z.infer<typeof adminRecordRefSchema>;
export type AdminActionSkeleton = z.infer<typeof adminActionSkeletonSchema>;
export type AdminLock = z.infer<typeof adminLockSchema>;
export type AdminRecordState = (typeof ADMIN_RECORD_STATES)[number];
export type AdminMatchKind = (typeof ADMIN_MATCH_KINDS)[number];
export type AdminFindInput = z.infer<typeof adminFindInputSchema>;
export type AdminFindItem = z.infer<typeof adminFindItemSchema>;
export type AdminFindData = z.infer<typeof adminFindDataSchema>;
export type AdminGetView = (typeof ADMIN_GET_VIEWS)[number];
export type AdminGetInput = z.infer<typeof adminGetInputSchema>;
export type AdminFieldFacts = z.infer<typeof adminFieldFactsSchema>;
export type AdminRender = z.infer<typeof adminRenderSchema>;
export type AdminReadInput = z.infer<typeof adminReadInputSchema>;
export type AdminReadView = (typeof ADMIN_READ_VIEWS)[number];
export type AdminMediaRegion = z.infer<typeof adminMediaRegionSchema>;
export type AdminViewMediaInput = z.infer<typeof adminViewMediaInputSchema>;
export type AdminViewMediaData = z.infer<typeof adminViewMediaDataSchema>;
