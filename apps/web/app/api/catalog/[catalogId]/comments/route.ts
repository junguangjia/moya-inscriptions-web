import { readCommunitySessionToken } from "../../../../../lib/public-api/community-session-cookie";
import {
  createServerCatalogComment,
  fetchServerCatalogCommentPage,
} from "../../../../../lib/public-api/server";

export const runtime = "nodejs";

/** `pinned` carries the hot ids a load-more request already holds. */
const allowedParameters = new Set(["page", "pageSize", "pinned"]);
const maximumBodyBytes = 4_096;

const emptyResponse = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

const jsonResponse = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Bounds the actual stream: a chunked body declares no content-length, so the
 * header alone is not a limit. Returns null when the body is too large or absent.
 */
const readBoundedJson = async (request: Request): Promise<unknown | null> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maximumBodyBytes) return null;
  const reader = request.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBodyBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder().decode(
        chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
      ),
    ) as unknown;
  } catch {
    return null;
  }
};

interface CommentRouteContext {
  params: Promise<{ catalogId: string }>;
}

const readQuery = (request: Request): Record<string, string> | null => {
  const parameters = new URL(request.url).searchParams;
  for (const name of parameters.keys()) {
    if (!allowedParameters.has(name) || parameters.getAll(name).length !== 1)
      return null;
  }
  return Object.fromEntries(parameters.entries());
};

export const GET = async (
  request: Request,
  context: CommentRouteContext,
): Promise<Response> => {
  const query = readQuery(request);
  if (query === null) return emptyResponse(400);
  const { catalogId } = await context.params;
  try {
    const result = await fetchServerCatalogCommentPage(
      catalogId,
      query,
      undefined,
      readCommunitySessionToken(request.headers.get("cookie")),
    );
    switch (result.state) {
      case "success":
        return jsonResponse(result.page, 200);
      case "access-denied":
        return emptyResponse(result.status);
      case "invalid-query":
        return emptyResponse(400);
      case "not-found":
        return emptyResponse(404);
      case "unavailable":
        return emptyResponse(503);
      case "unexpected-error":
        return emptyResponse(502);
    }
  } catch {
    return emptyResponse(502);
  }
};

/** The session credential stays in the HttpOnly cookie; Web only relays it. */
export const POST = async (
  request: Request,
  context: CommentRouteContext,
): Promise<Response> => {
  const token = readCommunitySessionToken(request.headers.get("cookie"));
  if (token === undefined) return emptyResponse(401);
  const body = await readBoundedJson(request);
  if (body === null) return emptyResponse(422);
  const { catalogId } = await context.params;
  try {
    const result = await createServerCatalogComment(catalogId, token, body);
    switch (result.state) {
      case "success":
        // 202 keeps the author's pending submission truthful.
        return jsonResponse(result.item, result.awaitingApproval ? 202 : 201);
      case "unauthenticated":
        return emptyResponse(401);
      case "access-denied":
        return emptyResponse(result.status);
      case "not-found":
        return emptyResponse(404);
      case "invalid-input":
        return emptyResponse(422);
      case "unavailable":
        return emptyResponse(503);
      case "unexpected-error":
        return emptyResponse(502);
    }
  } catch {
    return emptyResponse(502);
  }
};
