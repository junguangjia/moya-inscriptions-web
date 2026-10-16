import { describe, expect, it } from "vitest";

import {
  DESKTOP_MINIMUM_WIDTH,
  editorLayout,
} from "../publishing/ui/editor/editor-layout";
import {
  WIDE_LAYOUT_MINIMUM_WIDTH,
  detectDeviceClass,
  isWideLayout,
  readRuntimeDeviceClass,
  resolvePresentationOrientation,
  resolvePresentationPlatform,
  resolveRuntimePresentationPlatform,
} from "./device-platform";

import type { DeviceClass, PresentationPlatform } from "./device-platform";

describe("current T02 device classification compatibility", () => {
  it.each([
    [
      "iPhone-like phone",
      { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
      "phone",
    ],
    [
      "Android Mobile phone",
      { userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36" },
      "phone",
    ],
    [
      "Android non-Mobile tablet",
      { userAgent: "Mozilla/5.0 (Linux; Android 15) Safari/537.36" },
      "tablet",
    ],
    [
      "iPad tablet",
      { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" },
      "tablet",
    ],
    [
      "iPadOS Macintosh multi-touch tablet",
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
        maxTouchPoints: 5,
      },
      "tablet",
    ],
    [
      "ordinary desktop",
      {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
        maxTouchPoints: 0,
      },
      "desktop",
    ],
    ["desktop fallback", {}, "desktop"],
    [
      "User-Agent Client Hint phone",
      { userAgent: "Mozilla/5.0", userAgentData: { mobile: true } },
      "phone",
    ],
  ] as const)("classifies a %s", (_, input, expected) => {
    expect(detectDeviceClass(input)).toBe(expected);
  });

  it("keeps tablet detection ahead of a mobile client hint", () => {
    expect(
      detectDeviceClass({
        userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
        userAgentData: { mobile: true },
      }),
    ).toBe("tablet");
  });
});

describe("Product Shell runtime platform helpers", () => {
  it("keeps real phones on phone and touch-Mac iPads below PC", () => {
    expect(
      resolveRuntimePresentationPlatform(
        { userAgent: "Mozilla/5.0 (iPhone) Mobile" },
        1_200,
      ),
    ).toBe("phone");
    expect(
      resolveRuntimePresentationPlatform(
        {
          maxTouchPoints: 5,
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
        },
        1_366,
      ),
    ).toBe("tablet");
  });

  it("preserves Client Hint data while reading the runtime device class", () => {
    expect(
      readRuntimeDeviceClass({
        userAgent: "Mozilla/5.0",
        userAgentData: { mobile: true },
      }),
    ).toBe("phone");
  });

  it.each([
    [390, 844, "portrait"],
    [1_024, 768, "landscape"],
    [800, 800, "portrait"],
  ] as const)("resolves %sx%s as %s", (width, height, expectedOrientation) => {
    expect(resolvePresentationOrientation(width, height)).toBe(
      expectedOrientation,
    );
  });
});

describe("current T02 presentation platform compatibility", () => {
  it.each([320, 768, 896, 1440])(
    "keeps a phone-class device on phone at width %s",
    (width) => {
      expect(resolvePresentationPlatform("phone", width)).toBe("phone");
    },
  );

  it.each([
    [767, "phone"],
    [768, "tablet"],
    [1440, "tablet"],
  ] as const)("resolves a tablet at width %s to %s", (width, expected) => {
    expect(resolvePresentationPlatform("tablet", width)).toBe(expected);
  });

  it.each([
    [767, "phone"],
    [768, "tablet"],
    [895, "tablet"],
    [896, "pc"],
    [1440, "pc"],
  ] as const)("resolves a desktop at width %s to %s", (width, expected) => {
    expect(resolvePresentationPlatform("desktop", width)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "uses the current wide fallback for non-finite width %s",
    (width) => {
      expect(resolvePresentationPlatform("phone", width)).toBe("phone");
      expect(resolvePresentationPlatform("tablet", width)).toBe("tablet");
      expect(resolvePresentationPlatform("desktop", width)).toBe("pc");
    },
  );
});

describe("wide layout (pc-browse-only-v1)", () => {
  it("starts at the PC width", () => {
    expect(WIDE_LAYOUT_MINIMUM_WIDTH).toBe(896);
    expect(DESKTOP_MINIMUM_WIDTH).toBe(WIDE_LAYOUT_MINIMUM_WIDTH);
  });

  it.each([320, 767, 768, 895, 896, 1_280, 2_560])(
    "keeps a PC wide at width %s",
    (width) => {
      expect(isWideLayout("pc", width)).toBe(true);
    },
  );

  it.each([
    [767, false],
    [768, false],
    [834, false],
    [895, false],
    [896, true],
    [1_024, true],
    [1_194, true],
    [1_366, true],
  ] as const)("resolves a tablet at width %s as wide %s", (width, wide) => {
    expect(isWideLayout("tablet", width)).toBe(wide);
  });

  it.each([390, 768, 896, 1_400])(
    "never makes a phone wide at width %s",
    (width) => {
      expect(isWideLayout("phone", width)).toBe(false);
    },
  );

  it.each([
    ["a desktop window", "desktop", 767, false],
    ["a desktop window", "desktop", 800, false],
    ["a desktop window", "desktop", 895, false],
    ["a desktop window", "desktop", 896, true],
    ["a desktop window", "desktop", 1_280, true],
    ["an iPad in portrait", "tablet", 834, false],
    ["an iPad Pro in portrait", "tablet", 1_024, true],
    ["an iPad in landscape", "tablet", 1_194, true],
    ["a phone in landscape", "phone", 1_400, false],
  ] as const)(
    "applies to %s (%s) at width %s: %s",
    (_label, deviceClass: DeviceClass, width, wide) => {
      expect(
        isWideLayout(resolvePresentationPlatform(deviceClass, width), width),
      ).toBe(wide);
    },
  );

  it("is the same decision as the desktop editor layout", () => {
    const platforms: readonly PresentationPlatform[] = [
      "phone",
      "tablet",
      "pc",
    ];
    for (const platform of platforms)
      for (const width of [
        0, 320, 390, 767, 768, 834, 895, 896, 897, 1_024, 1_194, 1_400, 2_560,
      ])
        expect(editorLayout(platform, width) === "desktop").toBe(
          isWideLayout(platform, width),
        );
  });
});
