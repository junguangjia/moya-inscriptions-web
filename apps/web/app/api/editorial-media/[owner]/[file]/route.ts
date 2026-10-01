import { relayServerLocalEditorialMedia } from "../../../../../lib/public-api/server";
export const runtime = "nodejs";
/** Development only: editorial images for a phone on the LAN acceptance origin. */
export const GET = async (
  request: Request,
  context: { params: Promise<{ owner: string; file: string }> },
): Promise<Response> => {
  if (process.env.NODE_ENV !== "development" || new URL(request.url).search)
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    });
  const { owner, file } = await context.params;
  return relayServerLocalEditorialMedia(owner, file);
};
