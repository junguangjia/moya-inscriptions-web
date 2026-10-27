import { catalogThumbnailRequestSchema } from "@moya/contracts/internal/editorial";
import type { Endpoint } from "payload";
import { isOwner } from "../editorial/access";
import {
  CommunityOperatorError,
  openCatalogOperatorThumbnail,
} from "../community/backend";
import type { OperatorMediaCall } from "../community/backend";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
};
export const createCatalogThumbnailEndpoint = (
  open: OperatorMediaCall = openCatalogOperatorThumbnail,
): Endpoint => ({
  path: "/catalog-media-thumbnail",
  method: "get",
  handler: async (req) => {
    if (!isOwner(req)) return new Response(null, { status: 403, headers });
    const values: Record<string, string | string[]> = {};
    for (const [key, value] of new URL(req.url ?? "http://invalid")
      .searchParams) {
      const previous = values[key];
      values[key] =
        previous === undefined
          ? value
          : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    const input = catalogThumbnailRequestSchema.safeParse(values);
    if (!input.success) return new Response(null, { status: 400, headers });
    try {
      const media = await open(
        `catalog-delivery/thumbnail?${new URLSearchParams(input.data)}`,
        null,
        req.signal,
      );
      return new Response(media.body, {
        headers: {
          ...headers,
          "Content-Type": "image/webp",
          ...(media.contentLength
            ? { "Content-Length": media.contentLength }
            : {}),
        },
      });
    } catch (error) {
      return new Response(null, {
        status:
          error instanceof CommunityOperatorError && error.status === 404
            ? 404
            : 503,
        headers,
      });
    }
  },
});
