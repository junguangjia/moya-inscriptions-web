import config from "@payload-config";
import { getPayload } from "payload";

import { createAnalyticsProxy } from "../../../../../src/analytics/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const proxy = createAnalyticsProxy({
  isOwner: async (request) => {
    const payload = await getPayload({ config });
    // Native Umami sends its own Authorization header, even during bootstrap.
    // This boundary authenticates only the existing Payload session cookie.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const { user } = await payload.auth({ headers });
    return user?.collection === "users" && user.role === "owner";
  },
});

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
