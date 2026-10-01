import { z } from "zod";

import {
  catalogContributorSchema,
  catalogIdSchema,
  catalogKindSchema,
  catalogSummarySchema,
  mediaIdSchema,
  publicMediaSchema,
  publicSourceCitationSchema,
} from "../../schemas.js";
import {
  aliasImportRowSchema,
  canonicalDescriptionImportFieldSchema,
  canonicalFactualImportFieldSchema,
  canonicalHistoricalContextImportFieldSchema,
  canonicalScholarlyResearchImportFieldSchema,
  canonicalScriptStyleImportFieldSchema,
  canonicalTranscriptionImportFieldSchema,
  provenanceImportRowSchema,
  sourceIdSchema,
} from "../catalog-import/schemas.js";

/** These are complete versioned values, not independent mutable relations. */
export const EDITORIAL_STATEFUL_FIELDS = [
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
] as const;

const exactText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), {
      message: "Leading or trailing whitespace is not allowed",
    });

export const editorialMediaSchema = z.strictObject({
  mediaId: mediaIdSchema,
  objectKey: exactText(2_048),
  width: publicMediaSchema.shape.width.max(2_147_483_647),
  height: publicMediaSchema.shape.height.max(2_147_483_647),
  alt: publicMediaSchema.shape.alt,
  position: z.number().int().nonnegative().max(2_147_483_647),
  isRepresentative: z.boolean(),
  rights: exactText(2_000).optional(),
  orderConfidence: z.enum(["HIGH", "LOW"]).optional(),
});

const editorialAliasSchema = aliasImportRowSchema.omit({
  catalogImportId: true,
});
const editorialProvenanceSchema = provenanceImportRowSchema.omit({
  catalogImportId: true,
});

const statefulShape = {
  dynasty: canonicalFactualImportFieldSchema,
  dateText: canonicalFactualImportFieldSchema,
  province: canonicalFactualImportFieldSchema,
  prefecture: canonicalFactualImportFieldSchema,
  county: canonicalFactualImportFieldSchema,
  currentLocation: canonicalFactualImportFieldSchema,
  currentCustodian: canonicalFactualImportFieldSchema,
  description: canonicalDescriptionImportFieldSchema,
  scriptStyle: canonicalScriptStyleImportFieldSchema,
  transcription: canonicalTranscriptionImportFieldSchema,
  historicalContext: canonicalHistoricalContextImportFieldSchema,
  scholarlyResearch: canonicalScholarlyResearchImportFieldSchema,
};

export const FILTER_DIMENSIONS = [
  "dynasty",
  "textAuthor",
  "calligrapher",
  "originalRegion",
  "script",
] as const;
const filterDimensionSchema = z
  .strictObject({
    state: z.enum(["VALUE", "UNKNOWN", "UNSUPPLIED"]).default("UNSUPPLIED"),
    tokens: z.string().max(2000).default(""),
  })
  .superRefine((value, context) => {
    const tokens = value.tokens.split("\n");
    if (value.state !== "VALUE") {
      if (value.tokens !== "")
        context.addIssue({
          code: "custom",
          message: "Non-value filters must have no tokens",
        });
      return;
    }
    if (
      tokens.length > 25 ||
      new Set(tokens).size !== tokens.length ||
      tokens.some(
        (t) =>
          !t ||
          t === "@unknown" ||
          t === "@unsupplied" ||
          t.length > 80 ||
          t !== t.normalize("NFKC").trim() ||
          t.includes("\u0000") ||
          /[\uD800-\uDFFF]/u.test(t),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Supply distinct, validated normalized values, one per line",
      });
  });
export const catalogFilterMetadataSchema = z.strictObject({
  dynasty: filterDimensionSchema.default({ state: "UNSUPPLIED", tokens: "" }),
  textAuthor: filterDimensionSchema.default({
    state: "UNSUPPLIED",
    tokens: "",
  }),
  calligrapher: filterDimensionSchema.default({
    state: "UNSUPPLIED",
    tokens: "",
  }),
  originalRegion: filterDimensionSchema.default({
    state: "UNSUPPLIED",
    tokens: "",
  }),
  script: filterDimensionSchema.default({ state: "UNSUPPLIED", tokens: "" }),
});
const contentShape = {
  catalogId: catalogIdSchema,
  sourceId: sourceIdSchema,
  kind: catalogKindSchema,
  title: catalogSummarySchema.shape.title,
  summary: catalogSummarySchema.shape.summary,
  periodLabel: catalogSummarySchema.shape.periodLabel,
  ...statefulShape,
  aliases: z.array(editorialAliasSchema).default([]),
  provenance: z.array(editorialProvenanceSchema).default([]),
  contributors: z.array(catalogContributorSchema).max(50).default([]),
  sourceCitations: z.array(publicSourceCitationSchema).default([]),
  media: z.array(editorialMediaSchema).default([]),
  ownerNote: exactText(2_000).optional(),
  filterMetadata: catalogFilterMetadataSchema.optional(),
};

export const EDITORIAL_FIELD_NAMES = Object.keys(
  contentShape,
) as (keyof typeof contentShape)[];

/** PostgreSQL cannot store NUL or unpaired UTF-16 surrogates as UTF-8 text. */
export const isWellFormedEditorialText = (value: string): boolean => {
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const validateTextTree = (
  value: unknown,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
): void => {
  if (typeof value === "string") {
    if (!isWellFormedEditorialText(value)) {
      context.addIssue({
        code: "custom",
        path,
        message: "Text contains NUL or invalid UTF-16",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateTextTree(item, context, [...path, index]),
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      validateTextTree(item, context, [...path, key]);
    }
  }
};

const completeContentSchema = z.strictObject(contentShape);
const draftContentSchema = completeContentSchema.partial({
  title: true,
  dynasty: true,
  dateText: true,
  province: true,
  prefecture: true,
  county: true,
  currentLocation: true,
  currentCustodian: true,
  description: true,
  scriptStyle: true,
  transcription: true,
  historicalContext: true,
  scholarlyResearch: true,
});

const validateContent = (
  content: z.output<typeof draftContentSchema>,
  context: z.RefinementCtx,
): void => {
  validateTextTree(content, context);
  if (String(content.catalogId) === String(content.sourceId)) {
    context.addIssue({
      code: "custom",
      path: ["sourceId"],
      message: "SourceId and CatalogId must be distinct",
    });
  }

  const uniqueValues = (
    values: readonly string[],
    collection: string,
    field: string,
  ) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [collection, index, field],
          message: "Duplicate value in this record",
        });
      }
      seen.add(value);
    });
  };
  uniqueValues(
    content.aliases.map(({ alias }) => alias),
    "aliases",
    "alias",
  );
  uniqueValues(
    content.provenance.map(({ sourceId }) => String(sourceId)),
    "provenance",
    "sourceId",
  );
  content.provenance.forEach(({ sourceId }, index) => {
    if (String(sourceId) === String(content.catalogId)) {
      context.addIssue({
        code: "custom",
        path: ["provenance", index, "sourceId"],
        message: "SourceId and CatalogId must be distinct",
      });
    }
  });
  uniqueValues(
    content.contributors.map(({ name, role }) => JSON.stringify([name, role])),
    "contributors",
    "name",
  );
  uniqueValues(
    content.media.map(({ mediaId }) => String(mediaId)),
    "media",
    "mediaId",
  );
  uniqueValues(
    content.media.map(({ objectKey }) => objectKey),
    "media",
    "objectKey",
  );
  uniqueValues(
    content.media.map(({ position }) => String(position)),
    "media",
    "position",
  );
};

/** Incomplete content stays editable; every supplied value remains legal. */
export const editorialDraftSchema =
  draftContentSchema.superRefine(validateContent);

/** No media is required. A supplied media set has exactly one representative. */
export const editorialPublishSchema = completeContentSchema
  .superRefine(validateContent)
  .superRefine((content, context) => {
    let previousPosition = -1;
    for (const [index, media] of content.media.entries()) {
      if (media.position <= previousPosition) {
        context.addIssue({
          code: "custom",
          path: ["media", index, "position"],
          message: "Media must be ordered by strictly increasing position",
        });
      }
      previousPosition = media.position;
    }
    if (
      content.media.length > 0 &&
      content.media.filter(({ isRepresentative }) => isRepresentative)
        .length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["media"],
        message: "A media set must have exactly one representative",
      });
    }
  });

export type EditorialDraft = z.output<typeof editorialDraftSchema>;
export type EditorialPublished = z.output<typeof editorialPublishSchema>;
export type EditorialMedia = z.output<typeof editorialMediaSchema>;
export type EditorialStatefulField = (typeof EDITORIAL_STATEFUL_FIELDS)[number];

/**
 * Select content from a Payload document without copying auth or system fields.
 * Payload row IDs and null controls are transport metadata. Text, state, array
 * ordering and identity are never trimmed, normalized, sorted or inferred.
 * This adapter is not an authorization boundary; access is enforced by the CMS.
 */
export const editorialContentFromDocument = (
  input: Record<string, unknown>,
): Record<string, unknown> => {
  const copyContent = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copyContent);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, item]) =>
              key !== "id" && item !== null && item !== undefined,
          )
          .map(([key, item]) => [key, copyContent(item)]),
      );
    }
    return value;
  };
  const content: Record<string, unknown> = Object.fromEntries(
    EDITORIAL_FIELD_NAMES.filter(
      (name) => input[name] !== null && input[name] !== undefined,
    ).map((name) => [name, copyContent(input[name])]),
  );
  // Native group defaults do not turn an older omitted field into new content.
  // All UNSUPPLIED is the same absence; UNKNOWN and every supplied token remain
  // explicit. This preserves legacy migration fingerprints and replay checks.
  if (content.filterMetadata !== undefined) {
    const filters = catalogFilterMetadataSchema.safeParse(
      content.filterMetadata,
    );
    if (
      filters.success &&
      FILTER_DIMENSIONS.every(
        (key) =>
          filters.data[key].state === "UNSUPPLIED" &&
          filters.data[key].tokens === "",
      )
    )
      delete content.filterMetadata;
  }
  // Payload reads an unselected hasMany select as []. The contract represents
  // an unspecified citation scope by omission, and still rejects explicit []
  // in API input. Normalize only this native transport field on the copied rows.
  if (Array.isArray(content.sourceCitations)) {
    for (const citation of content.sourceCitations) {
      if (
        citation !== null &&
        typeof citation === "object" &&
        !Array.isArray(citation) &&
        Array.isArray(citation.appliesTo) &&
        citation.appliesTo.length === 0
      ) {
        delete citation.appliesTo;
      }
    }
  }
  return content;
};

// ---------------------------------------------------------------------------
// content-community-completion-v1: bounded extension of the editorial batch
// mechanism to the `articles` collection. Same preparation → exact-revision
// Owner approval → scoped publication shape; no new machine power.
// ---------------------------------------------------------------------------
const articleRowId = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/u),
]);
const articleIdempotencyKey = z.string().min(1).max(128);
export const editorialArticleSaveDraftSchema = z.strictObject({
  id: articleRowId.optional(),
  expectedRevision: z.number().int().min(0).optional(),
  idempotencyKey: articleIdempotencyKey,
  content: z.record(z.string(), z.unknown()),
});
export type EditorialArticleSaveDraft = z.infer<
  typeof editorialArticleSaveDraftSchema
>;
export const editorialArticleApproveBatchSchema = z.strictObject({
  label: z.string().min(1).max(200).optional(),
  automationUserId: articleRowId,
  items: z
    .array(
      z.strictObject({ id: articleRowId, revision: z.number().int().min(1) }),
    )
    .min(1)
    .max(100),
});
export type EditorialArticleApproveBatch = z.infer<
  typeof editorialArticleApproveBatchSchema
>;
export const editorialArticlePublishApprovedSchema = z.strictObject({
  approvalId: articleRowId,
  id: articleRowId,
  idempotencyKey: articleIdempotencyKey,
});
export type EditorialArticlePublishApproved = z.infer<
  typeof editorialArticlePublishApprovedSchema
>;
