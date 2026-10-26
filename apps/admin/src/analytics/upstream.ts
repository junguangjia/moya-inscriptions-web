import { createHash } from "node:crypto";
import {
  ADMIN_ANALYTICS_CHINA_MAP_SHA256,
  ADMIN_ANALYTICS_PROVINCE_CODES,
  adminAnalyticsQuerySchema,
  adminAnalyticsReportSchema,
} from "@moya/contracts/admin-analytics";
import type {
  AdminAnalyticsMapData,
  AdminAnalyticsQuery,
  AdminAnalyticsReport,
} from "@moya/contracts/admin-analytics";
import { analyticsReportReady, UMAMI_WORKSPACE_PATH } from "./config";

type Environment = Readonly<Record<string, string | undefined>>;

/** All authentication material remains in this server-only client. */
export const createUmamiUpstream = (
  environment: Environment = process.env,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) => {
  let cached: { token: string; until: number } | undefined;
  let loggingIn: Promise<string> | undefined;

  const origin = (): URL => {
    let value: URL;
    try {
      value = new URL(environment.UMAMI_ORIGIN ?? "");
    } catch {
      throw new Error("ANALYTICS_NOT_CONFIGURED");
    }
    if (
      !["http:", "https:"].includes(value.protocol) ||
      !["127.0.0.1", "[::1]", "localhost"].includes(value.hostname) ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash
    )
      throw new Error("ANALYTICS_NOT_CONFIGURED");
    return value;
  };

  const login = async (): Promise<string> => {
    if (cached && cached.until > now()) return cached.token;
    if (loggingIn) return loggingIn;
    loggingIn = (async () => {
      const username = environment.UMAMI_VIEWER_USERNAME;
      const password = environment.UMAMI_VIEWER_PASSWORD;
      if (!username || !password) throw new Error("ANALYTICS_NOT_CONFIGURED");
      const response = await fetcher(
        new URL(`${UMAMI_WORKSPACE_PATH}/api/auth/login`, origin()),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error("ANALYTICS_UNAVAILABLE");
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("token" in result) ||
        typeof result.token !== "string" ||
        result.token.length < 16 ||
        result.token.length > 8_192
      )
        throw new Error("ANALYTICS_UNAVAILABLE");
      cached = { token: result.token, until: now() + 10 * 60_000 };
      return result.token;
    })();
    try {
      return await loggingIn;
    } finally {
      loggingIn = undefined;
    }
  };

  return {
    origin,
    async request(path: string, init: RequestInit): Promise<Response> {
      const url = new URL(path, origin());
      const perform = async () => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${await login()}`);
        return fetcher(url, {
          ...init,
          headers,
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      };
      let response = await perform();
      if (response.status === 401) {
        await response.body?.cancel();
        cached = undefined;
        response = await perform();
      }
      return response;
    },
  };
};

export const umamiUpstream = createUmamiUpstream();

const pick = (value: unknown, keys: readonly string[]) =>
  Object.fromEntries(
    keys.flatMap((key) =>
      value && typeof value === "object" && key in value
        ? [[key, (value as Record<string, unknown>)[key]]]
        : [],
    ),
  );
const totals = [
  "pageviews",
  "visitors",
  "visits",
  "bounces",
  "totaltime",
] as const;
const context = ["country", "region", "displayName"] as const;
const rows = (value: unknown, keys: readonly string[]) => {
  if (!Array.isArray(value)) throw new Error("ANALYTICS_UNAVAILABLE");
  return value.map((row) => pick(row, keys));
};

// Expanded PostgreSQL SUM(bigint/numeric) fields serialize as decimal strings.
// This is a representation conversion for those two fields, never a null/blank
// fallback or a coercion of unrelated aggregate values.
const expandedNumeric = (value: unknown): unknown => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
    return value;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : value;
};

/** Bounded JSON only. Upstream account/error bodies and headers never escape. */
const readJsonBytes = async (response: Response, maximum: number) => {
  if (
    response.status !== 200 ||
    !/^application\/json(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    await response.body?.cancel();
    throw new Error("ANALYTICS_UNAVAILABLE");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new Error("ANALYTICS_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ANALYTICS_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("ANALYTICS_UNAVAILABLE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
const decodeJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

// DataV's standard two-digit province adcodes, in the contract's code order.
const provinceAdcodes = [
  11, 12, 13, 14, 15, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44,
  45, 46, 50, 51, 52, 53, 54, 61, 62, 63, 64, 65, 71, 81, 82,
];
const provinceCodes = new Map(
  provinceAdcodes.map((code, index) => [
    String(code * 10_000),
    ADMIN_ANALYTICS_PROVINCE_CODES[index],
  ]),
);
const mercator = (latitude: number) =>
  Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
const mapPath = (value: unknown): string => {
  if (!value || typeof value !== "object")
    throw new Error("ANALYTICS_UNAVAILABLE");
  const geometry = value as Record<string, unknown>;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : null;
  if (!polygons) throw new Error("ANALYTICS_UNAVAILABLE");
  return polygons
    .map((polygon) => {
      if (!Array.isArray(polygon)) throw new Error("ANALYTICS_UNAVAILABLE");
      return polygon
        .map((ring) => {
          if (!Array.isArray(ring) || ring.length < 4)
            throw new Error("ANALYTICS_UNAVAILABLE");
          return (
            ring
              .map((point, index) => {
                if (
                  !Array.isArray(point) ||
                  typeof point[0] !== "number" ||
                  typeof point[1] !== "number" ||
                  !Number.isFinite(point[0]) ||
                  !Number.isFinite(point[1]) ||
                  point[0] < 73 ||
                  point[0] > 136 ||
                  point[1] < 3 ||
                  point[1] > 54
                )
                  throw new Error("ANALYTICS_UNAVAILABLE");
                const x =
                  (((point[0] - 104.2990125) * Math.PI) / 180) *
                    551.356886295253 +
                  400;
                const y =
                  (mercator(31.769817845138974) - mercator(point[1])) *
                    551.356886295253 +
                  320;
                return `${index ? "L" : "M"}${Number(x.toFixed(3))} ${Number(y.toFixed(3))}`;
              })
              .join("") + "Z"
          );
        })
        .join("");
    })
    .join("");
};
const projectMap = (value: unknown): AdminAnalyticsMapData => {
  if (
    !value ||
    typeof value !== "object" ||
    !("features" in value) ||
    !Array.isArray(value.features)
  )
    throw new Error("ANALYTICS_UNAVAILABLE");
  const shapes = value.features.map((feature: unknown) => {
    if (
      !feature ||
      typeof feature !== "object" ||
      !("properties" in feature) ||
      !("geometry" in feature) ||
      !feature.properties ||
      typeof feature.properties !== "object" ||
      !("adcode" in feature.properties)
    )
      throw new Error("ANALYTICS_UNAVAILABLE");
    const id = String(feature.properties.adcode);
    const code = provinceCodes.get(id) ?? null;
    if (!code && id !== "100000_JD") throw new Error("ANALYTICS_UNAVAILABLE");
    const name =
      "name" in feature.properties &&
      typeof feature.properties.name === "string"
        ? feature.properties.name
        : "";
    return {
      id,
      code,
      name: code ? name : "地图边界装饰",
      path: mapPath(feature.geometry),
      decorative: code === null,
    };
  });
  return {
    width: 800,
    height: 640,
    viewBox: "0 0 800 640",
    sha256: ADMIN_ANALYTICS_CHINA_MAP_SHA256,
    attribution:
      "DataV.GeoAtlas / AMap（2021.5），仅供学习交流。标准地图参考与本数据来源分开标注。",
    referenceUrl:
      "https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml",
    shapes,
  };
};

const requestPath = (
  websiteId: string,
  query: Exclude<AdminAnalyticsQuery, { resource: "map" }>,
) => {
  const resource = {
    summary: "stats",
    trend: "pageviews",
    metrics: "metrics",
    expanded: "metrics/expanded",
    events: "events/series",
  }[query.resource];
  const params = new URLSearchParams({
    startAt: String(query.startAt),
    endAt: String(query.endAt),
    unit: query.unit,
    timezone: query.timezone,
  });
  for (const name of ["country", "region", "city"] as const) {
    if (query[name]) params.set(name, `eq.${query[name]}`);
  }
  if (query.resource === "metrics" || query.resource === "expanded") {
    params.set("type", query.type);
    params.set("limit", String(query.limit));
    params.set("offset", String(query.offset));
  }
  if (query.resource === "expanded" && query.q) params.set("search", query.q);
  if (query.resource === "events") params.set("limit", String(query.limit));
  return `${UMAMI_WORKSPACE_PATH}/api/websites/${websiteId}/${resource}?${params}`;
};

/** Fixed website, GET-only aggregate adapter. It does not run or recreate SQL. */
export const createAdminAnalyticsReports = (
  environment: Environment = process.env,
  upstream: Pick<
    ReturnType<typeof createUmamiUpstream>,
    "request"
  > = createUmamiUpstream(environment),
) => {
  let map: Promise<AdminAnalyticsMapData> | undefined;
  return async (input: unknown): Promise<AdminAnalyticsReport> => {
    const query = adminAnalyticsQuerySchema.parse(input);
    const websiteId = environment.UMAMI_WEBSITE_ID;
    if (!analyticsReportReady(environment) || !websiteId)
      throw new Error("ANALYTICS_NOT_CONFIGURED");
    try {
      if (query.resource === "map") {
        map ??= (async () => {
          const response = await upstream.request(
            `${UMAMI_WORKSPACE_PATH}/maps/china-provinces.json`,
            { method: "GET", headers: { accept: "application/json" } },
          );
          const bytes = await readJsonBytes(response, 1_048_576);
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            ADMIN_ANALYTICS_CHINA_MAP_SHA256
          )
            throw new Error("ANALYTICS_UNAVAILABLE");
          return projectMap(decodeJson(bytes));
        })().catch((error: unknown) => {
          map = undefined;
          throw error;
        });
        return adminAnalyticsReportSchema.parse({
          resource: "map",
          data: await map,
        });
      }
      const response = await upstream.request(requestPath(websiteId, query), {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const value = decodeJson(await readJsonBytes(response, 4_194_304));
      if (query.resource === "summary") {
        const comparison =
          value && typeof value === "object" && "comparison" in value
            ? value.comparison
            : undefined;
        return adminAnalyticsReportSchema.parse({
          resource: query.resource,
          data: {
            ...pick(value, totals),
            comparison: pick(comparison, totals),
          },
        });
      }
      if (query.resource === "trend") {
        const series = pick(value, ["pageviews", "sessions"]);
        return adminAnalyticsReportSchema.parse({
          resource: query.resource,
          data: {
            pageviews: rows(series.pageviews, ["x", "y"]),
            sessions: rows(series.sessions, ["x", "y"]),
          },
        });
      }
      if (query.resource === "events")
        return adminAnalyticsReportSchema.parse({
          resource: query.resource,
          data: rows(value, ["x", "t", "y"]),
        });
      const data = rows(
        value,
        query.resource === "metrics"
          ? ["x", "y", ...context]
          : ["name", ...totals, ...context],
      );
      if (query.resource === "expanded") {
        for (const row of data) {
          row.pageviews = expandedNumeric(row.pageviews);
          row.totaltime = expandedNumeric(row.totaltime);
        }
      }
      if (data.length > query.limit) throw new Error("ANALYTICS_UNAVAILABLE");
      if (query.resource === "metrics" && query.type === "country") {
        const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
        for (const row of data) {
          if (typeof row.x === "string" && /^[A-Z]{2}$/u.test(row.x))
            row.displayName = names.of(row.x) || row.x;
        }
      }
      return adminAnalyticsReportSchema.parse({
        resource: query.resource,
        data,
        limit: query.limit,
        offset: query.offset,
      });
    } catch {
      throw new Error("ANALYTICS_UNAVAILABLE");
    }
  };
};

export const readAdminAnalyticsReport = createAdminAnalyticsReports();
