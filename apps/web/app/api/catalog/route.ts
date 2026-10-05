import {
  parseCatalogListTransportQuery,
  parseCatalogPage,
} from "../../../lib/public-api/catalog-list-client";
import { readCommunitySessionToken } from "../../../lib/public-api/community-session-cookie";
import { fetchServerCatalogPage } from "../../../lib/public-api/server";

import type { CatalogListTransportQuery } from "@moya/contracts";

export const runtime = "nodejs";

const allowedParameters = new Set(["kind", "page", "pageSize"]);

const parseQuery = (request: Request): CatalogListTransportQuery | null => {
  const parameters = new URL(request.url).searchParams;
  for (const name of parameters.keys()) {
    if (!allowedParameters.has(name) || parameters.getAll(name).length !== 1) {
      return null;
    }
  }

  const candidate = Object.fromEntries(parameters.entries());
  return parseCatalogListTransportQuery(candidate);
};

// The answer depends on who asks, so no cache may keep it for someone else.
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const emptyResponse = (status: number) =>
  new Response(null, { status, headers });

export const GET = async (request: Request): Promise<Response> => {
  const query = parseQuery(request);
  if (query === null) return emptyResponse(400);

  try {
    const result = await fetchServerCatalogPage(
      query,
      readCommunitySessionToken(request.headers.get("cookie")),
    );
    switch (result.state) {
      case "success": {
        const page = parseCatalogPage(result.page);
        return page !== null
          ? Response.json(page, { headers })
          : emptyResponse(502);
      }
      case "access-denied":
        return emptyResponse(result.status);
      case "unavailable":
        return emptyResponse(503);
      case "unexpected-error":
        return emptyResponse(502);
    }
  } catch {
    return emptyResponse(502);
  }
};
