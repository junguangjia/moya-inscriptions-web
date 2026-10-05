import { readCommunitySessionToken } from "../../../../lib/public-api/community-session-cookie";
import { fetchServerCatalogDetail } from "../../../../lib/public-api/server";

export const runtime = "nodejs";

// The answer depends on who asks, so no cache may keep it for someone else.
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const emptyResponse = (status: number) =>
  new Response(null, { status, headers });

interface CatalogDetailRouteContext {
  params: Promise<{ catalogId: string }>;
}

export const GET = async (
  request: Request,
  context: CatalogDetailRouteContext,
): Promise<Response> => {
  const { catalogId } = await context.params;
  const result = await fetchServerCatalogDetail(
    catalogId,
    readCommunitySessionToken(request.headers.get("cookie")),
  );

  switch (result.state) {
    case "success":
      return Response.json(result.detail, { headers });
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
