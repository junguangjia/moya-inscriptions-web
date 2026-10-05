import { readCommunitySessionToken } from "../../../../../../lib/public-api/community-session-cookie";
import { relayServerLocalCatalogMedia } from "../../../../../../lib/public-api/server";
export const runtime = "nodejs";
export const GET = async (
  request: Request,
  context: { params: Promise<{ catalogId: string; mediaId: string }> },
): Promise<Response> => {
  if (process.env.NODE_ENV !== "development" || new URL(request.url).search)
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  const { catalogId, mediaId } = await context.params;
  return relayServerLocalCatalogMedia(
    catalogId,
    mediaId,
    readCommunitySessionToken(request.headers.get("cookie")),
  );
};
