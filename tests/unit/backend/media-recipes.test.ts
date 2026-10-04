import {
  MAX_OUTPUT_EDGE,
  RECIPE_DIGESTS_V1,
  RECIPE_PARAMETERS_V1,
  RENDITION_ROLES,
  STILL_ROLES,
  currentRecipe,
  editRegion,
  expectedStillSize,
  isCurrentRecipe,
  plannedStillSize,
  recipeDigest,
  recipeFraming,
  stillOutputSize,
} from "@moya/backend-production/internal/publishing-processing";
import { describe, expect, it } from "vitest";

import type { StillRole } from "@moya/backend-production/internal/publishing-processing";

/*
 * The one rendition recipe registry (unified media pipeline, increment 1):
 * pinned digests (the identities the store records come only from here),
 * today's profiles byte-for-byte as version 1, the new bounded `viewer`, and
 * the geometry both the coordinator and the sandboxed renderer compute sizes
 * with.
 */

const size = (width: number, height: number) => ({ width, height });

describe("rendition recipe registry", () => {
  it("pins every digest; a parameter change needs a new version", () => {
    expect(RECIPE_DIGESTS_V1).toEqual({
      thumb: "02deba84f648b4c8",
      cover: "6eca59397e187bee",
      display: "fa0cc28bb9865f16",
      viewer: "041a35a85fbbded3",
      full: "acb3027f6e2affec",
      motion: "61403d6585d07f92",
    });
    for (const role of RENDITION_ROLES) {
      // Changing a parameter without a version bump fails this line.
      expect(recipeDigest(RECIPE_PARAMETERS_V1[role]), role).toBe(
        RECIPE_DIGESTS_V1[role],
      );
      expect(RECIPE_PARAMETERS_V1[role]).toMatchObject({ role, version: 1 });
      expect(currentRecipe(role)).toEqual({
        role,
        version: 1,
        digest: RECIPE_DIGESTS_V1[role],
      });
    }
    expect(new Set(Object.values(RECIPE_DIGESTS_V1)).size).toBe(6);
    expect(
      recipeDigest({ ...RECIPE_PARAMETERS_V1.viewer, quality: 86 }),
    ).not.toBe(RECIPE_DIGESTS_V1.viewer);
    expect(isCurrentRecipe(currentRecipe("viewer"))).toBe(true);
    expect(
      isCurrentRecipe({ ...currentRecipe("viewer"), digest: "0".repeat(16) }),
    ).toBe(false);
    expect(isCurrentRecipe({ ...currentRecipe("full"), version: 2 })).toBe(
      false,
    );
    expect(
      isCurrentRecipe({ role: "tiles", version: 1, digest: "0".repeat(16) }),
    ).toBe(false);
  });

  it("keeps today's profiles as version 1 and adds the bounded viewer", () => {
    expect(
      Object.fromEntries(
        STILL_ROLES.map((role) => [
          role,
          [
            RECIPE_PARAMETERS_V1[role].quality,
            RECIPE_PARAMETERS_V1[role].maxLongEdge,
            recipeFraming(role),
          ],
        ]),
      ),
    ).toEqual({
      thumb: [80, 480, "card"],
      cover: [86, 1080, "card"],
      display: [86, 2048, "complete"],
      viewer: [88, 4096, "complete"],
      full: [90, 8192, "complete"],
    });
    expect(RECIPE_PARAMETERS_V1.viewer.maxPixels).toBe(4096 * 4096);
    expect(RECIPE_PARAMETERS_V1.viewer.longScroll).toEqual({
      aspectRatio: 2.5,
      maxShortEdge: 2048,
      maxLongEdge: 16_000,
      maxPixels: 20_000_000,
    });
    // Every byte is re-encoded; nothing passes the source through.
    expect(RECIPE_PARAMETERS_V1.display.pipeline.passthrough).toBe(false);
    expect(RECIPE_PARAMETERS_V1.display.pipeline.upscale).toBe(false);
  });

  it("sizes today's roles exactly like the pre-task processor (legacy cases)", () => {
    expect(stillOutputSize("thumb", size(4032, 3024))).toEqual(size(480, 360));
    expect(stillOutputSize("display", size(800, 600))).toEqual(size(800, 600));
    expect(stillOutputSize("full", size(12000, 9000))).toEqual(
      size(8192, 6144),
    );
    expect(stillOutputSize("full", size(1200, 16000))).toEqual(
      size(1200, 16000),
    );
    expect(stillOutputSize("full", size(4000, 20000))).toEqual(
      size(2828, 14142),
    );
    expect(stillOutputSize("cover", size(1200, 16000))).toEqual(size(81, 1080));
    expect(stillOutputSize("full", size(6000, 16000))).toEqual(
      size(3873, 10328),
    );
    expect(stillOutputSize("display", size(1200, 16000))).toEqual(
      size(1200, 16000),
    );
    expect(stillOutputSize("display", size(2000, 16000))).toEqual(
      size(1280, 10240),
    );
    expect(stillOutputSize("display", size(16000, 2000))).toEqual(
      size(10240, 1280),
    );
    // Aspect 2.33 is not a long scroll: the ordinary 2048 long edge applies.
    expect(stillOutputSize("display", size(3000, 7000))).toEqual(
      size(878, 2048),
    );
  });

  it("bounds the viewer to 4096 and its long-scroll rule, never above full", () => {
    expect(plannedStillSize("viewer", size(9504, 6336))).toEqual(
      size(4096, 2731),
    );
    expect(plannedStillSize("viewer", size(5000, 5000))).toEqual(
      size(4096, 4096),
    );
    // A long scroll keeps its legible short edge up to 2048 and 20 MP.
    expect(plannedStillSize("viewer", size(1600, 9416))).toEqual(
      size(1600, 9416),
    );
    expect(stillOutputSize("display", size(1600, 9416))).toEqual(
      size(1280, 7533),
    );
    expect(plannedStillSize("viewer", size(2000, 16000))).toEqual(
      size(1581, 12649),
    );
    expect(plannedStillSize("viewer", size(16000, 3000))).toEqual(
      size(10328, 1936),
    );
    expect(plannedStillSize("viewer", size(3000, 2000))).toEqual(
      size(3000, 2000),
    );
  });

  it("skips the viewer when it would equal display", () => {
    for (const frame of [size(1500, 1000), size(2048, 2048), size(1, 1)]) {
      expect(plannedStillSize("viewer", frame), JSON.stringify(frame)).toBe(
        null,
      );
    }
    // The long scroll display already keeps the whole small strip.
    expect(plannedStillSize("viewer", size(1200, 9000))).toBeNull();
    // Every other role is always planned.
    for (const role of ["thumb", "cover", "display", "full"] as const)
      expect(plannedStillSize(role, size(1500, 1000))).not.toBeNull();
  });

  it("never upscales and keeps display ≤ viewer ≤ full for any frame", () => {
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let index = 0; index < 4000; index += 1) {
      const pixels = Math.exp(Math.log(1) + next() * Math.log(120_000_000));
      const aspect = Math.exp((next() * 2 - 1) * Math.log(40));
      const width = Math.max(1, Math.round(Math.sqrt(pixels * aspect)));
      const height = Math.max(1, Math.round(width / aspect));
      if (width * height > 120_000_000) continue;
      const frame = size(width, height);
      const sizes = Object.fromEntries(
        STILL_ROLES.map((role) => [role, stillOutputSize(role, frame)]),
      ) as Record<StillRole, { width: number; height: number }>;
      for (const role of STILL_ROLES) {
        const out = sizes[role];
        expect(out.width <= width && out.height <= height, role).toBe(true);
        expect(
          out.width <= MAX_OUTPUT_EDGE && out.height <= MAX_OUTPUT_EDGE,
        ).toBe(true);
        expect(out.width >= 1 && out.height >= 1).toBe(true);
      }
      const viewer = plannedStillSize("viewer", frame);
      if (viewer !== null) {
        expect(viewer.width).toBeGreaterThanOrEqual(sizes.display.width);
        expect(viewer.height).toBeGreaterThanOrEqual(sizes.display.height);
        expect(viewer.width).toBeLessThanOrEqual(sizes.full.width);
        expect(viewer.height).toBeLessThanOrEqual(sizes.full.height);
        // The pixel caps bound the scale; rounding each side may add at most
        // half a pixel row and column (as for display and full).
        expect(viewer.width * viewer.height).toBeLessThanOrEqual(
          20_000_000 + viewer.width + viewer.height,
        );
      } else {
        expect(sizes.viewer).toEqual(sizes.display);
      }
    }
  });

  it("frames card roles with the cover crop and complete roles without it", () => {
    const edit = {
      rotation: 90 as const,
      crop: { x: 0, y: 0.5, width: 1, height: 0.5 },
    };
    const coverCrop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    expect(editRegion(size(2000, 1000), edit, coverCrop)).toEqual({
      frame: size(1000, 2000),
      region: { left: 500, top: 1000, width: 500, height: 1000 },
    });
    expect(
      expectedStillSize("cover", size(2000, 1000), edit, coverCrop),
    ).toEqual(size(500, 1000));
    expect(
      expectedStillSize("thumb", size(2000, 1000), edit, coverCrop),
    ).toEqual(size(240, 480));
    expect(
      expectedStillSize("display", size(2000, 1000), edit, coverCrop),
    ).toEqual(size(1000, 1000));
    expect(expectedStillSize("viewer", size(2000, 1000), edit, coverCrop)).toBe(
      null,
    );
    expect(() => stillOutputSize("thumb", size(0, 10))).toThrow(TypeError);
    expect(() => stillOutputSize("thumb", size(1.5, 10))).toThrow(TypeError);
  });
});
