import { createHash } from "node:crypto";

import {
  OPERATOR_SOURCES,
  PostgresAiOperatorReader,
  PostgresCommunityCommentAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityReportingAdapter,
  PostgresPublishingOperatorAdapter,
} from "@moya/community-postgres";
import type { SourceQuery, SourceSpec } from "@moya/community-postgres";
import { aiCountQuerySchema } from "@moya/contracts/internal/admin-mcp";
import type { AiCountSource } from "@moya/contracts/internal/admin-mcp";
import {
  operatorPublishingJobQuerySchema,
  operatorReportQuerySchema,
  operatorUsersQuerySchema,
  operatorWorkSubmissionQuerySchema,
  operatorWorksQuerySchema,
} from "@moya/contracts/internal/community-operator";
import type { OperatorCommentQueryInput } from "@moya/api";
import { describe, expect, it } from "vitest";

/**
 * One filter per operator source (admin-mcp-completion-v1 S8): the Owner's queue, its
 * AI read and the count beside it read one WHERE and one list of values. The golden
 * was recorded on the code before that filter was shared, so every statement these
 * reads send, the Owner's first, is shown to be the same text with the same values.
 */

/** The pool the adapters take; this package names no driver of its own. */
type Pool = ConstructorParameters<typeof PostgresAiOperatorReader>[0];

const hex = (seed: string) =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);
const user = `user-${hex("user")}`;
const other = `user-${hex("other")}`;
const work = `work-${hex("work")}`;
const item = `media-item-${hex("item")}`;
const job = `publishing-job-${hex("job")}`;
const from = "2026-01-01T00:00:00Z";
const to = "2026-02-01T00:00:00+08:00";
// Each character the search pattern escapes, and one it does not.
const search = "墨 50%_\\x";

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A pool that records every statement and answers each with no rows but a zero count. */
const recorder = () => {
  const statements: Statement[] = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    statements.push({ text, values: [...values] });
    const counts = /count\(/iu.test(text) && !/LIMIT \$|GROUP BY/u.test(text);
    // The comment queue reads its total as text, the other queues as a number.
    const total = /::text AS total/u.test(text) ? "0" : 0;
    return {
      rows: counts ? [{ total, n: 0, count: 0, oldest: null }] : [],
      rowCount: 0,
    };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;
  return { pool, statements };
};

type Read = (pool: Pool) => Promise<unknown>;

/** Every filter alone, then all of them at once. */
const eachThenAll = (
  filters: Readonly<Record<string, unknown>>,
): [string, Record<string, unknown>][] => [
  ["none", {}],
  ...Object.entries(filters).map(
    ([name, value]): [string, Record<string, unknown>] => [
      name,
      { [name]: value },
    ],
  ),
  ["all", { ...filters }],
];

const AI = { withholdSelfOnly: true } as const;
const SCOPES = [
  ["owner", undefined],
  ["ai", AI],
] as const;

const REPORT_FILTERS = {
  status: "open",
  unresolved: "true",
  urgent: "false",
  targetType: "work",
  targetId: work,
  affectedUserId: user,
  reporterId: other,
};
const COMMENT_FILTERS = {
  moderation: "pending",
  kind: "reply",
  catalogId: "catalog-golden",
  search,
  authorId: user,
  from,
  to,
};
const WORK_FILTERS = { search, authorId: user, workId: work, from, to };
const USER_FILTERS = { search, userId: user };
const SUBMISSION_FILTERS = { state: "approved", authorId: user, workId: work };
const JOB_FILTERS = {
  state: "failed",
  kind: "process_item",
  subjectId: item,
  id: job,
};

const SOURCE_FILTERS = {
  reports: REPORT_FILTERS,
  comments: COMMENT_FILTERS,
  works: WORK_FILTERS,
  users: USER_FILTERS,
  work_submissions: SUBMISSION_FILTERS,
  jobs: JOB_FILTERS,
} as const;

const GROUPS = {
  reports: ["kind", "status", "reason", "targetType"],
  comments: ["moderation", "kind", "targetType"],
  works: ["state"],
  users: ["status"],
  work_submissions: ["state"],
  jobs: ["state", "kind"],
} as const;

const commentQuery = (
  filter: Record<string, unknown>,
  order: "newest" | "oldest",
): OperatorCommentQueryInput =>
  ({
    ...filter,
    order,
    page: 3,
    pageSize: 7,
  }) as OperatorCommentQueryInput;

const scenarios = (): [string, Read][] => [
  ...eachThenAll(REPORT_FILTERS).flatMap(([name, filter]): [string, Read][] => {
    const query = operatorReportQuerySchema.parse({
      ...filter,
      page: "2",
      pageSize: "5",
    });
    return [
      [
        `reports owner ${name}`,
        (pool) =>
          new PostgresCommunityReportingAdapter(pool).operatorList(query),
      ],
      [
        `reports ai ${name}`,
        (pool) =>
          new PostgresCommunityReportingAdapter(pool).operatorListForAi(query),
      ],
    ];
  }),
  ...eachThenAll(COMMENT_FILTERS).flatMap(([name, filter]) =>
    SCOPES.flatMap(([scope, given]) =>
      // The order only picks the list's text, so once is enough.
      (name === "all"
        ? (["newest", "oldest"] as const)
        : (["newest"] as const)
      ).map((order): [string, Read] => [
        `comments ${scope} ${order} ${name}`,
        (pool) =>
          new PostgresCommunityCommentAdapter(pool).readOperatorComments(
            commentQuery(filter, order),
            given,
          ),
      ]),
    ),
  ),
  ...SCOPES.map(([scope, given]): [string, Read] => [
    `moderation summary ${scope}`,
    (pool) =>
      new PostgresCommunityCommentAdapter(pool).readModerationSummary(
        { from: new Date(from), to: new Date(to) },
        given,
      ),
  ]),
  ...eachThenAll(WORK_FILTERS).flatMap(([name, filter]) =>
    SCOPES.map(([scope, given]): [string, Read] => [
      `works ${scope} ${name}`,
      (pool) =>
        new PostgresCommunityContentOperatorAdapter(pool).readWorks(
          operatorWorksQuerySchema.parse({ ...filter, page: 2, pageSize: 5 }),
          given,
        ),
    ]),
  ),
  ...eachThenAll(USER_FILTERS).flatMap(([name, filter]) =>
    SCOPES.map(([scope, given]): [string, Read] => [
      `users ${scope} ${name}`,
      (pool) =>
        new PostgresCommunityContentOperatorAdapter(pool).readUsers(
          operatorUsersQuerySchema.parse({ ...filter, page: 2, pageSize: 5 }),
          given,
        ),
    ]),
  ),
  ...[
    ...eachThenAll(SUBMISSION_FILTERS),
    ["pending", { state: "pending" }] as [string, Record<string, unknown>],
  ].flatMap(([name, filter]) =>
    SCOPES.map(([scope, given]): [string, Read] => [
      `work_submissions ${scope} ${name}`,
      (pool) =>
        new PostgresPublishingOperatorAdapter(pool).listSubmissions(
          operatorWorkSubmissionQuerySchema.parse({
            ...filter,
            page: 2,
            pageSize: 5,
          }),
          given,
        ),
    ]),
  ),
  ...eachThenAll(JOB_FILTERS).map(([name, filter]): [string, Read] => [
    `jobs ${name}`,
    (pool) =>
      new PostgresPublishingOperatorAdapter(pool).listJobs(
        operatorPublishingJobQuerySchema.parse({
          ...filter,
          page: 2,
          pageSize: 5,
        }),
      ),
  ]),
  ...Object.entries(SOURCE_FILTERS).flatMap(([source, filters]) =>
    [
      ...eachThenAll(filters),
      ...GROUPS[source as keyof typeof GROUPS].map(
        (groupBy): [string, Record<string, unknown>] => [
          `by ${groupBy}`,
          { groupBy },
        ],
      ),
    ].map(([name, filter]): [string, Read] => [
      `count ${source} ${name}`,
      (pool) =>
        new PostgresAiOperatorReader(pool).count(
          aiCountQuerySchema.parse({ source, ...filter }),
        ),
    ]),
  ),
];

/**
 * Each distinct statement text once, under a short hash, and each read as the calls it
 * made, one line a call: that text's hash, then its values as JSON.
 */
const golden = async () => {
  const texts: Record<string, string> = {};
  const reads: Record<string, string[]> = {};
  for (const [name, read] of scenarios()) {
    const { pool, statements } = recorder();
    await read(pool);
    reads[name] = statements.map(({ text, values }) => {
      const key = createHash("sha256").update(text).digest("hex").slice(0, 12);
      texts[key] = text;
      return `${key} ${JSON.stringify(values)}`;
    });
  }
  return {
    reads,
    texts: Object.fromEntries(
      Object.entries(texts).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
};

describe("the operator sources' statements", () => {
  it("are the ones recorded before the filter was shared, text and values", async () => {
    expect(await golden()).toMatchSnapshot();
  });
});

describe("each source's filter", () => {
  const sources = Object.keys(OPERATOR_SOURCES) as AiCountSource[];

  it.each(sources)(
    "%s has a value for every placeholder, and LIMIT and OFFSET come after them",
    (source) => {
      const spec = OPERATOR_SOURCES[source] as SourceSpec<
        SourceQuery<typeof source>
      >;
      for (const query of [
        {},
        SOURCE_FILTERS[source],
        // The widest a report's AI read gets: a filter that leaves owner-only rows out.
        { ...SOURCE_FILTERS[source], groupBy: GROUPS[source].at(-1) },
      ] as SourceQuery<typeof source>[])
        for (const [, scope] of SCOPES) {
          const text = `${spec.from} ${spec.where(query, scope)}`;
          const used = new Set(
            [...text.matchAll(/\$(\d+)/gu)].map(([, n]) => Number(n)),
          );
          const values = spec.values(query, scope);
          expect([...used].sort((a, b) => a - b)).toEqual(
            values.map((_, index) => index + 1),
          );
        }
    },
  );
});
