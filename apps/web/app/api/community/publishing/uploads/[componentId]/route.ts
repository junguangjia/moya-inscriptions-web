import { relayServerPublishingUpload } from "../../../../../../lib/public-api/server";

export const runtime = "nodejs";

interface UploadRouteContext {
  params: Promise<{ componentId: string }>;
}

/** Streaming relay for one media component (raw bytes, POST only). */
export const POST = async (
  request: Request,
  context: UploadRouteContext,
): Promise<Response> => {
  const { componentId } = await context.params;
  return relayServerPublishingUpload(request, componentId);
};
