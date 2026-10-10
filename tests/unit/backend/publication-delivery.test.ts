import {
  mapPublishedMedia,
  withPublishedReads,
} from "@moya/backend-production/internal/publication";
import { describe, expect, it, vi } from "vitest";

const item = `media-item-${"1".repeat(32)}`;
const src = (role: string) =>
  `/api/community/publishing/media/${item}/${role}/base`;
const key = (role: string) =>
  `v1/${"2".repeat(32)}/${"3".repeat(32)}/base/${role}.r1.${role === "motion" ? "mp4" : "webp"}`;
const origin = "https://images.example.test";
const media = {
  id: item,
  src: src("display"),
  motionSrc: src("motion"),
  renditions: [
    { src: src("thumb"), width: 320 },
    { src: src("display"), width: 1600 },
  ],
};
const lookup = (roles: string[]) =>
  vi.fn(async () => new Map(roles.map((role) => [src(role), key(role)])));

describe("public publication DTO delivery", () => {
  it("does no lookup and preserves the exact DTO when Beta disables delivery", async () => {
    const read = lookup(["display", "motion", "thumb"]);
    expect(
      await mapPublishedMedia(media, {
        enabled: () => false,
        origin,
        lookup: read,
      }),
    ).toBe(media);
    expect(read).not.toHaveBeenCalled();
  });
  it("switches parent, motion and all still candidates together", async () => {
    const read = lookup(["display", "motion", "thumb"]);
    const mapped = await mapPublishedMedia(media, {
      enabled: () => true,
      origin,
      lookup: read,
    });
    expect(mapped.src).toBe(`${origin}/${key("display")}`);
    expect(mapped.motionSrc).toBe(`${origin}/${key("motion")}`);
    expect(mapped.renditions.map((r) => r.src)).toEqual([
      `${origin}/${key("thumb")}`,
      `${origin}/${key("display")}`,
    ]);
    expect(media.src).toBe(src("display"));
    expect(read).toHaveBeenCalledWith([item], expect.any(Date));
  });
  it.each(["thumb", "motion", "display"])(
    "keeps the whole group on relay when %s is missing",
    async (missing) => {
      expect(
        await mapPublishedMedia(media, {
          enabled: () => true,
          origin,
          lookup: lookup(
            ["display", "motion", "thumb"].filter((r) => r !== missing),
          ),
        }),
      ).toEqual(media);
    },
  );
  it("switches an independent cover group only when its list is complete", async () => {
    const work = {
      id: "work-test",
      media: [media],
      coverSrc: src("cover"),
      coverRenditions: [{ src: src("cover") }, { src: src("thumb") }],
    };
    const mapped = await mapPublishedMedia(work, {
      enabled: () => true,
      origin,
      lookup: lookup(["cover"]),
    });
    expect(mapped).toEqual(work);
  });
  it("switches every card gallery entry with its own candidates", async () => {
    const other = `media-item-${"4".repeat(32)}`;
    const otherSrc = (role: string) =>
      `/api/community/publishing/media/${other}/${role}/base`;
    const still = (id: string, at: (role: string) => string) => ({
      id,
      src: at("display"),
      renditions: [{ src: at("thumb") }, { src: at("display") }],
    });
    const card = {
      target: { type: "work", id: `work-${"5".repeat(32)}` },
      media: {
        id: item,
        src: src("cover"),
        renditions: [{ src: src("cover") }],
      },
      gallery: [still(item, src), still(other, otherSrc)],
      mediaCount: 2,
    };
    const read = vi.fn(
      async () =>
        new Map([
          ...["cover", "display", "thumb"].map(
            (role) => [src(role), key(role)] as const,
          ),
          // The second item's thumb is not published yet.
          [otherSrc("display"), key("other-display")] as const,
        ]),
    );
    const mapped = await mapPublishedMedia(card, {
      enabled: () => true,
      origin,
      lookup: read,
    });
    expect(mapped.media.src).toBe(`${origin}/${key("cover")}`);
    expect(mapped.gallery[0]).toEqual({
      id: item,
      src: `${origin}/${key("display")}`,
      renditions: [
        { src: `${origin}/${key("thumb")}` },
        { src: `${origin}/${key("display")}` },
      ],
    });
    // A gallery entry with a missing candidate stays wholly on the relay.
    expect(mapped.gallery[1]).toEqual(still(other, otherSrc));
    expect(mapped.mediaCount).toBe(2);
  });
  it("refuses a key outside the immutable published namespace", async () => {
    const read = lookup(["display", "motion", "thumb"]);
    read.mockResolvedValueOnce(
      new Map([
        [src("display"), "../original"],
        [src("motion"), key("motion")],
        [src("thumb"), key("thumb")],
      ]),
    );
    expect(
      await mapPublishedMedia(media, {
        enabled: () => true,
        origin,
        lookup: read,
      }),
    ).toEqual(media);
  });
  it("rechecks the mode after a concurrent lookup", async () => {
    let enabled = true;
    const read = vi.fn(async () => {
      enabled = false;
      return new Map([[src("display"), key("display")]]);
    });
    expect(
      await mapPublishedMedia(media, {
        enabled: () => enabled,
        origin,
        lookup: read,
      }),
    ).toBe(media);
  });
  it("decorates only selected reads and keeps the adapter receiver on writes", async () => {
    class Port {
      value = 7;
      async read() {
        return media;
      }
      write() {
        return this.value;
      }
    }
    const port = withPublishedReads(new Port(), ["read"], {
      enabled: () => true,
      origin,
      lookup: lookup(["display", "motion", "thumb"]),
    });
    expect((await port.read()).src).toBe(`${origin}/${key("display")}`);
    expect(port.write()).toBe(7);
  });
});
