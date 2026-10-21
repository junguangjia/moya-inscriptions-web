import { readCommunitySessionToken } from "../../../../../../../lib/public-api/community-session-cookie";
import { fetchServerCatalogZoomBlocks } from "../../../../../../../lib/public-api/server";

export const runtime = "nodejs";

// The answer depends on who asks, so no cache may keep it for someone else.
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const emptyResponse = (status: number) =>
  new Response(null, { status, headers });

interface CatalogZoomBlocksRouteContext {
  params: Promise<{ catalogId: string; mediaId: string }>;
}

/** catalog-deep-zoom-v1: the same-origin relay of one image's block list. */
export const GET = async (
  request: Request,
  context: CatalogZoomBlocksRouteContext,
): Promise<Response> => {
  const { catalogId, mediaId } = await context.params;
  const result = await fetchServerCatalogZoomBlocks(
    catalogId,
    mediaId,
    readCommunitySessionToken(request.headers.get("cookie")),
  );

  switch (result.state) {
    case "success":
      return Response.json(result.blocks, { headers });
    case "access-denied":
      return emptyResponse(result.status);
    case "not-found":
      return emptyResponse(404);
    case "unavailable":
      return emptyResponse(503);
    case "unexpected-error":
      return emptyResponse(502);
  }
};
