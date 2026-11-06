/**
 * admin-mcp-completion-v1 S4: canonical analytics through real HTTP, under the real
 * runtime App role, on a disposable database of its own. Reports read the whole
 * events table, so a shared database could not give an exact answer; this one starts
 * empty and passes the same on a used server. Every oracle below is computed from the
 * seeded rows, never through a report.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAnalyticsAdapter,
  PostgresAnalyticsInsights,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryCommunityIdentityPort } from "../../unit/backend/community-identity-fixture.js";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname))
  throw Error("Loopback synthetic database required");
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);

const suffix = randomBytes(6).toString("hex");
const database = `insights_${suffix}_synthetic_test`;
const role = `insights_${suffix}`;
const admin = poolFor(target);
let setup: Pool;
let app: Pool;
let createdDatabase = false;
let createdRole = false;

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const baseToken = syntheticToken();

const id32 = () => randomUUID().replaceAll("-", "");

/** A Wednesday, noon in Asia/Shanghai. */
const now = new Date("2026-03-11T04:00:00.000Z");
const cst = (wall: string) => new Date(`${wall}+08:00`);

const author = `user-${id32()}`;
const authorHandle = `insights-${suffix}`;
const reader = `user-${id32()}`;
const readerHandle = `reader-${suffix}`;
const canary = `CANARY-${id32()}`;
const work = (name: string) => ({ name, id: `work-${id32()}` });
const works = {
  first: work("合成作品甲"),
  second: work("合成作品乙"),
  third: work("合成作品丙"),
  gone: work("合成作品消失"),
  selfOnly: work(canary),
  deleted: work(""),
  trashed: work("合成作品回收"),
};
const catalogId = `catalog-${id32()}`;
const articleId = `article-${id32()}`;
const withdrawnArticleId = `article-${id32()}`;
const withdrawnTitle = `合成已撤回文章 ${id32()}`;

interface Seed {
  readonly visitor: string;
  readonly session: string;
  readonly user: string | null;
  readonly name: string;
  readonly surface: string;
  readonly type: string | null;
  readonly id: string | null;
  readonly at: Date;
  readonly received?: Date;
  readonly data?: Readonly<Record<string, unknown>>;
}

const visitor = () => randomUUID();
const seeded: Seed[] = [];
const event = (
  fields: Omit<Seed, "session" | "user" | "surface" | "name"> &
    Partial<Pick<Seed, "session" | "user" | "surface" | "name">>,
) => {
  seeded.push({
    session: fields.visitor,
    user: null,
    surface: "detail",
    name: "page_view",
    ...fields,
  });
};
const views = (
  count: number,
  type: string,
  id: string,
  wall: string,
  visitors: readonly string[] = [visitor()],
) => {
  for (let index = 0; index < count; index += 1)
    event({
      visitor: visitors[index % visitors.length]!,
      type,
      id,
      at: cst(wall),
    });
};

// A1: the 23:59 and 00:01 edges of each day around yesterday, 10 March.
const boundary = { a: visitor(), b: visitor(), c: visitor(), d: visitor() };
event({
  visitor: boundary.a,
  type: "work",
  id: works.first.id,
  at: cst("2026-03-09T23:59:00"),
});
event({
  visitor: boundary.a,
  type: "work",
  id: works.first.id,
  at: cst("2026-03-10T00:01:00"),
});
event({
  visitor: boundary.b,
  type: "work",
  id: works.second.id,
  at: cst("2026-03-10T23:59:00"),
});
event({
  visitor: boundary.b,
  type: "work",
  id: works.second.id,
  at: cst("2026-03-10T23:59:30"),
  // The client's clock says yesterday; the Backend heard it much later.
  received: cst("2026-03-11T11:00:00"),
});
event({
  visitor: boundary.c,
  type: "work",
  id: works.second.id,
  at: cst("2026-03-11T00:01:00"),
});

// A2 and A4: the last seven finished days are 4 to 10 March.
views(12, "work", works.first.id, "2026-03-05T10:00:00");
views(9, "work", works.second.id, "2026-03-06T10:00:00");
views(7, "catalog", catalogId, "2026-03-07T10:00:00");
views(5, "article", articleId, "2026-03-07T11:00:00");
views(4, "work", works.deleted.id, "2026-03-07T12:00:00");
views(3, "work", works.third.id, "2026-03-07T13:00:00");
views(2, "work", works.trashed.id, "2026-03-08T09:00:00");
views(1, "article", withdrawnArticleId, "2026-03-08T09:30:00");
views(6, "work", works.selfOnly.id, "2026-03-05T14:00:00");
for (let index = 0; index < 8; index += 1)
  event({
    visitor: visitor(),
    surface: "home",
    type: null,
    id: null,
    at: cst("2026-03-06T08:00:00"),
  });

// Which content dropped most, last week (2 to 8 March) against the week before.
views(25, "work", works.third.id, "2026-02-25T10:00:00");
views(4, "work", works.gone.id, "2026-02-26T10:00:00");
views(3, "work", works.selfOnly.id, "2026-02-26T11:00:00");
views(2, "work", works.first.id, "2026-02-24T10:00:00");

// Partial period: this week so far is Monday 9 March to Wednesday noon.
views(2, "work", works.first.id, "2026-03-03T11:59:00");
views(5, "work", works.first.id, "2026-03-04T13:00:00");

// A3: weeks across the last thirty finished days, 9 February to 10 March.
views(40, "catalog", catalogId, "2026-02-17T10:00:00");
views(6, "catalog", catalogId, "2026-02-10T10:00:00");

// A unique count across buckets: the same visitor on two days.
const twoDays = visitor();
event({
  visitor: twoDays,
  type: "work",
  id: works.first.id,
  at: cst("2026-02-12T10:00:00"),
});
event({
  visitor: twoDays,
  type: "work",
  id: works.first.id,
  at: cst("2026-02-13T10:00:00"),
});

// sameTarget: both visitors open something after an impression in one session.
const funnelSame = visitor();
const funnelCross = visitor();
const funnelStamp = "2026-01-20T";
event({
  visitor: funnelSame,
  name: "content_impression",
  type: "work",
  id: works.first.id,
  at: cst(`${funnelStamp}10:00:00`),
});
event({
  visitor: funnelSame,
  name: "content_open",
  type: "work",
  id: works.first.id,
  at: cst(`${funnelStamp}10:01:00`),
});
event({
  visitor: funnelCross,
  name: "content_impression",
  type: "work",
  id: works.first.id,
  at: cst(`${funnelStamp}10:00:00`),
});
event({
  visitor: funnelCross,
  name: "content_open",
  type: "work",
  id: works.second.id,
  at: cst(`${funnelStamp}10:01:00`),
});

// One visitor's timeline, with a signed-in account and a self-only work in it.
const timeline = visitor();
const timelineSession = randomUUID();
const timelineSecond = randomUUID();
const stamp = (minute: string) => cst(`2026-02-03T10:${minute}:00`);
for (const minute of ["00", "01", "02"])
  event({
    visitor: timeline,
    session: timelineSession,
    user: reader,
    name: "content_impression",
    surface: "browse",
    type: "work",
    id: works.first.id,
    at: stamp(minute),
    data: { position: 1 },
  });
event({
  visitor: timeline,
  session: timelineSession,
  user: reader,
  name: "content_open",
  type: "work",
  id: works.selfOnly.id,
  at: stamp("03"),
  data: { position: 2 },
});
event({
  visitor: timeline,
  session: timelineSession,
  user: reader,
  name: "content_dwell",
  type: "work",
  id: works.selfOnly.id,
  at: stamp("04"),
  data: { dwellMs: 900 },
});
event({
  visitor: timeline,
  session: timelineSession,
  user: reader,
  name: "search",
  surface: "search",
  type: null,
  id: null,
  at: stamp("05"),
  data: { searchQuery: "合成检索" },
});
event({
  visitor: timeline,
  session: timelineSecond,
  user: reader,
  type: "catalog",
  id: catalogId,
  at: stamp("30"),
});

// Product: positions, dwell and search on one day of their own, as the client sends
// them: an impression names its listing, and the open after it is recorded on detail.
const product = "2026-01-27T";
const opener = visitor();
[0, 0, 0, 3, 12].forEach((position, index) => {
  event({
    visitor: index === 0 ? opener : visitor(),
    name: "content_impression",
    surface: "browse",
    type: "work",
    id: works.first.id,
    at: cst(`${product}09:00:00`),
    data: { position },
  });
});
event({
  visitor: opener,
  name: "content_open",
  type: "work",
  id: works.first.id,
  at: cst(`${product}09:01:00`),
  data: { position: 0 },
});
const selfOnlyOpener = visitor();
event({
  visitor: selfOnlyOpener,
  name: "content_impression",
  surface: "browse",
  type: "work",
  id: works.selfOnly.id,
  at: cst(`${product}09:02:00`),
  data: { position: 1 },
});
event({
  visitor: selfOnlyOpener,
  name: "content_open",
  type: "work",
  id: works.selfOnly.id,
  at: cst(`${product}09:03:00`),
  data: { position: 1 },
});
// The same work at the same position on two listings: the later one is where it was tapped.
const twoListings = visitor();
for (const [surface, second] of [
  ["home", "10"],
  ["browse", "20"],
] as const)
  event({
    visitor: twoListings,
    name: "content_impression",
    surface,
    type: "work",
    id: works.first.id,
    at: cst(`${product}09:03:${second}`),
    data: { position: 7 },
  });
event({
  visitor: twoListings,
  name: "content_open",
  type: "work",
  id: works.first.id,
  at: cst(`${product}09:03:30`),
  data: { position: 7 },
});
// Tapped inside the impression timer: an open with no impression to go to.
event({
  visitor: visitor(),
  name: "content_open",
  type: "work",
  id: works.second.id,
  at: cst(`${product}09:03:40`),
  data: { position: 5 },
});
for (const dwellMs of [100, 200, 300, 400, 500])
  event({
    visitor: visitor(),
    name: "content_dwell",
    type: "work",
    id: works.second.id,
    at: cst(`${product}09:04:00`),
    data: { dwellMs },
  });
for (const searchQuery of ["合成甲", "合成甲", "合成乙"])
  event({
    visitor: visitor(),
    name: "search",
    surface: "search",
    type: null,
    id: null,
    at: cst(`${product}09:05:00`),
    data: { searchQuery },
  });
event({
  visitor: visitor(),
  name: "search_click",
  surface: "search",
  type: "work",
  id: works.first.id,
  at: cst(`${product}09:06:00`),
});
for (const name of ["like", "like", "favorite", "follow"])
  event({
    visitor: visitor(),
    name,
    type: "work",
    id: works.first.id,
    at: cst(`${product}09:07:00`),
  });

// Tapped again after Back, on a day of its own: one impression and three opens.
const retapDay = "2026-01-29T";
const retapper = visitor();
event({
  visitor: retapper,
  name: "content_impression",
  surface: "search",
  type: "work",
  id: works.first.id,
  at: cst(`${retapDay}09:00:00`),
  data: { position: 8 },
});
for (const second of ["10", "20", "30"])
  event({
    visitor: retapper,
    name: "content_open",
    type: "work",
    id: works.first.id,
    at: cst(`${retapDay}09:01:${second}`),
    data: { position: 8 },
  });

// Dwell: one read split by two tab switches, and the same session on another work.
const dwellDay = "2026-01-28T";
const splitReader = visitor();
for (const dwellMs of [1_000, 2_000, 3_000])
  event({
    visitor: splitReader,
    name: "content_dwell",
    type: "work",
    id: works.first.id,
    at: cst(`${dwellDay}09:00:00`),
    data: { dwellMs },
  });
event({
  visitor: splitReader,
  name: "content_dwell",
  type: "work",
  id: works.second.id,
  at: cst(`${dwellDay}09:01:00`),
  data: { dwellMs: 500 },
});
event({
  visitor: visitor(),
  name: "content_dwell",
  type: "work",
  id: works.first.id,
  at: cst(`${dwellDay}09:02:00`),
  data: { dwellMs: 1_000 },
});

// Realtime: heard within the last five minutes of noon.
const onlineVisitor = visitor();
const onlineSelfOnly = visitor();
const heard = (minutesAgo: number) =>
  new Date(now.getTime() - minutesAgo * 60_000);
event({
  visitor: onlineVisitor,
  user: reader,
  type: "work",
  id: works.first.id,
  at: heard(1),
  received: heard(1),
});
event({
  visitor: onlineVisitor,
  user: reader,
  type: "work",
  id: works.first.id,
  at: heard(4),
  received: heard(4),
});
event({
  visitor: onlineSelfOnly,
  type: "work",
  id: works.selfOnly.id,
  at: heard(2),
  received: heard(2),
});

// Holds the store's first row, so periods above sit inside the data this store has.
event({
  visitor: visitor(),
  type: "work",
  id: works.first.id,
  at: cst("2025-12-01T10:00:00"),
});

const ipCanary = "198.51.100.77";

const inPeriod = (seed: Seed, start: Date, end: Date) =>
  seed.at >= start && seed.at < end;
const between = (start: Date, end: Date, name: string | null = "page_view") =>
  seeded.filter(
    (seed) =>
      inPeriod(seed, start, end) && (name === null || seed.name === name),
  );
const uniqueCount = (rows: readonly Seed[], key: "visitor" | "session") =>
  new Set(rows.map((row) => row[key])).size;
const hitsByKey = (rows: readonly Seed[]) => {
  const hits = new Map<string, number>();
  for (const row of rows)
    if (row.id !== null) {
      const key = `${row.type}:${row.id}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  return hits;
};
const selfOnlyKey = () => `work:${works.selfOnly.id}`;
const keyOf = (row: Json) => `${row.target.type}:${row.target.id}`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let server: Server | undefined;
let origin = "";
const statements: string[] = [];

const get = async (
  report: string,
  query: Readonly<Record<string, string>> = {},
  token = baseToken,
) => {
  const response = await fetch(
    `${origin}/internal/analytics/insights/${report}?${new URLSearchParams(query)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return {
    status: response.status,
    body: (await response.json()) as Json,
  };
};
const ok = async (
  report: string,
  query: Readonly<Record<string, string>> = {},
): Promise<Json> => {
  const { status, body } = await get(report, query);
  expect(status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body;
};

beforeAll(async () => {
  const probe = await admin.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    decodeURI(new URL(target).pathname.slice(1)),
  );
  const password = randomBytes(32).toString("hex");
  await admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  createdRole = true;
  await admin.query(`CREATE DATABASE ${database}`);
  createdDatabase = true;
  const url = new URL(target);
  url.pathname = `/${database}`;
  setup = poolFor(url.toString());
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  await setup.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
  const grants = await readFile(
    `${root}/infra/development/work-publishing/grant-runtime.sql`,
    "utf8",
  );
  await setup.query(grants.replaceAll(':"app_role"', `"${role}"`));
  url.username = role;
  url.password = password;
  app = poolFor(url.toString());

  for (const [id, handle, name] of [
    [author, authorHandle, "合成作者"],
    [reader, readerHandle, "合成读者"],
  ] as const)
    await setup.query(
      "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,$3)",
      [id, handle, name],
    );
  const sha = "a".repeat(64);
  for (const entry of [
    works.first,
    works.second,
    works.third,
    works.gone,
    works.trashed,
  ])
    // The legacy bridge gives each of these its public revision.
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,'合成正文',$4::timestamptz)",
      [entry.id, author, entry.name, now],
    );
  await setup.query(
    "UPDATE community.works SET trashed_at=$1::timestamptz, trash_purge_after=$1::timestamptz+INTERVAL '30 days' WHERE id=$2",
    [now, works.trashed.id],
  );
  // Self-only: its title and text are the canary.
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,visibility,created_via) VALUES($1,$2,$3,$3,'self','publishing')",
    [works.selfOnly.id, author, canary],
  );
  // Permanent deletion also sets visibility to self and empties the work.
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,visibility,deleted_at,created_via) VALUES($1,$2,'','','self',$3::timestamptz,'publishing')",
    [works.deleted.id, author, now],
  );
  await setup.query(
    "INSERT INTO public.catalog_discovery(catalog_id,title) VALUES($1,'合成资料')",
    [catalogId],
  );
  const document = JSON.stringify({
    format: "blocknote",
    version: 1,
    blocks: [],
  });
  // The published revision's foreign key is deferred, so one transaction holds both.
  const articleClient = await setup.connect();
  try {
    await articleClient.query("BEGIN");
    await articleClient.query(
      `INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,status,published_version,first_published_at,published_at,created_at,updated_at)
      VALUES($1,$2,2,'合成文章草稿',$3::jsonb,$4,'published',1,$5::timestamptz,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
      [articleId, author, document, sha, now],
    );
    await articleClient.query(
      `INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at)
      VALUES($1,1,$2,'合成文章',$3::jsonb,$4,'DIRECT_PUBLICATION','human',$5::timestamptz)`,
      [articleId, author, document, sha, now],
    );
    // Withdrawn: the revision stays, and the document no longer points at it.
    await articleClient.query(
      `INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,status,first_published_at,created_at,updated_at)
      VALUES($1,$2,2,$3,$4::jsonb,$5,'withdrawn',$6::timestamptz,$6::timestamptz,$6::timestamptz)`,
      [withdrawnArticleId, author, withdrawnTitle, document, sha, now],
    );
    await articleClient.query(
      `INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at)
      VALUES($1,1,$2,$3,$4::jsonb,$5,'DIRECT_PUBLICATION','human',$6::timestamptz)`,
      [withdrawnArticleId, author, withdrawnTitle, document, sha, now],
    );
    await articleClient.query("COMMIT");
  } finally {
    articleClient.release();
  }
  await setup.query(
    `INSERT INTO community.analytics_events(event_id,visitor_id,session_id,user_id,distinct_id,event_name,target_type,target_id,surface,event_data,occurred_at,received_at)
    SELECT r.event_id,r.visitor_id,r.session_id,r.user_id,r.distinct_id,r.name,r.type,r.id,r.surface,r.data,r.at,r.received
    FROM jsonb_to_recordset($1::jsonb) AS r(event_id uuid,visitor_id uuid,session_id uuid,user_id text,distinct_id text,name text,type text,id text,surface text,data jsonb,at timestamptz,received timestamptz)`,
    [
      JSON.stringify(
        seeded.map((seed) => ({
          event_id: randomUUID(),
          visitor_id: seed.visitor,
          session_id: seed.session,
          user_id: seed.user,
          distinct_id: "d".repeat(39) + (seed.user === null ? "0" : "1"),
          name: seed.name,
          type: seed.type,
          id: seed.id,
          surface: seed.surface,
          data: { name: seed.name, ...seed.data },
          at: seed.at.toISOString(),
          received: (seed.received ?? seed.at).toISOString(),
        })),
      ),
    ],
  );
  await setup.query(
    `INSERT INTO community.analytics_ip_observations(id,visitor_id,user_id,ip,user_agent,received_at,expires_at)
    VALUES($1,$2,$3,$4::inet,'synthetic agent',$5::timestamptz,$5::timestamptz+INTERVAL '60 days')`,
    [randomUUID(), timeline, reader, ipCanary, stamp("00")],
  );
  await setup.query(
    "INSERT INTO community.content_relations(user_id,content_type,content_id,relation,created_at) VALUES($1,'work',$2,'like',$3::timestamptz),($1,'work',$2,'favorite',$3::timestamptz)",
    [reader, works.first.id, cst(`${product}10:00:00`)],
  );
  await setup.query(
    "INSERT INTO community.follows(follower_id,followed_id,created_at) VALUES($1,$2,$3::timestamptz)",
    [reader, author, cst(`${product}10:00:00`)],
  );

  // Records what the reader sends, on the real App-role connection.
  const recording = new Proxy(app, {
    get(pool, property) {
      if (property !== "connect") return Reflect.get(pool, property) as unknown;
      return async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        return new Proxy(client, {
          get(target, name) {
            if (name !== "query")
              return Reflect.get(target, name) as (...args: never) => unknown;
            return (text: string, values?: unknown[]) => {
              statements.push(text);
              return query(text, values as never);
            };
          },
        });
      };
    },
  }) as Pool;

  const application = createBackendApplication({
    nodeEnv: "development",
    communityIdentityPort: new InMemoryCommunityIdentityPort(),
    storageUrlResolver: new MappedStorageUrlResolver(new Map()),
    communityOperatorCredential: ownerToken,
    operatorAiBaseCredential: baseToken,
    analytics: {
      port: new PostgresAnalyticsAdapter(app),
      policy: {
        enabled: false,
        production: false,
        excludedUserIds: new Set(),
        ownerExclusionConfigured: false,
        hmacKey: "",
        forwardingConfigured: false,
        eventRetentionDays: 180,
      },
      insights: new PostgresAnalyticsInsights(recording, {
        retentionDays: 180,
        now: () => now,
      }),
    },
  });
  server = createBackendServer(application);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  if (server) await stopServer(server);
  await app?.end();
  await setup?.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
  if (createdRole) await admin.query(`DROP ROLE ${role}`);
  await admin.end();
});

describe("known answers on the reference paths", () => {
  it("keeps the overview near its 2 KB target", async () => {
    const body = await ok("overview", { range: "last_7_days" });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(2_048);
  });

  it("A1: yesterday's visitors, sessions and views against the day before, by 23:59 and 00:01 in Beijing time", async () => {
    const start = cst("2026-03-10T00:00:00");
    const end = cst("2026-03-11T00:00:00");
    const before = cst("2026-03-09T00:00:00");
    const body = await ok("overview", { range: "yesterday" });
    const current = between(start, end);
    const previous = between(before, start);
    // Both edges of the 10th count; the 23:59 before it and the 00:01 after do not.
    expect(current.some((row) => row.visitor === boundary.a)).toBe(true);
    expect(current.some((row) => row.visitor === boundary.c)).toBe(false);
    expect(body.range).toMatchObject({
      start: start.toISOString(),
      end: end.toISOString(),
      tz: "Asia/Shanghai",
      complete: true,
    });
    expect(body.compare).toMatchObject({
      start: before.toISOString(),
      end: start.toISOString(),
      mode: "previous",
    });
    expect(body.compare).not.toHaveProperty("aligned");
    expect(body.compare).not.toHaveProperty("outOfRetention");
    expect(body.range).not.toHaveProperty("requestedEnd");
    expect(body.metrics.pageViews).toEqual({
      v: current.length,
      prev: previous.length,
      delta: current.length - previous.length,
      pct:
        Math.round(
          ((current.length - previous.length) / previous.length) * 10_000,
        ) / 100,
      additive: true,
      ...(previous.length < 30 ? { lowBase: true } : {}),
    });
    expect(body.metrics.visitorsPageView).toMatchObject({
      v: uniqueCount(current, "visitor"),
      prev: uniqueCount(previous, "visitor"),
      additive: false,
    });
    expect(body.metrics.canonicalSessions).toMatchObject({
      v: uniqueCount(between(start, end, null), "session"),
      additive: false,
    });
    expect(body.source).toBe("canonical");
    expect(body.asOf).toBe(now.toISOString());
  });

  it("A2: the last seven finished days' top five content in order", async () => {
    const start = cst("2026-03-04T00:00:00");
    const end = cst("2026-03-11T00:00:00");
    const rows = between(start, end);
    const hits = hitsByKey(rows);
    const self = hits.get(selfOnlyKey())!;
    hits.delete(selfOnlyKey());
    const expected = [...hits.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5);
    const body = await ok("breakdown", {
      range: "last_7_days",
      dimension: "content",
      limit: "5",
    });
    expect(body.rows.map((row: Json) => [keyOf(row), row.count])).toEqual(
      expected,
    );
    expect(body.total).toBe(rows.length);
    expect(body.withheld).toMatchObject({ reason: "self_only", count: self });
    expect(body.unknown.count).toBe(
      rows.filter((row) => row.id === null).length,
    );
    expect(body.totalVisitors).toBe(uniqueCount(rows, "visitor"));
  });

  it("A3: the last thirty finished days by week, the highest and how far above the lowest", async () => {
    const start = cst("2026-02-09T00:00:00");
    const end = cst("2026-03-11T00:00:00");
    const weeks = new Map<string, number>();
    for (const row of between(start, end)) {
      const local = new Date(row.at.getTime() + 8 * 3_600_000);
      const monday = new Date(local);
      monday.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
      const label = monday.toISOString().slice(0, 10);
      weeks.set(label, (weeks.get(label) ?? 0) + 1);
    }
    const body = await ok("trend", { range: "last_30_days", groupBy: "week" });
    const read = new Map(
      body.buckets.map((bucket: Json) => [bucket.label, bucket.pageViews]),
    );
    for (const [label, count] of weeks)
      expect(read.get(label), label).toBe(count);
    const values = body.buckets.map((bucket: Json) => bucket.pageViews);
    expect(Math.max(...values)).toBe(Math.max(...weeks.values()));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0);
    expect(body.groupBy).toBe("week");
  });

  it("A4: the most viewed work names its author and its state", async () => {
    const start = cst("2026-03-04T00:00:00");
    const end = cst("2026-03-11T00:00:00");
    const works7 = between(start, end).filter(
      (row) => row.type === "work" && row.id !== works.selfOnly.id,
    );
    const hits = hitsByKey(works7);
    const [topKey] = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const body = await ok("breakdown", {
      range: "last_7_days",
      dimension: "content",
      limit: "1",
    });
    expect(keyOf(body.rows[0])).toBe(topKey);
    expect(body.rows[0].target).toEqual({
      type: "work",
      id: works.first.id,
      title: works.first.name,
      authorHandle,
      state: "public",
    });
  });
});

describe("time zones, ranges and alignment", () => {
  it("assigns the same events to different days in a different time zone", async () => {
    const shanghai = await ok("overview", {
      from: "2026-03-09",
      to: "2026-03-09",
    });
    const utc = await ok("overview", {
      from: "2026-03-09",
      to: "2026-03-09",
      tz: "UTC",
    });
    expect(shanghai.metrics.pageViews.v).toBe(
      between(cst("2026-03-09T00:00:00"), cst("2026-03-10T00:00:00")).length,
    );
    expect(utc.metrics.pageViews.v).toBe(
      between(
        new Date("2026-03-09T00:00:00Z"),
        new Date("2026-03-10T00:00:00Z"),
      ).length,
    );
    expect(utc.metrics.pageViews.v).not.toBe(shanghai.metrics.pageViews.v);
    expect(utc.range.tz).toBe("UTC");
  });

  it("counts an event by when it happened, though the Backend heard it much later", async () => {
    const body = await ok("breakdown", {
      from: "2026-03-10T23:59:15+08:00",
      to: "2026-03-10T23:59:45+08:00",
      dimension: "surface",
    });
    expect(body.total).toBe(1);
  });

  it("never sums unique counts across buckets", async () => {
    const body = await ok("trend", {
      from: "2026-02-12",
      to: "2026-02-13",
      groupBy: "day",
      targetType: "work",
      targetId: works.first.id,
    });
    expect(body.buckets.map((bucket: Json) => bucket.visitorsPageView)).toEqual(
      [1, 1],
    );
    expect(body.totals.visitorsPageView).toBe(1);
    expect(body.totals.pageViews).toBe(2);
  });

  it("aligns a partial week to elapsed time and marks it", async () => {
    const start = cst("2026-03-09T00:00:00");
    const before = cst("2026-03-02T00:00:00");
    const alignedEnd = cst("2026-03-04T12:00:00");
    const body = await ok("overview", { range: "this_week" });
    expect(body.range).toMatchObject({
      start: start.toISOString(),
      end: now.toISOString(),
      requestedEnd: cst("2026-03-16T00:00:00").toISOString(),
      complete: false,
    });
    expect(body.compare).toMatchObject({
      start: before.toISOString(),
      end: alignedEnd.toISOString(),
      aligned: true,
    });
    expect(body.notes).toContain("PARTIAL_PERIOD_ALIGNED");
    expect(body.metrics.pageViews.v).toBe(between(start, now).length);
    // The 13:00 Wednesday views last week are past the aligned end.
    expect(body.metrics.pageViews.prev).toBe(
      between(before, alignedEnd).length,
    );
    expect(between(before, alignedEnd).length).toBeLessThan(
      between(before, cst("2026-03-05T00:00:00")).length,
    );
  });

  it("answers outOfRetention beyond retention, never a false zero, though older rows linger", async () => {
    // Retention deletes in batches, so the store's first row can be older than the
    // window. A year ago must read as out of retention by the window alone.
    const lingering = randomUUID();
    const yearAgo = cst("2025-02-01T10:00:00");
    await setup.query(
      `INSERT INTO community.analytics_events(event_id,visitor_id,session_id,distinct_id,event_name,surface,event_data,occurred_at,received_at)
      VALUES($1,$2,$2,$3,'page_view','home','{}'::jsonb,$4::timestamptz,$4::timestamptz)`,
      [lingering, visitor(), "e".repeat(40), yearAgo],
    );
    try {
      const body = await ok("overview", {
        range: "yesterday",
        compare: "year",
      });
      expect(body.range.dataFrom).toBe(yearAgo.toISOString());
      expect(body.compare.start).toBe(cst("2025-03-10T00:00:00").toISOString());
      expect(body.compare.outOfRetention).toBe(true);
      expect(body.metrics.pageViews.prev).toBeNull();
      expect(body.metrics.pageViews.delta).toBeNull();
      expect(body.metrics.pageViews.pct).toBeNull();
      expect(body.notes).toContain("COMPARE_OUT_OF_RETENTION");
      const compared = await ok("compare", {
        range: "yesterday",
        compare: "year",
      });
      expect(compared.total.prev).toBeNull();
      expect(compared.rows).toEqual([]);
      expect(compared.other).toBeNull();
    } finally {
      await setup.query(
        "DELETE FROM community.analytics_events WHERE event_id=$1",
        [lingering],
      );
    }
    const refused = await get("overview", {
      from: "2025-01-01",
      to: "2025-01-02",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.issues[0]).toMatchObject({
      path: ["from"],
      code: "out_of_retention",
    });
  });

  it("treats a comparison before the store's first event like one beyond retention", async () => {
    const body = await ok("overview", {
      from: "2025-12-01",
      to: "2025-12-01",
    });
    expect(body.range.dataFrom).toBe(cst("2025-12-01T10:00:00").toISOString());
    expect(body.compare.outOfRetention).toBe(true);
    expect(body.metrics.pageViews.prev).toBeNull();
  });

  it("states collected:false for what was never collected, on status and as a dimension", async () => {
    const names = [
      "referrer",
      "utm",
      "channel",
      "replay",
      "heatmap",
      "revenue",
      "performance",
      "rankingVersion",
    ];
    const status = await ok("status");
    for (const name of names) {
      expect(status.notCollected[name].collected, name).toBe(false);
      expect(status.notCollected[name].reason.length, name).toBeGreaterThan(0);
      for (const report of ["breakdown", "compare"]) {
        const body = await ok(report, { dimension: name });
        expect(body, `${report} ${name}`).toMatchObject({
          collected: false,
          dimension: name,
        });
        expect(body).not.toHaveProperty("rows");
        expect(body).not.toHaveProperty("total");
      }
    }
  });

  it("names Umami's dimensions instead of reading them as empty", async () => {
    for (const dimension of ["province", "city", "device"]) {
      const { status, body } = await get("breakdown", { dimension });
      expect(status).toBe(400);
      expect(body.error.issues[0].code).toBe("answered_by_umami");
    }
  });
});

describe("a clock change at midnight", () => {
  it("starts that day at the later side of the gap, so it has one bucket", async () => {
    const body = await ok("trend", {
      from: "2026-03-08",
      to: "2026-03-08",
      tz: "America/Havana",
      groupBy: "day",
    });
    expect(body.range.start).toBe("2026-03-08T05:00:00.000Z");
    expect(body.buckets.map((bucket: Json) => bucket.label)).toEqual([
      "2026-03-08",
    ]);
    expect(body.buckets[0].partial).toBe(false);
  });
});

describe("compare: which content dropped most", () => {
  it("ranks the largest drop first, with onlyInBase rows and shares of the change", async () => {
    const start = cst("2026-03-02T00:00:00");
    const end = cst("2026-03-09T00:00:00");
    const before = cst("2026-02-23T00:00:00");
    const current = hitsByKey(between(start, end));
    const previous = hitsByKey(between(before, start));
    const drops = [...new Set([...current.keys(), ...previous.keys()])]
      .filter((key) => key !== selfOnlyKey())
      .map((key) => ({
        key,
        v: current.get(key) ?? 0,
        prev: previous.get(key) ?? 0,
      }))
      .filter((row) => row.v < row.prev)
      .sort((a, b) => a.v - a.prev - (b.v - b.prev));
    const body = await ok("compare", {
      range: "last_week",
      dimension: "content",
      direction: "down",
      minBase: "5",
    });
    expect(body.rows.map((row: Json) => [keyOf(row), row.v, row.prev])).toEqual(
      drops.map((row) => [row.key, row.v, row.prev]),
    );
    expect(body.rows[0].target.id).toBe(works.third.id);
    expect(body.rows[0].delta).toBe(drops[0]!.v - drops[0]!.prev);
    const gone = body.rows.find((row: Json) => row.target.id === works.gone.id);
    expect(gone).toMatchObject({
      onlyInBase: true,
      onlyInCurrent: false,
      v: 0,
      prev: 4,
      lowBase: true,
      pct: -100,
    });
    const shares = [
      ...body.rows.map((row: Json) => row.shareOfChange),
      body.other.shareOfChange,
      body.unknown.shareOfChange,
      body.withheld.shareOfChange,
    ];
    expect(
      shares.reduce((all: number, share: number) => all + share, 0),
    ).toBeCloseTo(100, 6);
    expect(body.total.v).toBe(between(start, end).length);
    expect(body.total.prev).toBe(between(before, start).length);
  });
});

describe("funnel", () => {
  it("sameTarget differs correctly from same-visit order, and the basis is labelled", async () => {
    const window = { from: "2026-01-20", to: "2026-01-20" };
    const steps = "content_impression,content_open";
    const visit = await ok("funnel", { ...window, steps });
    const same = await ok("funnel", { ...window, steps, sameTarget: "true" });
    expect(visit.steps.map((step: Json) => step.count)).toEqual([2, 2]);
    expect(same.steps.map((step: Json) => step.count)).toEqual([2, 1]);
    expect(visit.basis).toEqual({
      unit: "visitor",
      order: "same_session",
      sameTarget: false,
    });
    expect(same.basis).toEqual({
      unit: "visitor",
      order: "same_session",
      sameTarget: true,
    });
    expect(same.steps[1].fromFirst).toBe(50);
    const bySession = await ok("funnel", {
      ...window,
      steps,
      sameTarget: "true",
      basis: "session",
    });
    expect(bySession.basis.unit).toBe("session");
  });

  it("does not let a later step stand in for an earlier one", async () => {
    const body = await ok("funnel", {
      from: "2026-01-20",
      to: "2026-01-20",
      steps: "content_open,content_impression",
    });
    expect(body.steps.map((step: Json) => step.count)).toEqual([2, 0]);
  });

  const productDay = { from: "2026-01-27", to: "2026-01-27" };
  const counts = (body: Json) => body.steps.map((step: Json) => step.count);

  it("takes a surface on its first step only, because a client records each open on detail", async () => {
    const steps = "content_impression,content_open";
    const browse = await ok("funnel", {
      ...productDay,
      steps,
      sameTarget: "true",
      surface: "browse",
    });
    // Seven visitors saw a listing on browse, and three of them opened the same work.
    expect(counts(browse)).toEqual([7, 3]);
    expect(browse.steps[1].fromFirst).toBe(42.86);
    expect(browse.basis).toEqual({
      unit: "visitor",
      order: "same_session",
      sameTarget: true,
      surfaceAppliesTo: "first_step",
    });
    expect(
      counts(await ok("funnel", { ...productDay, steps, surface: "home" })),
    ).toEqual([1, 1]);
    expect(
      counts(await ok("funnel", { ...productDay, steps, surface: "search" })),
    ).toEqual([0, 0]);
  });

  it("says when a sameTarget step never has a target, rather than read as nobody doing it", async () => {
    const steps = "search,search_click";
    const strict = await ok("funnel", {
      ...productDay,
      steps,
      sameTarget: "true",
    });
    expect(counts(strict)).toEqual([0, 0]);
    expect(strict.notes).toContain("SAME_TARGET_STEP_HAS_NO_TARGET:search");
    expect(strict.notes).not.toContain(
      "SAME_TARGET_STEP_HAS_NO_TARGET:search_click",
    );
    const loose = await ok("funnel", { ...productDay, steps });
    expect(counts(loose)).toEqual([3, 0]);
    expect(loose.notes).toEqual([]);
    const targeted = await ok("funnel", {
      ...productDay,
      steps: "content_impression,content_open",
      sameTarget: "true",
    });
    expect(targeted.notes).toEqual([]);
  });

  it("says a first step that is an open or a dwell is recorded on detail, with its count as it is", async () => {
    const off = "OPENS_AND_DWELL_RECORDED_ON_DETAIL";
    for (const [first, seen] of [
      ["content_open", 4],
      ["content_dwell", 5],
    ] as const) {
      const steps = `${first},like`;
      const browse = await ok("funnel", {
        ...productDay,
        steps,
        surface: "browse",
      });
      expect(counts(browse), first).toEqual([0, 0]);
      expect(browse.notes, first).toEqual([off]);
      expect(browse.basis.surfaceAppliesTo, first).toBe("first_step");
      const detail = await ok("funnel", {
        ...productDay,
        steps,
        surface: "detail",
      });
      expect(counts(detail), first).toEqual([seen, 0]);
      expect(detail.notes, first).toEqual([]);
      const whole = await ok("funnel", { ...productDay, steps });
      expect(counts(whole), first).toEqual([seen, 0]);
      expect(whole.notes, first).toEqual([]);
    }
    // A listing's own step reads what it was asked; a later open changes nothing.
    const listing = await ok("funnel", {
      ...productDay,
      steps: "content_impression,content_open",
      surface: "browse",
    });
    expect(counts(listing)).toEqual([7, 3]);
    expect(listing.notes).toEqual([]);
  });
});

describe("realtime", () => {
  it("answers who is here now from the Backend's clock", async () => {
    const body = await ok("realtime");
    expect(body.activeVisitors).toBe(2);
    expect(body.activeAccounts).toBe(1);
    expect(body.windowSeconds).toBe(300);
    expect(body.eventsPerMinute).toHaveLength(5);
    expect(
      body.eventsPerMinute.reduce(
        (all: number, minute: Json) => all + minute.events,
        0,
      ),
    ).toBe(3);
    const signedIn = body.online.find(
      (row: Json) => row.visitorId === onlineVisitor,
    );
    expect(signedIn.account.handle).toBe(readerHandle);
    expect(signedIn.target.id).toBe(works.first.id);
    const withheld = body.online.find(
      (row: Json) => row.visitorId === onlineSelfOnly,
    );
    expect(withheld.withheld).toBe("self_only");
    expect(withheld.target).toBeNull();
    expect(body.topContent.withheld.count).toBe(1);
  });
});

describe("sessions and one visitor's session", () => {
  const window = { from: "2026-02-03", to: "2026-02-03" };

  it("lists a visitor's sessions with the linked account and no IP", async () => {
    const body = await ok("sessions", { ...window, visitorId: timeline });
    expect(body.rows.map((row: Json) => row.sessionId).sort()).toEqual(
      [timelineSession, timelineSecond].sort(),
    );
    expect(body.rows[0].account.handle).toBe(readerHandle);
    expect(JSON.stringify(body)).not.toContain(ipCanary);
    expect(body).not.toHaveProperty("ip");
    expect(JSON.stringify(body)).not.toMatch(/"ip"|user_?agent/iu);
  });

  it("collapses repeated impressions into a run, shows withheld steps, and resolves titles", async () => {
    const body = await ok("session", { ...window, sessionId: timelineSession });
    expect(body.summary).toMatchObject({ events: 6, sessions: 1, visitors: 1 });
    expect(body.accounts.map((row: Json) => row.handle)).toEqual([
      readerHandle,
    ]);
    expect(body.runs).toHaveLength(4);
    expect(body.runs[0]).toMatchObject({
      event: "content_impression",
      count: 3,
      firstAt: stamp("00").toISOString(),
      lastAt: stamp("02").toISOString(),
      target: { id: works.first.id, title: works.first.name },
    });
    expect(body.runs[1]).toMatchObject({
      event: "content_open",
      withheld: "self_only",
      target: null,
      count: 1,
    });
    expect(body.runs[2]).toMatchObject({
      event: "content_dwell",
      withheld: "self_only",
      dwellMs: null,
    });
    expect(body.runs[3]).toMatchObject({ event: "search", query: "合成检索" });
  });

  it("answers include:ip as withheld and sends no query to the observations", async () => {
    statements.length = 0;
    for (const [report, query] of [
      ["sessions", { ...window, visitorId: timeline, include: "ip" }],
      ["session", { ...window, visitorId: timeline, include: "ip" }],
    ] as const) {
      const body = await ok(report, query);
      expect(body.ip).toEqual({ withheld: true, switch: "rawIp" });
      expect(JSON.stringify(body)).not.toContain(ipCanary);
    }
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements)
      expect(statement).not.toMatch(/analytics_ip_observations/u);
    expect(
      await readFile(
        `${root}/services/community-postgres/src/analytics-insights.ts`,
        "utf8",
      ),
    ).not.toMatch(/FROM community\.analytics_ip_observations/u);
  });

  it("refuses a session read with no subject or two", async () => {
    for (const query of [
      window,
      { ...window, sessionId: timelineSession, visitorId: timeline },
    ]) {
      const { status, body } = await get("session", query);
      expect(status).toBe(400);
      expect(body.error.issues[0].code).toBe("one_subject_required");
    }
  });

  it("a timeline has one way on, and a full page with more to come sets it", async () => {
    const page = await ok("session", {
      ...window,
      visitorId: timeline,
      limit: "3",
    });
    expect(page.next.cursor).toEqual(expect.any(String));
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].count).toBe(3);
    const rest = await ok("session", {
      ...window,
      visitorId: timeline,
      limit: "100",
      cursor: page.next.cursor,
    });
    expect(rest).not.toHaveProperty("next");
    expect(
      rest.runs.reduce((all: number, run: Json) => all + run.count, 0),
    ).toBe(4);
    expect(rest.quality).not.toHaveProperty("truncated");
    expect(page.quality.truncated).toBe(true);
  });

  it("pages sessions by keyset without losing or repeating one", async () => {
    const first = await ok("sessions", { ...window, limit: "1" });
    expect(first.rows).toHaveLength(1);
    expect(first.next.cursor).toEqual(expect.any(String));
    const second = await ok("sessions", {
      ...window,
      limit: "1",
      cursor: first.next.cursor,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].sessionId).not.toBe(first.rows[0].sessionId);
    expect(second).not.toHaveProperty("next");
  });

  it("refuses a cursor that names no row", async () => {
    for (const cursor of [
      "not-a-cursor",
      Buffer.from("2026-13-45T00:00:00.000000Z|x").toString("base64url"),
    ]) {
      const { status, body } = await get("sessions", { ...window, cursor });
      expect(status).toBe(400);
      expect(body.error.issues[0].code).toBe("invalid_cursor");
    }
    const { status, body } = await get("breakdown", { cursor: "abc" });
    expect(status).toBe(400);
    expect(body.error.issues[0].code).toBe("invalid_cursor");
  });

  it.each(["0000", "0001", "1999", "2101", "9999"])(
    "refuses a forged cursor in year %s by name, before the database reads it",
    async (year) => {
      const cursor = Buffer.from(
        `${year}-01-01T00:00:00.000000Z|${randomUUID()}`,
      ).toString("base64url");
      for (const [report, query] of [
        ["sessions", { ...window, cursor }],
        ["session", { ...window, cursor, visitorId: timeline }],
      ] as const) {
        const { status, body } = await get(report, query);
        expect(status).toBe(400);
        expect(body.error.issues[0]).toMatchObject({
          path: ["cursor"],
          code: "invalid_cursor",
        });
      }
    },
  );
});

describe("product", () => {
  const day = { from: "2026-01-27", to: "2026-01-27" };

  it("reads impression to open by position, dwell, search and labelled finals", async () => {
    const body = await ok("product", day);
    const browse = body.byPosition.filter(
      (row: Json) => row.surface === "browse",
    );
    expect(browse.find((row: Json) => row.position === 0)).toEqual({
      surface: "browse",
      position: 0,
      impressions: 3,
      opens: 1,
      openRate: 33.33,
    });
    expect(browse.find((row: Json) => row.position === "10+")).toMatchObject({
      impressions: 1,
      opens: 0,
    });
    // The open is on detail, and the impression's listing is what it goes to.
    expect(browse.find((row: Json) => row.position === 7)).toMatchObject({
      impressions: 1,
      opens: 1,
    });
    const home = body.byPosition.filter((row: Json) => row.surface === "home");
    expect(home.find((row: Json) => row.position === 7)).toMatchObject({
      impressions: 1,
      opens: 0,
    });
    expect(
      body.byPosition.filter((row: Json) => row.surface === "detail"),
    ).toEqual([
      {
        surface: "detail",
        position: 5,
        impressions: 0,
        opens: 1,
        openRate: null,
      },
    ]);
    expect(body.notes).toContain("DETAIL_OPENS_HAD_NO_IMPRESSION");
    expect(body.notes).not.toContain("FINALS_NOT_BY_SURFACE");
    expect(body.notes).not.toContain("OPENS_AND_DWELL_RECORDED_ON_DETAIL");
    expect(body.dwell).toEqual({
      basis: "session_and_target",
      samples: 5,
      p50Ms: 300,
      p90Ms: 460,
    });
    expect(body.search).toEqual({
      searches: 3,
      clicks: 1,
      clickRate: 33.33,
      topQueries: [
        { query: "合成甲", count: 2 },
        { query: "合成乙", count: 1 },
      ],
    });
    expect(body.finals).toEqual({
      likes: { v: 1, source: "business_tables" },
      favorites: { v: 1, source: "business_tables" },
      follows: { v: 1, source: "business_tables" },
    });
    expect(body.clientEvents).toEqual({
      like: { v: 2, source: "client_evidence" },
      favorite: { v: 1, source: "client_evidence" },
      follow: { v: 1, source: "client_evidence" },
    });
    expect(body.topContent.rows[0].target.id).toBe(works.first.id);
    expect(body.topContent.withheld).toEqual({
      reason: "self_only",
      impressions: 1,
      opens: 1,
    });
  });

  it("keeps opens with their listing under a surface filter, and states what the filter cannot reach", async () => {
    const whole = await ok("product", day);
    const browse = await ok("product", { ...day, surface: "browse" });
    expect(browse.byPosition).toEqual(
      whole.byPosition.filter((row: Json) => row.surface === "browse"),
    );
    expect(
      browse.byPosition.find((row: Json) => row.position === 0).openRate,
    ).toBe(33.33);
    // The business tables have no surface, so these stay the site's, and say so.
    expect(browse.finals).toEqual(whole.finals);
    expect(browse.finals.likes.v).toBe(1);
    expect(browse.clientEvents.like.v).toBe(0);
    expect(browse.notes).toEqual(
      expect.arrayContaining([
        "FINALS_NOT_BY_SURFACE",
        "OPENS_AND_DWELL_RECORDED_ON_DETAIL",
      ]),
    );
    expect(browse.notes).not.toContain("DETAIL_OPENS_HAD_NO_IMPRESSION");
    expect(browse.dwell.samples).toBe(0);

    const detail = await ok("product", { ...day, surface: "detail" });
    expect(detail.byPosition).toEqual([
      {
        surface: "detail",
        position: 5,
        impressions: 0,
        opens: 1,
        openRate: null,
      },
    ]);
    expect(detail.notes).toContain("FINALS_NOT_BY_SURFACE");
    expect(detail.notes).not.toContain("OPENS_AND_DWELL_RECORDED_ON_DETAIL");
    expect(detail.dwell.samples).toBe(5);
  });

  it("reads dwell per open: one session's whole time on one target", async () => {
    const body = await ok("product", {
      from: "2026-01-28",
      to: "2026-01-28",
    });
    expect(body.dwell).toEqual({
      basis: "session_and_target",
      samples: 3,
      p50Ms: 1_000,
      p90Ms: 5_000,
    });
  });

  it("counts openRate in events, so a second tap takes it past 100", async () => {
    const body = await ok("product", {
      from: "2026-01-29",
      to: "2026-01-29",
    });
    expect(body.byPosition).toEqual([
      {
        surface: "search",
        position: 8,
        impressions: 1,
        opens: 3,
        openRate: 300,
      },
    ]);
    expect(body.topContent.rows).toHaveLength(1);
    expect(body.topContent.rows[0]).toMatchObject({
      impressions: 1,
      opens: 3,
      openRate: 300,
    });
  });

  describe("a listing's filter on what a client records on detail", () => {
    const off = "OPENS_AND_DWELL_RECORDED_ON_DETAIL";
    const opens = { ...day, dimension: "content", event: "content_open" };

    it("breakdown says so, with its counts as they are", async () => {
      const browse = await ok("breakdown", { ...opens, surface: "browse" });
      expect(browse).toMatchObject({ total: 0, rows: [] });
      expect(browse.notes).toEqual([off]);
      const dwell = await ok("breakdown", {
        ...opens,
        event: "content_dwell",
        surface: "home",
      });
      expect(dwell).toMatchObject({ total: 0, rows: [] });
      expect(dwell.notes).toEqual([off]);
      // Every event: the impressions are real, and the opens' absence is explained.
      const events = await ok("breakdown", {
        ...day,
        dimension: "event",
        surface: "browse",
      });
      expect(events.total).toBe(7);
      expect(events.rows.map((row: Json) => row.key)).toEqual([
        "content_impression",
      ]);
      expect(events.notes).toEqual([off]);

      const detail = await ok("breakdown", { ...opens, surface: "detail" });
      expect(detail.total).toBe(4);
      expect(detail.notes).not.toContain(off);
      const whole = await ok("breakdown", opens);
      expect(whole.total).toBe(4);
      expect(whole.notes).not.toContain(off);
      const pageViews = await ok("breakdown", {
        ...day,
        dimension: "content",
        surface: "browse",
      });
      expect(pageViews.event).toBe("page_view");
      expect(pageViews.notes).not.toContain(off);
    });

    it("compare says so on both its answers, with its counts as they are", async () => {
      const browse = await ok("compare", { ...opens, surface: "browse" });
      expect(browse.compare).not.toHaveProperty("outOfRetention");
      expect(browse.total.v).toBe(0);
      expect(browse.notes).toEqual([off]);
      const detail = await ok("compare", { ...opens, surface: "detail" });
      expect(detail.total.v).toBe(4);
      expect(detail.notes).not.toContain(off);
      const pageViews = await ok("compare", {
        ...day,
        dimension: "content",
        surface: "browse",
      });
      expect(pageViews.event).toBe("page_view");
      expect(pageViews.notes).not.toContain(off);

      // A year back is past retention, and that answer reads its own total.
      const year = { ...opens, compare: "year" };
      const old = await ok("compare", { ...year, surface: "browse" });
      expect(old.compare.outOfRetention).toBe(true);
      expect(old.total).toMatchObject({ v: 0, prev: null });
      expect(old.notes).toEqual(
        expect.arrayContaining(["COMPARE_OUT_OF_RETENTION", off]),
      );
      const oldDetail = await ok("compare", { ...year, surface: "detail" });
      expect(oldDetail.compare.outOfRetention).toBe(true);
      expect(oldDetail.total.v).toBe(4);
      expect(oldDetail.notes).toEqual(["COMPARE_OUT_OF_RETENTION"]);
    });
  });
});

describe("reconcile and native", () => {
  it("reads per-day canonical counts and what was and was not forwarded", async () => {
    const body = await ok("reconcile", {
      from: "2026-03-10",
      to: "2026-03-10",
    });
    expect(body.days).toHaveLength(1);
    const rows = between(
      cst("2026-03-10T00:00:00"),
      cst("2026-03-11T00:00:00"),
      null,
    );
    expect(body.days[0]).toEqual({
      day: "2026-03-10",
      partial: false,
      events: rows.length,
      pageViews: rows.filter((row) => row.name === "page_view").length,
      visitorsPageView: uniqueCount(rows, "visitor"),
      visitorsAny: uniqueCount(rows, "visitor"),
      forwarded: 0,
      notForwarded: rows.length,
      pageViewsQueued: 0,
      pageViewsNeverForwarded: rows.filter((row) => row.name === "page_view")
        .length,
    });
    expect(body.outbox).toEqual({ pending: 0, failed: 0 });
  });

  it("fixes the instants a native report asks about, and says when they are past retention", async () => {
    const body = await ok("native", { range: "yesterday" });
    expect(body.startMs).toBe(cst("2026-03-10T00:00:00").getTime());
    expect(body.endMs).toBe(cst("2026-03-11T00:00:00").getTime());
    expect(body.outOfRetention).toBe(false);
    expect(body.retention.days).toBe(180);
    const old = await ok("native", { from: "2025-01-01", to: "2025-01-02" });
    expect(old.outOfRetention).toBe(true);
  });
});

describe("a self-only work", () => {
  const sweep: readonly (readonly [string, Record<string, string>])[] = [
    ["overview", { range: "last_30_days" }],
    ["trend", { range: "last_30_days" }],
    ["breakdown", { range: "last_30_days", dimension: "content" }],
    ["breakdown", { range: "last_30_days", dimension: "surface" }],
    ["compare", { range: "last_week", dimension: "content" }],
    [
      "compare",
      { range: "last_week", dimension: "content", direction: "down" },
    ],
    [
      "funnel",
      {
        range: "last_30_days",
        steps: "content_impression,content_open",
        sameTarget: "true",
      },
    ],
    ["realtime", {}],
    ["sessions", { from: "2026-02-03", to: "2026-02-03" }],
    ["session", { from: "2026-02-03", to: "2026-02-03", visitorId: timeline }],
    ["product", { from: "2026-01-27", to: "2026-01-27" }],
    ["native", { range: "last_30_days" }],
    ["reconcile", { range: "last_30_days" }],
    ["status", {}],
  ];

  it("appears in no answer: the canary sweep finds neither its title nor its id", async () => {
    for (const [report, query] of sweep) {
      const body = JSON.stringify(await ok(report, query));
      expect(body, report).not.toContain(canary);
      expect(body, report).not.toContain(works.selfOnly.id);
    }
  });

  it("collapses into one withheld row, and shares still add to exactly 100 percent", async () => {
    const start = cst("2026-03-04T00:00:00");
    const end = cst("2026-03-11T00:00:00");
    const self = hitsByKey(between(start, end)).get(selfOnlyKey())!;
    expect(self).toBeGreaterThan(0);
    for (const limit of ["1", "3", "100"]) {
      const body = await ok("breakdown", {
        range: "last_7_days",
        dimension: "content",
        limit,
      });
      expect(body.withheld).toMatchObject({ reason: "self_only", count: self });
      expect(body.excluded).toEqual(["self_only"]);
      const hundredths = [
        ...body.rows.map((row: Json) => row.share),
        body.other.share,
        body.unknown.share,
        body.withheld.share,
      ].map((share: number) => Math.round(share * 100));
      expect(hundredths.reduce((all, share) => all + share, 0)).toBe(10_000);
      expect(
        body.rows.reduce((all: number, row: Json) => all + row.count, 0) +
          body.other.count +
          body.unknown.count +
          body.withheld.count,
      ).toBe(body.total);
    }
    const overview = await ok("overview", { range: "last_7_days" });
    expect(overview.topContent.withheld.count).toBe(self);
    expect(overview.excluded).toEqual(["self_only"]);
  });

  it("collapses in compare the same way", async () => {
    const body = await ok("compare", {
      range: "last_week",
      dimension: "content",
    });
    const start = cst("2026-03-02T00:00:00");
    expect(body.withheld).toMatchObject({
      reason: "self_only",
      v: hitsByKey(between(start, cst("2026-03-09T00:00:00"))).get(
        selfOnlyKey(),
      ),
      prev: hitsByKey(between(cst("2026-02-23T00:00:00"), start)).get(
        selfOnlyKey(),
      ),
    });
  });

  it("refuses a filter that names it, rather than giving its numbers", async () => {
    for (const report of ["overview", "trend", "breakdown", "compare"]) {
      const { status, body } = await get(report, {
        range: "last_7_days",
        targetType: "work",
        targetId: works.selfOnly.id,
      });
      expect(status, report).toBe(403);
      expect(body.error.code, report).toBe("SELF_ONLY_OWNER_REVIEW");
    }
  });

  it("does not take in a permanently deleted work, which stays its own row with no title", async () => {
    const body = await ok("breakdown", {
      range: "last_7_days",
      dimension: "content",
      limit: "100",
    });
    const deleted = body.rows.find(
      (row: Json) => keyOf(row) === `work:${works.deleted.id}`,
    );
    expect(deleted).toMatchObject({
      count: 4,
      target: {
        id: works.deleted.id,
        title: null,
        authorHandle,
        state: "deleted",
      },
    });
    const filtered = await get("breakdown", {
      range: "last_7_days",
      targetType: "work",
      targetId: works.deleted.id,
    });
    expect(filtered.status).toBe(200);
  });

  it.each([
    // A purge sets only this: the row keeps its title, text and `trashed_at`.
    ["a trash-purged work", "deleted_at=trashed_at"],
    // #126's delete set `deleted_at` alone, so its row has no `trashed_at`.
    [
      "a work deleted with no trashed_at",
      "deleted_at=trashed_at,trashed_at=NULL,trash_purge_after=NULL",
    ],
  ])(
    "takes in %s, which still holds its text, wherever it would read",
    async (_, deleted) => {
      const start = cst("2026-03-04T00:00:00");
      const end = cst("2026-03-11T00:00:00");
      const hits = hitsByKey(between(start, end));
      const { rows } = await setup.query(
        "SELECT trashed_at,trash_purge_after FROM community.works WHERE id=$1",
        [works.trashed.id],
      );
      await setup.query(`UPDATE community.works SET ${deleted} WHERE id=$1`, [
        works.trashed.id,
      ]);
      try {
        const filtered = await get("breakdown", {
          range: "last_7_days",
          targetType: "work",
          targetId: works.trashed.id,
        });
        expect(filtered.status).toBe(403);
        expect(filtered.body.error.code).toBe("SELF_ONLY_OWNER_REVIEW");
        const listed = await ok("breakdown", {
          range: "last_7_days",
          dimension: "content",
          limit: "100",
        });
        expect(JSON.stringify(listed)).not.toContain(works.trashed.name);
        expect(JSON.stringify(listed)).not.toContain(works.trashed.id);
        expect(listed.withheld.count).toBe(
          hits.get(selfOnlyKey())! + hits.get(`work:${works.trashed.id}`)!,
        );
        const insights = new PostgresAnalyticsInsights(app, {
          retentionDays: 180,
        });
        const client = await app.connect();
        try {
          const described = await (
            insights as unknown as {
              describeTargets(
                db: unknown,
                refs: readonly { type: string; id: string }[],
                notes: Set<string>,
              ): Promise<ReadonlyMap<string, Json>>;
            }
          ).describeTargets(
            client,
            [{ type: "work", id: works.trashed.id }],
            new Set(),
          );
          expect(described.get(`work:${works.trashed.id}`)).toMatchObject({
            title: null,
            state: "unresolved",
          });
        } finally {
          client.release();
        }
      } finally {
        await setup.query(
          "UPDATE community.works SET deleted_at=NULL,trashed_at=$2,trash_purge_after=$3 WHERE id=$1",
          [works.trashed.id, rows[0]!.trashed_at, rows[0]!.trash_purge_after],
        );
      }
    },
  );

  it("has no title through the title lookup either, whatever row asks", async () => {
    const insights = new PostgresAnalyticsInsights(app, { retentionDays: 180 });
    const client = await app.connect();
    try {
      const described = await (
        insights as unknown as {
          describeTargets(
            db: unknown,
            refs: readonly { type: string; id: string }[],
            notes: Set<string>,
          ): Promise<ReadonlyMap<string, Json>>;
        }
      ).describeTargets(
        client,
        [{ type: "work", id: works.selfOnly.id }],
        new Set(),
      );
      expect(described.get(selfOnlyKey())).toEqual({
        type: "work",
        id: works.selfOnly.id,
        title: null,
        authorHandle: null,
        state: "unresolved",
      });
    } finally {
      client.release();
    }
  });

  it("labels each target by what could be read", async () => {
    const body = await ok("breakdown", {
      range: "last_7_days",
      dimension: "content",
      limit: "100",
    });
    const by = (id: string) =>
      body.rows.find((row: Json) => row.target.id === id).target;
    expect(by(catalogId)).toMatchObject({
      title: "合成资料",
      state: "published",
    });
    // The published revision's title, not the draft's.
    expect(by(articleId)).toMatchObject({
      title: "合成文章",
      authorHandle,
      state: "published",
    });
    expect(by(works.trashed.id)).toMatchObject({
      title: works.trashed.name,
      state: "trashed",
    });
    // Withdrawn from the public, so no title, though its revision is still stored.
    expect(by(withdrawnArticleId)).toMatchObject({
      title: null,
      authorHandle,
      state: "withdrawn",
    });
    expect(JSON.stringify(body)).not.toContain(withdrawnTitle);
  });

  it("keeps a hidden or removed work's title, because its row names that state", async () => {
    for (const state of ["hidden", "removed"]) {
      await setup.query(
        "UPDATE community.works SET operator_state=$2, version=version+1 WHERE id=$1",
        [works.third.id, state],
      );
      try {
        const body = await ok("breakdown", {
          range: "last_7_days",
          dimension: "content",
          limit: "100",
        });
        expect(
          body.rows.find((row: Json) => row.target.id === works.third.id)
            .target,
        ).toMatchObject({ title: works.third.name, state });
      } finally {
        await setup.query(
          "UPDATE community.works SET operator_state='visible', version=version+1 WHERE id=$1",
          [works.third.id],
        );
      }
    }
  });

  it("gives no title for an Article a report hid from the public", async () => {
    const read = () =>
      ok("breakdown", {
        range: "last_7_days",
        dimension: "content",
        limit: "100",
      });
    await setup.query(
      "UPDATE community.article_documents SET reporting_hidden=true, version=version+1 WHERE id=$1",
      [articleId],
    );
    try {
      const body = await read();
      const target = body.rows.find(
        (row: Json) => row.target.id === articleId,
      ).target;
      expect(target).toMatchObject({
        title: null,
        authorHandle,
        state: "hidden",
      });
      expect(JSON.stringify(body)).not.toContain("合成文章");
    } finally {
      await setup.query(
        "UPDATE community.article_documents SET reporting_hidden=false, version=version+1 WHERE id=$1",
        [articleId],
      );
    }
    const restored = await read();
    expect(
      restored.rows.find((row: Json) => row.target.id === articleId).target,
    ).toMatchObject({ title: "合成文章", state: "published" });
  });
});

describe("the read itself", () => {
  it("is one READ ONLY snapshot under a statement timeout", async () => {
    statements.length = 0;
    await ok("overview", { range: "yesterday" });
    expect(statements[0]).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(statements[1]).toMatch(/^SET LOCAL statement_timeout = '3000ms'$/u);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("is refused by the database if it tries to write", async () => {
    await expect(
      (async () => {
        const client = await app.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query(
            "DELETE FROM community.analytics_events WHERE FALSE",
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      })(),
    ).rejects.toMatchObject({ code: "25006" });
  });

  it("answers READ_TIMED_OUT past the limit, with no number", async () => {
    const slow = new Proxy(app, {
      get(pool, property) {
        if (property !== "connect")
          return Reflect.get(pool, property) as unknown;
        return async () => {
          const client = await pool.connect();
          const query = client.query.bind(client);
          return new Proxy(client, {
            get(target, name) {
              if (name !== "query") return Reflect.get(target, name) as unknown;
              return (text: string, values?: unknown[]) =>
                query(
                  /count\(/u.test(text) ? "SELECT pg_sleep(5)" : text,
                  /count\(/u.test(text) ? [] : (values as never),
                );
            },
          });
        };
      },
    }) as Pool;
    const application = createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      communityOperatorCredential: ownerToken,
      operatorAiBaseCredential: baseToken,
      analytics: {
        port: new PostgresAnalyticsAdapter(app),
        policy: {
          enabled: false,
          production: false,
          excludedUserIds: new Set(),
          ownerExclusionConfigured: false,
          hmacKey: "",
          forwardingConfigured: false,
          eventRetentionDays: 180,
        },
        insights: new PostgresAnalyticsInsights(slow, {
          retentionDays: 180,
          now: () => now,
        }),
      },
    });
    const slowServer = createBackendServer(application);
    const address = await startServer(slowServer, {
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const started = Date.now();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/internal/analytics/insights/overview?range=yesterday`,
        { headers: { authorization: `Bearer ${baseToken}` } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { status: 503, code: "READ_TIMED_OUT" },
      });
      expect(Date.now() - started).toBeLessThan(4_500);
    } finally {
      await stopServer(slowServer);
    }
  }, 15_000);

  it("reads a Catalog title when it can, and says so when it cannot", async () => {
    await setup.query(
      `REVOKE SELECT ON public.catalog_discovery FROM "${role}"`,
    );
    try {
      const body = await ok("breakdown", {
        range: "last_7_days",
        dimension: "content",
        limit: "100",
      });
      expect(body.notes).toContain("CATALOG_TITLES_UNAVAILABLE");
      const row = body.rows.find(
        (entry: Json) => entry.target.id === catalogId,
      );
      expect(row.target).toMatchObject({
        title: null,
        state: "title_unavailable",
      });
      // The rest of the answer stands.
      expect(body.total).toBeGreaterThan(0);
      const stillTitled = body.rows.find(
        (entry: Json) => entry.target.id === works.first.id,
      );
      expect(stillTitled.target.title).toBe(works.first.name);
    } finally {
      await setup.query(
        `GRANT SELECT ON public.catalog_discovery TO "${role}"`,
      );
    }
  });
});

describe("paging", () => {
  it("a page with more to come has next, the last has none, and rows repeat nowhere", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body: Json = await ok("breakdown", {
        range: "last_7_days",
        dimension: "content",
        limit: "2",
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...body.rows.map(keyOf));
      cursor = body.next?.cursor;
      expect(body.quality.truncated === true).toBe(cursor !== undefined);
      if (cursor === undefined) break;
      expect(body.rows).toHaveLength(2);
    }
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length);
    const start = cst("2026-03-04T00:00:00");
    const hits = hitsByKey(between(start, cst("2026-03-11T00:00:00")));
    hits.delete(selfOnlyKey());
    expect([...seen].sort()).toEqual([...hits.keys()].sort());
  });

  it("a trend pages its buckets, with totals on every page", async () => {
    const first = await ok("trend", {
      from: "2026-02-01",
      to: "2026-02-10",
      groupBy: "day",
      limit: "4",
    });
    expect(first.buckets).toHaveLength(4);
    expect(first.next.cursor).toBe("4");
    const last = await ok("trend", {
      from: "2026-02-01",
      to: "2026-02-10",
      groupBy: "day",
      limit: "6",
      cursor: "4",
    });
    expect(last.buckets).toHaveLength(6);
    expect(last).not.toHaveProperty("next");
    expect(last.totals).toEqual(first.totals);
  });
});
