import "server-only";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  analyticsBatchSchema,
  analyticsBatchResultSchema,
} from "@moya/contracts/analytics";
import { readCommunitySessionToken } from "./community-session-cookie";
import { parsePublicApiBaseUrl } from "./server";

const validToken = (value: string | undefined | null): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/u.test(value);
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
};

/** Only authenticated ingress can name an IP; nothing forwarded by a browser is copied. */
export const relayServerAnalytics = async (
  request: Request,
): Promise<Response> => {
  const fail = (status: number) =>
    new Response(null, { status, headers: privateHeaders });
  if (request.method !== "POST") return fail(405);
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.MOYA_ANALYTICS_ENABLED !== "true"
  )
    return Response.json(
      { accepted: 0, excluded: false },
      { headers: privateHeaders },
    );
  const ingress = process.env.ANALYTICS_INGRESS_TOKEN;
  const relay = process.env.ANALYTICS_RELAY_TOKEN;
  const supplied = request.headers.get("x-moya-analytics-ingress");
  const source = request.headers.get("x-moya-client-ip");
  if (
    !validToken(ingress) ||
    !validToken(relay) ||
    ingress === relay ||
    !validToken(supplied) ||
    !equal(ingress, supplied) ||
    source === null ||
    source.length > 45 ||
    source.includes("%") ||
    isIP(source) === 0
  )
    return fail(403);
  const incoming = new URL(request.url);
  const origin = request.headers.get("origin");
  try {
    const actual = origin === null ? null : new URL(origin);
    if (
      actual === null ||
      actual.origin !== origin ||
      actual.host !== (request.headers.get("host") ?? incoming.host) ||
      actual.protocol !== incoming.protocol ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return fail(403);
  } catch {
    return fail(403);
  }
  if (
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  )
    return fail(415);
  if (Number(request.headers.get("content-length")) > 32_768) return fail(413);
  try {
    // Bound the stream as well: Content-Length is optional and never trusted.
    const reader = request.body?.getReader();
    if (!reader) return fail(400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 32_768) {
          await reader.cancel();
          return fail(413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    let parsed: ReturnType<typeof analyticsBatchSchema.safeParse>;
    try {
      parsed = analyticsBatchSchema.safeParse(JSON.parse(text));
    } catch {
      return fail(400);
    }
    if (!parsed.success) return fail(400);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "x-moya-analytics-relay": relay,
      "x-moya-analytics-source": source,
      "user-agent": (request.headers.get("user-agent") ?? "").slice(0, 512),
    };
    const token = readCommunitySessionToken(request.headers.get("cookie"));
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (
      (request.headers.get("cookie") ?? "")
        .split(";")
        .some((part) => part.trim() === "moya-analytics-excluded=1")
    )
      headers["x-moya-analytics-excluded"] = "1";
    const response = await fetch(
      new URL(
        "v1/analytics/events",
        parsePublicApiBaseUrl(process.env.MOYA_PUBLIC_API_BASE_URL),
      ),
      {
        method: "POST",
        headers,
        body: JSON.stringify(parsed.data),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return fail(response.status === 429 ? 429 : 503);
    const result = analyticsBatchResultSchema.safeParse(await response.json());
    if (!result.success) return fail(502);
    return Response.json(result.data, { headers: privateHeaders });
  } catch {
    return fail(503);
  }
};
