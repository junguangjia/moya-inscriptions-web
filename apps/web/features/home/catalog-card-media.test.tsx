// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const slot = vi.hoisted(() => ({
  value: null as MediaSlot | null,
}));
vi.mock("./catalog-masonry", () => ({
  useFeedPostSlot: () => false,
  useMasonrySlot: () => slot.value,
}));

import { CatalogCardMedia, feedMediaBoxRatio } from "./catalog-card";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import homeCss from "./home-screen.module.css?raw";

import type {
  CatalogCardMediaSource,
  CatalogCardVariant,
} from "./catalog-card";
import type { MediaSlot } from "../media/responsive-media";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const itemId = `media-item-${"e".repeat(32)}`;
/** A work cover still; 1:3 unless sized otherwise. */
const cover = (
  extra: Partial<CatalogCardMediaSource> = {},
): CatalogCardMediaSource => ({
  src: `/api/community/publishing/media/${itemId}/cover/base`,
  alt: "春日临帖",
  width: 600,
  height: 1800,
  placeholderColor: "#4a4038",
  ...extra,
});

const roots: Root[] = [];
const render = (
  media: CatalogCardMediaSource,
  variant: CatalogCardVariant = "feed",
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <CatalogCardMedia media={media} title="春日临帖" variant={variant} />,
    ),
  );
  const box = container.querySelector<HTMLElement>(
    '[data-catalog-media-state="valid"]',
  )!;
  return {
    box,
    image: box.querySelector("img")!,
    framing: [
      box.getAttribute("data-fit"),
      box.getAttribute("data-feed-framing"),
      box.style.getPropertyValue("--feed-media-y"),
    ],
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  slot.value = null;
});

/*
 * #341 (Owner): a two-column, tablet or pc work card follows its cover's
 * feed framing when the revision has no cover composition: the author's
 * region of a still taller than the card box, or the whole still with blank
 * sides on the card's surface.
 */
describe("CatalogCardMedia feed framing", () => {
  it("shows the author's region of a still taller than its box", () => {
    const { box, image, framing } = render(
      cover({ feed: { fit: "cover", y: 0 } }),
    );
    expect(framing).toEqual(["cover", "region", "0%"]);
    // The box keeps its own shape: 1:3 clamps to 3:4.
    expect(box.style.getPropertyValue("--feed-media-ratio")).toBe("0.75");
    expect(image.style.backgroundColor).toBe("rgb(74, 64, 56)");
    expect(
      render(cover({ feed: { fit: "cover", y: 0.6667 } })).framing,
    ).toEqual(["cover", "region", "66.67%"]);
  });

  it("keeps the whole still with blank sides that are never tinted", () => {
    const { image, framing } = render(cover({ feed: { fit: "contain" } }));
    expect(framing).toEqual(["contain", "whole", ""]);
    expect(image.style.backgroundColor).toBe("");
  });

  it("leaves an unframed, centred, untall or inscription cover as it was", () => {
    const unchanged = [null, null, ""];
    expect(render(cover()).framing).toEqual(unchanged);
    expect(render(cover({ feed: { fit: "cover", y: 0.5 } })).framing).toEqual(
      unchanged,
    );
    // 3:4 exactly fills its own 3:4 box; a 4:3 is covered sideways as ever.
    for (const [width, height] of [
      [600, 800],
      [800, 600],
    ] as const)
      for (const feed of [{ fit: "contain" }, { fit: "cover", y: 0 }] as const)
        expect(render(cover({ width, height, feed })).framing).toEqual(
          unchanged,
        );
    const inscription = render(
      cover({ feed: { fit: "contain" } }),
      "inscription",
    );
    expect(inscription.framing).toEqual(unchanged);
    expect(inscription.image.style.backgroundColor).toBe("rgb(74, 64, 56)");
    // Without framing the still keeps its asset colour while it loads.
    expect(render(cover()).image.style.backgroundColor).toBe("rgb(74, 64, 56)");
  });

  it("frames a cover in a card covering every column by that card's 3:2 box", () => {
    slot.value = { platform: "phone", columns: 2, span: true };
    // A 3:4 still is taller than a 3:2 feature box.
    expect(
      render(cover({ width: 600, height: 800, feed: { fit: "contain" } }))
        .framing,
    ).toEqual(["contain", "whole", ""]);
    expect(
      render(
        cover({ width: 600, height: 800, feed: { fit: "cover", y: 0.25 } }),
      ).framing,
    ).toEqual(["cover", "region", "25%"]);
    // A landscape 3:2 still fills it exactly.
    expect(
      render(cover({ width: 900, height: 600, feed: { fit: "contain" } }))
        .framing,
    ).toEqual([null, null, ""]);
  });

  it("measures the card box as the stylesheet draws it", () => {
    expect(feedMediaBoxRatio({ width: 600, height: 1800 }, false)).toBe(4 / 3);
    expect(feedMediaBoxRatio({ width: 3000, height: 300 }, false)).toBe(2 / 3);
    expect(feedMediaBoxRatio({ width: 1000, height: 1250 }, false)).toBe(1.25);
    expect(feedMediaBoxRatio({ width: 600, height: 1800 }, true)).toBe(2 / 3);
    const css = (homeCss as string).replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(css).toMatch(
      /\.feedMedia img \{[^}]*object-fit: cover;\s*object-position: 50% var\(--feed-media-y, 50%\);/u,
    );
    expect(css).toMatch(
      /\.feedMedia\[data-fit="contain"\] \{\s*background: var\(--yoyi-color-background-surface\);\s*\}/u,
    );
    expect(css).toMatch(
      /\.feedMedia\[data-fit="contain"\] img \{\s*object-fit: contain;\s*\}/u,
    );
    expect(css).toMatch(
      /\.masonry\[data-span-aligned-rows\]\s+\.masonryItem\[data-home-masonry-span="full"\]\s+\.feedMedia,[^{]*\{\s*aspect-ratio: 3 \/ 2;/u,
    );
    // The feed stage crops a taller image at the author's region.
    expect(css).toMatch(
      /\.postSlide\[data-fit="cover"\] \.postSlideButton img \{\s*object-fit: cover;\s*object-position: 50% var\(--feed-slide-y, 50%\);\s*\}/u,
    );
    expect(css).toMatch(
      /\.postStage \{[^}]*background: var\(--yoyi-color-background-page\);/u,
    );
  });
});
