import { describe, expect, it } from "vitest";

import { editorialMediaSrc } from "./editorial-media";

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
