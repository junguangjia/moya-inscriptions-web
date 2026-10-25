import { describe, expect, it } from "vitest";

import {
  COVER_PRESETS,
  EDIT_PRESETS,
  centeredCrop,
  closeEdit,
  cropFromPercentages,
  defaultFeed,
  drawPlan,
  editedSize,
  effectiveFeed,
  feedRegionText,
  feedStageWindow,
  matchPreset,
  normalizeCrop,
  normalizeFeed,
  previewPlacement,
  readerFeed,
  rotatedSize,
  sameEdit,
  sameFeed,
  turn,
  withFeed,
} from "./media-geometry";

describe("media edit geometry", () => {
  it("offers the documented presets and quarter turns in both directions", () => {
    expect(EDIT_PRESETS.map((preset) => preset.label)).toEqual([
      "原始比例",
      "1:1",
      "4:3",
      "3:4",
      "4:5",
      "16:9",
      "9:16",
    ]);
    expect(COVER_PRESETS.map((preset) => preset.id)).not.toContain("4:5");
    expect(COVER_PRESETS.map((preset) => preset.id)).toContain("original");
    expect(turn(0, 1)).toBe(90);
    expect(turn(270, 1)).toBe(0);
    expect(turn(0, -1)).toBe(270);
    expect(rotatedSize({ width: 4000, height: 3000 }, 90)).toEqual({
      width: 3000,
      height: 4000,
    });
    expect(rotatedSize({ width: 4000, height: 3000 }, 180)).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  it("stores the full frame as null and clamps crops inside the frame", () => {
    expect(cropFromPercentages({ x: 0, y: 0, width: 100, height: 100 })).toBe(
      null,
    );
    expect(
      cropFromPercentages({ x: 0.05, y: 0, width: 99.9, height: 100 }),
    ).toBe(null);
    expect(
      normalizeCrop({ x: 0.9, y: -0.2, width: 0.3, height: 0.004 }),
    ).toEqual({ x: 0.7, y: 0, width: 0.3, height: 0.01 });
    const crop = normalizeCrop({
      x: 1 / 3,
      y: 0.1,
      width: 2 / 3,
      height: 0.5,
    })!;
    expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(normalizeCrop({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBe(
      null,
    );
  });

  it("computes centered preset crops in the rotated frame and matches them back", () => {
    const source = { width: 4000, height: 3000 };
    const frame = rotatedSize(source, 90);
    const square = centeredCrop(1, frame)!;
    expect(square).toEqual({ x: 0, y: 0.125, width: 1, height: 0.75 });
    expect(matchPreset(square, frame)).toBe("1:1");
    expect(matchPreset(null, frame)).toBe("original");
    expect(centeredCrop(3 / 4, frame)).toBe(null);
    expect(matchPreset({ x: 0, y: 0, width: 0.5, height: 0.9 }, frame)).toBe(
      null,
    );
    expect(editedSize(source, { rotation: 90, crop: square })).toEqual({
      width: 3000,
      height: 3000,
    });
  });

  it("matches a 4:5 crop to its preset without disturbing the neighbours", () => {
    const frame = { width: 3000, height: 3000 };
    const tall = centeredCrop(4 / 5, frame)!;
    expect(tall).toEqual({ x: 0.1, y: 0, width: 0.8, height: 1 });
    expect(matchPreset(tall, frame)).toBe("4:5");
    expect(matchPreset(centeredCrop(3 / 4, frame), frame)).toBe("3:4");
    expect(matchPreset({ x: 0, y: 0, width: 0.5, height: 0.9 }, frame)).toBe(
      null,
    );
  });

  it("describes the feed stage window of an unframed frame from its shape", () => {
    // 3:4 frame: the stage is 4:5, so 6.25% is cut, half above and half below.
    expect(feedStageWindow(3 / 4)).toEqual({
      fit: "cover",
      height: 0.9375,
      top: 0.03125,
      tall: true,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(1)).toEqual({
      fit: "fill",
      height: 1,
      top: 0,
      tall: false,
      stageRatio: 1,
    });
    expect(feedStageWindow(4 / 5)).toEqual({
      fit: "fill",
      height: 1,
      top: 0,
      tall: false,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(4 / 3)).toEqual({
      fit: "contain",
      height: 1,
      top: 0,
      tall: false,
      stageRatio: 1,
    });
    expect(feedStageWindow(9 / 16).fit).toBe("cover");
    expect(feedStageWindow(9 / 16).height).toBeCloseTo(0.703125, 5);
    // A later item follows the first item's stage.
    expect(feedStageWindow(16 / 9, 1.25)).toEqual({
      fit: "contain",
      height: 1,
      top: 0,
      tall: false,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(1, 1.25).fit).toBe("contain");
    expect(feedStageWindow(3 / 4, 1).fit).toBe("cover");
    expect(feedStageWindow(3 / 4, 1).height).toBe(0.75);
    expect(feedStageWindow(3 / 4, 1).top).toBe(0.125);
    expect(feedStageWindow(Number.NaN)).toEqual({
      fit: "fill",
      height: 1,
      top: 0,
      tall: false,
      stageRatio: 1,
    });
  });

  it("places the feed window of a taller frame at the author's framing (#341)", () => {
    // 1:3 frame on the 4:5 stage: 41.67 % of it is visible.
    expect(feedStageWindow(1 / 3, 1.25, { fit: "cover", y: 0 })).toEqual({
      fit: "cover",
      height: 0.416667,
      top: 0,
      tall: true,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(1 / 3, 1.25, { fit: "cover", y: 1 }).top).toBe(
      0.583333,
    );
    expect(feedStageWindow(1 / 3, 1.25, { fit: "cover", y: 0.25 }).top).toBe(
      0.145833,
    );
    // No framing, or an unusable one, is the centred cover.
    expect(feedStageWindow(1 / 3, 1.25).top).toBeCloseTo(0.291667, 6);
    expect(
      feedStageWindow(1 / 3, 1.25, { fit: "cover", y: Number.NaN }).top,
    ).toBe(feedStageWindow(1 / 3, 1.25).top);
    expect(feedStageWindow(1 / 3, 1.25, { fit: "cover", y: 2 }).top).toBe(
      0.583333,
    );
    // 整张: the whole frame, blank at the sides.
    expect(feedStageWindow(1 / 3, 1.25, { fit: "contain" })).toEqual({
      fit: "contain",
      height: 1,
      top: 0,
      tall: true,
      stageRatio: 1.25,
    });
    // The first item's own window follows its stage, framed whole too.
    expect(feedStageWindow(1 / 3, undefined, { fit: "contain" })).toEqual({
      fit: "contain",
      height: 1,
      top: 0,
      tall: true,
      stageRatio: 1.25,
    });
    // A frame that is not taller than the stage keeps its framing dormant.
    expect(feedStageWindow(4 / 3, 1, { fit: "contain" })).toEqual(
      feedStageWindow(4 / 3, 1),
    );
    expect(feedStageWindow(1, 1, { fit: "cover", y: 0 })).toEqual(
      feedStageWindow(1, 1),
    );
    expect(feedStageWindow(1, 1.25, { fit: "contain" }).tall).toBe(false);
  });

  it("says what the feed window shows in words", () => {
    const tall = (y?: number) =>
      feedRegionText(
        feedStageWindow(
          1 / 3,
          1.25,
          y === undefined ? undefined : { fit: "cover", y },
        ),
      );
    expect(tall()).toBe("居中，上下各裁去 29%");
    expect(tall(0)).toBe("上方裁去 0%，下方裁去 58%");
    expect(tall(1)).toBe("上方裁去 58%，下方裁去 0%");
    expect(tall(0.25)).toBe("上方裁去 15%，下方裁去 44%");
    expect(
      feedRegionText(feedStageWindow(1 / 3, 1.25, { fit: "contain" })),
    ).toBe("整张显示，左右留白");
    expect(feedRegionText(feedStageWindow(1, 1))).toBe("满幅显示");
    expect(feedRegionText(feedStageWindow(4 / 3, 1))).toBe(
      "整张显示，上下留白",
    );
  });

  it("frames an uncropped photo whole and a cropped one centred by default (#341 r3)", () => {
    const crop = { x: 0, y: 0.1, width: 1, height: 0.5 };
    expect(defaultFeed({ crop: null })).toEqual({ fit: "contain" });
    expect(defaultFeed({ crop })).toEqual({ fit: "cover", y: 0.5 });

    // The author's choice wins; without one the crop's default shows.
    expect(effectiveFeed({ rotation: 0, crop: null })).toEqual({
      fit: "contain",
    });
    expect(effectiveFeed({ rotation: 90, crop })).toEqual({
      fit: "cover",
      y: 0.5,
    });
    expect(
      effectiveFeed({
        rotation: 0,
        crop: null,
        feed: { fit: "cover", y: 0.5 },
      }),
    ).toEqual({ fit: "cover", y: 0.5 });
    expect(
      effectiveFeed({ rotation: 0, crop, feed: { fit: "contain" } }),
    ).toEqual({ fit: "contain" });
    expect(
      effectiveFeed({ rotation: 0, crop, feed: { fit: "cover", y: 1 / 3 } }),
    ).toEqual({ fit: "cover", y: 0.3333 });
    // An invalid one is none.
    expect(
      effectiveFeed({
        rotation: 0,
        crop: null,
        feed: { fit: "cover", y: Number.NaN },
      }),
    ).toEqual({ fit: "contain" });
  });

  it("stores only a framing that differs from the photo's default, rounded", () => {
    const crop = { x: 0, y: 0.1, width: 1, height: 0.5 };
    const uncropped = { crop: null };
    const cropped = { crop };
    expect(normalizeFeed(undefined, uncropped)).toBeUndefined();
    expect(normalizeFeed(undefined, cropped)).toBeUndefined();
    // Uncropped: 整张 is the default, 局部 is stored even at the centre.
    expect(normalizeFeed({ fit: "contain" }, uncropped)).toBeUndefined();
    expect(normalizeFeed({ fit: "cover", y: 0.5 }, uncropped)).toEqual({
      fit: "cover",
      y: 0.5,
    });
    // Cropped: the centred cover is the default, 整张 is stored.
    expect(normalizeFeed({ fit: "contain" }, cropped)).toEqual({
      fit: "contain",
    });
    expect(normalizeFeed({ fit: "cover", y: 0.5 }, cropped)).toBeUndefined();
    expect(
      normalizeFeed({ fit: "cover", y: 0.50004 }, cropped),
    ).toBeUndefined();
    expect(normalizeFeed({ fit: "cover", y: 1 / 3 }, cropped)).toEqual({
      fit: "cover",
      y: 0.3333,
    });
    expect(normalizeFeed({ fit: "cover", y: -0.2 }, uncropped)).toEqual({
      fit: "cover",
      y: 0,
    });
    expect(normalizeFeed({ fit: "cover", y: 1.5 }, cropped)).toEqual({
      fit: "cover",
      y: 1,
    });
    expect(
      normalizeFeed({ fit: "cover", y: Number.NaN }, uncropped),
    ).toBeUndefined();

    // Compared as the photo shows them: absent is its default.
    expect(sameFeed(undefined, { fit: "cover", y: 0.5 }, cropped)).toBe(true);
    expect(sameFeed(undefined, { fit: "cover", y: 0.5 }, uncropped)).toBe(
      false,
    );
    expect(sameFeed(undefined, { fit: "contain" }, uncropped)).toBe(true);
    expect(sameFeed(undefined, { fit: "contain" }, cropped)).toBe(false);
    expect(
      sameFeed(
        { fit: "cover", y: 0.2 },
        { fit: "cover", y: 0.20001 },
        uncropped,
      ),
    ).toBe(true);
    expect(
      sameFeed({ fit: "cover", y: 0.2 }, { fit: "cover", y: 0.3 }, cropped),
    ).toBe(false);
    expect(sameFeed({ fit: "contain" }, { fit: "contain" }, cropped)).toBe(
      true,
    );
    expect(
      sameFeed({ fit: "contain" }, { fit: "cover", y: 0 }, uncropped),
    ).toBe(false);

    // `withFeed` stores relative to the edit it is given.
    const centred = withFeed({ rotation: 90, crop }, { fit: "cover", y: 0.5 });
    expect(centred).toEqual({ rotation: 90, crop });
    expect("feed" in centred).toBe(false);
    expect(
      withFeed({ rotation: 0, crop: null }, { fit: "cover", y: 0.5 }),
    ).toEqual({ rotation: 0, crop: null, feed: { fit: "cover", y: 0.5 } });
    const whole = withFeed({ rotation: 0, crop: null }, { fit: "contain" });
    expect(whole).toEqual({ rotation: 0, crop: null });
    expect("feed" in whole).toBe(false);
    expect(withFeed({ rotation: 0, crop }, { fit: "contain" })).toEqual({
      rotation: 0,
      crop,
      feed: { fit: "contain" },
    });
    expect(
      "feed" in
        withFeed({ rotation: 0, crop, feed: { fit: "contain" } }, undefined),
    ).toBe(false);
    expect(
      withFeed({ rotation: 0, crop: null }, { fit: "cover", y: 0.25 }),
    ).toEqual({ rotation: 0, crop: null, feed: { fit: "cover", y: 0.25 } });
  });

  it("gives readers the effective framing, absent for a centred cover (#341 r3)", () => {
    const crop = { x: 0, y: 0.1, width: 1, height: 0.5 };
    const tall = { width: 300, height: 900 };
    const square = { width: 500, height: 500 };
    const wide = { width: 900, height: 300 };
    // Uncropped: whole, spelled out only for a frame taller than a square.
    expect(readerFeed({ rotation: 0, crop: null }, tall)).toEqual({
      fit: "contain",
    });
    expect(readerFeed({ rotation: 0, crop: null }, square)).toBeUndefined();
    expect(
      readerFeed({ rotation: 0, crop: null }, { width: 1000, height: 1001 }),
    ).toBeUndefined();
    expect(readerFeed({ rotation: 0, crop: null }, wide)).toBeUndefined();
    expect(readerFeed({ rotation: 0, crop: null }, null)).toBeUndefined();
    // An explicit 局部 at the centre reads as the centred cover.
    expect(
      readerFeed(
        { rotation: 0, crop: null, feed: { fit: "cover", y: 0.5 } },
        tall,
      ),
    ).toBeUndefined();
    expect(
      readerFeed(
        { rotation: 0, crop: null, feed: { fit: "cover", y: 0.2 } },
        tall,
      ),
    ).toEqual({ fit: "cover", y: 0.2 });
    // Cropped: centred by default, an explicit 整张 kept.
    expect(readerFeed({ rotation: 0, crop }, tall)).toBeUndefined();
    expect(
      readerFeed({ rotation: 0, crop, feed: { fit: "contain" } }, tall),
    ).toEqual({ fit: "contain" });
    expect(
      readerFeed({ rotation: 0, crop, feed: { fit: "contain" } }, wide),
    ).toEqual({ fit: "contain" });
  });

  it("compares edits by their pixels alone, never their feed framing", () => {
    const pixels = { rotation: 90 as const, crop: null };
    const framed = { ...pixels, feed: { fit: "contain" as const } };
    expect(sameEdit(pixels, framed)).toBe(true);
    expect(closeEdit(pixels, framed)).toBe(true);
    expect(sameEdit(framed, { ...pixels, rotation: 180 })).toBe(false);
  });

  it("places the rotated frame so the crop fills the preview box", () => {
    const placement = previewPlacement(
      { width: 400, height: 300 },
      { rotation: 90, crop: { x: 0, y: 0.25, width: 1, height: 0.5 } },
    );
    expect(placement.aspectRatio).toBeCloseTo(1.5);
    expect(placement.frame).toEqual({
      left: "0%",
      top: "-50%",
      width: "100%",
      height: "200%",
    });
    expect(placement.rotation).toBe(90);
  });

  it("draws the edited frame at a bounded size with the crop at the origin", () => {
    const plan = drawPlan(
      { width: 4000, height: 3000 },
      { rotation: 90, crop: { x: 0, y: 0.125, width: 1, height: 0.75 } },
      1600,
    );
    expect(plan.canvas).toEqual({ width: 1600, height: 1600 });
    expect(plan.scale).toBeCloseTo(1600 / 3000);
    expect(plan.origin).toEqual({ x: 3000, y: 0 });
    expect(plan.offset).toEqual({ x: -0, y: -500 });
    expect(plan.radians).toBeCloseTo(Math.PI / 2);
  });
});
