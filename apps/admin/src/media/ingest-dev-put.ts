import type { Endpoint, PayloadRequest } from "payload";
import { EditorialError, safeEditorialFailure } from "../editorial/errors";
import type { LocalIngestStorage } from "./ingest-storage";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, Authorization",
};

/**
 * Development only: the PUT target of a staging URL the local ingest store
 * signs, standing in for the COS staging PUT. Its URL token is its only
 * authority; it never reads a session. createCatalogIngestEndpoints composes
 * it only for CMS_STORAGE_MODE=local outside production, so a production
 * configuration has no such route at all.
 */
export const createIngestDevPutEndpoint = (
  storage: (req: PayloadRequest) => LocalIngestStorage,
): Endpoint => ({
  path: "/editorial/media-ingest/dev-put/:ingestId",
  method: "put",
  handler: async (req) => {
    try {
      const result = await storage(req).acceptUpload(
        req.routeParams?.ingestId,
        req as unknown as Request,
      );
      if (result.status === 200)
        return Response.json(
          { ok: true },
          { headers: { ...headers, ETag: result.etag } },
        );
      return Response.json(
        { ok: false, error: { code: result.code, fields: [] } },
        { status: result.status, headers },
      );
    } catch (error) {
      if (!(error instanceof EditorialError))
        req.payload.logger.error({ category: "EDITORIAL_MEDIA_INGEST_FAILED" });
      return Response.json(safeEditorialFailure(error), {
        status: error instanceof EditorialError ? error.status : 500,
        headers,
      });
    }
  },
});
