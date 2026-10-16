// @vitest-environment jsdom
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRODUCT_BOOT_SCRIPT } from "../product-shell/product-boot";
import {
  WIDE_SCREEN_AUTH_REDIRECT_SCRIPT,
  WideScreenAuthRedirect,
} from "./wide-screen-auth-redirect";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const desktop =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const iPad = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)";
const iPhone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148";

interface Device {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly width: number;
}

// Wide = pc, or a tablet at least 896 px wide; the iPadOS desktop UA counts
// as a tablet through its touch points.
const cases: readonly (readonly [string, Device, boolean])[] = [
  ["a desktop at 1280", { userAgent: desktop, width: 1280 }, true],
  ["a desktop at 896", { userAgent: desktop, width: 896 }, true],
  ["a desktop at 895", { userAgent: desktop, width: 895 }, false],
  ["a desktop at 390", { userAgent: desktop, width: 390 }, false],
  ["an iPad at 1024", { userAgent: iPad, width: 1024 }, true],
  ["an iPad at 1194", { userAgent: iPad, width: 1194 }, true],
  ["an iPad at 834", { userAgent: iPad, width: 834 }, false],
  [
    "an iPadOS desktop UA at 1024",
    { userAgent: desktop, maxTouchPoints: 5, width: 1024 },
    true,
  ],
  [
    "an iPadOS desktop UA at 820",
    { userAgent: desktop, maxTouchPoints: 5, width: 820 },
    false,
  ],
  ["an iPhone at 430", { userAgent: iPhone, width: 430 }, false],
  ["an iPhone at 932", { userAgent: iPhone, width: 932 }, false],
];

const useDevice = ({ userAgent, maxTouchPoints = 0, width }: Device) => {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
};

const root = document.documentElement;
const replace = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  replace.mockReset();
  // jsdom cannot leave the document, so the replacement is observed instead.
  vi.stubGlobal("location", { replace });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "maxTouchPoints");
  for (const name of [
    "data-auth-redirect",
    "data-device-class",
    "data-home-layout",
    "data-orientation",
    "data-platform",
    "data-theme",
    "data-theme-preference",
    "data-yoyi-boot",
    "data-yoyi-boot-started",
  ])
    root.removeAttribute(name);
});

describe("wide-screen auth redirect script", () => {
  it("takes its threshold from the shared wide layout rule", () => {
    expect(WIDE_SCREEN_AUTH_REDIRECT_SCRIPT).toContain(
      'platform === "tablet" && window.innerWidth >= 896',
    );
  });

  it.each(cases)(
    "after the head boot script, decides for %s",
    (_label, device, wide) => {
      useDevice(device);
      // The root layout's head script sets data-platform before the body runs.
      window.eval(PRODUCT_BOOT_SCRIPT);
      window.eval(WIDE_SCREEN_AUTH_REDIRECT_SCRIPT);

      if (wide) {
        expect(replace).toHaveBeenCalledOnce();
        expect(replace).toHaveBeenCalledWith("/");
        expect(root.dataset.authRedirect).toBe("home");
      } else {
        expect(replace).not.toHaveBeenCalled();
        expect(root.dataset.authRedirect).toBe("none");
      }
    },
  );
});

describe("WideScreenAuthRedirect", () => {
  let container: HTMLDivElement;
  let reactRoot: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    const mounted = reactRoot;
    reactRoot = null;
    if (mounted !== null) await act(async () => mounted.unmount());
    container.remove();
  });

  it("renders the inline script on the server", () => {
    expect(renderToString(<WideScreenAuthRedirect />)).toBe(
      `<script id="yoyi-auth-redirect">${WIDE_SCREEN_AUTH_REDIRECT_SCRIPT}</script>`,
    );
  });

  it.each([true, false])(
    "hydrates the server script without a mismatch and does not redirect twice (wide: %s)",
    async (wide) => {
      useDevice({ userAgent: desktop, width: wide ? 1280 : 800 });
      window.eval(PRODUCT_BOOT_SCRIPT);
      container.innerHTML = renderToString(<WideScreenAuthRedirect />);
      // The parser ran the inline script already; jsdom's innerHTML does not.
      window.eval(container.querySelector("script")!.textContent!);
      expect(replace).toHaveBeenCalledTimes(wide ? 1 : 0);
      const recoverable = vi.fn();
      const errors = vi.spyOn(console, "error");

      await act(async () => {
        reactRoot = hydrateRoot(container, <WideScreenAuthRedirect />, {
          onRecoverableError: recoverable,
        });
      });

      expect(recoverable).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(replace).toHaveBeenCalledTimes(wide ? 1 : 0);
      expect(root.dataset.authRedirect).toBe(wide ? "home" : "none");
      // After hydration the spent script leaves the document.
      expect(container.querySelector("script")).toBeNull();
    },
  );

  it.each(cases)(
    "on a soft navigation, decides for %s in a layout effect",
    async (_label, device, wide) => {
      useDevice(device);
      const errors = vi.spyOn(console, "error");
      reactRoot = createRoot(container);

      await act(async () => reactRoot!.render(<WideScreenAuthRedirect />));

      // React never runs a script it creates, so none is rendered.
      expect(container.querySelector("script")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      if (wide) {
        expect(replace).toHaveBeenCalledOnce();
        expect(replace).toHaveBeenCalledWith("/");
        expect(root.dataset.authRedirect).toBe("home");
      } else {
        expect(replace).not.toHaveBeenCalled();
        expect(root.dataset.authRedirect).toBe("none");
      }
    },
  );

  it("leaves only once when the page is already leaving", async () => {
    useDevice({ userAgent: desktop, width: 1280 });
    root.dataset.authRedirect = "home";
    reactRoot = createRoot(container);

    await act(async () => reactRoot!.render(<WideScreenAuthRedirect />));

    expect(replace).not.toHaveBeenCalled();
  });

  it("checks at load only, so a later resize keeps the form", async () => {
    useDevice({ userAgent: desktop, width: 800 });
    reactRoot = createRoot(container);
    await act(async () => reactRoot!.render(<WideScreenAuthRedirect />));

    await act(async () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280,
      });
      window.dispatchEvent(new Event("resize"));
      vi.runAllTimers();
    });

    expect(replace).not.toHaveBeenCalled();
    expect(root.dataset.authRedirect).toBe("none");
  });

  it("keeps the first decision for a later 登录/注册 switch in the same document", async () => {
    useDevice({ userAgent: desktop, width: 800 });
    reactRoot = createRoot(container);
    await act(async () => reactRoot!.render(<WideScreenAuthRedirect />));
    await act(async () => reactRoot!.unmount());

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot!.render(<WideScreenAuthRedirect key="register" />),
    );

    expect(replace).not.toHaveBeenCalled();
    expect(root.dataset.authRedirect).toBe("none");
  });
});

describe("wide-screen auth redirect after a back-forward cache restore", () => {
  it("decides again when the restored page is now wide", () => {
    useDevice({ userAgent: desktop, width: 800 });
    window.eval(PRODUCT_BOOT_SCRIPT);
    window.eval(WIDE_SCREEN_AUTH_REDIRECT_SCRIPT);
    expect(replace).not.toHaveBeenCalled();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    root.dataset.platform = "pc";
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false }),
    );
    expect(replace).not.toHaveBeenCalled();
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(replace).toHaveBeenCalledWith("/");
    expect(root.dataset.authRedirect).toBe("home");
  });
});
