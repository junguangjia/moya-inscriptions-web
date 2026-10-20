import {
  analyticsBatchSchema,
  analyticsBatchResultSchema,
  analyticsIpObservationsSchema,
  analyticsStatusSchema,
} from "@moya/contracts/analytics";
import type { AnalyticsService, CommunitySessionService } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRequestSource } from "../community/auth-request-source.js";
import { isAuthorizedOperator } from "../community/operator-handler.js";
import { readBearerToken } from "../community/session-credential.js";
import { readJsonBody } from "../http/json-body.js";
import { sendJson } from "../http/json-response.js";

export interface AnalyticsRouteDependencies {
  readonly service: AnalyticsService;
  readonly source?: AuthRequestSource;
  readonly sessions?: Pick<CommunitySessionService, "identify">;
  readonly operatorCredential: string;
}
const noStore = { "cache-control": "private, no-store" };
export const handleAnalyticsRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: AnalyticsRouteDependencies,
): Promise<void> => {
  if (pathname.startsWith("/internal/")) {
    if (!isAuthorizedOperator(request, dependencies.operatorCredential)) {
      sendJson(response, 401, { error: { code: "UNAUTHENTICATED" } }, noStore);
      return;
    }
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        { error: { code: "METHOD_NOT_ALLOWED" } },
        { ...noStore, allow: "GET" },
      );
      return;
    }
    if (new URL(request.url ?? "/", "http://request.invalid").search) {
      sendJson(response, 400, { error: { code: "INVALID_QUERY" } }, noStore);
      return;
    }
    const result = pathname.endsWith("/ips")
      ? analyticsIpObservationsSchema.parse(
          await dependencies.service.recentIps(),
        )
      : analyticsStatusSchema.parse(await dependencies.service.status());
    sendJson(response, 200, result, noStore);
    return;
  }
  if (request.method !== "POST") {
    sendJson(
      response,
      405,
      { error: { code: "METHOD_NOT_ALLOWED" } },
      { ...noStore, allow: "POST" },
    );
    return;
  }
  let body: ReturnType<typeof analyticsBatchSchema.parse>;
  try {
    if (new URL(request.url ?? "/", "http://request.invalid").search)
      throw new Error("Invalid query");
    body = analyticsBatchSchema.parse(await readJsonBody(request, 32768));
  } catch {
    sendJson(response, 400, { error: { code: "INVALID_INPUT" } }, noStore);
    return;
  }
  if (
    !dependencies.service.policy.enabled ||
    !dependencies.service.policy.production
  ) {
    sendJson(response, 202, { accepted: 0, excluded: false }, noStore);
    return;
  }
  const ip = dependencies.source?.(request);
  if (!ip) {
    sendJson(
      response,
      401,
      { error: { code: "ANALYTICS_SOURCE_UNTRUSTED" } },
      noStore,
    );
    return;
  }
  const excluded = request.headers["x-moya-analytics-excluded"] === "1";
  const token = readBearerToken(request);
  const profile =
    !excluded && token && dependencies.sessions
      ? await dependencies.sessions.identify(token)
      : null;
  try {
    const result = await dependencies.service.collect(body, {
      userId: profile?.id ?? null,
      ip,
      userAgent: (request.headers["user-agent"] ?? "").slice(0, 512),
      excluded,
    });
    sendJson(response, 202, analyticsBatchResultSchema.parse(result), noStore);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    sendJson(response, 400, { error: { code: "INVALID_INPUT" } }, noStore);
  }
};
