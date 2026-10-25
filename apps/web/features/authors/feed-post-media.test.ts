import { describe, expect, it } from "vitest";

import { feedPostMedia } from "./feed-post-media";

import type { ContentCard } from "@moya/contracts";

type GalleryEntry = NonNullable<ContentCard["gallery"]>[number];

const workId = `work-${"d".repeat(32)}`;
const itemId = (n: number) => `media-item-${String(n).padStart(32, "0")}`;
const still = (n: number, extra: Partial<GalleryEntry> = {}) => ({
  id: itemId(n),
  src: `/api/community/publishing/media/${itemId(n)}/display/base`,
  width: 600,
  height: 1800,
  ...extra,
});
const card = (overrides: Partial<ContentCard> = {}): ContentCard => ({
  aliases: [],
  target: { type: "work", id: workId },
  title: "春日临帖",
  kind: null,
  authorId: `user-${"f".repeat(32)}`,
  firstPublishedAt: "2026-09-13T12:00:00.000Z",
  media: still(1),
  ...overrides,
});

// #341: the stage frames each work image the author's way.
describe("feedPostMedia", () => {
  it("keeps each work image's feed framing and leaves an unframed one without", () => {
    const media = feedPostMedia(
      card({
        gallery: [
          still(1, { feed: { fit: "cover", y: 0 } }),
          still(2),
          still(3, { feed: { fit: "contain" } }),
        ],
        mediaCount: 3,
      }),
      "春日临帖",
    );
    expect(media.map((entry) => entry.feed)).toEqual([
      { fit: "cover", y: 0 },
      undefined,
      { fit: "contain" },
    ]);
    expect("feed" in media[1]!).toBe(false);
    expect(media[0]).toEqual({
      id: itemId(1),
      alt: "春日临帖",
      src: still(1).src,
      width: 600,
      height: 1800,
      renditions: undefined,
      placeholderColor: undefined,
      feed: { fit: "cover", y: 0 },
    });
  });

  it("keeps the card image's framing when the card lists no gallery", () => {
    // The card image carries it only while it is in the item's own framing.
    const [cover] = feedPostMedia(
      card({ media: { ...still(1), feed: { fit: "contain" } } }),
      "春日临帖",
    );
    expect(cover!.feed).toEqual({ fit: "contain" });
    expect("feed" in feedPostMedia(card(), "春日临帖")[0]!).toBe(false);
  });

  it("never frames a Catalog image", () => {
    // The contract refuses it; the post never reads it either.
    const catalog = {
      ...card({
        gallery: [still(1, { feed: { fit: "contain" } })],
        mediaCount: 1,
      }),
      target: { type: "catalog", id: "catalog-jiuchenggong" },
    } as unknown as ContentCard;
    expect("feed" in feedPostMedia(catalog, "九成宫")[0]!).toBe(false);
  });
});
