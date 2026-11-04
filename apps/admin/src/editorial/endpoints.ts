import {
  cancelCatalogDeliverySchema,
  catalogDeliveryCapabilitiesRequestSchema,
  editorialApproveBatchSchema,
  editorialArticleApproveBatchSchema,
  editorialArticlePublishApprovedSchema,
  editorialArticleSaveDraftSchema,
  editorialPublishApprovedSchema,
  editorialReadDraftSchema,
  editorialRestoreDraftSchema,
  editorialSaveDraftSchema,
  ownerDraftPageRequestSchema,
  ownerHistoryRequestSchema,
  prepareCatalogDeliverySchema,
  readCatalogDeliverySchema,
  releaseCatalogDeliverySchema,
  requestCatalogReleaseSchema,
} from "@moya/contracts/internal/editorial";
import type { Endpoint, PayloadRequest } from "payload";
import type { ZodType } from "zod";

import { requireActor } from "./access";
import { ownerDraftPage, ownerHistoryPage } from "./owner";
import {
  prepareCatalogDelivery,
  readCatalogDelivery,
  requestCatalogRelease,
  releaseCatalogDelivery,
  cancelCatalogDelivery,
  catalogDeliveryCapabilities,
  catalogRenderBacklogForPacing,
} from "./catalog-delivery";

import { EditorialError, safeEditorialFailure } from "./errors";
import {
  approveBatch,
  publishApproved,
  readDraft,
  restoreDraft,
  saveDraft,
} from "./operations";
import {
  approveArticleBatch,
  publishApprovedArticle,
  saveArticleDraft,
} from "../editorial-content/operations";

const endpoint = (
  name: string,
  operation: (req: PayloadRequest, input: unknown) => Promise<unknown>,
): Endpoint => ({
  path: `/editorial/${name}`,
  method: "post",
  handler: async (req) => {
    try {
      requireActor(req);
      if (!req.json) throw new EditorialError("JSON_BODY_REQUIRED", 400);
      const input: unknown = await req.json();
      const result = await operation(req, input);
      return Response.json(
        { ok: true, result },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      // The configured logger emits only a fixed category and safe stack
      // locations, so unexpected failures remain diagnosable without content.
      if (!(error instanceof EditorialError))
        req.payload.logger.error({ err: error });
      return Response.json(safeEditorialFailure(error), {
        status: error instanceof EditorialError ? error.status : 500,
        headers: { "Cache-Control": "no-store" },
      });
    }
  },
});

export interface EditorialOperationDefinition {
  /** The request schema the operation parses for itself. */
  readonly input: ZodType;
  readonly run: (req: PayloadRequest, input: unknown) => Promise<unknown>;
}

/** Route name to operation, as communityOperationDefinitions names its routes. */
export const editorialOperationDefinitions = {
  "owner-drafts": { input: ownerDraftPageRequestSchema, run: ownerDraftPage },
  "owner-history": { input: ownerHistoryRequestSchema, run: ownerHistoryPage },
  "read-draft": { input: editorialReadDraftSchema, run: readDraft },
  "save-draft": { input: editorialSaveDraftSchema, run: saveDraft },
  "approve-batch": { input: editorialApproveBatchSchema, run: approveBatch },
  "publish-approved": {
    input: editorialPublishApprovedSchema,
    run: publishApproved,
  },
  "restore-draft": { input: editorialRestoreDraftSchema, run: restoreDraft },
  "prepare-catalog-delivery": {
    input: prepareCatalogDeliverySchema,
    run: prepareCatalogDelivery,
  },
  "read-catalog-delivery": {
    input: readCatalogDeliverySchema,
    run: readCatalogDelivery,
  },
  "request-catalog-release": {
    input: requestCatalogReleaseSchema,
    run: requestCatalogRelease,
  },
  "release-catalog-delivery": {
    input: releaseCatalogDeliverySchema,
    run: releaseCatalogDelivery,
  },
  "cancel-catalog-delivery": {
    input: cancelCatalogDeliverySchema,
    run: cancelCatalogDelivery,
  },
  "catalog-delivery-capabilities": {
    input: catalogDeliveryCapabilitiesRequestSchema,
    run: catalogDeliveryCapabilities,
  },
  // catalog-scale-v1 I9: read-only pacing for the CLI's prepare waves.
  "catalog-render-backlog": {
    input: catalogDeliveryCapabilitiesRequestSchema,
    run: catalogRenderBacklogForPacing,
  },
  // content-community-completion-v1: the same mechanism for Articles.
  "save-article-draft": {
    input: editorialArticleSaveDraftSchema,
    run: saveArticleDraft,
  },
  "approve-article-batch": {
    input: editorialArticleApproveBatchSchema,
    run: approveArticleBatch,
  },
  "publish-approved-article": {
    input: editorialArticlePublishApprovedSchema,
    run: publishApprovedArticle,
  },
} satisfies Readonly<Record<string, EditorialOperationDefinition>>;

export type EditorialOperationName = keyof typeof editorialOperationDefinitions;

export const editorialEndpoints: Endpoint[] = Object.entries(
  editorialOperationDefinitions,
).map(([name, { run }]) => endpoint(name, run));
