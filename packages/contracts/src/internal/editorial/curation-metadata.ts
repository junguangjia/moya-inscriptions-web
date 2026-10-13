import { z } from "zod";

import { catalogIdSchema, mediaIdSchema } from "../../schemas.js";
import { sourceIdSchema } from "../catalog-import/schemas.js";
import { isWellFormedEditorialText } from "./schemas.js";

export const CURATION_METADATA_VERSION = "artvenn-curation-metadata/v1";
export const MAX_CURATION_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10_000;
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const documentId = z.union([integer.min(1), id]);
const role = z.enum(["overview", "detail", "label", "context", "unspecified"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];

/** Only portable business metadata belongs in this internal snapshot. */
const forbiddenKey =
  /^(?:path|file|filePath|sourcePath|sourceRoot|derivativePath|previewPath|databasePath|config|apiKey|authorization|credentials?|secrets?|tokens?|password|privateKey|objectKey|bucket|url|thumbnailURL|previewURL|downloadURL)$/iu;
const localPath =
  /^(?:\/(?:Users|home|tmp|private\/tmp|var\/folders)(?:\/|$)|[A-Za-z]:[\\/]|file:\/\/)/u;

const walkJson = (
  root: unknown,
  visit: (value: Json, path: Path) => void,
): boolean => {
  const pending: { value: unknown; path: Path }[] = [{ value: root, path: [] }];
  let count = 0;
  while (pending.length) {
    const { value, path } = pending.pop()!;
    if (++count > 200_000 || path.length > 64) return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (typeof value === "string" && !isWellFormedEditorialText(value))
      return false;
    if (
      value === null ||
      ["boolean", "number", "string"].includes(typeof value)
    ) {
      visit(value as Json, path);
    } else if (Array.isArray(value)) {
      visit(value as Json, path);
      value.forEach((item, index) =>
        pending.push({ value: item, path: [...path, index] }),
      );
    } else if (typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      visit(value as Json, path);
      for (const [key, item] of Object.entries(value)) {
        if (!isWellFormedEditorialText(key)) return false;
        pending.push({ value: item, path: [...path, key] });
      }
    } else return false;
  }
  return true;
};
const json = z.custom<Json>((value) => walkJson(value, () => undefined), {
  message: "Expected bounded, well-formed JSON metadata",
});
const record = z.record(z.string(), json);
const extension = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).catchall(json);
const rows = <T extends z.ZodType>(schema: T) => z.array(schema).max(MAX_ROWS);

export const curationOriginalFrameSchema = z.discriminatedUnion(
  "coordinateSystem",
  [
    z.strictObject({
      version: z.literal("artvenn-original-frame/v1"),
      assetId: id,
      sourceSha256: hash,
      width: integer.min(1),
      height: integer.min(1),
      exifOrientation: integer.min(1).max(8),
      coordinateSystem: z.literal("original_encoded_pixels_top_left"),
      orientationApplied: z.literal(false),
    }),
    z.strictObject({
      version: z.literal("artvenn-original-frame/v1"),
      assetId: id,
      sourceSha256: hash,
      coordinateSystem: z.literal("unavailable"),
      orientationApplied: z.literal(false),
    }),
  ],
);

const uncertainList = <T extends readonly [string, ...string[]]>(
  values: T,
  maximum: number,
) =>
  z
    .array(z.enum(values))
    .max(maximum)
    .superRefine((items, context) => {
      if (
        new Set(items).size !== items.length ||
        (items.length > 1 &&
          items.some(
            (value) => value === "unknown" || value === "not_applicable",
          ))
      ) {
        context.addIssue({
          code: "custom",
          message: "Uncertain labels cannot be combined with other labels",
        });
      }
    });
const annotationText = (maximum: number) =>
  z
    .string()
    // Match the inherited JSON Schema maxLength: Unicode code points, not UTF-16.
    .refine((value) => Array.from(value).length <= maximum, {
      message: "Annotation text exceeds its code-point limit",
    })
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const point = character.codePointAt(0)!;
          return point > 31 && (point < 127 || point > 159);
        }),
      "Annotation text cannot contain control characters",
    )
    .nullable()
    .optional();
const photoValues = z
  .strictObject({
    object_kind: z
      .enum(["inscription", "calligraphy", "unknown"])
      .nullable()
      .optional(),
    representation: z
      .enum(["stone", "ink_original", "rubbing", "facsimile", "unknown"])
      .nullable()
      .optional(),
    capture_method: z.enum(["photo", "scan", "unknown"]).nullable().optional(),
    coverage: z
      .enum([
        "whole_object",
        "whole_surface_page",
        "detail",
        "context",
        "label",
        "unknown",
      ])
      .nullable()
      .optional(),
    surfaces: uncertainList(
      [
        "front",
        "back",
        "side_unspecified",
        "left",
        "right",
        "other",
        "unknown",
        "not_applicable",
      ],
      8,
    ).optional(),
    side_reference: z
      .enum(["facing_front", "unknown", "not_applicable"])
      .nullable()
      .optional(),
    parts: uncertainList(
      ["head", "body", "base", "other", "unknown", "not_applicable"],
      6,
    ).optional(),
    work_format: z
      .enum([
        "handscroll",
        "album",
        "folded_book",
        "hanging_scroll",
        "other",
        "unknown",
        "not_applicable",
      ])
      .nullable()
      .optional(),
    positions: uncertainList(
      [
        "main_work",
        "frontispiece",
        "tail",
        "cover_mount",
        "leaf_page",
        "other",
        "unknown",
        "not_applicable",
      ],
      8,
    ).optional(),
    content: uncertainList(
      [
        "main_text",
        "stele_title",
        "title",
        "colophon",
        "title_slip",
        "signature",
        "seal",
        "ornament",
        "damage",
        "label",
        "unknown",
      ],
      11,
    ).optional(),
    version_label: annotationText(120),
    position_index: integer.min(1).nullable().optional(),
    notes: annotationText(1000),
  })
  .superRefine((values, context) => {
    if (
      values.surfaces?.some(
        (surface) => surface === "left" || surface === "right",
      ) &&
      values.side_reference !== "facing_front"
    ) {
      context.addIssue({
        code: "custom",
        path: ["side_reference"],
        message: "Side labels require facing_front reference",
      });
    }
  });
const coverageState = z
  .enum(["captured", "not_captured", "unknown", "verified_absent"])
  .nullable()
  .optional();
const coverageValues = z
  .strictObject({
    front: coverageState,
    back: coverageState,
    left: coverageState,
    right: coverageState,
    head: coverageState,
    body: coverageState,
    base: coverageState,
    main_work: coverageState,
    frontispiece: coverageState,
    tail: coverageState,
    cover_mount: coverageState,
    leaf_page: coverageState,
    coverage_evidence: annotationText(1000),
  })
  .superRefine((values, context) => {
    if (
      Object.values(values).includes("verified_absent") &&
      !values.coverage_evidence?.trim()
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage_evidence"],
        message: "Verified absence requires evidence",
      });
    }
  });
const annotationPayload = z.discriminatedUnion("kind", [
  z.strictObject({
    schema_version: z.literal("artvenn-photo-annotation/v1"),
    kind: z.literal("photo"),
    values: photoValues,
  }),
  z.strictObject({
    schema_version: z.literal("artvenn-photo-annotation/v1"),
    kind: z.literal("object_coverage"),
    values: coverageValues,
  }),
]);
const annotationRevision = extension({
  id,
  context_key: hash,
  object_id: id,
  asset_id: id.nullable(),
  logical_asset_id: id.nullable(),
  source_sha256: hash.nullable(),
  revision: integer.min(1),
  previous_id: id.nullable(),
  payload: annotationPayload,
  payload_sha256: hash,
  // Keep Python's exact canonical spelling, including legal integer-valued 1.0.
  // The server hashes these original UTF-8 bytes after checking payload meaning.
  payloadCanonicalJSON: z
    .string()
    .min(1)
    .max(MAX_CURATION_METADATA_BYTES)
    .optional(),
  changes: record,
  coordinate_frame: curationOriginalFrameSchema.nullable(),
  review_id: id,
  review_revision: integer.min(1),
  review_draft_sha256: hash,
  membership_sha256: hash,
  confirmation_event: hash,
  created: z.number().nonnegative(),
});
const annotationDecision = extension({
  id,
  revision_id: id,
  status: z.literal("human_confirmed"),
  payload_sha256: hash,
  confirmation_event: hash,
  membership_decision_id: id,
  reviewer: z.string().min(1).max(256),
  provenance: extension({
    kind: z.literal("explicit_local_confirmation"),
    reviewId: id,
    reviewRevision: integer.min(1),
    draftSha256: hash,
    actorSource: z.literal("native_membership_reviewer"),
    // Preserve the actual narrow human review; do not promote inferred labels.
    nativeApprovalScope: z.literal("membership_and_legacy_role_only"),
  }),
  created: z.number().nonnegative(),
});
const proposal = extension({
  id,
  batch_id: id,
  subject: id,
  kind: z.string().min(1).max(80),
  field: z.string().nullable(),
  value: json,
  evidence: json,
  input_hash: hash,
  model_revision: z.string(),
  prompt_version: z.string(),
  created: z.number().nonnegative(),
  version: integer.min(1),
  source_record_sha256: hash.optional(),
  excluded_asset_count: integer.optional(),
});
const decision = extension({
  id,
  proposal_id: id,
  task_key: id,
  annotation_id: documentId,
  annotation_hash: hash,
  status: z.string().min(1).max(80),
  value: json,
  reviewer: z.string().min(1).max(256),
  created: z.number().nonnegative(),
  source_record_sha256: hash.optional(),
  excluded_asset_count: integer.optional(),
});

const snapshotShape = z.strictObject({
  schemaVersion: z.literal(CURATION_METADATA_VERSION),
  sourceHashPolicy: z.literal("registry_recorded_not_reverified"),
  publicationPacketSha256: hash,
  catalogId: catalogIdSchema,
  sourceId: sourceIdSchema,
  objectId: id,
  draftBaseline: z.strictObject({
    id: documentId,
    revision: integer.min(1),
    fingerprint: hash,
    status: z.literal("draft"),
    displayMediaIds: rows(mediaIdSchema),
    coverMediaId: mediaIdSchema.nullable(),
  }),
  review: z.strictObject({ id, revision: integer.min(1) }),
  photos: rows(
    z.strictObject({
      assetId: id,
      nativeId: documentId,
      mediaId: mediaIdSchema,
      sourceSha256: hash,
      uploadedSha256: hash,
      derivativeVersion: z.string().min(1).max(256),
      position: integer,
      role,
      frame: curationOriginalFrameSchema,
      processing: z.strictObject({
        source: record.nullable(),
        preview: record.nullable(),
      }),
    }),
  ).min(1),
  sourceGroups: rows(
    z.strictObject({
      id,
      assetIds: rows(id).min(1),
      originalRecordSha256: hash,
      originalMemberCount: integer.min(1),
      excludedCount: integer,
      provenance: record,
    }),
  ),
  annotations: z.strictObject({
    current_annotations: rows(
      z.strictObject({
        revision_id: id,
        decision_id: id,
        object_id: id,
        asset_id: id.nullable(),
      }),
    ),
    annotation_revisions: rows(annotationRevision),
    annotation_decisions: rows(annotationDecision),
  }),
  history: z.strictObject({
    proposals: rows(proposal),
    decisions: rows(decision),
    reviewDecisions: rows(decision),
    annotationSnapshots: rows(
      extension({
        id,
        sourceRecordSha256: hash,
        taskKey: id,
        annotationId: documentId,
        annotationHash: hash,
        annotation: record,
        normalized: record,
      }),
    ),
    fieldProvenance: rows(
      extension({
        id,
        field: z.string(),
        model_revision: z.string(),
        prompt_version: z.string(),
        evidence: json,
        decision_id: id,
      }),
    ),
    facts: rows(extension({ field: z.string().min(1).max(256), value: json })),
    relationships: rows(record),
  }),
  modelRuns: rows(
    z.strictObject({
      id,
      assetIds: rows(id),
      originalRecordSha256: hash,
      originalAssetCount: integer,
      excludedAssetCount: integer,
      metadata: extension({
        status: z.string().min(1).max(80),
        engine: z.string().min(1).max(256),
        model_id: z.string().min(1).max(2_048),
        revision: z.string().min(1).max(256),
        prompt_version: z.string().min(1).max(256),
        weights_sha256: hash,
        mock: z.boolean(),
        cloud: z.boolean(),
        selectionBasis: z.literal("retained_structured_output_evidence"),
        originalInputImageCount: integer,
        failedInputAssignmentUnknown: z.boolean(),
      }),
      output: record,
    }),
  ),
});

export const curationMetadataSchema = snapshotShape.superRefine(
  (value, context) => {
    const issue = (path: Path, message: string) =>
      context.addIssue({ code: "custom", path, message });
    const unique = (values: readonly (string | number)[], path: Path) => {
      const seen = new Set<string>();
      values.forEach((item, index) => {
        if (seen.has(String(item)))
          issue([...path, index], "Duplicate identity");
        seen.add(String(item));
      });
    };
    const assets = new Map(value.photos.map((photo) => [photo.assetId, photo]));
    const mediaIds = new Set(
      value.photos.map((photo) => String(photo.mediaId)),
    );
    for (const key of ["assetId", "mediaId", "nativeId"] as const)
      unique(
        value.photos.map((photo) => photo[key]),
        ["photos", key],
      );
    value.photos.forEach((photo, index) => {
      if (photo.position !== index)
        issue(
          ["photos", index, "position"],
          "Source order must be continuous from zero",
        );
      if (
        photo.frame.assetId !== photo.assetId ||
        photo.frame.sourceSha256 !== photo.sourceSha256
      ) {
        issue(
          ["photos", index, "frame"],
          "Source frame identity does not match the photo",
        );
      }
    });
    unique(value.draftBaseline.displayMediaIds, [
      "draftBaseline",
      "displayMediaIds",
    ]);
    value.draftBaseline.displayMediaIds.forEach((mediaId, index) => {
      if (!mediaIds.has(mediaId))
        issue(
          ["draftBaseline", "displayMediaIds", index],
          "Display media is outside the archived photos",
        );
    });
    if (
      value.draftBaseline.coverMediaId !== null &&
      !mediaIds.has(value.draftBaseline.coverMediaId)
    ) {
      issue(
        ["draftBaseline", "coverMediaId"],
        "Cover is outside the archived photos",
      );
    }
    if (value.catalogId === String(value.sourceId))
      issue(["sourceId"], "Catalog and source identities must be distinct");
    unique(
      value.sourceGroups.map((group) => group.id),
      ["sourceGroups", "id"],
    );
    const grouped: string[] = [];
    value.sourceGroups.forEach((group, index) => {
      unique(group.assetIds, ["sourceGroups", index, "assetIds"]);
      grouped.push(...group.assetIds);
      if (
        group.originalMemberCount !==
        group.assetIds.length + group.excludedCount
      )
        issue(
          ["sourceGroups", index],
          "Original group count must include excluded members",
        );
    });
    unique(grouped, ["sourceGroups", "assetIds"]);
    if (grouped.length !== assets.size)
      issue(["sourceGroups"], "Every photo must have one source group");
    unique(
      value.modelRuns.map((run) => run.id),
      ["modelRuns", "id"],
    );
    value.modelRuns.forEach((run, index) => {
      unique(run.assetIds, ["modelRuns", index, "assetIds"]);
      if (
        run.originalAssetCount !==
        run.assetIds.length + run.excludedAssetCount
      )
        issue(
          ["modelRuns", index],
          "Original model scope must include excluded evidence",
        );
    });

    const {
      annotation_revisions: revisions,
      annotation_decisions: decisions,
      current_annotations: current,
    } = value.annotations;
    unique(
      revisions.map((row) => row.id),
      ["annotations", "annotation_revisions", "id"],
    );
    unique(
      revisions.map((row) => `${row.context_key}:${row.revision}`),
      ["annotations", "annotation_revisions", "revision"],
    );
    unique(
      decisions.map((row) => row.id),
      ["annotations", "annotation_decisions", "id"],
    );
    unique(
      current.map((row) => JSON.stringify([row.object_id, row.asset_id])),
      ["annotations", "current_annotations"],
    );
    unique(
      value.history.proposals.map((row) => row.id),
      ["history", "proposals", "id"],
    );
    unique(
      value.history.decisions.map((row) => row.id),
      ["history", "decisions", "id"],
    );
    const revisionMap = new Map(revisions.map((row) => [row.id, row]));
    const decisionMap = new Map(decisions.map((row) => [row.id, row]));
    const proposalIds = new Set(value.history.proposals.map((row) => row.id));
    const membershipIds = new Set(value.history.decisions.map((row) => row.id));
    for (const [index, row] of revisions.entries()) {
      const path: Path = ["annotations", "annotation_revisions", index];
      if (row.object_id !== value.objectId)
        issue(path, "Annotation object is outside this snapshot");
      if (row.payloadCanonicalJSON !== undefined) {
        try {
          const input: unknown = JSON.parse(row.payloadCanonicalJSON);
          const originalPayload = annotationPayload.safeParse(input);
          if (
            !walkJson(input, () => undefined) ||
            !originalPayload.success ||
            JSON.stringify(originalPayload.data) !== JSON.stringify(row.payload)
          ) {
            issue(
              [...path, "payloadCanonicalJSON"],
              "Original annotation bytes must describe the exact controlled payload",
            );
          }
        } catch {
          issue(
            [...path, "payloadCanonicalJSON"],
            "Original annotation payload is not valid JSON",
          );
        }
      }
      const patchSchema =
        row.payload.kind === "photo"
          ? z.strictObject(photoValues.shape)
          : z.strictObject(coverageValues.shape);
      if (!patchSchema.safeParse(row.changes).success)
        issue(
          [...path, "changes"],
          "Annotation changes must use the existing professional vocabulary",
        );
      if (row.asset_id === null) {
        if (
          row.payload.kind !== "object_coverage" ||
          row.source_sha256 !== null ||
          row.coordinate_frame !== null ||
          row.logical_asset_id !== null
        )
          issue(path, "Object annotation cannot carry a photo frame");
      } else {
        const photo = assets.get(row.asset_id);
        if (
          !photo ||
          row.payload.kind !== "photo" ||
          row.source_sha256 !== photo.sourceSha256 ||
          row.coordinate_frame?.assetId !== photo.assetId ||
          row.coordinate_frame.sourceSha256 !== photo.sourceSha256 ||
          JSON.stringify(row.coordinate_frame) !== JSON.stringify(photo.frame)
        )
          issue(
            path,
            "Annotation source identity or frame does not match the photo",
          );
      }
      if (row.previous_id !== null) {
        const previous = revisionMap.get(row.previous_id);
        if (
          !previous ||
          previous.context_key !== row.context_key ||
          previous.revision !== row.revision - 1 ||
          previous.object_id !== row.object_id ||
          previous.asset_id !== row.asset_id
        )
          issue(
            path,
            "Annotation revision predecessor is missing or mismatched",
          );
      } else if (row.revision !== 1)
        issue(path, "Only a first revision may omit its predecessor");
    }
    for (const [index, row] of decisions.entries()) {
      const revision = revisionMap.get(row.revision_id);
      if (
        !revision ||
        row.payload_sha256 !== revision.payload_sha256 ||
        row.confirmation_event !== revision.confirmation_event ||
        row.provenance.reviewId !== revision.review_id ||
        row.provenance.reviewRevision !== revision.review_revision ||
        row.provenance.draftSha256 !== revision.review_draft_sha256 ||
        !membershipIds.has(row.membership_decision_id)
      ) {
        issue(
          ["annotations", "annotation_decisions", index],
          "Annotation decision is not bound to the exact revision and membership review",
        );
      }
    }
    current.forEach((row, index) => {
      const revision = revisionMap.get(row.revision_id);
      const decision = decisionMap.get(row.decision_id);
      if (
        !revision ||
        !decision ||
        decision.revision_id !== row.revision_id ||
        revision.object_id !== row.object_id ||
        revision.asset_id !== row.asset_id ||
        revisions.some(
          (candidate) =>
            candidate.context_key === revision.context_key &&
            candidate.revision > revision.revision,
        )
      ) {
        issue(
          ["annotations", "current_annotations", index],
          "Current annotation must reference the latest exact reviewed revision",
        );
      }
    });
    value.history.decisions.forEach((row, index) => {
      if (!proposalIds.has(row.proposal_id))
        issue(["history", "decisions", index], "Decision proposal is missing");
    });
    value.history.reviewDecisions.forEach((row, index) => {
      if (!membershipIds.has(row.id))
        issue(
          ["history", "reviewDecisions", index],
          "Review decision is absent from preserved history",
        );
    });
    value.history.fieldProvenance.forEach((row, index) => {
      if (!proposalIds.has(row.id) || !membershipIds.has(row.decision_id))
        issue(
          ["history", "fieldProvenance", index],
          "Field provenance references missing history",
        );
    });

    const assetKeys = new Set([
      "assetId",
      "asset_id",
      "source_asset_id",
      "assetIds",
      "asset_ids",
    ]);
    const validTree = walkJson(value, (item, path) => {
      const key = path.at(-1);
      if (typeof key === "string" && forbiddenKey.test(key))
        issue(
          path,
          "Local paths, configuration and storage access fields are not portable metadata",
        );
      if (typeof item === "string" && localPath.test(item))
        issue(path, "Local filesystem references are not portable metadata");
      if (typeof key === "string" && assetKeys.has(key)) {
        const refs = Array.isArray(item) ? item : item === null ? [] : [item];
        if (refs.some((ref) => typeof ref !== "string" || !assets.has(ref)))
          issue(path, "Asset reference is outside the selected photos");
      }
      // Existing proposal/model evidence is an array of source asset IDs.
      if (
        key === "evidence" &&
        Array.isArray(item) &&
        item.some((ref) => typeof ref !== "string" || !assets.has(ref))
      )
        issue(path, "Evidence is outside the selected photos");
    });
    if (!validTree) issue([], "Snapshot is not bounded, well-formed JSON");
  },
);

export type CurationMetadata = z.output<typeof curationMetadataSchema>;

/** Hash the original UTF-8 payload in the server; never reserialize this value. */
export const decodeCurationMetadata = (
  payloadJSON: string,
): CurationMetadata => {
  if (
    !isWellFormedEditorialText(payloadJSON) ||
    new TextEncoder().encode(payloadJSON).length > MAX_CURATION_METADATA_BYTES
  ) {
    throw new Error("CURATION_METADATA_PAYLOAD_INVALID");
  }
  let input: unknown;
  try {
    input = JSON.parse(payloadJSON);
  } catch {
    throw new Error("CURATION_METADATA_JSON_INVALID");
  }
  if (!walkJson(input, () => undefined))
    throw new Error("CURATION_METADATA_PAYLOAD_INVALID");
  return curationMetadataSchema.parse(input);
};

const payloadJSONSchema = z
  .string()
  .min(1)
  .superRefine((payloadJSON, context) => {
    try {
      decodeCurationMetadata(payloadJSON);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid versioned curation metadata payload",
      });
    }
  });
export const saveCurationMetadataSchema = z.strictObject({
  payloadJSON: payloadJSONSchema,
  snapshotSha256: hash,
  expectedPreviousSha256: hash.nullable(),
});
export const readCurationMetadataSchema = z.strictObject({
  catalogId: catalogIdSchema,
  snapshotSha256: hash.optional(),
});
export const curationMetadataCountsSchema = z.strictObject({
  photos: integer,
  sourceGroups: integer,
  currentAnnotations: integer,
  annotationRevisions: integer,
  annotationDecisions: integer,
  modelRuns: integer,
});
export const deriveCurationMetadataCounts = (
  value: CurationMetadata,
): z.output<typeof curationMetadataCountsSchema> => ({
  photos: value.photos.length,
  sourceGroups: value.sourceGroups.length,
  currentAnnotations: value.annotations.current_annotations.length,
  annotationRevisions: value.annotations.annotation_revisions.length,
  annotationDecisions: value.annotations.annotation_decisions.length,
  modelRuns: value.modelRuns.length,
});
export const deriveCurationMetadataWarnings = (
  value: CurationMetadata,
): string[] => {
  const warnings: string[] = [];
  const currentIds = new Set(
    value.annotations.current_annotations.map((row) => row.revision_id),
  );
  const photos = value.annotations.annotation_revisions.filter(
    (row) => currentIds.has(row.id) && row.payload.kind === "photo",
  );
  if (
    photos.length < value.photos.length ||
    photos.some((row) => {
      if (row.payload.kind !== "photo") return false;
      const values = row.payload.values;
      return (
        !values.representation ||
        !values.coverage ||
        !values.content?.length ||
        !values.surfaces?.length
      );
    })
  )
    warnings.push("SPARSE_PROFESSIONAL_VALUES");
  if (
    photos.some((row) => {
      if (row.payload.kind !== "photo") return false;
      return Object.values(row.payload.values).some(
        (item) =>
          item === "unknown" ||
          (Array.isArray(item) && item.includes("unknown")),
      );
    })
  )
    warnings.push("UNKNOWN_PROFESSIONAL_VALUES");
  if (value.modelRuns.length === 0) warnings.push("NO_MODEL_RESULTS");
  if (value.modelRuns.some((run) => run.metadata.status === "partial"))
    warnings.push("ORIGINAL_MODEL_PARTIAL");
  if (
    value.modelRuns.some(
      (run) => run.metadata.failedInputAssignmentUnknown === true,
    )
  )
    warnings.push("FAILED_INPUT_ASSIGNMENT_UNKNOWN");
  if (value.annotations.annotation_decisions.length > 0)
    warnings.push("PROFESSIONAL_REVIEW_SCOPE_MEMBERSHIP_AND_ROLE_ONLY");
  if (
    value.history.facts.some(
      (fact) =>
        fact.field === "plannedDisplay" &&
        fact.value !== null &&
        !Array.isArray(fact.value) &&
        typeof fact.value === "object" &&
        fact.value.status === "DISPLAY_PLAN_NOT_APPLIED" &&
        fact.value.intentOnly === true,
    )
  ) {
    warnings.push("DISPLAY_PLAN_NOT_APPLIED");
  }
  return warnings;
};
export const curationMetadataResponseSchema = z
  .strictObject({
    id: documentId,
    catalogId: catalogIdSchema,
    snapshotSha256: hash,
    payloadJSON: payloadJSONSchema,
    previousSha256: hash.nullable(),
    createdAt: z.iso.datetime(),
    current: z.boolean(),
    counts: curationMetadataCountsSchema,
    replayed: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const parsed = saveCurationMetadataSchema.shape.payloadJSON.safeParse(
      value.payloadJSON,
    );
    if (!parsed.success) return;
    const payload = decodeCurationMetadata(value.payloadJSON);
    if (
      payload.catalogId !== value.catalogId ||
      JSON.stringify(deriveCurationMetadataCounts(payload)) !==
        JSON.stringify(value.counts)
    ) {
      context.addIssue({
        code: "custom",
        message: "Response identity and counts must match the exact payload",
      });
    }
  });
export type SaveCurationMetadataRequest = z.output<
  typeof saveCurationMetadataSchema
>;
export type ReadCurationMetadataRequest = z.output<
  typeof readCurationMetadataSchema
>;
export type CurationMetadataResponse = z.output<
  typeof curationMetadataResponseSchema
>;
export type CurationMetadataCounts = z.output<
  typeof curationMetadataCountsSchema
>;
