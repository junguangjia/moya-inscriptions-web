import { relayServerCommunityAccounts } from "../../../../lib/public-api/server";

export const runtime = "nodejs";

/** account-switching-v1: the accounts this browser holds; their sessions stay in HttpOnly cookies. */
export const GET = (request: Request): Promise<Response> =>
  relayServerCommunityAccounts(request, "list");
