import { publishingMediaItemSchema } from "./work-publishing-schemas.ts";
import { z } from "zod";

/** Restricted BlockNote 0.55 document; browser, HTTP and MCP share these limits. */
export const ARTICLE_DOCUMENT_LIMITS = {
  blocks: 400,
  depth: 3,
  textCodePoints: 40_000,
  documentBytes: 1_048_576,
  imageReferences: 60,
  catalogRecords: 30,
  galleryImages: 20,
  titleCodePoints: 120,
  captionCodePoints: 200,
  blockEdits: 50,
} as const;

export const articleCodePointLength = (text: string): number =>
  [...text].length;
export const articleUtf8ByteLength = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

// Identical brand names give the existing public identity types, without a
// runtime import of schemas.ts (which re-exports this module).
const opaqueId = () => z.string().min(1).max(128).regex(/^\S+$/u);
export const articleAuthoringArticleIdSchema = z
  .string()
  .regex(/^article-[0-9a-f]{32}$/u)
  .brand<"ArticleId">();
const ownerIdSchema = opaqueId().brand<"PublicUserId">();
const catalogIdSchema = opaqueId().brand<"CatalogId">();
const catalogMediaIdSchema = opaqueId().brand<"MediaId">();
const itemIdSchema = z.string().regex(/^media-item-[0-9a-f]{32}$/u);
const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const versionSchema = z.number().int().min(1).max(2_147_483_647);
const requestIdSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ownEntry = <Value>(
  values: Record<string, Value>,
  key: string,
): Value | undefined => (Object.hasOwn(values, key) ? values[key] : undefined);

/* eslint-disable no-control-regex -- reject controls without Unicode normalization */
const invalidArticleText =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u;
const invalidArticleLink = /[\u0000-\u0020\u007F]/u;
/* eslint-enable no-control-regex */

/** Do not normalize historical variants, extended Unicode or explicit breaks. */
const textSchema = (maximum: number) =>
  z
    .string()
    .max(maximum * 2)
    .refine((text) => articleCodePointLength(text) <= maximum, {
      message: "article_text_limit",
    })
    .refine((text) => !invalidArticleText.test(text), {
      message: "article_invalid_text",
    })
    // JSON Schema counts code points; Zod's cheap guard measures UTF-16.
    .meta({ maxLength: maximum });

export const articleSafeLinkSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => {
      if (value !== value.trim() || invalidArticleLink.test(value))
        return false;
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: "article_unsafe_link" },
  );

export const articleStyledTextSchema = z.strictObject({
  type: z.literal("text"),
  text: textSchema(ARTICLE_DOCUMENT_LIMITS.textCodePoints),
  styles: z.strictObject({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    textColor: z.enum(["default", "gray", "red", "brown"]).optional(),
  }),
});
export const articleInlineContentSchema = z.discriminatedUnion("type", [
  articleStyledTextSchema,
  z.strictObject({
    type: z.literal("link"),
    href: articleSafeLinkSchema,
    content: z.array(articleStyledTextSchema).min(1).max(1_000),
  }),
]);
export type ArticleInlineContent = z.infer<typeof articleInlineContentSchema>;

const inline = z.array(articleInlineContentSchema).max(4_000);
// Native BlockNote properties are accepted only at the fixed unformatted values.
const nativeProps = z.strictObject({
  backgroundColor: z.literal("default").optional(),
  textColor: z.literal("default").optional(),
  textAlignment: z.literal("left").optional(),
});
const quoteProps = z.strictObject({
  backgroundColor: z.literal("default").optional(),
  textColor: z.literal("default").optional(),
});
const textualBlock = <Type extends string>(type: Type) =>
  z.strictObject({
    id: stableIdSchema,
    type: z.literal(type),
    props: nativeProps,
    content: inline,
  });
const paragraph = textualBlock("paragraph");
const heading = textualBlock("heading").extend({
  props: nativeProps.extend({ level: z.union([z.literal(2), z.literal(3)]) }),
});
const bullet = textualBlock("bulletListItem");
const numbered = textualBlock("numberedListItem").extend({
  props: nativeProps.extend({
    start: z.number().int().min(1).max(1_000_000).optional(),
  }),
});
const quote = textualBlock("quote").extend({ props: quoteProps });
const divider = z.strictObject({
  id: stableIdSchema,
  type: z.literal("divider"),
  props: z.strictObject({}),
});
const image = z.strictObject({
  id: stableIdSchema,
  type: z.literal("managedImage"),
  props: z.strictObject({
    refId: stableIdSchema,
    caption: textSchema(ARTICLE_DOCUMENT_LIMITS.captionCodePoints),
    alt: textSchema(ARTICLE_DOCUMENT_LIMITS.captionCodePoints),
  }),
});
const gallery = z.strictObject({
  id: stableIdSchema,
  type: z.literal("imageGallery"),
  props: z.strictObject({ groupId: stableIdSchema }),
});
const catalogReference = z.strictObject({
  id: stableIdSchema,
  type: z.literal("catalogReference"),
  props: z.strictObject({ catalogId: catalogIdSchema }),
});
export type ArticleBlock = (
  | z.infer<typeof paragraph>
  | z.infer<typeof heading>
  | z.infer<typeof bullet>
  | z.infer<typeof numbered>
  | z.infer<typeof quote>
  | z.infer<typeof divider>
  | z.infer<typeof image>
  | z.infer<typeof gallery>
  | z.infer<typeof catalogReference>
) & { children: ArticleBlock[] };
// Bounded construction also protects standalone block-edit command validation.
const blockSchemaAtDepth = (depth: number): z.ZodType<ArticleBlock> => {
  const children =
    depth === ARTICLE_DOCUMENT_LIMITS.depth
      ? z.array(z.never()).max(0)
      : z
          .array(blockSchemaAtDepth(depth + 1))
          .max(ARTICLE_DOCUMENT_LIMITS.blocks);
  return z.discriminatedUnion("type", [
    paragraph.extend({ children }),
    heading.extend({ children }),
    bullet.extend({ children }),
    numbered.extend({ children }),
    quote.extend({ children }),
    divider.extend({ children }),
    image.extend({ children }),
    gallery.extend({ children }),
    catalogReference.extend({ children }),
  ]);
};
export const articleBlockSchema = blockSchemaAtDepth(1);

export const articleMediaReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("managed"), itemId: itemIdSchema }),
  z.strictObject({
    type: z.literal("catalog"),
    catalogId: catalogIdSchema,
    mediaId: catalogMediaIdSchema,
  }),
]);
export type ArticleMediaReference = z.infer<typeof articleMediaReferenceSchema>;
export const articleGalleryGroupSchema = z.strictObject({
  referenceIds: z
    .array(stableIdSchema)
    .min(1)
    .max(ARTICLE_DOCUMENT_LIMITS.galleryImages),
});
const documentBaseSchema = z.strictObject({
  format: z.literal("blocknote"),
  version: z.literal(1),
  blocks: z
    .array(articleBlockSchema)
    .min(1)
    .max(ARTICLE_DOCUMENT_LIMITS.blocks),
  references: z.record(stableIdSchema, articleMediaReferenceSchema),
  galleries: z.record(stableIdSchema, articleGalleryGroupSchema),
});
export type ArticleDocument = z.infer<typeof documentBaseSchema>;

/** Iterative preflight refuses hostile depth/count before recursive Zod parse. */
export const articleDocumentSchema = z
  .preprocess((input, context) => {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return input;
    const root = input as Record<string, unknown>;
    // Zod records discard this own key before validating it. Refuse it
    // explicitly so retained attachment/group data cannot disappear on save.
    for (const field of ["references", "galleries"] as const) {
      const record = root[field];
      if (
        typeof record === "object" &&
        record !== null &&
        Object.hasOwn(record, "__proto__")
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "article_invalid_record_key",
        });
        return z.NEVER;
      }
    }
    if (root.format !== "blocknote" || root.version !== 1) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "article_unsupported_document_version",
      });
      return z.NEVER;
    }
    if (
      Array.isArray(root.blocks) &&
      root.blocks.length > ARTICLE_DOCUMENT_LIMITS.blocks
    ) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "article_block_limit",
      });
      return z.NEVER;
    }
    const queue: { value: unknown; depth: number }[] = Array.isArray(
      root.blocks,
    )
      ? root.blocks.map((value) => ({ value, depth: 1 }))
      : [];
    const seen = new WeakSet<object>();
    let count = 0;
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (
        ++count > ARTICLE_DOCUMENT_LIMITS.blocks ||
        current.depth > ARTICLE_DOCUMENT_LIMITS.depth
      ) {
        context.addIssue({
          code: "custom",
          path: ["blocks"],
          message: "article_block_limit",
        });
        return z.NEVER;
      }
      if (typeof current.value !== "object" || current.value === null) continue;
      if (seen.has(current.value)) {
        context.addIssue({
          code: "custom",
          path: ["blocks"],
          message: "article_duplicate_block_object",
        });
        return z.NEVER;
      }
      seen.add(current.value);
      const children = (current.value as Record<string, unknown>).children;
      if (Array.isArray(children)) {
        if (
          count + queue.length + children.length >
          ARTICLE_DOCUMENT_LIMITS.blocks
        ) {
          context.addIssue({
            code: "custom",
            path: ["blocks"],
            message: "article_block_limit",
          });
          return z.NEVER;
        }
        for (const child of children)
          queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    try {
      if (
        articleUtf8ByteLength(JSON.stringify(input)) >
        ARTICLE_DOCUMENT_LIMITS.documentBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "article_document_bytes_limit",
        });
        return z.NEVER;
      }
    } catch {
      context.addIssue({ code: "custom", message: "article_invalid_document" });
      return z.NEVER;
    }
    return input;
  }, documentBaseSchema)
  .superRefine((document, context) => {
    const ids = new Set<string>();
    const catalogs = new Set<string>();
    let characters = 0;
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    for (const [refId, reference] of Object.entries(document.references)) {
      if (reference.type === "catalog") catalogs.add(reference.catalogId);
      if (refId.length === 0)
        issue(["references"], "article_invalid_reference");
    }
    if (
      Object.keys(document.references).length >
      ARTICLE_DOCUMENT_LIMITS.imageReferences
    )
      issue(["references"], "article_image_reference_limit");
    if (Object.keys(document.galleries).length > ARTICLE_DOCUMENT_LIMITS.blocks)
      issue(["galleries"], "article_gallery_limit");
    for (const [groupId, group] of Object.entries(document.galleries)) {
      for (const refId of group.referenceIds)
        if (!ownEntry(document.references, refId))
          issue(["galleries", groupId], "article_missing_reference");
      if (new Set(group.referenceIds).size !== group.referenceIds.length)
        issue(["galleries", groupId], "article_duplicate_gallery_reference");
    }
    const walk = (
      blocks: readonly ArticleBlock[],
      path: (string | number)[],
    ) => {
      blocks.forEach((block, index) => {
        const here = [...path, index];
        if (ids.has(block.id))
          issue([...here, "id"], "article_duplicate_block_id");
        ids.add(block.id);
        if ("content" in block)
          for (const part of block.content)
            characters += articleCodePointLength(
              part.type === "text"
                ? part.text
                : part.content.map((text) => text.text).join(""),
            );
        if (block.type === "managedImage") {
          if (!ownEntry(document.references, block.props.refId))
            issue([...here, "props", "refId"], "article_missing_reference");
          characters +=
            articleCodePointLength(block.props.caption) +
            articleCodePointLength(block.props.alt);
        }
        if (
          block.type === "imageGallery" &&
          !ownEntry(document.galleries, block.props.groupId)
        )
          issue([...here, "props", "groupId"], "article_missing_gallery");
        if (block.type === "catalogReference")
          catalogs.add(block.props.catalogId);
        if (block.children.length > 0) {
          if (
            block.type !== "bulletListItem" &&
            block.type !== "numberedListItem"
          )
            issue([...here, "children"], "article_invalid_nesting");
          if (
            block.children.some(
              (child) =>
                child.type !== "bulletListItem" &&
                child.type !== "numberedListItem",
            )
          )
            issue([...here, "children"], "article_invalid_nesting");
          walk(block.children, [...here, "children"]);
        }
      });
    };
    walk(document.blocks, ["blocks"]);
    if (characters > ARTICLE_DOCUMENT_LIMITS.textCodePoints)
      issue(["blocks"], "article_text_limit");
    if (catalogs.size > ARTICLE_DOCUMENT_LIMITS.catalogRecords)
      issue(["references"], "article_catalog_reference_limit");
  });
export const articleAuthoringDocumentSchema = articleDocumentSchema;
export type ArticleAuthoringDocument = ArticleDocument;

export const emptyArticleDocument = (): ArticleDocument => ({
  format: "blocknote",
  version: 1,
  blocks: [
    { id: "start", type: "paragraph", props: {}, content: [], children: [] },
  ],
  references: {},
  galleries: {},
});

/** Plain text is a derivative, never a second editable body. */
export const extractArticleText = (document: ArticleDocument): string => {
  const text: string[] = [];
  const walk = (blocks: readonly ArticleBlock[]) => {
    for (const block of blocks) {
      if ("content" in block)
        text.push(
          block.content
            .map((part) =>
              part.type === "text"
                ? part.text
                : part.content.map((item) => item.text).join(""),
            )
            .join(""),
        );
      if (block.type === "managedImage") text.push(block.props.caption);
      walk(block.children);
    }
  };
  walk(document.blocks);
  return text.join("\n");
};

/** Only used references, deduplicated in document order; cover is explicit. */
export const articleReferences = (
  document: ArticleDocument,
  coverRefId: string | null = null,
): { refId: string; reference: ArticleMediaReference }[] => {
  const ids = new Set<string>();
  if (coverRefId !== null) ids.add(coverRefId);
  const walk = (blocks: readonly ArticleBlock[]) => {
    for (const block of blocks) {
      if (block.type === "managedImage") ids.add(block.props.refId);
      if (block.type === "imageGallery")
        for (const refId of ownEntry(document.galleries, block.props.groupId)
          ?.referenceIds ?? [])
          ids.add(refId);
      walk(block.children);
    }
  };
  walk(document.blocks);
  return [...ids].flatMap((refId) => {
    const reference = ownEntry(document.references, refId);
    return reference ? [{ refId, reference }] : [];
  });
};

export const articleCatalogReferences = (
  document: ArticleDocument,
): string[] => {
  const ids = new Set<string>();
  for (const { reference } of articleReferences(document))
    if (reference.type === "catalog") ids.add(reference.catalogId);
  const walk = (blocks: readonly ArticleBlock[]) => {
    for (const block of blocks) {
      if (block.type === "catalogReference") ids.add(block.props.catalogId);
      walk(block.children);
    }
  };
  walk(document.blocks);
  return [...ids];
};

const contentFields = {
  title: textSchema(ARTICLE_DOCUMENT_LIMITS.titleCodePoints),
  coverRefId: stableIdSchema.nullable(),
  document: articleDocumentSchema,
};
const withCoverCheck = <Schema extends z.ZodObject>(schema: Schema) =>
  schema.superRefine((value, context) => {
    const fields = value as {
      coverRefId: string | null;
      document: ArticleDocument;
    };
    if (
      fields.coverRefId !== null &&
      !ownEntry(fields.document.references, fields.coverRefId)
    )
      context.addIssue({
        code: "custom",
        path: ["coverRefId"],
        message: "article_missing_cover_reference",
      });
  });

export const articleDraftStatusSchema = z.enum([
  "draft",
  "pending",
  "published",
  "withdrawn",
]);
const articleDraftBaseSchema = z.strictObject({
  id: articleAuthoringArticleIdSchema,
  ownerId: ownerIdSchema,
  version: versionSchema,
  ...contentFields,
  status: articleDraftStatusSchema,
  publicVersion: versionSchema.nullable(),
  updatedAt: timestampSchema,
  fingerprint: fingerprintSchema,
});
export const articleDraftSchema = withCoverCheck(articleDraftBaseSchema);
export type ArticleDraft = z.infer<typeof articleDraftSchema>;

export const createArticleDraftCommandSchema = withCoverCheck(
  z.strictObject({ requestId: requestIdSchema, ...contentFields }),
);
export type CreateArticleDraftCommand = z.infer<
  typeof createArticleDraftCommandSchema
>;
export const updateArticleDraftCommandSchema = withCoverCheck(
  z.strictObject({
    requestId: requestIdSchema,
    expectedVersion: versionSchema,
    ...contentFields,
  }),
);
export type UpdateArticleDraftCommand = z.infer<
  typeof updateArticleDraftCommandSchema
>;
export const articleCandidateCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  expectedVersion: versionSchema,
  fingerprint: fingerprintSchema,
});
export const publishArticleCommandSchema = articleCandidateCommandSchema;
export type PublishArticleCommand = z.infer<typeof publishArticleCommandSchema>;
export const articleAuthoringCreateSchema = createArticleDraftCommandSchema;
export const articleAuthoringUpdateSchema = updateArticleDraftCommandSchema;
export const articleAuthoringCandidateSchema = articleCandidateCommandSchema;
export const articleAuthoringPublishSchema = publishArticleCommandSchema;
export const articleAuthoringWithdrawSchema = articleCandidateCommandSchema;
export type ArticleCandidateCommand = z.infer<
  typeof articleCandidateCommandSchema
>;

export const articleDraftListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const articleAuthoringListQuerySchema = articleDraftListQuerySchema;
export type ArticleDraftListQuery = z.infer<typeof articleDraftListQuerySchema>;
export const articleDraftSummarySchema = articleDraftBaseSchema.omit({
  document: true,
});
export type ArticleDraftSummary = z.infer<typeof articleDraftSummarySchema>;
export const articleDraftPageSchema = z.strictObject({
  items: z.array(articleDraftSummarySchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
});
export type ArticleDraftPage = z.infer<typeof articleDraftPageSchema>;
export const articlePublishResultSchema = z.strictObject({
  requestId: requestIdSchema,
  status: z.enum(["pending", "published"]),
  draft: articleDraftSchema,
});
export type ArticlePublishResult = z.infer<typeof articlePublishResultSchema>;
export const articlePublicationResultSchema = articlePublishResultSchema;
export const articleValidationIssueSchema = z.strictObject({
  code: z.enum([
    "media_unavailable",
    "media_not_ready",
    "catalog_unavailable",
    "title_required",
    "cover_unavailable",
  ]),
  path: z
    .array(z.union([z.string().max(128), z.number().int().nonnegative()]))
    .max(12),
});
export type ArticleValidationIssue = z.infer<
  typeof articleValidationIssueSchema
>;
export const articleValidationResultSchema = z.strictObject({
  id: articleAuthoringArticleIdSchema,
  version: versionSchema,
  fingerprint: fingerprintSchema,
  valid: z.boolean(),
  issues: z.array(articleValidationIssueSchema).max(100),
});
export type ArticleValidationResult = z.infer<
  typeof articleValidationResultSchema
>;
export type ArticleCandidateValidation = ArticleValidationResult;
export const articlePreviewSchema = z.strictObject({
  draft: articleDraftSchema,
  validation: articleValidationResultSchema,
});
export type ArticlePreview = z.infer<typeof articlePreviewSchema>;

export const articleAuthoringScopeSchema = z.enum([
  "artvenn:article:draft",
  "artvenn:article:publish",
]);
export type ArticleAuthoringScope = z.infer<typeof articleAuthoringScopeSchema>;
const grantScopesSchema = z
  .array(articleAuthoringScopeSchema)
  .min(1)
  .max(2)
  .refine(
    (scopes) =>
      scopes.includes("artvenn:article:draft") &&
      new Set(scopes).size === scopes.length,
    { message: "article_invalid_grant_scopes" },
  );
export const articleConnectionIdSchema = z
  .string()
  .regex(/^article-connection-[0-9a-f]{32}$/u);
export const articleAuthoringGrantSchema = z.strictObject({
  id: articleConnectionIdSchema,
  ownerId: ownerIdSchema,
  // The Backend validates the registered OAuth client identity, including CIMD.
  clientId: textSchema(1_024)
    .min(1)
    .refine((value) => articleUtf8ByteLength(value) <= 1_024, {
      message: "article_invalid_client_identity",
    }),
  environment: z.literal("development"),
  issuer: articleSafeLinkSchema,
  resource: articleSafeLinkSchema,
  scopes: grantScopesSchema,
  generation: versionSchema,
  status: z.enum(["authorized", "revoked"]),
  consentedAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
});
export type ArticleAuthoringGrant = z.infer<typeof articleAuthoringGrantSchema>;
/** Server-issued one-use interaction material is submitted by the human page. */
export const createArticleAuthoringGrantCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  interactionUid: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/u),
  consentTicket: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/u),
  scopes: grantScopesSchema.default(["artvenn:article:draft"]),
});
export type CreateArticleAuthoringGrantCommand = z.infer<
  typeof createArticleAuthoringGrantCommandSchema
>;
export const articleCandidateApprovalCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  connectionId: articleConnectionIdSchema,
  articleId: articleAuthoringArticleIdSchema,
  expectedVersion: versionSchema,
  fingerprint: fingerprintSchema,
});
export type ArticleCandidateApprovalCommand = z.infer<
  typeof articleCandidateApprovalCommandSchema
>;
export const revokeArticleAuthoringGrantCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  expectedGeneration: versionSchema,
});
export type RevokeArticleAuthoringGrantCommand = z.infer<
  typeof revokeArticleAuthoringGrantCommandSchema
>;

export const articleAuthoringFailureCodeSchema = z.enum([
  "article_unavailable",
  "article_not_owned",
  "article_changed",
  "article_invalid_document",
  "article_unsupported_document_version",
  "article_reference_unavailable",
  "article_media_not_ready",
  "article_publication_forbidden",
  "article_approval_required",
  "article_invalid_grant",
  "article_grant_revoked",
  "article_scope_required",
  "article_request_replay_mismatch",
]);

export const articleBlockEditSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("insert"),
    afterBlockId: stableIdSchema.nullable(),
    block: articleBlockSchema,
  }),
  z.strictObject({ type: z.literal("replace"), block: articleBlockSchema }),
  z.strictObject({ type: z.literal("remove"), blockId: stableIdSchema }),
  z.strictObject({
    type: z.literal("move"),
    blockId: stableIdSchema,
    afterBlockId: stableIdSchema.nullable(),
  }),
]);
const preflightArticleEditInput = (
  input: unknown,
  context: Pick<z.RefinementCtx, "addIssue">,
) => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return input;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.edits)) return input;
  const reject = (message: string) => {
    context.addIssue({ code: "custom", path: ["edits"], message });
    return z.NEVER;
  };
  if (root.edits.length > ARTICLE_DOCUMENT_LIMITS.blockEdits)
    return reject("article_block_edits_limit");
  const queue: { value: unknown; depth: number }[] = [];
  for (const edit of root.edits) {
    if (typeof edit !== "object" || edit === null) continue;
    const command = edit as Record<string, unknown>;
    if (command.type === "insert" || command.type === "replace")
      queue.push({ value: command.block, depth: 1 });
  }
  const seen = new WeakSet<object>();
  let count = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (
      ++count > ARTICLE_DOCUMENT_LIMITS.blocks ||
      current.depth > ARTICLE_DOCUMENT_LIMITS.depth
    )
      return reject("article_block_limit");
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value))
      return reject("article_duplicate_block_object");
    seen.add(current.value);
    const children = (current.value as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      if (
        count + queue.length + children.length >
        ARTICLE_DOCUMENT_LIMITS.blocks
      )
        return reject("article_block_limit");
      for (const child of children)
        queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  try {
    if (
      articleUtf8ByteLength(JSON.stringify(input)) >
      ARTICLE_DOCUMENT_LIMITS.documentBytes
    )
      return reject("article_document_bytes_limit");
  } catch {
    return reject("article_invalid_document");
  }
  return input;
};
export const articleBlockEditsCommandSchema = z.preprocess(
  preflightArticleEditInput,
  z.strictObject({
    requestId: requestIdSchema,
    expectedVersion: versionSchema,
    edits: z
      .array(articleBlockEditSchema)
      .min(1)
      .max(ARTICLE_DOCUMENT_LIMITS.blockEdits),
  }),
);
export type ArticleBlockEdit = z.infer<typeof articleBlockEditSchema>;
export type ArticleBlockEditsCommand = z.infer<
  typeof articleBlockEditsCommandSchema
>;

/** Pure version-aware adapter transaction helper; no reads, authority or effects. */
export const applyArticleBlockEdits = (
  input: ArticleDocument,
  edits: readonly ArticleBlockEdit[],
): ArticleDocument => {
  let preflightFailure: string | null = null;
  preflightArticleEditInput(
    { edits },
    {
      addIssue: (issue) => {
        preflightFailure =
          typeof issue === "string"
            ? "article_invalid_block_edits"
            : (issue.message ?? "article_invalid_block_edits");
      },
    },
  );
  if (preflightFailure !== null) throw new Error(preflightFailure);
  const parsedEdits = z
    .array(articleBlockEditSchema)
    .min(1)
    .max(ARTICLE_DOCUMENT_LIMITS.blockEdits)
    .safeParse(edits);
  if (!parsedEdits.success) throw new Error("article_invalid_block_edits");
  const parsedInput = articleDocumentSchema.safeParse(input);
  if (!parsedInput.success) throw new Error("article_invalid_document");
  const document = structuredClone(parsedInput.data);
  type Slot = { siblings: ArticleBlock[]; index: number; block: ArticleBlock };
  const find = (id: string, blocks = document.blocks): Slot | null => {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.id === id) return { siblings: blocks, index, block };
      const child = find(id, block.children);
      if (child !== null) return child;
    }
    return null;
  };
  const requireSlot = (id: string): Slot => {
    const slot = find(id);
    if (slot === null) throw new Error("article_block_unavailable");
    return slot;
  };
  const subtreeContains = (block: ArticleBlock, id: string): boolean =>
    block.id === id ||
    block.children.some((child) => subtreeContains(child, id));
  for (const edit of parsedEdits.data) {
    if (edit.type === "insert") {
      const block = structuredClone(edit.block);
      if (edit.afterBlockId === null) document.blocks.unshift(block);
      else {
        const after = requireSlot(edit.afterBlockId);
        after.siblings.splice(after.index + 1, 0, block);
      }
    } else if (edit.type === "replace") {
      const slot = requireSlot(edit.block.id);
      slot.siblings.splice(slot.index, 1, structuredClone(edit.block));
    } else if (edit.type === "remove") {
      const slot = requireSlot(edit.blockId);
      slot.siblings.splice(slot.index, 1);
    } else {
      const slot = requireSlot(edit.blockId);
      if (edit.afterBlockId !== null) {
        if (subtreeContains(slot.block, edit.afterBlockId))
          throw new Error("article_invalid_block_move");
        const after = requireSlot(edit.afterBlockId);
        if (slot.siblings !== after.siblings)
          throw new Error("article_invalid_move_slot");
      }
      slot.siblings.splice(slot.index, 1);
      if (edit.afterBlockId === null) document.blocks.unshift(slot.block);
      else {
        const after = requireSlot(edit.afterBlockId);
        after.siblings.splice(after.index + 1, 0, slot.block);
      }
    }
  }
  const result = articleDocumentSchema.safeParse(document);
  if (!result.success) {
    if (
      result.error.issues.some(
        (issue) => issue.message === "article_duplicate_block_id",
      )
    )
      throw new Error("article_duplicate_block_id");
    throw new Error("article_invalid_block_result");
  }
  return result.data;
};

export interface LegacyArticleImage {
  readonly id: string;
  readonly alt: string;
}
export interface LegacyArticleInput {
  readonly title: string;
  readonly intro: string | null;
  readonly cover: LegacyArticleImage | null;
  readonly sections: readonly {
    readonly heading: string | null;
    readonly paragraphs: readonly string[];
    readonly image: LegacyArticleImage | null;
    readonly imageCaption: string | null;
  }[];
  readonly citations: readonly {
    readonly text: string;
    readonly url: string | null;
  }[];
}

/** Missing Catalog identity or an unsafe retained URL refuses adaptation. */
export const legacyArticleToDocument = (
  article: LegacyArticleInput,
  resolveImage: (image: LegacyArticleImage) => ArticleMediaReference | null,
): { title: string; coverRefId: string | null; document: ArticleDocument } => {
  const document: ArticleDocument = {
    format: "blocknote",
    version: 1,
    blocks: [],
    references: {},
    galleries: {},
  };
  const text = (value: string): ArticleInlineContent[] => [
    { type: "text", text: value, styles: {} },
  ];
  const addParagraph = (id: string, value: string) =>
    document.blocks.push({
      id,
      type: "paragraph",
      props: {},
      content: text(value),
      children: [],
    });
  const addImage = (
    id: string,
    value: LegacyArticleImage,
    caption: string,
  ): string => {
    const reference = resolveImage(value);
    if (reference === null)
      throw new Error("article_legacy_reference_unresolved");
    document.references[id] = articleMediaReferenceSchema.parse(reference);
    document.blocks.push({
      id: `${id}-block`,
      type: "managedImage",
      props: { refId: id, caption, alt: value.alt },
      children: [],
    });
    return id;
  };
  // Cover metadata remains a cover; it is not duplicated into the body.
  let coverRefId: string | null = null;
  if (article.cover !== null) {
    const reference = resolveImage(article.cover);
    if (reference === null)
      throw new Error("article_legacy_reference_unresolved");
    coverRefId = "legacy-cover";
    document.references[coverRefId] =
      articleMediaReferenceSchema.parse(reference);
  }
  if (article.intro !== null) addParagraph("legacy-intro", article.intro);
  article.sections.forEach((section, index) => {
    const prefix = `legacy-section-${index}`;
    if (section.heading !== null)
      document.blocks.push({
        id: `${prefix}-heading`,
        type: "heading",
        props: { level: 2 },
        content: text(section.heading),
        children: [],
      });
    section.paragraphs.forEach((paragraph, paragraphIndex) =>
      addParagraph(`${prefix}-paragraph-${paragraphIndex}`, paragraph),
    );
    if (section.image !== null)
      addImage(`${prefix}-image`, section.image, section.imageCaption ?? "");
  });
  if (article.citations.length > 0)
    document.blocks.push({
      id: "legacy-citations-heading",
      type: "heading",
      props: { level: 2 },
      content: text("引用与参考"),
      children: [],
    });
  article.citations.forEach((citation, index) =>
    document.blocks.push({
      id: `legacy-citation-${index}`,
      type: "numberedListItem",
      props: { start: index + 1 },
      content:
        citation.url === null
          ? text(citation.text)
          : [
              {
                type: "link",
                href: articleSafeLinkSchema.parse(citation.url),
                content: [{ type: "text", text: citation.text, styles: {} }],
              },
            ],
      children: [],
    }),
  );
  if (document.blocks.length === 0)
    document.blocks = emptyArticleDocument().blocks;
  // Refuse over-limit retained content. The existing legacy reader is unchanged.
  return {
    title: textSchema(ARTICLE_DOCUMENT_LIMITS.titleCodePoints).parse(
      article.title,
    ),
    coverRefId,
    document: articleDocumentSchema.parse(document),
  };
};

/** Same finite, owner-scoped picker page for human HTTP and delegated MCP. */
export const articleOwnMediaListQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type ArticleOwnMediaListQuery = z.infer<
  typeof articleOwnMediaListQuerySchema
>;
export const articleOwnMediaPageSchema = z
  .strictObject({
    items: z.array(publishingMediaItemSchema).max(50),
    nextCursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .nullable(),
  })
  .superRefine((page, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < page.items.length; index++) {
      const item = page.items[index]!;
      if (
        item.state !== "ready" ||
        item.media === null ||
        item.presentation === null ||
        seen.has(item.id)
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "article_media_unavailable",
        });
      seen.add(item.id);
    }
  });
export type ArticleOwnMediaPage = z.infer<typeof articleOwnMediaPageSchema>;
