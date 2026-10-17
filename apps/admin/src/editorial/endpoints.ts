import type { Endpoint, PayloadRequest } from "payload";
import { MAX_CURATION_METADATA_BYTES } from "@moya/contracts/internal/editorial";

import { requireActor } from "./access";
import { ownerDraftPage, ownerHistoryPage } from "./owner";

import { EditorialError, safeEditorialFailure } from "./errors";
import {
  readCurationMetadata,
  saveCurationMetadata,
} from "./curation-metadata";
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

const boundedJSON = async (
  req: PayloadRequest,
  maxBytes: number,
): Promise<unknown> => {
  if (!req.body) throw new EditorialError("JSON_BODY_REQUIRED", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EditorialError("JSON_BODY_TOO_LARGE", 413);
      }
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof EditorialError) throw error;
    throw new EditorialError("JSON_BODY_INVALID", 400);
  } finally {
    reader.releaseLock();
  }
};

const endpoint = (
  name: string,
  operation: (req: PayloadRequest, input: unknown) => Promise<unknown>,
  maxBodyBytes?: number,
): Endpoint => ({
  path: `/editorial/${name}`,
  method: "post",
  handler: async (req) => {
    try {
      requireActor(req);
      if (!req.json) throw new EditorialError("JSON_BODY_REQUIRED", 400);
      const input: unknown =
        maxBodyBytes === undefined
          ? await req.json()
          : await boundedJSON(req, maxBodyBytes);
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
  // The outer request JSON escapes the original JSON text. Leave room for its
  // worst-case encoding while the contract caps the decoded artifact at 8 MiB.
  endpoint(
    "save-curation-metadata",
    saveCurationMetadata,
    MAX_CURATION_METADATA_BYTES * 6 + 4096,
  ),
  endpoint("read-curation-metadata", readCurationMetadata, 4096),
  endpoint("save-draft", saveDraft),
  endpoint("approve-batch", approveBatch),
  endpoint("publish-approved", publishApproved),
  endpoint("restore-draft", restoreDraft),
  // content-community-completion-v1: the same mechanism for Articles.
  endpoint("save-article-draft", saveArticleDraft),
  endpoint("approve-article-batch", approveArticleBatch),
  endpoint("publish-approved-article", publishApprovedArticle),
];
