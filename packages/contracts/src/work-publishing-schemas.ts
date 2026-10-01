import { z } from "zod";
import {
  mentionReferencesSchema,
  validMentionReferences,
} from "./mention-references.ts";

import {
  AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM,
  AUTHORSHIP_REFERENCE_TITLE_MAXIMUM,
  AUTHORSHIP_SOURCE_NOTE_MAXIMUM,
  DRAFT_TEXT_RAW_ALLOWANCE,
  WORK_EXCERPT_MAXIMUM,
  WORK_ITEMS_CONFIGURABLE_MAXIMUM,
  WORK_ITEMS_HARD_MAXIMUM,
  WORK_TITLE_MAXIMUM,
  checkPublishingText,
  codePointLength,
  hasInvalidPublishingCharacters,
  normalizePublishingBody,
  normalizePublishingTitle,
  publishingBodyRule,
  publishingTitleRule,
  type PublishingTextRule,
} from "./work-publishing-text.ts";

/**
 * Work publishing public shapes (work-publishing-v1): drafts, no-save
 * sessions, private media items, explicit submissions, visibility and the
 * recycle bin. Operator settings, the submission queue, capacity designation
 * and jobs live on the internal community-operator subpath only.
 *
 * Refinement messages that equal a `WorkPublishingFailureCode` are the
 * field-specific codes the Backend surfaces; any other message is a generic
 * invalid input.
 */

const platformId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{32}$`, "u"));

export const mediaItemIdSchema = platformId("media-item");
export const mediaComponentIdSchema = platformId("media-component");
export const workDraftIdSchema = platformId("work-draft");
export const workRevisionIdSchema = platformId("work-revision");
export const workSnapshotIdSchema = platformId("work-snapshot");
export const publishingSessionIdSchema = platformId("publishing-session");
const workIdSchema = platformId("work");
const requestIdSchema = z.uuid();
const timestampSchema = z.iso.datetime();
const versionSchema = z.number().int().nonnegative().max(2147483647);
const revisionSchema = z.number().int().min(1).max(2147483647);
const countSchema = z.number().int().nonnegative().max(2147483647);
const itemCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(WORK_ITEMS_HARD_MAXIMUM);
const byteSizeSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const receivedBytesSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const dimensionSchema = z.number().int().positive().max(65_535);

export const workPublishingFailureCodeSchema = z.enum([
  "empty_work",
  "title_too_long",
  "title_line_break",
  "body_too_long",
  "reference_title_too_long",
  "original_author_too_long",
  "source_note_too_long",
  "items_limit",
  "not_ready",
  "capacity_exceeded",
  "daily_limit",
  "draft_limit",
  "original_item_too_large",
  "component_too_large",
  "unsupported_type",
  "pairing_mismatch",
  "work_unavailable",
  // content-community-completion-v1: Thread association refusals.
  "thread_unavailable",
  "thread_conflict",
  "thread_items_limit",
]);

export const mediaItemKindSchema = z.enum(["static", "live"]);
/** `legacy` marks media carried over from the earlier PNG works; never requested by a client. */
export const mediaQualityModeSchema = z.enum([
  "standard",
  "original",
  "legacy",
]);
export const mediaUploadQualityModeSchema = z.enum(["standard", "original"]);
export const mediaItemStateSchema = z.enum([
  "awaiting_upload",
  "processing",
  "ready",
  "failed",
  "cancelled",
  "purged",
]);
export const mediaComponentRoleSchema = z.enum(["still", "motion", "package"]);
export const mediaComponentStateSchema = z.enum([
  "awaiting",
  "receiving",
  "received",
  "verified",
  "rejected",
  "cancelled",
]);
export const mediaContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/quicktime",
  "video/mp4",
]);
/** Content-free processing outcomes; never a tool message or a file name. */
export const mediaFailureCodeSchema = z.enum([
  "unsupported_type",
  "decode_failed",
  "dimensions_exceeded",
  "duration_exceeded",
  "stream_layout_unsupported",
  "animated_image_unsupported",
  "pairing_mismatch",
  "size_mismatch",
  "processing_timeout",
  "processing_failed",
]);
export const mediaPairingMethodSchema = z.enum([
  "apple-content-identifier",
  "motion-photo-container",
  "none",
]);
export const mediaVariantSchema = z.enum([
  "thumb",
  "display",
  "full",
  "motion",
  "cover",
]);
/** `base` for the unedited derivative, otherwise the 32-hex key of one edit. */
export const mediaEditKeySchema = z.string().regex(/^(?:base|[0-9a-f]{32})$/u);
export const workVisibilitySchema = z.enum(["public", "self"]);
export const workAuthorshipKindSchema = z.enum([
  "original",
  "copy_practice",
  "material_sharing",
]);
export const publishingDraftKindSchema = z.enum(["new", "edit"]);
export const workSnapshotKindSchema = z.enum([
  "saved",
  "submitted",
  "published",
  "conflict",
  "restored",
  "legacy_draft",
]);
/** Coarse only; never a model, user agent or device identifier. */
export const publishingDeviceClassSchema = z.enum([
  "phone",
  "tablet",
  "desktop",
]);
export const publishingSessionStateSchema = z.enum([
  "active",
  "submitted",
  "discarded",
  "expired",
]);

/**
 * Where text is checked. A draft (and every read of stored or legacy text)
 * keeps line breaks as typed or stored: Phase 4 accepted CR and LF in titles,
 * and a draft must stay saveable (C04). A submission also enforces the
 * single-line rule, and the Backend stores the normalized form.
 */
type PublishingTextStage = "draft" | "submission";

interface PublishingTextCodes {
  readonly tooLong: string;
  readonly lineBreak: string;
}

/**
 * Author input: raw text within the draft allowance whose normalized form is
 * within the limit (see work-publishing-text.ts).
 */
const publishingTextSchema = (
  rule: PublishingTextRule,
  codes: PublishingTextCodes,
  stage: PublishingTextStage,
) =>
  z
    .string()
    .max((rule.maximum + (rule.rawAllowance ?? 0)) * 2, {
      abort: true,
      message: codes.tooLong,
    })
    .superRefine((value, context) => {
      const { issue } = checkPublishingText(value, rule);
      if (issue === null || (issue === "line_break" && stage === "draft"))
        return;
      context.addIssue({
        code: "custom",
        message:
          issue === "too_long"
            ? codes.tooLong
            : issue === "line_break"
              ? codes.lineBreak
              : issue,
      });
    });

/**
 * Output text derived from stored content (titles, excerpts, bodies): trimmed,
 * free of NUL and lone surrogates, and within the code-point limit. Line
 * breaks are returned as stored, so Phase 4 text with CR or LF stays readable.
 */
export const storedPublishingTextSchema = (maximum: number) =>
  z
    .string()
    .max(maximum * 2, { abort: true })
    .refine(
      (value) =>
        value === value.trim() &&
        !hasInvalidPublishingCharacters(value) &&
        codePointLength(value) <= maximum,
      { message: "text must be trimmed and within its limit" },
    );

const authorshipTextSchema = (
  maximum: number,
  singleLine: boolean,
  tooLong: string,
  stage: PublishingTextStage,
) =>
  publishingTextSchema(
    { maximum, singleLine, rawAllowance: DRAFT_TEXT_RAW_ALLOWANCE },
    { tooLong, lineBreak: "line_break" },
    stage,
  );

/** Original works carry no reference; the other kinds may name one. No other metadata. */
const authorshipSchema = (stage: PublishingTextStage) => {
  const referenced = {
    referenceTitle: authorshipTextSchema(
      AUTHORSHIP_REFERENCE_TITLE_MAXIMUM,
      true,
      "reference_title_too_long",
      stage,
    ).optional(),
    originalAuthor: authorshipTextSchema(
      AUTHORSHIP_ORIGINAL_AUTHOR_MAXIMUM,
      true,
      "original_author_too_long",
      stage,
    ).optional(),
    sourceNote: authorshipTextSchema(
      AUTHORSHIP_SOURCE_NOTE_MAXIMUM,
      false,
      "source_note_too_long",
      stage,
    ).optional(),
  };
  return z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("original") }),
    z.strictObject({ kind: z.literal("copy_practice"), ...referenced }),
    z.strictObject({ kind: z.literal("material_sharing"), ...referenced }),
  ]);
};

/**
 * A declared authorship in drafts and in every read; submissions add the
 * single-line rule. Content carries `null` while the author has declared
 * none (legacy Phase 4 works never declared one); nothing defaults to
 * `original` (C05).
 */
export const workAuthorshipSchema = authorshipSchema("draft");

export const MEDIA_CROP_MINIMUM = 0.01;
/** Absorbs floating-point rounding of client-computed edges only; pixel extracts clamp to the frame. */
const CROP_EDGE_TOLERANCE = 1e-9;

/**
 * Normalized to the edited frame: the source in its display orientation
 * (EXIF orientation, HEIF `irot`, video display matrix), then turned clockwise
 * by `rotation`. Every edge lies inside the unit square. The Backend rounds
 * edges to pixels and clamps the region to the frame. A cover crop is
 * normalized to the item's edited frame (after its own rotation and crop).
 */
export const mediaCropSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(MEDIA_CROP_MINIMUM).max(1),
    height: z.number().min(MEDIA_CROP_MINIMUM).max(1),
  })
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1 + CROP_EDGE_TOLERANCE)
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "crop must end inside the right edge",
      });
    if (crop.y + crop.height > 1 + CROP_EDGE_TOLERANCE)
      context.addIssue({
        code: "custom",
        path: ["height"],
        message: "crop must end inside the bottom edge",
      });
  });

export const mediaRotationSchema = z.literal([0, 90, 180, 270]);

/** Rotate and optional crop only: no filters, overlays, text or trimming. */
export const mediaEditSchema = z.strictObject({
  rotation: mediaRotationSchema,
  crop: mediaCropSchema.nullable(),
});

/** The client's stable item key, independent of upload completion order. */
export const workDraftItemKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/u);

/**
 * Presentation provenance of one draft item: `clipboard` marks media pasted
 * from the clipboard, so the editor keeps labelling it as not camera-original
 * after a reload or restore. Private to the author's drafts and editable
 * content; never used for authorization, readiness or publication decisions.
 */
export const workDraftItemOriginSchema = z.literal("clipboard");

/**
 * One logical item in draft content. A pending placeholder (no `itemId`) is
 * allowed only in drafts; raw file names are never stored, only a coarse label.
 */
export const workDraftItemSchema = z
  .strictObject({
    key: workDraftItemKeySchema,
    itemId: mediaItemIdSchema.nullable(),
    kind: mediaItemKindSchema,
    qualityMode: mediaQualityModeSchema,
    edit: mediaEditSchema,
    pendingLabel: z.enum(["photo", "live"]).optional(),
    origin: workDraftItemOriginSchema.optional(),
  })
  .superRefine((item, context) => {
    if (item.itemId !== null && item.pendingLabel !== undefined)
      context.addIssue({
        code: "custom",
        path: ["pendingLabel"],
        message: "only a pending item carries a pending label",
      });
    if (
      item.pendingLabel !== undefined &&
      (item.pendingLabel === "live") !== (item.kind === "live")
    )
      context.addIssue({
        code: "custom",
        path: ["pendingLabel"],
        message: "the pending label must match the item kind",
      });
    if (item.itemId === null && item.qualityMode === "legacy")
      context.addIssue({
        code: "custom",
        path: ["qualityMode"],
        message: "a legacy item always has an item id",
      });
  });

const workContentShape = (stage: PublishingTextStage) => ({
  mentions: mentionReferencesSchema.optional(),
  title: publishingTextSchema(
    publishingTitleRule,
    { tooLong: "title_too_long", lineBreak: "title_line_break" },
    stage,
  ),
  body: publishingTextSchema(
    publishingBodyRule,
    { tooLong: "body_too_long", lineBreak: "line_break" },
    stage,
  ),
  /** `null` = not set: no authorship is claimed for the work. */
  authorship: (stage === "draft"
    ? workAuthorshipSchema
    : authorshipSchema(stage)
  ).nullable(),
  visibility: workVisibilitySchema,
  items: z
    .array(workDraftItemSchema)
    .max(WORK_ITEMS_HARD_MAXIMUM, { message: "items_limit" }),
  coverKey: workDraftItemKeySchema.nullable(),
  coverCrop: mediaCropSchema.nullable(),
});

interface WorkContentReferences {
  readonly items: readonly {
    readonly key: string;
    readonly itemId: string | null;
  }[];
  readonly coverKey: string | null;
  readonly coverCrop: unknown;
}

const checkContentReferences = (
  content: WorkContentReferences,
  context: z.RefinementCtx,
): void => {
  const keys = new Set(content.items.map((item) => item.key));
  if (keys.size !== content.items.length)
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "item keys must be unique",
    });
  const itemIds = content.items.flatMap((item) =>
    item.itemId === null ? [] : [item.itemId],
  );
  if (new Set(itemIds).size !== itemIds.length)
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "an item appears at most once",
    });
  if (content.coverKey !== null && !keys.has(content.coverKey))
    context.addIssue({
      code: "custom",
      path: ["coverKey"],
      message: "the cover must reference an item key",
    });
  if (content.coverKey === null && content.coverCrop !== null)
    context.addIssue({
      code: "custom",
      path: ["coverCrop"],
      message: "a cover crop needs a selected cover",
    });
};

interface WorkContentEmptiness {
  readonly title: string;
  readonly body: string;
  readonly items: readonly unknown[];
}

/** Whitespace-only text is empty; any retained or pending item is content. */
export const isEmptyWorkContent = (content: WorkContentEmptiness): boolean =>
  normalizePublishingTitle(content.title) === "" &&
  normalizePublishingBody(content.body) === "" &&
  content.items.length === 0;

/**
 * DraftContent: incomplete content is saveable before publishing requirements.
 * Also the read shape of stored drafts, snapshots, conflict copies and the
 * editable view, so legacy Phase 4 text (a title with a line break, a body
 * with CR) opens unchanged.
 */
export const workDraftContentSchema = z
  .strictObject(workContentShape("draft"))
  .superRefine(checkContentReferences);

/**
 * Submitted content: normalized text rules (a single-line title) and not
 * empty. Pending placeholders and items that are not ready are not a
 * validation failure: the Backend answers them with the `not_ready` result
 * listing their keys, so readiness has one channel.
 */
export const workSubmissionContentSchema = z
  .strictObject(workContentShape("submission"))
  .superRefine(checkContentReferences)
  .superRefine((content, context) => {
    if (!validMentionReferences(content.body, content.mentions ?? []))
      context.addIssue({
        code: "custom",
        message: "Invalid mention references",
      });
    if (isEmptyWorkContent(content))
      context.addIssue({ code: "custom", message: "empty_work" });
  });

export const PUBLISHING_MEDIA_PATH_PREFIX = "/api/community/publishing/media/";

const publishingMediaSrcPattern =
  /^\/api\/community\/publishing\/media\/(media-item-[0-9a-f]{32})\/(thumb|display|full|motion|cover)\/(?:base|[0-9a-f]{32})$/u;

/** The same-origin derivative path; sources and originals are never addressable. */
export const publishingMediaSrcSchema = z
  .string()
  .regex(publishingMediaSrcPattern);

/** A Phase 4 PNG, also the source of a legacy media item (served from user media, not derivatives). */
export const legacyMediaSrcSchema = z
  .string()
  .regex(/^\/api\/community\/media\/user-media-[0-9a-f]{32}$/u);

const legacyMediaIdSchema = platformId("user-media");

/** The id of one work media entry: a Phase 4 user media PNG or a media item. */
export const workMediaIdSchema = z.union([
  legacyMediaIdSchema,
  mediaItemIdSchema,
]);

/** The item id and variant a derivative path names, or null for any other path. */
const publishingMediaSrcParts = (
  src: string,
): { readonly itemId: string; readonly variant: string } | null => {
  const [, itemId, variant] = publishingMediaSrcPattern.exec(src) ?? [];
  return itemId === undefined || variant === undefined
    ? null
    : { itemId, variant };
};

/** A still image path: a derivative, or the Phase 4 PNG of a legacy item. */
const stillSrcSchema = z.union([
  publishingMediaSrcSchema,
  legacyMediaSrcSchema,
]);

/** A work's card cover still: a still derivative path or a Phase 4 PNG, never motion. */
export const workCoverSrcSchema = stillSrcSchema.refine(
  (src) => publishingMediaSrcParts(src)?.variant !== "motion",
  { message: "a cover is a still image" },
);

export const publishingMediaComponentSchema = z
  .strictObject({
    id: mediaComponentIdSchema,
    role: mediaComponentRoleSchema,
    state: mediaComponentStateSchema,
    byteSize: byteSizeSchema,
    receivedBytes: receivedBytesSchema,
  })
  .refine((component) => component.receivedBytes <= component.byteSize, {
    path: ["receivedBytes"],
    message: "received bytes cannot exceed the declared size",
  });

export const mediaPresentationSchema = z.strictObject({
  width: dimensionSchema,
  height: dimensionSchema,
  durationMs: z.number().int().positive().max(60_000).optional(),
  hasAudio: z.boolean().optional(),
});

/**
 * Derivative paths of one item. A legacy item has no derivatives: its still
 * paths are the Phase 4 user media path (thumb and display may be equal) and
 * it has no motion.
 */
export const publishingMediaSourcesSchema = z.strictObject({
  thumbSrc: stillSrcSchema,
  displaySrc: stillSrcSchema,
  fullSrc: stillSrcSchema.optional(),
  motionSrc: publishingMediaSrcSchema.optional(),
});

const sourceVariants = {
  thumbSrc: "thumb",
  displaySrc: "display",
  fullSrc: "full",
  motionSrc: "motion",
} as const;

const liveRoleLayouts = ["motion,still", "package"];

const roleLayout = (roles: readonly string[]): string =>
  [...roles].sort().join(",");

/** The owner's view of one private media item; derivative paths only when ready. */
export const publishingMediaItemSchema = z
  .strictObject({
    id: mediaItemIdSchema,
    kind: mediaItemKindSchema,
    qualityMode: mediaQualityModeSchema,
    state: mediaItemStateSchema,
    failureCode: mediaFailureCodeSchema.nullable(),
    components: z.array(publishingMediaComponentSchema).max(2),
    presentation: mediaPresentationSchema.nullable(),
    media: publishingMediaSourcesSchema.nullable(),
  })
  .superRefine((item, context) => {
    const ready = item.state === "ready";
    const legacy = item.qualityMode === "legacy";
    if (legacy && item.kind !== "static")
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "a legacy item is a static image",
      });
    for (const [field, variant] of Object.entries(sourceVariants)) {
      const src = item.media?.[field as keyof typeof sourceVariants];
      if (src === undefined) continue;
      const parts = publishingMediaSrcParts(src);
      if (
        legacy
          ? parts !== null
          : parts === null ||
            parts.itemId !== item.id ||
            parts.variant !== variant
      )
        context.addIssue({
          code: "custom",
          path: ["media", field],
          message: legacy
            ? "a legacy item is served from its user media path"
            : "a derivative path must name this item and its variant",
        });
    }
    if ((item.media !== null) !== ready)
      context.addIssue({
        code: "custom",
        path: ["media"],
        message: "derivative paths are present exactly when the item is ready",
      });
    if (ready && item.presentation === null)
      context.addIssue({
        code: "custom",
        path: ["presentation"],
        message: "a ready item has a presentation",
      });
    if ((item.failureCode !== null) !== (item.state === "failed"))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "a failure code is present exactly when the item failed",
      });
    const roles = item.components.map((component) => component.role);
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "component roles must be unique",
      });
    if (item.qualityMode !== "legacy" && roles.length === 0)
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "an uploaded item has components",
      });
    if (
      roles.length > 0 &&
      (item.kind === "static"
        ? roleLayout(roles) !== "still"
        : !liveRoleLayouts.includes(roleLayout(roles)))
    )
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "component roles do not match the item kind",
      });
    if (item.kind === "static") {
      if (item.media?.motionSrc !== undefined)
        context.addIssue({
          code: "custom",
          path: ["media", "motionSrc"],
          message: "a static item has no motion",
        });
      if (
        item.presentation?.durationMs !== undefined ||
        item.presentation?.hasAudio !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["presentation"],
          message: "a static item has no duration or audio",
        });
    } else if (item.media !== null && item.media.motionSrc === undefined)
      context.addIssue({
        code: "custom",
        path: ["media", "motionSrc"],
        message: "a ready Live Photo has motion",
      });
  });

/**
 * One ordered media entry of a work as its viewers see it: a Phase 4 PNG
 * (`user-media-…`, unchanged), a legacy item wrapping that PNG, or a ready
 * work publishing item. Avatars keep `authorMediaSchema`.
 */
export const workMediaSchema = z
  .strictObject({
    id: workMediaIdSchema,
    src: stillSrcSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    kind: mediaItemKindSchema.optional(),
    motionSrc: publishingMediaSrcSchema.optional(),
    hasAudio: z.boolean().optional(),
  })
  .superRefine((media, context) => {
    const parts = publishingMediaSrcParts(media.src);
    const srcMatchesId = media.id.startsWith("user-media-")
      ? media.src === `/api/community/media/${media.id}`
      : parts === null
        ? media.kind !== "live"
        : parts.itemId === media.id && parts.variant !== "motion";
    if (!srcMatchesId)
      context.addIssue({
        code: "custom",
        path: ["src"],
        message: "the media path must belong to this media id",
      });
    const live = media.kind === "live";
    const motion =
      media.motionSrc === undefined
        ? null
        : publishingMediaSrcParts(media.motionSrc);
    if (
      live
        ? motion === null ||
          motion.itemId !== media.id ||
          motion.variant !== "motion"
        : media.motionSrc !== undefined || media.hasAudio !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["motionSrc"],
        message:
          "a Live Photo has its own motion path and only a Live Photo has motion or audio",
      });
  });

/**
 * How a Standard component's bytes were produced: `optimized` is browser
 * output; `retained` keeps an already-small JPEG, PNG or WebP input
 * unchanged only after the browser's optimization attempt produced no
 * meaningful saving (Q04); HEIC/HEIF and QuickTime are never retained. An
 * Original component names neither.
 */
export const standardComponentOutcomeSchema = z.enum(["optimized", "retained"]);

export const mediaComponentDeclarationSchema = z.strictObject({
  role: mediaComponentRoleSchema,
  byteSize: byteSizeSchema,
  contentType: mediaContentTypeSchema,
  standardOutcome: standardComponentOutcomeSchema.optional(),
});

/**
 * Pairing proven by the client from source bytes before Standard optimization
 * strips it. `stillTimeMs` is the still's presentation time in the motion
 * (L09), which the Backend cannot recover from a transcoded master.
 */
export const mediaClientPairingSchema = z
  .strictObject({
    method: mediaPairingMethodSchema,
    identifierSha256: sha256Schema.optional(),
    stillTimeMs: z.number().int().nonnegative().max(60_000).optional(),
  })
  .superRefine((pairing, context) => {
    if (
      (pairing.method === "apple-content-identifier") !==
      (pairing.identifierSha256 !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["identifierSha256"],
        message:
          "only a content identifier pairing carries an identifier digest",
      });
    if (pairing.method === "none" && pairing.stillTimeMs !== undefined)
      context.addIssue({
        code: "custom",
        path: ["stillTimeMs"],
        message: "only a paired Live Photo carries a still time",
      });
  });

/** The documented browser optimization profiles (Q04, L09), recorded per Standard item. */
export const mediaProcessingProfileSchema = z.enum([
  "standard-image-v1",
  "standard-live-v1",
]);

export const MEDIA_METADATA_MAXIMUM_BYTES = 16 * 1024;
const MEDIA_METADATA_MAXIMUM_KEYS = 256;

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;
  }
  return bytes;
};

const metadataStringSchema = z
  .string()
  .max(512)
  .refine((value) => !hasInvalidPublishingCharacters(value), {
    message: "invalid_characters",
  });
const metadataScalarSchema = z.union([
  metadataStringSchema,
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * How the browser received the selected file: the native picker, a desktop
 * drop or a clipboard paste. Untrusted presentation provenance only.
 */
export const mediaClientSourceSchema = z.enum(["picker", "drop", "clipboard"]);

/**
 * Private, untrusted, bounded metadata read before optimization, with its
 * provenance. Stored privately only; never in public JSON, logs or derivatives.
 */
export const mediaMetadataSchema = z
  .strictObject({
    provenance: z.strictObject({
      source: z.literal("client"),
      parser: z.string().regex(/^[A-Za-z0-9@._/-]{1,64}$/u),
      status: z.enum(["parsed", "partial", "absent"]),
      clientSource: mediaClientSourceSchema.optional(),
    }),
    values: z.record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u),
      z.union([metadataScalarSchema, z.array(metadataScalarSchema).max(64)]),
    ),
  })
  .superRefine((metadata, context) => {
    const keyCount = Object.keys(metadata.values).length;
    if (keyCount > MEDIA_METADATA_MAXIMUM_KEYS)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "too many metadata values",
      });
    if (metadata.provenance.status === "absent" && keyCount !== 0)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "absent metadata has no values",
      });
    if (utf8ByteLength(JSON.stringify(metadata)) > MEDIA_METADATA_MAXIMUM_BYTES)
      context.addIssue({
        code: "custom",
        message: "metadata exceeds its serialized bound",
      });
  });

/** A draft (saved mode) or a temporary session (no-save mode) holds uploads. */
export const publishingHolderSchema = z.union([
  z.strictObject({ draftId: workDraftIdSchema }),
  z.strictObject({ sessionId: publishingSessionIdSchema }),
]);

const stillContentTypes: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];
const motionContentTypes: readonly string[] = ["video/quicktime", "video/mp4"];
const packageContentTypes: readonly string[] = [
  "image/jpeg",
  "image/heic",
  "image/heif",
];
/**
 * Optimized Standard masters are browser output. A retained Standard master
 * keeps an already-small JPEG, PNG or WebP input unchanged
 * only after an optimization attempt proved no saving; a HEIC/HEIF still or
 * QuickTime motion is never accepted as Standard, retained or not — the
 * browser offers Original or remove instead. Source motion is never retained;
 * Standard motion must be a transcoded MP4 master.
 */
const standardStillContentTypes: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];
const standardMotionContentTypes: readonly string[] = ["video/mp4"];
const retainedStandardStillContentTypes: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];
const retainedStandardMotionContentTypes: readonly string[] = [];

/**
 * Registers one logical item before any bytes move: a static image (one
 * still) or a complete Live Photo (still + motion, or one container package).
 * A Standard item names the browser profile that produced its master; an
 * Original item has none.
 */
export const registerMediaItemCommandSchema = z
  .strictObject({
    requestId: requestIdSchema,
    holder: publishingHolderSchema,
    kind: mediaItemKindSchema,
    qualityMode: mediaUploadQualityModeSchema,
    processingProfile: mediaProcessingProfileSchema.optional(),
    components: z.array(mediaComponentDeclarationSchema).min(1).max(2),
    clientPairing: mediaClientPairingSchema.optional(),
    metadata: mediaMetadataSchema.optional(),
  })
  .superRefine((command, context) => {
    const layout = roleLayout(command.components.map(({ role }) => role));
    const standard = command.qualityMode === "standard";
    const expectedProfile = standard
      ? command.kind === "static"
        ? "standard-image-v1"
        : "standard-live-v1"
      : undefined;
    if (command.processingProfile !== expectedProfile)
      context.addIssue({
        code: "custom",
        path: ["processingProfile"],
        message:
          "a Standard item names the profile for its kind and an Original item names none",
      });
    if (
      command.kind === "static"
        ? layout !== "still"
        : !liveRoleLayouts.includes(layout)
    ) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "unsupported_type",
      });
      return;
    }
    command.components.forEach((component, index) => {
      if (standard !== (component.standardOutcome !== undefined))
        context.addIssue({
          code: "custom",
          path: ["components", index, "standardOutcome"],
          message:
            "a Standard component names its outcome and an Original component names none",
        });
      const retained = component.standardOutcome === "retained";
      const allowed =
        component.role === "still"
          ? standard
            ? retained
              ? retainedStandardStillContentTypes
              : standardStillContentTypes
            : stillContentTypes
          : component.role === "motion"
            ? standard
              ? retained
                ? retainedStandardMotionContentTypes
                : standardMotionContentTypes
              : motionContentTypes
            : standard
              ? []
              : packageContentTypes;
      if (!allowed.includes(component.contentType))
        context.addIssue({
          code: "custom",
          path: ["components", index, "contentType"],
          message: "unsupported_type",
        });
    });
    const method = command.clientPairing?.method;
    const pairingValid =
      command.kind === "static"
        ? method === undefined || method === "none"
        : layout === "package"
          ? method === "motion-photo-container"
          : method === "apple-content-identifier" ||
            (standard && method === "motion-photo-container");
    if (!pairingValid)
      context.addIssue({
        code: "custom",
        path: ["clientPairing"],
        message: "pairing_mismatch",
      });
  });

export const publishingUploadResultSchema = z.strictObject({
  componentId: mediaComponentIdSchema,
  sha256: sha256Schema,
  receivedBytes: receivedBytesSchema,
  item: publishingMediaItemSchema,
});

const pageShape = <Item extends z.ZodType>(item: Item) => ({
  items: z.array(item).max(50),
  total: countSchema,
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalPages: countSchema,
});

export const publishingPageQuerySchema = z.strictObject({
  page: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(10000))
    .default(1),
  pageSize: z
    .union([z.number(), z.string().regex(/^[1-9]\d*$/u)])
    .pipe(z.coerce.number<string | number>().int().min(1).max(50))
    .default(20),
});

/** Created only on first real content; an empty draft is never stored. */
export const createPublishingDraftCommandSchema = z
  .strictObject({
    requestId: requestIdSchema,
    content: workDraftContentSchema,
    deviceClass: publishingDeviceClassSchema.nullable(),
  })
  .superRefine((command, context) => {
    if (isEmptyWorkContent(command.content))
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "empty_work",
      });
  });

/** Opens (or creates) the private edit draft of an existing work. */
export const openWorkEditDraftCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  deviceClass: publishingDeviceClassSchema.nullable(),
});

/** Revision-conditional save; also the body of Save now. */
export const savePublishingDraftCommandSchema = z.strictObject({
  baseRevision: revisionSchema,
  content: workDraftContentSchema,
  deviceClass: publishingDeviceClassSchema.nullable(),
});

/** Both recoverable versions of one concurrent edit, with real content. */
export const publishingDraftConflictSchema = z.strictObject({
  id: workDraftIdSchema,
  device: z.strictObject({
    content: workDraftContentSchema,
    baseRevision: revisionSchema,
    deviceClass: publishingDeviceClassSchema.nullable(),
    savedAt: timestampSchema,
  }),
  account: z.strictObject({
    content: workDraftContentSchema,
    revision: revisionSchema,
    deviceClass: publishingDeviceClassSchema.nullable(),
    updatedAt: timestampSchema,
  }),
  createdAt: timestampSchema,
});

const draftKindMatchesWork = (draft: {
  readonly kind: "new" | "edit";
  readonly workId: string | null;
}): boolean => (draft.kind === "edit") === (draft.workId !== null);

const draftKindIssue = {
  path: ["workId"],
  message: "an edit draft names its work and a new draft does not",
};

export const publishingDraftSchema = z
  .strictObject({
    id: workDraftIdSchema,
    kind: publishingDraftKindSchema,
    workId: workIdSchema.nullable(),
    /** The work revision an edit draft started from; the submission's stale-base check uses it. */
    baseRevisionId: workRevisionIdSchema.nullable(),
    revision: revisionSchema,
    content: workDraftContentSchema,
    mediaItems: z.array(publishingMediaItemSchema).max(WORK_ITEMS_HARD_MAXIMUM),
    conflict: publishingDraftConflictSchema.nullable(),
    deviceClass: publishingDeviceClassSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine(draftKindMatchesWork, draftKindIssue)
  .refine(
    (draft) => (draft.workId === null) === (draft.baseRevisionId === null),
    {
      path: ["baseRevisionId"],
      message: "an edit draft names its base revision and a new draft does not",
    },
  );

/**
 * The answer of `POST publishing/works/:workId/draft`: the work's active edit
 * draft, and whether this request inserted it. `created` is false when an
 * existing draft (from another device or an earlier request) was returned, so
 * a client deletes an untouched edit draft on leaving only when it created
 * that draft itself. A retried request identity answers as the original
 * request did.
 */
export const publishingOpenedEditDraftSchema = z
  .strictObject({
    draft: publishingDraftSchema,
    created: z.boolean(),
  })
  .refine(({ draft }) => draft.kind === "edit", {
    path: ["draft", "kind"],
    message: "an opened edit draft is an edit draft",
  });

export const publishingDraftSummarySchema = z
  .strictObject({
    id: workDraftIdSchema,
    kind: publishingDraftKindSchema,
    workId: workIdSchema.nullable(),
    title: storedPublishingTextSchema(WORK_TITLE_MAXIMUM),
    excerpt: storedPublishingTextSchema(WORK_EXCERPT_MAXIMUM),
    coverSrc: stillSrcSchema.nullable(),
    itemCount: itemCountSchema,
    /** Items still pending on some device: no uploaded item yet. */
    missingLocalCount: itemCountSchema,
    deviceClass: publishingDeviceClassSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .refine(draftKindMatchesWork, draftKindIssue)
  .refine((summary) => summary.missingLocalCount <= summary.itemCount, {
    path: ["missingLocalCount"],
    message: "missing items cannot exceed items",
  });

/** The owner's draft picker, newest first. */
export const publishingDraftPageSchema = z.strictObject(
  pageShape(publishingDraftSummarySchema),
);

export const publishingDraftSaveResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("saved"),
    draft: publishingDraftSchema,
  }),
  z
    .strictObject({
      status: z.literal("conflict"),
      draft: publishingDraftSchema,
      conflict: publishingDraftConflictSchema,
    })
    .refine((result) => result.draft.conflict?.id === result.conflict.id, {
      path: ["draft", "conflict"],
      message: "the draft carries the conflict this save created",
    }),
]);

/**
 * Targeted draft deletion (D06). `expectedRevision` is the draft revision the
 * author confirmed the deletion against. The deletion is refused with a 409
 * CONFLICT whose message is `draft_changed`, and nothing is removed, when the
 * stored draft revision differs (a save from another device on the current
 * base advanced it) or when the draft has any unresolved conflict copy (a
 * save on an outdated base, which leaves the revision unchanged). A guarded
 * deletion therefore never removes content saved elsewhere unseen; while a
 * conflict copy is unresolved it is refused even when the author saw that
 * copy. Without `expectedRevision` nothing is checked: the current draft is
 * deleted with its conflict copies.
 */
export const publishingDraftDeletionCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  expectedRevision: revisionSchema.optional(),
});

/** The conflict message of a draft deletion confirmed against an older revision. */
export const PUBLISHING_DRAFT_CHANGED = "draft_changed";

/** The targeted deletion scope: that draft, its history, conflict copies and exclusive media. */
export const publishingDraftDeletionResultSchema = z.strictObject({
  deleted: z.literal(true),
  snapshots: countSchema,
  conflictCopies: countSchema,
  mediaItems: countSchema,
});

export const publishingSnapshotSchema = z.strictObject({
  id: workSnapshotIdSchema,
  kind: workSnapshotKindSchema,
  draftId: workDraftIdSchema.nullable(),
  workId: workIdSchema.nullable(),
  sourceRevision: revisionSchema.nullable(),
  pinned: z.boolean(),
  createdAt: timestampSchema,
  content: workDraftContentSchema,
});

export const publishingSnapshotPageSchema = z.strictObject(
  pageShape(publishingSnapshotSchema),
);

export const restorePublishingSnapshotCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  snapshotId: workSnapshotIdSchema,
});

export const resolvePublishingConflictCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  conflictId: workDraftIdSchema,
  choice: z.enum(["device", "account"]),
});

/** No-save mode: a minimal temporary media holder with a bounded lease. */
export const createPublishingSessionCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  workId: workIdSchema.nullable(),
});

export const publishingSessionHeartbeatCommandSchema = z.strictObject({});

export const publishingSessionSchema = z.strictObject({
  id: publishingSessionIdSchema,
  state: publishingSessionStateSchema,
  workId: workIdSchema.nullable(),
  leaseExpiresAt: timestampSchema,
  createdAt: timestampSchema,
});

/**
 * Explicit, idempotent by requestId, tied to one immutable revision.
 * `baseRevisionId` is the revision the edit started from: the draft's
 * `baseRevisionId` for a draft holder, the opened `EditableWork.revisionId`
 * for a no-save session, and null for a new work.
 */
export const workSubmissionCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  holder: publishingHolderSchema,
  content: workSubmissionContentSchema,
  baseRevisionId: workRevisionIdSchema.nullable(),
  /**
   * content-community-completion-v1: publish this new Work into a Thread. The
   * association commits in the same transaction as the submission; at most
   * three static items; never reassigns an existing Work.
   */
  threadId: z
    .string()
    .regex(/^thread-[0-9a-f]{32}$/u)
    .optional(),
});

/** Author-neutral confirmation; the same receipt answers a lost-response query. */
export const workSubmissionReceiptSchema = z.strictObject({
  state: z.literal("confirmed"),
  requestId: requestIdSchema,
  workId: workIdSchema,
  revisionId: workRevisionIdSchema,
  visibility: workVisibilitySchema,
  submittedAt: timestampSchema,
});

export const workSubmissionNotReadySchema = z.strictObject({
  state: z.literal("not_ready"),
  itemKeys: z.array(workDraftItemKeySchema).min(1).max(WORK_ITEMS_HARD_MAXIMUM),
});

export const workSubmissionResultSchema = z.discriminatedUnion("state", [
  workSubmissionReceiptSchema,
  workSubmissionNotReadySchema,
]);

/**
 * Explicit readiness check of a holder's current content (`POST
 * drafts/:draftId/readiness`, `sessions/:sessionId/readiness`): the Backend
 * starts any missing edit derivative at once and reports which item keys
 * still wait or failed, so the editor never claims readiness the
 * submission would refuse as `not_ready`.
 */
export const publishingReadinessCommandSchema = z.strictObject({
  content: workDraftContentSchema,
});

/**
 * `pendingItemKeys`: placeholders, items still uploading or processing, and
 * ready items whose edit derivatives are still being made. `failedItemKeys`:
 * failed or unavailable items and edits whose derivation failed (remove or
 * retry). `editKeys`: for ready items whose thumb and cover derivatives are
 * stored under an edit key other than `base` (the cover crop included for
 * the cover item), that key; the thumb path is `<media path>/thumb/<key>`.
 */
export const publishingReadinessSchema = z
  .strictObject({
    ready: z.boolean(),
    pendingItemKeys: z
      .array(workDraftItemKeySchema)
      .max(WORK_ITEMS_HARD_MAXIMUM),
    failedItemKeys: z
      .array(workDraftItemKeySchema)
      .max(WORK_ITEMS_HARD_MAXIMUM),
    editKeys: z.record(workDraftItemKeySchema, mediaEditKeySchema),
  })
  .refine(
    (readiness) =>
      readiness.ready ===
      (readiness.pendingItemKeys.length === 0 &&
        readiness.failedItemKeys.length === 0),
    { path: ["ready"], message: "ready exactly when no item waits or failed" },
  )
  .refine(
    (readiness) =>
      Object.values(readiness.editKeys).every((key) => key !== "base"),
    { path: ["editKeys"], message: "base thumbs keep the item's own src" },
  );

/** The author's current revision prepared for editing. */
export const editableWorkSchema = z.strictObject({
  workId: workIdSchema,
  revisionId: workRevisionIdSchema,
  content: workDraftContentSchema,
  mediaItems: z.array(publishingMediaItemSchema).max(WORK_ITEMS_HARD_MAXIMUM),
  visibility: workVisibilitySchema,
  firstPublishedAt: timestampSchema.nullable(),
  editedAt: timestampSchema.nullable(),
  draftId: workDraftIdSchema.nullable(),
  version: versionSchema,
});

export const workVisibilityCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  visibility: workVisibilitySchema,
});

export const workVisibilityResultSchema = z.strictObject({
  workId: workIdSchema,
  visibility: workVisibilitySchema,
});

/** What the client needs for honest counters and early feedback; the Backend still enforces. */
export const publishingLimitsSchema = z.strictObject({
  maxItems: z.number().int().min(1).max(WORK_ITEMS_CONFIGURABLE_MAXIMUM),
  originalItemMaxBytes: byteSizeSchema,
  standardComponentMaxBytes: byteSizeSchema,
  titleMax: z.number().int().positive(),
  bodyMax: z.number().int().positive(),
});

export type WorkPublishingFailureCode = z.infer<
  typeof workPublishingFailureCodeSchema
>;
export type MediaItemKind = z.infer<typeof mediaItemKindSchema>;
export type MediaQualityMode = z.infer<typeof mediaQualityModeSchema>;
export type MediaUploadQualityMode = z.infer<
  typeof mediaUploadQualityModeSchema
>;
export type MediaItemState = z.infer<typeof mediaItemStateSchema>;
export type MediaComponentRole = z.infer<typeof mediaComponentRoleSchema>;
export type MediaComponentState = z.infer<typeof mediaComponentStateSchema>;
export type MediaContentType = z.infer<typeof mediaContentTypeSchema>;
export type MediaFailureCode = z.infer<typeof mediaFailureCodeSchema>;
export type MediaPairingMethod = z.infer<typeof mediaPairingMethodSchema>;
export type MediaVariant = z.infer<typeof mediaVariantSchema>;
export type WorkVisibility = z.infer<typeof workVisibilitySchema>;
export type WorkAuthorshipKind = z.infer<typeof workAuthorshipKindSchema>;
export type WorkAuthorship = z.infer<typeof workAuthorshipSchema>;
export type PublishingDraftKind = z.infer<typeof publishingDraftKindSchema>;
export type WorkSnapshotKind = z.infer<typeof workSnapshotKindSchema>;
export type PublishingDeviceClass = z.infer<typeof publishingDeviceClassSchema>;
export type PublishingSessionState = z.infer<
  typeof publishingSessionStateSchema
>;
export type MediaCrop = z.infer<typeof mediaCropSchema>;
export type MediaRotation = z.infer<typeof mediaRotationSchema>;
export type MediaEdit = z.infer<typeof mediaEditSchema>;
export type WorkDraftItem = z.infer<typeof workDraftItemSchema>;
export type WorkDraftItemOrigin = z.infer<typeof workDraftItemOriginSchema>;
export type WorkDraftContent = z.infer<typeof workDraftContentSchema>;
export type WorkSubmissionContent = z.infer<typeof workSubmissionContentSchema>;
export type PublishingMediaComponent = z.infer<
  typeof publishingMediaComponentSchema
>;
export type MediaPresentation = z.infer<typeof mediaPresentationSchema>;
export type PublishingMediaSources = z.infer<
  typeof publishingMediaSourcesSchema
>;
export type PublishingMediaItem = z.infer<typeof publishingMediaItemSchema>;
export type StandardComponentOutcome = z.infer<
  typeof standardComponentOutcomeSchema
>;
export type MediaComponentDeclaration = z.infer<
  typeof mediaComponentDeclarationSchema
>;
export type MediaClientPairing = z.infer<typeof mediaClientPairingSchema>;
export type MediaProcessingProfile = z.infer<
  typeof mediaProcessingProfileSchema
>;
export type WorkMedia = z.infer<typeof workMediaSchema>;
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;
export type MediaClientSource = z.infer<typeof mediaClientSourceSchema>;
export type PublishingHolder = z.infer<typeof publishingHolderSchema>;
export type RegisterMediaItemCommand = z.infer<
  typeof registerMediaItemCommandSchema
>;
export type PublishingUploadResult = z.infer<
  typeof publishingUploadResultSchema
>;
export type PublishingPageQuery = z.infer<typeof publishingPageQuerySchema>;
export type CreatePublishingDraftCommand = z.infer<
  typeof createPublishingDraftCommandSchema
>;
export type OpenWorkEditDraftCommand = z.infer<
  typeof openWorkEditDraftCommandSchema
>;
export type PublishingOpenedEditDraft = z.infer<
  typeof publishingOpenedEditDraftSchema
>;
export type SavePublishingDraftCommand = z.infer<
  typeof savePublishingDraftCommandSchema
>;
export type PublishingDraftConflict = z.infer<
  typeof publishingDraftConflictSchema
>;
export type PublishingDraft = z.infer<typeof publishingDraftSchema>;
export type PublishingDraftSummary = z.infer<
  typeof publishingDraftSummarySchema
>;
export type PublishingDraftPage = z.infer<typeof publishingDraftPageSchema>;
export type PublishingDraftSaveResult = z.infer<
  typeof publishingDraftSaveResultSchema
>;
export type PublishingDraftDeletionCommand = z.infer<
  typeof publishingDraftDeletionCommandSchema
>;
export type PublishingDraftDeletionResult = z.infer<
  typeof publishingDraftDeletionResultSchema
>;
export type PublishingSnapshot = z.infer<typeof publishingSnapshotSchema>;
export type PublishingSnapshotPage = z.infer<
  typeof publishingSnapshotPageSchema
>;
export type RestorePublishingSnapshotCommand = z.infer<
  typeof restorePublishingSnapshotCommandSchema
>;
export type ResolvePublishingConflictCommand = z.infer<
  typeof resolvePublishingConflictCommandSchema
>;
export type CreatePublishingSessionCommand = z.infer<
  typeof createPublishingSessionCommandSchema
>;
export type PublishingSession = z.infer<typeof publishingSessionSchema>;
export type WorkSubmissionCommand = z.infer<typeof workSubmissionCommandSchema>;
export type WorkSubmissionReceipt = z.infer<typeof workSubmissionReceiptSchema>;
export type WorkSubmissionNotReady = z.infer<
  typeof workSubmissionNotReadySchema
>;
export type WorkSubmissionResult = z.infer<typeof workSubmissionResultSchema>;
export type PublishingReadinessCommand = z.infer<
  typeof publishingReadinessCommandSchema
>;
export type PublishingReadiness = z.infer<typeof publishingReadinessSchema>;
export type EditableWork = z.infer<typeof editableWorkSchema>;
export type WorkVisibilityCommand = z.infer<typeof workVisibilityCommandSchema>;
export type WorkVisibilityResult = z.infer<typeof workVisibilityResultSchema>;
export type PublishingLimits = z.infer<typeof publishingLimitsSchema>;
