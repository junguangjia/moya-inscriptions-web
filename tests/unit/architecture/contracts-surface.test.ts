import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

const contractsRoot = path.join(repositoryRoot, "packages", "contracts");

describe("contracts package surface", () => {
  it("keeps the root declaration limited to approved public types", async () => {
    const declaration = await readFile(
      path.join(contractsRoot, "dist", "index.d.ts"),
      "utf8",
    );
    const approved = [
      "ApiError",
      "ApiErrorCode",
      "CatalogCitationScope",
      "CatalogContributor",
      "CatalogContributorRole",
      "CatalogDetail",
      "CatalogId",
      "CatalogKind",
      "CatalogListTransportQuery",
      "CatalogPage",
      "CatalogSummary",
      "CatalogSearchMatchKind",
      "CatalogSearchTransportQuery",
      "CatalogSearchItem",
      "CatalogSearchPage",
      "CatalogComment",
      "CatalogCommentId",
      "CatalogCommentPage",
      "CatalogCommentReply",
      "CatalogCommentReplyPage",
      "CatalogCommentListingTransportQuery",
      "CatalogCommentTransportQuery",
      "CommentAuthor",
      "CreateCatalogCommentReplyRequest",
      "CreateCatalogCommentRequest",
      "HealthResponse",
      "MediaId",
      // unified-media-pipeline-v1: one rendition candidate of an image.
      "MediaRendition",
      "PublicMedia",
      "PublicSourceCitation",
      "PublicUserId",
      "PublicUserProfile",
    ];
    const exportBlock = declaration.match(
      /export type\s*\{([\s\S]*?)\}\s*from/,
    )?.[1];
    const exported = (exportBlock ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .sort();

    expect(exported).toEqual(approved.sort());

    for (const removed of [
      "ArchiveItemDetail",
      "ArchiveItemId",
      "ArchiveItemListQuery",
      "ArchiveItemListTransportQuery",
      "ArchiveItemPage",
      "ArchiveItemSummary",
      "ArchiveItemRecord",
      "ArchiveItemLifecycleStatus",
      "ArchiveItemSearchQuery",
      "CatalogDetailProjection",
      "CatalogListItemProjection",
      "CatalogListPageProjection",
      "CatalogListQuery",
      "CatalogQueryPort",
      "CatalogRecord",
      "CategoryFacet",
      "ImageAsset",
      "PublicLocation",
    ]) {
      expect(declaration).not.toContain(removed);
    }
  });

  it("pins the work publishing public types on the root declaration", async () => {
    const declaration = await readFile(
      path.join(contractsRoot, "dist", "index.d.ts"),
      "utf8",
    );
    const approved = [
      "CreatePublishingDraftCommand",
      "CreatePublishingSessionCommand",
      "EditableWork",
      "MediaClientPairing",
      "MediaClientSource",
      "MediaComponentDeclaration",
      "StandardComponentOutcome",
      "MediaComponentRole",
      "MediaComponentState",
      "MediaContentType",
      "MediaCrop",
      "MediaEdit",
      "MediaFailureCode",
      "MediaItemKind",
      "MediaItemState",
      "MediaMetadata",
      "MediaPairingMethod",
      "MediaPresentation",
      "MediaProcessingProfile",
      "MediaQualityMode",
      "MediaRotation",
      "MediaUploadQualityMode",
      "MediaVariant",
      "OpenWorkEditDraftCommand",
      "PublishingDeviceClass",
      "PublishingDraft",
      "PublishingDraftConflict",
      "PublishingDraftDeletionCommand",
      "PublishingDraftDeletionResult",
      "PublishingDraftKind",
      "PublishingDraftPage",
      "PublishingDraftSaveResult",
      "PublishingDraftSummary",
      "PublishingHolder",
      "PublishingLimits",
      "PublishingMediaComponent",
      "PublishingMediaItem",
      "PublishingMediaSources",
      "PublishingOpenedEditDraft",
      "PublishingPageQuery",
      "PublishingReadiness",
      "PublishingReadinessCommand",
      "PublishingSession",
      "PublishingSessionState",
      "PublishingSnapshot",
      "PublishingSnapshotPage",
      "PublishingUploadResult",
      "RegisterMediaItemCommand",
      "ResolvePublishingConflictCommand",
      "RestorePublishingSnapshotCommand",
      "SavePublishingDraftCommand",
      "WorkAuthorship",
      "WorkAuthorshipKind",
      "WorkDraftContent",
      "WorkDraftItem",
      "WorkDraftItemOrigin",
      "WorkMedia",
      "WorkPublishingFailureCode",
      "WorkSnapshotKind",
      "WorkSubmissionCommand",
      "WorkSubmissionContent",
      "WorkSubmissionNotReady",
      "WorkSubmissionReceipt",
      "WorkSubmissionResult",
      "WorkVisibility",
      "WorkVisibilityCommand",
      "WorkVisibilityResult",
    ];
    const exportBlock = declaration.match(
      /export type\s*\{([^}]*)\}\s*from\s*"\.\/work-publishing-schemas\.js"/,
    )?.[1];
    const exported = (exportBlock ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .sort();

    expect(exported).toEqual(approved.sort());
  });

  it("retires the Phase 4 work-edit draft contracts", async () => {
    const declaration = await readFile(
      path.join(contractsRoot, "dist", "index.d.ts"),
      "utf8",
    );
    const schemaDeclaration = await readFile(
      path.join(contractsRoot, "dist", "schemas.d.ts"),
      "utf8",
    );
    const schemas: Record<string, unknown> =
      await import("@moya/contracts/schemas");
    const jsonSchemas = await import("@moya/contracts/json-schema");
    for (const retired of [
      "WorkText",
      "WorkEditDraft",
      "WorkDraftSave",
      "WorkDraftApply",
    ]) {
      expect(declaration).not.toMatch(new RegExp(`\\b${retired}\\b`, "u"));
      expect(schemaDeclaration).not.toMatch(
        new RegExp(`\\btype ${retired}\\b`, "u"),
      );
    }
    for (const retired of [
      "workTextSchema",
      "workEditDraftSchema",
      "workDraftSaveSchema",
      "workDraftApplySchema",
      "workDraftPageSchema",
      "workDraftResultSchema",
      "workApplyResultSchema",
    ])
      expect(schemas[retired]).toBeUndefined();
    for (const retired of [
      "WorkDraftPage",
      "WorkDraftResult",
      "WorkApplyResult",
      "WorkDraftSave",
      "WorkDraftApply",
    ])
      expect(Object.keys(jsonSchemas.authorCommunityJsonSchemas)).not.toContain(
        retired,
      );
  });

  it("keeps the root JavaScript empty and free of Zod imports", async () => {
    const runtime = await readFile(
      path.join(contractsRoot, "dist", "index.js"),
      "utf8",
    );

    expect(runtime).toMatch(/^export \{\};/);
    expect(runtime).not.toContain("zod");
    expect(runtime).not.toContain("schemas.js");
  });

  it("keeps explicit runtime subpaths and side-effect-free metadata", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(contractsRoot, "package.json"), "utf8"),
    ) as {
      exports?: Record<string, unknown>;
      sideEffects?: boolean;
    };

    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(
      [
        ".",
        "./internal/catalog-import",
        "./internal/community-operator",
        "./internal/editorial",
        "./json-schema",
        "./schemas",
        "./types",
      ].sort(),
    );
    expect(manifest.sideEffects).toBe(false);
  });

  it("keeps the Community operator shapes on the explicit internal subpath", async () => {
    const publicDeclaration = await readFile(
      path.join(contractsRoot, "dist", "index.d.ts"),
      "utf8",
    );
    const operatorDeclaration = await readFile(
      path.join(
        contractsRoot,
        "dist",
        "internal",
        "community-operator",
        "index.d.ts",
      ),
      "utf8",
    );

    for (const name of [
      "PublicationPolicy",
      "OperatorComment",
      "ModerationResult",
      "CommentModerationState",
      "WorkPublishingSettings",
      "OperatorWorkSubmission",
      "WorkSubmissionDisposition",
      "OperatorAccountCapacity",
      "OperatorPublishingJob",
    ]) {
      expect(publicDeclaration).not.toContain(name);
      expect(operatorDeclaration).toContain(name);
    }
  });

  it("keeps Catalog Import contracts on the explicit internal subpath", async () => {
    const publicDeclaration = await readFile(
      path.join(contractsRoot, "dist", "index.d.ts"),
      "utf8",
    );
    const importDeclaration = await readFile(
      path.join(
        contractsRoot,
        "dist",
        "internal",
        "catalog-import",
        "index.d.ts",
      ),
      "utf8",
    );

    expect(publicDeclaration).not.toContain("CanonicalCatalogImportRow");
    expect(publicDeclaration).not.toContain("SourceId");
    expect(importDeclaration).toContain("CATALOG_IMPORT_CONTRACT_VERSION");
    expect(importDeclaration).toContain("CanonicalCatalogImportEnvelope");
  });
});
