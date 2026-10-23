import { createHash } from "node:crypto";

import {
  catalogMembershipRequestsSql,
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
  applyCatalogMembership,
  catalogMembershipBuckets,
  catalogMembershipChanged,
  catalogMembershipTotal,
  catalogPublicationDirtyMarkSql,
  differingCatalogMembershipBuckets,
  markCatalogPublicationDirty,
  readCatalogMembershipHolds,
} from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

/*
 * catalog-scale-v1 (Issue #323) 1B, W8: the worker's per-minute membership
 * step and the dirty-queue writer, over synthetic pools. The step reads one
 * aggregate per side in one CMS snapshot; only a side whose total changed
 * lists buckets (as App asset ids): those that changed since the step's own
 * committed observation while that is the one stored, or else those that
 * differ from the App's record. With a prepare reader and a listed public
 * bucket, the App mirror's release requests that hold a listed asset are
 * confirmed by id through the prepare reader in the same snapshot; a
 * confirmation that fails confirms none (logged, and the observation is
 * still applied). Above a snapshot ceiling, or on any other read error,
 * nothing is applied or kept; every CMS client is rolled back and released.
 * Marks are one statement in asset id order, and invalid ones are refused
 * before any statement. The PostgreSQL behaviour is in
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
  /** The release requests the CMS confirms. */
  readonly requests?: readonly Record<string, unknown>[];
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
    if (sql === catalogMembershipRequestsSql)
      return { rows: answers.requests ?? [] };
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
  readonly holds: ReturnType<typeof vi.fn>;
} => {
  const apply = vi.fn(async () => ({ public: 0, private: 0, boundaries: 0 }));
  const appBuckets = vi.fn(async () => new Map());
  const holds = vi.fn(async (): Promise<readonly string[]> => []);
  return {
    readCatalogMembershipState: async () => ({ public: null, private: null }),
    readCatalogMembershipAppBuckets: appBuckets,
    readCatalogMembershipHolds: holds,
    applyCatalogMembership: apply,
    apply,
    appBuckets,
    holds,
    ...overrides,
  };
};
const silent = () => ({ info: vi.fn(), error: vi.fn() });
/** A recipe policy (the step passes it on; nothing here hashes a manifest). */
const POLICY = "c".repeat(64);

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
      policy: POLICY,
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
    expect(app.holds).not.toHaveBeenCalled();
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
      policy: POLICY,
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
    // The App mirror holds no request for the listed buckets: nothing to
    // confirm, and no pin keeps an asset unmarked.
    expect(app.holds).toHaveBeenCalledWith(
      ["10", "ff"],
      new Date("2026-10-23T00:00:00.000Z"),
      POLICY,
    );
    expect(observation.requests).toEqual({ policy: POLICY, intentIds: [] });
  });

  it("confirms the App mirror's requests that hold a listed asset in the observation's own snapshot, and none after a failed read", async () => {
    const at = new Date("2026-10-23T00:00:00.000Z");
    const held = [
      "0a1b2c3d-0000-4000-8000-000000000001",
      "ff1b2c3d-0000-4000-8000-000000000002",
    ];
    const logger = silent();
    const app = port();
    const run = (prepare: ReturnType<typeof cms>) =>
      createCatalogMembershipWatch({
        published: cms({ buckets: [bucketRow("0a", 2, "5")] }).pool,
        prepare: prepare.pool,
        policy: POLICY,
        port: app,
        logger,
      }).run(new Date());
    // The CMS confirms one of the two: the other has ended (or lapsed, or
    // is of another policy) since the sync last wrote the mirror.
    const prepare = cms({ buckets: [], requests: [{ intent_id: held[1] }] });
    app.holds.mockResolvedValueOnce(held);
    await run(prepare);
    expect(app.holds).toHaveBeenLastCalledWith(["0a"], at, POLICY);
    expect(prepare.statements).toEqual([
      { sql: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" },
      { sql: "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'" },
      { sql: catalogPrivateMembershipBucketsSql },
      {
        sql: catalogMembershipRequestsSql,
        values: [held, at.toISOString(), POLICY],
      },
      { sql: "ROLLBACK" },
    ]);
    expect(app.apply.mock.calls.at(-1)![0].requests).toEqual({
      policy: POLICY,
      intentIds: [held[1]],
    });
    expect(logger.error).not.toHaveBeenCalled();
    // A confirmation that fails, in the CMS or in the App, confirms none:
    // the observation is applied without requests (no pin keeps an asset
    // unmarked), and the failure is logged without content.
    for (const [failing, read] of [
      [cms({ buckets: [], fail: catalogMembershipRequestsSql }), held],
      [cms({ buckets: [] }), new Error("synthetic")],
    ] as const) {
      if (read instanceof Error) app.holds.mockRejectedValueOnce(read);
      else app.holds.mockResolvedValueOnce(read);
      const applied = app.apply.mock.calls.length;
      await run(failing);
      expect(app.apply).toHaveBeenCalledTimes(applied + 1);
      expect(app.apply.mock.calls.at(-1)![0]).not.toHaveProperty("requests");
      expect(failing.statements.at(-1)?.sql).toBe("ROLLBACK");
      expect(failing.released).toHaveBeenCalledTimes(1);
    }
    expect(logger.error.mock.calls).toEqual([
      ["[media-worker] catalog membership requests unconfirmed"],
      ["[media-worker] catalog membership requests unconfirmed"],
    ]);
    // No listed public bucket (the stored totals match): nothing is read
    // or confirmed.
    const reads = app.holds.mock.calls.length;
    const unchanged = cms({ buckets: [] });
    await createCatalogMembershipWatch({
      published: cms({ buckets: [bucketRow("0a", 2, "5")] }).pool,
      prepare: unchanged.pool,
      policy: POLICY,
      port: {
        ...app,
        readCatalogMembershipState: async () => ({
          public: { count: 2, sum: "5", observedAt: at },
          private: { count: 0, sum: "0", observedAt: at },
        }),
      },
      logger,
    }).run(new Date());
    expect(app.holds).toHaveBeenCalledTimes(reads);
    expect(unchanged.statements.map(({ sql }) => sql)).not.toContain(
      catalogMembershipRequestsSql,
    );
    expect(app.apply.mock.calls.at(-1)![0]).not.toHaveProperty("requests");
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
      policy: POLICY,
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
      policy: POLICY,
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
        policy: POLICY,
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
        policy: POLICY,
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
      policy: POLICY,
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

  it("refuses malformed confirmed requests or a malformed holds read before any statement", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connect = vi.fn();
    const pool = { query, connect } as never;
    const observation = {
      observedAt: new Date("2026-10-23T00:00:00.000Z"),
      previous: { public: null, private: null },
      public: { count: 0, sum: "0", diff: null },
      private: { count: 0, sum: "0", diff: null },
    };
    for (const requests of [
      { policy: "c".repeat(63), intentIds: [] },
      { policy: POLICY.toUpperCase(), intentIds: [] },
      { policy: POLICY, intentIds: ["not-a-uuid"] },
      { policy: POLICY, intentIds: ["0A1B2C3D-0000-4000-8000-000000000001"] },
      { policy: POLICY, intentIds: "0a1b2c3d-0000-4000-8000-000000000001" },
    ])
      await expect(
        applyCatalogMembership(
          pool,
          { ...observation, requests } as never,
          new Date(),
        ),
      ).rejects.toThrow("Catalog membership observation invalid");
    for (const [buckets, policy] of [
      [["zz"], POLICY],
      [["0a"], "c".repeat(63)],
    ] as const)
      await expect(
        readCatalogMembershipHolds(pool, buckets, new Date(), policy),
      ).rejects.toThrow("Catalog membership observation invalid");
    // No bucket, no read.
    expect(
      await readCatalogMembershipHolds(pool, [], new Date(), POLICY),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("marks in one statement in asset id order, each with its class, and refuses an invalid mark before any", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    const at = new Date("2026-10-23T00:00:00.000Z");
    const b = `catalog-asset-${"b".repeat(32)}`;
    const a = `catalog-asset-${"a".repeat(32)}`;
    expect(
      await markCatalogPublicationDirty(
        { query } as never,
        new Map([
          [b, { reason: "reference", urgent: false }],
          [a, { reason: "public_membership", urgent: true }],
        ] as const),
        at,
      ),
    ).toBe(2);
    expect(query).toHaveBeenCalledWith(catalogPublicationDirtyMarkSql, [
      [a, b],
      ["public_membership", "reference"],
      [true, false],
      at.toISOString(),
    ]);
    query.mockClear();
    expect(
      await markCatalogPublicationDirty({ query } as never, new Map(), at),
    ).toBe(0);
    for (const marks of [
      new Map([["catalog-asset-x", { reason: "reference", urgent: false }]]),
      new Map([[a, { reason: "anything", urgent: false }]]),
      new Map([[a, { reason: "reference", urgent: "yes" }]]),
      new Map([[a, "reference"]]),
    ])
      await expect(
        markCatalogPublicationDirty({ query } as never, marks as never, at),
      ).rejects.toThrow("Catalog publication mark invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
