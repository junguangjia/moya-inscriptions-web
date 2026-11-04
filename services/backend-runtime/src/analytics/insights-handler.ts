import {
  analyticsStatusSchema,
  ANALYTICS_IP_RETENTION_DAYS,
} from "@moya/contracts/analytics";
import {
  AI_OPERATOR_LABEL,
  ANALYTICS_CANONICAL_METRICS,
  ANALYTICS_INSIGHT_REPORTS,
  ANALYTICS_INSIGHTS_PATH,
  ANALYTICS_NOT_COLLECTED,
  AnalyticsInsightRefusal,
  AnalyticsInsightTimeout,
  analyticsInsightResultSchemas,
  parseAnalyticsInsightQuery,
} from "@moya/contracts/internal/admin-mcp";
import type { AnalyticsInsightReport } from "@moya/contracts/internal/admin-mcp";
import { isCommunityStoreUnavailableError } from "@moya/api";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  aiOperatorRefusal,
  resolveOperatorActor,
} from "../community/operator-handler.js";
import { sendJson } from "../http/json-response.js";
import type { AnalyticsRouteDependencies } from "./analytics-handler.js";

const noStore = { "cache-control": "private, no-store" };

const sendError = (
  response: ServerResponse,
  status: 400 | 401 | 403 | 404 | 405 | 503,
  code: string,
  extra: Readonly<Record<string, unknown>> = {},
): void =>
  sendJson(response, status, { error: { status, code, ...extra } }, noStore);

const isReport = (value: string): value is AnalyticsInsightReport =>
  (ANALYTICS_INSIGHT_REPORTS as readonly string[]).includes(value);

const statusReport = async (dependencies: AnalyticsRouteDependencies) => {
  const status = analyticsStatusSchema.parse(
    await dependencies.service.status(),
  );
  return {
    report: "status" as const,
    source: "canonical" as const,
    asOf: new Date().toISOString(),
    ...status,
    ipRetentionDays: ANALYTICS_IP_RETENTION_DAYS,
    metrics: [...ANALYTICS_CANONICAL_METRICS],
    notCollected: Object.fromEntries(
      Object.entries(ANALYTICS_NOT_COLLECTED).map(([name, reason]) => [
        name,
        { collected: false, reason },
      ]),
    ),
  };
};

/**
 * Canonical analytics for the AI operator, reached through the route table like any
 * other AI route. Read only, on the base credential, so sessions and every other
 * report work with the community token absent.
 */
export const handleAnalyticsInsights = async (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  dependencies: AnalyticsRouteDependencies,
): Promise<void> => {
  const actor = resolveOperatorActor(
    request,
    dependencies.operatorCredential,
    dependencies.aiCredentials,
  );
  if (actor === null) return sendError(response, 401, "OPERATOR_UNAUTHORIZED");
  if (actor.label === AI_OPERATOR_LABEL) {
    const refusal = aiOperatorRefusal(request, pathname, actor.credential);
    if (refusal !== null) return sendError(response, 403, refusal);
  }
  if (request.method !== "GET")
    return sendError(response, 405, "METHOD_NOT_ALLOWED");
  const report = pathname.slice(ANALYTICS_INSIGHTS_PATH.length + 1);
  if (!isReport(report)) return sendError(response, 404, "NOT_FOUND");
  try {
    const query = parseAnalyticsInsightQuery(
      report,
      new URL(request.url ?? "/", "http://request.invalid").searchParams,
    );
    if (report === "status") {
      const result = analyticsInsightResultSchemas.status.parse(
        await statusReport(dependencies),
      );
      return sendJson(response, 200, result, noStore);
    }
    if (dependencies.insights === undefined)
      return sendError(response, 503, "ANALYTICS_NOT_CONFIGURED");
    const result = analyticsInsightResultSchemas[report].parse(
      await dependencies.insights.read(report, query),
    );
    sendJson(response, 200, result, noStore);
  } catch (error) {
    if (error instanceof AnalyticsInsightRefusal)
      return sendError(
        response,
        error.status,
        error.code,
        error.issues.length > 0 ? { issues: error.issues } : {},
      );
    if (error instanceof AnalyticsInsightTimeout)
      return sendError(response, 503, "READ_TIMED_OUT");
    if (isCommunityStoreUnavailableError(error))
      return sendError(response, 503, "STORE_UNAVAILABLE");
    throw error;
  }
};
