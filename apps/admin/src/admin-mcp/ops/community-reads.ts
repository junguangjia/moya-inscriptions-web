import {
  ADMIN_MCP_TEXT_CAP_BYTES,
  AI_COUNT_GROUPS,
  adminReadCountDataSchema,
  adminReadRowsDataSchema,
  aiCountResultSchema,
  AI_OPERATOR_RUN_HEADER,
  aiFindResultSchema,
  aiOperatorRouteFor,
  aiSelectResultSchema,
  aiSettlementResultSchema,
  isAiRunHeader,
  resolveAnalyticsRange,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpCode,
  AdminMcpEnvelope,
  AdminMcpNext,
  AiCountSource,
  AiFindResult,
  AiOperatorCredential,
  AiSelectResult,
  AiSettlementQuery,
  AiSettlementResult,
  AiStampSource,
  AnalyticsInsightQuery,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import type { z } from "zod";

import {
  callAiOperator,
  CommunityOperatorError,
} from "../../community/backend";
import {
  communityOperationDefinitions,
  type CommunityOperationName,
  type OperatorCall,
} from "../../community/endpoints";
import { createPoolSlots } from "../analytics/cache";
import type { PoolSlots } from "../analytics/cache";
import {
  BACKEND_CONTRACT_MISMATCH,
  readBackendAnswer,
} from "../backend-answer";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import { notBuilt, type Unbuilt } from "../not-built";
import { INLINE_TEXT_CHARS } from "../records";
import { codePointLength, textHash } from "../text-window";
import { NUMBERED_PAGE_SIZE, numberedPageAfter } from "./define";
import type { AdminOpContext, AdminOpEntry } from "./define";

/**
 * The community reads of admin_read (admin-mcp-completion-v1 sections 5, 6 and 12),
 * through the route each page already uses, on the AI credential. The Backend decides
 * what leaves: this file checks what came back against the AI schema, which holds no
 * contact field, and makes it compact. A queue answers rows, in which long text is
 * only ever state, length and hash; one record is read whole through admin_get's
 * windows. Withheld is named on every read that can withhold, whatever it holds, so
 * the name says nothing about any one record.
 */

export type CommunityItem = Readonly<Record<string, unknown>>;

/**
 * A long read holds a connection of the Backend's App pool for its whole statement, and
 * that pool also serves the public site, the Owner and sign-in. So one Admin process
 * runs this many community calls at once, and the rest wait in turn.
 */
export const COMMUNITY_READ_POOL_SHARE = 2;
/**
 * Past it the read answers READ_TIMED_OUT. Short, because one answer can make several
 * calls of up to 15 s each, and Nginx and the clients stop waiting at 60 s. A link's
 * ids stay inside that by the exact stage's own deadline.
 */
const COMMUNITY_WAIT_MS = 5_000;
/**
 * Our abort does not end the Backend's read, so a read given up on keeps its slot this
 * much longer. A judgement: not every list's snapshot has a statement limit of its own.
 * A write's statements end themselves inside the abort (ai-write-limit.ts), so one with
 * several lock waits outlives its abort by less than this.
 */
const COMMUNITY_OVERRUN_HOLD_MS = 15_000;

export interface CommunityReadLimits {
  readonly slots: PoolSlots;
  readonly waitMs: number;
  readonly holdMs: number;
  /** What a call says when no slot came in time. A read answers READ_TIMED_OUT. */
  readonly busyCode?: string;
}

/** A slot within the wait, or false. A turn that comes later goes straight back. */
const slotWithin = ({ slots, waitMs }: CommunityReadLimits) =>
  new Promise<boolean>((answer) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      answer(false);
    }, waitMs);
    void slots.acquire().then(() => {
      if (late) slots.release();
      else {
        clearTimeout(timer);
        answer(true);
      }
    });
  });

/**
 * One Backend call inside the AI's share of the App pool. A slot wraps one call and
 * nothing waits while holding one, so it cannot deadlock. A refused connection means no
 * read is running, so only a call given up on is held past its answer.
 */
export const inPoolShare =
  (backend: OperatorCall, limits: CommunityReadLimits): OperatorCall =>
  async <Result>(...call: Parameters<OperatorCall>): Promise<Result> => {
    if (!(await slotWithin(limits)))
      throw new CommunityOperatorError(
        limits.busyCode ?? "READ_TIMED_OUT",
        503,
      );
    let overran = false;
    try {
      return await backend<Result>(...call);
    } catch (error) {
      overran = (error as { code?: unknown }).code === "OPERATOR_GAVE_UP";
      throw error;
    } finally {
      if (overran) setTimeout(() => limits.slots.release(), limits.holdMs);
      else limits.slots.release();
    }
  };

/**
 * The AI credential's call, refused before any fetch where the route table holds no row
 * for it, as the Backend refuses it: an op that calls an unlisted route fails its test,
 * not a live request. So is an irreversible row without a run id, which only the run
 * engine sets; the Backend asks the same, and a sensitive switch stays its to answer.
 */
export const routeCheckedAiCall = (
  credential: AiOperatorCredential,
  headers: Readonly<Record<string, string>> = {},
): OperatorCall => {
  const backend = callAiOperator(credential, headers);
  return async <Result>(...call: Parameters<OperatorCall>): Promise<Result> => {
    const [method, path] = call;
    const { pathname, searchParams } = new URL(
      `/internal/community/${path}`,
      "http://route.invalid",
    );
    const route = aiOperatorRouteFor(method, pathname, searchParams);
    if (route === undefined || !route.credentials.includes(credential))
      throw new CommunityOperatorError("AI_ROUTE_FORBIDDEN", 403);
    if (
      route.klass === "irreversible" &&
      !isAiRunHeader(headers[AI_OPERATOR_RUN_HEADER])
    )
      throw new CommunityOperatorError("AI_RUN_REQUIRED", 403);
    return backend<Result>(...call);
  };
};

const COMMUNITY_LIMITS: CommunityReadLimits = {
  slots: createPoolSlots(COMMUNITY_READ_POOL_SHARE),
  waitMs: COMMUNITY_WAIT_MS,
  holdMs: COMMUNITY_OVERRUN_HOLD_MS,
};

const community = inPoolShare(
  routeCheckedAiCall("community"),
  COMMUNITY_LIMITS,
);
// A job's own subject needs no community state, so Catalog work never needs that token.
const baseShare = inPoolShare(routeCheckedAiCall("base"), COMMUNITY_LIMITS);

/**
 * A write takes the same slots: the App pool holds 5 connections by default
 * (DATABASE_POOL_MAX), and these 2 and analytics' 2 are what leave one free for the
 * public site and sign-in. A write's transaction holds a connection as a read does, so
 * a share of its own would make 6. Refused in turn, it has not started. Its statements
 * end themselves, so it cannot keep a connection after its slot comes free.
 */
export const communityWriteCall = (
  headers: Readonly<Record<string, string>> = {},
): OperatorCall =>
  inPoolShare(routeCheckedAiCall("community", headers), {
    ...COMMUNITY_LIMITS,
    busyCode: "EXECUTE_BUSY",
  });

export const SELF_ONLY_CATEGORY = "self_only";

/** Reported for every report read: what no report answer carries. */
const REPORT_REDACTED = [
  "claimant.contact",
  "evidence.id",
  "evidence.fileName",
  "evidence.downloadPath",
];

/** Bare codes that mean the same thing on this side. */
const SAME_CODE: ReadonlySet<AdminMcpCode> = new Set<AdminMcpCode>([
  "SELF_ONLY_OWNER_REVIEW",
  "SENSITIVE_SWITCH_OFF",
  "AI_ROUTE_FORBIDDEN",
  "AI_CREDENTIAL_NOT_CONFIGURED",
  "READ_TIMED_OUT",
  "NOT_FOUND",
  BACKEND_CONTRACT_MISMATCH,
]);

/**
 * Bare codes this side names otherwise. The Backend asks for a run where an input is
 * irreversible, and what leads to a run here is a preview.
 */
export const COMMUNITY_CODE_HERE: Readonly<
  Record<string, Exclude<AdminMcpCode, "OK">>
> = { AI_RUN_REQUIRED: "PREVIEW_REQUIRED" };

/** A Backend refusal, as itself. Never a value, a path or a driver message. */
export const communityRefusal = (error: unknown): AdminMcpEnvelope => {
  if (!(error instanceof CommunityOperatorError)) throw error;
  const { code, status } = error;
  if (SAME_CODE.has(code as AdminMcpCode))
    return failedEnvelope(code as Exclude<AdminMcpCode, "OK">);
  const here = COMMUNITY_CODE_HERE[code];
  if (here !== undefined) return failedEnvelope(here);
  if (status === 404) return failedEnvelope("NOT_FOUND");
  if (status === 400 || status === 422)
    return inputInvalidEnvelope([{ path: ["input"], code: "refused" }]);
  if (status === 401 || status === 403)
    return failedEnvelope("AI_ROUTE_FORBIDDEN");
  return failedEnvelope("COMMUNITY_UNAVAILABLE");
};

/** What the schema reads of a Backend answer, its unknown keys dropped, or a mismatch. */
export const backendAnswer = <Schema extends z.ZodType>(
  schema: Schema,
  answer: unknown,
) => {
  const read = readBackendAnswer(schema, answer);
  if (read === undefined)
    throw new CommunityOperatorError(BACKEND_CONTRACT_MISMATCH, 502);
  return read;
};

/** One route's answer, checked against what AI may read before anything looks at it. */
export const askCommunity = async (
  route: CommunityOperationName,
  parsed: unknown,
  req: PayloadRequest,
): Promise<unknown> => {
  const definition = communityOperationDefinitions[route];
  const answer = await definition.run(parsed, community, req);
  const schema = definition.output.ai ?? definition.output.owner;
  if (schema === undefined) return answer;
  return backendAnswer(schema, answer).data;
};

/**
 * Node answers 431 past 16 KiB of request head, whatever the store holds, so a query
 * longer than this is refused by name. It leaves room for the head's other lines, and
 * about 1,300 CJK characters fit.
 */
const FIND_TEXT_IN_ADDRESS_MAX = 12_000;

export const fitsFindAddress = (text: string): boolean =>
  new URLSearchParams({ text }).toString().length <= FIND_TEXT_IN_ADDRESS_MAX;

/** The Backend's locate route: `{text,source?,limit}`, `{type,id}` or `{handle}`. */
export const askFind = async (
  query: Readonly<Record<string, string | number>>,
): Promise<AiFindResult> => {
  const params = new URLSearchParams(
    Object.entries(query).map(([name, value]) => [name, String(value)]),
  );
  return backendAnswer(
    aiFindResultSchema,
    await community("GET", `ai/find?${params.toString()}`),
  ).data;
};

const naming = (
  envelope: AdminMcpEnvelope,
  categories: readonly string[],
  redacted?: readonly string[],
): AdminMcpEnvelope =>
  categories.length === 0 && redacted === undefined
    ? envelope
    : {
        ...envelope,
        meta: {
          ...envelope.meta,
          ...(categories.length === 0 ? {} : { excluded: [...categories] }),
          ...(redacted === undefined ? {} : { redacted: [...redacted] }),
        },
      };

/**
 * The Backend's select route by ids: up to 100 rows' stamps in one statement, inside
 * the same share of the App pool every community read takes.
 */
export const askStamps = async (
  source: AiStampSource,
  ids: readonly string[],
): Promise<AiSelectResult> =>
  backendAnswer(
    aiSelectResultSchema,
    await community(
      "GET",
      `ai/select?${new URLSearchParams({ source, ids: ids.join(",") }).toString()}`,
    ),
  ).data;

/** The Backend's settlement route: what is left of the media work behind a subject. */
export const askSettlement = async (
  query: AiSettlementQuery,
): Promise<AiSettlementResult> => {
  const call = query.type === "item" ? baseShare : community;
  return backendAnswer(
    aiSettlementResultSchema,
    await call(
      "GET",
      `ai/settlement?${new URLSearchParams({ ...query }).toString()}`,
    ),
  ).data;
};

/** State, length and hash: what a row says of long text. */
export const textFacts = (value: unknown) =>
  typeof value === "string" && value !== ""
    ? { state: "VALUE", length: codePointLength(value), hash: textHash(value) }
    : { state: "ABSENT" };

export const shortOrFacts = (value: unknown) =>
  typeof value === "string" && codePointLength(value) > INLINE_TEXT_CHARS
    ? textFacts(value)
    : value;

const plain =
  (name: string) =>
  (item: CommunityItem): unknown =>
    item[name] ?? null;

const long =
  (name: string) =>
  (item: CommunityItem): unknown =>
    textFacts(item[name]);

const lengthOf =
  (name: string) =>
  (item: CommunityItem): number => {
    const list = item[name];
    return Array.isArray(list) ? list.length : 0;
  };

const nested = (item: CommunityItem, name: string) =>
  (item[name] ?? {}) as CommunityItem;

/** Leaves out what is not there, so a row carries no nulls. */
const present = (row: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );

export const isOwnerOnly = (value: unknown): boolean =>
  (value as { ownerOnly?: unknown } | null)?.ownerOnly === true;

interface CommunitySource {
  readonly route: CommunityOperationName;
  /** Names `self_only` on every answer, because the Backend withholds on this read. */
  readonly withholds?: true;
  readonly redacted?: readonly string[];
  readonly row: (item: CommunityItem) => Record<string, unknown>;
  /** Projected by `fields` or view=full. A whitelist: nothing else can leave a row. */
  readonly fields: Readonly<Record<string, (item: CommunityItem) => unknown>>;
  readonly count?: AiCountSource;
  /** A filter this queue always starts from: the appeal queue is the report queue's. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** More than this at once costs the store and cannot fit one answer. */
  readonly pageMax?: number;
}

/** The Backend builds each case whole, about 7 statements, and about 32 rows fit. */
const REPORT_PAGE_MAX = 30;

const REPORTS: CommunitySource = {
  route: "read-reports",
  withholds: true,
  pageMax: REPORT_PAGE_MAX,
  redacted: REPORT_REDACTED,
  row: (item) =>
    isOwnerOnly(item)
      ? {
          id: item.id,
          state: item.status,
          kind: item.kind,
          ownerOnly: true,
          code: item.code,
        }
      : present({
          id: item.id,
          title: shortOrFacts(nested(item, "snapshot").title),
          state: item.status,
          updatedAt: item.updatedAt,
          version: item.version,
          kind: item.kind,
          reason: item.reason,
          urgent: item.urgent,
          targetType: nested(item, "target").type,
          targetId: nested(item, "target").id,
          createdAt: item.createdAt,
        }),
  fields: {
    description: long("description"),
    canonicalPath: plain("canonicalPath"),
    reporterId: plain("reporterId"),
    affectedUserId: plain("affectedUserId"),
    legalHold: plain("legalHold"),
    claimantName: (item) => nested(item, "claimant").name ?? null,
    rightsBasis: (item) => textFacts(nested(item, "claimant").rightsBasis),
    decision: (item) => nested(item, "decision").action ?? null,
    appeal: (item) => nested(item, "appeal").status ?? null,
    allowedActions: plain("allowedActions"),
    materialCount: lengthOf("materials"),
    messageCount: lengthOf("messages"),
    historyCount: lengthOf("history"),
    evidenceCount: lengthOf("evidence"),
    evidenceTypes: (item) =>
      (item.evidence as readonly CommunityItem[]).map(
        ({ mimeType }) => mimeType,
      ),
    notificationFailures: plain("notificationFailures"),
  },
  count: "reports",
};

const COMMENTS: CommunitySource = {
  route: "read-comments",
  withholds: true,
  row: (item) =>
    present({
      id: item.id,
      title: shortOrFacts(item.contentTitle ?? item.catalogTitle),
      state: item.moderation,
      kind: item.kind,
      authorId: nested(item, "author").id,
      authorHandle: nested(item, "author").handle,
      targetType: nested(item, "target").type,
      targetId: nested(item, "target").id ?? item.catalogId,
      rootCommentId: item.rootCommentId,
      createdAt: item.createdAt,
    }),
  fields: {
    text: long("text"),
    authorName: (item) => nested(item, "author").displayName ?? null,
    authorStatus: (item) => nested(item, "author").status ?? null,
    replyToId: plain("replyToId"),
    bodyDeleted: plain("bodyDeleted"),
    threadRemoved: plain("threadRemoved"),
    threadAffectedCount: plain("threadAffectedCount"),
    imageCount: lengthOf("images"),
  },
  count: "comments",
};

const WORKS: CommunitySource = {
  route: "read-works",
  withholds: true,
  row: (item) =>
    present({
      id: item.id,
      title: shortOrFacts(item.title),
      state: item.state,
      version: item.version,
      authorId: item.authorId,
      authorName: item.authorName,
      firstPublishedAt: item.firstPublishedAt,
      publiclyVisible: item.publiclyVisible,
      ...(item.authorDeleted === true ? { authorDeleted: true } : {}),
    }),
  fields: {
    text: long("text"),
    authorStatus: plain("authorStatus"),
    publicRevisionId: plain("publicRevisionId"),
    latestSubmission: (item) => {
      const latest = item.latestSubmission as CommunityItem | null | undefined;
      return latest == null
        ? null
        : { ...latest, title: shortOrFacts(latest.title) };
    },
    recommendation: plain("recommendation"),
  },
  count: "works",
};

const USERS: CommunitySource = {
  route: "read-users",
  withholds: true,
  row: (item) => ({
    id: item.id,
    title: shortOrFacts(item.displayName),
    state: item.status,
    handle: item.handle,
    createdAt: item.createdAt,
    submittedWorks: item.submittedWorks,
    commentCount: item.commentCount,
    reportCount: item.reportCount,
  }),
  fields: {
    bio: long("bio"),
    recommended: plain("recommended"),
    recommendationVersion: plain("recommendationVersion"),
  },
  count: "users",
};

const THREADS: CommunitySource = {
  route: "read-threads",
  row: (item) => ({
    id: item.id,
    title: item.title,
    state: item.hidden === true ? "hidden" : item.status,
    updatedAt: item.updatedAt,
    version: item.version,
    postCount: item.postCount,
    position: item.position,
  }),
  fields: {
    description: long("description"),
    tags: plain("tags"),
    createdBy: plain("createdBy"),
    createdAt: plain("createdAt"),
  },
};

const FEATURED: CommunitySource = {
  route: "read-featured",
  withholds: true,
  row: (item) => ({
    id: nested(item, "target").id,
    title: shortOrFacts(item.title),
    state: item.enabled === true ? "enabled" : "disabled",
    version: item.version,
    targetType: nested(item, "target").type,
    eligible: item.eligible,
    position: item.position,
  }),
  fields: {},
};

const FEATURE_CATALOGS: CommunitySource = {
  route: "read-feature-catalogs",
  row: (item) => ({ id: item.id, title: shortOrFacts(item.title) }),
  fields: {},
};

const WORK_SUBMISSIONS: CommunitySource = {
  route: "read-work-submissions",
  withholds: true,
  row: (item) => ({
    id: item.revisionId,
    title: shortOrFacts(item.title),
    state: item.disposition,
    version: item.version,
    workId: item.workId,
    authorId: nested(item, "author").id,
    authorHandle: nested(item, "author").handle,
    latest: item.latest,
    workState: item.workState,
    submittedAt: item.submittedAt,
    itemCount: lengthOf("items")(item),
  }),
  fields: {
    body: long("body"),
    sequence: plain("sequence"),
    origin: plain("origin"),
    authorship: plain("authorship"),
    coverItemId: plain("coverItemId"),
    workTrashed: plain("workTrashed"),
    decidedAt: plain("decidedAt"),
    decidedBy: plain("decidedBy"),
  },
  count: "work_submissions",
};

/** A row here is at most about 770 bytes, so ten fit one text result whatever they hold. */
const ARTICLE_PAGE_MAX = 10;

const ARTICLE_SUBMISSIONS: CommunitySource = {
  route: "read-article-submissions",
  pageMax: ARTICLE_PAGE_MAX,
  row: (item) => ({
    id: item.articleId,
    title: item.title,
    state: "pending",
    version: item.expectedVersion,
    ownerId: item.ownerId,
    candidateVersion: item.candidateVersion,
    fingerprint: item.fingerprint,
    publicVersion: item.publicVersion,
    submittedAt: item.submittedAt,
  }),
  fields: {},
};

const JOBS: CommunitySource = {
  route: "read-publishing-jobs",
  row: (item) => ({
    id: item.id,
    state: item.state,
    updatedAt: item.updatedAt,
    kind: item.kind,
    subjectId: item.subjectId,
    attempts: item.attempts,
    lastErrorCode: item.lastErrorCode,
  }),
  fields: {
    maxAttempts: plain("maxAttempts"),
    runAfter: plain("runAfter"),
    leaseExpiresAt: plain("leaseExpiresAt"),
    createdAt: plain("createdAt"),
    finishedAt: plain("finishedAt"),
  },
  count: "jobs",
};

const FEEDBACK: CommunitySource = {
  route: "read-feedback",
  row: (item) => ({
    id: item.id,
    userId: nested(item, "user").id,
    userName: nested(item, "user").displayName,
    createdAt: item.createdAt,
    imageCount: lengthOf("images")(item),
    message: textFacts(item.message),
  }),
  fields: {},
};

const EVENTS: CommunitySource = {
  route: "read-events",
  withholds: true,
  row: (item) =>
    present({
      id: item.id,
      state: item.action,
      subjectKind: item.subjectKind,
      subjectId: item.subjectId,
      operatorLabel: item.operatorLabel,
      occurredAt: item.occurredAt,
      detail: item.detail,
    }),
  fields: {},
};

const VIEW_ARGS = ["view", "fields", "groupBy"] as const;

const ROWS_UNTRUSTED = ["/data/rows", "/data/filter"];

/**
 * `range` becomes the two instants the Backend reads. A filter's `to` is inclusive and
 * its columns hold microseconds, so the range ends on the last one.
 */
const resolvedFilter = (
  input: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>> | undefined,
) => {
  const { range, ...rest } = input;
  const query = { ...defaults, ...rest };
  if (typeof range !== "string") return { query, echo: {} };
  const { start, requestedEnd, tz, complete } = resolveAnalyticsRange(
    { range } as AnalyticsInsightQuery,
    new Date(),
  );
  const instants = {
    from: start.toISOString(),
    to: new Date(requestedEnd.getTime() - 1).toISOString().replace("Z", "999Z"),
  };
  return {
    query: { ...query, ...instants },
    echo: { range, tz, ...(complete ? { excludes: "today" } : {}) },
  };
};

const without = (
  record: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );

/** What a filter says: its paging is `next`'s, and an empty search is no filter. */
const withoutPaging = (query: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(without(query, ["page", "pageSize", "cursor"])).filter(
      ([, value]) => value !== "",
    ),
  );

const OWNER_ONLY_NOT_COUNTED =
  "Cases only the Owner reviews are not in this total, so it can be smaller than a plain count of the same queue.";

/** Decided by the query alone, so saying it says nothing about any one case. */
const toldOfOwnerOnly = (
  envelope: AdminMcpEnvelope,
  leavesOutOwnerOnly: true | undefined,
): AdminMcpEnvelope =>
  leavesOutOwnerOnly === true
    ? { ...envelope, hint: OWNER_ONLY_NOT_COUNTED }
    : envelope;

const RANGE_LEAVES_OUT_TODAY =
  "This range holds finished days, so today is not in it. To reach now, send from with no to.";

/** Only comments and works take a range, and they never leave out an owner-only case. */
const toldOfRange = (
  envelope: AdminMcpEnvelope,
  echo: Readonly<Record<string, unknown>>,
): AdminMcpEnvelope =>
  echo.excludes === undefined
    ? envelope
    : { ...envelope, hint: RANGE_LEAVES_OUT_TODAY };

const countEnvelope = async (
  source: CommunitySource,
  filter: Record<string, unknown>,
  echo: Record<string, unknown>,
  read: NonNullable<AdminOpContext["read"]>,
): Promise<AdminMcpEnvelope> => {
  if (source.count === undefined)
    return inputInvalidEnvelope([{ path: ["view"], code: "not_for_this_op" }]);
  const groups: readonly string[] = AI_COUNT_GROUPS[source.count];
  if (read.groupBy !== undefined && !groups.includes(read.groupBy))
    return inputInvalidEnvelope([
      { path: ["groupBy"], code: "unknown_group", allowedKeys: [...groups] },
    ]);
  const params = new URLSearchParams({ source: source.count });
  for (const [name, value] of Object.entries(without(filter, ["order"])))
    if (value !== undefined) params.set(name, String(value));
  if (read.groupBy !== undefined) params.set("groupBy", read.groupBy);
  const { leavesOutOwnerOnly, ...counted } = backendAnswer(
    aiCountResultSchema,
    await community("GET", `ai/count?${params.toString()}`),
  ).data;
  return toldOfRange(
    toldOfOwnerOnly(
      okEnvelope(
        adminReadCountDataSchema.parse({
          ...counted,
          filter: { ...filter, ...echo },
        }),
        ["/data/groups", "/data/filter"],
      ),
      leavesOutOwnerOnly,
    ),
    echo,
  );
};

const rowsEnvelope = async (
  source: CommunitySource,
  query: Record<string, unknown>,
  echo: Record<string, unknown>,
  read: NonNullable<AdminOpContext["read"]>,
  req: PayloadRequest,
): Promise<AdminMcpEnvelope> => {
  const asked =
    read.view === "full" ? Object.keys(source.fields) : (read.fields ?? []);
  if (asked.some((name) => !Object.hasOwn(source.fields, name)))
    return inputInvalidEnvelope([
      {
        path: ["fields"],
        code: "unknown_field",
        allowedKeys: Object.keys(source.fields),
      },
    ]);
  const paged = source.route !== "read-article-submissions";
  const page = paged ? Number(query.page ?? 1) : 1;
  const wanted = Number(
    query.pageSize ?? (paged ? NUMBERED_PAGE_SIZE : ARTICLE_PAGE_MAX),
  );
  const pageSize = Math.min(wanted, source.pageMax ?? wanted);
  const answer = (await askCommunity(
    source.route,
    { ...query, ...(paged ? { page } : {}), pageSize },
    req,
  )) as CommunityItem & {
    readonly items: readonly CommunityItem[];
    readonly total?: number;
    readonly nextCursor?: string | null;
    readonly leavesOutOwnerOnly?: true;
  };
  const { items, total, nextCursor, leavesOutOwnerOnly } = answer;
  // `next` is the one way on: a page number here would be a second one that skips rows.
  const about = without(answer, [
    "items",
    "total",
    "nextCursor",
    "page",
    "pageSize",
    "totalPages",
    "leavesOutOwnerOnly",
  ]);
  const rows = items.map((item) =>
    isOwnerOnly(item)
      ? source.row(item)
      : {
          ...source.row(item),
          ...Object.fromEntries(
            asked.map((name) => [name, source.fields[name]!(item)]),
          ),
        },
  );
  const reached = (page - 1) * pageSize + items.length;
  const onward: Record<string, unknown> | undefined = !paged
    ? nextCursor
      ? { cursor: nextCursor, pageSize }
      : undefined
    : items.length > 0 && total !== undefined && reached < total
      ? numberedPageAfter(page, pageSize, items.length)
      : undefined;
  const envelope = toldOfRange(
    toldOfOwnerOnly(
      okEnvelope(
        adminReadRowsDataSchema.parse({
          rows,
          filter: {
            ...withoutPaging(query),
            ...echo,
            ...(pageSize < wanted ? { pageSizeCappedAt: pageSize } : {}),
          },
          ...(total === undefined ? {} : { total }),
          ...(Object.keys(about).length === 0 ? {} : { about }),
        }),
        ROWS_UNTRUSTED,
      ),
      leavesOutOwnerOnly,
    ),
    echo,
  );
  if (onward === undefined) return envelope;
  const next: AdminMcpNext = {
    tool: "admin_read",
    args: { ...read, input: { ...read.input, ...onward } },
  };
  return { ...envelope, next };
};

/** The body of one queue op: rows, a projection of them, or a count in SQL. */
const runSource =
  (source: CommunitySource) =>
  async (input: unknown, { req, read }: AdminOpContext) => {
    const args = read ?? {};
    if (args.view !== "count" && args.groupBy !== undefined)
      return inputInvalidEnvelope([
        { path: ["groupBy"], code: "needs_view_count" },
      ]);
    const { query, echo } = resolvedFilter(
      input as Record<string, unknown>,
      source.defaults,
    );
    const categories = source.withholds ? [SELF_ONLY_CATEGORY] : [];
    try {
      return naming(
        args.view === "count"
          ? await countEnvelope(source, withoutPaging(query), echo, args)
          : await rowsEnvelope(source, query, echo, args, req),
        categories,
        source.redacted,
      );
    } catch (error) {
      return naming(communityRefusal(error), categories);
    }
  };

/** Past the size cap a whole record's long text goes by length and hash. */
const boundedRecord = (value: unknown): unknown => {
  if (typeof value === "string")
    return codePointLength(value) > INLINE_TEXT_CHARS
      ? { ...textFacts(value), windowed: true }
      : value;
  if (Array.isArray(value)) return value.map(boundedRecord);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, boundedRecord(item)]),
  );
};

const READ_IT_THROUGH_GET =
  "Long text here is by length and hash, because the record would not fit one answer. Read it in windows through next.";

interface OneRecord {
  readonly route: CommunityOperationName;
  readonly withholds?: true;
  /** Long enough to pass the cap: the admin_get type that reads it in windows. */
  readonly windowedAs?: string;
  /** Left out by the Backend and named: an address is for the Owner's own screen. */
  readonly leftOut?: string;
}

/** One record or setting, whole when it fits. */
const runOne =
  ({ route, withholds, windowedAs, leftOut }: OneRecord) =>
  async (input: unknown, { req }: AdminOpContext) => {
    const categories = withholds ? [SELF_ONLY_CATEGORY] : [];
    try {
      const asked = (await askCommunity(route, input, req)) as CommunityItem;
      if (isOwnerOnly(asked))
        return naming(
          failedEnvelope("SELF_ONLY_OWNER_REVIEW", { data: asked }),
          categories,
        );
      const redacted =
        leftOut === undefined
          ? (asked as { redacted?: string[] }).redacted
          : [leftOut];
      const envelope = naming(
        okEnvelope(asked, ["/data"]),
        categories,
        redacted,
      );
      if (
        windowedAs === undefined ||
        Buffer.byteLength(JSON.stringify(envelope)) <= ADMIN_MCP_TEXT_CAP_BYTES
      )
        return envelope;
      return {
        ...envelope,
        data: boundedRecord(asked),
        hint: READ_IT_THROUGH_GET,
        next: {
          tool: "admin_get",
          args: { type: windowedAs, id: (input as { id: unknown }).id },
        },
        meta: { ...envelope.meta, truncated: true as const },
      };
    } catch (error) {
      return naming(communityRefusal(error), categories);
    }
  };

const source = (
  row: CommunitySource,
  paging: "numbered" | null = "numbered",
): Partial<AdminOpEntry> => ({
  run: runSource(row),
  ...(paging === null ? {} : { paging }),
  ...(row.pageMax === undefined ? {} : { pageMax: row.pageMax }),
  readArgs: VIEW_ARGS,
  untrusted: ROWS_UNTRUSTED,
});

const one = (record: OneRecord): Partial<AdminOpEntry> => ({
  run: runOne(record),
  untrusted: ["/data"],
});

/**
 * A route that only reads, by its name. The totality test holds each one's op to class
 * read, so a read named otherwise fails there.
 */
export type CommunityReadRoute = Extract<
  CommunityOperationName,
  `read-${string}` | `lookup-${string}`
>;

/** What each built read adds to its row, or which slice brings it. */
export const COMMUNITY_READ_FACTS: Readonly<
  Record<CommunityReadRoute, Partial<AdminOpEntry> | Unbuilt>
> = {
  "read-reports": source(REPORTS),
  "read-comments": source(COMMENTS),
  "read-works": source(WORKS),
  "read-users": source(USERS),
  "read-threads": source(THREADS),
  "read-featured": source(FEATURED),
  "read-feature-catalogs": source(FEATURE_CATALOGS),
  "read-work-submissions": source(WORK_SUBMISSIONS),
  // Pages on the Backend's own cursor, which `next` carries as it stands. That cursor is
  // past the whole page, so a cut of this page has no way on.
  "read-article-submissions": source(ARTICLE_SUBMISSIONS, null),
  "read-publishing-jobs": source(JOBS),
  "read-feedback": source(FEEDBACK),
  "read-events": source(EVENTS),
  "read-report": one({
    route: "read-report",
    withholds: true,
    windowedAs: "report",
  }),
  "read-comment": one({
    route: "read-comment",
    withholds: true,
    windowedAs: "comment",
  }),
  "read-work-submission": one({
    route: "read-work-submission",
    withholds: true,
    windowedAs: "work_revision",
  }),
  "read-article-submission": one({
    route: "read-article-submission",
    windowedAs: "article",
    leftOut: "resolvedReferences",
  }),
  "read-summary": one({ route: "read-summary", withholds: true }),
  "read-policy": one({ route: "read-policy" }),
  "read-work-publishing-settings": one({
    route: "read-work-publishing-settings",
  }),
  "read-account-capacity": one({ route: "read-account-capacity" }),
  // Behind the dm switch, on admin_sensitive_read.
  "read-dm-conversation": notBuilt("S13"),
  "lookup-dm-conversation": notBuilt("S13"),
};

/** The appeal queue is the report queue, already filtered. */
export const appealQueueRun = runSource({
  ...REPORTS,
  defaults: { status: "appealed" },
});
