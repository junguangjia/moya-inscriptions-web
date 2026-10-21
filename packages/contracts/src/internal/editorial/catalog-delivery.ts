import { z } from "zod";

import { editorialMediaSchema } from "./schemas.js";

const documentId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const intentId = z.uuid();

/** Canonical registry parameters and the geometry implementation are pinned,
 * not just the three always-rendered role identities. The worker still calls
 * plannedStillSize("catalog") to decide conditional viewer omission.
 */
export const catalogRecipeManifestSchema = z.strictObject({
  version: z.literal(1),
  plan: z.literal("catalog"),
  roles: z.tuple([
    z.strictObject({
      role: z.literal("thumb"),
      version: revision,
      digest: z.string().regex(/^[a-f0-9]{16}$/),
      parameters: z.json(),
    }),
    z.strictObject({
      role: z.literal("cover"),
      version: revision,
      digest: z.string().regex(/^[a-f0-9]{16}$/),
      parameters: z.json(),
    }),
    z.strictObject({
      role: z.literal("display"),
      version: revision,
      digest: z.string().regex(/^[a-f0-9]{16}$/),
      parameters: z.json(),
    }),
    z.strictObject({
      role: z.literal("viewer"),
      version: revision,
      digest: z.string().regex(/^[a-f0-9]{16}$/),
      parameters: z.json(),
    }),
  ]),
  geometry: z.strictObject({
    frame: z.literal("oriented-uncropped-source"),
    plannedStillSizeSha256: digest,
    stillOutputSizeSha256: digest,
    planFull: z.literal(false),
    dependencySha256: digest,
    viewer: z.literal("omit-when-equal-to-display-or-larger-than-full"),
    comparisonFullParameters: z.json(),
    maxOutputEdge: z.number().int().positive(),
  }),
  excludedRoles: z.tuple([z.literal("full"), z.literal("motion")]),
});

export const catalogRecipePolicySchema = z
  .strictObject({
    recipeManifestSha256: digest,
    canonicalManifest: z.string().min(1).max(64_000),
  })
  .superRefine((value, context) => {
    try {
      if (
        catalogRecipeManifestSchema.safeParse(
          JSON.parse(value.canonicalManifest),
        ).success
      )
        return;
    } catch {
      /* only a fixed validation category crosses the boundary */
    }
    context.addIssue({
      code: "custom",
      path: ["canonicalManifest"],
      message:
        "A Catalog policy must contain the complete bounded registry manifest",
    });
  });
export type CatalogRecipePolicy = z.output<typeof catalogRecipePolicySchema>;

const processingMedia = z.strictObject({
  ordinal: revision.max(2000),
  mediaId: editorialMediaSchema.shape.mediaId,
  objectKey: editorialMediaSchema.shape.objectKey,
  sourceSha256: digest,
  width: editorialMediaSchema.shape.width.max(65535),
  height: editorialMediaSchema.shape.height.max(65535),
});

/** Internal CMS-to-App data only; it never crosses a public DTO boundary.
 * Empty live manifests carry a header, while incomplete/partial sets refuse.
 */
export const catalogProcessingIntentSchema = z
  .strictObject({
    intentId,
    documentId: documentId,
    catalogId: z.string().min(1).max(128),
    revision,
    fingerprint: digest,
    manifestSha256: digest,
    recipeManifestSha256: digest,
    state: z.enum([
      "prepared",
      "release_requested",
      "released",
      "cancelled",
      "superseded",
      "expired",
      "withdrawn",
    ]),
    stateVersion: revision,
    mediaCount: z.number().int().min(0).max(2000),
    media: z.array(processingMedia).max(2000),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    const live = ["prepared", "release_requested", "released"].includes(
      value.state,
    );
    if (
      (live ? value.mediaCount : 0) !== value.media.length ||
      value.media.some((item, index) => item.ordinal !== index + 1) ||
      new Set(value.media.map((item) => item.mediaId)).size !==
        value.media.length ||
      new Set(value.media.map((item) => item.objectKey)).size !==
        value.media.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["media"],
        message:
          "A source snapshot must be complete and ordered without repeated identities",
      });
    }
  });
export type CatalogProcessingIntent = z.output<
  typeof catalogProcessingIntentSchema
>;

export const prepareCatalogDeliverySchema = z.strictObject({
  id: documentId,
  expectedRevision: revision,
  expectedFingerprint: digest,
  idempotencyKey,
});
export const readCatalogDeliverySchema = z.strictObject({ intentId });
export const requestCatalogReleaseSchema = z.strictObject({
  intentId,
  expectedStateVersion: revision,
  expectedManifestSha256: digest,
  idempotencyKey,
});
export const releaseCatalogDeliverySchema = z.strictObject({
  intentId,
  expectedStateVersion: revision,
  expectedRevision: revision,
  expectedFingerprint: digest,
  idempotencyKey,
  approvalId: documentId.optional(),
});
export const cancelCatalogDeliverySchema = z.strictObject({
  intentId,
  expectedStateVersion: revision,
  idempotencyKey,
});

/** One logical media ID per entry; equal source hashes never collapse entries. */
export const catalogDeliveryMediaSchema = editorialMediaSchema.extend({
  sourceSha256: digest,
});
export const catalogDeliveryManifestSchema = z
  .array(catalogDeliveryMediaSchema)
  .max(2_000)
  .refine(
    (items) => new Set(items.map((item) => item.mediaId)).size === items.length,
  );

export const catalogDeliveryStateSchema = z.enum([
  "prepared",
  "release_requested",
  "released",
  "cancelled",
  "superseded",
  "expired",
  "withdrawn",
]);

/** This response contains no private source object keys or draft content. */
export const catalogDeliveryResultSchema = z.strictObject({
  intentId,
  id: documentId,
  catalogId: z.string(),
  revision,
  fingerprint: digest,
  manifestSha256: digest,
  mediaCount: z.number().int().nonnegative(),
  recipeManifestSha256: digest.nullable(),
  state: catalogDeliveryStateSchema,
  stateVersion: revision,
  readiness: z.enum(["NOT_CONFIGURED", "PENDING", "READY"]),
  publicCopyAuthorized: z.boolean(),
  expiresAt: z.iso.datetime(),
  replayed: z.boolean(),
});

export type CatalogDeliveryMedia = z.output<typeof catalogDeliveryMediaSchema>;
export type CatalogDeliveryState = z.output<typeof catalogDeliveryStateSchema>;
export type CatalogDeliveryResult = z.output<
  typeof catalogDeliveryResultSchema
>;

export const catalogDeliveryReadinessRequestSchema = z.strictObject({
  intentId,
});
export const catalogDeliveryReadinessSchema = z.strictObject({
  intentId,
  manifestSha256: digest,
  recipeManifestSha256: digest,
  stateVersion: revision,
  mediaCount: z.number().int().nonnegative().max(2000),
  privateReady: z.boolean(),
  publicReady: z.boolean(),
  proofSha256: digest,
});
export type CatalogDeliveryReadiness = z.output<
  typeof catalogDeliveryReadinessSchema
>;

/** Release tooling asks this before its first write. Any answer at all means
 * this Admin serves the delivery and upload endpoints; `delivery` says whether
 * its Backend can pin a recipe and prove readiness. No setting is reported.
 */
export const catalogDeliveryCapabilitiesRequestSchema = z.strictObject({});
export const catalogDeliveryCapabilitiesSchema = z.strictObject({
  delivery: z.enum(["AVAILABLE", "NOT_CONFIGURED", "UNAVAILABLE"]),
});
export type CatalogDeliveryCapabilities = z.output<
  typeof catalogDeliveryCapabilitiesSchema
>;

const publishedRenditionSource = {
  mediaId: editorialMediaSchema.shape.mediaId,
  objectKey: editorialMediaSchema.shape.objectKey,
};
/** Admin publish gate, operator boundary only: the exact CMS sources of a
 * record whose current, complete and published rendition sets are asked for.
 */
export const catalogPublishedRenditionsRequestSchema = z.strictObject({
  media: z
    .array(
      z.strictObject({ ...publishedRenditionSource, sourceSha256: digest }),
    )
    .min(1)
    .max(2000),
});
export const catalogPublishedRenditionsSchema = z.strictObject({
  media: z
    .array(
      z.strictObject({ ...publishedRenditionSource, complete: z.boolean() }),
    )
    .max(2000),
});
export type CatalogPublishedRenditionsRequest = z.output<
  typeof catalogPublishedRenditionsRequestSchema
>;
export type CatalogPublishedRenditions = z.output<
  typeof catalogPublishedRenditionsSchema
>;
