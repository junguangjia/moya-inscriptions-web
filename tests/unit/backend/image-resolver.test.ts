import {
  MappedStorageUrlResolver,
  UnconfiguredStorageUrlResolver,
} from "@moya/image";
import { mediaIdSchema } from "@moya/contracts/schemas";
import { describe, expect, it } from "vitest";

describe("backend Storage URL resolver implementations", () => {
  it("maps configured object keys in one deterministic batch", async () => {
    const firstId = mediaIdSchema.parse("media-resolver-first");
    const secondId = mediaIdSchema.parse("media-resolver-second");
    const resolver = new MappedStorageUrlResolver(
      new Map([
        ["private/first.jpg", "https://media.example.invalid/first.jpg"],
      ]),
    );

    const resolved = await resolver.resolveMany([
      { mediaId: firstId, objectKey: "private/first.jpg" },
      { mediaId: secondId, objectKey: "private/missing.jpg" },
    ]);

    expect([...resolved]).toEqual([
      [firstId, "https://media.example.invalid/first.jpg"],
    ]);
  });

  it("keeps the production placeholder explicitly unconfigured", async () => {
    const resolved = await new UnconfiguredStorageUrlResolver().resolveMany([
      {
        mediaId: mediaIdSchema.parse("media-resolver-production"),
        objectKey: "private/production.jpg",
      },
    ]);

    expect(resolved.size).toBe(0);
  });

  it("resolves only mapped rendition delivery keys; the placeholder resolves none", async () => {
    const delivered = `media-rendition-${"1".repeat(32)}`;
    const unmapped = `media-rendition-${"2".repeat(32)}`;
    const mapped = new MappedStorageUrlResolver(
      new Map(),
      new Map([[delivered, "https://media.example.invalid/delivered.webp"]]),
    );
    expect([...(await mapped.resolveKeys([delivered, unmapped]))]).toEqual([
      [delivered, "https://media.example.invalid/delivered.webp"],
    ]);
    // Without a delivery map no key resolves (rendition delivery off).
    expect(
      (await new MappedStorageUrlResolver(new Map()).resolveKeys([delivered]))
        .size,
    ).toBe(0);
    expect(
      (await new UnconfiguredStorageUrlResolver().resolveKeys([delivered]))
        .size,
    ).toBe(0);
  });
});
