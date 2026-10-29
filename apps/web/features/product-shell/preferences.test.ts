// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  applyFeedLayoutPreferenceToRoot,
  applyThemePreferenceToRoot,
  defaultFeedLayoutFor,
  feedLayoutStorageKeyFor,
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
    ["sepia", "light"],
    [null, "light"],
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

  it("defaults every device presentation to calligraphy", () => {
    expect(defaultFeedLayoutFor("phone")).toBe("single");
    expect(defaultFeedLayoutFor("tablet")).toBe("single");
    expect(defaultFeedLayoutFor("pc")).toBe("single");
  });

  it("keeps desktop choices separate from phone/tablet choices", () => {
    const values = new Map([
      [FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "double"],
      [DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY).toBe(
      "yoyi.desktop-feed-layout.v1",
    );
    expect(feedLayoutStorageKeyFor("desktop")).toBe(
      DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
    );
    expect(feedLayoutStorageKeyFor("tablet")).toBe(
      FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
    );
    expect(readStoredFeedLayoutPreference(storage, "desktop")).toBe("single");
    expect(readStoredFeedLayoutPreference(storage, "phone")).toBe("double");
    expect(readStoredFeedLayoutPreference(storage, "tablet")).toBe("double");
    values.delete(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY);
    expect(readStoredFeedLayoutPreference(storage, "desktop")).toBeNull();
    expect(values.get(FEED_LAYOUT_PREFERENCE_STORAGE_KEY)).toBe("double");
    values.set(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "invalid");
    expect(readStoredFeedLayoutPreference(storage, "desktop")).toBeNull();
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

    expect(readStoredThemePreference(storage)).toBe("light");
    expect(readStoredFeedLayoutPreference(storage)).toBeNull();
    expect(readStoredFeedLayoutPreference(storage, "desktop")).toBeNull();
    expect(() =>
      persistPreference(storage, THEME_PREFERENCE_STORAGE_KEY, "dark"),
    ).not.toThrow();
    expect(() =>
      persistPreference(storage, FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single"),
    ).not.toThrow();
  });

  it.each(["dark", "system"])(
    "ignores legacy %s preferences without writing or clearing storage",
    (legacyTheme) => {
      const values = new Map([
        ["yoyi.theme-preference", legacyTheme],
        ["yoyi.home-feed-layout", "double"],
        ["yoyi.publishing.original-quality", "true"],
        ["artvenn.editor.interruption.test-account", "synthetic-draft"],
        ["yoyi-avatar-save-v1:test-account", "synthetic-avatar"],
      ]);
      const before = new Map(values);
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      };

      expect(readStoredThemePreference(storage)).toBe("light");
      expect(readStoredFeedLayoutPreference(storage)).toBeNull();
      expect(values).toEqual(before);
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );

  it.each(["dark", "system"])(
    "retains a later %s and normal-mode choice despite legacy writes",
    (theme) => {
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      };
      persistPreference(storage, THEME_PREFERENCE_STORAGE_KEY, theme);
      persistPreference(storage, FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "double");
      // An already open old version can write only its legacy namespace.
      storage.setItem("yoyi.theme-preference", "light");
      storage.setItem("yoyi.home-feed-layout", "single");
      expect(readStoredThemePreference(storage)).toBe(theme);
      expect(readStoredFeedLayoutPreference(storage)).toBe("double");
    },
  );

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
