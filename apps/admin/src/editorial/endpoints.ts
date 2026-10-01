import type { Endpoint, PayloadRequest } from "payload";

import { requireActor } from "./access";
import { ownerDraftPage, ownerHistoryPage } from "./owner";

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

export const editorialEndpoints: Endpoint[] = [
  endpoint("owner-drafts", ownerDraftPage),
  endpoint("owner-history", ownerHistoryPage),
  endpoint("read-draft", readDraft),
  endpoint("save-draft", saveDraft),
  endpoint("approve-batch", approveBatch),
  endpoint("publish-approved", publishApproved),
  endpoint("restore-draft", restoreDraft),
  // content-community-completion-v1: the same mechanism for Articles.
  endpoint("save-article-draft", saveArticleDraft),
  endpoint("approve-article-batch", approveArticleBatch),
  endpoint("publish-approved-article", publishApprovedArticle),
];
