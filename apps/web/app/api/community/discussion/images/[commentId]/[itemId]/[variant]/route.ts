import { relayServerDiscussionImage } from "../../../../../../../../lib/public-api/server";

export const runtime = "nodejs";

interface ImageRouteContext {
  params: Promise<{ commentId: string; itemId: string; variant: string }>;
}

/** Image bytes bypass the bounded JSON business relay. */
export const GET = async (request: Request, context: ImageRouteContext) => {
  const { commentId, itemId, variant } = await context.params;
  return relayServerDiscussionImage(request, commentId, itemId, variant);
};

export const HEAD = GET;
