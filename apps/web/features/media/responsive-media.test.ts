import { describe, expect, it } from "vitest";

import {
  MEDIA_SIZES,
  VIEWER_INITIAL_MAX_PIXELS,
  VIEWER_UPGRADE_HEADROOM,
  VIEWER_UPGRADE_SETTLE_MS,
  coverFitFactor,
  inlineRenditions,
  listMediaPriority,
  mediaLoading,
  pickRendition,
  placeholderStyle,
  responsiveImage,
  srcSetOf,
  viewerInitialRendition,
  viewerRenditions,
  viewerUpgradeRendition,
} from "./responsive-media";

import type {
  RenditionCandidate,
  ResponsiveMediaSource,
} from "./responsive-media";

/*
 * unified-media-pipeline-v1 (CW13/CW14): candidates up to the anchor for
 * inline images, zoom levels for the Viewer only, `sizes` from the CSS boxes.
 */
const origin = "https://media.example.invalid/r";
const rendition = (width: number, height: number): RenditionCandidate => ({
  src: `${origin}/${width}x${height}.webp`,
  width,
  height,
});
const detail = (
  list: readonly RenditionCandidate[],
  anchor: RenditionCandidate,
): ResponsiveMediaSource => ({
  src: anchor.src,
  width: anchor.width,
  height: anchor.height,
  renditions: list,
});

const thumb = rendition(480, 270);
const cover = rendition(1080, 608);
const display = rendition(1600, 900);
const zoom = rendition(3200, 1800);
const landscape = detail([thumb, cover, display, zoom], display);

describe("rendition selection", () => {
  it("picks the smallest candidate covering the demand, else the widest", () => {
    const list = [thumb, cover, display];
    expect(pickRendition(list, 1)).toBe(thumb);
    expect(pickRendition(list, 480)).toBe(thumb);
    expect(pickRendition(list, 481)).toBe(cover);
    expect(pickRendition(list, 1600)).toBe(display);
    expect(pickRendition(list, 9000)).toBe(display);
    expect(pickRendition([], 100)).toBeUndefined();
  });

  it("offers inline surfaces the candidates up to the anchor, never a zoom level", () => {
    expect(inlineRenditions(landscape)).toEqual([thumb, cover, display]);
    expect(inlineRenditions(detail([thumb, cover, display], cover))).toEqual([
      thumb,
      cover,
    ]);
    // A wide long scroll keeps its 16000 × 1200 display as the anchor.
    const scrollThumb = rendition(480, 36);
    const scrollCover = rendition(1080, 81);
    const scrollDisplay = rendition(16000, 1200);
    expect(
      inlineRenditions(
        detail([scrollThumb, scrollCover, scrollDisplay], scrollDisplay),
      ),
    ).toEqual([scrollThumb, scrollCover, scrollDisplay]);
  });

  it("orders candidates, keeps one per width and refuses an unusable list", () => {
    expect(
      inlineRenditions(
        detail([display, thumb, cover, rendition(480, 271)], display),
      ),
    ).toEqual([thumb, cover, display]);
    // No anchor: the list does not describe this `src`.
    expect(
      inlineRenditions({ ...landscape, src: `${origin}/legacy.webp` }),
    ).toEqual([]);
    expect(inlineRenditions({ ...landscape, renditions: undefined })).toEqual(
      [],
    );
    // A tolerant source (Topics) can carry a malformed list.
    const malformed = [
      thumb,
      { src: display.src, width: "1600", height: 900 },
    ] as unknown as RenditionCandidate[];
    expect(inlineRenditions(detail(malformed, display))).toEqual([]);
    expect(
      inlineRenditions(detail([thumb, { ...display, width: 0 }], display)),
    ).toEqual([]);
  });
});

describe("srcset and the responsive image", () => {
  it("writes w descriptors, one per width", () => {
    expect(srcSetOf([thumb, cover, display])).toBe(
      `${thumb.src} 480w, ${cover.src} 1080w, ${display.src} 1600w`,
    );
    expect(srcSetOf([cover, thumb, { ...rendition(480, 300) }])).toBe(
      `${thumb.src} 480w, ${cover.src} 1080w`,
    );
    expect(srcSetOf([])).toBeUndefined();
  });

  it.each([
    `${origin}/with space.webp`,
    `${origin}/with,comma.webp`,
    `${origin}/tab\tseparated.webp`,
    `${origin}/trailing.webp,`,
  ])("emits no srcset when a URL cannot be written into it: %s", (src) => {
    expect(srcSetOf([thumb, { ...display, src }])).toBeUndefined();
    const media = detail([thumb, { ...display, src }], { ...display, src });
    expect(responsiveImage(media, "100vw")).toEqual({ src });
  });

  it("keeps src as the anchor and adds srcset and sizes from two inline candidates", () => {
    expect(responsiveImage(landscape, "100vw")).toEqual({
      src: display.src,
      srcSet: `${thumb.src} 480w, ${cover.src} 1080w, ${display.src} 1600w`,
      sizes: "100vw",
    });
    // Legacy media, an anchor-only list and the smallest anchor stay src only.
    expect(
      responsiveImage({ src: display.src, width: 1600, height: 900 }, "100vw"),
    ).toEqual({ src: display.src });
    expect(responsiveImage(detail([display], display), "100vw")).toEqual({
      src: display.src,
    });
    expect(
      responsiveImage(detail([thumb, cover, display], thumb), "100vw"),
    ).toEqual({ src: thumb.src });
  });

  it("never rewrites a URL, a signed query included", () => {
    const signed = {
      ...display,
      src: `${origin}/1600x900.webp?q-sign-algorithm=sha1&q-ak=synthetic`,
    };
    expect(
      responsiveImage(detail([thumb, signed], signed), "100vw").srcSet,
    ).toBe(`${thumb.src} 480w, ${signed.src} 1600w`);
  });
});

describe("placeholder colour and list priority", () => {
  it("paints only a valid lowercase colour", () => {
    expect(placeholderStyle("#8b735f")).toEqual({ backgroundColor: "#8b735f" });
    for (const color of [undefined, "", "#8B735F", "#abc", "red", "#8b735f00"])
      expect(placeholderStyle(color)).toBeUndefined();
  });

  it("loads the first card eagerly at high priority and the second eagerly", () => {
    expect([0, 1, 2, 12].map(listMediaPriority)).toEqual([
      "high",
      "eager",
      undefined,
      undefined,
    ]);
    expect(mediaLoading("high")).toEqual({
      loading: "eager",
      fetchPriority: "high",
    });
    expect(mediaLoading("eager")).toEqual({ loading: "eager" });
    expect(mediaLoading(undefined)).toEqual({ loading: "lazy" });
  });
});

describe("Viewer candidates", () => {
  const anchor = rendition(2048, 1365);
  const viewer = rendition(4096, 2731);
  const full = rendition(8192, 5461);
  const work = detail([rendition(480, 320), anchor, viewer, full], anchor);

  it("pins the progressive Viewer constants", () => {
    expect(VIEWER_INITIAL_MAX_PIXELS).toBe(4096 * 4096);
    expect(VIEWER_UPGRADE_HEADROOM).toBe(1.15);
    expect(VIEWER_UPGRADE_SETTLE_MS).toBe(120);
    expect(viewerRenditions(work).map(({ width }) => width)).toEqual([
      480, 2048, 4096, 8192,
    ]);
  });

  it("opens on the fit candidate within the 4096² bound", () => {
    expect(viewerInitialRendition(work, 1170)).toBe(anchor);
    expect(viewerInitialRendition(work, 3000)).toBe(viewer);
    // `full` exceeds the bound, so the largest bounded candidate opens.
    expect(viewerInitialRendition(work, 6000)).toBe(viewer);
    expect(
      viewerInitialRendition({ src: anchor.src, width: 2048, height: 1365 }, 1),
    ).toBeUndefined();
  });

  it("opens a long scroll within the pixel bound and upgrades to its anchor", () => {
    const bounded = rendition(81, 1080);
    const scroll = rendition(1200, 16000);
    const media = detail([rendition(36, 480), bounded, scroll], scroll);
    expect(scroll.width * scroll.height).toBeGreaterThan(
      VIEWER_INITIAL_MAX_PIXELS,
    );
    expect(viewerInitialRendition(media, 190)).toBe(bounded);
    expect(viewerUpgradeRendition(media, bounded, 190)).toBe(scroll);
  });

  it("upgrades only past the headroom, to the smallest wider candidate covering the demand", () => {
    expect(viewerUpgradeRendition(work, anchor, 2048 * 1.15)).toBeUndefined();
    expect(viewerUpgradeRendition(work, anchor, 2048 * 1.15 + 1)).toBe(viewer);
    expect(viewerUpgradeRendition(work, anchor, 6000)).toBe(full);
    expect(viewerUpgradeRendition(work, viewer, 20000)).toBe(full);
    expect(viewerUpgradeRendition(work, full, 20000)).toBeUndefined();
    // A refused candidate is never offered again; the next wider one is.
    expect(
      viewerUpgradeRendition(work, anchor, 3000, new Set([viewer.src])),
    ).toBe(full);
    expect(
      viewerUpgradeRendition(work, viewer, 9000, new Set([full.src])),
    ).toBeUndefined();
  });
});

describe("sizes per surface", () => {
  const wide = { width: 1600, height: 900 };
  const portrait = { width: 1200, height: 1600 };
  const square = { width: 1080, height: 1080 };
  const panorama = { width: 3000, height: 1000 };
  const scroll = { width: 600, height: 1800 };

  it("scales feed cards by the cover-fit factor of the 3:2-clamped box", () => {
    expect(coverFitFactor(portrait)).toBe(1);
    expect(coverFitFactor(square)).toBe(1);
    expect(coverFitFactor({ width: 1800, height: 1000 })).toBe(1.2);
    expect(coverFitFactor(panorama)).toBe(2);
    expect(coverFitFactor({ width: 0, height: 0 })).toBe(1);
  });

  it("follows the masonry slot of a feed card", () => {
    const phone = { platform: "phone", columns: 2, span: false } as const;
    expect(MEDIA_SIZES.feedCard(portrait, phone)).toBe("calc(50vw - 14px)");
    expect(MEDIA_SIZES.feedCard(portrait, { ...phone, span: true })).toBe(
      "calc(100vw - 16px)",
    );
    expect(MEDIA_SIZES.feedCard(portrait, { ...phone, columns: 1 })).toBe(
      "calc(100vw - 16px)",
    );
    expect(MEDIA_SIZES.feedCard(wide, phone)).toBe("calc(59.26vw - 16px)");
    expect(MEDIA_SIZES.feedCard(panorama, { ...phone, span: true })).toBe(
      "calc(200vw - 32px)",
    );
    const tablet = { platform: "tablet", columns: 2, span: false } as const;
    expect(MEDIA_SIZES.feedCard(portrait, tablet)).toBe("calc(50vw - 26px)");
    expect(MEDIA_SIZES.feedCard(portrait, { ...tablet, span: true })).toBe(
      "calc(100vw - 32px)",
    );
    const pc = { platform: "pc", columns: 5, span: false } as const;
    expect(MEDIA_SIZES.feedCard(portrait, pc)).toBe(
      "(min-width: 2757px) calc(12.5vw - 24px), 320px",
    );
    expect(MEDIA_SIZES.feedCard(wide, pc)).toBe(
      "(min-width: 2757px) calc(14.82vw - 29px), 380px",
    );
    expect(MEDIA_SIZES.topicCard(phone)).toBe("calc(50vw - 14px)");
  });

  it("falls back to the column feed outside a masonry", () => {
    const pc = "(hover: hover) and (pointer: fine)";
    expect(MEDIA_SIZES.feedCard(portrait)).toBe(
      `(min-width: 1440px) and ${pc} calc(20vw - 20px), ` +
        `(min-width: 1024px) and ${pc} calc(25vw - 22px), ` +
        `(min-width: 896px) and ${pc} calc(33.34vw - 24px), ` +
        "calc(50vw - 12px)",
    );
    expect(MEDIA_SIZES.topicCard(null)).toBe(MEDIA_SIZES.feedCard(portrait));
  });

  it("draws inscription thumbnails by their covered fixed boxes", () => {
    const pc = "(min-width: 896px) and (hover: hover) and (pointer: fine)";
    expect(MEDIA_SIZES.inscriptionCard(portrait)).toBe(
      `${pc} 128px, (min-width: 768px) 112px, 88px`,
    );
    expect(MEDIA_SIZES.inscriptionCard(square)).toBe(
      `${pc} 128px, (min-width: 768px) 120px, 104px`,
    );
    expect(MEDIA_SIZES.inscriptionCard(wide)).toBe(
      `${pc} 228px, (min-width: 768px) 214px, 185px`,
    );
  });

  it("bounds the contain-fit Detail carousel by stage width and height", () => {
    expect(MEDIA_SIZES.detailCarousel(wide, "phone")).toBe("100vw");
    expect(MEDIA_SIZES.detailCarousel(scroll, "phone")).toBe("44.45vw");
    expect(MEDIA_SIZES.detailCarousel(wide, "tablet")).toBe(
      "(min-width: 874px) 818px, calc(100vw - 56px)",
    );
    expect(MEDIA_SIZES.detailCarousel(portrait, "tablet")).toBe("345px");
    expect(MEDIA_SIZES.detailCarousel(wide, "pc")).toBe(
      "(min-width: 1320px) 768px, calc(100vw - 552px)",
    );
    expect(MEDIA_SIZES.detailCarousel(square, "pc")).toBe(
      "(min-width: 1112px) 560px, calc(100vw - 552px)",
    );
    expect(MEDIA_SIZES.detailCarousel(scroll, "pc")).toBe("187px");
  });

  it("widens an Article body image by its crop and narrows it by its display share", () => {
    expect(MEDIA_SIZES.articleBody()).toBe(
      "(min-width: 760px) 692px, calc(100vw - 40px)",
    );
    expect(MEDIA_SIZES.articleBody({ cropWidth: 0.5 })).toBe(
      "(min-width: 760px) 1384px, calc(200vw - 80px)",
    );
    expect(MEDIA_SIZES.articleBody({ share: 0.4 })).toBe(
      "(min-width: 760px) 277px, calc(40vw - 16px)",
    );
  });

  it("follows the editorial card boxes", () => {
    expect(MEDIA_SIZES.editorialCompact(portrait)).toBe(
      "(min-width: 768px) 180px, (max-width: 359px) 76px, 100px",
    );
    expect(MEDIA_SIZES.editorialCompact(wide)).toBe(
      "(min-width: 768px) 320px, (max-width: 359px) 136px, 178px",
    );
    expect(MEDIA_SIZES.editorialLarge(portrait)).toBe(
      "(min-width: 768px) 728px, 100vw",
    );
    expect(MEDIA_SIZES.editorialLarge(panorama)).toBe(
      "(min-width: 768px) 1365px, 187.5vw",
    );
    expect(MEDIA_SIZES.editorialSpecial(portrait)).toBe(
      "(min-width: 768px) 728px, (min-width: 308px) 100vw, 308px",
    );
    expect(MEDIA_SIZES.editorialSpecial(panorama)).toBe(
      "(min-width: 768px) 1320px, 1230px",
    );
  });

  it("bounds reader figures and thread images by column and height", () => {
    expect(MEDIA_SIZES.newsFigure(wide)).toBe(
      "(min-width: 663px) 623px, calc(100vw - 40px)",
    );
    expect(MEDIA_SIZES.newsFigure(scroll)).toBe("117px");
    expect(MEDIA_SIZES.academicFigure(wide)).toBe(
      "(min-width: 708px) 640px, calc(100vw - 68px)",
    );
    expect(MEDIA_SIZES.academicFigure(panorama)).toBe(
      "(min-width: 760px) 692px, calc(100vw - 68px)",
    );
    expect(MEDIA_SIZES.threadThumbnail(wide)).toBe(
      "(min-width: 760px) 238px, calc(33.34vw - 16px)",
    );
    expect(MEDIA_SIZES.threadThumbnail(scroll)).toBe(
      "(min-width: 760px) 80px, calc(11.12vw - 5px)",
    );
    expect(MEDIA_SIZES.threadGallery(square)).toBe(
      "(min-width: 640px) 600px, calc(100vw - 40px)",
    );
    expect(MEDIA_SIZES.threadGallery(scroll)).toBe("200px");
    expect(MEDIA_SIZES.topicBlock()).toBe(
      "(min-width: 760px) 728px, calc(100vw - 32px)",
    );
  });

  it("never uses sizes=auto", () => {
    const values = [
      MEDIA_SIZES.feedCard(wide),
      MEDIA_SIZES.inscriptionCard(wide),
      MEDIA_SIZES.detailCarousel(wide, "phone"),
      MEDIA_SIZES.articleBody(),
      MEDIA_SIZES.topicBlock(),
    ];
    for (const value of values) expect(value).not.toMatch(/\bauto\b/u);
  });
});
