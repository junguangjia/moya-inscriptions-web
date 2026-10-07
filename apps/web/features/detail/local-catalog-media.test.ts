import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localCatalogFileUrl,
  localCatalogMediaSrc,
  localCatalogRenditionSrc,
  localCatalogRenditions,
} from "./local-catalog-media";
describe("native local Catalog media mapping", () => {
  const file = "a".repeat(64) + "-" + "b".repeat(64) + ".png";
  it("maps only bounded native loopback file sources and keeps identities separate", () => {
    expect(
      localCatalogMediaSrc(
        `http://127.0.0.1:3412/api/media/file/${file}`,
        "catalog:independent",
        "media:independent",
      ),
    ).toBe("/api/catalog/catalog%3Aindependent/media/media%3Aindependent");
    const remote = `https://example.invalid/api/media/file/${file}`;
    expect(localCatalogMediaSrc(remote, "catalog", "media")).toBe(remote);
  });
  it.each([
    "http://127.0.0.1:3412/api/users",
    "http://127.0.0.1:3412/api/media/file/arbitrary.png",
    `http://127.0.0.1:3412/api/media/file/${file}?token=synthetic-placeholder`,
    `http://localhost.example.invalid/api/media/file/${file}`,
  ])("rejects non-native source %s", (url) =>
    expect(localCatalogFileUrl(url)).toBeNull(),
  );
});

/*
 * unified-media-pipeline-v1: the Development resolver delivers Catalog
 * renditions from the Backend's loopback port; in Development they reach a
 * phone on the LAN through the Web origin instead.
 */
describe("Development Catalog rendition mapping", () => {
  const id = `media-rendition-${"c".repeat(32)}`;
  const loopback = `http://127.0.0.1:3411/v1/development/catalog-renditions/${id}`;
  const relay = `/api/development/catalog-renditions/${id}`;
  afterEach(() => vi.unstubAllEnvs());

  it("serves the exact Development rendition shape through the Web origin", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localCatalogRenditionSrc(loopback)).toBe(relay);
    expect(
      localCatalogRenditionSrc(
        `http://localhost:3411/v1/development/catalog-renditions/${id}`,
      ),
    ).toBe(relay);
    // `src` is the anchor rendition, so it follows the same rewrite.
    expect(localCatalogMediaSrc(loopback, "catalog", "media")).toBe(relay);
    expect(
      localCatalogRenditions([
        { src: loopback, width: 1600, height: 900 },
        {
          src: "https://media.example.invalid/a.webp",
          width: 480,
          height: 270,
        },
      ]),
    ).toEqual([
      { src: relay, width: 1600, height: 900 },
      { src: "https://media.example.invalid/a.webp", width: 480, height: 270 },
    ]);
    expect(localCatalogRenditions(undefined)).toBeUndefined();
  });

  it.each([
    `${loopback}?x=1`,
    `${loopback}#fragment`,
    `http://user@127.0.0.1:3411/v1/development/catalog-renditions/${id}`,
    `https://127.0.0.1:3411/v1/development/catalog-renditions/${id}`,
    `http://10.0.0.5:3411/v1/development/catalog-renditions/${id}`,
    `http://127.0.0.1/v1/development/catalog-renditions/${id}`,
    `http://127.0.0.1:123456/v1/development/catalog-renditions/${id}`,
    `http://127.0.0.1:3411/v1/development/catalog-renditions/media-rendition-${"C".repeat(32)}`,
    `http://127.0.0.1:3411/v1/development/catalog-renditions/media-item-${"c".repeat(32)}`,
    `http://127.0.0.1:3411/v1/catalog-renditions/${id}`,
    `/api/development/catalog-renditions/${id}`,
  ])("leaves any other source unchanged: %s", (src) => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localCatalogRenditionSrc(src)).toBe(src);
  });

  it.each(["production", "test"])("rewrites nothing in %s", (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    expect(localCatalogRenditionSrc(loopback)).toBe(loopback);
    expect(localCatalogMediaSrc(loopback, "catalog", "media")).toBe(loopback);
  });
});
