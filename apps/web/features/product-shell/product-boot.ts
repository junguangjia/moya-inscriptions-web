import {
  DEFAULT_THEME_PREFERENCE,
  DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  FEED_LAYOUT_PREFERENCE_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  defaultFeedLayoutFor,
} from "./preferences";

export const PRODUCT_LOADING_MINIMUM_MS = 720;
export const PRODUCT_LOADING_FAILSAFE_MS = 3_000;

// This script intentionally runs before hydration so approved presentation
// preferences and platform attributes are available to the first CSS paint.
export const PRODUCT_BOOT_SCRIPT = `(() => {
  const root = document.documentElement;
  const themeKey = ${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)};
  const layoutKey = ${JSON.stringify(FEED_LAYOUT_PREFERENCE_STORAGE_KEY)};
  const desktopLayoutKey = ${JSON.stringify(DESKTOP_FEED_LAYOUT_PREFERENCE_STORAGE_KEY)};
  const defaultLayouts = ${JSON.stringify({
    phone: defaultFeedLayoutFor("phone"),
    tablet: defaultFeedLayoutFor("tablet"),
    pc: defaultFeedLayoutFor("pc"),
  })};
  const phonePattern = /iPhone|iPod|Windows Phone|IEMobile|Opera Mini|Mobile/i;
  const tabletPattern = /iPad|Tablet|PlayBook|Silk|Kindle/i;
  const started = performance.now();

  root.dataset.yoyiBoot = "pending";
  root.dataset.yoyiBootStarted = String(started);

  let layout = null;
  let desktopLayout = null;
  try {
    const theme = localStorage.getItem(themeKey);
    const preference =
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : "${DEFAULT_THEME_PREFERENCE}";
    root.dataset.themePreference = preference;
    if (preference === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = preference;
  } catch {
    root.dataset.themePreference = "${DEFAULT_THEME_PREFERENCE}";
    root.dataset.theme = "${DEFAULT_THEME_PREFERENCE}";
  }

  try {
    const stored = localStorage.getItem(layoutKey);
    if (stored === "single" || stored === "double") layout = stored;
  } catch {
    // An unavailable layout preference uses the platform default.
  }
  try {
    const stored = localStorage.getItem(desktopLayoutKey);
    if (stored === "single" || stored === "double") desktopLayout = stored;
  } catch {
    // Desktop never falls back to the phone/tablet preference.
  }

  const synchronizePlatform = () => {
    const userAgent = String(navigator.userAgent || "");
    const mobileHint = navigator.userAgentData?.mobile;
    const touchPoints = Number(navigator.maxTouchPoints || 0);
    let deviceClass = "desktop";
    if (
      tabletPattern.test(userAgent) ||
      (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) ||
      (/Macintosh/i.test(userAgent) && touchPoints > 1)
    ) {
      deviceClass = "tablet";
    } else if (mobileHint === true || phonePattern.test(userAgent)) {
      deviceClass = "phone";
    }

    const width = Number.isFinite(window.innerWidth) ? window.innerWidth : 896;
    const platform =
      deviceClass === "phone"
        ? "phone"
        : deviceClass === "tablet"
          ? width < 768
            ? "phone"
            : "tablet"
          : width < 768
            ? "phone"
            : width < 896
              ? "tablet"
              : "pc";

    root.dataset.deviceClass = deviceClass;
    root.dataset.platform = platform;
    root.dataset.orientation = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  };

  synchronizePlatform();
  // Device identity owns the preference; window width only owns presentation.
  root.dataset.homeLayout =
    (root.dataset.deviceClass === "desktop" ? desktopLayout : layout) ??
    defaultLayouts[root.dataset.deviceClass === "desktop" ? "pc" : root.dataset.platform];
  window.YOYI_PRODUCT_BOOT = Object.freeze({ synchronizePlatform });
  window.setTimeout(() => {
    if (root.dataset.yoyiBoot === "pending") root.dataset.yoyiBoot = "ready";
  }, ${PRODUCT_LOADING_FAILSAFE_MS});
})();`;
