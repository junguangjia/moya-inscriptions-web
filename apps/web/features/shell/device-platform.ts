export type DeviceClass = "phone" | "tablet" | "desktop";

export type PresentationPlatform = "phone" | "tablet" | "pc";

export interface DeviceDetectionInput {
  readonly userAgent?: string | null;
  readonly userAgentData?: { readonly mobile?: boolean | null } | null;
  readonly maxTouchPoints?: number | null;
}

export interface RuntimeNavigatorLike {
  readonly userAgent?: string | null;
  readonly userAgentData?: { readonly mobile?: boolean | null } | null;
  readonly maxTouchPoints?: number | null;
}

export type PresentationOrientation = "portrait" | "landscape";

// These private compatibility thresholds mirror the current prototype, not a Product breakpoint API.
const phoneMaximumWidth = 768;
const pcMinimumWidth = 896;
const phonePattern = /iPhone|iPod|Windows Phone|IEMobile|Opera Mini|Mobile/i;
const tabletPattern = /iPad|Tablet|PlayBook|Silk|Kindle/i;

export const detectDeviceClass = (
  input: DeviceDetectionInput | null = {},
): DeviceClass => {
  const userAgent = String(input?.userAgent ?? "");
  const mobileHint = input?.userAgentData?.mobile;
  const touchPoints = Number(input?.maxTouchPoints ?? 0);

  if (
    tabletPattern.test(userAgent) ||
    (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) ||
    // iPadOS can identify itself as Macintosh while retaining multi-touch.
    (/Macintosh/i.test(userAgent) && touchPoints > 1)
  ) {
    return "tablet";
  }
  if (mobileHint === true || phonePattern.test(userAgent)) return "phone";
  return "desktop";
};

export const resolvePresentationPlatform = (
  deviceClass: DeviceClass,
  viewportWidth: number,
): PresentationPlatform => {
  const width = Number.isFinite(viewportWidth) ? viewportWidth : pcMinimumWidth;

  if (deviceClass === "phone") return "phone";
  if (deviceClass === "tablet") {
    return width < phoneMaximumWidth ? "phone" : "tablet";
  }
  if (width < phoneMaximumWidth) return "phone";
  return width < pcMinimumWidth ? "tablet" : "pc";
};

/** From this width a tablet also takes the wide (desktop) composition. */
export const WIDE_LAYOUT_MINIMUM_WIDTH = pcMinimumWidth;

/**
 * The wide composition: a PC, or a tablet at least as wide as a PC. The
 * desktop editor and the browse-only policy (pc-browse-only-v1) share it.
 */
export const isWideLayout = (
  platform: PresentationPlatform,
  viewportWidth: number,
): boolean =>
  platform === "pc" ||
  (platform === "tablet" && viewportWidth >= WIDE_LAYOUT_MINIMUM_WIDTH);

export const readRuntimeDeviceClass = (
  navigatorLike: RuntimeNavigatorLike,
): DeviceClass =>
  detectDeviceClass({
    ...(navigatorLike.maxTouchPoints === undefined
      ? {}
      : { maxTouchPoints: navigatorLike.maxTouchPoints }),
    ...(navigatorLike.userAgent === undefined
      ? {}
      : { userAgent: navigatorLike.userAgent }),
    ...(navigatorLike.userAgentData === undefined
      ? {}
      : { userAgentData: navigatorLike.userAgentData }),
  });

export const resolveRuntimePresentationPlatform = (
  navigatorLike: RuntimeNavigatorLike,
  viewportWidth: number,
): PresentationPlatform =>
  resolvePresentationPlatform(
    readRuntimeDeviceClass(navigatorLike),
    viewportWidth,
  );

export const resolvePresentationOrientation = (
  viewportWidth: number,
  viewportHeight: number,
): PresentationOrientation =>
  viewportWidth > viewportHeight ? "landscape" : "portrait";
