import {
  ADMIN_ANALYTICS_UMAMI_FILTERS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ANALYTICS_DEFAULT_MIN_BASE,
  ANALYTICS_DEFAULT_TZ,
  ANALYTICS_INSIGHT_STATEMENT_TIMEOUT_MS,
  ANALYTICS_INSIGHTS_PATH,
  ANALYTICS_NOT_COLLECTED,
  ANALYTICS_RECONCILE_EXPLANATIONS,
  ANALYTICS_REALTIME_WINDOW_SECONDS,
  ANALYTICS_UMAMI_DIMENSIONS,
  analyticsExactShares,
  analyticsInsightResultSchemas,
  AnalyticsInsightRefusal,
  analyticsUntrustedPointers,
  parseAnalyticsInsightQuery,
  resolveAnalyticsRange,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminAnalyticsInput,
  AdminMcpEnvelope,
  AdminMcpIssue,
  AdminMcpMeta,
  AdminMcpNext,
  AnalyticsInsightReport,
  AnalyticsInsightResults,
  AnalyticsReconcileExplanation,
  AnalyticsResolvedRange,
  UmamiReadRoute,
} from "@moya/contracts/internal/admin-mcp";

import {
  aiToken,
  CommunityOperatorError,
  operatorBaseUrl,
} from "../../community/backend";
import {
  BACKEND_CONTRACT_MISMATCH,
  readBackendAnswer,
} from "../backend-answer";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import {
  ANALYTICS_SETTLED_AFTER_MS,
  analyticsCache,
  analyticsTtlMs,
  createPoolSlots,
} from "./cache";
import type { AnalyticsCache, PoolSlots } from "./cache";
import { umamiFailureEnvelope, umamiGuard } from "./umami-guard";
import type {
  UmamiAnswer,
  UmamiFailureAnswer,
  UmamiGuard,
} from "./umami-guard";

export const ANALYTICS_TOOL_NAME = "admin_analytics";

/** Section 9's limit on one call. Each statement inside it has its own 3 s. */
const CANONICAL_CALL_BUDGET_MS = 10_000;
/**
 * A report holds one community pool connection for its whole snapshot, and that pool
 * also serves the public site, the Owner and ingestion. Different questions pass the
 * cache and single flight, so the AI takes this many at once and the rest wait.
 */
export const CANONICAL_POOL_SHARE = 2;
/**
 * Our abort does not end the Backend's read, and a product report runs seven statements
 * with a time limit each, so a read given up on keeps its slot until the last has ended.
 */
const CANONICAL_OVERRUN_HOLD_MS =
  7 * ANALYTICS_INSIGHT_STATEMENT_TIMEOUT_MS - CANONICAL_CALL_BUDGET_MS;
/** Section 19: the native part of an answer never holds up the canonical part. */
const UMAMI_SOFT_BUDGET_MS = 1_500;
/** The screen's own cap. A row past it cannot be read, so it is named, not assumed. */
const UMAMI_METRIC_ROWS = 500;
const UMAMI_LIST_PAGE = 100;
const DEFAULT_ROWS = 10;
const DEFAULT_NATIVE_ROWS = 50;
const ANNOTATION_BYTES = 1_500;
const TOP_PROVINCES = 3;
/**
 * A cut answer is measured whole against this: `meta.stripped`, added after it leaves
 * here, needs the rest of the cap. Past the cap the tool would cut again and keep a
 * cursor naming the row it dropped.
 */
const FIT_BYTES = ADMIN_MCP_TEXT_CAP_BYTES - 16;
/**
 * Reports whose rows name a target or an account. The self-only check and an account's
 * erasure run where the Backend reads, and a change there cannot purge this cache, so
 * such an answer lives a minute, whatever period it is about.
 */
const NAMES_TARGETS_OR_ACCOUNTS: ReadonlySet<AnalyticsInsightReport> = new Set([
  "overview",
  "breakdown",
  "compare",
  "product",
  "session",
  "sessions",
]);

type Json = Record<string, unknown>;
type UmamiDimension = (typeof ANALYTICS_UMAMI_DIMENSIONS)[number];

const refused = (path: string, code: string, allowedKeys?: readonly string[]) =>
  new AnalyticsInsightRefusal(400, "INPUT_INVALID", [
    {
      path: [path],
      code,
      ...(allowedKeys === undefined ? {} : { allowedKeys }),
    },
  ]);

/** A read with no number. Carries the whole answer, so nothing below can read it as zero. */
class AnalyticsReadFailure extends Error {
  constructor(readonly envelope: AdminMcpEnvelope) {
    super(envelope.code);
    this.name = "AnalyticsReadFailure";
  }
}

const unavailable = (reason: string) =>
  new AnalyticsReadFailure(
    failedEnvelope("ANALYTICS_UNAVAILABLE", { data: { reason } }),
  );

const failureOfStatus = (
  status: number,
  body: { code?: unknown; issues?: unknown },
): AnalyticsReadFailure => {
  if (status === 400 && body.code === "INPUT_INVALID")
    return new AnalyticsReadFailure(
      inputInvalidEnvelope((body.issues ?? []) as readonly AdminMcpIssue[]),
    );
  if (body.code === "SELF_ONLY_OWNER_REVIEW")
    return new AnalyticsReadFailure(failedEnvelope("SELF_ONLY_OWNER_REVIEW"));
  if (status === 401 || status === 403)
    return new AnalyticsReadFailure(failedEnvelope("AI_ROUTE_FORBIDDEN"));
  if (body.code === "READ_TIMED_OUT")
    return new AnalyticsReadFailure(failedEnvelope("READ_TIMED_OUT"));
  return unavailable(status === 503 ? "store_unavailable" : "backend_refused");
};

/** The Backend's canonical read, on the base credential and never the Owner's. */
const fetchInsight = async <Report extends AnalyticsInsightReport>(
  report: Report,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<AnalyticsInsightResults[Report]> => {
  let url: URL;
  let token: string;
  try {
    token = aiToken("base");
    url = new URL(
      `${ANALYTICS_INSIGHTS_PATH.slice(1)}/${report}?${params}`,
      operatorBaseUrl(),
    );
  } catch (error) {
    throw error instanceof CommunityOperatorError &&
      error.code === "AI_CREDENTIAL_NOT_CONFIGURED"
      ? new AnalyticsReadFailure(failedEnvelope("AI_CREDENTIAL_NOT_CONFIGURED"))
      : unavailable("backend_not_configured");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // Never the URL, the credential or a driver message.
    throw signal.aborted
      ? new AnalyticsReadFailure(failedEnvelope("READ_TIMED_OUT"))
      : unavailable("backend_unreachable");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw failureOfStatus(
      response.status,
      (body as { error?: { code?: unknown; issues?: unknown } } | null)
        ?.error ?? {},
    );
  // A field the Backend adds first is dropped; a reply that breaks its contract is named.
  const read = readBackendAnswer(analyticsInsightResultSchemas[report], body);
  if (read === undefined)
    throw new AnalyticsReadFailure(failedEnvelope(BACKEND_CONTRACT_MISMATCH));
  return read.data as AnalyticsInsightResults[Report];
};

interface CanonicalLimits {
  readonly slots: PoolSlots;
  readonly callMs: number;
  readonly holdMs: number;
}

/** One read inside the AI's share of the community pool. */
const readInShare = async <Report extends AnalyticsInsightReport>(
  report: Report,
  params: URLSearchParams,
  wanted: () => boolean,
  { slots, callMs, holdMs }: CanonicalLimits,
): Promise<AnalyticsInsightResults[Report]> => {
  await slots.acquire();
  const signal = AbortSignal.timeout(callMs);
  try {
    // Queued, and every caller left before its turn: it never reaches the Backend.
    if (!wanted()) throw unavailable("abandoned");
    return await fetchInsight(report, params, signal);
  } finally {
    if (signal.aborted) setTimeout(() => slots.release(), holdMs);
    else slots.release();
  }
};

export interface AnalyticsServiceDeps {
  readonly guard: UmamiGuard;
  readonly cache: AnalyticsCache;
  readonly now: () => number;
  readonly canonical: CanonicalLimits;
}

/** One answer, before it is cut to size. What `limit` counts is `page`. */
interface Built {
  readonly data: Json;
  /** The way on past this page, kept in the same arguments. */
  readonly cursor?: string | undefined;
  /** The way on when it is not this report's own cursor. */
  readonly next?: AdminMcpNext | undefined;
  readonly page: readonly unknown[];
  /** What `limit` must be to keep `kept` rows, when a row is not one unit. */
  readonly unitsOf?: (kept: readonly unknown[]) => number;
  readonly excluded?: readonly string[] | undefined;
  readonly sources?: AdminMcpMeta["sources"];
  readonly partial?: boolean;
}

type CachedInsight<Report extends AnalyticsInsightReport> = Readonly<{
  reply: AnalyticsInsightResults[Report];
  cache: { readonly hit: boolean; readonly ageMs: number };
}>;

const pointersOf = (data: Json): readonly string[] => [
  ...new Set(
    analyticsUntrustedPointers(data, "/data").map((pointer) =>
      pointer.replace(/\/\d+(?=\/|$)/gu, "/*"),
    ),
  ),
];

const envelopeOf = (input: AdminAnalyticsInput, built: Built) => {
  const next =
    built.next ??
    (built.cursor === undefined
      ? undefined
      : {
          tool: ANALYTICS_TOOL_NAME,
          args: { ...input, cursor: built.cursor },
        });
  const meta: AdminMcpMeta = {
    ...(built.partial ? { partial: true as const } : {}),
    ...(built.excluded === undefined || built.excluded.length === 0
      ? {}
      : { excluded: [...built.excluded] }),
    ...(built.sources === undefined ? {} : { sources: built.sources }),
  };
  return {
    ...okEnvelope(built.data, pointersOf(built.data)),
    ...(next === undefined ? {} : { next }),
    meta,
  } satisfies AdminMcpEnvelope;
};

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The rows that fit once everything else in the answer has taken its room. */
const rowsThatFit = (
  envelope: AdminMcpEnvelope,
  page: readonly unknown[],
  input: AdminAnalyticsInput,
): number => {
  const others =
    bytesOf(envelope) -
    page.reduce<number>((sum, row) => sum + bytesOf(row) + 1, 0);
  // What a cut adds: its next, which repeats the arguments and a cursor, and its flags.
  const room = FIT_BYTES - others - bytesOf(input) - 240;
  let used = 0;
  let kept = 0;
  for (const row of page) {
    used += bytesOf(row) + 1;
    if (used > room) break;
    kept += 1;
  }
  return kept;
};

/**
 * A cut is a smaller page read again, so `other`, shares and the cursor are computed
 * for the rows that stay: none can hold a value from before the cut. An answer from
 * the cache costs nothing, and a canonical one is read in its own snapshot.
 */
const fitted = async (
  input: AdminAnalyticsInput,
  read: (limit: number | undefined) => Promise<Built>,
): Promise<AdminMcpEnvelope> => {
  const first = await read(input.limit);
  const whole = envelopeOf(input, first);
  if (bytesOf(whole) <= FIT_BYTES) return whole;
  const unitsFor = (built: Built, keep: number) =>
    built.unitsOf?.(built.page.slice(0, keep)) ?? keep;
  let units =
    first.page.length === 0
      ? 0
      : unitsFor(first, Math.max(1, rowsThatFit(whole, first.page, input)));
  for (let attempt = 0; attempt < 4 && units >= 1; attempt += 1) {
    const smaller = await read(units);
    const cut = envelopeOf(input, smaller);
    const answer = {
      ...cut,
      remaining: Math.max(0, first.page.length - smaller.page.length),
      meta: { ...cut.meta, truncated: true as const },
    };
    if (bytesOf(answer) <= FIT_BYTES) return answer;
    units = unitsFor(smaller, Math.floor(smaller.page.length / 2));
  }
  // Under the cap it stays whole, way on included.
  if (bytesOf(whole) <= ADMIN_MCP_TEXT_CAP_BYTES) return whole;
  // Not one row fits, so no cursor can go on from here: the size cap says so instead.
  return { ...whole, next: undefined };
};

const canonicalKeysOf = (input: AdminAnalyticsInput): URLSearchParams => {
  const params = new URLSearchParams();
  const put = (name: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) params.set(name, String(value));
  };
  put("range", input.range);
  put("from", input.from);
  put("to", input.to);
  put("tz", input.tz);
  put("compare", input.compare);
  put("groupBy", input.groupBy);
  put("dimension", input.dimension);
  put("direction", input.direction);
  put("minBase", input.minBase);
  put("limit", input.limit);
  put("cursor", input.cursor);
  put("visitorId", input.visitorId);
  put("sessionId", input.sessionId);
  put("include", input.include === "ip" ? "ip" : undefined);
  put("steps", input.steps?.join(","));
  put("sameTarget", input.sameTarget);
  put("basis", input.basis);
  put("surface", input.filter?.surface);
  put("targetType", input.filter?.targetType);
  put("targetId", input.filter?.targetId);
  put("event", input.filter?.event);
  put("distinctId", input.filter?.distinctId);
  put("userId", input.filter?.userId);
  return params;
};

const UMAMI_ONLY_ARGS = [
  "umamiSessionId",
  "funnelId",
  "kind",
  "goalId",
  "step",
] as const;

const umamiFilterOf = (input: AdminAnalyticsInput) =>
  Object.fromEntries(
    ADMIN_ANALYTICS_UMAMI_FILTERS.flatMap((name) => {
      const value = input.filter?.[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ) as {
    region?: string;
    city?: string;
    device?: string;
    segment?: string;
    cohort?: string;
  };

const hasUmamiFilter = (input: AdminAnalyticsInput) =>
  Object.keys(umamiFilterOf(input)).length > 0;

const RANGE_ARGS = ["range", "from", "to", "tz"] as const;

/** A report on Umami's path takes only these. Anything else would be quietly dropped. */
const onlyThese = (
  input: AdminAnalyticsInput,
  allowed: readonly (keyof AdminAnalyticsInput)[],
) => {
  const permitted = new Set<string>(["report", ...allowed]);
  for (const name of Object.keys(input))
    if (!permitted.has(name))
      throw refused(name, "not_for_this_report", [...permitted]);
  const canonicalOnly = Object.keys(input.filter ?? {}).find(
    (name) =>
      !(ADMIN_ANALYTICS_UMAMI_FILTERS as readonly string[]).includes(name),
  );
  if (canonicalOnly !== undefined)
    throw refused("filter", "not_for_this_report", [
      ...ADMIN_ANALYTICS_UMAMI_FILTERS,
    ]);
};

/** A canonical read takes no Umami argument, whatever a report's own list says. */
const noUmamiArgs = (input: AdminAnalyticsInput) => {
  for (const name of UMAMI_ONLY_ARGS)
    if (input[name] !== undefined) throw refused(name, "not_for_this_report");
  if (hasUmamiFilter(input)) throw refused("filter", "not_for_this_report");
  if (input.include === "umami")
    throw refused("include", "not_for_this_report");
};

/** Asked for, and never read: no path here goes near the observations. */
const ipWithheld = (input: AdminAnalyticsInput) =>
  input.include === "ip"
    ? { ip: { withheld: true as const, switch: "rawIp" as const } }
    : {};

const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  if (!/^[0-9]{1,7}$/u.test(cursor)) throw refused("cursor", "invalid_cursor");
  return Number(cursor);
};

/** Both read paths ask for the same instants, whatever the clock does between them. */
const pinnedRange = (
  params: URLSearchParams,
  range: AnalyticsResolvedRange,
) => {
  const open = params.has("from") && !params.has("to");
  params.delete("range");
  params.set("from", range.start.toISOString());
  if (!open) params.set("to", range.requestedEnd.toISOString());
};

/**
 * Inside an answer whose `meta.sources` and name already say Umami answered it. `covers`
 * only where it says more than the range does: an open range's last minute.
 */
const nestedBlockOf = <Route extends UmamiReadRoute>(
  answer: Exclude<UmamiAnswer<Route>, UmamiFailureAnswer>,
  range?: AnalyticsResolvedRange,
) => ({
  status: answer.status,
  asOf: answer.asOf,
  cache: answer.cache,
  ...(answer.covers === undefined ||
  answer.covers.end === range?.end.toISOString()
    ? {}
    : { covers: answer.covers }),
  ...(answer.status === "stale"
    ? { reason: answer.reason, retryAfterMs: answer.retryAfterMs }
    : {}),
});

const blockOf = <Route extends UmamiReadRoute>(
  answer: Exclude<UmamiAnswer<Route>, UmamiFailureAnswer>,
  range?: AnalyticsResolvedRange,
) => ({ source: "umami" as const, ...nestedBlockOf(answer, range) });

const failedBlock = (failure: UmamiFailureAnswer) => ({
  status: "failed" as const,
  code: failure.code,
  ...("reason" in failure ? { reason: failure.reason } : {}),
  ...("retryAfterMs" in failure ? { retryAfterMs: failure.retryAfterMs } : {}),
});

/** What one Umami part means for the answer it stands beside. */
const sourceStatus = (
  answer: UmamiAnswer<UmamiReadRoute>,
): "ok" | "timed_out" | "failed" | "not_available" => {
  if (answer.status === "fresh") return "ok";
  if (answer.status === "stale")
    return answer.reason === "timed_out" ? "timed_out" : "failed";
  if (answer.code === "UMAMI_QUERY_TIMEOUT")
    return answer.reason === "timed_out" ? "timed_out" : "failed";
  return answer.code === "UMAMI_NOT_CONFIGURED" ? "not_available" : "failed";
};

const worstSource = (
  answers: readonly UmamiAnswer<UmamiReadRoute>[],
): "ok" | "timed_out" | "failed" | "not_available" => {
  const statuses = answers.map(sourceStatus);
  return (
    (["failed", "timed_out", "not_available"] as const).find((status) =>
      statuses.includes(status),
    ) ?? "ok"
  );
};

const percentOf = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 100;

const nativeMetric = (
  v: number | null,
  prev: number | null,
  lowBase: boolean,
) => ({
  v,
  prev,
  delta: v === null || prev === null ? null : v - prev,
  pct: v === null || prev === null ? null : percentOf(v - prev, prev),
  additive: false,
  ...(lowBase ? { lowBase: true as const } : {}),
});

/**
 * The canonical path and the Umami path of one call. Key and pause were checked by
 * the guard before this runs, and a hit is audited by it like any read.
 */
const serviceFor = (
  input: AdminAnalyticsInput,
  { guard, cache, now, canonical }: AnalyticsServiceDeps,
) => {
  const umami = guard.forTool();
  const nowDate = () => new Date(now());

  const readInsight = async <Report extends AnalyticsInsightReport>(
    report: Report,
    params: URLSearchParams,
    range: AnalyticsResolvedRange | undefined,
  ): Promise<CachedInsight<Report>> => {
    const open = range !== undefined && !range.complete;
    const family = JSON.stringify([
      "insight",
      report,
      [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);
    const answer = await cache.read({
      family,
      version: open ? String(Math.floor(now() / 60_000)) : "",
      ttlMs: analyticsTtlMs(
        report === "realtime"
          ? "realtime"
          : range === undefined ||
              open ||
              NAMES_TARGETS_OR_ACCOUNTS.has(report) ||
              params.has("targetId")
            ? "open"
            : { end: range.requestedEnd.getTime() },
        now(),
      ),
      // Time in the queue counts: past this the caller has READ_TIMED_OUT, no number.
      waitMs: canonical.callMs + 500,
      // One short facts statement that every Umami-path report needs first, so no turn.
      load: (wanted) =>
        report === "native"
          ? fetchInsight(report, params, AbortSignal.timeout(canonical.callMs))
          : readInShare(report, params, wanted, canonical),
    });
    if (answer.status === "late")
      throw new AnalyticsReadFailure(failedEnvelope("READ_TIMED_OUT"));
    if (answer.status === "failed") {
      if (answer.error instanceof AnalyticsReadFailure) throw answer.error;
      throw unavailable("backend_unreachable");
    }
    return {
      reply: answer.value,
      cache: { hit: answer.hit, ageMs: Math.max(0, now() - answer.fetchedAt) },
    };
  };

  /** Checks a canonical report's arguments the way the Backend will, before asking it. */
  const canonicalQuery = (
    report: AnalyticsInsightReport,
    limit: number | undefined,
    overrides: Readonly<Record<string, string>> = {},
  ) => {
    const params = canonicalKeysOf(input);
    if (limit !== undefined) params.set("limit", String(limit));
    for (const [name, value] of Object.entries(overrides))
      params.set(name, value);
    const query = parseAnalyticsInsightQuery(report, params);
    if (report === "status" || report === "realtime")
      return { params, range: undefined };
    const range = resolveAnalyticsRange(query, nowDate());
    pinnedRange(params, range);
    return { params, range };
  };

  /**
   * One visitor's history reads through today: last_7_days holds finished days only,
   * and someone online now would otherwise read as having done nothing.
   */
  const sessionDefaults = (): Readonly<Record<string, string>> => {
    if (RANGE_ARGS.some((name) => input[name] !== undefined && name !== "tz"))
      return {};
    return {
      from: resolveAnalyticsRange(
        {
          range: "last_7_days",
          ...(input.tz === undefined ? {} : { tz: input.tz }),
        },
        nowDate(),
      ).start.toISOString(),
    };
  };

  /** What the store holds for this range, so Umami's empty rows cannot read as zero. */
  const retainedRange = async (
    overrides: Readonly<Record<string, string>> = {},
  ) => {
    const params = new URLSearchParams();
    for (const name of RANGE_ARGS) {
      const value = input[name];
      if (value !== undefined) params.set(name, value);
    }
    for (const [name, value] of Object.entries(overrides))
      params.set(name, value);
    const range = resolveAnalyticsRange(
      parseAnalyticsInsightQuery("native", params),
      nowDate(),
    );
    pinnedRange(params, range);
    const { reply } = await readInsight("native", params, range);
    return { range, facts: reply };
  };

  const canonicalBuilt = (
    reply: Json & {
      readonly excluded?: readonly string[] | undefined;
      readonly next?: { readonly cursor: string } | undefined;
    },
    cached: CachedInsight<AnalyticsInsightReport>["cache"],
    page: readonly unknown[],
  ): Built => {
    const { next, excluded, ...rest } = reply;
    return {
      data: { ...rest, cache: cached },
      cursor: next?.cursor,
      page,
      excluded,
      sources: { canonical: "ok" },
    };
  };

  const statusReport = async (): Promise<Built> => {
    noUmamiArgs(input);
    const { params } = canonicalQuery("status", undefined);
    const { reply, cache: cached } = await readInsight(
      "status",
      params,
      undefined,
    );
    const end = Date.parse(reply.asOf);
    return {
      data: {
        ...reply,
        // What `last24Hours` covers. `dataFrom` is not read here, so it is not named.
        range: {
          start: new Date(end - 86_400_000).toISOString(),
          end: reply.asOf,
          tz: ANALYTICS_DEFAULT_TZ,
          complete: false,
        },
        quality: { outboxPending: reply.outbox.pending },
        cache: cached,
      },
      page: [],
      sources: { canonical: "ok" },
    };
  };

  const overviewReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("overview", limit);
    // A number for one surface or target cannot stand beside site-wide places.
    const filtered = Object.keys(input.filter ?? {}).length > 0;
    const statsCompare =
      range!.complete && input.compare !== "week" && input.compare !== "none"
        ? input.compare === "year"
          ? ("yoy" as const)
          : ("prev" as const)
        : undefined;
    const [canonical, stats, places] = await Promise.all([
      readInsight("overview", params, range),
      filtered
        ? undefined
        : umami.read("stats", {
            range: range!,
            softMs: UMAMI_SOFT_BUDGET_MS,
            query: statsCompare === undefined ? {} : { compare: statsCompare },
          }),
      filtered
        ? undefined
        : umami.read("metrics", {
            range: range!,
            softMs: UMAMI_SOFT_BUDGET_MS,
            query: { type: "region", limit: UMAMI_METRIC_ROWS },
          }),
    ]);
    const { reply } = canonical;
    const minBase = input.minBase ?? ANALYTICS_DEFAULT_MIN_BASE;
    const notes: string[] = [...reply.notes];
    let quality: Json = { ...reply.quality };
    const statsBlock = (() => {
      if (stats === undefined) return undefined;
      if (stats.status === "failed") return failedBlock(stats);
      const { value } = stats;
      // A period the store no longer holds reads as zeros there. It is not zero.
      const before =
        statsCompare === undefined || reply.compare?.outOfRetention === true
          ? null
          : value.comparison;
      const lowBase = before !== null && before.visits < minBase;
      const bounce = (from: typeof value.comparison) =>
        percentOf(from.bounces, from.visits);
      const average = (from: typeof value.comparison) =>
        from.visits === 0
          ? null
          : Math.round((from.totaltime / from.visits) * 100) / 100;
      if (value.legacyPageviews !== undefined && value.pageviews > 0)
        quality = {
          ...quality,
          legacyShare: percentOf(value.legacyPageviews, value.pageviews),
        };
      // A length of no whole minutes: Umami takes its period cut short, so it moves.
      if (
        !range!.complete ||
        (range!.end.getTime() - range!.start.getTime()) % 60_000 !== 0
      )
        notes.push("NATIVE_COMPARE_NOT_ALIGNED");
      return {
        ...nestedBlockOf(stats, range!),
        metrics: {
          nativeVisits: nativeMetric(
            value.visits,
            before?.visits ?? null,
            lowBase,
          ),
          nativeBounceRate: nativeMetric(
            bounce(value),
            before === null ? null : bounce(before),
            lowBase,
          ),
          nativeAvgVisitSeconds: nativeMetric(
            average(value),
            before === null ? null : average(before),
            lowBase,
          ),
        },
      };
    })();
    const placesBlock = (() => {
      if (places === undefined) return undefined;
      if (places.status === "failed") return failedBlock(places);
      quality = { ...quality, approximateGeo: true };
      return {
        ...nestedBlockOf(places, range!),
        rows: places.value
          .filter((row) => row.x !== null && row.x !== "")
          .slice(0, TOP_PROVINCES)
          .map((row) => ({ key: row.x, visitors: row.y })),
      };
    })();
    const umamiAnswers = [stats, places].filter(
      (answer) => answer !== undefined,
    );
    const anyFailed = umamiAnswers.some((answer) => answer.status === "failed");
    const allFailed = umamiAnswers.every(
      (answer) => answer.status === "failed",
    );
    if (filtered) notes.push("UMAMI_NOT_READ_FOR_A_FILTER");
    const { rows, other } = reply.topContent;
    const built = canonicalBuilt(reply, canonical.cache, rows);
    return {
      ...built,
      data: {
        ...built.data,
        source: allFailed || filtered ? "canonical" : "both",
        quality,
        notes,
        ...(statsBlock === undefined ? {} : { native: statsBlock }),
        ...(placesBlock === undefined ? {} : { topProvinces: placesBlock }),
      },
      next:
        other.count === 0
          ? undefined
          : {
              tool: ANALYTICS_TOOL_NAME,
              args: {
                report: "breakdown",
                dimension: "content",
                ...(input.range === undefined ? {} : { range: input.range }),
                ...(input.from === undefined ? {} : { from: input.from }),
                ...(input.to === undefined ? {} : { to: input.to }),
                ...(input.tz === undefined ? {} : { tz: input.tz }),
                ...(input.filter === undefined ? {} : { filter: input.filter }),
                cursor: String(rows.length),
              },
            },
      sources: {
        canonical: "ok",
        ...(filtered ? {} : { umami: worstSource(umamiAnswers) }),
      },
      partial: anyFailed,
    };
  };

  const trendReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("trend", limit);
    const [canonical, annotations] = await Promise.all([
      readInsight("trend", params, range),
      umami.read("annotations", {
        range: range!,
        softMs: UMAMI_SOFT_BUDGET_MS,
        query: { pageSize: UMAMI_LIST_PAGE },
      }),
    ]);
    const built = canonicalBuilt(
      canonical.reply,
      canonical.cache,
      canonical.reply.buckets,
    );
    const read = annotations.status !== "failed";
    let used = 0;
    const rows = read
      ? annotations.value.data.filter((row) => {
          used += bytesOf(row);
          return used <= ANNOTATION_BYTES;
        })
      : [];
    return {
      ...built,
      data: {
        ...built.data,
        annotations: read
          ? {
              ...nestedBlockOf(annotations),
              total: annotations.value.count,
              rows: rows.map(({ date, allDay, note }) => ({
                date,
                allDay,
                note,
              })),
            }
          : failedBlock(annotations),
      },
      sources: { canonical: "ok", umami: sourceStatus(annotations) },
      partial: !read,
    };
  };

  const notCollectedBuilt = (
    reply: Json,
    cached: Json,
    range: AnalyticsResolvedRange,
  ) => ({
    data: {
      ...reply,
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        tz: range.tz,
        complete: range.complete,
      },
      quality: {},
      cache: cached,
    },
    page: [],
    sources: { canonical: "ok" as const },
  });

  const umamiBreakdown = async (
    dimension: UmamiDimension,
    limit: number | undefined,
  ): Promise<Built> => {
    onlyThese(input, [...RANGE_ARGS, "dimension", "limit", "cursor", "filter"]);
    const offset = offsetOf(input.cursor);
    const { range, facts } = await retainedRange();
    if (facts.outOfRetention) throw refused("from", "out_of_retention");
    const filter = umamiFilterOf(input);
    const [metrics, stats] = await Promise.all([
      umami.read("metrics", {
        range,
        query: {
          type:
            dimension === "province"
              ? "region"
              : dimension === "city"
                ? "city"
                : "device",
          limit: UMAMI_METRIC_ROWS,
          ...filter,
        },
      }),
      umami.read("stats", { range, query: filter }),
    ]);
    if (metrics.status === "failed")
      throw new AnalyticsReadFailure(umamiFailureEnvelope(metrics));
    const named = metrics.value.filter(
      (row): row is typeof row & { x: string } =>
        row.x !== null && row.x !== "",
    );
    const counted = named.reduce((sum, row) => sum + row.y, 0);
    const capped = metrics.value.length === UMAMI_METRIC_ROWS;
    // A total read at another moment divides rows it never saw: `unknown` would be
    // true of no moment. Two stale answers stand together, and say they are stale.
    const total =
      stats.status === "failed" || stats.status !== metrics.status
        ? null
        : stats.value.visitors;
    // Each row counts unique visitors, and one visitor can be in two places, so the
    // rows can pass the whole. Shares divide whichever is larger and say what it is.
    const whole = total === null ? counted : Math.max(counted, total);
    const shown = named.slice(offset, offset + (limit ?? DEFAULT_ROWS));
    const shownCount = shown.reduce((sum, row) => sum + row.y, 0);
    const known = total !== null && !capped && counted <= total;
    const unknownCount = known ? total - counted : null;
    const otherCount = (capped ? whole : counted) - shownCount;
    const shares = analyticsExactShares(
      [
        ...shown.map((row) => row.y),
        otherCount,
        ...(unknownCount === null ? [] : [unknownCount]),
      ],
      whole,
    );
    const shareAt = (index: number) => (whole === 0 ? null : shares[index]!);
    const more = offset + shown.length < named.length;
    const unknownShare =
      unknownCount === null ? null : shareAt(shown.length + 1);
    const legacy =
      total !== null &&
      stats.status !== "failed" &&
      stats.value.legacyPageviews !== undefined &&
      stats.value.pageviews > 0
        ? percentOf(stats.value.legacyPageviews, stats.value.pageviews)
        : undefined;
    const answers = [metrics, stats];
    return {
      data: {
        report: "breakdown",
        dimension,
        ...blockOf(metrics, range),
        range: facts.range,
        metric: "visitorsPageView",
        additive: false,
        shareBasis: total !== null && counted <= total ? "total" : "place_rows",
        total,
        rows: shown.map((row, index) => ({
          key: row.x,
          ...(row.displayName === undefined
            ? {}
            : { displayName: row.displayName }),
          ...(row.country === undefined || row.country === null
            ? {}
            : { country: row.country }),
          ...(row.region === undefined || row.region === null
            ? {}
            : { region: row.region }),
          visitors: row.y,
          share: shareAt(index),
        })),
        other: { count: otherCount, share: shareAt(shown.length) },
        unknown: { count: unknownCount, share: unknownShare },
        quality: {
          ...(dimension === "device" ? {} : { approximateGeo: true }),
          ...(unknownShare === null ? {} : { unknownShare }),
          ...(legacy === undefined ? {} : { legacyShare: legacy }),
          ...(more || capped ? { truncated: true } : {}),
        },
        notes: [
          ...facts.notes,
          ...(capped ? ["ROWS_CAPPED_AT_500"] : []),
          ...(total === null ? ["UMAMI_TOTAL_NOT_READ"] : []),
          ...(metrics.status === "stale" ? ["STALE_ANSWER"] : []),
        ],
      },
      cursor: more ? String(offset + shown.length) : undefined,
      page: shown,
      sources: { umami: worstSource(answers) },
      partial: total === null,
    };
  };

  const breakdownReport = async (limit: number | undefined): Promise<Built> => {
    const dimension = input.dimension;
    if (
      (ANALYTICS_UMAMI_DIMENSIONS as readonly (string | undefined)[]).includes(
        dimension,
      )
    )
      return umamiBreakdown(dimension as UmamiDimension, limit);
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("breakdown", limit);
    const { reply, cache: cached } = await readInsight(
      "breakdown",
      params,
      range,
    );
    if ("collected" in reply) return notCollectedBuilt(reply, cached, range!);
    return canonicalBuilt(reply, cached, reply.rows);
  };

  const compareReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("compare", limit);
    const { reply, cache: cached } = await readInsight(
      "compare",
      params,
      range,
    );
    if ("collected" in reply) return notCollectedBuilt(reply, cached, range!);
    return canonicalBuilt(reply, cached, reply.rows);
  };

  const funnelReport = async (): Promise<Built> => {
    if (input.funnelId === undefined) {
      noUmamiArgs(input);
      const { params, range } = canonicalQuery("funnel", undefined);
      const { reply, cache: cached } = await readInsight(
        "funnel",
        params,
        range,
      );
      return canonicalBuilt(reply, cached, []);
    }
    onlyThese(input, [...RANGE_ARGS, "funnelId", "filter"]);
    const { range, facts } = await retainedRange();
    if (facts.outOfRetention) throw refused("from", "out_of_retention");
    const answer = await umami.read("funnel", {
      range,
      query: {
        funnelId: input.funnelId,
        timezone: range.tz,
        ...umamiFilterOf(input),
      },
    });
    if (answer.status === "failed")
      throw new AnalyticsReadFailure(umamiFailureEnvelope(answer));
    return {
      data: {
        report: "funnel",
        ...blockOf(answer),
        range: facts.range,
        quality: {},
        // A saved native funnel never claims the same content, which it cannot know.
        basis: {
          unit: "visitor",
          order: "same_visit_order_only",
          sameTarget: false,
        },
        steps: answer.value,
        notes: [
          ...facts.notes,
          ...(answer.status === "stale" ? ["STALE_ANSWER"] : []),
        ],
      },
      page: [],
      sources: { umami: sourceStatus(answer) },
    };
  };

  const realtimeReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs({
      ...input,
      ...(input.include === "umami" ? { include: "ip" } : {}),
    });
    const { params } = canonicalQuery("realtime", limit);
    const windowEnd = Math.floor(now() / 60_000) * 60_000;
    const [canonical, places] = await Promise.all([
      readInsight("realtime", params, undefined),
      input.include === "umami"
        ? umami.read("metrics", {
            range: {
              start: new Date(
                windowEnd - ANALYTICS_REALTIME_WINDOW_SECONDS * 1000,
              ),
              end: new Date(windowEnd),
              complete: false,
            },
            realtime: true,
            softMs: UMAMI_SOFT_BUDGET_MS,
            query: { type: "region", limit: UMAMI_METRIC_ROWS },
          })
        : undefined,
    ]);
    const { reply } = canonical;
    const built = canonicalBuilt(reply, canonical.cache, reply.online);
    const end = Date.parse(reply.asOf);
    const answered = places !== undefined && places.status !== "failed";
    return {
      ...built,
      data: {
        ...built.data,
        // Who is here now goes by when the Backend heard it, in this rolling window.
        range: {
          start: new Date(
            end - ANALYTICS_REALTIME_WINDOW_SECONDS * 1000,
          ).toISOString(),
          end: reply.asOf,
          tz: ANALYTICS_DEFAULT_TZ,
          complete: false,
        },
        quality: answered ? { approximateGeo: true } : {},
        ...(places === undefined
          ? {}
          : {
              geography:
                places.status === "failed"
                  ? failedBlock(places)
                  : {
                      ...nestedBlockOf(places),
                      rows: places.value
                        .filter((row) => row.x !== null && row.x !== "")
                        .slice(0, 5)
                        .map((row) => ({ key: row.x, visitors: row.y })),
                    },
            }),
      },
      sources: {
        canonical: "ok",
        ...(places === undefined ? {} : { umami: sourceStatus(places) }),
      },
      partial: places?.status === "failed",
    };
  };

  /** Umami's rows have the geography and no link to canonical rows, so one answers. */
  const umamiSessions = async (limit: number | undefined): Promise<Built> => {
    onlyThese(input, [...RANGE_ARGS, "include", "limit", "cursor", "filter"]);
    const offset = offsetOf(input.cursor);
    const { range, facts } = await retainedRange(sessionDefaults());
    if (facts.outOfRetention) throw refused("from", "out_of_retention");
    const answer = await umami.read("sessions", {
      range,
      query: {
        page: Math.floor(offset / UMAMI_LIST_PAGE) + 1,
        pageSize: UMAMI_LIST_PAGE,
        ...umamiFilterOf(input),
      },
    });
    if (answer.status === "failed")
      throw new AnalyticsReadFailure(umamiFailureEnvelope(answer));
    const from = offset % UMAMI_LIST_PAGE;
    const rows = answer.value.data
      .slice(from, from + (limit ?? DEFAULT_ROWS))
      .map(({ id, ...row }) => ({ umamiSessionId: id, ...row }));
    const more = offset + rows.length < answer.value.count;
    return {
      data: {
        report: "sessions",
        ...blockOf(answer),
        range: facts.range,
        total: answer.value.count,
        rows,
        ...ipWithheld(input),
        quality: { approximateGeo: true, ...(more ? { truncated: true } : {}) },
        notes: [
          ...facts.notes,
          ...(answer.status === "stale" ? ["STALE_ANSWER"] : []),
        ],
      },
      cursor: more ? String(offset + rows.length) : undefined,
      page: rows,
      sources: { umami: sourceStatus(answer) },
    };
  };

  const sessionsReport = async (limit: number | undefined): Promise<Built> => {
    if (input.include === "umami" || hasUmamiFilter(input))
      return umamiSessions(limit);
    noUmamiArgs(input);
    const { params, range } = canonicalQuery(
      "sessions",
      limit,
      sessionDefaults(),
    );
    const { reply, cache: cached } = await readInsight(
      "sessions",
      params,
      range,
    );
    return canonicalBuilt(reply, cached, reply.rows);
  };

  const unitsOfRuns = (kept: readonly unknown[]) =>
    kept.reduce<number>(
      (sum, run) => sum + (run as { count: number }).count,
      0,
    );

  const sessionReport = async (limit: number | undefined): Promise<Built> => {
    if (input.umamiSessionId === undefined) {
      noUmamiArgs(input);
      const { params, range } = canonicalQuery(
        "session",
        limit,
        sessionDefaults(),
      );
      const { reply, cache: cached } = await readInsight(
        "session",
        params,
        range,
      );
      const built = canonicalBuilt(reply, cached, reply.runs);
      return {
        ...built,
        unitsOf: unitsOfRuns,
        data: {
          ...built.data,
          // Umami's session has no distinct id index, so only its own id can reach it.
          umami: { status: "not_read", reason: "NEEDS_UMAMI_SESSION_ID" },
        },
      };
    }
    onlyThese(input, [
      ...RANGE_ARGS,
      "umamiSessionId",
      "include",
      "limit",
      "cursor",
    ]);
    const answer = await umami.read("session", {
      query: { sessionId: input.umamiSessionId },
    });
    if (answer.status === "failed")
      throw new AnalyticsReadFailure(umamiFailureEnvelope(answer));
    const { id, distinctIds, distinctId, ...fields } = answer.value;
    const known = [
      ...new Set([
        ...(distinctIds ?? []),
        ...(typeof distinctId === "string" ? [distinctId] : []),
      ]),
    ];
    const primary = known.find((value) => /^[0-9a-f]{40}$/u.test(value));
    const umamiBlock = {
      ...nestedBlockOf(answer),
      umamiSessionId: id,
      distinctIds: known,
      ...fields,
      approximateGeo: true,
    };
    if (primary === undefined) {
      const { facts } = await retainedRange(sessionDefaults());
      return {
        data: {
          report: "session",
          source: "umami",
          asOf: answer.asOf,
          range: facts.range,
          quality: { approximateGeo: true },
          umami: umamiBlock,
          ...ipWithheld(input),
          notes: ["NO_DISTINCT_ID_SO_NO_TIMELINE"],
        },
        page: [],
        sources: { umami: sourceStatus(answer), canonical: "not_available" },
        partial: true,
      };
    }
    const canonicalArgs = { distinctId: primary, ...sessionDefaults() };
    const { params, range } = canonicalQuery("session", limit, canonicalArgs);
    const { reply, cache: cached } = await readInsight(
      "session",
      params,
      range,
    );
    const built = canonicalBuilt(reply, cached, reply.runs);
    return {
      ...built,
      unitsOf: unitsOfRuns,
      data: {
        ...built.data,
        source: "both",
        quality: { ...reply.quality, approximateGeo: true },
        notes: [
          ...reply.notes,
          ...(known.length > 1 ? ["OTHER_DISTINCT_IDS_NOT_READ"] : []),
        ],
        umami: umamiBlock,
      },
      sources: { canonical: "ok", umami: sourceStatus(answer) },
    };
  };

  const productReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("product", limit);
    const { reply, cache: cached } = await readInsight(
      "product",
      params,
      range,
    );
    // Up to 77 rows, and none of them pages: as columns they always fit one answer.
    const surfaces: Record<
      string,
      Record<string, readonly (number | null)[]>
    > = {};
    for (const row of reply.byPosition)
      (surfaces[row.surface] ??= {})[String(row.position)] = [
        row.impressions,
        row.opens,
        row.openRate,
      ];
    const built = canonicalBuilt(reply, cached, reply.topContent.rows);
    return {
      ...built,
      data: {
        ...built.data,
        byPosition: { columns: ["impressions", "opens", "openRate"], surfaces },
      },
    };
  };

  const nativeReport = async (limit: number | undefined): Promise<Built> => {
    const { kind } = input;
    if (kind === undefined) throw refused("kind", "required");
    const offset = offsetOf(input.cursor);
    const { range, facts } = await retainedRange();
    const frame = {
      report: "native",
      kind,
      range: facts.range,
      retention: facts.retention,
      quality: {},
    };
    if (facts.outOfRetention)
      return {
        data: {
          ...frame,
          source: "canonical",
          asOf: facts.asOf,
          outOfRetention: true,
          notes: facts.notes,
        },
        page: [],
        sources: { canonical: "ok" },
      };
    const answered = <Route extends UmamiReadRoute>(
      answer: UmamiAnswer<Route>,
    ) => {
      if (answer.status === "failed")
        throw new AnalyticsReadFailure(umamiFailureEnvelope(answer));
      return answer;
    };
    const whole = (
      answer: Exclude<UmamiAnswer<UmamiReadRoute>, UmamiFailureAnswer>,
      fields: Json,
      extraNotes: readonly string[] = [],
    ): Built => ({
      data: {
        ...frame,
        ...blockOf(answer),
        outOfRetention: false,
        ...fields,
        notes: [
          ...facts.notes,
          ...extraNotes,
          ...(answer.status === "stale" ? ["STALE_ANSWER"] : []),
        ],
      },
      page: [],
      sources: { umami: sourceStatus(answer) },
    });
    /**
     * `count` is what Umami holds and `rows` what it gave. `next` goes by the rows in
     * hand: this route has one page to read, so a cursor past it would offer itself.
     */
    const paged = (
      answer: Exclude<UmamiAnswer<UmamiReadRoute>, UmamiFailureAnswer>,
      rows: readonly unknown[],
      count: number = rows.length,
    ): Built => {
      const shown = rows.slice(offset, offset + (limit ?? DEFAULT_NATIVE_ROWS));
      const more = offset + shown.length < rows.length;
      const capped = count > rows.length;
      const built = whole(
        answer,
        { total: count, rows: shown },
        capped ? ["ROWS_CAPPED_AT_500"] : [],
      );
      return {
        ...built,
        data: {
          ...built.data,
          quality: more || capped ? { truncated: true } : {},
        },
        cursor: more ? String(offset + shown.length) : undefined,
        page: shown,
      };
    };
    const timezone = { timezone: range.tz };
    const filter = umamiFilterOf(input);
    switch (kind) {
      case "retention": {
        onlyThese(input, [...RANGE_ARGS, "kind", "limit", "cursor", "filter"]);
        const answer = answered(
          await umami.read("retention", {
            range,
            query: { ...timezone, ...filter },
          }),
        );
        return paged(answer, answer.value);
      }
      case "journey": {
        onlyThese(input, [
          ...RANGE_ARGS,
          "kind",
          "step",
          "limit",
          "cursor",
          "filter",
        ]);
        const answer = answered(
          await umami.read("journey", {
            range,
            query: {
              steps: 5,
              ...(input.step === undefined ? {} : { startStep: input.step }),
              ...timezone,
              ...filter,
            },
          }),
        );
        return paged(answer, answer.value);
      }
      case "weekly": {
        onlyThese(input, [...RANGE_ARGS, "kind", "filter"]);
        const answer = answered(
          await umami.read("weekly", {
            range,
            query: { ...timezone, ...filter },
          }),
        );
        return whole(answer, { weekly: answer.value });
      }
      case "goal": {
        if (input.goalId === undefined) {
          onlyThese(input, [...RANGE_ARGS, "kind", "limit", "cursor"]);
          const answer = answered(
            await umami.read("goals", {
              query: { pageSize: UMAMI_METRIC_ROWS },
            }),
          );
          return paged(answer, answer.value.data, answer.value.count);
        }
        onlyThese(input, [...RANGE_ARGS, "kind", "goalId", "filter"]);
        const answer = answered(
          await umami.read("goal", {
            range,
            query: { goalId: input.goalId, ...timezone, ...filter },
          }),
        );
        return whole(answer, {
          goal: {
            ...answer.value,
            rate: percentOf(answer.value.num, answer.value.total),
          },
        });
      }
      case "funnel": {
        onlyThese(input, [...RANGE_ARGS, "kind", "limit", "cursor"]);
        const answer = answered(
          await umami.read("funnels", {
            query: { pageSize: UMAMI_METRIC_ROWS },
          }),
        );
        return paged(answer, answer.value.data, answer.value.count);
      }
      case "segment":
      case "cohort": {
        onlyThese(input, [...RANGE_ARGS, "kind", "limit", "cursor"]);
        const answer = answered(
          await umami.read("segments", {
            query: { type: kind, pageSize: UMAMI_METRIC_ROWS },
          }),
        );
        return paged(answer, answer.value.data, answer.value.count);
      }
      case "attribution": {
        onlyThese(input, [...RANGE_ARGS, "kind", "step", "filter"]);
        if (input.step === undefined) throw refused("step", "required");
        const answer = answered(
          await umami.read("attribution", {
            range,
            query: {
              model: "first-click",
              type: input.step.startsWith("/") ? "path" : "event",
              step: input.step,
              ...timezone,
              ...filter,
            },
          }),
        );
        // Umami's lists here would read as no source at all, and none was collected.
        return whole(answer, {
          total: answer.value.total,
          referrer: {
            collected: false,
            reason: ANALYTICS_NOT_COLLECTED.referrer,
          },
          utm: { collected: false, reason: ANALYTICS_NOT_COLLECTED.utm },
          channel: {
            collected: false,
            reason: ANALYTICS_NOT_COLLECTED.channel,
          },
        });
      }
    }
  };

  const reconcileReport = async (limit: number | undefined): Promise<Built> => {
    noUmamiArgs(input);
    const { params, range } = canonicalQuery("reconcile", limit);
    const [canonical, umamiDays] = await Promise.all([
      readInsight("reconcile", params, range),
      umami.read("pageviews", {
        range: range!,
        query: { unit: "day", timezone: range!.tz },
      }),
    ]);
    const { reply } = canonical;
    const read = umamiDays.status !== "failed";
    const perDay = (series: readonly { x: string; y: number }[]) =>
      new Map(series.map(({ x, y }) => [x.slice(0, 10), y]));
    const views = read ? perDay(umamiDays.value.pageviews) : undefined;
    const visitors = read ? perDay(umamiDays.value.sessions) : undefined;
    const used = new Set<AnalyticsReconcileExplanation>();
    const days = reply.days.map((day) => {
      if (views === undefined || visitors === undefined)
        return { ...day, umami: null };
      const dayEnd = resolveAnalyticsRange(
        { from: day.day, to: day.day, tz: range!.tz },
        nowDate(),
      ).requestedEnd.getTime();
      const pageViews = views.get(day.day) ?? 0;
      const seen = visitors.get(day.day) ?? 0;
      const diff = {
        pageViews: day.pageViews - pageViews,
        visitors: day.visitorsPageView - seen,
      };
      const explained: AnalyticsReconcileExplanation[] = [];
      if (day.partial) explained.push("DAY_NOT_FINISHED");
      else if (now() - dayEnd < ANALYTICS_SETTLED_AFTER_MS)
        explained.push("LATE_EVENTS_POSSIBLE");
      if (day.pageViewsQueued > 0) explained.push("NOT_YET_FORWARDED");
      if (day.pageViewsNeverForwarded > 0) explained.push("NEVER_FORWARDED");
      if (diff.pageViews < 0) explained.push("UMAMI_HIGHER");
      if (
        diff.pageViews > day.pageViewsQueued + day.pageViewsNeverForwarded &&
        !day.partial
      )
        explained.push("CANONICAL_HIGHER");
      if (diff.visitors !== 0) explained.push("VISITOR_KEYS_DIFFER");
      for (const code of explained) used.add(code);
      return { ...day, umami: { pageViews, visitors: seen }, diff, explained };
    });
    const built = canonicalBuilt(reply, canonical.cache, reply.days);
    return {
      ...built,
      data: {
        ...built.data,
        source: read ? "both" : "canonical",
        days,
        ...(read
          ? {
              umami: nestedBlockOf(umamiDays),
              explanations: Object.fromEntries(
                [...used].map((code) => [
                  code,
                  ANALYTICS_RECONCILE_EXPLANATIONS[code],
                ]),
              ),
            }
          : { umami: failedBlock(umamiDays) }),
      },
      sources: { canonical: "ok", umami: sourceStatus(umamiDays) },
      partial: !read,
    };
  };

  return {
    status: statusReport,
    overview: overviewReport,
    trend: trendReport,
    breakdown: breakdownReport,
    compare: compareReport,
    funnel: funnelReport,
    realtime: realtimeReport,
    sessions: sessionsReport,
    session: sessionReport,
    product: productReport,
    native: nativeReport,
    reconcile: reconcileReport,
  };
};

const defaults: AnalyticsServiceDeps = {
  guard: umamiGuard,
  cache: analyticsCache,
  now: Date.now,
  canonical: {
    slots: createPoolSlots(CANONICAL_POOL_SHARE),
    callMs: CANONICAL_CALL_BUDGET_MS,
    holdMs: CANONICAL_OVERRUN_HOLD_MS,
  },
};

/** `admin_analytics`, one answer. A bad input is a named refusal and never an error. */
export const analyticsEnvelope = async (
  rawInput: unknown,
  deps: AnalyticsServiceDeps = defaults,
): Promise<AdminMcpEnvelope> => {
  const input = rawInput as AdminAnalyticsInput;
  if (input.report === "traffic") return failedEnvelope("NOT_AVAILABLE");
  const { report } = input;
  try {
    return await fitted(input, serviceFor(input, deps)[report]);
  } catch (error) {
    if (error instanceof AnalyticsReadFailure) return error.envelope;
    if (error instanceof AnalyticsInsightRefusal)
      return error.code === "SELF_ONLY_OWNER_REVIEW"
        ? failedEnvelope("SELF_ONLY_OWNER_REVIEW")
        : inputInvalidEnvelope(error.issues as readonly AdminMcpIssue[]);
    throw error;
  }
};
