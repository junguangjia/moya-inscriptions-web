// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCT_BOOT_SCRIPT,
  PRODUCT_LOADING_FAILSAFE_MS,
  PRODUCT_LOADING_MINIMUM_MS,
} from "./product-boot";
import {
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
} from "./preferences";

const initialWidth = window.innerWidth;

describe("Product Shell pre-hydration boot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: initialWidth,
    });
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preference");
    document.documentElement.removeAttribute("data-home-layout");
    document.documentElement.removeAttribute("data-device-class");
    document.documentElement.removeAttribute("data-platform");
    document.documentElement.removeAttribute("data-orientation");
    document.documentElement.removeAttribute("data-yoyi-boot");
  });

  it("uses the approved 720ms presentation and a longer escape hatch", () => {
    expect(PRODUCT_LOADING_MINIMUM_MS).toBe(720);
    expect(PRODUCT_LOADING_FAILSAFE_MS).toBeGreaterThan(
      PRODUCT_LOADING_MINIMUM_MS,
    );
  });

  it("applies canonical preferences and platform attributes before hydration", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, "dark");
    window.localStorage.setItem(
      DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
      "double",
    );

    window.eval(PRODUCT_BOOT_SCRIPT);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("double");
    expect(document.documentElement.dataset.deviceClass).toBe("desktop");
    expect(document.documentElement.dataset.platform).toMatch(
      /^(phone|tablet|pc)$/,
    );
    expect(document.documentElement.dataset.yoyiBoot).toBe("pending");

    vi.advanceTimersByTime(PRODUCT_LOADING_FAILSAFE_MS);
    expect(document.documentElement.dataset.yoyiBoot).toBe("ready");
  });

  it.each([null, "light", "dark", "system"] as const)(
    "defaults to light while retaining the explicit theme %s",
    (stored) => {
      vi.useFakeTimers();
      document.documentElement.dataset.theme = "light";
      if (stored !== null)
        window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, stored);

      window.eval(PRODUCT_BOOT_SCRIPT);

      const preference = stored ?? "light";
      expect(document.documentElement.dataset.themePreference).toBe(preference);
      expect(document.documentElement.dataset.theme).toBe(
        preference === "system" ? undefined : preference,
      );
    },
  );

  it.each([
    ["dark", "iPhone Mobile"],
    ["system", "iPad"],
  ])(
    "resets legacy %s before paint and preserves storage",
    (theme, userAgent) => {
      vi.useFakeTimers();
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
      window.localStorage.setItem("yoyi.theme-preference", theme);
      window.localStorage.setItem("yoyi.home-feed-layout", "double");
      window.localStorage.setItem("yoyi.publishing.original-quality", "true");
      window.sessionStorage.setItem("yoyi.publishing.edit-hint-shown", "true");
      const before = { ...window.localStorage };

      window.eval(PRODUCT_BOOT_SCRIPT);

      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.homeLayout).toBe("single");
      expect({ ...window.localStorage }).toEqual(before);
      expect(
        window.sessionStorage.getItem("yoyi.publishing.edit-hint-shown"),
      ).toBe("true");
      window.sessionStorage.removeItem("yoyi.publishing.edit-hint-shown");
    },
  );

  it.each(["dark", "system"])(
    "preserves later %s choices across boot reloads",
    (theme) => {
      vi.useFakeTimers();
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("iPad");
      window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, theme);
      window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "double");
      for (let reload = 0; reload < 2; reload += 1) {
        window.localStorage.setItem("yoyi.theme-preference", "light");
        window.localStorage.setItem("yoyi.home-feed-layout", "single");
        window.eval(PRODUCT_BOOT_SCRIPT);
        expect(document.documentElement.dataset.themePreference).toBe(theme);
        expect(document.documentElement.dataset.theme).toBe(
          theme === "system" ? undefined : theme,
        );
        expect(document.documentElement.dataset.homeLayout).toBe("double");
      }
    },
  );

  it.each(["iPhone Mobile", "iPad"])(
    "uses calligraphy when storage is blocked on %s",
    (userAgent) => {
      vi.useFakeTimers();
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(() => window.eval(PRODUCT_BOOT_SCRIPT)).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.homeLayout).toBe("single");
    },
  );

  it("uses light when access to localStorage itself is blocked", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => window.eval(PRODUCT_BOOT_SCRIPT)).not.toThrow();
    expect(document.documentElement.dataset.themePreference).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
  });

  it("retains an explicit theme when the layout read fails", () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      if (key === THEME_PREFERENCE_STORAGE_KEY) return "dark";
      throw new Error("blocked");
    });

    window.eval(PRODUCT_BOOT_SCRIPT);

    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
  });

  it("falls back safely for invalid stored values", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, "sepia");
    window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "triple");

    window.eval(PRODUCT_BOOT_SCRIPT);

    expect(document.documentElement.dataset.themePreference).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
  });

  it.each([
    ["no choice on a phone", null, "phone", "single"],
    ["no choice on a desktop", null, "desktop", "single"],
    ["no choice on a tablet", null, "tablet", "single"],
    ["an explicit double on a tablet", "double", "tablet", "double"],
    ["an explicit double on a phone", "double", "phone", "double"],
    ["an explicit single on a desktop", "single", "desktop", "single"],
  ] as const)(
    "lays out the home feed for %s",
    (_label, stored, device, expected) => {
      vi.useFakeTimers();
      if (stored !== null)
        window.localStorage.setItem(
          device === "desktop"
            ? DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY
            : FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
          stored,
        );
      const userAgent = vi.spyOn(window.navigator, "userAgent", "get");
      if (device === "phone")
        userAgent.mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
        );

      if (device === "tablet")
        userAgent.mockReturnValue(
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
        );

      window.eval(PRODUCT_BOOT_SCRIPT);

      expect(document.documentElement.dataset.platform).toBe(
        device === "desktop" ? "pc" : device,
      );
      expect(document.documentElement.dataset.homeLayout).toBe(expected);
      userAgent.mockRestore();
    },
  );

  it.each([390, 800, 895, 896, 2560])(
    "uses the desktop key before paint at width %s, independently of compact layout",
    (width) => {
      vi.useFakeTimers();
      vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
        "Desktop Browser",
      );
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "single");
      window.localStorage.setItem(
        DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
        "double",
      );
      const before = { ...window.localStorage };
      window.eval(PRODUCT_BOOT_SCRIPT);
      expect(document.documentElement.dataset.deviceClass).toBe("desktop");
      expect(document.documentElement.dataset.homeLayout).toBe("double");
      expect({ ...window.localStorage }).toEqual(before);
    },
  );

  it("does not import an existing phone preference into the desktop default", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY, "double");
    window.eval(PRODUCT_BOOT_SCRIPT);
    expect(document.documentElement.dataset.homeLayout).toBe("single");
    expect(
      window.localStorage.getItem(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
    ).toBeNull();
    expect(
      window.localStorage.getItem(FEED_LAYOUT_PREFERENCE_STORAGE_KEY),
    ).toBe("double");
  });
});
