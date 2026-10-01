import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  blur,
  darkTheme,
  lightTheme,
  material,
  motion,
  opacity,
  semanticColorNames,
  surface,
  typography,
  typographyNames,
  zIndex,
} from "@moya/design-tokens";

const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((index) =>
    Number.parseInt(hex.slice(index, index + 2), 16),
  );
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (linear[0] ?? 0) +
    0.7152 * (linear[1] ?? 0) +
    0.0722 * (linear[2] ?? 0)
  );
};

const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const compositeRgba = (value: string, background: string) => {
  const match = value.match(
    /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/,
  );
  if (!match) throw new Error(`Invalid rgba value: ${value}`);
  const alpha = Number(match[4]);
  const backgroundChannels = [1, 3, 5].map((index) =>
    Number.parseInt(background.slice(index, index + 2), 16),
  );
  const channels = [match[1], match[2], match[3]].map((channel, index) =>
    Math.round(
      Number(channel) * alpha + (backgroundChannels[index] ?? 0) * (1 - alpha),
    ),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
};

describe("design tokens", () => {
  it("exports complete and symmetric light/dark themes", () => {
    expect(Object.keys(lightTheme).sort()).toEqual(
      [...semanticColorNames].sort(),
    );
    expect(Object.keys(darkTheme).sort()).toEqual(
      [...semanticColorNames].sort(),
    );
    expect(Object.keys(typography).sort()).toEqual([...typographyNames].sort());
    expect(motion.duration.loadingLogo).toBe("720ms");
    expect(surface).toEqual({
      content: "var(--yoyi-surface-content)",
      elevated: "var(--yoyi-surface-elevated)",
      paper: "var(--yoyi-surface-paper)",
    });
    expect(material.glass.regular).toBe("glass-regular");
    expect(blur.glassRegular).toBe("20px");
    expect(opacity.glassRegular).toBe(0.82);
    expect(zIndex).toEqual({
      content: 0,
      navigation: 30,
      overlay: 100,
      sticky: 20,
    });
  });

  it("keeps essential text and accent contrast at 4.5:1 or better", () => {
    for (const [theme, name] of [
      [lightTheme, "light"],
      [darkTheme, "dark"],
    ] as const) {
      for (const token of [
        "text-primary",
        "text-secondary",
        "text-tertiary",
        "seal-red",
      ] as const) {
        expect(
          contrast(theme[token], theme["background-page"]),
          `${name} ${token}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps control accents separate from achromatic branding", async () => {
    for (const theme of [lightTheme, darkTheme]) {
      expect(theme["brand-wordmark-ink"]).toBe("#000000");
      expect(theme["brand-recess-floor"]).toMatch(/^rgba\(0, 0, 0,/);
      expect(theme["brand-recess-highlight"]).toMatch(/^rgba\(255, 255, 255,/);
    }
    expect(
      contrast(
        darkTheme["brand-wordmark-ink"],
        darkTheme["brand-wordmark-surface"],
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(lightTheme["system-orange"]).toBe(lightTheme["seal-red"]);
    expect(darkTheme["system-orange"]).toBe(darkTheme["seal-red"]);
    const css = await readFile(
      new URL("../../../packages/design-tokens/src/theme.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain(
      "--yoyi-color-system-orange: var(--yoyi-color-seal-red)",
    );
  });

  it("contains explicit and system theme selectors", async () => {
    const css = await readFile(
      new URL("../../../packages/design-tokens/src/theme.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain("--yoyi-material-glass-regular-background:");
    expect(css).toContain("--yoyi-material-glass-fallback-background:");
    expect(css).toContain("--yoyi-blur-glass-regular: 20px");
    expect(css).toContain("--yoyi-z-index-navigation: 30");
  });

  it("keeps navigation text legible on Glass, fallback, and active tint", async () => {
    const css = await readFile(
      new URL("../../../packages/design-tokens/src/theme.css", import.meta.url),
      "utf8",
    );
    const regularBackgrounds = [
      ...css.matchAll(
        /--yoyi-material-glass-regular-background:\s*(rgba\([^)]+\))/g,
      ),
    ].map(([, value]) => value ?? "");
    const fallbackBackgrounds = [
      ...css.matchAll(
        /--yoyi-material-glass-fallback-background:\s*(rgba\([^)]+\))/g,
      ),
    ].map(([, value]) => value ?? "");

    for (const [theme, index] of [
      [lightTheme, 0],
      [darkTheme, 1],
    ] as const) {
      const regular = compositeRgba(
        regularBackgrounds[index] ?? "",
        theme["background-page"],
      );
      const fallback = compositeRgba(
        fallbackBackgrounds[index] ?? "",
        theme["background-page"],
      );
      expect(contrast(theme["text-primary"], regular)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(theme["text-primary"], fallback)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrast(theme["text-primary"], theme["seal-red-muted"]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
