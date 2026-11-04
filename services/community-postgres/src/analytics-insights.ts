import {
  ANALYTICS_DEFAULT_MIN_BASE,
  ANALYTICS_MAX_HOURLY_RANGE_DAYS,
  ANALYTICS_MAX_SESSION_RANGE_DAYS,
  ANALYTICS_REALTIME_WINDOW_SECONDS,
  ANALYTICS_INSIGHT_STATEMENT_TIMEOUT_MS,
  ANALYTICS_NOT_COLLECTED,
  AnalyticsInsightRefusal,
  AnalyticsInsightTimeout,
  analyticsExactShares,
  resolveAnalyticsCompare,
  resolveAnalyticsRange,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AnalyticsCanonicalDimension,
  AnalyticsInsightCountBlock,
  AnalyticsInsightMetric,
  AnalyticsInsightQuery,
  AnalyticsInsightReport,
  AnalyticsInsightResults,
  AnalyticsInsightsReader,
  AnalyticsInsightTarget,
  AnalyticsNotCollected,
  AnalyticsResolvedCompare,
  AnalyticsResolvedRange,
} from "@moya/contracts/internal/admin-mcp";
import type { Pool, PoolClient } from "pg";

import { asCommunityOperationError } from "./availability.js";

const QUERY_CANCELED = "57014";
const INVALID_PARAMETER_VALUE = "22023";
const UNREADABLE_RELATION = new Set(["3F000", "42P01", "42501"]);
const DEFAULT_ROWS = 10;
const DEFAULT_BUCKETS = 100;
const DEFAULT_TIMELINE_EVENTS = 100;
const RECONCILE_MAX_DAYS = 92;
const DAY_MS = 86_400_000;

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

const refuse = (path: string, code: string) =>
  new AnalyticsInsightRefusal(400, "INPUT_INVALID", [{ path: [path], code }]);

/** Binds a value and names it by position, so no input ever reaches the SQL text. */
class Statement {
  readonly values: unknown[] = [];
  bind(value: unknown, cast: string): string {
    this.values.push(value);
    return `$${this.values.length}::${cast}`;
  }
}

interface Period {
  readonly start: Date;
  readonly end: Date;
}

interface ScanFilter {
  readonly surface?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  /** Event names to keep; absent keeps every event. */
  readonly events?: readonly string[] | undefined;
}

/**
 * The scan is bounded by `received_at` on analytics_events_received, because the
 * Backend refuses an event more than 24 hours from its clock; `occurred_at` decides
 * the period, so a period lines up with Umami's timestamp.
 */
const periodWhere = (
  st: Statement,
  current: Period,
  previous: Period | null,
  filter: ScanFilter = {},
) => {
  const occurred = ({ start, end }: Period) =>
    `(e.occurred_at >= ${st.bind(start, "timestamptz")} AND e.occurred_at < ${st.bind(end, "timestamptz")})`;
  const received = ({ start, end }: Period) =>
    `(e.received_at >= ${st.bind(start, "timestamptz")} - INTERVAL '24 hours' AND e.received_at < ${st.bind(end, "timestamptz")} + INTERVAL '24 hours')`;
  const cur = occurred(current);
  const prev = previous === null ? "FALSE" : occurred(previous);
  const conditions = [
    previous === null
      ? received(current)
      : `(${received(current)} OR ${received(previous)})`,
    `(${cur} OR ${prev})`,
  ];
  if (filter.surface !== undefined)
    conditions.push(`e.surface = ${st.bind(filter.surface, "text")}`);
  if (filter.targetType !== undefined)
    conditions.push(`e.target_type = ${st.bind(filter.targetType, "text")}`);
  if (filter.targetId !== undefined)
    conditions.push(`e.target_id = ${st.bind(filter.targetId, "text")}`);
  if (filter.events !== undefined)
    conditions.push(`e.event_name = ANY(${st.bind(filter.events, "text[]")})`);
  return { cur, prev, where: conditions.join(" AND ") };
};

const scanSql = (
  st: Statement,
  current: Period,
  previous: Period | null,
  filter: ScanFilter = {},
  extraColumns = "",
): string => {
  const { cur, prev, where } = periodWhere(st, current, previous, filter);
  return `SELECT e.visitor_id, e.session_id, e.user_id, e.event_name, e.surface, e.target_type, e.target_id, e.occurred_at, e.forwarded_at, ${extraColumns}
      ${cur} AS cur, ${prev} AS prev
    FROM community.analytics_events e WHERE ${where}`;
};

/** Exactly section 6's definition. A permanently deleted work is not self-only. */
const selfOnly = (type: string, id: string): string =>
  `(${type} = 'work' AND EXISTS (SELECT 1 FROM community.works w WHERE w.id = ${id} AND w.visibility = 'self' AND w.deleted_at IS NULL))`;

const DIMENSION_KEYS: Readonly<
  Record<AnalyticsCanonicalDimension, readonly string[]>
> = {
  content: ["target_type", "target_id"],
  surface: ["surface"],
  event: ["event_name"],
};

interface RankSpec {
  readonly dimension: AnalyticsCanonicalDimension;
  readonly aggregates: Readonly<Record<string, string>>;
  /** Columns that add up. A unique count is not one. */
  readonly additive: readonly string[];
  readonly order: string;
  readonly where?: string;
  readonly limit: number;
  readonly offset: number;
}

type GroupRow = Readonly<Record<string, unknown>>;
type ClassTotals = Readonly<Record<string, Readonly<Record<string, number>>>>;

interface Ranked {
  readonly rows: readonly GroupRow[];
  readonly hasMore: boolean;
  /** Per class (`row`, `unknown`, `withheld`), summed over every group, in or out of the page. */
  readonly totals: ClassTotals;
  readonly totalVisitors: number;
}

/**
 * Ranks groups in one statement, and collapses self-only works into one class before
 * ranking, so such a row takes no page slot and its count still reaches the total.
 */
const rankGroups = async (
  db: PoolClient,
  st: Statement,
  scan: string,
  spec: RankSpec,
): Promise<Ranked> => {
  const keys = DIMENSION_KEYS[spec.dimension];
  const klass =
    spec.dimension === "content"
      ? `CASE WHEN g.target_id IS NULL THEN 'unknown' WHEN ${selfOnly("g.target_type", "g.target_id")} THEN 'withheld' ELSE 'row' END`
      : `'row'`;
  const aggregates = Object.entries(spec.aggregates)
    .map(([name, sql]) => `${sql} AS ${name}`)
    .join(", ");
  const sums = spec.additive
    .map((name) => `'${name}', coalesce(sum(${name}), 0)`)
    .join(", ");
  const limit = st.bind(spec.limit + 1, "integer");
  const offset = st.bind(spec.offset, "integer");
  const result = await db.query<{
    totals: ClassTotals;
    page: GroupRow[];
    total_visitors: string;
  }>(
    `WITH scan AS MATERIALIZED (${scan}),
      grouped AS (SELECT ${keys.join(", ")}, ${aggregates} FROM scan GROUP BY ${keys.join(", ")}),
      classified AS (SELECT g.*, ${klass} AS class FROM grouped g)
    SELECT
      (SELECT count(DISTINCT visitor_id) FILTER (WHERE cur) FROM scan) AS total_visitors,
      (SELECT coalesce(json_object_agg(class, totals), '{}'::json)
        FROM (SELECT class, json_build_object(${sums}) AS totals FROM classified GROUP BY class) t) AS totals,
      (SELECT coalesce(json_agg(r ORDER BY r.ord), '[]'::json)
        FROM (SELECT c.*, row_number() OVER (ORDER BY ${spec.order}) AS ord
          FROM classified c WHERE c.class = 'row'${spec.where === undefined ? "" : ` AND ${spec.where}`}
          ORDER BY ${spec.order} LIMIT ${limit} OFFSET ${offset}) r) AS page`,
    st.values,
  );
  const { totals, page, total_visitors: totalVisitors } = result.rows[0]!;
  return {
    rows: page.slice(0, spec.limit),
    hasMore: page.length > spec.limit,
    totals,
    totalVisitors: Number(totalVisitors),
  };
};

const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 10_000) / 100;

const metric = (
  v: number,
  prev: number | null,
  additive: boolean,
  minBase: number,
): AnalyticsInsightMetric => ({
  v,
  prev,
  delta: prev === null ? null : v - prev,
  pct: prev === null ? null : rate(v - prev, prev),
  additive,
  ...(prev !== null && prev < minBase ? { lowBase: true as const } : {}),
});

const offsetCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  if (!/^[0-9]{1,7}$/u.test(cursor)) throw refuse("cursor", "invalid_cursor");
  return Number(cursor);
};

const nextOffset = (offset: number, kept: number, hasMore: boolean) =>
  hasMore ? { next: { cursor: String(offset + kept) } } : {};

const encodeKeyset = (at: string, id: string): string =>
  Buffer.from(`${at}|${id}`, "utf8").toString("base64url");

const decodeKeyset = (
  cursor: string,
): { readonly at: string; readonly id: string } => {
  const [at, id, extra] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (
    extra !== undefined ||
    at === undefined ||
    id === undefined ||
    !/^(?:20\d{2}|2100)-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(at) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      id,
    ) ||
    Number.isNaN(Date.parse(at)) ||
    new Date(at).toISOString().slice(0, 19) !== at.slice(0, 19)
  )
    throw refuse("cursor", "invalid_cursor");
  return { at, id };
};

const groupKey = (type: string, id: string): string => `${type}:${id}`;

const eventBasis = (
  query: AnalyticsInsightQuery,
  fallback: "page_view" | "any",
) => query.event ?? fallback;

const eventFilter = (event: string): readonly string[] | undefined =>
  event === "any" ? undefined : [event];

/** A client records each open and dwell on detail, so another surface's 0 is no measure. */
const offDetailNote = (
  surface: string | undefined,
  events: readonly string[] | undefined,
): string[] =>
  surface !== undefined &&
  surface !== "detail" &&
  (events === undefined ||
    events.includes("content_open") ||
    events.includes("content_dwell"))
    ? ["OPENS_AND_DWELL_RECORDED_ON_DETAIL"]
    : [];

const accountOf = (
  accounts: ReadonlyMap<string, AccountRow>,
  id: string | null,
) => {
  const row = id === null ? undefined : accounts.get(id);
  return row === undefined
    ? null
    : {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        status: row.status,
      };
};

interface AccountRow {
  readonly id: string;
  readonly handle: string;
  readonly display_name: string;
  readonly status: string;
}

interface Facts {
  readonly dataFrom: Date | null;
  readonly outboxPending: number;
  readonly outboxFailed: number;
}

const workState = (row: {
  deleted_at: Date | null;
  trashed_at: Date | null;
  operator_state: string;
  public_revision_id: string | null;
}): string =>
  row.deleted_at !== null
    ? "deleted"
    : row.trashed_at !== null
      ? "trashed"
      : row.operator_state !== "visible"
        ? row.operator_state
        : row.public_revision_id === null
          ? "not_public"
          : "public";

export interface PostgresAnalyticsInsightsOptions {
  readonly retentionDays: number;
  readonly now?: () => Date;
}

/**
 * Canonical analytics reads for the AI operator. Each answer is one READ ONLY
 * snapshot under a statement timeout, on the existing App-role pool. Self-only works
 * are withheld on every path here and no path reads analytics_ip_observations.
 */
export class PostgresAnalyticsInsights implements AnalyticsInsightsReader {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresAnalyticsInsightsOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async snapshot<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect().catch((error: unknown) => {
      throw asCommunityOperationError(error, "connect");
    });
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query(
        `SET LOCAL statement_timeout = '${ANALYTICS_INSIGHT_STATEMENT_TIMEOUT_MS}ms'`,
      );
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      if (error instanceof AnalyticsInsightRefusal) throw error;
      if (errorCode(error) === QUERY_CANCELED)
        throw new AnalyticsInsightTimeout();
      if (errorCode(error) === INVALID_PARAMETER_VALUE)
        throw refuse("tz", "unknown_time_zone");
      throw asCommunityOperationError(error, "query");
    } finally {
      db.release();
    }
  }

  private async facts(db: PoolClient): Promise<Facts> {
    const row = (
      await db.query<{
        data_from: Date | null;
        pending: string;
        failed: string;
      }>(
        `SELECT (SELECT min(received_at) FROM community.analytics_events) AS data_from,
          (SELECT count(*) FROM community.analytics_outbox WHERE failed_at IS NULL) AS pending,
          (SELECT count(*) FROM community.analytics_outbox WHERE failed_at IS NOT NULL) AS failed`,
      )
    ).rows[0]!;
    return {
      dataFrom: row.data_from,
      outboxPending: Number(row.pending),
      outboxFailed: Number(row.failed),
    };
  }

  private retentionFrom(now: Date): Date {
    return new Date(now.getTime() - this.options.retentionDays * DAY_MS);
  }

  /** Counts for a period the store no longer holds would read as a false zero. */
  private withinRetention(range: AnalyticsResolvedRange, now: Date): void {
    if (range.start < this.retentionFrom(now))
      throw refuse("from", "out_of_retention");
  }

  private compareFor(
    range: AnalyticsResolvedRange,
    mode: "previous" | "week" | "year" | "none",
    facts: Facts,
    now: Date,
  ): {
    readonly period: AnalyticsResolvedCompare;
    readonly outOfRetention: boolean;
  } | null {
    if (mode === "none") return null;
    const period = resolveAnalyticsCompare(range, mode);
    return {
      period,
      outOfRetention:
        period.start < this.retentionFrom(now) ||
        facts.dataFrom === null ||
        period.start < facts.dataFrom,
    };
  }

  private async refuseSelfOnlyTarget(
    db: PoolClient,
    query: AnalyticsInsightQuery,
  ): Promise<void> {
    if (query.targetType !== "work" || query.targetId === undefined) return;
    const found = await db.query(
      "SELECT 1 FROM community.works WHERE id = $1 AND visibility = 'self' AND deleted_at IS NULL",
      [query.targetId],
    );
    if (found.rows.length > 0)
      throw new AnalyticsInsightRefusal(403, "SELF_ONLY_OWNER_REVIEW");
  }

  /** The non-count fields every period answer repeats. */
  private frame(
    range: AnalyticsResolvedRange,
    facts: Facts,
    now: Date,
    notes: readonly string[],
    truncated: boolean,
  ) {
    return {
      source: "canonical" as const,
      asOf: now.toISOString(),
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        ...(range.requestedEnd > range.end
          ? { requestedEnd: range.requestedEnd.toISOString() }
          : {}),
        tz: range.tz,
        complete: range.complete,
        dataFrom: facts.dataFrom?.toISOString() ?? null,
      },
      quality: {
        outboxPending: facts.outboxPending,
        ...(truncated ? { truncated: true as const } : {}),
      },
      notes: [
        ...(facts.dataFrom === null
          ? ["NO_DATA_YET"]
          : range.start < facts.dataFrom
            ? ["RANGE_STARTS_BEFORE_DATA"]
            : []),
        ...notes,
      ],
    };
  }

  /**
   * Public titles only: a work's denormalized public revision, an Article's published
   * revision, a published Catalog. A second net below the ranking refuses a self-only
   * work by name, so a title cannot arrive here through any row.
   */
  private async describeTargets(
    db: PoolClient,
    refs: readonly { readonly type: string; readonly id: string }[],
    notes: Set<string>,
  ): Promise<ReadonlyMap<string, AnalyticsInsightTarget>> {
    const described = new Map<string, AnalyticsInsightTarget>();
    const ids = (type: string) => [
      ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
    ];
    const works = ids("work");
    if (works.length > 0) {
      const rows = await db.query<{
        id: string;
        title: string;
        handle: string | null;
        deleted_at: Date | null;
        trashed_at: Date | null;
        operator_state: string;
        public_revision_id: string | null;
      }>(
        `SELECT w.id, w.title, u.handle, w.deleted_at, w.trashed_at, w.operator_state, w.public_revision_id
        FROM community.works w LEFT JOIN community.public_users u ON u.id = w.author_id
        WHERE w.id = ANY($1::text[]) AND NOT (w.visibility = 'self' AND w.deleted_at IS NULL)`,
        [works],
      );
      for (const row of rows.rows)
        described.set(groupKey("work", row.id), {
          type: "work",
          id: row.id,
          title: row.title === "" ? null : row.title,
          authorHandle: row.handle,
          state: workState(row),
        });
    }
    const articles = ids("article");
    if (articles.length > 0) {
      const rows = await db.query<{
        id: string;
        status: string;
        title: string | null;
        handle: string | null;
      }>(
        `SELECT a.id, CASE WHEN a.reporting_hidden THEN 'hidden' ELSE a.status END AS status, r.title, u.handle
        FROM community.article_documents a
        LEFT JOIN community.article_revisions r ON r.article_id = a.id AND r.version = a.published_version AND NOT a.reporting_hidden
        LEFT JOIN community.public_users u ON u.id = a.owner_id
        WHERE a.id = ANY($1::text[])`,
        [articles],
      );
      for (const row of rows.rows)
        described.set(groupKey("article", row.id), {
          type: "article",
          id: row.id,
          title: row.title,
          authorHandle: row.handle,
          state: row.status,
        });
    }
    const profiles = ids("profile");
    if (profiles.length > 0) {
      const rows = await db.query<AccountRow>(
        "SELECT id, handle, display_name, status FROM community.public_users WHERE id = ANY($1::text[])",
        [profiles],
      );
      for (const row of rows.rows)
        described.set(groupKey("profile", row.id), {
          type: "profile",
          id: row.id,
          title: row.display_name,
          authorHandle: row.handle,
          state: row.status,
        });
    }
    const catalogs = ids("catalog");
    let catalogRead = catalogs.length > 0;
    if (catalogRead) {
      await db.query("SAVEPOINT catalog_titles");
      try {
        const rows = await db.query<{
          catalog_id: string;
          title: string | null;
        }>(
          "SELECT catalog_id, title FROM catalog_discovery WHERE catalog_id = ANY($1::text[])",
          [catalogs],
        );
        for (const row of rows.rows)
          described.set(groupKey("catalog", row.catalog_id), {
            type: "catalog",
            id: row.catalog_id,
            title: row.title,
            authorHandle: null,
            state: "published",
          });
      } catch (error) {
        if (!UNREADABLE_RELATION.has(String(errorCode(error)))) throw error;
        await db.query("ROLLBACK TO SAVEPOINT catalog_titles");
        catalogRead = false;
        notes.add("CATALOG_TITLES_UNAVAILABLE");
      }
    }
    for (const ref of refs) {
      const key = groupKey(ref.type, ref.id);
      if (!described.has(key))
        described.set(key, {
          type: ref.type as AnalyticsInsightTarget["type"],
          id: ref.id,
          title: null,
          authorHandle: null,
          // Only a source that was read may say the id is absent from it.
          state:
            ref.type === "catalog"
              ? catalogRead
                ? "not_published"
                : "title_unavailable"
              : "unresolved",
        });
    }
    return described;
  }

  private async accounts(
    db: PoolClient,
    ids: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, AccountRow>> {
    const wanted = [...new Set(ids.filter((id) => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await db.query<AccountRow>(
      "SELECT id, handle, display_name, status FROM community.public_users WHERE id = ANY($1::text[])",
      [wanted],
    );
    return new Map(rows.rows.map((row) => [row.id, row]));
  }

  /** rows + other + unknown + withheld is the total, so shares add to 100 percent. */
  private async countBlock(
    db: PoolClient,
    st: Statement,
    scan: string,
    dimension: AnalyticsCanonicalDimension,
    limit: number,
    offset: number,
    notes: Set<string>,
  ): Promise<{
    readonly block: AnalyticsInsightCountBlock;
    readonly hasMore: boolean;
  }> {
    const keys = DIMENSION_KEYS[dimension].join(", ");
    const ranked = await rankGroups(db, st, scan, {
      dimension,
      aggregates: {
        hits: "count(*) FILTER (WHERE cur)",
        visitors: "count(DISTINCT visitor_id) FILTER (WHERE cur)",
      },
      additive: ["hits"],
      order: `hits DESC, ${keys}`,
      limit,
      offset,
    });
    const sum = (klass: string) => ranked.totals[klass]?.hits ?? 0;
    const unknown = sum("unknown");
    const withheld = sum("withheld");
    const total = sum("row") + unknown + withheld;
    const counts = ranked.rows.map((row) => Number(row.hits));
    const other = sum("row") - counts.reduce((all, v) => all + v, 0);
    const shares = analyticsExactShares(
      [...counts, other, unknown, withheld],
      total,
    );
    const nullable = (value: number) => (total === 0 ? null : value);
    const targets = await this.describeTargets(
      db,
      dimension === "content"
        ? ranked.rows.map((row) => ({
            type: String(row.target_type),
            id: String(row.target_id),
          }))
        : [],
      notes,
    );
    return {
      hasMore: ranked.hasMore,
      block: {
        total,
        totalVisitors: ranked.totalVisitors,
        rows: ranked.rows.map((row, index) => {
          return {
            ...(dimension === "content"
              ? {
                  target: targets.get(
                    groupKey(String(row.target_type), String(row.target_id)),
                  )!,
                }
              : { key: String(row[DIMENSION_KEYS[dimension][0]!]) }),
            count: counts[index]!,
            share: nullable(shares[index]!),
            visitors: Number(row.visitors),
          };
        }),
        other: { count: other, share: nullable(shares[counts.length]!) },
        unknown: {
          count: unknown,
          share: nullable(shares[counts.length + 1]!),
        },
        withheld:
          withheld === 0
            ? null
            : {
                reason: "self_only",
                count: withheld,
                share: nullable(shares[counts.length + 2]!),
              },
      },
    };
  }

  async read<Report extends Exclude<AnalyticsInsightReport, "status">>(
    report: Report,
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults[Report]> {
    const reports: {
      readonly [Key in Exclude<AnalyticsInsightReport, "status">]: (
        query: AnalyticsInsightQuery,
      ) => Promise<AnalyticsInsightResults[Key]>;
    } = {
      overview: (q) => this.overview(q),
      trend: (q) => this.trend(q),
      breakdown: (q) => this.breakdown(q),
      compare: (q) => this.compare(q),
      funnel: (q) => this.funnel(q),
      realtime: (q) => this.realtime(q),
      sessions: (q) => this.sessions(q),
      session: (q) => this.session(q),
      product: (q) => this.product(q),
      native: (q) => this.native(q),
      reconcile: (q) => this.reconcile(q),
    };
    return reports[report](query) as Promise<AnalyticsInsightResults[Report]>;
  }

  private async overview(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["overview"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    const minBase = query.minBase ?? ANALYTICS_DEFAULT_MIN_BASE;
    return this.snapshot(async (db) => {
      await this.refuseSelfOnlyTarget(db, query);
      const facts = await this.facts(db);
      const compare = this.compareFor(
        range,
        query.compare ?? "previous",
        facts,
        now,
      );
      const previous =
        compare === null || compare.outOfRetention ? null : compare.period;
      const st = new Statement();
      const filter = {
        surface: query.surface,
        targetType: query.targetType,
        targetId: query.targetId,
      };
      const columns = (period: "cur" | "prev") =>
        [
          `count(*) FILTER (WHERE ${period} AND event_name = 'page_view') AS ${period}_page_views`,
          `count(DISTINCT visitor_id) FILTER (WHERE ${period} AND event_name = 'page_view') AS ${period}_visitors_page_view`,
          `count(DISTINCT visitor_id) FILTER (WHERE ${period}) AS ${period}_visitors_any`,
          `count(DISTINCT user_id) FILTER (WHERE ${period}) AS ${period}_accounts`,
          `count(DISTINCT session_id) FILTER (WHERE ${period}) AS ${period}_sessions`,
        ].join(", ");
      // One query over both periods, not two in turn: they read the same instant of the store.
      const row = (
        await db.query<Record<string, string>>(
          `SELECT ${columns("cur")}, ${columns("prev")} FROM (${scanSql(st, range, previous, filter)}) s`,
          st.values,
        )
      ).rows[0]!;
      const named = (name: string, additive: boolean): AnalyticsInsightMetric =>
        metric(
          Number(row[`cur_${name}`]),
          previous === null ? null : Number(row[`prev_${name}`]),
          additive,
          minBase,
        );
      const notes = new Set<string>();
      const top = new Statement();
      const { block } = await this.countBlock(
        db,
        top,
        scanSql(top, range, null, {
          ...filter,
          events: ["page_view"],
        }),
        "content",
        query.limit ?? 5,
        0,
        notes,
      );
      const frame = this.frame(
        range,
        facts,
        now,
        [...this.compareNotes(compare), ...notes],
        false,
      );
      return {
        report: "overview",
        ...frame,
        quality: { ...frame.quality, unknownShare: block.unknown.share },
        compare: this.compareResult(compare),
        metrics: {
          pageViews: named("page_views", true),
          visitorsPageView: named("visitors_page_view", false),
          visitorsAny: named("visitors_any", false),
          accountVisitors: named("accounts", false),
          canonicalSessions: named("sessions", false),
        },
        event: "page_view",
        topContent: block,
        excluded: ["self_only"],
      };
    });
  }

  private compareNotes(
    compare: {
      readonly outOfRetention: boolean;
      readonly period: AnalyticsResolvedCompare;
    } | null,
  ): readonly string[] {
    if (compare === null) return [];
    return [
      ...(compare.outOfRetention ? ["COMPARE_OUT_OF_RETENTION"] : []),
      ...(compare.period.aligned ? ["PARTIAL_PERIOD_ALIGNED"] : []),
    ];
  }

  private compareResult(
    compare: {
      readonly outOfRetention: boolean;
      readonly period: AnalyticsResolvedCompare;
    } | null,
  ) {
    return compare === null
      ? null
      : {
          start: compare.period.start.toISOString(),
          end: compare.period.end.toISOString(),
          mode: compare.period.mode,
          ...(compare.period.aligned ? { aligned: true as const } : {}),
          ...(compare.outOfRetention ? { outOfRetention: true as const } : {}),
        };
  }

  private async buckets(
    db: PoolClient,
    range: AnalyticsResolvedRange,
    groupBy: "hour" | "day" | "week" | "month",
    filter: ScanFilter,
  ) {
    const st = new Statement();
    const scan = scanSql(st, range, null, filter);
    const unit = st.bind(groupBy, "text");
    const tz = st.bind(range.tz, "text");
    const label =
      groupBy === "hour"
        ? `'YYYY-MM-DD"T"HH24:MI'`
        : groupBy === "month"
          ? `'YYYY-MM'`
          : `'YYYY-MM-DD'`;
    const firstBucket = `date_trunc(${unit}, ${st.bind(range.start, "timestamptz")} AT TIME ZONE ${tz})`;
    const lastBucket = `date_trunc(${unit}, (${st.bind(range.end, "timestamptz")} - INTERVAL '1 microsecond') AT TIME ZONE ${tz})`;
    const step = `('1 ' || ${unit})::interval`;
    const measures = `count(*) FILTER (WHERE event_name = 'page_view') AS page_views,
      count(*) AS events,
      count(DISTINCT visitor_id) FILTER (WHERE event_name = 'page_view') AS visitors_page_view,
      count(DISTINCT visitor_id) AS visitors_any,
      count(DISTINCT user_id) AS accounts,
      count(DISTINCT session_id) AS sessions,
      count(*) FILTER (WHERE forwarded_at IS NOT NULL) AS forwarded,
      count(*) FILTER (WHERE forwarded_at IS NOT NULL AND event_name = 'page_view') AS forwarded_page_views`;
    // The empty grouping set reads each unique count over the whole range, so a
    // total is never a sum of buckets.
    const rows = await db.query<{
      bucket: string | null;
      start_at: Date | null;
      end_at: Date | null;
      label: string | null;
      page_views: string;
      events: string;
      visitors_page_view: string;
      visitors_any: string;
      accounts: string;
      sessions: string;
      forwarded: string;
      forwarded_page_views: string;
    }>(
      `WITH scan AS MATERIALIZED (${scan}),
        rolled AS (
          SELECT bucket, GROUPING(bucket) AS is_total, ${measures}
          FROM (SELECT s.*, date_trunc(${unit}, s.occurred_at AT TIME ZONE ${tz}) AS bucket FROM scan s) b
          GROUP BY GROUPING SETS ((bucket), ())
        ),
        series AS (SELECT generate_series(${firstBucket}, ${lastBucket}, ${step}) AS bucket)
      SELECT s.bucket::text AS bucket, s.bucket AT TIME ZONE ${tz} AS start_at, (s.bucket + ${step}) AT TIME ZONE ${tz} AS end_at,
        to_char(s.bucket, ${label}) AS label,
        coalesce(r.page_views, 0) AS page_views, coalesce(r.events, 0) AS events,
        coalesce(r.visitors_page_view, 0) AS visitors_page_view, coalesce(r.visitors_any, 0) AS visitors_any,
        coalesce(r.accounts, 0) AS accounts, coalesce(r.sessions, 0) AS sessions, coalesce(r.forwarded, 0) AS forwarded,
        coalesce(r.forwarded_page_views, 0) AS forwarded_page_views
      FROM series s LEFT JOIN rolled r ON r.is_total = 0 AND r.bucket = s.bucket
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, page_views, events, visitors_page_view, visitors_any, accounts, sessions, forwarded, forwarded_page_views
      FROM rolled WHERE is_total = 1
      ORDER BY 2 NULLS LAST`,
      st.values,
    );
    const measured = (row: (typeof rows.rows)[number]) => ({
      pageViews: Number(row.page_views),
      events: Number(row.events),
      visitorsPageView: Number(row.visitors_page_view),
      visitorsAny: Number(row.visitors_any),
    });
    const whole = rows.rows.filter((row) => row.bucket === null);
    return {
      series: rows.rows
        .filter((row) => row.bucket !== null)
        .map((row) => ({
          start: row.start_at!.toISOString(),
          label: row.label!,
          partial: row.start_at! < range.start || row.end_at! > range.end,
          ...measured(row),
          accountVisitors: Number(row.accounts),
          canonicalSessions: Number(row.sessions),
          forwarded: Number(row.forwarded),
          forwardedPageViews: Number(row.forwarded_page_views),
        })),
      totals: {
        ...measured(whole[0]!),
        accountVisitors: Number(whole[0]!.accounts),
        canonicalSessions: Number(whole[0]!.sessions),
      },
    };
  }

  private async trend(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["trend"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    const days =
      (range.requestedEnd.getTime() - range.start.getTime()) / DAY_MS;
    const groupBy =
      query.groupBy ?? (days <= 2 ? "hour" : days <= 92 ? "day" : "week");
    if (groupBy === "hour" && days > ANALYTICS_MAX_HOURLY_RANGE_DAYS)
      throw refuse("groupBy", "range_too_long_for_hourly");
    const offset = offsetCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_BUCKETS;
    return this.snapshot(async (db) => {
      await this.refuseSelfOnlyTarget(db, query);
      const facts = await this.facts(db);
      const { series, totals } = await this.buckets(db, range, groupBy, {
        surface: query.surface,
        targetType: query.targetType,
        targetId: query.targetId,
      });
      const page = series.slice(offset, offset + limit);
      const hasMore = offset + page.length < series.length;
      return {
        report: "trend",
        ...this.frame(range, facts, now, [], hasMore),
        excluded: [],
        groupBy,
        buckets: page.map((bucket) => ({
          start: bucket.start,
          label: bucket.label,
          partial: bucket.partial,
          pageViews: bucket.pageViews,
          events: bucket.events,
          visitorsPageView: bucket.visitorsPageView,
          visitorsAny: bucket.visitorsAny,
          accountVisitors: bucket.accountVisitors,
          canonicalSessions: bucket.canonicalSessions,
        })),
        totals,
        ...nextOffset(offset, page.length, hasMore),
      };
    });
  }

  private collectedFalse<Report extends "breakdown" | "compare">(
    report: Report,
    dimension: AnalyticsNotCollected,
    now: Date,
  ) {
    return {
      report,
      source: "capability" as const,
      asOf: now.toISOString(),
      dimension,
      collected: false as const,
      reason: ANALYTICS_NOT_COLLECTED[dimension],
    };
  }

  /** Which of the three answers a `dimension` argument gets. */
  private dimensionOf(
    query: AnalyticsInsightQuery,
  ):
    | { readonly canonical: AnalyticsCanonicalDimension }
    | { readonly notCollected: AnalyticsNotCollected } {
    const dimension = query.dimension ?? "content";
    if (
      dimension === "province" ||
      dimension === "city" ||
      dimension === "device"
    )
      throw refuse("dimension", "answered_by_umami");
    if (dimension in ANALYTICS_NOT_COLLECTED)
      return { notCollected: dimension as AnalyticsNotCollected };
    return { canonical: dimension as AnalyticsCanonicalDimension };
  }

  private async breakdown(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["breakdown"]> {
    const now = this.now();
    const dimension = this.dimensionOf(query);
    if ("notCollected" in dimension)
      return this.collectedFalse("breakdown", dimension.notCollected, now);
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    const event = eventBasis(
      query,
      dimension.canonical === "event" ? "any" : "page_view",
    );
    const offset = offsetCursor(query.cursor);
    return this.snapshot(async (db) => {
      await this.refuseSelfOnlyTarget(db, query);
      const facts = await this.facts(db);
      const notes = new Set<string>();
      const st = new Statement();
      const { block, hasMore } = await this.countBlock(
        db,
        st,
        scanSql(st, range, null, {
          surface: query.surface,
          targetType: query.targetType,
          targetId: query.targetId,
          events: eventFilter(event),
        }),
        dimension.canonical,
        query.limit ?? DEFAULT_ROWS,
        offset,
        notes,
      );
      const frame = this.frame(
        range,
        facts,
        now,
        [...offDetailNote(query.surface, eventFilter(event)), ...notes],
        hasMore,
      );
      return {
        report: "breakdown",
        ...frame,
        quality: {
          ...frame.quality,
          unknownShare: block.unknown.share,
        },
        excluded: dimension.canonical === "content" ? ["self_only"] : [],
        dimension: dimension.canonical,
        event,
        ...block,
        ...nextOffset(offset, block.rows.length, hasMore),
      };
    });
  }

  private async compare(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["compare"]> {
    const now = this.now();
    const dimension = this.dimensionOf(query);
    if ("notCollected" in dimension)
      return this.collectedFalse("compare", dimension.notCollected, now);
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    const event = eventBasis(
      query,
      dimension.canonical === "event" ? "any" : "page_view",
    );
    const direction = query.direction ?? "abs";
    const minBase = query.minBase ?? ANALYTICS_DEFAULT_MIN_BASE;
    const offset = offsetCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_ROWS;
    const mode = query.compare ?? "previous";
    if (mode === "none") throw refuse("compare", "compare_needs_a_period");
    return this.snapshot(async (db) => {
      await this.refuseSelfOnlyTarget(db, query);
      const facts = await this.facts(db);
      const compare = this.compareFor(range, mode, facts, now)!;
      const filter = {
        surface: query.surface,
        targetType: query.targetType,
        targetId: query.targetId,
        events: eventFilter(event),
      };
      const excluded: "self_only"[] =
        dimension.canonical === "content" ? ["self_only"] : [];
      const shared = {
        report: "compare" as const,
        compare: this.compareResult(compare)!,
        dimension: dimension.canonical,
        direction,
        event,
        minBase,
        excluded,
      };
      if (compare.outOfRetention) {
        const st = new Statement();
        const total = (
          await db.query<{ v: string }>(
            `SELECT count(*) AS v FROM (${scanSql(st, range, null, filter)}) s`,
            st.values,
          )
        ).rows[0]!;
        return {
          ...this.frame(
            range,
            facts,
            now,
            [
              ...offDetailNote(query.surface, filter.events),
              ...this.compareNotes(compare),
            ],
            false,
          ),
          ...shared,
          total: {
            v: Number(total.v),
            prev: null,
            delta: null,
            pct: null,
            lowBase: false,
          },
          rows: [],
          other: null,
          unknown: null,
          withheld: null,
        };
      }
      const st = new Statement();
      const keys = DIMENSION_KEYS[dimension.canonical].join(", ");
      const ranked = await rankGroups(
        db,
        st,
        scanSql(st, range, compare.period, filter),
        {
          dimension: dimension.canonical,
          aggregates: {
            v: "count(*) FILTER (WHERE cur)",
            p: "count(*) FILTER (WHERE prev)",
          },
          additive: ["v", "p"],
          ...(direction === "abs"
            ? {}
            : { where: direction === "down" ? "c.v < c.p" : "c.v > c.p" }),
          order:
            direction === "down"
              ? `v - p ASC, ${keys}`
              : direction === "up"
                ? `v - p DESC, ${keys}`
                : `abs(v - p) DESC, ${keys}`,
          limit,
          offset,
        },
      );
      const sum = (klass: string, column: "v" | "p") =>
        ranked.totals[klass]?.[column] ?? 0;
      const slice = (klass: string) => ({
        v: sum(klass, "v"),
        prev: sum(klass, "p"),
        delta: sum(klass, "v") - sum(klass, "p"),
      });
      const rows = ranked.rows.map((row) => ({
        row,
        v: Number(row.v),
        prev: Number(row.p),
        delta: Number(row.v) - Number(row.p),
      }));
      const rowSlice = slice("row");
      const other = {
        v: rowSlice.v - rows.reduce((all, row) => all + row.v, 0),
        prev: rowSlice.prev - rows.reduce((all, row) => all + row.prev, 0),
        delta: rowSlice.delta - rows.reduce((all, row) => all + row.delta, 0),
      };
      const unknown = slice("unknown");
      const withheld = slice("withheld");
      const totalV = rowSlice.v + unknown.v + withheld.v;
      const totalPrev = rowSlice.prev + unknown.prev + withheld.prev;
      const totalDelta = totalV - totalPrev;
      const shares = analyticsExactShares(
        [
          ...rows.map((row) => row.delta),
          other.delta,
          unknown.delta,
          withheld.delta,
        ],
        totalDelta,
      );
      const shareAt = (index: number) =>
        totalDelta === 0 ? null : shares[index]!;
      const notes = new Set<string>();
      const targets = await this.describeTargets(
        db,
        dimension.canonical === "content"
          ? rows.map(({ row }) => ({
              type: String(row.target_type),
              id: String(row.target_id),
            }))
          : [],
        notes,
      );
      return {
        ...this.frame(
          range,
          facts,
          now,
          [
            ...offDetailNote(query.surface, filter.events),
            ...this.compareNotes(compare),
            ...notes,
          ],
          ranked.hasMore,
        ),
        ...shared,
        total: {
          v: totalV,
          prev: totalPrev,
          delta: totalDelta,
          pct: rate(totalDelta, totalPrev),
          lowBase: totalPrev < minBase,
        },
        rows: rows.map(({ row, v, prev, delta }, index) => {
          return {
            ...(dimension.canonical === "content"
              ? {
                  target: targets.get(
                    groupKey(String(row.target_type), String(row.target_id)),
                  )!,
                }
              : { key: String(row[DIMENSION_KEYS[dimension.canonical][0]!]) }),
            v,
            prev,
            delta,
            pct: rate(delta, prev),
            lowBase: prev < minBase,
            onlyInBase: v === 0 && prev > 0,
            onlyInCurrent: prev === 0 && v > 0,
            shareOfChange: shareAt(index),
          };
        }),
        other: { ...other, shareOfChange: shareAt(rows.length) },
        unknown: { ...unknown, shareOfChange: shareAt(rows.length + 1) },
        withheld:
          withheld.v === 0 && withheld.prev === 0
            ? null
            : {
                reason: "self_only",
                ...withheld,
                shareOfChange: shareAt(rows.length + 2),
              },
        ...nextOffset(offset, rows.length, ranked.hasMore),
      };
    });
  }

  private async funnel(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["funnel"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    if (query.steps === undefined) throw refuse("steps", "required");
    const steps = query.steps;
    const sameTarget = query.sameTarget === "true";
    const unit = query.basis ?? "visitor";
    return this.snapshot(async (db) => {
      await this.refuseSelfOnlyTarget(db, query);
      const facts = await this.facts(db);
      const st = new Statement();
      const scan = scanSql(st, range, null, {
        targetType: query.targetType,
        targetId: query.targetId,
        events: steps,
      });
      const group = sameTarget
        ? ["visitor_id", "session_id", "target_type", "target_id"]
        : ["visitor_id", "session_id"];
      const cols = (alias: string) =>
        group.map((column) => `${alias}.${column}`).join(", ");
      const stages = steps.map((step, index) => {
        const name = st.bind(step, "text");
        if (index === 0) {
          // Only the first step has a listing's surface: a client records each open on detail.
          const listing =
            query.surface === undefined
              ? ""
              : ` AND b.surface = ${st.bind(query.surface, "text")}`;
          const targeted = sameTarget ? " AND b.target_id IS NOT NULL" : "";
          return `s0 AS (SELECT ${cols("b")}, min(b.occurred_at) AS at FROM scan b WHERE b.event_name = ${name}${listing}${targeted} GROUP BY ${cols("b")})`;
        }
        const joined = group
          .map((column) => `b.${column} = a.${column}`)
          .join(" AND ");
        // Earliest match at each step, which is enough to know a later step can follow.
        return `s${index} AS (SELECT ${cols("a")}, min(b.occurred_at) AS at
          FROM s${index - 1} a JOIN scan b ON ${joined} AND b.event_name = ${name} AND b.occurred_at >= a.at
          GROUP BY ${cols("a")})`;
      });
      const column = unit === "visitor" ? "visitor_id" : "session_id";
      // A step seen only with no target cannot be asked about one, which is not nobody doing it.
      const targetless = sameTarget
        ? `, (SELECT coalesce(array_agg(event_name), '{}') FROM (SELECT event_name FROM scan GROUP BY event_name HAVING count(target_id) = 0) t) AS targetless`
        : "";
      const row = (
        await db.query<Record<string, string> & { targetless?: string[] }>(
          `WITH scan AS MATERIALIZED (${scan}), ${stages.join(", ")}
          SELECT ${steps.map((_, index) => `(SELECT count(DISTINCT ${column}) FROM s${index}) AS c${index}`).join(", ")}${targetless}`,
          st.values,
        )
      ).rows[0]!;
      const counts = steps.map((_, index) => Number(row[`c${index}`]));
      const notes = steps
        .filter((step) => row.targetless?.includes(step) === true)
        .map((step) => `SAME_TARGET_STEP_HAS_NO_TARGET:${step}`);
      return {
        report: "funnel",
        ...this.frame(
          range,
          facts,
          now,
          [...offDetailNote(query.surface, steps.slice(0, 1)), ...notes],
          false,
        ),
        excluded: [],
        basis: {
          unit,
          order: "same_session",
          sameTarget,
          ...(query.surface === undefined
            ? {}
            : { surfaceAppliesTo: "first_step" as const }),
        },
        steps: steps.map((event, index) => ({
          event,
          count: counts[index]!,
          fromPrevious:
            index === 0 ? null : rate(counts[index]!, counts[index - 1]!),
          fromFirst: rate(counts[index]!, counts[0]!),
        })),
      };
    });
  }

  private async realtime(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["realtime"]> {
    const now = this.now();
    const offset = offsetCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_ROWS;
    const since = new Date(
      now.getTime() - ANALYTICS_REALTIME_WINDOW_SECONDS * 1000,
    );
    return this.snapshot(async (db) => {
      // Who is here now goes by the Backend's clock: a client's can be a day off.
      const received = `e.received_at >= $1::timestamptz AND e.received_at <= $2::timestamptz`;
      const heads = (
        await db.query<{
          visitors: string;
          sessions: string;
          accounts: string;
        }>(
          `SELECT count(DISTINCT visitor_id) AS visitors, count(DISTINCT session_id) AS sessions, count(DISTINCT user_id) AS accounts
          FROM community.analytics_events e WHERE ${received}`,
          [since, now],
        )
      ).rows[0]!;
      const minutes = await db.query<{ minutes_ago: number; events: string }>(
        `SELECT floor(extract(epoch FROM $2::timestamptz - e.received_at) / 60)::int AS minutes_ago, count(*) AS events
        FROM community.analytics_events e WHERE ${received} GROUP BY 1`,
        [since, now],
      );
      const perMinute = new Map(
        minutes.rows.map((row) => [row.minutes_ago, Number(row.events)]),
      );
      const online = await db.query<{
        visitor_id: string;
        session_id: string;
        user_id: string | null;
        received_at: Date;
        event_name: string;
        surface: string;
        target_type: string | null;
        target_id: string | null;
        self_only: boolean;
      }>(
        `SELECT l.*, ${selfOnly("l.target_type", "l.target_id")} AS self_only
        FROM (SELECT DISTINCT ON (e.visitor_id) e.visitor_id, e.session_id, e.user_id, e.received_at, e.event_name, e.surface, e.target_type, e.target_id
          FROM community.analytics_events e WHERE ${received}
          ORDER BY e.visitor_id, e.received_at DESC, e.event_id DESC) l
        ORDER BY l.received_at DESC, l.visitor_id LIMIT $3::integer OFFSET $4::integer`,
        [since, now, limit + 1, offset],
      );
      const kept = online.rows.slice(0, limit);
      const notes = new Set<string>();
      const targets = await this.describeTargets(
        db,
        kept
          .filter((row) => row.target_id !== null && !row.self_only)
          .map((row) => ({ type: row.target_type!, id: row.target_id! })),
        notes,
      );
      const accounts = await this.accounts(
        db,
        kept.map((row) => row.user_id),
      );
      const st = new Statement();
      const scan = `SELECT e.visitor_id, e.target_type, e.target_id, TRUE AS cur
        FROM community.analytics_events e
        WHERE e.received_at >= ${st.bind(since, "timestamptz")} AND e.received_at <= ${st.bind(now, "timestamptz")} AND e.event_name = 'page_view'`;
      const { block } = await this.countBlock(
        db,
        st,
        scan,
        "content",
        5,
        0,
        notes,
      );
      return {
        report: "realtime",
        source: "canonical",
        asOf: now.toISOString(),
        windowSeconds: ANALYTICS_REALTIME_WINDOW_SECONDS,
        activeVisitors: Number(heads.visitors),
        activeSessions: Number(heads.sessions),
        activeAccounts: Number(heads.accounts),
        eventsPerMinute: Array.from(
          { length: ANALYTICS_REALTIME_WINDOW_SECONDS / 60 },
          (_, minutesAgo) => ({
            minutesAgo,
            events: perMinute.get(minutesAgo) ?? 0,
          }),
        ),
        topContent: block,
        online: kept.map((row) => ({
          visitorId: row.visitor_id,
          sessionId: row.session_id,
          account: accountOf(accounts, row.user_id),
          lastSeenAt: row.received_at.toISOString(),
          lastEvent:
            row.event_name as AnalyticsInsightResults["realtime"]["online"][number]["lastEvent"],
          lastSurface:
            row.surface as AnalyticsInsightResults["realtime"]["online"][number]["lastSurface"],
          target:
            row.target_id === null || row.self_only
              ? null
              : targets.get(groupKey(row.target_type!, row.target_id))!,
          ...(row.self_only ? { withheld: "self_only" as const } : {}),
        })),
        excluded: ["self_only"],
        notes: [...notes],
        ...nextOffset(offset, kept.length, online.rows.length > limit),
      };
    });
  }

  private async sessions(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["sessions"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(
      query,
      now,
      ANALYTICS_MAX_SESSION_RANGE_DAYS,
    );
    this.withinRetention(range, now);
    const limit = query.limit ?? DEFAULT_ROWS;
    const after =
      query.cursor === undefined ? null : decodeKeyset(query.cursor);
    return this.snapshot(async (db) => {
      const facts = await this.facts(db);
      const st = new Statement();
      const scan = scanSql(st, range, null, {}, "e.distinct_id,");
      const subject = [
        query.visitorId === undefined
          ? null
          : `visitor_id = ${st.bind(query.visitorId, "uuid")}`,
        query.sessionId === undefined
          ? null
          : `session_id = ${st.bind(query.sessionId, "uuid")}`,
        query.distinctId === undefined
          ? null
          : `distinct_id = ${st.bind(query.distinctId, "text")}`,
        query.userId === undefined
          ? null
          : `user_id = ${st.bind(query.userId, "text")}`,
      ].filter((part) => part !== null);
      const having =
        after === null
          ? ""
          : `HAVING (max(occurred_at), session_id) < (${st.bind(after.at, "timestamptz")}, ${st.bind(after.id, "uuid")})`;
      const rows = await db.query<{
        session_id: string;
        visitor_id: string;
        user_id: string | null;
        distinct_ids: string[];
        first_at: Date;
        last_at: Date;
        last_text: string;
        events: string;
        page_views: string;
        opens: string;
      }>(
        `SELECT session_id,
          (array_agg(visitor_id ORDER BY occurred_at DESC))[1] AS visitor_id,
          (array_agg(user_id ORDER BY occurred_at DESC) FILTER (WHERE user_id IS NOT NULL))[1] AS user_id,
          array_agg(DISTINCT distinct_id) AS distinct_ids,
          min(occurred_at) AS first_at, max(occurred_at) AS last_at,
          to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_text,
          count(*) AS events,
          count(*) FILTER (WHERE event_name = 'page_view') AS page_views,
          count(*) FILTER (WHERE event_name = 'content_open') AS opens
        FROM (${scan}) s
        ${subject.length === 0 ? "" : `WHERE ${subject.join(" AND ")}`}
        GROUP BY session_id ${having}
        ORDER BY max(occurred_at) DESC, session_id DESC LIMIT ${st.bind(limit + 1, "integer")}`,
        st.values,
      );
      const kept = rows.rows.slice(0, limit);
      const hasMore = rows.rows.length > limit;
      const accounts = await this.accounts(
        db,
        kept.map((row) => row.user_id),
      );
      const last = kept.at(-1);
      return {
        report: "sessions",
        ...this.frame(range, facts, now, [], hasMore),
        excluded: [],
        rows: kept.map((row) => ({
          sessionId: row.session_id,
          visitorId: row.visitor_id,
          distinctIds: row.distinct_ids,
          account: accountOf(accounts, row.user_id),
          firstAt: row.first_at.toISOString(),
          lastAt: row.last_at.toISOString(),
          events: Number(row.events),
          pageViews: Number(row.page_views),
          contentOpens: Number(row.opens),
        })),
        ...(query.include === "ip"
          ? { ip: { withheld: true as const, switch: "rawIp" as const } }
          : {}),
        ...(hasMore && last !== undefined
          ? { next: { cursor: encodeKeyset(last.last_text, last.session_id) } }
          : {}),
      };
    });
  }

  private async session(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["session"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(
      query,
      now,
      ANALYTICS_MAX_SESSION_RANGE_DAYS,
    );
    this.withinRetention(range, now);
    const subjects = [
      query.sessionId,
      query.visitorId,
      query.distinctId,
    ].filter((value) => value !== undefined);
    if (subjects.length !== 1)
      throw refuse("sessionId", "one_subject_required");
    const limit = query.limit ?? DEFAULT_TIMELINE_EVENTS;
    const after =
      query.cursor === undefined ? null : decodeKeyset(query.cursor);
    return this.snapshot(async (db) => {
      const facts = await this.facts(db);
      const bounds = (st: Statement) => {
        const { where } = periodWhere(st, range, null);
        const subject =
          query.sessionId !== undefined
            ? `e.session_id = ${st.bind(query.sessionId, "uuid")}`
            : query.visitorId !== undefined
              ? `e.visitor_id = ${st.bind(query.visitorId, "uuid")}`
              : `e.distinct_id = ${st.bind(query.distinctId, "text")}`;
        return `${where} AND ${subject}`;
      };
      const whole = new Statement();
      const summary = (
        await db.query<{
          events: string;
          sessions: string;
          visitors: string;
          first_at: Date | null;
          last_at: Date | null;
          users: string[] | null;
        }>(
          `SELECT count(*) AS events, count(DISTINCT e.session_id) AS sessions, count(DISTINCT e.visitor_id) AS visitors,
            min(e.occurred_at) AS first_at, max(e.occurred_at) AS last_at,
            array_agg(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL) AS users
          FROM community.analytics_events e WHERE ${bounds(whole)}`,
          whole.values,
        )
      ).rows[0]!;
      const st = new Statement();
      const where = bounds(st);
      const keyset =
        after === null
          ? ""
          : ` AND (e.occurred_at, e.event_id) > (${st.bind(after.at, "timestamptz")}, ${st.bind(after.id, "uuid")})`;
      const events = await db.query<{
        event_id: string;
        event_name: string;
        surface: string;
        target_type: string | null;
        target_id: string | null;
        occurred_at: Date;
        occurred_text: string;
        dwell_ms: string | null;
        query: string | null;
        self_only: boolean;
      }>(
        `SELECT e.event_id, e.event_name, e.surface, e.target_type, e.target_id, e.occurred_at,
          to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_text,
          CASE WHEN jsonb_typeof(e.event_data->'dwellMs') = 'number' THEN e.event_data->>'dwellMs' END AS dwell_ms,
          e.event_data->>'searchQuery' AS query,
          ${selfOnly("e.target_type", "e.target_id")} AS self_only
        FROM community.analytics_events e WHERE ${where}${keyset}
        ORDER BY e.occurred_at, e.event_id LIMIT ${st.bind(limit + 1, "integer")}`,
        st.values,
      );
      const kept = events.rows.slice(0, limit);
      const hasMore = events.rows.length > limit;
      const notes = new Set<string>();
      const targets = await this.describeTargets(
        db,
        kept
          .filter((row) => row.target_id !== null && !row.self_only)
          .map((row) => ({ type: row.target_type!, id: row.target_id! })),
        notes,
      );
      const runs: AnalyticsInsightResults["session"]["runs"][number][] = [];
      let lastKey: string | null = null;
      for (const row of kept) {
        const target =
          row.target_id === null || row.self_only
            ? null
            : targets.get(groupKey(row.target_type!, row.target_id))!;
        const searched = row.self_only ? null : row.query;
        const key = JSON.stringify([
          row.event_name,
          row.surface,
          target?.type,
          target?.id,
          row.self_only,
          searched,
        ]);
        const at = row.occurred_at.toISOString();
        const dwell = row.self_only ? null : row.dwell_ms;
        const previous = runs.at(-1);
        if (key === lastKey && previous !== undefined) {
          previous.count += 1;
          previous.lastAt = at;
          if (dwell !== null)
            previous.dwellMs = (previous.dwellMs ?? 0) + Number(dwell);
          continue;
        }
        lastKey = key;
        runs.push({
          event: row.event_name as (typeof runs)[number]["event"],
          surface: row.surface as (typeof runs)[number]["surface"],
          target,
          ...(row.self_only ? { withheld: "self_only" as const } : {}),
          count: 1,
          firstAt: at,
          lastAt: at,
          dwellMs: dwell === null ? null : Number(dwell),
          query: searched,
        });
      }
      const accounts = await this.accounts(db, summary.users ?? []);
      const last = kept.at(-1);
      return {
        report: "session",
        ...this.frame(range, facts, now, [...notes], hasMore),
        excluded: ["self_only"],
        subject: {
          ...(query.sessionId === undefined
            ? {}
            : { sessionId: query.sessionId }),
          ...(query.visitorId === undefined
            ? {}
            : { visitorId: query.visitorId }),
          ...(query.distinctId === undefined
            ? {}
            : { distinctId: query.distinctId }),
        },
        summary: {
          events: Number(summary.events),
          sessions: Number(summary.sessions),
          visitors: Number(summary.visitors),
          firstAt: summary.first_at?.toISOString() ?? null,
          lastAt: summary.last_at?.toISOString() ?? null,
        },
        accounts: (summary.users ?? [])
          .map((id) => accountOf(accounts, id))
          .filter((account) => account !== null),
        runs,
        ...(query.include === "ip"
          ? { ip: { withheld: true as const, switch: "rawIp" as const } }
          : {}),
        ...(hasMore && last !== undefined
          ? {
              next: { cursor: encodeKeyset(last.occurred_text, last.event_id) },
            }
          : {}),
      };
    });
  }

  private async product(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["product"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now);
    this.withinRetention(range, now);
    const offset = offsetCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_ROWS;
    return this.snapshot(async (db) => {
      const facts = await this.facts(db);
      const surface = { surface: query.surface };
      const scanWith = (st: Statement, filter: ScanFilter) =>
        scanSql(st, range, null, { ...surface, ...filter }, "e.event_data,");
      const heads = new Statement();
      // A client sends one dwell per hide and show, so one read sums to one sample.
      const totals = (
        await db.query<Record<string, string | null>>(
          `WITH scan AS MATERIALIZED (${scanWith(heads, {
            events: [
              "search",
              "search_click",
              "like",
              "favorite",
              "follow",
              "content_dwell",
            ],
          })}),
          reads AS (SELECT sum((s.event_data->>'dwellMs')::float8) AS dwell
            FROM scan s
            WHERE s.event_name = 'content_dwell' AND jsonb_typeof(s.event_data->'dwellMs') = 'number'
            GROUP BY s.session_id, s.target_type, s.target_id)
          SELECT count(*) FILTER (WHERE event_name = 'search') AS searches,
            count(*) FILTER (WHERE event_name = 'search_click') AS clicks,
            count(*) FILTER (WHERE event_name = 'like') AS like_events,
            count(*) FILTER (WHERE event_name = 'favorite') AS favorite_events,
            count(*) FILTER (WHERE event_name = 'follow') AS follow_events,
            (SELECT count(*) FROM reads) AS dwell_samples,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell) FROM reads) AS p50,
            (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY dwell) FROM reads) AS p90
          FROM scan`,
          heads.values,
        )
      ).rows[0]!;
      const positions = new Statement();
      // A client records each open on detail, with the position the listing gave it, so
      // an open goes to the surface of its session's latest impression of that target at
      // that position. The surface filter comes after, or it would remove the opens.
      const latestImpression = `to_char(p.occurred_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') || p.surface`;
      const byPosition = await db.query<{
        surface: string;
        position: string;
        impressions: string;
        opens: string;
      }>(
        `SELECT surface, CASE WHEN pos >= 10 THEN '10+' ELSE pos::text END AS position,
          count(*) FILTER (WHERE event_name = 'content_impression') AS impressions,
          count(*) FILTER (WHERE event_name = 'content_open') AS opens
        FROM (SELECT p.event_name, p.pos,
            CASE WHEN p.event_name = 'content_open' THEN coalesce(
              substr(max(CASE WHEN p.event_name = 'content_impression' THEN ${latestImpression} END)
                OVER (PARTITION BY p.session_id, p.target_type, p.target_id, p.pos ORDER BY p.occurred_at), 21),
              p.surface) ELSE p.surface END AS surface
          FROM (SELECT s.surface, s.event_name, s.session_id, s.target_type, s.target_id, s.occurred_at,
              floor((s.event_data->>'position')::numeric)::int AS pos
            FROM (${scanWith(positions, { surface: undefined, events: ["content_impression", "content_open"] })}) s
            WHERE jsonb_typeof(s.event_data->'position') = 'number') p) a
        ${query.surface === undefined ? "" : `WHERE a.surface = ${positions.bind(query.surface, "text")}`}
        GROUP BY 1, 2 ORDER BY 1, min(pos)`,
        positions.values,
      );
      const searches = new Statement();
      const queries = await db.query<{ query: string; count: string }>(
        `SELECT s.event_data->>'searchQuery' AS query, count(*) AS count
        FROM (${scanWith(searches, { events: ["search"] })}) s
        WHERE s.event_data->>'searchQuery' <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
        searches.values,
      );
      const finals = (
        await db.query<{ likes: string; favorites: string; follows: string }>(
          `SELECT
            (SELECT count(*) FROM community.content_relations WHERE relation = 'like' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz) AS likes,
            (SELECT count(*) FROM community.content_relations WHERE relation = 'favorite' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz) AS favorites,
            (SELECT count(*) FROM community.follows WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz) AS follows`,
          [range.start, range.end],
        )
      ).rows[0]!;
      const top = new Statement();
      const ranked = await rankGroups(
        db,
        top,
        scanSql(top, range, null, {
          ...surface,
          events: ["content_impression", "content_open"],
        }),
        {
          dimension: "content",
          aggregates: {
            impressions:
              "count(*) FILTER (WHERE event_name = 'content_impression')",
            opens: "count(*) FILTER (WHERE event_name = 'content_open')",
          },
          additive: ["impressions", "opens"],
          order: "opens DESC, impressions DESC, target_type, target_id",
          limit,
          offset,
        },
      );
      const notes = new Set<string>();
      // Site-wide, because the business tables have no surface column.
      if (query.surface !== undefined) notes.add("FINALS_NOT_BY_SURFACE");
      // Top content's opens and dwell stay where they were recorded, so they can read 0 here.
      if (query.surface !== undefined && query.surface !== "detail")
        notes.add("OPENS_AND_DWELL_RECORDED_ON_DETAIL");
      // An open with no impression in range: tapped inside the impression timer, or seen earlier.
      if (
        byPosition.rows.some(
          (row) => row.surface === "detail" && Number(row.opens) > 0,
        )
      )
        notes.add("DETAIL_OPENS_HAD_NO_IMPRESSION");
      const targets = await this.describeTargets(
        db,
        ranked.rows.map((row) => ({
          type: String(row.target_type),
          id: String(row.target_id),
        })),
        notes,
      );
      const summed = (klass: string, column: string) =>
        ranked.totals[klass]?.[column] ?? 0;
      const pageSum = (column: string) =>
        ranked.rows.reduce((all, row) => all + Number(row[column]), 0);
      const withheld = {
        impressions: summed("withheld", "impressions"),
        opens: summed("withheld", "opens"),
      };
      const searchCount = Number(totals.searches);
      return {
        report: "product",
        ...this.frame(range, facts, now, [...notes], ranked.hasMore),
        excluded: ["self_only"],
        byPosition: byPosition.rows.map((row) => ({
          surface:
            row.surface as AnalyticsInsightResults["product"]["byPosition"][number]["surface"],
          position: row.position === "10+" ? "10+" : Number(row.position),
          impressions: Number(row.impressions),
          opens: Number(row.opens),
          openRate: rate(Number(row.opens), Number(row.impressions)),
        })),
        dwell: {
          basis: "session_and_target",
          samples: Number(totals.dwell_samples),
          p50Ms: totals.p50 === null ? null : Number(totals.p50),
          p90Ms: totals.p90 === null ? null : Number(totals.p90),
        },
        search: {
          searches: searchCount,
          clicks: Number(totals.clicks),
          clickRate: rate(Number(totals.clicks), searchCount),
          topQueries: queries.rows.map((row) => ({
            query: row.query,
            count: Number(row.count),
          })),
        },
        finals: {
          likes: { v: Number(finals.likes), source: "business_tables" },
          favorites: { v: Number(finals.favorites), source: "business_tables" },
          follows: { v: Number(finals.follows), source: "business_tables" },
        },
        clientEvents: {
          like: { v: Number(totals.like_events), source: "client_evidence" },
          favorite: {
            v: Number(totals.favorite_events),
            source: "client_evidence",
          },
          follow: {
            v: Number(totals.follow_events),
            source: "client_evidence",
          },
        },
        topContent: {
          rows: ranked.rows.map((row) => {
            return {
              target: targets.get(
                groupKey(String(row.target_type), String(row.target_id)),
              )!,
              impressions: Number(row.impressions),
              opens: Number(row.opens),
              openRate: rate(Number(row.opens), Number(row.impressions)),
            };
          }),
          other: {
            impressions:
              summed("row", "impressions") +
              summed("unknown", "impressions") -
              pageSum("impressions"),
            opens:
              summed("row", "opens") +
              summed("unknown", "opens") -
              pageSum("opens"),
          },
          withheld:
            withheld.impressions === 0 && withheld.opens === 0
              ? null
              : { reason: "self_only", ...withheld },
        },
        ...nextOffset(offset, ranked.rows.length, ranked.hasMore),
      };
    });
  }

  private async native(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["native"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now);
    const retentionFrom = this.retentionFrom(now);
    return this.snapshot(async (db) => {
      const facts = await this.facts(db);
      const { range: resolved, notes } = this.frame(
        range,
        facts,
        now,
        [],
        false,
      );
      return {
        report: "native",
        source: "canonical",
        asOf: now.toISOString(),
        range: resolved,
        startMs: range.start.getTime(),
        endMs: range.end.getTime(),
        retention: {
          days: this.options.retentionDays,
          from: retentionFrom.toISOString(),
        },
        outOfRetention: range.start < retentionFrom,
        notes,
      };
    });
  }

  private async reconcile(
    query: AnalyticsInsightQuery,
  ): Promise<AnalyticsInsightResults["reconcile"]> {
    const now = this.now();
    const range = resolveAnalyticsRange(query, now, RECONCILE_MAX_DAYS);
    this.withinRetention(range, now);
    const offset = offsetCursor(query.cursor);
    const limit = query.limit ?? 31;
    return this.snapshot(async (db) => {
      const facts = await this.facts(db);
      const { series } = await this.buckets(db, range, "day", {});
      const queuedRows = await db.query<{ day: string; queued: string }>(
        `SELECT to_char(e.occurred_at AT TIME ZONE $3::text, 'YYYY-MM-DD') AS day, count(*) AS queued
        FROM community.analytics_outbox o JOIN community.analytics_events e USING (event_id)
        WHERE o.failed_at IS NULL AND e.event_name = 'page_view'
          AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz
        GROUP BY 1`,
        [range.start, range.end, range.tz],
      );
      const queued = new Map(
        queuedRows.rows.map((row) => [row.day, Number(row.queued)]),
      );
      const page = series.slice(offset, offset + limit);
      const hasMore = offset + page.length < series.length;
      return {
        report: "reconcile",
        ...this.frame(range, facts, now, [], hasMore),
        excluded: [],
        days: page.map((bucket) => ({
          day: bucket.label,
          partial: bucket.partial,
          events: bucket.events,
          pageViews: bucket.pageViews,
          visitorsPageView: bucket.visitorsPageView,
          visitorsAny: bucket.visitorsAny,
          forwarded: bucket.forwarded,
          notForwarded: bucket.events - bucket.forwarded,
          pageViewsQueued: queued.get(bucket.label) ?? 0,
          pageViewsNeverForwarded:
            bucket.pageViews -
            bucket.forwardedPageViews -
            (queued.get(bucket.label) ?? 0),
        })),
        outbox: { pending: facts.outboxPending, failed: facts.outboxFailed },
        ...nextOffset(offset, page.length, hasMore),
      };
    });
  }
}
