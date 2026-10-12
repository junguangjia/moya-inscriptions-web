// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCT_BOOT_SCRIPT,
  PRODUCT_LOADING_FAILSAFE_MS,
  PRODUCT_LOADING_MINIMUM_MS,
} from "./product-boot";

describe("Product Shell pre-hydration boot", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    window.localStorage.setItem("yoyi.theme-preference", "dark");
    window.localStorage.setItem("yoyi.home-feed-layout", "single");

    window.eval(PRODUCT_BOOT_SCRIPT);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
    expect(document.documentElement.dataset.homeLayout).toBe("single");
    expect(document.documentElement.dataset.deviceClass).toBe("desktop");
    expect(document.documentElement.dataset.platform).toMatch(
      /^(phone|tablet|pc)$/,
    );
    expect(document.documentElement.dataset.yoyiBoot).toBe("pending");

    vi.advanceTimersByTime(PRODUCT_LOADING_FAILSAFE_MS);
    expect(document.documentElement.dataset.yoyiBoot).toBe("ready");
  });

  it("falls back safely for invalid stored values", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("yoyi.theme-preference", "sepia");
    window.localStorage.setItem("yoyi.home-feed-layout", "triple");

    window.eval(PRODUCT_BOOT_SCRIPT);

    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.dataset.homeLayout).toBe("double");
  });

  it.each([
    ["no choice on a phone", null, "phone", "single"],
    ["no choice on a desktop", null, "desktop", "double"],
    ["an explicit double on a phone", "double", "phone", "double"],
    ["an explicit single on a desktop", "single", "desktop", "single"],
  ] as const)(
    "lays out the home feed for %s",
    (_label, stored, device, expected) => {
      vi.useFakeTimers();
      if (stored !== null)
        window.localStorage.setItem("yoyi.home-feed-layout", stored);
      const userAgent = vi.spyOn(window.navigator, "userAgent", "get");
      if (device === "phone")
        userAgent.mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
        );

      window.eval(PRODUCT_BOOT_SCRIPT);

      expect(document.documentElement.dataset.platform).toBe(
        device === "phone" ? "phone" : "pc",
      );
      expect(document.documentElement.dataset.homeLayout).toBe(expected);
      userAgent.mockRestore();
    },
  );
});
