import type { NextConfig } from "next";

const allowedDevOrigins =
  process.env.NODE_ENV === "development"
    ? (process.env.MOYA_ALLOWED_DEV_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : [];

const nextConfig: NextConfig = {
  agentRules: false,
  // The dev-only indicator sits over the dock on phone widths (QA D8).
  devIndicators: false,
  // Search text is private runtime input; keep ordinary dev request logs intact.
  logging: {
    incomingRequests: { ignore: [/^\/api\/catalog-search(?:[/?]|$)/u] },
  },
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  // No page uses the image optimizer. Left open it would fetch any same-origin
  // image with the caller's cookie and then serve its cached copy to anyone.
  images: { localPatterns: [], remotePatterns: [] },
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  outputFileTracingIncludes: {
    "/": [
      "../../docs/prototypes/mobile-preview/**/*",
      "../../docs/design-system/assets/**/*",
      "../../packages/design-tokens/src/theme.css",
      "../../packages/ui/src/styles.css",
      "../../packages/ui/src/brand.css",
      "../../packages/ui/src/assets/**/*",
    ],
    "/docs/prototypes/mobile-preview/*": [
      "../../docs/prototypes/mobile-preview/**/*",
    ],
    "/docs/design-system/assets/**": ["../../docs/design-system/assets/**/*"],
    "/packages/design-tokens/src/theme.css": [
      "../../packages/design-tokens/src/theme.css",
    ],
    "/packages/ui/src/styles.css": ["../../packages/ui/src/styles.css"],
    "/packages/ui/src/brand.css": ["../../packages/ui/src/brand.css"],
    "/packages/ui/src/assets/**": ["../../packages/ui/src/assets/**/*"],
  },
};

export default nextConfig;
