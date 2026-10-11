import { describe, expect, it } from "vitest";

import {
  COVER_PRESETS,
  EDIT_PRESETS,
  centeredCrop,
  cropFromPercentages,
  drawPlan,
  editedSize,
  feedStageWindow,
  matchPreset,
  normalizeCrop,
  previewPlacement,
  rotatedSize,
  turn,
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

  it("describes the feed stage window from the shape alone", () => {
    // 3:4 frame: the stage is 4:5, so 6.25% is cut, half above and half below.
    expect(feedStageWindow(3 / 4)).toEqual({
      fit: "cover",
      height: 0.9375,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(1)).toEqual({
      fit: "fill",
      height: 1,
      stageRatio: 1,
    });
    expect(feedStageWindow(4 / 5)).toEqual({
      fit: "fill",
      height: 1,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(4 / 3)).toEqual({
      fit: "contain",
      height: 1,
      stageRatio: 1,
    });
    expect(feedStageWindow(9 / 16).fit).toBe("cover");
    expect(feedStageWindow(9 / 16).height).toBeCloseTo(0.703125, 5);
    // A later item follows the first item's stage.
    expect(feedStageWindow(16 / 9, 1.25)).toEqual({
      fit: "contain",
      height: 1,
      stageRatio: 1.25,
    });
    expect(feedStageWindow(1, 1.25).fit).toBe("contain");
    expect(feedStageWindow(3 / 4, 1).fit).toBe("cover");
    expect(feedStageWindow(3 / 4, 1).height).toBe(0.75);
    expect(feedStageWindow(Number.NaN)).toEqual({
      fit: "fill",
      height: 1,
      stageRatio: 1,
    });
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
