import {
  articleDocumentSchema,
  articleReferences,
} from "./article-authoring.ts";
import {
  studioNameDisplaySchema,
  studioNameSuffixSchema,
  refineStudioNameWrite,
} from "./auth-schemas.ts";
import { z } from "zod";
import {
  mentionReferencesSchema,
  validMentionReferences,
} from "./mention-references.ts";
export {
  mentionReferenceSchema,
  mentionReferencesSchema,
  validMentionReferences,
  normalizeMentionText,
  MENTION_LIMIT,
} from "./mention-references.ts";
import {
  addMediaRenditionAnchorIssues,
  cardMediaRenditionListSchema,
  mediaRenditionListSchema,
  placeholderColorSchema,
  publicMediaRenditionListSchema,
  resolvedMediaUrlSchema,
} from "./media-delivery.ts";
export {
  MEDIA_RENDITIONS_MAXIMUM,
  addMediaRenditionAnchorIssues,
  cardMediaRenditionListSchema,
  mediaRenditionContentTypeSchema,
  mediaRenditionListOf,
  mediaRenditionListSchema,
  mediaRenditionPathParts,
  mediaRenditionPathSchema,
  mediaRenditionSchema,
  placeholderColorSchema,
  publicMediaRenditionListSchema,
  publicMediaRenditionSchema,
  publishedMediaUrlSchema,
  renditionDimensionSchema,
  resolvedMediaUrlSchema,
  sameMediaFraming,
} from "./media-delivery.ts";

import {
  workAuthorshipSchema,
  workCoverSrcSchema,
  workMediaIdSchema,
  workMediaSchema,
  workVisibilitySchema,
} from "./work-publishing-schemas.ts";
import {
  WORK_EXCERPT_MAXIMUM,
  WORK_ITEMS_HARD_MAXIMUM,
  codePointLength,
} from "./work-publishing-text.ts";

// Explicit re-exports: bundlers resolving the `.js` specifiers to these
// TypeScript sources cannot enumerate a star re-export statically.
export {
  AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM,
  AUTHORSHIP_REFERENCE_TITLE_MAXIMUM,
  AUTHORSHIP_SOURCE_NOTE_MAXIMUM,
  DRAFT_TEXT_RAW_ALLOWANCE,
  WORK_BODY_MAXIMUM,
  WORK_EXCERPT_MAXIMUM,
  WORK_ITEMS_CONFIGURABLE_MAXIMUM,
  WORK_ITEMS_HARD_MAXIMUM,
  WORK_TITLE_MAXIMUM,
  checkPublishingBody,
  checkPublishingText,
  checkPublishingTitle,
  codePointLength,
  hasInvalidPublishingCharacters,
  normalizePublishingBody,
  normalizePublishingLineBreaks,
  normalizePublishingTitle,
  publishingBodyRule,
  publishingContentIssues,
  publishingTitleRule,
} from "./work-publishing-text.ts";
export type {
  PublishingContentInput,
  PublishingContentIssue,
  PublishingTextCheck,
  PublishingTextIssue,
  PublishingTextRule,
} from "./work-publishing-text.ts";
export {
  MEDIA_CROP_MINIMUM,
  MEDIA_METADATA_MAXIMUM_BYTES,
  PUBLISHING_DRAFT_CHANGED,
  PUBLISHING_MEDIA_PATH_PREFIX,
  createPublishingDraftCommandSchema,
  createPublishingSessionCommandSchema,
  editableWorkSchema,
  isEmptyWorkContent,
  legacyMediaSrcSchema,
  mediaClientPairingSchema,
  mediaClientSourceSchema,
  mediaComponentDeclarationSchema,
  mediaComponentIdSchema,
  mediaComponentRoleSchema,
  mediaComponentStateSchema,
  mediaContentTypeSchema,
  mediaCropSchema,
  mediaEditKeySchema,
  mediaEditSchema,
  mediaFailureCodeSchema,
  mediaItemIdSchema,
  mediaItemKindSchema,
  mediaItemStateSchema,
  mediaMetadataSchema,
  mediaPairingMethodSchema,
  mediaPresentationSchema,
  mediaProcessingProfileSchema,
  mediaQualityModeSchema,
  mediaRotationSchema,
  mediaUploadQualityModeSchema,
  mediaVariantSchema,
  openWorkEditDraftCommandSchema,
  publishingDeviceClassSchema,
  publishingDraftConflictSchema,
  publishingDraftDeletionCommandSchema,
  publishingDraftDeletionResultSchema,
  publishingDraftKindSchema,
  publishingDraftPageSchema,
  publishingDraftSaveResultSchema,
  publishingDraftSchema,
  publishingDraftSummarySchema,
  publishingHolderSchema,
  publishingLimitsSchema,
  publishingMediaComponentSchema,
  publishingMediaItemSchema,
  publishingMediaSourcesSchema,
  publishingMediaSrcSchema,
  publishingOpenedEditDraftSchema,
  publishingPageQuerySchema,
  publishingReadinessCommandSchema,
  publishingReadinessSchema,
  publishingSessionHeartbeatCommandSchema,
  publishingSessionIdSchema,
  publishingSessionSchema,
  publishingSessionStateSchema,
  publishingSnapshotPageSchema,
  publishingSnapshotSchema,
  publishingUploadResultSchema,
  registerMediaItemCommandSchema,
  resolvePublishingConflictCommandSchema,
  restorePublishingSnapshotCommandSchema,
  savePublishingDraftCommandSchema,
  standardComponentOutcomeSchema,
  storedPublishingTextSchema,
  workAuthorshipKindSchema,
  workAuthorshipSchema,
  workCoverSrcSchema,
  workDraftContentSchema,
  workDraftIdSchema,
  workDraftItemKeySchema,
  workDraftItemOriginSchema,
  workDraftItemSchema,
  workMediaIdSchema,
  workMediaSchema,
  workPublishingFailureCodeSchema,
  workRevisionIdSchema,
  workSnapshotIdSchema,
  workSnapshotKindSchema,
  workSubmissionCommandSchema,
  workSubmissionContentSchema,
  workSubmissionNotReadySchema,
  workSubmissionReceiptSchema,
  workSubmissionResultSchema,
  workVisibilityCommandSchema,
  workVisibilityResultSchema,
  workVisibilitySchema,
} from "./work-publishing-schemas.ts";
export type {
  CreatePublishingDraftCommand,
  CreatePublishingSessionCommand,
  EditableWork,
  MediaClientPairing,
  MediaClientSource,
  MediaComponentDeclaration,
  MediaComponentRole,
  MediaComponentState,
  MediaContentType,
  MediaCrop,
  MediaEdit,
  MediaFailureCode,
  MediaItemKind,
  MediaItemState,
  MediaMetadata,
  MediaPairingMethod,
  MediaPresentation,
  MediaProcessingProfile,
  MediaQualityMode,
  MediaRotation,
  MediaUploadQualityMode,
  MediaVariant,
  OpenWorkEditDraftCommand,
  PublishingDeviceClass,
  PublishingDraft,
  PublishingDraftConflict,
  PublishingDraftDeletionCommand,
  PublishingDraftDeletionResult,
  PublishingDraftKind,
  PublishingDraftPage,
  PublishingDraftSaveResult,
  PublishingDraftSummary,
  PublishingHolder,
  PublishingLimits,
  PublishingMediaComponent,
  PublishingMediaItem,
  PublishingMediaSources,
  PublishingOpenedEditDraft,
  PublishingPageQuery,
  PublishingReadiness,
  PublishingReadinessCommand,
  PublishingSession,
  PublishingSessionState,
  PublishingSnapshot,
  PublishingSnapshotPage,
  PublishingUploadResult,
  RegisterMediaItemCommand,
  ResolvePublishingConflictCommand,
  RestorePublishingSnapshotCommand,
  SavePublishingDraftCommand,
  StandardComponentOutcome,
  WorkAuthorship,
  WorkAuthorshipKind,
  WorkDraftContent,
  WorkDraftItem,
  WorkDraftItemOrigin,
  WorkMedia,
  WorkPublishingFailureCode,
  WorkSnapshotKind,
  WorkSubmissionCommand,
  WorkSubmissionContent,
  WorkSubmissionNotReady,
  WorkSubmissionReceipt,
  WorkSubmissionResult,
  WorkVisibility,
  WorkVisibilityCommand,
  WorkVisibilityResult,
} from "./work-publishing-schemas.ts";

const exactTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), {
      message: "Leading or trailing whitespace is not allowed",
    });

const platformIdentitySchema = () => z.string().min(1).max(128).regex(/^\S+$/);

export const catalogIdSchema = platformIdentitySchema().brand<"CatalogId">();
export const mediaIdSchema = platformIdentitySchema().brand<"MediaId">();

export const catalogKindSchema = z.enum(["inscription", "calligraphy"]);

export const catalogContributorRoleSchema = z.enum([
  "textAuthor",
  "calligrapher",
]);

export const catalogContributorSchema = z.strictObject({
  name: exactTextSchema(500),
  role: catalogContributorRoleSchema,
});

export const catalogCitationScopeSchema = z.enum([
  "record",
  "description",
  "transcription",
  "historicalContext",
  "scholarlyResearch",
]);

const titleSchema = exactTextSchema(500);
const aliasSchema = exactTextSchema(500);
const summarySchema = exactTextSchema(2_000);
const displayLabelSchema = exactTextSchema(500);
const mediaAltSchema = exactTextSchema(2_000);

/**
 * `src`, `width` and `height` describe one complete image: the anchor of
 * `renditions` when present, else the legacy object. `placeholderColor` is
 * present only for an opaque image.
 */
export const publicMediaSchema = z
  .strictObject({
    id: mediaIdSchema,
    kind: z.literal("image"),
    src: resolvedMediaUrlSchema,
    alt: mediaAltSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    renditions: publicMediaRenditionListSchema.optional(),
    placeholderColor: placeholderColorSchema.optional(),
  })
  .superRefine((media, context) => {
    if (media.renditions !== undefined)
      addMediaRenditionAnchorIssues(media, media.renditions, context);
  });

export const publicSourceCitationSchema = z.strictObject({
  label: displayLabelSchema,
  citation: exactTextSchema(2_000).optional(),
  url: z.url().optional(),
  appliesTo: z
    .array(catalogCitationScopeSchema)
    .min(1)
    .max(5)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "Citation scopes must be unique",
    })
    .meta({ uniqueItems: true })
    .optional(),
});

export const catalogSummarySchema = z.strictObject({
  id: catalogIdSchema,
  kind: catalogKindSchema,
  title: titleSchema,
  aliases: z.array(aliasSchema),
  summary: summarySchema.optional(),
  periodLabel: exactTextSchema(200).optional(),
  /** Authoritative Catalog province; omitted when no value was supplied. */
  province: exactTextSchema(500).optional(),
  representativeMedia: publicMediaSchema.optional(),
});

export const catalogDetailSchema = z.strictObject({
  ...catalogSummarySchema.shape,
  dynasty: exactTextSchema(500).optional(),
  dateText: exactTextSchema(500).optional(),
  contributors: z
    .array(catalogContributorSchema)
    .min(1)
    .max(50)
    .refine(
      (contributors) => {
        const pairs = contributors.map(({ name, role }) =>
          JSON.stringify([name, role]),
        );

        return new Set(pairs).size === pairs.length;
      },
      { message: "Contributor name and role pairs must be unique" },
    )
    .meta({ uniqueItems: true })
    .optional(),
  scriptStyle: exactTextSchema(2_000).optional(),
  province: exactTextSchema(500).optional(),
  prefecture: exactTextSchema(500).optional(),
  county: exactTextSchema(500).optional(),
  currentLocation: exactTextSchema(500).optional(),
  currentCustodian: exactTextSchema(500).optional(),
  description: exactTextSchema(20_000).optional(),
  transcription: exactTextSchema(100_000).optional(),
  historicalContext: exactTextSchema(20_000).optional(),
  scholarlyResearch: exactTextSchema(20_000).optional(),
  sourceCitations: z.array(publicSourceCitationSchema),
  media: z.array(publicMediaSchema),
});

const positiveIntegerStringSchema = z
  .string()
  .max(16)
  .regex(/^[1-9]\d*$/);

const safePositiveIntegerStringSchema = positiveIntegerStringSchema.refine(
  (value) => Number.isSafeInteger(Number(value)),
  { message: "Value must be a safe positive integer" },
);

const catalogPageSizeStringSchema = safePositiveIntegerStringSchema.refine(
  (value) => Number(value) <= 100,
  { message: "pageSize must be less than or equal to 100" },
);

export const catalogListTransportQuerySchema = z.strictObject({
  kind: catalogKindSchema.optional(),
  page: safePositiveIntegerStringSchema.optional(),
  pageSize: catalogPageSizeStringSchema.optional(),
});

/** Strict transport boundary for endpoints that declare no query parameters. */
export const noQueryTransportSchema = z.strictObject({});

interface PageResult {
  readonly items: readonly unknown[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

/** The page invariants every paginated Public DTO shares. */
const checkPageInvariants = (
  result: PageResult,
  context: z.RefinementCtx,
): void => {
  const expectedTotalPages =
    result.total === 0 ? 0 : Math.ceil(result.total / result.pageSize);

  if (result.totalPages !== expectedTotalPages) {
    context.addIssue({
      code: "custom",
      path: ["totalPages"],
      message: "totalPages must equal ceil(total / pageSize), or 0 when empty",
    });
  }
  if (result.items.length > result.pageSize) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "items cannot exceed pageSize",
    });
  }
  if (result.items.length > result.total) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "items cannot exceed total",
    });
  }
  if (result.page > expectedTotalPages && result.items.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "an out-of-range page must have no items",
    });
  }
};

/** The fields every page DTO shares; the bound belongs to its operation. */
const pageShape = <Item extends z.ZodType>(
  itemSchema: Item,
  maximumPageSize: number,
) => ({
  items: z.array(itemSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(maximumPageSize),
  totalPages: z.number().int().min(0),
});

/** Builds a page DTO for one item schema. */
const pageSchema = <Item extends z.ZodType>(
  itemSchema: Item,
  maximumPageSize: number,
) =>
  z
    .strictObject(pageShape(itemSchema, maximumPageSize))
    .superRefine(checkPageInvariants);

export const catalogPageSchema = pageSchema(catalogSummarySchema, 100);

export const catalogSearchMatchKindSchema = z.enum([
  "title-exact",
  "alias-exact",
  "normalized-exact",
  "title-alias-partial",
  "structured",
  "body",
]);

export const catalogSearchTransportQuerySchema = z.strictObject({
  ...catalogListTransportQuerySchema.shape,
  q: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const code = character.charCodeAt(0);
          return (
            (code < 127 || code > 159) &&
            (code >= 32 || code === 9 || code === 10 || code === 13)
          );
        }),
      { message: "Query contains unsupported control characters" },
    )
    .refine((value) => value.trim().length > 0, {
      message: "Query must not be blank",
    }),
});

export const catalogSearchItemSchema = catalogSummarySchema.extend({
  matchKind: catalogSearchMatchKindSchema,
});

export const catalogSearchPageSchema = catalogPageSchema.safeExtend({
  items: z.array(catalogSearchItemSchema),
});

/** Opaque, platform-generated and immutable; never a provider id or handle. */
export const publicUserIdSchema =
  platformIdentitySchema().brand<"PublicUserId">();
/** System-assigned, normalized, bounded, no whitespace. */
export const publicUserHandleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,31}$/);
/** The rendered author name: bounded plain text, Chinese supported, duplicates allowed. */
export const publicUserDisplayNameSchema = exactTextSchema(40);

/** Returned only to the session owner; carries no status, timestamps or credential linkage. */
export const publicUserProfileSchema = z.strictObject({
  id: publicUserIdSchema,
  handle: publicUserHandleSchema,
  displayName: publicUserDisplayNameSchema,
  studioName: studioNameDisplaySchema.optional(),
});

/**
 * Development-only support operation between Web and the Backend; never
 * composed in Production. These runtime shapes live only on the server-only
 * `./schemas` subpath: they are not root Public DTO types and not OpenAPI.
 */
export const developmentSignInRequestSchema = z.strictObject({
  handle: publicUserHandleSchema,
});

/** Opaque bearer credential: 32 random bytes as base64url. Web moves it into the HttpOnly cookie. */
export const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The one-time grant handed to Web on Development sign-in; the token never appears anywhere else. */
export const developmentSessionSchema = z.strictObject({
  token: sessionTokenSchema,
  expiresAt: z.iso.datetime({ offset: false }),
  profile: publicUserProfileSchema,
});

/** Opaque, platform-generated comment identity; never a row serial. */
export const catalogCommentIdSchema =
  platformIdentitySchema().brand<"CatalogCommentId">();

/** The author shape embedded in every comment and reply; no avatar, no status. */
export const commentAuthorSchema = z.strictObject({
  id: publicUserIdSchema,
  displayName: publicUserDisplayNameSchema,
  studioName: studioNameDisplaySchema.optional(),
});

/**
 * Comment text is plain. Resolved mention references are separate from text; no rich text, links, media or attachments.
 * The bound is fixed by the Mission 2B Contract review and enforced by the
 * Backend; Web never relaxes it.
 */
export const COMMENT_TEXT_MAXIMUM = 1_000;
const commentTextSchema = exactTextSchema(COMMENT_TEXT_MAXIMUM);

export const catalogCommentReplySchema = z.strictObject({
  id: catalogCommentIdSchema,
  author: commentAuthorSchema,
  text: commentTextSchema,
  createdAt: z.iso.datetime({ offset: false }),
  /** PR #106's 回复 X： pointer; absent when the reply answers the root. */
  replyTo: commentAuthorSchema.optional(),
});

export const catalogCommentSchema = z.strictObject({
  id: catalogCommentIdSchema,
  catalogId: catalogIdSchema,
  author: commentAuthorSchema,
  text: commentTextSchema,
  createdAt: z.iso.datetime({ offset: false }),
  /** A bounded first page of visible replies, in server order. */
  replies: z.array(catalogCommentReplySchema),
  /**
   * The number of currently visible replies under this root: the hot score,
   * and what tells a reader whether load-more has anything left. Never a
   * fabricated or cached count.
   */
  replyTotal: z.number().int().min(0),
});

const COMMENT_PAGE_SIZE_MAXIMUM = 50;

/**
 * The small hot section at the top of the combined comment list (Owner scope
 * amendment 2026-09-12). Provisional defaults, adjustable by the Owner: at most
 * three visible roots, ranked by their number of currently visible replies,
 * positive scores only, ties broken by newer creation time then id.
 */
export const COMMENT_HOT_LIMIT = 3;

/**
 * One combined list: `hot` first, then `items` (the latest roots, newest
 * first). A root never appears in both. `hot` is populated only when the
 * request carries no `pinned` set; a load-more request pins the hot ids it
 * already holds, so the latest pages exclude exactly those.
 */
export const catalogCommentPageSchema = z
  .strictObject({
    hot: z.array(catalogCommentSchema).max(COMMENT_HOT_LIMIT),
    ...pageShape(catalogCommentSchema, COMMENT_PAGE_SIZE_MAXIMUM),
  })
  .superRefine(checkPageInvariants)
  .superRefine((listing, context) => {
    const hotIds = new Set(listing.hot.map((comment) => comment.id));
    if (hotIds.size !== listing.hot.length)
      context.addIssue({
        code: "custom",
        path: ["hot"],
        message: "hot comments must be distinct",
      });
    if (listing.items.some((comment) => hotIds.has(comment.id)))
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "a hot comment never repeats in the latest list",
      });
  });

/** The load-more page for one root comment's replies (support operation). */
export const catalogCommentReplyPageSchema = pageSchema(
  catalogCommentReplySchema,
  COMMENT_PAGE_SIZE_MAXIMUM,
);

const commentPageSizeStringSchema = safePositiveIntegerStringSchema.refine(
  (value) => Number(value) <= COMMENT_PAGE_SIZE_MAXIMUM,
  { message: "pageSize must be less than or equal to 50" },
);

export const catalogCommentTransportQuerySchema = z.strictObject({
  page: safePositiveIntegerStringSchema.optional(),
  pageSize: commentPageSizeStringSchema.optional(),
});

/**
 * Comma-separated hot ids a browsing sequence pins: at most COMMENT_HOT_LIMIT,
 * distinct, each a CatalogCommentId. Present on load-more requests only.
 */
const pinnedCommentIdsStringSchema = z
  .string()
  .min(1)
  .max((128 + 1) * COMMENT_HOT_LIMIT)
  .refine(
    (value) => {
      const ids = value.split(",");
      return (
        ids.length <= COMMENT_HOT_LIMIT &&
        new Set(ids).size === ids.length &&
        ids.every((id) => catalogCommentIdSchema.safeParse(id).success)
      );
    },
    { message: "pinned must list at most 3 distinct comment ids" },
  );

/** The root comment listing accepts the page query plus the pinned hot ids. */
export const catalogCommentListingTransportQuerySchema =
  catalogCommentTransportQuerySchema.safeExtend({
    pinned: pinnedCommentIdsStringSchema.optional(),
  });

export const createCatalogCommentRequestSchema = z
  .strictObject({
    text: commentTextSchema,
    mentions: mentionReferencesSchema.optional(),
  })
  .refine((value) => validMentionReferences(value.text, value.mentions ?? []), {
    message: "Invalid mention references",
  });

export const createCatalogCommentReplyRequestSchema = z
  .strictObject({
    text: commentTextSchema,
    /** Answers a sibling reply; the new reply stays a sibling under the same root. */
    replyTo: catalogCommentIdSchema.optional(),
    mentions: mentionReferencesSchema.optional(),
  })
  .refine((value) => validMentionReferences(value.text, value.mentions ?? []), {
    message: "Invalid mention references",
  });

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
});

/**
 * The Backend's answer to "may this session use the product right now".
 * `closed_beta` admits only explicitly approved accounts; `public` adds no
 * restriction. It carries no content and no account data.
 */
export const productAccessSchema = z.strictObject({
  mode: z.enum(["public", "closed_beta"]),
  access: z.enum(["granted", "sign_in_required", "restricted"]),
});

export const apiErrorCodeSchema = z.enum([
  "CONFLICT",
  "INVALID_QUERY",
  "INVALID_INPUT",
  "ITEM_NOT_FOUND",
  "UNAUTHENTICATED",
  "ACCESS_RESTRICTED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: exactTextSchema(500),
    requestId: exactTextSchema(200),
  }),
});

// Phase 4 public shapes. Operator commands and storage metadata never appear here.
const id = z.string().min(1).max(128).regex(/^\S+$/u);
const userId = z.string().regex(/^user-[0-9a-f]{32}$/u);
const workId = z.string().regex(/^work-[0-9a-f]{32}$/u);
const mediaId = z.string().regex(/^user-media-[0-9a-f]{32}$/u);
const requestId = z.string().uuid();
const version = z.number().int().nonnegative().max(2147483647);
const visibility = z.enum(["public", "private"]);
const authorText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (s) =>
        s === s.trim() && !s.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(s),
    );
export const contentIdentitySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("catalog"), id }),
  z.strictObject({ type: z.literal("work"), id: workId }),
]);
// content-community-completion-v1: the public Article identity and the
// discussion target that adds it to the two content identities.
export const articleIdSchema = z
  .string()
  .regex(/^article-[0-9a-f]{32}$/u)
  .brand<"ArticleId">();
export type ArticleId = z.infer<typeof articleIdSchema>;
/**
 * What a discussion may attach to: the existing Catalog and Work identities
 * plus a published editorial Article. Content relations (favorite / like) keep
 * `contentIdentitySchema`; an Article has no likes or favorites.
 */
export const discussionTargetSchema = z.discriminatedUnion("type", [
  ...contentIdentitySchema.options,
  z.strictObject({ type: z.literal("article"), id: articleIdSchema }),
]);
export type DiscussionTarget = z.infer<typeof discussionTargetSchema>;
export const authorPrivacySchema = z.strictObject({
  following: visibility,
  followers: visibility,
  favorites: visibility,
  likes: visibility,
});
export const authorMediaSchema = z.strictObject({
  id: mediaId,
  src: z.string().startsWith("/api/community/media/"),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});

export const authorProfileSchema = z.strictObject({
  id: userId,
  handle: z.string(),
  displayName: authorText(40),
  bio: authorText(500),
  studioName: studioNameDisplaySchema.optional(),
  studioNameSuffix: studioNameSuffixSchema.optional(),
  avatar: authorMediaSchema.nullable(),
  background: authorMediaSchema.nullable().optional(),
  isOwner: z.boolean(),
  following: z.boolean(),
  privacy: authorPrivacySchema,
  totals: z.strictObject({
    works: version,
    following: version.nullable(),
    followers: version.nullable(),
    favorites: version.nullable(),
    likes: version.nullable(),
  }),
  nextAvatarChangeAt: z.iso.datetime().nullable(),
});
export const workSchema = z
  .strictObject({
    id: workId,
    authorId: userId,
    authorName: z.string(),
    authorStudioName: studioNameDisplaySchema.optional(),
    /** May be empty: an untitled work keeps an empty title in storage. */
    title: z.string(),
    text: z.string(),
    /** Phase 4 PNG media or work publishing media items; avatars keep `authorMediaSchema`. */
    media: z.array(workMediaSchema).max(WORK_ITEMS_HARD_MAXIMUM),
    /**
     * The id of the `media` entry the viewer's revision uses as its cover (the
     * public revision for third parties, the author revision for the author):
     * the chosen cover item, else the first entry; null without media.
     */
    coverMediaId: workMediaIdSchema.nullable().optional(),
    /**
     * The card cover still of the same revision: the cover item's `cover`
     * derivative under its edit and the revision cover crop (else its display
     * derivative), the Phase 4 PNG for an unedited legacy item, the first item
     * when no cover was chosen; null without a presentable cover.
     */
    coverSrc: workCoverSrcSchema.nullable().optional(),
    /**
     * Card candidates of the cover still in its own framing (the cover crop
     * when one is set), with `coverSrc` as the anchor; never mixed with the
     * full-frame `renditions` of `media`.
     */
    coverRenditions: mediaRenditionListSchema.optional(),
    /** Null until the first public exposure (a self-only or pending first submission). */
    firstPublishedAt: z.iso.datetime().nullable(),
    version,
    canEdit: z.boolean(),
    available: z.boolean(),
    /** Set after a real content update of a public revision. */
    editedAt: z.iso.datetime().nullable().optional(),
    /**
     * Attribution readers see: original, copy or practice, or material sharing
     * with its reference. Absent when the viewer's revision declares none
     * (legacy Phase 4 works and submissions without a declaration).
     */
    authorship: workAuthorshipSchema.optional(),
    /** Author-only fields: present only in the author's own view. */
    visibility: workVisibilitySchema.optional(),
    trashedAt: z.iso.datetime().nullable().optional(),
    /**
     * Author-only: true exactly when third parties can currently see the work
     * (public, not trashed, not hidden or removed by an operator, and a public
     * revision exists). A pending first submission or a hidden work is false.
     */
    publiclyVisible: z.boolean().optional(),
  })
  .superRefine((work, context) => {
    if (work.publiclyVisible !== undefined && !work.canEdit)
      context.addIssue({
        code: "custom",
        path: ["publiclyVisible"],
        message: "only the author's own view says whether a work is public",
      });
    if (
      work.publiclyVisible === true &&
      (work.visibility === "self" ||
        (work.trashedAt !== undefined && work.trashedAt !== null))
    )
      context.addIssue({
        code: "custom",
        path: ["publiclyVisible"],
        message: "a self-only or trashed work is not public",
      });
    if (
      work.coverMediaId !== undefined &&
      work.coverMediaId !== null &&
      !work.media.some((media) => media.id === work.coverMediaId)
    )
      context.addIssue({
        code: "custom",
        path: ["coverMediaId"],
        message: "the cover names one of the work's media",
      });
    if (work.coverRenditions !== undefined)
      addMediaRenditionAnchorIssues(
        { src: work.coverSrc },
        work.coverRenditions,
        context,
        ["coverRenditions"],
      );
  });
export const profileUpdateSchema = z
  .strictObject({
    requestId,
    displayName: authorText(40).refine((s) => s.length > 0),
    bio: authorText(500),
    studioName: studioNameDisplaySchema.optional(),
    studioNameSuffix: studioNameSuffixSchema.optional(),
  })
  .superRefine(refineStudioNameWrite);
export const privacyUpdateSchema = z.strictObject({
  requestId,
  privacy: authorPrivacySchema,
});
export const avatarUpdateSchema = z.strictObject({ requestId, mediaId });
export const backgroundUpdateSchema = z.strictObject({
  requestId,
  mediaId: mediaId.nullable(),
});
export const relationshipUpdateSchema = z.strictObject({
  requestId,
  targetId: userId,
  enabled: z.boolean(),
});
export const contentRelationUpdateSchema = z.strictObject({
  requestId,
  target: contentIdentitySchema,
  enabled: z.boolean(),
});
export const guestFavoriteMergeSchema = z.strictObject({
  requestId,
  expectedAccountId: userId,
  items: z.array(contentIdentitySchema).min(1).max(100),
});
export const requestIdentitySchema = z.strictObject({ requestId });
export const authorListQuerySchema = z.strictObject({
  page: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(10000))
    .default(1),
  pageSize: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(50))
    .default(20),
  search: z.string().trim().max(200).default(""),
  kind: z.enum(["all", "inscription", "calligraphy"]).default("all"),
});
export type ContentIdentity = z.infer<typeof contentIdentitySchema>;
export type AuthorPrivacy = z.infer<typeof authorPrivacySchema>;
export type AuthorMedia = z.infer<typeof authorMediaSchema>;
export type AuthorProfile = z.infer<typeof authorProfileSchema>;
export type UserWork = z.infer<typeof workSchema>;
export type AuthorListQuery = z.infer<typeof authorListQuerySchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type PrivacyUpdate = z.infer<typeof privacyUpdateSchema>;
export type AvatarUpdate = z.infer<typeof avatarUpdateSchema>;
export type BackgroundUpdate = z.infer<typeof backgroundUpdateSchema>;
export type RelationshipUpdate = z.infer<typeof relationshipUpdateSchema>;
export type ContentRelationUpdate = z.infer<typeof contentRelationUpdateSchema>;
export type GuestFavoriteMerge = z.infer<typeof guestFavoriteMergeSchema>;

const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(50),
    total: version,
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(50),
  });
export const authorPersonSchema = z.strictObject({
  id: userId,
  handle: z.string(),
  displayName: z.string(),
  studioName: studioNameDisplaySchema.optional(),
  avatar: authorMediaSchema.nullable(),
});
export const authorPeoplePageSchema = pageOf(authorPersonSchema);
export const workPageSchema = pageOf(workSchema);
export const guestFavoriteMergeResultSchema = z.strictObject({
  acknowledged: z.array(contentIdentitySchema).max(100),
});
export const avatarUpdateResultSchema = z.strictObject({
  nextChangeAt: z.iso.datetime(),
});

export const discussionReplySchema = z.strictObject({
  id: catalogCommentIdSchema,
  author: commentAuthorSchema,
  text: z.string().max(1000),
  createdAt: z.iso.datetime(),
  replyTo: commentAuthorSchema.optional(),
  likeCount: z.number().int().nonnegative(),
  liked: z.boolean(),
  deleted: z.boolean(),
});
export const discussionCommentSchema = discussionReplySchema.extend({
  target: discussionTargetSchema,
  replies: z.array(discussionReplySchema).max(3),
  replyTotal: z.number().int().nonnegative(),
  replyPageTotal: z.number().int().nonnegative(),
});
export const discussionPageSchema = z.strictObject({
  /** Publicly visible, undeleted roots and replies, filtered for this reader. */
  visibleTotal: z.number().int().nonnegative(),
  hot: z.array(discussionCommentSchema).max(3),
  items: z.array(discussionCommentSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: z.number().int().nonnegative(),
});
export const discussionReplyPageSchema = z.strictObject({
  visibleTotal: z.number().int().nonnegative(),
  items: z.array(discussionReplySchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: z.number().int().nonnegative(),
});
export const ownCommentSchema = z.strictObject({
  id: catalogCommentIdSchema,
  rootId: catalogCommentIdSchema,
  text: z.string(),
  createdAt: z.iso.datetime(),
  deleted: z.boolean(),
  target: discussionTargetSchema.nullable(),
});
export const commentLikeUpdateSchema = z.strictObject({
  requestId,
  enabled: z.boolean(),
});
export const commentBodyDeleteSchema = z.strictObject({ requestId });
export type DiscussionReply = z.infer<typeof discussionReplySchema>;
export type DiscussionComment = z.infer<typeof discussionCommentSchema>;
export type DiscussionPage = z.infer<typeof discussionPageSchema>;
export type DiscussionReplyPage = z.infer<typeof discussionReplyPageSchema>;
export type OwnComment = z.infer<typeof ownCommentSchema>;

/** At most this many gallery entries travel with a card; `mediaCount` carries the total. */
export const CARD_GALLERY_MAXIMUM = 10;

/** One card image: the anchor `src` and size, its card candidates and loading colour. */
const cardMediaFields = {
  id: z.string(),
  src: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  renditions: cardMediaRenditionListSchema.optional(),
  placeholderColor: placeholderColorSchema.optional(),
};
const addCardMediaAnchorIssues = (
  media: z.infer<z.ZodObject<typeof cardMediaFields>>,
  context: z.RefinementCtx,
) => {
  if (media.renditions !== undefined)
    addMediaRenditionAnchorIssues(media, media.renditions, context);
};
const cardMediaSchema = z
  .strictObject(cardMediaFields)
  .superRefine(addCardMediaAnchorIssues);
/**
 * One shown image of a card's item in its full framing, in the same delivery
 * form as the card's `media`; a Live Photo is its still plus the flag.
 */
const cardGalleryEntrySchema = z
  .strictObject({ ...cardMediaFields, live: z.boolean().optional() })
  .superRefine(addCardMediaAnchorIssues);
export type CardGalleryEntry = z.infer<typeof cardGalleryEntrySchema>;

const contentCardFields = z.strictObject({
  aliases: catalogSummarySchema.shape.aliases,
  /** Present only for official Catalog content with a known province. */
  province: catalogSummarySchema.shape.province,
  target: contentIdentitySchema,
  /** Empty for an untitled work; the UI never invents a title. */
  title: authorText(500),
  /** The opening of a work body, for text cards. */
  excerpt: authorText(WORK_EXCERPT_MAXIMUM * 2)
    .refine((s) => codePointLength(s) <= WORK_EXCERPT_MAXIMUM)
    .optional(),
  /** A Live Photo cover: static image plus a LIVE indicator, never autoplay. */
  live: z.boolean().optional(),
  kind: catalogKindSchema.nullable(),
  authorId: userId.nullable(),
  firstPublishedAt: z.iso.datetime().nullable(),
  /**
   * The card image: Catalog media, or a work's cover still in its cover
   * framing. `renditions` are card candidates with `src` as the anchor.
   */
  media: cardMediaSchema.nullable(),
  /**
   * The item's shown images in their own order (Catalog position, revision
   * position), each in its full framing, at most CARD_GALLERY_MAXIMUM;
   * present exactly when `media` is, together with `mediaCount`. A work
   * entry is its display still: motion never travels on a card.
   */
  gallery: z
    .array(cardGalleryEntrySchema)
    .min(1)
    .max(CARD_GALLERY_MAXIMUM)
    .optional(),
  /** The item's shown image total; `gallery` may stop short of it. */
  mediaCount: z.number().int().positive().optional(),
});

/**
 * A work card lists its images in the community forms (unsigned published
 * URLs or the authorized path, never a signed URL, never motion); a Catalog
 * card in the resolved form of Catalog media.
 */
const addCardMediaFormIssues = (
  type: ContentIdentity["type"],
  media: {
    readonly src: string;
    readonly renditions?: readonly unknown[] | undefined;
  },
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void => {
  if (type === "work" && !workCoverSrcSchema.safeParse(media.src).success)
    context.addIssue({
      code: "custom",
      path: [...path, "src"],
      message:
        "work card media uses an authorized path or unsigned published URL",
    });
  if (media.renditions === undefined) return;
  const form =
    type === "work" ? mediaRenditionListSchema : publicMediaRenditionListSchema;
  if (!form.safeParse(media.renditions).success)
    context.addIssue({
      code: "custom",
      path: [...path, "renditions"],
      message: "card renditions take the delivery form of their target",
    });
};
export const contentCardSchema = contentCardFields.superRefine(
  (card, context) => {
    if (card.media !== null)
      addCardMediaFormIssues(card.target.type, card.media, context, ["media"]);
    if ((card.gallery === undefined) !== (card.mediaCount === undefined))
      context.addIssue({
        code: "custom",
        path: ["mediaCount"],
        message: "gallery and mediaCount travel together",
      });
    if (card.gallery === undefined) return;
    if (card.media === null)
      context.addIssue({
        code: "custom",
        path: ["gallery"],
        message: "a gallery needs a card image",
      });
    if (card.mediaCount !== undefined && card.mediaCount < card.gallery.length)
      context.addIssue({
        code: "custom",
        path: ["mediaCount"],
        message: "mediaCount counts every gallery entry",
      });
    if (
      new Set(card.gallery.map((entry) => entry.id)).size !==
      card.gallery.length
    )
      context.addIssue({
        code: "custom",
        path: ["gallery"],
        message: "gallery entries are distinct images",
      });
    card.gallery.forEach((entry, index) =>
      addCardMediaFormIssues(card.target.type, entry, context, [
        "gallery",
        index,
      ]),
    );
  },
);
const filterValues = z
  .array(authorText(80).min(1))
  .max(25)
  .refine((values) => new Set(values).size === values.length)
  .default([]);
export const inscriptionFiltersSchema = z.strictObject({
  dynasty: filterValues,
  textAuthor: filterValues,
  calligrapher: filterValues,
  originalRegion: filterValues,
  script: filterValues,
});
export const discoveryQuerySchema = z
  .strictObject({
    kind: z.enum(["all", "inscription", "calligraphy"]).default("all"),
    pageSize: z.number().int().min(1).max(50).default(12),
    filters: inscriptionFiltersSchema.default({
      dynasty: [],
      textAuthor: [],
      calligrapher: [],
      originalRegion: [],
      script: [],
    }),
    sequence: z.string().uuid().optional(),
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    search: authorText(200).default(""),
  })
  .refine(
    (q) =>
      q.kind === "inscription" ||
      Object.values(q.filters).every((v) => v.length === 0),
    { message: "Advanced filters are inscription-only" },
  );
export const discoveryPageSchema = z.strictObject({
  items: z.array(contentCardSchema).max(50),
  sequence: z.string().uuid(),
  nextAfter: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export const contentCollectionPageSchema = z.strictObject({
  items: z.array(contentCardSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
const filterOptionSchema = z.strictObject({
  values: z.array(z.string()),
  unknown: z.number().int().nonnegative(),
  unsupplied: z.number().int().nonnegative(),
});
export const inscriptionFilterOptionsSchema = z.strictObject({
  dynasty: filterOptionSchema,
  textAuthor: filterOptionSchema,
  calligrapher: filterOptionSchema,
  originalRegion: filterOptionSchema,
  script: filterOptionSchema,
});
export const contentStateQuerySchema = z.strictObject({
  target: contentIdentitySchema,
});
export const contentStateSchema = z.strictObject({
  favorite: z.boolean(),
  liked: z.boolean(),
  favoriteCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  /** Public comments and replies this reader may see (the discussion's visibleTotal). */
  commentCount: z.number().int().nonnegative(),
});
export type ContentState = z.infer<typeof contentStateSchema>;
export type ContentCard = z.infer<typeof contentCardSchema>;
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
export type DiscoveryPage = z.infer<typeof discoveryPageSchema>;
export type InscriptionFilters = z.infer<typeof inscriptionFiltersSchema>;
export type InscriptionFilterOptions = z.infer<
  typeof inscriptionFilterOptionsSchema
>;

export const ownCommentPageSchema = pageOf(ownCommentSchema).extend({
  totalPages: z.number().int().nonnegative(),
});
export const discussionSubmitResultSchema = z.strictObject({
  id: catalogCommentIdSchema,
  rootId: catalogCommentIdSchema,
  item: discussionReplySchema,
  awaitingApproval: z.boolean(),
});
export const discussionLocationSchema = z.strictObject({
  rootId: catalogCommentIdSchema,
  page: z.number().int().positive(),
  replyPage: z.number().int().positive(),
});
export const savedResultSchema = z.strictObject({ saved: z.literal(true) });
export const deletedResultSchema = z.strictObject({ deleted: z.literal(true) });
export const discardedResultSchema = z.strictObject({
  discarded: z.literal(true),
});

export {
  authAccountSecuritySchema,
  authCapabilitiesSchema,
  authChallengeAcceptedSchema,
  authChallengeRequestSchema,
  authChannelSchema,
  authChannelStateSchema,
  authFactorCompleteRequestSchema,
  authFactorSchema,
  authRegistrationRequestSchema,
  authRegistrationAgreementSchema,
  authPasswordSchema,
  authPasswordLoginRequestSchema,
  authPasswordResetRequestSchema,
  authPasswordResetResultSchema,
  studioNameSchema,
  studioNameDisplaySchema,
  studioNameSuffixSchema,
  studioNameInputSchema,
  authUnlinkRequestSchema,
  authVerifyRequestSchema,
} from "./auth-schemas.ts";
export type {
  AuthAccountSecurity,
  AuthCapabilities,
  AuthChallengeAccepted,
  AuthChallengeRequest,
  AuthChannel,
  AuthChannelState,
  AuthFactor,
  AuthFactorCompleteRequest,
  AuthRegistrationRequest,
  AuthRegistrationAgreement,
  AuthPasswordLoginRequest,
  AuthPasswordResetRequest,
  AuthPasswordResetResult,
  AuthUnlinkRequest,
  AuthVerifyRequest,
} from "./auth-schemas.ts";
// messaging-notification-foundation-v1: private activity DTOs; no Session or media keys.
export const notificationReasonSchema = z.enum([
  "like",
  "comment",
  "reply",
  "mention",
]);
export const notificationObservationSchema = z.string().min(1).max(4096);
export const notificationItemSchema = z.strictObject({
  id: z.string().regex(/^notification-[0-9a-f]{32}$/u),
  reason: notificationReasonSchema,
  available: z.boolean(),
  // parallel-community-integration-qa: a notification target is a discussion
  // target, so it spans Catalog, Work and published Article. This is the
  // discussion union, NOT `contentIdentitySchema`: content relations
  // (favorite / like) stay Catalog/Work only, so an Article gains no likes or
  // favorites from being notifiable.
  target: discussionTargetSchema.nullable(),
  commentId: catalogCommentIdSchema.nullable(),
  actors: z.array(publicUserProfileSchema).max(3),
  actorCount: z.number().int().nonnegative(),
  text: z.string().max(240),
  createdAt: z.iso.datetime(),
  unread: z.boolean(),
  observation: notificationObservationSchema,
});
export const notificationUnreadSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
});
export const notificationPageSchema = z.strictObject({
  items: z.array(notificationItemSchema).max(50),
  nextCursor: notificationObservationSchema.nullable(),
  observation: notificationObservationSchema,
  unread: notificationUnreadSchema,
});
export const notificationReadSchema = z.strictObject({
  observation: notificationObservationSchema,
});
export const mentionLookupPageSchema = z.strictObject({
  items: z.array(publicUserProfileSchema).max(10),
});
// ---------------------------------------------------------------------------
// content-community-completion-v1: editorial Articles and Article Collections.
// Public read DTOs over the Payload published-only views. Ids are the
// server-generated stable identities, never Payload row ids; timestamps are
// canonical ISO 8601 instants formatted by Web.
// ---------------------------------------------------------------------------
export const articleCollectionIdSchema = z
  .string()
  .regex(/^collection-[0-9a-f]{32}$/u)
  .brand<"ArticleCollectionId">();
export type ArticleCollectionId = z.infer<typeof articleCollectionIdSchema>;
export const articlePresentationSchema = z.enum(["news", "academic"]);
export type ArticlePresentation = z.infer<typeof articlePresentationSchema>;
const editorialInstant = z.iso.datetime({ offset: true });
const optionalEditorialText = (max: number) =>
  z.string().min(1).max(max).nullable();
export const articleSummarySchema = z.strictObject({
  id: articleIdSchema,
  presentation: articlePresentationSchema,
  title: z
    .string()
    .min(1)
    .max(240)
    .refine((value) => [...value].length <= 120),
  subtitle: optionalEditorialText(120),
  summary: optionalEditorialText(400),
  section: optionalEditorialText(40),
  issue: optionalEditorialText(40),
  /** Display attribution only; never an authorization identity. */
  byline: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => [...value].length <= 60),
  cover: publicMediaSchema.nullable(),
  /** Current managed Article cover, using existing derivative/Live Photo paths. */
  managedCover: workMediaSchema.nullable().optional(),
  firstPublishedAt: editorialInstant,
  publishedAt: editorialInstant,
  updatedAt: editorialInstant,
});
export type ArticleSummary = z.infer<typeof articleSummarySchema>;
export const articleSectionSchema = z.strictObject({
  heading: optionalEditorialText(80),
  paragraphs: z.array(z.string().min(1).max(20000)).min(1).max(400),
  image: publicMediaSchema.nullable(),
  imageCaption: optionalEditorialText(200),
});
export type ArticleSection = z.infer<typeof articleSectionSchema>;
export const articleCitationSchema = z.strictObject({
  text: z.string().min(1).max(500),
  url: z.string().url().max(500).nullable(),
});
export type ArticleCitation = z.infer<typeof articleCitationSchema>;
/** Public read resolution never carries object keys, originals or private metadata. */
export const articleResolvedReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("managed"), media: workMediaSchema }),
  z.strictObject({ type: z.literal("catalog"), media: publicMediaSchema }),
  z.strictObject({
    type: z.literal("unavailable"),
    reason: z.enum(["media_unavailable", "catalog_unavailable"]),
  }),
]);
export type ArticleResolvedReference = z.infer<
  typeof articleResolvedReferenceSchema
>;
export const articleResolvedReferencesSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    articleResolvedReferenceSchema,
  )
  .refine((references) => Object.keys(references).length <= 60, {
    message: "article_reference_limit",
  });
export type ArticleResolvedReferences = z.infer<
  typeof articleResolvedReferencesSchema
>;
export const articleDetailSchema = articleSummarySchema
  .extend({
    intro: optionalEditorialText(2000),
    sections: z.array(articleSectionSchema).max(40),
    citations: z.array(articleCitationSchema).max(50),
    /** Optional only for retained legacy Articles, whose sections stay authoritative. */
    document: articleDocumentSchema.optional(),
    resolvedReferences: articleResolvedReferencesSchema.optional(),
  })
  .superRefine((article, context) => {
    if (article.document === undefined) {
      if (article.sections.length === 0)
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message: "legacy Article requires sections",
        });
      if (article.resolvedReferences !== undefined)
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences"],
          message: "rich references require a document",
        });
      return;
    }
    if (article.sections.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "rich Article body is its canonical document",
      });
    if (article.resolvedReferences === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resolvedReferences"],
        message: "rich Article requires reference resolutions",
      });
      return;
    }
    for (const { refId } of articleReferences(article.document))
      if (!Object.hasOwn(article.resolvedReferences, refId))
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences", refId],
          message: "Article reference resolution missing",
        });
    for (const refId of Object.keys(article.resolvedReferences))
      if (!Object.hasOwn(article.document.references, refId))
        context.addIssue({
          code: "custom",
          path: ["resolvedReferences", refId],
          message: "Article reference does not exist",
        });
  });
export type ArticleDetail = z.infer<typeof articleDetailSchema>;
export const ARTICLE_PAGE_SIZE_MAXIMUM = 50;
export const articleListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ARTICLE_PAGE_SIZE_MAXIMUM)
    .default(12),
  presentation: articlePresentationSchema.optional(),
});
export type ArticleListQuery = z.infer<typeof articleListQuerySchema>;
const editorialPageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(ARTICLE_PAGE_SIZE_MAXIMUM),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(ARTICLE_PAGE_SIZE_MAXIMUM),
    totalPages: z.number().int().min(0),
  });
export const articlePageSchema = editorialPageOf(articleSummarySchema);
export type ArticlePage = z.infer<typeof articlePageSchema>;
export const articleCollectionSummarySchema = z.strictObject({
  id: articleCollectionIdSchema,
  title: z.string().min(1).max(120),
  subtitle: optionalEditorialText(120),
  summary: optionalEditorialText(1000),
  category: optionalEditorialText(60),
  issue: optionalEditorialText(40),
  cover: publicMediaSchema.nullable(),
  /** Currently eligible members only; withdrawn members never count. */
  memberTotal: z.number().int().min(0),
  firstPublishedAt: editorialInstant,
  publishedAt: editorialInstant,
  updatedAt: editorialInstant,
});
export type ArticleCollectionSummary = z.infer<
  typeof articleCollectionSummarySchema
>;
export const articleCollectionMemberSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("article"),
    position: z.number().int().min(0),
    article: articleSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("catalog"),
    position: z.number().int().min(0),
    record: catalogSummarySchema,
  }),
]);
export type ArticleCollectionMember = z.infer<
  typeof articleCollectionMemberSchema
>;
export const articleCollectionDetailSchema =
  articleCollectionSummarySchema.extend({
    members: z.array(articleCollectionMemberSchema).max(200),
  });
export type ArticleCollectionDetail = z.infer<
  typeof articleCollectionDetailSchema
>;
export const articleCollectionListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ARTICLE_PAGE_SIZE_MAXIMUM)
    .default(12),
});
export type ArticleCollectionListQuery = z.infer<
  typeof articleCollectionListQuerySchema
>;
export const articleCollectionPageSchema = editorialPageOf(
  articleCollectionSummarySchema,
);
export type ArticleCollectionPage = z.infer<typeof articleCollectionPageSchema>;

// ---------------------------------------------------------------------------
// content-community-completion-v1: Threads over Works and the Article
// discussion target.
// ---------------------------------------------------------------------------
export const threadIdSchema = z
  .string()
  .regex(/^thread-[0-9a-f]{32}$/u)
  .brand<"ThreadId">();
export type ThreadId = z.infer<typeof threadIdSchema>;
export const threadStatusSchema = z.enum(["open", "closed"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export const threadSummarySchema = z.strictObject({
  id: threadIdSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  tags: z.array(z.string().min(1).max(24)).max(6),
  status: threadStatusSchema,
  /** Deterministic V1 heat at the page anchor; a transparent heuristic, not a recommendation. */
  heat: z.number().min(0),
  /** Currently eligible (publicly visible) posts. */
  postCount: z.number().int().min(0),
  /** Latest eligible activity instant, or null for a Thread without any yet. */
  latestActivityAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /**
   * Whether the signed-in viewer has unseen eligible activity; null for an
   * anonymous viewer (whose read state, if any, stays local).
   */
  unread: z.boolean().nullable(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export const THREAD_PAGE_SIZE_MAXIMUM = 50;
export const threadListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(THREAD_PAGE_SIZE_MAXIMUM)
    .default(22),
  /** Ranking snapshot; the first page omits it and receives one for later pages. */
  anchor: z.iso.datetime({ offset: true }).optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;
export const threadPageSchema = z.strictObject({
  items: z.array(threadSummarySchema).max(THREAD_PAGE_SIZE_MAXIMUM),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(THREAD_PAGE_SIZE_MAXIMUM),
  totalPages: z.number().int().min(0),
  /** Server snapshot instant every page of this browsing sequence is ranked at. */
  anchor: z.iso.datetime({ offset: true }),
});
export type ThreadPage = z.infer<typeof threadPageSchema>;
export const threadReadResultSchema = z.strictObject({
  /** The server-observed activity instant now recorded as seen, or null. */
  observedActivityAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ThreadReadResult = z.infer<typeof threadReadResultSchema>;

// ---------------------------------------------------------------------------
// content-community-completion-v1: one-to-one plain-text direct messages.
// Sender identity always comes from the Session; DTOs never carry credentials,
// contact details or read receipts of the other participant.
// ---------------------------------------------------------------------------
export const DIRECT_MESSAGE_TEXT_MAXIMUM = 2000;
export const dmConversationIdSchema = z
  .string()
  .regex(/^dm-[0-9a-f]{32}$/u)
  .brand<"DmConversationId">();
export type DmConversationId = z.infer<typeof dmConversationIdSchema>;
export const dmMessageIdSchema = z
  .string()
  .regex(/^dmsg-[0-9a-f]{32}$/u)
  .brand<"DmMessageId">();
export type DmMessageId = z.infer<typeof dmMessageIdSchema>;
export const dmParticipantSchema = z.strictObject({
  id: userId,
  displayName: z.string(),
  studioName: studioNameDisplaySchema.optional(),
  /** Whether the other account can currently be messaged (active, not blocked either way). */
  available: z.boolean(),
});
export type DmParticipant = z.infer<typeof dmParticipantSchema>;
export const directMessageSchema = z.strictObject({
  id: dmMessageIdSchema,
  conversationId: dmConversationIdSchema,
  sequence: z.number().int().min(1),
  senderId: userId,
  /** Null once removed by the authorized moderation path. */
  text: z.string().max(DIRECT_MESSAGE_TEXT_MAXIMUM).nullable(),
  removed: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type DirectMessage = z.infer<typeof directMessageSchema>;
export const dmSendRefusalSchema = z.enum([
  "request_pending",
  "blocked",
  "unavailable",
]);
export type DmSendRefusal = z.infer<typeof dmSendRefusalSchema>;
export const directConversationSchema = z.strictObject({
  id: dmConversationIdSchema,
  participant: dmParticipantSchema,
  /** `requested` until the recipient's committed reply activates it. */
  state: z.enum(["requested", "active"]),
  /** Whether the viewer may commit a message now; `sendRefusal` names why not. */
  canSend: z.boolean(),
  sendRefusal: dmSendRefusalSchema.nullable(),
  lastMessage: z
    .strictObject({
      sequence: z.number().int().min(1),
      senderId: userId,
      text: z.string().max(DIRECT_MESSAGE_TEXT_MAXIMUM).nullable(),
      removed: z.boolean(),
      createdAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  /** Unread incoming, non-removed messages for the viewer. */
  unreadCount: z.number().int().min(0),
  muted: z.boolean(),
  hidden: z.boolean(),
  /** The viewer's monotonic observed sequence (never the other participant's). */
  readSequence: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
});
export type DirectConversation = z.infer<typeof directConversationSchema>;
/** The canonical pair with another account, if it exists; never creates one. */
export const directConversationLookupSchema = z.strictObject({
  conversation: directConversationSchema.nullable(),
});
export type DirectConversationLookup = z.infer<
  typeof directConversationLookupSchema
>;
export const directConversationPageSchema = z.strictObject({
  items: z.array(directConversationSchema).max(50),
  /** Opaque cursor for older conversations, or null at the end. */
  nextCursor: z.string().max(200).nullable(),
});
export type DirectConversationPage = z.infer<
  typeof directConversationPageSchema
>;
export const directMessagePageSchema = z.strictObject({
  conversation: directConversationSchema,
  /** Newest first; `nextBefore` continues to older messages. */
  items: z.array(directMessageSchema).max(50),
  nextBefore: z.number().int().min(1).nullable(),
});
export type DirectMessagePage = z.infer<typeof directMessagePageSchema>;
export const directConversationListQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const directMessageHistoryQuerySchema = z.strictObject({
  before: z.coerce.number().int().min(1).optional(),
  /** Messages newer than this sequence only (polling). */
  after: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(30),
});
export const sendDirectMessageCommandSchema = z
  .strictObject({
    requestId: requestIdentitySchema.shape.requestId,
    recipientId: userId.optional(),
    conversationId: dmConversationIdSchema.optional(),
    /** Trimmed by the Backend; 1–2,000 Unicode code points after trimming. */
    text: z
      .string()
      .max(DIRECT_MESSAGE_TEXT_MAXIMUM * 4)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          codePointLength(value.trim()) <= DIRECT_MESSAGE_TEXT_MAXIMUM,
        `1–${DIRECT_MESSAGE_TEXT_MAXIMUM} code points`,
      ),
  })
  .refine(
    (value) =>
      (value.recipientId === undefined) !==
      (value.conversationId === undefined),
    "Exactly one of recipientId or conversationId",
  );
export type SendDirectMessageCommand = z.infer<
  typeof sendDirectMessageCommandSchema
>;
export const directMessageReadCommandSchema = z.strictObject({
  requestId: requestIdentitySchema.shape.requestId,
  /** Observed sequence; clamped to the latest existing message, never beyond. */
  sequence: z.number().int().min(0),
});
export type DirectMessageReadCommand = z.infer<
  typeof directMessageReadCommandSchema
>;
export const directMessageUnreadSchema = z.strictObject({
  /** Visible (unhidden) conversations with unread incoming messages: the DM badge unit. */
  unreadConversations: z.number().int().min(0),
});
export type DirectMessageUnread = z.infer<typeof directMessageUnreadSchema>;
/** Refusal codes carried in INVALID_INPUT messages. */
export const directMessageFailureCodeSchema = z.enum([
  "dm_self",
  "dm_recipient_unavailable",
  "dm_blocked",
  "dm_request_pending",
  "dm_daily_limit",
  "dm_rate_limited",
  "dm_text_invalid",
]);
export type DirectMessageFailureCode = z.infer<
  typeof directMessageFailureCodeSchema
>;

// Restricted Article commands and canonical document; no editor runtime.
export {
  ARTICLE_DOCUMENT_LIMITS,
  articleCodePointLength,
  articleUtf8ByteLength,
  articleAuthoringArticleIdSchema,
  articleSafeLinkSchema,
  articleStyledTextSchema,
  articleInlineContentSchema,
  articleBlockSchema,
  articleMediaReferenceSchema,
  articleGalleryGroupSchema,
  articleDocumentSchema,
  articleAuthoringDocumentSchema,
  emptyArticleDocument,
  extractArticleText,
  articleReferences,
  articleCatalogReferences,
  articleDraftStatusSchema,
  articleDraftSchema,
  createArticleDraftCommandSchema,
  updateArticleDraftCommandSchema,
  deleteArticleDraftCommandSchema,
  articleDraftDeletionResultSchema,
  articleCandidateCommandSchema,
  publishArticleCommandSchema,
  articleAuthoringCreateSchema,
  articleAuthoringUpdateSchema,
  articleAuthoringCandidateSchema,
  articleAuthoringPublishSchema,
  articleAuthoringWithdrawSchema,
  articleOwnMediaListQuerySchema,
  articleOwnMediaPageSchema,
  articleDraftListQuerySchema,
  articleAuthoringListQuerySchema,
  articleDraftSummarySchema,
  articleDraftPageSchema,
  articlePublishResultSchema,
  articlePublicationResultSchema,
  articleValidationIssueSchema,
  articleValidationResultSchema,
  articlePreviewSchema,
  articleAuthoringScopeSchema,
  articleConnectionIdSchema,
  articleAuthoringGrantSchema,
  createArticleAuthoringGrantCommandSchema,
  articleCandidateApprovalCommandSchema,
  revokeArticleAuthoringGrantCommandSchema,
  articleAuthoringFailureCodeSchema,
  articleBlockEditSchema,
  articleBlockEditsCommandSchema,
  applyArticleBlockEdits,
  legacyArticleToDocument,
} from "./article-authoring.ts";

export {
  articleApprovalCandidateSchema,
  articleApprovalResultSchema,
  articleCandidateApprovalSubmissionSchema,
  articleApprovalReviewSchema,
  articleConsentReviewSchema,
  articleAuthoringConnectionsSchema,
  articleConnectionRevocationSchema,
  articleConsentDecisionSchema,
} from "./article-delegation.ts";
