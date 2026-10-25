import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { createCatalogRenderBacklog } from "@moya/backend-production/internal/catalog-delivery";
import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  catalogRenderBacklogWriteSql,
  PostgresCommunityCommentAdapter,
  PostgresCommunityIdentityAdapter,
} from "@moya/community-postgres";
import { catalogRenderBacklogSchema } from "@moya/contracts/internal/editorial";
import { UnconfiguredStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCatalogScaleDatabase,
  type CatalogScaleDatabase,
} from "./catalog-scale-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/*
 * catalog-scale-v1 (Issue #323) increment 2, I9 on real PostgreSQL: the
 * render-backlog operator route on the real Backend server, router and
 * handler, read by the restricted App role, which holds the runtime grants
 * only (infra/development/work-publishing/grant-runtime.sql; nothing is
 * granted for it). Every statement of the reader runs in a READ ONLY
 * transaction, and the rows it reads are unchanged after it.
 * - Only the operator credential is answered, and only GET.
 * - Before the first sync pass: no tiers and no time, and the live job
 *   counts.
 * - After a pass: its per-tier counts and time, and the base Catalog renders
 *   queued and running now (not a block render, a finished one or another
 *   kind), as the contract.
 * - A recorded count with a tier that is not a whole number of at least 0,
 *   or with a key that is no known tier: reported as never counted, never
 *   as 0.
 * Content is synthetic; no object store, CMS or network.
 */

const SLOW = 300_000;
const target = requireSyntheticTestDatabaseUrl();
type Pool = ReturnType<typeof createPostgresPool>;
const hex = (bytes = 16) => randomBytes(bytes).toString("hex");
const operatorCredential = `synthetic-operator-${hex()}`;
const countedAt = new Date("2026-10-23T12:00:00.000Z");
let fixture: CatalogScaleDatabase;
let server: Server | undefined;
let base = "";
const statements: string[] = [];

/** The pool's queries, each alone in a READ ONLY transaction: a write fails
 * with 25006 instead of changing anything. */
const readOnly = (pool: Pool) =>
  ({
    query: async (text: string, values?: unknown[]) => {
      statements.push(text);
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query(text, values);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  }) as unknown as Parameters<typeof createCatalogRenderBacklog>[0];

const backlog = (authorization: string | null = operatorCredential) =>
  fetch(`${base}/internal/community/catalog-delivery/render-backlog`, {
    headers:
      authorization === null
        ? {}
        : { authorization: `Bearer ${authorization}` },
  });

/** What the reader reads, to show it unchanged. */
const readRows = async () => ({
  state: (
    await fixture.setup.query(
      "SELECT * FROM community.catalog_reconcile_state ORDER BY 1",
    )
  ).rows,
  jobs: (
    await fixture.setup.query(
      "SELECT * FROM community.publishing_jobs ORDER BY id",
    )
  ).rows,
});

beforeAll(async () => {
  fixture = await createCatalogScaleDatabase({
    target,
    openPool: (url) =>
      createPostgresPool(parsePostgresConfig({ DATABASE_URL: url })),
    label: "csrb",
  });
  server = createBackendServer(
    createBackendApplication({
      nodeEnv: "test",
      communityIdentityPort: new PostgresCommunityIdentityAdapter(fixture.app),
      communityCommentPort: new PostgresCommunityCommentAdapter(fixture.app),
      communityOperatorCredential: operatorCredential,
      catalogRenderBacklog: createCatalogRenderBacklog(readOnly(fixture.app)),
      catalogQueryPort: createDevelopmentCatalogFixtureQueryPort(),
      storageUrlResolver: new UnconfiguredStorageUrlResolver(),
    }),
  );
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  base = `http://${address.address}:${address.port}`;
}, SLOW);

afterAll(async () => {
  try {
    server?.closeAllConnections();
    if (server) await stopServer(server);
  } finally {
    await fixture?.close();
  }
}, SLOW);

describe("Catalog render-backlog route on PostgreSQL (I9)", () => {
  it("answers only the operator credential, and only GET", async () => {
    for (const authorization of [null, `${operatorCredential}-other`]) {
      const answer = await backlog(authorization);
      expect(answer.status).toBe(401);
      expect(await answer.json()).toEqual({
        error: { status: 401, code: "OPERATOR_UNAUTHORIZED" },
      });
    }
    const post = await fetch(
      `${base}/internal/community/catalog-delivery/render-backlog`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorCredential}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(post.status).toBe(405);
    expect(statements).toEqual([]);
  });

  it("reports no tiers before the first sync pass, with the live job counts", async () => {
    const before = await readRows();
    const answer = await backlog();
    expect(answer.status).toBe(200);
    const body = catalogRenderBacklogSchema.parse(await answer.json());
    expect(body).toEqual({
      tiers: null,
      countedAt: null,
      queued: 0,
      running: 0,
    });
    expect(await readRows()).toEqual(before);
  });

  it("reports the last pass's tiers and the base renders queued and running now, read-only", async () => {
    await fixture.setup.query(catalogRenderBacklogWriteSql, [
      JSON.stringify({ t0: 3, t1: 2, t2: 40, t3: 1, t4: 1_200 }),
      countedAt,
    ]);
    const job = () => `publishing-job-${hex()}`;
    const asset = () => `catalog-asset-${hex()}`;
    await fixture.setup.query(
      `INSERT INTO community.publishing_jobs(id,kind,subject_id,payload,state,lease_owner,lease_expires_at,run_after,created_at,updated_at,finished_at)
       VALUES
         ($1,'catalog_render',$2,NULL,'queued',NULL,NULL,$15,$15,$15,NULL),
         ($3,'catalog_render',$4,'{"variant":"base"}'::jsonb,'queued',NULL,NULL,$15,$15,$15,NULL),
         ($5,'catalog_render',$6,NULL,'running','synthetic-worker',$15::timestamptz + interval '1 hour',$15,$15,$15,NULL),
         ($7,'catalog_render',$8,'{"variant":"blocks","masterId":"m","cells":[0]}'::jsonb,'queued',NULL,NULL,$15,$15,$15,NULL),
         ($9,'catalog_render',$10,NULL,'succeeded',NULL,NULL,$15,$15,$15,$15),
         ($11,'catalog_render',$12,NULL,'failed',NULL,NULL,$15,$15,$15,$15),
         ($13,'process_item',$14,NULL,'queued',NULL,NULL,$15,$15,$15,NULL)`,
      [
        job(),
        asset(),
        job(),
        asset(),
        job(),
        asset(),
        job(),
        asset(),
        job(),
        asset(),
        job(),
        asset(),
        job(),
        `media-item-${hex()}`,
        countedAt,
      ],
    );
    const before = await readRows();
    const reads = statements.length;
    const answer = await backlog();
    expect(answer.status).toBe(200);
    const body = catalogRenderBacklogSchema.parse(await answer.json());
    expect(body).toEqual({
      tiers: { t0: 3, t1: 2, t2: 40, t3: 1, t4: 1_200 },
      countedAt: countedAt.toISOString(),
      queued: 2,
      running: 1,
    });
    // One read, through the READ ONLY wrapper, and nothing changed.
    expect(statements.length).toBe(reads + 1);
    expect(await readRows()).toEqual(before);
  });

  it("reports a count it cannot read as whole tiers as never counted, never as 0", async () => {
    for (const recorded of [
      { t0: 3, t1: -1, t2: 40, t3: 1, t4: 1_200 },
      { t0: 3, t1: 2, t2: 0.5, t3: 1, t4: 1_200 },
      { t0: 3, t1: 2, t2: 40, t3: "1", t4: 1_200 },
      { t0: 3, t1: 2, t2: 40, t4: 1_200 },
      { t0: 3, t1: 2, t2: 40, t3: 1, t4: 1_200, t5: 500 },
    ]) {
      await fixture.setup.query(catalogRenderBacklogWriteSql, [
        JSON.stringify(recorded),
        countedAt,
      ]);
      const before = await readRows();
      const answer = await backlog();
      expect(answer.status, JSON.stringify(recorded)).toBe(200);
      expect(
        catalogRenderBacklogSchema.parse(await answer.json()),
      ).toMatchObject({ tiers: null, countedAt: null });
      expect(await readRows()).toEqual(before);
    }
  });

  it("runs the App role's read in a transaction that refuses writes", async () => {
    // The negative control of the wrapper the route's reader runs in: a
    // statement the App role may run (UPDATE of updated_at) is refused.
    await expect(
      readOnly(fixture.app).query(
        "UPDATE community.catalog_reconcile_state SET updated_at=now() WHERE id",
      ),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(
      fixture.app.query(
        "SELECT render_backlog, render_backlog_at FROM community.catalog_reconcile_state WHERE id",
      ),
    ).resolves.toBeTruthy();
  });
});
