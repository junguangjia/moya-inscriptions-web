import {
  MAX_OUTPUT_EDGE,
  PROFILE_FAMILIES,
  PROFILE_ROLES,
  RECIPE_DIGESTS_V1,
  RECIPE_PARAMETERS_V1,
  RENDITION_PLANS,
  RENDITION_ROLES,
  STILL_PIPELINE_V1,
  STILL_ROLES,
  currentRecipe,
  editRegion,
  expectedStillSize,
  isCurrentRecipe,
  isProfileRole,
  isRenditionPlan,
  isStillRole,
  planRoles,
  plannedStillSize,
  recipeDigest,
  recipeFraming,
  recipeQuality,
  stillOutputSize,
} from "@moya/backend-production/internal/publishing-processing";
import { describe, expect, it } from "vitest";

import type {
  RenditionPlan,
  StillRole,
} from "@moya/backend-production/internal/publishing-processing";

/*
 * The one rendition recipe registry (unified media pipeline, increment 1):
 * pinned digests (the identities the store records come only from here),
 * today's profiles byte-for-byte as version 1, the new bounded `viewer` (never
 * a second copy of `display`, nor of `full` where the plan renders `full`),
 * the profile image roles of increment 3a (never upscaled, never a second
 * copy of their family anchor), and the geometry both the coordinator and the
 * sandboxed renderer compute sizes with.
 */

/** The plans that render the work and Catalog still roles. */
const PLANS = (Object.keys(RENDITION_PLANS) as RenditionPlan[]).filter(
  (plan) => RENDITION_PLANS[plan].roles === "still",
);

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
      "avatar-128": "a127cd6992900e4a",
      "avatar-512": "15a60d75ab0b9da9",
      "background-960": "f6e1093c931edcef",
      "background-1600": "fdc0f14fbb0a2677",
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
    expect(new Set(Object.values(RECIPE_DIGESTS_V1)).size).toBe(10);
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

  it("names the work, Catalog and profile plans; only the work plan renders full", () => {
    expect(RENDITION_PLANS).toEqual({
      work: { full: true, roles: "still" },
      catalog: { full: false, roles: "still" },
      profile: { full: false, roles: "profile" },
    });
    expect(PLANS).toEqual(["work", "catalog"]);
    for (const plan of ["work", "catalog", "profile"])
      expect(isRenditionPlan(plan), plan).toBe(true);
    for (const value of ["full", "Work", "avatar", "toString", "", null, 1])
      expect(isRenditionPlan(value), String(value)).toBe(false);
    // Each plan asks for its own roles only, in the order a job renders them.
    expect(planRoles("work")).toEqual(STILL_ROLES);
    expect(planRoles("catalog")).toEqual(STILL_ROLES);
    expect(planRoles("profile")).toEqual([
      "avatar-128",
      "avatar-512",
      "background-960",
      "background-1600",
    ]);
  });

  it("adds the profile roles as version 1 WebP stills of the shared pipeline", () => {
    expect(PROFILE_ROLES).toEqual([
      "avatar-128",
      "avatar-512",
      "background-960",
      "background-1600",
    ]);
    expect(RENDITION_ROLES).toEqual([
      ...STILL_ROLES,
      "motion",
      ...PROFILE_ROLES,
    ]);
    expect(
      Object.fromEntries(
        PROFILE_ROLES.map((role) => [
          role,
          [
            recipeQuality(role),
            RECIPE_PARAMETERS_V1[role].maxLongEdge,
            recipeFraming(role),
          ],
        ]),
      ),
    ).toEqual({
      "avatar-128": [80, 128, "complete"],
      "avatar-512": [82, 512, "complete"],
      "background-960": [82, 960, "complete"],
      "background-1600": [84, 1600, "complete"],
    });
    for (const role of PROFILE_ROLES) {
      const recipe = RECIPE_PARAMETERS_V1[role];
      // Never upscaled, metadata stripped, alpha kept, every byte re-encoded.
      expect(recipe.pipeline).toBe(STILL_PIPELINE_V1);
      expect([recipe.maxPixels, recipe.longScroll]).toEqual([null, null]);
      expect(isProfileRole(role) && !isStillRole(role), role).toBe(true);
    }
    expect(STILL_PIPELINE_V1).toMatchObject({
      metadata: "strip-all",
      alpha: "preserve",
      upscale: false,
      passthrough: false,
    });
    expect(RECIPE_PARAMETERS_V1["avatar-512"].skip).toEqual({
      whenEqualTo: "avatar-128",
    });
    expect(RECIPE_PARAMETERS_V1["background-1600"].skip).toEqual({
      whenEqualTo: "background-960",
    });
    expect("skip" in RECIPE_PARAMETERS_V1["avatar-128"]).toBe(false);
    expect("skip" in RECIPE_PARAMETERS_V1["background-960"]).toBe(false);
    // Each family anchor is its smallest, always rendered role.
    expect(PROFILE_FAMILIES).toEqual({
      avatar: { anchor: "avatar-128", roles: ["avatar-128", "avatar-512"] },
      background: {
        anchor: "background-960",
        roles: ["background-960", "background-1600"],
      },
    });
    for (const value of ["thumb", "motion", "avatar", "avatar-256", null])
      expect(isProfileRole(value), String(value)).toBe(false);
  });

  it("sizes profile roles by their long edge and skips a family's second copy of its anchor", () => {
    const profile = (frame: { width: number; height: number }) =>
      Object.fromEntries(
        PROFILE_ROLES.map((role) => [
          role,
          plannedStillSize(role, frame, "profile"),
        ]),
      );
    expect(profile(size(512, 512))).toMatchObject({
      "avatar-128": size(128, 128),
      "avatar-512": size(512, 512),
    });
    // Never upscaled: a small avatar is rendered once, at its own size.
    expect(profile(size(100, 100))).toMatchObject({
      "avatar-128": size(100, 100),
      "avatar-512": null,
    });
    expect(profile(size(128, 128))).toMatchObject({
      "avatar-128": size(128, 128),
      "avatar-512": null,
    });
    expect(profile(size(300, 300))).toMatchObject({
      "avatar-128": size(128, 128),
      "avatar-512": size(300, 300),
    });
    expect(profile(size(2048, 2048))).toMatchObject({
      "avatar-128": size(128, 128),
      "avatar-512": size(512, 512),
    });
    expect(profile(size(1600, 1200))).toMatchObject({
      "background-960": size(960, 720),
      "background-1600": size(1600, 1200),
    });
    expect(profile(size(1024, 768))).toMatchObject({
      "background-960": size(960, 720),
      "background-1600": size(1024, 768),
    });
    expect(profile(size(3200, 2400))).toMatchObject({
      "background-960": size(960, 720),
      "background-1600": size(1600, 1200),
    });
    expect(profile(size(800, 600))).toMatchObject({
      "background-960": size(800, 600),
      "background-1600": null,
    });
    // No long-scroll rule: a tall image keeps the long-edge cap.
    expect(profile(size(600, 4000))).toMatchObject({
      "avatar-128": size(19, 128),
      "background-960": size(144, 960),
      "background-1600": size(240, 1600),
    });
    // The complete framing ignores a cover crop; edits still apply.
    expect(
      expectedStillSize(
        "background-1600",
        size(1200, 1600),
        { rotation: 90, crop: null },
        { x: 0, y: 0, width: 0.5, height: 1 },
        "profile",
      ),
    ).toEqual(size(1600, 1200));
    for (const role of PROFILE_ROLES)
      expect(plannedStillSize(role, size(1, 1), "profile")).toEqual(
        role === "avatar-128" || role === "background-960" ? size(1, 1) : null,
      );
  });

  it("bounds the viewer to 4096 and its long-scroll rule, never above full", () => {
    for (const plan of PLANS) {
      expect(plannedStillSize("viewer", size(9504, 6336), plan)).toEqual(
        size(4096, 2731),
      );
      expect(plannedStillSize("viewer", size(5000, 5000), plan)).toEqual(
        size(4096, 4096),
      );
      // A long scroll keeps its legible short edge up to 2048 and 20 MP, below
      // the long-scroll `full` (2000 × 16000 and 14606 × 2739 here).
      expect(plannedStillSize("viewer", size(2000, 16000), plan)).toEqual(
        size(1581, 12649),
      );
      expect(plannedStillSize("viewer", size(16000, 3000), plan)).toEqual(
        size(10328, 1936),
      );
    }
    expect(stillOutputSize("full", size(9504, 6336))).toEqual(size(8192, 5461));
    expect(stillOutputSize("full", size(2000, 16000))).toEqual(
      size(2000, 16000),
    );
    expect(stillOutputSize("full", size(16000, 3000))).toEqual(
      size(14606, 2739),
    );
  });

  it("never renders a work item's viewer at the size of its full", () => {
    // Camera photos up to 4096 px: the viewer would be the full image again.
    for (const [frame, display] of [
      [size(4032, 3024), size(2048, 1536)],
      [size(3000, 2000), size(2048, 1365)],
      [size(4096, 2731), size(2048, 1366)],
      [size(4096, 4096), size(2048, 2048)],
    ] as const) {
      expect(stillOutputSize("full", frame)).toEqual(frame);
      expect(stillOutputSize("viewer", frame)).toEqual(frame);
      expect(stillOutputSize("display", frame)).toEqual(display);
      expect(plannedStillSize("viewer", frame, "work")).toBeNull();
      // The Catalog plan has no full: its viewer is the largest image.
      expect(plannedStillSize("viewer", frame, "catalog")).toEqual(frame);
    }
    // A long scroll within the viewer's bounds equals its long-scroll full.
    expect(stillOutputSize("full", size(1600, 9416))).toEqual(size(1600, 9416));
    expect(stillOutputSize("display", size(1600, 9416))).toEqual(
      size(1280, 7533),
    );
    expect(plannedStillSize("viewer", size(1600, 9416), "work")).toBeNull();
    expect(plannedStillSize("viewer", size(1600, 9416), "catalog")).toEqual(
      size(1600, 9416),
    );
    // A viewer smaller than full on either side stays (even by one row).
    expect(plannedStillSize("viewer", size(4097, 3000), "work")).toEqual(
      size(4096, 2999),
    );
    expect(plannedStillSize("viewer", size(2100, 5400), "work")).toEqual(
      size(2048, 5266),
    );
    expect(stillOutputSize("full", size(2100, 5400))).toEqual(size(2100, 5400));
    expect(
      expectedStillSize(
        "viewer",
        size(3024, 4032),
        { rotation: 90, crop: null },
        null,
        "work",
      ),
    ).toBeNull();
    expect(
      expectedStillSize(
        "viewer",
        size(3024, 4032),
        { rotation: 90, crop: null },
        null,
        "catalog",
      ),
    ).toEqual(size(4032, 3024));
  });

  it("skips the viewer when it would equal display", () => {
    for (const plan of PLANS) {
      for (const frame of [size(1500, 1000), size(2048, 2048), size(1, 1)]) {
        expect(
          plannedStillSize("viewer", frame, plan),
          `${plan} ${JSON.stringify(frame)}`,
        ).toBe(null);
      }
      // The long scroll display already keeps the whole small strip.
      expect(plannedStillSize("viewer", size(1200, 9000), plan)).toBeNull();
      // Every other role is always planned.
      for (const role of ["thumb", "cover", "display", "full"] as const)
        expect(plannedStillSize(role, size(1500, 1000), plan)).not.toBeNull();
    }
  });

  it("never upscales, keeps every planned viewer above display, at most full and below a rendered full, and never repeats a profile anchor", () => {
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
      const same = (
        left: { width: number; height: number },
        right: { width: number; height: number },
      ) => left.width === right.width && left.height === right.height;
      for (const plan of PLANS) {
        const viewer = plannedStillSize("viewer", frame, plan);
        if (viewer !== null) {
          expect(viewer).toEqual(sizes.viewer);
          expect(viewer.width).toBeGreaterThanOrEqual(sizes.display.width);
          expect(viewer.height).toBeGreaterThanOrEqual(sizes.display.height);
          expect(viewer.width).toBeLessThanOrEqual(sizes.full.width);
          expect(viewer.height).toBeLessThanOrEqual(sizes.full.height);
          expect(same(viewer, sizes.display)).toBe(false);
          // Where full is rendered too, the viewer is a smaller image.
          if (RENDITION_PLANS[plan].full)
            expect(
              viewer.width < sizes.full.width ||
                viewer.height < sizes.full.height,
            ).toBe(true);
          // The pixel caps bound the scale; rounding each side may add at
          // most half a pixel row and column (as for display and full).
          expect(viewer.width * viewer.height).toBeLessThanOrEqual(
            20_000_000 + viewer.width + viewer.height,
          );
        } else {
          expect(
            same(sizes.viewer, sizes.display) ||
              (RENDITION_PLANS[plan].full && same(sizes.viewer, sizes.full)),
            `${plan} ${width}x${height}`,
          ).toBe(true);
        }
      }
      // A profile family never stores its anchor's size twice.
      for (const family of Object.values(PROFILE_FAMILIES)) {
        const anchor = plannedStillSize(family.anchor, frame, "profile")!;
        expect(anchor.width <= width && anchor.height <= height).toBe(true);
        for (const role of family.roles) {
          if (role === family.anchor) continue;
          const planned = plannedStillSize(role, frame, "profile");
          if (planned === null) {
            expect(same(stillOutputSize(role, frame), anchor)).toBe(true);
          } else {
            expect(same(planned, anchor)).toBe(false);
            expect(planned.width <= width && planned.height <= height).toBe(
              true,
            );
          }
        }
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
      expectedStillSize("cover", size(2000, 1000), edit, coverCrop, "work"),
    ).toEqual(size(500, 1000));
    expect(
      expectedStillSize("thumb", size(2000, 1000), edit, coverCrop, "work"),
    ).toEqual(size(240, 480));
    expect(
      expectedStillSize("display", size(2000, 1000), edit, coverCrop, "work"),
    ).toEqual(size(1000, 1000));
    for (const plan of PLANS)
      expect(
        expectedStillSize("viewer", size(2000, 1000), edit, coverCrop, plan),
      ).toBe(null);
    expect(() => stillOutputSize("thumb", size(0, 10))).toThrow(TypeError);
    expect(() => stillOutputSize("thumb", size(1.5, 10))).toThrow(TypeError);
  });
});
