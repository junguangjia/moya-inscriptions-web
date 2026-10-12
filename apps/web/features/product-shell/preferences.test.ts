// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  applyFeedLayoutPreferenceToRoot,
  applyThemePreferenceToRoot,
  defaultFeedLayoutFor,
  nextFeedLayoutPreference,
  nextThemePreference,
  parseFeedLayoutPreference,
  parseThemePreference,
  persistPreference,
  readStoredFeedLayoutPreference,
  readStoredThemePreference,
} from "./preferences";

describe("Product Shell preferences", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    ["sepia", "system"],
    [null, "system"],
  ] as const)("parses theme preference %s", (value, expected) => {
    expect(parseThemePreference(value)).toBe(expected);
  });

  it.each([
    ["single", "single"],
    ["double", "double"],
    ["wide", null],
    [null, null],
  ] as const)("parses feed layout preference %s", (value, expected) => {
    expect(parseFeedLayoutPreference(value)).toBe(expected);
  });

  it("defaults phone to single column and tablet and PC to double", () => {
    expect(defaultFeedLayoutFor("phone")).toBe("single");
    expect(defaultFeedLayoutFor("tablet")).toBe("double");
    expect(defaultFeedLayoutFor("pc")).toBe("double");
  });

  it("uses canonical storage keys and fails closed when storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(readStoredThemePreference(storage)).toBe("system");
    expect(readStoredFeedLayoutPreference(storage)).toBeNull();
    expect(() =>
      persistPreference(storage, THEME_PREFERENCE_STORAGE_KEY, "dark"),
    ).not.toThrow();
    expect(() =>
      persistPreference(storage, FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single"),
    ).not.toThrow();
  });

  it("cycles only the approved bounded values", () => {
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
    expect(nextThemePreference("system")).toBe("light");
    expect(nextFeedLayoutPreference("single")).toBe("double");
    expect(nextFeedLayoutPreference("double")).toBe("single");
  });

  it("applies theme and layout attributes without creating another theme system", () => {
    const root = document.createElement("html");

    applyThemePreferenceToRoot(root, "dark");
    applyFeedLayoutPreferenceToRoot(root, "single");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themePreference).toBe("dark");
    expect(root.dataset.homeLayout).toBe("single");

    applyThemePreferenceToRoot(root, "system");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.dataset.themePreference).toBe("system");
  });
});
