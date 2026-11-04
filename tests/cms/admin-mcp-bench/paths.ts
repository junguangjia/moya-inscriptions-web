import {
  adminFindDataSchema,
  adminGetDataSchema,
  adminReadCountDataSchema,
} from "@moya/contracts/internal/admin-mcp";

import type { AdminExecuteData } from "@moya/contracts/internal/admin-mcp";

import type { AnalyticsOracle } from "./analytics-seed.ts";
import type { BenchOracle, CommunityOracle } from "./seed.ts";

// Each task's reference path, as a client with no model would replay it, and its
// grader against the seed's oracle (admin-mcp-completion-v1 section 21). L0 replays
// these in CI and L1 times the reads; a write's path spends its fixture, so L1 times
// its class instead. Each slice adds its tasks here.

/** Section 21's Gate A, in ms, proposals to calibrate at first measurement. */
export const GATE_A_P95_MS = {
  door_floor: 100,
  exact_locate: 150,
  single_read: 250,
  list_page: 400,
  aggregate: 500,
  fuzzy_locate: 800,
  media_view: 800,
  single_write: 800,
  batch_write_per_target: 150,
  analytics_cached: 100,
  analytics_canonical_cold: 800,
  analytics_umami_cold: 2000,
} as const;

/** 访问分析主要数据 in Issue #330, a direct match: over it, an analytics answer fails. */
export const ANALYTICS_CEILING_MS = 3775;

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** C1: 「资料库草稿里缺释文的有多少条？按朝代分组给我数字。」 One statement of SQL, no rows. */
export const C1_CALL: ToolCall = {
  name: "admin_read",
  arguments: {
    op: "list.catalogs",
    view: "count",
    groupBy: "dynasty",
    input: { filter: { missing: ["transcription"] } },
  },
};

const groupKey = ({
  state,
  value,
}: {
  readonly state?: string | undefined;
  readonly value: string | null;
}) => `${state}|${value}`;

export const gradeC1 = (
  data: unknown,
  oracle: BenchOracle["c1"],
): readonly string[] => {
  const answer = adminReadCountDataSchema.parse(data);
  const failures: string[] = [];
  if (answer.total !== oracle.total)
    failures.push(`total ${answer.total}, expected ${oracle.total}`);
  const expected = new Map(
    oracle.groups.map((group) => [groupKey(group), group.count]),
  );
  const seen = new Set<string>();
  for (const group of answer.groups ?? []) {
    const key = groupKey(group);
    seen.add(key);
    if (expected.get(key) !== group.count)
      failures.push(`${key}: ${group.count}, expected ${expected.get(key)}`);
  }
  for (const key of expected.keys())
    if (!seen.has(key)) failures.push(`${key}: missing from the answer`);
  return failures;
};

/** C4: 「这个链接对应哪条资料？现在上线了吗？深度缩放是什么状态？/catalog/<id>」 */
export const c4Calls = (catalogId: string, id: number) => ({
  find: {
    name: "admin_find",
    arguments: { query: `/catalog/${catalogId}` },
  } satisfies ToolCall,
  get: {
    name: "admin_get",
    arguments: { type: "catalog", id },
  } satisfies ToolCall,
});

/**
 * The master half reads as not_available until the master routes arrive in a later
 * slice, which the Matrix asks for over a guessed state: it never reads as no master.
 * It is graded as that, and reported as open, because C4's full grader wants the state.
 */
export const gradeC4 = (
  found: unknown,
  got: unknown,
  expected: { readonly id: number; readonly state: string },
): readonly string[] => {
  const failures: string[] = [];
  const find = adminFindDataSchema.parse(found);
  if (find.resolution.status !== "exact" || !find.resolution.uniqueIdentity)
    failures.push(`resolution ${find.resolution.status}`);
  if (find.resolution.ref?.id !== expected.id)
    failures.push(`ref ${find.resolution.ref?.id}, expected ${expected.id}`);
  if (find.items[0]?.state !== expected.state)
    failures.push(`find state ${find.items[0]?.state}`);
  const record = adminGetDataSchema.parse(got) as Record<string, unknown>;
  if (record.id !== expected.id) failures.push(`get id ${String(record.id)}`);
  if (record.state !== expected.state)
    failures.push(`get state ${String(record.state)}`);
  if (record.deepZoom !== "not_available")
    failures.push(`deepZoom ${String(record.deepZoom)}`);
  return failures;
};

/** C2: 「把草稿《泰山经石峪》的题名改成“泰山经石峪金刚经”，其他字段不动。」 */
export const c2FindCall = (title: string): ToolCall => ({
  name: "admin_find",
  arguments: { query: title, type: "catalog" },
});

/**
 * The prompt names a draft by its whole title, so a client takes the one draft that
 * has exactly that title: never the near-twin, never the published one. Undefined when
 * the answer holds no such one, or two.
 */
export const c2Candidate = (found: unknown, title: string) => {
  const { items } = adminFindDataSchema.parse(found);
  const matching = items.filter(
    (item) => item.title === title && item.state === "draft",
  );
  return matching.length === 1 ? matching[0] : undefined;
};

export const c2SaveCall = (
  requestId: string,
  got: { readonly id: number; readonly revision: number | null },
  disambiguators: Readonly<Record<string, unknown>>,
  newTitle: string,
): ToolCall => ({
  name: "admin_execute",
  arguments: {
    requestId,
    op: "editorial.save-draft",
    input: {
      id: got.id,
      expectedRevision: got.revision,
      content: {
        catalogId: disambiguators.catalogId,
        sourceId: disambiguators.sourceId,
        kind: disambiguators.kind,
        title: newTitle,
      },
    },
  },
});

/** What a save moves on a row whatever it edits: not the content. */
const C2_BOOKKEEPING: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "updated_at",
  "version_updated_at",
  "version_revision",
  "version_last_edited_by_id",
]);

/** Row diff of the latest version, from plain SQL before and after. */
export const gradeC2 = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  oracle: BenchOracle["c2"],
): readonly string[] => {
  const failures: string[] = [];
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (name) =>
        !C2_BOOKKEEPING.has(name) &&
        JSON.stringify(before[name]) !== JSON.stringify(after[name]),
    )
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify(["version_title"]))
    failures.push(`changed ${changed.join(",")}, expected version_title`);
  if (before.version_title !== oracle.title)
    failures.push(`title before: ${String(before.version_title)}`);
  if (after.version_title !== oracle.newTitle)
    failures.push(`title after: ${String(after.version_title)}`);
  if (after.version_revision !== Number(before.version_revision) + 1)
    failures.push(`revision ${String(after.version_revision)}`);
  return failures;
};

/** C3: 「发布下面这 30 条已批准的草稿（附 id）。发完告诉我实际发布了几条，没发成的是哪几条、为什么。」 */
export const C3_APPROVALS_CALL: ToolCall = {
  name: "admin_read",
  arguments: {
    op: "list.approvals",
    fields: ["itemCount"],
    input: { filter: { status: "active" } },
  },
};

export const c3PublishCall = (
  requestId: string,
  approvalId: number,
  targets: readonly number[],
): ToolCall => ({
  name: "admin_execute",
  arguments: {
    requestId,
    op: "editorial.publish-approved",
    input: { approvalId },
    targets: targets.map((id) => ({ id })),
  },
});

const sameIds = (
  actual: readonly unknown[] | undefined,
  expected: readonly number[],
) => {
  const ordered = (ids: readonly number[]) =>
    JSON.stringify([...ids].sort((a, b) => a - b));
  return ordered((actual ?? []).map(Number)) === ordered(expected);
};

/**
 * What the answer itself says, because the task is to tell how many went out and which
 * did not and why. The final state is graded apart, on the rows.
 */
export const gradeC3 = (
  envelope: {
    readonly ok: boolean;
    readonly code: string;
    readonly data?: unknown;
  },
  oracle: BenchOracle["c3"],
  fresh = true,
): readonly string[] => {
  const failures: string[] = [];
  const data = (envelope.data ?? {}) as AdminExecuteData;
  if (envelope.ok || envelope.code !== "PARTIAL")
    failures.push(`answer ${String(envelope.ok)} ${envelope.code}`);
  const applied = fresh ? oracle.publishes : [];
  const already = fresh
    ? [oracle.alreadyPublished]
    : [...oracle.publishes, oracle.alreadyPublished];
  if (!sameIds(data.applied, applied)) failures.push("applied set");
  if (!sameIds(data.already_applied, already)) failures.push("already set");
  const conflict = data.conflict ?? [];
  if (
    conflict.length !== 1 ||
    conflict[0]!.id !== oracle.locked ||
    conflict[0]!.code !== "DOCUMENT_LOCKED" ||
    conflict[0]!.lock?.held !== true ||
    conflict[0]!.lock?.by !== "owner"
  )
    failures.push(`conflict ${JSON.stringify(conflict)}`);
  const failed = data.failed ?? [];
  if (
    failed.length !== 1 ||
    failed[0]!.id !== oracle.missingField.id ||
    failed[0]!.code !== "CONTENT_INVALID"
  )
    failures.push(`failed ${JSON.stringify(failed)}`);
  // A receipt keeps a code and no field names, so only the first answer can say which.
  if (fresh && failed[0]?.fields?.[0] !== oracle.missingField.field)
    failures.push(`failed fields ${JSON.stringify(failed[0]?.fields)}`);
  if (data.unknown !== undefined || data.queued !== undefined)
    failures.push("a target reads unknown or queued");
  return failures;
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const differs = (
  failures: string[],
  name: string,
  actual: unknown,
  expected: unknown,
) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    failures.push(
      `${name}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
};

/** M1: 「现在待处理的举报有多少？按类型分组，最早那条等了多久？」 One read, no rows. */
export const M1_CALL: ToolCall = {
  name: "admin_read",
  arguments: {
    op: "list.reports",
    view: "count",
    groupBy: "kind",
    input: { unresolved: "true" },
  },
};

export const gradeM1 = (data: unknown, oracle: CommunityOracle["m1"]) => {
  const answer = adminReadCountDataSchema.parse(data);
  const failures: string[] = [];
  differs(failures, "total", answer.total, oracle.total);
  differs(failures, "oldest", answer.oldestAt, oracle.oldestAt);
  const ordered = (groups: readonly { readonly value: string | null }[]) =>
    [...groups].sort((a, b) => String(a.value).localeCompare(String(b.value)));
  differs(
    failures,
    "groups",
    ordered(answer.groups ?? []),
    ordered(oracle.groups),
  );
  return failures;
};

/** U1: 「查一下 @lishu_test：注册时间、账号状态、作品数、评论数、被举报过几次。」 */
export const u1FindCall = (handle: string): ToolCall => ({
  name: "admin_find",
  arguments: { query: `@${handle}` },
});

export const u1ReadCall = (ref: { readonly id: unknown }): ToolCall => ({
  name: "admin_read",
  arguments: { op: "list.users", input: { userId: ref.id } },
});

export const gradeU1 = (
  found: unknown,
  listed: unknown,
  oracle: CommunityOracle["u1"],
) => {
  const failures: string[] = [];
  const find = adminFindDataSchema.parse(found);
  differs(failures, "resolution", find.resolution, {
    status: "exact",
    uniqueIdentity: true,
    ref: { type: "user", id: oracle.id },
  });
  const rows = (listed as { rows?: readonly Json[] }).rows ?? [];
  differs(failures, "rows", rows.length, 1);
  const row = rows[0];
  differs(
    failures,
    "facts",
    [
      row?.id,
      row?.handle,
      row?.createdAt,
      row?.state,
      row?.submittedWorks,
      row?.commentCount,
      row?.reportCount,
    ],
    [
      oracle.id,
      oracle.handle,
      oracle.createdAt,
      oracle.status,
      oracle.submittedWorks,
      oracle.commentCount,
      oracle.reportCount,
    ],
  );
  return failures;
};

/** A1: 「昨天（北京时间）的访客数、访问次数、浏览量各是多少？和前一天比变化多少？」 */
export const A1_CALL: ToolCall = {
  name: "admin_analytics",
  arguments: { report: "overview", range: "yesterday" },
};

export const gradeA1 = (data: Json, oracle: AnalyticsOracle["a1"]) => {
  const failures: string[] = [];
  const { yesterday, dayBefore } = oracle;
  differs(
    failures,
    "range",
    [data.range?.start, data.range?.end, data.range?.tz],
    [oracle.start, oracle.end, "Asia/Shanghai"],
  );
  for (const name of [
    "pageViews",
    "visitorsPageView",
    "canonicalSessions",
  ] as const) {
    const metric = data.metrics?.[name];
    differs(
      failures,
      name,
      [metric?.v, metric?.prev, metric?.delta],
      [yesterday[name], dayBefore[name], yesterday[name] - dayBefore[name]],
    );
  }
  const visits = data.native?.metrics?.nativeVisits;
  differs(failures, "native status", data.native?.status, "fresh");
  differs(
    failures,
    "nativeVisits",
    [visits?.v, visits?.prev, visits?.delta],
    [
      yesterday.nativeVisits,
      dayBefore.nativeVisits,
      yesterday.nativeVisits - dayBefore.nativeVisits,
    ],
  );
  return failures;
};

/** A2: 「过去 7 天访问最多的 5 个页面和前 3 个省份是什么？」 */
export const A2_CALL: ToolCall = {
  name: "admin_analytics",
  arguments: { report: "overview", range: "last_7_days", limit: 5 },
};

export const gradeA2 = (data: Json, oracle: AnalyticsOracle["a2"]) => {
  const failures: string[] = [];
  const block = data.topContent;
  differs(
    failures,
    "top content",
    block?.rows?.map((row: Json) => [
      row.target.type,
      row.target.id,
      row.count,
    ]),
    oracle.rows.map(({ type, id, hits }) => [type, id, hits]),
  );
  differs(failures, "total", block?.total, oracle.total);
  differs(failures, "withheld", block?.withheld?.count, oracle.withheld);
  differs(failures, "unknown", block?.unknown?.count, oracle.unknown);
  const shares =
    Math.round(
      (block?.rows?.reduce((sum: number, row: Json) => sum + row.share, 0) +
        block?.other?.share +
        block?.unknown?.share +
        block?.withheld?.share) *
        100,
    ) / 100;
  differs(failures, "shares", shares, 100);
  differs(failures, "provinces status", data.topProvinces?.status, "fresh");
  differs(failures, "provinces", data.topProvinces?.rows, oracle.provinces);
  return failures;
};

/** A3: 「过去 30 天按周看浏览量，哪周最高？比最低那周高多少？」 */
export const A3_CALL: ToolCall = {
  name: "admin_analytics",
  arguments: { report: "trend", range: "last_30_days", groupBy: "week" },
};

export const gradeA3 = (data: Json, oracle: AnalyticsOracle["a3"]) => {
  const failures: string[] = [];
  const buckets = (data.buckets ?? []) as Json[];
  differs(
    failures,
    "weeks",
    Object.fromEntries(
      buckets
        .map((bucket) => [bucket.label as string, bucket.pageViews as number])
        .sort(([a], [b]) => (a! < b! ? -1 : 1)),
    ),
    Object.fromEntries(
      Object.entries(oracle.weeks).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );
  const highest = buckets.reduce<Json | undefined>(
    (best, bucket) =>
      best === undefined || bucket.pageViews > best.pageViews ? bucket : best,
    undefined,
  );
  const lowest = buckets.reduce<Json | undefined>(
    (best, bucket) =>
      best === undefined || bucket.pageViews < best.pageViews ? bucket : best,
    undefined,
  );
  differs(failures, "highest week", highest?.label, oracle.highest.label);
  differs(
    failures,
    "difference",
    highest?.pageViews - lowest?.pageViews,
    oracle.highest.pageViews - oracle.lowest.pageViews,
  );
  return failures;
};

/** A4: 「过去 7 天访问量最高的作品是哪件？作者是谁？这件作品现在是什么状态？」 */
export const A4_CALL: ToolCall = {
  name: "admin_analytics",
  arguments: {
    report: "breakdown",
    range: "last_7_days",
    dimension: "content",
    filter: { targetType: "work" },
    limit: 1,
  },
};

export const gradeA4 = (data: Json, oracle: AnalyticsOracle["a4"]) => {
  const failures: string[] = [];
  const row = data.rows?.[0];
  differs(
    failures,
    "top work",
    [
      row?.target?.id,
      row?.count,
      row?.target?.authorHandle,
      row?.target?.state,
    ],
    [oracle.id, oracle.hits, oracle.authorHandle, oracle.state],
  );
  return failures;
};
