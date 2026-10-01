import { relayNotificationStream } from "../../../../../lib/public-api/notification-stream";
export const runtime = "nodejs";
export const GET = (request: Request): Promise<Response> =>
  process.env.NODE_ENV === "development"
    ? relayNotificationStream(request)
    : Promise.resolve(
        new Response(null, {
          status: 404,
          headers: { "cache-control": "private, no-store", vary: "Cookie" },
        }),
      );
