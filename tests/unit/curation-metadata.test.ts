import { describe, expect, it } from "vitest";
import {
  CURATION_METADATA_VERSION,
  MAX_CURATION_METADATA_BYTES,
  curationMetadataResponseSchema,
  curationMetadataSchema,
  decodeCurationMetadata,
  deriveCurationMetadataCounts,
  deriveCurationMetadataWarnings,
  readCurationMetadataSchema,
  saveCurationMetadataSchema,
} from "@moya/contracts/internal/editorial";

const sha = "a".repeat(64);
const otherSha = "b".repeat(64);

const fixture = (count = 3) => {
  const photos = Array.from({ length: count }, (_, position) => ({
    assetId: `asset-${position}`,
    nativeId: position + 1,
    mediaId: `synthetic-media-${position}`,
    sourceSha256: sha,
    uploadedSha256: otherSha,
    derivativeVersion: "source-srgb-jpeg-4096-q92-444-v1",
    position,
    role: "detail",
    frame: {
      version: "artvenn-original-frame/v1",
      assetId: `asset-${position}`,
      sourceSha256: sha,
      width: 6000,
      height: 4000,
      exifOrientation: 1,
      coordinateSystem: "original_encoded_pixels_top_left",
      orientationApplied: false,
    },
    processing: {
      source: { version: "derivation/v1", sourceSha256: sha },
      preview: null,
    },
  }));
  return {
    schemaVersion: CURATION_METADATA_VERSION,
    sourceHashPolicy: "registry_recorded_not_reverified",
    publicationPacketSha256: sha,
    catalogId: "synthetic-catalog",
    sourceId: "synthetic-source",
    objectId: "object-1",
    draftBaseline: {
      id: 5,
      revision: 2,
      fingerprint: sha,
      status: "draft",
      displayMediaIds: [photos[0]!.mediaId],
      coverMediaId: photos[0]!.mediaId,
    },
    review: { id: "review-1", revision: 15 },
    photos,
    sourceGroups: [
      {
        id: "group-1",
        assetIds: photos.map((photo) => photo.assetId),
        originalRecordSha256: sha,
        originalMemberCount: count + 1,
        excludedCount: 1,
        provenance: { kind: "ai-proposal" },
      },
    ],
    annotations: {
      current_annotations: [
        {
          revision_id: "annotation-1",
          decision_id: "annotation-decision-1",
          object_id: "object-1",
          asset_id: "asset-0",
        },
      ],
      annotation_revisions: [
        {
          id: "annotation-1",
          context_key: sha,
          object_id: "object-1",
          asset_id: "asset-0",
          logical_asset_id: "logical-1",
          source_sha256: sha,
          revision: 1,
          previous_id: null,
          payload: {
            schema_version: "artvenn-photo-annotation/v1",
            kind: "photo",
            values: {
              representation: "stone",
              content: ["unknown"],
              surfaces: ["unknown"],
              coverage: "unknown",
            },
          },
          payload_sha256: sha,
          changes: { representation: "stone" },
          coordinate_frame: photos[0]!.frame,
          review_id: "review-1",
          review_revision: 15,
          review_draft_sha256: sha,
          membership_sha256: sha,
          confirmation_event: sha,
          created: 0.123456789012345,
        },
      ],
      annotation_decisions: [
        {
          id: "annotation-decision-1",
          revision_id: "annotation-1",
          status: "human_confirmed",
          payload_sha256: sha,
          confirmation_event: sha,
          membership_decision_id: "decision-1",
          reviewer: "synthetic-reviewer",
          provenance: {
            kind: "explicit_local_confirmation",
            reviewId: "review-1",
            reviewRevision: 15,
            draftSha256: sha,
            actorSource: "native_membership_reviewer",
            nativeApprovalScope: "membership_and_legacy_role_only",
          },
          created: 0.123456789012345,
        },
      ],
    },
    history: {
      proposals: [
        {
          id: "proposal-1",
          batch_id: "batch-1",
          subject: "object-1",
          kind: "group",
          field: null,
          value: photos.map((photo) => ({
            asset_id: photo.assetId,
            role: photo.role,
          })),
          evidence: photos.map((photo) => photo.assetId),
          input_hash: sha,
          model_revision: "model-revision-1",
          prompt_version: "prompt-v1",
          created: 0,
          version: 1,
          source_record_sha256: otherSha,
          excluded_asset_count: 1,
        },
      ],
      decisions: [
        {
          id: "decision-1",
          proposal_id: "proposal-1",
          task_key: "task-1",
          annotation_id: 1,
          annotation_hash: sha,
          status: "accepted",
          value: [],
          reviewer: "synthetic-reviewer",
          created: 0,
        },
      ],
      reviewDecisions: [],
      annotationSnapshots: [],
      fieldProvenance: [],
      facts: [{ field: "period_original", value: { state: "UNSUPPLIED" } }],
      relationships: [],
    },
    modelRuns: [
      {
        id: "run-1",
        assetIds: photos.map((photo) => photo.assetId),
        originalRecordSha256: sha,
        originalAssetCount: count + 1,
        excludedAssetCount: 1,
        metadata: {
          model_id: "https://huggingface.co/synthetic/model",
          revision: "v1",
          prompt_version: "prompt-v1",
          status: "partial",
          engine: "synthetic-local",
          weights_sha256: sha,
          mock: true,
          cloud: false,
          selectionBasis: "retained_structured_output_evidence",
          originalInputImageCount: count + 1,
          failedInputAssignmentUnknown: true,
        },
        output: {
          groups: [
            {
              key: "g1",
              asset_ids: photos.map((photo) => photo.assetId),
              fields: [],
            },
          ],
          roles: [],
          relationships: [],
          issues: [],
        },
      },
    ],
  };
};

describe("versioned portable curation metadata", () => {
  it("retains an 83-photo archive and one display choice independently", () => {
    const parsed = decodeCurationMetadata(JSON.stringify(fixture(83)));
    expect(parsed.photos).toHaveLength(83);
    expect(parsed.draftBaseline.displayMediaIds).toEqual(["synthetic-media-0"]);
    expect(parsed.draftBaseline.coverMediaId).toBe("synthetic-media-0");
    expect(parsed.draftBaseline.id).toBe(5);
    expect(parsed.draftBaseline.revision).toBe(2);
    expect(parsed.history.proposals[0]!.input_hash).toBe(sha);
  });

  it("allows sparse, unknown and UNSUPPLIED values without promoting review", () => {
    const value = fixture(2);
    const stone = structuredClone(value.annotations.annotation_revisions[0]!);
    Object.assign(stone, {
      id: "annotation-2",
      context_key: otherSha,
      asset_id: "asset-1",
      coordinate_frame: value.photos[1]!.frame,
    });
    Object.assign(stone.payload, { values: { representation: "stone" } });
    value.annotations.annotation_revisions.push(stone);
    const stoneDecision = structuredClone(
      value.annotations.annotation_decisions[0]!,
    );
    Object.assign(stoneDecision, {
      id: "annotation-decision-2",
      revision_id: "annotation-2",
    });
    value.annotations.annotation_decisions.push(stoneDecision);
    value.annotations.current_annotations.push({
      revision_id: "annotation-2",
      decision_id: "annotation-decision-2",
      object_id: "object-1",
      asset_id: "asset-1",
    });
    const parsed = curationMetadataSchema.parse(value);
    expect(parsed.history.facts[0]!.value).toEqual({ state: "UNSUPPLIED" });
    expect(deriveCurationMetadataWarnings(parsed)).toEqual([
      "SPARSE_PROFESSIONAL_VALUES",
      "UNKNOWN_PROFESSIONAL_VALUES",
      "ORIGINAL_MODEL_PARTIAL",
      "FAILED_INPUT_ASSIGNMENT_UNKNOWN",
      "PROFESSIONAL_REVIEW_SCOPE_MEMBERSHIP_AND_ROLE_ONLY",
    ]);
    expect(
      parsed.annotations.annotation_decisions[0]!.provenance
        .nativeApprovalScope,
    ).toBe("membership_and_legacy_role_only");
  });

  it("distinguishes complete unknown labels from missing professional fields", () => {
    const unknown = curationMetadataSchema.parse(fixture(1));
    expect(deriveCurationMetadataWarnings(unknown)).toContain(
      "UNKNOWN_PROFESSIONAL_VALUES",
    );
    expect(deriveCurationMetadataWarnings(unknown)).not.toContain(
      "SPARSE_PROFESSIONAL_VALUES",
    );
    const sparse = fixture(1);
    Object.assign(sparse.annotations.annotation_revisions[0]!.payload, {
      values: { representation: "stone" },
    });
    const warnings = deriveCurationMetadataWarnings(
      curationMetadataSchema.parse(sparse),
    );
    expect(warnings).toContain("SPARSE_PROFESSIONAL_VALUES");
    expect(warnings).not.toContain("UNKNOWN_PROFESSIONAL_VALUES");
  });

  it.each([
    ["version_label", 120],
    ["notes", 1000],
  ] as const)(
    "preserves the inherited %s code-point limit",
    (field, maximum) => {
      const legal = fixture(1);
      Object.assign(legal.annotations.annotation_revisions[0]!.payload.values, {
        [field]: "🙂".repeat(maximum),
      });
      expect(curationMetadataSchema.safeParse(legal).success).toBe(true);
      const tooLong = fixture(1);
      Object.assign(
        tooLong.annotations.annotation_revisions[0]!.payload.values,
        {
          [field]: "🙂".repeat(maximum + 1),
        },
      );
      expect(curationMetadataSchema.safeParse(tooLong).success).toBe(false);
      const control = fixture(1);
      Object.assign(
        control.annotations.annotation_revisions[0]!.payload.values,
        {
          [field]: "🙂\n",
        },
      );
      expect(curationMetadataSchema.safeParse(control).success).toBe(false);
    },
  );

  it("preserves Python's integer-valued decimal spelling and its original payload hash", () => {
    const value = fixture(1);
    const originalPayloadJSON =
      '{"kind":"photo","schema_version":"artvenn-photo-annotation/v1","values":{"position_index":1.0,"representation":"stone"}}';
    // Golden SHA-256 of the original Python canonical UTF-8 bytes, not JS 1.
    const originalPayloadSha256 =
      "7a0feda1c0f17a14bbd8881702c3e4b072bafd75b232d2b0532e526911c268f5";
    const originalPayload: unknown = JSON.parse(originalPayloadJSON);
    Object.assign(value.annotations.annotation_revisions[0]!, {
      payload: originalPayload,
      payloadCanonicalJSON: originalPayloadJSON,
      payload_sha256: originalPayloadSha256,
    });
    value.annotations.annotation_decisions[0]!.payload_sha256 =
      originalPayloadSha256;
    const parsed = decodeCurationMetadata(JSON.stringify(value));
    expect(
      parsed.annotations.annotation_revisions[0]!.payloadCanonicalJSON,
    ).toBe(originalPayloadJSON);
    expect(parsed.annotations.annotation_revisions[0]!.payload_sha256).toBe(
      originalPayloadSha256,
    );
    const professional = parsed.annotations.annotation_revisions[0]!.payload;
    expect(
      professional.kind === "photo" && professional.values.position_index,
    ).toBe(1);
    const mismatched = structuredClone(value);
    Object.assign(mismatched.annotations.annotation_revisions[0]!, {
      payloadCanonicalJSON: originalPayloadJSON.replace('"stone"', '"rubbing"'),
    });
    expect(curationMetadataSchema.safeParse(mismatched).success).toBe(false);
    const invalid = structuredClone(value);
    Object.assign(invalid.annotations.annotation_revisions[0]!, {
      payloadCanonicalJSON: "{",
    });
    expect(curationMetadataSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps an unapplied display plan as intent and reports the empty actual selection", () => {
    const value = fixture(1);
    Object.assign(value.draftBaseline, {
      displayMediaIds: [],
      coverMediaId: null,
    });
    Object.assign(value.history, {
      facts: [
        ...value.history.facts,
        {
          field: "plannedDisplay",
          value: {
            status: "DISPLAY_PLAN_NOT_APPLIED",
            intentOnly: true,
            displayMedia: [
              {
                assetId: "asset-0",
                mediaId: "synthetic-media-0",
                position: 0,
                isRepresentative: true,
              },
            ],
          },
        },
      ],
    });
    const parsed = curationMetadataSchema.parse(value);
    expect(parsed.draftBaseline.displayMediaIds).toEqual([]);
    expect(parsed.draftBaseline.coverMediaId).toBeNull();
    expect(deriveCurationMetadataWarnings(parsed)).toContain(
      "DISPLAY_PLAN_NOT_APPLIED",
    );
    const applied = fixture(1);
    expect(
      deriveCurationMetadataWarnings(curationMetadataSchema.parse(applied)),
    ).not.toContain("DISPLAY_PLAN_NOT_APPLIED");
  });

  it.each(["assetId", "mediaId", "nativeId"] as const)(
    "rejects duplicate %s identities",
    (key) => {
      const value = fixture();
      // Duplicate identity is rejected before server writes or image operations.
      Object.assign(value.photos[1]!, { [key]: value.photos[0]![key] });
      expect(curationMetadataSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects gaps, shuffled order and references beyond the archive", () => {
    const gap = fixture();
    gap.photos[1]!.position = 7;
    expect(curationMetadataSchema.safeParse(gap).success).toBe(false);
    const shuffled = fixture();
    shuffled.photos.reverse();
    expect(curationMetadataSchema.safeParse(shuffled).success).toBe(false);
    const display = fixture();
    display.draftBaseline.displayMediaIds = ["outside-media"];
    expect(curationMetadataSchema.safeParse(display).success).toBe(false);
    const cover = fixture();
    cover.draftBaseline.coverMediaId = "outside-media";
    expect(curationMetadataSchema.safeParse(cover).success).toBe(false);
    const group = fixture();
    group.sourceGroups[0]!.assetIds[0] = "outside-asset";
    expect(curationMetadataSchema.safeParse(group).success).toBe(false);
    const model = fixture();
    model.modelRuns[0]!.output.groups[0]!.asset_ids[0] = "outside-asset";
    expect(curationMetadataSchema.safeParse(model).success).toBe(false);
  });

  it("requires exact annotation revisions, source frames and decision hash references", () => {
    const broken = [fixture(), fixture(), fixture(), fixture(), fixture()];
    broken[0]!.annotations.current_annotations[0]!.revision_id = "missing";
    broken[1]!.annotations.annotation_decisions[0]!.payload_sha256 = otherSha;
    broken[2]!.annotations.annotation_revisions[0]!.source_sha256 = otherSha;
    broken[3]!.annotations.annotation_revisions[0]!.coordinate_frame = {
      ...broken[3]!.photos[0]!.frame,
      width: 400,
    };
    broken[4]!.annotations.annotation_decisions[0]!.membership_decision_id =
      "missing";
    for (const value of broken)
      expect(curationMetadataSchema.safeParse(value).success).toBe(false);
  });

  it("does not accept missing or inflated professional review scope", () => {
    for (const scope of [
      undefined,
      "professional_dimensions_confirmed",
      "fully_reviewed",
    ]) {
      const value = fixture();
      Object.assign(value.annotations.annotation_decisions[0]!.provenance, {
        nativeApprovalScope: scope,
      });
      expect(curationMetadataSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects conflicting uncertainty and impossible side labels", () => {
    const mixed = fixture();
    mixed.annotations.annotation_revisions[0]!.payload.values.content = [
      "unknown",
      "main_text",
    ];
    expect(curationMetadataSchema.safeParse(mixed).success).toBe(false);
    const side = fixture();
    side.annotations.annotation_revisions[0]!.payload.values.surfaces = [
      "left",
    ];
    expect(curationMetadataSchema.safeParse(side).success).toBe(false);
  });

  it("blocks local paths, storage access and configuration fields while allowing model provenance URLs", () => {
    expect(curationMetadataSchema.safeParse(fixture()).success).toBe(true);
    for (const bad of [
      { sourcePath: "/Users/example/photo.jpg" },
      { objectKey: "private/photo.jpg" },
      { apiKey: "synthetic" },
      { source: "/tmp/photo.jpg" },
    ]) {
      const value = fixture();
      Object.assign(value.photos[0]!.processing.source!, bad);
      expect(curationMetadataSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects unsupported protocol versions, invalid JSON and oversized UTF-8 input", () => {
    const old = fixture();
    Object.assign(old, { schemaVersion: "artvenn-curation-metadata/v2" });
    expect(() => decodeCurationMetadata(JSON.stringify(old))).toThrow();
    expect(() => decodeCurationMetadata("{")).toThrow(
      "CURATION_METADATA_JSON_INVALID",
    );
    expect(() =>
      decodeCurationMetadata(
        `{"padding":"${"字".repeat(MAX_CURATION_METADATA_BYTES / 3)}"}`,
      ),
    ).toThrow("CURATION_METADATA_PAYLOAD_INVALID");
    const malformed = fixture();
    malformed.history.facts[0]!.field = "bad\ud800";
    expect(() => decodeCurationMetadata(JSON.stringify(malformed))).toThrow();
  });

  it("transports raw JSON without changing decimal spelling or whitespace", () => {
    const payloadJSON = JSON.stringify(fixture(), null, 2).replace(
      "0.123456789012345",
      "0.123456789012345000",
    );
    const saved = saveCurationMetadataSchema.parse({
      payloadJSON,
      snapshotSha256: sha,
      expectedPreviousSha256: null,
    });
    expect(saved.payloadJSON).toBe(payloadJSON);
    expect(
      readCurationMetadataSchema.parse({
        catalogId: "synthetic-catalog",
        snapshotSha256: sha,
      }),
    ).toEqual({ catalogId: "synthetic-catalog", snapshotSha256: sha });
    expect(
      saveCurationMetadataSchema.safeParse({
        ...saved,
        idempotencyKey: "legacy",
      }).success,
    ).toBe(false);
  });

  it("distinguishes current and historical responses and validates derived counts", () => {
    const payloadJSON = JSON.stringify(fixture());
    const response = {
      id: 1,
      catalogId: "synthetic-catalog",
      snapshotSha256: sha,
      payloadJSON,
      previousSha256: null,
      createdAt: "2026-10-13T00:00:00.000Z",
      current: false,
      counts: deriveCurationMetadataCounts(decodeCurationMetadata(payloadJSON)),
      replayed: true,
    };
    expect(curationMetadataResponseSchema.parse(response).current).toBe(false);
    expect(
      curationMetadataResponseSchema.safeParse({
        ...response,
        counts: { ...response.counts, photos: 99 },
      }).success,
    ).toBe(false);
    expect(
      curationMetadataResponseSchema.safeParse({
        ...response,
        catalogId: "other-catalog",
      }).success,
    ).toBe(false);
  });
});
