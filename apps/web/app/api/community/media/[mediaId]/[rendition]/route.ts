import { relayServerProfileMedia } from "../../../../../../lib/public-api/server";

export const runtime = "nodejs";

interface ProfileMediaRouteContext {
  params: Promise<{ mediaId: string; rendition: string }>;
}

/**
 * One rendition of a profile image (Range aware). The original image and its
 * upload stay on the catch-all community route.
 */
export const GET = async (
  request: Request,
  context: ProfileMediaRouteContext,
): Promise<Response> => {
  const { mediaId, rendition } = await context.params;
  return relayServerProfileMedia(request, mediaId, rendition);
};
