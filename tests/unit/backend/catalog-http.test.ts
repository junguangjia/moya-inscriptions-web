import {
  createBackendApplication,
  createBackendServer,
  createDevelopmentCatalogFixtureQueryPort,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  catalogDetailSchema,
  catalogIdSchema,
  catalogPageSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";
import { CatalogQueryUnavailableError } from "@moya/api";
import {
  MappedStorageUrlResolver,
  UnconfiguredStorageUrlResolver,
} from "@moya/image";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CatalogDetailProjection,
  CatalogMediaProjection,
  CatalogQueryPort,
  StorageUrlResolver,
} from "@moya/api";
import type { ApiErrorCode, CatalogId } from "@moya/contracts";
import type { NodeEnvironment } from "@moya/backend-runtime";
import type { Server } from "node:http";

const servers = new Set<Server>();

const startCatalogServer = async (
  options: {
    readonly nodeEnv?: NodeEnvironment;
    readonly catalogQueryPort?: CatalogQueryPort;
    readonly storageUrlResolver?: StorageUrlResolver;
  } = {},
) => {
  const applicationOptions = {
    nodeEnv: options.nodeEnv ?? "test",
    ...(options.catalogQueryPort === undefined
      ? {}
      : { catalogQueryPort: options.catalogQueryPort }),
    ...(options.storageUrlResolver === undefined
      ? options.nodeEnv === "production"
        ? { storageUrlResolver: new UnconfiguredStorageUrlResolver() }
        : {}
      : { storageUrlResolver: options.storageUrlResolver }),
  };
  const server = createBackendServer(
    createBackendApplication(applicationOptions),
  );
  servers.add(server);
  const address = await startServer(server, {
    host: "127.0.0.1",
    port: 0,
  });

  return {
    baseUrl: `http://${address.address}:${address.port}`,
    server,
  };
};

const parseApiError = async (
  response: Response,
  expectedStatus: 400 | 404 | 500 | 503,
  expectedCode: ApiErrorCode,
) => {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  const error = apiErrorSchema.parse(await response.json());
  expect(error.error.code).toBe(expectedCode);
  expect(error.error.requestId).not.toBe("");
  return error;
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("development Catalog fixture adapter", () => {
  it("returns schema-valid IDs and a deterministic fixture sequence", async () => {
    const port = createDevelopmentCatalogFixtureQueryPort();
    const firstRead = await port.list({ page: 1, pageSize: 2 });
    const secondRead = await port.list({ page: 1, pageSize: 2 });

    expect(firstRead).toEqual(secondRead);
    expect(firstRead.items.map(({ title }) => title)).toEqual([
      "九成宫醴泉铭",
      "好太王碑",
    ]);
    expect(firstRead.items[0]?.periodLabel).toBe("唐 · 贞观十年");
    expect(firstRead.items.map(({ id }) => catalogIdSchema.parse(id))).toEqual(
      firstRead.items.map(({ id }) => id),
    );
  });

  it("implements subsequent and beyond-range pages without freezing a production order", async () => {
    const port = createDevelopmentCatalogFixtureQueryPort();

    expect(await port.list({ page: 2, pageSize: 2 })).toMatchObject({
      items: [{ title: "泰山经石峪金刚经" }],
      page: 2,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    expect(await port.list({ page: 100, pageSize: 2 })).toEqual({
      items: [],
      page: 100,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it("filters by kind inside the fixture adapter before pagination", async () => {
    const port = createDevelopmentCatalogFixtureQueryPort();

    await expect(
      port.list({ kind: "calligraphy", page: 1, pageSize: 20 }),
    ).resolves.toMatchObject({
      items: [{ kind: "calligraphy", title: "九成宫醴泉铭" }],
      total: 1,
      totalPages: 1,
    });
    await expect(
      port.list({ kind: "inscription", page: 1, pageSize: 1 }),
    ).resolves.toMatchObject({
      items: [{ kind: "inscription", title: "好太王碑" }],
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
  });
});

describe("Catalog list HTTP boundary", () => {
  it("returns JSON 200 through the frozen CatalogPage mapper", async () => {
    const { baseUrl } = await startCatalogServer();
    const response = await fetch(`${baseUrl}/v1/catalog`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const page = catalogPageSchema.parse(await response.json());
    expect(page).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
    });
    expect(page.items.map(({ title }) => title)).toEqual([
      "九成宫醴泉铭",
      "好太王碑",
      "泰山经石峪金刚经",
    ]);
    expect(page.items.map(({ kind }) => kind)).toEqual([
      "calligraphy",
      "inscription",
      "inscription",
    ]);
    expect(page.items[0]?.representativeMedia?.id).toBe("fixture-media-002");
  });

  it("returns the requested subsequent page and an empty valid beyond-range page", async () => {
    const { baseUrl } = await startCatalogServer();
    const secondPage = catalogPageSchema.parse(
      await (await fetch(`${baseUrl}/v1/catalog?page=2&pageSize=2`)).json(),
    );
    const beyondPageResponse = await fetch(
      `${baseUrl}/v1/catalog?page=100&pageSize=2`,
    );
    const beyondPage = catalogPageSchema.parse(await beyondPageResponse.json());

    expect(secondPage.items.map(({ id }) => id)).toEqual([
      "fixture-catalog-003",
    ]);
    expect(beyondPageResponse.status).toBe(200);
    expect(beyondPage).toEqual({
      items: [],
      page: 100,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it.each([
    ["calligraphy", ["九成宫醴泉铭"], 1],
    ["inscription", ["好太王碑", "泰山经石峪金刚经"], 2],
  ] as const)(
    "filters the HTTP list by kind=%s through the injected Port",
    async (kind, expectedTitles, expectedTotal) => {
      const { baseUrl } = await startCatalogServer();
      const response = await fetch(`${baseUrl}/v1/catalog?kind=${kind}`);
      const page = catalogPageSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(page.items.map(({ title }) => title)).toEqual(expectedTitles);
      expect(page.total).toBe(expectedTotal);
      expect(page.items.every((item) => item.kind === kind)).toBe(true);
    },
  );

  it("returns 200 with an empty frozen page for an empty collection", async () => {
    const emptyPort: CatalogQueryPort = {
      async list({ page, pageSize }) {
        return { items: [], total: 0, page, pageSize, totalPages: 0 };
      },
      async getById() {
        return null;
      },
    };
    const { baseUrl } = await startCatalogServer({
      catalogQueryPort: emptyPort,
    });
    const response = await fetch(`${baseUrl}/v1/catalog?page=4&pageSize=10`);

    expect(response.status).toBe(200);
    expect(catalogPageSchema.parse(await response.json())).toEqual({
      items: [],
      total: 0,
      page: 4,
      pageSize: 10,
      totalPages: 0,
    });
  });

  it.each([
    "page=0",
    "page=1.5",
    "pageSize=0",
    "pageSize=101",
    "kind=cliff_inscription",
    "kind=inscription&kind=calligraphy",
    "keyword=碑",
    "provicne=陕西省",
    "page=1&page=2",
  ])("returns INVALID_QUERY for invalid strict query %s", async (query) => {
    const { baseUrl } = await startCatalogServer();
    const response = await fetch(`${baseUrl}/v1/catalog?${query}`);

    await parseApiError(response, 400, "INVALID_QUERY");
  });
});

describe("Catalog detail HTTP boundary", () => {
  it("returns JSON 200 through the frozen CatalogDetail mapper", async () => {
    const { baseUrl } = await startCatalogServer();
    const response = await fetch(`${baseUrl}/v1/catalog/fixture-catalog-001`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(catalogDetailSchema.parse(await response.json())).toMatchObject({
      id: "fixture-catalog-001",
      kind: "calligraphy",
      title: "九成宫醴泉铭",
      representativeMedia: { id: "fixture-media-002" },
      media: [{ id: "fixture-media-001" }, { id: "fixture-media-002" }],
      dynasty: "唐",
      dateText: "贞观十年",
      province: "陕西",
      currentLocation: "陕西省碑林区",
      currentCustodian: "碑林博物馆",
    });
  });

  it.each(["fixture-catalog-999", "malformed%20catalog%20id"])(
    "returns ITEM_NOT_FOUND for missing or invalid ID %s",
    async (id) => {
      const { baseUrl } = await startCatalogServer();
      const response = await fetch(`${baseUrl}/v1/catalog/${id}`);

      await parseApiError(response, 404, "ITEM_NOT_FOUND");
    },
  );

  it("rejects unknown detail query parameters before the Catalog lookup", async () => {
    const { baseUrl } = await startCatalogServer();
    const existingResponse = await fetch(
      `${baseUrl}/v1/catalog/fixture-catalog-001?foo=bar`,
    );
    const missingResponse = await fetch(
      `${baseUrl}/v1/catalog/fixture-catalog-999?foo=bar`,
    );

    await parseApiError(existingResponse, 400, "INVALID_QUERY");
    await parseApiError(missingResponse, 400, "INVALID_QUERY");
  });

  it("does not leak private fixture representation fields", async () => {
    const { baseUrl } = await startCatalogServer();
    const response = await fetch(`${baseUrl}/v1/catalog/fixture-catalog-001`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    catalogDetailSchema.parse(body);
    expect(serialized).not.toContain("privateFixtureMetadata");
    expect(serialized).not.toContain("internalSourceId");
    expect(serialized).not.toContain("rawSourceExcerpt");
    expect(serialized).not.toContain("verificationNote");
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("ownerDecision");
    expect(serialized).not.toContain("migrationMetadata");
    expect(serialized).not.toContain("internalRightsNotes");
    expect(serialized).not.toContain("storagePath");
  });
});

describe("Catalog composition and transport errors", () => {
  const injectedId = catalogIdSchema.parse("injected-catalog-001");
  const injectedDetail: CatalogDetailProjection = {
    id: injectedId,
    kind: "inscription",
    title: "Explicitly injected Catalog port",
    aliases: [],
    sourceCitations: [],
    media: [],
  };
  const injectedPort: CatalogQueryPort = {
    async list({ page, pageSize }) {
      return {
        items: page === 1 ? [injectedDetail] : [],
        total: 1,
        page,
        pageSize,
        totalPages: 1,
      };
    },
    async getById(id: CatalogId) {
      return id === injectedId ? injectedDetail : null;
    },
  };

  it.each<NodeEnvironment>(["development", "test", "production"])(
    "gives explicit dependency injection priority in %s",
    async (nodeEnv) => {
      const { baseUrl } = await startCatalogServer({
        nodeEnv,
        catalogQueryPort: injectedPort,
      });
      const response = await fetch(`${baseUrl}/v1/catalog`);
      const page = catalogPageSchema.parse(await response.json());

      expect(page.items.map(({ title }) => title)).toEqual([
        "Explicitly injected Catalog port",
      ]);
    },
  );

  it("fails production composition before a listener is returned", () => {
    expect(() => createBackendApplication({ nodeEnv: "production" })).toThrow(
      "CatalogQueryPort",
    );
  });

  it("requires an explicit production resolver after the Catalog port", () => {
    expect(() =>
      createBackendApplication({
        nodeEnv: "production",
        catalogQueryPort: injectedPort,
      }),
    ).toThrow("StorageUrlResolver");
  });

  it("serves Media-less list and detail without invoking a failing resolver", async () => {
    let resolverCalls = 0;
    const resolver: StorageUrlResolver = {
      async resolveMany() {
        resolverCalls += 1;
        throw new Error("must not be called");
      },
    };
    const { baseUrl } = await startCatalogServer({
      catalogQueryPort: injectedPort,
      storageUrlResolver: resolver,
    });

    const [list, detail] = await Promise.all([
      fetch(`${baseUrl}/v1/catalog`),
      fetch(`${baseUrl}/v1/catalog/${injectedId}`),
    ]);

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(
      catalogPageSchema.parse(await list.json()).items[0],
    ).not.toHaveProperty("representativeMedia");
    expect(catalogDetailSchema.parse(await detail.json())).toMatchObject({
      media: [],
    });
    expect(resolverCalls).toBe(0);
  });

  it("returns safe SERVICE_UNAVAILABLE only when Media requires resolution", async () => {
    const mediaId = mediaIdSchema.parse("media-http-unresolved");
    const mediaPort: CatalogQueryPort = {
      async list({ page, pageSize }) {
        return {
          items: [
            {
              id: injectedId,
              kind: "inscription",
              title: "Unresolved Media",
              aliases: [],
              representativeMedia: {
                id: mediaId,
                position: 0,
                isRepresentative: true,
                kind: "image",
                alt: "未解析测试图",
                width: 800,
                height: 600,
                objectKey: "private/unresolved.jpg",
              },
            },
          ],
          total: 1,
          page,
          pageSize,
          totalPages: 1,
        };
      },
      async getById() {
        return null;
      },
    };
    const resolvers = [
      new UnconfiguredStorageUrlResolver(),
      {
        async resolveMany() {
          throw new Error("private resolver exception");
        },
      },
      {
        async resolveMany() {
          return new Map([[mediaId, "not-a-url"]]);
        },
      },
    ] satisfies StorageUrlResolver[];

    for (const storageUrlResolver of resolvers) {
      const { baseUrl } = await startCatalogServer({
        catalogQueryPort: mediaPort,
        storageUrlResolver,
      });
      const response = await fetch(`${baseUrl}/v1/catalog`);
      const error = await parseApiError(response, 503, "SERVICE_UNAVAILABLE");

      expect(JSON.stringify(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("not-a-url");
    }
  });

  it("maps unexpected list and detail port exceptions to safe INTERNAL_ERROR JSON", async () => {
    const secret = "/private/catalog/adapter.ts:99";
    const failingPort: CatalogQueryPort = {
      async list() {
        throw new Error(secret);
      },
      async getById() {
        throw new Error(secret);
      },
    };
    const { baseUrl } = await startCatalogServer({
      catalogQueryPort: failingPort,
    });
    for (const path of ["/v1/catalog", "/v1/catalog/fixture-catalog-001"]) {
      const response = await fetch(`${baseUrl}${path}`);
      const error = await parseApiError(response, 500, "INTERNAL_ERROR");

      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("maps classified Catalog availability failures to safe SERVICE_UNAVAILABLE JSON", async () => {
    const secret = "postgresql://secret@private-host/catalog";
    const unavailablePort: CatalogQueryPort = {
      async list() {
        throw new CatalogQueryUnavailableError({ cause: new Error(secret) });
      },
      async getById() {
        throw new CatalogQueryUnavailableError({ cause: new Error(secret) });
      },
    };
    const { baseUrl } = await startCatalogServer({
      catalogQueryPort: unavailablePort,
    });
    for (const path of ["/v1/catalog", "/v1/catalog/fixture-catalog-001"]) {
      const response = await fetch(`${baseUrl}${path}`);
      const error = await parseApiError(response, 503, "SERVICE_UNAVAILABLE");

      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it.each(["/v1/catalog", "/v1/catalog/fixture-catalog-001"])(
    "returns JSON 405 and Allow for unsupported method on %s",
    async (path) => {
      const { baseUrl } = await startCatalogServer();
      const response = await fetch(`${baseUrl}${path}`, { method: "POST" });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(await response.json()).toEqual({
        error: { message: "Method Not Allowed", status: 405 },
      });
    },
  );
});

describe("Catalog rendition delivery over HTTP (unified media pipeline, PR 1b)", () => {
  const catalogId = catalogIdSchema.parse("rendition-catalog-001");
  const mediaId = mediaIdSchema.parse("media-rendition-http");
  const key = (n: number) => `media-rendition-${String(n).repeat(32)}`;
  const deliveryUrl = (n: number) =>
    `http://127.0.0.1:3001/v1/development/catalog-renditions/${key(n)}`;
  const media: CatalogMediaProjection = {
    id: mediaId,
    position: 0,
    isRepresentative: true,
    kind: "image",
    alt: "分级测试图",
    width: 4096,
    height: 2731,
    objectKey: "private/approved.webp",
    renditions: [
      {
        key: key(1),
        width: 480,
        height: 320,
        contentType: "image/webp",
        level: "card",
      },
      {
        key: key(2),
        width: 1080,
        height: 720,
        contentType: "image/webp",
        level: "card",
      },
      {
        key: key(3),
        width: 2048,
        height: 1365,
        contentType: "image/webp",
        level: "display",
      },
      {
        key: key(4),
        width: 4096,
        height: 2731,
        contentType: "image/webp",
        level: "zoom",
      },
    ],
    placeholderColor: "#3a2f28",
  };
  const port: CatalogQueryPort = {
    async list({ page, pageSize }) {
      return {
        items: [
          {
            id: catalogId,
            kind: "inscription",
            title: "分级资料",
            aliases: [],
            representativeMedia: media,
          },
        ],
        total: 1,
        page,
        pageSize,
        totalPages: 1,
      };
    },
    async getById(id) {
      return id === catalogId
        ? {
            id,
            kind: "inscription",
            title: "分级资料",
            aliases: [],
            representativeMedia: media,
            sourceCitations: [],
            media: [media],
          }
        : null;
    },
  };
  const approved = new Map([
    ["private/approved.webp", "https://media.example.invalid/approved.webp"],
  ]);
  const candidate = (n: number, width: number, height: number) => ({
    src: deliveryUrl(n),
    width,
    height,
    contentType: "image/webp",
  });
  const cardList = [
    candidate(1, 480, 320),
    candidate(2, 1080, 720),
    candidate(3, 2048, 1365),
  ];

  it("lists card candidates on list pages and zoom levels in the detail gallery", async () => {
    const { baseUrl } = await startCatalogServer({
      catalogQueryPort: port,
      storageUrlResolver: new MappedStorageUrlResolver(
        approved,
        new Map([1, 2, 3, 4].map((n) => [key(n), deliveryUrl(n)] as const)),
      ),
    });
    const page = catalogPageSchema.parse(
      await (await fetch(`${baseUrl}/v1/catalog`)).json(),
    );
    expect(page.items[0]?.representativeMedia).toEqual({
      id: mediaId,
      kind: "image",
      src: deliveryUrl(3),
      alt: "分级测试图",
      width: 2048,
      height: 1365,
      renditions: cardList,
      placeholderColor: "#3a2f28",
    });
    const detail = catalogDetailSchema.parse(
      await (await fetch(`${baseUrl}/v1/catalog/${catalogId}`)).json(),
    );
    expect(detail.representativeMedia?.renditions).toEqual(cardList);
    expect(detail.media[0]?.renditions).toEqual([
      ...cardList,
      candidate(4, 4096, 2731),
    ]);
    expect(JSON.stringify(detail)).not.toContain("private/approved.webp");
  });

  it("keeps the approved image when a candidate does not resolve and answers 503 when the batch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const partial = await startCatalogServer({
      catalogQueryPort: port,
      storageUrlResolver: new MappedStorageUrlResolver(
        approved,
        new Map([[key(3), deliveryUrl(3)]]),
      ),
    });
    const page = catalogPageSchema.parse(
      await (await fetch(`${partial.baseUrl}/v1/catalog`)).json(),
    );
    expect(page.items[0]?.representativeMedia).toEqual({
      id: mediaId,
      kind: "image",
      src: "https://media.example.invalid/approved.webp",
      alt: "分级测试图",
      width: 4096,
      height: 2731,
      placeholderColor: "#3a2f28",
    });
    expect(warn.mock.calls).toEqual([["[catalog-media] rendition_fallback"]]);
    warn.mockRestore();
    const failing = await startCatalogServer({
      catalogQueryPort: port,
      storageUrlResolver: {
        resolveMany: async () =>
          new Map([[mediaId, "https://media.example.invalid/approved.webp"]]),
        resolveKeys: async () => {
          throw new Error("private rendition resolver exception");
        },
      },
    });
    for (const path of ["/v1/catalog", `/v1/catalog/${catalogId}`]) {
      const error = await parseApiError(
        await fetch(`${failing.baseUrl}${path}`),
        503,
        "SERVICE_UNAVAILABLE",
      );
      expect(JSON.stringify(error)).not.toContain("private");
    }
  });
});
