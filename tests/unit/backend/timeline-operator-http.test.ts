import {
  CommunityConflictError,
  CommunityIdempotencyConflictError,
  CommunityNamedConflictError,
  CommunityNotFoundError,
  CommunityStoreUnavailableError,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  operatorTimelinePageSchema,
  operatorTimelineSummarySchema,
} from "@moya/contracts/internal/community-operator";
import {
  TIMELINE_CHAPTER_SPANS,
  timelineChapterSchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCommunityCommentPort } from "./community-comment-fixture.js";
import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type { AuthorCommunityPort, TimelineOperatorPort } from "@moya/api";
import type { TimelineChapter } from "@moya/contracts";
import type {
  CreateTimelineEntryCommand,
  OperatorTimelineEntry,
  ReorderTimelineCommand,
  UpdateTimelineEntryCommand,
} from "@moya/contracts/internal/community-operator";
import type { Server } from "node:http";

/*
 * home-timeline-v1 (Issue #384 r3): the timeline operator routes over the real
 * router, operator boundary, handler and service, with a fixture port. The
 * service filters, pages and counts what the port loads; the handler refuses a
 * query string on a command and passes a refusal's contract code, never more.
 * Content is synthetic.
 */

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

/** Synthetic credentials for this unit test only. */
const ownerToken = "synthetic-owner-credential-0123456789abcdef";
const communityToken = "synthetic-community-credential-0123456789ab";
const baseToken = "synthetic-base-credential-0123456789abcdef";

const row = (
  id: string,
  overrides: Partial<OperatorTimelineEntry> = {},
): OperatorTimelineEntry => ({
  id,
  title: `合成${id}`,
  fullTitle: `合成朝合成${id}`,
  startYear: 618,
  endYear: 618,
  precision: "year",
  dateLabel: null,
  onAxis: true,
  chapter: "唐",
  polity: null,
  disputed: false,
  groupId: null,
  groupTitle: null,
  province: null,
  holder: null,
  catalogId: null,
  position: 0,
  version: 1,
  hidden: false,
  linkState: "unlinked",
  createdBy: "import",
  updatedBy: "import",
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  ...overrides,
});

class FixturePort implements TimelineOperatorPort {
  rows: OperatorTimelineEntry[] = [];
  readonly calls: unknown[][] = [];
  failure: unknown = null;
  async operatorTimelineEntries() {
    return this.rows;
  }
  private answer(call: unknown[], id: string, operator: string) {
    this.calls.push(call);
    if (this.failure !== null) throw this.failure;
    return row(id, { createdBy: "owner", updatedBy: operator as "owner" });
  }
  async operatorCreateTimelineEntry(
    operator: string,
    command: CreateTimelineEntryCommand,
  ) {
    return this.answer(["create", operator, command], command.id, operator);
  }
  async operatorUpdateTimelineEntry(
    operator: string,
    id: string,
    command: UpdateTimelineEntryCommand,
  ) {
    return this.answer(["update", operator, id, command], id, operator);
  }
  async operatorReorderTimeline(
    operator: string,
    command: ReorderTimelineCommand,
  ) {
    this.calls.push(["reorder", operator, command]);
    if (this.failure !== null) throw this.failure;
    return { startYear: command.startYear, count: command.entries.length };
  }
}

const start = async (port?: TimelineOperatorPort) => {
  const identity = new InMemoryCommunityIdentityPort();
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "production",
      communityIdentityPort: identity,
      communityCommentPort: new InMemoryCommunityCommentPort(),
      authorCommunityPort: {} as unknown as AuthorCommunityPort,
      storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      catalogQueryPort: {
        list: async () => ({
          items: [],
          total: 0,
          page: 1,
          pageSize: 1,
          totalPages: 0,
        }),
        getById: async () => null,
      },
      ...(port ? { timelineOperatorPort: port } : {}),
      communityOperatorCredential: ownerToken,
      operatorAiCommunityCredential: communityToken,
      operatorAiBaseCredential: baseToken,
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  const send = async (
    route: string,
    {
      method = "GET",
      body,
      token = ownerToken,
      raw,
    }: {
      method?: string;
      body?: unknown;
      token?: string;
      raw?: string;
    } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/community/${route}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined && raw === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(raw !== undefined
          ? { body: raw }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
      },
    );
    const json = (await response.json()) as {
      error?: { code?: string };
    } & Record<string, unknown>;
    return { status: response.status, json, code: json.error?.code };
  };
  return { send };
};

const requestId = "00000000-0000-4000-8000-000000000001";
const create = {
  requestId,
  id: "tang-new",
  title: "合成新条",
  fullTitle: "合成朝合成新条",
  startYear: 700,
  endYear: 700,
  precision: "year",
  onAxis: true,
  chapter: "唐",
};

describe("the timeline operator read", () => {
  const seeded = () => {
    const port = new FixturePort();
    port.rows = [
      row("tang-a", { position: 0, polity: "合成国", province: "陕西" }),
      row("tang-b", {
        position: 1024,
        hidden: true,
        updatedBy: "ai-admin",
        groupId: "pair",
        groupTitle: "合成组",
      }),
      row("tang-c", {
        position: 2048,
        groupId: "pair",
        groupTitle: "另一组名",
        onAxis: false,
      }),
      row("linked", {
        startYear: 700,
        endYear: 760,
        catalogId: `catalog-${"a".repeat(8)}`,
        linkState: "published",
        disputed: true,
      }),
      row("linked-off", {
        startYear: 701,
        endYear: 701,
        catalogId: `catalog-${"b".repeat(8)}`,
        linkState: "not_published",
        updatedBy: "owner",
        updatedAt: "2026-11-06T08:00:00.000Z",
      }),
      // A Song row filed under 唐, and one the contract would refuse.
      row("misplaced", { startYear: 1000, endYear: 1000 }),
      row("broken", { startYear: 650, endYear: 640 }),
    ];
    return port;
  };
  const ids = (json: unknown) =>
    operatorTimelinePageSchema.parse(json).items.map(({ id }) => id);

  it("pages every stored row in stored order, hidden ones included by default", async () => {
    const { send } = await start(seeded());
    const all = await send("timeline-entries");
    expect(all.status).toBe(200);
    expect(operatorTimelinePageSchema.parse(all.json)).toMatchObject({
      total: 7,
      page: 1,
      pageSize: 20,
    });
    expect(ids(all.json)).toEqual([
      "tang-a",
      "tang-b",
      "tang-c",
      "linked",
      "linked-off",
      "misplaced",
      "broken",
    ]);
    const second = await send("timeline-entries?page=2&pageSize=3");
    expect(ids(second.json)).toEqual(["linked", "linked-off", "misplaced"]);
    expect(second.json).toMatchObject({ total: 7, page: 2, pageSize: 3 });
    expect(
      ids((await send("timeline-entries?page=9&pageSize=50")).json),
    ).toEqual([]);
  });

  it.each([
    ["id=tang-b", ["tang-b"]],
    ["ids=linked,tang-a", ["tang-a", "linked"]],
    ["ids=linked&ids=tang-a", ["tang-a", "linked"]],
    ["search=%E9%99%95%E8%A5%BF", ["tang-a"]],
    ["search=LINKED-OFF", ["linked-off"]],
    ["yearFrom=701", ["linked", "linked-off", "misplaced"]],
    ["yearFrom=720&yearTo=900", ["linked"]],
    ["polity=%E5%90%88%E6%88%90%E5%9B%BD", ["tang-a"]],
    ["onAxis=false", ["tang-c"]],
    ["disputed=true", ["linked"]],
    ["groupId=pair", ["tang-b", "tang-c"]],
    ["linked=linked", ["linked", "linked-off"]],
    ["linked=not_published", ["linked-off"]],
    [`catalogId=catalog-${"a".repeat(8)}`, ["linked"]],
    ["hidden=only", ["tang-b"]],
    ["hidden=exclude&chapter=%E5%94%90&pageSize=2", ["tang-a", "tang-c"], 6],
    ["updatedBy=ai-admin", ["tang-b"]],
    ["issue=contract", ["broken"]],
    ["issue=group", ["tang-b", "tang-c"]],
    ["issue=chapter_year", ["misplaced"]],
    ["issue=not_published", ["linked-off"]],
  ] as [string, string[], number?][])(
    "narrows by %s",
    async (query, expected, total = expected.length) => {
      const { send } = await start(seeded());
      const read = await send(`timeline-entries?${query}`);
      expect(read.status, query).toBe(200);
      expect(ids(read.json), query).toEqual(expected);
      expect(read.json.total, query).toBe(total);
    },
  );

  it.each([
    "pageSize=51",
    "page=0",
    "view=compact",
    "hidden=maybe",
    "onAxis=yes",
    "id=Not_A_Slug",
    "page=1&page=2",
    "yearFrom=900&yearTo=700",
  ])("refuses the query %s", async (query) => {
    const { send } = await start(seeded());
    expect(await send(`timeline-entries?${query}`)).toMatchObject({
      status: 400,
      code: "INVALID_QUERY",
    });
  });

  it("counts every row, its issues and the limits in the summary", async () => {
    const { send } = await start(seeded());
    const read = await send("timeline-summary");
    expect(read.status).toBe(200);
    const summary = operatorTimelineSummarySchema.parse(read.json);
    expect(summary.entries).toEqual({
      total: 7,
      visible: 6,
      hidden: 1,
      onAxis: 6,
      shelf: 1,
      disputed: 1,
    });
    expect(summary.chapters.map(({ chapter }) => chapter)).toEqual(
      timelineChapterSchema.options,
    );
    expect(summary.chapters.find(({ chapter }) => chapter === "唐")).toEqual({
      chapter: "唐",
      total: 7,
      hidden: 1,
      onAxis: 6,
      shelf: 1,
    });
    expect(summary.links).toEqual({
      unlinked: 5,
      published: 1,
      notPublished: 1,
    });
    // The hidden member does not fold: one visible group of one.
    expect(summary.groups).toEqual({ total: 1, folding: 0 });
    expect(summary.updatedBy).toEqual({
      import: 5,
      owner: 1,
      "ai-admin": 1,
    });
    expect(summary.issues).toEqual({
      contract: 1,
      group: 2,
      chapterYear: 1,
      notPublished: 1,
    });
    expect(summary.limits).toMatchObject({
      entries: 7,
      entriesMaximum: 5000,
      responseBytesMaximum: 4_000_000,
    });
    expect(summary.limits.responseBytes).toBeGreaterThan(3000);
    expect(summary.lastUpdatedAt).toBe("2026-11-06T08:00:00.000Z");
    expect(await send("timeline-summary?range=30d")).toMatchObject({
      status: 400,
      code: "INVALID_QUERY",
    });
  });

  it("answers an empty timeline with zero counts", async () => {
    const { send } = await start(new FixturePort());
    const summary = operatorTimelineSummarySchema.parse(
      (await send("timeline-summary")).json,
    );
    expect(summary.entries.total).toBe(0);
    expect(summary.limits.responseBytes).toBe(2);
    expect(summary.lastUpdatedAt).toBeNull();
  });

  it("places a start year in its chapter by the shared chapter spans", async () => {
    const port = new FixturePort();
    const expected: string[] = [];
    for (const [chapter, [startYear, endYear]] of Object.entries(
      TIMELINE_CHAPTER_SPANS,
    ) as [TimelineChapter, readonly [number, number | null]][]) {
      const inside = [startYear, endYear ?? 3000];
      const outside = [
        startYear - 1,
        ...(endYear === null ? [] : [endYear + 1]),
      ];
      for (const year of [...inside, ...outside].filter((y) => y !== 0)) {
        const id = `c${port.rows.length}`;
        port.rows.push(row(id, { chapter, startYear: year, endYear: year }));
        if (outside.includes(year)) expected.push(id);
      }
    }
    const { send } = await start(port);
    const found: string[] = [];
    for (let page = 1; ; page += 1) {
      const read = operatorTimelinePageSchema.parse(
        (
          await send(
            `timeline-entries?issue=chapter_year&pageSize=50&page=${page}`,
          )
        ).json,
      );
      found.push(...read.items.map(({ id }) => id));
      if (found.length >= read.total) break;
    }
    expect(found).toEqual(expected);
  });
});

describe("the timeline operator commands", () => {
  it("hands each command to the port, parsed, with the caller's label", async () => {
    const port = new FixturePort();
    const { send } = await start(port);
    expect(
      await send("timeline-entries", { method: "POST", body: create }),
    ).toMatchObject({ status: 200, json: { id: "tang-new" } });
    const update = { requestId, expectedVersion: 2, hidden: true };
    expect(
      (
        await send("timeline-entries/tang-new", {
          method: "POST",
          body: update,
          token: communityToken,
        })
      ).status,
    ).toBe(200);
    const reorder = {
      requestId,
      startYear: 618,
      entries: [
        { id: "tang-b", expectedVersion: 1 },
        { id: "tang-a", expectedVersion: 3 },
      ],
    };
    expect(
      await send("timeline-order", { method: "POST", body: reorder }),
    ).toMatchObject({ status: 200, json: { startYear: 618, count: 2 } });
    expect(port.calls).toEqual([
      [
        "create",
        "owner",
        {
          ...create,
          dateLabel: null,
          polity: null,
          disputed: false,
          groupId: null,
          groupTitle: null,
          province: null,
          holder: null,
          catalogId: null,
        },
      ],
      ["update", "ai-admin", "tang-new", update],
      ["reorder", "owner", reorder],
    ]);
  });

  it.each([
    ["timeline-entries", create],
    [
      "timeline-entries/tang-a",
      { requestId, expectedVersion: 1, title: "合成" },
    ],
    [
      "timeline-order",
      { requestId, startYear: 618, entries: [{ id: "a", expectedVersion: 1 }] },
    ],
  ])(
    "refuses %s with a query string, a bad body or no body",
    async (route, body) => {
      const port = new FixturePort();
      const { send } = await start(port);
      for (const attempt of [
        send(`${route}?requestId=${requestId}`, { method: "POST", body }),
        send(route, { method: "POST", body: { ...body, extra: true } }),
        send(route, { method: "POST", body: { ...body, requestId: "x" } }),
        send(route, { method: "POST", raw: "{" }),
        send(route, { method: "POST", raw: "null" }),
        send(route, { method: "POST" }),
      ])
        expect(await attempt, route).toMatchObject({
          status: 400,
          code: "INVALID_COMMAND",
        });
      expect(port.calls).toEqual([]);
    },
  );

  it("refuses a change without the version it was read at, or a reorder listing an entry twice", async () => {
    const port = new FixturePort();
    const { send } = await start(port);
    expect(
      await send("timeline-entries/tang-a", {
        method: "POST",
        body: { requestId, title: "合成" },
      }),
    ).toMatchObject({ status: 400, code: "INVALID_COMMAND" });
    expect(
      await send("timeline-order", {
        method: "POST",
        body: {
          requestId,
          startYear: 618,
          entries: [
            { id: "a", expectedVersion: 1 },
            { id: "a", expectedVersion: 1 },
          ],
        },
      }),
    ).toMatchObject({ status: 400, code: "INVALID_COMMAND" });
    expect(port.calls).toEqual([]);
  });

  it("answers an id no row could have as not found, and other paths by their method", async () => {
    const port = new FixturePort();
    const { send } = await start(port);
    const update = { requestId, expectedVersion: 1, title: "合成" };
    for (const id of ["Tang", "%E5%94%90", "%ZZ", "a".repeat(65)])
      expect(
        await send(`timeline-entries/${id}`, { method: "POST", body: update }),
        id,
      ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    for (const [route, method] of [
      ["timeline-entries", "PUT"],
      ["timeline-entries/tang-a", "GET"],
      ["timeline-summary", "POST"],
      ["timeline-order", "GET"],
    ] as const)
      expect(
        await send(route, { method, body: method === "GET" ? undefined : {} }),
        `${method} ${route}`,
      ).toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
    for (const route of [
      "timeline-entries/tang-a/extra",
      "timeline-summary/extra",
      "timeline-order/extra",
    ])
      expect(
        await send(route, { method: "POST", body: {} }),
        route,
      ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(port.calls).toEqual([]);
  });

  it.each([
    [
      "a named refusal",
      422,
      "ENTRY_EXISTS",
      new CommunityNamedConflictError("ENTRY_EXISTS"),
    ],
    [
      "another named refusal",
      422,
      "SET_CHANGED",
      new CommunityNamedConflictError("SET_CHANGED"),
    ],
    // A refusal code outside the contract leaves as a plain conflict.
    [
      "a refusal named by text",
      409,
      "STATE_CONFLICT",
      new CommunityNamedConflictError("合成 text"),
    ],
    [
      "a reused key",
      409,
      "IDEMPOTENCY_CONFLICT",
      new CommunityIdempotencyConflictError(),
    ],
    ["a stale version", 409, "STATE_CONFLICT", new CommunityConflictError()],
    ["a missing row", 404, "NOT_FOUND", new CommunityNotFoundError()],
    [
      "a lost store",
      503,
      "OPERATOR_UNAVAILABLE",
      new CommunityStoreUnavailableError(),
    ],
    ["anything else", 500, "INTERNAL_ERROR", new Error("synthetic")],
  ] as const)(
    "answers %s with %i %s for the Owner and AI alike",
    async (_label, status, code, failure) => {
      const port = new FixturePort();
      port.failure = failure;
      const { send } = await start(port);
      for (const token of [ownerToken, communityToken])
        expect(
          await send("timeline-entries", {
            method: "POST",
            body: create,
            token,
          }),
        ).toMatchObject({ status, code });
    },
  );

  it("is unrouted without a port", async () => {
    const { send } = await start();
    expect(await send("timeline-entries")).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(
      await send("timeline-entries", { method: "POST", body: create }),
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("the timeline routes on an AI credential", () => {
  it("open on the community credential only, and on no path beside the five", async () => {
    const port = new FixturePort();
    port.rows = [row("tang-a")];
    const { send } = await start(port);
    const routes = [
      ["timeline-entries", "GET", undefined],
      ["timeline-summary", "GET", undefined],
      ["timeline-entries", "POST", create],
      [
        "timeline-entries/tang-a",
        "POST",
        { requestId, expectedVersion: 1, hidden: true },
      ],
      [
        "timeline-order",
        "POST",
        {
          requestId,
          startYear: 618,
          entries: [{ id: "tang-a", expectedVersion: 1 }],
        },
      ],
    ] as const;
    for (const [route, method, body] of routes) {
      expect(
        (await send(route, { method, body, token: communityToken })).status,
        `${method} ${route}`,
      ).toBe(200);
      expect(
        await send(route, { method, body, token: baseToken }),
        `${method} ${route}`,
      ).toMatchObject({ status: 403, code: "AI_ROUTE_FORBIDDEN" });
    }
    for (const [route, method] of [
      ["timeline-entries/tang-a", "GET"],
      ["timeline-entries/tang-a/extra", "POST"],
      ["timeline-summary", "POST"],
      ["timeline-order", "PUT"],
      ["timeline-entries", "PUT"],
    ] as const)
      expect(
        await send(route, {
          method,
          body: method === "GET" ? undefined : {},
          token: communityToken,
        }),
        `${method} ${route}`,
      ).toMatchObject({ status: 403, code: "AI_ROUTE_FORBIDDEN" });
    expect(port.calls).toHaveLength(3);
  });
});
