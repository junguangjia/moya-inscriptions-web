import {
  analyticsIpObservationsSchema,
  analyticsStatusSchema,
} from "@moya/contracts/analytics";
import type { Endpoint } from "payload";
import {
  adminAnalyticsQuerySchema,
  adminAnalyticsReportSchema,
} from "@moya/contracts/admin-analytics";

import { isOwner } from "../editorial/access";
import { callCommunityOperator } from "../community/backend";
import { analyticsReportReady } from "./config";
import { readAdminAnalyticsReport } from "./upstream";

const privateHeaders = { "cache-control": "private, no-store" };

export const analyticsEndpoints: Endpoint[] = [
  {
    path: "/analytics/report",
    method: "get",
    handler: async (req) => {
      const headers = { ...privateHeaders, vary: "Cookie" };
      if (!isOwner(req))
        return Response.json({ error: "OWNER_ONLY" }, { status: 403, headers });
      if (req.method && req.method !== "GET")
        return Response.json(
          { error: "METHOD_NOT_ALLOWED" },
          { status: 405, headers: { ...headers, allow: "GET" } },
        );
      const params = new URL(req.url ?? "http://invalid").searchParams;
      if (
        [...new Set(params.keys())].some(
          (name) => params.getAll(name).length !== 1,
        )
      )
        return Response.json(
          { error: "INVALID_QUERY" },
          { status: 400, headers },
        );
      const query = adminAnalyticsQuerySchema.safeParse(
        Object.fromEntries(params),
      );
      if (!query.success)
        return Response.json(
          { error: "INVALID_QUERY" },
          { status: 400, headers },
        );
      if (!analyticsReportReady())
        return Response.json(
          { error: "ANALYTICS_NOT_CONFIGURED" },
          { status: 503, headers },
        );
      try {
        return Response.json(
          adminAnalyticsReportSchema.parse(
            await readAdminAnalyticsReport(query.data),
          ),
          {
            headers,
          },
        );
      } catch {
        return Response.json(
          { error: "ANALYTICS_UNAVAILABLE" },
          { status: 503, headers },
        );
      }
    },
  },
  ...(
    [
      ["status", analyticsStatusSchema],
      ["ips", analyticsIpObservationsSchema],
    ] as const
  ).map(([resource, schema]): Endpoint => ({
    path: `/analytics/${resource}`,
    method: "get",
    handler: async (req) => {
      if (!isOwner(req))
        return Response.json({ error: "OWNER_ONLY" }, { status: 403 });
      if (new URL(req.url ?? "http://invalid").search)
        return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
      try {
        const result = schema.parse(
          await callCommunityOperator("GET", `analytics/${resource}`),
        );
        return Response.json(result, { headers: privateHeaders });
      } catch {
        return Response.json(
          { error: "ANALYTICS_UNAVAILABLE" },
          { status: 503, headers: privateHeaders },
        );
      }
    },
  })),
  {
    path: "/analytics/exclude-device",
    method: "post",
    handler: async (req) => {
      if (!isOwner(req))
        return Response.json({ error: "OWNER_ONLY" }, { status: 403 });
      // Next may normalize req.url to its internal HTTP origin behind Nginx.
      // The production CMS boundary validates this configured public origin.
      const publicUrl = process.env.CMS_PUBLIC_URL ?? req.url;
      if (!publicUrl || req.headers.get("origin") !== new URL(publicUrl).origin)
        return Response.json({ error: "ORIGIN_REQUIRED" }, { status: 403 });
      // This cookie excludes only this device. It grants no access or identity.
      return Response.json(
        { excluded: true },
        {
          headers: {
            ...privateHeaders,
            "set-cookie": `moya-analytics-excluded=1; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${new URL(publicUrl).protocol === "https:" ? "; Secure" : ""}`,
          },
        },
      );
    },
  },
];
