import { relayServerAuthorCommunity } from "../../../../lib/public-api/server";
export const runtime = "nodejs";
const relay = (request: Request): Promise<Response> =>
  process.env.NODE_ENV === "development"
    ? relayServerAuthorCommunity(request)
    : Promise.resolve(
        new Response(null, {
          status: 404,
          headers: { "cache-control": "private, no-store", vary: "Cookie" },
        }),
      );
export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const DELETE = relay;
