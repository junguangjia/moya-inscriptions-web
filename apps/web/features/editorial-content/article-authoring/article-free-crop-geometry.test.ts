import { describe, expect, it } from "vitest";
import {
  cropCornerPoint,
  moveArticleCrop,
  normalizedCropPoint,
  normalizedPointerRect,
  resizeArticleCrop,
} from "./article-free-crop-geometry";

describe("Article free crop geometry", () => {
  it("normalizes pointer coordinates against the original image and clamps outside it", () => {
    const bounds = { left: 100, top: 50, width: 800, height: 600 };
    expect(normalizedCropPoint(500, 350, bounds)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedCropPoint(-10, 1000, bounds)).toEqual({ x: 0, y: 1 });
    expect(normalizedCropPoint(0, 0, { ...bounds, width: 0 })).toBeNull();
    expect(normalizedCropPoint(Number.NaN, 0, bounds)).toBeNull();
  });

  it("draws in either direction without a fixed aspect ratio", () => {
    const forward = normalizedPointerRect(
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.8 },
    );
    expect(forward).toEqual({ x: 0.1, y: 0.2, width: 0.8, height: 0.6 });
    expect(
      normalizedPointerRect({ x: 0.9, y: 0.8 }, { x: 0.1, y: 0.2 }),
    ).toEqual(forward);
    expect(normalizedPointerRect({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("moves the whole crop without changing its size or crossing the original", () => {
    expect(
      moveArticleCrop(
        { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
        { x: 2, y: -2 },
      ),
    ).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  it("moves each corner freely while anchoring its opposite corner", () => {
    const crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
    expect(resizeArticleCrop(crop, "nw", { x: 0.1, y: 0.3 })).toEqual({
      x: 0.1,
      y: 0.3,
      width: 0.7,
      height: 0.5,
    });
    expect(resizeArticleCrop(crop, "se", { x: 1, y: 0.5 })).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.8,
      height: 0.3,
    });
    expect(resizeArticleCrop(crop, "ne", { x: 0.1, y: 1 })).toEqual({
      x: 0.2,
      y: 0.79,
      width: 0.01,
      height: 0.01,
    });
    expect(cropCornerPoint(crop, "sw")).toEqual({ x: 0.2, y: 0.8 });
  });
});
