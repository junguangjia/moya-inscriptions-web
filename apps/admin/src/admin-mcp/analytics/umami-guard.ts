import { UMAMI_READ_ROUTES } from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpIssue,
  AnalyticsCacheBlock,
  AnalyticsResolvedRange,
  UmamiReadRoute,
  UmamiRouteQuery,
  UmamiRouteReply,
} from "@moya/contracts/internal/admin-mcp";
import type { z } from "zod";

import { UMAMI_WORKSPACE_PATH } from "../../analytics/config";
import { publicWebsite, umamiUpstream } from "../../analytics/upstream";
import {
  failedEnvelope,
  inputInvalidEnvelope,
  issuesOfError,
} from "../envelope";
import {
  analyticsCache,
  analyticsTtlMs,
  createAnalyticsCache,
  createPoolSlots,
  snappedOpenEnd,
} from "./cache";
import type { AnalyticsCache } from "./cache";

/**
 * Umami's pool holds 3 connections and its reads appear to share them with ingestion,
 * whose batch POST times out at 3 s, so a lost acknowledgement can duplicate native
 * counts. MCP load must not inflate the numbers it reports: one connection stays free
 * for the screen and for ingestion.
 */
export const UMAMI_POOL_SHARE = 2;
export const UMAMI_CALL_BUDGET_MS = 6_000;
export const UMAMI_TOOL_BUDGET_MS = 8_000;

/**
 * A timeout ends the wait, not the query: Umami's handlers take no signal, so the
 * statement runs on, up to the role's 5 s statement_timeout, on a pool connection the
 * slot stands for. A slow Umami is when freeing it early would starve ingestion.
 */
export const UMAMI_OVERRUN_HOLD_MS = 5_000;

const WEBSITE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type FailureKind =
  | "timed_out"
  | "unavailable"
  | "rejected"
  | "invalid"
  | "not_found"
  | "not_configured"
  /** Queued, and every caller left before its turn: it never reached Umami. */
  | "abandoned";

class UmamiFailure extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind);
    this.name = "UmamiFailure";
  }
}

export interface UmamiCovers {
  readonly start: string;
  readonly end: string;
}

interface Answered<Route extends UmamiReadRoute> {
  readonly value: UmamiRouteReply<Route>;
  readonly asOf: string;
  /** The instants this answer is about; an open range's stops at its snapped minute. */
  readonly covers?: UmamiCovers;
}

/** No number: each names why, and a timeout says when to try again. */
export type UmamiFailureAnswer =
  | {
      readonly status: "failed";
      readonly code: "UMAMI_QUERY_TIMEOUT";
      readonly reason: "timed_out" | "unavailable";
      readonly retryAfterMs: number;
    }
  | {
      readonly status: "failed";
      readonly code: "UMAMI_REPLY_INVALID";
      readonly reason: "rejected" | "invalid";
    }
  | {
      readonly status: "failed";
      readonly code: "UMAMI_NOT_CONFIGURED" | "NOT_FOUND";
    }
  | {
      readonly status: "failed";
      readonly code: "INPUT_INVALID";
      readonly issues: readonly AdminMcpIssue[];
    };

export type UmamiAnswer<Route extends UmamiReadRoute> =
  | (Answered<Route> & {
      readonly status: "fresh";
      readonly cache: AnalyticsCacheBlock & { readonly stale?: undefined };
    })
  | (Answered<Route> & {
      readonly status: "stale";
      readonly cache: AnalyticsCacheBlock & { readonly stale: true };
      readonly reason: "timed_out" | "unavailable";
      readonly retryAfterMs: number;
    })
  | UmamiFailureAnswer;

export interface UmamiReadInput<Route extends UmamiReadRoute> {
  readonly query?: UmamiRouteQuery<Route>;
  /** Required on a ranged route and refused elsewhere. From the shared resolver. */
  readonly range?: Pick<AnalyticsResolvedRange, "start" | "end" | "complete">;
  /** Leave sooner than the tool's limit; the read runs on and fills the cache. */
  readonly softMs?: number;
  /** Holds for the realtime TTL, not the open-range one. */
  readonly realtime?: true;
}

interface Row {
  readonly path: string;
  readonly ranged: boolean;
  readonly pool: 1 | 2;
  readonly query: z.ZodType;
  readonly reply: z.ZodType;
}

const refused = (path: string, code: string): UmamiFailureAnswer => ({
  status: "failed",
  code: "INPUT_INVALID",
  issues: [{ path: [path], code }],
});

/**
 * The only way the MCP path reaches Umami: `umamiUpstream` straight to loopback with
 * the viewer identity, under Umami's own base path. Not the Admin's proxy, which is
 * the screen's path, and not Umami's own MCP route.
 */
export const createUmamiGuard = ({
  upstream = umamiUpstream,
  environment = process.env,
  now = Date.now,
  cache = createAnalyticsCache({ now }),
  callMs = UMAMI_CALL_BUDGET_MS,
  toolMs = UMAMI_TOOL_BUDGET_MS,
  overrunMs = UMAMI_OVERRUN_HOLD_MS,
}: {
  readonly upstream?: Pick<typeof umamiUpstream, "request">;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly cache?: AnalyticsCache;
  readonly callMs?: number;
  readonly toolMs?: number;
  readonly overrunMs?: number;
} = {}) => {
  const slots = createPoolSlots(UMAMI_POOL_SHARE);

  const fetchReply = async (
    route: UmamiReadRoute,
    row: Row,
    path: string,
    signal: AbortSignal,
  ) => {
    let response: Response;
    try {
      response = await upstream.request(path, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
    } catch (error) {
      throw new UmamiFailure(
        error instanceof Error && error.message === "ANALYTICS_NOT_CONFIGURED"
          ? "not_configured"
          : signal.aborted
            ? "timed_out"
            : "unavailable",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UmamiFailure(
        response.status === 404
          ? "not_found"
          : response.status >= 500
            ? "unavailable"
            : "rejected",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UmamiFailure(signal.aborted ? "timed_out" : "invalid");
    }
    const parsed = row.reply.safeParse(
      route === "website" ? publicWebsite(body) : body,
    );
    if (!parsed.success) throw new UmamiFailure("invalid");
    return parsed.data;
  };

  /**
   * The slot is held until the call has really ended. The signal covers the fetch and
   * the body; login cannot take it, but its own 5 s limit keeps the whole inside this one.
   */
  const call = async (
    route: UmamiReadRoute,
    row: Row,
    path: string,
    wanted: () => boolean,
  ) => {
    await slots.acquire(row.pool);
    let overran = false;
    try {
      if (!wanted()) throw new UmamiFailure("abandoned");
      return await fetchReply(route, row, path, AbortSignal.timeout(callMs));
    } catch (error) {
      overran = error instanceof UmamiFailure && error.kind === "timed_out";
      throw error;
    } finally {
      if (overran) setTimeout(() => slots.release(row.pool), overrunMs);
      else slots.release(row.pool);
    }
  };

  const read = async <Route extends UmamiReadRoute>(
    route: Route,
    input: UmamiReadInput<Route>,
    deadline: number,
  ): Promise<UmamiAnswer<Route>> => {
    if (!Object.hasOwn(UMAMI_READ_ROUTES, route))
      return refused("route", "route_not_allowed");
    const row: Row = UMAMI_READ_ROUTES[route];
    const given = input.query ?? {};
    // A strict object passes over an own `__proto__` silently, so it is named here.
    if (Object.hasOwn(given, "__proto__"))
      return refused("query", "unrecognized_keys");
    const parsed = row.query.safeParse(given);
    if (!parsed.success)
      return {
        status: "failed",
        code: "INPUT_INVALID",
        issues: issuesOfError(parsed.error, row.query, ["query"]),
      };
    const { range } = input;
    if (row.ranged !== (range !== undefined))
      return refused("range", row.ranged ? "required" : "not_for_this_route");
    const startAt = range?.start.getTime();
    const givenEnd = range?.end.getTime();
    if (
      range !== undefined &&
      (!Number.isInteger(startAt) ||
        !Number.isInteger(givenEnd) ||
        startAt! >= givenEnd!)
    )
      return refused("range", "invalid_range");

    const websiteId = environment.UMAMI_WEBSITE_ID ?? "";
    if (!WEBSITE_ID.test(websiteId))
      return { status: "failed", code: "UMAMI_NOT_CONFIGURED" };

    const open = range !== undefined && !range.complete;
    const endAt = open ? snappedOpenEnd(startAt!, now()) : givenEnd;
    const query = parsed.data as Record<string, string | number | undefined>;
    const inPath = new Set<string>();
    const path = row.path.replace(/\{(\w+)\}/gu, (_match, name: string) => {
      inPath.add(name);
      return String(query[name]);
    });
    const search = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .sort(([first], [second]) => (first < second ? -1 : 1))
      .map(([name, value]): [string, string] => [name, String(value)]);
    const params = new URLSearchParams([
      ...(range === undefined
        ? []
        : [
            // Umami takes prev's length in whole minutes, cut short, so both ends move by 1 ms
            // to keep it whole. Stored rows are whole seconds, so none sits in that 1 ms.
            [
              "startAt",
              String(
                !open && query.compare === "prev" ? startAt! - 1 : startAt,
              ),
            ],
            // Umami reads between two ends, both included. A complete range's end is not.
            ["endAt", String(open ? endAt : endAt! - 1)],
          ]),
      ...search.filter(([name]) => !inPath.has(name)),
    ]);
    const family = JSON.stringify([
      route,
      websiteId.toLowerCase(),
      search,
      startAt ?? null,
      open ? "open" : (endAt ?? null),
      input.realtime === true,
    ]);
    const covers =
      range === undefined
        ? undefined
        : {
            start: new Date(startAt!).toISOString(),
            end: new Date(endAt!).toISOString(),
          };

    const down = (reason: "timed_out" | "unavailable"): UmamiAnswer<Route> => {
      const last = cache.latest<{
        readonly reply: UmamiRouteReply<Route>;
        readonly covers?: UmamiCovers;
      }>(family);
      if (last === undefined)
        return {
          status: "failed",
          code: "UMAMI_QUERY_TIMEOUT",
          reason,
          retryAfterMs: callMs,
        };
      return {
        status: "stale",
        value: last.value.reply,
        asOf: new Date(last.fetchedAt).toISOString(),
        ...(last.value.covers === undefined
          ? {}
          : { covers: last.value.covers }),
        cache: {
          hit: true,
          ageMs: Math.max(0, now() - last.fetchedAt),
          stale: true,
        },
        reason,
        retryAfterMs: callMs,
      };
    };

    const answer = await cache.read({
      family,
      version: open ? String(endAt) : "",
      ttlMs: analyticsTtlMs(
        input.realtime
          ? "realtime"
          : range === undefined || open
            ? "open"
            : { end: endAt! },
        now(),
      ),
      waitMs: Math.min(input.softMs ?? Infinity, deadline - now()),
      load: async (wanted) => ({
        reply: (await call(
          route,
          row,
          `${UMAMI_WORKSPACE_PATH}/api/websites/${websiteId}${path}${params.size > 0 ? `?${params}` : ""}`,
          wanted,
        )) as UmamiRouteReply<Route>,
        ...(covers === undefined ? {} : { covers }),
      }),
    });
    if (answer.status === "answered")
      return {
        status: "fresh",
        value: answer.value.reply,
        asOf: new Date(answer.fetchedAt).toISOString(),
        ...(answer.value.covers === undefined
          ? {}
          : { covers: answer.value.covers }),
        cache: {
          hit: answer.hit,
          ageMs: Math.max(0, now() - answer.fetchedAt),
        },
      };
    if (answer.status === "late") return down("timed_out");
    const kind =
      answer.error instanceof UmamiFailure ? answer.error.kind : "invalid";
    switch (kind) {
      case "timed_out":
      case "abandoned":
        return down("timed_out");
      case "unavailable":
        return down("unavailable");
      case "rejected":
      case "invalid":
        return { status: "failed", code: "UMAMI_REPLY_INVALID", reason: kind };
      case "not_found":
        return { status: "failed", code: "NOT_FOUND" };
      case "not_configured":
        return { status: "failed", code: "UMAMI_NOT_CONFIGURED" };
    }
  };

  return {
    /** One tool call: its reads share the tool's limit, whichever of them spends it. */
    forTool() {
      const deadline = now() + toolMs;
      return {
        read: <Route extends UmamiReadRoute>(
          route: Route,
          input: UmamiReadInput<Route> = {},
        ) => read(route, input, deadline),
      };
    },
    purge: cache.purge,
  };
};

export type UmamiGuard = ReturnType<typeof createUmamiGuard>;

export const umamiGuard = createUmamiGuard({ cache: analyticsCache });

/** The whole answer when no canonical part stands beside it. */
export const umamiFailureEnvelope = (
  failure: UmamiFailureAnswer,
): AdminMcpEnvelope => {
  switch (failure.code) {
    case "INPUT_INVALID":
      return inputInvalidEnvelope(failure.issues);
    case "UMAMI_QUERY_TIMEOUT":
      return failedEnvelope(failure.code, {
        data: { reason: failure.reason, retryAfterMs: failure.retryAfterMs },
      });
    case "UMAMI_REPLY_INVALID":
      return failedEnvelope(failure.code, { data: { reason: failure.reason } });
    default:
      return failedEnvelope(failure.code);
  }
};
