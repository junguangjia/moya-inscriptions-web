import {
  AuthorCommunityService,
  CatalogQueryUnavailableError,
  CommunityNotFoundError,
} from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import { PostgresCommunityDiscoveryAdapter } from "@moya/community-postgres";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  apiErrorSchema,
  timelineSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  AuthorCommunityPort,
  CatalogPublicationPort,
  CommunityDiscoveryPort,
  StorageUrlResolver,
  TimelineRecord,
} from "@moya/api";
import type { CatalogId, MediaId } from "@moya/contracts";
import type { Server } from "node:http";

// home-timeline-v1 over stand-in connections; the SQL itself runs in
// tests/integration/postgres/timeline-entries.test.ts. Rows are fictional.
type Pool = ConstructorParameters<typeof PostgresCommunityDiscoveryAdapter>[0];

const fakePool = (
  answer: (text: string, values: readonly unknown[]) => readonly unknown[],
) => {
  const statements: string[] = [];
  const release = vi.fn();
  const connect = vi.fn(async () => ({
    query: async (text: string, values: readonly unknown[] = []) => {
      statements.push(text);
      return { rows: answer(text, values) };
    },
    release,
  }));
  return { pool: { connect } as unknown as Pool, connect, statements, release };
};

const row = (id: string, catalogId: string | null = null) => ({
  entry_id: id,
  title: `虚构${id}`,
  full_title: `虚构朝虚构${id}`,
  start_year: -300,
  end_year: -200,
  precision: "period",
  date_label: "虚构纪年",
  on_axis: true,
  chapter: "战国",
  polity: "虚构国",
  disputed: false,
  group_id: null,
  group_title: null,
  province: "虚构省",
  holder: "虚构馆",
  catalog_id: catalogId,
});

const appAnswering =
  (rows: readonly unknown[]) =>
  (text: string): readonly unknown[] =>
    text.includes("community.timeline_entries") ? rows : [];

const catalogRow = (id: string) => ({
  content_type: "catalog",
  content_id: id,
  kind: "inscription",
  title: "已发布记录",
  aliases: [],
  author_id: null,
  first_published_at: null,
  filter_metadata: {},
});
const mediaRow = (catalogId: string, position: number, media: string) => ({
  catalog_id: catalogId,
  media_id: media,
  object_key: `display/${media}`,
  width: 1200,
  height: 800,
  is_representative: position === 0,
  position,
  rn: String(position + 1),
  total: "2",
  renditions: null,
  placeholder_color: null,
});

describe("timeline discovery adapter", () => {
  it("reads rows in contract order without opening the Catalog connection when nothing links", async () => {
    const app = fakePool(appAnswering([row("a"), row("b")]));
    const catalog = fakePool(() => []);
    const record = await new PostgresCommunityDiscoveryAdapter(app.pool, {
      catalogPool: catalog.pool,
    }).timeline();
    expect(catalog.connect).not.toHaveBeenCalled();
    expect(record.cards).toEqual([]);
    expect(record.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(record.entries[0]).toEqual({
      id: "a",
      title: "虚构a",
      fullTitle: "虚构朝虚构a",
      startYear: -300,
      endYear: -200,
      precision: "period",
      dateLabel: "虚构纪年",
      onAxis: true,
      chapter: "战国",
      polity: "虚构国",
      disputed: false,
      groupId: null,
      groupTitle: null,
      province: "虚构省",
      holder: "虚构馆",
      catalogId: null,
    });
    const read = app.statements.find((text) =>
      text.includes("community.timeline_entries"),
    )!;
    expect(read).toMatch(/ORDER BY start_year,position,entry_id LIMIT \$1/u);
    expect(app.statements).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(app.statements).toContain("COMMIT");
    expect(app.release).toHaveBeenCalledOnce();
  });

  it("bounds the read just past the contract maximum", async () => {
    const seen: unknown[] = [];
    const app = fakePool((text, values) => {
      if (text.includes("community.timeline_entries")) seen.push(...values);
      return [];
    });
    await new PostgresCommunityDiscoveryAdapter(app.pool).timeline();
    expect(seen).toEqual([TIMELINE_ENTRIES_MAXIMUM + 1]);
  });

  it("keeps a link only while its record is published and reads no discovery source", async () => {
    const app = fakePool(
      appAnswering([
        row("unlinked"),
        row("published", "catalog-published"),
        row("unpublished", "catalog-unpublished"),
      ]),
    );
    const linkedIds: unknown[] = [];
    const catalog = fakePool((text, values) => {
      if (text.includes("FROM catalog_discovery")) {
        linkedIds.push(...values);
        return [catalogRow("catalog-published")];
      }
      if (text.includes("FROM catalog_media"))
        return [
          mediaRow("catalog-published", 0, "media-one"),
          mediaRow("catalog-published", 1, "media-two"),
        ];
      return [];
    });
    const record = await new PostgresCommunityDiscoveryAdapter(app.pool, {
      catalogPool: catalog.pool,
    }).timeline();
    expect(linkedIds).toEqual([["catalog-published", "catalog-unpublished"]]);
    expect(catalog.statements.join("\n")).not.toContain("LIMIT 10001");
    expect(catalog.statements).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(catalog.release).toHaveBeenCalledOnce();
    expect(record.entries.map(({ id, catalogId }) => [id, catalogId])).toEqual([
      ["unlinked", null],
      ["published", "catalog-published"],
      ["unpublished", null],
    ]);
    // One image per row: the projection's gallery stays out of the record.
    expect(record.cards).toHaveLength(1);
    expect(record.cards[0]).toMatchObject({
      target: { type: "catalog", id: "catalog-published" },
      media: { type: "catalog", id: "media-one" },
    });
    expect(record.cards[0]).not.toHaveProperty("gallery");
    expect(record.cards[0]).not.toHaveProperty("mediaCount");
  });
});

const entry = (
  id: string,
  catalogId: string | null = null,
): TimelineRecord["entries"][number] => ({
  id,
  title: `虚构${id}`,
  fullTitle: `虚构朝虚构${id}`,
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
  catalogId: catalogId as CatalogId | null,
});
const serviceFor = (record: TimelineRecord, resolver?: StorageUrlResolver) =>
  new AuthorCommunityService(
    {} as AuthorCommunityPort,
    {} as CatalogPublicationPort,
    undefined,
    { timeline: async () => record } as unknown as CommunityDiscoveryPort,
    resolver,
  );
const card = (
  id: string,
  media: TimelineRecord["cards"][number]["media"],
): TimelineRecord["cards"][number] => ({
  target: { type: "catalog", id },
  title: "已发布记录",
  aliases: [],
  kind: "inscription",
  authorId: null,
  firstPublishedAt: null,
  media,
});

describe("timeline service", () => {
  it("gives a linked row its card image as public media and leaves the rest without", async () => {
    const resolveMany = vi.fn(
      async (locators: Parameters<StorageUrlResolver["resolveMany"]>[0]) =>
        new Map(
          locators.map(({ mediaId }) => [
            mediaId,
            "https://media.example.invalid/approved.webp",
          ]),
        ),
    );
    const timeline = await serviceFor(
      {
        entries: [
          entry("plain"),
          entry("linked", "catalog-linked"),
          entry("textual", "catalog-textual"),
        ],
        cards: [
          card("catalog-linked", {
            type: "catalog",
            id: "media-one" as MediaId,
            objectKey: "display/media-one",
            width: 1200,
            height: 800,
          }),
          card("catalog-textual", null),
        ],
      },
      { resolveMany },
    ).timeline();
    expect(timelineSchema.parse(timeline)).toEqual(timeline);
    expect(resolveMany).toHaveBeenCalledOnce();
    expect(timeline.entries.map(({ media }) => media)).toEqual([
      null,
      {
        id: "media-one",
        kind: "image",
        src: "https://media.example.invalid/approved.webp",
        alt: "虚构朝虚构linked",
        width: 1200,
        height: 800,
      },
      null,
    ]);
    expect(timeline.entries[2]!.catalogId).toBe("catalog-textual");
  });

  it("leaves only the row whose image cannot resolve without an image", async () => {
    const resolveMany = vi.fn(
      async (locators: Parameters<StorageUrlResolver["resolveMany"]>[0]) => {
        if (locators.some(({ mediaId }) => mediaId === "media-bad"))
          throw new Error("COS object key invalid");
        return new Map(
          locators.map(({ mediaId }) => [
            mediaId,
            "https://media.example.invalid/approved.webp",
          ]),
        );
      },
    );
    const image = (id: string) => ({
      type: "catalog" as const,
      id: id as MediaId,
      objectKey: `display/${id}`,
      width: 1200,
      height: 800,
    });
    const timeline = await serviceFor(
      {
        entries: [
          entry("plain"),
          entry("good", "catalog-good"),
          entry("bad", "catalog-bad"),
        ],
        cards: [
          card("catalog-good", image("media-good")),
          card("catalog-bad", image("media-bad")),
        ],
      },
      { resolveMany },
    ).timeline();
    expect(timeline.entries.map(({ media }) => media?.id ?? null)).toEqual([
      null,
      "media-good",
      null,
    ]);
    expect(timeline.entries[2]!.catalogId).toBe("catalog-bad");
  });

  const linkedImage = (id: string) => ({
    type: "catalog" as const,
    id: id as MediaId,
    objectKey: `display/${id}`,
    width: 1200,
    height: 800,
  });

  it("treats several failed records with no image resolved as an outage, in a few reads", async () => {
    const resolveMany = vi.fn(
      async (locators: Parameters<StorageUrlResolver["resolveMany"]>[0]) => {
        if (locators.length > 0) throw new Error("credentials expired");
        return new Map();
      },
    );
    const ids = Array.from({ length: 60 }, (_, at) => at);
    await expect(
      serviceFor(
        {
          entries: ids.map((at) => entry(`row-${at}`, `catalog-${at}`)),
          cards: ids.map((at) =>
            card(`catalog-${at}`, linkedImage(`media-${at}`)),
          ),
        },
        { resolveMany },
      ).timeline(),
    ).rejects.toThrow("credentials expired");
    expect(resolveMany.mock.calls.length).toBeLessThan(16);
  });

  it("keeps the rows when one record fails beside records with no image", async () => {
    const resolveMany = vi.fn(
      async (locators: Parameters<StorageUrlResolver["resolveMany"]>[0]) => {
        if (locators.length > 0) throw new Error("COS object key invalid");
        return new Map();
      },
    );
    const timeline = await serviceFor(
      {
        entries: [
          entry("plain"),
          entry("bad", "catalog-bad"),
          entry("textual-1", "catalog-textual-1"),
          entry("textual-2", "catalog-textual-2"),
        ],
        cards: [
          card("catalog-bad", linkedImage("media-bad")),
          card("catalog-textual-1", null),
          card("catalog-textual-2", null),
        ],
      },
      { resolveMany },
    ).timeline();
    expect(timeline.entries).toHaveLength(4);
    expect(timeline.entries.every(({ media }) => media === null)).toBe(true);
  });

  it("fails an availability error at once, without retrying per row", async () => {
    const resolveMany = vi.fn(async () => {
      throw new CatalogQueryUnavailableError();
    });
    await expect(
      serviceFor(
        {
          entries: [entry("one", "catalog-one"), entry("two", "catalog-two")],
          cards: [
            card("catalog-one", linkedImage("media-one")),
            card("catalog-two", linkedImage("media-two")),
          ],
        },
        { resolveMany },
      ).timeline(),
    ).rejects.toBeInstanceOf(CatalogQueryUnavailableError);
    expect(resolveMany).toHaveBeenCalledOnce();
  });

  it("isolates one bad record among many in a few reads, one at a time", async () => {
    let concurrent = 0;
    let peak = 0;
    const resolveMany = vi.fn(
      async (locators: Parameters<StorageUrlResolver["resolveMany"]>[0]) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await Promise.resolve();
        concurrent -= 1;
        if (locators.some(({ mediaId }) => mediaId === "media-13"))
          throw new Error("COS object key invalid");
        return new Map(
          locators.map(({ mediaId }) => [
            mediaId,
            "https://media.example.invalid/approved.webp",
          ]),
        );
      },
    );
    const ids = Array.from({ length: 60 }, (_, at) => at);
    const timeline = await serviceFor(
      {
        entries: ids.map((at) => entry(`row-${at}`, `catalog-${at}`)),
        cards: ids.map((at) =>
          card(`catalog-${at}`, linkedImage(`media-${at}`)),
        ),
      },
      { resolveMany },
    ).timeline();
    expect(timeline.entries.filter(({ media }) => media !== null)).toHaveLength(
      59,
    );
    expect(peak).toBe(1);
    expect(resolveMany.mock.calls.length).toBeLessThan(16);
  });

  it("never reaches media resolution for rows without a link", async () => {
    const resolveMany = vi.fn(async () => new Map());
    const catalogFacts = vi.fn(async () => new Map());
    const timeline = await serviceFor(
      { entries: [entry("plain")], cards: [] },
      { resolveMany, catalogFacts } as unknown as StorageUrlResolver,
    ).timeline();
    expect(timeline.entries[0]!.media).toBeNull();
    expect(resolveMany).not.toHaveBeenCalled();
    expect(catalogFacts).not.toHaveBeenCalled();
  });

  it("reads as unavailable without a discovery port", async () => {
    await expect(
      new AuthorCommunityService(
        {} as AuthorCommunityPort,
        {} as CatalogPublicationPort,
      ).timeline(),
    ).rejects.toBeInstanceOf(CommunityNotFoundError);
  });
});

const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});
const backend = async (discoveryPort?: unknown) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv: "development",
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      authorCommunityPort: {} as AuthorCommunityPort,
      catalogPublicationPort: {
        isPublished: async () => true,
        readTitle: async () => "Test catalog",
      },
      ...(discoveryPort === undefined
        ? {}
        : { discoveryPort: discoveryPort as CommunityDiscoveryPort }),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}/v1/community/timeline`;
};

describe("GET /v1/community/timeline", () => {
  it("answers a guest with the validated timeline, uncached", async () => {
    const timeline = vi.fn(async () => ({
      entries: [entry("plain")],
      cards: [],
    }));
    const response = await fetch(await backend({ timeline }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(timelineSchema.parse(await response.json())).toEqual({
      entries: [{ ...entry("plain"), media: null }],
    });
    expect(timeline).toHaveBeenCalledOnce();
  });

  it("rejects any query string before reading", async () => {
    const timeline = vi.fn();
    const response = await fetch(`${await backend({ timeline })}?year=650`);
    expect(response.status).toBe(422);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "INVALID_INPUT",
    );
    expect(timeline).not.toHaveBeenCalled();
  });

  it("answers 503 for a row the contract refuses, without echoing it", async () => {
    const response = await fetch(
      await backend({
        timeline: async () => ({
          entries: [{ ...entry("broken"), startYear: 0, endYear: 0 }],
          cards: [],
        }),
      }),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(text).not.toContain("虚构broken");
  });

  it("is not a route without a discovery port", async () => {
    expect((await fetch(await backend())).status).toBe(404);
  });

  it("is a read: another method is not routed", async () => {
    const timeline = vi.fn();
    const response = await fetch(await backend({ timeline }), {
      method: "POST",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(timeline).not.toHaveBeenCalled();
  });
});
