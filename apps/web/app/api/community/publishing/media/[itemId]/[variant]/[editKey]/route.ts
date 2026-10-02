import { relayServerPublishingMedia } from "../../../../../../../../lib/public-api/server";

export const runtime = "nodejs";

interface MediaRouteContext {
  params: Promise<{ itemId: string; variant: string; editKey: string }>;
}

/** Streaming relay for one private derivative (Range aware). */
export const GET = async (
  request: Request,
  context: MediaRouteContext,
): Promise<Response> => {
  const { itemId, variant, editKey } = await context.params;
  return relayServerPublishingMedia(request, itemId, variant, editKey);
};
