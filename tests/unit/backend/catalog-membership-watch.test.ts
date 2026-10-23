import { createHash } from "node:crypto";

import {
  catalogPrivateMembershipBucketsSql,
  catalogPrivateMembershipMembersSql,
  catalogPublicMembershipBucketsSql,
  catalogPublicMembershipMembersSql,
  createCatalogMembershipWatch,
  type CatalogMembershipPort,
} from "@moya/backend-production/internal/publishing-catalog";
import {
  CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS,
  CATALOG_SNAPSHOT_MAX_SOURCES,
  catalogMembershipBuckets,
  catalogMembershipChanged,
  catalogMembershipTotal,
  catalogPublicationDirtyMarkSql,
  differingCatalogMembershipBuckets,
  markCatalogPublicationDirty,
} from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 (Issue #323) 1B, W8: the worker's per-minute membership
 * step and the dirty-queue writer, over synthetic pools. The step reads one
 * aggregate per side in one CMS snapshot; only a side whose total changed
 * lists buckets (as App asset ids): those that changed since the step's own
 * committed observation while that is the one stored, or else those that
 * differ from the App's record; above a snapshot ceiling, or on any read
 * error, nothing is applied or kept; every CMS client is rolled back and
 * released. Marks are one
 * statement in asset id order, and invalid ones are refused before any
 * statement. The PostgreSQL behaviour is in
 * tests/integration/postgres/catalog-membership.test.ts.
 */

const md5 = (value: string) =>
  createHash("md5").update(value, "utf8").digest("hex");
const bucketRow = (bucket: string, count: number, sum: string) => ({
  bucket,
  count,
  sum,
});

/** A synthetic CMS pool answering the step's statements. */
const cms = (answers: {
  readonly buckets: readonly ReturnType<typeof bucketRow>[];
  readonly members?: readonly Record<string, unknown>[];
  readonly fail?: string;
  /** The CMS clock (default 2026-10-23T00:00:00.000Z). */
  readonly at?: Date;
}) => {
  const statements: { sql: string; values?: readonly unknown[] }[] = [];
  const released = vi.fn();
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    statements.push({ sql, ...(values ? { values } : {}) });
    if (answers.fail !== undefined && sql === answers.fail)
      throw Object.assign(new Error("synthetic"), { code: "57P01" });
    if (sql === "SELECT clock_timestamp() AS at")
      return {
        rows: [{ at: answers.at ?? new Date("2026-10-23T00:00:00.000Z") }],
      };
    if (sql === "SELECT pg_export_snapshot() AS id")
      return { rows: [{ id: "00000003-0000001B-1" }] };
    if (
      sql === catalogPublicMembershipBucketsSql ||
      sql === catalogPrivateMembershipBucketsSql
    )
      return { rows: answers.buckets };
    if (
      sql === catalogPublicMembershipMembersSql ||
      sql === catalogPrivateMembershipMembersSql
    )
      return { rows: answers.members ?? [] };
    return { rows: [] };
  });
  return {
    pool: {
      connect: async () => ({ query, release: released }),
    } as unknown as Parameters<
      typeof createCatalogMembershipWatch
    >[0]["published"],
    statements,
    released,
  };
};

const port = (
  overrides: Partial<CatalogMembershipPort> = {},
): CatalogMembershipPort & {
  readonly apply: ReturnType<typeof vi.fn>;
  readonly appBuckets: ReturnType<typeof vi.fn>;
} => {
  const apply = vi.fn(async () => ({ public: 0, private: 0, boundaries: 0 }));
  const appBuckets = vi.fn(async () => new Map());
  return {
    readCatalogMembershipState: async () => ({ public: null, private: null }),
    readCatalogMembershipAppBuckets: appBuckets,
    applyCatalogMembership: apply,
    apply,
    appBuckets,
    ...overrides,
  };
};
const silent = () => ({ info: vi.fn(), error: vi.fn() });

describe("Catalog membership step", () => {
  it("reads only the aggregates when the stored totals match", async () => {
    const published = cms({ buckets: [bucketRow("0a", 2, "5")] });
    const app = port({
      readCatalogMembershipState: async () => ({
        public: {
          count: 2,
          sum: "5",
          observedAt: new Date("2026-10-22T23:59:00.000Z"),
        },
        private: null,
      }),
    });
    await createCatalogMembershipWatch({
      published: published.pool,
      prepare: null,
      port: app,
      logger: silent(),
    }).run(new Date());
    expect(published.statements.map(({ sql }) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT clock_timestamp() AS at",
      catalogPublicMembershipBucketsSql,
      "ROLLBACK",
    ]);
    expect(app.appBuckets).not.toHaveBeenCalled();
    expect(app.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        public: { count: 2, sum: "5", diff: null },
        private: null,
      }),
      expect.any(Date),
    );
    expect(published.released).toHaveBeenCalledTimes(1);
  });

  it("lists only the differing buckets of a changed side, as App asset ids", async () => {
    const pair = { media_id: "synthetic-media", object_key: "display/v1/x" };
    const published = cms({
      buckets: [bucketRow("0a", 2, "5"), bucketRow("ff", 1, "7")],
      members: [pair],
    });
    const app = port();
    app.appBuckets.mockResolvedValueOnce(
      new Map([
        ["0a", { count: 2, sum: "5" }],
        ["10", { count: 1, sum: "3" }],
      ]),
    );
    const prepare = cms({ buckets: [] });
    await createCatalogMembershipWatch({
      published: published.pool,
      prepare: prepare.pool,
      port: app,
      logger: silent(),
    }).run(new Date());
    const members = published.statements.find(
      ({ sql }) => sql === catalogPublicMembershipMembersSql,
    );
    expect(members?.values).toEqual([["10", "ff"]]);
    expect(app.appBuckets.mock.calls).toEqual([["public"], ["private"]]);
    const observation = app.apply.mock.calls[0]![0];
    expect(observation.public).toEqual({
      count: 3,
      sum: "12",
      diff: {
        buckets: ["10", "ff"],
        members: [`catalog-asset-${md5("synthetic-media:display/v1/x")}`],
      },
    });
    // The private side was read in the exported snapshot; nothing is there
    // and nothing is stored, so its diff is empty.
    expect(prepare.statements.map(({ sql }) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
      catalogPrivateMembershipBucketsSql,
      "ROLLBACK",
    ]);
    expect(observation.private).toEqual({
      count: 0,
      sum: "0",
      diff: { buckets: [], members: [] },
    });
    expect(prepare.released).toHaveBeenCalledTimes(1);
  });

  it("lists the buckets changed since its own committed observation while that is the one stored", async () => {
    const answers: {
      buckets: ReturnType<typeof bucketRow>[];
      members: Record<string, unknown>[];
      at: Date;
    } = {
      buckets: [bucketRow("0a", 2, "5")],
      members: [],
      at: new Date("2026-10-23T00:00:00.000Z"),
    };
    const published = cms(answers);
    // A store: what applyCatalogMembership commits is what is read next.
    let stored: Awaited<
      ReturnType<CatalogMembershipPort["readCatalogMembershipState"]>
    > = { public: null, private: null };
    let failNext = false;
    const app = port({
      readCatalogMembershipState: async () => stored,
    });
    app.apply.mockImplementation(async (observation) => {
      if (failNext) {
        failNext = false;
        throw new Error("synthetic commit failure");
      }
      stored = {
        public: {
          count: observation.public.count,
          sum: observation.public.sum,
          observedAt: observation.observedAt,
        },
        private: null,
      };
      return { public: 0, private: 0, boundaries: 0 };
    });
    const step = createCatalogMembershipWatch({
      published: published.pool,
      prepare: null,
      port: app,
      logger: silent(),
    });
    const listed = () =>
      published.statements
        .filter(({ sql }) => sql === catalogPublicMembershipMembersSql)
        .map(({ values }) => values![0]);
    const minute = (n: number) =>
      new Date(Date.parse("2026-10-23T00:00:00.000Z") + n * 60_000);
    // Nothing stored and no observation of its own: the App's record.
    await step.run(minute(0));
    expect(app.appBuckets).toHaveBeenCalledTimes(1);
    expect(listed()).toEqual([["0a"]]);
    // Its own observation is stored: only the bucket that changed since,
    // with no App aggregate, whatever else differs from the App's record.
    answers.buckets = [bucketRow("0a", 2, "5"), bucketRow("ff", 1, "7")];
    answers.at = minute(1);
    await step.run(minute(1));
    expect(app.appBuckets).toHaveBeenCalledTimes(1);
    expect(listed()).toEqual([["0a"], ["ff"]]);
    // A commit that fails keeps nothing: the next observation still
    // compares with the stored one, so the change is listed again.
    answers.buckets = [...answers.buckets, bucketRow("10", 1, "3")];
    answers.at = minute(2);
    failNext = true;
    await expect(step.run(minute(2))).rejects.toThrow(
      "synthetic commit failure",
    );
    answers.at = minute(3);
    await step.run(minute(3));
    expect(app.appBuckets).toHaveBeenCalledTimes(1);
    expect(listed()).toEqual([["0a"], ["ff"], ["10"], ["10"]]);
    // Another process stored an observation of its own (same totals, its
    // own time): the step no longer knows the stored buckets and compares
    // with the App's record again.
    stored = {
      public: { ...stored.public!, observedAt: minute(4) },
      private: null,
    };
    answers.buckets = [...answers.buckets, bucketRow("20", 1, "9")];
    answers.at = minute(5);
    await step.run(minute(5));
    expect(app.appBuckets).toHaveBeenCalledTimes(2);
    expect(listed().at(-1)).toEqual(["0a", "10", "20", "ff"]);
  });

  it("applies nothing above a snapshot ceiling or after a failed read", async () => {
    const logger = silent();
    const app = port();
    const huge = cms({
      buckets: [bucketRow("00", CATALOG_SNAPSHOT_MAX_SOURCES + 1, "1")],
    });
    await createCatalogMembershipWatch({
      published: huge.pool,
      prepare: null,
      port: app,
      logger,
    }).run(new Date());
    expect(logger.error).toHaveBeenCalledWith(
      `[media-worker] catalog membership skipped: above ceiling sources=${CATALOG_SNAPSHOT_MAX_SOURCES + 1}/${CATALOG_SNAPSHOT_MAX_SOURCES} intents=0/${CATALOG_SNAPSHOT_MAX_PRIVATE_ROWS}`,
    );
    expect(app.apply).not.toHaveBeenCalled();
    const failing = cms({
      buckets: [bucketRow("00", 1, "1")],
      fail: catalogPublicMembershipMembersSql,
    });
    await expect(
      createCatalogMembershipWatch({
        published: failing.pool,
        prepare: null,
        port: app,
        logger,
      }).run(new Date()),
    ).rejects.toThrow("synthetic");
    expect(app.apply).not.toHaveBeenCalled();
    expect(failing.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(failing.released).toHaveBeenCalledTimes(1);
    // A malformed aggregate is refused, never read as a partial fingerprint.
    const malformed = cms({ buckets: [bucketRow("zz", 1, "1")] });
    await expect(
      createCatalogMembershipWatch({
        published: malformed.pool,
        prepare: null,
        port: app,
        logger,
      }).run(new Date()),
    ).rejects.toThrow("Catalog membership fingerprint invalid");
    expect(app.apply).not.toHaveBeenCalled();
  });

  it("runs one observation at a time", async () => {
    let release: (() => void) | undefined;
    const app = port({
      readCatalogMembershipState: () =>
        new Promise((resolve) => {
          release = () => resolve({ public: null, private: null });
        }),
    });
    const watch = createCatalogMembershipWatch({
      published: cms({ buckets: [] }).pool,
      prepare: null,
      port: app,
      logger: silent(),
    });
    const first = watch.run(new Date());
    expect(watch.run(new Date())).toBe(first);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await first;
    expect(app.apply).toHaveBeenCalledTimes(1);
  });
});

describe("Catalog membership fingerprints and marks", () => {
  it("totals, compares and diffs bucketed fingerprints exactly", () => {
    const left = catalogMembershipBuckets([
      { bucket: "00", count: "2", sum: "1152921504606846975" },
      { bucket: "ab", count: 1, sum: "3" },
    ]);
    expect(catalogMembershipTotal(left)).toEqual({
      count: 3,
      sum: "1152921504606846978",
    });
    expect(catalogMembershipChanged(null, { count: 0, sum: "0" })).toBe(true);
    expect(
      catalogMembershipChanged(
        { count: 3, sum: "1152921504606846978" },
        catalogMembershipTotal(left),
      ),
    ).toBe(false);
    const right = catalogMembershipBuckets([
      { bucket: "00", count: 2, sum: "1152921504606846975" },
      { bucket: "ab", count: 1, sum: "4" },
      { bucket: "ff", count: 1, sum: "1" },
    ]);
    expect(differingCatalogMembershipBuckets(left, right)).toEqual([
      "ab",
      "ff",
    ]);
    for (const row of [
      { bucket: "0", count: 1, sum: "1" },
      { bucket: "00", count: 0, sum: "1" },
      { bucket: "00", count: 1, sum: "-1" },
      { bucket: "00", count: 1, sum: 1 },
    ])
      expect(() => catalogMembershipBuckets([row])).toThrow(TypeError);
    expect(() =>
      catalogMembershipBuckets([
        { bucket: "00", count: 1, sum: "1" },
        { bucket: "00", count: 1, sum: "1" },
      ]),
    ).toThrow(TypeError);
  });

  it("marks in one statement in asset id order, and refuses an invalid mark before any", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    const at = new Date("2026-10-23T00:00:00.000Z");
    const b = `catalog-asset-${"b".repeat(32)}`;
    const a = `catalog-asset-${"a".repeat(32)}`;
    expect(
      await markCatalogPublicationDirty(
        { query } as never,
        new Map([
          [b, "reference"],
          [a, "public_membership"],
        ] as const),
        at,
      ),
    ).toBe(2);
    expect(query).toHaveBeenCalledWith(catalogPublicationDirtyMarkSql, [
      [a, b],
      ["public_membership", "reference"],
      at.toISOString(),
    ]);
    query.mockClear();
    expect(
      await markCatalogPublicationDirty({ query } as never, new Map(), at),
    ).toBe(0);
    for (const marks of [
      new Map([["catalog-asset-x", "reference"]]),
      new Map([[a, "anything"]]),
    ])
      await expect(
        markCatalogPublicationDirty({ query } as never, marks as never, at),
      ).rejects.toThrow("Catalog publication mark invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
