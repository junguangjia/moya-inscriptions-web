/**
 * admin-mcp-completion-v1 S4: `admin_analytics`, real JSON-RPC over HTTP with the
 * official client, through the real door and guard, to the real Backend on a disposable
 * community database of its own and a real HTTP stand-in for Umami. The clock is pinned
 * so day and week boundaries are exact. Every oracle comes from the seeded rows, never
 * through a report, and the suite seeds all it reads, so it passes alone on an empty
 * server and on a used one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
import {
  ADMIN_ANALYTICS_REPORTS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ANALYTICS_NOT_COLLECTED,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import { MappedStorageUrlResolver } from "@moya/image";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import { getPayload, type Payload, type TypedUser } from "payload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { analyticsCache, toolListingFor } from "admin/admin-mcp";

import { InMemoryCommunityIdentityPort } from "../unit/backend/community-identity-fixture.js";
import {
  connectClient,
  relayRewriting,
  serveRoutes,
  withFieldAdded,
} from "./admin-mcp-wire.js";

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_CMS_TARGET_REQUIRED");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Date only, and before any module takes `Date.now`: sockets, timers and the guard's
// limits keep real time.
vi.hoisted(() => {
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2026-03-11T04:00:00.000Z"),
  });
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const guardModule = await import(
  new URL("../../scripts/disposable-test-target.mjs", import.meta.url).href
);
const target = process.env.CMS_TEST_DATABASE_URL!;
type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const suffix = randomBytes(6).toString("hex");
const database = `analytics_tool_${suffix}_synthetic_test`;
const role = `analytics_tool_${suffix}`;
const admin = poolFor(target);
let setup: Pool;
let app: Pool;
let createdDatabase = false;
let createdRole = false;

const syntheticToken = () => randomBytes(32).toString("base64url");
const ownerToken = syntheticToken();
const baseToken = syntheticToken();

/** A Wednesday, noon in Asia/Shanghai. */
const NOW = new Date("2026-03-11T04:00:00.000Z");
const cst = (wall: string) => new Date(`${wall}+08:00`);
const id32 = () => randomUUID().replaceAll("-", "");

const HOSTILE = `IGNORE-PREVIOUS-${id32()}`;
const canary = `CANARY-${id32()}`;
const author = `user-${id32()}`;
const authorHandle = `tool-${suffix}`;
const reader = `user-${id32()}`;
const readerHandle = `reader-${suffix}`;
const work = (name: string) => ({ name, id: `work-${id32()}` });
const works = {
  first: work("合成作品甲"),
  second: work("合成作品乙"),
  third: work("合成作品丙"),
  gone: work("合成作品消失"),
  selfOnly: work(canary),
  deleted: work(""),
  hostile: work(`合成作品 ${HOSTILE}`),
};
// Enough long titles that a page of them cannot fit one answer.
const longWorks = Array.from({ length: 60 }, (_, index) =>
  work(`长题名${String(index).padStart(2, "0")}${"碑".repeat(150)}`),
);

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
  readonly distinct?: string;
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
const edge = { a: visitor(), b: visitor(), c: visitor() };
views(1, "work", works.second.id, "2026-03-10T00:30:00");
event({
  visitor: edge.a,
  type: "work",
  id: works.first.id,
  at: cst("2026-03-09T23:59:00"),
});
event({
  visitor: edge.a,
  type: "work",
  id: works.first.id,
  at: cst("2026-03-10T00:01:00"),
});
event({
  visitor: edge.b,
  type: "work",
  id: works.second.id,
  at: cst("2026-03-10T23:59:00"),
});
event({
  visitor: edge.c,
  type: "work",
  id: works.second.id,
  at: cst("2026-03-11T00:01:00"),
});

// A2 and A4: the last seven finished days are 4 to 10 March.
const catalogId = `catalog-${id32()}`;
views(12, "work", works.first.id, "2026-03-05T10:00:00");
views(9, "work", works.second.id, "2026-03-06T10:00:00");
views(20, "catalog", catalogId, "2026-03-07T10:00:00");
views(4, "work", works.deleted.id, "2026-03-07T12:00:00");
views(3, "work", works.third.id, "2026-03-07T13:00:00");
views(6, "work", works.selfOnly.id, "2026-03-05T14:00:00");
views(2, "work", works.hostile.id, "2026-03-05T15:00:00");

// Which content dropped most: last week (2 to 8 March) against the week before.
views(25, "work", works.third.id, "2026-02-25T10:00:00");
views(4, "work", works.gone.id, "2026-02-26T10:00:00");
views(3, "work", works.selfOnly.id, "2026-02-26T11:00:00");

// A partial today against the same elapsed time yesterday.
views(2, "work", works.first.id, "2026-03-10T11:59:00");
views(5, "work", works.first.id, "2026-03-10T13:00:00");

// A3: weeks across the last thirty finished days, 9 February to 10 March.
views(40, "catalog", catalogId, "2026-02-17T10:00:00");
views(6, "catalog", catalogId, "2026-02-10T10:00:00");

// A unique count across buckets: one visitor on two days.
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

// sameTarget: both open something after an impression; one opens the same work.
const funnelSame = visitor();
const funnelCross = visitor();
for (const [who, opened] of [
  [funnelSame, works.first.id],
  [funnelCross, works.second.id],
] as const) {
  event({
    visitor: who,
    name: "content_impression",
    type: "work",
    id: works.first.id,
    at: cst("2026-01-20T10:00:00"),
  });
  event({
    visitor: who,
    name: "content_open",
    type: "work",
    id: opened,
    at: cst("2026-01-20T10:01:00"),
  });
}

// One visitor's day: repeated impressions, a self-only step and text they typed.
const timeline = visitor();
const distinct = "c".repeat(40);
const stamp = (minute: string) => cst(`2026-03-11T09:${minute}:00`);
for (const minute of ["01", "02", "03"])
  event({
    visitor: timeline,
    user: reader,
    name: "content_impression",
    type: "work",
    id: works.first.id,
    at: stamp(minute),
    distinct,
  });
event({
  visitor: timeline,
  user: reader,
  name: "content_open",
  type: "work",
  id: works.selfOnly.id,
  at: stamp("04"),
  distinct,
});
event({
  visitor: timeline,
  user: reader,
  name: "search",
  surface: "search",
  type: null,
  id: null,
  at: stamp("05"),
  data: { searchQuery: HOSTILE },
  distinct,
});

// Who is here now, by when the Backend heard it.
const heard = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const online = visitor();
const onlineSelfOnly = visitor();
event({
  visitor: online,
  type: "work",
  id: works.first.id,
  at: heard(30),
  received: heard(30),
});
event({
  visitor: onlineSelfOnly,
  type: "work",
  id: works.selfOnly.id,
  at: heard(40),
  received: heard(40),
});

// A cut: sixty titled works in one day, more than one answer can hold.
longWorks.forEach((entry, index) =>
  views(100 - index, "work", entry.id, "2026-01-10T10:00:00"),
);

// A cut timeline: long text alternating, so nothing collapses.
const talker = visitor();
for (let index = 0; index < 90; index += 1)
  event({
    visitor: talker,
    name: index % 2 === 0 ? "search" : "content_open",
    surface: "search",
    type: index % 2 === 0 ? null : "work",
    id: index % 2 === 0 ? null : works.first.id,
    at: new Date(cst("2026-01-12T10:00:00").getTime() + index * 1000),
    ...(index % 2 === 0
      ? { data: { searchQuery: `${index} ${"碑".repeat(90)}` } }
      : {}),
  });

// The product report's rows that do not page: every surface at every position.
const SURFACES = [
  "home",
  "browse",
  "search",
  "detail",
  "profile",
  "thread",
  "other",
];
const shopper = visitor();
for (const surface of SURFACES)
  for (let position = 0; position <= 10; position += 1)
    event({
      visitor: shopper,
      name: "content_impression",
      surface,
      type: "work",
      id: works.first.id,
      at: cst("2026-01-05T10:00:00"),
      data: { position },
    });
for (let index = 0; index < 10; index += 1)
  event({
    visitor: shopper,
    name: "search",
    surface: "search",
    type: null,
    id: null,
    at: cst("2026-01-05T11:00:00"),
    data: { searchQuery: `${index}${"帖".repeat(99)}` },
  });

// Holds the store's first row, so the periods above sit inside what it holds.
event({
  visitor: visitor(),
  type: "work",
  id: works.first.id,
  at: cst("2025-12-01T10:00:00"),
});

const ipCanary = "198.51.100.88";

const pageViews = (start: Date, end: Date) =>
  seeded.filter(
    (seed) => seed.name === "page_view" && seed.at >= start && seed.at < end,
  );
const uniqueVisitors = (rows: readonly Seed[]) =>
  new Set(rows.map((row) => row.visitor)).size;
const uniqueSessions = (rows: readonly Seed[]) =>
  new Set(rows.map((row) => row.session)).size;

// What Umami answers. Fixed here, so its oracles are these numbers.
const site = randomUUID();
const umamiSession = randomUUID();
const funnelDefinition = randomUUID();
const goalDefinition = randomUUID();
const provinces = [
  { x: "CN-31", y: 20, country: "CN" },
  { x: "CN-11", y: 12, country: "CN" },
  { x: "CN-44", y: 5, country: "CN" },
  { x: "CN-33", y: 2, country: "CN" },
];
const statsOf = (overrides: Json = {}) => ({
  pageviews: 90,
  visitors: 40,
  accountVisitors: 7,
  legacyPageviews: 9,
  visits: 50,
  bounces: 10,
  totaltime: 5000,
  comparison: {
    pageviews: 80,
    visitors: 30,
    visits: 40,
    bounces: 20,
    totaltime: 2000,
  },
  ...overrides,
});
const send = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const umamiReply = (path: string): unknown => {
  if (path.endsWith(`/funnels/${funnelDefinition}/stats`))
    return [
      {
        type: "path",
        value: `/works/${HOSTILE}`,
        visitors: 5,
        previous: 0,
        dropped: 0,
        dropoff: null,
        remaining: 1,
      },
    ];
  if (path.endsWith(`/goals/${goalDefinition}/stats`))
    return { num: 3, total: 12 };
  if (/\/(?:funnels|goals)\/[^/]+\/stats$/u.test(path)) return null;
  if (path.endsWith("/stats")) return statsOf();
  if (path.endsWith("/metrics")) return provinces;
  if (path.endsWith("/annotations"))
    return {
      data: [
        {
          id: randomUUID(),
          date: "2026-03-05T00:00:00.000Z",
          allDay: true,
          note: `发布 ${HOSTILE}`,
        },
      ],
      count: 1,
      page: 1,
      pageSize: 100,
    };
  if (path.endsWith("/pageviews"))
    return {
      pageviews: [{ x: "2026-03-10T00:00:00Z", y: 3 }],
      sessions: [{ x: "2026-03-10T00:00:00Z", y: 2 }],
    };
  if (path.endsWith(`/sessions/${umamiSession}`))
    return {
      id: umamiSession,
      browser: `Chrome ${HOSTILE}`,
      os: "iOS",
      device: "mobile",
      screen: "390x844",
      language: "zh-CN",
      country: "CN",
      region: "CN-31",
      city: "上海",
      firstAt: "2026-03-11T01:00:00.000Z",
      lastAt: "2026-03-11T01:10:00.000Z",
      visits: 1,
      views: 4,
      events: 3,
      distinctId: distinct,
      distinctIds: [distinct],
      stitchedSessionCount: 1,
      totaltime: 600,
      canDelete: false,
      ip: ipCanary,
    };
  if (path.endsWith("/sessions"))
    return {
      data: [
        {
          id: umamiSession,
          browser: "Chrome",
          os: "iOS",
          device: "mobile",
          screen: "390x844",
          language: "zh-CN",
          country: "CN",
          region: "CN-31",
          city: "上海",
          firstAt: "2026-03-11T01:00:00.000Z",
          lastAt: "2026-03-11T01:10:00.000Z",
          visits: 1,
          views: 4,
        },
      ],
      count: 1,
      page: 1,
      pageSize: 100,
    };
  if (path.endsWith("/retention"))
    return [
      {
        date: "2026-03-01",
        day: 0,
        visitors: 3,
        returnVisitors: 3,
        percentage: 100,
      },
    ];
  if (path.endsWith("/journeys"))
    return [{ items: [`/works/${HOSTILE}`, null], count: 2 }];
  if (path.endsWith("/sessions/weekly"))
    return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1));
  if (path.endsWith("/attribution")) {
    const none: unknown[] = [];
    return {
      referrer: none,
      paidAds: none,
      utm_source: none,
      utm_medium: none,
      utm_campaign: none,
      utm_content: none,
      utm_term: none,
      total: { pageviews: 9, visitors: 3, visits: 4 },
    };
  }
  if (/\/(?:goals|funnels|segments)$/u.test(path))
    return {
      data: [
        {
          id: funnelDefinition,
          type: "funnel",
          name: `定义 ${HOSTILE}`,
          parameters: {},
        },
      ],
      count: 1,
      page: 1,
      pageSize: 20,
    };
  return null;
};

/** Replaces the answer for one test; a route with none hangs until the test ends. */
type UmamiMode = "normal" | "hang" | "down";
let umamiMode: UmamiMode = "normal";
let umamiDelayMs = 0;
/** One route down while the others answer. */
const UMAMI_DOWN = Symbol("down");
let umamiOverride:
  ((path: string, search: URLSearchParams) => unknown) | undefined;
let umamiHits: string[] = [];
let umamiActive = 0;
let umamiPeak = 0;
const hung = new Set<ServerResponse>();
let umami: Server;

const startUmami = async () => {
  umami = createServer((request, response) => {
    const url = new URL(request.url!, "http://stub.invalid");
    if (url.pathname.endsWith("/api/auth/login")) {
      request.resume();
      send(response, { token: syntheticToken() });
      return;
    }
    umamiHits.push(`${url.pathname}${url.search}`);
    umamiActive += 1;
    umamiPeak = Math.max(umamiPeak, umamiActive);
    response.on("close", () => {
      umamiActive -= 1;
    });
    if (umamiMode === "hang") {
      hung.add(response);
      return;
    }
    if (umamiMode === "down") {
      send(response, {}, 503);
      return;
    }
    const answer = (umamiOverride ?? umamiReply)(
      url.pathname,
      url.searchParams,
    );
    if (answer === UMAMI_DOWN) {
      send(response, {}, 503);
      return;
    }
    setTimeout(() => {
      send(response, answer, answer === null ? 404 : 200);
    }, umamiDelayMs);
  });
  await new Promise<void>((resolve) =>
    umami.listen(0, "127.0.0.1", () => resolve()),
  );
  return `http://127.0.0.1:${(umami.address() as AddressInfo).port}`;
};

/** A Backend that answers one way, for what the real one will not do on request. */
const startBackendStub = async (
  respond: (url: URL, response: ServerResponse) => void,
) => {
  const server = createServer((request, response) => {
    respond(new URL(request.url!, "http://stub.invalid"), response);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

let payload: Payload;
let server: Awaited<ReturnType<typeof serveRoutes>>;
let backend: Server;
let backendOrigin = "";
let umamiOrigin = "";
let aiOperator: TypedUser;
let client: Client;
let keyId = 0;
let secret = "";
const statements: string[] = [];

const auditRows = async () =>
  Number(
    (
      await (
        payload.db as unknown as Pick<PostgresAdapter, "drizzle">
      ).drizzle.execute(
        sql`SELECT count(*) AS rows FROM mcp_audit_events WHERE key_id = ${keyId} AND tool = 'admin_analytics'`,
      )
    ).rows[0]!.rows,
  );

const call = async (args: Json) => {
  const result = await client.callTool({
    name: "admin_analytics",
    arguments: args,
  });
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ADMIN_MCP_TEXT_CAP_BYTES);
  const envelope = adminMcpEnvelopeSchema.parse(result.structuredContent);
  expect(JSON.parse(text)).toEqual(envelope);
  expect(result.isError === true).toBe(!envelope.ok);
  // One way on, at the top: never a second continuation inside the answer.
  expect((envelope.data as Json | undefined)?.next).toBeUndefined();
  return envelope as Json;
};

const ok = async (args: Json): Promise<Json> => {
  const envelope = await call(args);
  expect(envelope.ok, JSON.stringify(envelope).slice(0, 500)).toBe(true);
  return envelope;
};

const wholeShares = (block: Json) =>
  Math.round(
    (block.rows.reduce((sum: number, row: Json) => sum + row.share, 0) +
      block.other.share +
      block.unknown.share +
      (block.withheld?.share ?? 0)) *
      100,
  ) / 100;

/** Every string under a value, with the path a pointer pattern must reach. */
const stringsOf = (
  value: unknown,
  path: readonly string[] = [],
): readonly { path: readonly string[]; text: string }[] => {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      stringsOf(item, [...path, String(index)]),
    );
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    stringsOf(item, [...path, key]),
  );
};

const expectHostileMarked = (envelope: Json) => {
  const hits = stringsOf(envelope.data, ["data"]).filter(({ text }) =>
    text.includes(HOSTILE),
  );
  expect(hits.length).toBeGreaterThan(0);
  for (const { path } of hits) {
    const covered = (envelope.untrusted as string[]).some((pointer) => {
      const parts = pointer.split("/").slice(1);
      return (
        parts.length === path.length &&
        parts.every((part, index) => part === "*" || part === path[index])
      );
    });
    expect(covered, path.join("/")).toBe(true);
  }
};

beforeAll(async () => {
  const probe = await admin.query(guardModule.disposableTestTargetProbeSql);
  guardModule.assertDisposableTestTarget(
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
  for (const entry of [
    works.first,
    works.second,
    works.third,
    works.gone,
    works.hostile,
    ...longWorks,
  ])
    await setup.query(
      "INSERT INTO community.works(id,author_id,title,text,first_published_at) VALUES($1,$2,$3,'合成正文',$4::timestamptz)",
      [entry.id, author, entry.name, NOW],
    );
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,visibility,created_via) VALUES($1,$2,$3,$3,'self','publishing')",
    [works.selfOnly.id, author, canary],
  );
  // Permanent deletion also sets visibility to self and empties the work.
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,visibility,deleted_at,created_via) VALUES($1,$2,'','','self',$3::timestamptz,'publishing')",
    [works.deleted.id, author, NOW],
  );
  await setup.query(
    "INSERT INTO public.catalog_discovery(catalog_id,title) VALUES($1,'合成资料')",
    [catalogId],
  );
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
          distinct_id: seed.distinct ?? "d".repeat(40),
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

  // Records what the reader sends, on the real App-role connection.
  const recording = new Proxy(app, {
    get(pool, property) {
      if (property !== "connect") return Reflect.get(pool, property) as unknown;
      return async () => {
        const connection = await pool.connect();
        const query = connection.query.bind(connection);
        return new Proxy(connection, {
          get(held, name) {
            if (name !== "query")
              return Reflect.get(held, name) as (...args: never) => unknown;
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
      }),
    },
  });
  backend = createBackendServer(application);
  const address = await startServer(backend, { host: "127.0.0.1", port: 0 });
  backendOrigin = `http://127.0.0.1:${address.port}/`;
  umamiOrigin = await startUmami();

  const config = await (await import("admin/config")).default;
  payload = await getPayload({ config });
  aiOperator = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `ai-${suffix}@example.invalid`,
      password: randomBytes(24).toString("hex"),
      role: "automation",
      scopeCatalogIds: [],
    },
  });
  aiOperator = await payload.update({
    collection: "users",
    id: aiOperator.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  secret = randomBytes(32).toString("hex");
  const key = await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: aiOperator.id,
      label: "synthetic-analytics",
      enableAPIKey: true,
      apiKey: secret,
      toolProfile: "read",
    } as never,
  });
  keyId = key.id;
  server = await serveRoutes(config);
  client = (
    await connectClient(server.endpoint, { authorization: `Bearer ${secret}` })
  ).client;
}, 120_000);

beforeEach(() => {
  analyticsCache.purge();
  umamiMode = "normal";
  umamiDelayMs = 0;
  umamiOverride = undefined;
  umamiHits = [];
  umamiPeak = 0;
  statements.length = 0;
  vi.setSystemTime(NOW);
  vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", backendOrigin);
  vi.stubEnv("OPERATOR_AI_BASE_TOKEN", baseToken);
  // The Matrix's order: analytics never needs the community token.
  vi.stubEnv("COMMUNITY_OPERATOR_AI_TOKEN", "");
  vi.stubEnv("COMMUNITY_OPERATOR_TOKEN", "");
  vi.stubEnv("UMAMI_ORIGIN", umamiOrigin);
  vi.stubEnv("UMAMI_WEBSITE_ID", site);
  vi.stubEnv("UMAMI_VIEWER_USERNAME", "synthetic-viewer");
  vi.stubEnv("UMAMI_VIEWER_PASSWORD", syntheticToken());
});

afterEach(() => {
  // A hung read ends now, not at its limit, so its slot does not outlive the test.
  for (const response of hung) response.destroy();
  hung.clear();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.useRealTimers();
  await client?.close();
  await server?.close();
  await payload?.db?.destroy?.();
  umami?.closeAllConnections();
  if (umami) await new Promise((resolve) => umami.close(resolve));
  if (backend) await stopServer(backend);
  await app?.end();
  await setup?.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
  if (createdRole) await admin.query(`DROP ROLE ${role}`);
  await admin.end();
});

const YESTERDAY = [
  cst("2026-03-10T00:00:00"),
  cst("2026-03-11T00:00:00"),
] as const;
const DAY_BEFORE = [
  cst("2026-03-09T00:00:00"),
  cst("2026-03-10T00:00:00"),
] as const;

describe("known answers on the reference paths", () => {
  it("A1: yesterday's visitors, sessions and views against the day before, by Beijing time", async () => {
    const { data } = await ok({ report: "overview", range: "yesterday" });
    const day = pageViews(...YESTERDAY);
    const before = pageViews(...DAY_BEFORE);
    // The edges really are on the days they should be, so a wrong boundary fails.
    expect(before.some((seed) => seed.visitor === edge.a)).toBe(true);
    expect(day.some((seed) => seed.visitor === edge.b)).toBe(true);
    expect(day.some((seed) => seed.visitor === edge.c)).toBe(false);
    expect(data.metrics.pageViews).toMatchObject({
      v: day.length,
      prev: before.length,
      delta: day.length - before.length,
      additive: true,
    });
    expect(data.metrics.visitorsPageView).toMatchObject({
      v: uniqueVisitors(day),
      prev: uniqueVisitors(before),
      additive: false,
    });
    expect(data.metrics.canonicalSessions.v).toBe(uniqueSessions(day));
    expect(data.range).toMatchObject({
      start: YESTERDAY[0].toISOString(),
      end: YESTERDAY[1].toISOString(),
      tz: "Asia/Shanghai",
      complete: true,
    });
  });

  it("A2: the last seven days' top pages in order and the top three provinces", async () => {
    const { data, next, meta } = await ok({
      report: "overview",
      range: "last_7_days",
      limit: 5,
    });
    const hits = new Map<string, number>();
    for (const seed of pageViews(
      cst("2026-03-04T00:00:00"),
      cst("2026-03-11T00:00:00"),
    ))
      if (seed.id !== null && seed.id !== works.selfOnly.id)
        hits.set(seed.id, (hits.get(seed.id) ?? 0) + 1);
    const expected = [...hits.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5);
    expect(
      data.topContent.rows.map((row: Json) => [row.target.id, row.count]),
    ).toEqual(expected);
    expect(data.topProvinces.rows).toEqual(
      provinces.slice(0, 3).map(({ x, y }) => ({ key: x, visitors: y })),
    );
    expect(data.source).toBe("both");
    expect(data.quality.approximateGeo).toBe(true);
    expect(meta.sources).toEqual({ canonical: "ok", umami: "ok" });
    // More than the page holds, so the one way on goes to the rows.
    expect(next).toMatchObject({
      tool: "admin_analytics",
      args: { report: "breakdown", dimension: "content", cursor: "5" },
    });
  });

  it("A3: thirty days by week, the highest and how far above the lowest", async () => {
    const { data } = await ok({
      report: "trend",
      range: "last_30_days",
      groupBy: "week",
    });
    const start = cst("2026-02-09T00:00:00").getTime();
    const end = cst("2026-03-11T00:00:00").getTime();
    const perWeek = new Map<string, number>();
    for (const bucket of data.buckets as Json[]) perWeek.set(bucket.label, 0);
    for (const seed of seeded) {
      const at = seed.at.getTime();
      if (seed.name !== "page_view" || at < start || at >= end) continue;
      const monday = new Date(at + 8 * 3_600_000);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const label = monday.toISOString().slice(0, 10);
      perWeek.set(label, (perWeek.get(label) ?? 0) + 1);
    }
    expect(
      Object.fromEntries(
        (data.buckets as Json[]).map((bucket) => [
          bucket.label,
          bucket.pageViews,
        ]),
      ),
    ).toEqual(Object.fromEntries(perWeek));
    const sorted = [...perWeek.values()].sort((a, b) => b - a);
    const top = (data.buckets as Json[]).reduce((best, bucket) =>
      bucket.pageViews > best.pageViews ? bucket : best,
    );
    expect(top.pageViews).toBe(sorted[0]);
  });

  it("A4: the most viewed work names its author and its state", async () => {
    const { data } = await ok({
      report: "breakdown",
      range: "last_7_days",
      dimension: "content",
      filter: { targetType: "work" },
      limit: 1,
    });
    expect(data.rows[0].target).toMatchObject({
      type: "work",
      id: works.first.id,
      title: works.first.name,
      authorHandle,
      state: "public",
    });
  });
});

describe("time", () => {
  it("defaults to Asia/Shanghai and moves the same events with another zone", async () => {
    const { data } = await ok({
      report: "overview",
      range: "yesterday",
      tz: "UTC",
      compare: "none",
    });
    const start = new Date("2026-03-10T00:00:00.000Z");
    const end = new Date("2026-03-11T00:00:00.000Z");
    expect(data.range.tz).toBe("UTC");
    expect(data.metrics.pageViews.v).toBe(pageViews(start, end).length);
    expect(pageViews(start, end).length).not.toBe(
      pageViews(...YESTERDAY).length,
    );
    expect(data.compare).toBeNull();
    expect(data.metrics.pageViews.prev).toBeNull();
  });

  it("reads a date-only input in the answer's zone, through the end of that day", async () => {
    const { data } = await ok({
      report: "overview",
      from: "2026-03-10",
      to: "2026-03-10",
      compare: "none",
    });
    expect(data.range.start).toBe(YESTERDAY[0].toISOString());
    expect(data.range.end).toBe(YESTERDAY[1].toISOString());
    expect(data.metrics.pageViews.v).toBe(pageViews(...YESTERDAY).length);
  });

  it.each([
    ["words", { from: "yesterday" }, "unparseable_date"],
    ["no offset", { from: "2026-03-01T10:00:00" }, "unparseable_date"],
    ["an impossible date", { from: "2026-02-30" }, "impossible_date"],
    ["an impossible hour", { from: "2026-03-01T25:00:00Z" }, "impossible_date"],
    ["a NUL", { from: "2026-03-01\u0000" }, "unparseable_date"],
    ["an unknown zone", { tz: "Mars/Olympus" }, "unknown_time_zone"],
    ["a short zone name", { tz: "CST" }, "time_zone_not_region_city"],
    [
      "a range past the data",
      { from: "2025-01-01", to: "2025-01-31" },
      "out_of_retention",
    ],
    [
      "a range and dates",
      { range: "today", from: "2026-03-01" },
      "range_or_dates_not_both",
    ],
  ])("refuses %s by name", async (_name, args, code) => {
    const answer = await call({ report: "overview", ...args });
    expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(answer.issues[0].code).toBe(code);
    expect(answer.hint).toBeDefined();
  });

  it("aligns a partial today to the time elapsed, and says so", async () => {
    const { data } = await ok({ report: "overview", range: "today" });
    const elapsed = NOW.getTime() - cst("2026-03-11T00:00:00").getTime();
    const start = cst("2026-03-10T00:00:00");
    const end = new Date(start.getTime() + elapsed);
    expect(data.range.complete).toBe(false);
    expect(data.compare).toMatchObject({
      start: start.toISOString(),
      end: end.toISOString(),
      aligned: true,
    });
    expect(data.metrics.pageViews.prev).toBe(pageViews(start, end).length);
    // Five views after noon yesterday are outside the aligned period.
    expect(pageViews(start, end).length).toBeLessThan(
      pageViews(...YESTERDAY).length,
    );
    expect(data.notes).toContain("PARTIAL_PERIOD_ALIGNED");
    // Umami's own comparison is the preceding hours, not the same hours of yesterday.
    expect(data.native.metrics.nativeVisits.prev).toBeNull();
    expect(data.notes).toContain("NATIVE_COMPARE_NOT_ALIGNED");
  });

  it("says Umami's comparison moved on a finished range of no whole minutes", async () => {
    const period = { report: "overview", from: "2026-03-10T00:00:00Z" };
    const whole = await ok({ ...period, to: "2026-03-10T10:00:00Z" });
    expect(whole.data.range.complete).toBe(true);
    expect(whole.data.native.status).toBe("fresh");
    expect(whole.data.notes).not.toContain("NATIVE_COMPARE_NOT_ALIGNED");
    const cut = await ok({ ...period, to: "2026-03-10T10:00:30Z" });
    expect(cut.data.range.complete).toBe(true);
    expect(cut.data.native.status).toBe("fresh");
    expect(cut.data.notes).toContain("NATIVE_COMPARE_NOT_ALIGNED");
  });

  it("answers a year's comparison beyond retention as outOfRetention, never a zero", async () => {
    const { data } = await ok({
      report: "overview",
      range: "last_7_days",
      compare: "year",
    });
    expect(data.compare.outOfRetention).toBe(true);
    expect(data.metrics.pageViews.prev).toBeNull();
    expect(data.metrics.pageViews.delta).toBeNull();
    expect(data.notes).toContain("COMPARE_OUT_OF_RETENTION");
    // Umami answers zeros for a period it no longer holds. That is not a number here.
    expect(data.native.metrics.nativeVisits.prev).toBeNull();
    expect(data.native.metrics.nativeVisits.v).toBe(50);
  });

  it("never adds unique counts across buckets", async () => {
    const { data } = await ok({
      report: "trend",
      from: "2026-02-12",
      to: "2026-02-13",
      groupBy: "day",
    });
    const buckets = data.buckets as Json[];
    expect(buckets.map((bucket) => bucket.visitorsAny)).toEqual([1, 1]);
    expect(data.totals.visitorsAny).toBe(1);
    expect(data.totals.pageViews).toBe(2);
  });
});

describe("never collected", () => {
  it.each(Object.keys(ANALYTICS_NOT_COLLECTED))(
    "answers %s collected:false, never empty rows",
    async (dimension) => {
      const { data } = await ok({
        report: "breakdown",
        dimension,
        range: "yesterday",
      });
      expect(data).toMatchObject({
        dimension,
        collected: false,
        source: "capability",
        quality: {},
        reason:
          ANALYTICS_NOT_COLLECTED[
            dimension as keyof typeof ANALYTICS_NOT_COLLECTED
          ],
      });
      expect(data).not.toHaveProperty("rows");
      expect(data.range.start).toBe(YESTERDAY[0].toISOString());
      expect(data.asOf).toBeDefined();
    },
  );

  it("lists them on status, with the store's own facts beside them", async () => {
    const { data } = await ok({ report: "status" });
    expect(Object.keys(data.notCollected).sort()).toEqual(
      Object.keys(ANALYTICS_NOT_COLLECTED).sort(),
    );
    expect(data.notCollected.referrer.collected).toBe(false);
    expect(data.definitions.accountVisitors).toMatch(/any event/u);
    expect(data.definitions.accountVisitors).toMatch(/page views only/u);
    expect(data).toMatchObject({ source: "canonical", quality: {} });
    expect(data.range.end).toBe(data.asOf);
    expect(Date.parse(data.range.end) - Date.parse(data.range.start)).toBe(
      86_400_000,
    );
  });

  it("gives attribution's totals and says its sources were never collected", async () => {
    const { data } = await ok({
      report: "native",
      kind: "attribution",
      step: "/works",
      range: "last_7_days",
    });
    expect(data.total).toEqual({ pageviews: 9, visitors: 3, visits: 4 });
    expect(data.referrer.collected).toBe(false);
    expect(data.utm.collected).toBe(false);
    expect(data.channel.collected).toBe(false);
    expect(data).not.toHaveProperty("paidAds");
  });
});

describe("which content dropped most", () => {
  it("ranks the largest drop first, with rows only in the base and shares of the change", async () => {
    const { data, meta } = await ok({
      report: "compare",
      range: "last_week",
      dimension: "content",
      direction: "down",
    });
    const rows = data.rows as [Json, ...Json[]];
    expect(rows[0].target.id).toBe(works.third.id);
    expect(rows[0].delta).toBeLessThan(0);
    const gone = rows.find((row) => row.target.id === works.gone.id)!;
    expect(gone).toMatchObject({ v: 0, onlyInBase: true });
    expect(meta.excluded).toEqual(["self_only"]);
    expect(data).not.toHaveProperty("excluded");
    expect(data.compare.mode).toBe("previous");
    expect(JSON.stringify(data)).not.toContain(canary);
  });
});

describe("funnel", () => {
  const steps = ["content_impression", "content_open"];
  const window = { from: "2026-01-20", to: "2026-01-20" };

  it("sameTarget differs correctly from same-visit order, and the basis is labelled", async () => {
    const loose = await ok({ report: "funnel", ...window, steps });
    const strict = await ok({
      report: "funnel",
      ...window,
      steps,
      sameTarget: true,
    });
    expect(loose.data.steps.map((step: Json) => step.count)).toEqual([2, 2]);
    expect(strict.data.steps.map((step: Json) => step.count)).toEqual([2, 1]);
    expect(loose.data.basis).toEqual({
      unit: "visitor",
      order: "same_session",
      sameTarget: false,
    });
    expect(strict.data.basis.sameTarget).toBe(true);
  });

  it("labels a saved native funnel same-visit order only, and refuses to claim more", async () => {
    const { data } = await ok({
      report: "funnel",
      ...window,
      funnelId: funnelDefinition,
    });
    expect(data).toMatchObject({
      source: "umami",
      basis: {
        order: "same_visit_order_only",
        sameTarget: false,
      },
    });
    const refused = await call({
      report: "funnel",
      ...window,
      funnelId: funnelDefinition,
      sameTarget: true,
    });
    expect(refused).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(refused.issues[0]).toMatchObject({
      path: ["sameTarget"],
      code: "not_for_this_report",
    });
  });
});

describe("who is online and what one visitor viewed", () => {
  it("names who is here now, withholding a self-only step", async () => {
    const { data, meta } = await ok({ report: "realtime" });
    const here = (data.online as Json[]).map((row) => row.visitorId);
    expect(here).toContain(online);
    const hidden = (data.online as Json[]).find(
      (row) => row.visitorId === onlineSelfOnly,
    )!;
    expect(hidden).toMatchObject({ withheld: "self_only", target: null });
    expect(data.activeVisitors).toBe(2);
    expect(data.range.complete).toBe(false);
    expect(meta.excluded).toEqual(["self_only"]);
    expect(JSON.stringify(data)).not.toContain(canary);
    expect(umamiHits).toEqual([]);
  });

  it("adds cached geography from Umami only when asked", async () => {
    const { data } = await ok({ report: "realtime", include: "umami" });
    expect(data.geography.rows[0]).toEqual({ key: "CN-31", visitors: 20 });
    expect(data.geography.status).toBe("fresh");
    expect(data.quality.approximateGeo).toBe(true);
  });

  it("collapses a visitor's day into runs, reads through today, and has no IP", async () => {
    const envelope = await ok({ report: "session", visitorId: timeline });
    const { data } = envelope;
    const runs = data.runs as Json[];
    expect(runs[0]).toMatchObject({
      event: "content_impression",
      count: 3,
      target: { id: works.first.id },
    });
    expect(runs[1]).toMatchObject({ withheld: "self_only", target: null });
    expect(runs[2]).toMatchObject({ event: "search", query: HOSTILE });
    expect(data.accounts[0].handle).toBe(readerHandle);
    expect(data.range.complete).toBe(false);
    const text = JSON.stringify(envelope);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(ipCanary);
    expect(text).not.toMatch(/"ip"/u);
    expect(data.umami).toEqual({
      status: "not_read",
      reason: "NEEDS_UMAMI_SESSION_ID",
    });
    expectHostileMarked(envelope);
  });

  it("answers include:ip withheld, with no query against the observations", async () => {
    for (const report of ["session", "sessions"]) {
      const { data } = await ok({
        report,
        visitorId: timeline,
        include: "ip",
      });
      expect(data.ip).toEqual({ withheld: true, switch: "rawIp" });
    }
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.join("\n")).not.toContain("analytics_ip_observations");
  });

  it("starts from a Umami session: its device and approximate place beside the timeline", async () => {
    const envelope = await ok({
      report: "session",
      umamiSessionId: umamiSession,
    });
    const { data, meta } = envelope;
    expect(data.source).toBe("both");
    expect(data.summary.events).toBe(5);
    expect(data.umami).toMatchObject({
      umamiSessionId: umamiSession,
      region: "CN-31",
      city: "上海",
      approximateGeo: true,
      distinctIds: [distinct],
    });
    expect(data.quality.approximateGeo).toBe(true);
    expect(JSON.stringify(data)).not.toContain(ipCanary);
    expect(meta.sources).toEqual({ canonical: "ok", umami: "ok" });
    expectHostileMarked(envelope);
  });

  it("says when a Umami session has no account to read a timeline by, and when it has two", async () => {
    const second = "e".repeat(40);
    umamiOverride = (path) =>
      path.endsWith(`/sessions/${umamiSession}`)
        ? { ...(umamiReply(path) as Json), distinctId: null, distinctIds: [] }
        : umamiReply(path);
    const none = await ok({
      report: "session",
      umamiSessionId: umamiSession,
      include: "ip",
    });
    expect(none.data).toMatchObject({
      source: "umami",
      notes: ["NO_DISTINCT_ID_SO_NO_TIMELINE"],
      ip: { withheld: true, switch: "rawIp" },
    });
    expect(none.data).not.toHaveProperty("runs");
    expect(none.meta.partial).toBe(true);
    analyticsCache.purge();
    umamiOverride = (path) =>
      path.endsWith(`/sessions/${umamiSession}`)
        ? { ...(umamiReply(path) as Json), distinctIds: [distinct, second] }
        : umamiReply(path);
    const two = await ok({ report: "session", umamiSessionId: umamiSession });
    expect(two.data.subject.distinctId).toBe(distinct);
    expect(two.data.notes).toContain("OTHER_DISTINCT_IDS_NOT_READ");
    expect(two.data.umami.distinctIds).toEqual([distinct, second]);
  });

  it("answers include:ip withheld on Umami's session rows as well", async () => {
    const { data } = await ok({
      report: "sessions",
      include: "ip",
      filter: { region: "CN-31" },
    });
    expect(data.source).toBe("umami");
    expect(data.ip).toEqual({ withheld: true, switch: "rawIp" });
  });

  it("asks Umami for sessions by place, and only Umami answers", async () => {
    const { data } = await ok({
      report: "sessions",
      filter: { region: "CN-31" },
      include: "umami",
    });
    expect(data.source).toBe("umami");
    expect(data.rows[0]).toMatchObject({
      umamiSessionId: umamiSession,
      region: "CN-31",
    });
    expect(data.quality.approximateGeo).toBe(true);
    expect(umamiHits.some((hit) => hit.includes("region=CN-31"))).toBe(true);
  });
});

describe("a self-only work", () => {
  const sweep: readonly Json[] = [
    { report: "overview", range: "last_7_days" },
    { report: "breakdown", range: "last_7_days", dimension: "content" },
    {
      report: "compare",
      range: "last_week",
      dimension: "content",
      direction: "abs",
    },
    { report: "product", range: "last_7_days" },
    { report: "realtime" },
    { report: "session", visitorId: timeline },
    { report: "sessions", visitorId: timeline },
  ];

  it.each(sweep.map((args) => [args.report as string, args] as const))(
    "leaves no trace in %s: neither its title nor its id",
    async (_report, args) => {
      const text = JSON.stringify(await ok(args));
      expect(text).not.toContain(canary);
      expect(text).not.toContain(works.selfOnly.id);
    },
  );

  it("collapses into one withheld row, and shares still add to 100 percent", async () => {
    const { data, meta } = await ok({
      report: "breakdown",
      range: "last_7_days",
      dimension: "content",
      limit: 3,
    });
    expect(data.withheld).toMatchObject({ count: 6, reason: "self_only" });
    expect(wholeShares(data)).toBe(100);
    expect(meta.excluded).toEqual(["self_only"]);
  });

  it("refuses a filter that names it", async () => {
    const refused = await call({
      report: "breakdown",
      range: "last_7_days",
      dimension: "content",
      filter: { targetType: "work", targetId: works.selfOnly.id },
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "SELF_ONLY_OWNER_REVIEW",
    });
  });

  it("leaves a cached answer within a minute of being set self-only", async () => {
    const breakdown = {
      report: "breakdown",
      range: "last_week",
      dimension: "content",
      limit: 100,
    };
    const scoped = {
      report: "trend",
      range: "last_week",
      filter: { targetType: "work", targetId: works.first.id },
    };
    const before = await ok(breakdown);
    const row = (before.data.rows as Json[]).find(
      (entry) => entry.target.id === works.first.id,
    )!;
    await ok(scoped);
    await setup.query(
      "UPDATE community.works SET visibility='self' WHERE id=$1",
      [works.first.id],
    );
    try {
      vi.setSystemTime(NOW.getTime() + 61_000);
      const after = await ok(breakdown);
      const text = JSON.stringify(after);
      expect(text).not.toContain(works.first.name);
      expect(text).not.toContain(works.first.id);
      expect(after.data.withheld.count).toBe(
        before.data.withheld.count + row.count,
      );
      expect(await call(scoped)).toMatchObject({
        ok: false,
        code: "SELF_ONLY_OWNER_REVIEW",
      });
    } finally {
      await setup.query(
        "UPDATE community.works SET visibility='public' WHERE id=$1",
        [works.first.id],
      );
    }
  });

  const finished = { from: "2026-03-02", to: "2026-03-08" };
  it.each([
    ["overview", { report: "overview", ...finished }],
    ["breakdown", { report: "breakdown", ...finished, dimension: "content" }],
    ["compare", { report: "compare", ...finished, dimension: "content" }],
    ["product", { report: "product", ...finished }],
    ["session", { report: "session", ...finished, visitorId: timeline }],
    ["sessions", { report: "sessions", ...finished }],
  ])(
    "reads %s again after a minute, however long its period has been over",
    async (_report, args) => {
      await ok(args);
      vi.setSystemTime(NOW.getTime() + 59_000);
      expect((await ok(args)).data.cache.hit).toBe(true);
      vi.setSystemTime(NOW.getTime() + 61_000);
      expect((await ok(args)).data.cache.hit).toBe(false);
    },
  );

  it("keeps the longer life of a report that names no target", async () => {
    const args = { report: "trend", ...finished };
    await ok(args);
    vi.setSystemTime(NOW.getTime() + 3_600_000);
    expect((await ok(args)).data.cache.hit).toBe(true);
  });

  it("does not take in a deleted work, which stays its own row with no title", async () => {
    const { data } = await ok({
      report: "breakdown",
      range: "last_7_days",
      dimension: "content",
      limit: 100,
    });
    const row = (data.rows as Json[]).find(
      (entry) => entry.target.id === works.deleted.id,
    )!;
    expect(row.target).toMatchObject({ state: "deleted", title: null });
    expect(row.count).toBe(4);
    expect(data.withheld.count).toBe(6);
  });
});

describe("size", () => {
  const titled = {
    report: "breakdown",
    from: "2026-01-10",
    to: "2026-01-10",
    dimension: "content",
    limit: 100,
  };

  it("cuts by whole rows, says so, and recomputes what the rows left out", async () => {
    const { data, next, meta, remaining } = await ok(titled);
    const rows = data.rows as Json[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    expect(meta.truncated).toBe(true);
    expect(remaining).toBe(60 - rows.length);
    expect(next.tool).toBe("admin_analytics");
    expect(next.args.cursor).toBe(String(rows.length));
    const total = longWorks.reduce(
      (sum, _entry, index) => sum + 100 - index,
      0,
    );
    expect(data.total).toBe(total);
    expect(data.other.count).toBe(
      total - rows.reduce((sum, row) => sum + row.count, 0),
    );
    expect(wholeShares(data)).toBe(100);
    expect(data.quality.truncated).toBe(true);
  });

  it("reaches every row exactly once by following next, then stops", async () => {
    const seen: string[] = [];
    let args: Json | undefined = titled;
    for (let page = 0; args !== undefined && page < 30; page += 1) {
      const answer: Json = await ok(args);
      seen.push(...answer.data.rows.map((row: Json) => row.target.id));
      expect(answer.data).not.toHaveProperty("next");
      args = answer.next?.args as Json | undefined;
    }
    expect(args).toBeUndefined();
    expect(seen.sort()).toEqual(longWorks.map((entry) => entry.id).sort());
  });

  it("sets next on a whole page with more to come, without calling it cut", async () => {
    const { next, meta, data } = await ok({ ...titled, limit: 2 });
    expect(data.rows).toHaveLength(2);
    expect(next.args).toMatchObject({ cursor: "2", limit: 2 });
    expect(meta).not.toHaveProperty("truncated");
    const last = await ok({ ...titled, limit: 100, cursor: "59" });
    expect(last.data.rows).toHaveLength(1);
    expect(last).not.toHaveProperty("next");
  });

  it("cuts a long timeline and goes on from the last event kept", async () => {
    const args = {
      report: "session",
      visitorId: talker,
      from: "2026-01-12",
      to: "2026-01-12",
    };
    const first = await ok(args);
    expect(first.meta.truncated).toBe(true);
    expect(first.next.args.cursor).toBeDefined();
    let events = first.data.runs.reduce(
      (sum: number, run: Json) => sum + run.count,
      0,
    );
    let cursor = first.next.args.cursor as string | undefined;
    for (let page = 0; cursor !== undefined && page < 30; page += 1) {
      const answer: Json = await ok({ ...args, cursor });
      events += answer.data.runs.reduce(
        (sum: number, run: Json) => sum + run.count,
        0,
      );
      cursor = answer.next?.args.cursor as string | undefined;
    }
    expect(cursor).toBeUndefined();
    expect(events).toBe(90);
    expect(first.data.summary.events).toBe(90);
  });

  it("fits every surface at every position, because those rows have no next", async () => {
    const { data, meta } = await ok({
      report: "product",
      from: "2026-01-05",
      to: "2026-01-05",
    });
    expect(Object.keys(data.byPosition.surfaces).sort()).toEqual(
      [...SURFACES].sort(),
    );
    expect(data.byPosition.surfaces.home["10+"]).toEqual([1, 0, 0]);
    expect(data.search.topQueries).toHaveLength(10);
    expect(meta).not.toHaveProperty("truncated");
  });

  it("cuts an overview's rows and goes on in the breakdown that holds the rest", async () => {
    const { data, next, meta } = await ok({
      report: "overview",
      from: "2026-01-10",
      to: "2026-01-10",
      compare: "none",
      limit: 100,
    });
    const rows = data.topContent.rows as Json[];
    expect(rows.length).toBeLessThan(60);
    expect(meta.truncated).toBe(true);
    expect(next.args).toMatchObject({
      report: "breakdown",
      dimension: "content",
      from: "2026-01-10",
      cursor: String(rows.length),
    });
    expect(wholeShares(data.topContent)).toBe(100);
    const rest = await ok(next.args);
    expect(rest.data.rows[0].target.id).toBe(longWorks[rows.length]!.id);
  });

  it("cuts a comparison, with what the rows left out recomputed", async () => {
    const { data, next, meta } = await ok({
      report: "compare",
      from: "2026-01-10",
      to: "2026-01-10",
      dimension: "content",
      limit: 100,
    });
    const rows = data.rows as Json[];
    expect(rows.length).toBeLessThan(60);
    expect(meta.truncated).toBe(true);
    expect(data.other.v).toBe(
      longWorks.reduce((sum, _entry, index) => sum + 100 - index, 0) -
        rows.reduce((sum, row) => sum + row.v, 0),
    );
    expect(next.args.cursor).toBe(String(rows.length));
  });

  it("cuts an hourly trend, with its totals on every page, and reaches every bucket", async () => {
    const args = { report: "trend", range: "last_7_days", groupBy: "hour" };
    const labels: string[] = [];
    let cursor: string | undefined;
    let cuts = 0;
    let totals: Json | undefined;
    for (let page = 0; page < 30; page += 1) {
      const answer: Json = await ok(
        cursor === undefined ? args : { ...args, cursor },
      );
      labels.push(...answer.data.buckets.map((bucket: Json) => bucket.label));
      if (answer.meta.truncated) cuts += 1;
      totals ??= answer.data.totals;
      expect(answer.data.totals).toEqual(totals);
      cursor = answer.next?.args.cursor as string | undefined;
      if (cursor === undefined) break;
    }
    expect(cuts).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(7 * 24);
    expect(labels).toHaveLength(7 * 24);
  });

  it("cuts a page of sessions on its keyset, without losing or repeating one", async () => {
    const args = {
      report: "sessions",
      from: "2026-01-10",
      to: "2026-01-10",
      limit: 100,
    };
    const seen: string[] = [];
    let cursor: string | undefined;
    let cuts = 0;
    for (let page = 0; page < 30; page += 1) {
      const answer: Json = await ok(
        cursor === undefined ? args : { ...args, cursor },
      );
      seen.push(...answer.data.rows.map((row: Json) => row.sessionId));
      if (answer.meta.truncated) cuts += 1;
      cursor = answer.next?.args.cursor as string | undefined;
      if (cursor === undefined) break;
    }
    expect(cuts).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(60);
    expect(seen).toHaveLength(60);
  });

  describe("across the size boundary", () => {
    /** The real store's cursor: the row's time and id, the same length every time. */
    const keysetOf = (index: number) =>
      Buffer.from(
        `2026-01-14T10:00:00.000000Z|${uuidOf(index)}`,
        "utf8",
      ).toString("base64url");
    const uuidOf = (index: number) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const framed = {
      source: "canonical",
      asOf: NOW.toISOString(),
      range: {
        start: "2026-01-13T16:00:00.000Z",
        end: "2026-01-14T16:00:00.000Z",
        tz: "Asia/Shanghai",
        complete: true,
        dataFrom: "2025-11-30T16:00:00.000Z",
      },
      notes: [],
    };
    /** A Backend in the real store's order: limit + 1, then a strict keyset. */
    const keysetBackend = (
      total: number,
      defaultLimit: number,
      answer: (rows: readonly number[], more: Json) => Json,
    ) =>
      startBackendStub((url, response) => {
        const limit = Number(url.searchParams.get("limit") ?? defaultLimit);
        const cursor = url.searchParams.get("cursor");
        const from =
          cursor === null
            ? 0
            : Number(
                Buffer.from(cursor, "base64url")
                  .toString("utf8")
                  .split("-")
                  .at(-1),
              ) + 1;
        const rows = Array.from(
          { length: Math.min(limit, total - from) },
          (_, offset) => from + offset,
        );
        const hasMore = from + rows.length < total;
        send(
          response,
          answer(rows, {
            quality: hasMore ? { truncated: true } : {},
            ...(hasMore ? { next: { cursor: keysetOf(rows.at(-1)!) } } : {}),
          }),
        );
      });

    const sessionsOf =
      (name: (index: number) => string) =>
      (rows: readonly number[], more: Json) => ({
        report: "sessions",
        ...framed,
        ...more,
        excluded: [],
        rows: rows.map((index) => ({
          sessionId: uuidOf(index),
          visitorId: uuidOf(index),
          distinctIds: ["d".repeat(40)],
          account: {
            id: `user-${"a".repeat(32)}`,
            handle: "walker",
            displayName: name(index),
            status: "active",
          },
          firstAt: "2026-01-14T02:00:00.000Z",
          lastAt: "2026-01-14T02:00:00.000Z",
          events: 1,
          pageViews: 1,
          contentOpens: 0,
        })),
      });

    const walk = async (
      args: Json,
      idsOf: (data: Json) => readonly string[],
    ) => {
      const seen: string[] = [];
      let next: Json | undefined = args;
      for (let page = 0; next !== undefined && page < 40; page += 1) {
        const answer: Json = await ok(next);
        seen.push(...idsOf(answer.data));
        next = answer.next?.args as Json | undefined;
      }
      expect(next).toBeUndefined();
      return seen;
    };

    const sessionIds = (data: Json) =>
      (data.rows as Json[]).map((row) => row.sessionId as string);
    const window = { from: "2026-01-14", to: "2026-01-14" };

    it("reaches every session exactly once, whatever size an answer lands on", async () => {
      const total = 30;
      let length = 1;
      const stub = await keysetBackend(
        total,
        10,
        sessionsOf(() => "x".repeat(length)),
      );
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const everyone = Array.from({ length: total }, (_, index) =>
          uuidOf(index),
        );
        for (length = 1; length <= 100; length += 1) {
          analyticsCache.purge();
          const seen = await walk(
            { report: "sessions", ...window, limit: 100 },
            sessionIds,
          );
          expect(seen, `name of ${length}`).toEqual(everyone);
        }
      } finally {
        await stub.close();
      }
    });

    it("reaches every event of a timeline exactly once, whatever size an answer lands on", async () => {
      const total = 60;
      let length = 1;
      const atOf = (index: number) =>
        new Date(Date.parse("2026-01-14T02:00:00.000Z") + index * 1000);
      const stub = await keysetBackend(total, 100, (rows, more) => ({
        report: "session",
        ...framed,
        ...more,
        excluded: ["self_only"],
        subject: { visitorId: uuidOf(0) },
        summary: {
          events: total,
          sessions: 1,
          visitors: 1,
          firstAt: atOf(0).toISOString(),
          lastAt: atOf(total - 1).toISOString(),
        },
        accounts: [],
        runs: rows.map((index) => ({
          event: index % 2 === 0 ? "search" : "content_open",
          surface: index % 2 === 0 ? "search" : "detail",
          target:
            index % 2 === 0
              ? null
              : {
                  type: "work",
                  id: works.first.id,
                  title: works.first.name,
                  authorHandle,
                  state: "public",
                },
          count: 1,
          firstAt: atOf(index).toISOString(),
          lastAt: atOf(index).toISOString(),
          dwellMs: null,
          query: index % 2 === 0 ? "q".repeat(length) : null,
        })),
      }));
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const every = Array.from({ length: total }, (_, index) =>
          atOf(index).toISOString(),
        );
        for (length = 1; length <= 100; length += 1) {
          analyticsCache.purge();
          const seen = await walk(
            { report: "session", ...window, visitorId: uuidOf(0) },
            (data) => (data.runs as Json[]).map((run) => run.firstAt as string),
          );
          expect(seen, `text of ${length}`).toEqual(every);
        }
      } finally {
        await stub.close();
      }
    });

    it("leaves room for an invisible character's flag, so its answer is not cut again", async () => {
      const total = 30;
      const limit = 20;
      let pad = 1;
      let extra = 0;
      const stub = await keysetBackend(
        total,
        10,
        sessionsOf((index) =>
          index === 0 ? `\u200b${"y".repeat(extra)}` : "x".repeat(pad),
        ),
      );
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const args = { report: "sessions", ...window, limit };
        const everyone = Array.from({ length: total }, (_, index) =>
          uuidOf(index),
        );
        // Brought near the cap by every row, then across it one byte at a time.
        const near = Buffer.byteLength(JSON.stringify(await ok(args)));
        pad += Math.floor((ADMIN_MCP_TEXT_CAP_BYTES - 40 - near) / (limit - 1));
        for (extra = 0; extra <= 60; extra += 1) {
          analyticsCache.purge();
          const seen = await walk(args, sessionIds);
          expect(seen, `extra of ${extra}`).toEqual(everyone);
        }
      } finally {
        await stub.close();
      }
    });

    it("measures the answer a cut read really gave, not the room it set aside", async () => {
      const total = 30;
      let length = 1;
      const plain = sessionsOf(() => "x".repeat(length));
      // A read of fewer rows can come back with more beside them than the first had.
      const stub = await keysetBackend(total, 10, (rows, more) => ({
        ...plain(rows, more),
        notes: rows.length < total ? ["N".repeat(80)] : [],
      }));
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const everyone = Array.from({ length: total }, (_, index) =>
          uuidOf(index),
        );
        for (length = 1; length <= 100; length += 1) {
          analyticsCache.purge();
          const seen = await walk(
            { report: "sessions", ...window, limit: 100 },
            sessionIds,
          );
          expect(seen, `name of ${length}`).toEqual(everyone);
        }
      } finally {
        await stub.close();
      }
    });

    it("keeps its way on when one row fills an answer to just under the cap", async () => {
      let length = 1;
      const stub = await keysetBackend(
        2,
        10,
        sessionsOf(() => "x".repeat(length)),
      );
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const args = { report: "sessions", ...window, limit: 1 };
        const bytes = (answer: Json) =>
          Buffer.byteLength(JSON.stringify(answer));
        length += ADMIN_MCP_TEXT_CAP_BYTES - 8 - bytes(await ok(args));
        analyticsCache.purge();
        const full = await ok(args);
        expect(bytes(full)).toBeGreaterThan(ADMIN_MCP_TEXT_CAP_BYTES - 16);
        expect(full.next).toBeDefined();
        analyticsCache.purge();
        expect(await walk(args, sessionIds)).toEqual([uuidOf(0), uuidOf(1)]);
      } finally {
        await stub.close();
      }
    });
  });

  it("holds the overview's whole answer under 3 KB with five titled rows and Umami's block", async () => {
    const answer = await ok({ report: "overview", range: "last_7_days" });
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      3_000,
    );
  });
});

describe("untrusted text", () => {
  it.each([
    [
      "titles in a breakdown",
      {
        report: "breakdown",
        range: "last_7_days",
        dimension: "content",
        limit: 100,
      },
    ],
    [
      "titles in an overview",
      { report: "overview", range: "last_7_days", limit: 100 },
    ],
    ["annotations on a trend", { report: "trend", range: "last_7_days" }],
    [
      "search text in product",
      { report: "product", from: "2026-03-11", to: "2026-03-11" },
    ],
    [
      "a saved funnel's step",
      {
        report: "funnel",
        from: "2026-01-20",
        to: "2026-01-20",
        funnelId: funnelDefinition,
      },
    ],
    [
      "a journey's paths",
      { report: "native", kind: "journey", range: "last_7_days" },
    ],
    [
      "a definition's name",
      { report: "native", kind: "funnel", range: "last_7_days" },
    ],
  ])("marks %s", async (_name, args) => {
    expectHostileMarked(await ok(args));
  });

  it("keeps the pointers short, however many rows there are", async () => {
    const { untrusted } = await ok({
      report: "breakdown",
      from: "2026-01-10",
      to: "2026-01-10",
      dimension: "content",
      limit: 5,
    });
    expect(untrusted).toEqual(
      expect.arrayContaining([
        "/data/rows/*/target/title",
        "/data/rows/*/target/authorHandle",
      ]),
    );
    expect(untrusted.length).toBeLessThanOrEqual(3);
  });
});

describe("Umami's path", () => {
  it("answers a province breakdown with rows, total, other and unknown adding to 100", async () => {
    const { data, next, meta } = await ok({
      report: "breakdown",
      dimension: "province",
      range: "last_7_days",
      limit: 2,
    });
    expect(data).toMatchObject({
      source: "umami",
      metric: "visitorsPageView",
      additive: false,
      total: 40,
      shareBasis: "total",
    });
    expect(data.rows).toEqual([
      expect.objectContaining({ key: "CN-31", visitors: 20, share: 50 }),
      expect.objectContaining({ key: "CN-11", visitors: 12, share: 30 }),
    ]);
    expect(data.other).toEqual({ count: 7, share: 17.5 });
    expect(data.unknown).toEqual({ count: 1, share: 2.5 });
    expect(wholeShares(data)).toBe(100);
    expect(data.quality).toMatchObject({
      approximateGeo: true,
      unknownShare: 2.5,
      legacyShare: 10,
      truncated: true,
    });
    expect(next.args.cursor).toBe("2");
    expect(meta.sources).toEqual({ umami: "ok" });
    expect(data.range.dataFrom).toBeDefined();
  });

  it("will not sum unique rows into a total: past the total it divides the rows and says so", async () => {
    umamiOverride = (path) =>
      path.endsWith("/stats") ? statsOf({ visitors: 30 }) : umamiReply(path);
    const { data } = await ok({
      report: "breakdown",
      dimension: "province",
      range: "last_7_days",
    });
    expect(data.total).toBe(30);
    expect(data.shareBasis).toBe("place_rows");
    expect(data.unknown).toEqual({ count: null, share: null });
    expect(wholeShares({ ...data, unknown: { share: 0 } })).toBe(100);
  });

  it("names a total it could not read, and still gives the rows", async () => {
    umamiOverride = (path) =>
      path.endsWith("/stats") ? statsOf({ visitors: null }) : umamiReply(path);
    const { data, meta } = await ok({
      report: "breakdown",
      dimension: "city",
      range: "last_7_days",
    });
    expect(data.total).toBeNull();
    expect(data.unknown.count).toBeNull();
    expect(data.notes).toContain("UMAMI_TOTAL_NOT_READ");
    expect(meta.partial).toBe(true);
  });

  it("divides fresh rows by no total read at another moment", async () => {
    const args = {
      report: "breakdown",
      dimension: "province",
      range: "today",
    };
    await ok(args);
    vi.setSystemTime(NOW.getTime() + 61_000);
    umamiOverride = (path) =>
      path.endsWith("/stats") ? UMAMI_DOWN : umamiReply(path);
    const { data, meta } = await ok(args);
    expect(data.status).toBe("fresh");
    expect(data.total).toBeNull();
    expect(data.unknown).toEqual({ count: null, share: null });
    expect(data.shareBasis).toBe("place_rows");
    expect(data.notes).toContain("UMAMI_TOTAL_NOT_READ");
    expect(data.quality).not.toHaveProperty("legacyShare");
    expect(data.quality).not.toHaveProperty("unknownShare");
    expect(data.rows[0]).toMatchObject({ key: "CN-31", visitors: 20 });
    expect(meta.partial).toBe(true);
    expect(meta.sources.umami).toBe("failed");
  });

  it("does not divide stale rows by a total read later either", async () => {
    const args = {
      report: "breakdown",
      dimension: "province",
      range: "today",
    };
    await ok(args);
    vi.setSystemTime(NOW.getTime() + 61_000);
    umamiOverride = (path) =>
      path.endsWith("/metrics") ? UMAMI_DOWN : umamiReply(path);
    const { data, meta } = await ok(args);
    expect(data.status).toBe("stale");
    expect(data.total).toBeNull();
    expect(data.notes).toContain("STALE_ANSWER");
    expect(meta.partial).toBe(true);
  });

  it("refuses a range past retention before Umami can read it as empty", async () => {
    const answer = await call({
      report: "breakdown",
      dimension: "province",
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(answer.issues[0].code).toBe("out_of_retention");
    expect(umamiHits).toEqual([]);
  });

  it("says when Umami's rows stopped at its cap, and claims no unknown past it", async () => {
    umamiOverride = (path) =>
      path.endsWith("/metrics")
        ? Array.from({ length: 500 }, (_, index) => ({
            x: `place-${index}`,
            y: 1,
          }))
        : path.endsWith("/stats")
          ? statsOf({ visitors: 600 })
          : umamiReply(path);
    const { data } = await ok({
      report: "breakdown",
      dimension: "city",
      range: "last_7_days",
      limit: 2,
    });
    expect(data.notes).toContain("ROWS_CAPPED_AT_500");
    expect(data.quality.truncated).toBe(true);
    expect(data.unknown).toEqual({ count: null, share: null });
    expect(data.total).toBe(600);
    expect(data.other.count).toBe(598);
    expect(wholeShares({ ...data, unknown: { share: 0 } })).toBe(100);
  });

  it("refuses a canonical filter on Umami's dimensions, and a Umami filter on a canonical one", async () => {
    const onUmami = await call({
      report: "breakdown",
      dimension: "province",
      range: "last_7_days",
      filter: { surface: "home" },
    });
    expect(onUmami.code).toBe("INPUT_INVALID");
    const onCanonical = await call({
      report: "breakdown",
      dimension: "content",
      range: "last_7_days",
      filter: { region: "CN-31" },
    });
    expect(onCanonical.code).toBe("INPUT_INVALID");
    expect(umamiHits).toEqual([]);
  });

  it("does not read site-wide places beside a filtered overview, and says so", async () => {
    const { data, meta } = await ok({
      report: "overview",
      range: "last_7_days",
      filter: { surface: "detail" },
    });
    expect(data.source).toBe("canonical");
    expect(data).not.toHaveProperty("topProvinces");
    expect(data.notes).toContain("UMAMI_NOT_READ_FOR_A_FILTER");
    expect(meta.sources).toEqual({ canonical: "ok" });
    expect(umamiHits).toEqual([]);
  });

  it("gives the canonical numbers at once when Umami hangs, and names what is missing", async () => {
    umamiMode = "hang";
    const started = performance.now();
    const { data, meta } = await ok({ report: "overview", range: "yesterday" });
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(data.metrics.pageViews.v).toBe(pageViews(...YESTERDAY).length);
    expect(data.source).toBe("canonical");
    expect(data.native).toMatchObject({
      status: "failed",
      code: "UMAMI_QUERY_TIMEOUT",
      reason: "timed_out",
      retryAfterMs: expect.any(Number) as number,
    });
    expect(data.native).not.toHaveProperty("metrics");
    expect(data.topProvinces.code).toBe("UMAMI_QUERY_TIMEOUT");
    expect(meta).toMatchObject({
      partial: true,
      sources: { canonical: "ok", umami: "timed_out" },
    });
  });

  it("stands in the last answer marked stale, with its age, when Umami goes away", async () => {
    const args = { report: "overview", range: "last_7_days" };
    await ok(args);
    vi.setSystemTime(NOW.getTime() + 7 * 3_600_000);
    umamiMode = "down";
    const { data, meta } = await ok(args);
    expect(data.topProvinces).toMatchObject({
      status: "stale",
      cache: { hit: true, stale: true, ageMs: 7 * 3_600_000 },
    });
    expect(data.source).toBe("both");
    expect(meta.sources.umami).toBe("failed");
  });

  it("marks a whole Umami answer stale too, and names the reason it stands in", async () => {
    const args = {
      report: "breakdown",
      dimension: "province",
      range: "last_7_days",
    };
    await ok(args);
    vi.setSystemTime(NOW.getTime() + 7 * 3_600_000);
    umamiMode = "down";
    const { data } = await ok(args);
    expect(data).toMatchObject({
      status: "stale",
      reason: "unavailable",
      retryAfterMs: expect.any(Number) as number,
      cache: { stale: true, ageMs: 7 * 3_600_000 },
    });
    expect(data.notes).toContain("STALE_ANSWER");
    expect(data.rows[0].key).toBe("CN-31");
    // Both stale, so the total still divides the rows it was read with.
    expect(data.total).toBe(40);
    expect(data.shareBasis).toBe("total");
  });

  it("answers a whole Umami breakdown UMAMI_QUERY_TIMEOUT with no number when it is down", async () => {
    umamiMode = "down";
    const answer = await call({
      report: "breakdown",
      dimension: "province",
      range: "yesterday",
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "UMAMI_QUERY_TIMEOUT",
      data: { reason: "unavailable" },
      retryable: true,
    });
    expect(answer.data.retryAfterMs).toBeGreaterThan(0);
    expect(answer.data).not.toHaveProperty("rows");
  });

  it("never holds more than two pool connections, however many calls arrive", async () => {
    umamiDelayMs = 60;
    await Promise.all(
      ["CN-31", "CN-11", "CN-44", "CN-33", "CN-50", "CN-51"].map((region) =>
        ok({
          report: "breakdown",
          dimension: "city",
          range: "yesterday",
          filter: { region },
        }),
      ),
    );
    expect(umamiHits.length).toBe(12);
    expect(umamiPeak).toBeLessThanOrEqual(2);
    expect(umamiPeak).toBeGreaterThan(1);
  });

  it("sends identical parallel calls upstream once", async () => {
    umamiDelayMs = 80;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        ok({ report: "breakdown", dimension: "device", range: "yesterday" }),
      ),
    );
    expect(umamiHits.filter((hit) => hit.includes("/metrics"))).toHaveLength(1);
    expect(umamiHits.filter((hit) => hit.includes("/stats"))).toHaveLength(1);
  });

  it("names native reports and a definition that is not there", async () => {
    const retention = await ok({
      report: "native",
      kind: "retention",
      range: "last_7_days",
    });
    expect(retention.data).toMatchObject({
      source: "umami",
      kind: "retention",
      outOfRetention: false,
      rows: [{ visitors: 3 }],
    });
    const goal = await ok({
      report: "native",
      kind: "goal",
      goalId: goalDefinition,
      range: "last_7_days",
    });
    expect(goal.data.goal).toEqual({ num: 3, total: 12, rate: 25 });
    const missing = await call({
      report: "native",
      kind: "goal",
      goalId: randomUUID(),
      range: "last_7_days",
    });
    expect(missing.code).toBe("NOT_FOUND");
    const needsKind = await call({ report: "native", range: "last_7_days" });
    expect(needsKind.issues[0]).toMatchObject({
      path: ["kind"],
      code: "required",
    });
  });

  describe("a list of definitions", () => {
    /** As pinned Umami pages: 20 rows unless asked, and `count` is all it holds. */
    const definitions =
      (held: number) => (path: string, search: URLSearchParams) =>
        path.endsWith("/segments")
          ? {
              data: Array.from(
                {
                  length: Math.min(held, Number(search.get("pageSize") ?? 20)),
                },
                (_, index) => ({
                  id: randomUUID(),
                  type: "segment",
                  name: `定义 ${index}`,
                  parameters: {},
                }),
              ),
              count: held,
              page: 1,
              pageSize: Number(search.get("pageSize") ?? 20),
            }
          : umamiReply(path);
    const args = { report: "native", kind: "segment", range: "last_7_days" };

    it("asks for what it needs and states what Umami holds", async () => {
      umamiOverride = definitions(25);
      const { data, next } = await ok(args);
      expect(data.total).toBe(25);
      expect(data.rows).toHaveLength(25);
      expect(data.quality).toEqual({});
      expect(data.notes).not.toContain("ROWS_CAPPED_AT_500");
      expect(next).toBeUndefined();
      expect(umamiHits.at(-1)).toContain("pageSize=500");
    });

    it("reaches every row of a list by limit, then stops", async () => {
      umamiOverride = definitions(25);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const answer: Json = await ok({
          ...args,
          limit: 10,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(answer.data.total).toBe(25);
        seen.push(...answer.data.rows.map((row: Json) => row.name as string));
        cursor = answer.next?.args.cursor as string | undefined;
        if (cursor === undefined) break;
      }
      expect(cursor).toBeUndefined();
      expect(new Set(seen).size).toBe(25);
    });

    it("says when the list stopped at the cap, with no way on past the rows in hand", async () => {
      umamiOverride = definitions(501);
      let answer: Json = await ok({ ...args, limit: 100 });
      expect(answer.data.total).toBe(501);
      expect(answer.data.notes).toContain("ROWS_CAPPED_AT_500");
      let rows = answer.data.rows.length as number;
      for (let page = 0; answer.next !== undefined && page < 12; page += 1) {
        answer = await ok(answer.next.args);
        rows += answer.data.rows.length as number;
      }
      expect(rows).toBe(500);
      expect(answer.next).toBeUndefined();
      expect(answer.data.total).toBe(501);
      expect(answer.data.quality.truncated).toBe(true);
      expect(answer.data.notes).toContain("ROWS_CAPPED_AT_500");
    });
  });

  it("answers a native report past retention with no Umami read", async () => {
    const { data } = await ok({
      report: "native",
      kind: "retention",
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(data).toMatchObject({ outOfRetention: true, source: "canonical" });
    expect(data).not.toHaveProperty("rows");
    expect(umamiHits).toEqual([]);
  });

  it("explains each day's difference between the two stores", async () => {
    const { data, meta } = await ok({
      report: "reconcile",
      from: "2026-03-09",
      to: "2026-03-10",
    });
    const [monday, tuesday] = data.days as [Json, Json];
    expect(monday.umami).toEqual({ pageViews: 0, visitors: 0 });
    expect(tuesday.umami).toEqual({ pageViews: 3, visitors: 2 });
    expect(tuesday.diff.pageViews).toBe(pageViews(...YESTERDAY).length - 3);
    expect(tuesday.explained).toContain("NEVER_FORWARDED");
    expect(tuesday.explained).toContain("LATE_EVENTS_POSSIBLE");
    for (const code of tuesday.explained as string[])
      expect(data.explanations[code]).toMatch(/\w/u);
    expect(meta.sources).toEqual({ canonical: "ok", umami: "ok" });
  });

  it("words a page view on its way apart from one that will never arrive, and no other event explains a gap", async () => {
    const day = { report: "reconcile", from: "2026-03-10", to: "2026-03-10" };
    const read = async () => {
      analyticsCache.purge();
      return (await ok(day)).data.days[0] as Json;
    };
    const dayViews = await setup.query<{ event_id: string }>(
      "SELECT event_id FROM community.analytics_events WHERE event_name='page_view' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz",
      [...YESTERDAY],
    );
    const held = dayViews.rows[0]!.event_id;
    const custom = randomUUID();
    try {
      await setup.query(
        "UPDATE community.analytics_events SET forwarded_at=$2::timestamptz WHERE event_id=ANY($1::uuid[])",
        [dayViews.rows.map((row) => row.event_id), NOW],
      );
      await setup.query(
        "UPDATE community.analytics_events SET forwarded_at=NULL WHERE event_id=$1",
        [held],
      );
      await setup.query(
        "INSERT INTO community.analytics_outbox(event_id,next_attempt_at) VALUES($1,$2::timestamptz)",
        [held, NOW],
      );
      const queued = await read();
      expect(queued).toMatchObject({
        pageViewsQueued: 1,
        pageViewsNeverForwarded: 0,
      });
      expect(queued.explained).toContain("NOT_YET_FORWARDED");
      expect(queued.explained).not.toContain("NEVER_FORWARDED");

      await setup.query(
        "UPDATE community.analytics_outbox SET failed_at=$2::timestamptz WHERE event_id=$1",
        [held, NOW],
      );
      const lost = await read();
      expect(lost).toMatchObject({
        pageViewsQueued: 0,
        pageViewsNeverForwarded: 1,
      });
      expect(lost.explained).toContain("NEVER_FORWARDED");
      expect(lost.explained).not.toContain("NOT_YET_FORWARDED");

      // Every page view went, and a queued search says nothing about the gap in them.
      await setup.query(
        "UPDATE community.analytics_events SET forwarded_at=$2::timestamptz WHERE event_id=$1",
        [held, NOW],
      );
      await setup.query("DELETE FROM community.analytics_outbox");
      await setup.query(
        `INSERT INTO community.analytics_events(event_id,visitor_id,session_id,distinct_id,event_name,surface,event_data,occurred_at,received_at)
        VALUES($1,$2,$2,$3,'search','search','{"name":"search"}',$4::timestamptz,$4::timestamptz)`,
        [custom, visitor(), "d".repeat(40), cst("2026-03-10T12:00:00")],
      );
      await setup.query(
        "INSERT INTO community.analytics_outbox(event_id,next_attempt_at) VALUES($1,$2::timestamptz)",
        [custom, NOW],
      );
      const gap = await read();
      expect(gap.notForwarded).toBe(1);
      expect(gap.pageViewsQueued).toBe(0);
      expect(gap.diff.pageViews).toBeGreaterThan(0);
      expect(gap.explained).toContain("CANONICAL_HIGHER");
      expect(gap.explained).not.toContain("NOT_YET_FORWARDED");
    } finally {
      await setup.query("DELETE FROM community.analytics_outbox");
      await setup.query(
        "DELETE FROM community.analytics_events WHERE event_id=$1",
        [custom],
      );
      await setup.query(
        "UPDATE community.analytics_events SET forwarded_at=NULL WHERE forwarded_at IS NOT NULL",
      );
    }
  });

  it("keeps a reconcile's canonical days when Umami is down, and reads no difference", async () => {
    umamiMode = "down";
    const { data, meta } = await ok({
      report: "reconcile",
      from: "2026-03-09",
      to: "2026-03-10",
    });
    expect(data.days[0].umami).toBeNull();
    expect(data.days[0]).not.toHaveProperty("diff");
    expect(data.days[0].pageViews).toBeGreaterThan(0);
    expect(data.umami.code).toBe("UMAMI_QUERY_TIMEOUT");
    expect(meta.partial).toBe(true);
  });
});

describe("the canonical path", () => {
  it("names every report in the capability table, and traffic as not built", async () => {
    expect(ADMIN_ANALYTICS_REPORTS).toContain("traffic");
    const answer = await call({ report: "traffic" });
    expect(answer).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    expect(answer).not.toHaveProperty("data");
  });

  it.each([
    [
      "a stored status of timed out",
      503,
      { code: "READ_TIMED_OUT" },
      "READ_TIMED_OUT",
    ],
    [
      "an unavailable store",
      503,
      { code: "STORE_UNAVAILABLE" },
      "ANALYTICS_UNAVAILABLE",
    ],
    [
      "a refused credential",
      403,
      { code: "AI_ROUTE_FORBIDDEN" },
      "AI_ROUTE_FORBIDDEN",
    ],
    [
      "a wrong credential",
      401,
      { code: "OPERATOR_UNAUTHORIZED" },
      "AI_ROUTE_FORBIDDEN",
    ],
  ])(
    "answers %s by name, with no number",
    async (_name, status, error, code) => {
      const stub = await startBackendStub((_path, response) =>
        send(response, { error: { status, ...error } }, status),
      );
      try {
        vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
        const answer = await call({ report: "overview", range: "yesterday" });
        expect(answer).toMatchObject({ ok: false, code });
        expect(answer.data?.metrics).toBeUndefined();
      } finally {
        await stub.close();
      }
    },
  );

  it("never runs more than two canonical reads at once, however many different questions arrive", async () => {
    let active = 0;
    let peak = 0;
    let hits = 0;
    const stub = await startBackendStub((_url, response) => {
      hits += 1;
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        send(
          response,
          { error: { status: 503, code: "STORE_UNAVAILABLE" } },
          503,
        );
      }, 60);
    });
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
      const answers = await Promise.all(
        ["01", "02", "03", "04", "05", "06"].map((day) =>
          call({
            report: "compare",
            dimension: "content",
            from: `2026-03-${day}`,
            to: `2026-03-${day}`,
          }),
        ),
      );
      expect(answers.map(({ code }) => code)).toEqual(
        Array.from({ length: 6 }, () => "ANALYTICS_UNAVAILABLE"),
      );
      expect(hits).toBe(6);
      expect(peak).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("refuses a reply that breaks its contract, rather than read a number from it", async () => {
    const stub = await startBackendStub((_path, response) =>
      send(response, { report: "status", last24Hours: { events: "many" } }),
    );
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
      expect(await call({ report: "status" })).toMatchObject({
        ok: false,
        code: "BACKEND_CONTRACT_MISMATCH",
      });
    } finally {
      await stub.close();
    }
  });

  it("reads a reply that is not JSON as a failed read, which a retry may get past", async () => {
    const stub = await startBackendStub((_path, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>synthetic proxy page</html>");
    });
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
      expect(await call({ report: "status" })).toMatchObject({
        ok: false,
        code: "ANALYTICS_UNAVAILABLE",
        retryable: true,
        data: { reason: "reply_invalid" },
      });
    } finally {
      await stub.close();
    }
  });

  it("reads a reply carrying a field it does not know, and the field goes nowhere", async () => {
    const unknown = `unknownfield${randomUUID().replaceAll("-", "")}`;
    const relay = await relayRewriting(backendOrigin, (body) =>
      withFieldAdded(body, unknown),
    );
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", relay.origin);
      for (const args of [
        { report: "status" },
        { report: "overview", range: "yesterday" },
        { report: "trend", range: "yesterday" },
        { report: "breakdown", dimension: "surface", range: "yesterday" },
        { report: "compare", dimension: "event", range: "yesterday" },
        {
          report: "funnel",
          range: "yesterday",
          steps: ["page_view", "content_open"],
        },
        { report: "realtime" },
        { report: "sessions", range: "yesterday" },
        { report: "session", visitorId: timeline },
        { report: "product", range: "yesterday" },
      ]) {
        // The cache would answer from the Backend's first reply, not this one.
        analyticsCache.purge();
        const answer = await ok(args);
        expect(JSON.stringify(answer), JSON.stringify(args)).not.toContain(
          unknown,
        );
      }
    } finally {
      analyticsCache.purge();
      await relay.close();
    }
  });

  it("labels every kind of answer with its range, source, asOf and quality", async () => {
    for (const args of [
      { report: "status" },
      { report: "overview", range: "yesterday" },
      { report: "trend", range: "yesterday" },
      { report: "breakdown", dimension: "surface", range: "yesterday" },
      { report: "breakdown", dimension: "province", range: "yesterday" },
      { report: "breakdown", dimension: "utm", range: "yesterday" },
      { report: "compare", dimension: "event", range: "yesterday" },
      {
        report: "funnel",
        range: "yesterday",
        steps: ["page_view", "content_open"],
      },
      { report: "funnel", range: "yesterday", funnelId: funnelDefinition },
      { report: "realtime" },
      { report: "sessions", range: "yesterday" },
      { report: "sessions", range: "yesterday", include: "umami" },
      { report: "session", visitorId: timeline },
      { report: "session", umamiSessionId: umamiSession },
      { report: "product", range: "yesterday" },
      { report: "native", kind: "weekly", range: "yesterday" },
      {
        report: "native",
        kind: "retention",
        from: "2025-01-01",
        to: "2025-01-02",
      },
      { report: "reconcile", range: "yesterday" },
    ]) {
      const { data } = await ok(args);
      expect(data.range, JSON.stringify(args)).toMatchObject({
        start: expect.any(String) as string,
        end: expect.any(String) as string,
        tz: expect.any(String) as string,
        complete: expect.any(Boolean) as boolean,
      });
      expect(data.source, JSON.stringify(args)).toMatch(
        /^(?:canonical|umami|both|capability)$/u,
      );
      expect(Date.parse(data.asOf), JSON.stringify(args)).not.toBeNaN();
      expect(typeof data.quality, JSON.stringify(args)).toBe("object");
    }
  });

  it("works with the community token absent, and says so when the base token is", async () => {
    await ok({ report: "sessions", visitorId: timeline });
    vi.stubEnv("OPERATOR_AI_BASE_TOKEN", "");
    for (const args of [
      { report: "status" },
      { report: "overview", range: "yesterday" },
      { report: "sessions", visitorId: timeline, limit: 3 },
      { report: "breakdown", dimension: "province", range: "yesterday" },
    ])
      expect(await call(args)).toMatchObject({
        ok: false,
        code: "AI_CREDENTIAL_NOT_CONFIGURED",
      });
  });

  it("sends identical parallel calls to the Backend once, then shows the cache's age", async () => {
    let hits = 0;
    const stub = await startBackendStub((_path, response) => {
      hits += 1;
      setTimeout(() => {
        send(response, {
          report: "status",
          source: "canonical",
          asOf: NOW.toISOString(),
          enabled: false,
          forwardingConfigured: false,
          ownerExclusionConfigured: false,
          eventRetentionDays: 180,
          ipRetentionDays: 60,
          last24Hours: { events: 1, visitors: 1, users: 0, sessions: 1 },
          outbox: { pending: 0, failed: 0 },
          lastEventAt: null,
          lastForwardedAt: null,
          metrics: ["pageViews"],
          definitions: { accountVisitors: "synthetic" },
          notCollected: Object.fromEntries(
            Object.keys(ANALYTICS_NOT_COLLECTED).map((name) => [
              name,
              { collected: false, reason: "synthetic" },
            ]),
          ),
        });
      }, 60);
    });
    try {
      vi.stubEnv("COMMUNITY_OPERATOR_BASE_URL", stub.origin);
      const before = await auditRows();
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => ok({ report: "status" })),
      );
      expect(hits).toBe(1);
      expect(answers.every(({ data }) => data.cache.hit === false)).toBe(true);
      vi.setSystemTime(NOW.getTime() + 5_000);
      const later = await ok({ report: "status" });
      expect(hits).toBe(1);
      expect(later.data.cache).toEqual({ hit: true, ageMs: 5_000 });
      // A hit is a read like any other: the ledger has it.
      expect((await auditRows()) - before).toBe(6);
    } finally {
      await stub.close();
    }
  });

  it("checks the pause before the cache, so a held answer does not slip out", async () => {
    await ok({ report: "status" });
    const drizzle = (payload.db as unknown as Pick<PostgresAdapter, "drizzle">)
      .drizzle;
    await drizzle.execute(sql`UPDATE mcp_control SET pause = true`);
    try {
      expect(await call({ report: "status" })).toMatchObject({
        ok: false,
        code: "MCP_PAUSED",
      });
    } finally {
      await drizzle.execute(sql`UPDATE mcp_control SET pause = false`);
    }
  });
});

describe("arguments", () => {
  it.each([
    ["an unknown report", { report: "constructor" }, ["report"]],
    ["an inherited key", { report: "status", constructor: 1 }, []],
    [
      "an inherited dimension",
      { report: "breakdown", dimension: "toString" },
      ["dimension"],
    ],
    [
      "an inherited filter key",
      { report: "overview", filter: { constructor: "x" } },
      ["filter"],
    ],
    ["a limit of none", { report: "overview", limit: 0 }, ["limit"]],
    ["a limit past the page", { report: "overview", limit: 101 }, ["limit"]],
    ["a limit with a fraction", { report: "overview", limit: 1.5 }, ["limit"]],
    [
      "a base past its bound",
      { report: "overview", minBase: 1_000_001 },
      ["minBase"],
    ],
    ["a NUL in a cursor", { report: "trend", cursor: "1\u0000" }, ["cursor"]],
    [
      "a NUL in a Umami filter",
      { report: "breakdown", dimension: "city", filter: { region: "a\u0000" } },
      ["filter", "region"],
    ],
    [
      "a session id that is no id",
      { report: "session", sessionId: "x" },
      ["sessionId"],
    ],
    [
      "a repeated funnel step",
      {
        report: "funnel",
        range: "yesterday",
        steps: ["page_view", "page_view"],
      },
      ["steps"],
    ],
  ])(
    "refuses %s by name, not with an internal error",
    async (_name, args, path) => {
      const answer = await call(args);
      expect(answer).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(answer.issues[0].path).toEqual(path);
    },
  );

  it("has no way to read an own __proto__: the SDK drops it before any tool", async () => {
    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_analytics","arguments":{"report":"status","__proto__":{"report":"overview"}}}}`,
    });
    const { result } = (await response.json()) as Json;
    expect(result.structuredContent.data.report).toBe("status");
  });

  it("refuses an argument a report does not read, rather than drop it", async () => {
    for (const args of [
      { report: "realtime", range: "yesterday" },
      { report: "status", limit: 3 },
      { report: "overview", kind: "weekly" },
      { report: "overview", include: "umami" },
      { report: "trend", funnelId: funnelDefinition },
      { report: "session", visitorId: timeline, include: "umami" },
    ]) {
      const answer = await call(args);
      expect(answer.code, JSON.stringify(args)).toBe("INPUT_INVALID");
    }
  });

  it("refuses a session with no subject, or two", async () => {
    expect((await call({ report: "session" })).issues[0].code).toBe(
      "one_subject_required",
    );
    expect(
      (
        await call({
          report: "session",
          visitorId: timeline,
          sessionId: timeline,
        })
      ).issues[0].code,
    ).toBe("one_subject_required");
  });
});

describe("the tool", () => {
  it("is listed on every profile, in the design's place, as a read that names no other", async () => {
    const { tools } = await client.listTools();
    const listed = tools.find((tool) => tool.name === "admin_analytics")!;
    expect(listed.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(listed.description!.length).toBeLessThanOrEqual(1_024);
    expect(tools.map((tool) => tool.name)).toEqual(
      toolListingFor("read", false).map((tool) => tool.name),
    );
  });
});
