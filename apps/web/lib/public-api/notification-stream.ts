import "server-only";
import { readCommunitySessionToken } from "./community-session-cookie";
import { parsePublicApiBaseUrl } from "./server";

export async function relayNotificationStream(
  request: Request,
): Promise<Response> {
  const headers = {
    "cache-control": "private, no-store, no-transform",
    vary: "Cookie",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  };
  const fail = (status: number) => new Response(null, { status, headers });
  if (new URL(request.url).search || request.headers.has("last-event-id"))
    return fail(422);
  const token = readCommunitySessionToken(request.headers.get("cookie"));
  if (!token) return fail(401);
  try {
    const upstream = await fetch(
      new URL(
        "v1/community/notifications/stream",
        parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL),
      ),
      {
        headers: {
          accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        redirect: "error",
        signal: request.signal,
      },
    );
    if (
      !upstream.ok ||
      !upstream.body ||
      !upstream.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      await upstream.body?.cancel();
      return fail(upstream.ok ? 502 : upstream.status);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  } catch {
    return fail(503);
  }
}
