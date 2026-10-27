import { relayServerCommunityAccounts } from "../../../../../lib/public-api/server";

export const runtime = "nodejs";

/** account-switching-v1: makes another held account current, after `me` confirms its session. */
export const POST = (request: Request): Promise<Response> =>
  relayServerCommunityAccounts(request, "switch");
