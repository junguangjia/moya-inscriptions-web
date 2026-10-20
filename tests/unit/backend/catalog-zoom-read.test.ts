import { CatalogReadService, mapCatalogDetail } from "@moya/api";
import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  catalogDetailSchema,
  catalogIdSchema,
  catalogZoomBlocksSchema,
  mediaIdSchema,
} from "@moya/contracts/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CatalogDetailProjection,
  CatalogMediaProjection,
  CatalogMediaRenditionProjection,
  CatalogQueryPort,
  CatalogZoomBlocksProjection,
  CatalogZoomFrameProjection,
  StorageUrlResolver,
} from "@moya/api";
import type { MediaId } from "@moya/contracts";
import type { Server } from "node:http";

/*
 * catalog-deep-zoom-v1 (Issue #295), criteria 11, 12 and 20: the Detail
 * carries an image's block frame only when its rendition group resolved and
 * the frame shows its framing; a failing frame read omits every frame and
 * the Detail stays 200; the per-image block-list read answers only for an
 * image whose Detail entry carries the frame and whose every block key
 * resolves (404 otherwise, 503 when delivery lookup fails). No block URL
 * ever appears in the Detail.
 */

const hex = (n: number) => n.toString(16).padStart(32, "0");
const key = (n: number) => `media-rendition-${hex(n)}`;
const entry = (
  n: number,
  level: CatalogMediaRenditionProjection["level"],
  width: number,
  height: number,
): CatalogMediaRenditionProjection => ({
  key: key(n),
  width,
  height,
  contentType: "image/webp",
  level,
});
const catalogId = catalogIdSchema.parse("catalog-zoom-1");
const tiled = mediaIdSchema.parse("media-zoom-tiled");
const plain = mediaIdSchema.parse("media-zoom-plain");
const fallback = mediaIdSchema.parse("media-zoom-fallback");
const image = (
  id: MediaId,
  position: number,
  renditions?: readonly CatalogMediaRenditionProjection[],
): CatalogMediaProjection => ({
  id,
  position,
  isRepresentative: position === 0,
  kind: "image",
  alt: "合成拓片",
  width: 4096,
  height: 2731,
  objectKey: `private/${id}.webp`,
  ...(renditions === undefined ? {} : { renditions }),
});
const ladder = (base: number) => [
  entry(base + 1, "card", 480, 320),
  entry(base + 2, "card", 1080, 720),
  entry(base + 3, "display", 2048, 1365),
  entry(base + 4, "zoom", 4096, 2731),
];
const projection: CatalogDetailProjection = {
  id: catalogId,
  kind: "inscription",
  title: "合成资料",
  aliases: [],
  sourceCitations: [],
  media: [
    image(tiled, 0, ladder(0)),
    image(plain, 1, ladder(10)),
    // Its ladder keys are not delivered: the approved-`src` fallback.
    image(fallback, 2, ladder(20)),
  ],
};
const frame: CatalogZoomFrameProjection = { width: 8192, height: 5461 };
const blockKeys = Array.from({ length: 48 }, (_, cell) => key(1000 + cell));
const deliveryUrl = (value: string) =>
  `https://images.example.invalid/v1/p/g/${value}.jpg`;

const resolver = (
  options: {
    readonly withoutKeys?: ReadonlySet<string>;
    readonly failKeys?: boolean;
  } = {},
) => {
  const keys = vi.fn(async (requested: readonly string[]) => {
    if (
      options.failKeys === true &&
      requested.some((k) => blockKeys.includes(k))
    )
      throw new Error("lookup failed");
    return new Map(
      requested
        .filter(
          (value) =>
            !(options.withoutKeys?.has(value) ?? false) &&
            !ladder(20).some((ladderEntry) => ladderEntry.key === value),
        )
        .map((value) => [value, deliveryUrl(value)] as const),
    );
  });
  const value: StorageUrlResolver = {
    resolveMany: async (locators) =>
      new Map(
        locators.map(
          (locator) =>
            [
              locator.mediaId,
              `https://media.example.invalid/${locator.mediaId}.webp`,
            ] as const,
        ),
      ),
    resolveKeys: keys,
  };
  return { value, keys };
};

const port = (
  options: {
    readonly frames?: () => Promise<
      ReadonlyMap<MediaId, CatalogZoomFrameProjection>
    >;
    readonly blocks?: CatalogZoomBlocksProjection | null;
  } = {},
): CatalogQueryPort => ({
  list: async () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
  }),
  getById: async (id) => (id === catalogId ? projection : null),
  getZoomFrames:
    options.frames ??
    (async () =>
      new Map([
        [tiled, frame],
        [fallback, frame],
        // A frame of another framing is never emitted.
        [plain, { width: 8192, height: 5000 }],
      ])),
  getZoomBlocks: async (id, mediaId) =>
    options.blocks !== undefined
      ? options.blocks
      : id === catalogId && mediaId === tiled
        ? { ...frame, keys: blockKeys }
        : null,
});

describe("the Detail zoom frame", () => {
  it("attaches the frame only to a resolved rendition group of the same framing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const detail = await new CatalogReadService(
      port(),
      resolver().value,
    ).getById(catalogId);
    expect(catalogDetailSchema.parse(detail)).toEqual(detail);
    const byId = new Map(detail!.media.map((media) => [media.id, media]));
    expect(byId.get(tiled)?.zoom).toEqual(frame);
    expect(byId.get(plain)?.zoom).toBeUndefined();
    expect(byId.get(fallback)?.renditions).toBeUndefined();
    expect(byId.get(fallback)?.zoom).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[catalog-zoom] frame_refused");
    // No block URL ever reaches the Detail (criterion 12).
    const json = JSON.stringify(detail);
    for (const blockKey of blockKeys) expect(json).not.toContain(blockKey);
    warn.mockRestore();
  });

  it("omits every frame when the frame read fails, and the Detail still answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const detail = await new CatalogReadService(
      port({
        frames: async () => {
          throw new Error("view unavailable");
        },
      }),
      resolver().value,
    ).getById(catalogId);
    expect(detail?.media.every((media) => media.zoom === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledWith("[catalog-zoom] frame_unavailable");
    warn.mockRestore();
  });

  it("grows the Detail by at most 48 bytes raw per mastered image (criterion 20)", () => {
    const urls = new Map(
      projection.media.flatMap((media) =>
        (media.renditions ?? []).map(
          (rendition) => [rendition.key, deliveryUrl(rendition.key)] as const,
        ),
      ),
    );
    // Shaped like the largest known record: 83 images, all mastered.
    const record: CatalogDetailProjection = {
      ...projection,
      media: Array.from({ length: 83 }, (_, n) =>
        image(mediaIdSchema.parse(`media-zoom-${n}`), n, ladder(0)),
      ),
    };
    const many = new Map(
      record.media.map(
        (media) =>
          [media.id, `https://media.example.invalid/${media.id}.webp`] as const,
      ),
    );
    const without = JSON.stringify(mapCatalogDetail(record, many, urls));
    const withFrames = JSON.stringify(
      mapCatalogDetail(
        record,
        many,
        urls,
        new Map(record.media.map((media) => [media.id, frame] as const)),
      ),
    );
    const growth = Buffer.byteLength(withFrames) - Buffer.byteLength(without);
    expect(growth / 83).toBeLessThanOrEqual(48);
    expect(growth).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("the per-image block-list read", () => {
  it("answers the frame, the grid and one URL per cell, resolved in one batch", async () => {
    const { value, keys } = resolver();
    const blocks = await new CatalogReadService(port(), value).getZoomBlocks(
      catalogId,
      tiled,
    );
    expect(catalogZoomBlocksSchema.parse(blocks)).toEqual({
      ...frame,
      edge: 1024,
      overlap: 2,
      srcs: blockKeys.map(deliveryUrl),
    });
    expect(
      keys.mock.calls.filter(([requested]) =>
        requested.includes(blockKeys[0]!),
      ),
    ).toHaveLength(1);
    // ≤ 13 KiB raw for a 100-block image (criterion 20); this one has 48.
    expect(Buffer.byteLength(JSON.stringify(blocks))).toBeLessThanOrEqual(
      13 * 1024,
    );
  });

  it("answers null without a Detail frame, for a missing key, or a frame that moved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = (
      options: Parameters<typeof port>[0] = {},
      resolve = resolver(),
    ) => new CatalogReadService(port(options), resolve.value);
    expect(await service().getZoomBlocks(catalogId, plain)).toBeNull();
    expect(await service().getZoomBlocks(catalogId, fallback)).toBeNull();
    expect(
      await service(
        {},
        resolver({ withoutKeys: new Set([blockKeys[7]!]) }),
      ).getZoomBlocks(catalogId, tiled),
    ).toBeNull();
    expect(
      await service({
        blocks: { width: 8000, height: 5333, keys: blockKeys },
      }).getZoomBlocks(catalogId, tiled),
    ).toBeNull();
    expect(
      await new CatalogReadService(
        { list: port().list, getById: port().getById },
        resolver().value,
      ).getZoomBlocks(catalogId, tiled),
    ).toBeNull();
    warn.mockRestore();
  });
});

describe("GET /v1/catalog/{catalogId}/media/{mediaId}/zoom-blocks", () => {
  const servers = new Set<Server>();
  afterEach(async () => {
    for (const server of servers) await stopServer(server);
    servers.clear();
  });
  const start = async (options: { readonly failKeys?: boolean } = {}) => {
    const server = createBackendServer(
      createBackendApplication({
        nodeEnv: "test",
        catalogQueryPort: port(),
        storageUrlResolver: resolver(options).value,
      }),
    );
    servers.add(server);
    const address = await startServer(server, { host: "127.0.0.1", port: 0 });
    return `http://${address.address}:${address.port}`;
  };
  const path = (media: string) =>
    `/v1/catalog/${catalogId}/media/${media}/zoom-blocks`;

  it("answers 200 for a tiled image and 404 for every other image or id", async () => {
    const base = await start();
    const ok = await fetch(`${base}${path(tiled)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(catalogZoomBlocksSchema.parse(await ok.json()).srcs).toHaveLength(
      48,
    );
    for (const media of [plain, fallback, "media-unknown", "%E0%A4%A"]) {
      const response = await fetch(`${base}${path(media)}`);
      expect(response.status, media).toBe(404);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
        "ITEM_NOT_FOUND",
      );
    }
    const otherRecord = await fetch(
      `${base}/v1/catalog/catalog-other/media/${tiled}/zoom-blocks`,
    );
    expect(otherRecord.status).toBe(404);
  });

  it("refuses a query and other methods, and answers 503 when delivery lookup fails", async () => {
    const base = await start();
    const query = await fetch(`${base}${path(tiled)}?page=1`);
    expect(query.status).toBe(400);
    expect(apiErrorSchema.parse(await query.json()).error.code).toBe(
      "INVALID_QUERY",
    );
    expect(
      (await fetch(`${base}${path(tiled)}`, { method: "POST" })).status,
    ).toBe(405);
    const failing = await start({ failKeys: true });
    const unavailable = await fetch(`${failing}${path(tiled)}`);
    expect(unavailable.status).toBe(503);
  });
});
