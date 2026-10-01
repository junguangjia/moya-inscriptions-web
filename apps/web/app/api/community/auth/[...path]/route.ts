import { relayServerCommunityAuth } from "../../../../../lib/public-api/server";

export const runtime = "nodejs";

const unavailable = (): Response =>
  new Response(null, {
    status: 404,
    headers: { "cache-control": "private, no-store" },
  });

export const GET = (request: Request): Promise<Response> =>
  process.env.NODE_ENV === "development"
    ? relayServerCommunityAuth(request)
    : Promise.resolve(unavailable());

export const POST = (request: Request): Promise<Response> =>
  process.env.NODE_ENV === "development"
    ? relayServerCommunityAuth(request)
    : Promise.resolve(unavailable());
