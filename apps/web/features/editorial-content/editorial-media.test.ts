import { afterEach, describe, expect, it, vi } from "vitest";

import { editorialImage, editorialMediaSrc } from "./editorial-media";

/*
 * content-community-completion-v1: a phone on the Development LAN origin cannot
 * reach the loopback Payload file URLs editorial media carry, so those are
 * served through the Web origin; every other source stays as it is.
 */
const file = `${"a".repeat(64)}-${"b".repeat(64)}.png`;
const owner = `article-${"1".repeat(32)}`;

describe("editorialMediaSrc", () => {
  it("serves a native synthetic Payload file through the Web origin", () => {
    expect(
      editorialMediaSrc(`http://127.0.0.1:3522/api/media/file/${file}`, owner),
    ).toBe(`/api/editorial-media/${owner}/${file}`);
    expect(
      editorialMediaSrc(`http://localhost:3002/api/media/file/${file}`, owner),
    ).toBe(`/api/editorial-media/${owner}/${file}`);
  });

  it.each([
    `https://media.example.invalid/api/media/file/${file}`,
    `http://10.0.0.5:3522/api/media/file/${file}`,
    `http://127.0.0.1:3522/api/media/file/${file}?x=1`,
    "http://127.0.0.1:3522/api/media/file/not-a-hashed-name.png",
    "/docs/design-system/assets/demo/sample.png",
  ])("leaves %s unchanged", (src) => {
    expect(editorialMediaSrc(src, owner)).toBe(src);
  });
});

/*
 * unified-media-pipeline-v1: a Catalog cover with renditions has a rendition
 * as its `src`; in Development both it and every candidate go through the
 * rendition relay, so the anchor still matches.
 */
describe("editorialImage", () => {
  const rendition = (hex: string) =>
    `http://127.0.0.1:3411/v1/development/catalog-renditions/media-rendition-${hex.repeat(32)}`;
  const relay = (hex: string) =>
    `/api/development/catalog-renditions/media-rendition-${hex.repeat(32)}`;
  const cover = {
    src: rendition("b"),
    width: 1080,
    height: 720,
    renditions: [
      { src: rendition("a"), width: 480, height: 320 },
      { src: rendition("b"), width: 1080, height: 720 },
    ],
  };
  afterEach(() => vi.unstubAllEnvs());

  it("rewrites the anchor and its candidates alike in Development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(editorialMediaSrc(rendition("b"), owner)).toBe(relay("b"));
    expect(editorialImage(cover, owner, "100vw")).toEqual({
      src: relay("b"),
      srcSet: `${relay("a")} 480w, ${relay("b")} 1080w`,
      sizes: "100vw",
    });
  });

  it("uses the delivered URLs as given elsewhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(editorialImage(cover, owner, "100vw")).toEqual({
      src: rendition("b"),
      srcSet: `${rendition("a")} 480w, ${rendition("b")} 1080w`,
      sizes: "100vw",
    });
  });
});
